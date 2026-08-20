-- Production already has the schema from schema.sql through the historical
-- migrations/0005_add_share_codes.sql. This no-op starts Wrangler's migration
-- ledger without replaying the old, manually applied ALTER TABLE statements.
SELECT 1;
