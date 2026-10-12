-- Reservations count attempts, including failed upstream submissions and deletion.
-- Never store raw IPs, filenames, PDF bytes, converter errors, or reports here.
CREATE TABLE struct_demo_jobs (
  public_id TEXT PRIMARY KEY NOT NULL,
  owner_hash TEXT NOT NULL,
  network_hash TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  backend_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE INDEX struct_demo_quota_day ON struct_demo_jobs(quota_day);
CREATE INDEX struct_demo_network_day ON struct_demo_jobs(network_hash, quota_day);
CREATE INDEX struct_demo_expiry ON struct_demo_jobs(expires_at);
