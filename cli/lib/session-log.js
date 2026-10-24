const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Segment encryption intentionally remains an interface seam: compressed bytes
// can later be passed through AES-GCM here without changing logical offsets.
function compressionCodec(env = process.env, runtime = zlib) {
  const requested = String(env.SWITCHBOARD_LOG_COMPRESSION || "gzip").trim().toLowerCase();
  if (requested === "zstd") {
    if (!runtime.zstdCompressSync || !runtime.zstdDecompressSync) {
      throw new Error("zstd session log compression is unavailable in this Node.js runtime");
    }
    return { ext: ".zst", encode: runtime.zstdCompressSync };
  }
  if (requested !== "gzip" && requested !== "gz") {
    throw new Error(`unsupported session log compression: ${requested}`);
  }
  return { ext: ".gz", encode: runtime.gzipSync };
}

const DEFAULT_SEGMENT_SIZE = 16 * 1024 * 1024;
const DEFAULT_INDEX_BYTES = 64 * 1024;
const DEFAULT_INDEX_INTERVAL_MS = 1000;
const DEFAULT_MAX_SESSION_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_READ_LENGTH = 64 * 1024;
const DEFAULT_COMPRESSION_BLOCK_SIZE = 512 * 1024;
const LEGACY_CACHE_ENTRIES = 4;
const ALT_SCREEN_RE = /\x1b\[\?(?:47|1047|1049)([hl])/g;

function alternateApplication(line) {
  const match = String(line).match(/(?:^|[\s$#;|&])(vim?|nvim|nano|less|more|man|top|htop|ssh|tmux)(?=\s|$)/i);
  return match ? match[1].toLowerCase() : "fullscreen";
}

function rememberOutputLine(tracker, text) {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");
  const parts = clean.split("\n");
  tracker.line += parts[0];
  for (let index = 1; index < parts.length; index++) {
    if (tracker.line.trim()) tracker.lastLine = tracker.line;
    tracker.line = parts[index];
  }
}

function scanAlternateScreens(state, chunk, startOffset, now, emit) {
  const prefix = state.altScan.pending;
  const input = prefix + chunk.toString("latin1");
  const baseOffset = startOffset - Buffer.byteLength(prefix, "latin1");
  state.altScan.pending = "";
  let cursor = 0;
  ALT_SCREEN_RE.lastIndex = 0;
  for (let match; (match = ALT_SCREEN_RE.exec(input));) {
    if (!state.altScan.active) rememberOutputLine(state.altScan, input.slice(cursor, match.index));
    const offset = baseOffset + match.index;
    if (match[1] === "h" && !state.altScan.active) {
      state.altScan.active = {
        start: offset,
        startedAt: now,
        application: alternateApplication(state.altScan.line || state.altScan.lastLine),
      };
      emit({ type: "alternate-screen-enter", off: offset, ...state.altScan.active });
    } else if (match[1] === "l" && state.altScan.active) {
      const interval = {
        type: "alternate-screen-exit",
        off: offset + match[0].length,
        ...state.altScan.active,
        end: offset + match[0].length,
        endedAt: now,
      };
      emit(interval);
      state.altScan.active = null;
    }
    cursor = match.index + match[0].length;
  }
  const rest = input.slice(cursor);
  const incomplete = rest.match(/\x1b(?:\[(?:\?(?:\d*)?)?)?$/);
  const safe = incomplete ? rest.slice(0, incomplete.index) : rest;
  if (!state.altScan.active) rememberOutputLine(state.altScan, safe);
  if (incomplete) state.altScan.pending = incomplete[0];
}

class SessionLogStore {
  constructor(options) {
    if (!options?.dir) throw new Error("session log directory is required");
    if (options.scope != null && !validId(options.scope)) throw new Error("invalid session log scope");
    this.rootDir = options.dir;
    this.scope = options.scope || null;
    this.dir = this.scope ? path.join(this.rootDir, this.scope) : this.rootDir;
    this.segmentSize = positiveInt(options.segmentSize ?? options.segmentBytes, DEFAULT_SEGMENT_SIZE);
    this.indexBytes = positiveInt(options.indexBytes, DEFAULT_INDEX_BYTES);
    this.indexIntervalMs = positiveInt(options.indexIntervalMs, DEFAULT_INDEX_INTERVAL_MS);
    this.maxSessionBytes = nonNegativeInt(options.maxSessionBytes, DEFAULT_MAX_SESSION_BYTES);
    this.maxTotalBytes = nonNegativeInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.retentionMs = nonNegativeInt(options.retentionMs, DEFAULT_RETENTION_MS);
    this.compressionRuntime = options.compressionRuntime || zlib;
    this.compression = compressionCodec(options.env, this.compressionRuntime);
    this.compressionBlockSize = positiveInt(
      options.compressionBlockSize,
      DEFAULT_COMPRESSION_BLOCK_SIZE,
    );
    this.now = options.now || Date.now;
    this.records = new Map();
    this.legacyCompressionCache = new Map();
    this.active = new Map();
    this.pruneScheduled = false;
  }

  init() {
    secureDir(this.rootDir);
    secureDir(this.dir);
    for (const entry of safeReadDir(this.dir)) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      let record;
      try { record = this._loadRecord(entry.name); } catch { continue; }
      if (!record) continue;
      // A replacement daemon can initialize this store before the relay has
      // disconnected the old one. Do not make its live segment prunable.
      if (record.status === "running" && !pidAlive(record.pid)) {
        record.status = "interrupted";
        record.pid = null;
        record.closedAt = this.now();
        record.updatedAt = record.closedAt;
        record.error ||= "daemon stopped while this session was running";
        this._persist(record);
      }
      this.records.set(entry.name, record);
    }
    this.prune();
    return this;
  }

  open(sid, info = {}) {
    if (!validId(sid)) throw new Error("invalid session id");
    if (this.active.has(sid)) return this.active.get(sid).handle;
    const sessionDir = this.sessionDir(sid);
    secureDir(sessionDir);
    // Opening is cold-path work. Reload from disk first so a daemon that
    // overlapped its predecessor sees the predecessor's final bytes and state.
    let record = this._loadRecord(sid) || this.records.get(sid);
    const now = this.now();
    if (record?.status === "running" && record.pid !== process.pid && pidAlive(record.pid)) {
      throw Object.assign(new Error("session log is still owned by another daemon"), { code: "EBUSY" });
    }
    if (!record) {
      record = {
        version: 1,
        sid,
        publicSid: validId(info.sid) ? info.sid : sid,
        ownerAccountId: typeof info.ownerAccountId === "string" && info.ownerAccountId
          ? info.ownerAccountId : null,
        legacy: !!info.legacy,
        scope: this.scope,
        segmentSize: this.segmentSize,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
        closedAt: null,
        status: "running",
        pid: process.pid,
        error: null,
        exitCode: null,
        firstOffset: 0,
        nextOffset: 0,
        bytesStored: 0,
        lastSeg: -1,
        segments: [],
        cols: positiveInt(info.cols, null),
        rows: positiveInt(info.rows, null),
      };
    } else {
      record.status = "running";
      record.pid = process.pid;
      record.closedAt = null;
      record.error = null;
      record.exitCode = null;
      record.updatedAt = now;
      if (info.cols > 0) record.cols = Math.floor(info.cols);
      if (info.rows > 0) record.rows = Math.floor(info.rows);
      if (!record.publicSid && validId(info.sid)) record.publicSid = info.sid;
      if (!record.ownerAccountId && typeof info.ownerAccountId === "string" && info.ownerAccountId) {
        record.ownerAccountId = info.ownerAccountId;
        record.legacy = !!info.legacy;
      }
    }
    this.records.set(sid, record);

    const indexPath = path.join(sessionDir, "index.jsonl");
    touchPrivate(indexPath);
    const state = {
      record,
      writer: null,
      indexWriter: fs.createWriteStream(indexPath, { flags: "a", mode: 0o600 }),
      segment: null,
      pending: new Set(),
      pendingSegments: new Set(),
      backpressure: new Set(),
      failed: null,
      closing: false,
      closePromise: null,
      lastIndexOff: record.nextOffset,
      lastIndexAt: now,
      altScan: { pending: "", active: null, line: "", lastLine: "" },
      indexTimer: null,
      handle: null,
    };
    state.indexWriter.on("error", (error) => { state.failed ||= error; });
    this.active.set(sid, state);
    this._ensureSegment(state);
    state.handle = new SessionLogHandle(this, sid);
    this._writeIndex(state);
    state.indexTimer = setInterval(() => {
      if (!state.closing && state.record.nextOffset !== state.lastIndexOff) this._writeIndex(state);
    }, this.indexIntervalMs);
    state.indexTimer.unref?.();
    this._persist(record);
    return state.handle;
  }

  append(sid, value) {
    const state = this.active.get(sid);
    if (!state || state.closing || state.failed) return true;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!chunk.length) return true;
    const appendOffset = state.record.nextOffset;
    const appendTime = this.now();
    scanAlternateScreens(state, chunk, appendOffset, appendTime, (event) => {
      this._writeIndex(state, event);
    });
    let position = 0;
    let writable = true;
    while (position < chunk.length) {
      this._ensureSegment(state);
      const room = state.record.segmentSize - state.segment.bytes;
      if (room <= 0) {
        this._rollSegment(state);
        continue;
      }
      const piece = chunk.subarray(position, position + Math.min(room, chunk.length - position));
      const ok = state.writer.write(piece);
      state.segment.bytes += piece.length;
      state.segment.updatedAt = this.now();
      state.record.nextOffset += piece.length;
      state.record.bytesStored += piece.length;
      state.record.updatedAt = state.segment.updatedAt;
      position += piece.length;
      if (!ok) {
        writable = false;
        const wait = streamDrain(state.writer);
        state.backpressure.add(wait);
        wait.finally(() => state.backpressure.delete(wait));
      }
    }
    if (state.record.nextOffset - state.lastIndexOff >= this.indexBytes ||
        this.now() - state.lastIndexAt >= this.indexIntervalMs) this._writeIndex(state);
    return writable;
  }

  resize(sid, cols, rows) {
    const state = this.active.get(sid);
    if (!state || state.closing || !(cols > 0 && rows > 0)) return false;
    state.record.cols = Math.floor(cols);
    state.record.rows = Math.floor(rows);
    state.record.updatedAt = this.now();
    this._writeIndex(state, {
      type: "resize",
      cols: state.record.cols,
      rows: state.record.rows,
      resize: { cols: state.record.cols, rows: state.record.rows },
    });
    return true;
  }

  async drain(sid) {
    const state = this.active.get(sid);
    while (state?.backpressure.size) await Promise.all([...state.backpressure]);
  }

  async flush(sid) {
    const state = this.active.get(sid);
    if (!state || state.closing) return;
    await Promise.all([...state.pending]);
    if (!state.writer || state.writer.destroyed || state.writer.closed) return;
    await new Promise((resolve) => state.writer.write(Buffer.alloc(0), resolve));
  }

  close(sid, result = {}) {
    const state = this.active.get(sid);
    if (!state) return Promise.resolve(this.stat(sid));
    if (state.closePromise) return state.closePromise;
    state.closing = true;
    clearInterval(state.indexTimer);
    if (state.altScan.active) {
      const endedAt = this.now();
      this._writeIndex(state, {
        type: "alternate-screen-exit",
        off: state.record.nextOffset,
        ...state.altScan.active,
        end: state.record.nextOffset,
        endedAt,
      });
      state.altScan.active = null;
    }
    this._writeIndex(state, { type: "close" });
    const segmentDone = this._endSegmentWriter(state);
    const indexDone = closeStream(state.indexWriter);
    state.pending.add(indexDone);
    indexDone.finally(() => state.pending.delete(indexDone));
    state.closePromise = Promise.all([...state.pending, segmentDone]).then(() => {
      const record = state.record;
      this._reconcileSegments(record);
      record.status = result.status || "closed";
      record.pid = null;
      record.closedAt = this.now();
      record.updatedAt = record.closedAt;
      record.exitCode = result.exitCode ?? null;
      record.error = result.error || state.failed?.message || null;
      this.active.delete(sid);
      this._persist(record);
      this.prune();
      return this.stat(sid);
    });
    return state.closePromise;
  }

  closeAll(result = {}) {
    return Promise.all([...this.active.keys()].map((sid) => this.close(sid, result)));
  }

  read(sid, options = {}) {
    if (sid && typeof sid === "object") { options = sid; sid = options.sid; }
    const record = this.records.get(sid) || this._loadRecord(sid);
    if (!record) throw Object.assign(new Error("no such session"), { code: "ENOENT" });
    const requested = finiteOffset(options.from);
    const length = nonNegativeInt(options.len, DEFAULT_READ_LENGTH);
    const segments = this._readableSegments(record);
    const first = segments.length ? segments[0].start : record.nextOffset;
    const logicalEnd = record.nextOffset;
    const readableEnd = segments.length
      ? Math.max(...segments.map((segment) => segment.start + segment.size))
      : logicalEnd;
    const activeState = this.active.get(sid);
    const activelyWriting = !!activeState && !activeState.failed;
    let cursor = Math.max(first, Math.min(requested, logicalEnd));
    const parts = [];
    let remaining = length;
    let off = cursor;
    let found = false;
    for (const segment of segments) {
      const end = segment.start + segment.size;
      const logicalSegmentEnd = segment.start + segment.bytes;
      if (cursor >= logicalSegmentEnd) continue;
      if (cursor >= end) {
        // A rolled stream can still be flushing while the next stream already
        // has bytes. Do not jump that temporary gap and mislabel later bytes.
        if (activelyWriting) {
          if (!found) { off = cursor; found = true; }
          break;
        }
        cursor = logicalSegmentEnd;
        continue;
      }
      if (cursor < segment.start) {
        if (found) break;
        cursor = segment.start;
      }
      if (!found) { off = cursor; found = true; }
      if (!remaining) break;
      const available = end - cursor;
      const take = Math.min(remaining, available);
      let buffer;
      let bytesRead = 0;
      if (segment.compression) {
        buffer = this._readCompressedSegment(
          segment,
          cursor - segment.start,
          take,
        );
        bytesRead = buffer.length;
      } else {
        const fd = fs.openSync(segment.file, "r");
        try {
          buffer = Buffer.allocUnsafe(take);
          bytesRead = take ? fs.readSync(fd, buffer, 0, take, cursor - segment.start) : 0;
          buffer = buffer.subarray(0, bytesRead);
        } finally {
          fs.closeSync(fd);
        }
      }
      if (bytesRead) parts.push(buffer);
      cursor += bytesRead;
      remaining -= bytesRead;
      if (bytesRead < take || cursor < logicalSegmentEnd) break;
    }
    if (!found) off = cursor;
    const data = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    const next = off + data.length;
    const stat = this._publicStat(record, segments);
    const alternateScreens = this._alternateScreens(record, off, next);
    return {
      data,
      off,
      next,
      alternateScreens,
      eof: next >= (activeState && !activeState.failed ? logicalEnd : readableEnd),
      from: first,
      size: logicalEnd,
      active: this.active.has(sid),
      stat,
    };
  }

  _alternateScreens(record, from, to) {
    const file = path.join(record._dir || this.sessionDir(record.sid), "index.jsonl");
    let lines;
    try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return []; }
    const intervals = [];
    let active = null;
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "alternate-screen-enter") {
        active = {
          start: entry.start,
          startedAt: entry.startedAt,
          application: entry.application || "fullscreen",
        };
        continue;
      }
      if (entry.type !== "alternate-screen-exit") continue;
      active = null;
      if (entry.end > from && entry.start < to) {
        intervals.push({
          start: entry.start,
          end: entry.end,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          application: entry.application || "fullscreen",
        });
      }
    }
    if (active && record.nextOffset > from && active.start < to) {
      intervals.push({
        ...active,
        end: record.nextOffset,
        active: true,
      });
    }
    return intervals;
  }

  tail(sid, bytes) {
    if (sid && typeof sid === "object") { bytes = sid.n ?? sid.bytes; sid = sid.sid; }
    const record = this.records.get(sid) || this._loadRecord(sid);
    if (!record) throw Object.assign(new Error("no such session"), { code: "ENOENT" });
    const first = this._firstReadableOffset(record);
    const length = nonNegativeInt(bytes, 0);
    return this.read(sid, { from: Math.max(first, record.nextOffset - length), len: length });
  }

  stat(sid) {
    const record = this.records.get(sid) || this._loadRecord(sid);
    if (!record) return null;
    if (!this.records.has(sid)) this.records.set(sid, record);
    return this._publicStat(record);
  }

  list(predicate = null) {
    return [...this.records.values()]
      .filter((record) => this.active.has(record.sid) || record.segments.length ||
        this.now() - (record.closedAt || record.updatedAt || record.createdAt) <= this.retentionMs)
      .filter((record) => !predicate || predicate(this._publicStat(record)))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((record) => this._publicStat(record));
  }

  assignLegacyOwner(ownerAccountId) {
    if (typeof ownerAccountId !== "string" || !ownerAccountId) return 0;
    let changed = 0;
    for (const record of this.records.values()) {
      if (record.ownerAccountId) continue;
      record.ownerAccountId = ownerAccountId;
      record.publicSid ||= record.sid;
      record.legacy = true;
      record.updatedAt = this.now();
      this._persist(record);
      changed++;
    }
    return changed;
  }

  prune() {
    const now = this.now();
    const sessions = this._allSessionRecords();
    const touched = new Set();
    const remove = (item) => {
      try { fs.unlinkSync(item.file); } catch (error) { if (error.code !== "ENOENT") return false; }
      const record = item.record;
      record.segments = record.segments.filter((segment) => segment.seg !== item.segment.seg);
      record.bytesStored = Math.max(0, record.bytesStored - item.size);
      record.firstOffset = record.segments.length
        ? Math.min(...record.segments.map((segment) => segment.start))
        : record.nextOffset;
      touched.add(record);
      return true;
    };

    for (const item of sessions.flatMap((record) => this._prunableSegments(record))) {
      if (now - item.updatedAt > this.retentionMs) remove(item);
    }
    for (const record of sessions) {
      let items = this._prunableSegments(record).sort(oldestFirst);
      while (record.bytesStored > this.maxSessionBytes && items.length) {
        const item = items.shift();
        if (!remove(item)) break;
      }
    }
    let total = sessions.reduce((sum, record) => sum + record.bytesStored, 0);
    const all = sessions.flatMap((record) => this._prunableSegments(record)).sort(oldestFirst);
    while (total > this.maxTotalBytes && all.length) {
      const item = all.shift();
      if (item.record.segments.some((segment) => segment.seg === item.segment.seg) && remove(item)) {
        total -= item.size;
      }
    }
    for (const record of touched) {
      this._persistRecordAt(record);
    }
  }

  sessionDir(sid) { return path.join(this.dir, sid); }

  _ensureSegment(state) {
    if (state.writer && state.segment && state.segment.bytes < state.record.segmentSize) return;
    if (state.writer) this._rollSegment(state);
    if (state.writer) return;
    const record = state.record;
    let segment = record.segments.at(-1);
    if (!segment || segment.bytes >= record.segmentSize ||
        segment.start + segment.bytes !== record.nextOffset ||
        !fs.existsSync(this.segmentPath(record.sid, segment.seg))) {
      const now = this.now();
      segment = {
        seg: record.lastSeg + 1,
        start: record.nextOffset,
        bytes: 0,
        createdAt: now,
        updatedAt: now,
      };
      record.lastSeg = segment.seg;
      record.segments.push(segment);
      if (record.segments.length === 1) record.firstOffset = segment.start;
    }
    const file = this.segmentPath(record.sid, segment.seg);
    touchPrivate(file);
    state.segment = segment;
    state.writer = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
    state.writer.on("error", (error) => { state.failed ||= error; });
    this._persist(record);
  }

  _rollSegment(state) {
    this._endSegmentWriter(state);
    state.writer = null;
    state.segment = null;
    this._ensureSegment(state);
    this._schedulePrune();
  }

  _endSegmentWriter(state) {
    const writer = state.writer;
    if (!writer) return Promise.resolve();
    const seg = state.segment?.seg;
    state.pendingSegments.add(seg);
    const done = closeStream(writer).then(() => this._compressSegment(state.record, seg));
    state.pending.add(done);
    done.catch((error) => { state.failed ||= error; }).finally(() => {
      state.pending.delete(done);
      state.pendingSegments.delete(seg);
      if (!state.closing) this._schedulePrune();
    });
    return done;
  }

  _compressSegment(record, seg) {
    const segment = record.segments.find((item) => item.seg === seg);
    if (!segment || segment.compression) return;
    const source = this.segmentPath(record.sid, seg);
    let input;
    try { input = fs.readFileSync(source); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const target = source + this.compression.ext;
    const temporary = target + `.tmp-${process.pid}`;
    const parts = [];
    const blocks = [];
    let storedOffset = 0;
    for (let offset = 0; offset < input.length; offset += this.compressionBlockSize) {
      const raw = input.subarray(offset, offset + this.compressionBlockSize);
      const compressed = this.compression.encode(raw);
      parts.push(compressed);
      blocks.push({
        offset,
        bytes: raw.length,
        storedOffset,
        storedBytes: compressed.length,
      });
      storedOffset += compressed.length;
    }
    fs.writeFileSync(temporary, Buffer.concat(parts), { mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.unlinkSync(source);
    segment.bytes = input.length;
    segment.compression = this.compression.ext.slice(1);
    segment.compressionBlocks = blocks;
    segment.storedBytes = storedOffset;
    this._persist(record);
  }

  _readCompressedSegment(segment, offset, length) {
    if (!segment.compressionBlocks?.length) {
      const key = `${segment.file}:${segment.storedBytes || 0}`;
      let raw = this.legacyCompressionCache.get(key);
      if (raw) {
        this.legacyCompressionCache.delete(key);
        this.legacyCompressionCache.set(key, raw);
      } else {
        raw = decompressSegment(segment.file, segment.compression, this.compressionRuntime);
        this.legacyCompressionCache.set(key, raw);
        while (this.legacyCompressionCache.size > LEGACY_CACHE_ENTRIES) {
          this.legacyCompressionCache.delete(this.legacyCompressionCache.keys().next().value);
        }
      }
      return raw.subarray(offset, offset + length);
    }

    const end = offset + length;
    const parts = [];
    const fd = fs.openSync(segment.file, "r");
    try {
      for (const block of segment.compressionBlocks) {
        const blockEnd = block.offset + block.bytes;
        if (blockEnd <= offset || block.offset >= end) continue;
        const encoded = Buffer.allocUnsafe(block.storedBytes);
        const read = fs.readSync(fd, encoded, 0, block.storedBytes, block.storedOffset);
        if (read !== block.storedBytes) throw new Error("truncated compressed session block");
        const raw = decompressBuffer(encoded, segment.compression, this.compressionRuntime);
        const from = Math.max(offset, block.offset) - block.offset;
        const to = Math.min(end, blockEnd) - block.offset;
        parts.push(raw.subarray(from, to));
      }
    } finally {
      fs.closeSync(fd);
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  _writeIndex(state, extra = null) {
    if (!state.indexWriter || state.indexWriter.destroyed) return;
    const now = this.now();
    const entry = {
      off: state.record.nextOffset,
      ts: now,
      seg: state.segment?.seg ?? state.record.lastSeg,
      ...(extra || {}),
    };
    state.indexWriter.write(JSON.stringify(entry) + "\n");
    state.lastIndexOff = entry.off;
    state.lastIndexAt = now;
  }

  _loadRecord(sid) {
    if (!validId(sid)) return null;
    const sessionDir = this.sessionDir(sid);
    const record = loadRecordAt(sessionDir, sid, this.scope, this.segmentSize, this.now);
    if (!record) return null;
    for (const segment of record.segments) {
      try { fs.chmodSync(segmentFile(sessionDir, segment), 0o600); } catch {}
    }
    for (const name of ["meta.json", "index.jsonl"]) {
      try { fs.chmodSync(path.join(sessionDir, name), 0o600); } catch {}
    }
    return record;
  }

  _publicStat(record, readable = this._readableSegments(record)) {
    const state = this.active.get(record.sid);
    const active = !!state && !state.failed;
    const first = readable[0]?.start ?? record.nextOffset;
    return {
      sid: record.publicSid || record.sid,
      storageId: record.sid,
      ownerAccountId: record.ownerAccountId || null,
      legacy: !!record.legacy,
      status: active ? "running" : state?.failed ? "recording-error" : record.status,
      active,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      closedAt: active ? null : record.closedAt,
      endedAt: active ? null : record.closedAt,
      from: first,
      off: record.nextOffset,
      bytes: readable.reduce((sum, segment) => sum + segment.size, 0),
      segments: readable.length,
      cols: record.cols || null,
      rows: record.rows || null,
      exitCode: record.exitCode,
      error: state?.failed?.message || record.error,
    };
  }

  _readableSegments(record) {
    const sessionDir = record._dir || this.sessionDir(record.sid);
    const state = record.scope === this.scope ? this.active.get(record.sid) : null;
    const firstFile = record.segments[0] && segmentFile(sessionDir, record.segments[0]);
    // A daemon for another scope may enforce the global quota and persist a
    // shorter prefix. Refresh only when that is observable, keeping normal
    // reads to O(1) filesystem metadata calls rather than one per segment.
    if (!state && (record.status === "running" || (firstFile && !fs.existsSync(firstFile)))) {
      const refreshed = loadRecordAt(sessionDir, record.sid, record.scope, record.segmentSize, this.now);
      if (refreshed) Object.assign(record, refreshed);
    }
    return record.segments.map((segment) => {
      const file = segmentFile(sessionDir, segment);
      // Closed streams were reconciled when loaded or closed, so their saved
      // byte counts are stable. Only streams that can still have buffered
      // writes need a stat on every read.
      if (segment.compression || !state || (state.segment?.seg !== segment.seg && !state.pendingSegments.has(segment.seg))) {
        return { ...segment, file, size: segment.bytes };
      }
      try { return { ...segment, file, size: fs.statSync(file).size }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.start - b.start);
  }

  _reconcileSegments(record) {
    const sessionDir = record._dir || this.sessionDir(record.sid);
    record.segments = record.segments.map((segment) => {
      try {
        if (segment.compression) {
          fs.statSync(segmentFile(sessionDir, segment));
          return segment;
        }
        return { ...segment, bytes: fs.statSync(segmentFile(sessionDir, segment)).size };
      } catch {
        return null;
      }
    }).filter(Boolean);
    record.bytesStored = record.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    record.firstOffset = record.segments[0]?.start ?? record.nextOffset;
  }

  _firstReadableOffset(record) {
    const first = this._readableSegments(record)[0];
    return first ? first.start : record.nextOffset;
  }

  _allSessionRecords() {
    const records = [];
    const seen = new Set();
    const add = (record) => {
      if (!record) return;
      const key = record._dir || this.sessionDir(record.sid);
      if (!seen.has(key)) { seen.add(key); records.push(record); }
    };
    for (const record of this.records.values()) add(record);
    if (!this.scope) return records;
    for (const scopeEntry of safeReadDir(this.rootDir)) {
      if (!scopeEntry.isDirectory() || !validId(scopeEntry.name)) continue;
      const scopeDir = path.join(this.rootDir, scopeEntry.name);
      for (const sidEntry of safeReadDir(scopeDir)) {
        if (!sidEntry.isDirectory() || !validId(sidEntry.name)) continue;
        const location = path.join(scopeDir, sidEntry.name);
        if (seen.has(location)) continue;
        try { add(loadRecordAt(location, sidEntry.name, scopeEntry.name, this.segmentSize, this.now)); }
        catch {}
      }
    }
    return records;
  }

  _prunableSegments(record) {
    const state = record.scope === this.scope ? this.active.get(record.sid) : null;
    const sessionDir = record._dir || this.sessionDir(record.sid);
    // Another circuit may have its own daemon writing under this global root.
    // Its metadata cannot tell us which rotated stream is still flushing, so
    // leave that live record alone; its own store enforces the same quotas.
    if (!state && record.status === "running" && pidAlive(record.pid)) return [];
    return record.segments.filter((segment) => {
      if (state?.pendingSegments.has(segment.seg)) return false;
      if ((state || record.status === "running") && segment.seg === record.lastSeg) return false;
      return true;
    }).map((segment) => ({
      record,
      segment,
      file: segmentFile(sessionDir, segment),
      size: segment.bytes,
      updatedAt: segment.updatedAt || record.updatedAt || record.createdAt,
    }));
  }

  _persist(record) {
    record._dir = this.sessionDir(record.sid);
    this._persistRecordAt(record);
  }

  _persistRecordAt(record) {
    const sessionDir = record._dir || this.sessionDir(record.sid);
    secureDir(sessionDir);
    const file = path.join(sessionDir, "meta.json");
    const temp = file + `.tmp-${process.pid}`;
    const output = { ...record };
    delete output._dir;
    fs.writeFileSync(temp, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  _schedulePrune() {
    if (this.pruneScheduled) return;
    this.pruneScheduled = true;
    setImmediate(() => {
      this.pruneScheduled = false;
      try { this.prune(); } catch {}
    }).unref?.();
  }

  segmentPath(sid, seg) { return path.join(this.sessionDir(sid), `seg-${seg}.log`); }
}

class SessionLogHandle {
  constructor(store, sid) { this.store = store; this.sid = sid; }
  append(value) { return this.store.append(this.sid, value); }
  resize(cols, rows) { return this.store.resize(this.sid, cols, rows); }
  drain() { return this.store.drain(this.sid); }
  flush() { return this.store.flush(this.sid); }
  close(result) { return this.store.close(this.sid, result); }
  read(options) { return this.store.read(this.sid, options); }
  tail(bytes) { return this.store.tail(this.sid, bytes); }
  stat() { return this.store.stat(this.sid); }
}

function loadRecordAt(sessionDir, sid, scope, segmentSize, now) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8")); } catch {}
  const discovered = safeReadDir(sessionDir)
    .map((entry) => ({ entry, match: /^seg-(\d+)\.log(?:\.(gz|zst))?$/.exec(entry.name) }))
    .filter(({ entry, match }) => entry.isFile() && match)
    .map(({ entry, match }) => ({ name: entry.name, seg: Number(match[1]), compression: match[2] || null }));
  // A crash between the compressed rename and the raw unlink can leave both
  // seg-N.log and its compressed sibling. Keep one entry per N, preferring the
  // compressed file that compression already committed to disk.
  const bySeg = new Map();
  for (const file of discovered) {
    const existing = bySeg.get(file.seg);
    if (!existing || (file.compression && !existing.compression)) bySeg.set(file.seg, file);
  }
  const files = [...bySeg.values()].sort((a, b) => a.seg - b.seg);
  if (!files.length && !meta.sid) return null;
  const saved = new Map((Array.isArray(meta.segments) ? meta.segments : [])
    .filter((segment) => Number.isSafeInteger(segment.seg))
    .map((segment) => [segment.seg, segment]));
  let inferredStart = finiteOffset(meta.firstOffset);
  const segments = files.map((file) => {
    const st = fs.statSync(path.join(sessionDir, file.name));
    const prior = saved.get(file.seg);
    const start = Number.isSafeInteger(prior?.start) ? prior.start : inferredStart;
    // The filename is authoritative: a stale meta.compression must not be
    // applied to an uncompressed sibling left behind by an interrupted roll.
    const compression = file.compression;
    let bytes;
    if (compression) {
      // Only decompress to recover the logical length when meta cannot tell us.
      if (Number.isSafeInteger(prior?.bytes) && prior.bytes >= 0) {
        bytes = prior.bytes;
      } else {
        try { bytes = decompressSegment(path.join(sessionDir, file.name), compression).length; }
        catch { return null; }
      }
    } else {
      bytes = st.size;
    }
    const segment = {
      seg: file.seg,
      start,
      bytes,
      ...(compression ? {
        compression,
        storedBytes: st.size,
        ...(Array.isArray(prior?.compressionBlocks)
          ? { compressionBlocks: prior.compressionBlocks }
          : {}),
      } : {}),
      createdAt: prior?.createdAt || st.birthtimeMs || st.mtimeMs,
      updatedAt: Math.max(Number(prior?.updatedAt) || 0, st.mtimeMs),
    };
    inferredStart = start + bytes;
    return segment;
  }).filter(Boolean);
  const ends = segments.map((segment) => segment.start + segment.bytes);
  const nextOffset = Math.max(finiteOffset(meta.nextOffset), ...ends, 0);
  const createdAt = Number(meta.createdAt) || segments[0]?.createdAt || now();
  return {
    ...meta,
    version: 1,
    sid,
    publicSid: validId(meta.publicSid) ? meta.publicSid : sid,
    ownerAccountId: typeof meta.ownerAccountId === "string" && meta.ownerAccountId
      ? meta.ownerAccountId : null,
    legacy: !!meta.legacy,
    scope,
    segmentSize: positiveInt(meta.segmentSize, segmentSize),
    createdAt,
    startedAt: Number(meta.startedAt) || createdAt,
    updatedAt: Number(meta.updatedAt) || segments.at(-1)?.updatedAt || createdAt,
    closedAt: Number(meta.closedAt) || null,
    status: meta.status || "closed",
    error: meta.error || null,
    exitCode: meta.exitCode ?? null,
    firstOffset: segments.length ? segments[0].start : nextOffset,
    nextOffset,
    bytesStored: segments.reduce((sum, segment) => sum + segment.bytes, 0),
    lastSeg: Math.max(Number.isSafeInteger(meta.lastSeg) ? meta.lastSeg : -1, ...files.map((file) => file.seg), -1),
    segments,
    cols: positiveInt(meta.cols, null),
    rows: positiveInt(meta.rows, null),
    _dir: sessionDir,
  };
}

function segmentFile(sessionDir, segment) {
  return path.join(sessionDir, `seg-${segment.seg}.log${segment.compression ? `.${segment.compression}` : ""}`);
}

function decompressSegment(file, compression, runtime = zlib) {
  return decompressBuffer(fs.readFileSync(file), compression, runtime);
}

function decompressBuffer(input, compression, runtime = zlib) {
  if (compression === "zst") {
    if (runtime.zstdDecompressSync) return runtime.zstdDecompressSync(input);
    throw new Error("zstd session log decompression is unavailable in this Node.js runtime");
  }
  if (compression === "gz") return runtime.gunzipSync(input);
  throw new Error(`unsupported session segment compression: ${compression}`);
}

function recordingEnabled(env = process.env) {
  return !["0", "off", "false", "no"].includes(String(env.SWITCHBOARD_RECORD || "").trim().toLowerCase());
}
function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== "." && value !== "..";
}
function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}
function touchPrivate(file) {
  const fd = fs.openSync(file, "a", 0o600);
  fs.closeSync(fd);
  try { fs.chmodSync(file, 0o600); } catch {}
}
function safeReadDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
function finiteOffset(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function oldestFirst(a, b) { return a.updatedAt - b.updatedAt || a.segment.start - b.segment.start; }
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
function streamDrain(stream) {
  return new Promise((resolve) => {
    const done = () => { stream.off("drain", done); stream.off("error", done); stream.off("close", done); resolve(); };
    stream.once("drain", done);
    stream.once("error", done);
    stream.once("close", done);
  });
}
function closeStream(stream) {
  if (!stream || stream.destroyed || stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      stream.off("error", done);
      stream.off("close", done);
      resolve();
    };
    stream.once("error", done);
    stream.once("close", done);
    stream.end(done);
  });
}

function sessionLogListResponse(store, id) {
  return {
    type: "sess-list",
    id,
    recording: !!store,
    sessions: store ? store.list().map(({ storageId, ...session }) => session) : [],
  };
}

function sessionLogReadResponse(store, msg) {
  if (!store) {
    return { type: "sess-error", id: msg.id, sid: msg.sid, message: "session recording is disabled" };
  }
  try {
    const requested = Number(msg.len);
    const len = Number.isSafeInteger(requested) && requested >= 0
      ? Math.min(DEFAULT_READ_LENGTH, requested)
      : DEFAULT_READ_LENGTH;
    const chunk = store.read(String(msg.sid), { from: msg.from, len });
    const { storageId, ...stat } = chunk.stat;
    return {
      type: "sess-chunk",
      id: msg.id,
      sid: msg.sid,
      data: chunk.data.toString("base64"),
      off: chunk.off,
      next: chunk.next,
      eof: chunk.eof,
      alternateScreens: chunk.alternateScreens,
      stat,
    };
  } catch (error) {
    return { type: "sess-error", id: msg.id, sid: msg.sid, message: error.message };
  }
}

module.exports = {
  DEFAULT_INDEX_BYTES,
  DEFAULT_INDEX_INTERVAL_MS,
  DEFAULT_MAX_SESSION_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_READ_LENGTH,
  DEFAULT_RETENTION_MS,
  DEFAULT_SEGMENT_BYTES: DEFAULT_SEGMENT_SIZE,
  DEFAULT_SEGMENT_SIZE,
  SessionLog: SessionLogStore,
  SessionLogStore,
  recordingEnabled,
  sessionLogListResponse,
  sessionLogReadResponse,
  validId,
};
