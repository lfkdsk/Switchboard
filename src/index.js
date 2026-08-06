/**
 * Switchboard relay — Cloudflare Worker entry + router.
 *
 * Two access modes:
 *   - anonymous: /ws?role=…&token=<secret>      (token is the credential)
 *   - bound:     /ws?role=…&machine=<id>        (account-gated)
 *       daemon  → header x-switchboard-agent: <agent token>  (→ account)
 *       browser → sb_session cookie             (→ account; owner or grantee)
 *
 * HTTP: GitHub-OAuth sessions (/auth/*), the CLI-login handshake (/cli/*),
 * the dashboard API (/api/*), and static assets (the frontend in ./public).
 */

import { Circuit } from "./circuit.js";
import { handleLogin, handleSession, handleLogout, getSession, json } from "./auth.js";
import {
  cliStart, cliComplete, cliPoll,
  listMachines, deleteMachine, verifyAgentToken, registerMachine,
  canAccess, grantMachine, revokeGrant, listGrants, listSharedWithMe,
} from "./registry.js";

export { Circuit };

const MIN_TOKEN_LEN = 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/ws") return routeWebSocket(request, env, url);
    if (p === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

    // ---- auth / session ----
    if (p === "/auth/login") return handleLogin(url);
    if (p === "/auth/session" && request.method === "POST") return handleSession(request, env);
    if (p === "/auth/logout" && request.method === "POST") return handleLogout();
    if (p === "/auth/me") {
      const s = await getSession(request, env);
      return json(s ? { id: s.id, login: s.login } : { login: null });
    }

    // ---- CLI-login handshake ----
    if (p === "/cli/start" && request.method === "POST") {
      const b = await safeJson(request);
      if (!b || !b.state || !b.verifier_hash) return json({ error: "missing state/verifier_hash" }, 400);
      await cliStart(env, b.state, b.verifier_hash);
      return json({ ok: true });
    }
    if (p === "/cli/complete" && request.method === "POST") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const b = await safeJson(request);
      if (!b || !b.state) return json({ error: "missing state" }, 400);
      const ok = await cliComplete(env, b.state, { id: s.id, login: s.login });
      return ok ? json({ ok: true }) : json({ error: "unknown state" }, 404);
    }
    if (p === "/cli/poll") {
      const state = url.searchParams.get("state");
      const verifier = url.searchParams.get("verifier");
      if (!state || !verifier) return json({ error: "missing state/verifier" }, 400);
      return json(await cliPoll(env, state, verifier));
    }

    // ---- dashboard API ----
    // The two read routes also answer to an agent token, because a node has to
    // be able to ask "which machines can I reach?" before it can drive one. The
    // mutating routes below stay session-only on purpose: an agent token lives
    // on a host, sometimes a shared one, and a credential that can hand out
    // access to other machines is a much bigger thing to leave lying there.
    if (p === "/api/machines") {
      const who = await identify(request, env);
      if (!who) return json({ error: "not signed in" }, 401);
      return json({ machines: await listMachines(env, who.id) });
    }
    if (p === "/api/machines/delete" && request.method === "POST") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const b = await safeJson(request);
      if (!b || !b.machine_id) return json({ error: "missing machine_id" }, 400);
      // Ownership, not access: deleteMachine matches on account_id, so a
      // grantee gets the same "not found" as a stranger. Every mutating route
      // below keeps that split — a grant buys a shell and nothing more.
      const r = await deleteMachine(env, b.machine_id, s.id);
      if (r.ok) return json({ ok: true });
      return r.reason === "online"
        ? json({ error: "machine is online" }, 409)
        : json({ error: "not found" }, 404);
    }

    // ---- sharing (delegation grants) ----
    if (p === "/api/machines/shared") {
      const who = await identify(request, env);
      if (!who) return json({ error: "not signed in" }, 401);
      return json({ machines: await listSharedWithMe(env, who.id) });
    }
    if (p === "/api/machines/grants") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const machineId = url.searchParams.get("machine_id");
      if (!machineId) return json({ error: "missing machine_id" }, 400);
      // Owner-only: who else can reach your machine is your business, and a
      // grantee has no reason to enumerate the other people sharing it.
      const grants = await listGrants(env, machineId, s.id);
      return grants ? json({ grants }) : json({ error: "not found" }, 404);
    }
    if (p === "/api/machines/grant" && request.method === "POST") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const b = await safeJson(request);
      if (!b || !b.machine_id || !b.login) return json({ error: "missing machine_id/login" }, 400);
      const r = await grantMachine(env, b.machine_id, s.id, b.login, b.expires_at ?? null, !!b.can_exec);
      if (r.ok) return json({ ok: true, grant: r.grant });
      if (r.reason === "unknown-login") return json({ error: "no such github user" }, 404);
      if (r.reason === "self") return json({ error: "you already own this machine" }, 400);
      if (r.reason === "bad-expiry") return json({ error: "expires_at must be a future timestamp" }, 400);
      return json({ error: "not found" }, 404);
    }
    if (p === "/api/machines/revoke" && request.method === "POST") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const b = await safeJson(request);
      if (!b || !b.machine_id || !b.grantee_id) return json({ error: "missing machine_id/grantee_id" }, 400);
      // grantee_id is stored as TEXT; JSON may hand us a number for it.
      const r = await revokeGrant(env, b.machine_id, String(b.grantee_id), s.id);
      return r.ok ? json({ ok: true }) : json({ error: "not found" }, 404);
    }

    // ---- static assets (frontend) ----
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found\n", { status: 404 });
  },
};

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

// Who is asking: a person with a dashboard session, or a node presenting its own
// agent token. Both resolve to the same account, which is the whole point — the
// grants that govern what you can open in a browser govern what your machines
// can drive, with no second permission system to keep in step.
async function identify(request, env) {
  const agentToken = request.headers.get("x-switchboard-agent");
  if (agentToken) return verifyAgentToken(env, agentToken);
  return getSession(request, env);
}

// The Circuit gets told what this attachment is allowed to do, because it is the
// only place both ends of the wire are visible. Carried as a header on a copy of
// the upgrade request: the DO is addressed by machine id, so it cannot re-derive
// the answer itself, and re-reading D1 there would be a second lookup per
// connect for something the Worker just resolved.
function withExec(request, allowExec) {
  if (allowExec) return request; // the common case travels untouched
  const r = new Request(request);
  r.headers.set("x-sb-exec", "0");
  return r;
}

async function routeWebSocket(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected a WebSocket upgrade\n", { status: 426 });
  }
  const role = url.searchParams.get("role");
  if (role !== "daemon" && role !== "browser") {
    return new Response("role must be 'daemon' or 'browser'\n", { status: 400 });
  }

  const machineId = url.searchParams.get("machine");
  if (machineId) {
    // ---- bound (account) mode ----
    // Whether this attachment may use the exec channel. Only a shell-only grant
    // turns it off; the daemon end and the machine's owner are never restricted.
    let allowExec = true;
    if (role === "daemon") {
      const account = await verifyAgentToken(env, request.headers.get("x-switchboard-agent"));
      if (!account) return new Response("invalid or missing agent token\n", { status: 401 });
      const ok = await registerMachine(env, machineId, account, url.searchParams.get("name") || "");
      if (!ok) return new Response("machine is owned by another account\n", { status: 403 });
    } else {
      // Two kinds of client attach here. A person arrives from the dashboard
      // with a session cookie. A *node* arrives with its own agent token — that
      // is what lets one machine drive another (`switchboard exec`, flow steps)
      // without anyone copying a bearer share token around: the same identity
      // and the same grants that govern the dashboard govern automation.
      const agentToken = request.headers.get("x-switchboard-agent");
      let accountId;
      if (agentToken) {
        const account = await verifyAgentToken(env, agentToken);
        if (!account) return new Response("invalid agent token\n", { status: 401 });
        accountId = account.id;
      } else {
        const s = await getSession(request, env);
        if (!s) return new Response("not signed in\n", { status: 401 });
        accountId = s.id;
      }
      // Owner or live grantee. Re-derived from D1 on every connect, never
      // carried in the session cookie: the cookie is good for a week, so a
      // cached answer would outlive a revoked or expired grant by days. The
      // cost is one indexed read per connect, not per frame.
      const access = await canAccess(env, machineId, accountId);
      if (!access) return new Response("you don't have access to this machine\n", { status: 403 });
      // An agent token is software by definition, so a shell-only share is
      // refused here rather than at the first exec frame — failing at connect
      // gives the caller one clear error instead of a socket that opens and
      // then silently ignores everything it is asked to do.
      if (agentToken && !access.exec) {
        return new Response("this machine is shared with you for shell access only\n", { status: 403 });
      }
      allowExec = access.exec;
    }
    return env.CIRCUIT.get(env.CIRCUIT.idFromName("m:" + machineId)).fetch(withExec(request, allowExec));
  }

  // ---- anonymous (token) mode ----
  const token = url.searchParams.get("token") || "";
  if (token.length < MIN_TOKEN_LEN) {
    return new Response(`token must be at least ${MIN_TOKEN_LEN} characters\n`, { status: 400 });
  }
  return env.CIRCUIT.get(env.CIRCUIT.idFromName("t:" + token)).fetch(request);
}
