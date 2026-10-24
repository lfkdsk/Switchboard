import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const visibility = require("../cli/lib/account-sessions.js");

const owner = { accountId: "owner-1", accessVia: "owner", clientId: "owner-client", expiresAt: null };
const guest = { accountId: "guest-1", accessVia: "grant", clientId: "guest-client", expiresAt: 123456789 };
const otherGuest = { accountId: "guest-2", accessVia: "grant", clientId: "other-client" };
const ownerSession = { sid: "same-browser-sid", ownerAccountId: "owner-1" };
const guestSession = { sid: "same-browser-sid", ownerAccountId: "guest-1" };

test("daemon accepts only the principal in the relay envelope", () => {
  const wrapped = visibility.unwrapBrowserJson({
    type: "_sb_browser",
    version: 1,
    nonce: "relay-daemon-nonce",
    principal: guest,
    message: {
      type: "open",
      sid: "shell-a",
      accountId: "owner-1",
      accessVia: "owner",
      principal: owner,
    },
  }, "relay-daemon-nonce");
  assert.deepEqual(wrapped.principal, guest);
  assert.equal(wrapped.message.accountId, "owner-1");
  assert.equal(visibility.unwrapBrowserJson({
    type: "open", principal: owner, message: { type: "open", sid: "shell-a" },
  }, "relay-daemon-nonce"), null);
});

test("daemon decodes stamped binary input with the authenticated principal", () => {
  const original = Buffer.from([5, ...Buffer.from("shell"), 0x61]);
  const metadata = Buffer.from(JSON.stringify({
    version: 1, nonce: "relay-daemon-nonce", principal: guest,
  }));
  const wrapped = Buffer.alloc(8 + metadata.length + original.length);
  visibility.INPUT_MAGIC.copy(wrapped, 0);
  wrapped.writeUInt32BE(metadata.length, 4);
  metadata.copy(wrapped, 8);
  original.copy(wrapped, 8 + metadata.length);
  const decoded = visibility.unwrapBrowserBinary(wrapped, "relay-daemon-nonce");
  assert.deepEqual(decoded.principal, guest);
  assert.deepEqual(decoded.message, original);
});

test("only a finite relay-stamped grant deadline expires browser authority", () => {
  assert.equal(visibility.principalAccessExpired(guest, guest.expiresAt), true);
  assert.equal(visibility.principalAccessExpired(guest, guest.expiresAt - 1), false);
  assert.equal(visibility.principalAccessExpired({ ...guest, expiresAt: null }, Date.now()), false);
  assert.equal(visibility.principalAccessExpired({ ...owner, expiresAt: 1 }, Date.now()), false);
  assert.equal(visibility.principalAccessExpired({ ...guest, expiresAt: "123" }, Date.now()), false);
});

test("concurrent grant sockets retain the widest still-authenticated deadline", () => {
  assert.deepEqual(visibility.grantExpiryForAccount([
    { ...guest, clientId: "old", expiresAt: 100 },
    { ...guest, clientId: "renewed", expiresAt: 200 },
    otherGuest,
  ], guest.accountId), { found: true, expiresAt: 200 });
  assert.deepEqual(visibility.grantExpiryForAccount([
    { ...guest, clientId: "finite", expiresAt: 200 },
    { ...guest, clientId: "indefinite", expiresAt: null },
  ], guest.accountId), { found: true, expiresAt: null });
  assert.deepEqual(
    visibility.grantExpiryForAccount([otherGuest], guest.accountId),
    { found: false, expiresAt: null },
  );
});

test("daemon reconnect snapshot kills missed revocations and refreshes recovered deadlines", () => {
  const now = 200;
  const reconciliation = visibility.reconcileGrantSnapshot([
    { sid: "owner", ownerAccountId: "owner-1", accessExpiresAt: null },
    { sid: "renewed", ownerAccountId: "guest-1", accessExpiresAt: 100 },
    { sid: "indefinite", ownerAccountId: "guest-2", accessExpiresAt: 150 },
    { sid: "revoked", ownerAccountId: "guest-revoked", accessExpiresAt: null },
    { sid: "expired", ownerAccountId: "guest-expired", accessExpiresAt: 200 },
    { sid: "legacy", ownerAccountId: null, accessExpiresAt: null },
  ], "owner-1", [
    { accountId: "guest-1", expiresAt: 300 },
    { accountId: "guest-2", expiresAt: null },
  ], now);

  assert.deepEqual(reconciliation.retained, new Map([
    ["guest-1", 300],
    ["guest-2", null],
  ]));
  assert.deepEqual(reconciliation.ended, new Map([
    ["guest-revoked", "access-revoked"],
    ["guest-expired", "access-expired"],
  ]));
});

test("daemon rejects malformed or incomplete active-grant snapshots", () => {
  const sessions = [{ sid: "visitor", ownerAccountId: "guest-1", accessExpiresAt: null }];
  for (const snapshot of [
    undefined,
    [{ accountId: "guest-1", expiresAt: "never" }],
    [{ accountId: "owner-1", expiresAt: null }],
    [{ accountId: "guest-1", expiresAt: null }, { accountId: "guest-1", expiresAt: null }],
    Array.from({ length: 4097 }, (_, index) => ({ accountId: `guest-${index}`, expiresAt: null })),
  ]) {
    assert.equal(visibility.reconcileGrantSnapshot(sessions, "owner-1", snapshot, 100), null);
  }
});

test("owner supervises every session while grants see only their own", () => {
  assert.equal(visibility.canAccessSession(owner, ownerSession, "owner-1"), true);
  assert.equal(visibility.canAccessSession(owner, guestSession, "owner-1"), true);
  assert.equal(visibility.canAccessSession(guest, guestSession, "owner-1"), true);
  assert.equal(visibility.canAccessSession(guest, ownerSession, "owner-1"), false);
  assert.equal(visibility.canAccessSession(otherGuest, guestSession, "owner-1"), false);
  assert.deepEqual(visibility.visibleSessions([ownerSession, guestSession], guest, "owner-1"), [guestSession]);
  assert.deepEqual(visibility.visibleSessions([ownerSession, guestSession], owner, "owner-1"), [ownerSession, guestSession]);
});

test("detached jobs are same-account resources with an owner supervisor", () => {
  const ownerJob = { id: "owner-job", ownerAccountId: "owner-1" };
  const guestJob = { id: "guest-job", ownerAccountId: "guest-1" };
  const legacyUnownedJob = { id: "legacy-job", ownerAccountId: null };

  for (const action of visibility.JOB_ACTIONS) {
    assert.equal(visibility.canAccessJobFor(action, owner, ownerJob, "owner-1"), true);
    assert.equal(visibility.canAccessJobFor(action, owner, guestJob, "owner-1"), true);
    assert.equal(visibility.canAccessJobFor(action, guest, guestJob, "owner-1"), true);
    assert.equal(visibility.canAccessJobFor(action, guest, ownerJob, "owner-1"), false);
    assert.equal(visibility.canAccessJobFor(action, otherGuest, guestJob, "owner-1"), false);
    assert.equal(visibility.canAccessJobFor(action, owner, legacyUnownedJob, "owner-1"), false);
  }
  assert.equal(visibility.canAccessJobFor("job-delete", owner, ownerJob, "owner-1"), false);
});

test("the same browser sid is namespaced by account and has a distinct owner-supervisor id", () => {
  assert.notEqual(
    visibility.sessionStorageId(ownerSession.ownerAccountId, ownerSession.sid),
    visibility.sessionStorageId(guestSession.ownerAccountId, guestSession.sid),
  );
  assert.equal(visibility.wireSessionId(guestSession, guest, "owner-1"), guestSession.sid);
  assert.match(visibility.wireSessionId(guestSession, owner, "owner-1"), /^supervised-/);
  assert.notEqual(
    visibility.wireSessionId(guestSession, owner, "owner-1"),
    visibility.wireSessionId(ownerSession, owner, "owner-1"),
  );
});

test("input resolves only an accessible wire session even when the visitor guesses the owner sid", () => {
  const entries = new Map([
    ["owner-storage", { sid: "owner-shell", ownerAccountId: "owner-1" }],
    ["guest-storage", { sid: "guest-shell", ownerAccountId: "guest-1" }],
  ]);
  assert.equal(
    visibility.findAccessibleSession(entries, guest, "owner-1", "owner-shell", "input"),
    null,
  );
  assert.equal(
    visibility.findAccessibleSession(entries, guest, "owner-1", "guest-shell", "input")?.storageId,
    "guest-storage",
  );
  assert.equal(
    visibility.findAccessibleSession(
      entries, owner, "owner-1", visibility.supervisorSessionId("guest-1", "guest-shell"), "input",
    ),
    null,
  );
  assert.equal(
    visibility.findAccessibleSession(
      entries, owner, "owner-1", visibility.supervisorSessionId("guest-1", "guest-shell"), "close",
    )?.storageId,
    "guest-storage",
  );
});

test("session-bearing message classes all use the same ownership guard", () => {
  assert.deepEqual(visibility.SESSION_ACTIONS, [
    "sessions", "live-output", "replay", "history-list", "history-read",
    "activity", "input", "resize", "close", "exit", "reset", "upload",
  ]);
  assert.deepEqual(visibility.OWNER_SUPERVISOR_ACTIONS, [
    "sessions", "live-output", "replay", "history-list", "history-read",
    "activity", "close", "exit", "reset",
  ]);
  for (const kind of visibility.SESSION_ACTIONS) {
    assert.equal(
      visibility.canAccessSessionFor(kind, guest, ownerSession, "owner-1"),
      false,
      `${kind} must reject a grant reading or mutating an owner session`,
    );
    const ownerMaySupervise = visibility.OWNER_SUPERVISOR_ACTIONS.includes(kind);
    assert.equal(visibility.canAccessSessionFor(kind, owner, guestSession, "owner-1"), ownerMaySupervise,
      `${kind} must apply the explicit owner-supervisor capability set`);
    assert.equal(visibility.canAccessSessionFor(kind, guest, guestSession, "owner-1"), true,
      `${kind} must remain available to the session owner`);
  }
  assert.equal(
    visibility.canAccessSessionFor("unknown-future-message", owner, ownerSession, "owner-1"),
    false,
    "unregistered message classes fail closed",
  );
});

test("revoke cleanup selects every opening/live session owned by that account only", () => {
  const entries = new Map([
    ["owner-storage", ownerSession],
    ["guest-storage-a", guestSession],
    ["guest-storage-b", { sid: "second", ownerAccountId: "guest-1" }],
    ["other-storage", { sid: "other", ownerAccountId: "guest-2" }],
  ]);
  assert.deepEqual(
    visibility.ownedSessionEntries(entries, "guest-1").map(([storageId]) => storageId),
    ["guest-storage-a", "guest-storage-b"],
  );
  assert.deepEqual(visibility.ownedSessionEntries(entries, ""), []);
});

test("adjacent request streams are bound to the initiating relay client", () => {
  const route = visibility.clientRoute(guest);
  assert.equal(visibility.sameClient(route, guest), true);
  assert.equal(visibility.sameClient(route, { ...guest, clientId: "second-tab" }), false);
  assert.equal(visibility.sameClient(route, owner), false);
  const frame = visibility.wrapDaemonJson({ type: "exec-out", id: "same-id" }, route);
  assert.deepEqual(JSON.parse(frame).route, route);
  const routes = new Map([["same-id", route]]);
  assert.deepEqual(visibility.daemonResponseRoute({ id: "same-id" }, null, routes), route);
  routes.delete("same-id");
  assert.equal(
    visibility.daemonResponseRoute({ type: "exec-exit", id: "same-id" }, null, routes),
    null,
    "a late response after requester cleanup must not fall back to the owner",
  );
  assert.deepEqual(visibility.daemonResponseRoute({ type: "stats" }, null, routes), { kind: "owner" });
});
