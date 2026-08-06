/**
 * D1-backed registry: machines, delegated access, agent tokens, and the
 * CLI-login handshake. The relay stays a transparent forwarder for terminal
 * traffic; this module is only the account/ownership bookkeeping around it.
 */

import { githubUserByLogin } from "./auth.js";

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
export async function registerMachine(env, machineId, account, name) {
  const existing = await env.DB.prepare("SELECT account_id FROM machines WHERE machine_id=?").bind(machineId).first();
  if (existing && existing.account_id !== account.id) return false;
  const now = Date.now();
  if (existing) {
    await env.DB.prepare("UPDATE machines SET online=1, last_seen=?, name=? WHERE machine_id=?")
      .bind(now, name || "", machineId).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO machines (machine_id, account_id, account_login, name, online, created_at, last_seen) VALUES (?,?,?,?,1,?,?)",
    ).bind(machineId, account.id, account.login, name || "", now, now).run();
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
    "UPDATE machines SET online=1, last_seen=?, rtt=?, cpu=?, mem_used=?, mem_total=?, activity=? WHERE machine_id=?",
  ).bind(
    Date.now(), s.rtt ?? null, s.cpu ?? null, s.memUsed ?? null, s.memTotal ?? null,
    // Stored as an opaque JSON blob: it's display-only, ephemeral, and rides in
    // the UPDATE the heartbeat already performs, so it costs no extra write.
    s.act ? JSON.stringify(s.act) : null,
    machineId,
  ).run();
}
export async function machineOwner(env, machineId) {
  const row = await env.DB.prepare("SELECT account_id FROM machines WHERE machine_id=?").bind(machineId).first();
  return row ? row.account_id : null;
}
// The dashboard draws owned and shared-with-me machines with one renderer, so
// both queries have to return identically shaped rows — keep the column list in
// one place rather than trusting two SELECTs to stay in step.
const MACHINE_COLS = "machine_id, name, online, created_at, last_seen, rtt, cpu, mem_used, mem_total, activity";
// Hand the client a parsed object; a row written by an older daemon has none.
function withActivity(results) {
  return (results || []).map((r) => {
    let activity = null;
    if (r.activity) { try { activity = JSON.parse(r.activity); } catch {} }
    return { ...r, activity };
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

// A machine is "online" while its heartbeat stays fresh; mirror the dashboard's
// freshness window so the two agree on what's deletable.
const ONLINE_WINDOW_MS = 6000;

// Remove one of the caller's own machines, but only while it's offline — a live
// daemon would just re-register on its next heartbeat, so deleting it is futile
// and looks like a bug. Returns { ok } or { ok:false, reason }.
export async function deleteMachine(env, machineId, accountId) {
  const row = await env.DB.prepare(
    "SELECT account_id, last_seen FROM machines WHERE machine_id=?",
  ).bind(machineId).first();
  if (!row || row.account_id !== accountId) return { ok: false, reason: "not-found" };
  if (Date.now() - row.last_seen < ONLINE_WINDOW_MS) return { ok: false, reason: "online" };
  // Take the grants with it, in one batch (D1 runs a batch as a transaction).
  // The machine_id is chosen by the CLI and persisted on the host, so deleting
  // a machine and re-running the CLI there brings the *same* id back — leaving
  // the grant rows behind would silently resurrect access the owner thought
  // they had thrown away, and would hand it to whoever registers that id next.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM machine_grants WHERE machine_id=?").bind(machineId),
    env.DB.prepare("DELETE FROM machines WHERE machine_id=?").bind(machineId),
  ]);
  return { ok: true };
}

// ---- delegated access (grants) -------------------------------------------
// A grant lets another GitHub account open a shell on a machine it does not
// own, and nothing else: renaming, deleting, and re-sharing stay with the
// owner, so access can never be chained onward by whoever received it.

// Every "is this grant live?" question goes through this one predicate, so the
// answer can't drift between call sites. Both halves are evaluated in SQL
// against the current time (bound as the next ?), which is what makes a grant
// fail closed: a revoked or expired row simply stops matching, with no separate
// check anyone could forget to write. `t` is the table alias, if the query joins.
const liveGrant = (t = "") => `${t}revoked_at IS NULL AND (${t}expires_at IS NULL OR ${t}expires_at > ?)`;

// { via: 'owner' | 'grant', exec } | null — `exec` says whether software may
// drive the machine or only a person may sit at it. Deliberately re-run on every
// browser connect rather than resolved once and cached in the session: a session
// cookie is good for a week, so a cached answer would keep a revoked or expired
// grant working for days after it ended.
export async function canAccess(env, machineId, accountId) {
  if (!machineId || !accountId) return null;
  const m = await env.DB.prepare("SELECT account_id FROM machines WHERE machine_id=?").bind(machineId).first();
  if (!m) return null;
  if (m.account_id === accountId) return { via: "owner", exec: true };
  const g = await env.DB.prepare(
    `SELECT can_exec FROM machine_grants WHERE machine_id=? AND grantee_id=? AND ${liveGrant()}`,
  ).bind(machineId, accountId, Date.now()).first();
  return g ? { via: "grant", exec: !!g.can_exec } : null;
}

// Share one of your own machines with another GitHub user, by login.
// expiresAt is epoch ms, or null for a grant that never lapses on its own.
// Returns { ok:true, grant } or { ok:false, reason }.
export async function grantMachine(env, machineId, ownerId, granteeLogin, expiresAt = null, canExec = false) {
  const m = await env.DB.prepare(
    "SELECT account_id, account_login FROM machines WHERE machine_id=?",
  ).bind(machineId).first();
  // Same conflation deleteMachine makes: a caller who isn't the owner is told
  // "not-found" either way, so probing this endpoint reveals nothing about
  // machines they can't already see. Note the check is ownership, not
  // canAccess — a grantee must not be able to pass their access along.
  if (!m || m.account_id !== ownerId) return { ok: false, reason: "not-found" };

  const now = Date.now();
  // An expiry already in the past would write a grant that is dead on arrival;
  // that's a malformed request, not a very short share.
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= now)) {
    return { ok: false, reason: "bad-expiry" };
  }

  const gh = await githubUserByLogin(String(granteeLogin || "").trim());
  // Refuse rather than storing the typed login as if it were an id: the row
  // would grant nothing today, and would grant a shell to whoever eventually
  // registers that string. An unresolvable login is an error, not a pending share.
  if (!gh) return { ok: false, reason: "unknown-login" };
  if (gh.id === ownerId) return { ok: false, reason: "self" };

  await env.DB.prepare(
    // Re-granting someone you previously cut off revives their row (revoked_at
    // back to NULL) instead of failing on the primary key: the tombstone
    // recorded a decision, not a permanent ban. created_at is refreshed too, so
    // the audit trail reads as the current share rather than the old one.
    `INSERT INTO machine_grants
       (machine_id, grantee_id, grantee_login, granted_by_id, granted_by_login, created_at, expires_at, can_exec, revoked_at)
     VALUES (?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT (machine_id, grantee_id) DO UPDATE SET
       grantee_login=excluded.grantee_login,
       granted_by_id=excluded.granted_by_id,
       granted_by_login=excluded.granted_by_login,
       created_at=excluded.created_at,
       expires_at=excluded.expires_at,
       can_exec=excluded.can_exec,
       revoked_at=NULL`,
  ).bind(machineId, gh.id, gh.login, m.account_id, m.account_login, now, expiresAt, canExec ? 1 : 0).run();

  return { ok: true, grant: { grantee_id: gh.id, grantee_login: gh.login, created_at: now, expires_at: expiresAt, can_exec: canExec ? 1 : 0 } };
}

// Cut off a share. The owner can revoke anyone; a grantee can also revoke their
// own grant — walking away from access you were handed shouldn't need the
// owner's cooperation, and there's nothing to protect: they can already achieve
// it by never connecting. Returns { ok } or { ok:false, reason }.
export async function revokeGrant(env, machineId, granteeId, callerId) {
  const owner = await machineOwner(env, machineId);
  if (owner !== callerId && granteeId !== callerId) return { ok: false, reason: "not-found" };
  const row = await env.DB.prepare(
    "SELECT revoked_at FROM machine_grants WHERE machine_id=? AND grantee_id=?",
  ).bind(machineId, granteeId).first();
  if (!row || row.revoked_at != null) return { ok: false, reason: "not-found" };
  // Note what this does *not* do: a browser already holding an open WebSocket
  // keeps it. Authorisation is checked at connect time, so revocation takes
  // effect on their next connect, not mid-session.
  await env.DB.prepare("UPDATE machine_grants SET revoked_at=? WHERE machine_id=? AND grantee_id=?")
    .bind(Date.now(), machineId, granteeId).run();
  return { ok: true };
}

// Who currently has access to one of your machines. Returns null (not []) if
// the caller doesn't own it, so the route can answer 404 rather than "nobody".
// Expired-but-unrevoked grants are included: the owner should be able to see
// that a share lapsed, which is also why the UI labels expiry per row.
export async function listGrants(env, machineId, ownerId) {
  if ((await machineOwner(env, machineId)) !== ownerId) return null;
  const { results } = await env.DB.prepare(
    "SELECT grantee_id, grantee_login, created_at, expires_at, can_exec FROM machine_grants WHERE machine_id=? AND revoked_at IS NULL ORDER BY created_at ASC",
  ).bind(machineId).all();
  return results || [];
}

// Machines other people have shared with this account, in the same shape
// listMachines returns plus the owner's login and the grant's expiry, so the
// dashboard can render both lists through one path.
export async function listSharedWithMe(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT ${MACHINE_COLS.split(", ").map((c) => "m." + c).join(", ")},
            m.account_login AS owner_login, g.expires_at, g.can_exec
       FROM machine_grants g JOIN machines m ON m.machine_id = g.machine_id
      WHERE g.grantee_id=? AND ${liveGrant("g.")}
      ORDER BY m.created_at ASC, m.machine_id ASC`,
  ).bind(accountId, Date.now()).all();
  return withActivity(results);
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
