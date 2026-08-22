-- Keep host identity useful while a daemon is offline; heartbeat updates refresh
-- these values without changing the relay's transparent transport behaviour.
ALTER TABLE machines ADD COLUMN platform TEXT;
ALTER TABLE machines ADD COLUMN arch TEXT;
