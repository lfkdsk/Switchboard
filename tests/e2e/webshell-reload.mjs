import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { stopPtyHolders } = require(path.join(root, "cli/lib/pty-holder.js"));
const token = "webshell-e2e-" + crypto.randomUUID();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-webshell-e2e-"));
const logs = new Map();
let relay;
let daemon;
let browser;
let cleaning = null;

function capture(child, name) {
  const output = [];
  logs.set(name, output);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      output.push(chunk);
      if (output.length > 200) output.shift();
    });
  }
  child.on("error", (error) => output.push(error.stack + "\n"));
  return child;
}

function start(name, command, args, options = {}) {
  return capture(spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...options,
  }), name);
}

async function freePort() {
  while (true) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    if (port < 8700 || port > 8799) return port;
  }
}

async function waitForHttp(url, child, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`relay exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`relay did not become ready: ${lastError?.message || "timeout"}`);
}

function browserExecutable() {
  const executable = "/usr/bin/google-chrome";
  if (!isExecutable(executable)) {
    throw new Error(`Chrome not found or not executable: ${executable}`);
  }
  return executable;
}

function walkExecutables(directory) {
  if (!fs.existsSync(directory)) return [];
  const matches = [];
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !["chrome-headless-shell", "chrome"].includes(entry.name)) continue;
    matches.push(path.join(entry.parentPath, entry.name));
  }
  return matches;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function instrument(page) {
  // Keep the production page free of test hooks. This wraps xterm's constructor
  // before the CDN script assigns it, exposing each real Terminal to this test.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "Terminal", {
      configurable: true,
      set(Constructor) {
        function InstrumentedTerminal(...args) {
          const terminal = new Constructor(...args);
          (globalThis.__switchboardE2eTerminals ||= []).push(terminal);
          return terminal;
        }
        Object.setPrototypeOf(InstrumentedTerminal, Constructor);
        InstrumentedTerminal.prototype = Constructor.prototype;
        Object.defineProperty(globalThis, "Terminal", {
          configurable: true,
          writable: true,
          value: InstrumentedTerminal,
        });
      },
    });
  });
}

async function terminalText(page) {
  return page.evaluate(() => {
    const terminal = globalThis.__switchboardE2eTerminals?.at(-1);
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let index = 0; index < buffer.length; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true) || "");
    }
    return lines.join("\n");
  });
}

async function waitForTerminal(page, predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    try {
      text = await terminalText(page);
      if (predicate(text)) return text;
    } catch {}
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}\nTerminal tail:\n${text.slice(-2000)}`);
}

async function waitForConnection(page, timeout = 30000) {
  await page.waitForFunction(
    () => document.querySelector("#connText")?.textContent === "connected",
    null,
    { timeout },
  );
}

async function sendCommand(page, command) {
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}

async function terminate(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
  if (await exitedWithin(child, 3000)) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {}
  await exitedWithin(child, 3000);
}

async function exitedWithin(child, timeout) {
  if (child.exitCode != null || child.signalCode != null) return true;
  return Promise.race([
    once(child, "exit").then(() => true),
    delay(timeout).then(() => false),
  ]);
}

// The daemon is the only record of which shells exist; nothing may survive in
// the page's storage, and a reload must never spawn an extra shell.
async function assertDaemonOwnedTabs(page, label) {
  const stored = await page.evaluate(() => localStorage.length + sessionStorage.length);
  assert.equal(stored, 0, `${label}: browser storage should stay empty`);
  assert.equal(await page.locator("#tabbar .tab").count(), 1, `${label}: exactly one shell tab`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    try { await browser?.close(); } catch {}
    await terminate(daemon);
    try {
      await stopPtyHolders({
        rootDir: path.join(home, ".switchboard", "sessions"),
        timeout: 2000,
      });
    } catch {}
    await terminate(relay);
    fs.rmSync(home, { recursive: true, force: true });
  })();
  return cleaning;
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

let failure;
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  relay = start("relay", process.execPath, [
    require.resolve("wrangler"), "dev", "--ip", "127.0.0.1", "--port", String(port),
  ]);
  await waitForHttp(`${origin}/healthz`, relay);

  daemon = start("daemon", process.execPath, [
    path.join(root, "cli/index.js"),
    "--server", origin,
    "--token", token,
    "--force",
  ], {
    cwd: path.join(root, "cli"),
    env: {
      ...process.env,
      HOME: home,
      SWITCHBOARD_RECORD: "1",
      SWITCHBOARD_SESSION_GRACE: "24h",
      SWITCHBOARD_SHELL: process.env.SWITCHBOARD_E2E_SHELL || "/bin/bash",
    },
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  let page = await context.newPage();
  await instrument(page);
  await page.goto(`${origin}/?token=${encodeURIComponent(token)}`);
  await waitForConnection(page);

  await sendCommand(page, "echo PID=$$; echo HISTORY_EARLY_SEQUENCE_000001; sleep 1; seq 1 20000");
  const pidText = await waitForTerminal(page, (text) => /PID=\d+/.test(text), "initial PID");
  const pid = pidText.match(/PID=(\d+)/)?.[1];
  assert.ok(pid, "initial PID was not printed");
  await waitForTerminal(
    page,
    (text) => text.split("\n").some((line) => line.trim() === "20000"),
    "20,000 output lines",
    60000,
  );

  await page.click("#btnHistory");
  await page.waitForFunction(
    () => /lines/.test(document.querySelector("#historyStatus")?.textContent || ""),
    null,
    { timeout: 30000 },
  );
  await page.fill("#historySearch", "HISTORY_EARLY_SEQUENCE_000001");
  await page.waitForFunction(
    () => /[1-9]\d* matches/.test(document.querySelector("#historyStatus")?.textContent || ""),
    null,
    { timeout: 15000 },
  );
  const historyMatch = await page.locator("#historyRows .history-line.current").textContent();
  assert.match(historyMatch || "", /HISTORY_EARLY_SEQUENCE_000001/);
  await page.click("#historyClose");

  await page.reload();
  await waitForConnection(page);
  const reloaded = await waitForTerminal(
    page,
    (text) => text.split("\n").some((line) => line.trim() === "12000") &&
      text.split("\n").some((line) => line.trim() === "20000"),
    "restored early and final scrollback lines",
  );
  assert.match(reloaded, /(?:^|\n)12000(?:\n|$)/);
  assert.match(reloaded, /(?:^|\n)20000(?:\n|$)/);
  await sendCommand(page, "echo RELOAD_PID=$$; echo RELOAD_INTERACTIVE_OK");
  const reloadInteractive = await waitForTerminal(
    page,
    (text) => text.includes("RELOAD_INTERACTIVE_OK") && /RELOAD_PID=\d+/.test(text),
    "interactive command after reload",
  );
  assert.equal(reloadInteractive.match(/RELOAD_PID=(\d+)/)?.[1], pid);
  await assertDaemonOwnedTabs(page, "after reload");

  // A brand-new browser profile stands in for another device: it has never
  // seen this shell, so only the daemon's session list can lead it back.
  const otherDevice = await browser.newContext();
  const otherPage = await otherDevice.newPage();
  await instrument(otherPage);
  await otherPage.goto(`${origin}/?token=${encodeURIComponent(token)}`);
  await waitForConnection(otherPage);
  await waitForTerminal(
    otherPage,
    (text) => text.split("\n").some((line) => line.trim() === "12000") &&
      text.split("\n").some((line) => line.trim() === "20000"),
    "scrollback in a fresh browser profile",
  );
  await sendCommand(otherPage, "echo DEVICE_PID=$$; echo OTHER_DEVICE_OK");
  const otherDeviceText = await waitForTerminal(
    otherPage,
    (text) => text.includes("OTHER_DEVICE_OK") && /DEVICE_PID=\d+/.test(text),
    "interactive command from a fresh browser profile",
  );
  assert.equal(otherDeviceText.match(/DEVICE_PID=(\d+)/)?.[1], pid);
  await assertDaemonOwnedTabs(otherPage, "fresh browser profile");
  await otherDevice.close();

  const secondPage = await context.newPage();
  await instrument(secondPage);
  await secondPage.goto(`${origin}/?token=${encodeURIComponent(token)}`);
  await waitForConnection(secondPage);
  await waitForTerminal(secondPage, (text) => text.includes("12000") && text.includes("20000"), "scrollback in second live tab");
  await sendCommand(secondPage, "echo MULTITAB_PID=$$; echo MULTITAB_SHARED_OK");
  const [firstTabText, secondTabText] = await Promise.all([
    waitForTerminal(page, (text) => text.includes("MULTITAB_SHARED_OK"), "shared output in first tab"),
    waitForTerminal(secondPage, (text) => text.includes("MULTITAB_SHARED_OK"), "shared output in second tab"),
  ]);
  assert.equal(firstTabText.match(/MULTITAB_PID=(\d+)/)?.[1], pid);
  assert.equal(secondTabText.match(/MULTITAB_PID=(\d+)/)?.[1], pid);
  assert.equal(firstTabText.split("\n").filter((line) => line.trim() === "MULTITAB_SHARED_OK").length, 1);
  assert.equal(secondTabText.split("\n").filter((line) => line.trim() === "MULTITAB_SHARED_OK").length, 1);
  await secondPage.close();
  await sendCommand(page, "echo MULTITAB_CLOSE_PID=$$; echo MULTITAB_CLOSE_OK");
  const afterSecondTabClose = await waitForTerminal(
    page,
    (text) => text.includes("MULTITAB_CLOSE_OK") && /MULTITAB_CLOSE_PID=\d+/.test(text),
    "first tab after closing second tab",
  );
  assert.equal(afterSecondTabClose.match(/MULTITAB_CLOSE_PID=(\d+)/)?.[1], pid);

  await terminate(daemon);
  await page.waitForFunction(
    () => /disconnected|offline/.test(document.querySelector("#connText")?.textContent || ""),
    null,
    { timeout: 15000 },
  );
  daemon = start("daemon-restarted", process.execPath, [
    path.join(root, "cli/index.js"),
    "--server", origin,
    "--token", token,
    "--force",
  ], {
    cwd: path.join(root, "cli"),
    env: {
      ...process.env,
      HOME: home,
      SWITCHBOARD_RECORD: "1",
      SWITCHBOARD_SESSION_GRACE: "24h",
      SWITCHBOARD_SHELL: process.env.SWITCHBOARD_E2E_SHELL || "/bin/bash",
    },
  });
  await waitForConnection(page);
  await sendCommand(page, "echo DAEMON_RESTART_PID=$$; echo DAEMON_RESTART_INTERACTIVE_OK");
  const daemonRestartInteractive = await waitForTerminal(
    page,
    (text) => text.includes("DAEMON_RESTART_INTERACTIVE_OK") && /DAEMON_RESTART_PID=\d+/.test(text),
    "in-page reattach after daemon restart",
  );
  assert.equal(daemonRestartInteractive.match(/DAEMON_RESTART_PID=(\d+)/)?.[1], pid);

  await page.reload();
  await waitForConnection(page);
  const daemonRestarted = await waitForTerminal(
    page,
    (text) => text.split("\n").some((line) => line.trim() === "12000") &&
      text.split("\n").some((line) => line.trim() === "20000"),
    "scrollback after daemon restart",
  );
  assert.match(daemonRestarted, /(?:^|\n)12000(?:\n|$)/);
  assert.match(daemonRestarted, /(?:^|\n)20000(?:\n|$)/);
  await sendCommand(page, "echo DAEMON_REFRESH_PID=$$; echo DAEMON_REFRESH_INTERACTIVE_OK");
  const daemonRefreshInteractive = await waitForTerminal(
    page,
    (text) => text.includes("DAEMON_REFRESH_INTERACTIVE_OK") && /DAEMON_REFRESH_PID=\d+/.test(text),
    "interactive command after daemon restart and page refresh",
  );
  assert.equal(daemonRefreshInteractive.match(/DAEMON_REFRESH_PID=(\d+)/)?.[1], pid);
  await assertDaemonOwnedTabs(page, "after daemon restart and refresh");

  await terminate(relay);
  await page.waitForFunction(
    () => /disconnected|offline/.test(document.querySelector("#connText")?.textContent || ""),
    null,
    { timeout: 15000 },
  );
  relay = start("relay-restarted", process.execPath, [
    require.resolve("wrangler"), "dev", "--ip", "127.0.0.1", "--port", String(port),
  ]);
  await waitForHttp(`${origin}/healthz`, relay);
  await waitForConnection(page, 30000);
  await sendCommand(page, "echo RECONNECT_PID=$$; echo RECONNECT_INTERACTIVE_OK");
  const reconnectInteractive = await waitForTerminal(
    page,
    (text) => text.includes("RECONNECT_INTERACTIVE_OK") && /RECONNECT_PID=\d+/.test(text),
    "interactive command after network reconnect",
  );
  assert.equal(reconnectInteractive.match(/RECONNECT_PID=(\d+)/)?.[1], pid);

  await page.close();
  page = await context.newPage();
  await instrument(page);
  await page.goto(`${origin}/?token=${encodeURIComponent(token)}`);
  await waitForConnection(page);
  await waitForTerminal(
    page,
    (text) => text.split("\n").some((line) => line.trim() === "12000") &&
      text.split("\n").some((line) => line.trim() === "20000"),
    "scrollback after closing and reopening the page",
  );
  await sendCommand(page, "echo REOPEN_PID=$$; echo REOPEN_INTERACTIVE_OK");
  const reopenInteractive = await waitForTerminal(
    page,
    (text) => text.includes("REOPEN_INTERACTIVE_OK") && /REOPEN_PID=\d+/.test(text),
    "interactive command after page reopen",
  );
  assert.equal(reopenInteractive.match(/REOPEN_PID=(\d+)/)?.[1], pid);
  await assertDaemonOwnedTabs(page, "after page reopen");

  console.log(`webshell reload E2E passed (relay port ${port})`);
  console.log(`same shell PID ${pid}: reload, fresh browser profile, daemon restart, network reconnect, and page reopen`);
  console.log("browser storage stayed empty and every restore showed exactly one shell tab");
  console.log("restored terminal buffer lines: 12000 and 20000");
  console.log(
    "interactive markers: RELOAD_INTERACTIVE_OK, OTHER_DEVICE_OK, DAEMON_RESTART_INTERACTIVE_OK, " +
    "DAEMON_REFRESH_INTERACTIVE_OK, " +
    "RECONNECT_INTERACTIVE_OK, REOPEN_INTERACTIVE_OK",
  );
} catch (error) {
  failure = error;
  console.error(error.stack || error);
  for (const [name, chunks] of logs) {
    console.error(`\n--- ${name} output ---\n${chunks.join("").slice(-10000)}`);
  }
} finally {
  await cleanup();
  console.log("E2E cleanup complete: browser, daemon, and relay stopped");
}

if (failure) process.exitCode = 1;
