/**
 * Switchboard relay — Cloudflare Worker entry + router.
 *
 * Two access modes:
 *   - anonymous: /ws?role=…&token=<secret>      (token is the credential)
 *   - bound:     /ws?role=…&machine=<id>        (account-gated)
 *       daemon  → header x-switchboard-agent: <agent token>  (→ account)
 *       browser → sb_session cookie             (→ account; must own machine)
 *
 * HTTP: GitHub-OAuth sessions (/auth/*), the CLI-login handshake (/cli/*),
 * the dashboard API (/api/*), and static assets (the frontend in ./public).
 */

import { Circuit } from "./circuit.js";
import { handleLogin, handleSession, handleLogout, getSession, json } from "./auth.js";
import {
  cliStart, cliComplete, cliPoll,
  listMachines, verifyAgentToken, registerMachine, machineOwner,
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

    // ---- static assets (frontend) ----
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found\n", { status: 404 });
  },
};

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
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
    if (role === "daemon") {
      const account = await verifyAgentToken(env, request.headers.get("x-switchboard-agent"));
      if (!account) return new Response("invalid or missing agent token\n", { status: 401 });
      const ok = await registerMachine(env, machineId, account, url.searchParams.get("name") || "");
      if (!ok) return new Response("machine is owned by another account\n", { status: 403 });
    } else {
      const s = await getSession(request, env);
      if (!s) return new Response("not signed in\n", { status: 401 });
      if ((await machineOwner(env, machineId)) !== s.id) {
        return new Response("not your machine\n", { status: 403 });
      }
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
