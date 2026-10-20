-- The durable editorial record store.
--
-- NOT APPLIED BY E-05. This file is the schema of record for the
-- `EDITORIAL_DB` database, and E-05a neither creates that database nor
-- applies this file. It lives under `src/editorial/` and NOT under
-- `migrations/`, so the Wrangler migration runner and the margin test
-- harness (`src/worker/margin/sqlite-database.ts`, which applies every
-- `migrations/*.sql` in filename order) never see it. Nothing applies it
-- until the follow-up job (E05c) adds the numbered migration and the
-- coordinator authorises the apply.
--
-- The statements are the `IF NOT EXISTS` form, like
-- `src/worker/margin/schema.sql`, so a fresh database needs no manual step
-- when the writer is first allowed to run.
--
-- Design notes that the DDL has to carry:
--
--  - Every row is immutable. There is no `updated_at`, and the only write
--    path is an INSERT. A record that has to change is replaced by a new
--    record, which is why the state columns below are the only mutable
--    thing in the store.
--  - `state` on a revision, a candidate and a release is the *materialised*
--    projection of the append-only record set. It exists so a write can be
--    a compare-and-swap: `UPDATE ... SET state = ? WHERE id = ? AND state
--    = ?`, and zero changed rows means somebody else moved first. The
--    authoritative state is still the projection; the column is maintained
--    in the same transaction as the append, so the two cannot diverge.
--  - The JSON columns hold the nested objects of the record schemas
--    verbatim (`source_binding`, `schema_versions`, `rendering`, `target`,
--    `artifacts`, `actor`, `evidence`). The authoritative shape of each is
--    the zod schema in `records.ts`; the column is the storage of it.
--  - `id` is the content-addressed id: `urn:editorial:<kind>:<sha256>`. It
--    is the primary key, so the store cannot hold two records with the same
--    id, and the id cannot be changed.

CREATE TABLE IF NOT EXISTS editorial_revisions (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind = 'revision'),
  version                TEXT NOT NULL,
  content_hash           TEXT NOT NULL,
  document_sha256        TEXT NOT NULL,
  bundle_sha256          TEXT,
  semantic_receipt_sha256 TEXT,
  source_binding         TEXT NOT NULL,
  schema_versions        TEXT NOT NULL,
  rendering              TEXT NOT NULL,
  author                 TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN (
                           'revision-proposed',
                           'revision-approved',
                           'revision-rejected',
                           'revision-changes-requested'
                         )),
  created                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editorial_revisions_content
  ON editorial_revisions (content_hash);
CREATE INDEX IF NOT EXISTS editorial_revisions_state
  ON editorial_revisions (state, created);

CREATE TABLE IF NOT EXISTS editorial_decisions (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind = 'decision'),
  version       TEXT NOT NULL,
  revision_id   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  bundle_sha256 TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN (
                  'approved', 'rejected', 'changes-requested'
                )),
  actor         TEXT NOT NULL,
  rationale     TEXT,
  decided_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editorial_decisions_revision
  ON editorial_decisions (revision_id, decided_at);

CREATE TABLE IF NOT EXISTS editorial_candidates (
  id                        TEXT PRIMARY KEY,
  kind                      TEXT NOT NULL CHECK (kind = 'candidate'),
  version                   TEXT NOT NULL,
  revision_id               TEXT NOT NULL,
  content_hash              TEXT NOT NULL,
  document_sha256           TEXT NOT NULL,
  bundle_sha256             TEXT,
  target_id                 TEXT NOT NULL,
  target                    TEXT NOT NULL,
  artifacts                 TEXT NOT NULL,
  artifact_set_sha256       TEXT NOT NULL,
  required_validation_checks TEXT NOT NULL,
  author                    TEXT NOT NULL,
  state                     TEXT NOT NULL CHECK (state IN (
                              'candidate-assembled',
                              'candidate-validated',
                              'candidate-approved-for-release',
                              'candidate-released'
                            )),
  created                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editorial_candidates_target
  ON editorial_candidates (target_id, state);
CREATE INDEX IF NOT EXISTS editorial_candidates_revision
  ON editorial_candidates (revision_id);

CREATE TABLE IF NOT EXISTS editorial_validations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind = 'validation'),
  version         TEXT NOT NULL,
  check_name      TEXT NOT NULL,
  candidate_id    TEXT NOT NULL,
  revision_id     TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  bundle_sha256   TEXT,
  target_id       TEXT NOT NULL,
  artifact_set_sha256 TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  evidence        TEXT NOT NULL,
  actor           TEXT NOT NULL,
  validated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editorial_validations_candidate
  ON editorial_validations (candidate_id, check_name);

CREATE TABLE IF NOT EXISTS editorial_approvals (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind = 'approval'),
  version              TEXT NOT NULL,
  candidate_id         TEXT NOT NULL,
  revision_id          TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  document_sha256      TEXT NOT NULL,
  bundle_sha256        TEXT,
  target_id            TEXT NOT NULL,
  artifact_set_sha256  TEXT NOT NULL,
  actor                TEXT NOT NULL,
  approved_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editorial_approvals_candidate
  ON editorial_approvals (candidate_id, approved_at);

CREATE TABLE IF NOT EXISTS editorial_releases (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind = 'release'),
  version            TEXT NOT NULL,
  candidate_id       TEXT NOT NULL,
  revision_id        TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  source_binding     TEXT NOT NULL,
  schema_versions    TEXT NOT NULL,
  rendering          TEXT NOT NULL,
  validations        TEXT NOT NULL,
  approval           TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  target             TEXT NOT NULL,
  artifacts          TEXT NOT NULL,
  artifact_set_sha256 TEXT NOT NULL,
  producer           TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN (
                       'release-released',
                       'release-superseded',
                       'release-withdrawn'
                     )),
  released_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editorial_releases_target
  ON editorial_releases (target_id, state);
CREATE INDEX IF NOT EXISTS editorial_releases_candidate
  ON editorial_releases (candidate_id);

CREATE TABLE IF NOT EXISTS editorial_supersessions (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind = 'supersession'),
  version              TEXT NOT NULL,
  subject_release_id   TEXT NOT NULL,
  superseding_release_id TEXT,
  reason               TEXT NOT NULL CHECK (reason IN (
                         'replacement', 'correction', 'withdrawn', 'revocation'
                       )),
  actor                TEXT NOT NULL,
  at                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editorial_supersessions_subject
  ON editorial_supersessions (subject_release_id);

-- The idempotency receipt of a keyed submission.
--
-- The key scope is (actor, record_kind, request_key), the same shape as the
-- margin service's (creator, site, document, request_key): one caller's key
-- never collides with another's, and the same key in a different record kind
-- is a different submission. The fingerprint is the record's identity
-- digest, so a replay of the same submission carries the same fingerprint
-- and a reused key with different content does not.
CREATE TABLE IF NOT EXISTS editorial_idempotency_receipts (
  actor         TEXT NOT NULL,
  record_kind   TEXT NOT NULL,
  request_key   TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  created       TEXT NOT NULL,
  PRIMARY KEY (actor, record_kind, request_key)
);
