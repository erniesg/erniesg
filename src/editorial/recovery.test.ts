import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_ACTIVATION_PHRASE,
  grantEditorialActivation,
  type EditorialActivation,
} from './activation'
import { D1EditorialRepository } from './d1-repository'
import { createExpandedReader } from './expanded-reader'
import { staticLegacySource } from './legacy-source'
import { runEditorialBackfill } from './migration'
import { rehearseEditorialRecovery } from './recovery'
import { openEditorialFixture } from './sqlite-fixture'
import { InactiveEditorialWriter } from './writer'
import {
  NEWER_PACKAGE_PIN,
  fixturePinRegistry,
  publishChain,
  releaseChainFixture,
} from './store-fixtures'
import {
  OTHER_DOCUMENT_SHA256,
  revisionFixture,
  supersessionFixture,
} from './fixtures'
import type { EditorialRecord } from './records'

const NOW = '2026-10-20T12:00:00.000Z'

function activation(): EditorialActivation {
  const granted = grantEditorialActivation(
    EDITORIAL_ACTIVATION_PHRASE,
    'the test',
  )
  if (granted === null) throw new Error('the test could not be activated')
  return granted
}

/** The pre-switch record set: one published release and everything it binds. */
function legacyRecords(chain: ReturnType<typeof releaseChainFixture>): EditorialRecord[] {
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
 * The rollback and forward-recovery rehearsal.
 *
 * The rehearsal runs on **representative pre-switch and post-switch
 * records**: a legacy release the backfill migrated, and a release the new
 * writer published after the cutover.
 */
describe('the rollback and forward-recovery rehearsal', () => {
  it('serves the post-switch record, then the pre-switch one, then the post-switch one again', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const registry = fixturePinRegistry()
      const writer = new InactiveEditorialWriter(repository, registry)
      const granted = activation()

      // The pre-switch records: the legacy side already published them.
      const preSwitch = releaseChainFixture()
      const source = staticLegacySource(legacyRecords(preSwitch))
      const reader = createExpandedReader({ repository, source })

      // The backfill moves them into the store.
      await runEditorialBackfill({
        source,
        repository,
        name: 'editorial-cutover',
      })

      // The post-switch record: a new cut of the content, published for the
      // same target after the pre-switch release was retired.
      const retired = await writer.supersedeRelease({
        activation: granted,
        actor: preSwitch.release.producer,
        now: NOW,
        record: supersessionFixture(preSwitch.release, { reason: 'withdrawn' }),
      })
      expect(retired.ok).toBe(true)

      const postSwitch = releaseChainFixture({
        revision: revisionFixture({
          documentSha256: OTHER_DOCUMENT_SHA256,
        }),
      })
      await publishChain(writer, postSwitch, granted, NOW)

      const targetId = preSwitch.release.target.id
      expect(postSwitch.release.target.id).toBe(targetId)

      const evidence = await rehearseEditorialRecovery({
        repository,
        reader,
        source,
        writer,
        registry,
        activation: granted,
        targetId,
        now: NOW,
        newerPin: NEWER_PACKAGE_PIN,
        downgradeRevision: preSwitch.revision,
        downgradeCandidate: releaseChainFixture({
          revision: preSwitch.revision,
          artifacts: [
            {
              path: 'downgraded.epub',
              sha256: '4'.repeat(64),
              byteLength: 4096,
              profile: 'eink-epub',
              renderer: 'jszip',
            },
          ],
        }).candidate,
      })

      // The cutover in force: the store answers with the post-switch
      // release.
      expect(evidence.beforeRollback.source).toBe('store')
      expect(evidence.beforeRollback.releaseId).toBe(postSwitch.release.id)

      // The rollback: the legacy source answers with the pre-switch
      // release, and the post-switch record is not served.
      expect(evidence.afterRollback.source).toBe('legacy')
      expect(evidence.afterRollback.releaseId).toBe(preSwitch.release.id)
      expect(evidence.afterRollback.releaseId).not.toBe(
        evidence.beforeRollback.releaseId,
      )

      // The forward recovery: the store answers again.
      expect(evidence.afterForwardRecovery.source).toBe('store')
      expect(evidence.afterForwardRecovery.releaseId).toBe(
        postSwitch.release.id,
      )

      // The rollback destroyed nothing.
      expect(evidence.recordsAfterRollback).toBe(
        evidence.recordsBeforeRollback,
      )
      expect(evidence.recordsBeforeRollback).toBeGreaterThan(0)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses an unsafe package downgrade', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const registry = fixturePinRegistry()
      const writer = new InactiveEditorialWriter(repository, registry)
      const granted = activation()

      const preSwitch = releaseChainFixture()
      const source = staticLegacySource([preSwitch.revision])
      const reader = createExpandedReader({ repository, source })
      await runEditorialBackfill({
        source,
        repository,
        name: 'editorial-cutover',
      })

      const downgradeCandidate = releaseChainFixture({
        revision: preSwitch.revision,
        artifacts: [
          {
            path: 'downgraded.epub',
            sha256: '3'.repeat(64),
            byteLength: 4096,
            profile: 'eink-epub',
            renderer: 'jszip',
          },
        ],
      }).candidate

      const evidence = await rehearseEditorialRecovery({
        repository,
        reader,
        source,
        writer,
        registry,
        activation: granted,
        targetId: preSwitch.release.target.id,
        now: NOW,
        newerPin: NEWER_PACKAGE_PIN,
        downgradeRevision: preSwitch.revision,
        downgradeCandidate,
      })

      expect(evidence.downgrade.refused).toBe(true)
      expect(evidence.downgrade.code).toBe('package_pin_downgrade')

      // The refusal wrote nothing.
      expect(
        await repository.findRecord('candidate', downgradeCandidate.id),
      ).toBeNull()
      expect(await repository.listRecords('candidate')).toHaveLength(0)
    } finally {
      fixture.cleanup()
    }
  })

  it('re-pins the app, so the old pin is a downgrade from then on', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const registry = fixturePinRegistry()
      const writer = new InactiveEditorialWriter(repository, registry)
      const granted = activation()

      const chain = releaseChainFixture()
      const source = staticLegacySource([chain.revision])
      const reader = createExpandedReader({ repository, source })
      await runEditorialBackfill({
        source,
        repository,
        name: 'editorial-cutover',
      })

      await rehearseEditorialRecovery({
        repository,
        reader,
        source,
        writer,
        registry,
        activation: granted,
        targetId: chain.release.target.id,
        now: NOW,
        newerPin: NEWER_PACKAGE_PIN,
        downgradeRevision: chain.revision,
        downgradeCandidate: releaseChainFixture({
          revision: chain.revision,
          artifacts: [
            {
              path: 'downgraded.epub',
              sha256: '2'.repeat(64),
              byteLength: 4096,
              profile: 'eink-epub',
              renderer: 'jszip',
            },
          ],
        }).candidate,
      })

      // The registry now holds the newer pin, and the fixture's pin is
      // older than it.
      expect(registry.pins).toContain(NEWER_PACKAGE_PIN)
      const fixturePin = registry.pins.find(
        (pin) => pin.sourceCommit === chain.revision.sourceBinding.packageSourceCommit,
      )
      expect(fixturePin).toBeDefined()
      expect(fixturePin!.sequence).toBeLessThan(NEWER_PACKAGE_PIN.sequence)
    } finally {
      fixture.cleanup()
    }
  })
})
