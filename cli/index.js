#!/usr/bin/env node
/**
 * Switchboard daemon — run this on the host machine you want to reach.
 *
 * It spawns a PTY (your shell) and dials OUT over WebSocket to a Switchboard
 * relay. A browser that opens the relay URL and presents the same token gets a
 * full interactive terminal on this machine. Because both ends dial out, this
 * works from behind NAT / firewalls with no inbound ports.
 *
 * This is a clean reimplementation of the @elsetech/webterm daemon (MIT),
 * speaking the same wire protocol as our Switchboard relay so the two ends are
 * developed together and protocol-level features (E2E, port-forwarding, …) can
 * be added on both sides at once.
 *
 * Options (flags override env vars):
 *   -t, --token <token>   Use a specific token (min 24 chars). Default: random 256-bit.
 *   -s, --server <url>    Relay origin. Default: http://localhost:8787 (dev).
 *       --shell <path>    Shell to spawn. Default: $SHELL, or bash/powershell.
 *   -v, --version         Print version and exit.
 *   -h, --help            Show help and exit.
 *
 * Env vars: SWITCHBOARD_TOKEN, SWITCHBOARD_SERVER, SWITCHBOARD_SHELL
 *           (WEBTERM_* are also accepted for drop-in compatibility.)
 */

const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const WebSocket = require("ws");
const pty = require("node-pty");
const fixPtyPerms = require("./scripts/fix-pty-perms");
const pkg = require("./package.json");

// ---- logging -------------------------------------------------------------
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const log = (...a) => console.log(`[${ts()}]`, ...a);
const logErr = (...a) => console.error(`[${ts()}]`, ...a);

// ---- structured status (opt-in) ------------------------------------------
// Emit one JSON object per line on each lifecycle event, so a supervisor (e.g.
// the macOS menu-bar app) can track online/offline, RTT and host stats without
// scraping the human-readable log. Two opt-in sinks, both off by default:
//   SWITCHBOARD_STATUS_FILE=<path>  append NDJSON to a file (Foundation-friendly)
//   SWITCHBOARD_JSON_STATUS=1       write NDJSON to fd 3 (inherited pipe)
// The file sink wins if both are set. Human logs on stdout/stderr are untouched.
const STATUS_FILE = process.env.SWITCHBOARD_STATUS_FILE || null;
const STATUS_FD = process.env.SWITCHBOARD_JSON_STATUS ? 3 : null;
const STATUS_ON = !!(STATUS_FILE || STATUS_FD);
function emitStatus(ev, extra) {
  if (!STATUS_ON) return;
  const line = JSON.stringify({ ev, t: Date.now(), ...extra }) + "\n";
  try {
    if (STATUS_FILE) fs.appendFileSync(STATUS_FILE, line);
    else fs.writeSync(STATUS_FD, line);
  } catch {}
}

const DEFAULT_SERVER = "https://shell.lfkdsk.org";
const MIN_TOKEN_LEN = 24; // reject weak custom tokens; the generated one is ~43 chars

// ---- CLI -----------------------------------------------------------------
function printHelp() {
  console.log(`Switchboard — expose this machine's shell to a Switchboard relay.

Usage:
  switchboard login            Sign in via browser, then expose this machine's shell
                               under your account — one step.
  switchboard [options]        Expose this shell using saved credentials, or an
                               anonymous one-off token if not signed in.
  switchboard logout           Remove the stored account credential.

Options:
  -t, --token <token>   Force anonymous mode with this token (min ${MIN_TOKEN_LEN} chars).
  -s, --server <url>    Relay origin. Default: ${DEFAULT_SERVER}
      --shell <path>    Shell to spawn. Default: $SHELL, or bash/powershell.
  -v, --version         Print version and exit.
  -h, --help            Show this help and exit.

Environment (overridden by the flags above):
  SWITCHBOARD_TOKEN, SWITCHBOARD_SERVER, SWITCHBOARD_SHELL  (WEBTERM_* also accepted)

Notes:
  Logged in → this machine shows up in your dashboard; only you can open its shell.
  Anonymous → the token is the credential; anyone who has it gets a shell here.`);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const inline = eq > -1 ? a.slice(eq + 1) : null;
    const name = eq > -1 ? a.slice(0, eq) : a;
    switch (name) {
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      case "-t": case "--token": opts.token = inline !== null ? inline : argv[++i]; break;
      case "-s": case "--server": opts.server = inline !== null ? inline : argv[++i]; break;
      case "--shell": opts.shell = inline !== null ? inline : argv[++i]; break;
      default:
        console.error(`Unknown option: ${a}\n`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

const rawArgs = process.argv.slice(2);
const sub = rawArgs[0] === "login" || rawArgs[0] === "logout" ? rawArgs.shift() : null;
const args = parseArgs(rawArgs);
if (args.help) { printHelp(); process.exit(0); }
if (args.version) { console.log(pkg.version); process.exit(0); }

const SERVER = (args.server || process.env.SWITCHBOARD_SERVER || process.env.WEBTERM_SERVER || DEFAULT_SERVER)
  .replace(/\/+$/, "");

// ---- account config (~/.switchboard/config.json) -------------------------
const CONFIG_DIR = path.join(os.homedir(), ".switchboard");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; } }
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  } catch (e) { logErr("could not save config: " + e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  try { exec(`${cmd} "${url}"`); } catch { /* best-effort; the URL is printed too */ }
}

// `switchboard login` — browser-redirect auth that binds this machine to your account.
async function doLogin() {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("hex");
  const verifierHash = crypto.createHash("sha256").update(verifier).digest("hex");
  try {
    await fetch(SERVER + "/cli/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, verifier_hash: verifierHash }),
    });
  } catch (e) { console.error("Could not reach relay at " + SERVER + ": " + e.message); process.exit(1); }
  const loginUrl = SERVER + "/cli-login?state=" + encodeURIComponent(state);
  console.log("\nTo authorize this machine, open this URL and sign in:\n\n  " + loginUrl + "\n");
  openBrowser(loginUrl);
  process.stdout.write("Waiting for authorization");
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(2000);
    process.stdout.write(".");
    let r;
    try { r = await (await fetch(`${SERVER}/cli/poll?state=${encodeURIComponent(state)}&verifier=${encodeURIComponent(verifier)}`)).json(); }
    catch { continue; }
    if (r.status === "ready") {
      const c = loadConfig();
      c.server = SERVER;
      c.agentToken = r.agentToken;
      c.login = r.login;
      if (!c.machineId) c.machineId = crypto.randomUUID();
      saveConfig(c);
      console.log(`\n\n✓ Signed in as ${r.login}. Exposing this machine's shell…\n`);
      return; // fall through to start the daemon (login is one step: sign in + expose)
    }
    if (r.status === "denied") { console.error("\nAuthorization was denied."); process.exit(1); }
  }
  console.error("\nTimed out waiting for authorization."); process.exit(1);
}
function doLogout() {
  const c = loadConfig();
  delete c.agentToken; delete c.login;
  saveConfig(c);
  console.log("Logged out. (Account credential removed; machine id kept for re-login.)");
  process.exit(0);
}

// Connection state, resolved by setupConnection() at startup — after any login —
// so it picks up freshly-saved credentials.
let cfg = loadConfig();
let BOUND = false;
let TOKEN = null, MACHINE = null, AGENT = null, wsUrl, browseUrl;

const SHELL =
  args.shell || process.env.SWITCHBOARD_SHELL || process.env.WEBTERM_SHELL || process.env.SHELL ||
  (process.platform === "win32" ? "powershell.exe" : "bash");

function setupConnection() {
  BOUND = !!cfg.agentToken && !args.token;
  if (BOUND) {
    MACHINE = cfg.machineId || crypto.randomUUID();
    if (!cfg.machineId) { cfg.machineId = MACHINE; saveConfig(cfg); }
    AGENT = cfg.agentToken;
    wsUrl = SERVER.replace(/^http/, "ws") + "/ws?role=daemon&machine=" + encodeURIComponent(MACHINE) +
      "&name=" + encodeURIComponent(os.hostname());
    browseUrl = SERVER + "/";
  } else {
    // 32 random bytes = 256 bits of entropy (~43 url-safe chars). Infeasible to guess.
    TOKEN = args.token || process.env.SWITCHBOARD_TOKEN || process.env.WEBTERM_TOKEN ||
      crypto.randomBytes(32).toString("base64url");
    if (TOKEN.length < MIN_TOKEN_LEN) {
      console.error(`ERROR: token must be at least ${MIN_TOKEN_LEN} characters (got ${TOKEN.length}).`);
      process.exit(1);
    }
    wsUrl = SERVER.replace(/^http/, "ws") + "/ws?role=daemon&token=" + encodeURIComponent(TOKEN);
    browseUrl = SERVER + "/?token=" + encodeURIComponent(TOKEN);
  }
  // node-pty's macOS spawn-helper can lose its +x bit when the prebuild is
  // extracted; re-assert it right before we need it so a fresh install works.
  fixPtyPerms();
}

// ---- sessions ------------------------------------------------------------
// One PTY per browser window. Each window carries a session id (sid); a reload
// reuses its sid and resumes, a new window gets a fresh sid and its own shell.
// Sessions outlive relay reconnects so a flaky link or tab reload doesn't lose
// work.
const sessions = new Map(); // sid -> { pty, graceTimer }
const SESSION_GRACE_MS = 60000;

// Binary frame format shared with the relay/browser:
//   [1 byte sid length][sid utf8 bytes][payload bytes]
function encodeFrame(sid, payloadBuf) {
  const sidBuf = Buffer.from(sid, "utf8");
  return Buffer.concat([Buffer.from([sidBuf.length]), sidBuf, payloadBuf]);
}
function sendSessionData(sid, str) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeFrame(sid, Buffer.from(str, "utf8")), { binary: true });
  }
}

function openSession(sid, cols, rows) {
  let s = sessions.get(sid);
  if (s) {
    if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = null; }
    if (cols > 0 && rows > 0) { try { s.pty.resize(cols, rows); } catch {} }
    s.pty.write("\f"); // Ctrl-L: redraw so a reattached window sees a prompt
    return s;
  }
  const p = pty.spawn(SHELL, [], {
    name: "xterm-color",
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd: process.env.HOME || process.cwd(),
    env: process.env,
  });
  s = { pty: p, graceTimer: null, startedAt: Date.now() };
  sessions.set(sid, s);
  p.onData((d) => sendSessionData(sid, d));
  p.onExit(({ exitCode }) => {
    sessions.delete(sid);
    sendCtl({ type: "exit", sid, code: exitCode });
    broadcastSessions();
    log(`[session ${sid}] shell exited (${exitCode})`);
  });
  broadcastSessions();
  log(`[session ${sid}] shell started (pid ${p.pid})`);
  return s;
}

// Report the live session list so a browser can show/attach tabs (tmux-style):
// sessions persist for the daemon's lifetime in bound mode and are reattachable.
function buildSessionList() {
  return Promise.all([...sessions.entries()].map(([sid, s]) =>
    new Promise((res) => getShellCwd(sid, (cwd) => res({ sid, startedAt: s.startedAt, cwd })))));
}
async function broadcastSessions() {
  try { sendCtl({ type: "sessions", list: await buildSessionList() }); } catch {}
}

function killSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  if (s.graceTimer) clearTimeout(s.graceTimer);
  sessions.delete(sid);
  try { s.pty.kill(); } catch {}
}

// A window's socket dropped: keep its shell briefly so a reload can reattach.
function scheduleSessionCleanup(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  if (s.graceTimer) clearTimeout(s.graceTimer);
  s.graceTimer = setTimeout(() => {
    log(`[session ${sid}] no reconnect within grace window, closing`);
    killSession(sid);
  }, SESSION_GRACE_MS);
}

// ---- banner --------------------------------------------------------------
function banner() {
  const line = "─".repeat(58);
  console.log(`\n┌${line}┐`);
  console.log("  Switchboard is live on " + os.hostname());
  console.log("");
  if (BOUND) {
    console.log("  Account : " + (cfg.login || "(signed in)"));
    console.log("  Machine : " + MACHINE);
    console.log("  Open    : " + browseUrl + "   (your dashboard)");
    console.log("");
    console.log("  Signed in — only you can open this machine's shell.");
  } else {
    console.log("  Token : " + TOKEN);
    console.log("  Open  : " + browseUrl);
    console.log("");
    console.log("  Anyone with this token gets a shell on this machine.");
  }
  console.log(`└${line}┘\n`);
  emitStatus("ready", {
    mode: BOUND ? "account" : "token",
    machine: os.hostname(),
    account: BOUND ? (cfg.login || null) : null,
    machineId: BOUND ? MACHINE : null,
    dashboardUrl: browseUrl,
    shareUrl: BOUND ? null : browseUrl,
    token: BOUND ? null : TOKEN,
  });
}

// ---- relay connection ----------------------------------------------------
let ws = null;
let reconnectDelay = 1000;
let announced = false;
let lastRtt = null, pingSentAt = 0; // relay-edge round-trip (ms), reported in stats
const activeDownloads = new Map(); // id -> fs.ReadStream
const activeUploads = new Map(); // id -> { stream, finalPath }

function sendCtl(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(wsUrl, AGENT ? { headers: { "x-switchboard-agent": AGENT } } : undefined);

  ws.on("open", () => {
    reconnectDelay = 1000;
    if (!announced) { banner(); announced = true; }
    log("[relay] connected");
    emitStatus("connected", { mode: BOUND ? "account" : "token" });
  });

  // Fatal server responses: 409 (another daemon on this circuit) and, in bound
  // mode, 401/403 (expired/invalid login). Retrying these would never succeed.
  ws.on("unexpected-response", (_req, res) => {
    if (res.statusCode === 409) {
      console.error(
        "\nERROR: this " + (BOUND ? "machine" : "token") + " already has a daemon connected on the relay.\n" +
          "       Stop the other one" + (BOUND ? "." : ", or choose a different --token.")
      );
      emitStatus("fatal", { reason: "conflict", code: res.statusCode });
      for (const sid of sessions.keys()) killSession(sid);
      process.exit(1);
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.error(
        `\nERROR: relay rejected this machine (${res.statusCode}). ` +
          "Your login may have expired — run `switchboard login` again."
      );
      emitStatus("fatal", { reason: "auth", code: res.statusCode });
      for (const sid of sessions.keys()) killSession(sid);
      process.exit(1);
    }
    log(`[relay] server responded ${res.statusCode}; will retry`);
    res.resume();
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Keystrokes from a window: [1-byte sid length][sid][payload].
      const sidLen = data[0];
      const sid = data.toString("utf8", 1, 1 + sidLen);
      const s = sessions.get(sid);
      if (s) s.pty.write(data.subarray(1 + sidLen).toString("utf8"));
      return;
    }
    const text = data.toString("utf8");
    if (text === "pong") { if (pingSentAt) lastRtt = Date.now() - pingSentAt; return; } // relay-edge RTT
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.type) {
      case "open":
        openSession(msg.sid, msg.cols, msg.rows);
        sendStats();
        break;
      case "resize": {
        if (!(msg.cols > 0 && msg.rows > 0)) break;
        const s = sessions.get(msg.sid);
        if (s) try { s.pty.resize(msg.cols, msg.rows); } catch {}
        break;
      }
      // tmux-style: closing a browser window does NOT end the shell when bound
      // to an account; only an explicit `close` (or the shell exiting) does.
      case "client-gone": if (!BOUND) scheduleSessionCleanup(msg.sid); break;
      case "list-sessions": broadcastSessions(); break;
      case "close": killSession(msg.sid); broadcastSessions(); break;
      case "ping": sendCtl({ type: "pong", t: msg.t }); break; // browser↔daemon RTT probe
      case "dl-open": startDownload(msg.id, msg.path); break;
      case "ul-open": startUpload(msg.id, msg.sid, msg.name); break;
      case "ul-chunk": uploadChunk(msg.id, msg.data); break;
      case "ul-end": endUpload(msg.id); break;
      case "peer-status":
        log("[relay] browser " + (msg.online ? "connected" : "disconnected"));
        emitStatus("peer", { online: !!msg.online });
        break;
    }
  });

  ws.on("close", (code) => {
    // 4001 = the relay handed this circuit to a newer daemon for the same
    // machine/token. Reconnecting would just kick that one off in an endless
    // loop, so step aside. Exit 0 so a supervisor (systemd/pm2) treats this as
    // an intentional stop and doesn't restart us back into the fight.
    if (code === 4001) {
      log("[relay] replaced by a newer daemon for this " + (BOUND ? "machine" : "token") + "; exiting.");
      emitStatus("fatal", { reason: "replaced", code });
      for (const sid of sessions.keys()) killSession(sid);
      process.exit(0);
    }
    // Sessions are kept across reconnects; their onData handlers check ws state.
    for (const stream of activeDownloads.values()) stream.destroy();
    activeDownloads.clear();
    for (const up of activeUploads.values()) up.stream.destroy();
    activeUploads.clear();
    log(`[relay] disconnected, retrying in ${reconnectDelay}ms`);
    emitStatus("disconnected", { code, retryInMs: reconnectDelay });
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  ws.on("error", (err) => {
    logErr("[relay] error: " + err.message);
    ws.close();
  });
}

// ---- file transfer -------------------------------------------------------
// Best-effort cwd of a window's shell, so uploads land where the user is.
function getShellCwd(sid, cb) {
  const fallback = () => process.env.HOME || process.cwd();
  const s = sessions.get(sid);
  const pid = s ? s.pty.pid : null;
  if (!pid) return cb(fallback());
  if (process.platform === "linux") {
    fs.readlink(`/proc/${pid}/cwd`, (err, dir) => cb(!err && dir ? dir : fallback()));
  } else if (process.platform === "darwin") {
    exec(`lsof -a -d cwd -p ${pid} -Fn`, (err, out) => {
      if (err) return cb(fallback());
      const line = out.split("\n").find((l) => l.startsWith("n"));
      cb(line ? line.slice(1) : fallback());
    });
  } else {
    cb(fallback());
  }
}

// Open for writing without clobbering: on a name clash, insert -1, -2, … before
// the extension. "wx" makes the check-and-create atomic.
function openUniqueFile(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; n < 100000; n++) {
    try {
      const fd = fs.openSync(candidate, "wx", 0o644);
      return { fd, finalPath: candidate };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      candidate = path.join(dir, `${stem}-${n}${ext}`);
    }
  }
  throw new Error("too many name collisions");
}

function startUpload(id, sid, name) {
  getShellCwd(sid, (dir) => {
    const safe = path.basename(String(name || "")).trim() || "upload";
    let opened;
    try {
      opened = openUniqueFile(dir, safe);
    } catch (e) {
      sendCtl({ type: "ul-error", id, message: e.message });
      return;
    }
    const stream = fs.createWriteStream(null, { fd: opened.fd });
    activeUploads.set(id, { stream, finalPath: opened.finalPath });
    stream.on("error", (e) => {
      activeUploads.delete(id);
      sendCtl({ type: "ul-error", id, message: e.message });
    });
    sendCtl({ type: "ul-ready", id });
  });
}

function uploadChunk(id, b64) {
  const up = activeUploads.get(id);
  if (up) up.stream.write(Buffer.from(b64, "base64"));
}

function endUpload(id) {
  const up = activeUploads.get(id);
  if (!up) return;
  up.stream.end(() => {
    activeUploads.delete(id);
    sendCtl({ type: "ul-done", id, path: up.finalPath, name: path.basename(up.finalPath) });
    log(`[file] received ${up.finalPath}`);
  });
}

// Stream a host file to the browser as base64 chunks, with backpressure.
function startDownload(id, rawPath) {
  if (!rawPath) {
    sendCtl({ type: "dl-error", id, message: "no path given" });
    return;
  }
  let filePath = rawPath;
  if (filePath === "~" || filePath.startsWith("~/")) {
    filePath = path.join(os.homedir(), filePath.slice(1));
  }
  filePath = path.resolve(filePath);

  fs.stat(filePath, (err, st) => {
    if (err) {
      sendCtl({ type: "dl-error", id, message: err.code === "ENOENT" ? "no such file" : err.message });
      return;
    }
    if (st.isDirectory()) {
      sendCtl({ type: "dl-error", id, message: "path is a directory" });
      return;
    }
    sendCtl({ type: "dl-meta", id, name: path.basename(filePath), size: st.size, mime: "application/octet-stream" });

    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    activeDownloads.set(id, stream);
    stream.on("data", (chunk) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { stream.destroy(); return; }
      stream.pause(); // resume once this chunk has flushed -> backpressure
      ws.send(JSON.stringify({ type: "dl-chunk", id, data: chunk.toString("base64") }), () => {
        if (ws && ws.readyState === WebSocket.OPEN) stream.resume();
      });
    });
    stream.on("end", () => {
      activeDownloads.delete(id);
      sendCtl({ type: "dl-end", id });
      log(`[file] sent ${filePath} (${st.size} bytes)`);
    });
    stream.on("error", (e) => {
      activeDownloads.delete(id);
      sendCtl({ type: "dl-error", id, message: e.message });
    });
  });
}

// ---- host metrics --------------------------------------------------------
let prevCpu = cpuSample();
function cpuSample() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
function cpuUsage() {
  const cur = cpuSample();
  const idleDiff = cur.idle - prevCpu.idle;
  const totalDiff = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - idleDiff / totalDiff));
}
function primaryIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

// total - freemem overstates "used" (page cache etc.); track *available* memory.
let memAvailable = os.freemem();
function refreshMemAvailable() {
  if (process.platform === "linux") {
    try {
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
      memAvailable = m ? parseInt(m[1], 10) * 1024 : os.freemem();
    } catch { memAvailable = os.freemem(); }
  } else if (process.platform === "darwin") {
    exec("vm_stat", (err, out) => {
      if (err) { memAvailable = os.freemem(); return; }
      const pageSize = parseInt((/page size of (\d+)/.exec(out) || [])[1], 10) || 4096;
      const pages = (re) => parseInt((re.exec(out) || [])[1], 10) || 0;
      const reclaimable =
        pages(/Pages free:\s+(\d+)/) +
        pages(/Pages inactive:\s+(\d+)/) +
        pages(/Pages speculative:\s+(\d+)/) +
        pages(/Pages purgeable:\s+(\d+)/);
      memAvailable = reclaimable * pageSize;
    });
  } else {
    memAvailable = os.freemem(); // Windows os.freemem() already reports available
  }
}
function sendStats() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  refreshMemAvailable();
  const total = os.totalmem();
  // cpuUsage() advances the sampling window, so compute these once and reuse
  // them for both the relay frame and the local status event.
  const cpu = cpuUsage();
  const memUsed = Math.max(0, Math.min(total, total - memAvailable));
  const cores = os.cpus().length;
  try {
    ws.send(JSON.stringify({
      type: "stats",
      cpu,
      memUsed,
      memTotal: total,
      cores,
      ip: primaryIp(),
      host: os.hostname(),
      platform: process.platform,
      rtt: lastRtt, // relay-edge round-trip from the previous tick (ms)
    }));
    emitStatus("stats", { cpu, memUsed, memTotal: total, cores, rtt: lastRtt });
    // Probe the relay edge for the next tick's rtt (auto-ponged, no DO wake).
    pingSentAt = Date.now();
    ws.send("ping");
  } catch { /* peer gone */ }
}

// ---- start ---------------------------------------------------------------
(async function main() {
  if (sub === "logout") return doLogout(); // remove creds and exit
  if (sub === "login") {
    // One step: sign in, then fall through to expose this machine's shell.
    await doLogin(); // saves config; fatal-exits on failure
    cfg = loadConfig();
  }
  setupConnection();
  refreshMemAvailable();
  setInterval(sendStats, 2000);
  log(`connecting to ${SERVER} …`);
  emitStatus("connecting", { server: SERVER, mode: BOUND ? "account" : "token" });
  connect();
  process.on("SIGINT", () => {
    log("shutting down.");
    emitStatus("stopping", {});
    for (const sid of sessions.keys()) killSession(sid);
    process.exit(0);
  });
})();
