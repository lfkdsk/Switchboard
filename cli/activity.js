/**
 * Host activity — "what is this machine actually doing?", answered without
 * opening a shell.
 *
 * The dashboard already shows cpu/mem/rtt, but those don't say *what* is
 * running, and for an AI agent they actively mislead: an agent waiting on an
 * API response burns ~0% cpu, so a busy machine reads as idle. This module
 * builds a small summary that rides along on the existing 2s `stats` heartbeat.
 *
 * Three layers, cheapest first:
 *   1. shells — per PTY session: foreground process, cwd, and time since the
 *      shell last produced output (the honest liveness signal).
 *   2. top    — host-wide top processes by cpu, so work started outside
 *      Switchboard (tmux, ssh, systemd) still shows up.
 *   3. agents — opt-in: Claude Code sessions, read from the state it already
 *      keeps on disk. See collectAgents() for the privacy note.
 *
 * Layers 1-2 report process *names* only, never argv — a command line routinely
 * carries secrets (`mysql -p…`, `curl -H "authorization: …"`).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// `full`/`claude` opts into layer 3; anything else (including unset) stays on 1-2.
const MODE = (process.env.SWITCHBOARD_ACTIVITY || "").toLowerCase();
const WANT_AGENTS = MODE === "full" || MODE === "claude";

// Budgets. The whole payload shares the heartbeat frame, and the relay drops
// oversized frames rather than writing them to D1, so keep this comfortably small.
const MAX_SHELLS = 8;
const MAX_AGENTS = 6;
const MAX_TOP = 3;
const TITLE_MAX = 48;

// Wrappers are true but useless answers ("it's running zsh"). When the
// foreground process is one of these we drill into its descendants instead.
const WRAPPERS = new Set([
  "zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "screen", "tmux",
  "login", "su", "sudo", "env", "nice", "time", "watch", "script", "expect",
  "npm", "npx", "yarn", "pnpm", "make", "cargo", "uv", "poetry", "pipenv",
]);

// ---- process table -------------------------------------------------------
// One `ps` for the whole host, reused by every layer. Refreshed on its own
// timer rather than per-heartbeat: a fork every 2s on every machine is a real
// cost, and none of this data is worth that.
const PS_TTL_MS = 10000;
let psRows = [];
let psAt = 0;
let psInFlight = false;

// macOS `comm` is a full path; `ucomm` is the short name Linux's `comm` gives.
const COMM_COL = process.platform === "darwin" ? "ucomm=" : "comm=";

function refreshProcTable() {
  if (psInFlight || Date.now() - psAt < PS_TTL_MS) return;
  psInFlight = true;
  execFile("ps", ["-Ao", "pid=,ppid=,pcpu=," + COMM_COL], { maxBuffer: 4 << 20 }, (err, out) => {
    psInFlight = false;
    if (err) return;
    psAt = Date.now();
    const rows = [];
    for (const line of out.split("\n")) {
      // comm can contain spaces, so it takes everything after the third column.
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
      if (m) rows.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], comm: m[4].trim() });
    }
    psRows = rows;
  });
}

function descendants(rootPid) {
  const byParent = new Map();
  for (const r of psRows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const out = [];
  const walk = (pid, depth) => {
    if (depth > 6) return; // guard against a pathological/looping tree
    for (const c of byParent.get(pid) || []) { out.push(c); walk(c.pid, depth + 1); }
  };
  walk(rootPid, 0);
  return out;
}

// node-pty's `process` getter already tracks the pty's foreground process, which
// is the right answer most of the time and costs nothing. It's only wrong when
// that process is a wrapper — `npm run build` reports "npm" when the interesting
// thing is the compiler underneath — so in that case pick the busiest descendant.
function resolveProc(fgName, ptyPid) {
  if (!fgName || !WRAPPERS.has(fgName)) return fgName || null;
  const kids = descendants(ptyPid).filter((r) => !WRAPPERS.has(r.comm));
  if (!kids.length) return fgName || null;
  return kids.reduce((a, b) => (b.cpu > a.cpu ? b : a)).comm;
}

function topProcesses() {
  return [...psRows]
    .filter((r) => r.cpu >= 5) // below this it's noise, not "what the machine is doing"
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, MAX_TOP)
    .map((r) => ({ name: r.comm, cpu: Math.round(r.cpu) }));
}

// ---- Claude Code sessions (opt-in) ---------------------------------------
// Claude Code keeps ~/.claude/sessions/<pid>.json for every running instance,
// pointing at a transcript under ~/.claude/projects/. That gives us an exact
// answer — the title Claude Code generated for the session, which tool it is
// running right now, and when it last did anything — with no guessing and no
// scraping of terminal output.
//
// Privacy: `aiTitle` is a summary of what you asked for, so this is materially
// more sensitive than a process name and is why the whole layer is opt-in. We
// deliberately read *only* the title, the tool name, and timestamps — never
// `lastPrompt` and never message bodies.
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

const AGENT_TTL_MS = 5000;
const STALE_MS = 30 * 60 * 1000; // waiting-on-human for longer than this = parked, not running
let agentCache = { list: [], idle: 0 };
let agentAt = 0;
let agentInFlight = false;

// sessionId -> transcript path. The project directory is a slugified cwd, but
// the slug rule isn't ours to depend on, so we locate the file by its (unique)
// session id and remember where it was.
const transcriptPaths = new Map();

function findTranscript(sessionId) {
  const hit = transcriptPaths.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(PROJECTS_DIR, d, sessionId + ".jsonl");
    if (fs.existsSync(p)) { transcriptPaths.set(sessionId, p); return p; }
  }
  return null;
}

// Transcripts are append-only and grow into the hundreds of KB, so never read
// one whole. The tail holds everything we want: the newest ai-title record
// (Claude Code re-appends it on every update) and the last real message.
const TAIL_BYTES = 32 * 1024;
function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Titles change rarely and can fall out of the tail window on a long session,
// so remember the last one we saw per session.
const titleCache = new Map();

function parseTranscriptTail(file) {
  const text = readTail(file);
  if (!text) return null;
  const lines = text.split("\n");
  let title = null, state = null, tool = null, at = null;
  // Walk backwards: the first record of each kind we meet is the newest one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== "{") continue; // first line is usually a partial record
    let r;
    try { r = JSON.parse(line); } catch { continue; }

    if (!title && (r.type === "custom-title" || r.type === "ai-title")) {
      title = r.customTitle || r.aiTitle || null;
    }
    if (!state && (r.type === "assistant" || r.type === "user") && r.message) {
      const content = Array.isArray(r.message.content) ? r.message.content : [];
      const use = content.find((c) => c.type === "tool_use");
      if (r.type === "assistant") {
        // A turn that ends without calling a tool is Claude handing control
        // back — the session is waiting on the human, not stuck.
        state = use ? "tool" : "waiting";
        tool = use ? use.name : null;
      } else {
        // Either a tool result or a fresh prompt; both mean the model is next.
        state = "thinking";
      }
      at = Date.parse(r.timestamp) || null;
    }
    if (title && state) break;
  }
  return { title, state, tool, at };
}

// Start times, used to tell a live agent from a recycled pid: session files are
// never cleaned up, so ~/.claude/sessions is mostly dead pids and a match on pid
// alone would happily report a long-gone agent as running.
//
// Compare instants, not strings: `ps -o lstart=` prints local time while Claude
// Code records `procStart` in UTC, so the two texts never match literally even
// for the same process.
function livePids(pids, cb) {
  if (!pids.length) return cb(new Map());
  execFile("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], (err, out) => {
    const m = new Map();
    if (err) return cb(m); // every pid gone -> ps exits non-zero
    for (const line of out.split("\n")) {
      const mm = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (mm) m.set(+mm[1], Date.parse(mm[2])); // local-time text -> epoch ms
    }
    cb(m);
  });
}
// ps rounds to whole seconds and the two clocks are read a moment apart, so
// allow a small window rather than demanding equality.
const START_SKEW_MS = 2000;

function refreshAgents() {
  if (agentInFlight || Date.now() - agentAt < AGENT_TTL_MS) return;
  agentInFlight = true;
  const done = (res) => { agentCache = res; agentAt = Date.now(); agentInFlight = false; };
  const none = { list: [], idle: 0 };

  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")); } catch { return done(none); }

  const metas = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
      if (meta && meta.pid && meta.sessionId) metas.push(meta);
    } catch {}
  }
  if (!metas.length) return done(none);

  livePids(metas.map((m) => m.pid), (alive) => {
    const out = [];
    for (const meta of metas) {
      const startedAt = alive.get(meta.pid);
      if (!startedAt) continue;
      // Same pid, different process (recycled) — skip rather than mislabel it.
      // procStart is UTC; fall back to startedAt (already epoch ms) if absent.
      const expected = meta.procStart ? Date.parse(meta.procStart + " UTC") : meta.startedAt;
      if (expected && Math.abs(startedAt - expected) > START_SKEW_MS) continue;

      const file = findTranscript(meta.sessionId);
      const t = file ? parseTranscriptTail(file) : null;
      const title = (t && t.title) || titleCache.get(meta.sessionId) || null;
      if (title) titleCache.set(meta.sessionId, title);

      out.push({
        kind: "claude",
        cwd: shortenPath(meta.cwd),
        title: title ? clip(title, TITLE_MAX) : null,
        state: (t && t.state) || null,
        tool: (t && t.tool) || null,
        at: (t && t.at) || null,
      });
    }
    // A session left open overnight is still "running", but listing six of them
    // waiting on input from hours ago is noise that crowds out the one actually
    // working. Keep anything mid-turn plus anything recently touched; collapse
    // the rest into a count so they're still accounted for.
    const now = Date.now();
    const isStale = (a) => a.state === "waiting" && a.at && now - a.at > STALE_MS;
    const live = out.filter((a) => !isStale(a));
    const stale = out.length - live.length;

    // Busiest first: something mid-tool-call is more interesting than one that
    // has been waiting on a human for an hour.
    const rank = { tool: 0, thinking: 1, waiting: 2 };
    live.sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || (b.at || 0) - (a.at || 0));
    const kept = live.slice(0, MAX_AGENTS);
    done({ list: kept, idle: stale + (live.length - kept.length) });
  });
}

// ---- helpers -------------------------------------------------------------
function clip(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + "…"; }

// Keep the tail of a path — "~/Code/Switchboard" locates the work; the leading
// components are the same on every row and just eat the width budget.
function shortenPath(p) {
  if (!p) return null;
  let s = p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p;
  const parts = s.split(path.sep).filter(Boolean);
  if (parts.length > 3) s = (s.startsWith("~") ? "~/…/" : "…/") + parts.slice(-2).join("/");
  return clip(s, 40);
}

// ---- public API ----------------------------------------------------------
/**
 * Build the activity summary. `sessions` is the daemon's live session map
 * (sid -> { pty, lastOutputAt }); cwds are passed in because the daemon already
 * resolves them for uploads and there's no reason to do that work twice.
 */
function snapshot(sessions, cwdBySid) {
  refreshProcTable();
  if (WANT_AGENTS) refreshAgents();

  const now = Date.now();
  const shells = [];
  for (const [sid, s] of sessions) {
    if (shells.length >= MAX_SHELLS) break;
    let fg = null;
    try { fg = s.pty.process; } catch {}
    shells.push({
      sid,
      proc: resolveProc(fg, s.pty.pid),
      cwd: shortenPath(cwdBySid.get(sid)),
      idle: Math.max(0, now - (s.lastOutputAt || s.startedAt || now)),
    });
  }

  const act = { shells, top: topProcesses() };
  if (WANT_AGENTS) {
    if (agentCache.list.length) act.agents = agentCache.list;
    if (agentCache.idle) act.agentsIdle = agentCache.idle;
  }
  return act;
}

module.exports = { snapshot, agentsEnabled: WANT_AGENTS };
