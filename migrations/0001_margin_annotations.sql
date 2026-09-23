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

-- The collection is always read in `(created, id)` order and now in bounded
-- pages, so without a covering order this plan is `USE TEMP B-TREE FOR ORDER BY`:
-- every visible row sorted before `LIMIT` takes a handful. Paging bounds the
-- response and this is what bounds the work behind it.
CREATE INDEX margin_annotations_page
  ON margin_annotations (site, document, created, id);

-- Anonymous readers have no owner branch. Put the public predicate before the
-- keyset order so private rows are never scanned to fill a public page.
CREATE INDEX margin_annotations_public_page
  ON margin_annotations (site, document, visibility, created, id);

CREATE INDEX margin_annotations_owner
  ON margin_annotations (creator, site, document);

CREATE INDEX margin_annotations_parent
  ON margin_annotations (parent_id);

-- Preferences are global per user, not per site: success criterion 5 asks for
-- one default visibility per person, and changing it never rewrites rows in
-- margin_annotations.
CREATE TABLE margin_prefs (
  creator            TEXT PRIMARY KEY,
  default_visibility TEXT NOT NULL CHECK (default_visibility IN ('private', 'public')),
  created            TEXT NOT NULL,
  modified           TEXT NOT NULL
);
