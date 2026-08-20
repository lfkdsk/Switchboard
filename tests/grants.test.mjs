import test from "node:test";
import assert from "node:assert/strict";
import {
  createShareCode,
  deleteMachine,
  listGrants,
  machineAccess,
  redeemShareCode,
  revokeGrant,
} from "../src/registry.js";

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
    if (this.sql.startsWith("SELECT machine_id, access_expires_at FROM machine_share_codes")) {
      const share = this.db.shareCodes.get(this.args[0]);
      if (!share || share.redeemed_at != null || share.expires_at <= this.args[1]) return null;
      if (share.access_expires_at != null && share.access_expires_at <= this.args[2]) return null;
      return { machine_id: share.machine_id, access_expires_at: share.access_expires_at };
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
    if (this.sql.startsWith("INSERT INTO machine_share_codes")) {
      const [code_hash, machine_id, created_by_id, created_by_login, created_at, expires_at, access_expires_at] = this.args;
      this.db.shareCodes.set(code_hash, {
        code_hash, machine_id, created_by_id, created_by_login, created_at,
        expires_at, access_expires_at, redeemed_at: null,
        redeemed_by_id: null, redeemed_by_login: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE machine_share_codes SET redeemed_at")) {
      const [redeemed_at, redeemed_by_id, redeemed_by_login, codeHash, now, accessNow] = this.args;
      const share = this.db.shareCodes.get(codeHash);
      if (!share || share.redeemed_at != null || share.expires_at <= now
        || (share.access_expires_at != null && share.access_expires_at <= accessNow)) {
        return { meta: { changes: 0 } };
      }
      Object.assign(share, { redeemed_at, redeemed_by_id, redeemed_by_login });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM machine_share_codes WHERE machine_id")) {
      const machineId = this.args[0];
      for (const [key, share] of this.db.shareCodes) {
        if (share.machine_id === machineId) this.db.shareCodes.delete(key);
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM machine_share_codes WHERE expires_at")) {
      const [now, redeemedBefore] = this.args;
      for (const [key, share] of this.db.shareCodes) {
        if (share.expires_at <= now || (share.redeemed_at != null && share.redeemed_at <= redeemedBefore)) {
          this.db.shareCodes.delete(key);
        }
      }
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO machine_grants")) {
      const [machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login, created_at, expires_at] = this.args;
      this.db.grants.set(`${machine_id}:${grantee_id}`, {
        machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login,
        created_at, expires_at, revoked_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE machine_grants SET revoked_at")) {
      const [revoked_at, machineId, granteeId] = this.args;
      this.db.grants.get(`${machineId}:${granteeId}`).revoked_at = revoked_at;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM machine_grants")) {
      const machineId = this.args[0];
      for (const [key, grant] of this.db.grants) {
        if (grant.machine_id === machineId) this.db.grants.delete(key);
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM machines")) {
      this.db.machines.delete(this.args[0]);
      return { meta: { changes: 1 } };
    }
    throw new Error("Unhandled run(): " + this.sql);
  }
}

class FakeDB {
  constructor() {
    this.machines = new Map();
    this.grants = new Map();
    this.shareCodes = new Map();
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
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

test("a one-time code binds access to the signed-in recipient", async () => {
  const env = envWithMachine();
  const expiresAt = Date.now() + 86400000;
  const created = await createShareCode(env, "machine-1", "owner-1", expiresAt);
  assert.equal(created.ok, true);
  assert.match(created.share.code, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  assert.equal(created.share.access_expires_at, expiresAt);
  assert.equal(JSON.stringify([...env.DB.shareCodes.values()]).includes(created.share.code.replaceAll("-", "")), false);

  const result = await redeemShareCode(env, created.share.code.toLowerCase(), { id: "202", login: "bob" });
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
  assert.deepEqual(await redeemShareCode(env, created.share.code, { id: "303", login: "eve" }), {
    ok: false, reason: "invalid",
  });
});

test("an owner cannot redeem their own code or create one for another owner's machine", async () => {
  const env = envWithMachine();
  assert.deepEqual(await createShareCode(env, "machine-1", "stranger"), { ok: false, reason: "not-found" });
  const created = await createShareCode(env, "machine-1", "owner-1");
  assert.equal(created.ok, true);
  assert.deepEqual(await redeemShareCode(env, created.share.code, { id: "owner-1", login: "owner" }), {
    ok: false, reason: "self",
  });
  assert.equal((await redeemShareCode(env, created.share.code, { id: "guest-1", login: "guest" })).ok, true);
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
  env.DB.shareCodes.set("code-hash", { machine_id: "machine-1", expires_at: Date.now() + 60000, redeemed_at: null });
  assert.deepEqual(await deleteMachine(env, "machine-1", "owner-1"), { ok: true });
  assert.equal(env.DB.machines.size, 0);
  assert.equal(env.DB.grants.size, 0);
  assert.equal(env.DB.shareCodes.size, 0);
});
