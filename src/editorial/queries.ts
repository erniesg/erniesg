/**
 * Every SQL statement the editorial store runs, as pure `(sql, params)`
 * values.
 *
 * It is the same shape as `src/worker/margin/queries.ts`: the statements
 * live apart from the D1 client so a test can run the *exact* statement a
 * write would run, against a real SQLite database, and count the rows it
 * touched. The compare-and-swap proof depends on that — asserting that a
 * stale expected version writes nothing is only worth anything if a genuine
 * SQL engine is the one deciding.
 *
 * ## The three shapes of statement here
 *
 * - **Reads.** `SELECT`. A read is never scoped by a caller-supplied
 *   predicate that could widen it; the record ids and the target ids are the
 *   only parameters.
 * - **The guarded insert.** Every record row is written by an `INSERT ...
 *   SELECT ... WHERE EXISTS (...)`, and the `EXISTS` sub-select is the
 *   compare-and-swap guard: the aggregate row must still be in the state the
 *   writer decided in. The guard lives in the *same statement* as the write,
 *   which is the app's existing idiom (`AND withdrawn_at IS NULL` in
 *   `updateAnnotationQuery`), so a state change between the read and the
 *   write wins over the write.
 * - **The state update.** The materialised `state` column, guarded by the
 *   same expected state.
 *
 * ## The order of the batch
 *
 * The guarded insert comes **first** and the state update **second**. The
 * insert's guard reads the aggregate's *old* state; if the update ran first,
 * the state would already have moved and the insert would find nothing to
 * match. The receipt comes last and is guarded by the record's own
 * existence, so a receipt is never written for a record that was not.
 */
import type { EditorialRecordKind } from './records'

/** A statement and its parameters. */
export type Query = { sql: string; params: unknown[] }

/** The table each record kind lives in. */
export const EDITORIAL_RECORD_TABLES: Record<EditorialRecordKind, string> = {
  revision: 'editorial_revisions',
  decision: 'editorial_decisions',
  candidate: 'editorial_candidates',
  validation: 'editorial_validations',
  approval: 'editorial_approvals',
  release: 'editorial_releases',
  supersession: 'editorial_supersessions',
}

/**
 * The aggregates whose materialised state is swapped.
 *
 * A revision, a candidate and a release have a `state` column; a decision, a
 * validation, an approval and a supersession do not, because their existence
 * *is* their effect.
 */
export const EDITORIAL_AGGREGATE_TABLES = {
  revision: 'editorial_revisions',
  candidate: 'editorial_candidates',
  release: 'editorial_releases',
} as const

export type EditorialAggregateKind = keyof typeof EDITORIAL_AGGREGATE_TABLES

/** The state a record row is created with. */
export const EDITORIAL_INITIAL_STATES: Record<
  EditorialAggregateKind,
  string
> = {
  revision: 'revision-proposed',
  candidate: 'candidate-assembled',
  release: 'release-released',
}

/* ------------------------------------------------------------------- reads */

/** Every row of one kind, in id order. */
export function selectRecordsQuery(
  kind: EditorialRecordKind,
  table = EDITORIAL_RECORD_TABLES[kind],
): Query {
  return {
    sql: `SELECT * FROM ${table} ORDER BY id ASC`,
    params: [],
  }
}

/** One row, by its content-addressed id. */
export function selectRecordQuery(
  kind: EditorialRecordKind,
  id: string,
  table = EDITORIAL_RECORD_TABLES[kind],
): Query {
  return {
    sql: `SELECT * FROM ${table} WHERE id = ? LIMIT 1`,
    params: [id],
  }
}

/** The materialised state of one aggregate row. */
export function selectAggregateStateQuery(
  kind: EditorialAggregateKind,
  id: string,
): Query {
  return {
    sql: `SELECT state FROM ${EDITORIAL_AGGREGATE_TABLES[kind]} WHERE id = ? LIMIT 1`,
    params: [id],
  }
}

/**
 * The current release of one target.
 *
 * The filter is in SQL, not in the caller: a reader that fetched every
 * release and picked one in JavaScript could pick the wrong one after a
 * supersession, and the "one current release per target" question deserves
 * one answer from one statement.
 */
export function selectCurrentReleaseQuery(targetId: string): Query {
  return {
    sql: `SELECT * FROM editorial_releases WHERE target_id = ? AND state = 'release-released' LIMIT 1`,
    params: [targetId],
  }
}

/* ----------------------------------------------------------------- writes */

/**
 * The guarded insert of one record row.
 *
 * `values` are the column values in `columns` order. The guard, when there
 * is one, is the aggregate's expected state; without a guard the statement
 * is a plain insert.
 */
export function insertRecordQuery(input: {
  table: string
  columns: readonly string[]
  values: readonly unknown[]
  guard?: { kind: EditorialAggregateKind; id: string; expected: string }
}): Query {
  const placeholders = new Array(input.columns.length).fill('?').join(', ')
  const columnList = input.columns.join(', ')
  if (!input.guard) {
    return {
      sql: `INSERT INTO ${input.table} (${columnList}) VALUES (${placeholders})`,
      params: [...input.values],
    }
  }
  const aggregate = EDITORIAL_AGGREGATE_TABLES[input.guard.kind]
  return {
    sql: `INSERT INTO ${input.table} (${columnList})
SELECT ${placeholders}
WHERE EXISTS (
  SELECT 1 FROM ${aggregate} WHERE id = ? AND state = ?
)`,
    params: [
      ...input.values,
      input.guard.id,
      input.guard.expected,
    ],
  }
}

/**
 * The compare-and-swap of an aggregate's materialised state.
 *
 * Zero changed rows means somebody else moved first: the caller re-reads
 * and re-decides.
 */
export function updateAggregateStateQuery(input: {
  kind: EditorialAggregateKind
  id: string
  expected: string
  next: string
}): Query {
  return {
    sql: `UPDATE ${EDITORIAL_AGGREGATE_TABLES[input.kind]} SET state = ? WHERE id = ? AND state = ?`,
    params: [input.next, input.id, input.expected],
  }
}

/** The receipt of a keyed submission. */
export function selectReceiptQuery(input: {
  actor: string
  recordKind: EditorialRecordKind
  requestKey: string
}): Query {
  return {
    sql: `SELECT fingerprint, record_id, created FROM editorial_idempotency_receipts
WHERE actor = ? AND record_kind = ? AND request_key = ? LIMIT 1`,
    params: [input.actor, input.recordKind, input.requestKey],
  }
}

/**
 * The insert of a receipt, guarded by the record's own existence.
 *
 * The guard is what makes "the receipt and the record commit together" true
 * in the other direction too: when the guarded insert of the record wrote
 * nothing, this writes nothing, so a key is never receipted for a record
 * that was not stored.
 */
export function insertReceiptQuery(input: {
  actor: string
  recordKind: EditorialRecordKind
  requestKey: string
  fingerprint: string
  recordId: string
  created: string
  table: string
}): Query {
  return {
    sql: `INSERT INTO editorial_idempotency_receipts
(actor, record_kind, request_key, fingerprint, record_id, created)
SELECT ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM ${input.table} WHERE id = ?)`,
    params: [
      input.actor,
      input.recordKind,
      input.requestKey,
      input.fingerprint,
      input.recordId,
      input.created,
      input.recordId,
    ],
  }
}

/* ----------------------------------------------------------- control tables */

/** The durable state of the cutover switch. */
export function selectSwitchStateQuery(): Query {
  return {
    sql: `SELECT switched_at, rolled_back_at FROM editorial_switch_state WHERE id = 1 LIMIT 1`,
    params: [],
  }
}

/** The write of the cutover switch's state. */
export function upsertSwitchStateQuery(input: {
  switchedAt: string | null
  rolledBackAt: string | null
}): Query {
  return {
    sql: `INSERT INTO editorial_switch_state (id, switched_at, rolled_back_at)
VALUES (1, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  switched_at = excluded.switched_at,
  rolled_back_at = excluded.rolled_back_at`,
    params: [input.switchedAt, input.rolledBackAt],
  }
}

/** The backfill's cursor. */
export function selectBackfillProgressQuery(name: string): Query {
  return {
    sql: `SELECT cursor FROM editorial_backfill_progress WHERE name = ? LIMIT 1`,
    params: [name],
  }
}

/** The write of the backfill's cursor. */
export function upsertBackfillProgressQuery(input: {
  name: string
  cursor: string | null
}): Query {
  return {
    sql: `INSERT INTO editorial_backfill_progress (name, cursor) VALUES (?, ?)
ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor`,
    params: [input.name, input.cursor],
  }
}

/* --------------------------------------------------------------- trust state */

/** The consumer's durable trust state. */
export function selectTrustStateQuery(): Query {
  return {
    sql: `SELECT highest_accepted_epoch, event_count FROM editorial_trust_state WHERE id = 1 LIMIT 1`,
    params: [],
  }
}

/**
 * The insert of an accepted producer event, guarded by the trust state's
 * *old* values.
 *
 * It comes before the state update in the batch, so the guard still matches
 * when the update has not run yet. If the state moved, neither the insert nor
 * the update happens.
 */
export function insertTrustEventQuery(input: {
  eventId: string
  digest: string
  acceptedAt: string
  expectedEpoch: number
  expectedCount: number
}): Query {
  return {
    sql: `INSERT INTO editorial_trust_events (event_id, digest, accepted_at)
SELECT ?, ?, ?
WHERE EXISTS (
  SELECT 1 FROM editorial_trust_state
  WHERE id = 1 AND highest_accepted_epoch = ? AND event_count = ?
)`,
    params: [
      input.eventId,
      input.digest,
      input.acceptedAt,
      input.expectedEpoch,
      input.expectedCount,
    ],
  }
}

/**
 * The compare-and-advance of the trust state.
 *
 * The guard covers the epoch **and** the number of accepted events, so a
 * change that does not move the epoch — a second event at the same epoch —
 * is still detected.
 */
export function updateTrustStateQuery(input: {
  expectedEpoch: number
  expectedCount: number
  nextEpoch: number
  nextCount: number
  updatedAt: string
}): Query {
  return {
    sql: `UPDATE editorial_trust_state
SET highest_accepted_epoch = ?, event_count = ?, updated = ?
WHERE id = 1 AND highest_accepted_epoch = ? AND event_count = ?`,
    params: [
      input.nextEpoch,
      input.nextCount,
      input.updatedAt,
      input.expectedEpoch,
      input.expectedCount,
    ],
  }
}
