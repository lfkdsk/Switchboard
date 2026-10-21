import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sessionLogs from "../cli/lib/session-log.js";

const { SessionLogStore, recordingEnabled } = sessionLogs;

function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-sessions-"));
  return { dir, store: new SessionLogStore({ dir, ...options }).init() };
}

test("session output rolls segments and reads continuously across their boundaries", async () => {
  let now = Date.now();
  const { dir, store } = tempStore({ segmentSize: 4, indexBytes: 3, now: () => now });
  const log = store.open("session-one", { cols: 80, rows: 24 });
  log.append(Buffer.from("abcdefghij"));
  now += 1;
  log.resize(100, 40);
  await log.close({ exitCode: 0 });

  const sessionDir = path.join(dir, "session-one");
  assert.deepEqual(
    fs.readdirSync(sessionDir).filter((name) => name.endsWith(".log")).sort(),
    ["seg-0.log", "seg-1.log", "seg-2.log"],
  );
  const chunk = store.read("session-one", { from: 2, len: 7 });
  assert.equal(chunk.data.toString(), "cdefghi");
  assert.deepEqual({ off: chunk.off, next: chunk.next, eof: chunk.eof }, { off: 2, next: 9, eof: false });
  assert.deepEqual(store.tail("session-one", 3).data, Buffer.from("hij"));
  assert.equal(store.stat("session-one").off, 10);

  const index = fs.readFileSync(path.join(sessionDir, "index.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(index.every((entry) => Number.isInteger(entry.off) && Number.isInteger(entry.seg)));
  assert.deepEqual(index.find((entry) => entry.type === "resize").resize, { cols: 100, rows: 40 });
  assert.equal(fs.statSync(sessionDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(sessionDir, "seg-0.log")).mode & 0o777, 0o600);
  const reloaded = new SessionLogStore({ dir, segmentSize: 4, now: () => now }).init();
  assert.equal(reloaded.read("session-one", { from: 0, len: 20 }).data.toString(), "abcdefghij");
  assert.equal(reloaded.stat("session-one").status, "closed");
  fs.rmSync(dir, { recursive: true });
});

test("pruning old segments preserves monotonically increasing offsets", async () => {
  let now = 2_000;
  const { dir, store } = tempStore({
    segmentSize: 4, maxSessionBytes: 8, maxTotalBytes: 100, retentionMs: 10_000, now: () => now,
  });
  const log = store.open("session-prune");
  log.append("abcdefghijkl");
  await log.close();

  const afterCap = store.read("session-prune", { from: 0, len: 20 });
  assert.equal(afterCap.data.toString(), "efghijkl");
  assert.deepEqual({ off: afterCap.off, next: afterCap.next }, { off: 4, next: 12 });

  now += 10_001;
  store.prune();
  assert.equal(store.stat("session-prune").off, 12);
  assert.equal(store.read("session-prune", { from: 0, len: 20 }).off, 12);
  assert.deepEqual(store.list(), []);

  const reopened = store.open("session-prune");
  reopened.append("Z");
  await reopened.close();
  const last = store.read("session-prune", { from: 0, len: 20 });
  assert.deepEqual({ text: last.data.toString(), off: last.off, next: last.next }, { text: "Z", off: 12, next: 13 });
  fs.rmSync(dir, { recursive: true });
});

test("the global cap prunes the oldest segments across scope directories", async () => {
  let now = 10_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-session-scopes-"));
  const options = {
    dir, segmentSize: 4, maxSessionBytes: 100, maxTotalBytes: 8, retentionMs: 100_000, now: () => now,
  };
  const first = new SessionLogStore({ ...options, scope: "scope-a" }).init();
  const firstLog = first.open("session-a");
  firstLog.append("abcdefgh");
  await firstLog.close();

  now += 100;
  const second = new SessionLogStore({ ...options, scope: "scope-b" }).init();
  const secondLog = second.open("session-b");
  secondLog.append("ijklmnop");
  await secondLog.close();

  assert.deepEqual(
    fs.readdirSync(path.join(dir, "scope-a", "session-a")).filter((name) => name.endsWith(".log")),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "scope-b", "session-b")).filter((name) => name.endsWith(".log")).sort(),
    ["seg-0.log", "seg-1.log"],
  );
  assert.equal(first.stat("session-a").bytes, 0);
  fs.rmSync(dir, { recursive: true });
});

test("SWITCHBOARD_RECORD=0 disables recording while recording defaults on", () => {
  assert.equal(recordingEnabled({}), true);
  assert.equal(recordingEnabled({ SWITCHBOARD_RECORD: "1" }), true);
  assert.equal(recordingEnabled({ SWITCHBOARD_RECORD: "0" }), false);
});
