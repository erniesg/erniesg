-- Durable keyed-create receipts outlive annotation deletion. They bind a
-- canonical request fingerprint to the generated annotation id without
-- retaining source text or a plaintext principal in any public response.
CREATE TABLE margin_idempotency_receipts (
  creator       TEXT NOT NULL,
  site          TEXT NOT NULL,
  document      TEXT NOT NULL,
  request_key   TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  created       TEXT NOT NULL,
  PRIMARY KEY (creator, site, document, request_key)
);
