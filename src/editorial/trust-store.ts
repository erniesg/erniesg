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
 * is still detected. The epoch alone would not be enough.
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
  insertTrustEventQuery,
  selectTrustStateQuery,
  updateTrustStateQuery,
  type Query,
} from './queries'
import {
  EMPTY_PRODUCER_TRUST_STATE,
  type AcceptedProducerEvent,
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
   */
  async read(): Promise<ProducerTrustState> {
    const row = await this.statement(selectTrustStateQuery()).first<{
      highest_accepted_epoch?: number
      event_count?: number
    }>()
    if (!row) return EMPTY_PRODUCER_TRUST_STATE
    const events = await this.statement({
      sql: 'SELECT event_id, digest FROM editorial_trust_events ORDER BY rowid ASC',
      params: [],
    }).all<{ event_id?: string; digest?: string }>()
    const acceptedEvents: AcceptedProducerEvent[] = (events.results ?? []).map(
      (event) => ({
        eventId: String(event.event_id),
        digest: String(event.digest),
      }),
    )
    return {
      highestAcceptedEpoch: Number(row.highest_accepted_epoch ?? -1),
      acceptedEvents,
    }
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

    const expectedCount = expected.acceptedEvents.length
    const nextCount = next.acceptedEvents.length
    const added = next.acceptedEvents[nextCount - 1]
    if (added === undefined) return false

    const statements: D1PreparedStatement[] = [
      this.statement(
        insertTrustEventQuery({
          eventId: added.eventId,
          digest: added.digest,
          acceptedAt: new Date().toISOString(),
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
          updatedAt: new Date().toISOString(),
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
