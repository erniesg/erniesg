-- Read-only service identities; no credentials or site grants are seeded.
-- Apply only through the operator's migration process. Rollback requires
-- disabling/revoking grants before removing these additive registry tables.
CREATE TABLE margin_adapters (
  site TEXT PRIMARY KEY NOT NULL,
  adapter TEXT NOT NULL CHECK (length(adapter) BETWEEN 1 AND 128),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (site, adapter)
);
CREATE TABLE margin_adapter_tokens (
  token_id TEXT PRIMARY KEY NOT NULL CHECK (length(token_id) = 22),
  site TEXT NOT NULL,
  adapter TEXT NOT NULL,
  token_sha256 TEXT NOT NULL CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  capability TEXT NOT NULL CHECK (capability = 'approved_feed'),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (site, adapter) REFERENCES margin_adapters(site, adapter) ON DELETE RESTRICT
);
CREATE INDEX margin_applications_approved_feed
  ON margin_proposal_applications(site, state, approved_at, proposal_id);
