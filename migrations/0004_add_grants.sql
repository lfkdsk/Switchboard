-- Adds identity-based, revocable sharing of one machine with another GitHub
-- account. Some early deployments briefly used 0002/0003 for an older grants
-- experiment, while current main uses 0002 for machines.peer. Starting at 0004
-- avoids reusing any of those deployed migration numbers:
--
--   npx wrangler d1 execute switchboard_db --local  --file migrations/0004_add_grants.sql
--   npx wrangler d1 execute switchboard_db --remote --file migrations/0004_add_grants.sql
--
-- Idempotent: this migration only creates a table and index with IF NOT EXISTS.
-- It is also compatible with an old machine_grants table that still has an
-- unused can_exec column; that extra column can remain until a later cleanup.
CREATE TABLE IF NOT EXISTS machine_grants (
  machine_id       TEXT NOT NULL,
  grantee_id       TEXT NOT NULL,
  grantee_login    TEXT NOT NULL,
  granted_by_id    TEXT NOT NULL,
  granted_by_login TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  revoked_at       INTEGER,
  PRIMARY KEY (machine_id, grantee_id)
);
CREATE INDEX IF NOT EXISTS idx_machine_grants_grantee ON machine_grants(grantee_id);
