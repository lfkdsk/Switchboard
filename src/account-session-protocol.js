const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const ACCOUNT_SESSIONS_FEATURE = "account-sessions-v1";

const INPUT_MAGIC = new Uint8Array([0x53, 0x42, 0x49, 0x31]); // SBI1
const OUTPUT_MAGIC = new Uint8Array([0x53, 0x42, 0x4f, 0x31]); // SBO1
const BINARY_HEADER_BYTES = 8;
const MAX_METADATA_BYTES = 64 * 1024;

function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function hasMagic(value, magic) {
  return value.length >= magic.length && magic.every((byte, index) => value[index] === byte);
}

function encodeBinary(magic, metadata, payload) {
  const body = bytes(payload);
  if (!body) return null;
  const encoded = textEncoder.encode(JSON.stringify(metadata));
  if (!encoded.length || encoded.length > MAX_METADATA_BYTES) return null;
  const result = new Uint8Array(BINARY_HEADER_BYTES + encoded.length + body.length);
  result.set(magic, 0);
  new DataView(result.buffer).setUint32(4, encoded.length);
  result.set(encoded, BINARY_HEADER_BYTES);
  result.set(body, BINARY_HEADER_BYTES + encoded.length);
  return result;
}

function decodeBinary(magic, value) {
  const input = bytes(value);
  if (!input || !hasMagic(input, magic) || input.length < BINARY_HEADER_BYTES) return null;
  const length = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(4);
  if (!length || length > MAX_METADATA_BYTES || BINARY_HEADER_BYTES + length > input.length) return null;
  let metadata;
  try { metadata = JSON.parse(textDecoder.decode(input.subarray(BINARY_HEADER_BYTES, BINARY_HEADER_BYTES + length))); }
  catch { return null; }
  return { metadata, payload: input.slice(BINARY_HEADER_BYTES + length) };
}

function validIdentity(identity) {
  return identity && typeof identity.accountId === "string" && identity.accountId &&
    typeof identity.clientId === "string" && identity.clientId &&
    typeof identity.protocolNonce === "string" && identity.protocolNonce &&
    (identity.expiresAt == null || Number.isFinite(identity.expiresAt)) &&
    (identity.accessVia === "owner" || identity.accessVia === "grant");
}

/** Add the relay-authenticated browser identity to a daemon-bound frame. */
export function stampBrowserMessage(message, identity) {
  if (!validIdentity(identity)) return null;
  const principal = {
    accountId: identity.accountId,
    accessVia: identity.accessVia,
    clientId: identity.clientId,
    expiresAt: identity.accessVia === "grant" && Number.isFinite(identity.expiresAt)
      ? identity.expiresAt : null,
  };
  if (typeof message === "string") {
    let inner;
    try { inner = JSON.parse(message); } catch { return null; }
    return JSON.stringify({
      type: "_sb_browser", version: 1, nonce: identity.protocolNonce, principal, message: inner,
    });
  }
  return encodeBinary(INPUT_MAGIC, { version: 1, nonce: identity.protocolNonce, principal }, message);
}

function validRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return false;
  if (route.kind === "owner") return true;
  if (route.kind === "account") return typeof route.accountId === "string" && !!route.accountId;
  return route.kind === "client" && typeof route.accountId === "string" && !!route.accountId &&
    typeof route.clientId === "string" && !!route.clientId;
}

/** Unwrap a daemon frame and retain only its relay-owned delivery route. */
export function routeDaemonMessage(message) {
  if (typeof message === "string") {
    let value;
    try { value = JSON.parse(message); } catch { return null; }
    if (!value || value.type !== "_sb_daemon" || value.version !== 1 ||
        !validRoute(value.route) || value.message == null) return null;
    return { route: value.route, message: JSON.stringify(value.message) };
  }
  const decoded = decodeBinary(OUTPUT_MAGIC, message);
  if (!decoded || decoded.metadata?.version !== 1 || !validRoute(decoded.metadata.route)) return null;
  return { route: decoded.metadata.route, message: decoded.payload };
}

export function routeAllowsBrowser(route, browser, ownerAccountId) {
  if (!validRoute(route) || !browser || browser.blocked) return false;
  if (route.kind === "owner") {
    return browser.accessVia === "owner" && browser.accountId === ownerAccountId;
  }
  if (route.kind === "account") return browser.accountId === route.accountId;
  return browser.accountId === route.accountId && browser.clientId === route.clientId;
}

export function liveGrantForAccount(browser, accountId, now = Date.now()) {
  return !!browser && !browser.blocked && browser.accessVia === "grant" &&
    browser.accountId === accountId &&
    (browser.expiresAt == null ||
      (Number.isFinite(browser.expiresAt) && browser.expiresAt > now));
}

// Exported for the daemon-side CommonJS implementation's byte-for-byte tests.
export const ACCOUNT_INPUT_MAGIC = INPUT_MAGIC;
export const ACCOUNT_OUTPUT_MAGIC = OUTPUT_MAGIC;
