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
  await env.DB.prepare("UPDATE machines SET online=0, last_seen=? WHERE machine_id=?").bind(Date.now(), machineId).run();
}
export async function machineOwner(env, machineId) {
  const row = await env.DB.prepare("SELECT account_id FROM machines WHERE machine_id=?").bind(machineId).first();
  return row ? row.account_id : null;
}
export async function listMachines(env, accountId) {
  const { results } = await env.DB.prepare(
    "SELECT machine_id, name, online, created_at, last_seen FROM machines WHERE account_id=? ORDER BY online DESC, last_seen DESC",
  ).bind(accountId).all();
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
