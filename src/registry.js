/**
 * D1-backed registry: machines, agent tokens, and the CLI-login handshake.
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
export async function registerMachine(env, machineId, account, name, peer) {
  const existing = await env.DB.prepare("SELECT account_id FROM machines WHERE machine_id=?").bind(machineId).first();
  if (existing && existing.account_id !== account.id) return false;
  const now = Date.now();
  if (existing) {
    await env.DB.prepare("UPDATE machines SET online=1, last_seen=?, name=?, peer=? WHERE machine_id=?")
      .bind(now, name || "", peer ? 1 : 0, machineId).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO machines (machine_id, account_id, account_login, name, online, created_at, last_seen, peer) VALUES (?,?,?,?,1,?,?,?)",
    ).bind(machineId, account.id, account.login, name || "", now, now, peer ? 1 : 0).run();
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
// Who owns this machine, and does it take peer connections? One row read answers
// both questions the /ws gate asks, so it stays one round-trip to D1.
export async function machineAccess(env, machineId) {
  const row = await env.DB.prepare(
    "SELECT account_id, peer FROM machines WHERE machine_id=?",
  ).bind(machineId).first();
  return row ? { accountId: row.account_id, peer: !!row.peer } : null;
}
export async function listMachines(env, accountId) {
  const { results } = await env.DB.prepare(
    // Stable order: created_at never changes, so rows keep a fixed position.
    // (Ordering by last_seen made rows re-shuffle on every heartbeat → jitter.)
    "SELECT machine_id, name, online, created_at, last_seen, rtt, cpu, mem_used, mem_total, activity, peer FROM machines WHERE account_id=? ORDER BY created_at ASC, machine_id ASC",
  ).bind(accountId).all();
  // Hand the client a parsed object; a row written by an older daemon has none.
  return (results || []).map((r) => {
    let activity = null;
    if (r.activity) { try { activity = JSON.parse(r.activity); } catch {} }
    return { ...r, activity, peer: !!r.peer, online: isOnline(r.last_seen) };
  });
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
  await env.DB.prepare("DELETE FROM machines WHERE machine_id=?").bind(machineId).run();
  return { ok: true };
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
