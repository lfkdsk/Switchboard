/**
 * Peer commands — machines this account can reach, from a signed-in machine.
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
 * Reaching a machine needs two yeses: the relay checks ownership or an explicit
 * cross-account grant, and the target itself must have declared `peer` on
 * connect (SWITCHBOARD_PEER). We are only ever the client here — the daemon in
 * index.js is what answers.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { finalizeDownload, parseCopyOperands, removeFile } = require("./lib/peer-utils");

const CAPABILITY_TIMEOUT_MS = 2000;
const PROGRESS_MIN_BYTES = 1024 * 1024;
const WS_OPEN = 1;

// ---- talking to the relay ------------------------------------------------
async function fetchNodes(ctx) {
  let r;
  try {
    r = await (ctx.fetch || fetch)(ctx.server + "/api/nodes", { headers: { "x-switchboard-agent": ctx.agentToken } });
  } catch (e) {
    fail(`Could not reach the relay at ${ctx.server}: ${e.message}`);
  }
  if (r.status === 401) {
    fail("The relay rejected this machine's credential.\nRun `switchboard login` again to renew it.");
  }
  // A relay that predates peer support has no /api/nodes at all, and "404" on
  // its own would send you looking for a missing machine instead of an old relay.
  if (r.status === 404) {
    fail(`The relay at ${ctx.server} doesn't support reaching peer machines yet.\n\n` +
      "It needs deploying from a version of Switchboard that has it (relay first,\n" +
      "then the CLI — the machines themselves can update whenever).");
  }
  if (!r.ok) fail(`Relay error ${r.status} listing reachable machines.`);
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

function peerSocket(ctx, machineId, onFailure) {
  const url = ctx.server.replace(/^http/, "ws") + "/ws?role=browser&machine=" + encodeURIComponent(machineId);
  const Socket = ctx.WebSocket || require("ws");
  const ws = new Socket(url, { headers: { "x-switchboard-agent": ctx.agentToken } });
  let reportedFailure = false;
  const reportFailure = (error) => {
    if (!onFailure || reportedFailure) return;
    reportedFailure = true;
    onFailure(error);
  };
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => {
      const message = `Relay refused the connection (${res.statusCode}): ${body.trim() || "no reason given"}`;
      if (onFailure) reportFailure(new Error(message)); else fail(message);
    });
  });
  ws.on("error", (e) => {
    if (onFailure) reportFailure(new Error("Connection failed: " + e.message));
    else { console.error("\nConnection failed: " + e.message + "\n"); process.exitCode = 255; }
  });
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
    fail("No reachable machines yet.\nRun `switchboard login` on a machine, or ask its owner to share one with you.");
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
    fail(`“${label(node, ctx)}” does not accept peer connections.\n\n` +
      "Its daemon was started with SWITCHBOARD_PEER=0 (or predates peer support).\n" +
      "Restart it without that to allow this.");
  }
  return { node, skew };
}

function label(n, ctx) {
  const short = n.machine_id.slice(0, 8);
  const name = n.name || "(unnamed)";
  if (n.machine_id === ctx.machineId) return `${name} [${short}] (this machine)`;
  return `${name} [${short}]${n.shared ? ` (shared by @${n.owner_login})` : ""}`;
}

// ---- switchboard nodes ---------------------------------------------------
async function cmdNodes(ctx, opts) {
  const { nodes, skew } = await fetchNodes(ctx);
  if (opts.json) {
    console.log(JSON.stringify(nodes.map((n) => ({
      id: n.machine_id,
      name: n.name || null,
      self: n.machine_id === ctx.machineId,
      shared: !!n.shared,
      owner: n.shared ? n.owner_login : null,
      expiresAt: n.shared ? (n.expires_at ?? null) : null,
      online: !!n.online,
      peer: !!n.peer,
      lastSeenMsAgo: Math.max(0, Date.now() - skew - n.last_seen),
      rtt: n.rtt ?? null,
      cpu: n.cpu ?? null,
      memUsed: n.mem_used ?? null,
      memTotal: n.mem_total ?? null,
      activity: n.activity || null,
      platform: n.platform || n.activity?.platform || null,
      arch: n.arch || n.activity?.arch || null,
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
    const platform = n.platform || n.activity?.platform;
    const arch = n.arch || n.activity?.arch;
    if (platform || arch) notes.unshift([platform, arch].filter(Boolean).join("/"));
    // Both, when both apply: "this machine" on its own would quietly hide that
    // this is the one host on the list refusing the commands you're about to type.
    if (!n.peer) notes.unshift("peer off");
    if (n.shared) notes.unshift(`shared by @${n.owner_login}`);
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
  let timingOut = false;

  const send = (obj) => { if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)); };
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

  let timer = null;
  timer = opts.timeout
    ? setTimeout(async () => {
      timingOut = true;
      send({ type: "exec-kill", id, signal: "SIGTERM" });
      const guiBlocked = targetPlatform(node) === "darwin" && await probeGuiDialog(ws);
      // A permission-stalled process may not unwind on SIGTERM. Do not leave it
      // behind to create another dialog when the caller retries.
      send({ type: "exec-kill", id, signal: "SIGKILL" });
      finish(124, `\nTimed out after ${opts.timeout}s.` + (guiBlocked
        ? "\nhint: target may be blocked on a GUI permission dialog (UserNotificationCenter is running)"
        : ""));
    }, opts.timeout * 1000)
    : null;

  ws.on("open", () => {
    if (finished || timingOut) return;
    // Piped stdin is forwarded; a terminal's is not. Holding a TTY open would
    // leave `switchboard exec box -- ls` waiting on a human who has nothing to type.
    const piped = !process.stdin.isTTY && !opts.detach;
    const start = () => {
      send({
        type: "exec", id, cmd: opts.command, cwd: opts.cwd || null, stdin: piped,
        login: !!opts.login, shell: opts.shell || null, detach: !!opts.detach,
      });
      if (piped && !opts.detach) {
        process.stdin.on("data", (d) => send({ type: "exec-stdin", id, data: d.toString("base64") }));
        process.stdin.on("end", () => send({ type: "exec-stdin-end", id }));
      }
    };
    if (opts.detach || opts.shell || opts.login) {
      const required = [];
      if (opts.detach) required.push("jobs-v1");
      if (opts.shell || opts.login) required.push("exec-options-v1");
      requireCapabilities(ws, send, required, "this exec option")
        .then(start, (e) => finish(2, e.message));
    } else {
      start();
    }
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // another window's terminal traffic on the same circuit
    const text = data.toString("utf8");
    if (text === "pong") return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.type === "_relay") {
      if (m.event === "daemon-offline") return finish(255, `\nHost ${node.name || node.machine_id} went offline.`);
      if (m.event === "access-revoked" || m.event === "access-expired") {
        return finish(255, `\nMachine access ${m.event === "access-expired" ? "expired" : "was revoked"}.`);
      }
    }
    if (m.id !== id) return; // stats, other callers' output, someone else's shell
    switch (m.type) {
      case "exec-out": process.stdout.write(Buffer.from(m.data, "base64")); break;
      case "exec-err": process.stderr.write(Buffer.from(m.data, "base64")); break;
      case "exec-job":
        process.stdout.write(String(m.job || id) + "\n");
        finish(0);
        break;
      case "exec-exit":
        if (timingOut) break;
        finish(m.code == null ? 255 : m.code,
          m.error ? `switchboard: ${m.error}` : m.signal ? `\nKilled by ${m.signal}.` : null);
        break;
    }
  });

    ws.on("close", () => {
      if (!timingOut) finish(255, finished ? null : "\nConnection closed before the command finished.");
    });

  // Ctrl-C reaches the remote process group; a second one gives up locally, the
  // way ssh does, so a command that ignores SIGINT can't trap you here.
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts >= 2) process.exit(130);
    send({ type: "exec-kill", id, signal: "SIGINT" });
  });
  ws.on("error", () => { if (!finished && !timingOut) finish(255); });
}

// ---- switchboard cp ------------------------------------------------------
async function cmdCopy(ctx, opts) {
  const spec = parseCopyOperands(opts.source, opts.destination);
  const { node } = await pickNode(ctx, spec.node);
  return spec.direction === "download"
    ? downloadFile(ctx, node, spec)
    : uploadFile(ctx, node, spec);
}

async function downloadFile(ctx, node, spec) {
  if (/[\\/]$/.test(spec.localPath)) {
    throw new Error(`local destination is a directory; choose a file path: ${spec.localPath}`);
  }
  let local = path.resolve(spec.localPath);
  let localStat = null;
  try { localStat = await fs.promises.stat(local); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  if (!localStat) {
    const parent = path.dirname(local);
    const st = await fs.promises.stat(parent).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`local destination directory does not exist: ${parent}`);
  } else if (localStat.isDirectory()) {
    throw new Error(`local destination is a directory; choose a file path: ${local}`);
  } else if (!localStat.isFile()) {
    throw new Error(`local destination is not a regular file: ${local}`);
  }

  return new Promise((resolve, reject) => {
    let ws;
    const id = crypto.randomUUID();
    let temp = null;
    let output = null;
    let destination = local;
    let total = 0;
    let received = 0;
    let settled = false;
    const hash = crypto.createHash("sha256");
    const send = (obj) => { if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)); };
    const done = async (error) => {
      if (settled) return;
      settled = true;
      if (error) send({ type: "dl-cancel", id });
      if (output && !output.closed) {
        const stream = output;
        output = null;
        await new Promise((closed) => { stream.once("close", closed); stream.destroy(); });
      }
      if (temp) await removeFile(temp).catch(() => {});
      hangUp(ws);
      error ? reject(error) : resolve();
    };
    ws = peerSocket(ctx, node.machine_id, done);

    ws.on("open", () => {
      requireCapabilities(ws, send, ["cp-sha256-v1"], "file copy")
        .then(() => send({ type: "dl-open", id, path: spec.remotePath, base: "home" }), done);
    });
    ws.on("message", async (data, isBinary) => {
      if (settled) return;
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { return; }
      if (m.id !== id) return;
      try {
        if (m.type === "dl-meta") {
          total = Number(m.size) || 0;
          let existing = null;
          try { existing = fs.statSync(destination); } catch (e) { if (e.code !== "ENOENT") throw e; }
          if (existing?.isDirectory()) throw new Error(`local destination is a directory: ${destination}`);
          temp = path.join(path.dirname(destination), `.${path.basename(destination)}.switchboard-${id}.part`);
          output = fs.createWriteStream(temp, { flags: "wx", mode: 0o600 });
          output.on("error", done);
          return;
        }
        if (m.type === "dl-chunk") {
          if (!output) throw new Error("target sent file data before metadata");
          const chunk = Buffer.from(m.data, "base64");
          hash.update(chunk);
          received += chunk.length;
          if (!output.write(chunk)) {
            try { ws._socket?.pause(); } catch {}
            output.once("drain", () => { try { ws._socket?.resume(); } catch {} });
          }
          showProgress("download", received, total);
          return;
        }
        if (m.type === "dl-error") throw new Error(`download failed: ${m.message}`);
        if (m.type === "dl-end") {
          if (!output || !temp) throw new Error("target ended download without metadata");
          await closeWritable(output);
          output = null;
          if (received !== total) throw new Error(`download was incomplete (${received} of ${total} bytes)`);
          const actual = hash.digest("hex");
          await finalizeDownload(temp, destination, m.sha256, actual);
          temp = null;
          finishProgress("download", received, total);
          await done();
        }
      } catch (e) { await done(e); }
    });
    ws.on("close", () => { if (!settled) void done(new Error("connection closed before the download finished")); });
  });
}

async function uploadFile(ctx, node, spec) {
  const local = path.resolve(spec.localPath);
  const st = await fs.promises.stat(local).catch((e) => {
    throw new Error(e.code === "ENOENT" ? `local source does not exist: ${local}` : e.message);
  });
  if (st.isDirectory()) throw new Error(`local source is a directory; directory copies are not supported: ${local}`);
  if (!st.isFile()) throw new Error(`local source is not a regular file: ${local}`);

  return new Promise((resolve, reject) => {
    let ws;
    const id = crypto.randomUUID();
    let started = false;
    let settled = false;
    let sent = 0;
    let input = null;
    let stdinAck = null;
    const hash = crypto.createHash("sha256");
    let digest = null;
    const send = (obj) => { if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)); };
    const done = (error) => {
      if (settled) return;
      settled = true;
      if (stdinAck) { clearTimeout(stdinAck.timer); stdinAck.reject(error || new Error("upload ended")); stdinAck = null; }
      if (input) input.destroy();
      hangUp(ws);
      error ? reject(error) : resolve();
    };
    ws = peerSocket(ctx, node.machine_id, done);
    const stream = async () => {
      if (started) return;
      started = true;
      input = fs.createReadStream(local, { highWaterMark: 64 * 1024 });
      try {
        for await (const chunk of input) {
          const ack = new Promise((resolveAck, rejectAck) => {
            const timer = setTimeout(() => rejectAck(new Error("target stopped accepting upload data")), 30000);
            stdinAck = { resolve: resolveAck, reject: rejectAck, timer };
          });
          send({ type: "exec-stdin", id, data: chunk.toString("base64") });
          hash.update(chunk);
          sent += chunk.length;
          showProgress("upload", sent, st.size);
          await Promise.all([ack, socketDrain(ws)]);
        }
        if (sent !== st.size) throw new Error("local file changed size during upload");
        digest = hash.digest("hex");
        send({ type: "exec-stdin-end", id, sha256: digest });
      } catch (e) {
        send({ type: "exec-kill", id, signal: "SIGTERM" });
        done(e);
      }
    };

    ws.on("open", () => {
      requireCapabilities(ws, send, ["cp-sha256-v1"], "file copy").then(() => {
        send({
          type: "exec", id, cmd: "upload", stdin: true, login: false,
          upload: { path: spec.remotePath },
        });
      }, done);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { return; }
      if (m.id !== id) return;
      if (m.type === "exec-ready") void stream();
      else if (m.type === "exec-stdin-ready") {
        const ack = stdinAck;
        stdinAck = null;
        if (ack) { clearTimeout(ack.timer); ack.resolve(); }
      }
      else if (m.type === "exec-err") process.stderr.write(Buffer.from(m.data, "base64"));
      else if (m.type === "exec-exit") {
        if (m.code === 0 && m.sha256 === digest) {
          finishProgress("upload", sent, st.size);
          done();
        } else {
          done(new Error(m.error || (m.code === 0
            ? "upload checksum was not confirmed by the target"
            : `upload failed with exit code ${m.code == null ? "unknown" : m.code}`)));
        }
      }
    });
    ws.on("close", () => { if (!settled) done(new Error("connection closed before the upload finished")); });
  });
}

// ---- detached jobs -------------------------------------------------------
async function cmdJobs(ctx, opts) {
  const { node } = await pickNode(ctx, opts.target);
  const jobs = await requestOnce(ctx, node, "jobs-v1", "job queries",
    (id) => ({ type: "job-list", id }), "job-list");
  const list = jobs.jobs || [];
  if (opts.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    console.log("No retained jobs.");
    return;
  }
  const width = Math.max(8, ...list.map((j) => j.id.length));
  for (const job of list) {
    const result = job.status === "exited"
      ? `exit ${job.exitCode == null ? "?" : job.exitCode}`
      : job.status;
    const when = new Date(job.createdAt).toISOString();
    const truncated = job.truncated ? ` · truncated ${formatBytes(job.bytesDropped || 0)}` : "";
    console.log(`${job.id.padEnd(width)}  ${result.padEnd(10)}  ${when}${truncated}  ${job.command}`);
  }
}

async function cmdLogs(ctx, opts) {
  const { node } = await pickNode(ctx, opts.target);
  const ws = await capableSocket(ctx, node, ["jobs-v1"], "job logs");
  let offset = 0;
  try {
    while (true) {
      const m = await socketRequest(ws, (id) => ({ type: "job-read", id, job: opts.job, offset }),
        ["job-chunk", "job-error"]);
      if (m.type === "job-error") throw new Error(m.message);
      const chunk = Buffer.from(m.data || "", "base64");
      if (chunk.length) await writeOutput(process.stdout, chunk);
      offset = Number(m.offset) || offset + chunk.length;
      const running = m.record?.status === "running";
      if (offset < (Number(m.size) || 0)) continue;
      if (!opts.follow || !running) break;
      await delay(500);
    }
  } finally {
    hangUp(ws);
  }
}

async function cmdWait(ctx, opts) {
  const { node } = await pickNode(ctx, opts.target);
  const ws = await capableSocket(ctx, node, ["jobs-v1"], "job waiting");
  try {
    while (true) {
      const m = await socketRequest(ws, (id) => ({ type: "job-get", id, job: opts.job }),
        ["job-status", "job-error"]);
      if (m.type === "job-error") throw new Error(m.message);
      const job = m.record;
      if (job.status !== "running") {
        if (job.error) console.error(`switchboard: ${job.error}`);
        process.exitCode = job.status === "exited" && job.exitCode != null ? job.exitCode : 255;
        return;
      }
      await delay(500);
    }
  } finally {
    hangUp(ws);
  }
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

  const send = (obj) => { if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)); };
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
      if (ws.readyState === WS_OPEN) ws.send(frame(sid, chunk), { binary: true });
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
        else if (m.event === "access-revoked" || m.event === "access-expired") {
          leave(`[machine access ${m.event === "access-expired" ? "expired" : "was revoked"}]`, 255);
        }
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
function targetPlatform(node) {
  return node.platform || node.activity?.platform || null;
}

function requireCapabilities(ws, send, required, purpose) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Target daemon is too old for ${purpose}; update Switchboard on the target machine.`));
    }, CAPABILITY_TIMEOUT_MS);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { return; }
      if (m.type !== "capabilities" || m.id !== id) return;
      cleanup();
      const missing = required.filter((feature) => !(m.features || []).includes(feature));
      if (missing.length) {
        reject(new Error(`Target daemon ${m.version || "(unknown version)"} does not support ${purpose}; update it first.`));
      } else {
        resolve(m);
      }
    };
    const cleanup = () => { clearTimeout(timeout); ws.off("message", onMessage); };
    ws.on("message", onMessage);
    send({ type: "capabilities", id });
  });
}

function capableSocket(ctx, node, required, purpose) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const failed = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const ws = peerSocket(ctx, node.machine_id, failed);
    const send = (obj) => { if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)); };
    ws.on("open", () => {
      requireCapabilities(ws, send, required, purpose)
        .then(() => { if (!settled) { settled = true; resolve(ws); } },
          (e) => { hangUp(ws); failed(e); });
    });
  });
}

function socketRequest(ws, build, types) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("target did not answer the request")); }, 5000);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { return; }
      if (m.id !== id || !types.includes(m.type)) return;
      cleanup();
      resolve(m);
    };
    const onClose = () => { cleanup(); reject(new Error("connection closed before the target answered")); };
    const cleanup = () => { clearTimeout(timeout); ws.off("message", onMessage); ws.off("close", onClose); };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.send(JSON.stringify(build(id)));
  });
}

async function requestOnce(ctx, node, capability, purpose, build, responseType) {
  const ws = await capableSocket(ctx, node, [capability], purpose);
  try {
    const result = await socketRequest(ws, build, [responseType, "job-error"]);
    if (result.type === "job-error") throw new Error(result.message);
    return result;
  }
  finally { hangUp(ws); }
}

async function probeGuiDialog(ws) {
  if (ws.readyState !== WS_OPEN) return false;
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const done = (answer) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(answer);
    };
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { return; }
      if (m.id === id && m.type === "exec-exit") done(m.code === 0);
    };
    const timer = setTimeout(() => {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: "exec-kill", id, signal: "SIGKILL" }));
      done(false);
    }, 2000);
    ws.on("message", onMessage);
    ws.send(JSON.stringify({
      type: "exec", id, cmd: "/usr/bin/pgrep -x UserNotificationCenter >/dev/null",
      stdin: false, login: false, shell: "/bin/sh",
    }));
  });
}

function showProgress(action, current, total) {
  if (!process.stderr.isTTY || total < PROGRESS_MIN_BYTES) return;
  const percent = total ? Math.min(100, Math.floor(current * 100 / total)) : 0;
  process.stderr.write(`\r${action}: ${percent}% (${formatBytes(current)}/${formatBytes(total)})`);
}
function finishProgress(action, current, total) {
  if (!process.stderr.isTTY || total < PROGRESS_MIN_BYTES) return;
  showProgress(action, current, total);
  process.stderr.write("\n");
}
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MiB";
}
function closeWritable(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
function socketDrain(ws) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (ws.readyState !== WS_OPEN) return reject(new Error("connection closed during upload"));
      if (ws.bufferedAmount < 1024 * 1024) return resolve();
      setTimeout(check, 20);
    };
    check();
  });
}
function writeOutput(stream, chunk) {
  return stream.write(chunk) ? Promise.resolve() : new Promise((resolve) => stream.once("drain", resolve));
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

module.exports = { cmdCopy, cmdExec, cmdJobs, cmdLogs, cmdNodes, cmdShell, cmdWait };
