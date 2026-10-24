import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_OUTPUT_MAGIC,
  liveGrantForAccount,
  routeAllowsBrowser,
  routeDaemonMessage,
  stampBrowserMessage,
} from "../src/account-session-protocol.js";

function daemonBinary(route, payload) {
  const metadata = Buffer.from(JSON.stringify({ version: 1, route }));
  const frame = Buffer.alloc(8 + metadata.length + payload.length);
  Buffer.from(ACCOUNT_OUTPUT_MAGIC).copy(frame, 0);
  frame.writeUInt32BE(metadata.length, 4);
  metadata.copy(frame, 8);
  payload.copy(frame, 8 + metadata.length);
  return frame;
}

test("relay stamps its authenticated identity and does not trust browser self-reporting", () => {
  const stamped = JSON.parse(stampBrowserMessage(JSON.stringify({
    type: "open",
    sid: "shell-a",
    principal: { accountId: "forged-owner", accessVia: "owner", clientId: "forged-client" },
    accountId: "forged-owner",
    accessVia: "owner",
    relayClientId: "forged-client",
  }), {
    accountId: "guest-7",
    accessVia: "grant",
    clientId: "relay-client-9",
    expiresAt: 123456789,
    protocolNonce: "daemon-secret-nonce",
  }));

  assert.deepEqual(stamped.principal, {
    accountId: "guest-7",
    accessVia: "grant",
    clientId: "relay-client-9",
    expiresAt: 123456789,
  });
  assert.equal(stamped.message.accountId, "forged-owner");
  assert.equal(stamped.message.principal.accountId, "forged-owner");
});

test("relay stamps binary input instead of forwarding a browser-selected prefix", () => {
  const original = Uint8Array.from([3, ...Buffer.from("sid"), 0x61]);
  const stamped = stampBrowserMessage(original, {
    accountId: "guest-7", accessVia: "grant", clientId: "relay-client-9", expiresAt: 123456789,
    protocolNonce: "daemon-secret-nonce",
  });
  assert.ok(stamped instanceof Uint8Array);
  assert.equal(Buffer.from(stamped.subarray(0, 4)).toString("ascii"), "SBI1");
  const metadataLength = new DataView(stamped.buffer, stamped.byteOffset, stamped.byteLength).getUint32(4);
  const metadata = JSON.parse(Buffer.from(stamped.subarray(8, 8 + metadataLength)).toString("utf8"));
  assert.equal(metadata.principal.accountId, "guest-7");
  assert.equal(metadata.principal.expiresAt, 123456789);
  assert.equal(metadata.nonce, "daemon-secret-nonce");
  assert.deepEqual(stamped.subarray(8 + metadataLength), original);
});

test("daemon JSON routes are stripped and enforced by account, owner, and client", () => {
  const scoped = routeDaemonMessage(JSON.stringify({
    type: "_sb_daemon",
    version: 1,
    route: { kind: "client", accountId: "guest-7", clientId: "client-a" },
    message: { type: "sess-list", id: "request-1", sessions: [] },
  }));
  assert.deepEqual(JSON.parse(scoped.message), { type: "sess-list", id: "request-1", sessions: [] });
  assert.equal(routeAllowsBrowser(scoped.route, {
    accountId: "guest-7", accessVia: "grant", clientId: "client-a",
    protocolNonce: "daemon-secret-nonce",
  }, "owner-1"), true);
  assert.equal(routeAllowsBrowser(scoped.route, {
    accountId: "guest-7", accessVia: "grant", clientId: "client-b",
  }, "owner-1"), false);
  assert.equal(routeAllowsBrowser({ kind: "owner" }, {
    accountId: "owner-1", accessVia: "owner", clientId: "owner-client",
  }, "owner-1"), true);
  assert.equal(routeAllowsBrowser({ kind: "owner" }, {
    accountId: "guest-7", accessVia: "grant", clientId: "guest-client",
  }, "owner-1"), false);
});

test("daemon binary routes are stripped before browser delivery", () => {
  const payload = Buffer.from([3, ...Buffer.from("sid"), 0x61, 0x62]);
  const scoped = routeDaemonMessage(daemonBinary({ kind: "account", accountId: "guest-7" }, payload));
  assert.deepEqual(Buffer.from(scoped.message), payload);
  assert.equal(routeAllowsBrowser(scoped.route, {
    accountId: "guest-7", accessVia: "grant", clientId: "guest-client",
  }, "owner-1"), true);
  assert.equal(routeAllowsBrowser(scoped.route, {
    accountId: "other-guest", accessVia: "grant", clientId: "other-client",
  }, "owner-1"), false);
});

test("an expired socket does not end an account that has another live renewed grant", () => {
  const now = 200;
  assert.equal(liveGrantForAccount({
    accountId: "guest-7", accessVia: "grant", clientId: "renewed", expiresAt: 300,
  }, "guest-7", now), true);
  assert.equal(liveGrantForAccount({
    accountId: "guest-7", accessVia: "grant", clientId: "old", expiresAt: now,
  }, "guest-7", now), false);
  assert.equal(liveGrantForAccount({
    accountId: "guest-7", accessVia: "grant", clientId: "blocked", expiresAt: 300, blocked: "access-revoked",
  }, "guest-7", now), false);
  assert.equal(liveGrantForAccount({
    accountId: "other", accessVia: "grant", clientId: "other", expiresAt: null,
  }, "guest-7", now), false);
});

test("unscoped or malformed daemon frames fail closed in account-session mode", () => {
  assert.equal(routeDaemonMessage(JSON.stringify({ type: "sessions", list: [] })), null);
  assert.equal(routeDaemonMessage(JSON.stringify({
    type: "_sb_daemon", version: 1, route: { kind: "all" }, message: { type: "sessions", list: [] },
  })), null);
  assert.equal(routeDaemonMessage(Uint8Array.from([1, 2, 3])), null);
  assert.equal(stampBrowserMessage("not json", {
    accountId: "guest-7", accessVia: "grant", clientId: "client-a",
  }), null);
});
