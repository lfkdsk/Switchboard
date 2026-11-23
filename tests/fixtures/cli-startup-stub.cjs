const { EventEmitter } = require("node:events");
const Module = require("node:module");

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;

  constructor(url) {
    super();
    this.readyState = 0;
    process.stdout.write(`TEST_WS_CONNECT ${url}\n`);
    // Startup tests only need to prove that the daemon reached the dial point.
    // Exit on the next turn so its normal process-exit cleanup still runs.
    setImmediate(() => process.exit(0));
  }
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "ws") return FakeWebSocket;
  if (request === "node-pty") {
    return { spawn() { throw new Error("startup test unexpectedly spawned a PTY"); } };
  }
  if (request === "@xterm/headless") return { Terminal: class Terminal {} };
  if (request === "@xterm/addon-serialize") return { SerializeAddon: class SerializeAddon {} };
  return originalLoad.call(this, request, parent, isMain);
};
