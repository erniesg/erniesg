import { describe, expect, it } from 'vitest'

import { D1EditorialRepository } from './d1-repository'
import {
  EDITORIAL_MIGRATION_FILES,
  appliedEditorialMigrations,
  applyEditorialMigrations,
} from './migration'
import { openEditorialFixture } from './sqlite-fixture'
import {
  approvalFixture,
  candidateFixture,
  decisionFixture,
  releaseFixture,
  revisionFixture,
  supersessionFixture,
  validationFixture,
} from './fixtures'
import { ARTIFACTS } from './fixtures'
import type { EditorialRelease } from './records'

/**
 * The storage adapter, against a durable fixture.
 *
 * The fixture is a **file**, not `:memory:`. A reader that opens a second
 * connection to the same file sees the committed rows, which is what
 * "durable" means, and it is the only way an assertion about durability is
 * worth anything.
 */
describe('the durable editorial store', () => {
  it('applies the numbered migrations once', () => {
    const fixture = openEditorialFixture()
    try {
      const applied = appliedEditorialMigrations(fixture.database.raw())
      expect(applied).toEqual([...EDITORIAL_MIGRATION_FILES])

      const again = applyEditorialMigrations(fixture.database.raw())
      expect(again).toEqual([])
      expect(appliedEditorialMigrations(fixture.database.raw())).toEqual([
        ...EDITORIAL_MIGRATION_FILES,
      ])
    } finally {
      fixture.cleanup()
    }
  })

  it('reads a record back exactly as it was written', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const revision = revisionFixture()

      const outcome = await repository.append({ record: revision })
      expect(outcome.ok).toBe(true)

      const read = await repository.findRecord('revision', revision.id)
      expect(read).toStrictEqual(revision)
    } finally {
      fixture.cleanup()
    }
  })

  it('is durable across connections', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const revision = revisionFixture()
      await repository.append({ record: revision })

      // A second connection to the same file.
      const second = new D1EditorialRepository(fixture.reopen())
      const read = await second.findRecord('revision', revision.id)
      expect(read).toStrictEqual(revision)
    } finally {
      fixture.cleanup()
    }
  })

  it('writes a record and its receipt together', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const revision = revisionFixture()

      await repository.append({
        record: revision,
        receipt: {
          actor: 'human:urn:margin:principal:editor',
          recordKind: 'revision',
          requestKey: 'key-1',
          fingerprint: 'f'.repeat(64),
          created: '2026-10-20T09:00:00.000Z',
        },
      })

      const receipt = await repository.findReceipt({
        actor: 'human:urn:margin:principal:editor',
        recordKind: 'revision',
        requestKey: 'key-1',
      })
      expect(receipt).not.toBeNull()
      expect(receipt?.recordId).toBe(revision.id)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a reused key and writes nothing', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const revision = revisionFixture()
      const other = revisionFixture({ documentSha256: 'b'.repeat(64) })

      await repository.append({
        record: revision,
        receipt: {
          actor: 'human:editor',
          recordKind: 'revision',
          requestKey: 'key-1',
          fingerprint: 'a'.repeat(64),
          created: '2026-10-20T09:00:00.000Z',
        },
      })

      // The same key, different content: the second write is refused by the
      // primary key of the receipt, and the store is unchanged.
      const outcome = await repository.append({
        record: other,
        receipt: {
          actor: 'human:editor',
          recordKind: 'revision',
          requestKey: 'key-1',
          fingerprint: 'c'.repeat(64),
          created: '2026-10-20T09:05:00.000Z',
        },
      })
      expect(outcome.ok).toBe(false)
      expect(await repository.findRecord('revision', other.id)).toBeNull()
      expect(await repository.listRecords('revision')).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a stale expected version and mutates nothing', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const revision = revisionFixture()
      const first = decisionFixture(revision)
      const second = decisionFixture(revision, {
        outcome: 'rejected',
        actor: revisionFixture().author,
      })

      await repository.append({ record: revision })
      const moved = await repository.append({
        record: first,
        transition: {
          kind: 'revision',
          id: revision.id,
          expected: 'revision-proposed',
          next: 'revision-approved',
        },
      })
      expect(moved.ok).toBe(true)
      expect(
        await repository.readAggregateState('revision', revision.id),
      ).toBe('revision-approved')

      // The second writer expected the old state. It is refused, and
      // nothing it wrote is stored.
      const stale = await repository.append({
        record: second,
        transition: {
          kind: 'revision',
          id: revision.id,
          expected: 'revision-proposed',
          next: 'revision-rejected',
        },
      })
      expect(stale.ok).toBe(false)
      if (!stale.ok) expect(stale.refusal.code).toBe('cas_conflict')
      expect(await repository.findRecord('decision', second.id)).toBeNull()
      expect(
        await repository.readAggregateState('revision', revision.id),
      ).toBe('revision-approved')
    } finally {
      fixture.cleanup()
    }
  })

  it('holds one current release per target', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const revision = revisionFixture()
      const candidate = candidateFixture(revision)
      const validation = validationFixture(candidate)
      const approval = approvalFixture(candidate)
      const first = releaseFixture(revision, candidate, [validation], approval)
      const secondRelease = releaseFixture(
        revision,
        candidate,
        [validation],
        approval,
        { artifacts: [...ARTIFACTS, {
          path: 'extra.txt',
          sha256: 'd'.repeat(64),
          byteLength: 10,
          profile: 'phone-webpub',
          renderer: 'semantic-html',
        }] },
      )

      const one = await repository.append({ record: first })
      expect(one.ok).toBe(true)

      const two = await repository.append({ record: secondRelease })
      expect(two.ok).toBe(false)
      if (!two.ok) expect(two.refusal.code).toBe('target_already_released')

      const releases = await repository.listRecords('release')
      expect(releases).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  it('lets a new release be published once the old one is retired', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const revision = revisionFixture()
      const candidate = candidateFixture(revision)
      const validation = validationFixture(candidate)
      const approval = approvalFixture(candidate)
      const first = releaseFixture(revision, candidate, [validation], approval)

      await repository.append({ record: first })
      const retired = await repository.append({
        record: supersessionFixture(first),
        transition: {
          kind: 'release',
          id: first.id,
          expected: 'release-released',
          next: 'release-superseded',
        },
      })
      expect(retired.ok).toBe(true)
      expect(
        await repository.readAggregateState('release', first.id),
      ).toBe('release-superseded')

      const secondRelease: EditorialRelease = releaseFixture(
        revision,
        candidate,
        [validation],
        approval,
        {
          artifacts: [
            {
              path: 'other.txt',
              sha256: 'e'.repeat(64),
              byteLength: 11,
              profile: 'phone-webpub',
              renderer: 'semantic-html',
            },
          ],
        },
      )
      const outcome = await repository.append({ record: secondRelease })
      expect(outcome.ok).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })
})
