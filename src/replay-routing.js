// Replay frames share the daemon WebSocket with live terminal output. The relay
// records the requesting browser per session after replay metadata, then sends
// that session's replay bytes only to that browser. Other sessions' live frames
// remain broadcast and cannot consume or inherit the replay target.
export function browserMessage(message, clientId) {
  if (typeof message !== "string") return message;
  let value;
  try { value = JSON.parse(message); } catch { return message; }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "open") return message;
  return JSON.stringify({ ...value, relayClientId: clientId });
}

export function resetReplayRoutes() {
  // A target is meaningful only for the daemon WebSocket that announced it.
  // Reusing it after daemon replacement could misroute the new daemon's first
  // live frame if the predecessor disconnected between metadata and payload.
  return {};
}

function binaryFrame(message) {
  const bytes = message instanceof ArrayBuffer
    ? new Uint8Array(message)
    : new Uint8Array(message.buffer, message.byteOffset || 0, message.byteLength);
  if (!bytes.length || bytes.length < 1 + bytes[0]) return null;
  return {
    sid: new TextDecoder().decode(bytes.subarray(1, 1 + bytes[0])),
    payloadBytes: bytes.length - 1 - bytes[0],
  };
}

export function daemonRoute(message, replayTargets = {}) {
  if (typeof message === "string") {
    let value;
    try { value = JSON.parse(message); } catch { return { target: null, replayTargets, message }; }
    const target = typeof value.relayClientId === "string" ? value.relayClientId : null;
    if (target) delete value.relayClientId;
    let next = replayTargets;
    if (value.type === "session-replay" && target && typeof value.sid === "string" &&
        Number.isSafeInteger(value.bytes) && value.bytes > 0) {
      next = { ...replayTargets, [value.sid]: { clientId: target, bytes: value.bytes } };
    }
    return { target, replayTargets: next, message: target ? JSON.stringify(value) : message };
  }
  const frame = binaryFrame(message);
  const replay = frame && replayTargets[frame.sid];
  if (!replay) return { target: null, replayTargets, message };
  const remaining = replay.bytes - frame.payloadBytes;
  const next = { ...replayTargets };
  if (remaining > 0) next[frame.sid] = { ...replay, bytes: remaining };
  else delete next[frame.sid];
  return { target: replay.clientId, replayTargets: next, message };
}
