import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_ACTIVATION_PHRASE,
  grantEditorialActivation,
} from './activation'
import { D1EditorialRepository } from './d1-repository'
import { editorialRecordDigest } from './ids'
import { openEditorialFixture } from './sqlite-fixture'
import { InactiveEditorialWriter } from './writer'
import { fixturePinRegistry, releaseChainFixture } from './store-fixtures'
import { supersessionFixture } from './fixtures'
import type { EditorialRelease } from './records'

const NOW = '2026-10-20T12:00:00.000Z'

function activation() {
  return grantEditorialActivation(EDITORIAL_ACTIVATION_PHRASE, 'the test')
}

/**
 * The inactive writer.
 *
 * The two things it must never do are refuse nothing and write nothing when
 * it has no activation, so both are asserted first.
 */
describe('the inactive editorial writer', () => {
  it('refuses every write when it has no activation', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()

      const result = await writer.proposeRevision({
        activation: null,
        actor: chain.revision.author,
        now: NOW,
        record: chain.revision,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.refusal.code).toBe('editorial_writer_inactive')
      }

      // Nothing was written.
      expect(await repository.listRecords('revision')).toHaveLength(0)
      expect(await repository.listRecords('candidate')).toHaveLength(0)
      expect(await repository.listRecords('release')).toHaveLength(0)
    } finally {
      fixture.cleanup()
    }
  })

  it('writes the whole pipeline, and a later read sees what it returned', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()
      const granted = activation()

      const revision = await writer.proposeRevision({
        activation: granted,
        actor: chain.revision.author,
        now: NOW,
        record: chain.revision,
      })
      expect(revision.ok).toBe(true)
      if (!revision.ok) return
      expect(revision.record).toStrictEqual(chain.revision)
      expect(
        await repository.findRecord('revision', chain.revision.id),
      ).toStrictEqual(chain.revision)

      const decision = await writer.recordDecision({
        activation: granted,
        actor: chain.decision.actor,
        now: NOW,
        record: chain.decision,
      })
      expect(decision.ok).toBe(true)

      const candidate = await writer.assembleCandidate({
        activation: granted,
        actor: chain.candidate.author,
        now: NOW,
        record: chain.candidate,
      })
      expect(candidate.ok).toBe(true)

      for (const validation of chain.validations) {
        const written = await writer.recordValidation({
          activation: granted,
          actor: validation.actor,
          now: NOW,
          record: validation,
        })
        expect(written.ok).toBe(true)
      }
      expect(
        await repository.readAggregateState('candidate', chain.candidate.id),
      ).toBe('candidate-validated')

      const approval = await writer.recordApproval({
        activation: granted,
        actor: chain.approval.actor,
        now: NOW,
        record: chain.approval,
      })
      expect(approval.ok).toBe(true)
      expect(
        await repository.readAggregateState('candidate', chain.candidate.id),
      ).toBe('candidate-approved-for-release')

      const release = await writer.recordRelease({
        activation: granted,
        actor: chain.release.producer,
        now: NOW,
        record: chain.release,
      })
      expect(release.ok).toBe(true)
      if (!release.ok) return
      expect(release.record).toStrictEqual(chain.release)
      expect(
        await repository.findRecord('release', chain.release.id),
      ).toStrictEqual(chain.release)
      expect(
        await repository.readAggregateState('candidate', chain.candidate.id),
      ).toBe('candidate-released')

      const current = await writer.currentReleaseForTarget(
        chain.release.target.id,
      )
      expect(current?.id).toBe(chain.release.id)
    } finally {
      fixture.cleanup()
    }
  })

  it('retires a release and publishes its replacement', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()
      const granted = activation()

      await writer.proposeRevision({
        activation: granted,
        actor: chain.revision.author,
        now: NOW,
        record: chain.revision,
      })
      await writer.recordDecision({
        activation: granted,
        actor: chain.decision.actor,
        now: NOW,
        record: chain.decision,
      })
      await writer.assembleCandidate({
        activation: granted,
        actor: chain.candidate.author,
        now: NOW,
        record: chain.candidate,
      })
      for (const validation of chain.validations) {
        await writer.recordValidation({
          activation: granted,
          actor: validation.actor,
          now: NOW,
          record: validation,
        })
      }
      await writer.recordApproval({
        activation: granted,
        actor: chain.approval.actor,
        now: NOW,
        record: chain.approval,
      })
      await writer.recordRelease({
        activation: granted,
        actor: chain.release.producer,
        now: NOW,
        record: chain.release,
      })

      // The order is supersede, then release: the old release is retired
      // first, and only then is the new one published.
      const retired = await writer.supersedeRelease({
        activation: granted,
        actor: chain.release.producer,
        now: NOW,
        record: supersessionFixture(chain.release, { reason: 'withdrawn' }),
      })
      expect(retired.ok).toBe(true)
      expect(
        await repository.readAggregateState('release', chain.release.id),
      ).toBe('release-withdrawn')
      expect(
        await writer.currentReleaseForTarget(chain.release.target.id),
      ).toBeNull()

      const second = releaseChainFixture({
        revision: chain.revision,
        artifacts: [
          {
            path: 'other.epub',
            sha256: '7'.repeat(64),
            byteLength: 4096,
            profile: 'eink-epub',
            renderer: 'jszip',
          },
        ],
      })
      await writer.assembleCandidate({
        activation: granted,
        actor: second.candidate.author,
        now: NOW,
        record: second.candidate,
      })
      for (const validation of second.validations) {
        await writer.recordValidation({
          activation: granted,
          actor: validation.actor,
          now: NOW,
          record: validation,
        })
      }
      await writer.recordApproval({
        activation: granted,
        actor: second.approval.actor,
        now: NOW,
        record: second.approval,
      })
      const published = await writer.recordRelease({
        activation: granted,
        actor: second.release.producer,
        now: NOW,
        record: second.release,
      })
      expect(published.ok).toBe(true)
      expect(
        (await writer.currentReleaseForTarget(second.release.target.id))?.id,
      ).toBe(second.release.id)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a release that binds an approval for a different candidate', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const granted = activation()

      // The first chain is the approved one.
      const first = releaseChainFixture()
      await writer.proposeRevision({
        activation: granted,
        actor: first.revision.author,
        now: NOW,
        record: first.revision,
      })
      await writer.recordDecision({
        activation: granted,
        actor: first.decision.actor,
        now: NOW,
        record: first.decision,
      })

      // The second candidate is a different cut of the same revision.
      const second = releaseChainFixture({
        revision: first.revision,
        artifacts: [
          {
            path: 'other.epub',
            sha256: '9'.repeat(64),
            byteLength: 4096,
            profile: 'eink-epub',
            renderer: 'jszip',
          },
        ],
      })
      await writer.assembleCandidate({
        activation: granted,
        actor: second.candidate.author,
        now: NOW,
        record: second.candidate,
      })
      for (const validation of second.validations) {
        await writer.recordValidation({
          activation: granted,
          actor: validation.actor,
          now: NOW,
          record: validation,
        })
      }
      await writer.recordApproval({
        activation: granted,
        actor: second.approval.actor,
        now: NOW,
        record: second.approval,
      })

      // A release over the second candidate that binds the *first*
      // candidate's approval: the approval is stale and does not authorise
      // the changed candidate.
      const forged: EditorialRelease = {
        ...second.release,
        approval: {
          id: first.approval.id,
          sha256: editorialRecordDigest(first.approval),
        },
        id: `urn:editorial:release:${'b'.repeat(64)}`,
      }
      const outcome = await writer.recordRelease({
        activation: granted,
        actor: second.release.producer,
        now: NOW,
        record: forged,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe('record_id_mismatch')
      }
      expect(await repository.listRecords('release')).toHaveLength(0)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a candidate cut under a package pin the app does not approve', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()

      const outcome = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        record: {
          ...chain.revision,
          sourceBinding: {
            ...chain.revision.sourceBinding,
            packageSourceCommit: 'f'.repeat(40),
          },
        },
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe('package_pin_unapproved')
      }
      expect(await repository.listRecords('revision')).toHaveLength(0)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a second release for a target that already has one', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const granted = activation()
      const chain = releaseChainFixture()

      await writer.proposeRevision({
        activation: granted,
        actor: chain.revision.author,
        now: NOW,
        record: chain.revision,
      })
      await writer.recordDecision({
        activation: granted,
        actor: chain.decision.actor,
        now: NOW,
        record: chain.decision,
      })
      await writer.assembleCandidate({
        activation: granted,
        actor: chain.candidate.author,
        now: NOW,
        record: chain.candidate,
      })
      for (const validation of chain.validations) {
        await writer.recordValidation({
          activation: granted,
          actor: validation.actor,
          now: NOW,
          record: validation,
        })
      }
      await writer.recordApproval({
        activation: granted,
        actor: chain.approval.actor,
        now: NOW,
        record: chain.approval,
      })
      const released = await writer.recordRelease({
        activation: granted,
        actor: chain.release.producer,
        now: NOW,
        record: chain.release,
      })
      expect(released.ok).toBe(true)

      // A second candidate for the same target, published without
      // superseding the first.
      const second = releaseChainFixture({
        revision: chain.revision,
        artifacts: [
          {
            path: 'other.epub',
            sha256: '8'.repeat(64),
            byteLength: 4096,
            profile: 'eink-epub',
            renderer: 'jszip',
          },
        ],
      })
      await writer.assembleCandidate({
        activation: granted,
        actor: second.candidate.author,
        now: NOW,
        record: second.candidate,
      })
      for (const validation of second.validations) {
        await writer.recordValidation({
          activation: granted,
          actor: validation.actor,
          now: NOW,
          record: validation,
        })
      }
      await writer.recordApproval({
        activation: granted,
        actor: second.approval.actor,
        now: NOW,
        record: second.approval,
      })
      const outcome = await writer.recordRelease({
        activation: granted,
        actor: second.release.producer,
        now: NOW,
        record: second.release,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe('target_already_released')
      }
      expect(await repository.listRecords('release')).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  it('writes a record whose timestamp is in the future only if it refuses', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()

      const outcome = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: '2026-10-20T08:00:00.000Z',
        record: chain.revision,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe('record_timestamp_in_future')
      }
      expect(await repository.listRecords('revision')).toHaveLength(0)
    } finally {
      fixture.cleanup()
    }
  })
})
