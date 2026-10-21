import assert from "node:assert/strict";
import test from "node:test";

import { browserMessage, daemonRoute } from "../src/replay-routing.js";

const frame = (sid, payload) => new Uint8Array([
  Buffer.byteLength(sid), ...Buffer.from(sid), ...payload,
]);

test("only browser open requests carry a relay-only client target", () => {
  const routed = JSON.parse(browserMessage(JSON.stringify({
    type: "open", sid: "shell-1", since: 42,
  }), "browser-a"));
  assert.deepEqual(routed, {
    type: "open", sid: "shell-1", since: 42, relayClientId: "browser-a",
  });
  const ping = JSON.stringify({ type: "ping" });
  assert.equal(browserMessage(ping, "browser-a"), ping);
  const binary = new Uint8Array([1, 2, 3]);
  assert.equal(browserMessage(binary, "browser-a"), binary);
});

test("replay metadata and payload target only the requesting browser", () => {
  const metadata = daemonRoute(JSON.stringify({
    type: "session-replay", sid: "shell-1", mode: "delta",
    from: 42, to: 46, bytes: 4, relayClientId: "browser-a",
  }));
  assert.equal(metadata.target, "browser-a");
  assert.equal(JSON.parse(metadata.message).relayClientId, undefined);
  assert.deepEqual(metadata.replayTargets, {
    "shell-1": { clientId: "browser-a", bytes: 4 },
  });

  const payload = frame("shell-1", [1, 2, 3, 4]);
  const data = daemonRoute(payload, metadata.replayTargets);
  assert.equal(data.target, "browser-a");
  assert.equal(data.message, payload);
  assert.deepEqual(data.replayTargets, {});

  const live = daemonRoute(frame("shell-1", [5]), data.replayTargets);
  assert.equal(live.target, null);
});

test("live output for another session does not consume a replay target", () => {
  const targets = { "shell-1": { clientId: "browser-a", bytes: 4 } };
  const live = daemonRoute(frame("shell-2", [8, 9]), targets);
  assert.equal(live.target, null);
  assert.equal(live.replayTargets, targets);
  const replay = daemonRoute(frame("shell-1", [1, 2, 3, 4]), live.replayTargets);
  assert.equal(replay.target, "browser-a");
  assert.deepEqual(replay.replayTargets, {});
});

test("reset is targeted without consuming the following replay payload", () => {
  const reset = daemonRoute(JSON.stringify({
    type: "reset", sid: "shell-1", offset: 100, relayClientId: "browser-b",
  }));
  assert.equal(reset.target, "browser-b");
  assert.deepEqual(reset.replayTargets, {});
  assert.deepEqual(JSON.parse(reset.message), {
    type: "reset", sid: "shell-1", offset: 100,
  });
});
