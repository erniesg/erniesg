-- `GET /mine` (issue 073) lists one reader's own annotations under a path
-- prefix in `(document, created, id)` order, a page at a time. The owner index
-- from 0001 ends at `document`, so every page would sort all of the reader's
-- matching rows in a temporary B-tree before taking a handful. Ending the key
-- in `(created, id)` lets the range scan walk rows already in order and stop
-- at the page size. This migration only adds an index.
CREATE INDEX margin_annotations_owner_keyset
  ON margin_annotations (creator, site, document, created, id);
