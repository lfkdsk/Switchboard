import test from "node:test";
import assert from "node:assert/strict";
import { registerMachine, updateMachineStats } from "../src/registry.js";

test("machine registration and heartbeats persist platform and architecture", async () => {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          args: [],
          bind(...args) { this.args = args; return this; },
          async first() { return { account_id: "account-1" }; },
          async run() { calls.push({ sql: sql.replace(/\s+/g, " "), args: this.args }); },
        };
        return statement;
      },
    },
  };

  assert.equal(await registerMachine(
    env, "machine-1", { id: "account-1", login: "alice" }, "mini", true, "darwin", "arm64",
  ), true);
  await updateMachineStats(env, "machine-1", {
    rtt: 4, cpu: 0.1, memUsed: 10, memTotal: 100, act: {}, platform: "darwin", arch: "arm64",
  });

  assert.match(calls[0].sql, /platform=COALESCE/);
  assert.deepEqual(calls[0].args.slice(-3), ["darwin", "arm64", "machine-1"]);
  assert.match(calls[1].sql, /arch=COALESCE/);
  assert.deepEqual(calls[1].args.slice(-3), ["darwin", "arm64", "machine-1"]);
});
