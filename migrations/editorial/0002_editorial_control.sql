-- 0002: the control tables the store needs beside the records.
--
-- Forward-only, like every migration in this store: there is no down
-- migration, and a change to these tables is a later numbered file.
--
-- Three things live here, and none of them is a record:
--
--  - `editorial_trust_state` and `editorial_trust_events` are the durable
--    trust state of a consumer: the highest policy epoch it has accepted and
--    the (event id, digest) pairs it has accepted. The compare-and-advance
--    of that state is the store's second compare-and-swap, and it guards the
--    epoch **and** the event count, so a change that does not move the epoch
--    is still detected.
--  - `editorial_switch_state` is the durable state of the cutover switch:
--    when the cutover happened, and when it was undone. A rollback wins over
--    a switch, whatever the timestamps say.
--  - `editorial_backfill_progress` is the backfill's cursor. It is what
--    makes the backfill interruptible and resumable: an interrupted backfill
--    leaves a cursor, and the next run continues from it.

CREATE TABLE IF NOT EXISTS editorial_trust_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  highest_accepted_epoch INTEGER NOT NULL,
  event_count            INTEGER NOT NULL,
  updated                TEXT NOT NULL
);

-- The consumer's trust state starts empty: no epoch has been accepted, and
-- no event has been accepted.
--
-- The row exists from the start rather than being created by the first
-- advance, because the advance's guard is a conditional UPDATE: without a
-- row there is nothing to guard, and the first accepted event would be
-- recorded without the state that says so.
INSERT OR IGNORE INTO editorial_trust_state
  (id, highest_accepted_epoch, event_count, updated)
VALUES (1, -1, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS editorial_trust_events (
  event_id    TEXT NOT NULL,
  digest      TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (event_id, digest)
);

CREATE TABLE IF NOT EXISTS editorial_switch_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  switched_at   TEXT,
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS editorial_backfill_progress (
  name   TEXT PRIMARY KEY,
  cursor TEXT
);
