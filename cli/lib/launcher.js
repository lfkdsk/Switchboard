const fs = require("fs");
const path = require("path");

// These describe the process which owns the daemon, not the user's shell. Do
// not let a shell or peer exec inherit them: otherwise a later bare
// `switchboard` inside that child could mistake itself for an App/systemd
// restart and expose the machine without an explicit `up`.
const SUPERVISOR_ENV = [
  "SWITCHBOARD_STATUS_FILE",
  "SWITCHBOARD_JSON_STATUS",
  "SWITCHBOARD_STOP_ON_STDIN_EOF",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
];

function openFd(fd, fsImpl) {
  try { fsImpl.fstatSync(fd); return true; }
  catch { return false; }
}

function journalStreamMatches(value, fd, fsImpl) {
  const match = /^(\d+):(\d+)$/.exec(value || "");
  if (!match) return false;
  try {
    const stat = fsImpl.fstatSync(fd);
    return String(stat.dev) === match[1] && String(stat.ino) === match[2];
  } catch { return false; }
}

function appStatusSink(env, fsImpl, parentPid, allowFd3) {
  const file = env.SWITCHBOARD_STATUS_FILE;
  // All deployed macOS/Windows Apps (including legacy-mac) put their own pid in
  // this pre-created filename. A shell spawned by the daemon may inherit the
  // string in old CLI versions, but its parent is the shell/holder, not the App.
  const owner = file && /^switchboard-status-(\d+)-\d+\.ndjson$/.exec(path.basename(file));
  if (file && path.isAbsolute(file) && owner && Number(owner[1]) === parentPid) {
    try { fsImpl.statSync(file); return true; }
    catch { /* an inherited path to a removed status file is not a launch signal */ }
  }
  return allowFd3 && !!env.SWITCHBOARD_JSON_STATUS && openFd(3, fsImpl);
}

/**
 * Return the supervisor which directly launched this process, or null.
 *
 * Existing macOS/Windows Apps (including legacy-mac) create an absolute status
 * file whose name carries their pid before spawning the CLI. Older systemd
 * units have no custom marker, but systemd supplies INVOCATION_ID plus either a
 * matching SYSTEMD_EXEC_PID or JOURNAL_STREAM; matching the latter to our actual
 * stdout/stderr is systemd's documented way to reject an inherited value. The
 * weaker fd-3 status signal is accepted only without a TTY. New supervisors
 * pass `up` explicitly; this is only their old-version safety net.
 */
function supervisorLauncher({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  parentPid = process.ppid,
  fsImpl = fs,
} = {}) {
  const interactive = [stdin, stdout, stderr].some((stream) => stream && stream.isTTY);
  if (appStatusSink(env, fsImpl, parentPid, !interactive)) return "app";
  if (env.INVOCATION_ID && (
    Number(env.SYSTEMD_EXEC_PID) === process.pid ||
    journalStreamMatches(env.JOURNAL_STREAM, 1, fsImpl) ||
    journalStreamMatches(env.JOURNAL_STREAM, 2, fsImpl)
  )) return "service";
  return null;
}

function childEnvironment(env = process.env) {
  const child = { ...env };
  for (const key of SUPERVISOR_ENV) delete child[key];
  return child;
}

module.exports = { childEnvironment, supervisorLauncher };
