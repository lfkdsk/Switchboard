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
const { exec, spawn, spawnSync } = require("child_process");
const WebSocket = require("ws");
const pty = require("node-pty");
const fixPtyPerms = require("./scripts/fix-pty-perms");
const { dial, machines: reachableMachines } = require("./target");
const activity = require("./activity");
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
  switchboard service <verb>   Linux: run in the background via systemd, starting
                               at boot. Verbs: install, uninstall, status.
  switchboard list             Machines this account can reach: your own, plus the
                               ones shared with you and what they allow.
  switchboard exec <machine> -- <command…>
                               Run one command on another machine and stream it
                               back here. No TTY, so stdout and stderr stay apart
                               and the exit code is the command's own — this is
                               the door for scripts and agents; the browser
                               terminal is the one for people. <machine> is a name
                               or id from "switchboard list", or a share token.

Options:
  -t, --token <token>   Force anonymous mode with this token (min ${MIN_TOKEN_LEN} chars).
  -s, --server <url>    Relay origin. Default: ${DEFAULT_SERVER}
      --shell <path>    Shell to spawn. Default: $SHELL, or bash/powershell.
      --timeout <ms>    exec only: give up on the command after this long.
  -v, --version         Print version and exit.
  -h, --help            Show this help and exit.

Environment (overridden by the flags above):
  SWITCHBOARD_TOKEN, SWITCHBOARD_SERVER, SWITCHBOARD_SHELL  (WEBTERM_* also accepted)
  SWITCHBOARD_ACTIVITY=claude   Also report live Claude Code sessions (title,
                                current tool, idle time) to your dashboard.
                                Off by default: a session title summarises what
                                you asked for, so it leaves this machine only
                                when you opt in.

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
      case "--timeout": opts.timeout = inline !== null ? inline : argv[++i]; break;
      default:
        console.error(`Unknown option: ${a}\n`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

// `exec` carries a target and then a whole command line of its own. Neither is
// ours to interpret, so both are lifted out of argv before parseArgs sees it —
// otherwise the command's flags would be read as the CLI's own and rejected.
// The words are re-joined for the far shell to re-split, the way ssh does it:
// quote anything that has to survive as a single argument.
function takeExecSpec(argv) {
  const target = argv[0] && !argv[0].startsWith("-") ? argv.shift() : null;
  const dash = argv.indexOf("--");
  const words = dash > -1 ? argv.splice(dash).slice(1) : [];
  return { target, cmd: words.join(" ") };
}

const rawArgs = process.argv.slice(2);
const sub = ["login", "logout", "service", "list", "exec"].includes(rawArgs[0]) ? rawArgs.shift() : null;
// `service` takes a bare verb of its own before the usual flags.
const serviceAction = sub === "service" && rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.shift() : null;
const execSpec = sub === "exec" ? takeExecSpec(rawArgs) : null;
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

// ---- background service (systemd --user) ---------------------------------
// The Linux counterpart to the macOS app's "launch at login": a user-level unit
// plus lingering, so the daemon comes up at boot and keeps running after you log
// out. User scope rather than /etc/systemd/system is the right level — the
// daemon reads ~/.switchboard/config.json and spawns *your* login shell, so it
// should run as you and needs no root.
const UNIT_NAME = "switchboard.service";
const UNIT_PATH = path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);
const sh = (cmd, argv) => spawnSync(cmd, argv, { encoding: "utf8" });
const die = (msg) => { console.error(msg); process.exit(1); };

// systemd needs literal absolute paths — it has no PATH lookup for ExecStart and
// no shell to expand anything. __filename is already symlink-resolved by Node,
// so a global install's bin shim resolves to the real module path.
const CLI_PATH = __filename;

function requireSystemd() {
  if (process.platform !== "linux") {
    die(process.platform === "darwin"
      ? "`service` manages a systemd unit and is Linux-only.\nOn macOS, use the menu-bar app instead: https://github.com/lfkdsk/Switchboard/releases"
      : `\`service\` manages a systemd unit and is Linux-only (this is ${process.platform}).`);
  }
  if (sh("systemctl", ["--user", "show-environment"]).status !== 0) {
    die("No systemd user manager is reachable here.\n\n" +
      "  • On Alpine/Devuan (OpenRC) or WSL without systemd, there's no user manager\n" +
      "    to install into — run the daemon under your own supervisor instead.\n" +
      "  • Over sudo or a non-login shell, XDG_RUNTIME_DIR may be unset; log in as\n" +
      "    this user directly and retry.");
  }
}

// A unit records absolute paths, so it outlives the process that wrote it only
// if those paths do. npx unpacks into a cache npm is free to evict.
function requireStablePath() {
  if (/[/\\]_npx[/\\]/.test(CLI_PATH)) {
    die("This copy of the CLI lives in npx's cache, which npm may delete at any\n" +
      "time — a unit pointing there would break on the next boot.\n\n" +
      "Install it for real first, then re-run:\n\n" +
      "  npm install -g @switch-board/cli\n" +
      "  switchboard service install\n");
  }
}

function unitBody() {
  const shell = args.shell || process.env.SWITCHBOARD_SHELL || process.env.WEBTERM_SHELL || process.env.SHELL;
  const token = args.token || process.env.SWITCHBOARD_TOKEN || process.env.WEBTERM_TOKEN;
  const env = [`Environment="SWITCHBOARD_SERVER=${SERVER}"`];
  // A systemd user unit starts from a near-empty environment, so $SHELL isn't
  // there to be read at boot the way it is in an interactive run. Pin it now or
  // every session silently falls back to bash.
  if (shell) env.push(`Environment="SWITCHBOARD_SHELL=${shell}"`);
  if (token) env.push(`Environment="SWITCHBOARD_TOKEN=${token}"`);
  return `[Unit]
Description=Switchboard — a shell on this machine, in your browser
Documentation=https://github.com/lfkdsk/Switchboard

[Service]
Type=simple
ExecStart="${process.execPath}" "${CLI_PATH}"
${env.join("\n")}
# Not Restart=always: when the relay hands this circuit to a newer daemon for the
# same machine, this one exits 0 on purpose (see the 4001 close handler). Only
# restarting on failure honours that instead of restarting back into the fight.
Restart=on-failure
RestartSec=5
# No After=network-online.target — that's a system target a user unit can't pull
# in, and the daemon already retries the relay with its own backoff.

[Install]
WantedBy=default.target
`;
}

function serviceInstall() {
  requireSystemd();
  requireStablePath();
  // Same rule the macOS app applies to silent launches: an anonymous token
  // nobody has seen is useless, and a fresh random one every restart is worse —
  // the URL would change on each boot. Demand a durable credential.
  if (!cfg.agentToken && !args.token && !process.env.SWITCHBOARD_TOKEN) {
    die("Not signed in, so the service would mint a new random token on every\n" +
      "restart — and nobody would ever see the URL it printed.\n\n" +
      "Bind this machine to your account first, then install:\n\n" +
      "  switchboard login       # Ctrl-C once it's connected\n" +
      "  switchboard service install\n\n" +
      "Or pin a fixed token you already hold:\n\n" +
      "  switchboard service install --token <token>\n");
  }

  fs.mkdirSync(path.dirname(UNIT_PATH), { recursive: true });
  // 0600: the unit may carry a token, and the token *is* the shell credential.
  fs.writeFileSync(UNIT_PATH, unitBody(), { mode: 0o600 });
  console.log("Wrote " + UNIT_PATH);

  // Lingering is what makes this survive logout and come up at boot; without it
  // the user manager only exists while a session does.
  const user = os.userInfo().username;
  const linger = sh("loginctl", ["enable-linger", user]);
  if (linger.status !== 0) {
    console.error(`\n! Could not enable lingering (${(linger.stderr || "").trim() || "loginctl unavailable"}).\n` +
      `  The service will still start when you log in, but not at boot. Fix with:\n\n` +
      `    sudo loginctl enable-linger ${user}\n`);
  }

  for (const argv of [["daemon-reload"], ["enable", "--now", UNIT_NAME]]) {
    const r = sh("systemctl", ["--user", ...argv]);
    if (r.status !== 0) die(`systemctl --user ${argv.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }

  console.log("\n✓ Switchboard is running in the background and will start at boot.\n");
  const hints = [
    [`systemctl --user status ${UNIT_NAME}`, "is it up?"],
    [`journalctl --user -u ${UNIT_NAME} -f`, "follow its log"],
    ["switchboard service uninstall", "undo all of this"],
  ];
  const w = Math.max(...hints.map(([c]) => c.length));
  for (const [cmd, note] of hints) console.log(`  ${cmd.padEnd(w)}   # ${note}`);
  if (cfg.agentToken) console.log(`\nThis machine should now appear in your dashboard: ${SERVER}`);
  console.log("");
  process.exit(0);
}

function serviceUninstall() {
  requireSystemd();
  if (!fs.existsSync(UNIT_PATH)) die("Nothing to remove — no unit at " + UNIT_PATH);
  sh("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
  fs.rmSync(UNIT_PATH, { force: true });
  sh("systemctl", ["--user", "daemon-reload"]);
  console.log(`✓ Stopped and removed ${UNIT_PATH}\n`);
  // Lingering is user-wide, so clearing it could take down someone else's
  // long-running units. Leave it and say so.
  console.log(`Lingering was left enabled (it's user-wide and other services may rely
on it). Turn it off with: sudo loginctl disable-linger ${os.userInfo().username}\n`);
  process.exit(0);
}

function doService(action) {
  switch (action) {
    case "install": return serviceInstall();
    case "uninstall": case "remove": return serviceUninstall();
    case "status": {
      requireSystemd();
      const r = spawnSync("systemctl", ["--user", "status", UNIT_NAME], { stdio: "inherit" });
      process.exit(r.status === null ? 1 : r.status);
      break;
    }
    default:
      die(`Usage: switchboard service <install|uninstall|status>\n\n` +
        `  install     Run Switchboard in the background via systemd, starting at boot.\n` +
        `  uninstall   Stop it and remove the unit.\n` +
        `  status      Show whether it's running.\n`);
  }
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
  s = { pty: p, graceTimer: null, startedAt: Date.now(), lastOutputAt: Date.now() };
  sessions.set(sid, s);
  p.onData((d) => { s.lastOutputAt = Date.now(); sendSessionData(sid, d); });
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

// ---- exec channel --------------------------------------------------------
// The non-interactive counterpart to a session. A PTY is the right thing for a
// person and the wrong thing for a program: the shell echoes what was typed,
// redraws it with escape codes, folds stderr into stdout, and the exit status
// disappears into a prompt. An exec runs the same shell with no tty at all, so
// a caller gets the two streams apart and the code the command really returned.
const execs = new Map(); // id -> { child, startedAt, timedOut, timeoutTimer, killTimer }
// Payload cap per exec-out frame, in base64 characters. The relay reads every
// string frame that passes through it, and one enormous frame also holds up
// everything queued behind it. A multiple of 4 is what makes splitting safe:
// each frame stays a whole number of base64 quads, so the far end can decode
// them one at a time instead of having to rejoin them first.
const EXEC_MAX_B64 = 32768;
const EXEC_KILL_AFTER_MS = 5000; // SIGTERM → SIGKILL grace once a timeout fires

function sendExecOut(id, stream, chunk) {
  const b64 = chunk.toString("base64");
  for (let i = 0; i < b64.length; i += EXEC_MAX_B64) {
    sendCtl({ type: "exec-out", id, stream, data: b64.slice(i, i + EXEC_MAX_B64) });
  }
}

// Drop the bookkeeping for an exec without touching the child — the callers
// below either already reaped it or are about to signal it themselves.
function forgetExec(id) {
  const e = execs.get(id);
  if (!e) return;
  if (e.timeoutTimer) clearTimeout(e.timeoutTimer);
  if (e.killTimer) clearTimeout(e.killTimer);
  execs.delete(id);
}

function startExec(msg) {
  const id = msg.id;
  if (!id) return; // nothing to address a reply to, so there is nothing to say
  if (execs.has(id)) {
    // The id is how stdin and kill find their child; a second one would make
    // both ambiguous. Refuse instead of quietly writing to the wrong process.
    sendCtl({ type: "exec-error", id, message: "an exec with this id is already running" });
    return;
  }
  if (typeof msg.cmd !== "string" || !msg.cmd) {
    sendCtl({ type: "exec-error", id, message: "cmd must be a non-empty string" });
    return;
  }

  let child;
  try {
    child = spawn(SHELL, ["-lc", msg.cmd], {
      cwd: msg.cwd || process.env.HOME || process.cwd(),
      // Merged over the daemon's environment, never replacing it: a command
      // that arrived without PATH or HOME would fail in ways the caller has no
      // way to diagnose from the other side of the relay.
      env: { ...process.env, ...(msg.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    sendCtl({ type: "exec-error", id, message: e.message });
    return;
  }
  const e = { child, startedAt: Date.now(), timedOut: false, timeoutTimer: null, killTimer: null };
  execs.set(id, e);

  // A command that exits without draining its stdin turns our next write into
  // an EPIPE on an unhandled 'error' event, which would take the daemon down
  // with it. Swallow it: the exec is over either way.
  child.stdin.on("error", () => {});
  child.stdout.on("data", (d) => sendExecOut(id, "stdout", d));
  child.stderr.on("data", (d) => sendExecOut(id, "stderr", d));

  const timeout = Number(msg.timeout) || 0; // 0, the default, means no limit
  if (timeout > 0) {
    e.timeoutTimer = setTimeout(() => {
      e.timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      // Anything that traps or ignores SIGTERM would otherwise hold its id, and
      // its process, forever. Escalate once and be done.
      e.killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, EXEC_KILL_AFTER_MS);
    }, timeout);
  }

  child.on("error", (err) => {
    if (!execs.has(id)) return;
    forgetExec(id);
    sendCtl({ type: "exec-error", id, message: err.message });
    logErr(`[exec ${id}] could not start: ${err.message}`);
  });
  // 'close' rather than 'exit': exit can fire while stdout still holds buffered
  // data, and a caller that reads exec-exit as end-of-output would lose the tail.
  child.on("close", (code, signal) => {
    if (!execs.has(id)) return; // spawn failed; exec-error already went out
    const ms = Date.now() - e.startedAt;
    forgetExec(id);
    // A shell that traps SIGTERM exits with an ordinary code, which reads as a
    // normal finish. Report the signal we sent so a timeout stays recognisable.
    sendCtl({ type: "exec-exit", id, code, signal: signal || (e.timedOut ? "SIGTERM" : null), ms });
    log(`[exec ${id}] exited (${signal || code}) after ${ms}ms`);
  });

  sendCtl({ type: "exec-started", id, pid: child.pid });
  log(`[exec ${id}] running: ${msg.cmd}`);
}

function execStdin(id, b64) {
  const e = execs.get(id);
  if (!e || typeof b64 !== "string") return;
  try { e.child.stdin.write(Buffer.from(b64, "base64")); } catch {}
}

function execStdinEnd(id) {
  const e = execs.get(id);
  if (!e) return;
  try { e.child.stdin.end(); } catch {}
}

// No exec-exit from here: the 'close' handler still sends it, so a caller
// learns how the command died the same way whether it asked for this or not.
function killExec(id, signal) {
  const e = execs.get(id);
  if (!e) return;
  try { e.child.kill(signal || "SIGTERM"); } catch {}
}

// Unlike a PTY session, an exec has nobody to reattach to it — its output went
// to a socket that is now gone, and the caller waiting on the exit code has
// gone with it. SIGKILL rather than a polite SIGTERM because we forget the
// entry here, so no one is left to escalate if the child ignores it.
function killAllExecs() {
  for (const [id, e] of [...execs.entries()]) {
    forgetExec(id);
    try { e.child.kill("SIGKILL"); } catch {}
  }
}

// ---- `switchboard exec` (the client end) ---------------------------------
// The other side of the channel above, so a script or an agent can drive a
// machine without a browser. It joins the circuit exactly as the web UI does —
// role=browser, same URL — and then does nothing but pass one command's two
// streams and its exit status through, which is what lets it exit with the
// command's own code and be useful in a pipeline.
async function doExec(spec) {
  if (!spec.target || !spec.cmd) {
    die("Usage: switchboard exec <machine> [--timeout <ms>] -- <command…>\n\n" +
      "  <machine>  A machine name or id from `switchboard list`, or a share token.\n\n" +
      "  Example:   switchboard exec pi -- ls -la /tmp\n");
  }
  let how;
  try { how = await dial(SERVER, spec.target, cfg.agentToken); }
  catch (e) { die("exec: " + e.message + "\n"); }
  const id = crypto.randomUUID();
  const sock = new WebSocket(how.url, { headers: how.headers });

  let done = false;
  const finish = (code) => {
    done = true;
    process.exitCode = code;
    // Deliberately not process.exit(): a redirected stdout flushes
    // asynchronously and the tail of the output would go missing. Dropping our
    // hold on stdin and the socket leaves nothing keeping the loop alive, so the
    // process ends by itself once the writes have drained.
    try { process.stdin.pause(); process.stdin.unref(); } catch {}
    // terminate(), not close(): close() starts a closing handshake and waits for
    // the peer's reply, and ws gives that a 30s timeout — through a relay that
    // doesn't hurry, every exec would take 30 seconds longer than the command it
    // ran (measured). exec-exit is the last thing we had to hear, so there is
    // nothing left to wait for.
    try { sock.terminate(); } catch {}
  };

  sock.on("open", () => {
    sock.send(JSON.stringify({ type: "exec", id, cmd: spec.cmd, timeout: Number(args.timeout) || 0 }));
    // A command that reads stdin would otherwise wait forever on a pipe nobody
    // writes to. Forward ours when it has been redirected, and say EOF straight
    // away when it hasn't — an interactive terminal has nothing to send.
    if (process.stdin.isTTY) return sock.send(JSON.stringify({ type: "exec-stdin-end", id }));
    process.stdin.on("data", (d) => sock.send(JSON.stringify({ type: "exec-stdin", id, data: d.toString("base64") })));
    process.stdin.on("end", () => sock.send(JSON.stringify({ type: "exec-stdin-end", id })));
  });

  sock.on("message", (data, isBinary) => {
    if (isBinary) return; // a PTY window sharing this circuit; none of our business
    let msg;
    try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
    if (msg.type === "_relay" && msg.event === "daemon-offline") {
      console.error("exec: no daemon is connected on that circuit.");
      return finish(1);
    }
    if (msg.id !== id) return; // circuits are shared; ignore other clients' work
    switch (msg.type) {
      case "exec-out":
        (msg.stream === "stderr" ? process.stderr : process.stdout).write(Buffer.from(msg.data, "base64"));
        break;
      case "exec-error":
        console.error("exec: " + msg.message);
        finish(1);
        break;
      case "exec-exit":
        // 128+signum is what a shell reports for a signalled child, so `$?`
        // means the same here as it would had the command run locally.
        finish(msg.signal ? 128 + (os.constants.signals[msg.signal] || 0) : (msg.code || 0));
        break;
    }
  });

  sock.on("close", () => {
    if (done) return;
    console.error("exec: the relay closed the connection before the command finished.");
    process.exit(1);
  });
  // A refused upgrade carries its reason in the body ("shared with you for shell
  // access only", "invalid agent token"). ws would otherwise surface only
  // "Unexpected server response: 403", which names the number and not the fix.
  sock.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => {
      console.error("exec: " + (body.trim() || `the relay refused the connection (${res.statusCode})`));
      process.exit(1);
    });
  });
  sock.on("error", (e) => {
    if (done) return; // terminate() after a clean finish surfaces here too
    console.error("exec: " + e.message);
    process.exit(1);
  });
}

// ---- `switchboard list` --------------------------------------------------
// What can this host reach, and what may it do there? An agent that is about to
// drive another node needs both halves, and the second one is invisible from the
// dashboard's point of view — a shell-only share looks like any other machine
// until a flow tries to use it.
async function doList() {
  if (!cfg.agentToken) {
    die("switchboard list: this host isn't signed in.\n\n" +
      "  Run `switchboard login` first — the list is per account.\n");
  }
  let all;
  try { all = await reachableMachines(SERVER, cfg.agentToken); }
  catch (e) { die("switchboard list: " + e.message + "\n"); }
  if (!all.length) {
    console.log("No machines yet. Run `switchboard login` on a host to bind it.");
    return;
  }
  const now = Date.now();
  const width = Math.max(...all.map((m) => (m.name || "(unnamed)").length), 4);
  for (const m of all) {
    const online = now - m.last_seen < 6000; // same freshness window as the dashboard
    const how = m.owned ? "yours" : `@${m.owner_login}${m.can_exec ? "" : ", shell only"}`;
    console.log(
      `${(m.name || "(unnamed)").padEnd(width)}  ${m.machine_id.slice(0, 8)}  ` +
      `${(online ? "online" : "offline").padEnd(7)}  ${how}`);
  }
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
      killAllExecs();
      process.exit(1);
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.error(
        `\nERROR: relay rejected this machine (${res.statusCode}). ` +
          "Your login may have expired — run `switchboard login` again."
      );
      emitStatus("fatal", { reason: "auth", code: res.statusCode });
      for (const sid of sessions.keys()) killSession(sid);
      killAllExecs();
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
      case "exec": startExec(msg); break;
      case "exec-stdin": execStdin(msg.id, msg.data); break;
      case "exec-stdin-end": execStdinEnd(msg.id); break;
      case "exec-kill": killExec(msg.id, msg.signal); break;
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
      killAllExecs();
      process.exit(0);
    }
    // Sessions are kept across reconnects; their onData handlers check ws state.
    for (const stream of activeDownloads.values()) stream.destroy();
    activeDownloads.clear();
    for (const up of activeUploads.values()) up.stream.destroy();
    activeUploads.clear();
    killAllExecs();
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

// Cached cwd per session. getShellCwd shells out — lsof on macOS — which is far
// too expensive to repeat for every session on every 2s heartbeat, so refresh it
// on a slow timer and let the heartbeat read the cache.
const cwdCache = new Map(); // sid -> path
function refreshCwds() {
  for (const sid of sessions.keys()) getShellCwd(sid, (dir) => cwdCache.set(sid, dir));
  for (const sid of [...cwdCache.keys()]) if (!sessions.has(sid)) cwdCache.delete(sid);
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
  // What the machine is *doing* — process names, idle times, and (opt-in) live
  // Claude Code sessions. cpu alone can't answer this: an agent blocked on an
  // API call looks exactly like an idle machine.
  const act = activity.snapshot(sessions, cwdCache);
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
      act,
    }));
    emitStatus("stats", { cpu, memUsed, memTotal: total, cores, rtt: lastRtt, act });
    // Probe the relay edge for the next tick's rtt (auto-ponged, no DO wake).
    pingSentAt = Date.now();
    ws.send("ping");
  } catch { /* peer gone */ }
}

// ---- start ---------------------------------------------------------------
(async function main() {
  if (sub === "logout") return doLogout(); // remove creds and exit
  if (sub === "service") return doService(serviceAction); // install/remove the systemd unit and exit
  if (sub === "list") return doList(); // what this account can reach; never becomes a daemon
  if (sub === "exec") return doExec(execSpec); // drive someone else's daemon; never becomes one
  if (sub === "login") {
    // One step: sign in, then fall through to expose this machine's shell.
    await doLogin(); // saves config; fatal-exits on failure
    cfg = loadConfig();
  }
  setupConnection();
  refreshMemAvailable();
  setInterval(sendStats, 2000);
  setInterval(refreshCwds, 10000);
  log(`connecting to ${SERVER} …`);
  if (activity.agentsEnabled) log("[activity] reporting Claude Code sessions (SWITCHBOARD_ACTIVITY)");
  emitStatus("connecting", { server: SERVER, mode: BOUND ? "account" : "token" });
  connect();
  // SIGTERM matters as much as SIGINT: it's what `systemctl stop` sends, and
  // Node's default handler would exit without reaping the shells we spawned.
  const shutdown = (sig) => () => {
    log(`shutting down (${sig}).`);
    emitStatus("stopping", { signal: sig });
    for (const sid of sessions.keys()) killSession(sid);
    killAllExecs();
    process.exit(0);
  };
  process.on("SIGINT", shutdown("SIGINT"));
  process.on("SIGTERM", shutdown("SIGTERM"));
})();
