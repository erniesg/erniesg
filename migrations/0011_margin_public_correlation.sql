-- Durable public pseudonyms only; no key material, historical backfill or grants.
-- Preserve issued rows during key rotation and operator-controlled rollback:
-- losing them can create duplicate public artifacts. This is not an approval.
CREATE TABLE margin_public_correlations (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  site TEXT NOT NULL,
  approved_revision INTEGER NOT NULL CHECK(typeof(approved_revision)='integer' AND approved_revision BETWEEN 1 AND 9007199254740991),
  public_id TEXT UNIQUE NOT NULL CHECK(typeof(public_id)='text' AND length(public_id)=64 AND public_id NOT GLOB '*[^0-9a-f]*' AND instr(public_id,char(0))=0),
  key_id TEXT NOT NULL CHECK(typeof(key_id)='text' AND length(key_id) BETWEEN 1 AND 32 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(key_id,char(0))=0),
  scheme_version INTEGER NOT NULL CHECK(typeof(scheme_version)='integer' AND scheme_version=1),
  issued_at TEXT NOT NULL,
  FOREIGN KEY(proposal_id,site,approved_revision) REFERENCES margin_proposal_applications(proposal_id,site,revision) ON DELETE RESTRICT
);
-- OR REPLACE must not erase either an application identity or a colliding ID.
CREATE TRIGGER margin_public_correlation_no_replace BEFORE INSERT ON margin_public_correlations
WHEN EXISTS(SELECT 1 FROM margin_public_correlations WHERE proposal_id=NEW.proposal_id OR public_id=NEW.public_id)
BEGIN SELECT RAISE(ABORT,'public correlation cannot be replaced'); END;
CREATE TRIGGER margin_public_correlation_no_update BEFORE UPDATE ON margin_public_correlations
BEGIN SELECT RAISE(ABORT,'public correlation is immutable'); END;
CREATE TRIGGER margin_public_correlation_no_delete BEFORE DELETE ON margin_public_correlations
BEGIN SELECT RAISE(ABORT,'public correlation cannot be deleted'); END;
