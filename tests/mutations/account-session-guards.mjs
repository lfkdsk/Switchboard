import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const relayPath = path.join(root, "src", "account-session-protocol.js");
const daemonPath = path.join(root, "cli", "lib", "account-sessions.js");
const relaySource = fs.readFileSync(relayPath, "utf8");
const daemonSource = fs.readFileSync(daemonPath, "utf8");

function replaceExactlyOnce(source, before, after, name) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${name}: mutation target must exist`);
  assert.equal(source.indexOf(before, first + before.length), -1, `${name}: mutation target must be unique`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

async function loadRelay(source) {
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Math.random()}`);
}

function loadDaemon(source) {
  const filename = path.join(root, "cli", "lib", ".account-sessions-mutant.cjs");
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  return loaded.exports;
}

let killed = 0;
let total = 0;

async function expectKilled(name, load, assertion) {
  total++;
  try {
    await assertion(await load());
  } catch (error) {
    if (error?.code !== "ERR_ASSERTION") throw error;
    killed++;
    console.log(`killed ${name}: ${error.message.split("\n")[0]}`);
    return;
  }
  throw new Error(`SURVIVED ${name}`);
}

await expectKilled(
  "relay authenticated accountId stamp",
  () => loadRelay(replaceExactlyOnce(
    relaySource,
    "    accountId: identity.accountId,",
    '    accountId: "browser-forged-owner",',
    "relay stamp",
  )),
  (protocol) => {
    const stamped = JSON.parse(protocol.stampBrowserMessage(
      JSON.stringify({ type: "open", sid: "shell", accountId: "browser-forged-owner" }),
      {
        accountId: "visitor-1", accessVia: "grant", clientId: "client-1",
        protocolNonce: "nonce-at-least-twenty-four-characters",
      },
    ));
    assert.equal(stamped.principal.accountId, "visitor-1");
  },
);

await expectKilled(
  "relay account output audience",
  () => loadRelay(replaceExactlyOnce(
    relaySource,
    '  if (route.kind === "account") return browser.accountId === route.accountId;',
    '  if (route.kind === "account") return true;',
    "relay account audience",
  )),
  (protocol) => assert.equal(protocol.routeAllowsBrowser(
    { kind: "account", accountId: "visitor-1" },
    { accountId: "visitor-2", accessVia: "grant", clientId: "client-2" },
    "owner-1",
  ), false),
);

const daemon = loadDaemon(daemonSource);
const owner = { accountId: "owner-1", accessVia: "owner", clientId: "owner-client" };
const visitor = { accountId: "visitor-1", accessVia: "grant", clientId: "visitor-client" };
const ownerSession = { sid: "owner-shell", ownerAccountId: "owner-1" };
const visitorSession = { sid: "visitor-shell", ownerAccountId: "visitor-1" };
const actionGuard =
  "  if (!SESSION_ACTION_SET.has(action) || !validPrincipal(principal) || !session?.ownerAccountId) return false;";
const jobActionGuard =
  "  if (!JOB_ACTION_SET.has(action) || !validPrincipal(principal) || !job?.ownerAccountId) return false;";

for (const action of daemon.SESSION_ACTIONS) {
  await expectKilled(
    `daemon ${action} ownership filter`,
    () => Promise.resolve(loadDaemon(replaceExactlyOnce(
      daemonSource,
      actionGuard,
      `  if (action === ${JSON.stringify(action)}) return true;\n${actionGuard}`,
      `${action} ownership filter`,
    ))),
    (mutant) => assert.equal(
      mutant.canAccessSessionFor(action, visitor, ownerSession, "owner-1"),
      false,
      `${action} must not cross accounts`,
    ),
  );
}

for (const action of daemon.JOB_ACTIONS) {
  await expectKilled(
    `daemon ${action} ownership filter`,
    () => Promise.resolve(loadDaemon(replaceExactlyOnce(
      daemonSource,
      jobActionGuard,
      `  if (action === ${JSON.stringify(action)}) return true;\n${jobActionGuard}`,
      `${action} ownership filter`,
    ))),
    (mutant) => assert.equal(
      mutant.canAccessJobFor(action, visitor, { id: "owner-job", ownerAccountId: "owner-1" }, "owner-1"),
      false,
      `${action} must not cross accounts`,
    ),
  );
}

await expectKilled(
  "daemon binary input session authorization",
  () => {
    let mutant = replaceExactlyOnce(
      daemonSource,
      actionGuard,
      `  if (action === "input") return true;\n${actionGuard}`,
      "input action policy",
    );
    mutant = replaceExactlyOnce(
      mutant,
      "  if (!canAccessSession(principal, session, machineOwnerAccountId)) return null;",
      "  if (!session?.ownerAccountId) return null;",
      "input wire-session policy",
    );
    return Promise.resolve(loadDaemon(mutant));
  },
  (mutant) => assert.equal(mutant.findAccessibleSession(
    new Map([
      ["owner-storage", ownerSession],
      ["visitor-storage", visitorSession],
    ]),
    visitor,
    "owner-1",
    mutant.supervisorSessionId("owner-1", "owner-shell"),
    "input",
  ), null),
);

await expectKilled(
  "daemon revoke and expiry PTY selection",
  () => Promise.resolve(loadDaemon(replaceExactlyOnce(
    daemonSource,
    "session?.ownerAccountId === accountId",
    "session?.ownerAccountId !== accountId",
    "revoke ownership selection",
  ))),
  (mutant) => assert.deepEqual(
    mutant.ownedSessionEntries(new Map([
      ["owner-storage", ownerSession],
      ["visitor-storage", visitorSession],
    ]), "visitor-1").map(([storageId]) => storageId),
    ["visitor-storage"],
  ),
);

await expectKilled(
  "daemon grant expiry deadline",
  () => Promise.resolve(loadDaemon(replaceExactlyOnce(
    daemonSource,
    "Number.isFinite(principal.expiresAt) && principal.expiresAt <= now;",
    "Number.isFinite(principal.expiresAt) && principal.expiresAt > now;",
    "grant expiry comparison",
  ))),
  (mutant) => assert.equal(mutant.principalAccessExpired({
    accountId: "visitor-1", accessVia: "grant", clientId: "visitor-client", expiresAt: 100,
  }, 100), true),
);

await expectKilled(
  "daemon offline revoke snapshot reconciliation",
  () => Promise.resolve(loadDaemon(replaceExactlyOnce(
    daemonSource,
    "    if (!activeGrants.has(accountId)) {",
    "    if (activeGrants.has(accountId)) {",
    "offline revoke snapshot membership",
  ))),
  (mutant) => assert.deepEqual(
    mutant.reconcileGrantSnapshot([
      { ...visitorSession, accessExpiresAt: null },
    ], "owner-1", [], 100).ended,
    new Map([["visitor-1", "access-revoked"]]),
  ),
);

assert.equal(killed, total);
console.log(`mutation summary: ${killed}/${total} killed, 0 survived`);
console.log("covered: relay stamp/output route, every daemon session and detached-job ownership class, input lookup, revoke/expiry cleanup, deadline, and reconnect snapshot");
