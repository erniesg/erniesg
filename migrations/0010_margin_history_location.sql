-- Public, operator-provisioned site-owned history locator. Existing sites are
-- unavailable until separately configured; no token, grant or seed is added.
ALTER TABLE margin_adapters ADD COLUMN history_location TEXT;
