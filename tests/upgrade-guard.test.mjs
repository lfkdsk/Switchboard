import test from "node:test";
import assert from "node:assert/strict";
import { guardUpgrade } from "../src/upgrade-guard.js";

function recorder() {
  const calls = [];
  return { calls, error: (...args) => calls.push(args) };
}

test("a successful upgrade passes through untouched", async () => {
  const log = recorder();
  // Node's Response cannot carry 101; the guard only forwards whatever it got.
  const upgraded = new Response(null, { status: 200 });
  const result = await guardUpgrade(async () => upgraded, { role: "browser", machine: "m1" }, log);
  assert.equal(result, upgraded);
  assert.equal(log.calls.length, 0);
});

test("a throwing upgrade becomes a retryable 503 with the context logged", async () => {
  const log = recorder();
  const result = await guardUpgrade(
    async () => { throw new Error("Durable Object reset while handling request"); },
    { role: "daemon", machine: "m1" },
    log,
  );
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("retry-after"), "2");
  assert.match(await result.text(), /retry shortly/);
  assert.equal(log.calls.length, 1);
  const [message, detail] = log.calls[0];
  assert.equal(message, "[ws] upgrade failed");
  assert.equal(detail.role, "daemon");
  assert.equal(detail.machine, "m1");
  assert.match(detail.error, /Durable Object reset/);
});

test("non-Error throws are still logged and converted", async () => {
  const log = recorder();
  const result = await guardUpgrade(() => Promise.reject("boom"), {}, log);
  assert.equal(result.status, 503);
  assert.equal(log.calls[0][1].error, "boom");
  assert.equal(log.calls[0][1].role, null);
});
