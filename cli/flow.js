/**
 * Flow runner — the conductor side of Switchboard.
 *
 * A flow is a graph of commands, each pinned to a node, wired together by exit
 * status. It rides entirely on the `exec` channel (see index.js), which means
 * the relay stays what it has always been: a transparent forwarder that never
 * learns a flow exists. That is deliberate. Putting orchestration in the relay
 * would force it to parse payloads, and the moment it parses payloads you can no
 * longer layer end-to-end encryption underneath it.
 *
 * Which machine conducts is chosen per flow, not baked in: the spec names a
 * `conductor`, and running the flow there is what makes it that flow's
 * conductor. A flow whose steps all target one machine should be conducted by
 * that machine — it saves a round trip through the relay for every step.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const { dial } = require("./target");

const DEFAULT_STEP_TIMEOUT_MS = 600000;

// ---- spec ----------------------------------------------------------------
/**
 * Read and validate a flow. Every problem found is reported at once rather than
 * one per run: a flow is usually edited by hand, and fixing a typo only to hit
 * the next one is the slowest possible way to learn the schema.
 */
function loadFlow(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  let flow;
  try { flow = JSON.parse(raw); }
  catch (e) { throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`); }

  const errs = [];
  if (flow.conductor != null && typeof flow.conductor !== "string") {
    errs.push("conductor must be the name or id of the machine this flow is meant to run on");
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) errs.push("steps must be a non-empty array");
  const ids = new Set();
  for (const [i, s] of (flow.steps || []).entries()) {
    const where = `step ${i}${s && s.id ? ` (${s.id})` : ""}`;
    if (!s || typeof s !== "object") { errs.push(`${where}: not an object`); continue; }
    if (!s.id) errs.push(`${where}: missing id`);
    else if (ids.has(s.id)) errs.push(`${where}: duplicate id`);
    else ids.add(s.id);
    if (!s.target) errs.push(`${where}: missing target (the token of the node to run on)`);
    if (!s.cmd || typeof s.cmd !== "string") errs.push(`${where}: missing cmd`);
  }
  // Edges are checked after every id is known, so a forward reference — which is
  // the normal way to write a retry or a cleanup step — is not a false positive.
  for (const s of flow.steps || []) {
    for (const edge of ["on_success", "on_failure"]) {
      const t = s && s[edge];
      if (t && t !== "stop" && !ids.has(t)) errs.push(`step ${s.id}: ${edge} points at unknown step "${t}"`);
    }
    if (s && s.stdin_from && !ids.has(s.stdin_from)) errs.push(`step ${s.id}: stdin_from points at unknown step "${s.stdin_from}"`);
  }
  if (errs.length) throw new Error(`${path.basename(file)} is not a valid flow:\n  - ` + errs.join("\n  - "));
  return flow;
}

// ---- one remote command --------------------------------------------------
/**
 * Run a single command on one node and resolve with its full result. This is the
 * `exec` channel's client half: join the circuit as a browser would, send one
 * exec, collect the two streams separately, and wait for the exit status.
 *
 * Resolves — rather than rejects — on a non-zero exit, because for a flow a
 * failing step is data (it selects the on_failure edge), not an exception.
 */
function execRemote(server, how, cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const sock = new WebSocket(how.url, { headers: how.headers || {} });
    const out = [], err = [];
    let settled = false;
    const started = Date.now();

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      // terminate() rather than close(): close() waits for the peer's closing
      // handshake, and ws gives that 30 seconds. A flow of twenty steps would
      // spend ten minutes doing nothing at all.
      try { sock.terminate(); } catch {}
      fn(arg);
    };

    sock.on("open", () => {
      sock.send(JSON.stringify({ type: "exec", id, cmd, cwd: opts.cwd || undefined, timeout: opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS }));
      if (opts.stdin != null && opts.stdin.length) {
        sock.send(JSON.stringify({ type: "exec-stdin", id, data: Buffer.from(opts.stdin).toString("base64") }));
      }
      sock.send(JSON.stringify({ type: "exec-stdin-end", id }));
    });

    sock.on("message", (data, isBinary) => {
      if (isBinary) return; // a PTY window sharing this circuit; not ours
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { return; }
      if (m.type === "_relay" && m.event === "daemon-offline") {
        return done(reject, new Error("no daemon is connected on that circuit"));
      }
      if (m.id !== id) return;
      if (m.type === "exec-out") {
        const buf = Buffer.from(m.data, "base64");
        (m.stream === "stderr" ? err : out).push(buf);
        if (opts.onOutput) opts.onOutput(m.stream, buf);
      } else if (m.type === "exec-error") {
        done(reject, new Error(m.message));
      } else if (m.type === "exec-exit") {
        // stdoutBuf as well as stdout: a flow reads text, but a file fetched
        // through this channel has to survive not being valid UTF-8.
        const stdoutBuf = Buffer.concat(out);
        done(resolve, {
          code: m.code, signal: m.signal || null,
          stdout: stdoutBuf.toString("utf8"),
          stdoutBuf,
          stderr: Buffer.concat(err).toString("utf8"),
          ms: m.ms ?? Date.now() - started,
        });
      }
    });

    sock.on("close", () => done(reject, new Error("the relay closed the connection before the command finished")));
    // The relay explains a refusal in the body; ws would only report the number.
    sock.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => done(reject, new Error(body.trim() || `the relay refused the connection (${res.statusCode})`)));
    });
    sock.on("error", (e) => done(reject, e));
  });
}

// ---- the graph -----------------------------------------------------------
/**
 * Walk the flow from its first step, following on_success / on_failure.
 *
 * Defaults are chosen so the common case needs no edges at all: success falls
 * through to the next step in document order, and failure stops the flow. A
 * pipeline reads top to bottom and aborts when something breaks, which is what
 * anyone writing one expects; edges are only for the exceptions.
 *
 * A step already visited ends the run rather than looping. Retry loops need a
 * bound to be safe, and silently spinning forever on a remote machine is a much
 * worse failure than refusing to.
 */
async function runFlow(flow, opts = {}) {
  const server = (opts.server || "https://shell.lfkdsk.org").replace(/\/+$/, "");
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const order = flow.steps.map((s) => s.id);
  const results = new Map();
  const log = opts.log || (() => {});

  // `conductor` names where the flow was written to run. It is an assertion, not
  // an instruction — nothing can make a flow start somewhere else — so a
  // mismatch is reported and the run continues. Ignoring it silently would make
  // the field decorative; refusing to run would strand a flow whose usual
  // conductor is asleep.
  if (flow.conductor && opts.self && flow.conductor !== opts.self.machineId && flow.conductor !== opts.self.name) {
    log("conductor-mismatch", { want: flow.conductor, here: opts.self.name || opts.self.machineId || "this host" });
  }

  // Resolve every target before the first command runs. Discovering a typo in
  // step five after steps one to four have already changed something is the one
  // failure this can cheaply prevent.
  const dials = new Map();
  const unresolved = [];
  for (const t of new Set(flow.steps.map((s) => s.target))) {
    try { dials.set(t, await dial(server, t, opts.agentToken)); }
    catch (e) { unresolved.push(`  ${t}: ${e.message.split("\n")[0]}`); }
  }
  if (unresolved.length) {
    throw new Error(`${unresolved.length} target(s) in this flow could not be resolved:\n${unresolved.join("\n")}\n\n` +
      "Run `switchboard list` to see what this host can reach.");
  }

  let cur = flow.start || order[0];
  const seen = new Set();
  let last = null; // the step the flow actually ended on — see the verdict below

  while (cur && cur !== "stop") {
    if (seen.has(cur)) { log("halt", { id: cur, reason: "already ran; flows do not loop" }); break; }
    seen.add(cur);

    const step = byId.get(cur);
    log("step-start", { id: step.id, target: step.target, cmd: step.cmd });

    // stdin_from wires one step's stdout into the next one's stdin. It reads the
    // recorded result rather than streaming, so a step can consume output from
    // any earlier step, not only the one immediately before it.
    const upstream = step.stdin_from ? results.get(step.stdin_from) : null;

    let r;
    try {
      r = await execRemote(server, dials.get(step.target), step.cmd, {
        timeout: step.timeout ?? flow.timeout ?? DEFAULT_STEP_TIMEOUT_MS,
        stdin: upstream ? upstream.stdout : null,
        onOutput: opts.onOutput ? (s, b) => opts.onOutput(step.id, s, b) : null,
      });
    } catch (e) {
      // An unreachable node is a failed step, not a crashed flow: the on_failure
      // edge is exactly where "the machine is down" wants to be handled.
      r = { code: null, signal: null, stdout: "", stderr: String(e.message), ms: 0, unreachable: true };
    }

    results.set(step.id, r);
    last = r;
    const ok = r.code === 0 && !r.unreachable;
    log("step-end", { id: step.id, ok, code: r.code, signal: r.signal, ms: r.ms, unreachable: !!r.unreachable });

    if (ok) cur = step.on_success ?? order[order.indexOf(step.id) + 1] ?? null;
    else cur = step.on_failure ?? "stop";
  }

  // The verdict is the step the flow ended on, not "did anything fail". Writing
  // an on_failure edge is the author saying they intend to handle that failure —
  // if the recovery step then succeeds, the flow did its job, and reporting it
  // as failed would make every flow with a fallback path permanently red.
  // Steps that failed along the way are still listed, because "it recovered"
  // and "nothing went wrong" are not the same thing worth knowing.
  const failed = [...results.entries()].filter(([, r]) => r.code !== 0 || r.unreachable).map(([id]) => id);
  const ok = !!last && last.code === 0 && !last.unreachable;
  return { results, failed, ok };
}

module.exports = { loadFlow, runFlow, execRemote, DEFAULT_STEP_TIMEOUT_MS };
