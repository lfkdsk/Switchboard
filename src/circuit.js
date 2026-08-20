import { DurableObject } from "cloudflare:workers";
import { setMachineOffline, updateMachineStats } from "./registry.js";

const WS_OPEN = 1;

/**
 * One circuit per token (anonymous) or per machine_id (bound). Transparent
 * forwarder between the daemon and the browser(s) on the same circuit. For
 * bound circuits it also flips the machine's `online` flag in D1 when the
 * daemon disconnects (online is set on connect by the Worker before routing).
 */
export class Circuit extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__revoke" && request.method === "POST") {
      const accountId = request.headers.get("x-switchboard-account");
      if (!accountId) return new Response("missing account\n", { status: 400 });
      let closed = 0;
      for (const ws of this.ctx.getWebSockets("browser")) {
        const a = ws.deserializeAttachment() || {};
        if (a.accessVia !== "grant" || a.accountId !== accountId) continue;
        // Persist the block before attempting the close handshake. Even if a
        // client/runtime delays that handshake, no more frames pass either way.
        a.blocked = "access-revoked";
        ws.serializeAttachment(a);
        this.safeSend(ws, JSON.stringify({ type: "_relay", event: a.blocked }));
        try { ws.close(4003, "machine access revoked"); closed++; } catch {}
      }
      return new Response(JSON.stringify({ ok: true, closed }), {
        headers: { "content-type": "application/json" },
      });
    }
    const role = url.searchParams.get("role");
    const machineId = url.searchParams.get("machine") || null;

    if (role === "daemon") {
      // Last-writer-wins: a newly-arrived daemon always takes over the circuit.
      // We can't trust readyState here — when a daemon dies ungracefully (sleep,
      // crash, kill -9) Cloudflare leaves its socket reading OPEN for minutes
      // until the TCP connection times out. Rejecting the newcomer in that
      // window locks a restarted daemon out of its own (machine-keyed) circuit.
      // Instead, close any incumbent and accept the newcomer. The 4001 code
      // tells a still-live incumbent it was deliberately replaced so it exits
      // cleanly instead of reconnecting and fighting for the circuit.
      for (const s of this.ctx.getWebSockets("daemon")) {
        try { s.close(4001, "replaced by a newer daemon"); } catch {}
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    const expiresRaw = request.headers.get("x-switchboard-expires");
    const expiresAt = expiresRaw == null ? null : Number(expiresRaw);
    server.serializeAttachment({
      role,
      machineId,
      accountId: request.headers.get("x-switchboard-account") || null,
      accessVia: request.headers.get("x-switchboard-access") || null,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    });

    if (role === "browser") {
      const daemonUp = this.ctx.getWebSockets("daemon").some((s) => s.readyState === WS_OPEN);
      this.safeSend(server, JSON.stringify({ type: "_relay", event: daemonUp ? "daemon-online" : "daemon-offline" }));
      this.notifyDaemonPeer();
    } else {
      this.broadcastToBrowsers(JSON.stringify({ type: "_relay", event: "daemon-online" }));
      this.notifyDaemonPeer();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === "daemon") {
      // Bound-machine heartbeat → D1 (small JSON stats only; skip binary + big dl-chunks).
      // The cap sits above a full stats frame — which now carries the activity
      // summary — but well below a dl-chunk, so file transfers still skip parsing.
      if (att.machineId && typeof message === "string" && message.length < 8000) {
        this.recordHeartbeat(att.machineId, message);
      }
      for (const b of this.ctx.getWebSockets("browser")) {
        if (!this.closeIfBlocked(b)) this.safeSend(b, message);
      }
    } else {
      if (this.closeIfBlocked(ws)) return;
      const daemon = this.ctx.getWebSockets("daemon").find((s) => s.readyState === WS_OPEN);
      if (daemon) this.safeSend(daemon, message);
    }
  }

  recordHeartbeat(machineId, str) {
    let m;
    try { m = JSON.parse(str); } catch { return; }
    if (m.type !== "stats") return;
    const now = Date.now();
    if (this._lastBeat && now - this._lastBeat < 4000) return; // throttle D1 writes
    this._lastBeat = now;
    this.ctx.waitUntil(updateMachineStats(this.env, machineId, m));
  }

  async webSocketClose(ws, code, reason) {
    const { role, machineId } = ws.deserializeAttachment() || {};
    try { ws.close(code, reason); } catch {}
    if (role === "daemon") {
      this.broadcastToBrowsers(JSON.stringify({ type: "_relay", event: "daemon-offline" }));
      if (machineId) { try { await setMachineOffline(this.env, machineId); } catch {} }
    } else {
      this.notifyDaemonPeer(ws);
    }
  }

  webSocketError() {}

  notifyDaemonPeer(excluding) {
    const daemon = this.ctx.getWebSockets("daemon").find((s) => s.readyState === WS_OPEN);
    if (!daemon) return;
    const online = this.ctx.getWebSockets("browser").some((b) => b !== excluding && b.readyState === WS_OPEN);
    this.safeSend(daemon, JSON.stringify({ type: "peer-status", online }));
  }

  broadcastToBrowsers(str) {
    for (const b of this.ctx.getWebSockets("browser")) {
      if (!this.closeIfBlocked(b)) this.safeSend(b, str);
    }
  }
  closeIfBlocked(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.blocked) {
      try { ws.close(4003, a.blocked === "access-expired" ? "machine access expired" : "machine access revoked"); } catch {}
      return true;
    }
    if (a.accessVia !== "grant" || a.expiresAt == null || a.expiresAt > Date.now()) return false;
    a.blocked = "access-expired";
    ws.serializeAttachment(a);
    this.safeSend(ws, JSON.stringify({ type: "_relay", event: a.blocked }));
    try { ws.close(4003, "machine access expired"); } catch {}
    return true;
  }
  safeSend(ws, data) { try { ws.send(data); } catch {} }
}
