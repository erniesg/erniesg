-- 0001: the durable editorial store.
--
-- This is the numbered, forward-only migration E05c adds. It lives under
-- `src/editorial/migrations/`, NOT under the repository's `migrations/`
-- directory, so neither the Wrangler migration runner (whose pattern for
-- `MARGIN_DB` is `migrations/*.sql`) nor the margin test harness (which
-- applies every `migrations/*.sql` in filename order) ever sees it. The
-- editorial store is a separate database with a separate binding, and the
-- binding — and its `migrations_dir` — is added when the cutover is
-- authorised, not before.
--
-- NOTHING HAS APPLIED THIS FILE. E-05c does not create a database, does not
-- apply a migration and does not touch a live database. The coordinator
-- authorises the apply.
--
-- The DDL is the schema of record, `src/editorial/schema.sql`, unchanged:
-- E05a wrote that file and this migration applies it.
--
-- Design notes the DDL carries:
--
--  - Every row is immutable. There is no `updated_at` on a record row, and a
--    record row is only ever written by an INSERT. The only mutable thing in
--    the store is the materialised `state` column of a revision, a candidate
--    and a release; it is updated by the conditional UPDATE of the
--    compare-and-swap, in the same transaction as the append it belongs to.
--  - `state` is the materialised projection of the append-only record set.
--    The authoritative state is the projection; the column is maintained in
--    the same transaction as the append, so the two cannot diverge.
--  - The JSON columns hold the nested objects of the record schemas
--    verbatim. The authoritative shape of each is the zod schema in
--    `records.ts`; the column is the storage of it.
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

-- At most one release per target may be current at a time.
--
-- The state machine refuses a second current release for a target
-- (`target_already_released`), and this index makes the same rule hold at
-- the storage level: two writers that both believed they were first cannot
-- both commit. A compare-and-swap cannot enforce it, because there is no
-- per-target row to compare and swap -- the CAS guards one row's state, and
-- a release row's state says whether *that* release is current.
CREATE UNIQUE INDEX IF NOT EXISTS editorial_releases_one_current
  ON editorial_releases (target_id) WHERE state = 'release-released';

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
