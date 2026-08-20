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
const { exec, spawn, spawnSync } = require("child_process");
const WebSocket = require("ws");
const pty = require("node-pty");
const fixPtyPerms = require("./scripts/fix-pty-perms");
const activity = require("./activity");
const peer = require("./peer");
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

Reachable machines (signed in; the target must allow peers):
  switchboard nodes            List machines you own or that were shared with you.
  switchboard exec <node> <cmd…>
                               Run a command over there; its stdout, stderr and
                               exit code come back here.
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

  nodes: --json                Machine-readable output.
  exec:  --cwd <dir>           Working directory over there. Default: its home.
         --timeout <seconds>   Give up and kill the command after this long.
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

Notes:
  Logged in → this machine shows up in your dashboard; you may share it there.
  Anonymous → the token is the credential; anyone who has it gets a shell here.
  One daemon serves this machine at a time. If another one is already up — the
  menu-bar app, the systemd service, another terminal — starting this one takes
  its circuit over and closes the shells open in it, so you're asked first.`);
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
function parsePeerArgs(argv) {
  const opts = {};
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
const PEER_SUBS = ["nodes", "ls", "exec", "shell"];
const sub = ["login", "logout", "service", ...PEER_SUBS].includes(rawArgs[0]) ? rawArgs.shift() : null;
// `service` takes a bare verb of its own before the usual flags.
const serviceAction = sub === "service" && rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.shift() : null;
const args = PEER_SUBS.includes(sub) ? parsePeerArgs(rawArgs) : parseArgs(rawArgs);
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
// `nodes` / `exec` / `shell` don't expose anything: they spawn no PTY and
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
  return run(peer.cmdExec(ctx, {
    target: args.target, command, cwd: args.cwd || null, timeout: args.timeout || 0,
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
    case "app": return process.platform === "darwin" ? "the menu-bar app" : "a supervisor";
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
      (takeover ? " — taking over its circuit; the shells open in it will close."
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
      "&name=" + encodeURIComponent(os.hostname()) + (PEER ? "&peer=1" : "");
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

function sendCtl(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
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
      // Keystrokes from a window: [1-byte sid length][sid][payload].
      const sidLen = data[0];
      const sid = data.toString("utf8", 1, 1 + sidLen);
      const s = sessions.get(sid);
      if (s) s.pty.write(data.subarray(1 + sidLen).toString("utf8"));
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
        // Nobody is left on this circuit, so no running command still has a
        // caller: its output is going nowhere and nothing can stop it any more.
        // This is the SIGHUP an ssh session would have delivered.
        if (!msg.online) for (const id of [...activeExecs.keys()]) killExec(id, "SIGTERM");
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
    // Exec dies with the link it was invoked over: its caller is already gone,
    // and a command whose output has nowhere to go would fill a pipe and hang.
    // (Long jobs belong in a session, which does survive a reconnect.)
    for (const id of [...activeExecs.keys()]) { killExec(id, "SIGTERM"); activeExecs.delete(id); }
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

// ---- remote exec ---------------------------------------------------------
// What `switchboard exec <node> <cmd>` on one of your other machines lands on.
// Deliberately *not* a session: a caller running one command — a script, or an
// agent — wants clean stdout, clean stderr and a real exit code, not a PTY that
// echoes its own input and paints escape sequences over the output.
//
// The relay only lets a peer reach here when this daemon declared `peer=1` on
// connect (SWITCHBOARD_PEER), so the gate is upstream; by the time a message
// arrives it has already been checked against the account that owns this host.
const activeExecs = new Map(); // id -> child process
const MAX_EXECS = 8;

// A *login* shell. The daemon's own environment is not the user's: started by
// systemd or launchd it inherits a stub PATH, so `node`, `claude` or `cargo`
// installed by a version manager would simply not exist. -l reads the profile,
// which is what makes a command behave the way it does when you type it.
function shellCommandArgs(cmd) {
  return process.platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-Command", cmd]
    : ["-lc", cmd];
}

function execFail(id, message) {
  sendCtl({ type: "exec-exit", id, code: 126, error: message });
}

function startExec(msg) {
  const id = msg.id;
  if (!id || activeExecs.has(id)) return;
  const cmd = typeof msg.cmd === "string" ? msg.cmd.trim() : "";
  if (!cmd) return execFail(id, "empty command");
  // A peer is already trusted to run anything here; the cap is against a runaway
  // loop on the other end, not against its author.
  if (activeExecs.size >= MAX_EXECS) return execFail(id, `too many concurrent commands (max ${MAX_EXECS})`);

  let cwd = msg.cwd ? String(msg.cwd) : os.homedir();
  if (cwd === "~" || cwd.startsWith("~/")) cwd = path.join(os.homedir(), cwd.slice(1));

  let child;
  try {
    child = spawn(SHELL, shellCommandArgs(cmd), {
      cwd,
      env: process.env,
      // Its own process group, so a Ctrl-C on the far end can take down the
      // whole pipeline rather than just the shell that spawned it.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return execFail(id, e.message);
  }
  activeExecs.set(id, child);
  log(`[exec ${id.slice(0, 8)}] ${cmd}`);

  // Same backpressure shape as a download: pause until the frame has flushed,
  // so a command that floods stdout can't outrun the socket.
  const pump = (stream, type) => {
    stream.on("data", (chunk) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { killExec(id); return; }
      stream.pause();
      ws.send(JSON.stringify({ type, id, data: chunk.toString("base64") }), () => {
        if (ws && ws.readyState === WebSocket.OPEN) stream.resume();
      });
    });
  };
  pump(child.stdout, "exec-out");
  pump(child.stderr, "exec-err");

  // Without stdin the caller is not going to send any, and a command that reads
  // it (`cat`, `read`) would hang forever waiting on a pipe nobody will close.
  child.stdin.on("error", () => {}); // the child may exit before we finish writing
  if (!msg.stdin) child.stdin.end();

  child.on("error", (e) => {
    if (!activeExecs.delete(id)) return;
    execFail(id, e.code === "ENOENT" ? `no such directory: ${cwd}` : e.message);
  });
  child.on("close", (code, signal) => {
    if (!activeExecs.delete(id)) return;
    sendCtl({ type: "exec-exit", id, code: code == null ? null : code, signal: signal || null });
    log(`[exec ${id.slice(0, 8)}] exited (${signal || code})`);
  });
}

function execStdin(id, b64) {
  const child = activeExecs.get(id);
  if (child && child.stdin.writable) child.stdin.write(Buffer.from(String(b64 || ""), "base64"));
}
function execStdinEnd(id) {
  const child = activeExecs.get(id);
  if (child && child.stdin.writable) child.stdin.end();
}
function killExec(id, signal) {
  const child = activeExecs.get(id);
  if (!child) return;
  const sig = signal === "SIGKILL" ? "SIGKILL" : signal === "SIGTERM" ? "SIGTERM" : "SIGINT";
  try {
    // Negative pid = the whole process group (see `detached` above). Falls back
    // to the direct child on Windows, which has no groups to signal.
    if (process.platform === "win32") child.kill(sig);
    else process.kill(-child.pid, sig);
  } catch { try { child.kill(sig); } catch {} }
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
    for (const sid of sessions.keys()) killSession(sid);
    process.exit(0);
  };
  process.on("SIGINT", shutdown("SIGINT"));
  process.on("SIGTERM", shutdown("SIGTERM"));
})();
