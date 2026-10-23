// A WebSocket upgrade that throws — a Durable Object stub that cannot reach its
// object, a D1 call that fails mid-handshake — used to escape the Worker as an
// uncaught exception. Cloudflare turns that into a bare "error code: 1101" page
// with no log line carrying the role or machine, so a circuit that was broken
// for a minute left nothing to diagnose but client-side guesses. Catch it here,
// log it with context, and answer 503 so daemons and peers know to retry.
export async function guardUpgrade(run, { role, machine } = {}, logger = console) {
  try {
    return await run();
  } catch (error) {
    logger.error("[ws] upgrade failed", {
      role: role || null,
      machine: machine || null,
      error: error?.stack || String(error),
    });
    return new Response(
      "relay temporarily unavailable for this machine; retry shortly\n",
      { status: 503, headers: { "content-type": "text/plain", "retry-after": "2" } },
    );
  }
}
