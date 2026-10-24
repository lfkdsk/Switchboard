import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import peer from "../cli/peer.js";

const { peerSocket } = peer;

// Answers the first `failures` handshakes with `status`, then opens.
function flakyTransport({ failures, status }) {
  const log = { dials: 0, statuses: [] };
  class Socket extends EventEmitter {
    constructor() {
      super();
      log.dials++;
      this.readyState = 0;
      queueMicrotask(() => {
        if (log.dials <= failures) {
          const res = new EventEmitter();
          res.statusCode = status;
          log.statuses.push(status);
          this.emit("unexpected-response", {}, res);
          res.emit("data", "error code: 1101");
          res.emit("end");
        } else {
          this.readyState = 1;
          this.emit("open");
        }
      });
    }
    send() {}
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
  }
  return { Socket, log };
}

function ctxWith(Socket, extra = {}) {
  const notices = [];
  return {
    ctx: {
      server: "https://relay.invalid", agentToken: "token", WebSocket: Socket,
      handshakeRetryDelays: [1, 1, 1], notify: (line) => notices.push(line), ...extra,
    },
    notices,
  };
}

function settle(ws) {
  return new Promise((resolve) => {
    ws.on("open", () => resolve({ opened: true }));
  });
}

test("a 5xx handshake is retried and the caller's handlers survive the retry", async () => {
  const { Socket, log } = flakyTransport({ failures: 2, status: 503 });
  const failures = [];
  const { ctx, notices } = ctxWith(Socket);
  const ws = peerSocket(ctx, "m1", (e) => failures.push(e));
  const result = await settle(ws);
  assert.deepEqual(result, { opened: true });
  assert.equal(log.dials, 3);
  assert.deepEqual(log.statuses, [503, 503]);
  assert.equal(failures.length, 0);
  assert.equal(notices.length, 2);
  assert.match(notices[0], /503/);
  assert.equal(ws.readyState, 1);
});

test("retries stop after the configured attempts and report how many were made", async () => {
  const { Socket, log } = flakyTransport({ failures: 99, status: 500 });
  const { ctx } = ctxWith(Socket);
  const error = await new Promise((resolve) => peerSocket(ctx, "m1", resolve));
  assert.equal(log.dials, 4); // 1 + 3 retries
  assert.match(error.message, /Relay refused the connection \(500\)/);
  assert.match(error.message, /after 4 attempts/);
});

test("a 4xx handshake fails immediately without retrying", async () => {
  const { Socket, log } = flakyTransport({ failures: 99, status: 403 });
  const { ctx, notices } = ctxWith(Socket);
  const error = await new Promise((resolve) => peerSocket(ctx, "m1", resolve));
  assert.equal(log.dials, 1);
  assert.equal(notices.length, 0);
  assert.match(error.message, /\(403\)/);
  assert.doesNotMatch(error.message, /attempts/);
});

for (const method of ["close", "terminate"]) {
  test(`${method} during retry backoff prevents redial and suppresses teardown events`, async () => {
    const { Socket, log } = flakyTransport({ failures: 1, status: 503 });
    class ClosingSocket extends Socket {
      close() {
        super.close();
        this.emit("error", new Error("WebSocket was closed before the connection was established"));
        this.emit("close");
      }
      terminate() { this.close(); }
    }
    const failures = [];
    const events = [];
    const { ctx, notices } = ctxWith(ClosingSocket, { handshakeRetryDelays: [20] });
    const ws = peerSocket(ctx, "m1", (error) => failures.push(error));
    for (const event of ["open", "error", "close"]) ws.on(event, () => events.push(event));
    // The response's end handler has scheduled the retry before this resumes.
    await Promise.resolve();
    assert.equal(notices.length, 1);
    ws[method]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(log.dials, 1);
    assert.equal(ws.readyState, 3);
    assert.deepEqual(failures, []);
    assert.deepEqual(events, []);
  });
}

// Run in a separate process: a leaked retry timer must not be hidden by the
// test runner's own handles or by forced process.exit() in a fixture.
function cancellationChild(peerPath, method) {
  const assert = require("node:assert/strict");
  const { EventEmitter } = require("node:events");
  const { peerSocket, cmdExec } = require(peerPath);
  let dials = 0;
  let cancellations = 0;
  let retries = 0;
  class Socket extends EventEmitter {
    constructor() {
      super();
      assert.equal(++dials, 1, "cancelled socket must never redial");
      this.readyState = 0;
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 503;
        this.emit("unexpected-response", {}, res);
        res.emit("end");
      });
    }
    close() {
      cancellations++;
      this.readyState = 3;
      this.emit("error", new Error("WebSocket was closed before the connection was established"));
      this.emit("close");
    }
    terminate() { this.close(); }
  }
  const ctx = {
    server: "https://relay.invalid", agentToken: "token", WebSocket: Socket,
    handshakeRetryDelays: [60000],
    notify() {
      retries++;
      if (method !== "exec") setImmediate(() => ws[method]());
    },
    fetch: async () => ({ ok: true, json: async () => ({
      nodes: [{ machine_id: "m1", name: "box", online: true, peer: true, platform: "linux" }],
    }) }),
  };
  let ws;
  if (method === "exec") {
    cmdExec(ctx, { target: "box", command: "true", timeout: 0.05 });
  } else {
    // No failure callback or error listener: a spurious error would change
    // the exit code, just as it does for callers using the default handler.
    ws = peerSocket(ctx, "m1");
  }
  process.on("exit", () => {
    assert.equal(retries, 1);
    assert.equal(dials, 1);
    assert.ok(cancellations >= 1);
  });
}

for (const method of ["close", "terminate", "exec"]) {
  test(`${method} during retry backoff lets the calling process exit naturally`, async () => {
    const script = `(${cancellationChild.toString()})(...process.argv.slice(1))`;
    const args = ["--input-type=commonjs", "-e", script, fileURLToPath(new URL("../cli/peer.js", import.meta.url)), method];
    let result;
    try {
      result = await promisify(execFile)(process.execPath, args, { timeout: 3000 });
      assert.notEqual(method, "exec", "exec timeout must exit with 124");
    } catch (error) {
      assert.equal(method, "exec", error.message);
      assert.equal(error.killed, false, "child must exit without the parent watchdog");
      assert.equal(error.code, 124);
      assert.match(error.stderr, /Timed out after 0.05s/);
      result = error;
    }
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /Connection failed|AssertionError/);
    if (method !== "exec") assert.equal(result.stderr, "");
  });
}
