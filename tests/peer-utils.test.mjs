import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import peer from "../cli/peer.js";
import utils from "../cli/lib/peer-utils.js";

const {
  finalizeDownload, parseCopyOperands, remoteOperand, shellCommandArgs, shellQuote, verifyUploadedFile,
} = utils;
const { lastLines, parseTailSpec, stripAnsi } = peer;

test("cp operands distinguish node paths from local Windows and POSIX paths", () => {
  assert.deepEqual(remoteOperand("build:/tmp/a:b"), { node: "build", path: "/tmp/a:b" });
  assert.equal(remoteOperand("C:\\Users\\me\\file.txt"), null);
  assert.equal(remoteOperand("D:/work/file.txt"), null);
  assert.equal(remoteOperand("C:relative.txt"), null);
  assert.equal(remoteOperand("./relative.txt"), null);
  assert.equal(remoteOperand("./name:with-colon.txt"), null);
  assert.equal(remoteOperand("/absolute/file.txt"), null);

  assert.deepEqual(parseCopyOperands("node:relative.txt", "./out.txt"), {
    direction: "download", node: "node", remotePath: "relative.txt", localPath: "./out.txt",
  });
  assert.deepEqual(parseCopyOperands("/tmp/in.txt", "node:/absolute/out.txt"), {
    direction: "upload", node: "node", remotePath: "/absolute/out.txt", localPath: "/tmp/in.txt",
  });
  assert.deepEqual(parseCopyOperands("./in.txt", "windows:C:\\Users\\me\\out.txt"), {
    direction: "upload", node: "windows", remotePath: "C:\\Users\\me\\out.txt", localPath: "./in.txt",
  });
  assert.throws(() => parseCopyOperands("node-a:/one", "node-b:/two"), /remote-to-remote/);
  assert.throws(() => parseCopyOperands("./one", "./two"), /one cp operand/);
});

test("POSIX shell quoting preserves spaces, quotes, dollars, and newlines", () => {
  const values = ["plain", "a b", "it's here", "$HOME `touch nope`", "line one\nline two"];
  for (const value of values) {
    const actual = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`]);
    assert.equal(actual.toString(), value);
  }
});

test("exec selects login shell arguments only when requested", () => {
  assert.deepEqual(shellCommandArgs("echo ok", false, "linux"), ["-c", "echo ok"]);
  assert.deepEqual(shellCommandArgs("echo ok", true, "darwin"), ["-lc", "echo ok"]);
  assert.deepEqual(shellCommandArgs("echo ok", true, "win32"),
    ["-NoLogo", "-NoProfile", "-Command", "echo ok"]);
});

test("a failed download checksum removes the temporary file and preserves destination", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-checksum-"));
  const temp = path.join(dir, "part");
  const destination = path.join(dir, "destination");
  fs.writeFileSync(temp, "corrupt");
  fs.writeFileSync(destination, "known-good");
  await assert.rejects(finalizeDownload(temp, destination, "expected", "actual"), /sha256 mismatch/);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(fs.readFileSync(destination, "utf8"), "known-good");
  fs.rmSync(dir, { recursive: true });
});

test("a failed upload checksum removes the target-side staged file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-upload-checksum-"));
  const staged = path.join(dir, "upload.part");
  fs.writeFileSync(staged, "wrong bytes");
  await assert.rejects(verifyUploadedFile(staged, "0".repeat(64)), /sha256 mismatch/);
  assert.equal(fs.existsSync(staged), false);
  fs.rmSync(dir, { recursive: true });
});

class FakeSocket extends EventEmitter {
  static content = Buffer.from("binary\0payload\n");
  static badChecksum = false;
  static mode = "download";
  static uploaded = Buffer.alloc(0);
  static uploadPath = null;
  static uploadCommand = null;
  static downloadBase = null;
  static historyContent = Buffer.from("\x1b[31mred\x1b[0m\nblue\n");
  static features = ["cp-sha256-v1"];
  static ignoreCapabilities = false;
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
  }
  send(raw) {
    const m = JSON.parse(raw);
    if (m.type === "capabilities") {
      if (FakeSocket.ignoreCapabilities) return;
      return this.reply({ type: "capabilities", id: m.id, version: "test", features: FakeSocket.features });
    }
    if (m.type === "dl-open" && FakeSocket.mode === "download") {
      FakeSocket.downloadBase = m.base;
      this.reply({ type: "dl-meta", id: m.id, name: "remote.bin", size: FakeSocket.content.length });
      this.reply({ type: "dl-chunk", id: m.id, data: FakeSocket.content.toString("base64") });
      const digest = crypto.createHash("sha256").update(FakeSocket.content).digest("hex");
      this.reply({ type: "dl-end", id: m.id, sha256: FakeSocket.badChecksum ? "0".repeat(64) : digest });
    }
    if (m.type === "dl-open" && FakeSocket.mode === "directory") {
      this.reply({ type: "dl-error", id: m.id, message: "path is a directory" });
    }
    if (m.type === "exec" && FakeSocket.mode === "upload") {
      FakeSocket.uploaded = Buffer.alloc(0);
      FakeSocket.uploadPath = m.upload.path;
      FakeSocket.uploadCommand = m.cmd;
      this.execId = m.id;
      this.reply({ type: "exec-ready", id: m.id });
    }
    if (m.type === "exec-stdin" && FakeSocket.mode === "upload") {
      FakeSocket.uploaded = Buffer.concat([FakeSocket.uploaded, Buffer.from(m.data, "base64")]);
      this.reply({ type: "exec-stdin-ready", id: m.id });
    }
    if (m.type === "exec-stdin-end" && FakeSocket.mode === "upload") {
      const digest = crypto.createHash("sha256").update(FakeSocket.uploaded).digest("hex");
      this.reply({ type: "exec-exit", id: m.id, code: m.sha256 === digest ? 0 : 1, sha256: digest });
    }
    if (m.type === "job-list" && FakeSocket.mode === "jobs") {
      this.reply({
        type: "job-list", id: m.id,
        jobs: [{ id: "job-remote", status: "exited", exitCode: 3, createdAt: 123, command: "build" }],
      });
    }
    if (m.type === "sess-list" && FakeSocket.mode === "history") {
      this.reply({
        type: "sess-list", id: m.id, recording: true,
        sessions: [{
          sid: "session-remote", status: "closed", active: false, startedAt: 123,
          from: 0, off: FakeSocket.historyContent.length, bytes: FakeSocket.historyContent.length,
        }],
      });
    }
    if (m.type === "sess-read" && FakeSocket.mode === "history") {
      const from = Math.max(0, Math.min(Number(m.from) || 0, FakeSocket.historyContent.length));
      const chunk = FakeSocket.historyContent.subarray(from, from + Math.min(Number(m.len) || 65536, 65536));
      const next = from + chunk.length;
      this.reply({
        type: "sess-chunk", id: m.id, sid: m.sid, data: chunk.toString("base64"),
        off: from, next, eof: next >= FakeSocket.historyContent.length,
        stat: { active: false, from: 0, off: FakeSocket.historyContent.length },
      });
    }
  }
  reply(message) { queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(message)), false)); }
  close() { this.readyState = 3; queueMicrotask(() => this.emit("close")); }
  terminate() { this.readyState = 3; }
}

function fakeContext() {
  return {
    server: "https://relay.invalid", agentToken: "token", machineId: "caller", WebSocket: FakeSocket,
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({
        now: Date.now(),
        nodes: [{ machine_id: "target-id", name: "target", online: true, peer: true, last_seen: Date.now() }],
      }),
    }),
  };
}

test("cp download uses the existing dl protocol through a fake transport", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cp-"));
  const destination = path.join(dir, "copy.bin");
  FakeSocket.mode = "download";
  FakeSocket.features = ["cp-sha256-v1"];
  FakeSocket.badChecksum = false;
  await peer.cmdCopy(fakeContext(), { source: "target:/tmp/source.bin", destination });
  assert.deepEqual(fs.readFileSync(destination), FakeSocket.content);
  assert.equal(FakeSocket.downloadBase, "home");
  fs.rmSync(dir, { recursive: true });
});

test("cp download cleans its staged file when the fake target reports a bad checksum", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cp-bad-"));
  const destination = path.join(dir, "copy.bin");
  FakeSocket.mode = "download";
  FakeSocket.features = ["cp-sha256-v1"];
  FakeSocket.badChecksum = true;
  await assert.rejects(
    peer.cmdCopy(fakeContext(), { source: "target:/tmp/source.bin", destination }),
    /sha256 mismatch/,
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  FakeSocket.badChecksum = false;
  fs.rmSync(dir, { recursive: true });
});

test("cp upload streams stdin over a fake transport and keeps the path out of the shell command", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cp-upload-"));
  const source = path.join(dir, "source.bin");
  const content = crypto.randomBytes(150_000);
  fs.writeFileSync(source, content);
  const remotePath = "~/dir/a b'c$\n.bin";
  FakeSocket.mode = "upload";
  FakeSocket.features = ["cp-sha256-v1"];

  await peer.cmdCopy(fakeContext(), { source, destination: `target:${remotePath}` });

  assert.deepEqual(FakeSocket.uploaded, content);
  assert.equal(FakeSocket.uploadPath, remotePath);
  assert.equal(FakeSocket.uploadCommand.includes(remotePath), false);
  fs.rmSync(dir, { recursive: true });
  FakeSocket.mode = "download";
});

test("new cp client reports an old target clearly before starting a transfer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cp-old-"));
  FakeSocket.features = [];
  await assert.rejects(
    peer.cmdCopy(fakeContext(), { source: "target:/tmp/source.bin", destination: path.join(dir, "copy.bin") }),
    /does not support file copy; update it first/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
  FakeSocket.features = ["cp-sha256-v1"];
  fs.rmSync(dir, { recursive: true });
});

test("an old target that ignores capability messages fails after the short compatibility timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cp-older-"));
  FakeSocket.ignoreCapabilities = true;
  const started = Date.now();
  await assert.rejects(
    peer.cmdCopy(fakeContext(), { source: "target:/tmp/source.bin", destination: path.join(dir, "copy.bin") }),
    /too old for file copy; update Switchboard/,
  );
  assert.ok(Date.now() - started >= 1900);
  assert.ok(Date.now() - started < 3000);
  FakeSocket.ignoreCapabilities = false;
  fs.rmSync(dir, { recursive: true });
});

test("cp reports a remote directory explicitly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cp-dir-"));
  FakeSocket.mode = "directory";
  await assert.rejects(
    peer.cmdCopy(fakeContext(), { source: "target:/tmp/a-directory", destination: path.join(dir, "copy") }),
    /path is a directory/,
  );
  FakeSocket.mode = "download";
  fs.rmSync(dir, { recursive: true });
});

test("jobs queries use a fake transport and return target-side records", async () => {
  FakeSocket.mode = "jobs";
  FakeSocket.features = ["jobs-v1"];
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await peer.cmdJobs(fakeContext(), { target: "target", json: true });
  } finally {
    console.log = original;
    FakeSocket.mode = "download";
    FakeSocket.features = ["cp-sha256-v1"];
  }
  assert.deepEqual(JSON.parse(lines.join("\n")), [
    { id: "job-remote", status: "exited", exitCode: 3, createdAt: 123, command: "build" },
  ]);
});

test("history reads a line tail and strips terminal escape sequences", async () => {
  FakeSocket.mode = "history";
  FakeSocket.features = ["history-v1"];
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
  try {
    await peer.cmdHistory(fakeContext(), {
      target: "target", sid: "session-remote", tail: "1l", text: true,
      raw: false, follow: false, json: false,
    });
  } finally {
    process.stdout.write = original;
    FakeSocket.mode = "download";
    FakeSocket.features = ["cp-sha256-v1"];
  }
  assert.equal(output, "blue\n");
});

test("history reports a target without history-v1 before requesting sessions", async () => {
  FakeSocket.mode = "history";
  FakeSocket.features = [];
  try {
    await assert.rejects(
      peer.cmdHistory(fakeContext(), {
        target: "target", sid: null, text: false, raw: false, follow: false, json: false,
      }),
      /does not support session history; update it first/,
    );
  } finally {
    FakeSocket.mode = "download";
    FakeSocket.features = ["cp-sha256-v1"];
  }
});

test("history text mode strips an ANSI sequence split across protocol chunks", async () => {
  const originalContent = FakeSocket.historyContent;
  FakeSocket.historyContent = Buffer.concat([Buffer.alloc(65535, 0x78), Buffer.from("\x1b[31mred\x1b[0m\n")]);
  FakeSocket.mode = "history";
  FakeSocket.features = ["history-v1"];
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
  try {
    await peer.cmdHistory(fakeContext(), {
      target: "target", sid: "session-remote", text: true,
      raw: false, follow: false, json: false,
    });
  } finally {
    process.stdout.write = originalWrite;
    FakeSocket.historyContent = originalContent;
    FakeSocket.mode = "download";
    FakeSocket.features = ["cp-sha256-v1"];
  }
  assert.equal(output, "x".repeat(65535) + "red\n");
});

test("history text mode streams a long OSC sequence without leaking its payload", async () => {
  const originalContent = FakeSocket.historyContent;
  FakeSocket.historyContent = Buffer.from(
    "before\x1b]0;" + "x".repeat(70_000) + "\x1b[31mhidden\x07after\n",
  );
  FakeSocket.mode = "history";
  FakeSocket.features = ["history-v1"];
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
  try {
    await peer.cmdHistory(fakeContext(), {
      target: "target", sid: "session-remote", text: true,
      raw: false, follow: false, json: false,
    });
  } finally {
    process.stdout.write = originalWrite;
    FakeSocket.historyContent = originalContent;
    FakeSocket.mode = "download";
    FakeSocket.features = ["cp-sha256-v1"];
  }
  assert.equal(output, "beforeafter\n");
});

test("history helpers parse byte and line tails without a dependency", () => {
  assert.deepEqual(parseTailSpec("64KiB"), { unit: "bytes", value: 65536 });
  assert.deepEqual(parseTailSpec("200 lines"), { unit: "lines", value: 200 });
  assert.equal(stripAnsi("\x1b[32mok\x1b[0m"), "ok");
  assert.equal(stripAnsi("a\x1bPignored\x1b\\b"), "ab");
  assert.equal(lastLines(Buffer.from("one\ntwo\nthree\n"), 2).toString(), "two\nthree\n");
});
