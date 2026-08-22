-- Retains the OS and CPU architecture reported by each daemon so `switchboard
-- nodes` can show them even while a machine is offline. Apply once with:
--   npx wrangler d1 execute switchboard_db --local  --file migrations/0006_add_platform_arch.sql
--   npx wrangler d1 execute switchboard_db --remote --file migrations/0006_add_platform_arch.sql
--
-- Not idempotent: a duplicate-column error means this migration was already run.
ALTER TABLE machines ADD COLUMN platform TEXT;
ALTER TABLE machines ADD COLUMN arch TEXT;
