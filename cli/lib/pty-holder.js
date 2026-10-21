#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { StringDecoder } = require("string_decoder");
const { spawn } = require("child_process");
const { SessionLogStore, validId } = require("./session-log");
const { SessionScreen, buildSessionReplay } = require("./session-replay");

const CONTROL_PACKET = 0;
const DATA_PACKET = 1;
const MAX_PACKET_BYTES = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 10000;
let lockClaimCounter = 0;

function usePtyHolder(platform = process.platform) {
  // ConPTY handles cannot currently be inherited by an independent holder.
  // Keep the existing in-process implementation on Windows.
  return platform !== "win32";
}

function holderSocketPath(rootDir, scope, sid) {
  if (!rootDir) throw new Error("session root directory is required");
  if (!validId(scope)) throw new Error("invalid session scope");
  if (!validId(sid)) throw new Error("invalid session id");
  return path.join(rootDir, scope, sid, "sock");
}

function packet(type, value) {
  const payload = type === CONTROL_PACKET
    ? Buffer.from(JSON.stringify(value), "utf8")
    : Buffer.from(value);
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(payload.length + 1, 0);
  frame[4] = type;
  payload.copy(frame, 5);
  return frame;
}

function control(value) { return packet(CONTROL_PACKET, value); }
function data(value) { return packet(DATA_PACKET, value); }

function decodePackets(onPacket) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length < 1 || length > MAX_PACKET_BYTES) throw new Error("invalid PTY holder packet");
      if (buffered.length < 4 + length) return;
      const type = buffered[4];
      const payload = buffered.subarray(5, 4 + length);
      buffered = buffered.subarray(4 + length);
      if (type === CONTROL_PACKET) onPacket(type, JSON.parse(payload.toString("utf8")));
      else if (type === DATA_PACKET) onPacket(type, payload);
      else throw new Error("unknown PTY holder packet");
    }
  };
}

class PtyHolderClient extends EventEmitter {
  constructor(socket, socketPath) {
    super();
    this.socket = socket;
    this.socketPath = socketPath;
    this.pending = [];
    this.active = false;
    this.intentionalClose = false;
    this.ready = false;
    this.pid = null;
    this.holderPid = null;
    this.process = null;
    this.startedAt = null;
    this.lastOutputAt = null;
    this.offset = 0;
    this.cols = null;
    this.rows = null;
    this.replayBytesRemaining = 0;

    const decode = decodePackets((type, payload) => {
      if (type === DATA_PACKET) {
        const replayBytes = Math.min(this.replayBytesRemaining, payload.length);
        this.replayBytesRemaining -= replayBytes;
        if (payload.length > replayBytes) {
          this.offset += payload.length - replayBytes;
          this.lastOutputAt = Date.now();
        }
        this._deliver("data", payload);
        return;
      }
      if (payload.type === "ready") {
        this.ready = true;
        this.sid = payload.sid;
        this.pid = payload.pid;
        this.holderPid = payload.holderPid;
        this.process = payload.process;
        this.startedAt = payload.startedAt;
        this.lastOutputAt = payload.lastOutputAt;
        this.offset = payload.offset;
        this.cols = payload.cols;
        this.rows = payload.rows;
        this.recording = payload.recording;
        this.emit("_ready");
        return;
      }
      if (payload.type === "session-replay") {
        this.offset = payload.to;
        this.replayBytesRemaining = payload.bytes;
      }
      this._deliver(payload.type, payload);
    });
    socket.on("data", (chunk) => {
      try { decode(chunk); } catch (error) { this._deliver("protocol-error", error); socket.destroy(); }
    });
    socket.on("error", (error) => {
      this.emit("_socket-error", error);
      this._deliver("socket-error", error);
    });
    socket.on("close", () => {
      if (!this.intentionalClose) {
        this.emit("_disconnect");
        this._deliver("disconnect");
      }
    });
  }

  _deliver(event, value) {
    if (this.active) this.emit(event, value);
    else this.pending.push([event, value]);
  }

  activate() {
    if (this.active) return this;
    this.active = true;
    const pending = this.pending;
    this.pending = [];
    for (const [event, value] of pending) this.emit(event, value);
    return this;
  }

  sendControl(message) {
    if (!this.socket.destroyed) this.socket.write(control(message));
  }

  write(value) {
    if (!this.socket.destroyed) this.socket.write(data(value));
  }

  resize(cols, rows) {
    if (cols > 0 && rows > 0) {
      this.cols = Math.floor(cols);
      this.rows = Math.floor(rows);
      this.sendControl({ type: "resize", cols: this.cols, rows: this.rows });
    }
  }

  replay(since, snapshot) {
    this.sendControl({ type: "replay", since, snapshot: !!snapshot });
  }

  kill() { this.sendControl({ type: "kill" }); }

  disconnect() {
    this.intentionalClose = true;
    this.socket.destroy();
  }
}

function connectPtyHolder(socketPath, options = {}) {
  const timeout = options.timeout ?? CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const target = socketConnectTarget(socketPath);
    const socket = net.createConnection(target.path);
    const releaseTarget = () => {
      if (target.fd != null) {
        try { fs.closeSync(target.fd); } catch {}
        target.fd = null;
      }
      target.cleanup?.();
      target.cleanup = null;
    };
    socket.once("connect", releaseTarget);
    socket.once("error", releaseTarget);
    socket.once("close", releaseTarget);
    const client = new PtyHolderClient(socket, socketPath);
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`timed out connecting to PTY holder ${socketPath}`)), timeout);
    timer.unref?.();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("_ready", onReady);
      client.off("_socket-error", onError);
      client.off("_disconnect", onDisconnect);
      if (error) {
        client.disconnect();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const onReady = () => finish();
    const onError = (error) => {
      if (!client.ready) finish(error);
    };
    const onDisconnect = () => {
      if (!client.ready) finish(new Error(`PTY holder disconnected before ready: ${socketPath}`));
    };
    client.once("_ready", onReady);
    client.once("_socket-error", onError);
    client.once("_disconnect", onDisconnect);
  });
}

async function spawnPtyHolder(options) {
  const socketPath = holderSocketPath(options.rootDir, options.scope, options.sid);
  secureDir(path.dirname(socketPath));
  try {
    return await connectPtyHolder(socketPath, { timeout: 250 });
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
  }
  if (options.signal?.aborted) throw abortError();

  const config = {
    rootDir: options.rootDir,
    scope: options.scope,
    sid: options.sid,
    shell: options.shell,
    cwd: options.cwd,
    cols: dimension(options.cols, 80),
    rows: dimension(options.rows, 24),
    recording: options.recording !== false,
  };
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
  const child = spawn(process.execPath, [__filename, "--run", encoded], {
    detached: true,
    stdio: "ignore",
    env: options.env || process.env,
  });
  let childError = null;
  child.on("error", (error) => { childError = error; });
  child.unref();
  const abort = () => {
    try { child.kill("SIGTERM"); } catch {}
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const deadline = Date.now() + (options.timeout ?? START_TIMEOUT_MS);
    let lastError;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw abortError();
      if (childError) throw childError;
      try {
        return await connectPtyHolder(socketPath, { timeout: 250 });
      } catch (error) {
        lastError = error;
        await delay(25);
      }
    }
    abort();
    throw new Error(`PTY holder did not start: ${lastError?.message || socketPath}`);
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

function listPtyHolderSockets(rootDir, scope = null) {
  const scopes = scope
    ? (validId(scope) ? [scope] : [])
    : safeReadDir(rootDir).filter((entry) => entry.isDirectory() && validId(entry.name)).map((entry) => entry.name);
  const sockets = [];
  for (const scopeName of scopes) {
    const scopeDir = path.join(rootDir, scopeName);
    for (const entry of safeReadDir(scopeDir)) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      const socketPath = path.join(scopeDir, entry.name, "sock");
      try {
        if (fs.lstatSync(socketPath).isSocket()) sockets.push(socketPath);
      } catch {}
    }
  }
  return sockets;
}

async function recoverPtyHolders(options) {
  if (!usePtyHolder(options.platform)) return [];
  const clients = [];
  for (const socketPath of listPtyHolderSockets(options.rootDir, options.scope)) {
    try {
      clients.push(await connectPtyHolder(socketPath, { timeout: options.timeout }));
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) {
        try { fs.unlinkSync(socketPath); } catch {}
      }
    }
  }
  return clients;
}

async function stopPtyHolders(options) {
  const clients = await recoverPtyHolders(options);
  await Promise.all(clients.map((client) => new Promise((resolve) => {
    const timer = setTimeout(() => { client.disconnect(); resolve(); }, options.timeout ?? CONNECT_TIMEOUT_MS);
    timer.unref?.();
    const done = () => { clearTimeout(timer); resolve(); };
    client.once("exit", done);
    client.once("disconnect", done);
    client.activate();
    client.kill();
  })));
}

async function runHolder(config) {
  const pty = require("node-pty");
  const socketPath = holderSocketPath(config.rootDir, config.scope, config.sid);
  const sessionDir = path.dirname(socketPath);
  secureDir(sessionDir);
  const releaseLock = acquireHolderLock(sessionDir);
  const cleanupFiles = () => {
    try { fs.unlinkSync(socketPath); } catch {}
    releaseLock();
  };
  process.on("exit", cleanupFiles);
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }

  process.title = `switchboard-pty-holder:${config.sid}`;
  const cols = dimension(config.cols, 80);
  const rows = dimension(config.rows, 24);
  const startedAt = Date.now();
  const screen = new SessionScreen(cols, rows);
  let sessionLog = null;
  let log = null;
  if (config.recording !== false) {
    sessionLog = new SessionLogStore({ dir: config.rootDir, scope: config.scope }).init();
    log = sessionLog.open(config.sid, { cols, rows });
  }
  let offset = log?.stat().off || 0;
  let lastOutputAt = startedAt;
  let logPaused = false;
  let replayPaused = false;
  let replayQueue = Promise.resolve();
  let closing = false;
  let killTimer = null;
  const clients = new Set();
  const shell = pty.spawn(config.shell || defaultShell(), [], {
    name: "xterm-color",
    cols,
    rows,
    cwd: config.cwd || process.env.HOME || process.cwd(),
    env: process.env,
  });
  const shellExit = new Promise((resolve) => shell.onExit(resolve));

  const send = (socket, value) => {
    if (!socket.destroyed) socket.write(value);
  };
  const broadcast = (value) => {
    for (const socket of clients) send(socket, value);
  };
  const resume = () => {
    if (!logPaused && !replayPaused) {
      try { shell.resume(); } catch {}
    }
  };

  shell.onData((value) => {
    const output = Buffer.from(value, "utf8");
    lastOutputAt = Date.now();
    offset += output.length;
    screen.write(output);
    if (log && !log.append(output) && !logPaused) {
      logPaused = true;
      try { shell.pause(); } catch {}
      void log.drain().finally(() => {
        logPaused = false;
        resume();
      });
    }
    broadcast(data(output));
  });

  const server = net.createServer((socket) => {
    clients.add(socket);
    send(socket, control({
      type: "ready",
      sid: config.sid,
      pid: shell.pid,
      holderPid: process.pid,
      process: shell.process,
      startedAt,
      lastOutputAt,
      offset,
      cols: shell.cols || cols,
      rows: shell.rows || rows,
      recording: !!log,
    }));
    const inputDecoder = new StringDecoder("utf8");
    const decode = decodePackets((type, message) => {
      if (type === DATA_PACKET) {
        const text = inputDecoder.write(message);
        if (text) shell.write(text);
        return;
      }
      switch (message.type) {
        case "resize":
          if (message.cols > 0 && message.rows > 0) {
            try { shell.resize(Math.floor(message.cols), Math.floor(message.rows)); } catch {}
            screen.resize(message.cols, message.rows);
            log?.resize(message.cols, message.rows);
          }
          break;
        case "replay":
          replayQueue = replayQueue.then(async () => {
            if (closing || socket.destroyed) return;
            replayPaused = true;
            try { shell.pause(); } catch {}
            try {
              const replay = await buildSessionReplay({
                log,
                screen,
                since: message.since,
                currentOffset: offset,
                forceSnapshot: !!message.snapshot,
              });
              if (replay.mode === "snapshot") {
                send(socket, control({ type: "reset", sid: config.sid, offset: replay.to }));
              }
              send(socket, control({
                type: "session-replay",
                sid: config.sid,
                mode: replay.mode,
                from: replay.from,
                to: replay.to,
                bytes: replay.payload.length,
              }));
              if (replay.payload.length) send(socket, data(replay.payload));
            } catch (error) {
              send(socket, control({ type: "holder-error", message: error.message }));
            } finally {
              replayPaused = false;
              resume();
            }
          });
          break;
        case "kill": terminateShell(); break;
      }
    });
    socket.on("data", (chunk) => {
      try { decode(chunk); } catch { socket.destroy(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Binding a relative name avoids sockaddr_un's ~104-byte absolute-path
    // limit while still creating the required <session>/sock filesystem node.
    process.chdir(sessionDir);
    server.listen(path.basename(socketPath), () => {
      server.off("error", reject);
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  const finish = async (result) => {
    if (closing) return;
    closing = true;
    clearTimeout(killTimer);
    broadcast(control({ type: "exit", sid: config.sid, code: result.exitCode ?? null }));
    for (const socket of clients) socket.end();
    try { await log?.close(result); } catch {}
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      delay(500),
    ]);
    cleanupFiles();
    screen.dispose();
  };

  function terminateShell() {
    if (closing || killTimer) return;
    try { shell.kill("SIGTERM"); } catch {}
    killTimer = setTimeout(() => {
      try { process.kill(-shell.pid, "SIGKILL"); }
      catch { try { shell.kill("SIGKILL"); } catch {} }
    }, 1000);
  }
  process.on("SIGINT", terminateShell);
  process.on("SIGTERM", terminateShell);

  const { exitCode } = await shellExit;
  await finish({ exitCode });
}

function defaultShell() {
  return process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
}
function dimension(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}
function safeReadDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function socketConnectTarget(socketPath) {
  // Linux can resolve a long socket path through an open directory descriptor,
  // keeping the actual sockaddr short without moving the required socket file.
  if (process.platform === "linux" && Buffer.byteLength(socketPath) > 100) {
    const fd = fs.openSync(path.dirname(socketPath), "r");
    return { path: `/proc/self/fd/${fd}/${path.basename(socketPath)}`, fd };
  }
  if (Buffer.byteLength(socketPath) > 100) {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const aliasRoot = fs.mkdtempSync(`/tmp/sbpty-${uid}-`);
    fs.chmodSync(aliasRoot, 0o700);
    const alias = path.join(aliasRoot, "session");
    fs.symlinkSync(path.dirname(socketPath), alias, process.platform === "win32" ? "junction" : "dir");
    return {
      path: path.join(alias, path.basename(socketPath)),
      fd: null,
      cleanup: () => { try { fs.rmSync(aliasRoot, { recursive: true, force: true }); } catch {} },
    };
  }
  return { path: socketPath, fd: null };
}
function acquireHolderLock(sessionDir) {
  const lockPath = path.join(sessionDir, "holder.pid");
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (Number(fs.readFileSync(lockPath, "utf8")) === process.pid) fs.unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const claimPath = lockPath + `.claim-${process.pid}-${lockClaimCounter++}`;
      try {
        // A hard link pins the exact inode we inspected. If another starter
        // replaces holder.pid meanwhile, the inode check prevents us from
        // unlinking its new live lock while recovering this stale one.
        fs.linkSync(lockPath, claimPath);
        const owner = Number(fs.readFileSync(claimPath, "utf8"));
        if (pidAlive(owner)) {
          throw Object.assign(new Error("PTY holder is already running"), { code: "EEXIST" });
        }
        const claimed = fs.statSync(claimPath);
        let current = null;
        try { current = fs.statSync(lockPath); } catch {}
        if (current && current.dev === claimed.dev && current.ino === claimed.ino) {
          try { fs.unlinkSync(lockPath); } catch {}
        }
      } catch (claimError) {
        if (claimError.code === "EEXIST" && /already running/.test(claimError.message)) throw claimError;
        if (!["ENOENT", "EEXIST"].includes(claimError.code)) throw claimError;
      } finally {
        try { fs.unlinkSync(claimPath); } catch {}
      }
    }
  }
  throw new Error("could not acquire PTY holder lock");
}
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
function abortError() {
  return Object.assign(new Error("PTY holder startup cancelled"), { code: "ECANCELED" });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

if (require.main === module) {
  if (process.argv[2] !== "--run" || !process.argv[3]) {
    console.error("pty-holder is an internal Switchboard process");
    process.exit(2);
  }
  let config;
  try { config = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8")); }
  catch (error) {
    console.error("invalid PTY holder configuration: " + error.message);
    process.exit(2);
  }
  runHolder(config).then(
    () => process.exit(0),
    (error) => {
      console.error(error.stack || error);
      process.exit(1);
    },
  );
}

module.exports = {
  PtyHolderClient,
  connectPtyHolder,
  holderSocketPath,
  listPtyHolderSockets,
  recoverPtyHolders,
  runHolder,
  spawnPtyHolder,
  stopPtyHolders,
  usePtyHolder,
};
