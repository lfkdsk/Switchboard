# Switchboard

Self-hostable browser terminal: run a daemon on any machine and get a full
interactive shell in your browser — from behind NAT, with no inbound ports. A
clean reimplementation of [`@elsetech/webterm`](https://www.npmjs.com/package/@elsetech/webterm)
— **both ends** — so you own the whole stack and can add protocol-level features
(E2E, port-forwarding, …) on the relay and the daemon together.

Two parts live in this repo:
- **relay** (repo root) — a Cloudflare Worker + Durable Object that pairs a daemon
  with browser(s) by token; a drop-in replacement for `webterm.elsetech.app`.
- **cli** (`cli/`, package `@switchboard/cli`) — the host agent that spawns your
  shell and dials out to the relay; wire-compatible with the original `@elsetech/webterm`.

Think of it as an old telephone switchboard: each **token is a circuit**, and the
operator (the Worker + Durable Object) patches the daemon's line to the browser's.

```
  your machine                         your Cloudflare account            any browser
 ┌──────────────┐   wss (dials out)   ┌───────────────────────────┐   wss   ┌──────────┐
 │  switchboard │ ──────────────────▶ │  Worker  +  Durable Object │ ◀────── │ xterm.js │
 │  daemon      │  /ws?role=daemon    │  (one Circuit per token)   │ browser │   page   │
 └──────────────┘                     └───────────────────────────┘         └──────────┘
```

It is a **transparent forwarder**: it pairs the daemon and the browser(s) by
token and shovels frames between them. It never parses the terminal payloads.

> ⚠️ Like the original, Switchboard is **not end-to-end encrypted** — TLS
> terminates at the Worker, so the relay (i.e. you, the operator) can see the
> plaintext stream. Self-hosting removes the third party, not the relay's
> visibility. See [Security](#security).

## What's here

| File | Purpose |
| --- | --- |
| `src/index.js` | Worker entry + `Circuit` Durable Object (the relay) |
| `public/index.html` | The browser terminal (xterm.js, self-contained) |
| `wrangler.jsonc` | Cloudflare config (DO binding, migration, static assets) |
| `cli/index.js` | Host CLI (`@switchboard/cli`) — spawns your shell, dials out to the relay |
| `cli/scripts/fix-pty-perms.js` | node-pty macOS spawn-helper fix (postinstall) |

## Deploy

```bash
cd Switchboard
npm install
npx wrangler login        # one-time, opens a browser
npm run deploy
```

Wrangler prints the deployed URL, e.g. `https://switchboard.<your-subdomain>.workers.dev`.

Then run the host daemon (in this repo) pointing at it:

```bash
cd cli && npm install
node index.js --server https://switchboard.<your-subdomain>.workers.dev
# the original is wire-compatible too:
# npx @elsetech/webterm --server https://switchboard.<your-subdomain>.workers.dev
```

The daemon prints a token and an `Open:` URL on **your** domain. Open it (or
paste the token into the page) and you get a shell on the daemon's machine.

### Custom domain (optional)

To serve it at `switchboard.example.com`, add a route in the Cloudflare dashboard
(Workers & Pages → your worker → Settings → Domains & Routes) or via
`wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "switchboard.example.com", "custom_domain": true }]
```

## Local development

```bash
npm run dev               # wrangler dev, defaults to http://localhost:8787
# in another terminal — the CLI defaults to localhost:8787, so just:
cd cli && npm install && node index.js
```

The daemon rewrites `http→ws` automatically, so `http://localhost:8787` works.
Durable Objects and hibernatable WebSockets run under `wrangler dev` locally.

## How it works

`idFromName(token)` maps every daemon/browser carrying the same token into one
Durable Object instance — the **circuit** for that token. Inside the circuit:

- **binary frames** `[1-byte sid len][sid][payload]` are forwarded verbatim in
  both directions (keystrokes one way, PTY output the other). Daemon output is
  broadcast to every browser on the circuit; each browser filters by its own `sid`.
- **JSON control messages** are forwarded verbatim: the browser's
  `open` / `resize` / `client-gone` / `dl-*` / `ul-*` go to the daemon; the
  daemon's `stats` / `exit` / `dl-*` / `ul-*` go to the browsers.
- the relay itself sends `peer-status {online}` to the daemon (which logs it)
  and a private `_relay {event}` to browsers (host online/offline).
- a **second daemon** on the same token gets **HTTP 409**, which the daemon
  treats as fatal — exactly as the original relay behaves.

It uses the **Hibernatable WebSockets API**, so idle terminals cost nothing and
the circuit survives the DO being evicted between messages. A plain
`"ping"`/`"pong"` auto-response keeps connections warm without waking the DO.

## Protocol

Reverse-engineered from `@elsetech/webterm@2.0.0` and forwarded verbatim, so
Switchboard stays payload-agnostic. Frame format:

```
binary:  [1-byte sid length][sid utf8][payload bytes]
browser → daemon JSON:  open · resize · client-gone · dl-open · ul-open · ul-chunk · ul-end
daemon → browser JSON:  stats · exit · dl-meta · dl-chunk · dl-end · dl-error · ul-ready · ul-done · ul-error
relay  → daemon  JSON:  peer-status {online}
relay  → browser JSON:  _relay {event}   (Switchboard's own frontend only)
```

## Security

- **The token is the only credential.** Anyone with it gets a shell on the
  daemon's host. Treat it like a password; it is a fresh 256-bit value per run.
- **The relay sees plaintext.** This matches the original design. If you want the
  relay to be untrusted too, add an end-to-end encryption layer (e.g. derive a
  key from extra entropy in the token, X25519 + an AEAD between daemon and
  browser) — the relay forwards opaque bytes either way, so no relay change is
  needed.
- **Anyone who can reach the Worker URL can try tokens.** Tokens are 256-bit
  random, so guessing is infeasible, but you can add Cloudflare Access in front
  of the Worker to gate it behind your own auth.
- The browser frontend loads `xterm.js` from jsDelivr. To remove that external
  dependency, vendor the two `@xterm` files into `public/` and update the
  `<script>`/`<link>` tags.

## Compatibility

Verified against the daemon protocol in `@elsetech/webterm@2.0.0`, including a
full end-to-end run (real daemon ↔ Switchboard ↔ browser): live commands, host
stats, and file upload/download all round-trip. The relay is payload-agnostic,
so it should keep working as long as the framing (1-byte sid length prefix +
JSON control messages) is unchanged.
