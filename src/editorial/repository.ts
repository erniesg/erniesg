/**
 * The storage seam of the durable editorial store.
 *
 * It is the same shape as `src/worker/margin/repository.ts`: the writer and
 * the reader depend on this interface and never on D1, so the store can be
 * swapped for another implementation — or for a test double — without either
 * of them changing.
 *
 * ## The three rules the seam carries
 *
 * 1. **Records are immutable.** Nothing in this interface edits a record.
 *    The only mutable thing in the store is the materialised `state` column
 *    of an aggregate, and it moves only through `append`, in the same
 *    transaction as the append it belongs to.
 * 2. **The write is one transaction.** `append` writes the record, the
 *    aggregate's state change and the idempotency receipt together, and it
 *    refuses rather than writing half of them.
 * 3. **The reader never sees a half-written write.** Every read goes
 *    through committed rows, and the store's unit of visibility is the
 *    transaction.
 */
import type {
  EditorialRecord,
  EditorialRecordKind,
} from './records'
import type { EditorialAggregateKind } from './queries'

export type { EditorialAggregateKind } from './queries'

/** The durable result of a keyed submission. */
export type EditorialReceipt = {
  /** The record's identity digest: the fingerprint of the submission. */
  fingerprint: string
  /** The record the key produced. */
  recordId: string
  /** When the receipt was written. */
  created: string
}

/** The scope of an idempotency receipt. */
export type EditorialRequestKey = {
  /** The submitting actor. One caller's key never collides with another's. */
  actor: string
  /** The kind of record the key was used for. */
  recordKind: EditorialRecordKind
  /** The caller's own key. */
  requestKey: string
}

/**
 * The compare-and-swap of an aggregate's materialised state.
 *
 * `expected` is the state the writer read and decided in. Zero changed rows
 * means somebody else moved first.
 */
export type EditorialAggregateTransition = {
  kind: EditorialAggregateKind
  id: string
  expected: string
  next: string
}

/** One append: the record, the state change it belongs to, the receipt. */
export type EditorialAppendInput = {
  record: EditorialRecord
  /**
   * The state change this append belongs to.
   *
   * When it is there, the record's insert is guarded by the aggregate's
   * expected state, so the record and the state change commit together or
   * not at all. When it is absent, the record creates its own aggregate
   * (a revision, a candidate) and there is nothing to swap.
   */
  transition?: EditorialAggregateTransition
  /**
   * The materialised state the row is created with.
   *
   * It is for the **backfill**, which restores history rather than
   * performing a transition: a revision that was approved before the cutover
   * is restored as `revision-approved`, not as `revision-proposed`. A write
   * that performs a transition leaves it alone, because the transition's
   * `next` is the state the row must hold.
   */
  initialState?: string
  /** The idempotency receipt, when the caller supplied a key. */
  receipt?: {
    actor: string
    recordKind: EditorialRecordKind
    requestKey: string
    fingerprint: string
    created: string
  }
}

/** The ways the store refuses a write. */
export const EDITORIAL_STORE_REFUSALS = [
  'cas_conflict',
  'idempotency_key_reused',
  'target_already_released',
  'record_already_exists',
  'editorial_store_unavailable',
] as const
export type EditorialStoreRefusal = (typeof EDITORIAL_STORE_REFUSALS)[number]

/** The outcome of one append. */
export type EditorialAppendOutcome =
  | { ok: true; written: true }
  | { ok: false; refusal: { code: EditorialStoreRefusal; message: string } }

/**
 * How a reader consults the two sources.
 *
 * - `expanded` — the store first, the legacy source second. This is the
 *   reader of §8.2: it exists from the day the store does, so the fallback
 *   is always there and always correct.
 * - `store-only` — the narrowed reader. It is the act of activation, and it
 *   is a separate, explicitly authorised one.
 * - `legacy-only` — the rolled-back reader. The cutover was undone, so the
 *   store is not consulted at all.
 */
export type EditorialReadMode = 'expanded' | 'store-only' | 'legacy-only'

/** The durable state of the cutover switch. */
export type EditorialSwitchState = {
  /** When the cutover happened. `null` before it. */
  switchedAt: string | null
  /** When the cutover was undone. `null` unless it was. */
  rolledBackAt: string | null
}

/**
 * The read mode a switch state implies.
 *
 * A rollback wins over a switch: a switch that was undone is not in force,
 * whatever its timestamp says.
 */
export function readModeOf(state: EditorialSwitchState): EditorialReadMode {
  if (state.rolledBackAt !== null) return 'legacy-only'
  if (state.switchedAt !== null) return 'store-only'
  return 'expanded'
}

/** The switch state of a store that has never been switched. */
export const INITIAL_SWITCH_STATE: EditorialSwitchState = {
  switchedAt: null,
  rolledBackAt: null,
}

/**
 * The store the editorial writer and reader talk to.
 *
 * Every method is async, because the store is a network database in
 * production and a file in the tests, and the two must not differ in shape.
 */
export interface EditorialRepository {
  /** Every row of one kind, in id order. */
  listRecords(kind: EditorialRecordKind): Promise<EditorialRecord[]>

  /** One row by its content-addressed id, or `null`. */
  findRecord(
    kind: EditorialRecordKind,
    id: string,
  ): Promise<EditorialRecord | null>

  /** The materialised state of one aggregate row, or `null` when absent. */
  readAggregateState(
    kind: EditorialAggregateKind,
    id: string,
  ): Promise<string | null>

  /** The receipt of a keyed submission, or `null`. */
  findReceipt(key: EditorialRequestKey): Promise<EditorialReceipt | null>

  /**
   * Append a record, its state change and its receipt, in one transaction.
   *
   * It refuses rather than writing half of them: a lost compare-and-swap
   * writes nothing at all.
   */
  append(input: EditorialAppendInput): Promise<EditorialAppendOutcome>

  /** The durable state of the cutover switch. */
  readSwitchState(): Promise<EditorialSwitchState>

  /** The write of the cutover switch's state. */
  writeSwitchState(state: EditorialSwitchState): Promise<void>

  /** The backfill's cursor, or `null` when the backfill has not started. */
  readBackfillProgress(name: string): Promise<string | null>

  /** The write of the backfill's cursor. */
  writeBackfillProgress(name: string, cursor: string | null): Promise<void>
}
