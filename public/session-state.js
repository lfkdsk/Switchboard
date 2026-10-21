(function (root) {
  "use strict";

  const VERSION = 1;
  const PREFIX = "switchboard:shells:v1:";

  function connectionNode(conn) {
    if (conn?.mode === "machine") return String(conn.machineId || "");
    if (conn?.mode === "token") return "token-" + hash(String(conn.token || ""));
    return "";
  }

  function storageKey(origin, conn, account) {
    const relay = encodeURIComponent(String(origin || ""));
    const owner = conn?.mode === "machine"
      ? String(account?.id || account?.login || "account")
      : "anonymous";
    return PREFIX + relay + ":" + encodeURIComponent(owner) + ":" +
      encodeURIComponent(connectionNode(conn));
  }

  function load(storage, key, node) {
    try {
      const parsed = JSON.parse(storage.getItem(key) || "null");
      return normalize(parsed, node);
    } catch {
      return emptyState();
    }
  }

  function save(storage, key, state) {
    try {
      storage.setItem(key, JSON.stringify(normalize(state)));
      return true;
    } catch {
      return false;
    }
  }

  function normalize(value, expectedNode) {
    const shells = [];
    const seen = new Set();
    for (const entry of Array.isArray(value?.shells) ? value.shells : []) {
      const sid = validSid(entry?.sid) ? entry.sid : null;
      const node = typeof entry?.node === "string" ? entry.node : "";
      if (!sid || seen.has(sid) || (expectedNode != null && node !== expectedNode)) continue;
      seen.add(sid);
      shells.push({
        sid,
        node,
        label: typeof entry.label === "string" ? entry.label.slice(0, 256) : "shell",
        offset: validOffset(entry.offset) ? entry.offset : null,
        cols: dimension(entry.cols),
        rows: dimension(entry.rows),
      });
    }
    const activeSid = shells.some((entry) => entry.sid === value?.activeSid)
      ? value.activeSid
      : shells[0]?.sid || null;
    return { version: VERSION, activeSid, shells };
  }

  function advanceOffset(current, bytes) {
    const start = validOffset(current) ? current : 0;
    const count = Number(bytes);
    return Number.isSafeInteger(count) && count >= 0 && start <= Number.MAX_SAFE_INTEGER - count
      ? start + count
      : start;
  }

  function emptyState() {
    return { version: VERSION, activeSid: null, shells: [] };
  }
  function validSid(value) {
    return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) &&
      value !== "." && value !== "..";
  }
  function validOffset(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }
  function dimension(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  function hash(value) {
    let first = 2166136261;
    let second = 2246822507;
    for (let index = 0; index < value.length; index++) {
      first = Math.imul(first ^ value.charCodeAt(index), 16777619);
      second = Math.imul(second ^ value.charCodeAt(index), 3266489917);
    }
    return (first >>> 0).toString(16).padStart(8, "0") +
      (second >>> 0).toString(16).padStart(8, "0");
  }

  root.SwitchboardSessionState = {
    advanceOffset,
    connectionNode,
    emptyState,
    load,
    normalize,
    save,
    storageKey,
  };
})(typeof globalThis === "object" ? globalThis : window);
