import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_ACTIVATION_PHRASE,
  grantEditorialActivation,
} from './activation'
import { D1EditorialRepository } from './d1-repository'
import type { D1Database, D1PreparedStatement, D1Result } from './d1'
import { openEditorialFixture } from './sqlite-fixture'
import { InactiveEditorialWriter } from './writer'
import { fixturePinRegistry, releaseChainFixture } from './store-fixtures'
import { deriveEditorialId, editorialRecordDigest } from './ids'
import {
  candidateFixture,
  decisionFixture,
  revisionFixture,
  validationFixture,
} from './fixtures'
import { OTHER_REVIEWER, REVIEWER, TOOL } from './fixtures'
import type {
  EditorialApproval,
  EditorialCandidate,
  EditorialRecord,
  EditorialRecordKind,
  EditorialRelease,
  EditorialRevision,
  EditorialValidation,
} from './records'
import type {
  EditorialAggregateKind,
  EditorialAppendInput,
  EditorialAppendOutcome,
  EditorialReceipt,
  EditorialRepository,
  EditorialRequestKey,
  EditorialSwitchState,
} from './repository'

const NOW = '2026-10-20T12:00:00.000Z'

function activation() {
  return grantEditorialActivation(EDITORIAL_ACTIVATION_PHRASE, 'the test')
}

/**
 * A database whose idempotency receipt insert fails.
 *
 * It is the design record's own failure row: "the idempotency receipt insert
 * failed — the whole batch rolled back, record included". The batch is
 * atomic, so the record must not be there either.
 */
class ReceiptFailureDatabase implements D1Database {
  constructor(private readonly inner: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    const statement = this.inner.prepare(query)
    if (!query.includes('editorial_idempotency_receipts')) return statement
    const fail = (inner: D1PreparedStatement): D1PreparedStatement => ({
      bind: (...values: unknown[]) => fail(inner.bind(...values)),
      all: <T>() => inner.all<T>(),
      first: <T>() => inner.first<T>(),
      run: () => {
        throw new Error('the store refused the write: simulated receipt failure')
      },
    })
    return fail(statement)
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    return this.inner.batch!(statements)
  }
}

/**
 * A repository that lets another writer move first.
 *
 * The race it creates is the real one: the writer has read the aggregate's
 * state, decided the transition, and *then* somebody else moved the
 * aggregate. The store's compare-and-swap has to catch it.
 */
class RacingRepository implements EditorialRepository {
  private raced = false

  constructor(
    private readonly inner: EditorialRepository,
    private readonly race: () => Promise<void>,
  ) {}

  async append(input: EditorialAppendInput): Promise<EditorialAppendOutcome> {
    if (!this.raced) {
      this.raced = true
      await this.race()
    }
    return this.inner.append(input)
  }

  listRecords(kind: EditorialRecordKind): Promise<EditorialRecord[]> {
    return this.inner.listRecords(kind)
  }

  findRecord(
    kind: EditorialRecordKind,
    id: string,
  ): Promise<EditorialRecord | null> {
    return this.inner.findRecord(kind, id)
  }

  readAggregateState(
    kind: EditorialAggregateKind,
    id: string,
  ): Promise<string | null> {
    return this.inner.readAggregateState(kind, id)
  }

  findReceipt(key: EditorialRequestKey): Promise<EditorialReceipt | null> {
    return this.inner.findReceipt(key)
  }

  readSwitchState(): Promise<EditorialSwitchState> {
    return this.inner.readSwitchState()
  }

  writeSwitchState(state: EditorialSwitchState): Promise<void> {
    return this.inner.writeSwitchState(state)
  }

  readBackfillProgress(name: string): Promise<string | null> {
    return this.inner.readBackfillProgress(name)
  }

  writeBackfillProgress(name: string, cursor: string | null): Promise<void> {
    return this.inner.writeBackfillProgress(name, cursor)
  }
}

/** A candidate that needs four checks, three of which are recorded. */
function candidateWithThreeChecks(): {
  revision: EditorialRevision
  candidate: EditorialCandidate
  recorded: EditorialValidation[]
  missing: EditorialValidation
} {
  const revision = revisionFixture()
  const candidate = candidateFixture(revision)
  const recorded = (['bundle-verification', 'epubcheck', 'ace'] as const).map(
    (check) => validationFixture(candidate, { check, actor: TOOL }),
  )
  // A *different* reviewer, so it is a different record: the id is the
  // content's digest, and the timestamp is not part of it.
  const missing = validationFixture(candidate, {
    check: 'human-review',
    actor: OTHER_REVIEWER,
  })
  return { revision, candidate, recorded, missing }
}

/**
 * The concurrency and mutation proofs.
 *
 * Six properties, each one a thing that goes wrong in a durable store when
 * nobody proves it: a retry, a duplicate, a stale approval, a lost race, a
 * half-written write, and a write nobody can read back.
 */
describe('the editorial concurrency and mutation proofs', () => {
  it('makes a retry of the same submission idempotent', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()

      const first = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'retry-key',
        record: chain.revision,
      })
      expect(first.ok).toBe(true)

      const second = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'retry-key',
        record: chain.revision,
      })
      expect(second.ok).toBe(true)
      if (!second.ok || !first.ok) return
      expect(second.replayed).toBe(true)
      expect(second.record).toStrictEqual(first.record)

      // One revision, one receipt: the retry wrote nothing.
      expect(await repository.listRecords('revision')).toHaveLength(1)
      const receipt = await repository.findReceipt({
        actor: 'human:urn:margin:principal:workos:https%3A%2F%2Fidp.example:editor-1',
        recordKind: 'revision',
        requestKey: 'retry-key',
      })
      expect(receipt).not.toBeNull()
      expect(receipt?.recordId).toBe(chain.revision.id)
    } finally {
      fixture.cleanup()
    }
  })

  it('does not write twice when the same content is submitted again', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()

      const first = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'key-one',
        record: chain.revision,
      })
      // A different key, the same content: the id is the content's digest,
      // so this is the same record and it is already stored.
      const second = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'key-two',
        record: chain.revision,
      })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.replayed).toBe(true)
      expect(await repository.listRecords('revision')).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a key that was used for a different submission', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()
      const other = revisionFixture({ documentSha256: 'b'.repeat(64) })

      await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'shared-key',
        record: chain.revision,
      })
      const outcome = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'shared-key',
        record: other,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe('idempotency_key_reused')
      }
      expect(await repository.listRecords('revision')).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  it('does not let a stale approval authorise a changed candidate', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const granted = activation()

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

      // The candidate changes: different artifact bytes, so a different
      // candidate, and a different approval is needed.
      const second = releaseChainFixture({
        revision: first.revision,
        artifacts: [
          {
            path: 'changed.epub',
            sha256: '5'.repeat(64),
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

      // The first candidate's approval is in the store, so the release's
      // reference to it resolves: the refusal is about the digests, not
      // about a missing record.
      await repository.append({ record: first.approval })

      // A release over the changed candidate that binds the *first*
      // candidate's approval.
      const stale = {
        ...second.release,
        approval: {
          id: first.approval.id,
          sha256: editorialRecordDigest(first.approval),
        },
      }
      const staleRelease: EditorialRelease = {
        ...stale,
        id: deriveEditorialId(stale),
      }
      const outcome = await writer.recordRelease({
        activation: granted,
        actor: second.release.producer,
        now: NOW,
        record: staleRelease,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe('digest_mismatch')
      }
      expect(await repository.listRecords('release')).toHaveLength(0)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a compare-and-swap that lost the race, and changes nothing', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const granted = activation()
      const { revision, candidate, recorded, missing } =
        candidateWithThreeChecks()

      await writer.proposeRevision({
        activation: granted,
        actor: revision.author,
        now: NOW,
        record: revision,
      })
      const decision = decisionFixture(revision)
      await writer.recordDecision({
        activation: granted,
        actor: decision.actor,
        now: NOW,
        record: decision,
      })
      await writer.assembleCandidate({
        activation: granted,
        actor: candidate.author,
        now: NOW,
        record: candidate,
      })
      for (const validation of recorded) {
        await writer.recordValidation({
          activation: granted,
          actor: validation.actor,
          now: NOW,
          record: validation,
        })
      }
      expect(
        await repository.readAggregateState('candidate', candidate.id),
      ).toBe('candidate-assembled')

      // The other writer gets there first.
      const other = validationFixture(candidate, {
        check: 'human-review',
        actor: REVIEWER,
      })
      const plain = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const racing = new InactiveEditorialWriter(
        new RacingRepository(repository, async () => {
          const won = await plain.recordValidation({
            activation: granted,
            actor: other.actor,
            now: NOW,
            record: other,
          })
          expect(won.ok).toBe(true)
        }),
        fixturePinRegistry(),
      )

      const outcome = await racing.recordValidation({
        activation: granted,
        actor: missing.actor,
        now: NOW,
        record: missing,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.refusal.code).toBe('cas_conflict')

      // The stored state is the winner's, and the loser's record was never
      // written.
      expect(
        await repository.readAggregateState('candidate', candidate.id),
      ).toBe('candidate-validated')
      expect(await repository.findRecord('validation', missing.id)).toBeNull()
      expect(await repository.findRecord('validation', other.id)).not.toBeNull()
    } finally {
      fixture.cleanup()
    }
  })

  it('writes nothing when a receipt cannot be written, and the retry converges', async () => {
    const fixture = openEditorialFixture()
    try {
      const broken = new D1EditorialRepository(
        new ReceiptFailureDatabase(fixture.database),
      )
      const writer = new InactiveEditorialWriter(broken, fixturePinRegistry())
      const chain = releaseChainFixture()

      const failed = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'partial-key',
        record: chain.revision,
      })
      expect(failed.ok).toBe(false)
      if (!failed.ok) {
        expect(failed.refusal.code).toBe('editorial_store_unavailable')
      }

      // The batch rolled back: the record is not there either.
      const repository = new D1EditorialRepository(fixture.database)
      expect(await repository.findRecord('revision', chain.revision.id)).toBeNull()
      expect(await repository.listRecords('revision')).toHaveLength(0)

      // The retry, with the store working, converges.
      const healthy = new InactiveEditorialWriter(
        repository,
        fixturePinRegistry(),
      )
      const retried = await healthy.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        requestKey: 'partial-key',
        record: chain.revision,
      })
      expect(retried.ok).toBe(true)
      if (!retried.ok) return
      expect(retried.replayed).toBe(false)

      // The read-after-write evidence: what the write returned is what a
      // later read observes.
      expect(
        await repository.findRecord('revision', chain.revision.id),
      ).toStrictEqual(retried.record)
      const receipt = await repository.findReceipt({
        actor: 'human:urn:margin:principal:workos:https%3A%2F%2Fidp.example:editor-1',
        recordKind: 'revision',
        requestKey: 'partial-key',
      })
      expect(receipt?.recordId).toBe(chain.revision.id)
    } finally {
      fixture.cleanup()
    }
  })

  it('reads back exactly what it wrote, through another connection', async () => {
    const fixture = openEditorialFixture()
    try {
      const repository = new D1EditorialRepository(fixture.database)
      const writer = new InactiveEditorialWriter(repository, fixturePinRegistry())
      const chain = releaseChainFixture()

      const written = await writer.proposeRevision({
        activation: activation(),
        actor: chain.revision.author,
        now: NOW,
        record: chain.revision,
      })
      expect(written.ok).toBe(true)
      if (!written.ok) return

      const later = new D1EditorialRepository(fixture.reopen())
      expect(await later.findRecord('revision', chain.revision.id)).toStrictEqual(
        written.record,
      )
    } finally {
      fixture.cleanup()
    }
  })
})
