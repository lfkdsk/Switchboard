import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import replayModule from "../cli/lib/session-replay.js";
import logModule from "../cli/lib/session-log.js";

const {
  DEFAULT_SESSION_GRACE_MS,
  MAX_REPLAY_BYTES,
  SessionScreen,
  buildSessionReplay,
  parseSessionGrace,
  replayPlan,
} = replayModule;
const { SessionLogStore } = logModule;

test("replay planning chooses an exact delta only for a readable gap up to 1 MiB", () => {
  assert.deepEqual(
    replayPlan({ since: 40, firstOffset: 10, currentOffset: 75 }),
    { mode: "delta", from: 40, to: 75 },
  );
  assert.equal(replayPlan({ firstOffset: 0, currentOffset: 75 }).mode, "snapshot");
  assert.equal(replayPlan({ since: 9, firstOffset: 10, currentOffset: 75 }).mode, "snapshot");
  assert.equal(replayPlan({
    since: 0, firstOffset: 0, currentOffset: MAX_REPLAY_BYTES + 1,
  }).mode, "snapshot");
  assert.equal(replayPlan({
    since: 74, firstOffset: 0, currentOffset: 75, forceSnapshot: true,
  }).mode, "snapshot");
});

test("incremental replay flushes the session log and preserves UTF-8 bytes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-replay-"));
  const store = new SessionLogStore({ dir }).init();
  const log = store.open("unicode");
  const screen = new SessionScreen(80, 24);
  const output = Buffer.from("old🙂new", "utf8");
  log.append(output);
  screen.write(output);

  const from = Buffer.byteLength("old", "utf8");
  const replay = await buildSessionReplay({
    log, screen, since: from, currentOffset: output.length,
  });
  assert.equal(replay.mode, "delta");
  assert.deepEqual(replay.payload, output.subarray(from));
  assert.deepEqual({ from: replay.from, to: replay.to }, { from, to: output.length });

  await log.close();
  screen.dispose();
  fs.rmSync(dir, { recursive: true });
});

test("snapshot replay serializes the screen and anchors future output at the raw offset", async () => {
  const screen = new SessionScreen(20, 4);
  screen.write("one\r\ntwo\r\nthree");
  const replay = await buildSessionReplay({
    screen, since: null, currentOffset: 321, forceSnapshot: true,
  });
  assert.equal(replay.mode, "snapshot");
  assert.deepEqual({ from: replay.from, to: replay.to }, { from: 321, to: 321 });
  assert.equal(replay.payload.subarray(0, 2).toString(), "\x1bc");
  assert.match(replay.payload.toString(), /one\r\ntwo\r\nthree/);
  screen.dispose();
});

test("session grace defaults to 24h, accepts units, and treats zero as forever", () => {
  assert.equal(parseSessionGrace(undefined), DEFAULT_SESSION_GRACE_MS);
  assert.equal(parseSessionGrace("24h"), 24 * 60 * 60 * 1000);
  assert.equal(parseSessionGrace("90"), 90 * 1000);
  assert.equal(parseSessionGrace("1500ms"), 1500);
  assert.equal(parseSessionGrace("0"), 0);
  assert.equal(parseSessionGrace("nonsense"), DEFAULT_SESSION_GRACE_MS);
});
