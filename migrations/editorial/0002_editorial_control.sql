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
--
--    The two are not the same number on purpose. `event_count` is the
--    number of events the consumer has accepted **ever**, and it is what
--    says "the state moved"; the ledger is **pruned** to the policy's
--    freshness window, so the ledger and the count drift apart, and the
--    count is what detects the change.
--
--    `accepted_at` is the **consumer's** acceptance time, on the same clock
--    the freshness bound is measured on, because the ledger's retention is
--    measured against it. The read of the ledger is bounded by that column
--    (`accepted_at >= ?`) and the prune deletes by it (`accepted_at < ?`),
--    so the index below is what makes the bounded read a range scan rather
--    than a scan of the whole ledger.
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

-- The ledger is read inside the freshness window and pruned to it, so the
-- read is a range scan over the acceptance times rather than a scan of
-- every pair the store has ever accepted.
CREATE INDEX IF NOT EXISTS editorial_trust_events_accepted_at
  ON editorial_trust_events (accepted_at);

CREATE TABLE IF NOT EXISTS editorial_switch_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  switched_at   TEXT,
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS editorial_backfill_progress (
  name   TEXT PRIMARY KEY,
  cursor TEXT
);
