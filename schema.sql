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
  activity      TEXT
);
CREATE INDEX IF NOT EXISTS idx_machines_account ON machines(account_id);

-- Delegated access: one row per (machine, person you shared it with). A machine
-- still belongs to exactly one account — this table only widens who may *open a
-- shell*, never who may rename, delete or re-share it. Keyed on the grantee's
-- numeric id rather than their login so a grant survives a GitHub rename, and
-- so a stranger who later claims the freed login does not inherit the access.
CREATE TABLE IF NOT EXISTS machine_grants (
  machine_id       TEXT NOT NULL,      -- machines.machine_id being shared
  grantee_id       TEXT NOT NULL,      -- GitHub numeric user id of the invitee
  grantee_login    TEXT NOT NULL,      -- their login when granted (for display)
  granted_by_id    TEXT NOT NULL,      -- owner at the time, for the audit trail
  granted_by_login TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,            -- NULL = never expires
  -- Whether software may drive this machine, or only a person may sit at it.
  -- Off by default: sharing a shell with someone is a smaller thing than letting
  -- their agents and flows run commands here unattended, and the smaller thing
  -- is what "share" means to the person clicking it. This is a guardrail on
  -- automation, not a sandbox — a grantee who wants to can still type anything
  -- into the shell they were given.
  can_exec         INTEGER NOT NULL DEFAULT 0,
  -- Revocation writes a tombstone instead of deleting the row: the row *is* the
  -- record of who was let in and when they were cut off. Re-granting the same
  -- person clears revoked_at rather than inserting a second row, which is why
  -- (machine_id, grantee_id) can be the primary key.
  revoked_at       INTEGER,            -- NULL = live
  PRIMARY KEY (machine_id, grantee_id)
);
-- "which machines am I allowed into?" — asked on every dashboard load.
CREATE INDEX IF NOT EXISTS idx_machine_grants_grantee ON machine_grants(grantee_id);

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
