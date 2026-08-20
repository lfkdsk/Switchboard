import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  deleteMachine,
  grantMachine,
  listGrants,
  machineAccess,
  revokeGrant,
} from "../src/registry.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function sqlKey(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sqlKey(sql);
    this.args = [];
  }
  bind(...args) { this.args = args; return this; }

  async first() {
    if (this.sql.startsWith("SELECT account_id, account_login FROM machines")) {
      const machine = this.db.machines.get(this.args[0]);
      return machine ? { account_id: machine.account_id, account_login: machine.account_login } : null;
    }
    if (this.sql.startsWith("SELECT account_id, peer FROM machines")) {
      const machine = this.db.machines.get(this.args[0]);
      return machine ? { account_id: machine.account_id, peer: machine.peer } : null;
    }
    if (this.sql.startsWith("SELECT expires_at FROM machine_grants")) {
      const grant = this.db.grants.get(`${this.args[0]}:${this.args[1]}`);
      if (!grant || grant.revoked_at != null) return null;
      if (grant.expires_at != null && grant.expires_at <= this.args[2]) return null;
      return { expires_at: grant.expires_at };
    }
    if (this.sql.startsWith("SELECT revoked_at FROM machine_grants")) {
      const grant = this.db.grants.get(`${this.args[0]}:${this.args[1]}`);
      return grant ? { revoked_at: grant.revoked_at } : null;
    }
    if (this.sql.startsWith("SELECT account_id, last_seen FROM machines")) {
      const machine = this.db.machines.get(this.args[0]);
      return machine ? { account_id: machine.account_id, last_seen: machine.last_seen } : null;
    }
    throw new Error("Unhandled first(): " + this.sql);
  }

  async all() {
    if (this.sql.includes("FROM machine_grants") && this.sql.includes("ORDER BY created_at")) {
      const results = [...this.db.grants.values()]
        .filter((grant) => grant.machine_id === this.args[0] && grant.revoked_at == null)
        .sort((a, b) => a.created_at - b.created_at)
        .map(({ grantee_id, grantee_login, created_at, expires_at }) => ({
          grantee_id, grantee_login, created_at, expires_at,
        }));
      return { results };
    }
    throw new Error("Unhandled all(): " + this.sql);
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO machine_grants")) {
      const [machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login, created_at, expires_at] = this.args;
      this.db.grants.set(`${machine_id}:${grantee_id}`, {
        machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login,
        created_at, expires_at, revoked_at: null,
      });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE machine_grants SET revoked_at")) {
      const [revoked_at, machineId, granteeId] = this.args;
      this.db.grants.get(`${machineId}:${granteeId}`).revoked_at = revoked_at;
      return { success: true };
    }
    if (this.sql.startsWith("DELETE FROM machine_grants")) {
      const machineId = this.args[0];
      for (const [key, grant] of this.db.grants) {
        if (grant.machine_id === machineId) this.db.grants.delete(key);
      }
      return { success: true };
    }
    if (this.sql.startsWith("DELETE FROM machines")) {
      this.db.machines.delete(this.args[0]);
      return { success: true };
    }
    throw new Error("Unhandled run(): " + this.sql);
  }
}

class FakeDB {
  constructor() {
    this.machines = new Map();
    this.grants = new Map();
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    for (const statement of statements) await statement.run();
  }
}

function envWithMachine(overrides = {}) {
  const DB = new FakeDB();
  DB.machines.set("machine-1", {
    account_id: "owner-1",
    account_login: "owner",
    peer: 1,
    last_seen: 0,
    ...overrides,
  });
  return { DB };
}

test("grant uses GitHub's stable id and authorizes owner and grantee", async () => {
  const env = envWithMachine();
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://api.github.com/users/Bob");
    return new Response(JSON.stringify({ id: 202, login: "bob" }), {
      headers: { "content-type": "application/json" },
    });
  };

  const expiresAt = Date.now() + 60_000;
  const result = await grantMachine(env, "machine-1", "owner-1", "Bob", expiresAt);
  assert.equal(result.ok, true);
  assert.equal(result.grant.grantee_id, "202");
  assert.equal(result.grant.grantee_login, "bob");

  assert.deepEqual(await machineAccess(env, "machine-1", "owner-1"), {
    accountId: "owner-1", peer: true, via: "owner", expiresAt: null,
  });
  assert.deepEqual(await machineAccess(env, "machine-1", "202"), {
    accountId: "owner-1", peer: true, via: "grant", expiresAt,
  });
  assert.equal((await listGrants(env, "machine-1", "owner-1")).length, 1);
  assert.equal(await listGrants(env, "machine-1", "somebody-else"), null);
});

test("expired grants fail closed and revocation is owner-or-self only", async () => {
  const env = envWithMachine();
  env.DB.grants.set("machine-1:grantee-1", {
    machine_id: "machine-1", grantee_id: "grantee-1", grantee_login: "guest",
    created_at: Date.now() - 1000, expires_at: Date.now() + 60_000, revoked_at: null,
  });
  assert.equal((await revokeGrant(env, "machine-1", "grantee-1", "stranger")).ok, false);
  assert.equal((await revokeGrant(env, "machine-1", "grantee-1", "grantee-1")).ok, true);
  assert.equal(await machineAccess(env, "machine-1", "grantee-1"), null);

  env.DB.grants.set("machine-1:expired", {
    machine_id: "machine-1", grantee_id: "expired", grantee_login: "old",
    created_at: Date.now() - 2000, expires_at: Date.now() - 1, revoked_at: null,
  });
  assert.equal(await machineAccess(env, "machine-1", "expired"), null);
});

test("deleting an offline machine also deletes every grant", async () => {
  const env = envWithMachine({ last_seen: 0 });
  env.DB.grants.set("machine-1:grantee-1", {
    machine_id: "machine-1", grantee_id: "grantee-1", revoked_at: null,
  });
  assert.deepEqual(await deleteMachine(env, "machine-1", "owner-1"), { ok: true });
  assert.equal(env.DB.machines.size, 0);
  assert.equal(env.DB.grants.size, 0);
});
