import fs from "node:fs";
import net from "node:net";
import holderModule from "../../cli/lib/pty-holder.js";

const { holderSocketPath, runHolder } = holderModule;

async function main() {
  const rootDir = process.env.HOLDER_TEST_ROOT;
  const scope = process.env.HOLDER_TEST_SCOPE;
  const sid = process.env.HOLDER_TEST_SID;
  const socketPath = holderSocketPath(rootDir, scope, sid);
  const originalExitListeners = new Set(process.rawListeners("exit"));

  await runHolder({
    rootDir,
    scope,
    sid,
    shell: "/bin/true",
    cwd: rootDir,
    recording: false,
  });

  const cleanup = process.rawListeners("exit").find((listener) => !originalExitListeners.has(listener));
  if (!cleanup) throw new Error("holder exit cleanup listener was not installed");

  const replacement = net.createServer();
  await new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(socketPath, resolve);
  });
  cleanup();
  const socketExists = fs.existsSync(socketPath);
  process.send?.({ type: "replacement", socketExists });
  await new Promise((resolve) => replacement.close(resolve));
  try { fs.unlinkSync(socketPath); } catch {}
  process.exit(socketExists ? 0 : 1);
}

main().catch((error) => {
  process.send?.({ type: "error", message: error.stack || error.message });
  process.exit(1);
});
