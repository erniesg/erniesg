-- margin identity and allowlist schema.
--
-- Kept byte-identical to SCHEMA_STATEMENTS in ./identity.ts, which a test
-- asserts. Apply by hand with:
--
--   wrangler d1 execute margin-db-stg --file src/worker/margin/schema.sql
--
-- The Worker also applies these statements itself on the login callback path,
-- so a fresh database needs no manual step; they are all IF NOT EXISTS.
--
-- There is no self-service path onto the allowlist, which is the point. After
-- somebody has signed in once, the owner adds them by hand:
--
--   INSERT INTO margin_allowlist (identity_id, role, added_at)
--   SELECT id, 'writer', datetime('now') FROM margin_identity
--   WHERE issuer = ? AND subject = ?;
--
-- The admin row is bound automatically, once, on the first sign-in by the
-- owner's verified email. After that, email decides nothing.

CREATE TABLE IF NOT EXISTS margin_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (provider, issuer, subject)
);

CREATE TABLE IF NOT EXISTS margin_allowlist (
  identity_id INTEGER PRIMARY KEY REFERENCES margin_identity(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('writer', 'admin')),
  added_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS margin_allowlist_single_admin
  ON margin_allowlist (role) WHERE role = 'admin';
