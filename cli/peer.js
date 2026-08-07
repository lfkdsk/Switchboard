/**
 * Peer commands — the machines on your account, from a machine on your account.
 *
 * The dashboard has always been able to see every host you've bound and open a
 * shell on any of them. This is the same capability without the browser: the
 * agent token in ~/.switchboard/config.json authenticates to the relay as *you*,
 * so a host can list its siblings (`nodes`) and drive one (`exec`, `shell`).
 *
 * That matters most for the thing already living on these machines — an agent.
 * `switchboard exec build-box npm test` is a plain command with plain stdout and
 * a real exit code, so Claude Code running on your laptop can use another host
 * the same way it uses a local shell.
 *
 * Reaching a machine needs two yeses: the relay checks that the target belongs
 * to the same account, and the target itself must have declared `peer` on
 * connect (SWITCHBOARD_PEER). We are only ever the client here — the daemon in
 * index.js is what answers.
 */

const crypto = require("crypto");
const WebSocket = require("ws");

// ---- talking to the relay ------------------------------------------------
async function fetchNodes(ctx) {
  let r;
  try {
    r = await fetch(ctx.server + "/api/nodes", { headers: { "x-switchboard-agent": ctx.agentToken } });
  } catch (e) {
    fail(`Could not reach the relay at ${ctx.server}: ${e.message}`);
  }
  if (r.status === 401) {
    fail("The relay rejected this machine's credential.\nRun `switchboard login` again to renew it.");
  }
  // A relay that predates peer support has no /api/nodes at all, and "404" on
  // its own would send you looking for a missing machine instead of an old relay.
  if (r.status === 404) {
    fail(`The relay at ${ctx.server} doesn't support reaching your other machines yet.\n\n` +
      "It needs deploying from a version of Switchboard that has it (relay first,\n" +
      "then the CLI — the machines themselves can update whenever).");
  }
  if (!r.ok) fail(`Relay error ${r.status} listing your machines.`);
  let body;
  // Anything but JSON here means we're not talking to a Switchboard relay — a
  // captive portal, a proxy error page, a typo'd --server. Say that, rather than
  // letting a parser error surface as the diagnosis.
  try { body = await r.json(); } catch { fail(`${ctx.server} didn't answer with JSON — is that the right relay?`); }
  // The relay's clock stamped last_seen, so measure "ago" against the relay's
  // now — not ours. Two machines are rarely in sync to the second.
  return { nodes: body.nodes || [], skew: Date.now() - (body.now || Date.now()) };
}

// ws's close() waits up to 30s for the peer's close frame before giving up on
// the socket, which would leave `switchboard exec` sitting there long after its
// command finished. Ask politely, then hang up — the frames we still owe (an
// exec-kill, say) go out first, and the unref'd timer only fires because the
// socket itself is what's keeping us alive.
function hangUp(ws) {
  try { ws.close(); } catch {}
  setTimeout(() => { try { ws.terminate(); } catch {} }, 500).unref();
}

function peerSocket(ctx, machineId) {
  const url = ctx.server.replace(/^http/, "ws") + "/ws?role=browser&machine=" + encodeURIComponent(machineId);
  const ws = new WebSocket(url, { headers: { "x-switchboard-agent": ctx.agentToken } });
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => fail(`Relay refused the connection (${res.statusCode}): ${body.trim() || "no reason given"}`));
  });
  ws.on("error", (e) => fail("Connection failed: " + e.message));
  return ws;
}

// ---- picking a machine ---------------------------------------------------
// Accepts a machine id, an unambiguous prefix of one, or a hostname — the three
// things you'd plausibly have in hand. Ambiguity is an error rather than a
// guess: picking the wrong host and running a command on it is not recoverable.
function match(nodes, selector) {
  const q = selector.toLowerCase();
  const exact = nodes.filter((n) => n.machine_id === selector || (n.name || "").toLowerCase() === q);
  if (exact.length) return exact;
  return nodes.filter((n) => n.machine_id.startsWith(q) || (n.name || "").toLowerCase().startsWith(q));
}

async function pickNode(ctx, selector, { needOnline = true } = {}) {
  const { nodes, skew } = await fetchNodes(ctx);
  if (!nodes.length) {
    fail("No machines on this account yet.\nRun `switchboard login` on the machines you want to reach.");
  }
  const hits = match(nodes, selector);
  if (!hits.length) {
    fail(`No machine matches “${selector}”.\n\nYour machines:\n` +
      nodes.map((n) => "  " + label(n, ctx)).join("\n"));
  }
  if (hits.length > 1) {
    fail(`“${selector}” matches ${hits.length} machines:\n` +
      hits.map((n) => "  " + label(n, ctx)).join("\n") + "\n\nUse a longer prefix or the full id.");
  }
  const node = hits[0];
  if (needOnline && !node.online) {
    fail(`“${label(node, ctx)}” is offline (last seen ${ago(node.last_seen, skew)}).`);
  }
  if (needOnline && !node.peer) {
    fail(`“${label(node, ctx)}” does not accept connections from your other machines.\n\n` +
      "Its daemon was started with SWITCHBOARD_PEER=0 (or predates peer support).\n" +
      "Restart it without that to allow this.");
  }
  return { node, skew };
}

function label(n, ctx) {
  const short = n.machine_id.slice(0, 8);
  const name = n.name || "(unnamed)";
  return n.machine_id === ctx.machineId ? `${name} [${short}] (this machine)` : `${name} [${short}]`;
}

// ---- switchboard nodes ---------------------------------------------------
async function cmdNodes(ctx, opts) {
  const { nodes, skew } = await fetchNodes(ctx);
  if (opts.json) {
    console.log(JSON.stringify(nodes.map((n) => ({
      id: n.machine_id,
      name: n.name || null,
      self: n.machine_id === ctx.machineId,
      online: !!n.online,
      peer: !!n.peer,
      lastSeenMsAgo: Math.max(0, Date.now() - skew - n.last_seen),
      rtt: n.rtt ?? null,
      cpu: n.cpu ?? null,
      memUsed: n.mem_used ?? null,
      memTotal: n.mem_total ?? null,
      activity: n.activity || null,
    })), null, 2));
    return;
  }
  if (!nodes.length) {
    console.log("\nNo machines on this account yet — run `switchboard login` on one.\n");
    return;
  }
  const width = Math.max(...nodes.map((n) => (n.name || "(unnamed)").length));
  console.log("");
  for (const n of nodes) {
    const self = n.machine_id === ctx.machineId;
    const dot = n.online ? "●" : "○";
    const name = (n.name || "(unnamed)").padEnd(width);
    const notes = n.online ? liveNotes(n) : [`offline · last seen ${ago(n.last_seen, skew)}`];
    // Both, when both apply: "this machine" on its own would quietly hide that
    // this is the one host on the list refusing the commands you're about to type.
    if (!n.peer) notes.unshift("peer off");
    if (self) notes.unshift("this machine");
    console.log(`  ${dot} ${name}  ${n.machine_id.slice(0, 8)}  ${notes.join(" · ")}`);
  }
  console.log("\n  switchboard exec <name> <command>    run something over there");
  console.log("  switchboard shell <name>             open a shell over there\n");
}

// One line of "what is this box doing", built from the same activity blob the
// dashboard renders: an agent if one is running, otherwise the busiest shell.
function liveNotes(n) {
  const out = [];
  if (n.rtt != null) out.push(n.rtt + "ms");
  if (n.cpu != null) out.push("cpu " + Math.round(n.cpu * 100) + "%");
  const act = n.activity || {};
  const agent = (act.agents || [])[0];
  if (agent) {
    out.push("claude: " + (agent.title || agent.cwd || "session") + (agent.tool ? ` (${agent.tool})` : ""));
  } else if ((act.shells || []).length) {
    const busiest = act.shells.reduce((a, b) => (b.idle < a.idle ? b : a));
    out.push(`${act.shells.length} shell${act.shells.length > 1 ? "s" : ""}` +
      (busiest.proc ? ` · ${busiest.proc}` : ""));
  }
  return out;
}

// ---- switchboard exec ----------------------------------------------------
async function cmdExec(ctx, opts) {
  const { node } = await pickNode(ctx, opts.target);
  const ws = peerSocket(ctx, node.machine_id);
  const id = crypto.randomUUID();
  let finished = false;

  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  const finish = (code, note) => {
    if (finished) return;
    finished = true;
    if (note) console.error(note);
    // Set the code and let the process wind down on its own: process.exit()
    // here would truncate whatever stdout has not yet flushed to a pipe.
    process.exitCode = code;
    clearTimeout(timer);
    try { process.stdin.pause(); } catch {}
    hangUp(ws);
  };

  const timer = opts.timeout
    ? setTimeout(() => { send({ type: "exec-kill", id, signal: "SIGTERM" }); finish(124, `\nTimed out after ${opts.timeout}s.`); }, opts.timeout * 1000)
    : null;

  ws.on("open", () => {
    // Piped stdin is forwarded; a terminal's is not. Holding a TTY open would
    // leave `switchboard exec box -- ls` waiting on a human who has nothing to type.
    const piped = !process.stdin.isTTY;
    send({ type: "exec", id, cmd: opts.command, cwd: opts.cwd || null, stdin: piped });
    if (piped) {
      process.stdin.on("data", (d) => send({ type: "exec-stdin", id, data: d.toString("base64") }));
      process.stdin.on("end", () => send({ type: "exec-stdin-end", id }));
    }
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // another window's terminal traffic on the same circuit
    const text = data.toString("utf8");
    if (text === "pong") return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.type === "_relay" && m.event === "daemon-offline") {
      return finish(255, `\nHost ${node.name || node.machine_id} went offline.`);
    }
    if (m.id !== id) return; // stats, other callers' output, someone else's shell
    switch (m.type) {
      case "exec-out": process.stdout.write(Buffer.from(m.data, "base64")); break;
      case "exec-err": process.stderr.write(Buffer.from(m.data, "base64")); break;
      case "exec-exit":
        finish(m.code == null ? 255 : m.code,
          m.error ? `switchboard: ${m.error}` : m.signal ? `\nKilled by ${m.signal}.` : null);
        break;
    }
  });

  ws.on("close", () => { finish(255, finished ? null : "\nConnection closed before the command finished."); });

  // Ctrl-C reaches the remote process group; a second one gives up locally, the
  // way ssh does, so a command that ignores SIGINT can't trap you here.
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts >= 2) process.exit(130);
    send({ type: "exec-kill", id, signal: "SIGINT" });
  });
}

// ---- switchboard shell ---------------------------------------------------
// The browser terminal, in your terminal: same protocol, same sessions. A shell
// opened here shows up as a tab in the dashboard, and survives detaching.
async function cmdShell(ctx, opts) {
  const { node } = await pickNode(ctx, opts.target);
  const ws = peerSocket(ctx, node.machine_id);
  const name = node.name || node.machine_id.slice(0, 8);
  let sid = opts.sid || null;
  let raw = false;

  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

  const restore = () => {
    if (raw) { try { process.stdin.setRawMode(false); } catch {} raw = false; }
    try { process.stdin.pause(); } catch {}
  };
  const leave = (msg, code = 0) => {
    restore();
    process.exitCode = code;
    // Say why before hanging up: the socket closing is what ends the process.
    if (msg) process.stdout.write("\r\n" + msg + "\r\n");
    hangUp(ws);
  };

  const startSession = () => {
    if (!sid) sid = crypto.randomUUID();
    send({ type: "open", sid, ...size() });
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); raw = true; }
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      // Ctrl-] detaches — the shell keeps running on the host (that's the whole
      // point of bound sessions), so this is "step away", not "hang up".
      if (chunk.length === 1 && chunk[0] === 0x1d) {
        return leave(`[detached] reattach with:  switchboard shell ${name} ${sid}`);
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(frame(sid, chunk), { binary: true });
    });
    process.stdout.on("resize", () => send({ type: "resize", sid, ...size() }));
  };

  ws.on("open", () => {
    process.stdout.write(`\x1b[2mconnected to ${name} — Ctrl-] to detach\x1b[0m\r\n`);
    // `--attach` with no id means "whatever I left running there"; ask for the
    // list first and take the newest, which is nearly always the one you mean.
    if (opts.attach && !sid) send({ type: "list-sessions" });
    else startSession();
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const sidLen = data[0];
      if (data.toString("utf8", 1, 1 + sidLen) !== sid) return; // another window's shell
      process.stdout.write(data.subarray(1 + sidLen));
      return;
    }
    const text = data.toString("utf8");
    if (text === "pong") return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    switch (m.type) {
      case "sessions":
        if (sid) break; // already attached; this is just the host keeping us posted
        if ((m.list || []).length) {
          sid = m.list.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)).sid;
          process.stdout.write(`\x1b[2mreattaching to ${sid.slice(0, 8)}\x1b[0m\r\n`);
        }
        startSession();
        break;
      case "exit":
        if (m.sid === sid) leave(`[remote shell exited ${m.code}]`, m.code || 0);
        break;
      case "_relay":
        if (m.event === "daemon-offline") leave(`[${name} went offline]`, 255);
        break;
    }
  });

  ws.on("close", () => { restore(); process.exit(process.exitCode || 0); });
  process.on("exit", restore);
}

// Wire format shared with the daemon and the browser:
//   [1 byte sid length][sid utf8][payload]
function frame(sid, payload) {
  const s = Buffer.from(sid, "utf8");
  return Buffer.concat([Buffer.from([s.length]), s, payload]);
}

// ---- helpers -------------------------------------------------------------
function fail(msg, code = 1) {
  console.error("\n" + msg + "\n");
  process.exit(code);
}
function ago(t, skew = 0) {
  const s = Math.max(0, Math.round((Date.now() - skew - t) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

module.exports = { cmdNodes, cmdExec, cmdShell };
