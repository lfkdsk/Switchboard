import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
