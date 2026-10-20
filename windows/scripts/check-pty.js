// Proves the bundled runtime can open a real ConPTY: load node-pty from the
// staged cli, run a command through it, and look for its output. Run with the
// bundled node.exe:
//
//   runtime\node.exe scripts\check-pty.js runtime\cli
"use strict";
const path = require("path");

const cliDir = path.resolve(process.argv[2] || ".");
const pty = require(path.join(cliDir, "node_modules", "node-pty"));

const MARK = "switchboard-pty-ok";
let out = "";
const p = pty.spawn("cmd.exe", ["/d", "/c", "echo " + MARK], { cols: 80, rows: 24 });
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => {
  // ConPTY can deliver the last output just after the exit notification.
  setTimeout(() => {
    if (!out.includes(MARK)) {
      console.error("pty ran but printed nothing we expected:", JSON.stringify(out));
      process.exit(1);
    }
    console.log(`pty ok (exit ${exitCode})`);
    process.exit(0);
  }, 500);
});
setTimeout(() => {
  console.error("timed out waiting for the pty; got:", JSON.stringify(out));
  process.exit(1);
}, 20000).unref();
