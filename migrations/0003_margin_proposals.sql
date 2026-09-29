-- Edit proposals name the text they change (issue 059).
--
-- An `editing` annotation is a patch against a named base commit of the node's
-- source file. It records that commit, the repo-relative file, a revision the
-- reviewer's approval binds to (060), and when its author withdrew it. The
-- row is never deleted by a withdrawal: replies to it stay readable, and the
-- review listing simply leaves it out.
--
-- None of these apply to a highlight or a note, and an `editing` row must carry
-- all of them. The triggers say so in the database, so no code path can store
-- a proposal against a guess.

ALTER TABLE margin_annotations ADD COLUMN base_commit TEXT;
ALTER TABLE margin_annotations ADD COLUMN source_path TEXT;
ALTER TABLE margin_annotations ADD COLUMN revision INTEGER;
ALTER TABLE margin_annotations ADD COLUMN withdrawn_at TEXT;

CREATE TRIGGER margin_annotations_proposal_fields_insert
BEFORE INSERT ON margin_annotations
WHEN (
  NEW.motivation = 'editing' AND (
    NEW.base_commit IS NULL
    OR length(NEW.base_commit) NOT IN (40, 64)
    OR NEW.base_commit GLOB '*[^0-9a-f]*'
    OR NEW.source_path IS NULL
    OR length(NEW.source_path) = 0
    OR NEW.revision IS NULL
    OR NEW.revision < 1
  )
) OR (
  NEW.motivation <> 'editing' AND (
    NEW.base_commit IS NOT NULL
    OR NEW.source_path IS NOT NULL
    OR NEW.revision IS NOT NULL
    OR NEW.withdrawn_at IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'MARGIN_PROPOSAL_FIELDS');
END;

-- A proposal stored before this migration has no base commit; it stays
-- readable, but it can only be revised by supplying one.
CREATE TRIGGER margin_annotations_proposal_fields_update
BEFORE UPDATE OF base_commit, source_path, revision, withdrawn_at, body ON margin_annotations
WHEN (
  NEW.motivation = 'editing' AND (
    NEW.base_commit IS NULL
    OR length(NEW.base_commit) NOT IN (40, 64)
    OR NEW.base_commit GLOB '*[^0-9a-f]*'
    OR NEW.source_path IS NULL
    OR NEW.revision IS NULL
    OR NEW.revision < 1
  )
) OR (
  NEW.motivation <> 'editing' AND (
    NEW.base_commit IS NOT NULL
    OR NEW.source_path IS NOT NULL
    OR NEW.revision IS NOT NULL
    OR NEW.withdrawn_at IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'MARGIN_PROPOSAL_FIELDS');
END;
