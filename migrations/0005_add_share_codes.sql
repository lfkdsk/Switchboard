-- One-time account-sharing codes. Apply to an existing database with:
--   npx wrangler d1 execute switchboard_db --local  --file migrations/0005_add_share_codes.sql
--   npx wrangler d1 execute switchboard_db --remote --file migrations/0005_add_share_codes.sql
--
-- The browser displays the plaintext once. D1 stores only its SHA-256 hash;
-- codes expire after ten minutes and are claimed by one signed-in account.

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
