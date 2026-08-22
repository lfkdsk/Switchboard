/**
 * D1-backed registry: machines, delegated access, agent tokens, and the
 * CLI-login handshake.
 * The relay stays a transparent forwarder for terminal traffic; this module is
 * only the account/ownership bookkeeping around it.
 */

const enc = new TextEncoder();

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randHex(n = 32) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- agent tokens --------------------------------------------------------
export async function mintAgentToken(env, account) {
  const token = randHex(32);
  await env.DB.prepare(
    "INSERT INTO agent_tokens (token_hash, account_id, account_login, created_at) VALUES (?,?,?,?)",
  ).bind(await sha256hex(token), account.id, account.login, Date.now()).run();
  return token;
}
export async function verifyAgentToken(env, token) {
  if (!token) return null;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare(
    "SELECT account_id, account_login FROM agent_tokens WHERE token_hash=?",
  ).bind(hash).first();
  if (!row) return null;
  await env.DB.prepare("UPDATE agent_tokens SET last_used=? WHERE token_hash=?").bind(Date.now(), hash).run();
  return { id: row.account_id, login: row.account_login };
}

// ---- machines ------------------------------------------------------------
// Returns false if the machine_id is already claimed by a different account.
// `peer` is the host's own answer to "may my other machines run things here?",
// re-stated on every connect — so flipping it is a daemon restart, not a support
// ticket, and a machine that has gone away can't leave a stale `yes` behind.
export async function registerMachine(env, machineId, account, name, peer, platform = null, arch = null) {
  const existing = await env.DB.prepare("SELECT account_id FROM machines WHERE machine_id=?").bind(machineId).first();
  if (existing && existing.account_id !== account.id) return false;
  const now = Date.now();
  if (existing) {
    await env.DB.prepare(
      `UPDATE machines SET online=1, last_seen=?, name=?, peer=?,
         platform=COALESCE(?, platform), arch=COALESCE(?, arch) WHERE machine_id=?`,
    ).bind(now, name || "", peer ? 1 : 0, platform, arch, machineId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO machines
        (machine_id, account_id, account_login, name, online, created_at, last_seen, peer, platform, arch)
       VALUES (?,?,?,?,1,?,?,?,?,?)`,
    ).bind(machineId, account.id, account.login, name || "", now, now, peer ? 1 : 0, platform, arch).run();
  }
  return true;
}
export async function setMachineOffline(env, machineId) {
  // Clear activity too: "claude · running Bash" is a claim about *now*, and
  // leaving the last one behind would have an offline machine still looking busy.
  await env.DB.prepare("UPDATE machines SET online=0, last_seen=?, activity=NULL WHERE machine_id=?")
    .bind(Date.now(), machineId).run();
}
// Heartbeat: each daemon `stats` message bumps last_seen (+ latency/load) so the
// dashboard shows accurate, self-healing status (online = last_seen is fresh).
export async function updateMachineStats(env, machineId, s) {
  await env.DB.prepare(
    `UPDATE machines SET online=1, last_seen=?, rtt=?, cpu=?, mem_used=?, mem_total=?,
       activity=?, platform=COALESCE(?, platform), arch=COALESCE(?, arch) WHERE machine_id=?`,
  ).bind(
    Date.now(), s.rtt ?? null, s.cpu ?? null, s.memUsed ?? null, s.memTotal ?? null,
    // Stored as an opaque JSON blob: it's display-only, ephemeral, and rides in
    // the UPDATE the heartbeat already performs, so it costs no extra write.
    s.act ? JSON.stringify(s.act) : null, s.platform ?? null, s.arch ?? null,
    machineId,
  ).run();
}
// Owner or live grantee. A browser grant is full shell access; `peer` remains a
// separate host-side opt-in that the Worker applies to agent-token clients.
// Re-evaluated on every connection so a week-long session cookie never caches a
// revoked grant.
export async function machineAccess(env, machineId, accountId) {
  const row = await env.DB.prepare(
    "SELECT account_id, peer FROM machines WHERE machine_id=?",
  ).bind(machineId).first();
  if (!row) return null;
  if (row.account_id === accountId) {
    return { accountId: row.account_id, peer: !!row.peer, via: "owner", expiresAt: null };
  }
  const grant = await env.DB.prepare(
    `SELECT expires_at FROM machine_grants
      WHERE machine_id=? AND grantee_id=? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`,
  ).bind(machineId, accountId, Date.now()).first();
  return grant
    ? { accountId: row.account_id, peer: !!row.peer, via: "grant", expiresAt: grant.expires_at ?? null }
    : null;
}

const MACHINE_COLS = "machine_id, name, online, created_at, last_seen, rtt, cpu, mem_used, mem_total, platform, arch, activity, peer";

function withActivity(results) {
  return (results || []).map((r) => {
    let activity = null;
    if (r.activity) { try { activity = JSON.parse(r.activity); } catch {} }
    return { ...r, activity, peer: !!r.peer, online: isOnline(r.last_seen) };
  });
}

export async function listMachines(env, accountId) {
  const { results } = await env.DB.prepare(
    // Stable order: created_at never changes, so rows keep a fixed position.
    // (Ordering by last_seen made rows re-shuffle on every heartbeat → jitter.)
    `SELECT ${MACHINE_COLS} FROM machines WHERE account_id=? ORDER BY created_at ASC, machine_id ASC`,
  ).bind(accountId).all();
  return withActivity(results);
}

// Machines shared with an account, shaped like owned machines plus the owner
// and expiry labels the dashboard/CLI need to explain why each row is visible.
export async function listSharedWithMe(env, accountId) {
  const cols = MACHINE_COLS.split(", ").map((c) => "m." + c).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT ${cols}, m.account_login AS owner_login, g.expires_at
       FROM machine_grants g JOIN machines m ON m.machine_id=g.machine_id
      WHERE g.grantee_id=? AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > ?)
      ORDER BY m.created_at ASC, m.machine_id ASC`,
  ).bind(accountId, Date.now()).all();
  return withActivity(results).map((m) => ({ ...m, shared: true }));
}

export async function listReachableMachines(env, accountId) {
  const [owned, shared] = await Promise.all([
    listMachines(env, accountId),
    listSharedWithMe(env, accountId),
  ]);
  return owned.concat(shared);
}

// A machine is "online" while its heartbeat stays fresh — the `online` column is
// only a hint, since a daemon that dies ungracefully never gets to clear it.
// Mirrors the window the dashboard applies, so every caller agrees on who's up.
const ONLINE_WINDOW_MS = 6000;
export function isOnline(lastSeen) {
  return Date.now() - lastSeen < ONLINE_WINDOW_MS;
}

// Remove one of the caller's own machines, but only while it's offline — a live
// daemon would just re-register on its next heartbeat, so deleting it is futile
// and looks like a bug. Returns { ok } or { ok:false, reason }.
export async function deleteMachine(env, machineId, accountId) {
  const row = await env.DB.prepare(
    "SELECT account_id, last_seen FROM machines WHERE machine_id=?",
  ).bind(machineId).first();
  if (!row || row.account_id !== accountId) return { ok: false, reason: "not-found" };
  if (isOnline(row.last_seen)) return { ok: false, reason: "online" };
  // A host keeps its machine id across reinstalls. Delete grants with the row so
  // re-registering that id cannot revive access the owner believed was removed.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM machine_share_codes WHERE machine_id=?").bind(machineId),
    env.DB.prepare("DELETE FROM machine_grants WHERE machine_id=?").bind(machineId),
    env.DB.prepare("DELETE FROM machines WHERE machine_id=?").bind(machineId),
  ]);
  return { ok: true };
}

// ---- delegated machine access -------------------------------------------
// A grant widens who may open the machine; ownership never moves. Only the
// owner may create a share code. The signed-in recipient redeems it into a
// grant, and may later leave, but cannot share onward.

async function machineOwner(env, machineId) {
  const row = await env.DB.prepare(
    "SELECT account_id, account_login FROM machines WHERE machine_id=?",
  ).bind(machineId).first();
  return row || null;
}

const SHARE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHARE_CODE_LENGTH = 20; // 100 bits; compact enough to copy, infeasible to guess
const SHARE_CODE_TTL_MS = 10 * 60 * 1000;

function newShareCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(SHARE_CODE_LENGTH));
  return [...bytes].map((b) => SHARE_CODE_ALPHABET[b & 31]).join("");
}
function normalizeShareCode(code) {
  const raw = String(code || "").toUpperCase().replace(/[\s-]/g, "");
  return raw.length === SHARE_CODE_LENGTH && [...raw].every((c) => SHARE_CODE_ALPHABET.includes(c)) ? raw : null;
}
function formatShareCode(raw) {
  return raw.match(/.{1,4}/g).join("-");
}
function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export async function createShareCode(env, machineId, ownerId, accessExpiresAt = null) {
  const owner = await machineOwner(env, machineId);
  if (!owner || owner.account_id !== ownerId) return { ok: false, reason: "not-found" };

  const now = Date.now();
  if (accessExpiresAt != null && (!Number.isFinite(accessExpiresAt) || accessExpiresAt <= now)) {
    return { ok: false, reason: "bad-expiry" };
  }
  const raw = newShareCode();
  const codeHash = await sha256hex(raw);
  const expiresAt = now + SHARE_CODE_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO machine_share_codes
       (code_hash, machine_id, created_by_id, created_by_login, created_at, expires_at, access_expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(codeHash, machineId, owner.account_id, owner.account_login, now, expiresAt, accessExpiresAt).run();
  // Opportunistic cleanup keeps this ephemeral table small without a cron.
  await env.DB.prepare(
    "DELETE FROM machine_share_codes WHERE expires_at<=? OR (redeemed_at IS NOT NULL AND redeemed_at<=?)",
  ).bind(now, now - 86400000).run();

  return {
    ok: true,
    share: { code: formatShareCode(raw), expires_at: expiresAt, access_expires_at: accessExpiresAt },
  };
}

export async function redeemShareCode(env, code, account) {
  const raw = normalizeShareCode(code);
  if (!raw || !account?.id || !account?.login) return { ok: false, reason: "invalid" };
  const codeHash = await sha256hex(raw);
  const now = Date.now();
  const share = await env.DB.prepare(
    `SELECT machine_id, access_expires_at
       FROM machine_share_codes
      WHERE code_hash=? AND redeemed_at IS NULL AND expires_at>?
        AND (access_expires_at IS NULL OR access_expires_at>?)`,
  ).bind(codeHash, now, now).first();
  if (!share) return { ok: false, reason: "invalid" };

  const owner = await machineOwner(env, share.machine_id);
  if (!owner) return { ok: false, reason: "invalid" };
  if (owner.account_id === account.id) return { ok: false, reason: "self" };

  // Claim first with a conditional write. A concurrent redeemer then changes
  // zero rows and cannot receive a grant.
  const claim = await env.DB.prepare(
    `UPDATE machine_share_codes
        SET redeemed_at=?, redeemed_by_id=?, redeemed_by_login=?
      WHERE code_hash=? AND redeemed_at IS NULL AND expires_at>?
        AND (access_expires_at IS NULL OR access_expires_at>?)`,
  ).bind(now, account.id, account.login, codeHash, now, now).run();
  if (changed(claim) !== 1) return { ok: false, reason: "invalid" };

  await env.DB.prepare(
    `INSERT INTO machine_grants
       (machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login, created_at, expires_at, revoked_at)
     VALUES (?,?,?,?,?,?,?,NULL)
     ON CONFLICT (machine_id, grantee_id) DO UPDATE SET
       grantee_login=excluded.grantee_login,
       granted_by_id=excluded.granted_by_id,
       granted_by_login=excluded.granted_by_login,
       created_at=excluded.created_at,
       expires_at=excluded.expires_at,
       revoked_at=NULL`,
  ).bind(
    share.machine_id, account.id, account.login, owner.account_id, owner.account_login,
    now, share.access_expires_at ?? null,
  ).run();

  return {
    ok: true,
    grant: {
      machine_id: share.machine_id,
      owner_login: owner.account_login,
      grantee_id: account.id,
      grantee_login: account.login,
      created_at: now,
      expires_at: share.access_expires_at ?? null,
    },
  };
}

export async function revokeGrant(env, machineId, granteeId, callerId) {
  const owner = await machineOwner(env, machineId);
  if (!owner || (owner.account_id !== callerId && granteeId !== callerId)) {
    return { ok: false, reason: "not-found" };
  }
  const row = await env.DB.prepare(
    "SELECT revoked_at FROM machine_grants WHERE machine_id=? AND grantee_id=?",
  ).bind(machineId, granteeId).first();
  if (!row || row.revoked_at != null) return { ok: false, reason: "not-found" };
  await env.DB.prepare(
    "UPDATE machine_grants SET revoked_at=? WHERE machine_id=? AND grantee_id=?",
  ).bind(Date.now(), machineId, granteeId).run();
  return { ok: true };
}

export async function listGrants(env, machineId, ownerId) {
  const owner = await machineOwner(env, machineId);
  if (!owner || owner.account_id !== ownerId) return null;
  const { results } = await env.DB.prepare(
    `SELECT grantee_id, grantee_login, created_at, expires_at
       FROM machine_grants
      WHERE machine_id=? AND revoked_at IS NULL
      ORDER BY created_at ASC`,
  ).bind(machineId).all();
  return results || [];
}

// ---- CLI-login handshake (PKCE-like) -------------------------------------
export async function cliStart(env, state, verifierHash) {
  await env.DB.prepare("DELETE FROM cli_logins WHERE created_at < ?").bind(Date.now() - 600000).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO cli_logins (state, verifier_hash, status, created_at) VALUES (?,?, 'pending', ?)",
  ).bind(state, verifierHash, Date.now()).run();
}
// Called by the signed-in browser page; mints the agent token for `state`.
export async function cliComplete(env, state, account) {
  const row = await env.DB.prepare("SELECT state FROM cli_logins WHERE state=?").bind(state).first();
  if (!row) return false;
  const agentToken = await mintAgentToken(env, account);
  await env.DB.prepare(
    "UPDATE cli_logins SET status='ready', account_id=?, account_login=?, agent_token=? WHERE state=?",
  ).bind(account.id, account.login, agentToken, state).run();
  return true;
}
// Called by the CLI; returns the agent token exactly once, gated by the verifier.
export async function cliPoll(env, state, verifier) {
  const row = await env.DB.prepare(
    "SELECT verifier_hash, status, agent_token, account_login FROM cli_logins WHERE state=?",
  ).bind(state).first();
  if (!row) return { status: "unknown" };
  if (row.status !== "ready") return { status: "pending" };
  if ((await sha256hex(verifier)) !== row.verifier_hash) return { status: "denied" };
  await env.DB.prepare("DELETE FROM cli_logins WHERE state=?").bind(state).run();
  return { status: "ready", agentToken: row.agent_token, login: row.account_login };
}
