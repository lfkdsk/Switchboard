import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/session-state.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(source, sandbox);
const state = sandbox.SwitchboardSessionState;

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("shell state is isolated by relay, account, and machine without exposing tokens", () => {
  const machine = { mode: "machine", machineId: "node-1" };
  const first = state.storageKey("https://relay-a.test", machine, { id: 7 });
  assert.notEqual(first, state.storageKey("https://relay-b.test", machine, { id: 7 }));
  assert.notEqual(first, state.storageKey("https://relay-a.test", machine, { id: 8 }));
  assert.notEqual(first, state.storageKey("https://relay-a.test", {
    mode: "machine", machineId: "node-2",
  }, { id: 7 }));

  const secret = "this-is-a-secret-token-value";
  const tokenKey = state.storageKey("https://relay-a.test", { mode: "token", token: secret }, null);
  assert.equal(tokenKey.includes(secret), false);
});

test("local storage round-trips shell tabs, offsets, labels, dimensions, and active tab", () => {
  const storage = memoryStorage();
  const conn = { mode: "machine", machineId: "node-1" };
  const node = state.connectionNode(conn);
  const key = state.storageKey("https://relay.test", conn, { id: 7 });
  assert.equal(state.save(storage, key, {
    activeSid: "sid-b",
    shells: [
      { sid: "sid-a", node, label: "home", offset: 12, cols: 80, rows: 24 },
      { sid: "sid-b", node, label: "work", offset: 99, cols: 120, rows: 40 },
    ],
  }), true);
  assert.deepEqual(plain(state.load(storage, key, node)), {
    version: 1,
    activeSid: "sid-b",
    shells: [
      { sid: "sid-a", node, label: "home", offset: 12, cols: 80, rows: 24 },
      { sid: "sid-b", node, label: "work", offset: 99, cols: 120, rows: 40 },
    ],
  });
});

test("daemon session retention requires both replay and PTY holder features", () => {
  assert.equal(state.daemonRetainsSessions(["session-replay-v1", "pty-holder-v1"]), true);
  assert.equal(state.daemonRetainsSessions(["session-replay-v1"]), false);
  assert.equal(state.daemonRetainsSessions(["pty-holder-v1"]), false);
  assert.equal(state.daemonRetainsSessions([]), false);
  assert.equal(state.daemonRetainsSessions(null), false);
});

test("storage failures are contained and byte offsets accumulate safely", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
  };
  assert.deepEqual(plain(state.load(broken, "key", "node")), {
    version: 1, activeSid: null, shells: [],
  });
  assert.equal(state.save(broken, "key", { shells: [] }), false);
  assert.equal(state.advanceOffset(7, Buffer.byteLength("🙂")), 11);
  assert.equal(state.advanceOffset(null, 3), 3);
  assert.equal(state.advanceOffset(5, -1), 5);
});
