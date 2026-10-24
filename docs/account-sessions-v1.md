# Account-scoped terminal protocol (`account-sessions-v1`)

`account-sessions-v1` is the relay/daemon protocol used by an account-bound
Switchboard machine. It gives every authenticated account a separate terminal
namespace while preserving an explicit machine-owner supervisory view.

This is an application-level visibility and attribution boundary. It is not an
OS sandbox: owner and visitors still run shells and commands as the daemon's OS
user.

## Policy

- The relay-authenticated account, never a browser field, owns every newly
  opened session.
- A visitor can list, replay, read history, type into, resize, and close only
  sessions owned by that visitor account.
- The machine owner sees its own sessions plus labeled, read-only visitor
  sessions and may observe or close them. Supervision does not grant terminal
  input, resize, or session-relative upload authority.
- Other visitor accounts cannot see one another.
- Live output, lifecycle events, history, and activity follow the same policy.
- The relay-authenticated account also owns every detached job. Visitors can
  list, read, inspect, and terminate only jobs owned by their account; the
  machine owner may supervise and terminate all jobs. Browser `accountId`,
  `ownerAccountId`, and `principal` fields never participate in attribution.
- Download, upload, job, and exec request streams return to the exact relay
  client that initiated the request, even when another tab uses the same account.
- Grant revocation or expiry closes the visitor sockets and terminates every
  opening or live PTY owned by that visitor account. The trusted deadline is
  also persisted with detached holders, so expiry does not depend on a visitor
  socket remaining connected or on relay traffic arriving at the deadline.
- Recovered holder/log records and detached-job records without an owner are
  assigned to the machine owner and marked `legacy`; they are never exposed to
  a visitor.

The browser UI tells a visitor that the machine owner can observe the terminal
and its history and can close it. Owner tabs for visitor sessions are labeled
`visitor`.

## Negotiation and trust boundary

An account-bound daemon connects with both of these query parameters:

```text
protocol=account-sessions-v1
protocol-nonce=<random per-daemon-process nonce, at least 24 characters>
```

After accepting the daemon, the relay sends:

```json
{
  "type": "_relay",
  "event": "account-sessions",
  "version": 1,
  "ownerAccountId": "<authenticated daemon account>",
  "nonce": "<echoed protocol nonce>",
  "activeGrants": [
    { "accountId": "<grantee account>", "expiresAt": 1735689600000 },
    { "accountId": "<non-expiring grantee>", "expiresAt": null }
  ]
}
```

The daemon enables scoped processing only when version, owner id, and its secret
nonce all match and the complete active-grant snapshot is valid. The snapshot
comes from D1 and includes only non-revoked grants whose deadline is still in
the future. It is bounded at 4,096 unique account ids; query failure, malformed
rows, or overflow rejects the new daemon before it can replace an existing one,
rather than treating a truncated list as revocations. The circuit serializes
the snapshot read with revoke delivery so a concurrent revoke is either absent
from the snapshot or delivered to the newly accepted daemon. Existing grant
socket attachments are reconciled to the same snapshot before `browser-status`
is replayed, preventing an older socket deadline from overriding current D1
authority after a daemon restart.

The nonce prevents a browser connected through an older transparent relay from
forging a new-protocol envelope. Before acknowledgement, the daemon accepts
neither scoped envelopes nor an inferred browser identity.

The Worker authenticates a browser session or agent token and stores
`accountId`, `accessVia` (`owner` or `grant`), the trusted grant `expiresAt`,
and a relay-generated `clientId` in the browser WebSocket attachment. These
values form the principal stamped on every browser frame. Any similarly named
fields inside the browser message are untrusted application data and have no
authorization effect.

## Browser to daemon

JSON browser messages retain their existing body and are wrapped by the relay:

```json
{
  "type": "_sb_browser",
  "version": 1,
  "nonce": "<daemon protocol nonce>",
  "principal": {
    "accountId": "<authenticated account>",
    "accessVia": "owner | grant",
    "clientId": "<relay-generated id>",
    "expiresAt": 1735689600000
  },
  "message": { "type": "open", "sid": "browser-selected sid" }
}
```

`expiresAt` is a finite Unix-millisecond deadline for expiring grants and
`null` for owner or non-expiring access.

Binary terminal input uses a length-delimited envelope so the original browser
frame stays byte-for-byte intact:

```text
0..3    ASCII "SBI1"
4..7    uint32 big-endian metadata length N
8..N    UTF-8 JSON {version, nonce, principal}
...     original [sidLength][sid UTF-8][input bytes] frame
```

Malformed, unversioned, wrong-nonce, or invalid-principal envelopes are dropped.

## Daemon to browser

Every daemon response has a relay-owned delivery route:

```json
{
  "type": "_sb_daemon",
  "version": 1,
  "route": { "kind": "client", "accountId": "...", "clientId": "..." },
  "message": { "type": "sess-list", "id": "...", "sessions": [] }
}
```

Valid routes are:

| Route | Audience |
| --- | --- |
| `{kind: "owner"}` | Authenticated machine-owner browser sockets only |
| `{kind: "account", accountId}` | Every socket for that account |
| `{kind: "client", accountId, clientId}` | One exact authenticated browser socket |

An id-bearing response without a live initiating-client route is dropped. It
never falls back to the machine owner after requester disconnect or revocation.

Binary output uses the analogous layout:

```text
0..3    ASCII "SBO1"
4..7    uint32 big-endian metadata length N
8..N    UTF-8 JSON {version, route}
...     original [sidLength][sid UTF-8][PTY output bytes] frame
```

The relay validates the route, filters recipients, and removes the entire outer
envelope. Browsers continue to receive the legacy JSON body or sid-prefixed
binary terminal frame and never receive account-routing metadata.

Unwrapped or malformed daemon frames fail closed after negotiation.

## Session identity and owner supervision

A browser `sid` is correlation data, not authority. The daemon stores an
account-owned session under:

```text
v1-<base64url SHA-256(accountId + NUL + browserSid)>
```

Thus two accounts may safely choose the same browser sid. The owning account
continues to see its original sid. The machine owner sees a visitor session as:

```text
supervised-<base64url SHA-256(visitorAccountId + NUL + browserSid)>
```

The owner-supervisor id avoids collisions with the owner's own sid and does not
expose the daemon's internal storage id. PTY-holder `owner.json` and session-log
metadata persist the owner account independently of whether transcript recording
is enabled.

## Lifecycle and compatibility

- A grant connecting while a legacy daemon is live receives HTTP 426 with an
  upgrade message.
- If a grant socket was waiting while the host was offline and a legacy daemon
  later connects, the relay sends `daemon-upgrade-required` and closes it.
- A new daemon connected through an old relay enters explicit legacy mode for
  the machine owner. It never treats browser fields as an authenticated account;
  grants still require an upgraded relay/daemon pair.
- Expiry is copied only from the relay-authenticated access result into stamped
  principals and `browser-status`. The daemon maintains an account deadline,
  and each detached holder persists the same `accessExpiresAt` in `owner.json`
  and enforces it independently. This covers a disconnected visitor and a
  daemon restart. For a still-connected visitor, the relay attachment also
  sends `access-expired` to the daemon and visitor, then closes the socket.
- Revocation is durable in D1 first, then the Worker asks the circuit to send
  `access-revoked`, block existing visitor sockets, and close them.
- On every daemon connection, the daemon reconciles recovered visitor PTYs
  against the negotiation's authoritative active-grant snapshot. A recovered
  account omitted because its grant was revoked or expired is terminated even
  when the daemon was offline for the live event. A retained account receives
  the snapshot deadline, replacing stale holder metadata after renewal.
- The daemon handles either event or its local trusted deadline by killing that
  account's opening and live PTYs and cancelling adjacent in-flight request
  streams.

Token-mode circuits retain their existing shared-session wire behavior and do
not use these envelopes.

## Test contract

The unit tests validate relay stamping and route stripping, nonce and malformed
frame rejection, owner/visitor policy, account-derived session ids, every
session- and detached-job-bearing message class, exact-client request routes,
and legacy record migration. The real account-mode webshell E2E uses isolated
Wrangler/D1 and daemon state to validate two-account positive and negative
behavior (including forged and cross-account detached-job operations), frontend
disclosure, live and daemon-offline revocation, restart reconciliation, expiry,
and old-daemon rejection.
