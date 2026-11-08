-- Self-service removal: SHA-256 hash of the private token returned at sign-up.
ALTER TABLE waitlist ADD COLUMN remove_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_remove_hash ON waitlist (remove_hash);
