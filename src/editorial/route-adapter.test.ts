import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_ACTIVATION_PHRASE,
  grantEditorialActivation,
} from './activation'
import { D1EditorialRepository } from './d1-repository'
import { deriveEditorialId, editorialRecordDigest } from './ids'
import {
  makeProducerTestKeys,
  NOW,
  producerRecordFixture,
  trustPolicyFixture,
  trustRootFixture,
} from './producer-fixtures'
import { InactiveEditorialRouteAdapter } from './route-adapter'
import { openEditorialFixture } from './sqlite-fixture'
import { D1ProducerTrustStore } from './trust-store'
import { InactiveEditorialWriter } from './writer'
import { fixturePinRegistry, releaseChainFixture } from './store-fixtures'
import { supersessionFixture } from './fixtures'
import type { EditorialRelease } from './records'

const NOW_STRING = '2026-10-20T12:00:00.000Z'

function activation() {
  return grantEditorialActivation(EDITORIAL_ACTIVATION_PHRASE, 'the test')
}

/** The chain, written into a fresh store. */
async function publishChain(
  fixture: {
    database: ReturnType<typeof openEditorialFixture>['database']
  },
  options: { withApproval?: boolean; withRelease?: boolean } = {},
) {
  const repository = new D1EditorialRepository(fixture.database)
  const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
  const chain = releaseChainFixture()
  const granted = activation()

  await writer.proposeRevision({
    activation: granted,
    actor: chain.revision.author,
    now: NOW_STRING,
    record: chain.revision,
  })
  await writer.recordDecision({
    activation: granted,
    actor: chain.decision.actor,
    now: NOW_STRING,
    record: chain.decision,
  })
  await writer.assembleCandidate({
    activation: granted,
    actor: chain.candidate.author,
    now: NOW_STRING,
    record: chain.candidate,
  })
  for (const validation of chain.validations) {
    await writer.recordValidation({
      activation: granted,
      actor: validation.actor,
      now: NOW_STRING,
      record: validation,
    })
  }
  if (options.withApproval !== false) {
    await writer.recordApproval({
      activation: granted,
      actor: chain.approval.actor,
      now: NOW_STRING,
      record: chain.approval,
    })
  }
  if (options.withRelease !== false) {
    await writer.recordRelease({
      activation: granted,
      actor: chain.release.producer,
      now: NOW_STRING,
      record: chain.release,
    })
  }
  return { repository, writer, chain }
}

/**
 * The inactive public-route adapter.
 *
 * The property under test is a single sentence: the adapter never exposes
 * an unapproved or superseded artifact. Every refusal below is that
 * sentence, spelled out.
 */
describe('the inactive public-route adapter', () => {
  it('serves nothing at all without an activation', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository, chain } = await publishChain(fixture)
      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )

      const result = await adapter.serve({
        activation: null,
        request: { kind: 'target', targetId: chain.release.target.id },
        now: NOW,
        producerRecord: {},
        policy: {},
        root: {},
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_route_inactive')
        expect(result.status).toBe(503)
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('serves the current release of a target', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository, chain } = await publishChain(fixture)
      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const producerRecord = await producerRecordFixture({
        keys,
        overrides: {
          releaseId: chain.release.id,
          releaseSha256: editorialRecordDigest(chain.release),
        },
      })
      const policy = await trustPolicyFixture({ keys })

      const result = await adapter.serve({
        activation: activation(),
        request: { kind: 'target', targetId: chain.release.target.id },
        now: NOW,
        producerRecord,
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.release.id).toBe(chain.release.id)
      expect(result.artifacts).toStrictEqual(chain.release.artifacts)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a target that has no current release', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository } = await publishChain(fixture)
      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const policy = await trustPolicyFixture({ keys })

      const result = await adapter.serve({
        activation: activation(),
        request: { kind: 'target', targetId: 'a-target-with-nothing' },
        now: NOW,
        producerRecord: {},
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_release_not_found')
        expect(result.status).toBe(404)
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a superseded artifact', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository, writer, chain } = await publishChain(fixture)
      await writer.supersedeRelease({
        activation: activation(),
        actor: chain.release.producer,
        now: NOW_STRING,
        record: supersessionFixture(chain.release, { reason: 'withdrawn' }),
      })
      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const policy = await trustPolicyFixture({ keys })

      const result = await adapter.serve({
        activation: activation(),
        request: { kind: 'release', releaseId: chain.release.id },
        now: NOW,
        producerRecord: {},
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_release_superseded')
        expect(result.status).toBe(410)
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses an artifact with no approval', async () => {
    const fixture = openEditorialFixture()
    try {
      // The chain is written without its approval, and the release is
      // written straight into the store, so it binds an approval that is
      // not there.
      const { repository, chain } = await publishChain(fixture, {
        withApproval: false,
        withRelease: false,
      })
      await repository.append({ record: chain.release })
      expect(
        await repository.findRecord('approval', chain.approval.id),
      ).toBeNull()

      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const policy = await trustPolicyFixture({ keys })

      const result = await adapter.serve({
        activation: activation(),
        request: { kind: 'release', releaseId: chain.release.id },
        now: NOW,
        producerRecord: {},
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_artifact_unapproved')
        expect(result.status).toBe(503)
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses an artifact whose approval is for different digests', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository, chain } = await publishChain(fixture)

      // A second candidate, with its own approval, over the same revision.
      const other = releaseChainFixture({
        revision: chain.revision,
        artifacts: [
          {
            path: 'other.epub',
            sha256: '6'.repeat(64),
            byteLength: 4096,
            profile: 'eink-epub',
            renderer: 'jszip',
          },
        ],
      })

      // A release over the first candidate that binds the *second*
      // candidate's approval. The writer would refuse to write it; the
      // adapter refuses to serve it.
      const mismatched = {
        ...chain.release,
        // A target of its own, so the store's one-current-release-per-target
        // index is not what refuses the write: the digest mismatch is.
        target: { ...chain.release.target, id: 'a-second-target' },
        approval: {
          id: other.approval.id,
          sha256: editorialRecordDigest(other.approval),
        },
      }
      const mismatchedRelease: EditorialRelease = {
        ...mismatched,
        id: deriveEditorialId(mismatched),
      }
      // The *other* candidate's approval is in the store; the release binds
      // it while publishing the first candidate.
      await repository.append({ record: other.approval })
      await repository.append({ record: mismatchedRelease })

      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const policy = await trustPolicyFixture({ keys })

      const result = await adapter.serve({
        activation: activation(),
        request: { kind: 'release', releaseId: mismatchedRelease.id },
        now: NOW,
        producerRecord: {},
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_approval_digest_mismatch')
        expect(result.status).toBe(503)
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses an artifact with a revoked producer record', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository, chain } = await publishChain(fixture)
      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const producerRecord = await producerRecordFixture({
        keys,
        overrides: {
          releaseId: chain.release.id,
          releaseSha256: editorialRecordDigest(chain.release),
          status: 'revoked',
        },
      })
      const policy = await trustPolicyFixture({ keys })

      const result = await adapter.serve({
        activation: activation(),
        request: { kind: 'target', targetId: chain.release.target.id },
        now: NOW,
        producerRecord,
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_producer_record_revoked')
        expect(result.status).toBe(503)
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses an artifact with an expired producer record', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository, chain } = await publishChain(fixture)
      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const producerRecord = await producerRecordFixture({
        keys,
        overrides: {
          releaseId: chain.release.id,
          releaseSha256: editorialRecordDigest(chain.release),
          issuedAt: '2026-10-19T00:00:00.000Z',
          expiresAt: '2026-10-19T12:00:00.000Z',
        },
      })
      const policy = await trustPolicyFixture({ keys })

      const result = await adapter.serve({
        activation: activation(),
        request: { kind: 'target', targetId: chain.release.target.id },
        now: NOW,
        producerRecord,
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_producer_record_expired')
        expect(result.status).toBe(503)
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses an artifact published under a package pin the app does not approve', async () => {
    const fixture = openEditorialFixture()
    try {
      const { repository, chain } = await publishChain(fixture)
      const adapter = new InactiveEditorialRouteAdapter(
        repository,
        fixturePinRegistry(),
      )
      const keys = await makeProducerTestKeys()
      const policy = await trustPolicyFixture({ keys })

      // The registry the adapter holds no longer approves the pin the
      // release was published under.
      const registry = fixturePinRegistry()
      registry.pins = registry.pins.filter(
        (pin) => pin.sourceCommit !== chain.release.sourceBinding.packageSourceCommit,
      )
      const strict = new InactiveEditorialRouteAdapter(repository, registry)

      const result = await strict.serve({
        activation: activation(),
        request: { kind: 'target', targetId: chain.release.target.id },
        now: NOW,
        producerRecord: {},
        policy,
        root: trustRootFixture(keys),
        trustStore: new D1ProducerTrustStore(fixture.database),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('editorial_package_pin_unapproved')
      }
    } finally {
      fixture.cleanup()
    }
  })
})
