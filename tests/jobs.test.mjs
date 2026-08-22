import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jobs from "../cli/lib/job-store.js";

const { JobStore } = jobs;

function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-jobs-"));
  return { dir, store: new JobStore({ dir, ...options }).init() };
}

test("job output is capped and ends with an explicit truncation marker", async () => {
  const { dir, store } = tempStore({ maxOutput: 256 });
  store.create({ id: "job-0001", command: "noisy", cwd: "/tmp", shell: "/bin/sh", login: false });
  store.append("job-0001", Buffer.alloc(400, 0x78));
  const record = await store.finish("job-0001", { exitCode: 0 });
  const output = fs.readFileSync(path.join(dir, "job-0001.log"));

  assert.equal(record.truncated, true);
  assert.equal(record.bytesDropped, 272);
  assert.ok(output.length <= 256);
  assert.match(output.toString(), /output truncated; 272 bytes omitted/);
  fs.rmSync(dir, { recursive: true });
});

test("job cleanup removes expired records and then enforces the record cap", async () => {
  let now = 1_000_000;
  const { dir, store } = tempStore({ now: () => now, retentionMs: 100, maxRecords: 2 });
  for (const id of ["job-0001", "job-0002", "job-0003"]) {
    store.create({ id, command: id, cwd: "/tmp", shell: "/bin/sh", login: false });
    await store.finish(id, { exitCode: 0 });
    now += 10;
  }
  assert.deepEqual(store.list().map((r) => r.id), ["job-0003", "job-0002"]);
  assert.equal(fs.existsSync(path.join(dir, "job-0001.json")), false);

  now += 101;
  store.cleanup();
  assert.deepEqual(store.list(), []);
  fs.rmSync(dir, { recursive: true });
});

test("a running record becomes unknown after daemon restart", () => {
  let now = 5_000;
  const { dir, store } = tempStore({ now: () => now });
  store.create({ id: "job-live", command: "sleep 10", cwd: "/tmp", shell: "/bin/sh", login: false });
  store.writer("job-live").destroy();
  now = 6_000;

  const reloaded = new JobStore({ dir, now: () => now }).init();
  assert.equal(reloaded.get("job-live").status, "unknown");
  assert.match(reloaded.get("job-live").error, /daemon restarted/);
  fs.rmSync(dir, { recursive: true });
});

test("completed records and output survive a daemon restart", async () => {
  const { dir, store } = tempStore();
  store.create({ id: "job-done", command: "printf done", cwd: "/tmp", shell: "/bin/sh", login: false });
  store.append("job-done", "done");
  await store.finish("job-done", { exitCode: 7 });

  const reloaded = new JobStore({ dir }).init();
  assert.equal(reloaded.get("job-done").status, "exited");
  assert.equal(reloaded.get("job-done").exitCode, 7);
  assert.equal(reloaded.read("job-done").data.toString(), "done");
  fs.rmSync(dir, { recursive: true });
});
