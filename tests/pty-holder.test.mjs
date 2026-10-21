import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import holderModule from "../cli/lib/pty-holder.js";
import sessionLogModule from "../cli/lib/session-log.js";

const {
  holderSocketPath,
  spawnPtyHolder,
  stopPtyHolders,
  usePtyHolder,
} = holderModule;
const { SessionLogStore } = sessionLogModule;
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/pty-holder-daemon.mjs");
const requireFromCli = createRequire(new URL("../cli/package.json", import.meta.url));
let holderRuntimeAvailable = true;
try { requireFromCli.resolve("node-pty"); } catch { holderRuntimeAvailable = false; }

function startDaemon(socketPath, mode, since = 0) {
  return spawn(process.execPath, [fixture], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      HOLDER_TEST_MODE: mode,
      HOLDER_TEST_SOCKET: socketPath,
      HOLDER_TEST_SINCE: String(since),
    },
  });
}

function nextMessage(child, expected, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`timed out waiting for ${expected}`)), timeout);
    const onMessage = (message) => {
      if (message.type === "error") return done(new Error(message.message));
      if (message.type === expected) done(null, message);
    };
    const onExit = (code, signal) => done(new Error(
      `daemon fixture exited before ${expected} (code=${code}, signal=${signal})`,
    ));
    const done = (error, message) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(message);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
}

async function waitFor(check, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

test("holder selection keeps Windows on the in-process PTY path", () => {
  assert.equal(usePtyHolder("linux"), true);
  assert.equal(usePtyHolder("darwin"), true);
  assert.equal(usePtyHolder("win32"), false);
});

test("a detached PTY holder survives daemon replacement and replays missed output", {
  skip: process.platform === "win32"
    ? "Unix sockets are not used on Windows"
    : !holderRuntimeAvailable ? "CLI runtime dependencies are not installed" : false,
  timeout: 30000,
}, async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-holder-"));
  const scope = "test-scope";
  const sid = "holder-restart";
  const socketPath = holderSocketPath(rootDir, scope, sid);
  let firstDaemon;
  let secondDaemon;
  t.after(async () => {
    await stopChild(firstDaemon);
    await stopChild(secondDaemon);
    await stopPtyHolders({ rootDir, scope, timeout: 2000 });
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const launcher = await spawnPtyHolder({
    rootDir,
    scope,
    sid,
    shell: "/bin/sh",
    cwd: rootDir,
    cols: 80,
    rows: 24,
    recording: true,
  });
  const originalShellPid = launcher.pid;
  const originalHolderPid = launcher.holderPid;
  launcher.disconnect();

  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  firstDaemon = startDaemon(socketPath, "first");
  const before = await nextMessage(firstDaemon, "before");
  assert.equal(before.shellPid, originalShellPid);
  assert.equal(before.holderPid, originalHolderPid);

  await stopChild(firstDaemon);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(pidAlive(originalHolderPid), true, "holder must outlive the first daemon");
  assert.equal(pidAlive(originalShellPid), true, "shell must outlive the first daemon");

  secondDaemon = startDaemon(socketPath, "second", before.offset);
  const recovered = await nextMessage(secondDaemon, "recovered");
  assert.equal(recovered.shellPid, originalShellPid);
  assert.equal(recovered.holderPid, originalHolderPid);
  assert.equal(recovered.replay.mode, "delta");
  assert.equal(recovered.replay.from, before.offset);
  assert.match(recovered.output, /HOLDER_DURING\r\n/);
  await nextMessage(secondDaemon, "exit");
  await once(secondDaemon, "exit");

  await waitFor(() => !fs.existsSync(socketPath), "holder socket cleanup");
  await waitFor(() => !pidAlive(originalHolderPid), "holder process exit");
  await waitFor(() => !pidAlive(originalShellPid), "shell process exit");

  const observer = new SessionLogStore({ dir: rootDir, scope }).init();
  const transcript = observer.read(sid, { from: 0, len: 1024 * 1024 }).data.toString("utf8");
  assert.match(transcript, /HOLDER_BEFORE/);
  assert.match(transcript, /HOLDER_DURING/);
  assert.equal(observer.stat(sid).status, "closed");
});
