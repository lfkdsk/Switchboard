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
const readline = require("readline");
const { StringDecoder } = require("string_decoder");
const { exec, spawn, spawnSync } = require("child_process");
const WebSocket = require("ws");
const pty = require("node-pty");
const fixPtyPerms = require("./scripts/fix-pty-perms");
const activity = require("./activity");
const peer = require("./peer");
const { JobStore } = require("./lib/job-store");
const {
  SessionLogStore, recordingEnabled, sessionLogListResponse, sessionLogReadResponse, validId,
} = require("./lib/session-log");
const {
  SessionScreen, buildSessionReplay, parseSessionGrace,
} = require("./lib/session-replay");
const {
  recoverPtyHolders, spawnPtyHolder, usePtyHolder,
} = require("./lib/pty-holder");
const {
  FEATURE: ACCOUNT_SESSIONS_FEATURE,
  accountRoute,
  canAccessSessionFor,
  clientRoute,
  daemonResponseRoute,
  encodeBinary: encodeAccountBinary,
  findAccessibleSession,
  grantExpiryForAccount,
  ownerRoute,
  ownedSessionEntries,
  principalAccessExpired,
  reconcileGrantSnapshot,
  sameClient,
  sessionStorageId,
  unwrapBrowserBinary,
  unwrapBrowserJson,
  validPrincipal,
  wireSessionId,
  wrapDaemonJson,
} = require("./lib/account-sessions");
const { shellCommandArgs, shellQuote, verifyUploadedFile } = require("./lib/peer-utils");
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
// A supervisor that can't signal us (Windows) also sets
// SWITCHBOARD_STOP_ON_STDIN_EOF=1 and closes our stdin to stop us; see the end.
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

Reachable machines (signed in; the target must allow peers):
  switchboard nodes            List machines you own or that were shared with you.
  switchboard exec <node> <cmd…>
                               Run a command over there; its stdout, stderr and
                               exit code come back here.
  switchboard cp <source> <destination>
                               Copy one file to or from a reachable machine.
  switchboard jobs <node>      List detached jobs kept on that machine.
  switchboard logs <node> <job> [--follow]
                               Read a detached job's saved output.
  switchboard history <node> [sid]
                               List saved shell sessions, or read one transcript.
  switchboard wait <node> <job>
                               Wait for a detached job and return its exit code.
  switchboard shell <node>     Open an interactive shell over there. Ctrl-] detaches.

  <node> is a hostname or any unambiguous prefix of it (or of the machine id).

Options:
  -t, --token <token>   Force anonymous mode with this token (min ${MIN_TOKEN_LEN} chars).
  -s, --server <url>    Relay origin. Default: ${DEFAULT_SERVER}
      --shell <path>    Shell to spawn. Default: $SHELL, or bash/powershell.
      --no-peer         Refuse commands from peer machines (see below).
      --force           Start even if this machine already has a daemon running,
                        without asking first (see below).
  -v, --version         Print version and exit.
  -h, --help            Show this help and exit.

  nodes/jobs: --json           Machine-readable output.
  exec:  --cwd <dir>           Working directory over there. Default: its home.
         --timeout <seconds>   Give up and kill the command after this long.
         --login               Run through a login shell.
         --shell <path>        Override the target shell for this command.
         --detach              Start a durable job and print its id immediately.
  logs:  --follow              Keep reading until the job finishes.
  history: --from <off>        Start at this byte offset.
           --tail <N|Nl>       Read the last N bytes, or N lines with an l suffix.
           --text              Strip terminal escape sequences.
           --grep <pattern>    Print matching text lines; skips alternate screens.
           --include-alt       Include alternate-screen text with --grep/--text.
           --raw               Write recorded PTY bytes (the default).
           --follow            Poll for new output while the session is live.
           --json              Machine-readable list/chunks.
  shell: [sid] | --attach      Reattach: to that session, or to the newest one.

Environment (overridden by the flags above):
  SWITCHBOARD_TOKEN, SWITCHBOARD_SERVER, SWITCHBOARD_SHELL  (WEBTERM_* also accepted)
  SWITCHBOARD_ACTIVITY=claude   Also report live Claude Code sessions (title,
                                current tool, idle time) to your dashboard.
                                Off by default: a session title summarises what
                                you asked for, so it leaves this machine only
                                when you opt in.
  SWITCHBOARD_PEER=0            Refuse exec/shell from peer machines. Browser
                                terminals still work for you and anyone you have
                                explicitly shared this machine with.
  SWITCHBOARD_FORCE=1           Same as --force.
  SWITCHBOARD_RECORD=0          Do not save shell session output. Recording is on
                                by default with bounded local retention.
  SWITCHBOARD_SESSION_GRACE=24h Keep detached shells for this long. A bare value
                                is seconds; 0 keeps them until explicit close.

Notes:
  Logged in → this machine shows up in your dashboard; you may share it there.
  Anonymous → the token is the credential; anyone who has it gets a shell here.
  One daemon serves this machine at a time. If another one is already up — the
  menu-bar app, the systemd service, another terminal — starting this one takes
  its circuit over, so you're asked first. On Unix, detached shell holders keep
  webshell sessions alive across that daemon handoff; Windows shells remain
  owned by the daemon and close when it stops.`);
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
      case "--no-peer": opts.noPeer = true; break;
      case "--force": opts.force = true; break;
      default:
        console.error(`Unknown option: ${a}\n`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

// The peer subcommands take a machine, and `exec` takes a whole foreign command
// line after it. Our flags may sit on either side of the machine name, but they
// stop at the first bare word after it: that word starts the remote command, and
// everything from there belongs to the far end — so `exec box ls -la` keeps its
// -la instead of losing it to this parser. A literal `--` ends our flags too.
function parsePeerArgs(argv, command) {
  const opts = {};
  if (command !== "exec") {
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-h" || a === "--help") opts.help = true;
      else if (a === "--follow" && (command === "logs" || command === "history")) opts.follow = true;
      else if (a === "--json" && ["nodes", "ls", "jobs", "history"].includes(command)) opts.json = true;
      else if (a === "--text" && command === "history") opts.text = true;
      else if ((a === "--grep" || a.startsWith("--grep=")) && command === "history") {
        opts.grep = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]) ?? "";
        opts.text = true;
      }
      else if (a === "--include-alt" && command === "history") opts.includeAlt = true;
      else if (a === "--raw" && command === "history") opts.raw = true;
      else if ((a === "--from" || a.startsWith("--from=")) && command === "history") {
        opts.from = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]) ?? "";
      }
      else if ((a === "--tail" || a.startsWith("--tail=")) && command === "history") {
        opts.tail = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]) ?? "";
      }
      else if (a === "--attach" && command === "shell") opts.attach = true;
      else if (a === "-s" || a === "--server") opts.server = argv[++i];
      else if (a.startsWith("--server=")) opts.server = a.slice(a.indexOf("=") + 1);
      else if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
      else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(1); }
      else positional.push(a);
    }
    opts.target = positional[0];
    opts.rest = positional.slice(1);
    return opts;
  }
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { i++; break; }
    if (!a.startsWith("-")) {
      if (opts.target === undefined) { opts.target = a; continue; }
      break; // the command starts here
    }
    const eq = a.indexOf("=");
    const inline = eq > -1 ? a.slice(eq + 1) : null;
    const name = eq > -1 ? a.slice(0, eq) : a;
    const take = () => (inline !== null ? inline : argv[++i]);
    switch (name) {
      case "-h": case "--help": opts.help = true; break;
      case "-s": case "--server": opts.server = take(); break;
      case "--json": opts.json = true; break;
      case "--cwd": opts.cwd = take(); break;
      case "--timeout": opts.timeout = Number(take()); break;
      case "--login": opts.login = true; break;
      case "--shell": opts.shell = take(); break;
      case "--detach": opts.detach = true; break;
      case "--follow": opts.follow = true; break;
      case "--attach": opts.attach = true; break;
      default:
        console.error(`Unknown option: ${a}\n`);
        printHelp();
        process.exit(1);
    }
  }
  opts.rest = argv.slice(i);
  return opts;
}

const rawArgs = process.argv.slice(2);
const PEER_SUBS = ["nodes", "ls", "exec", "cp", "jobs", "logs", "history", "wait", "shell"];
const sub = ["login", "logout", "service", ...PEER_SUBS].includes(rawArgs[0]) ? rawArgs.shift() : null;
// `service` takes a bare verb of its own before the usual flags.
const serviceAction = sub === "service" && rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.shift() : null;
const args = PEER_SUBS.includes(sub) ? parsePeerArgs(rawArgs, sub) : parseArgs(rawArgs);
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

// ---- peer commands -------------------------------------------------------
// Peer subcommands don't expose anything: they spawn no PTY and
// register nothing. They're this machine acting as a *client* of the relay,
// using the same account credential the daemon does, to reach the machines the
// dashboard would show you. The far end is the exec/session handling below.
function peerContext() {
  const c = loadConfig();
  if (!c.agentToken) {
    console.error("\nNot signed in on this machine.\n\n" +
      "Reachable machines are identity-scoped, so reaching them needs the same\n" +
      "credential the daemon uses:\n\n  switchboard login\n");
    process.exit(1);
  }
  return {
    // The agent token is only valid on the relay that issued it, so the saved
    // one wins over the built-in default — an explicit --server/env still wins
    // over both, for a self-hosted setup with more than one.
    server: (args.server || process.env.SWITCHBOARD_SERVER || process.env.WEBTERM_SERVER ||
      c.server || DEFAULT_SERVER).replace(/\/+$/, ""),
    agentToken: c.agentToken,
    machineId: c.machineId || null,
    login: c.login || null,
  };
}

function doPeer() {
  const ctx = peerContext();
  const run = (p) => p.catch((e) => { console.error("\n" + ((e && e.message) || e) + "\n"); process.exit(1); });

  if (sub === "nodes" || sub === "ls") return run(peer.cmdNodes(ctx, { json: !!args.json }));
  if (sub === "cp") {
    if (!args.target || args.rest.length !== 1) {
      console.error("\nUsage: switchboard cp <node>:/remote/path ./local/path\n" +
        "       switchboard cp ./local/path <node>:/remote/path\n");
      process.exit(1);
    }
    return run(peer.cmdCopy(ctx, { source: args.target, destination: args.rest[0] }));
  }

  if (!args.target) {
    console.error(`\nWhich machine? Usage: switchboard ${sub} <node>${sub === "exec" ? " <command…>" : ""}\n\n` +
      "Run `switchboard nodes` to see them.\n");
    process.exit(1);
  }
  if (sub === "shell") {
    // An explicit session id is a positional, not a flag value: `--attach <sid>`
    // sitting before the machine name would be ambiguous about which is which.
    return run(peer.cmdShell(ctx, { target: args.target, sid: args.rest[0] || null, attach: !!args.attach }));
  }
  if (sub === "jobs") {
    if (args.rest.length) die("Usage: switchboard jobs <node> [--json]");
    return run(peer.cmdJobs(ctx, { target: args.target, json: !!args.json }));
  }
  if (sub === "history") {
    if (args.rest.length > 1) die("Usage: switchboard history <node> [sid] [options]");
    return run(peer.cmdHistory(ctx, {
      target: args.target, sid: args.rest[0] || null, from: args.from, tail: args.tail,
      text: !!args.text, raw: !!args.raw, follow: !!args.follow, json: !!args.json,
      grep: args.grep, includeAlt: !!args.includeAlt,
    }));
  }
  if (sub === "logs" || sub === "wait") {
    if (args.rest.length !== 1) die(`Usage: switchboard ${sub} <node> <job>${sub === "logs" ? " [--follow]" : ""}`);
    return run(sub === "logs"
      ? peer.cmdLogs(ctx, { target: args.target, job: args.rest[0], follow: !!args.follow })
      : peer.cmdWait(ctx, { target: args.target, job: args.rest[0] }));
  }
  // Joined the way ssh joins it, so quoting is resolved once — over there.
  const command = args.rest.join(" ").trim();
  if (!command) {
    console.error("\nNothing to run. Usage: switchboard exec <node> <command…>\n");
    process.exit(1);
  }
  if (args.timeout !== undefined && !(args.timeout > 0)) {
    console.error("\n--timeout takes a number of seconds.\n");
    process.exit(1);
  }
  if (args.detach && args.timeout) {
    console.error("\n--timeout cannot be combined with --detach; use `switchboard wait` to observe the job.\n");
    process.exit(1);
  }
  return run(peer.cmdExec(ctx, {
    target: args.target, command, cwd: args.cwd || null, timeout: args.timeout || 0,
    login: !!args.login, shell: args.shell || null, detach: !!args.detach,
  }));
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
  // Same reasoning for peer access: the unit is the machine's standing answer,
  // so a host you deliberately closed off must not come back open at boot.
  if (!PEER) env.push(`Environment="SWITCHBOARD_PEER=0"`);
  if (!RECORD_SESSIONS) env.push(`Environment="SWITCHBOARD_RECORD=0"`);
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

async function serviceInstall() {
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

  // `enable --now` is about to start a daemon, so the same question applies as
  // for a hand-started one — minus the unit itself, which is what we're here to
  // manage and which `--now` leaves alone when it's already up.
  const pinned = args.token || process.env.SWITCHBOARD_TOKEN || process.env.WEBTERM_TOKEN || null;
  const willBind = !!cfg.agentToken && !pinned;
  await confirmSoleDaemon(
    willBind ? circuitId(true, cfg.machineId) : circuitId(false, pinned),
    { ignoreService: true, intent: "service" });

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

// ---- who's already serving this machine (~/.switchboard/daemons.json) ----
// A second daemon is not an error on the relay: circuits are last-writer-wins,
// so a newcomer silently takes the line and whoever was serving this machine —
// the menu-bar app, the systemd unit, the terminal in the next tab — is closed
// with 4001, taking every shell open in it along. That's exactly right when you
// meant it and a nasty surprise when you didn't, and the relay can't tell the
// difference. So every daemon records itself here and the next one asks first.
//
// Records, not a lock: the daemon must still start when the file is stale (a
// `kill -9` leaves an entry behind) or unwritable, so every entry read back is
// checked against the live process and every write failure is survivable. A
// list rather than one slot because two daemons here are legal — a bound one
// and a `--token` share are different circuits — and neither should erase the
// other's entry on the way out.
const RUN_FILE = path.join(CONFIG_DIR, "daemons.json");

const FORCE = !!args.force ||
  ["1", "true", "yes", "on"].includes((process.env.SWITCHBOARD_FORCE || "").toLowerCase());

// Which of the three ways in was taken, so the prompt can name it. systemd
// stamps INVOCATION_ID on every unit it starts; the macOS app (and any other
// supervisor) is the reason the status sinks exist at all.
const LAUNCHER = (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) ? "service"
  : STATUS_ON ? "app"
  : "cli";
function launcherLabel(kind) {
  switch (kind) {
    case "service": return "the systemd user service";
    case "app": return process.platform === "darwin" ? "the menu-bar app"
      : process.platform === "win32" ? "the tray app" : "a supervisor";
    default: return "a terminal";
  }
}

// What the relay keys a circuit by — the machine id when bound to an account,
// the token itself when anonymous — so two daemons can tell whether they'd be
// fighting over one line or just sharing a host. Hashed, because in anonymous
// mode that key *is* the shell credential and it has no business in a second
// file; a digest compares just as well.
function circuitId(bound, key) {
  if (!key) return null;
  return crypto.createHash("sha256")
    .update(`${SERVER}|${bound ? "machine" : "token"}:${key}`).digest("hex").slice(0, 16);
}

function readRunRecords() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
    return Array.isArray(raw.daemons) ? raw.daemons : [];
  } catch { return []; }
}

function writeRunRecords(list) {
  try {
    if (!list.length) { fs.rmSync(RUN_FILE, { force: true }); return; }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(RUN_FILE, JSON.stringify({ daemons: list }, null, 2) + "\n", { mode: 0o600 });
  } catch { /* a courtesy to the next launch; never worth failing to start over */ }
}

// Everyone on file who is still there — which excludes us, so this is exactly
// "the other daemons". Entries left by a crash are dropped on the way past.
function liveRunRecords() {
  return readRunRecords().filter((r) => pidAlive(r.pid) && pidIsDaemon(r.pid, r));
}

function claimRunRecord() {
  writeRunRecords([...liveRunRecords(), {
    pid: process.pid,
    startedAt: Date.now(),
    launcher: LAUNCHER,
    version: pkg.version,
    cli: CLI_PATH,
    server: SERVER,
    mode: BOUND ? "account" : "token",
    account: BOUND ? (cfg.login || null) : null,
    circuit: circuitId(BOUND, BOUND ? MACHINE : TOKEN),
  }]);
}

// Drop our own entry on the way out and keep everyone else's: a daemon that
// exits — replaced, or just stopped — must not take a live sibling's record
// with it, or the next launch would see an empty file and ask nothing.
function releaseRunRecord() {
  writeRunRecords(liveRunRecords().filter((r) => r.pid !== process.pid));
}

function pidAlive(pid) {
  if (!(pid > 0) || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; } // running, just not ours to signal
}

// Pids get recycled and a record outlives a `kill -9`, so a live pid alone
// proves nothing. Where the OS hands over a command line cheaply, insist it
// still looks like our daemon; where it won't answer, believe the record — a
// question we didn't need to ask is cheaper than a takeover nobody saw coming.
function pidIsDaemon(pid, rec) {
  const looks = (s) => !!s && ((rec.cli && s.includes(rec.cli)) || /switch-?board/i.test(s));
  try {
    if (process.platform === "linux") {
      // /proc/<pid>/cmdline is NUL-separated, one entry per argv element.
      return looks(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "));
    }
    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      return r.status === 0 && r.stdout ? looks(r.stdout) : true;
    }
  } catch { return true; }
  return true;
}

// The daemons already serving this machine. `ignoreService` is for `service
// install`, where the unit is the thing being managed rather than a stranger to
// warn about (and `enable --now` leaves an already-running one alone).
function findRunningDaemons(ignoreService) {
  const live = liveRunRecords().filter((r) => !(ignoreService && r.launcher === "service"));
  if (live.length) return live;
  // Version skew: a daemon older than these records keeps no trace of itself,
  // but on Linux the unit it runs under does. Only worth asking systemd when
  // we're the one barging in — a unit restarting itself would find itself.
  if (!ignoreService && LAUNCHER === "cli" && process.platform === "linux" &&
      spawnSync("systemctl", ["--user", "is-active", "--quiet", UNIT_NAME]).status === 0) {
    return [{ launcher: "service", unit: UNIT_NAME }];
  }
  return [];
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Settle before closing: rl.close() emits "close" synchronously, so an
    // answer handed over after it would lose the race to the empty default.
    let settled = false;
    const done = (answer) => { if (!settled) { settled = true; resolve(answer); } };
    rl.on("close", () => done("")); // Ctrl-D, or stdin closed under us: no
    rl.question(question, (answer) => {
      done(answer);
      rl.close();
      try { process.stdin.pause(); } catch {}
    });
  });
}

// The gate itself. `circuit` is the line this run would take, when it's known
// early enough to say whether the daemon already up would be replaced by it or
// merely joined on the same host.
async function confirmSoleDaemon(circuit, { ignoreService = false, intent = "start" } = {}) {
  const others = findRunningDaemons(ignoreService);
  if (!others.length) return;
  // Unknown on either side means we can't rule out a takeover — describe the
  // outcome that costs somebody their shells rather than the comfortable one.
  const shares = (r) => !circuit || !r.circuit || circuit === r.circuit;
  const takeover = others.some(shares);
  // The one that would actually lose its line, when we can tell which that is.
  const other = others.find(shares) || others[0];

  const who = [launcherLabel(other.launcher), other.pid ? `pid ${other.pid}` : null,
    others.length > 1 ? `${others.length} running in all` : null].filter(Boolean).join(", ");
  emitStatus("duplicate", { pid: other.pid || null, launcher: other.launcher || null, takeover });

  // Nobody is watching a supervised start — the app, the unit, a CI script —
  // and a prompt into a closed stdin would just hang. Say what's happening and
  // carry on: this is the behaviour those callers have always had.
  if (FORCE || !(process.stdin.isTTY && process.stdout.isTTY)) {
    logErr(`! Switchboard is already running on this machine (${who})` +
      (takeover ? (USE_PTY_HOLDER
        ? " — taking over its circuit; detached shells will be recovered."
        : " — taking over its circuit; the shells open in it will close.")
                : " — on a different circuit; both will run."));
    return;
  }

  console.log("\n! Switchboard is already running on this machine.\n");
  console.log(`    Started   ${other.startedAt ? ago(other.startedAt) : "some time ago"} by ` +
    `${launcherLabel(other.launcher)}${other.pid ? ` (pid ${other.pid})` : ""}`);
  if (other.mode) {
    console.log(`    Serving   ${other.mode === "account" ? (other.account || "your account") : "a one-off token"}` +
      ` at ${other.server || SERVER}`);
  }
  if (others.length > 1) console.log(`    Also      ${others.length - 1} more running here`);
  console.log("");
  const what = intent === "service" ? "The service would start a second daemon, which" : "Starting another one";
  console.log(takeover
    ? `  ${what} takes this machine's circuit over from it:\n` +
      "  the relay hands the line to the newcomer, that daemon exits, and every\n" +
      "  shell open in it closes with it."
    : `  ${what} would use a different circuit (another relay, or a\n` +
      "  one-off token), so the two would run side by side rather than one\n" +
      "  replacing the other.");
  console.log("");

  const answer = await ask(intent === "service" ? "Install and start it anyway? [y/N] "
    : takeover ? "Take over? [y/N] " : "Start a second one? [y/N] ");
  if (!/^y(es)?$/i.test(answer.trim())) {
    // Echo back the command they actually typed, so --force lands somewhere
    // that works: `switchboard login --force`, `service install --force`, …
    const self = ["switchboard", sub, sub === "service" ? serviceAction : null].filter(Boolean).join(" ");
    console.log("\nLeft the running daemon alone — nothing was started.\n");
    if (other.launcher === "service") console.log(`  systemctl --user status ${UNIT_NAME}   # what it's doing`);
    else if (other.pid) console.log(`  kill ${other.pid}   # stop it, if it's the one you don't want`);
    console.log(`  ${self} --force   # start anyway, without this question\n`);
    process.exit(0);
  }
  console.log("");
}

// Connection state, resolved by setupConnection() at startup — after any login —
// so it picks up freshly-saved credentials.
let cfg = loadConfig();
let BOUND = false;
let TOKEN = null, MACHINE = null, AGENT = null, wsUrl, browseUrl;
const ACCOUNT_PROTOCOL_NONCE = crypto.randomBytes(24).toString("base64url");

// May your *other* machines run things here (`switchboard exec`, `switchboard
// shell`)? On by default in account mode: they're yours, and anyone who can
// reach this host that way could already have opened a shell on it from the
// dashboard. Turning it off is for a machine that should only ever be driven by
// hand. Declared to the relay on every connect — the host decides, not the caller.
const PEER = !args.noPeer &&
  !["0", "off", "false", "no"].includes((process.env.SWITCHBOARD_PEER || "").toLowerCase());

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
      "&name=" + encodeURIComponent(os.hostname()) +
      "&platform=" + encodeURIComponent(process.platform) +
      "&arch=" + encodeURIComponent(process.arch) +
      "&protocol=" + encodeURIComponent(ACCOUNT_SESSIONS_FEATURE) +
      "&protocol-nonce=" + encodeURIComponent(ACCOUNT_PROTOCOL_NONCE) + (PEER ? "&peer=1" : "");
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
// One PTY per session id (sid). Reloads and same-origin tabs that restore the
// same sid share that PTY: both can type, both receive its output, and an
// explicit `close` from either kills it for both. The browser's + button creates
// a fresh sid. Merely disconnecting never closes a session; sessions outlive
// relay reconnects so a flaky link or tab reload doesn't lose work.
const sessions = new Map(); // storage id -> { sid, ownerAccountId, pty, holder, log, ... }
const openingSessions = new Map();
const openingSessionAborts = new Map();
const openingSessionInfo = new Map();
const cancelledOpenSessions = new Set();
const pendingSessionInput = new Map();
const SESSION_GRACE_MS = parseSessionGrace(process.env.SWITCHBOARD_SESSION_GRACE);
const RECORD_SESSIONS = recordingEnabled();
const USE_PTY_HOLDER = usePtyHolder();
let sessionRoot = null;
let sessionScope = null;
let accountProtocolState = "pending"; // active, legacy (token/old relay), or pending negotiation
let machineOwnerAccountId = null;
const browserClients = new Map(); // relay client id -> authenticated principal
const requestRoutes = new Map(); // request id -> initiating relay client route
const accountAccessExpiries = new Map(); // visitor account id -> finite deadline or null
const accountExpiryTimers = new Map();
const MAX_TIMER_DELAY_MS = 0x7fffffff;

function scopedSessions() { return BOUND && accountProtocolState === "active"; }
function legacySessions() { return !BOUND || accountProtocolState === "legacy"; }

function clearAccountExpiryTimer(accountId) {
  const timer = accountExpiryTimers.get(accountId);
  if (timer) clearTimeout(timer);
  accountExpiryTimers.delete(accountId);
}

function forgetAccountAccessExpiry(accountId) {
  clearAccountExpiryTimer(accountId);
  accountAccessExpiries.delete(accountId);
}

function armAccountAccessExpiry(accountId) {
  clearAccountExpiryTimer(accountId);
  const expiresAt = accountAccessExpiries.get(accountId);
  if (!Number.isFinite(expiresAt)) return;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    terminateAccountSessions(accountId, "access-expired");
    return;
  }
  const timer = setTimeout(() => {
    if (accountAccessExpiries.get(accountId) !== expiresAt) return;
    if (expiresAt > Date.now()) armAccountAccessExpiry(accountId);
    else terminateAccountSessions(accountId, "access-expired");
  }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  timer.unref?.();
  accountExpiryTimers.set(accountId, timer);
}

function setAccountAccessExpiry(accountId, expiresAt) {
  if (typeof accountId !== "string" || !accountId || accountId === machineOwnerAccountId) return;
  const normalized = Number.isFinite(expiresAt) ? expiresAt : null;
  accountAccessExpiries.set(accountId, normalized);
  for (const info of openingSessionInfo.values()) {
    if (info.ownerAccountId === accountId) info.accessExpiresAt = normalized;
  }
  for (const s of sessions.values()) {
    if (s.ownerAccountId !== accountId || s.accessExpiresAt === normalized) continue;
    s.accessExpiresAt = normalized;
    s.pty.setAccessExpiry?.(normalized);
  }
  armAccountAccessExpiry(accountId);
}

function rememberPrincipalAccessExpiry(principal) {
  if (!scopedSessions() || principal?.accessVia !== "grant") return true;
  if (principalAccessExpired(principal)) {
    terminateAccountSessions(principal.accountId, "access-expired");
    return false;
  }
  if (!accountAccessExpiries.has(principal.accountId)) {
    setAccountAccessExpiry(principal.accountId, principal.expiresAt);
  }
  return true;
}

function sessionWireId(s, principal) {
  return scopedSessions() ? wireSessionId(s, principal, machineOwnerAccountId) : s.sid;
}

function findSession(principal, wireSid, includeOpening = false, action = "replay") {
  if (!scopedSessions()) {
    const s = sessions.get(wireSid);
    if (s) return { storageId: wireSid, session: s };
    if (includeOpening && openingSessionInfo.has(wireSid)) {
      return { storageId: wireSid, session: openingSessionInfo.get(wireSid), opening: true };
    }
    return null;
  }
  // Prefer the caller's own raw sid. An owner and visitor may independently
  // choose the same browser sid; storage and supervisor wire ids stay distinct.
  const live = findAccessibleSession(sessions, principal, machineOwnerAccountId, wireSid, action);
  if (live) return live;
  if (includeOpening) {
    const opening = findAccessibleSession(
      openingSessionInfo, principal, machineOwnerAccountId, wireSid, action,
    );
    if (opening) return { ...opening, opening: true };
  }
  return null;
}

// Binary frame format shared with the relay/browser:
//   [1 byte sid length][sid utf8 bytes][payload bytes]
function encodeFrame(sid, payloadBuf) {
  const sidBuf = Buffer.from(sid, "utf8");
  return Buffer.concat([Buffer.from([sidBuf.length]), sidBuf, payloadBuf]);
}
function sendBinary(frame, route = null) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (scopedSessions()) {
    const wrapped = encodeAccountBinary(frame, route || ownerRoute());
    if (wrapped) ws.send(wrapped, { binary: true });
  } else if (legacySessions()) {
    ws.send(frame, { binary: true });
  }
}

function sendSessionDataForRoute(wireSid, data, route) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  sendBinary(encodeFrame(wireSid, payload), route);
}

function sendSessionData(storageId, data) {
  const s = sessions.get(storageId);
  if (!s) return;
  if (!scopedSessions()) {
    sendSessionDataForRoute(s.sid, data, null);
    return;
  }
  sendSessionDataForRoute(s.sid, data, accountRoute(s.ownerAccountId));
  if (s.ownerAccountId !== machineOwnerAccountId) {
    const supervisorSid = wireSessionId(s, {
      accountId: machineOwnerAccountId, accessVia: "owner", clientId: "supervisor",
    }, machineOwnerAccountId);
    sendSessionDataForRoute(supervisorSid, data, ownerRoute());
  }
}

function sendSessionEvent(s, message) {
  if (!scopedSessions()) {
    sendCtl({ ...message, sid: s.sid });
    return;
  }
  sendCtl({ ...message, sid: s.sid }, accountRoute(s.ownerAccountId));
  if (s.ownerAccountId !== machineOwnerAccountId) {
    const supervisorSid = wireSessionId(s, {
      accountId: machineOwnerAccountId, accessVia: "owner", clientId: "supervisor",
    }, machineOwnerAccountId);
    sendCtl({ ...message, sid: supervisorSid }, ownerRoute());
  }
}

function resizeSession(s, cols, rows) {
  if (!(cols > 0 && rows > 0)) return;
  try { s.pty.resize(cols, rows); } catch {}
  s.log?.resize(cols, rows);
  s.screen?.resize(cols, rows);
}

function writeSessionInput(s, input) {
  const text = s.inputDecoder.write(Buffer.isBuffer(input) ? input : Buffer.from(input));
  if (text) s.pty.write(text);
}

function openInProcessSession(storageId, sid, ownerAccountId, legacy, accessExpiresAt, cols, rows) {
  let s = sessions.get(storageId);
  if (s) {
    if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = null; }
    resizeSession(s, cols, rows);
    return s;
  }
  const p = pty.spawn(SHELL, [], {
    name: "xterm-color",
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd: process.env.HOME || process.cwd(),
    env: process.env,
  });
  let sessionRecorder = null;
  try {
    sessionRecorder = sessionLog?.open(storageId, {
      sid, ownerAccountId, legacy, cols, rows,
    }) || null;
  }
  catch (e) { logErr(`[session ${sid}] recording unavailable: ${e.message}`); }
  let settleExit;
  const exitPromise = new Promise((resolve) => { settleExit = resolve; });
  const screen = new SessionScreen(cols, rows);
  s = {
    storageId, sid, ownerAccountId, legacy: !!legacy, accessExpiresAt,
    pty: p, log: sessionRecorder, screen, inputDecoder: new StringDecoder("utf8"),
    offset: sessionRecorder?.stat().off || 0,
    logPaused: false, replayPaused: false, replayQueue: Promise.resolve(), graceTimer: null,
    startedAt: Date.now(), lastOutputAt: Date.now(), exitPromise, settleExit,
  };
  sessions.set(storageId, s);
  p.onData((d) => {
    const output = Buffer.from(d, "utf8");
    s.lastOutputAt = Date.now();
    s.offset += output.length;
    s.screen.write(output);
    if (s.log && !s.log.append(output) && !s.logPaused) {
      s.logPaused = true;
      try { p.pause(); } catch {}
      void s.log.drain().finally(() => {
        s.logPaused = false;
        if (!s.replayPaused) { try { p.resume(); } catch {} }
      });
    }
    sendSessionData(storageId, output);
  });
  p.onExit(({ exitCode }) => {
    sessions.delete(storageId);
    const closed = s.log?.close({ exitCode }) || Promise.resolve();
    void Promise.allSettled([closed, s.replayQueue]).finally(() => {
      s.screen.dispose();
      s.settleExit();
    });
    sendSessionEvent(s, { type: "exit", code: exitCode });
    broadcastSessions();
    log(`[session ${sid}] shell exited (${exitCode})`);
  });
  broadcastSessions();
  log(`[session ${sid}] shell started (pid ${p.pid})`);
  return s;
}

function adoptHolder(client, recovered = false) {
  const storageId = client.sid;
  const existing = sessions.get(storageId);
  if (existing) {
    client.disconnect();
    return existing;
  }
  let settleExit;
  const exitPromise = new Promise((resolve) => { settleExit = resolve; });
  let accessExpiresAt = Number.isFinite(client.accessExpiresAt) ? client.accessExpiresAt : null;
  if (scopedSessions() && client.ownerAccountId !== machineOwnerAccountId &&
      accountAccessExpiries.has(client.ownerAccountId)) {
    accessExpiresAt = accountAccessExpiries.get(client.ownerAccountId);
  }
  const s = {
    storageId,
    sid: client.publicSid || client.sid,
    ownerAccountId: client.ownerAccountId || null,
    legacy: !!client.legacy || !client.ownerAccountId,
    accessExpiresAt,
    pty: client, holder: true, log: null, screen: null, inputDecoder: new StringDecoder("utf8"),
    offset: client.offset, replayQueue: Promise.resolve(), graceTimer: null,
    startedAt: client.startedAt || Date.now(),
    lastOutputAt: client.lastOutputAt || Date.now(),
    exitPromise, settleExit, finished: false,
  };
  sessions.set(storageId, s);
  if (client.accessExpiresAt !== accessExpiresAt) client.setAccessExpiry(accessExpiresAt);
  // The holder owns the writer, but the daemon's observer needs to discover a
  // newly-created record so history listing can include it immediately.
  sessionLog?.stat(storageId);

  const finish = (code, reason) => {
    if (s.finished) return;
    s.finished = true;
    if (s.graceTimer) clearTimeout(s.graceTimer);
    if (sessions.get(storageId) === s) sessions.delete(storageId);
    s.settleExit();
    sendSessionEvent(s, { type: "exit", code });
    broadcastSessions();
    log(`[session ${client.sid}] ${reason}${code == null ? "" : ` (${code})`}`);
  };
  client.on("data", (output) => {
    s.offset = client.offset;
    s.lastOutputAt = client.lastOutputAt || Date.now();
    if (s.pendingReplay?.remaining) {
      const count = Math.min(s.pendingReplay.remaining, output.length);
      if (count) sendSessionDataForRoute(s.pendingReplay.wireSid, output.subarray(0, count), s.pendingReplay.route);
      s.pendingReplay.remaining -= count;
      if (!s.pendingReplay.remaining) s.pendingReplay = null;
      if (count < output.length) sendSessionData(storageId, output.subarray(count));
    } else {
      sendSessionData(storageId, output);
    }
  });
  client.on("reset", (message) => {
    if (!scopedSessions()) {
      sendCtl(message);
      return;
    }
    const principal = browserClients.get(message.relayClientId);
    if (!principal) return;
    const { relayClientId, ...inner } = message;
    sendCtl({ ...inner, sid: sessionWireId(s, principal) }, clientRoute(principal));
  });
  client.on("session-replay", (message) => {
    s.offset = message.to;
    if (!scopedSessions()) {
      s.pendingReplay = { route: null, wireSid: s.sid, remaining: message.bytes };
      sendCtl(message);
      return;
    }
    const principal = browserClients.get(message.relayClientId);
    if (!principal) return;
    const { relayClientId, ...inner } = message;
    const wireSid = sessionWireId(s, principal);
    s.pendingReplay = { route: clientRoute(principal), wireSid, remaining: message.bytes };
    sendCtl({ ...inner, sid: wireSid }, clientRoute(principal));
  });
  client.on("holder-error", (message) => {
    logErr(`[session ${client.sid}] holder replay failed: ${message.message}`);
  });
  client.on("exit", (message) => finish(message.code, "shell exited"));
  client.on("disconnect", () => finish(null, "holder disconnected"));
  client.activate();

  broadcastSessions();
  log(`[session ${client.sid}] ${recovered ? "holder recovered" : "shell started"} ` +
    `(pid ${client.pid}, holder ${client.holderPid})`);
  return s;
}

async function openSession(principal, sid, cols, rows) {
  if (!validId(sid)) throw new Error("invalid session id");
  if (!rememberPrincipalAccessExpiry(principal)) throw new Error("machine access expired");
  const found = findSession(principal, sid, true);
  let storageId = found?.storageId;
  let s = found?.session;
  if (s) {
    if (found.opening) return openingSessions.get(storageId);
    if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = null; }
    // An owner-supervisor may replay and close a visitor session, but viewing
    // it must not resize or otherwise drive the visitor's PTY.
    if (!scopedSessions() || canAccessSessionFor(
      "resize", principal, s, machineOwnerAccountId,
    )) resizeSession(s, cols, rows);
    return s;
  }
  const ownerAccountId = scopedSessions() ? principal.accountId : null;
  const accessExpiresAt = scopedSessions() && ownerAccountId !== machineOwnerAccountId
    ? (accountAccessExpiries.has(ownerAccountId)
      ? accountAccessExpiries.get(ownerAccountId)
      : Number.isFinite(principal.expiresAt) ? principal.expiresAt : null)
    : null;
  storageId = scopedSessions() ? sessionStorageId(ownerAccountId, sid) : sid;
  if (!USE_PTY_HOLDER) {
    return openInProcessSession(
      storageId, sid, ownerAccountId, false, accessExpiresAt, cols, rows,
    );
  }
  if (openingSessions.has(storageId)) return openingSessions.get(storageId);
  const controller = new AbortController();
  openingSessionAborts.set(storageId, controller);
  openingSessionInfo.set(storageId, {
    storageId, sid, ownerAccountId, legacy: false, accessExpiresAt,
    startedAt: Date.now(), cwd: process.env.HOME || process.cwd(),
  });
  const opening = spawnPtyHolder({
    rootDir: sessionRoot,
    scope: sessionScope,
    sid: storageId,
    publicSid: sid,
    ownerAccountId,
    accessExpiresAt,
    shell: SHELL,
    cwd: process.env.HOME || process.cwd(),
    cols,
    rows,
    recording: RECORD_SESSIONS,
    signal: controller.signal,
  }).then((client) => {
    const adopted = adoptHolder(client);
    if (cancelledOpenSessions.delete(storageId)) {
      const exitPromise = killSession(storageId);
      throw Object.assign(new Error("session opening was cancelled"), {
        code: "ECANCELED", exitHandled: true, exitPromise,
      });
    }
    for (const input of pendingSessionInput.get(storageId) || []) writeSessionInput(adopted, input);
    pendingSessionInput.delete(storageId);
    return adopted;
  }).finally(() => {
    openingSessions.delete(storageId);
    openingSessionAborts.delete(storageId);
    openingSessionInfo.delete(storageId);
    cancelledOpenSessions.delete(storageId);
    pendingSessionInput.delete(storageId);
  });
  openingSessions.set(storageId, opening);
  return opening;
}

function replaySession(storageId, s, msg, principal) {
  if (s.holder) {
    s.pty.replay(msg.since, msg.snapshot, principal?.clientId || msg.relayClientId);
    return;
  }
  s.replayQueue = s.replayQueue.then(async () => {
    if (!sessions.has(storageId)) return;
    s.replayPaused = true;
    try { s.pty.pause(); } catch {}
    try {
      const replay = await buildSessionReplay({
        log: s.log,
        screen: s.screen,
        since: msg.since,
        currentOffset: s.offset,
        forceSnapshot: !!msg.snapshot,
      });
      const route = scopedSessions() ? clientRoute(principal) : null;
      const wireSid = scopedSessions() ? sessionWireId(s, principal) : s.sid;
      // Replay metadata and bytes use an exact authenticated client route. Live
      // output follows the session account/owner audiences.
      if (replay.mode === "snapshot") {
        sendCtl({ type: "reset", sid: wireSid, offset: replay.to }, route);
      }
      sendCtl({
        type: "session-replay", sid: wireSid, mode: replay.mode,
        from: replay.from, to: replay.to, bytes: replay.payload.length,
      }, route);
      if (replay.payload.length) sendSessionDataForRoute(wireSid, replay.payload, route);
    } catch (error) {
      logErr(`[session ${s.sid}] replay failed: ${error.message}`);
    } finally {
      s.replayPaused = false;
      if (!s.logPaused) { try { s.pty.resume(); } catch {} }
    }
  });
}

// Report the live session list so a browser can show/attach tabs (tmux-style):
// sessions persist for the daemon's lifetime in bound mode and are reattachable.
async function buildSessionList(principal = null) {
  while (true) {
    const liveEntries = [...sessions.entries()].filter(([, session]) =>
      !scopedSessions() || canAccessSessionFor("sessions", principal, session, machineOwnerAccountId));
    const openingEntries = [...openingSessionInfo.entries()]
      .filter(([storageId, session]) => !sessions.has(storageId) &&
        (!scopedSessions() || canAccessSessionFor("sessions", principal, session, machineOwnerAccountId)));
    const list = await Promise.all(liveEntries.map(([storageId, s]) =>
      new Promise((resolve) => getShellCwd(storageId, (cwd) => resolve({
        sid: scopedSessions() ? sessionWireId(s, principal) : s.sid,
        sessionSid: s.sid,
        ownerAccountId: s.ownerAccountId,
        mine: !scopedSessions() || s.ownerAccountId === principal.accountId,
        legacy: !!s.legacy,
        startedAt: s.startedAt,
        cwd,
      })))));
    const visibleLive = [...sessions.entries()].filter(([, session]) =>
      !scopedSessions() || canAccessSessionFor("sessions", principal, session, machineOwnerAccountId));
    const visibleOpening = [...openingSessionInfo.entries()].filter(([storageId, session]) =>
      !sessions.has(storageId) &&
        (!scopedSessions() || canAccessSessionFor("sessions", principal, session, machineOwnerAccountId)));
    const unchanged = liveEntries.length === visibleLive.length &&
      liveEntries.every(([storageId, s]) => sessions.get(storageId) === s) &&
      openingEntries.length === visibleOpening.length &&
      openingEntries.every(([storageId, info]) => openingSessionInfo.get(storageId) === info && !sessions.has(storageId));
    if (!unchanged) continue;
    for (const [, info] of openingEntries) {
      list.push({
        sid: scopedSessions() ? sessionWireId(info, principal) : info.sid,
        sessionSid: info.sid,
        ownerAccountId: info.ownerAccountId,
        mine: !scopedSessions() || info.ownerAccountId === principal.accountId,
        legacy: !!info.legacy,
        startedAt: info.startedAt,
        cwd: info.cwd,
      });
    }
    return list;
  }
}
let sessionBroadcastQueue = Promise.resolve();
function broadcastSessions() {
  const next = sessionBroadcastQueue.then(async () => {
    try {
      if (!scopedSessions()) {
        sendCtl({ type: "sessions", list: await buildSessionList() });
        return;
      }
      for (const principal of browserClients.values()) {
        sendCtl({ type: "sessions", list: await buildSessionList(principal) }, clientRoute(principal));
      }
    } catch {}
  });
  sessionBroadcastQueue = next.catch(() => {});
  return next;
}

function killSession(sid) {
  const s = sessions.get(sid);
  if (!s) {
    const opening = openingSessions.get(sid);
    if (!opening) return null;
    cancelledOpenSessions.add(sid);
    openingSessionInfo.delete(sid);
    pendingSessionInput.delete(sid);
    openingSessionAborts.get(sid)?.abort();
    return opening.catch((error) => error.exitPromise || null);
  }
  if (s.graceTimer) clearTimeout(s.graceTimer);
  sessions.delete(sid);
  try { s.pty.kill(); }
  catch (e) {
    const closed = s.log?.close({ status: "interrupted", error: e.message }) || Promise.resolve();
    void closed.finally(s.settleExit);
  }
  return s.exitPromise;
}

// A window's socket dropped: keep its shell briefly so a reload can reattach.
function scheduleSessionCleanup(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  if (s.graceTimer) clearTimeout(s.graceTimer);
  if (SESSION_GRACE_MS === 0) { s.graceTimer = null; return; }
  s.graceTimer = setTimeout(() => {
    log(`[session ${sid}] no reconnect within grace window, closing`);
    killSession(sid);
  }, SESSION_GRACE_MS);
  s.graceTimer.unref?.();
}
function cancelSessionCleanup(sid) {
  const s = sessions.get(sid);
  if (!s?.graceTimer) return;
  clearTimeout(s.graceTimer);
  s.graceTimer = null;
}

let stopping = false;
async function stopDaemon(code) {
  if (stopping) return;
  stopping = true;
  for (const accountId of accountExpiryTimers.keys()) clearAccountExpiryTimer(accountId);
  if (openingSessions.size) {
    await Promise.race([Promise.allSettled([...openingSessions.values()]), sleep(2000)]);
  }
  const exits = [];
  for (const sid of openingSessions.keys()) {
    const exit = killSession(sid);
    if (exit) exits.push(exit);
  }
  for (const [sid, s] of sessions) {
    if (!s.holder) {
      const exit = killSession(sid);
      if (exit) exits.push(exit);
      continue;
    }
    // The detached holder deliberately outlives this daemon. A replacement
    // daemon scans the scope and reconnects to its socket during startup.
    if (s.graceTimer) clearTimeout(s.graceTimer);
    sessions.delete(sid);
    s.pty.disconnect();
    s.settleExit();
  }
  for (const id of activeExecs.keys()) killExec(id, "SIGTERM");
  if (exits.length) {
    await Promise.race([Promise.allSettled(exits), sleep(500)]);
  }
  try { await sessionLog?.closeAll({ status: "interrupted", error: "daemon stopped" }); }
  catch (e) { logErr("could not flush session logs: " + e.message); }
  process.exit(code);
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
    console.log("  Peers   : " + (PEER
      ? "on — authorized peers can `switchboard exec " + os.hostname() + "`"
      : "off — no exec/shell from peer machines"));
    console.log("");
    console.log("  Signed in — manage machine sharing from your dashboard.");
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
    peer: BOUND ? PEER : null,
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
let lastPongAt = 0; // when the relay edge last answered; 0 while no link is up
const STATS_INTERVAL_MS = 2000;
// The relay answers "ping" from the edge, without waking the Durable Object
// (src/circuit.js: setWebSocketAutoResponse), so a pong is owed on every tick
// even while the DO hibernates. Five missed ticks means the link is gone, not
// that the other end is busy.
const PONG_TIMEOUT_MS = 5 * STATS_INTERVAL_MS;
// A TCP connection that opens but never completes the upgrade would otherwise
// sit in CONNECTING with no deadline of its own.
const HANDSHAKE_TIMEOUT_MS = 15000;
const activeDownloads = new Map(); // id -> fs.ReadStream
const activeUploads = new Map(); // id -> { stream, finalPath }
let jobStore = null;
let sessionLog = null;
const PROTOCOL_FEATURES = [
  "cp-sha256-v1", "exec-options-v1", "jobs-v1", "history-v1", "session-replay-v1", "pty-holder-v1",
  ACCOUNT_SESSIONS_FEATURE,
];

const FINAL_REQUEST_MESSAGES = new Set([
  "capabilities", "dl-end", "dl-error", "ul-done", "ul-error", "exec-exit", "exec-job",
  "job-list", "job-chunk", "job-status", "job-error", "sess-list", "sess-chunk", "sess-error",
]);

function beginRequest(principal, id) {
  if (!scopedSessions() || !id) return true;
  const route = clientRoute(principal);
  const existing = requestRoutes.get(String(id));
  if (existing) return sameClient(existing, principal);
  requestRoutes.set(String(id), route);
  return true;
}

function ownsRequest(principal, id) {
  if (!scopedSessions()) return true;
  return !!id && sameClient(requestRoutes.get(String(id)), principal);
}

function sendRequestCtl(obj, principal, callback = undefined) {
  if (scopedSessions() && !ownsRequest(principal, obj?.id)) return false;
  return sendCtl(obj, null, callback);
}

function encodedCtl(obj, route = null) {
  if (scopedSessions()) {
    // An id-bearing response belongs to the exact client that registered the
    // request. If revocation/disconnect removed that route while async work was
    // finishing, drop the late frame instead of falling back to the owner.
    const target = daemonResponseRoute(obj, route, requestRoutes);
    if (!target) return null;
    return wrapDaemonJson(obj, target);
  }
  return legacySessions() ? JSON.stringify(obj) : null;
}

function sendCtl(obj, route = null, callback = undefined) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const encoded = encodedCtl(obj, route);
  if (!encoded) return false;
  ws.send(encoded, callback);
  if (obj?.id && FINAL_REQUEST_MESSAGES.has(obj.type)) requestRoutes.delete(String(obj.id));
  return true;
}

function adoptLegacyOwnership(ownerAccountId) {
  let changed = sessionLog?.assignLegacyOwner(ownerAccountId) || 0;
  for (const s of sessions.values()) {
    if (s.ownerAccountId) continue;
    s.ownerAccountId = ownerAccountId;
    s.legacy = true;
    s.accessExpiresAt = null;
    s.pty.setOwner?.(ownerAccountId, true);
    s.pty.setAccessExpiry?.(null);
    changed++;
  }
  if (changed) log(`[sessions] assigned ${changed} legacy session record(s) to the machine owner`);
}

function endClientRequests(principal) {
  for (const [id, route] of requestRoutes) {
    if (!sameClient(route, principal)) continue;
    activeDownloads.get(id)?.destroy();
    activeDownloads.delete(id);
    const upload = activeUploads.get(id);
    if (upload) {
      upload.stream.destroy();
      try { fs.unlinkSync(upload.finalPath); } catch {}
      activeUploads.delete(id);
    }
    const running = activeExecs.get(id);
    if (running && !running.detached) {
      running.abandoned = true;
      killExec(id, "SIGTERM");
    }
    requestRoutes.delete(id);
  }
}

function terminateAccountSessions(accountId, reason) {
  forgetAccountAccessExpiry(accountId);
  const exits = [];
  for (const [storageId] of ownedSessionEntries(openingSessionInfo, accountId)) {
    const result = killSession(storageId);
    if (result) exits.push(result);
  }
  for (const [storageId] of ownedSessionEntries(sessions, accountId)) {
    const result = killSession(storageId);
    if (result) exits.push(result);
  }
  for (const [clientId, principal] of browserClients) {
    if (principal.accountId !== accountId) continue;
    endClientRequests(principal);
    browserClients.delete(clientId);
  }
  if (exits.length) log(`[sessions] terminating ${exits.length} session(s): ${reason}`);
  void broadcastSessions();
}

function accountHasBrowser(accountId) {
  return [...browserClients.values()].some((principal) => principal.accountId === accountId);
}

function handleRelayControl(message) {
  switch (message.event) {
    case "account-sessions":
      if (message.version !== 1 || message.nonce !== ACCOUNT_PROTOCOL_NONCE ||
          typeof message.ownerAccountId !== "string" || !message.ownerAccountId) return;
      {
        const reconciliation = reconcileGrantSnapshot(
          [...openingSessionInfo.values(), ...sessions.values()],
          message.ownerAccountId,
          message.activeGrants,
        );
        if (!reconciliation) {
          logErr("[relay] rejected malformed active-grant snapshot");
          try { ws.close(1002, "invalid active-grant snapshot"); } catch {}
          return;
        }
        machineOwnerAccountId = message.ownerAccountId;
        accountProtocolState = "active";
        adoptLegacyOwnership(machineOwnerAccountId);

        // Existing deadlines may have come from the previous connection. Move
        // them to the D1-authoritative value, and forget any account that is no
        // longer active before accepting new browser frames.
        for (const accountId of [...accountAccessExpiries.keys()]) {
          const expiresAt = reconciliation.activeGrants.get(accountId);
          if (!reconciliation.activeGrants.has(accountId) ||
              (Number.isFinite(expiresAt) && expiresAt <= Date.now())) {
            forgetAccountAccessExpiry(accountId);
          } else {
            setAccountAccessExpiry(accountId, expiresAt);
          }
        }
        for (const [accountId, expiresAt] of reconciliation.retained) {
          setAccountAccessExpiry(accountId, expiresAt);
        }
        for (const [accountId, reason] of reconciliation.ended) {
          terminateAccountSessions(accountId, reason);
        }
        if (reconciliation.ended.size) {
          log(`[sessions] reconciled ${reconciliation.ended.size} ended grant account(s)`);
        }
      }
      void broadcastSessions();
      sendStats();
      break;
    case "browser-status": {
      if (!scopedSessions()) return;
      const principal = {
        accountId: message.accountId,
        accessVia: message.accessVia,
        clientId: message.clientId,
        expiresAt: message.expiresAt,
      };
      if (!validPrincipal(principal)) return;
      if (message.online) {
        if (principalAccessExpired(principal)) {
          terminateAccountSessions(principal.accountId, "access-expired");
          return;
        }
        browserClients.set(principal.clientId, principal);
        if (principal.accessVia === "grant") {
          setAccountAccessExpiry(
            principal.accountId,
            grantExpiryForAccount(browserClients.values(), principal.accountId).expiresAt,
          );
        }
        for (const [storageId, session] of sessions) {
          if (session.ownerAccountId === principal.accountId) cancelSessionCleanup(storageId);
        }
        void buildSessionList(principal).then((list) => {
          sendCtl({ type: "sessions", list }, clientRoute(principal));
        });
      } else {
        browserClients.delete(principal.clientId);
        endClientRequests(principal);
        const remainingGrant = grantExpiryForAccount(browserClients.values(), principal.accountId);
        if (remainingGrant.found) {
          setAccountAccessExpiry(principal.accountId, remainingGrant.expiresAt);
        }
        if (!accountHasBrowser(principal.accountId)) {
          for (const [storageId, session] of sessions) {
            if (session.ownerAccountId === principal.accountId) scheduleSessionCleanup(storageId);
          }
        }
      }
      emitStatus("peer", { online: !!message.online, account: principal.accountId });
      break;
    }
    case "access-revoked":
    case "access-expired":
      if (typeof message.accountId === "string" && message.accountId !== machineOwnerAccountId) {
        terminateAccountSessions(message.accountId, message.event);
      }
      break;
  }
}

function handleSessionInput(principal, data) {
  if (!rememberPrincipalAccessExpiry(principal)) return;
  if (!data?.length) return;
  const sidLen = data[0];
  if (!sidLen || data.length < 1 + sidLen) return;
  const wireSid = data.toString("utf8", 1, 1 + sidLen);
  const found = findSession(principal, wireSid, true, "input");
  if (!found) return;
  const input = data.subarray(1 + sidLen);
  if (!found.opening) {
    writeSessionInput(found.session, input);
  } else {
    const pending = pendingSessionInput.get(found.storageId) || [];
    if (pending.reduce((sum, chunk) => sum + chunk.length, 0) + input.length <= 1024 * 1024) {
      pending.push(Buffer.from(input));
      pendingSessionInput.set(found.storageId, pending);
    }
  }
}

function handleBrowserControl(principal, msg) {
  if (!rememberPrincipalAccessExpiry(principal)) return;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  const initialRequest = new Set([
    "capabilities", "exec", "dl-open", "job-list", "job-read", "job-get",
    "sess-list", "sess-read", "ul-open",
  ]);
  const continuation = new Set([
    "exec-stdin", "exec-stdin-end", "exec-kill", "dl-cancel", "ul-chunk", "ul-end",
  ]);
  if (initialRequest.has(msg.type) && !beginRequest(principal, msg.id)) return;
  if (continuation.has(msg.type) && !ownsRequest(principal, msg.id)) return;

  switch (msg.type) {
    case "capabilities":
      sendCtl({ type: "capabilities", id: msg.id, version: pkg.version, features: PROTOCOL_FEATURES });
      break;
    case "open": {
      void openSession(principal, msg.sid, msg.cols, msg.rows).then((session) => {
        replaySession(session.storageId, session, msg, principal);
        sendStats();
      }).catch((error) => {
        logErr(`[session ${msg.sid}] could not open: ${error.message}`);
        if (!error.exitHandled) {
          sendCtl({ type: "exit", sid: msg.sid, code: null }, scopedSessions() ? clientRoute(principal) : null);
        }
      });
      break;
    }
    case "resize": {
      if (!(msg.cols > 0 && msg.rows > 0)) break;
      const found = findSession(principal, msg.sid, false, "resize");
      if (found) resizeSession(found.session, msg.cols, msg.rows);
      break;
    }
    case "client-gone": break;
    case "list-sessions":
      if (scopedSessions()) {
        void buildSessionList(principal).then((list) => {
          sendCtl({ type: "sessions", list }, clientRoute(principal));
        });
      } else {
        void broadcastSessions();
      }
      break;
    case "close": {
      const found = findSession(principal, msg.sid, true, "close");
      if (found) { killSession(found.storageId); void broadcastSessions(); }
      break;
    }
    case "ping":
      sendCtl({ type: "pong", t: msg.t }, scopedSessions() ? clientRoute(principal) : null);
      break;
    case "exec": startExec(msg, principal); break;
    case "exec-stdin": execStdin(msg.id, msg.data); break;
    case "exec-stdin-end": execStdinEnd(msg.id, msg.sha256); break;
    case "exec-kill": killExec(msg.id, msg.signal); break;
    case "dl-open": startDownload(msg.id, msg.path, msg.base === "home", principal); break;
    case "dl-cancel": cancelDownload(msg.id); requestRoutes.delete(String(msg.id)); break;
    case "job-list": sendJobList(msg.id); break;
    case "job-read": sendJobRead(msg); break;
    case "job-get": sendJobStatus(msg); break;
    case "sess-list": sendSessionLogList(msg.id, principal); break;
    case "sess-read": sendSessionLogRead(msg, principal); break;
    case "ul-open": startUpload(msg.id, msg.sid, msg.name, principal); break;
    case "ul-chunk": uploadChunk(msg.id, msg.data); break;
    case "ul-end": endUpload(msg.id); break;
  }
}

function connect() {
  accountProtocolState = BOUND ? "pending" : "legacy";
  browserClients.clear();
  requestRoutes.clear();
  ws = new WebSocket(wsUrl, {
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    ...(AGENT ? { headers: { "x-switchboard-agent": AGENT } } : {}),
  });

  ws.on("open", () => {
    reconnectDelay = 1000;
    lastPongAt = Date.now(); // start the liveness clock; no pong is owed yet
    if (!announced) { banner(); announced = true; }
    log("[relay] connected");
    emitStatus("connected", { mode: BOUND ? "account" : "token" });
    // Recovered holders existed before this relay connection, so announce
    // them now as well as in response to a browser's list-sessions request.
    if (sessions.size) void broadcastSessions();
  });

  // Fatal server responses: 409 (another daemon on this circuit) and, in bound
  // mode, 401/403 (expired/invalid login). Retrying these would never succeed.
  ws.on("unexpected-response", (req, res) => {
    if (res.statusCode === 409) {
      console.error(
        "\nERROR: this " + (BOUND ? "machine" : "token") + " already has a daemon connected on the relay.\n" +
          "       Stop the other one" + (BOUND ? "." : ", or choose a different --token.")
      );
      emitStatus("fatal", { reason: "conflict", code: res.statusCode });
      void stopDaemon(1);
      return;
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.error(
        `\nERROR: relay rejected this machine (${res.statusCode}). ` +
          "Your login may have expired — run `switchboard login` again."
      );
      emitStatus("fatal", { reason: "auth", code: res.statusCode });
      void stopDaemon(1);
      return;
    }
    // Everything else is transient (a 500 from the relay, a proxy hiccup) and
    // should reconnect. That teardown is ours to do: ws only runs its own
    // abortHandshake() when nothing is listening for `unexpected-response`
    // (see ws/lib/websocket.js), and merely having this handler suppresses it.
    // It also has to be destroy(err), not destroy() — with no error argument
    // nothing reaches ws's request `error` handler, so no `close` is emitted,
    // the socket sits in CONNECTING for ever, and the reconnect timer in the
    // close handler below is never scheduled. The daemon stays up, logs a
    // reassuring line, and is silently off the relay until someone restarts it.
    res.resume();
    req.destroy(new Error(`relay responded ${res.statusCode} to the handshake`));
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (scopedSessions()) {
        const wrapped = unwrapBrowserBinary(data, ACCOUNT_PROTOCOL_NONCE);
        if (wrapped) handleSessionInput(wrapped.principal, wrapped.message);
      } else if (legacySessions()) {
        handleSessionInput(null, data);
      }
      return;
    }
    const text = data.toString("utf8");
    if (text === "pong") { // relay-edge RTT, and proof the link still carries traffic
      if (pingSentAt) lastRtt = Date.now() - pingSentAt;
      lastPongAt = Date.now();
      return;
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === "_relay") {
      handleRelayControl(msg);
      return;
    }
    if (scopedSessions()) {
      const wrapped = unwrapBrowserJson(msg, ACCOUNT_PROTOCOL_NONCE);
      if (wrapped) handleBrowserControl(wrapped.principal, wrapped.message);
      return;
    }
    // A relay predating account-sessions-v1 ignores the daemon's protocol query
    // and forwards browser frames directly. Keep the pre-existing shared mode
    // for the machine owner, but never infer account ownership from those frames.
    if (BOUND && accountProtocolState === "pending") {
      accountProtocolState = "legacy";
      logErr("[relay] account session scoping was not negotiated; grants require a relay/daemon upgrade");
    }
    if (msg.type === "peer-status") {
      log("[relay] browser " + (msg.online ? "connected" : "disconnected"));
      emitStatus("peer", { online: !!msg.online });
      for (const storageId of sessions.keys()) {
        if (msg.online) cancelSessionCleanup(storageId);
        else scheduleSessionCleanup(storageId);
      }
      if (!msg.online) {
        for (const [id, running] of activeExecs) if (!running.detached) killExec(id, "SIGTERM");
      }
      return;
    }
    handleBrowserControl(null, msg);
  });

  ws.on("close", (code) => {
    // 4001 = the relay handed this circuit to a newer daemon for the same
    // machine/token. Reconnecting would just kick that one off in an endless
    // loop, so step aside. Exit 0 so a supervisor (systemd/pm2) treats this as
    // an intentional stop and doesn't restart us back into the fight.
    if (code === 4001) {
      log("[relay] replaced by a newer daemon for this " + (BOUND ? "machine" : "token") + "; exiting.");
      emitStatus("fatal", { reason: "replaced", code });
      void stopDaemon(0);
      return;
    }
    if (stopping) return;
    // Sessions are kept across reconnects; their onData handlers check ws state.
    for (const stream of activeDownloads.values()) stream.destroy();
    activeDownloads.clear();
    for (const up of activeUploads.values()) up.stream.destroy();
    activeUploads.clear();
    // Attached exec dies with its caller; detached jobs keep writing to disk
    // and remain queryable after the relay connection comes back.
    for (const [id, running] of activeExecs) {
      if (!running.detached) { running.abandoned = true; killExec(id, "SIGTERM"); }
    }
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

function startUpload(id, sid, name, principal) {
  const found = findSession(principal, sid, false, "upload");
  if (!found) {
    sendRequestCtl({ type: "ul-error", id, message: "no accessible shell for upload" }, principal);
    return;
  }
  getShellCwd(found.storageId, (dir) => {
    if (scopedSessions() && !ownsRequest(principal, id)) return;
    const safe = path.basename(String(name || "")).trim() || "upload";
    let opened;
    try {
      opened = openUniqueFile(dir, safe);
    } catch (e) {
      sendRequestCtl({ type: "ul-error", id, message: e.message }, principal);
      return;
    }
    const stream = fs.createWriteStream(null, { fd: opened.fd });
    activeUploads.set(id, { stream, finalPath: opened.finalPath, principal });
    stream.on("error", (e) => {
      activeUploads.delete(id);
      try { fs.unlinkSync(opened.finalPath); } catch {}
      sendRequestCtl({ type: "ul-error", id, message: e.message }, principal);
    });
    sendRequestCtl({ type: "ul-ready", id }, principal);
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
    sendRequestCtl(
      { type: "ul-done", id, path: up.finalPath, name: path.basename(up.finalPath) },
      up.principal,
    );
    log(`[file] received ${up.finalPath}`);
  });
}

// Stream a host file to the browser as base64 chunks, with backpressure.
function startDownload(id, rawPath, relativeToHome = false, principal = null) {
  if (!rawPath) {
    sendRequestCtl({ type: "dl-error", id, message: "no path given" }, principal);
    return;
  }
  let filePath = rawPath;
  if (filePath === "~" || filePath.startsWith("~/")) {
    filePath = path.join(os.homedir(), filePath.slice(1));
  }
  // cp explicitly asks for home-relative paths to match exec/upload semantics.
  // An old web client omits the flag and keeps the download protocol's original
  // daemon-cwd behaviour.
  filePath = relativeToHome ? path.resolve(os.homedir(), filePath) : path.resolve(filePath);

  fs.stat(filePath, (err, st) => {
    if (scopedSessions() && !ownsRequest(principal, id)) return;
    if (err) {
      sendRequestCtl(
        { type: "dl-error", id, message: err.code === "ENOENT" ? "no such file" : err.message },
        principal,
      );
      return;
    }
    if (st.isDirectory()) {
      sendRequestCtl({ type: "dl-error", id, message: "path is a directory" }, principal);
      return;
    }
    if (!st.isFile()) {
      sendRequestCtl({ type: "dl-error", id, message: "path is not a regular file" }, principal);
      return;
    }
    sendRequestCtl({
      type: "dl-meta", id, name: path.basename(filePath), size: st.size, mime: "application/octet-stream",
    }, principal);

    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    activeDownloads.set(id, stream);
    stream.on("data", (chunk) => {
      if (!ws || ws.readyState !== WebSocket.OPEN ||
          (scopedSessions() && !ownsRequest(principal, id))) {
        stream.destroy();
        return;
      }
      hash.update(chunk);
      stream.pause(); // resume once this chunk has flushed -> backpressure
      sendRequestCtl({ type: "dl-chunk", id, data: chunk.toString("base64") }, principal, () => {
        if (ws && ws.readyState === WebSocket.OPEN) stream.resume();
      });
    });
    stream.on("end", () => {
      activeDownloads.delete(id);
      sendRequestCtl({ type: "dl-end", id, sha256: hash.digest("hex") }, principal);
      log(`[file] sent ${filePath} (${st.size} bytes)`);
    });
    stream.on("error", (e) => {
      activeDownloads.delete(id);
      sendRequestCtl({ type: "dl-error", id, message: e.message }, principal);
    });
  });
}
function cancelDownload(id) {
  const stream = activeDownloads.get(id);
  if (stream) stream.destroy();
  activeDownloads.delete(id);
}

// ---- remote exec ---------------------------------------------------------
// What `switchboard exec <node> <cmd>` on one of your other machines lands on.
// Deliberately *not* a session: a caller running one command — a script, or an
// agent — wants clean stdout, clean stderr and a real exit code, not a PTY that
// echoes its own input and paints escape sequences over the output.
//
// The relay only lets a peer reach here when this daemon declared `peer=1` on
// connect (SWITCHBOARD_PEER), so the gate is upstream; by the time a message
// arrives it has already been checked against the account that owns this host.
// The detached bit is needed when a caller disconnects: only attached commands
// should receive the ssh-like hangup, while detached jobs keep writing to disk.
const activeExecs = new Map();
const MAX_EXECS = 8;

function execFail(id, message, principal = null) {
  sendRequestCtl({ type: "exec-exit", id, code: 126, error: message }, principal);
}

function startExec(msg, principal = null) {
  const id = msg.id;
  if (!id || activeExecs.has(id)) return;
  let cmd = typeof msg.cmd === "string" ? msg.cmd.trim() : "";
  if (!cmd) return execFail(id, "empty command", principal);
  // A peer is already trusted to run anything here; the cap is against a runaway
  // loop on the other end, not against its author.
  if (activeExecs.size >= MAX_EXECS) {
    return execFail(id, `too many concurrent commands (max ${MAX_EXECS})`, principal);
  }

  let cwd = msg.cwd ? String(msg.cwd) : os.homedir();
  if (cwd === "~" || cwd.startsWith("~/")) cwd = path.join(os.homedir(), cwd.slice(1));
  let selectedShell = msg.shell ? String(msg.shell) : SHELL;
  // An absent flag preserves the behaviour expected by older clients. New
  // clients send false explicitly, so --login is an actual per-command choice.
  const login = msg.login === undefined ? true : !!msg.login;
  const detached = !!msg.detach;
  let upload = null;
  try {
    if (msg.upload) {
      let destination = String(msg.upload.path || "");
      if (!destination) throw new Error("no upload destination given");
      if (/[\\/]$/.test(destination)) throw new Error("target path is a directory; choose a file path");
      if (destination === "~" || destination.startsWith("~/")) {
        destination = path.join(os.homedir(), destination.slice(1));
      }
      destination = path.resolve(cwd, destination);
      const parent = path.dirname(destination);
      const parentStat = fs.statSync(parent);
      if (!parentStat.isDirectory()) throw new Error(`target parent is not a directory: ${parent}`);
      try {
        if (fs.statSync(destination).isDirectory()) throw new Error(`target is a directory: ${destination}`);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const tempPath = path.join(parent, `.${path.basename(destination)}.switchboard-${id}.part`);
      const fd = fs.openSync(tempPath, "wx", 0o600);
      fs.closeSync(fd);
      upload = { destination, tempPath, expected: null };
      if (process.platform === "win32") {
        selectedShell = "powershell.exe";
        const encodedPath = Buffer.from(tempPath, "utf16le").toString("base64");
        cmd = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'));` +
          "$i=[Console]::OpenStandardInput();$o=[IO.File]::OpenWrite($p);" +
          "try{$i.CopyTo($o)}finally{$o.Dispose()}";
      } else {
        selectedShell = "/bin/sh";
        cmd = `cat > ${shellQuote(tempPath)}`;
      }
    }
  } catch (e) {
    return execFail(id, e.code === "ENOENT"
      ? `target directory does not exist: ${path.dirname(String(msg.upload?.path || ""))}`
      : e.message, principal);
  }

  let job = null;
  if (detached) {
    try {
      job = jobStore.create({ id, command: cmd, cwd, shell: selectedShell, login });
    } catch (e) {
      if (upload) try { fs.unlinkSync(upload.tempPath); } catch {}
      return execFail(id, e.message, principal);
    }
  }

  let child;
  try {
    child = spawn(selectedShell, shellCommandArgs(cmd, login), {
      cwd,
      env: process.env,
      // Its own process group, so a Ctrl-C on the far end can take down the
      // whole pipeline rather than just the shell that spawned it.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    if (upload) try { fs.unlinkSync(upload.tempPath); } catch {}
    if (job) void jobStore.finish(id, { status: "failed", error: e.message });
    return execFail(id, e.message, principal);
  }
  activeExecs.set(id, { child, detached, upload, principal });
  log(`[exec ${id.slice(0, 8)}] ${cmd}`);
  if (detached) sendRequestCtl({ type: "exec-job", id, job: id }, principal);
  else if (upload) sendRequestCtl({ type: "exec-ready", id }, principal);
  if (detached) {
    jobStore.writer(id)?.on("error", (e) => {
      const running = activeExecs.get(id);
      if (!running) return;
      running.outputError = e;
      killExec(id, "SIGTERM");
    });
  }

  // Same backpressure shape as a download: pause until the frame has flushed,
  // so a command that floods stdout can't outrun the socket.
  const pump = (stream, type) => {
    stream.on("data", (chunk) => {
      if (detached) {
        try {
          if (!jobStore.append(id, chunk)) {
            stream.pause();
            jobStore.writer(id)?.once("drain", () => stream.resume());
          }
        } catch (e) {
          const running = activeExecs.get(id);
          if (running) running.outputError = e;
          killExec(id, "SIGTERM");
        }
        return;
      }
      if (!ws || ws.readyState !== WebSocket.OPEN ||
          (scopedSessions() && !ownsRequest(principal, id))) {
        const running = activeExecs.get(id);
        if (running) running.abandoned = true;
        killExec(id);
        return;
      }
      stream.pause();
      sendRequestCtl({ type, id, data: chunk.toString("base64") }, principal, () => {
        if (ws && ws.readyState === WebSocket.OPEN) stream.resume();
      });
    });
  };
  pump(child.stdout, "exec-out");
  pump(child.stderr, "exec-err");

  // Without stdin the caller is not going to send any, and a command that reads
  // it (`cat`, `read`) would hang forever waiting on a pipe nobody will close.
  child.stdin.on("error", () => {}); // the child may exit before we finish writing
  if (detached || !msg.stdin) child.stdin.end();

  child.on("error", (e) => {
    if (!activeExecs.delete(id)) return;
    if (upload) try { fs.unlinkSync(upload.tempPath); } catch {}
    const message = e.code === "ENOENT" ? `shell or working directory not found (${selectedShell}, ${cwd})` : e.message;
    if (detached) void jobStore.finish(id, { status: "failed", error: message });
    else execFail(id, message, principal);
  });
  child.on("close", async (code, signal) => {
    const running = activeExecs.get(id);
    if (!running || !activeExecs.delete(id)) return;
    let error = null;
    let sha256 = null;
    if (upload) {
      try {
        if (running.uploadProtocolError) {
          try { fs.unlinkSync(upload.tempPath); } catch {}
          error = running.uploadProtocolError.message;
          code = 1;
        } else if (code !== 0 || signal) {
          try { fs.unlinkSync(upload.tempPath); } catch {}
          error = "upload failed; partial target was removed";
        } else {
          sha256 = await verifyUploadedFile(upload.tempPath, upload.expected);
          if (process.platform === "win32") {
            try { fs.unlinkSync(upload.destination); } catch (e) { if (e.code !== "ENOENT") throw e; }
          }
          fs.renameSync(upload.tempPath, upload.destination);
        }
      } catch (e) {
        try { fs.unlinkSync(upload.tempPath); } catch {}
        error = e.message;
        code = 1;
      }
    }
    if (detached) {
      const outputError = running.outputError;
      await jobStore.finish(id, {
        status: outputError ? "failed" : "exited", exitCode: code, signal: signal || null,
        error: outputError ? `could not save job output: ${outputError.message}` : error,
      });
    } else if (!running.abandoned) {
      sendRequestCtl({
        type: "exec-exit", id, code: code == null ? null : code,
        signal: signal || null, error, sha256,
      }, principal);
    }
    log(`[exec ${id.slice(0, 8)}] exited (${signal || code})`);
  });
}

function execStdin(id, b64) {
  const running = activeExecs.get(id);
  const child = running?.child;
  if (child && child.stdin.writable) {
    child.stdin.write(Buffer.from(String(b64 || ""), "base64"), () => {
      if (running.upload) sendRequestCtl({ type: "exec-stdin-ready", id }, running.principal);
    });
  }
}
function execStdinEnd(id, sha256) {
  const running = activeExecs.get(id);
  const child = running?.child;
  if (!child || !child.stdin.writable) return;
  if (running.upload) {
    const expected = String(sha256 || "");
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      running.uploadProtocolError = new Error("client did not provide a valid upload checksum");
      killExec(id, "SIGTERM");
      return;
    }
    running.upload.expected = expected;
  }
  child.stdin.end();
}
function killExec(id, signal) {
  const child = activeExecs.get(id)?.child;
  if (!child) return;
  const sig = signal === "SIGKILL" ? "SIGKILL" : signal === "SIGTERM" ? "SIGTERM" : "SIGINT";
  try {
    // Negative pid = the whole process group (see `detached` above). Falls back
    // to the direct child on Windows, which has no groups to signal.
    if (process.platform === "win32") child.kill(sig);
    else process.kill(-child.pid, sig);
  } catch { try { child.kill(sig); } catch {} }
}

function sendJobList(id) {
  if (!id) return;
  sendCtl({ type: "job-list", id, jobs: jobStore.list() });
}
function sendJobRead(msg) {
  if (!msg.id || !msg.job) return;
  try {
    const chunk = jobStore.read(String(msg.job), msg.offset, 64 * 1024);
    sendCtl({
      type: "job-chunk", id: msg.id, job: msg.job, data: chunk.data.toString("base64"),
      offset: chunk.offset, size: chunk.size, record: jobStore.get(String(msg.job)),
    });
  } catch (e) {
    sendCtl({ type: "job-error", id: msg.id, job: msg.job, message: e.message });
  }
}
function sendJobStatus(msg) {
  if (!msg.id || !msg.job) return;
  const record = jobStore.get(String(msg.job));
  sendCtl(record
    ? { type: "job-status", id: msg.id, job: msg.job, record }
    : { type: "job-error", id: msg.id, job: msg.job, message: "no such job" });
}

function visibleHistory(principal, action = "history-list") {
  if (!sessionLog) return [];
  if (!scopedSessions()) return sessionLog.list();
  return sessionLog.list().filter((record) =>
    canAccessSessionFor(action, principal, record, machineOwnerAccountId));
}

function historyRecord(principal, wireSid) {
  for (const record of visibleHistory(principal, "history-read")) {
    const visibleSid = scopedSessions() ? sessionWireId(record, principal) : record.sid;
    if (visibleSid === wireSid) return { record, visibleSid };
  }
  return null;
}

function sendSessionLogList(id, principal) {
  if (!id) return;
  if (!scopedSessions()) {
    sendCtl(sessionLogListResponse(sessionLog, id));
    return;
  }
  const sessionsForPrincipal = visibleHistory(principal).map((record) => {
    const { storageId, ...visible } = record;
    return {
      ...visible,
      sid: sessionWireId(record, principal),
      sessionSid: record.sid,
      mine: record.ownerAccountId === principal.accountId,
    };
  });
  sendCtl({ type: "sess-list", id, recording: !!sessionLog, sessions: sessionsForPrincipal });
}
function sendSessionLogRead(msg, principal) {
  if (!msg.id || !msg.sid) return;
  if (!scopedSessions()) {
    sendCtl(sessionLogReadResponse(sessionLog, msg));
    return;
  }
  const found = historyRecord(principal, msg.sid);
  if (!found) {
    sendCtl({ type: "sess-error", id: msg.id, sid: msg.sid, message: "no accessible session" });
    return;
  }
  const response = sessionLogReadResponse(sessionLog, { ...msg, sid: found.record.storageId });
  response.sid = found.visibleSid;
  if (response.stat) {
    const { storageId, ...stat } = response.stat;
    response.stat = { ...stat, sid: found.visibleSid };
  }
  sendCtl(response);
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

function activityForPrincipal(principal) {
  const visible = scopedSessions()
    ? new Map([...sessions].filter(([, session]) =>
      canAccessSessionFor("activity", principal, session, machineOwnerAccountId)))
    : sessions;
  const act = activity.snapshot(visible, cwdCache);
  act.shells = (act.shells || []).map((shell) => {
    const session = sessions.get(shell.sid);
    return session ? { ...shell, sid: scopedSessions() ? sessionWireId(session, principal) : session.sid } : shell;
  });
  if (scopedSessions() && principal.accessVia === "grant") {
    // Process/agent summaries are host-wide and can describe an owner's hidden
    // work even when no terminal frame crosses the account boundary.
    act.top = [];
    delete act.agents;
    delete act.agentsIdle;
  }
  act.platform = process.platform;
  act.arch = process.arch;
  return act;
}

function statsMessage(cpu, memUsed, total, cores, act) {
  return {
    type: "stats",
    cpu,
    memUsed,
    memTotal: total,
    cores,
    ip: primaryIp(),
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    rtt: lastRtt,
    act,
  };
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
  // A half-open link still accepts ws.send() — the frames go into the kernel's
  // send buffer and TCP retransmits them for ~15 minutes before giving up. For
  // all that time readyState stays OPEN, no `close` fires, the reconnect timer
  // never runs, and this daemon reports itself Online while the relay has long
  // since written the machine off. The unanswered pings are the only evidence,
  // so act on them: terminate() destroys the socket now and emits the `close`
  // the reconnect path is waiting for.
  if (lastPongAt && Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
    logErr(`[relay] no pong for ${PONG_TIMEOUT_MS}ms; link is half-open, reconnecting`);
    lastPongAt = 0; // don't fire again while the close is in flight
    ws.terminate();
    return;
  }
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
  const ownerPrincipal = scopedSessions() ? {
    accountId: machineOwnerAccountId, accessVia: "owner", clientId: "daemon-owner-view",
  } : null;
  const act = activityForPrincipal(ownerPrincipal);
  try {
    const ownerStats = statsMessage(cpu, memUsed, total, cores, act);
    if (scopedSessions()) {
      // The owner copy is both the supervisory live view and the only heartbeat
      // persisted by the relay. Each grantee receives an account-filtered copy.
      sendCtl(ownerStats, ownerRoute());
      const guests = new Map();
      for (const principal of browserClients.values()) {
        if (principal.accessVia === "grant") guests.set(principal.accountId, principal);
      }
      for (const principal of guests.values()) {
        sendCtl(statsMessage(cpu, memUsed, total, cores, activityForPrincipal(principal)),
          accountRoute(principal.accountId));
      }
    } else if (legacySessions()) {
      ws.send(JSON.stringify(ownerStats));
    }
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
  if (PEER_SUBS.includes(sub)) return doPeer(); // client-side: talk to the *other* machines
  if (sub === "login") {
    // Ask before the browser round-trip rather than after it: signing in here
    // ends with this machine exposed, which is exactly what a daemon already
    // running would lose. The machine id survives a login, so the circuit this
    // run lands on is knowable now — and when there isn't one yet, login mints
    // it, which means nothing running can be on that circuit. A stand-in random
    // id says precisely that.
    await confirmSoleDaemon(circuitId(true, cfg.machineId || crypto.randomUUID()));
    // One step: sign in, then fall through to expose this machine's shell.
    await doLogin(); // saves config; fatal-exits on failure
    cfg = loadConfig();
    setupConnection();
  } else {
    setupConnection(); // resolves the circuit this run would take…
    await confirmSoleDaemon(circuitId(BOUND, BOUND ? MACHINE : TOKEN)); // …so we can name it
  }
  // We're going ahead: put this daemon on the record, and take it off again on
  // the way out. `exit` covers every path out of here — the signal handlers
  // below, a fatal relay response, the 4001 handover — since they all end in
  // process.exit().
  claimRunRecord();
  process.on("exit", releaseRunRecord);
  refreshMemAvailable();
  // Different local daemons may legally serve different circuits at once. Keep
  // their job ledgers apart so one startup cannot mark the other's jobs unknown.
  const storageScope = BOUND ? MACHINE : circuitId(false, TOKEN);
  jobStore = new JobStore({ dir: path.join(CONFIG_DIR, "jobs", storageScope) }).init();
  sessionRoot = path.join(CONFIG_DIR, "sessions");
  sessionScope = storageScope;
  if (RECORD_SESSIONS) {
    try {
      sessionLog = new SessionLogStore({
        dir: sessionRoot, scope: storageScope,
      }).init();
    } catch (e) {
      logErr("session recording unavailable: " + e.message);
    }
  }
  if (USE_PTY_HOLDER) {
    const recovered = await recoverPtyHolders({ rootDir: sessionRoot, scope: sessionScope });
    for (const client of recovered) adoptHolder(client, true);
    if (recovered.length) log(`recovered ${recovered.length} detached shell holder(s)`);
  }
  setInterval(() => jobStore.cleanup(), 60 * 60 * 1000);
  if (sessionLog) setInterval(() => sessionLog.prune(), 60 * 60 * 1000);
  setInterval(sendStats, STATS_INTERVAL_MS);
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
    void stopDaemon(0);
  };
  process.on("SIGINT", shutdown("SIGINT"));
  process.on("SIGTERM", shutdown("SIGTERM"));
  // Windows has no signal a supervisor can send a windowless child: there,
  // child.kill() is TerminateProcess and Ctrl-C needs a shared console. So the
  // tray app holds our stdin open and closes it to ask us to stop — which also
  // takes us down with it if the app itself dies. Opt-in, because an
  // interactive run must not exit on Ctrl-Z/Ctrl-D.
  if (process.env.SWITCHBOARD_STOP_ON_STDIN_EOF === "1") {
    process.stdin.on("end", shutdown("stdin closed"));
    process.stdin.on("error", shutdown("stdin closed"));
    process.stdin.resume();
  }
})();
