const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const DEFAULT_SESSION_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_REPLAY_BYTES = 1024 * 1024;
const SESSION_SCROLLBACK = 10000;

class SessionScreen {
  constructor(cols = 80, rows = 24) {
    this.terminal = new Terminal({
      cols: positiveDimension(cols, 80),
      rows: positiveDimension(rows, 24),
      scrollback: SESSION_SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.pending = new Set();
  }

  write(data) {
    let resolve;
    const done = new Promise((settle) => { resolve = settle; });
    this.pending.add(done);
    this.terminal.write(data, () => {
      this.pending.delete(done);
      resolve();
    });
  }

  resize(cols, rows) {
    if (cols > 0 && rows > 0) this.terminal.resize(Math.floor(cols), Math.floor(rows));
  }

  async snapshot() {
    while (this.pending.size) await Promise.all([...this.pending]);
    return this.serializer.serialize({ scrollback: SESSION_SCROLLBACK });
  }

  dispose() {
    this.terminal.dispose();
  }
}

function replayPlan(options) {
  const currentOffset = offset(options.currentOffset);
  const firstOffset = offset(options.firstOffset);
  const since = Number(options.since);
  const canRead = options.canRead !== false;
  const maxBytes = nonNegativeInteger(options.maxBytes, MAX_REPLAY_BYTES);
  if (!options.forceSnapshot && canRead && Number.isSafeInteger(since) &&
      since >= firstOffset && since <= currentOffset && currentOffset - since <= maxBytes) {
    return { mode: "delta", from: since, to: currentOffset };
  }
  return { mode: "snapshot", from: currentOffset, to: currentOffset };
}

async function buildSessionReplay(options) {
  const currentOffset = offset(options.currentOffset);
  const stat = options.log?.stat?.();
  const plan = replayPlan({
    since: options.since,
    currentOffset,
    firstOffset: stat?.from ?? currentOffset,
    canRead: !!options.log || Number(options.since) === currentOffset,
    forceSnapshot: !!options.forceSnapshot,
    maxBytes: options.maxBytes,
  });

  if (plan.mode === "delta") {
    await options.log?.flush?.();
    const payload = readRange(options.log, plan.from, plan.to);
    if (payload && payload.length === plan.to - plan.from) return { ...plan, payload };
  }

  const snapshot = await options.screen.snapshot();
  // RIS also resets legacy clients which predate the JSON reset control frame.
  const payload = Buffer.from("\x1bc" + snapshot, "utf8");
  return { mode: "snapshot", from: currentOffset, to: currentOffset, payload };
}

function readRange(log, from, to) {
  if (from === to) return Buffer.alloc(0);
  if (!log?.read) return null;
  const parts = [];
  let cursor = from;
  while (cursor < to) {
    const chunk = log.read({ from: cursor, len: Math.min(64 * 1024, to - cursor) });
    if (chunk.off !== cursor || !chunk.data.length) return null;
    parts.push(chunk.data);
    cursor = chunk.next;
  }
  return cursor === to ? Buffer.concat(parts) : null;
}

function parseSessionGrace(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_SESSION_GRACE_MS;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(value).trim());
  if (!match) return DEFAULT_SESSION_GRACE_MS;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  // A bare value is seconds, matching other Switchboard duration flags.
  const result = Number(match[1]) * units[(match[2] || "s").toLowerCase()];
  return Number.isSafeInteger(result) && result >= 0 ? result : DEFAULT_SESSION_GRACE_MS;
}

function positiveDimension(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
function offset(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

module.exports = {
  DEFAULT_SESSION_GRACE_MS,
  MAX_REPLAY_BYTES,
  SESSION_SCROLLBACK,
  SessionScreen,
  buildSessionReplay,
  parseSessionGrace,
  replayPlan,
};
