-- Current review metadata is separate from the once-approved application.
ALTER TABLE margin_annotations ADD COLUMN review_decision TEXT;
ALTER TABLE margin_annotations ADD COLUMN review_comments TEXT;
ALTER TABLE margin_annotations ADD COLUMN reviewed_by TEXT;
ALTER TABLE margin_annotations ADD COLUMN reviewed_at TEXT;
ALTER TABLE margin_annotations ADD COLUMN reviewed_revision INTEGER;

CREATE TABLE margin_proposal_applications (
  proposal_id TEXT PRIMARY KEY REFERENCES margin_annotations(id) ON DELETE RESTRICT,
  site TEXT NOT NULL,
  document TEXT NOT NULL,
  creator TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  body TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  source_path TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved', 'pr_open', 'conflict', 'merged', 'closed', 'apply_failed'))
);
-- Even replacement conflict strategies cannot discard an existing snapshot.
CREATE TRIGGER margin_application_no_replace BEFORE INSERT ON margin_proposal_applications
WHEN EXISTS (SELECT 1 FROM margin_proposal_applications WHERE proposal_id = NEW.proposal_id)
BEGIN SELECT RAISE(ABORT, 'approved snapshot cannot be replaced'); END;
CREATE TRIGGER margin_application_no_delete BEFORE DELETE ON margin_proposal_applications
BEGIN SELECT RAISE(ABORT, 'approved snapshot cannot be deleted'); END;
CREATE TRIGGER margin_application_immutable BEFORE UPDATE OF
  proposal_id, site, document, creator, visibility, body, base_commit, source_path,
  revision, approved_by, approved_at ON margin_proposal_applications
BEGIN SELECT RAISE(ABORT, 'approved snapshot is immutable'); END;
