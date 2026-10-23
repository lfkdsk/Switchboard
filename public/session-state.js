(function (root) {
  "use strict";

  function advanceOffset(current, bytes) {
    const start = validOffset(current) ? current : 0;
    const count = Number(bytes);
    return Number.isSafeInteger(count) && count >= 0 && start <= Number.MAX_SAFE_INTEGER - count
      ? start + count
      : start;
  }

  function daemonRetainsSessions(features) {
    const supported = new Set(Array.isArray(features) ? features : []);
    return supported.has("session-replay-v1") && supported.has("pty-holder-v1");
  }

  function shouldNotifyClientGone(features) {
    // Unknown capabilities must remain compatible with legacy daemons. Modern
    // holder-aware daemons ignore client-gone and advertise both features.
    return !daemonRetainsSessions(features);
  }

  function validOffset(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  root.SwitchboardSessionState = {
    advanceOffset,
    daemonRetainsSessions,
    shouldNotifyClientGone,
  };
})(typeof globalThis === "object" ? globalThis : window);
