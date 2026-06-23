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
  last_seen     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_machines_account ON machines(account_id);

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
