/**
 * Switchboard — a self-hosted relay for the `@elsetech/webterm` daemon, a
 * drop-in replacement for webterm.elsetech.app.
 *
 * Like an old telephone switchboard: each token is a circuit, and the operator
 * (this Worker + Durable Object) patches the daemon's line to the browser's. It
 * is a transparent forwarder — it never parses the terminal payloads, it just
 * shovels frames between the two ends of the same circuit.
 *
 *   daemon  ──wss──▶  /ws?role=daemon&token=…   ┐
 *                                                ├─ Circuit (idFromName(token))
 *   browser ──wss──▶  /ws?role=browser&token=…  ┘
 *
 * Routing:
 *   GET /ws?role=daemon|browser&token=…  → WebSocket upgrade, handled by the DO
 *   GET /healthz                          → liveness
 *   everything else                       → static assets (the frontend in ./public)
 *
 * Protocol (reverse-engineered from the daemon's index.js, forwarded verbatim):
 *   binary frames  [1-byte sid length][sid utf8][payload]   both directions
 *   browser → daemon JSON: open / resize / client-gone / dl-open /
 *                          ul-open / ul-chunk / ul-end
 *   daemon → browser JSON: stats / exit / dl-meta / dl-chunk / dl-end /
 *                          dl-error / ul-ready / ul-done / ul-error
 *   relay  → daemon  JSON: peer-status {online}      (daemon logs this)
 *   relay  → browser JSON: _relay {event}            (our frontend only)
 */

import { DurableObject } from "cloudflare:workers";

const MIN_TOKEN_LEN = 24; // mirror the daemon: reject weak tokens
const WS_OPEN = 1; // WebSocket.OPEN readyState

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return routeWebSocket(request, env, url);
    }
    if (url.pathname === "/healthz") {
      return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain" } });
    }

    // Static assets (the frontend) are served by the platform before the Worker
    // runs for any path that matches a file in ./public; we only reach here for
    // unmatched paths. Fall back to the asset binding if present, else 404.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found\n", { status: 404 });
  },
};

function routeWebSocket(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected a WebSocket upgrade\n", { status: 426 });
  }
  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token") || "";
  if (role !== "daemon" && role !== "browser") {
    return new Response("role must be 'daemon' or 'browser'\n", { status: 400 });
  }
  if (token.length < MIN_TOKEN_LEN) {
    return new Response(`token must be at least ${MIN_TOKEN_LEN} characters\n`, { status: 400 });
  }
  // One circuit per token. idFromName is deterministic, so the daemon and every
  // browser carrying the same token land in the same Durable Object instance.
  const id = env.CIRCUIT.idFromName(token);
  return env.CIRCUIT.get(id).fetch(request);
}

/**
 * One circuit per token. Holds the live WebSockets for that circuit and forwards
 * between them. Uses the Hibernatable WebSockets API so an idle terminal costs
 * nothing and the circuit survives the DO being evicted between messages.
 */
export class Circuit extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive that never wakes the DO: a browser sends the literal string
    // "ping" and the runtime answers "pong" on its own. Terminal keystrokes are
    // binary frames, so they never collide with this text-frame heartbeat.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get("role");

    if (role === "daemon") {
      // The daemon treats HTTP 409 as fatal: "this token is already in use".
      // Only reject if a *live* daemon is present; reap any stale straggler
      // (e.g. a crashed daemon whose close hasn't fired yet) and take over.
      const daemons = this.ctx.getWebSockets("daemon");
      if (daemons.some((s) => s.readyState === WS_OPEN)) {
        return new Response("token already in use by another daemon\n", { status: 409 });
      }
      for (const s of daemons) {
        try { s.close(1000, "stale daemon replaced"); } catch {}
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]); // tag so getWebSockets(role) works
    server.serializeAttachment({ role });

    if (role === "browser") {
      // Let the new browser know if a daemon is already waiting, and tell the
      // daemon a browser has arrived.
      const daemonUp = this.ctx.getWebSockets("daemon").some((s) => s.readyState === WS_OPEN);
      this.safeSend(server, JSON.stringify({ type: "_relay", event: daemonUp ? "daemon-online" : "daemon-offline" }));
      this.notifyDaemonPeer();
    } else {
      // A daemon (re)connected: wake up any browsers that were waiting, and tell
      // the daemon whether browsers are already attached.
      this.broadcastToBrowsers(JSON.stringify({ type: "_relay", event: "daemon-online" }));
      this.notifyDaemonPeer();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const { role } = ws.deserializeAttachment() || {};
    if (role === "daemon") {
      // daemon → every browser, verbatim (binary PTY output or JSON control).
      // Each browser filters by its own sid/id, so a broadcast is correct.
      for (const b of this.ctx.getWebSockets("browser")) this.safeSend(b, message);
    } else {
      // browser → the single daemon, verbatim.
      const daemon = this.ctx.getWebSockets("daemon").find((s) => s.readyState === WS_OPEN);
      if (daemon) this.safeSend(daemon, message);
    }
  }

  webSocketClose(ws, code, reason) {
    const { role } = ws.deserializeAttachment() || {};
    try { ws.close(code, reason); } catch {}
    if (role === "daemon") {
      this.broadcastToBrowsers(JSON.stringify({ type: "_relay", event: "daemon-offline" }));
    } else {
      this.notifyDaemonPeer(ws); // recompute browser count, excluding the one leaving
    }
  }

  webSocketError(ws) {
    // The matching webSocketClose handles cleanup; nothing to do here.
  }

  // Tell the daemon whether any browser is currently attached. The daemon just
  // logs "browser connected/disconnected", so loose semantics are fine.
  notifyDaemonPeer(excluding) {
    const daemon = this.ctx.getWebSockets("daemon").find((s) => s.readyState === WS_OPEN);
    if (!daemon) return;
    const online = this.ctx
      .getWebSockets("browser")
      .some((b) => b !== excluding && b.readyState === WS_OPEN);
    this.safeSend(daemon, JSON.stringify({ type: "peer-status", online }));
  }

  broadcastToBrowsers(str) {
    for (const b of this.ctx.getWebSockets("browser")) this.safeSend(b, str);
  }

  safeSend(ws, data) {
    try { ws.send(data); } catch {}
  }
}
