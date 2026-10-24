# Account-session visibility verification

Date: 2026-10-23

Task: Fleet 5792, Option 1/1A
Base: `73bb3a2d695d0e1e6f4eb28403facf09612a594d`

## Automated checks

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | Exit 0; 101 passed, 0 failed | [Complete TAP output](account-session-npm-test.tap) |
| `npm run test:mutation:account-sessions` | Exit 0; 18/18 mutants killed | [Mutation report](account-session-mutation-report.md) |
| Syntax | `node --check` passed for the daemon, holder, relay protocol, circuit, registry, and account E2E | Command output was empty; exit 0 |
| Patch hygiene | `git diff --check` | Command output was empty; exit 0 |

The unit suite includes relay-authenticated identity stamping and spoof
resistance, account/client output routes, all session action classes, read-only
owner supervision, exact-client adjacent request routing, active-grant snapshot
filtering and reconciliation, detached-holder expiry, ownership persistence,
and legacy-record migration.

## Lease-gated WebShell E2E

`npm run test:e2e:webshell` was not executed by task 5792 without its required
exclusive `sb-webshell-e2e` lease. The task was launched with no Fleet lease,
and worker-facing lease tooling is read-only. Lease requests were sent to the
commander, and Fleet proposal `4116` asks for a lease-bound verifier against
this implementation branch.

The prepared account E2E covers:

- forged browser identity fields versus relay stamping;
- owner/visitor list, live output, replay input, history, activity, and adjacent
  request isolation;
- read-only owner supervision and owner close;
- live revoke, revoke while the daemon is offline followed by holder recovery,
  and disconnected-client grant expiry;
- explicit old-daemon rejection, legacy unowned-record migration, and frontend
  disclosure/labels.

The E2E must still be run by a task whose recorded lease holder is
`sb-webshell-e2e`; this document deliberately does not present an unleased run
as verification.
