const crypto = require("crypto");

const FEATURE = "account-sessions-v1";
const INPUT_MAGIC = Buffer.from("SBI1", "ascii");
const OUTPUT_MAGIC = Buffer.from("SBO1", "ascii");
const HEADER_BYTES = 8;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ACTIVE_GRANT_SNAPSHOT = 4096;
const MAX_ACCOUNT_ID_LENGTH = 512;
const SESSION_ACTIONS = Object.freeze([
  "sessions",
  "live-output",
  "replay",
  "history-list",
  "history-read",
  "activity",
  "input",
  "resize",
  "close",
  "exit",
  "reset",
  "upload",
]);
const SESSION_ACTION_SET = new Set(SESSION_ACTIONS);
const OWNER_SUPERVISOR_ACTIONS = Object.freeze([
  "sessions",
  "live-output",
  "replay",
  "history-list",
  "history-read",
  "activity",
  "close",
  "exit",
  "reset",
]);
const OWNER_SUPERVISOR_ACTION_SET = new Set(OWNER_SUPERVISOR_ACTIONS);
const JOB_ACTIONS = Object.freeze([
  "job-list",
  "job-read",
  "job-get",
  "job-kill",
]);
const JOB_ACTION_SET = new Set(JOB_ACTIONS);

function validPrincipal(principal) {
  return principal && typeof principal.accountId === "string" && !!principal.accountId &&
    typeof principal.clientId === "string" && !!principal.clientId &&
    (principal.expiresAt == null || Number.isFinite(principal.expiresAt)) &&
    (principal.accessVia === "owner" || principal.accessVia === "grant");
}

function principalAccessExpired(principal, now = Date.now()) {
  return validPrincipal(principal) && principal.accessVia === "grant" &&
    Number.isFinite(principal.expiresAt) && principal.expiresAt <= now;
}

function grantExpiryForAccount(principals, accountId) {
  let found = false;
  let expiresAt = null;
  for (const principal of principals) {
    if (!validPrincipal(principal) || principal.accountId !== accountId ||
        principal.accessVia !== "grant") continue;
    found = true;
    if (principal.expiresAt == null) return { found, expiresAt: null };
    if (!Number.isFinite(expiresAt) || principal.expiresAt > expiresAt) {
      expiresAt = principal.expiresAt;
    }
  }
  return { found, expiresAt };
}

function reconcileGrantSnapshot(sessionValues, machineOwnerAccountId, snapshot, now = Date.now()) {
  if (typeof machineOwnerAccountId !== "string" || !machineOwnerAccountId ||
      !Array.isArray(snapshot) || snapshot.length > MAX_ACTIVE_GRANT_SNAPSHOT) return null;
  const activeGrants = new Map();
  for (const entry of snapshot) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.accountId !== "string" || !entry.accountId ||
        entry.accountId.length > MAX_ACCOUNT_ID_LENGTH ||
        entry.accountId === machineOwnerAccountId || activeGrants.has(entry.accountId) ||
        (entry.expiresAt !== null && !Number.isFinite(entry.expiresAt))) return null;
    activeGrants.set(entry.accountId, entry.expiresAt);
  }

  const retained = new Map();
  const ended = new Map();
  for (const session of sessionValues) {
    const accountId = session?.ownerAccountId;
    if (typeof accountId !== "string" || !accountId || accountId === machineOwnerAccountId) continue;
    if (!activeGrants.has(accountId)) {
      const expired = Number.isFinite(session.accessExpiresAt) && session.accessExpiresAt <= now;
      if (!ended.has(accountId) || expired) {
        ended.set(accountId, expired ? "access-expired" : "access-revoked");
      }
      retained.delete(accountId);
      continue;
    }
    const expiresAt = activeGrants.get(accountId);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      ended.set(accountId, "access-expired");
      retained.delete(accountId);
    } else if (!ended.has(accountId)) {
      retained.set(accountId, expiresAt);
    }
  }
  return { activeGrants, retained, ended };
}

function validRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return false;
  if (route.kind === "owner") return true;
  if (route.kind === "account") return typeof route.accountId === "string" && !!route.accountId;
  return route.kind === "client" && typeof route.accountId === "string" && !!route.accountId &&
    typeof route.clientId === "string" && !!route.clientId;
}

function decodeBinary(value, magic = INPUT_MAGIC) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (input.length < HEADER_BYTES || !input.subarray(0, 4).equals(magic)) return null;
  const length = input.readUInt32BE(4);
  if (!length || length > MAX_METADATA_BYTES || HEADER_BYTES + length > input.length) return null;
  let metadata;
  try { metadata = JSON.parse(input.toString("utf8", HEADER_BYTES, HEADER_BYTES + length)); }
  catch { return null; }
  return { metadata, payload: input.subarray(HEADER_BYTES + length) };
}

function encodeBinary(value, route) {
  if (!validRoute(route)) return null;
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const metadata = Buffer.from(JSON.stringify({ version: 1, route }));
  if (!metadata.length || metadata.length > MAX_METADATA_BYTES) return null;
  const output = Buffer.allocUnsafe(HEADER_BYTES + metadata.length + payload.length);
  OUTPUT_MAGIC.copy(output, 0);
  output.writeUInt32BE(metadata.length, 4);
  metadata.copy(output, HEADER_BYTES);
  payload.copy(output, HEADER_BYTES + metadata.length);
  return output;
}

function unwrapBrowserJson(value, expectedNonce) {
  if (!value || value.type !== "_sb_browser" || value.version !== 1 ||
      typeof expectedNonce !== "string" || value.nonce !== expectedNonce ||
      !validPrincipal(value.principal) || !value.message ||
      typeof value.message !== "object" || Array.isArray(value.message)) return null;
  return { principal: value.principal, message: value.message };
}

function unwrapBrowserBinary(value, expectedNonce) {
  const decoded = decodeBinary(value);
  if (!decoded || decoded.metadata?.version !== 1 || decoded.metadata.nonce !== expectedNonce ||
      !validPrincipal(decoded.metadata.principal)) return null;
  return { principal: decoded.metadata.principal, message: decoded.payload };
}

function wrapDaemonJson(message, route) {
  if (!validRoute(route)) return null;
  return JSON.stringify({ type: "_sb_daemon", version: 1, route, message });
}

function clientRoute(principal) {
  if (!validPrincipal(principal)) return null;
  return { kind: "client", accountId: principal.accountId, clientId: principal.clientId };
}
function accountRoute(accountId) {
  return typeof accountId === "string" && accountId ? { kind: "account", accountId } : null;
}
function ownerRoute() { return { kind: "owner" }; }

function daemonResponseRoute(message, explicitRoute, requestRoutes) {
  if (explicitRoute != null) return validRoute(explicitRoute) ? explicitRoute : null;
  if (message?.id) return requestRoutes.get(String(message.id)) || null;
  return ownerRoute();
}

function sameClient(route, principal) {
  return route?.kind === "client" && validPrincipal(principal) &&
    route.accountId === principal.accountId && route.clientId === principal.clientId;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function sessionStorageId(accountId, sid) {
  return "v1-" + digest(String(accountId) + "\0" + String(sid));
}

function supervisorSessionId(accountId, sid) {
  return "supervised-" + digest(String(accountId) + "\0" + String(sid));
}

function canAccessSession(principal, session, machineOwnerAccountId) {
  if (!validPrincipal(principal) || !session?.ownerAccountId) return false;
  if (principal.accountId === session.ownerAccountId) return true;
  return principal.accessVia === "owner" && principal.accountId === machineOwnerAccountId;
}

function canAccessSessionFor(action, principal, session, machineOwnerAccountId) {
  if (!SESSION_ACTION_SET.has(action) || !validPrincipal(principal) || !session?.ownerAccountId) return false;
  if (principal.accountId === session.ownerAccountId) return true;
  return OWNER_SUPERVISOR_ACTION_SET.has(action) &&
    principal.accessVia === "owner" && principal.accountId === machineOwnerAccountId;
}

function canAccessJobFor(action, principal, job, machineOwnerAccountId) {
  if (!JOB_ACTION_SET.has(action) || !validPrincipal(principal) || !job?.ownerAccountId) return false;
  if (principal.accountId === job.ownerAccountId) return true;
  return principal.accessVia === "owner" && principal.accountId === machineOwnerAccountId;
}

function ownedSessionEntries(entries, accountId) {
  if (typeof accountId !== "string" || !accountId) return [];
  return [...entries].filter(([, session]) => session?.ownerAccountId === accountId);
}

function findAccessibleSession(entries, principal, machineOwnerAccountId, wireSid, action) {
  const ordered = [...entries].sort(([, a], [, b]) =>
    Number(b?.ownerAccountId === principal?.accountId) -
      Number(a?.ownerAccountId === principal?.accountId));
  for (const [storageId, session] of ordered) {
    if (!canAccessSessionFor(action, principal, session, machineOwnerAccountId)) continue;
    if (wireSessionId(session, principal, machineOwnerAccountId) === wireSid) {
      return { storageId, session };
    }
  }
  return null;
}

function wireSessionId(session, principal, machineOwnerAccountId) {
  if (!canAccessSession(principal, session, machineOwnerAccountId)) return null;
  return principal.accountId === session.ownerAccountId
    ? session.sid
    : supervisorSessionId(session.ownerAccountId, session.sid);
}

function visibleSessions(entries, principal, machineOwnerAccountId) {
  return entries.filter((entry) => canAccessSession(principal, entry, machineOwnerAccountId));
}

module.exports = {
  FEATURE,
  INPUT_MAGIC,
  JOB_ACTIONS,
  OUTPUT_MAGIC,
  OWNER_SUPERVISOR_ACTIONS,
  SESSION_ACTIONS,
  accountRoute,
  canAccessJobFor,
  canAccessSession,
  canAccessSessionFor,
  clientRoute,
  daemonResponseRoute,
  decodeBinary,
  encodeBinary,
  findAccessibleSession,
  grantExpiryForAccount,
  ownerRoute,
  ownedSessionEntries,
  principalAccessExpired,
  reconcileGrantSnapshot,
  sameClient,
  sessionStorageId,
  supervisorSessionId,
  unwrapBrowserBinary,
  unwrapBrowserJson,
  validPrincipal,
  visibleSessions,
  wireSessionId,
  wrapDaemonJson,
};
