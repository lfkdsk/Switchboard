import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { signSession } from "../../src/auth.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootRequire = createRequire(import.meta.url);
const cliRequire = createRequire(path.join(root, "cli", "index.js"));
const WebSocket = cliRequire("ws");
const { JobStore } = cliRequire("./lib/job-store.js");
const { stopPtyHolders } = cliRequire("./lib/pty-holder.js");
const { SessionLogStore } = cliRequire("./lib/session-log.js");
const wrangler = rootRequire.resolve("wrangler");

const runId = crypto.randomUUID();
const machineId = `visibility-${runId}`;
const legacyMachineId = `legacy-${runId}`;
const owner = { id: `owner-${runId}`, login: "visibility-owner" };
const visitor = { id: `visitor-${runId}`, login: "visibility-visitor" };
const offlineVisitor = { id: `offline-${runId}`, login: "visibility-offline" };
const expiringVisitor = { id: `expiring-${runId}`, login: "visibility-expiring" };
const agentToken = `agent-${crypto.randomBytes(32).toString("base64url")}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-account-visibility-"));
const home = path.join(tempRoot, "home");
const persistence = path.join(tempRoot, "wrangler-state");
const logs = new Map();
const sockets = new Set();
let relay;
let daemon;
let legacyDaemon;
let browser;
let cleaning = null;

function capture(child, name) {
  const output = [];
  logs.set(name, output);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      output.push(chunk);
      if (output.length > 300) output.shift();
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

async function run(name, command, args, options = {}) {
  const child = start(name, command, args, options);
  const [code, signal] = await once(child, "exit");
  const output = (logs.get(name) || []).join("");
  if (code !== 0) {
    throw new Error(`${name} failed (${signal || code})\n${output.slice(-10000)}`);
  }
  return output;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitUntil(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForHttp(url, child, timeout = 30000) {
  await waitUntil(async () => {
    if (child.exitCode != null) throw new Error(`relay exited with ${child.exitCode}`);
    try { return (await fetch(url)).ok; } catch { return false; }
  }, `relay at ${url}`, timeout);
}

function sql(value) {
  if (value == null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function seedDatabase() {
  fs.mkdirSync(persistence, { recursive: true });
  await run("d1-schema", process.execPath, [
    wrangler, "d1", "execute", "switchboard_db", "--local", "--persist-to", persistence,
    "--file", path.join(root, "schema.sql"), "--yes",
  ]);
  const now = Date.now();
  const statements = [
    `INSERT INTO agent_tokens (token_hash, account_id, account_login, created_at) VALUES (${sql(sha256(agentToken))}, ${sql(owner.id)}, ${sql(owner.login)}, ${now})`,
    `INSERT INTO machines (machine_id, account_id, account_login, name, online, created_at, last_seen, peer) VALUES (${sql(machineId)}, ${sql(owner.id)}, ${sql(owner.login)}, 'visibility-host', 0, ${now}, ${now}, 1)`,
    `INSERT INTO machines (machine_id, account_id, account_login, name, online, created_at, last_seen, peer) VALUES (${sql(legacyMachineId)}, ${sql(owner.id)}, ${sql(owner.login)}, 'legacy-host', 0, ${now}, ${now}, 1)`,
    `INSERT INTO machine_grants (machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login, created_at, expires_at, revoked_at) VALUES (${sql(machineId)}, ${sql(visitor.id)}, ${sql(visitor.login)}, ${sql(owner.id)}, ${sql(owner.login)}, ${now}, NULL, NULL)`,
    `INSERT INTO machine_grants (machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login, created_at, expires_at, revoked_at) VALUES (${sql(machineId)}, ${sql(offlineVisitor.id)}, ${sql(offlineVisitor.login)}, ${sql(owner.id)}, ${sql(owner.login)}, ${now + 1}, NULL, NULL)`,
    `INSERT INTO machine_grants (machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login, created_at, expires_at, revoked_at) VALUES (${sql(legacyMachineId)}, ${sql(visitor.id)}, ${sql(visitor.login)}, ${sql(owner.id)}, ${sql(owner.login)}, ${now}, NULL, NULL)`,
  ];
  await run("d1-seed", process.execPath, [
    wrangler, "d1", "execute", "switchboard_db", "--local", "--persist-to", persistence,
    "--command", statements.join(";"), "--yes",
  ]);
}

async function createLegacyRecord() {
  const store = new SessionLogStore({
    dir: path.join(home, ".switchboard", "sessions"),
    scope: machineId,
  }).init();
  const handle = store.open("legacy-unowned", { sid: "legacy-unowned", cols: 80, rows: 24 });
  handle.append("LEGACY_OWNER_ONLY_RECORD\r\n");
  await handle.close({ exitCode: 0 });
}

async function createLegacyJobRecord() {
  const store = new JobStore({
    dir: path.join(home, ".switchboard", "jobs", machineId),
  }).init();
  store.create({
    id: "legacy-job-0001",
    command: "printf LEGACY_OWNER_ONLY_JOB",
    cwd: home,
    shell: "/bin/sh",
    login: false,
  });
  store.append("legacy-job-0001", "LEGACY_OWNER_ONLY_JOB\n");
  await store.finish("legacy-job-0001", { exitCode: 0 });
}

function cookieHeader(token) { return `sb_session=${encodeURIComponent(token)}`; }

class BrowserSocket {
  constructor(label, url, cookie) {
    this.label = label;
    this.url = url;
    this.cookie = cookie;
    this.json = [];
    this.binary = [];
    this.output = new Map();
    this.closed = null;
    this.ws = null;
  }

  async connect() {
    const ws = new WebSocket(this.url, { headers: { Cookie: cookieHeader(this.cookie) } });
    this.ws = ws;
    sockets.add(ws);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try { this.json.push(JSON.parse(data.toString("utf8"))); } catch {}
        return;
      }
      const frame = Buffer.from(data);
      const sidLength = frame[0];
      if (!sidLength || frame.length < 1 + sidLength) return;
      const sid = frame.toString("utf8", 1, 1 + sidLength);
      const payload = frame.subarray(1 + sidLength);
      this.binary.push({ sid, payload });
      const previous = this.output.get(sid) || Buffer.alloc(0);
      this.output.set(sid, Buffer.concat([previous, payload]).subarray(-1024 * 1024));
    });
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString("utf8") };
      sockets.delete(ws);
    });
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const onUnexpected = (_request, response) => {
        cleanup();
        response.resume();
        reject(new Error(`${this.label} handshake returned HTTP ${response.statusCode}`));
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("unexpected-response", onUnexpected);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("unexpected-response", onUnexpected);
    });
    return this;
  }

  sendJson(message) { this.ws.send(JSON.stringify(message)); }

  sendInput(sid, value) {
    const sidBytes = Buffer.from(sid, "utf8");
    assert.ok(sidBytes.length > 0 && sidBytes.length < 256, "valid browser session id");
    this.ws.send(Buffer.concat([Buffer.from([sidBytes.length]), sidBytes, Buffer.from(value)]));
  }

  outputText(sid) { return (this.output.get(sid) || Buffer.alloc(0)).toString("utf8"); }

  allOutputText() {
    return [...this.output.values()].map((value) => value.toString("utf8")).join("\n");
  }

  async waitJson(predicate, description, after = 0, timeout = 30000) {
    return waitUntil(() => this.json.slice(after).find(predicate), `${this.label}: ${description}`, timeout);
  }

  async request(message, timeout = 30000) {
    const id = `request-${crypto.randomUUID()}`;
    const after = this.json.length;
    this.sendJson({ ...message, id });
    return this.waitJson((item) => item.id === id, `${message.type} response`, after, timeout);
  }

  async sessions(predicate = () => true, description = "session list", timeout = 30000) {
    const after = this.json.length;
    this.sendJson({ type: "list-sessions" });
    return this.waitJson(
      (item) => item.type === "sessions" && predicate(item.list || []),
      description,
      after,
      timeout,
    );
  }

  close() {
    try { this.ws?.close(); } catch {}
  }

  async disconnect(closeEchoMs = 250) {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return true;
    const closed = once(ws, "close").then(() => true, () => false);
    try { ws.close(); } catch {}
    const echoed = await Promise.race([closed, delay(closeEchoMs).then(() => false)]);
    if (!echoed && ws.readyState !== WebSocket.CLOSED) {
      // Workerd can accept the peer FIN without echoing a WebSocket close frame,
      // leaving ws in CLOSING indefinitely. The transport teardown is local test
      // cleanup; the server-side expiry/PTY/history assertions below remain the gate.
      try { ws.terminate(); } catch {}
      sockets.delete(ws);
    }
    return echoed;
  }
}

async function connectLegacyDaemon(url) {
  const ws = new WebSocket(url, { headers: { "x-switchboard-agent": agentToken } });
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  await once(ws, "open");
  return ws;
}

async function rejectedWebSocket(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: cookieHeader(cookie) } });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("legacy grant handshake timed out")), 15000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    ws.once("open", () => finish(new Error("legacy daemon grant unexpectedly connected")));
    ws.once("unexpected-response", (_request, response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => finish(null, {
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.resume();
    });
    ws.on("error", (error) => { if (!settled) finish(error); });
  });
}

async function api(origin, cookie, pathname, body) {
  const response = await fetch(origin + pathname, {
    method: "POST",
    headers: { Cookie: cookieHeader(cookie), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let value = null;
  try { value = await response.json(); } catch {}
  return { response, value };
}

function browserExecutable() {
  const executable = "/usr/bin/google-chrome";
  fs.accessSync(executable, fs.constants.X_OK);
  return executable;
}

function startDaemon(name, origin) {
  return start(name, process.execPath, [
    path.join(root, "cli", "index.js"), "--server", origin, "--force",
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
}

async function terminate(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
  if (await Promise.race([once(child, "exit").then(() => true), delay(3000).then(() => false)])) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    try { await browser?.close(); } catch {}
    for (const socket of sockets) try { socket.close(); } catch {}
    await terminate(daemon);
    try {
      await stopPtyHolders({
        rootDir: path.join(home, ".switchboard", "sessions"),
        timeout: 2000,
      });
    } catch {}
    await terminate(relay);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  })();
  return cleaning;
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
}

let failure;
try {
  fs.mkdirSync(path.join(home, ".switchboard"), { recursive: true });
  await seedDatabase();
  await createLegacyRecord();
  await createLegacyJobRecord();

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const wsOrigin = `ws://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(home, ".switchboard", "config.json"), JSON.stringify({
    server: origin,
    agentToken,
    login: owner.login,
    machineId,
  }, null, 2) + "\n", { mode: 0o600 });

  relay = start("relay", process.execPath, [
    wrangler, "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistence,
  ]);
  await waitForHttp(`${origin}/healthz`, relay);

  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const [ownerCookie, visitorCookie, offlineCookie, expiringCookie] = await Promise.all([
    signSession({ ...owner, exp: expiry }, "dev-secret"),
    signSession({ ...visitor, exp: expiry }, "dev-secret"),
    signSession({ ...offlineVisitor, exp: expiry }, "dev-secret"),
    signSession({ ...expiringVisitor, exp: expiry }, "dev-secret"),
  ]);

  const legacyBrowserUrl = `${wsOrigin}/ws?role=browser&machine=${encodeURIComponent(legacyMachineId)}`;
  const waitingLegacyClient = await new BrowserSocket(
    "waiting legacy visitor", legacyBrowserUrl, visitorCookie,
  ).connect();
  legacyDaemon = await connectLegacyDaemon(
    `${wsOrigin}/ws?role=daemon&machine=${encodeURIComponent(legacyMachineId)}`,
  );
  await waitingLegacyClient.waitJson(
    (message) => message.type === "_relay" && message.event === "daemon-upgrade-required",
    "legacy daemon upgrade event",
  );
  await waitUntil(() => waitingLegacyClient.closed?.code === 4004, "waiting legacy visitor rejected");
  const legacyRejection = await rejectedWebSocket(
    legacyBrowserUrl,
    visitorCookie,
  );
  assert.equal(legacyRejection.status, 426);
  assert.match(legacyRejection.body, /older Switchboard daemon/i);

  daemon = startDaemon("daemon-initial", origin);

  const browserUrl = `${wsOrigin}/ws?role=browser&machine=${encodeURIComponent(machineId)}`;
  const ownerClient = await new BrowserSocket("owner", browserUrl, ownerCookie).connect();
  const visitorClient = await new BrowserSocket("visitor", browserUrl, visitorCookie).connect();
  const visitorObserver = await new BrowserSocket("visitor observer", browserUrl, visitorCookie).connect();
  await ownerClient.waitJson(
    (message) => message.type === "_relay" && message.event === "daemon-online",
    "daemon online",
  );
  await visitorClient.waitJson(
    (message) => message.type === "_relay" && message.event === "access-context" && message.accessVia === "grant",
    "grant access context",
  );

  const ownerJobSecret = `F1_OWNER_JOB_SECRET_${runId}`;
  const ownerJobCwd = path.join(home, `owner-job-cwd-${runId}`);
  fs.mkdirSync(ownerJobCwd, { recursive: true });
  const ownerJobStarted = await ownerClient.request({
    type: "exec",
    cmd: `printf '${ownerJobSecret}\\n'; sleep 120`,
    detach: true,
    login: false,
    cwd: ownerJobCwd,
    // All of these are browser-controlled lies. Only the relay envelope may own the job.
    accountId: visitor.id,
    ownerAccountId: visitor.id,
    principal: { accountId: visitor.id, accessVia: "grant", clientId: "forged" },
  });
  assert.equal(ownerJobStarted.type, "exec-job");
  const ownerJobId = ownerJobStarted.job;

  const visitorJobMarker = `VISITOR_JOB_OUTPUT_${runId}`;
  const visitorJobStarted = await visitorClient.request({
    type: "exec",
    cmd: `printf '${visitorJobMarker}\\n'; sleep 120`,
    detach: true,
    login: false,
    accountId: owner.id,
    ownerAccountId: owner.id,
    principal: { accountId: owner.id, accessVia: "owner", clientId: "forged" },
  });
  assert.equal(visitorJobStarted.type, "exec-job");
  const visitorJobId = visitorJobStarted.job;

  await waitUntil(async () => {
    const chunk = await ownerClient.request({ type: "job-read", job: ownerJobId, offset: 0 });
    return chunk.type === "job-chunk" &&
      Buffer.from(chunk.data, "base64").toString("utf8").includes(ownerJobSecret) && chunk;
  }, "owner detached job output", 15000);
  await waitUntil(async () => {
    const chunk = await visitorClient.request({ type: "job-read", job: visitorJobId, offset: 0 });
    return chunk.type === "job-chunk" &&
      Buffer.from(chunk.data, "base64").toString("utf8").includes(visitorJobMarker) && chunk;
  }, "visitor detached job output", 15000);

  const forgedVisitorJobs = await visitorClient.request({
    type: "job-list",
    accountId: owner.id,
    ownerAccountId: owner.id,
    principal: { accountId: owner.id, accessVia: "owner", clientId: "forged" },
  });
  assert.equal(forgedVisitorJobs.type, "job-list");
  assert.ok(forgedVisitorJobs.jobs.some(
    (job) => job.id === visitorJobId && job.ownerAccountId === visitor.id,
  ));
  assert.ok(!forgedVisitorJobs.jobs.some((job) => job.id === ownerJobId));
  assert.ok(!forgedVisitorJobs.jobs.some((job) => job.id === "legacy-job-0001"));
  assert.doesNotMatch(JSON.stringify(forgedVisitorJobs), new RegExp(ownerJobSecret));
  assert.doesNotMatch(
    JSON.stringify(forgedVisitorJobs),
    new RegExp(ownerJobCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  for (const type of ["job-read", "job-get"]) {
    const denied = await visitorClient.request({
      type,
      job: ownerJobId,
      offset: 0,
      accountId: owner.id,
      ownerAccountId: owner.id,
    });
    assert.equal(denied.type, "job-error");
    assert.match(denied.message, /no such accessible job/);
    assert.equal("record" in denied, false);
    assert.equal("data" in denied, false);
  }

  visitorClient.sendJson({
    type: "exec-kill",
    id: ownerJobId,
    signal: "SIGTERM",
    accountId: owner.id,
    ownerAccountId: owner.id,
  });
  await delay(400);
  const ownerJobAfterDeniedKill = await ownerClient.request({ type: "job-get", job: ownerJobId });
  assert.equal(ownerJobAfterDeniedKill.type, "job-status");
  assert.equal(ownerJobAfterDeniedKill.record.status, "running");

  const sameAccountJobs = await visitorObserver.request({ type: "job-list" });
  assert.ok(sameAccountJobs.jobs.some((job) => job.id === visitorJobId));
  assert.ok(!sameAccountJobs.jobs.some((job) => job.id === ownerJobId));
  const sameAccountRead = await visitorObserver.request({
    type: "job-read", job: visitorJobId, offset: 0,
  });
  assert.equal(sameAccountRead.type, "job-chunk");
  assert.match(Buffer.from(sameAccountRead.data, "base64").toString("utf8"), new RegExp(visitorJobMarker));

  const ownerJobs = await ownerClient.request({ type: "job-list" });
  assert.ok(ownerJobs.jobs.some(
    (job) => job.id === ownerJobId && job.ownerAccountId === owner.id &&
      job.command.includes(ownerJobSecret) && job.cwd === ownerJobCwd,
  ));
  assert.ok(ownerJobs.jobs.some(
    (job) => job.id === visitorJobId && job.ownerAccountId === visitor.id,
  ));
  assert.ok(ownerJobs.jobs.some(
    (job) => job.id === "legacy-job-0001" && job.ownerAccountId === owner.id && job.legacy === true,
  ));
  const supervisedJobRead = await ownerClient.request({
    type: "job-read", job: visitorJobId, offset: 0,
  });
  assert.equal(supervisedJobRead.type, "job-chunk");
  assert.match(Buffer.from(supervisedJobRead.data, "base64").toString("utf8"), new RegExp(visitorJobMarker));

  ownerClient.sendJson({ type: "exec-kill", id: visitorJobId, signal: "SIGTERM" });
  await waitUntil(async () => {
    const status = await ownerClient.request({ type: "job-get", job: visitorJobId });
    return status.type === "job-status" && status.record.status !== "running" && status;
  }, "machine owner terminates visitor detached job", 15000);
  ownerClient.sendJson({ type: "exec-kill", id: ownerJobId, signal: "SIGTERM" });
  await waitUntil(async () => {
    const status = await ownerClient.request({ type: "job-get", job: ownerJobId });
    return status.type === "job-status" && status.record.status !== "running" && status;
  }, "owner terminates own detached job", 15000);

  const ownerSid = "owner-shell";
  const visitorSid = "visitor-shell";
  ownerClient.sendJson({ type: "open", sid: ownerSid, cols: 80, rows: 24, snapshot: true });
  await ownerClient.sessions(
    (list) => list.some((session) => session.sid === ownerSid && session.mine === true),
    "owner shell in owner list",
  );
  await visitorClient.sessions(
    (list) => !list.some((session) => session.sessionSid === ownerSid || session.sid === ownerSid),
    "owner shell absent from visitor list",
  );

  const ownerMarker = `OWNER_OUTPUT_ONLY_${runId}`;
  ownerClient.sendInput(ownerSid, `printf '${ownerMarker}\\n'\n`);
  await waitUntil(() => ownerClient.outputText(ownerSid).includes(ownerMarker), "owner shell output");
  await delay(500);
  assert.doesNotMatch(visitorClient.allOutputText(), new RegExp(ownerMarker));
  assert.doesNotMatch(visitorObserver.allOutputText(), new RegExp(ownerMarker));

  // The inner identity is deliberately forged. The relay envelope must still
  // make this a visitor-owned shell.
  visitorClient.sendJson({
    type: "open",
    sid: visitorSid,
    cols: 80,
    rows: 24,
    snapshot: true,
    accountId: owner.id,
    accessVia: "owner",
    principal: { accountId: owner.id, accessVia: "owner", clientId: "forged" },
    relayClientId: "forged",
  });
  const visitorList = await visitorClient.sessions(
    (list) => list.some((session) => session.sid === visitorSid && session.mine === true),
    "visitor shell in visitor list",
  );
  assert.ok(!visitorList.list.some((session) => session.sessionSid === ownerSid || session.sid === ownerSid));
  const ownerSupervision = await ownerClient.sessions(
    (list) => list.some((session) => session.sessionSid === visitorSid && session.mine === false),
    "visitor shell in owner supervisory list",
  );
  const supervisedVisitor = ownerSupervision.list.find(
    (session) => session.sessionSid === visitorSid && session.mine === false,
  );
  assert.equal(supervisedVisitor.ownerAccountId, visitor.id);
  assert.match(supervisedVisitor.sid, /^supervised-/);

  const visitorMarker = `VISITOR_OUTPUT_${runId}`;
  visitorClient.sendInput(visitorSid, `printf '${visitorMarker}\\n'\n`);
  await waitUntil(() => visitorClient.outputText(visitorSid).includes(visitorMarker), "visitor output");
  await waitUntil(
    () => ownerClient.outputText(supervisedVisitor.sid).includes(visitorMarker),
    "owner supervisory visitor output",
  );

  const ownerInputMarker = `OWNER_INPUT_MUST_NOT_DRIVE_VISITOR_${runId}`;
  ownerClient.sendInput(supervisedVisitor.sid, `printf '${ownerInputMarker}\\n'\n`);
  await delay(750);
  assert.doesNotMatch(visitorClient.outputText(visitorSid), new RegExp(ownerInputMarker));
  assert.doesNotMatch(ownerClient.outputText(supervisedVisitor.sid), new RegExp(ownerInputMarker));

  const breachMarker = `VISITOR_INPUT_BREACH_${runId}`;
  visitorClient.sendInput(ownerSid, `printf '${breachMarker}\\n'\n`);
  await delay(750);
  assert.doesNotMatch(ownerClient.outputText(ownerSid), new RegExp(breachMarker));
  const stillInteractive = `OWNER_STILL_INTERACTIVE_${runId}`;
  ownerClient.sendInput(ownerSid, `printf '${stillInteractive}\\n'\n`);
  await waitUntil(
    () => ownerClient.outputText(ownerSid).includes(stillInteractive),
    "owner shell remains interactive after rejected visitor input",
  );

  const [ownerStats, visitorStats] = await Promise.all([
    ownerClient.waitJson(
      (message) => message.type === "stats" &&
        message.act?.shells?.some((shell) => shell.sid === ownerSid) &&
        message.act.shells.some((shell) => shell.sid === supervisedVisitor.sid),
      "owner activity contains owner and visitor shells",
      0,
      15000,
    ),
    visitorClient.waitJson(
      (message) => message.type === "stats" &&
        message.act?.shells?.some((shell) => shell.sid === visitorSid),
      "visitor activity contains visitor shell",
      0,
      15000,
    ),
  ]);
  assert.ok(ownerStats.act.shells.some((shell) => shell.sid === ownerSid));
  assert.ok(ownerStats.act.shells.some((shell) => shell.sid === supervisedVisitor.sid));
  assert.ok(!visitorStats.act.shells.some((shell) => shell.sid === ownerSid));
  assert.deepEqual(visitorStats.act.top, []);
  assert.equal("agents" in visitorStats.act, false);

  const execId = `exec-${runId}`;
  const ownerJsonBeforeExec = ownerClient.json.length;
  const observerJsonBeforeExec = visitorObserver.json.length;
  visitorClient.sendJson({
    type: "exec",
    id: execId,
    cmd: `printf ADJACENT_REQUEST_${runId}`,
    login: false,
  });
  const execOutput = await visitorClient.waitJson(
    (message) => message.type === "exec-out" && message.id === execId,
    "adjacent exec output",
  );
  assert.equal(Buffer.from(execOutput.data, "base64").toString("utf8"), `ADJACENT_REQUEST_${runId}`);
  await visitorClient.waitJson(
    (message) => message.type === "exec-exit" && message.id === execId && message.code === 0,
    "adjacent exec exit",
  );
  await delay(300);
  assert.ok(!ownerClient.json.slice(ownerJsonBeforeExec).some((message) => message.id === execId));
  assert.ok(!visitorObserver.json.slice(observerJsonBeforeExec).some((message) => message.id === execId));

  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ["--no-sandbox"],
  });
  const visitorContext = await browser.newContext();
  await visitorContext.addCookies([{ name: "sb_session", value: visitorCookie, url: origin }]);
  const visitorPage = await visitorContext.newPage();
  await visitorPage.goto(`${origin}/?machine=${encodeURIComponent(machineId)}`);
  await visitorPage.waitForFunction(() => document.querySelector("#connText")?.textContent === "connected");
  await visitorPage.waitForFunction(() => !document.querySelector("#accessNotice")?.hidden);
  assert.match(await visitorPage.locator("#accessNotice").textContent(), /owner can observe.*history.*close/i);
  const legacyPage = await visitorContext.newPage();
  await legacyPage.goto(`${origin}/?machine=${encodeURIComponent(legacyMachineId)}`);
  await legacyPage.waitForFunction(() => /ask the owner to upgrade/i.test(
    document.querySelector("#connText")?.textContent || "",
  ));

  const ownerContext = await browser.newContext();
  await ownerContext.addCookies([{ name: "sb_session", value: ownerCookie, url: origin }]);
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`${origin}/?machine=${encodeURIComponent(machineId)}`);
  await ownerPage.waitForFunction(() => document.querySelector("#connText")?.textContent === "connected");
  await ownerPage.waitForFunction(() => [...document.querySelectorAll("#tabbar .tab")]
    .some((tab) => /^visitor ·/.test(tab.textContent || "")));
  assert.ok((await ownerPage.locator("#tabbar .tab").allTextContents()).some((text) => /^visitor ·/.test(text)));
  assert.ok((await ownerPage.locator("#tabbar .tab").evaluateAll((tabs) => tabs.map((tab) => tab.title)))
    .some((title) => /^Read-only visitor /.test(title)));
  await ownerContext.close();
  await visitorContext.close();

  const ownerHistory = await ownerClient.request({ type: "sess-list" });
  const visitorHistory = await visitorClient.request({ type: "sess-list" });
  assert.ok(ownerHistory.sessions.some((session) => session.sessionSid === "legacy-unowned" && session.legacy));
  assert.ok(ownerHistory.sessions.some((session) => session.sessionSid === ownerSid));
  assert.ok(ownerHistory.sessions.some((session) => session.sessionSid === visitorSid));
  assert.ok(visitorHistory.sessions.some((session) => session.sessionSid === visitorSid));
  assert.ok(!visitorHistory.sessions.some((session) => session.sessionSid === ownerSid));
  assert.ok(!visitorHistory.sessions.some((session) => session.sessionSid === "legacy-unowned"));
  assert.ok(ownerHistory.sessions.every((session) => !("storageId" in session)));

  const legacyChunk = await ownerClient.request({
    type: "sess-read", sid: "legacy-unowned", from: 0, len: 4096,
  });
  assert.equal(legacyChunk.type, "sess-chunk");
  assert.match(Buffer.from(legacyChunk.data, "base64").toString("utf8"), /LEGACY_OWNER_ONLY_RECORD/);
  const deniedLegacy = await visitorClient.request({
    type: "sess-read", sid: "legacy-unowned", from: 0, len: 4096,
  });
  assert.equal(deniedLegacy.type, "sess-error");
  assert.match(deniedLegacy.message, /no accessible session/);

  ownerClient.sendJson({ type: "close", sid: supervisedVisitor.sid });
  await visitorClient.waitJson(
    (message) => message.type === "exit" && message.sid === visitorSid,
    "owner closes visitor PTY",
  );
  await ownerClient.sessions(
    (list) => !list.some((session) => session.sessionSid === visitorSid),
    "visitor shell removed after owner close",
  );

  // Leave a non-expiring visitor PTY in its detached holder, stop the daemon,
  // and revoke while no daemon can receive the live event. The reconnect D1
  // snapshot must still classify and terminate that recovered PTY.
  const offlineClient = await new BrowserSocket(
    "offline-revoke visitor", browserUrl, offlineCookie,
  ).connect();
  const offlineSid = "visitor-offline-revoke-shell";
  offlineClient.sendJson({ type: "open", sid: offlineSid, cols: 80, rows: 24, snapshot: true });
  const offlineSupervision = await ownerClient.sessions(
    (list) => list.some((session) => session.sessionSid === offlineSid && session.mine === false),
    "offline-revoke shell visible to owner",
  );
  const offlineWireSid = offlineSupervision.list.find(
    (session) => session.sessionSid === offlineSid,
  ).sid;

  const ownerBeforeOffline = ownerClient.json.length;
  await terminate(daemon);
  await ownerClient.waitJson(
    (message) => message.type === "_relay" && message.event === "daemon-offline",
    "daemon offline before missed revoke",
    ownerBeforeOffline,
  );
  const offlineRevoked = await api(origin, ownerCookie, "/api/machines/revoke", {
    machine_id: machineId,
    grantee_id: offlineVisitor.id,
  });
  assert.equal(offlineRevoked.response.status, 200);
  assert.equal(offlineRevoked.value.ok, true);
  assert.ok(offlineRevoked.value.disconnected >= 1);
  await offlineClient.waitJson(
    (message) => message.type === "_relay" && message.event === "access-revoked",
    "offline revoke notification",
  );
  await waitUntil(() => offlineClient.closed?.code === 4003, "offline-revoked visitor socket close");

  const ownerBeforeRestart = ownerClient.json.length;
  daemon = startDaemon("daemon-restarted", origin);
  await ownerClient.waitJson(
    (message) => message.type === "_relay" && message.event === "daemon-online",
    "daemon online after missed revoke",
    ownerBeforeRestart,
  );
  await ownerClient.sessions(
    (list) => list.some((session) => session.sid === ownerSid && session.mine === true) &&
      !list.some((session) => session.sessionSid === offlineSid),
    "reconnect snapshot removes offline-revoked PTY but retains owner PTY",
  );
  await waitUntil(async () => {
    const history = await ownerClient.request({ type: "sess-list" });
    const record = history.sessions.find((session) => session.sid === offlineWireSid);
    return record && record.active === false && record.closedAt;
  }, "offline-revoked visitor PTY history closes", 15000);

  const ownerJobsAfterRestart = await ownerClient.request({ type: "job-list" });
  const visitorJobsAfterRestart = await visitorClient.request({ type: "job-list" });
  assert.ok(ownerJobsAfterRestart.jobs.some((job) => job.id === ownerJobId));
  assert.ok(ownerJobsAfterRestart.jobs.some((job) => job.id === visitorJobId));
  assert.ok(visitorJobsAfterRestart.jobs.some((job) => job.id === visitorJobId));
  assert.ok(!visitorJobsAfterRestart.jobs.some((job) => job.id === ownerJobId));
  const persistedVisitorJob = await visitorObserver.request({ type: "job-get", job: visitorJobId });
  assert.equal(persistedVisitorJob.type, "job-status");
  assert.equal(persistedVisitorJob.record.ownerAccountId, visitor.id);

  const revokeSid = "visitor-revoke-shell";
  visitorClient.sendJson({ type: "open", sid: revokeSid, cols: 80, rows: 24, snapshot: true });
  const revokeSupervision = await ownerClient.sessions(
    (list) => list.some((session) => session.sessionSid === revokeSid && session.mine === false),
    "revoke shell visible to owner",
  );
  const revokeWireSid = revokeSupervision.list.find((session) => session.sessionSid === revokeSid).sid;
  visitorObserver.close();
  const revoked = await api(origin, ownerCookie, "/api/machines/revoke", {
    machine_id: machineId,
    grantee_id: visitor.id,
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.value.ok, true);
  assert.ok(revoked.value.disconnected >= 1);
  await visitorClient.waitJson(
    (message) => message.type === "_relay" && message.event === "access-revoked",
    "access revoked notification",
  );
  await waitUntil(() => visitorClient.closed?.code === 4003, "revoked visitor socket close");
  await ownerClient.sessions(
    (list) => !list.some((session) => session.sessionSid === revokeSid),
    "revoked visitor PTY removed",
  );
  await waitUntil(async () => {
    const history = await ownerClient.request({ type: "sess-list" });
    const record = history.sessions.find((session) => session.sid === revokeWireSid);
    return record && record.active === false && record.closedAt;
  }, "revoked visitor PTY history closes", 15000);

  const accessExpiresAt = Date.now() + 15000;
  const createdShare = await api(origin, ownerCookie, "/api/share-codes", {
    machine_id: machineId,
    expires_at: accessExpiresAt,
  });
  assert.equal(createdShare.response.status, 200);
  const redeemedShare = await api(origin, expiringCookie, "/api/share-codes/redeem", {
    code: createdShare.value.share.code,
  });
  assert.equal(redeemedShare.response.status, 200);
  assert.equal(redeemedShare.value.grant.expires_at, accessExpiresAt);

  const expiringClient = await new BrowserSocket("expiring visitor", browserUrl, expiringCookie).connect();
  const expiringSid = "visitor-expiry-shell";
  expiringClient.sendJson({ type: "open", sid: expiringSid, cols: 80, rows: 24, snapshot: true });
  const expirySupervision = await ownerClient.sessions(
    (list) => list.some((session) => session.sessionSid === expiringSid && session.mine === false),
    "expiring shell visible to owner",
  );
  const expiryWireSid = expirySupervision.list.find((session) => session.sessionSid === expiringSid).sid;
  await expiringClient.disconnect();
  assert.notEqual(expiringClient.ws.readyState, WebSocket.OPEN);
  await ownerClient.sessions(
    (list) => list.some((session) => session.sessionSid === expiringSid),
    "disconnected expiring visitor PTY remains before its grant deadline",
  );
  await ownerClient.sessions(
    (list) => !list.some((session) => session.sessionSid === expiringSid),
    "disconnected visitor PTY removed at grant expiry",
    25000,
  );
  await waitUntil(async () => {
    const history = await ownerClient.request({ type: "sess-list" });
    const record = history.sessions.find((session) => session.sid === expiryWireSid);
    return record && record.active === false && record.closedAt;
  }, "expired visitor PTY history closes", 15000);

  assert.match(
    fs.readFileSync(path.join(home, ".switchboard", "sessions", machineId, "legacy-unowned", "meta.json"), "utf8"),
    new RegExp(`"ownerAccountId"\\s*:\\s*"${owner.id}"`),
  );
  assert.match(
    fs.readFileSync(path.join(home, ".switchboard", "jobs", machineId, "legacy-job-0001.json"), "utf8"),
    new RegExp(`"ownerAccountId"\\s*:\\s*"${owner.id}"`),
  );

  ownerClient.close();
  console.log(`account visibility E2E passed (relay port ${port})`);
  console.log("relay-authenticated identity defeated forged owner fields; owner and visitor lists/output/input stayed scoped");
  console.log("owner supervised and closed visitor PTYs; live revoke, offline revoke reconciliation, and disconnected-client expiry terminated visitor PTYs");
  console.log("history, replay inputs, activity, and adjacent exec streams stayed scoped to their authenticated audience");
  console.log("detached jobs rejected forged/cross-account list, read, get, and kill; same-account access, owner supervision, and restart persistence passed");
  console.log("legacy daemon grants failed with HTTP 426; unowned legacy history and jobs migrated to the machine owner only");
  console.log("visitor disclosure and owner visitor-tab labels were rendered by the production frontend");
} catch (error) {
  failure = error;
  console.error(error.stack || error);
  for (const [name, chunks] of logs) {
    console.error(`\n--- ${name} output ---\n${chunks.join("").slice(-12000)}`);
  }
} finally {
  await cleanup();
  console.log("account visibility E2E cleanup complete");
}

if (failure) process.exitCode = 1;
