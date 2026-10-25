import { describe, expect, it } from 'vitest'

import { D1EditorialRepository } from './d1-repository'
import { createExpandedReader } from './expanded-reader'
import { staticLegacySource } from './legacy-source'
import {
  EDITORIAL_BACKFILL_ORDER,
  backfillInitialStates,
  orderedBackfillRecords,
  runEditorialBackfill,
} from './migration'
import { openEditorialFixture } from './sqlite-fixture'
import { releaseChainFixture } from './store-fixtures'
import type { EditorialRecord } from './records'

const BACKFILL = 'editorial-cutover'

/** The pre-switch record set: one published release and everything it binds. */
function legacyRecords(): EditorialRecord[] {
  const chain = releaseChainFixture()
  return [
    chain.revision,
    chain.decision,
    chain.candidate,
    ...chain.validations,
    chain.approval,
    chain.release,
  ]
}

/**
 * The migration, the backfill and the expanded reader.
 *
 * The property is that the reader is correct **while** the backfill runs:
 * a target is served either the pre-migration record or the migrated one,
 * and never a mixture of the two.
 */
describe('the migration, the backfill and the expanded reader', () => {
  it('copies the legacy records in dependency order', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const source = staticLegacySource(legacyRecords())

      const result = await runEditorialBackfill({
        source,
        repository,
        name: BACKFILL,
      })
      expect(result.complete).toBe(true)
      expect(result.migrated).toBe(legacyRecords().length)

      const records = orderedBackfillRecords(await source.listRecords())
      const kinds = records.map((record) => record.kind)
      const ranks = kinds.map((kind) => EDITORIAL_BACKFILL_ORDER.indexOf(kind))
      expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
      // The release is last, so a reader that finds it finds its chain.
      expect(kinds[kinds.length - 1]).toBe('release')
    } finally {
      fixture.cleanup()
    }
  })

  it('restores the materialised states of the history', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const records = legacyRecords()
      const source = staticLegacySource(records)

      await runEditorialBackfill({ source, repository, name: BACKFILL })

      const chain = releaseChainFixture()
      expect(
        await repository.readAggregateState('revision', chain.revision.id),
      ).toBe('revision-approved')
      expect(
        await repository.readAggregateState('candidate', chain.candidate.id),
      ).toBe('candidate-released')
      expect(
        await repository.readAggregateState('release', chain.release.id),
      ).toBe('release-released')
    } finally {
      fixture.cleanup()
    }
  })

  it('can be interrupted and resumed', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const source = staticLegacySource(legacyRecords())

      const interrupted = await runEditorialBackfill({
        source,
        repository,
        name: BACKFILL,
        batchSize: 2,
        maxBatches: 1,
      })
      expect(interrupted.complete).toBe(false)
      expect(interrupted.migrated).toBe(2)
      expect(interrupted.cursor).not.toBeNull()

      // The cursor is durable: it survives the connection.
      const later = new D1EditorialRepository(fixture.reopen())
      expect(await later.readBackfillProgress(BACKFILL)).toBe(
        interrupted.cursor,
      )
      expect(await later.listRecords('revision')).toHaveLength(1)
      expect(await later.listRecords('release')).toHaveLength(0)

      const resumed = await runEditorialBackfill({
        source,
        repository: later,
        name: BACKFILL,
        batchSize: 2,
      })
      expect(resumed.complete).toBe(true)
      expect(resumed.migrated).toBe(legacyRecords().length - 2)
      expect(await later.listRecords('release')).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  it('serves the pre-migration record while the backfill is in progress', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const source = staticLegacySource(legacyRecords())
      const reader = createExpandedReader({ repository, source })
      const chain = releaseChainFixture()

      // Before the backfill: the legacy source answers.
      const before = await reader.currentReleaseForTarget(
        chain.release.target.id,
      )
      expect(before.source).toBe('legacy')
      expect(before.release?.id).toBe(chain.release.id)

      // Half way through the backfill: the release has not been copied yet,
      // so the legacy source still answers, and the record it answers with
      // is the same record.
      await runEditorialBackfill({
        source,
        repository,
        name: BACKFILL,
        batchSize: 3,
        maxBatches: 1,
      })
      const during = await reader.currentReleaseForTarget(
        chain.release.target.id,
      )
      expect(during.source).toBe('legacy')
      expect(during.release).toStrictEqual(before.release)

      // After the backfill: the store answers, with the same record.
      await runEditorialBackfill({ source, repository, name: BACKFILL })
      const after = await reader.currentReleaseForTarget(
        chain.release.target.id,
      )
      expect(after.source).toBe('store')
      expect(after.release).toStrictEqual(before.release)
    } finally {
      fixture.cleanup()
    }
  })

  it('never consults the legacy source for a target the store holds', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const source = staticLegacySource(legacyRecords())
      const reader = createExpandedReader({ repository, source })
      const chain = releaseChainFixture()

      await runEditorialBackfill({ source, repository, name: BACKFILL })
      const answer = await reader.currentReleaseForTarget(
        chain.release.target.id,
      )
      expect(answer.source).toBe('store')

      // A target the store does not hold still falls back.
      const other = await reader.currentReleaseForTarget('no-such-target')
      expect(other.release).toBeNull()
      expect(other.source).toBeNull()
    } finally {
      fixture.cleanup()
    }
  })

  it('projects the state of the legacy records the same way the store does', () => {
    const records = legacyRecords()
    const states = backfillInitialStates(records)
    const chain = releaseChainFixture()
    expect(states.get(chain.revision.id)).toBe('revision-approved')
    expect(states.get(chain.candidate.id)).toBe('candidate-released')
    expect(states.get(chain.release.id)).toBe('release-released')
  })
})
