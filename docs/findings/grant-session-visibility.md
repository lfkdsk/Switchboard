# Grant session visibility: findings and design options

Status: **DECIDED AND IMPLEMENTED**. Option **1/1A** was selected: account-scoped
visitor sessions with machine-owner supervision, fail-closed legacy-daemon
grants, immediate visitor PTY termination on revoke/expiry, and legacy unowned
records assigned to the machine owner. The original investigation inspected
`a4c23b7`; the implementation was built as Fleet task 5792 from task 5772 commit
`73bb3a2d695d0e1e6f4eb28403facf09612a594d` on an independent branch.

The implemented wire contract and compatibility rules are specified in
[`docs/account-sessions-v1.md`](../account-sessions-v1.md). The findings and
reproduction below are retained as the rationale and before-state evidence.

## Decision summary

The recorded decision is **Option 1: account-scoped sessions**, with these policy
choices:

1. A grantee sees and controls only sessions created by that account.
2. The machine owner can see and terminate every session, with that fact
   disclosed to grantees. Symmetric isolation is an available sub-option.
3. A grant connection to a daemon that does not advertise the new protocol is
   rejected with an upgrade message, rather than silently retaining shared
   session visibility.

This preserves the documented promise of a real shell running as the machine's
user while removing ambient access to terminals the visitor did not create. It
is an application-level privacy and attribution boundary, **not** an OS security
boundary: a hostile grantee still has arbitrary code execution as the same
system user.

The former decision questions are recorded as resolved at the end.

## 1. Confirmed current behavior

### Access is account-aware only until the circuit

The account registry makes a real owner/grantee distinction:

- `machineAccess` returns `via: "owner"` for the machine owner and
  `via: "grant"` for a live grantee (`src/registry.js:80-99`).
- The Worker puts the connecting account id, access path, and grant expiry into
  trusted request headers (`src/index.js:175-181`, `src/index.js:209-225`).
- The circuit persists those values in each browser WebSocket attachment
  (`src/circuit.js:57-68`). Revocation and expiry already use the attachment to
  find and close the right grantee sockets (`src/circuit.js:19-37`,
  `src/circuit.js:146-157`).

The distinction stops there. The daemon protocol does not receive an account
principal:

- A daemon frame is sent to every browser socket unless it is one of the replay
  frames carrying a temporary `relayClientId` target (`src/circuit.js:81-96`,
  `src/replay-routing.js:31-51`). A normal `sessions`, `stats`, `exit`, or live
  PTY frame has no target.
- A browser frame is sent to the single daemon unchanged, except that an `open`
  request gets a relay-only client id used to route its replay
  (`src/circuit.js:97-100`, `src/replay-routing.js:5-10`). Neither JSON control
  frames nor binary input carry the authenticated account id.

The effective flow is therefore:

```text
owner browser  -- accountId=owner --\
                                    >  one machine Circuit  <--> one daemon
grant browser  -- accountId=guest --/        |                    |
                                              |                    +-- one global sessions Map
                                              +-- live daemon frames fan out to both browsers
```

The attachment contains enough information to enforce a policy at the relay,
but current terminal frames do not say which account owns a session, so the
relay has nothing on which to filter daemon output.

### The daemon and frontend deliberately model one shared set of PTYs

The daemon has one process-global `sessions` map keyed only by `sid`
(`cli/index.js:850-862`). Opening a missing sid spawns the configured shell with
the daemon's `HOME` and full environment (`cli/index.js:892-918`). PTY output is
encoded with only the sid and sent to the relay (`cli/index.js:919-945`), while
incoming binary input selects a PTY by that sid alone (`cli/index.js:1299-1314`).
The following control operations are also unscoped:

- `open`, `resize`, `list-sessions`, and `close`
  (`cli/index.js:1328-1350`);
- the session list built from every entry in the global map and emitted as one
  `sessions` frame (`cli/index.js:1086-1110`);
- persistent history list/read requests (`cli/index.js:1360-1361`).

The browser follows that model. It says that every page mirrors the same PTYs,
builds all tabs from the daemon's `sessions` broadcast, and allows either page
to type or close a PTY (`public/index.html:691-696`). It sends terminal input as
`sid + payload` (`public/index.html:760-780`), automatically attaches every
listed session (`public/index.html:979-994`), and writes every matching live
binary frame into the terminal (`public/index.html:1063-1087`). The frontend
also explicitly relies on the relay fanning daemon output to every browser
socket (`public/index.html:1004-1008`).

As a result, an active grantee can currently:

- enumerate every live shell and see its cwd;
- attach to and read replay plus live output from a shell opened by the owner;
- send input, resize, or close that shell;
- request the machine-wide persistent session list and transcripts; and
- receive the global activity heartbeat. That heartbeat is derived from all
  live sessions (`cli/index.js:1888-1909`, `cli/activity.js:297-326`), stored as
  one machine blob, and returned for shared dashboard rows
  (`src/registry.js:121-132`).

The same fan-out also exposes requester-specific daemon responses (for example,
history pages, file-download chunks, and `exec` output) to every raw browser
socket. The stock frontend ignores response ids it did not create, but that is
UI demultiplexing rather than an authorization boundary. Full same-user command
and file access limits the additional OS privilege represented by those frames,
but a principal-aware protocol should route them back only to their requester.

The history and activity paths matter to any isolation design. Filtering only
the live binary fan-out would leave adjacent disclosures intact.

## 2. Local reproduction

The issue was reproduced against the current Worker, not inferred only from
source.

### Setup

1. Wrangler `4.151.3` was started locally on port `8972` with an isolated,
   temporary D1 state created from `schema.sql`.
2. D1 was seeded with two distinct agent-token accounts, one owner machine, and
   one unexpired grant. The agent-token form exercises the same browser role,
   `machineAccess`, `withBrowserAccess`, and circuit attachment as a session
   cookie; it adds the peer-opt-in check before admission, so the fixture set
   `peer=1`.
3. Three raw WebSocket clients connected to the real `/ws` route: the owner
   daemon, an owner browser-role client, and a grantee browser-role client.
4. The daemon sent the same `sessions` control frame and sid-prefixed live PTY
   frame that `cli/index.js` emits. The grantee then sent a sid-prefixed input
   frame back.

The database check showed a live grant:

```text
machine_id    owner_id    grantee_id  revoked_at
machine-5772  owner-5772  guest-5772  null
```

Wrangler logged three successful upgrades:

```text
GET /ws 101 Switching Protocols
GET /ws 101 Switching Protocols
GET /ws 101 Switching Protocols
```

The protocol harness printed:

```text
owner_connection=101
grant_connection=101
owner_sessions={"type":"sessions","list":[{"sid":"owner-shell-5772","cwd":"/home/owner","startedAt":1}]}
grant_sessions={"type":"sessions","list":[{"sid":"owner-shell-5772","cwd":"/home/owner","startedAt":1}]}
owner_output={"sid":"owner-shell-5772","payload":"OWNER_SECRET_OUTPUT_5772\r\n"}
grant_output={"sid":"owner-shell-5772","payload":"OWNER_SECRET_OUTPUT_5772\r\n"}
daemon_received_guest_input={"sid":"owner-shell-5772","payload":"echo GUEST_CAN_TYPE_5772\n"}
RESULT=live owner session list/output reached grant account; grant input reached daemon unchanged
```

The temporary Wrangler/D1 state was removed after the run. No production
service or remote database was used.

## 3. What “share” promises today

The current public contract is broad:

- Account mode can be opened by “you + GitHub users you share with,” and account
  and token modes are said to differ only in who may connect and how long shells
  persist (`README.md:109-120`).
- The share section calls a grant “full access — terminal input, file transfer,
  and commands” (`README.md:122-136`).
- The dashboard warning likewise says “full terminal, file-transfer, and command
  access” (`public/index.html:540-543`).
- The product description says the daemon owns the open-shell list and any
  browser on any device reattaches to it (`README.md:92-96`). The implementation
  overview is even more explicit that host output is broadcast to every open
  tab (`README.md:385-394`).

Therefore, this is not an authorization bypass in the sense of obtaining a
more privileged Unix account. A grantee is already allowed to create a new PTY
through `open`; that PTY is spawned by the same daemon, as the same system user,
with the same home directory and environment. When host peer access is enabled,
the grantee's CLI can also run `exec` and `shell`; disabling peer access does not
block the granted browser terminal (`README.md:133-136`).

It is nevertheless a meaningful privacy and session-integrity problem:

- Arbitrary execution as the same user does not automatically provide terminal
  scrollback, transient command output, prompts, unsaved editor state, or the
  timing needed to observe a secret printed only briefly.
- Injecting keystrokes into an already-running REPL, installer, debugger, or
  confirmation prompt is a distinct capability from starting a new process.
  Resize and close are also cross-account destructive actions.
- Because frames have no principal by the time they reach the daemon, logs and
  the UI cannot attribute which account typed, resized, or closed a session.
- A grantee can already read many files and processes as the same OS user, and
  can potentially read on-disk Switchboard transcripts. Account-scoped tabs
  should therefore be described as reducing accidental ambient exposure and
  interference, not as protecting the owner from a malicious grantee.

The share UI's phrase “full terminal access” does not clearly tell an owner that
the recipient immediately sees and can drive terminals that were open before
the share was created. If the shared-PTY behavior remains intentional, that
specific behavior needs an explicit, unavoidable disclosure.

## 4. Design requirements for isolation

Any implementation claiming account isolation should cover all of these
invariants, rather than patching only the visible output fan-out:

1. **Authenticated principal.** The relay, not the browser, adds the account id
   and access class to every browser-to-daemon message. Browser-supplied reserved
   fields must be removed or overwritten. Binary input needs an authenticated
   envelope too.
2. **Session ownership.** The daemon keys live, opening, recovered, and recorded
   sessions by principal plus sid, and persists the owner beside PTY-holder and
   transcript state. A random sid is not an authorization token.
3. **Complete authorization.** `open`, input, resize, close, replay, session
   list, history list/read, session-based upload, and lifecycle cleanup all
   enforce the same policy. Request-scoped download, job, and `exec` responses
   also return only to their authenticated requester; a browser-chosen id is
   correlation data, not authority.
4. **Targeted output.** The daemon tags session-specific responses and output;
   the relay sends them only to the session owner and, if chosen, the machine
   owner. Other request/response streams are tagged with their initiating
   principal/client. Relay-only tags are stripped before frames reach browsers.
5. **Metadata policy.** `stats.act.shells`, cwd/process summaries, and opt-in
   Claude activity must not re-expose hidden owner sessions through the live
   heartbeat or `/api/machines/shared`. Host-wide CPU/top-process data is a
   separate product choice because the grant already includes host execution.
6. **Per-principal lifecycle.** Online status and detached-session grace cannot
   remain one aggregate boolean for the whole circuit. Revocation/expiry should
   close the grantee's sockets and terminate or explicitly retain that
   principal's PTYs according to a documented rule. The recommendation is to
   terminate them; this still cannot clean up arbitrary background processes a
   full-access grantee launched outside the PTY.
7. **Negotiated rollout.** The daemon advertises an unambiguous feature such as
   `account-sessions-v1`, and the relay acknowledges it; lack of acknowledgement
   is legacy mode. The relay must never send a new binary envelope to an old
   daemon that will interpret its prefix as a sid length.

## 5. Options

### Option 1 — account-scoped sessions (recommended)

#### Semantics

Each authenticated account gets its own shell namespace on a shared machine. A
grantee can create and reattach its own shells, use file transfer, and run
commands exactly as promised, but cannot enumerate, read, type into, resize, or
close another grantee's or the owner's shells.

There are two owner-policy sub-options:

- **1A: owner-supervisor (recommended).** The machine owner can see, label, and
  terminate every session. This matches ownership of the host and gives the
  owner a way to recover resources. The recipient UI must say that the owner
  can observe their terminals.
- **1B: symmetric application isolation.** Every account, including the owner,
  sees only its own sessions. This offers a cleaner mutual-privacy story, but the
  owner still controls the machine and same OS account, so it cannot be a strong
  confidentiality promise and makes support/cleanup harder.

Legacy sessions have no trustworthy creator. On first upgraded recovery they
should be assigned to the machine owner and marked `legacy`, rather than guessed
from which account happens to connect first.

#### Required changes

| Layer | Change |
| --- | --- |
| Relay / Worker | Preserve the authenticated account/access class in a spoof-proof daemon envelope for JSON and binary browser frames. Track daemon capability. Filter daemon output by tagged session owner, with an owner-supervisor exception if 1A is chosen, and return request-scoped streams only to their initiating client. Make replay targets and online/lease status principal-aware. Strip relay metadata before delivery to browsers. Likely files: `src/index.js`, `src/circuit.js`, `src/replay-routing.js`. |
| Daemon | Key session/open/input state by `(accountId, sid)`; validate every session operation; persist the principal in PTY-holder and session-log metadata; build principal-specific session/history/activity views; echo trusted requester routing on download/job/exec responses; handle account revoke/expiry and per-principal grace. Likely files: `cli/index.js`, `cli/lib/pty-holder.js`, `cli/lib/session-log.js`, `cli/activity.js`. |
| Frontend | The grantee's existing tab flow can remain wire-compatible. Add owner-visible account labels/filters under 1A, disclose owner supervision to visitors, and avoid showing hidden activity. Likely file: `public/index.html`. |
| Protocol | Add a negotiated `account-sessions-v1` relay/daemon envelope in both directions. Continue the current browser wire format where possible so relay translation keeps old frontends functional. Define ownership for `open`, replay, live binary data, list/history responses, exit/reset, and revocation, plus requester routing for non-session streams. |

#### Compatibility and rollout

- **Old daemon:** it cannot provide isolation because it has no principal. The
  safe policy is to reject grant-role connections once an old daemon is
  detected and tell the owner to upgrade. Allowing them with a warning is a
  compatibility choice, but means the product cannot claim grants are isolated.
- **Old relay + new daemon:** the daemon receives no authenticated principal, so
  it must remain in explicitly labeled legacy mode; it cannot infer ownership
  from sid or payload. Roll out the relay first, then daemons.
- **Old frontend:** if the relay translates the new daemon envelope back to the
  current `sessions`/binary format, a grantee's old frontend should work and see
  only its sessions. An old owner frontend under 1A can function, but cannot show
  account labels and may present visitor tabs ambiguously; the new frontend is
  required for a good supervisory experience.
- **Stored sessions:** assign unowned legacy holder/log records to the machine
  owner. Do not expose them to grantees during migration.

Estimated effort: **large, roughly 5–8 engineering days** for protocol, relay,
daemon state migration, frontend attribution, and adversarial multi-account
tests, plus staged rollout time.

Residual risks: all principals still execute as the same OS user; the owner can
observe guest work under 1A; cwd/process/top-process metadata needs an explicit
policy; sid collisions must be harmless; old self-hosted relays can retain the
legacy behavior indefinitely; revocation cannot undo files, processes, or
credentials a grantee already created or copied.

### Option 2 — account-scoped sessions plus explicit session collaboration

#### Semantics

Use Option 1 as the default, then let the owner explicitly expose one selected
session to one or more live grants. A grant can still create private-to-that-
account shells. Pairing on an existing terminal becomes an intentional action
instead of a side effect of granting machine access.

This can be represented either as a second grant mode (`workspace` versus
`all-current-terminals`) or, preferably, as per-session “Collaborate with…”
ACLs. Per-session ACLs make the sensitive object and duration visible at the
point of consent.

#### Required changes

| Layer | Change |
| --- | --- |
| Relay / Worker | Everything in Option 1, plus routing to the session ACL and immediate removal on revoke/expiry. Persistent collaboration ACLs would need registry storage; ephemeral ACLs can live with the daemon session but disappear on restart. |
| Daemon | Everything in Option 1, plus session membership/roles, an authoritative owner action to add/remove collaborators, and defined behavior for input, resize, close, history, and replay per role. |
| Frontend | Add “Collaborate with…” and “Stop sharing this session” controls, a conspicuous shared-session indicator, participant labels, and input/close permissions. |
| Protocol | Add session ACL events and participant-aware output/input authorization on top of `account-sessions-v1`. |

Compatibility is the same as Option 1 for old daemons. Old frontends cannot
create or explain a collaboration ACL; they should receive only their ordinary
account-scoped sessions unless the relay can safely render an already-shared
session through the old wire format. Existing blanket grants must migrate to
`workspace`, not silently to “all terminals.”

Estimated effort: **very large, roughly 8–13 engineering days** including the
Option 1 foundation, UI/ACL state, permission tests, and rollout.

Residual risks: the same-OS-user limitation remains; ACL and terminal ownership
can be confusing; collaborative input is intentionally multi-writer and can
still corrupt a command; owner/grantee expectations must be explicit; a
persisted ACL creates additional revocation and recovery state.

### Option 3 — keep the shared-PTY model and disclose it explicitly

#### Semantics

Define a machine grant as joining a single collaborative terminal workspace.
Every connected owner or grantee can see the complete shell list, replay and
live output, history, and activity, and can type into, resize, or close every
shell. The current protocol remains unchanged.

The owner-facing share flow should require confirmation with language such as:

> This person can see every terminal already open on this machine, including
> live output and history, and can type into or close those terminals. Commands
> run as your OS user. Close sensitive terminals before sharing.

The recipient should see a persistent “Shared terminal workspace” banner, and
README/security documentation should repeat the exact behavior. “Full terminal
access” alone is not specific enough.

#### Required changes

| Layer | Change |
| --- | --- |
| Relay / daemon / protocol | None. Preserve the existing shared circuit and global session map. |
| Frontend | Replace the current generic warning with explicit existing-terminal, output/history, input/resize/close, and OS-user language; require confirmation; show a persistent recipient banner. |
| Documentation | Update the share, security, and architecture sections so the shared-PTY behavior is part of the contract rather than an implementation surprise. |

Old daemons remain fully compatible. The deployed static frontend updates
without a daemon upgrade, but cached/old frontends will not show the warning;
the README alone cannot make the risk unavoidable.

Estimated effort: **small, roughly 0.5–1.5 engineering days** including copy,
UI confirmation/banner, and tests.

Residual risks: ambient secret disclosure, prompt/input injection, accidental
session closure, cross-account resize, history/activity leakage, and no useful
input attribution all remain by design. Warnings are easy to habituate to and
do not protect an owner who shares while a sensitive terminal is already open.

## 6. Comparison

| Option | Default session visibility | Protocol scope | Old-daemon posture | Estimate | Main residual risk |
| --- | --- | --- | --- | --- | --- |
| 1. Account-scoped sessions | Grantee: own only; owner: all under 1A | Relay + daemon + frontend labels/disclosure | Block grants or explicitly retain legacy behavior; blocking recommended | 5–8 days | Same OS user means no hostile-grantee confidentiality |
| 2. Explicit collaboration | Own only, plus sessions deliberately shared | Option 1 + ACL protocol/UI/state | Same as Option 1 | 8–13 days | Multi-writer sessions and ACL complexity |
| 3. Disclosure only | Everyone sees and controls everything | Copy/UI/docs only | Fully compatible | 0.5–1.5 days | Current privacy/integrity exposure remains |

## 7. Recorded decision

The product owner selected:

1. **Base behavior:** Option 1, account-scoped sessions.
2. **Owner policy:** 1A, machine-owner supervision of visitor sessions.
3. **Legacy daemon policy:** reject grant connections until the daemon supports
   account scoping and show an upgrade instruction.
4. **Revocation/expiry:** immediately terminate that grantee's
   Switchboard-owned PTYs. The authenticated expiry is persisted with detached
   holders and enforced locally so a disconnected browser or daemon restart
   cannot leave a visitor PTY alive past its grant. Each daemon negotiation also
   carries a bounded, complete D1 snapshot of active grants; recovered visitor
   PTYs absent from it are terminated, covering a revoke event missed while the
   daemon was offline. Snapshot failure or overflow rejects the new daemon
   before it replaces the incumbent rather than reconciling from partial state.

Implemented decision: **Option 1 + owner-supervisor + reject legacy grant
connections + terminate grantee PTYs on revoke/expiry.** It is the smallest
design that removes the surprising cross-account terminal behavior, adds
attribution, and preserves the existing promise of full same-user machine
access without implying an OS sandbox that does not exist.
