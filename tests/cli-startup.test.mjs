import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { childEnvironment, supervisorLauncher } = require("../cli/lib/launcher.js");

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "cli", "index.js");
const preload = path.join(root, "tests", "fixtures", "cli-startup-stub.cjs");
const token = "startup-test-token-1234567890";
const supervisorKeys = [
  "SWITCHBOARD_STATUS_FILE",
  "SWITCHBOARD_JSON_STATUS",
  "SWITCHBOARD_STOP_ON_STDIN_EOF",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
];

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cli-startup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const key of supervisorKeys) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function runCli(home, args = [], { env = {}, stdio } = {}) {
  return spawnSync(process.execPath, ["--require", preload, cli, ...args], {
    encoding: "utf8",
    timeout: 5000,
    env: isolatedEnv(home, env),
    ...(stdio ? { stdio } : {}),
  });
}

function output(result) {
  return String(result.stdout || "") + String(result.stderr || "");
}

test("bare command and daemon flags are inert, nonzero, and point to up", (t) => {
  const cases = [
    { args: [] },
    { args: [], env: { SWITCHBOARD_TOKEN: token } },
    { args: ["--token", token] },
    { args: ["--server", "http://127.0.0.1:9"] },
  ];
  for (const { args, env } of cases) {
    const home = tempHome(t);
    const result = runCli(home, args, { env });
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /switchboard up/);
    assert.doesNotMatch(output(result), /TEST_WS_CONNECT/);
    assert.equal(fs.existsSync(path.join(home, ".switchboard")), false);
  }
});

test("help and version remain successful without a subcommand", (t) => {
  const home = tempHome(t);
  for (const flag of ["--help", "-h"]) {
    const result = runCli(home, [flag]);
    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /switchboard up \[options\]/);
  }
  const version = runCli(home, ["--version"]);
  assert.equal(version.status, 0, output(version));
  assert.match(version.stdout, /^1\.3\.0\s*$/);
  assert.equal(fs.existsSync(path.join(home, ".switchboard")), false);
});

test("an inherited INVOCATION_ID alone is not a supervised launch", (t) => {
  const home = tempHome(t);
  const result = runCli(home, [], { env: { INVOCATION_ID: "not-this-process" } });
  assert.equal(result.status, 1, output(result));
  assert.doesNotMatch(output(result), /TEST_WS_CONNECT/);
});

test("an inherited App status path from another parent is not a supervised launch", (t) => {
  const home = tempHome(t);
  const statusFile = path.join(home, `switchboard-status-${process.pid + 1}-1.ndjson`);
  fs.writeFileSync(statusFile, "");
  const result = runCli(home, [], { env: { SWITCHBOARD_STATUS_FILE: statusFile } });
  assert.equal(result.status, 1, output(result));
  assert.doesNotMatch(output(result), /TEST_WS_CONNECT/);
  assert.equal(fs.readFileSync(statusFile, "utf8"), "");
  assert.equal(fs.existsSync(path.join(home, ".switchboard")), false);
});

test("old App launches with a pre-created status file still enter the up path", (t) => {
  for (const args of [[], ["--token", token]]) {
    const home = tempHome(t);
    const statusFile = path.join(home, `switchboard-status-${process.pid}-${args.length}.ndjson`);
    fs.writeFileSync(statusFile, "");
    const result = runCli(home, args, {
      env: {
        SWITCHBOARD_STATUS_FILE: statusFile,
        ...(args.length ? {} : { SWITCHBOARD_TOKEN: token }),
      },
    });
    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /TEST_WS_CONNECT/);
    assert.match(fs.readFileSync(statusFile, "utf8"), /"ev":"connecting"/);
  }
});

test("old fd-3 status supervisors still enter the up path", (t) => {
  const home = tempHome(t);
  const statusFile = path.join(home, "fd3.ndjson");
  const statusFd = fs.openSync(statusFile, "w");
  t.after(() => { try { fs.closeSync(statusFd); } catch {} });
  const result = runCli(home, [], {
    env: { SWITCHBOARD_JSON_STATUS: "1", SWITCHBOARD_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe", statusFd],
  });
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /TEST_WS_CONNECT/);
  assert.match(fs.readFileSync(statusFile, "utf8"), /"ev":"connecting"/);
});

test("an old systemd unit is recognized only when JOURNAL_STREAM is this process output", (t) => {
  if (process.platform !== "linux") return t.skip("systemd compatibility is Linux-only");
  const home = tempHome(t);
  const journalFile = path.join(home, "journal.log");
  const journalFd = fs.openSync(journalFile, "w");
  t.after(() => { try { fs.closeSync(journalFd); } catch {} });
  const stat = fs.fstatSync(journalFd);
  const result = runCli(home, [], {
    env: {
      INVOCATION_ID: "startup-test-invocation",
      JOURNAL_STREAM: `${stat.dev}:${stat.ino}`,
      SWITCHBOARD_TOKEN: token,
    },
    stdio: ["ignore", journalFd, journalFd],
  });
  assert.equal(result.status, 0, fs.readFileSync(journalFile, "utf8"));
  assert.match(fs.readFileSync(journalFile, "utf8"), /TEST_WS_CONNECT/);
});

test("explicit up refuses an existing daemon until --force is supplied", async (t) => {
  const home = tempHome(t);
  const marker = path.join(home, "existing-switchboard-daemon.cjs");
  fs.writeFileSync(marker, "setInterval(() => {}, 1000);\n");
  const existing = spawn(process.execPath, [marker], { stdio: "ignore" });
  t.after(() => { try { existing.kill("SIGTERM"); } catch {} });

  const configDir = path.join(home, ".switchboard");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "daemons.json"), JSON.stringify({
    daemons: [{
      pid: existing.pid,
      startedAt: Date.now(),
      launcher: "app",
      cli: marker,
      server: "https://shell.lfkdsk.org",
      mode: "token",
      circuit: null,
    }],
  }));

  const refused = runCli(home, ["up", "--token", token]);
  assert.equal(refused.status, 1, output(refused));
  assert.match(output(refused), /Refusing to start another daemon/);
  assert.match(output(refused), /switchboard up --force/);
  assert.doesNotMatch(output(refused), /TEST_WS_CONNECT/);

  const forced = runCli(home, ["up", "--token", token, "--force"]);
  assert.equal(forced.status, 0, output(forced));
  assert.match(forced.stdout, /TEST_WS_CONNECT/);
});

test("new systemd units invoke the explicit up command", (t) => {
  if (process.platform !== "linux") return t.skip("systemd unit generation is Linux-only");
  const home = tempHome(t);
  const configDir = path.join(home, ".switchboard");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    agentToken: "test-agent-token",
    machineId: "test-machine-id",
  }));

  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  for (const name of ["systemctl", "loginctl"]) {
    const command = path.join(bin, name);
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(command, 0o755);
  }

  const result = runCli(home, ["service", "install"], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` },
  });
  assert.equal(result.status, 0, output(result));
  const unit = fs.readFileSync(path.join(
    home, ".config", "systemd", "user", "switchboard.service",
  ), "utf8");
  assert.match(unit, /^ExecStart=.* (?:"up"|up)$/m);
});

test("native supervisors and npm start invoke up explicitly", () => {
  const mac = fs.readFileSync(path.join(root, "macos", "Sources", "Switchboard", "DaemonSupervisor.swift"), "utf8");
  const windows = fs.readFileSync(path.join(root, "windows", "src", "DaemonSupervisor.cs"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "cli", "package.json"), "utf8"));
  assert.match(mac, /p\.arguments = \[rt\.cli\.path, "up"\]/);
  assert.match(mac, /p\.arguments = \[rt\.cli\.path, "up", "--token", oneOffToken\]/);
  assert.match(windows, /login \? " login" : " up"/);
  assert.equal(pkg.scripts.start, "node index.js up");
});

test("daemon child environments do not inherit supervisor identity", () => {
  const original = Object.fromEntries(supervisorKeys.map((key) => [key, `value-${key}`]));
  original.SWITCHBOARD_SERVER = "https://relay.example";
  const child = childEnvironment(original);
  for (const key of supervisorKeys) assert.equal(key in child, false, key);
  assert.equal(child.SWITCHBOARD_SERVER, original.SWITCHBOARD_SERVER);
});

test("SYSTEMD_EXEC_PID identifies only the directly executed unit process", () => {
  const streams = { stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } };
  assert.equal(supervisorLauncher({
    env: { INVOCATION_ID: "test", SYSTEMD_EXEC_PID: String(process.pid) },
    ...streams,
  }), "service");
  assert.equal(supervisorLauncher({
    env: { INVOCATION_ID: "test", SYSTEMD_EXEC_PID: String(process.pid + 1) },
    ...streams,
  }), null);
  assert.equal(supervisorLauncher({
    env: { INVOCATION_ID: "test", SYSTEMD_EXEC_PID: String(process.pid) },
    ...streams,
    stdin: { isTTY: true },
  }), "service");
});
