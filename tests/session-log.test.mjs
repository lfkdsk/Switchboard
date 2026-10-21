import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import sessionLogs from "../cli/lib/session-log.js";

const {
  SessionLogStore, recordingEnabled, sessionLogListResponse, sessionLogReadResponse,
} = sessionLogs;

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
  const segmentNames = fs.readdirSync(sessionDir)
    .filter((name) => /^seg-\d+\.log(?:\.(?:gz|zst))?$/.test(name));
  assert.deepEqual(
    segmentNames.map((name) => name.match(/^seg-\d+\.log/)[0]).sort(),
    ["seg-0.log", "seg-1.log", "seg-2.log"],
  );
  assert.ok(segmentNames.every((name) => /\.gz$/.test(name)),
    "closed session segments should use gzip by default");
  const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8"));
  assert.deepEqual(meta.segments.map(({ start, bytes }) => ({ start, bytes })), [
    { start: 0, bytes: 4 }, { start: 4, bytes: 4 }, { start: 8, bytes: 2 },
  ]);
  assert.ok(meta.segments.every((segment) => segment.compression === "gz"));
  const chunk = store.read("session-one", { from: 2, len: 7 });
  assert.equal(chunk.data.toString(), "cdefghi");
  assert.deepEqual({ off: chunk.off, next: chunk.next, eof: chunk.eof }, { off: 2, next: 9, eof: false });
  assert.deepEqual(store.tail("session-one", 3).data, Buffer.from("hij"));
  assert.equal(store.stat("session-one").off, 10);

  const index = fs.readFileSync(path.join(sessionDir, "index.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(index.every((entry) => Number.isInteger(entry.off) && Number.isInteger(entry.seg)));
  assert.deepEqual(index.find((entry) => entry.type === "resize").resize, { cols: 100, rows: 40 });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(sessionDir).mode & 0o777, 0o700);
  const firstSegment = fs.readdirSync(sessionDir).find((name) => name.startsWith("seg-0.log"));
  assert.equal(fs.statSync(path.join(sessionDir, firstSegment)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(sessionDir, "index.jsonl")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(sessionDir, "meta.json")).mode & 0o777, 0o600);
  const reloaded = new SessionLogStore({ dir, segmentSize: 4, now: () => now }).init();
  assert.equal(reloaded.read("session-one", { from: 0, len: 20 }).data.toString(), "abcdefghij");
  assert.equal(reloaded.stat("session-one").status, "closed");
  fs.rmSync(dir, { recursive: true });
});

test("alternate-screen intervals are indexed with offsets, timestamps, and application", async () => {
  let now = 1_000;
  const { dir, store } = tempStore({ now: () => now });
  const log = store.open("session-alternate");
  log.append("$ vim file.txt\n\x1b[?104");
  now = 193_000;
  log.append("9hfullscreen bytes");
  now = 385_000;
  log.append("\x1b[?1049ldone\n");
  await log.close();

  const sessionDir = path.join(dir, "session-alternate");
  const entries = fs.readFileSync(path.join(sessionDir, "index.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  const enter = entries.find((entry) => entry.type === "alternate-screen-enter");
  const exit = entries.find((entry) => entry.type === "alternate-screen-exit");
  assert.deepEqual(
    { start: enter.start, startedAt: enter.startedAt, application: enter.application },
    { start: 15, startedAt: 193_000, application: "vim" },
  );
  assert.deepEqual(
    {
      start: exit.start,
      end: exit.end,
      startedAt: exit.startedAt,
      endedAt: exit.endedAt,
      application: exit.application,
    },
    { start: 15, end: 47, startedAt: 193_000, endedAt: 385_000, application: "vim" },
  );
  const chunk = store.read("session-alternate", { from: 10, len: 50 });
  assert.deepEqual(chunk.alternateScreens, [{
    start: 15,
    end: 47,
    startedAt: 193_000,
    endedAt: 385_000,
    application: "vim",
  }]);
  fs.rmSync(dir, { recursive: true });
});

test("alternate-screen indexing falls back to fullscreen", async () => {
  let now = 10;
  const { dir, store } = tempStore({ now: () => now });
  const log = store.open("session-fullscreen");
  log.append("prompt\n\x1b[?47hnoise");
  now = 1_010;
  log.append("\x1b[?47l");
  await log.close();
  const chunk = store.read("session-fullscreen", { from: 0, len: 100 });
  assert.equal(chunk.alternateScreens[0].application, "fullscreen");
  assert.equal(chunk.alternateScreens[0].endedAt - chunk.alternateScreens[0].startedAt, 1_000);
  fs.rmSync(dir, { recursive: true });
});

test("zstd compression is opt-in and requires runtime support", async () => {
  const runtime = {
    gzipSync: zlib.gzipSync,
    gunzipSync: zlib.gunzipSync,
    zstdCompressSync: zlib.gzipSync,
    zstdDecompressSync: zlib.gunzipSync,
  };
  const { dir, store } = tempStore({
    env: { SWITCHBOARD_LOG_COMPRESSION: "zstd" },
    compressionRuntime: runtime,
  });
  const log = store.open("session-zstd");
  log.append("zstd opt in");
  await log.close();

  const sessionDir = path.join(dir, "session-zstd");
  assert.ok(fs.existsSync(path.join(sessionDir, "seg-0.log.zst")));
  assert.equal(store.read("session-zstd", { from: 0, len: 64 }).data.toString(), "zstd opt in");
  fs.rmSync(dir, { recursive: true });

  const unsupportedDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-sessions-"));
  assert.throws(
    () => new SessionLogStore({
      dir: unsupportedDir,
      env: { SWITCHBOARD_LOG_COMPRESSION: "zstd" },
      compressionRuntime: { gzipSync: zlib.gzipSync, gunzipSync: zlib.gunzipSync },
    }),
    /zstd session log compression is unavailable/,
  );
  fs.rmSync(unsupportedDir, { recursive: true });
});

test("sess-read reports unavailable zstd decoding without crashing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-sessions-"));
  const sid = "session-zstd-unsupported";
  const sessionDir = path.join(dir, sid);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "seg-0.log.zst"), Buffer.from("not decoded"));
  fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify({
    version: 1,
    sid,
    segmentSize: 1024,
    createdAt: 1,
    startedAt: 1,
    updatedAt: 1,
    closedAt: 2,
    status: "closed",
    firstOffset: 0,
    nextOffset: 11,
    bytesStored: 11,
    lastSeg: 0,
    segments: [{
      seg: 0,
      start: 0,
      bytes: 11,
      compression: "zst",
      storedBytes: 11,
      compressionBlocks: [{ offset: 0, bytes: 11, storedOffset: 0, storedBytes: 11 }],
    }],
  }));

  const store = new SessionLogStore({
    dir,
    compressionRuntime: { gzipSync: zlib.gzipSync, gunzipSync: zlib.gunzipSync },
  }).init();
  const response = sessionLogReadResponse(store, { id: "read-zstd", sid, from: 0, len: 11 });
  assert.equal(response.type, "sess-error");
  assert.match(response.message, /zstd session log decompression is unavailable/);
  fs.rmSync(dir, { recursive: true });
});

test("compressed segments use independently readable blocks", async () => {
  const { dir, store } = tempStore({
    segmentSize: 32,
    compressionBlockSize: 4,
  });
  const log = store.open("session-blocks");
  log.append("abcdefghijkl");
  await log.close();

  const sessionDir = path.join(dir, "session-blocks");
  const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8"));
  const segment = meta.segments[0];
  assert.deepEqual(
    segment.compressionBlocks.map(({ offset, bytes, storedOffset, storedBytes }) => ({
      offset, bytes, storedOffset, storedBytes,
    })),
    [
      { offset: 0, bytes: 4, storedOffset: 0, storedBytes: segment.compressionBlocks[0].storedBytes },
      {
        offset: 4,
        bytes: 4,
        storedOffset: segment.compressionBlocks[0].storedBytes,
        storedBytes: segment.compressionBlocks[1].storedBytes,
      },
      {
        offset: 8,
        bytes: 4,
        storedOffset: segment.compressionBlocks[0].storedBytes + segment.compressionBlocks[1].storedBytes,
        storedBytes: segment.compressionBlocks[2].storedBytes,
      },
    ],
  );

  const file = path.join(sessionDir, `seg-0.log.${segment.compression}`);
  const encoded = fs.readFileSync(file);
  encoded[0] ^= 0xff;
  fs.writeFileSync(file, encoded);
  assert.equal(store.read("session-blocks", { from: 4, len: 4 }).data.toString(), "efgh");
  assert.throws(() => store.read("session-blocks", { from: 0, len: 4 }));
  fs.rmSync(dir, { recursive: true });
});

test("legacy whole-segment compression is decompressed once for sequential reads", async () => {
  const { dir, store } = tempStore({ segmentSize: 32 });
  const log = store.open("session-legacy");
  log.append("abcdefghijkl");
  await log.close();

  const sessionDir = path.join(dir, "session-legacy");
  const metaPath = path.join(sessionDir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const compression = meta.segments[0].compression;
  const file = path.join(sessionDir, `seg-0.log.${compression}`);
  const raw = Buffer.from("abcdefghijkl");
  const encoded = compression === "zst"
    ? zlib.zstdCompressSync(raw)
    : zlib.gzipSync(raw);
  fs.writeFileSync(file, encoded);
  delete meta.segments[0].compressionBlocks;
  meta.segments[0].storedBytes = encoded.length;
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const reloaded = new SessionLogStore({ dir, segmentSize: 32 }).init();
  const originalRead = fs.readFileSync;
  let compressedReads = 0;
  fs.readFileSync = function countedRead(target, ...args) {
    if (target === file) compressedReads += 1;
    return originalRead.call(this, target, ...args);
  };
  try {
    assert.equal(reloaded.read("session-legacy", { from: 0, len: 4 }).data.toString(), "abcd");
    assert.equal(reloaded.read("session-legacy", { from: 4, len: 4 }).data.toString(), "efgh");
    assert.equal(reloaded.read("session-legacy", { from: 8, len: 4 }).data.toString(), "ijkl");
    assert.equal(compressedReads, 1);
  } finally {
    fs.readFileSync = originalRead;
  }
  fs.rmSync(dir, { recursive: true });
});

test("close flushes a burst of queued writes before the record becomes closed", async () => {
  const { dir, store } = tempStore({ segmentSize: 31 });
  const log = store.open("session-burst");
  const chunks = Array.from({ length: 300 }, (_, index) => Buffer.from(`${index}:` + "x".repeat(index % 23)));
  for (const chunk of chunks) log.append(chunk);
  await log.close({ exitCode: 0 });

  const expected = Buffer.concat(chunks);
  const reloaded = new SessionLogStore({ dir, segmentSize: 31 }).init();
  assert.deepEqual(reloaded.read("session-burst", { from: 0, len: expected.length + 1 }).data, expected);
  assert.equal(reloaded.stat("session-burst").off, expected.length);
  fs.rmSync(dir, { recursive: true });
});

test("pruning never removes the current or still-flushing segment", async () => {
  const { dir, store } = tempStore({
    segmentSize: 4, maxSessionBytes: 0, maxTotalBytes: 0, retentionMs: 0,
  });
  const log = store.open("session-live");
  log.append("abcdefgh");
  store.prune();

  const sessionDir = path.join(dir, "session-live");
  assert.deepEqual(
    fs.readdirSync(sessionDir).filter((name) => name.endsWith(".log")).sort(),
    ["seg-0.log", "seg-1.log"],
  );
  await log.close();
  assert.deepEqual(fs.readdirSync(sessionDir).filter((name) => name.endsWith(".log")), []);
  fs.rmSync(dir, { recursive: true });
});

test("active reads wait at a flushing segment gap instead of skipping bytes", async () => {
  const { dir, store } = tempStore({ segmentSize: 4 });
  const log = store.open("session-flushing");
  log.append("abcdefgh");
  // Model the observable state while seg-0's queued write is only half on
  // disk. Both segment streams are still pending until this turn yields.
  fs.writeFileSync(path.join(dir, "session-flushing", "seg-0.log"), "ab");
  const first = store.read("session-flushing", { from: 0, len: 8 });
  assert.deepEqual(
    { text: first.data.toString(), off: first.off, next: first.next, eof: first.eof },
    { text: "ab", off: 0, next: 2, eof: false },
  );
  const waiting = store.read("session-flushing", { from: first.next, len: 8 });
  assert.deepEqual(
    { bytes: waiting.data.length, off: waiting.off, next: waiting.next, eof: waiting.eof },
    { bytes: 0, off: 2, next: 2, eof: false },
  );
  await log.close();
  fs.rmSync(dir, { recursive: true });
});

test("initializing another store does not prune a live writer's segment", async () => {
  let now = 1_000;
  const { dir, store } = tempStore({
    segmentSize: 4, maxSessionBytes: 100, maxTotalBytes: 100, retentionMs: 0, now: () => now,
  });
  const log = store.open("session-owned");
  log.append("abc");
  now += 1;

  const observer = new SessionLogStore({
    dir, segmentSize: 4, maxSessionBytes: 100, maxTotalBytes: 100, retentionMs: 0, now: () => now,
  }).init();
  assert.equal(observer.stat("session-owned").status, "running");
  assert.equal(fs.existsSync(path.join(dir, "session-owned", "seg-0.log")), true);

  await log.close();
  fs.rmSync(dir, { recursive: true });
});

test("a replacement store reloads the previous writer before appending", async () => {
  const { dir, store } = tempStore({ segmentSize: 4 });
  const first = store.open("session-handoff");
  first.append("abc");
  const replacement = new SessionLogStore({ dir, segmentSize: 4 }).init();
  first.append("def");
  await first.close();

  const second = replacement.open("session-handoff");
  second.append("ghi");
  await second.close();
  const transcript = replacement.read("session-handoff", { from: 0, len: 20 });
  assert.deepEqual(
    { text: transcript.data.toString(), off: transcript.off, next: transcript.next },
    { text: "abcdefghi", off: 0, next: 9 },
  );
  fs.rmSync(dir, { recursive: true });
});

test("reopening after a short failed write preserves the global offset gap", async () => {
  const { dir, store } = tempStore({ segmentSize: 16 });
  const first = store.open("session-gap");
  first.append("abcd");
  await first.close();

  const metaPath = path.join(dir, "session-gap", "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.nextOffset = 8;
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const reloaded = new SessionLogStore({ dir, segmentSize: 16 }).init();
  const second = reloaded.open("session-gap");
  second.append("Z");
  await second.close();
  assert.equal(reloaded.read("session-gap", { from: 0, len: 20 }).data.toString(), "abcd");
  const afterGap = reloaded.read("session-gap", { from: 4, len: 20 });
  assert.deepEqual(
    { text: afterGap.data.toString(), off: afterGap.off, next: afterGap.next },
    { text: "Z", off: 8, next: 9 },
  );
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
    fs.readdirSync(path.join(dir, "scope-a", "session-a")).filter((name) => /^seg-\d+\.log(?:\.(?:gz|zst))?$/.test(name)),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "scope-b", "session-b")).filter((name) => /^seg-\d+\.log(?:\.(?:gz|zst))?$/.test(name)).map((name) => name.match(/^seg-\d+\.log/)[0]).sort(),
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

test("sess-list and sess-read protocol responses use the persisted store", async () => {
  const { dir, store } = tempStore({ segmentSize: 4 });
  const log = store.open("session-protocol");
  log.append("abcdefghij");
  await log.close({ exitCode: 7 });

  const listed = sessionLogListResponse(store, "list-1");
  assert.equal(listed.type, "sess-list");
  assert.equal(listed.recording, true);
  assert.equal(listed.sessions[0].sid, "session-protocol");

  const first = sessionLogReadResponse(store, {
    id: "read-1", sid: "session-protocol", from: 2, len: 5,
  });
  assert.equal(first.type, "sess-chunk");
  assert.equal(Buffer.from(first.data, "base64").toString(), "cdefg");
  assert.deepEqual(
    { off: first.off, next: first.next, eof: first.eof, exitCode: first.stat.exitCode },
    { off: 2, next: 7, eof: false, exitCode: 7 },
  );

  const rest = sessionLogReadResponse(store, {
    id: "read-2", sid: "session-protocol", from: first.next, len: 64 * 1024,
  });
  assert.equal(Buffer.from(rest.data, "base64").toString(), "hij");
  assert.equal(rest.eof, true);

  assert.deepEqual(sessionLogListResponse(null, "list-off"), {
    type: "sess-list", id: "list-off", recording: false, sessions: [],
  });
  assert.match(
    sessionLogReadResponse(null, { id: "read-off", sid: "session-protocol" }).message,
    /recording is disabled/,
  );
  fs.rmSync(dir, { recursive: true });
});

function compressBytes(value) {
  return zlib.zstdCompressSync ? zlib.zstdCompressSync(value) : zlib.gzipSync(value);
}
function compressExt() {
  return zlib.zstdCompressSync ? "zst" : "gz";
}

test("an interrupted segment roll keeps one logical segment and does not double-count bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-segdup-"));
  const scope = "dup-scope";
  const sid = "dup-session";
  const sessionDir = path.join(dir, scope, sid);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const raw = Buffer.from("HELLO_WORLD_RAW_BYTES_XXXX");
  // Crash window: the compressed sibling has been renamed into place but the
  // raw segment has not been unlinked yet, and meta.json still lacks the
  // compression marker.
  fs.writeFileSync(path.join(sessionDir, "seg-0.log"), raw, { mode: 0o600 });
  fs.writeFileSync(path.join(sessionDir, `seg-0.log.${compressExt()}`), compressBytes(raw), { mode: 0o600 });
  fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify({
    version: 1, sid, scope, segmentSize: 1024,
    createdAt: 1, startedAt: 1, updatedAt: 1, closedAt: 2, status: "closed",
    pid: null, error: null, exitCode: 0, firstOffset: 0, nextOffset: raw.length,
    bytesStored: raw.length, lastSeg: 0,
    segments: [{ seg: 0, start: 0, bytes: raw.length, createdAt: 1, updatedAt: 1 }],
    cols: 80, rows: 24,
  }), { mode: 0o600 });

  const store = new SessionLogStore({ dir, scope }).init();
  const stat = store.stat(sid);
  assert.equal(stat.bytes, raw.length, "bytes must not count the raw leftover twice");
  assert.equal(stat.segments, 1);
  assert.equal(stat.off, raw.length);
  const chunk = store.read(sid, { from: 0, len: 1024 });
  assert.equal(chunk.data.toString(), raw.toString());
  assert.deepEqual({ off: chunk.off, next: chunk.next }, { off: 0, next: raw.length });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a stale compression marker never makes an uncompressed segment unreadable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-segraw-"));
  const scope = "raw-scope";
  const sid = "raw-session";
  const sessionDir = path.join(dir, scope, sid);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const raw = Buffer.from("PLAIN_TEXT_SEGMENT_BYTES");
  fs.writeFileSync(path.join(sessionDir, "seg-0.log"), raw, { mode: 0o600 });
  fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify({
    version: 1, sid, scope, segmentSize: 1024,
    createdAt: 1, startedAt: 1, updatedAt: 1, closedAt: 2, status: "closed",
    pid: null, error: null, exitCode: 0, firstOffset: 0, nextOffset: raw.length,
    bytesStored: raw.length, lastSeg: 0,
    segments: [{
      seg: 0, start: 0, bytes: raw.length, createdAt: 1, updatedAt: 1,
      compression: compressExt(), storedBytes: 12,
    }],
    cols: 80, rows: 24,
  }), { mode: 0o600 });

  const store = new SessionLogStore({ dir, scope }).init();
  const chunk = store.read(sid, { from: 0, len: 1024 });
  assert.equal(chunk.data.toString(), raw.toString());
  assert.equal(store.stat(sid).bytes, raw.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("one unreadable session record cannot stop the store from loading the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-segbroken-"));
  const scope = "broken-scope";
  const good = path.join(dir, scope, "good-session");
  const bad = path.join(dir, scope, "bad-session");
  fs.mkdirSync(good, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bad, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(good, "seg-0.log"), Buffer.from("GOOD"), { mode: 0o600 });
  fs.writeFileSync(path.join(good, "meta.json"), JSON.stringify({
    version: 1, sid: "good-session", scope, segmentSize: 1024,
    createdAt: 1, startedAt: 1, updatedAt: 1, closedAt: 2, status: "closed",
    firstOffset: 0, nextOffset: 4, bytesStored: 4, lastSeg: 0,
    segments: [{ seg: 0, start: 0, bytes: 4, createdAt: 1, updatedAt: 1 }],
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(bad, "seg-0.log"), Buffer.from("BAD"), { mode: 0o600 });
  fs.writeFileSync(path.join(bad, "meta.json"), JSON.stringify({
    version: 1, sid: "bad-session", scope, segmentSize: 1024,
    createdAt: 1, startedAt: 1, updatedAt: 1, closedAt: 2, status: "closed",
    firstOffset: 0, nextOffset: 3, bytesStored: 3, lastSeg: 0,
    segments: [{ seg: 0, start: 0, bytes: 3, createdAt: 1, updatedAt: 1 }],
  }), { mode: 0o600 });

  const originalStatSync = fs.statSync;
  fs.statSync = (file, ...args) => {
    if (path.dirname(String(file)) === bad) throw Object.assign(new Error("unreadable record"), { code: "EIO" });
    return originalStatSync(file, ...args);
  };
  let store;
  try {
    store = new SessionLogStore({ dir, scope }).init();
  } finally {
    fs.statSync = originalStatSync;
  }
  const sids = store.list().map((entry) => entry.sid);
  assert.ok(sids.includes("good-session"), `expected good-session in ${sids}`);
  assert.ok(!sids.includes("bad-session"), `did not expect bad-session in ${sids}`);
  assert.equal(store.read("good-session", { from: 0, len: 10 }).data.toString(), "GOOD");
  fs.rmSync(dir, { recursive: true, force: true });
});
