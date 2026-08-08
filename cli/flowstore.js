/**
 * Where a flow lives: ~/.switchboard/flows/<name>.json on the conductor itself.
 *
 * A flow is stored on the machine that runs it, next to the credential it uses
 * to reach the other machines. The browser editor writes these files through the
 * daemon and `switchboard flow run <name>` reads the same ones back, so a flow
 * has exactly one copy and there is never a question of which is current. The
 * alternative — keeping specs in the relay's database — would have made the
 * relay the owner of something it must never execute, and left the file on disk
 * and the row in the table free to disagree.
 *
 * The cost is honest and small: a machine that is offline can't show you its
 * flows. It couldn't have run them either.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateFlow } = require("./flow");

const FLOWS_DIR = path.join(os.homedir(), ".switchboard", "flows");

// Names arrive from a browser, over a relay, from anyone the machine's owner has
// shared it with. They end up as a path, so they are checked as one: an
// allow-list rather than a hunt for "..", because the list of ways to walk out
// of a directory is longer than it looks and only ever gets longer.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function checkName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("..")) {
    throw new Error(
      `"${name}" is not a usable flow name — letters, digits, dot, dash and underscore, ` +
      "up to 64 characters, starting with a letter or digit.");
  }
  return name;
}

function flowPath(name) { return path.join(FLOWS_DIR, checkName(name) + ".json"); }

/**
 * Every flow on this machine, newest edit first.
 *
 * A file that no longer parses is listed with its problem rather than skipped.
 * Hiding it would mean the one flow you need to fix is the one flow the editor
 * refuses to show you.
 */
function listFlows() {
  let names;
  try { names = fs.readdirSync(FLOWS_DIR); }
  catch { return []; } // no directory yet is not an error, it's an empty list
  const out = [];
  for (const file of names) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    if (!NAME_RE.test(name)) continue; // not something we wrote; not ours to interpret
    const full = path.join(FLOWS_DIR, file);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    const entry = { name, updated: stat.mtimeMs, bytes: stat.size };
    try {
      const spec = JSON.parse(fs.readFileSync(full, "utf8"));
      const problems = validateFlow(spec);
      entry.title = typeof spec.name === "string" ? spec.name : "";
      entry.conductor = typeof spec.conductor === "string" ? spec.conductor : "";
      entry.steps = Array.isArray(spec.steps) ? spec.steps.length : 0;
      if (problems.length) entry.invalid = problems[0];
    } catch (e) {
      entry.steps = 0;
      entry.invalid = e.message;
    }
    out.push(entry);
  }
  return out.sort((a, b) => b.updated - a.updated);
}

function readFlow(name) {
  const full = flowPath(name);
  let raw;
  try { raw = fs.readFileSync(full, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`no flow called "${name}" on this machine`);
    throw new Error(`cannot read ${full}: ${e.message}`);
  }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`${name}.json is not valid JSON: ${e.message}`); }
}

/**
 * Write a flow, refusing anything that wouldn't run.
 *
 * Validating here rather than at run time is the whole point of having a store:
 * a flow saved from the editor at 5pm and triggered by someone else at 3am
 * should fail while its author is still looking at it.
 */
function saveFlow(name, spec) {
  const full = flowPath(name);
  if (!spec || typeof spec !== "object") throw new Error("a flow must be a JSON object");
  const problems = validateFlow(spec);
  if (problems.length) throw new Error(`this flow would not run:\n  - ${problems.join("\n  - ")}`);
  fs.mkdirSync(FLOWS_DIR, { recursive: true });
  // Through a temporary file: a half-written flow that still parses is the worst
  // possible outcome here, and a crash mid-write is exactly how you get one.
  const tmp = full + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, full);
  return full;
}

function removeFlow(name) {
  const full = flowPath(name);
  try { fs.unlinkSync(full); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`no flow called "${name}" on this machine`);
    throw e;
  }
  return full;
}

/**
 * Turn what someone typed into a file to read.
 *
 * A path that exists wins, so every `switchboard flow run ./nightly.json` that
 * worked before this store existed still does. Otherwise a bare word is a name
 * in the store — with a trailing .json forgiven, because the editor shows names
 * and the shell tab-completes files, and being wrong about which one you meant
 * is not worth an error message.
 */
function resolveFlowRef(ref) {
  if (fs.existsSync(ref)) return ref;
  if (ref.includes("/") || ref.includes("\\")) return ref; // an explicit path, missing
  return flowPath(ref.endsWith(".json") ? ref.slice(0, -5) : ref);
}

module.exports = { FLOWS_DIR, flowPath, listFlows, readFlow, saveFlow, removeFlow, resolveFlowRef, checkName };
