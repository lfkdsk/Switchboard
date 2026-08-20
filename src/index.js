/**
 * Switchboard relay — Cloudflare Worker entry + router.
 *
 * Two access modes:
 *   - anonymous: /ws?role=…&token=<secret>      (token is the credential)
 *   - bound:     /ws?role=…&machine=<id>        (account-gated)
 *       daemon  → header x-switchboard-agent: <agent token>  (→ account)
 *       browser → sb_session cookie             (→ account; owner or grantee)
 *                 …or the same agent token, which is how one of your machines
 *                 dials an owned/shared target (peer mode; target opts in).
 *
 * HTTP: GitHub-OAuth sessions (/auth/*), the CLI-login handshake (/cli/*),
 * the dashboard API (/api/*), the CLI's own node list (/api/nodes), and static
 * assets (the frontend in ./public).
 */

import { Circuit } from "./circuit.js";
import { handleLogin, handleSession, handleLogout, getSession, json } from "./auth.js";
import {
  cliStart, cliComplete, cliPoll,
  listMachines, listSharedWithMe, listReachableMachines, deleteMachine,
  verifyAgentToken, registerMachine, machineAccess,
  grantMachine, revokeGrant, listGrants,
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
    if (p === "/api/machines") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      return json({ machines: await listMachines(env, s.id) });
    }
    if (p === "/api/machines/delete" && request.method === "POST") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const b = await safeJson(request);
      if (!b || !b.machine_id) return json({ error: "missing machine_id" }, 400);
      const r = await deleteMachine(env, b.machine_id, s.id);
      if (r.ok) return json({ ok: true });
      return r.reason === "online"
        ? json({ error: "machine is online" }, 409)
        : json({ error: "not found" }, 404);
    }
    if (p === "/api/machines/shared") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      return json({ machines: await listSharedWithMe(env, s.id) });
    }
    if (p === "/api/machines/grants") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const machineId = url.searchParams.get("machine_id");
      if (!machineId) return json({ error: "missing machine_id" }, 400);
      const grants = await listGrants(env, machineId, s.id);
      return grants ? json({ grants }) : json({ error: "not found" }, 404);
    }
    if (p === "/api/machines/grant" && request.method === "POST") {
      const s = await getSession(request, env);
      if (!s) return json({ error: "not signed in" }, 401);
      const b = await safeJson(request);
      if (!b || !b.machine_id || !b.login) return json({ error: "missing machine_id/login" }, 400);
      const r = await grantMachine(env, b.machine_id, s.id, b.login, b.expires_at ?? null);
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
      if (!b || !b.machine_id || !b.grantee_id) {
        return json({ error: "missing machine_id/grantee_id" }, 400);
      }
      const granteeId = String(b.grantee_id);
      const r = await revokeGrant(env, b.machine_id, granteeId, s.id);
      if (!r.ok) return json({ error: "not found" }, 404);
      // The database is authoritative for every future connection. Also close
      // this account's existing granted sockets so revoke means now, not after
      // their current terminal happens to disconnect.
      const disconnected = await disconnectGrantedAccount(env, b.machine_id, granteeId);
      return json({ ok: true, disconnected });
    }

    // ---- the CLI's view of the account ----
    // Same list as /api/machines, but authenticated with the agent token a
    // machine already holds instead of a browser session — this is how a host
    // discovers its siblings without a human at a keyboard. `online` is decided
    // here rather than by the caller: the relay's clock wrote last_seen, and a
    // machine comparing it against its own would fold in every bit of skew.
    if (p === "/api/nodes") {
      const account = await verifyAgentToken(env, request.headers.get("x-switchboard-agent"));
      if (!account) return json({ error: "invalid or missing agent token" }, 401);
      // `now` travels with the rows for the same reason: "last seen 3m ago" is
      // only true if it's measured against the clock that stamped last_seen.
      return json({ login: account.login, now: Date.now(), nodes: await listReachableMachines(env, account.id) });
    }

    // ---- static assets (frontend) ----
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found\n", { status: 404 });
  },
};

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function disconnectGrantedAccount(env, machineId, accountId) {
  const stub = env.CIRCUIT.get(env.CIRCUIT.idFromName("m:" + machineId));
  try {
    const response = await stub.fetch(new Request("https://switchboard.internal/__revoke", {
      method: "POST",
      headers: { "x-switchboard-account": accountId },
    }));
    if (response.ok) return Number((await response.json()).closed) || 0;
  } catch {
    // D1 has already revoked the grant, so reconnects still fail closed. A DO
    // delivery failure must not roll the durable decision back.
  }
  return 0;
}

function withBrowserAccess(request, accountId, access) {
  const r = new Request(request);
  r.headers.set("x-switchboard-account", accountId);
  r.headers.set("x-switchboard-access", access.via);
  if (access.expiresAt != null) r.headers.set("x-switchboard-expires", String(access.expiresAt));
  else r.headers.delete("x-switchboard-expires");
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
    const agentToken = request.headers.get("x-switchboard-agent");
    if (role === "daemon") {
      const account = await verifyAgentToken(env, agentToken);
      if (!account) return new Response("invalid or missing agent token\n", { status: 401 });
      const ok = await registerMachine(
        env, machineId, account,
        url.searchParams.get("name") || "",
        url.searchParams.get("peer") === "1",
      );
      if (!ok) return new Response("machine is owned by another account\n", { status: 403 });
    } else {
      // A client is a signed-in browser or an account's agent token. Both may
      // use owned machines and explicit live grants. Software connections still
      // require the target daemon's peer opt-in; browser terminals do not.
      const peer = agentToken ? await verifyAgentToken(env, agentToken) : null;
      if (agentToken && !peer) return new Response("invalid agent token\n", { status: 401 });
      const s = peer || (await getSession(request, env));
      if (!s) return new Response("not signed in\n", { status: 401 });
      const target = await machineAccess(env, machineId, s.id);
      if (!target) return new Response("you don't have access to this machine\n", { status: 403 });
      if (peer && !target.peer) {
        return new Response(
          "that machine does not accept peer connections\n" +
            "(restart its daemon without SWITCHBOARD_PEER=0 to allow it)\n",
          { status: 403 },
        );
      }
      request = withBrowserAccess(request, s.id, target);
    }
    return env.CIRCUIT.get(env.CIRCUIT.idFromName("m:" + machineId)).fetch(request);
  }

  // ---- anonymous (token) mode ----
  const token = url.searchParams.get("token") || "";
  if (token.length < MIN_TOKEN_LEN) {
    return new Response(`token must be at least ${MIN_TOKEN_LEN} characters\n`, { status: 400 });
  }
  return env.CIRCUIT.get(env.CIRCUIT.idFromName("t:" + token)).fetch(request);
}
