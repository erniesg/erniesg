import { describe, expect, it } from 'vitest'

import {
  makeProducerTestKeys,
  producerRecordFixture,
  trustPolicyFixture,
  trustRootFixture,
  type ProducerTestKeys,
} from './producer-fixtures'
import { openEditorialFixture } from './sqlite-fixture'
import { D1ProducerTrustStore } from './trust-store'
import { verifyProducerRecord } from './trust-policy'

/**
 * The durable replay ledger.
 *
 * The ledger is the consumer's memory of what it has accepted: a pair that
 * is already in it is a replay, and a replay is a refusal. The ledger is
 * therefore pruned to the policy's freshness window — a pair whose record
 * can no longer be fresh can never be needed again — and the read of it is
 * bounded by the same window, so the read does not grow with the life of
 * the store.
 *
 * The property that matters is the one a prune can break: **a pair that is
 * still inside the window must survive the prune**, because that pair is
 * what refuses the replay.
 */
const FRESHNESS_SECONDS = 3_600
const SKEW_SECONDS = 300

/** The bounds the policy under test carries. */
const BOUNDS = {
  maxRecordAgeSeconds: FRESHNESS_SECONDS,
  maxValiditySeconds: 604_800,
  maxFutureSkewSeconds: SKEW_SECONDS,
  maxRotationOverlapSeconds: 86_400,
} as const

/** The window the ledger is pruned to: the freshness bound plus the skew. */
const WINDOW_SECONDS = FRESHNESS_SECONDS + SKEW_SECONDS

/** A clock `seconds` after `from`. */
function after(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000)
}

async function policyFor(keys: ProducerTestKeys, issuedAt: Date) {
  return trustPolicyFixture({
    keys,
    overrides: {
      bounds: { ...BOUNDS },
      issuedAt: issuedAt.toISOString(),
      expiresAt: after(issuedAt, 86_400).toISOString(),
    },
  })
}

/**
 * The rows the ledger holds, straight out of the database.
 *
 * It reads through the raw connection, not through the fixture's `query`,
 * so the test's own statement is not recorded among the statements the
 * store ran.
 */
function ledgerRows(database: {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}): Record<string, unknown>[] {
  return database
    .prepare(
      'SELECT event_id, digest, accepted_at FROM editorial_trust_events ORDER BY rowid ASC',
    )
    .all() as Record<string, unknown>[]
}

describe('the durable replay ledger', () => {
  it('prunes the ledger to the freshness window and bounds the read', async () => {
    const fixture = openEditorialFixture()
    try {
      const keys = await makeProducerTestKeys()
      const store = new D1ProducerTrustStore(fixture.database)
      const root = await trustRootFixture(keys)
      const now = new Date()

      // The first record is accepted inside the window.
      const first = await producerRecordFixture({
        keys,
        overrides: {
          eventId: 'event-1',
          issuedAt: now.toISOString(),
          expiresAt: after(now, 80_000).toISOString(),
        },
      })
      const firstOutcome = await verifyProducerRecord({
        record: first,
        policy: await policyFor(keys, now),
        root,
        store,
        now,
      })
      expect(firstOutcome.ok).toBe(true)
      expect(ledgerRows(fixture.database.raw())).toHaveLength(1)

      // A second record, accepted well inside the window.
      const later = after(now, 1_000)
      const second = await producerRecordFixture({
        keys,
        overrides: {
          eventId: 'event-2',
          issuedAt: later.toISOString(),
          expiresAt: after(later, 80_000).toISOString(),
        },
      })
      const secondOutcome = await verifyProducerRecord({
        record: second,
        policy: await policyFor(keys, now),
        root,
        store,
        now: later,
      })
      expect(secondOutcome.ok).toBe(true)
      expect(ledgerRows(fixture.database.raw())).toHaveLength(2)

      // Past the window, the first pair is pruned and the second is not.
      const beyond = after(now, WINDOW_SECONDS + 1)
      const third = await producerRecordFixture({
        keys,
        overrides: {
          eventId: 'event-3',
          issuedAt: beyond.toISOString(),
          expiresAt: after(beyond, 80_000).toISOString(),
        },
      })
      const thirdOutcome = await verifyProducerRecord({
        record: third,
        policy: await policyFor(keys, now),
        root,
        store,
        now: beyond,
      })
      expect(thirdOutcome.ok).toBe(true)

      const rows = ledgerRows(fixture.database.raw())
      expect(rows.map((row) => row.event_id)).toEqual(['event-2', 'event-3'])

      // The count is the number of events accepted **ever**: the prune
      // trims the ledger and does not touch it, so the count and the ledger
      // drift apart on purpose.
      const state = fixture.database
        .raw()
        .prepare(
          'SELECT highest_accepted_epoch, event_count FROM editorial_trust_state WHERE id = 1',
        )
        .all() as Record<string, unknown>[]
      expect(state[0]?.event_count).toBe(3)
      expect(state[0]?.highest_accepted_epoch).toBe(9)

      // The read of the ledger is bounded by the window.
      const reads = fixture.database
        .reads()
        .filter((entry) => entry.sql.includes('editorial_trust_events'))
      expect(reads.length).toBeGreaterThan(0)
      for (const read of reads) {
        expect(read.sql).toContain('accepted_at >= ?')
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('still refuses a replay of a record inside the window after a prune', async () => {
    const fixture = openEditorialFixture()
    try {
      const keys = await makeProducerTestKeys()
      const store = new D1ProducerTrustStore(fixture.database)
      const root = await trustRootFixture(keys)
      const now = new Date()
      const policy = await policyFor(keys, now)

      // The record that will age out of the window.
      const old = await producerRecordFixture({
        keys,
        overrides: {
          eventId: 'event-old',
          issuedAt: now.toISOString(),
          expiresAt: after(now, 80_000).toISOString(),
        },
      })
      expect(
        (
          await verifyProducerRecord({
            record: old,
            policy,
            root,
            store,
            now,
          })
        ).ok,
      ).toBe(true)

      // The record that is still inside the window.
      const inside = after(now, 1_000)
      const fresh = await producerRecordFixture({
        keys,
        overrides: {
          eventId: 'event-fresh',
          issuedAt: inside.toISOString(),
          expiresAt: after(inside, 80_000).toISOString(),
        },
      })
      expect(
        (
          await verifyProducerRecord({
            record: fresh,
            policy,
            root,
            store,
            now: inside,
          })
        ).ok,
      ).toBe(true)

      // Past the window, the old pair is pruned and the fresh one is not.
      const beyond = after(now, WINDOW_SECONDS + 1)
      const other = await producerRecordFixture({
        keys,
        overrides: {
          eventId: 'event-other',
          issuedAt: beyond.toISOString(),
          expiresAt: after(beyond, 80_000).toISOString(),
        },
      })
      expect(
        (
          await verifyProducerRecord({
            record: other,
            policy,
            root,
            store,
            now: beyond,
          })
        ).ok,
      ).toBe(true)
      expect(ledgerRows(fixture.database.raw()).map((row) => row.event_id)).toEqual([
        'event-fresh',
        'event-other',
      ])

      // The record inside the window is still refused as a replay: its pair
      // survived the prune.
      const replay = await verifyProducerRecord({
        record: fresh,
        policy,
        root,
        store,
        now: beyond,
      })
      expect(replay.ok).toBe(false)
      if (!replay.ok) {
        expect(replay.reason).toBe('producer_record_replayed')
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a record that is older than the freshness window before the ledger is consulted', async () => {
    const fixture = openEditorialFixture()
    try {
      const keys = await makeProducerTestKeys()
      const store = new D1ProducerTrustStore(fixture.database)
      const root = await trustRootFixture(keys)
      const now = new Date()
      const policy = await policyFor(keys, now)

      const record = await producerRecordFixture({
        keys,
        overrides: {
          eventId: 'event-1',
          issuedAt: now.toISOString(),
          expiresAt: after(now, 80_000).toISOString(),
        },
      })
      expect(
        (
          await verifyProducerRecord({ record, policy, root, store, now })
        ).ok,
      ).toBe(true)

      // Long past the freshness window: the record is refused, whatever the
      // ledger says.
      const stale = after(now, FRESHNESS_SECONDS + 1)
      const outcome = await verifyProducerRecord({
        record,
        policy,
        root,
        store,
        now: stale,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toBe('producer_record_not_fresh')
      }
    } finally {
      fixture.cleanup()
    }
  })
})
