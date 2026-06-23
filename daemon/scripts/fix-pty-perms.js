#!/usr/bin/env node
/**
 * node-pty ships prebuilt binaries, but on macOS the extracted `spawn-helper`
 * often loses its execute bit, making pty.spawn() fail with "posix_spawnp
 * failed". Re-assert +x on it.
 *
 * Located via require.resolve so it works wherever the package manager hoisted
 * node-pty. Exported so the daemon can also call it at runtime (belt and
 * suspenders if the postinstall hook was skipped). No-op where there's no helper
 * (e.g. Windows/conpty, source builds).
 */
const fs = require("fs");
const path = require("path");

function fixPtyPerms() {
  let ptyRoot;
  try {
    ptyRoot = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  } catch {
    return; // node-pty not resolvable yet
  }
  const helper = path.join(ptyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  try {
    fs.chmodSync(helper, 0o755);
    return helper;
  } catch {
    return; // no helper here (other platform / source build)
  }
}

module.exports = fixPtyPerms;

if (require.main === module) {
  const fixed = fixPtyPerms();
  if (fixed) console.log("[switchboard-daemon] chmod +x " + fixed);
}
