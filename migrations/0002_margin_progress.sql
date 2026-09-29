-- A signed-in reader's progress through a book: which exercises and challenges
-- they solved, and the code they last left in each editor.
--
-- One row per (reader, site, book, item). `item` is a node or exercise id as the
-- book writes it. Rows are private to `creator`, the same principal key
-- margin_annotations uses, and no statement reads another reader's rows.
--
-- Merging lives in the upsert, not in application code: `solved` only ever
-- goes from 0 to 1, `solved_at` keeps the earliest known time, and a draft is
-- replaced only by a newer one. A client that knows less than the server can
-- therefore send what it has without losing anything.
--
-- `solved` is separate from `solved_at` because a solve can be known without
-- its time: the local preview's older progress files are a bare list of ids.
CREATE TABLE margin_progress (
  creator       TEXT NOT NULL,
  site          TEXT NOT NULL,
  book          TEXT NOT NULL,
  item          TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 128),
  solved        INTEGER NOT NULL DEFAULT 0 CHECK (solved IN (0, 1)),
  solved_at     TEXT,
  draft         TEXT CHECK (draft IS NULL OR length(draft) <= 20000),
  draft_updated TEXT,
  modified      TEXT NOT NULL,
  PRIMARY KEY (creator, site, book, item),
  CHECK ((draft IS NULL) = (draft_updated IS NULL)),
  CHECK (solved = 1 OR solved_at IS NULL)
);
