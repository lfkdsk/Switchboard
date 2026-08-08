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
    // Set only for a share that grants a shell but not automation (see
    // machine_grants.can_exec). Stored inverted so the ordinary attachment keeps
    // an empty flag and takes the fast path in webSocketMessage.
    const noExec = request.headers.get("x-sb-exec") === "0" || undefined;
    server.serializeAttachment({ role, machineId, noExec });

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
      for (const b of this.ctx.getWebSockets("browser")) this.safeSend(b, message);
    } else {
      // A shell-only share can open a terminal but must not drive the machine
      // by other means. Only such an attachment pays for the parse: every other
      // browser frame — and every byte of terminal payload, which is binary — is
      // forwarded without being looked at, so the relay stays opaque where
      // opacity is the point.
      if (att.noExec && typeof message === "string" && !this.allowFromRestricted(ws, message)) return;
      const daemon = this.ctx.getWebSockets("daemon").find((s) => s.readyState === WS_OPEN);
      if (daemon) this.safeSend(daemon, message);
    }
  }

  // False when this frame asks the machine to do something a shell-only share
  // may not ask for. Both families count: `exec` runs one command, `flow` saves
  // and conducts whole graphs of them, and a share that withholds the first
  // while handing over the second would mean nothing at all.
  //
  // Unparseable frames are passed through: the daemon is the one that has to
  // make sense of them, and inventing a second opinion here would mean the relay
  // deciding what valid traffic looks like.
  allowFromRestricted(ws, str) {
    let m;
    try { m = JSON.parse(str); } catch { return true; }
    if (typeof m?.type !== "string") return true;
    const family = m.type.startsWith("exec") ? "exec-error" : m.type.startsWith("flow") ? "flow-error" : null;
    if (!family) return true;
    // Answered in the same family it was asked in, so the caller's own error
    // path handles it instead of it vanishing into a channel nobody is reading.
    this.safeSend(ws, JSON.stringify({
      type: family, id: m.id, run: m.run, op: m.type.replace(/^flow-/, ""),
      message: "this machine is shared with you for shell access only",
    }));
    return false;
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
    for (const b of this.ctx.getWebSockets("browser")) this.safeSend(b, str);
  }
  safeSend(ws, data) { try { ws.send(data); } catch {} }
}
