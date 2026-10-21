/**
 * The durable trust state of a consumer, over the editorial store.
 *
 * E05b's `trust-policy.ts` states the contract and hands the durable store
 * to this job: "The durable store (E05c) must implement the same contract
 * with a conditional update, the way the margin service's CAS does."
 *
 * ## The compare-and-advance
 *
 * The state is the pair (highest accepted epoch, accepted events). The
 * advance is a **conditional update**: it happens only when the state is
 * still the one the caller read. Two consumers that race lose one of the
 * two advances, and the loser refuses rather than merges — which is the
 * whole anti-rollback property, because a rollback that two consumers both
 * accept is a rollback that is not detected.
 *
 * The guard covers the epoch **and** the number of accepted events, so a
 * change that does not move the epoch — a second event at the same epoch —
 * is still detected. The epoch alone would not be enough. The count is the
 * number of events the consumer has accepted **ever**, not the number of
 * rows the ledger currently holds: the ledger is pruned to the freshness
 * window (§ the retention below), so the two drift apart on purpose, and
 * the count is what says "the state moved".
 *
 * ## The retention of the ledger
 *
 * The replay ledger is **pruned** to the freshness window, and the read of
 * it is **bounded** by the same window. A ledger that is never pruned grows
 * for the life of the store, and a read that is not bounded reads every pair
 * the store has ever accepted, on the hot path of every verification.
 *
 * The window is the freshness bound plus the future skew, and it is
 * computed on the **consumer's** clock: the ledger's `accepted_at` column
 * holds the consumer's acceptance time, so the two are the same clock. A
 * pair older than the window belongs to a record that can no longer be
 * fresh, and a record that is not fresh is refused before the ledger is
 * consulted — so pruning it cannot weaken a refusal.
 *
 * ## The order inside the batch
 *
 * The event row is inserted **first**, guarded by the *old* epoch and count,
 * and the state row is updated **second**, guarded by the same old values.
 * If the state moved between the read and the write, neither statement
 * matches and neither happens: the accepted event is not recorded and the
 * state does not advance.
 */
import type { D1Database, D1PreparedStatement } from './d1'
import {
  deleteTrustEventsQuery,
  insertTrustEventQuery,
  selectTrustEventsQuery,
  selectTrustStateQuery,
  updateTrustStateQuery,
  type Query,
} from './queries'
import {
  EMPTY_PRODUCER_TRUST_STATE,
  type AcceptedProducerEvent,
  type ProducerTrustLedgerWindow,
  type ProducerTrustState,
  type ProducerTrustStore,
} from './trust-policy'

/** The trust store over the editorial database. */
export class D1ProducerTrustStore implements ProducerTrustStore {
  constructor(private readonly database: D1Database) {}

  private statement({ sql, params }: Query): D1PreparedStatement {
    const prepared = this.database.prepare(sql)
    return params.length > 0 ? prepared.bind(...params) : prepared
  }

  /**
   * The current state.
   *
   * It throws when the state cannot be established, because the consumer
   * that cannot read its trust state must refuse rather than assume.
   *
   * The ledger is read **inside the window**: the pairs older than it
   * belong to records that can no longer be fresh, so the read does not
   * fetch them and the read does not grow with the life of the store.
   */
  async read(window: ProducerTrustLedgerWindow): Promise<ProducerTrustState> {
    const row = await this.statement(selectTrustStateQuery()).first<{
      highest_accepted_epoch?: number
      event_count?: number
    }>()
    if (!row) return EMPTY_PRODUCER_TRUST_STATE
    const events = await this.statement(
      selectTrustEventsQuery({ since: window.since }),
    ).all<{ event_id?: string; digest?: string; accepted_at?: string }>()
    const acceptedEvents: AcceptedProducerEvent[] = (events.results ?? []).map(
      (event) => ({
        eventId: String(event.event_id),
        digest: String(event.digest),
        acceptedAt: String(event.accepted_at),
      }),
    )
    return {
      highestAcceptedEpoch: Number(row.highest_accepted_epoch ?? -1),
      acceptedEventCount: Number(row.event_count ?? 0),
      acceptedEvents,
    }
  }

  /**
   * Prune the ledger to the window.
   *
   * It removes the pairs the window has made irrelevant, and nothing else:
   * a pair whose record is still fresh is inside the window, because the
   * window is the freshness bound plus the future skew, and a record may
   * have been issued up to the skew in the future of the consumer's clock
   * when it was accepted.
   *
   * The prune does not touch the trust state: the state says how many
   * events the consumer has accepted, and that number does not change when
   * the ledger is trimmed.
   */
  async prune(window: ProducerTrustLedgerWindow): Promise<void> {
    await this.statement(
      deleteTrustEventsQuery({ before: window.since }),
    ).run()
  }

  /**
   * Advance the state from `expected` to `next`, or refuse.
   *
   * `false` when the state moved since it was read.
   */
  async compareAndAdvance(
    expected: ProducerTrustState,
    next: ProducerTrustState,
  ): Promise<boolean> {
    const batch = this.database.batch
    if (!batch) return false

    const expectedCount = expected.acceptedEventCount
    const nextCount = next.acceptedEventCount
    const added = next.acceptedEvents[next.acceptedEvents.length - 1]
    if (added === undefined) return false

    const statements: D1PreparedStatement[] = [
      this.statement(
        insertTrustEventQuery({
          eventId: added.eventId,
          digest: added.digest,
          acceptedAt: added.acceptedAt,
          expectedEpoch: expected.highestAcceptedEpoch,
          expectedCount,
        }),
      ),
      this.statement(
        updateTrustStateQuery({
          expectedEpoch: expected.highestAcceptedEpoch,
          expectedCount,
          nextEpoch: next.highestAcceptedEpoch,
          nextCount,
          updatedAt: added.acceptedAt,
        }),
      ),
    ]

    try {
      const results = await batch.call(this.database, statements)
      return (results[1]?.meta?.changes ?? 0) > 0
    } catch {
      // A duplicate (event id, digest) is a refusal, not a crash: the
      // consumer's replay ledger has already seen this event.
      return false
    }
  }
}
