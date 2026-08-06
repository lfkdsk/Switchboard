/**
 * Turning "which machine?" into "how do I dial it?".
 *
 * A target on the command line — or in a flow's `target` field — is one of:
 *
 *   • a machine's name, as it appears in the dashboard  ("pi", "buildbox")
 *   • a machine id, or a unique prefix of one           ("7f3c1a2b")
 *   • a raw share token                                 (the anonymous circuits)
 *
 * The first two dial the account-bound circuit and authenticate with this
 * host's own agent token, so what a node may drive is decided by the same
 * ownership and grants the dashboard shows — nothing bearer, nothing to copy
 * around, and revoking in the browser stops the automation too. The third stays
 * supported because it needs no account at all, which is exactly right for
 * "look at this box for an hour" and exactly wrong for a flow that runs nightly.
 */

const MIN_TOKEN_LEN = 24;

// One list per process, not per step: a flow with twenty steps resolves its
// targets against the same answer rather than asking the relay twenty times.
let cache = null;

/**
 * Every machine this account can reach, owned and shared alike. Returns [] when
 * the CLI isn't logged in — targets then have to be raw tokens, which is what an
 * anonymous host can dial anyway.
 */
async function machines(server, agentToken) {
  if (cache) return cache;
  if (!agentToken) return (cache = []);
  const headers = { "x-switchboard-agent": agentToken };
  const get = async (path) => {
    let r;
    try { r = await fetch(server + path, { headers }); }
    catch (e) { throw new Error(`cannot reach ${server}: ${e.message}`); }
    // A rejected credential must not read as "you have no machines" — that sends
    // you looking for the machine that vanished instead of at the login that
    // expired. Everything else degrades to an empty list, which is honest: the
    // relay answered, it just had nothing to say.
    if (r.status === 401 || r.status === 403) {
      throw new Error(`${server} rejected this host's credential — run \`switchboard login\` again.`);
    }
    if (!r.ok) return [];
    return (await r.json()).machines || [];
  };
  const [mine, shared] = await Promise.all([get("/api/machines"), get("/api/machines/shared")]);
  return (cache = mine.map((m) => ({ ...m, owned: true })).concat(shared.map((m) => ({ ...m, owned: false }))));
}

/**
 * Resolve one target to { url, headers, label }, or throw with a message that
 * says what was tried. Ambiguity is an error rather than a guess: picking one of
 * two machines called "pi" would run the command on the wrong host, and the
 * wrong host is the one failure mode this whole layer exists to avoid.
 */
async function dial(server, target, agentToken) {
  const ws = server.replace(/^http/, "ws");
  // A failed lookup is held rather than thrown: a share token dials a circuit
  // that never involved an account, so an expired login must not stop it.
  let known = [], listErr = null;
  try { known = await machines(server, agentToken); }
  catch (e) { listErr = e; }

  const byName = known.filter((m) => m.name && m.name === target);
  const byId = known.filter((m) => m.machine_id === target || m.machine_id.startsWith(target));
  const hits = byName.length ? byName : byId;

  if (hits.length > 1) {
    throw new Error(`"${target}" matches ${hits.length} machines: ` +
      hits.map((m) => `${m.name || "(unnamed)"} ${m.machine_id.slice(0, 8)}`).join(", ") +
      "\nUse a longer id prefix.");
  }
  if (hits.length === 1) {
    const m = hits[0];
    // A shell-only share is refused by the relay at connect. Saying so here
    // costs nothing and names the fix, which the 403 body cannot.
    if (!m.owned && !m.can_exec) {
      throw new Error(`@${m.owner_login} shared "${m.name || m.machine_id.slice(0, 8)}" with you for shell access only.\n` +
        "Ask them to re-share it with commands allowed.");
    }
    return {
      url: `${ws}/ws?role=browser&machine=${encodeURIComponent(m.machine_id)}`,
      headers: { "x-switchboard-agent": agentToken },
      label: m.name || m.machine_id.slice(0, 8),
    };
  }

  if (target.length >= MIN_TOKEN_LEN) {
    return { url: `${ws}/ws?role=browser&token=${encodeURIComponent(target)}`, headers: {}, label: "token" };
  }
  if (listErr) throw listErr;

  throw new Error(
    `no machine called "${target}".` +
    (known.length
      ? "\n\nMachines you can reach:\n" + known.map((m) => `  ${(m.name || "(unnamed)").padEnd(20)} ${m.machine_id.slice(0, 8)}`).join("\n")
      : agentToken
        ? "\n\nYou have no machines yet — run `switchboard login` on a host to bind one."
        : "\n\nThis host isn't signed in, so a target has to be a share token. Run `switchboard login` first.") +
    "\n\nA share token would also work here, but must be at least " + MIN_TOKEN_LEN + " characters.",
  );
}

module.exports = { dial, machines, MIN_TOKEN_LEN };
