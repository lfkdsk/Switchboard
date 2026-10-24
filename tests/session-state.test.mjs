import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/session-state.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(source, sandbox);
const state = sandbox.SwitchboardSessionState;

test("daemon session retention requires both replay and PTY holder features", () => {
  assert.equal(state.daemonRetainsSessions(["session-replay-v1", "pty-holder-v1"]), true);
  assert.equal(state.daemonRetainsSessions(["session-replay-v1"]), false);
  assert.equal(state.daemonRetainsSessions(["pty-holder-v1"]), false);
  assert.equal(state.daemonRetainsSessions([]), false);
  assert.equal(state.daemonRetainsSessions(null), false);
});

test("client-gone stays enabled until holder-aware retention is confirmed", () => {
  assert.equal(state.shouldNotifyClientGone(null), true);
  assert.equal(state.shouldNotifyClientGone([]), true);
  assert.equal(state.shouldNotifyClientGone(["session-replay-v1"]), true);
  assert.equal(state.shouldNotifyClientGone(["session-replay-v1", "pty-holder-v1"]), false);
});

test("byte offsets accumulate safely", () => {
  assert.equal(state.advanceOffset(7, Buffer.byteLength("🙂")), 11);
  assert.equal(state.advanceOffset(null, 3), 3);
  assert.equal(state.advanceOffset(5, -1), 5);
});

test("the webshell keeps no shell state in browser storage", () => {
  // The daemon's session list is the only source of truth for which shells
  // exist; a browser-side copy goes stale and is invisible to other devices.
  const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/);
});
