-- Adds machine_grants — revocable, identity-based sharing of one machine with
-- another GitHub account. Until now the only way to let someone else onto a
-- host was to hand them a raw one-off token: unrevocable, unattributable, and
-- shared by everyone who ever received it.
--
-- schema.sql only uses CREATE TABLE IF NOT EXISTS, so an existing database
-- never picks up a new table on its own. Run this once against each:
--   npx wrangler d1 execute switchboard_db --local  --file migrations/0002_add_grants.sql
--   npx wrangler d1 execute switchboard_db --remote --file migrations/0002_add_grants.sql
--
-- Unlike 0001 this one *is* idempotent — it only adds a new table and index, so
-- IF NOT EXISTS covers it and a second run is a no-op rather than an error.
CREATE TABLE IF NOT EXISTS machine_grants (
  machine_id       TEXT NOT NULL,
  grantee_id       TEXT NOT NULL,
  grantee_login    TEXT NOT NULL,
  granted_by_id    TEXT NOT NULL,
  granted_by_login TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,            -- NULL = never expires
  revoked_at       INTEGER,            -- NULL = live
  PRIMARY KEY (machine_id, grantee_id)
);
CREATE INDEX IF NOT EXISTS idx_machine_grants_grantee ON machine_grants(grantee_id);
