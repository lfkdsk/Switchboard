-- Switchboard D1 schema. Apply locally:
--   npx wrangler d1 execute switchboard_db --local --file schema.sql
-- and remotely (after `wrangler d1 create switchboard_db`):
--   npx wrangler d1 execute switchboard_db --remote --file schema.sql

-- Machines bound to an account, discoverable in the dashboard.
CREATE TABLE IF NOT EXISTS machines (
  machine_id    TEXT PRIMARY KEY,   -- random UUID chosen by the CLI, persisted locally
  account_id    TEXT NOT NULL,      -- GitHub numeric user id
  account_login TEXT NOT NULL,      -- GitHub login (for display)
  name          TEXT NOT NULL DEFAULT '',
  online        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,   -- bumped by each daemon stats heartbeat (~2s)
  rtt           INTEGER,            -- daemon↔relay round-trip (ms), from heartbeat
  cpu           REAL,               -- last reported cpu fraction 0..1
  mem_used      INTEGER,
  mem_total     INTEGER,
  -- What the machine is doing, as an opaque JSON blob (shells / top / agents).
  -- Display-only and always ephemeral: cleared the moment the daemon goes away.
  -- See migrations/ for applying this to a database created before it existed.
  activity      TEXT,
  -- Does this machine accept peer connections — a `switchboard exec/shell` from
  -- another machine on the same account? Declared by the daemon on every connect
  -- (never by a client), so the host itself decides. Defaults to 0 so a row
  -- written by a daemon too old to have an opinion is closed, not open.
  peer          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_machines_account ON machines(account_id);

-- Delegated access. A machine still has exactly one owner; a live row here lets
-- another GitHub account open its terminal and, when peer is enabled on the
-- host, reach it through `switchboard exec` / `switchboard shell` as well.
-- Numeric GitHub ids are the authority; logins are display-only snapshots.
CREATE TABLE IF NOT EXISTS machine_grants (
  machine_id       TEXT NOT NULL,
  grantee_id       TEXT NOT NULL,
  grantee_login    TEXT NOT NULL,
  granted_by_id    TEXT NOT NULL,
  granted_by_login TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,            -- NULL = no automatic expiry
  revoked_at       INTEGER,            -- NULL = live
  PRIMARY KEY (machine_id, grantee_id)
);
CREATE INDEX IF NOT EXISTS idx_machine_grants_grantee ON machine_grants(grantee_id);

-- Short-lived, single-use invitations. Only the SHA-256 hash is stored; the
-- plaintext code is shown once to the owner and becomes a grant only when a
-- signed-in recipient redeems it.
CREATE TABLE IF NOT EXISTS machine_share_codes (
  code_hash         TEXT PRIMARY KEY,
  machine_id        TEXT NOT NULL,
  created_by_id     TEXT NOT NULL,
  created_by_login  TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  access_expires_at INTEGER,
  redeemed_at       INTEGER,
  redeemed_by_id    TEXT,
  redeemed_by_login TEXT
);
CREATE INDEX IF NOT EXISTS idx_machine_share_codes_machine ON machine_share_codes(machine_id);

-- Account-scoped agent tokens the CLI presents to register/connect a machine.
-- Only the SHA-256 hash is stored; the plaintext lives in the CLI's config.
CREATE TABLE IF NOT EXISTS agent_tokens (
  token_hash    TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  account_login TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_account ON agent_tokens(account_id);

-- Ephemeral CLI-login handshake rows (PKCE-like). Pruned by age on each start.
CREATE TABLE IF NOT EXISTS cli_logins (
  state         TEXT PRIMARY KEY,   -- random, travels in the browser URL
  verifier_hash TEXT NOT NULL,      -- sha256(verifier); only the CLI holds the verifier
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | ready
  account_id    TEXT,
  account_login TEXT,
  agent_token   TEXT,               -- plaintext, handed to the CLI once then row deleted
  created_at    INTEGER NOT NULL
);
