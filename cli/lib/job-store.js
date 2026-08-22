const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 100;
const MARKER_RESERVE = 128;

class JobStore {
  constructor(options) {
    this.dir = options.dir;
    this.maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.now = options.now || Date.now;
    this.records = new Map();
    this.writers = new Map();
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch {}
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8"));
        if (!validId(record.id)) continue;
        const logSize = statSize(this.logPath(record.id));
        record.bytesStored = logSize;
        if (record.status === "running") {
          record.status = "unknown";
          record.endedAt = this.now();
          record.error = "daemon restarted while this job was running";
          record.exitCode = null;
          this.persist(record);
        }
        this.records.set(record.id, record);
      } catch {}
    }
    for (const name of fs.readdirSync(this.dir)) {
      const match = /^(.+)\.log$/.exec(name);
      if (match && !this.records.has(match[1])) {
        try { fs.unlinkSync(path.join(this.dir, name)); } catch {}
      } else if (/\.json\.tmp-\d+$/.test(name)) {
        try { fs.unlinkSync(path.join(this.dir, name)); } catch {}
      }
    }
    this.cleanup();
    return this;
  }

  create(input) {
    if (!validId(input.id)) throw new Error("invalid job id");
    this.cleanup();
    for (const record of [...this.records.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => (a.endedAt || a.createdAt) - (b.endedAt || b.createdAt))) {
      if (this.records.size < this.maxRecords) break;
      this.remove(record.id);
    }
    if (this.records.size >= this.maxRecords) {
      throw new Error(`too many retained or running jobs (max ${this.maxRecords})`);
    }
    if (this.records.has(input.id)) throw new Error("job id already exists");
    const now = this.now();
    const command = String(input.command);
    const record = {
      id: input.id,
      command: command.length > 4096 ? command.slice(0, 4095) + "…" : command,
      cwd: input.cwd,
      shell: input.shell,
      login: !!input.login,
      status: "running",
      createdAt: now,
      startedAt: now,
      endedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      outputBytes: 0,
      bytesStored: 0,
      bytesDropped: 0,
      truncated: false,
    };
    let writer;
    try {
      fs.writeFileSync(this.logPath(record.id), "", { mode: 0o600 });
      writer = fs.createWriteStream(this.logPath(record.id), { flags: "a", mode: 0o600 });
      // Consumers attach their own handler when a live child should be stopped;
      // this baseline listener prevents an asynchronous ENOSPC from taking the
      // whole daemon down before that handler runs.
      writer.on("error", () => {});
      this.records.set(record.id, record);
      this.writers.set(record.id, writer);
      this.persist(record);
    } catch (e) {
      writer?.destroy();
      this.records.delete(record.id);
      this.writers.delete(record.id);
      try { fs.unlinkSync(this.logPath(record.id)); } catch {}
      try { fs.unlinkSync(this.metaPath(record.id)); } catch {}
      throw e;
    }
    return { ...record };
  }

  append(id, value) {
    const record = this.records.get(id);
    const writer = this.writers.get(id);
    if (!record || !writer || record.status !== "running") return true;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const dataLimit = Math.max(0, this.maxOutput - MARKER_RESERVE);
    const keep = Math.max(0, Math.min(chunk.length, dataLimit - record.outputBytes));
    let writable = true;
    if (keep) {
      writable = writer.write(chunk.subarray(0, keep));
      record.outputBytes += keep;
      record.bytesStored += keep;
    }
    if (keep < chunk.length) {
      const firstDrop = !record.truncated;
      record.bytesDropped += chunk.length - keep;
      record.truncated = true;
      if (firstDrop) this.persist(record);
    }
    return writable;
  }

  writer(id) { return this.writers.get(id) || null; }

  finish(id, result = {}) {
    const record = this.records.get(id);
    if (!record || record.status !== "running") return Promise.resolve(record ? { ...record } : null);
    const writer = this.writers.get(id);
    this.writers.delete(id);
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try {
          // Keep the public state running until all buffered output and the
          // truncation marker are readable, so `logs --follow` cannot exit in
          // the gap between child exit and file flush.
          record.status = result.status || "exited";
          record.endedAt = this.now();
          record.exitCode = result.exitCode ?? null;
          record.signal = result.signal || null;
          record.error = result.error || null;
          record.bytesStored = statSize(this.logPath(id));
          this.persist(record);
          this.cleanup();
        } catch (e) {
          record.error ||= `could not persist job record: ${e.message}`;
        }
        resolve({ ...record });
      };
      if (!writer || writer.destroyed) return done();
      writer.once("error", done);
      writer.once("close", done);
      if (record.truncated) {
        const marker = Buffer.from(`\n[switchboard: output truncated; ${record.bytesDropped} bytes omitted]\n`);
        writer.end(marker.subarray(0, Math.max(0, this.maxOutput - record.outputBytes)), done);
      } else {
        writer.end(done);
      }
    });
  }

  get(id) {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  list() {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => ({ ...record }));
  }

  read(id, offset = 0, length = 64 * 1024) {
    if (!this.records.has(id)) throw Object.assign(new Error("no such job"), { code: "ENOENT" });
    const fd = fs.openSync(this.logPath(id), "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, Math.min(Number(offset) || 0, size));
      const buffer = Buffer.allocUnsafe(Math.min(length, size - start));
      const bytesRead = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, start) : 0;
      return { data: buffer.subarray(0, bytesRead), offset: start + bytesRead, size };
    } finally {
      fs.closeSync(fd);
    }
  }

  cleanup() {
    const now = this.now();
    const terminal = [...this.records.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => (a.endedAt || a.createdAt) - (b.endedAt || b.createdAt));
    for (const record of terminal) {
      if (now - (record.endedAt || record.createdAt) > this.retentionMs) this.remove(record.id);
    }
    for (const record of terminal) {
      if (this.records.size <= this.maxRecords) break;
      this.remove(record.id);
    }
  }

  remove(id) {
    if (this.writers.has(id)) return false;
    this.records.delete(id);
    try { fs.unlinkSync(this.metaPath(id)); } catch {}
    try { fs.unlinkSync(this.logPath(id)); } catch {}
    return true;
  }

  persist(record) {
    const file = this.metaPath(record.id);
    const temp = file + `.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  metaPath(id) { return path.join(this.dir, id + ".json"); }
  logPath(id) { return path.join(this.dir, id + ".log"); }
}

function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}
function statSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

module.exports = {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_MAX_RECORDS,
  DEFAULT_RETENTION_MS,
  JobStore,
  validId,
};
