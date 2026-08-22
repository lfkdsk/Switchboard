const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function remoteOperand(value) {
  const raw = String(value || "");
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  // A drive-qualified Windows path is local even when this CLI is running on
  // Unix (a common case in scripts which prepare commands for another host).
  if (colon === 1 && /^[A-Za-z]$/.test(raw[0])) return null;
  if (raw.slice(0, colon).includes("/") || raw.slice(0, colon).includes("\\")) return null;
  return { node: raw.slice(0, colon), path: raw.slice(colon + 1) };
}

function parseCopyOperands(source, destination) {
  if (!source || !destination) throw new Error("cp needs a source and a destination");
  const from = remoteOperand(source);
  const to = remoteOperand(destination);
  if (!!from === !!to) {
    throw new Error(from
      ? "remote-to-remote copies are not supported"
      : "one cp operand must have the form <node>:<path>");
  }
  const remote = from || to;
  if (!remote.node || !remote.path) throw new Error("a remote operand must have the form <node>:<path>");
  return from
    ? { direction: "download", node: from.node, remotePath: from.path, localPath: destination }
    : { direction: "upload", node: to.node, remotePath: to.path, localPath: source };
}

// Single quotes are the one portable POSIX-shell representation whose content
// cannot expand variables, substitutions, globs, or embedded newlines.
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function shellCommandArgs(command, login, platform = process.platform) {
  return platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-Command", command]
    : [login ? "-lc" : "-c", command];
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function removeFile(filePath) {
  try {
    const st = await fs.promises.lstat(filePath);
    if (!st.isDirectory()) await fs.promises.unlink(filePath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

async function verifyUploadedFile(filePath, expected) {
  let actual;
  try {
    actual = await hashFile(filePath);
  } catch (e) {
    await removeFile(filePath);
    throw e;
  }
  if (actual !== expected) {
    await removeFile(filePath);
    const error = new Error(`sha256 mismatch (local ${expected}, remote ${actual})`);
    error.code = "EBADCHECKSUM";
    error.actual = actual;
    throw error;
  }
  return actual;
}

async function finalizeDownload(tempPath, destination, expected, actual) {
  if (!expected || expected !== actual) {
    await removeFile(tempPath);
    throw new Error(!expected
      ? "target daemon did not return a sha256 checksum; update it and retry"
      : `sha256 mismatch (remote ${expected}, received ${actual})`);
  }
  // POSIX rename replaces files atomically, but Windows refuses to replace an
  // existing destination. Removing only after verification preserves the old
  // good file throughout transfer and gives both platforms the same semantics.
  if (process.platform === "win32") await removeFile(destination);
  await fs.promises.rename(tempPath, destination);
}

module.exports = {
  finalizeDownload,
  hashFile,
  parseCopyOperands,
  remoteOperand,
  removeFile,
  shellCommandArgs,
  shellQuote,
  verifyUploadedFile,
};
