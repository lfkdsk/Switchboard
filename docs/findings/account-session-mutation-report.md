# Account-session guard mutation report

Date: 2026-10-23

Task: Fleet 5792, Option 1/1A
Command: `npm run test:mutation:account-sessions`

The mutation runner loads in-memory variants of the production relay and daemon
protocol modules. It does not edit the working tree. A mutant is counted as
killed only when the corresponding invariant assertion fails; syntax/load
errors are not accepted as kills, and any surviving mutant makes the command
exit nonzero.

## Mutations

| Area | Mutation | Expected detecting invariant | Result |
| --- | --- | --- | --- |
| Relay identity | Replace the relay-authenticated `principal.accountId` stamp with a forged owner id | Stamped JSON principal remains the authenticated visitor | Killed |
| Relay output | Allow every browser through an account route | A different visitor account cannot receive the route | Killed |
| Daemon session messages | Bypass the ownership policy separately for `sessions`, `live-output`, `replay`, `history-list`, `history-read`, `activity`, `input`, `resize`, `close`, `exit`, `reset`, and `upload` | Every message class rejects visitor-to-owner access; only the explicit read-only/close supervisor set admits owner-to-visitor access | 12/12 killed |
| Binary input | Bypass both the input action policy and wire-session visibility check | A visitor cannot resolve an owner session even with a computed supervisor id | Killed |
| Revoke/expiry cleanup | Invert the account-owner predicate used to select opening/live PTYs | Cleanup selects all and only sessions owned by the ended visitor account | Killed |
| Expiry deadline | Invert the finite grant deadline comparison | A grant becomes expired exactly at its trusted deadline, while owner and non-expiring access do not | Killed |
| Offline revoke reconciliation | Invert active-snapshot membership when classifying a recovered visitor PTY | An account omitted from the authoritative reconnect snapshot is selected for termination | Killed |

Total: **18/18 mutants killed; 0 survived**.

## Complete output

```text
> switchboard@1.0.0 test:mutation:account-sessions
> node tests/mutations/account-session-guards.mjs

killed relay authenticated accountId stamp: Expected values to be strictly equal:
killed relay account output audience: Expected values to be strictly equal:
killed daemon sessions ownership filter: sessions must not cross accounts
killed daemon live-output ownership filter: live-output must not cross accounts
killed daemon replay ownership filter: replay must not cross accounts
killed daemon history-list ownership filter: history-list must not cross accounts
killed daemon history-read ownership filter: history-read must not cross accounts
killed daemon activity ownership filter: activity must not cross accounts
killed daemon input ownership filter: input must not cross accounts
killed daemon resize ownership filter: resize must not cross accounts
killed daemon close ownership filter: close must not cross accounts
killed daemon exit ownership filter: exit must not cross accounts
killed daemon reset ownership filter: reset must not cross accounts
killed daemon upload ownership filter: upload must not cross accounts
killed daemon binary input session authorization: Expected values to be strictly equal:
killed daemon revoke and expiry PTY selection: Expected values to be strictly deep-equal:
killed daemon grant expiry deadline: Expected values to be strictly equal:
killed daemon offline revoke snapshot reconciliation: Expected values to be strictly deep-equal:
mutation summary: 18/18 killed, 0 survived
covered: relay stamp/output route, every daemon session message class, input lookup, revoke/expiry cleanup, deadline, and reconnect snapshot
```

Exit code: `0`.
