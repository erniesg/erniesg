-- Explicit per-site review authority; no identity creation or admin grant.
-- Identity DDL is owned by margin/identity.ts and may be initialized before
-- or after this migration. Reads require both its global admin role and this
-- mapping. Applying this table alone grants nobody access.
CREATE TABLE margin_site_admins (
  site TEXT NOT NULL,
  identity_id INTEGER NOT NULL REFERENCES margin_identity(id) ON DELETE CASCADE,
  PRIMARY KEY (site, identity_id)
);
