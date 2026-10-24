import { DurableObject } from "cloudflare:workers";
import { activeGrantSnapshot, setMachineOffline, updateMachineStats } from "./registry.js";
import { browserMessage, daemonRoute, resetReplayRoutes } from "./replay-routing.js";
import {
  ACCOUNT_SESSIONS_FEATURE,
  liveGrantForAccount,
  routeAllowsBrowser,
  routeDaemonMessage,
  stampBrowserMessage,
} from "./account-session-protocol.js";

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
      this.notifyDaemonAccountEnded(accountId, "access-revoked");
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
    const requestedNonce = url.searchParams.get("protocol-nonce");
    const accountSessions = role === "daemon" && !!machineId &&
      url.searchParams.get("protocol") === ACCOUNT_SESSIONS_FEATURE &&
      typeof requestedNonce === "string" && requestedNonce.length >= 24;
    const protocolNonce = accountSessions ? requestedNonce : null;
    let activeGrants = null;

    // Build a complete D1 snapshot before replacing an incumbent daemon. If
    // D1 fails or the bounded protocol limit is exceeded, keeping the current
    // daemon alive is safer than negotiating from a truncated authority set.
    // The concurrency block also serializes this read with /__revoke: a revoke
    // either lands before the query and is absent, or runs after acceptance and
    // notifies the newly accepted daemon. It cannot be missed between the two.
    if (accountSessions) {
      try {
        activeGrants = await this.ctx.blockConcurrencyWhile(() => activeGrantSnapshot(
          this.env, machineId, request.headers.get("x-switchboard-account"), Date.now(),
        ));
      } catch {
        return new Response(
          "Could not build a complete active-grant snapshot; the existing daemon was left running.\n",
          { status: 503 },
        );
      }
      if (!activeGrants) return new Response("machine ownership changed\n", { status: 403 });
    }

    if (role === "browser" && request.headers.get("x-switchboard-access") === "grant") {
      const daemon = this.liveDaemon();
      if (daemon && !this.daemonAttachment(daemon).accountSessions) {
        return new Response(
          "This shared machine is running an older Switchboard daemon. " +
            "Ask its owner to upgrade and restart the daemon before using this grant.\n",
          { status: 426 },
        );
      }
    }

    if (role === "daemon") {
      this._replayTargets = resetReplayRoutes();
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
      clientId: role === "browser" ? crypto.randomUUID() : null,
      accountId: request.headers.get("x-switchboard-account") || null,
      accessVia: request.headers.get("x-switchboard-access") || null,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      accountSessions,
      protocolNonce,
    });

    if (role === "browser") {
      const daemonUp = !!this.liveDaemon();
      this.safeSend(server, JSON.stringify({
        type: "_relay", event: "access-context",
        accessVia: request.headers.get("x-switchboard-access") || null,
      }));
      this.safeSend(server, JSON.stringify({ type: "_relay", event: daemonUp ? "daemon-online" : "daemon-offline" }));
      this.notifyDaemonPeer(server, true);
    } else {
      if (accountSessions) {
        this.reconcileGrantSockets(activeGrants);
        this.safeSend(server, JSON.stringify({
          type: "_relay", event: "account-sessions", version: 1,
          ownerAccountId: request.headers.get("x-switchboard-account"),
          nonce: protocolNonce, activeGrants,
        }));
      } else if (machineId) {
        this.rejectLegacyGrants();
      }
      this.broadcastToBrowsers(JSON.stringify({ type: "_relay", event: "daemon-online" }));
      this.notifyDaemonPeer();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === "daemon") {
      if (att.accountSessions) {
        const scoped = routeDaemonMessage(message);
        if (!scoped) return;
        if (att.machineId && scoped.route.kind === "owner" && typeof scoped.message === "string" &&
            scoped.message.length < 8000) {
          this.recordHeartbeat(att.machineId, scoped.message);
        }
        for (const b of this.ctx.getWebSockets("browser")) {
          const browser = b.deserializeAttachment() || {};
          if (!routeAllowsBrowser(scoped.route, browser, att.accountId)) continue;
          if (!this.closeIfBlocked(b)) this.safeSend(b, scoped.message);
        }
        return;
      }
      // Bound-machine heartbeat → D1 (small JSON stats only; skip binary + big dl-chunks).
      // The cap sits above a full stats frame — which now carries the activity
      // summary — but well below a dl-chunk, so file transfers still skip parsing.
      if (att.machineId && typeof message === "string" && message.length < 8000) {
        this.recordHeartbeat(att.machineId, message);
      }
      const route = daemonRoute(message, this._replayTargets);
      this._replayTargets = route.replayTargets;
      for (const b of this.ctx.getWebSockets("browser")) {
        const browser = b.deserializeAttachment() || {};
        if (route.target && browser.clientId !== route.target) continue;
        if (!this.closeIfBlocked(b)) this.safeSend(b, route.message);
      }
    } else {
      if (this.closeIfBlocked(ws)) return;
      const daemon = this.liveDaemon();
      if (!daemon) return;
      const daemonAtt = this.daemonAttachment(daemon);
      if (att.accessVia === "grant" && !daemonAtt.accountSessions) {
        this.rejectGrantSocket(ws);
        return;
      }
      if (daemonAtt.accountSessions) {
        const stamped = stampBrowserMessage(message, { ...att, protocolNonce: daemonAtt.protocolNonce });
        if (stamped != null) this.safeSend(daemon, stamped);
      } else {
        this.safeSend(daemon, browserMessage(message, att.clientId));
      }
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
      // A replacement daemon may already be accepted when the incumbent's
      // delayed close callback runs. Do not announce or persist a false offline
      // transition over the newer live connection.
      const replacement = this.ctx.getWebSockets("daemon")
        .some((candidate) => candidate !== ws && candidate.readyState === WS_OPEN);
      if (!replacement) {
        this.broadcastToBrowsers(JSON.stringify({ type: "_relay", event: "daemon-offline" }));
        if (machineId) { try { await setMachineOffline(this.env, machineId); } catch {} }
      }
    } else {
      this.notifyDaemonPeer(ws, false);
    }
  }

  webSocketError() {}

  liveDaemon() {
    return this.ctx.getWebSockets("daemon").find((socket) => socket.readyState === WS_OPEN) || null;
  }

  daemonAttachment(socket) {
    return socket?.deserializeAttachment() || {};
  }

  notifyDaemonAccountEnded(accountId, event) {
    const daemon = this.liveDaemon();
    if (!daemon || !this.daemonAttachment(daemon).accountSessions) return;
    this.safeSend(daemon, JSON.stringify({ type: "_relay", event, accountId }));
  }

  rejectGrantSocket(socket) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.blocked) return;
    attachment.blocked = "daemon-upgrade-required";
    socket.serializeAttachment(attachment);
    this.safeSend(socket, JSON.stringify({ type: "_relay", event: "daemon-upgrade-required" }));
    try { socket.close(4004, "machine owner must upgrade the daemon"); } catch {}
  }

  rejectLegacyGrants() {
    for (const browser of this.ctx.getWebSockets("browser")) {
      const attachment = browser.deserializeAttachment() || {};
      if (attachment.accessVia === "grant") this.rejectGrantSocket(browser);
    }
  }

  reconcileGrantSockets(activeGrants) {
    const byAccount = new Map(activeGrants.map((grant) => [grant.accountId, grant.expiresAt]));
    const now = Date.now();
    for (const browser of this.ctx.getWebSockets("browser")) {
      const attachment = browser.deserializeAttachment() || {};
      if (attachment.accessVia !== "grant" || attachment.blocked) continue;
      if (byAccount.has(attachment.accountId)) {
        // A reconnect snapshot is newer than the authentication result stored
        // on a long-lived socket. Refresh it so a stale socket cannot restore
        // an old deadline when browser-status follows the negotiation.
        attachment.expiresAt = byAccount.get(attachment.accountId);
        browser.serializeAttachment(attachment);
        continue;
      }
      attachment.blocked = Number.isFinite(attachment.expiresAt) && attachment.expiresAt <= now
        ? "access-expired" : "access-revoked";
      browser.serializeAttachment(attachment);
      this.safeSend(browser, JSON.stringify({ type: "_relay", event: attachment.blocked }));
      try {
        browser.close(4003, attachment.blocked === "access-expired"
          ? "machine access expired" : "machine access revoked");
      } catch {}
    }
  }

  notifyDaemonPeer(browserSocket = null, online = null) {
    const daemon = this.liveDaemon();
    if (!daemon) return;
    const daemonAtt = this.daemonAttachment(daemon);
    if (daemonAtt.accountSessions) {
      if (browserSocket) {
        const browser = browserSocket.deserializeAttachment() || {};
        if (online && browser.blocked) return;
        if (browser.accountId && browser.clientId) {
          this.safeSend(daemon, JSON.stringify({
            type: "_relay", event: "browser-status", online: !!online,
            accountId: browser.accountId, accessVia: browser.accessVia,
            clientId: browser.clientId, expiresAt: browser.expiresAt,
          }));
        }
      } else {
        for (const candidate of this.ctx.getWebSockets("browser")) {
          if (candidate.readyState === WS_OPEN) this.notifyDaemonPeer(candidate, true);
        }
      }
      return;
    }
    const anyOnline = this.ctx.getWebSockets("browser")
      .some((browser) => browser !== browserSocket && browser.readyState === WS_OPEN);
    this.safeSend(daemon, JSON.stringify({ type: "peer-status", online: anyOnline }));
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
    const replacement = this.ctx.getWebSockets("browser").some((candidate) =>
      candidate !== ws && candidate.readyState === WS_OPEN &&
      liveGrantForAccount(candidate.deserializeAttachment() || {}, a.accountId));
    if (!replacement) this.notifyDaemonAccountEnded(a.accountId, a.blocked);
    this.safeSend(ws, JSON.stringify({ type: "_relay", event: a.blocked }));
    try { ws.close(4003, "machine access expired"); } catch {}
    return true;
  }
  safeSend(ws, data) { try { ws.send(data); } catch {} }
}
