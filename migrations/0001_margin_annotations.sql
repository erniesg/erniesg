-- Migration number: 0001 	 2026-09-22T00:00:00.000Z
--
-- margin: the W3C Web Annotation store.
--
-- Two tables and nothing document-specific. `(site, document)` is the tenancy
-- key and it is part of every index and every read path, so a second site is
-- a different pair of column values rather than a migration. `site` is a URL
-- origin and `document` is the rest of the annotation target URI; together
-- they rebuild the W3C `target.source` exactly.
--
-- Selectors are stored as typed columns rather than a JSON blob so the
-- visibility predicate, the tenancy predicate and any future anchor query all
-- run in SQL. `src/worker/margin/web-annotation.ts` owns the mapping back to
-- the canonical selector list.

CREATE TABLE margin_annotations (
  id             TEXT PRIMARY KEY,
  site           TEXT NOT NULL,
  document       TEXT NOT NULL,
  creator        TEXT NOT NULL,
  visibility     TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  motivation     TEXT NOT NULL CHECK (motivation IN ('highlighting', 'commenting', 'editing')),
  -- RESTRICT, not CASCADE: a reply belongs to whoever wrote it, and the delete
  -- path is owner-scoped, so cascading would let a parent's owner destroy other
  -- people's annotations. The route refuses a delete with replies under it and
  -- this is the backstop for anything that does not go through the route.
  parent_id      TEXT REFERENCES margin_annotations (id) ON DELETE RESTRICT,
  struct_id      TEXT,
  node_id        TEXT NOT NULL,
  position_start INTEGER NOT NULL,
  position_end   INTEGER NOT NULL,
  position_unit  TEXT NOT NULL CHECK (position_unit IN ('utf16', 'codepoint')),
  quote_exact    TEXT NOT NULL,
  quote_prefix   TEXT NOT NULL DEFAULT '',
  quote_suffix   TEXT NOT NULL DEFAULT '',
  body           TEXT,
  color          TEXT,
  created        TEXT NOT NULL,
  modified       TEXT NOT NULL,
  CHECK (position_end > position_start),
  -- A highlight carries no body; a note and a proposal require one.
  CHECK (
    (motivation = 'highlighting' AND body IS NULL) OR
    (motivation <> 'highlighting' AND body IS NOT NULL AND length(body) > 0)
  )
);

-- The read path is always (site, document) first, then the visibility
-- predicate, then the owner. Leading with the tenancy key keeps one site's
-- rows off another site's query entirely.
CREATE INDEX margin_annotations_tenant
  ON margin_annotations (site, document, visibility, creator);

-- Anonymous readers have no owner branch. Put the public predicate before the
-- keyset order so private rows are never scanned to fill a public page.
CREATE INDEX margin_annotations_public_page
  ON margin_annotations (site, document, visibility, created, id);

-- Signed-in lists merge this private owner stream with the public stream.
-- Both predicates precede the keyset order, so a page never walks private
-- annotations by other creators.
CREATE INDEX margin_annotations_private_page
  ON margin_annotations (site, document, visibility, creator, created, id);

-- Anonymous proposal pages must also lead with visibility: putting motivation
-- first would make the engine walk private editing rows to fill the page.
CREATE INDEX margin_annotations_public_proposal_page
  ON margin_annotations (site, document, visibility, motivation, created, id);

CREATE INDEX margin_annotations_private_proposal_page
  ON margin_annotations (site, document, visibility, creator, motivation, created, id);

CREATE INDEX margin_annotations_owner
  ON margin_annotations (creator, site, document);

CREATE INDEX margin_annotations_parent
  ON margin_annotations (parent_id);

-- A child may point only to a parent in its own tenant that its creator can
-- read. These checks are atomic with the write, including a concurrent parent
-- visibility change between a route's precheck and its INSERT/UPDATE.
CREATE TRIGGER margin_annotations_parent_visible_insert
BEFORE INSERT ON margin_annotations
WHEN NEW.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM margin_annotations AS parent
    WHERE parent.id = NEW.parent_id
      AND parent.site = NEW.site AND parent.document = NEW.document
      AND (
        parent.visibility = 'public'
        OR (
          parent.visibility = 'private'
          AND NEW.visibility = 'private'
          AND parent.creator = NEW.creator
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'MARGIN_PARENT_VISIBILITY_CONFLICT');
END;

CREATE TRIGGER margin_annotations_parent_visible_update
BEFORE UPDATE OF parent_id, visibility, creator, site, document ON margin_annotations
WHEN NEW.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM margin_annotations AS parent
    WHERE parent.id = NEW.parent_id
      AND parent.site = NEW.site AND parent.document = NEW.document
      AND (
        parent.visibility = 'public'
        OR (
          parent.visibility = 'private'
          AND NEW.visibility = 'private'
          AND parent.creator = NEW.creator
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'MARGIN_PARENT_VISIBILITY_CONFLICT');
END;

-- A parent's owner cannot hide it from a public reply's readers or from an
-- other-owner private reply's creator. The child index makes this a seek.
CREATE TRIGGER margin_annotations_parent_downgrade
BEFORE UPDATE OF visibility, creator, site, document ON margin_annotations
WHEN EXISTS (
  SELECT 1 FROM margin_annotations AS child
  WHERE child.parent_id = OLD.id
    AND (
      child.site <> NEW.site OR child.document <> NEW.document
      OR (NEW.visibility = 'private'
        AND (child.visibility = 'public' OR child.creator <> NEW.creator))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'MARGIN_VISIBLE_REPLIES_CONFLICT');
END;

-- Preferences are global per user, not per site: success criterion 5 asks for
-- one default visibility per person, and changing it never rewrites rows in
-- margin_annotations.
CREATE TABLE margin_prefs (
  creator            TEXT PRIMARY KEY,
  default_visibility TEXT NOT NULL CHECK (default_visibility IN ('private', 'public')),
  created            TEXT NOT NULL,
  modified           TEXT NOT NULL
);
