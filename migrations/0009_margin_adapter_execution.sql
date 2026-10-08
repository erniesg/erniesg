-- Private execution metadata only. No grants or historical attempt counts are
-- seeded. Revoke report grants before an operator-controlled rollback; retain
-- receipts and execution rows for reconciliation. Dropping them loses evidence.
CREATE TABLE margin_adapter_report_grants (
  token_id TEXT PRIMARY KEY NOT NULL REFERENCES margin_adapter_tokens(token_id) ON DELETE RESTRICT,
  token_sha256 TEXT NOT NULL CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  site TEXT NOT NULL,
  adapter TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(site,adapter) REFERENCES margin_adapters(site,adapter) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX margin_application_execution_binding
  ON margin_proposal_applications(proposal_id,site,revision);
CREATE TABLE margin_proposal_execution (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  site TEXT NOT NULL,
  approved_revision INTEGER NOT NULL,
  state_version INTEGER NOT NULL CHECK(typeof(state_version)='integer' AND state_version BETWEEN 0 AND 9007199254740991),
  failed_apply_count INTEGER NOT NULL CHECK(typeof(failed_apply_count)='integer' AND failed_apply_count BETWEEN 0 AND 3 AND failed_apply_count<=state_version),
  bound_adapter TEXT,
  pr_number INTEGER CHECK(pr_number IS NULL OR (typeof(pr_number)='integer' AND pr_number BETWEEN 1 AND 9007199254740991)),
  pr_url TEXT CHECK(pr_url IS NULL OR length(pr_url) BETWEEN 1 AND 2048),
  pr_head TEXT CHECK(pr_head IS NULL OR (length(pr_head) IN (40,64) AND pr_head NOT GLOB '*[^0-9a-f]*')),
  checks TEXT CHECK(checks IS NULL OR checks IN ('pending','passed','failed','not_evaluated')),
  detail TEXT CHECK(detail IS NULL OR length(detail) BETWEEN 1 AND 4096),
  merge_commit TEXT CHECK(merge_commit IS NULL OR (length(merge_commit) IN (40,64) AND merge_commit NOT GLOB '*[^0-9a-f]*')),
  last_event TEXT,
  updated_at TEXT NOT NULL,
  CHECK((pr_number IS NULL AND pr_url IS NULL AND pr_head IS NULL) OR (pr_number IS NOT NULL AND pr_url IS NOT NULL AND pr_head IS NOT NULL)),
  CHECK((state_version=0 AND failed_apply_count=0 AND bound_adapter IS NULL AND last_event IS NULL AND pr_number IS NULL AND checks IS NULL AND detail IS NULL AND merge_commit IS NULL)
    OR (state_version>0 AND bound_adapter IS NOT NULL AND length(last_event)=22)),
  FOREIGN KEY(proposal_id,site,approved_revision) REFERENCES margin_proposal_applications(proposal_id,site,revision) ON DELETE RESTRICT,
  FOREIGN KEY(site,bound_adapter) REFERENCES margin_adapters(site,adapter) ON DELETE RESTRICT
);
CREATE TRIGGER margin_execution_initialize AFTER INSERT ON margin_proposal_applications
BEGIN
  INSERT INTO margin_proposal_execution(proposal_id,site,approved_revision,state_version,failed_apply_count,updated_at)
  VALUES(NEW.proposal_id,NEW.site,NEW.revision,0,0,NEW.approved_at);
END;
CREATE TRIGGER margin_execution_no_replace BEFORE INSERT ON margin_proposal_execution
WHEN EXISTS(SELECT 1 FROM margin_proposal_execution WHERE proposal_id=NEW.proposal_id)
BEGIN SELECT RAISE(ABORT,'execution cannot be replaced'); END;
CREATE TRIGGER margin_execution_no_delete BEFORE DELETE ON margin_proposal_execution
BEGIN SELECT RAISE(ABORT,'execution cannot be deleted'); END;
CREATE TRIGGER margin_execution_binding_immutable BEFORE UPDATE OF proposal_id,site,approved_revision ON margin_proposal_execution
BEGIN SELECT RAISE(ABORT,'execution binding is immutable'); END;
CREATE TABLE margin_adapter_report_receipts (
  site TEXT NOT NULL,
  adapter TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK(length(event_id)=22),
  proposal_id TEXT NOT NULL,
  approved_revision INTEGER NOT NULL,
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 0 AND 9007199254740990),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  accepted_at TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK(state_version=expected_version+1),
  failed_apply_count INTEGER NOT NULL CHECK(typeof(failed_apply_count)='integer' AND failed_apply_count BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK(state IN ('pr_open','conflict','apply_failed','merged','closed')),
  pr_number INTEGER,
  pr_url TEXT,
  pr_head TEXT,
  checks TEXT,
  detail TEXT,
  merge_commit TEXT,
  PRIMARY KEY(site,adapter,event_id),
  FOREIGN KEY(proposal_id,site,approved_revision) REFERENCES margin_proposal_applications(proposal_id,site,revision) ON DELETE RESTRICT,
  FOREIGN KEY(site,adapter) REFERENCES margin_adapters(site,adapter) ON DELETE RESTRICT
);
-- BEFORE INSERT is intentional: OR REPLACE must never erase an acknowledgement.
CREATE TRIGGER margin_report_no_replace BEFORE INSERT ON margin_adapter_report_receipts
WHEN EXISTS(SELECT 1 FROM margin_adapter_report_receipts WHERE site=NEW.site AND adapter=NEW.adapter AND event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'report receipt cannot be replaced'); END;
CREATE TRIGGER margin_report_no_update BEFORE UPDATE ON margin_adapter_report_receipts
BEGIN SELECT RAISE(ABORT,'report receipt is immutable'); END;
CREATE TRIGGER margin_report_no_delete BEFORE DELETE ON margin_adapter_report_receipts
BEGIN SELECT RAISE(ABORT,'report receipt cannot be deleted'); END;
CREATE TRIGGER margin_report_project AFTER INSERT ON margin_adapter_report_receipts
BEGIN
  UPDATE margin_proposal_execution SET state_version=NEW.state_version,
    failed_apply_count=NEW.failed_apply_count,bound_adapter=NEW.adapter,
    pr_number=NEW.pr_number,pr_url=NEW.pr_url,pr_head=NEW.pr_head,checks=NEW.checks,
    detail=NEW.detail,merge_commit=NEW.merge_commit,last_event=NEW.event_id,updated_at=NEW.accepted_at
    WHERE proposal_id=NEW.proposal_id AND site=NEW.site AND approved_revision=NEW.approved_revision
      AND state_version=NEW.expected_version AND (bound_adapter IS NULL OR bound_adapter=NEW.adapter);
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'execution CAS lost') END;
  UPDATE margin_proposal_applications SET state=NEW.state
    WHERE proposal_id=NEW.proposal_id AND site=NEW.site AND revision=NEW.approved_revision;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'application binding lost') END;
END;
