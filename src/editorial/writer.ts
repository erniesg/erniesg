/**
 * The **inactive** editorial writer.
 *
 * It performs the durable publication transitions of §5 of the design record,
 * and it is **not wired into anything**: no route imports it, the Worker
 * entry does not import it, and it refuses to write unless the caller hands
 * it an activation value that this repository never supplies
 * (`activation.ts`).
 *
 * ## What one write does
 *
 * 1. **Refuse without an activation.** Nothing is read and nothing is
 *    written.
 * 2. **Answer a replay.** A keyed submission whose receipt already exists
 *    returns the record that receipt names and writes nothing. A submission
 *    whose *content* is already stored returns that record and writes
 *    nothing: the id is the content's digest, so the same content is the
 *    same record.
 * 3. **Decide.** The records the transition needs are read, and
 *    `applyTransition` answers "may this happen, and what is the state
 *    afterwards". A refusal writes nothing.
 * 4. **Check the expected version.** The aggregate's materialised state is
 *    read and compared with the transition's `from`. A mismatch is a
 *    compare-and-swap conflict: somebody else moved first, and nothing is
 *    written.
 * 5. **Write once.** The record, the aggregate's state change and the
 *    idempotency receipt commit together, in one batch, guarded by the
 *    expected state. A lost race writes nothing at all.
 *
 * ## Why the pin check is here and not in the state machine
 *
 * The state machine owns the *pipeline*: who may do what, and which digests
 * bind which records. The package pin is a **policy of the app's
 * configuration** — an ordered registry of the Struct pins the app approves
 * (`package-pin.ts`) — and a registry is not part of a pure function over
 * records. So the check is here, where the registry is injected, and it is a
 * precondition: it runs before the transition is attempted and a refusal
 * writes nothing.
 */
import {
  EDITORIAL_INACTIVE_MESSAGE,
  isEditorialActivation,
  type EditorialActivation,
} from './activation'
import { idempotencyFingerprint } from './ids'
import {
  checkPackagePin,
  type PackagePinRegistry,
} from './package-pin'
import {
  applyTransition,
  type EditorialRefusalCode,
} from './state-machine'
import type {
  EditorialActor,
  EditorialApproval,
  EditorialCandidate,
  EditorialDecision,
  EditorialRecord,
  EditorialRecordKind,
  EditorialRelease,
  EditorialRevision,
  EditorialSupersession,
  EditorialValidation,
} from './records'
import type {
  EditorialAggregateTransition,
  EditorialRepository,
  EditorialStoreRefusal,
} from './repository'
import { currentReleaseForTarget as projectCurrentRelease } from './validation'

/**
 * Every way the writer can refuse.
 *
 * The state machine's codes are in there, because most refusals are the
 * state machine's: a writer that refused with its own vocabulary would hide
 * *why* the pipeline said no.
 */
export type EditorialWriterRefusalCode =
  | 'editorial_writer_inactive'
  | 'editorial_record_missing'
  | 'package_pin_unapproved'
  | 'package_pin_downgrade'
  | EditorialRefusalCode
  | EditorialStoreRefusal

/** A refusal, with a code a caller can branch on. */
export type EditorialWriterRefusal = {
  code: EditorialWriterRefusalCode
  message: string
}

/** The outcome of one write. */
export type EditorialWriteResult<T> =
  | { ok: true; record: T; replayed: boolean }
  | { ok: false; refusal: EditorialWriterRefusal }

/** The input of one write. */
export type EditorialWriteInput<T> = {
  /**
   * The activation.
   *
   * Without it the writer refuses. It is carried per call: there is no
   * ambient state a future commit could set once and forget.
   */
  activation: EditorialActivation | null
  /** The actor performing the write. */
  actor: EditorialActor
  /** The writer's clock. An ISO 8601 timestamp. */
  now: string
  /** The caller's idempotency key, when the caller supplies one. */
  requestKey?: string
  /** The record to append. */
  record: T
}

/**
 * The scope of an idempotency receipt: the actor's own key.
 *
 * One caller's key never collides with another's, and the same key used for
 * a different kind of record is a different submission.
 */
export function editorialActorKey(actor: EditorialActor): string {
  switch (actor.kind) {
    case 'editor':
    case 'reviewer':
    case 'approver':
      return `human:${actor.principal}`
    case 'tool':
      return `tool:${actor.toolId}@${actor.toolVersion}`
    case 'producer':
      return `producer:${actor.keyId}@${actor.policyEpoch}`
  }
}

/** The receipt a write commits with its record. */
export type EditorialReceiptInput = {
  actor: string
  recordKind: EditorialRecordKind
  requestKey: string
  fingerprint: string
  created: string
}

/** The preparation of a write, before the transition is attempted. */
type WritePreparation<T> =
  | { ok: false; refusal: EditorialWriterRefusal }
  | {
      ok: true
      /** The stored record, when this submission is a replay. */
      replay: T | null
      fingerprint: string
      receipt: EditorialReceiptInput | null
    }

/**
 * The inactive editorial writer.
 *
 * It is behind the `EditorialRepository` seam, so it never touches D1
 * directly and the same code runs against the durable fixture and against
 * the real store.
 */
export class InactiveEditorialWriter {
  constructor(
    private readonly repository: EditorialRepository,
    /** The approved package pins. App-owned configuration, injected. */
    private readonly pins: PackagePinRegistry,
  ) {}

  /* ------------------------------------------------------------ the writes */

  /** Cut a new content revision. */
  async proposeRevision(
    input: EditorialWriteInput<EditorialRevision>,
  ): Promise<EditorialWriteResult<EditorialRevision>> {
    const prepared = await this.prepare(input, 'revision')
    if (!prepared.ok) return prepared
    if (prepared.replay !== null) {
      return { ok: true, record: prepared.replay, replayed: true }
    }
    const pin = checkPackagePin(input.record.sourceBinding, this.pins)
    if (!pin.ok) {
      return { ok: false, refusal: { code: pin.code, message: pin.message } }
    }
    const outcome = applyTransition({
      action: 'propose-revision',
      actor: input.actor,
      now: input.now,
      revision: input.record,
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    return this.commit(prepared, outcome.record, undefined)
  }

  /** Record a review decision about a revision. */
  async recordDecision(
    input: EditorialWriteInput<EditorialDecision>,
  ): Promise<EditorialWriteResult<EditorialDecision>> {
    const prepared = await this.prepare(input, 'decision')
    if (!prepared.ok) return prepared
    if (prepared.replay !== null) {
      return { ok: true, record: prepared.replay, replayed: true }
    }
    const revision = await this.repository.findRecord(
      'revision',
      input.record.subject.revisionId,
    )
    if (revision === null || revision.kind !== 'revision') {
      return {
        ok: false,
        refusal: {
          code: 'editorial_record_missing',
          message: `the decision names a revision the store does not hold: ${input.record.subject.revisionId}`,
        },
      }
    }
    const decisions = await this.decisions()
    const expected = await this.repository.readAggregateState(
      'revision',
      revision.id,
    )
    const outcome = applyTransition({
      action: 'record-decision',
      actor: input.actor,
      now: input.now,
      revision,
      decision: input.record,
      decisions,
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    const from = outcome.from
    if (from === null) {
      return {
        ok: false,
        refusal: {
          code: 'cas_conflict',
          message:
            'the transition was decided in no state, so there is nothing to compare and swap',
        },
      }
    }
    const conflict = this.expectedVersionConflict(expected, from)
    if (conflict !== null) return { ok: false, refusal: conflict }
    return this.commit(prepared, outcome.record, {
      kind: 'revision',
      id: revision.id,
      expected: from,
      next: outcome.to,
    })
  }

  /** Assemble a release candidate from an approved revision. */
  async assembleCandidate(
    input: EditorialWriteInput<EditorialCandidate>,
  ): Promise<EditorialWriteResult<EditorialCandidate>> {
    const prepared = await this.prepare(input, 'candidate')
    if (!prepared.ok) return prepared
    if (prepared.replay !== null) {
      return { ok: true, record: prepared.replay, replayed: true }
    }
    const revision = await this.repository.findRecord(
      'revision',
      input.record.revisionId,
    )
    if (revision === null || revision.kind !== 'revision') {
      return {
        ok: false,
        refusal: {
          code: 'editorial_record_missing',
          message: `the candidate names a revision the store does not hold: ${input.record.revisionId}`,
        },
      }
    }
    const pin = checkPackagePin(revision.sourceBinding, this.pins)
    if (!pin.ok) {
      return { ok: false, refusal: { code: pin.code, message: pin.message } }
    }
    const decisions = await this.decisions()
    const outcome = applyTransition({
      action: 'assemble-candidate',
      actor: input.actor,
      now: input.now,
      revision,
      candidate: input.record,
      decisions,
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    return this.commit(prepared, outcome.record, undefined)
  }

  /** Record one validation of a candidate. */
  async recordValidation(
    input: EditorialWriteInput<EditorialValidation>,
  ): Promise<EditorialWriteResult<EditorialValidation>> {
    const prepared = await this.prepare(input, 'validation')
    if (!prepared.ok) return prepared
    if (prepared.replay !== null) {
      return { ok: true, record: prepared.replay, replayed: true }
    }
    const candidate = await this.repository.findRecord(
      'candidate',
      input.record.subject.candidateId,
    )
    if (candidate === null || candidate.kind !== 'candidate') {
      return {
        ok: false,
        refusal: {
          code: 'editorial_record_missing',
          message: `the validation names a candidate the store does not hold: ${input.record.subject.candidateId}`,
        },
      }
    }
    const validations = await this.validations()
    const approvals = await this.approvals()
    const releases = await this.releases()
    const expected = await this.repository.readAggregateState(
      'candidate',
      candidate.id,
    )
    const outcome = applyTransition({
      action: 'record-validation',
      actor: input.actor,
      now: input.now,
      candidate,
      validation: input.record,
      validations,
      approvals,
      releases,
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    const from = outcome.from
    if (from === null) {
      return {
        ok: false,
        refusal: {
          code: 'cas_conflict',
          message:
            'the transition was decided in no state, so there is nothing to compare and swap',
        },
      }
    }
    const conflict = this.expectedVersionConflict(expected, from)
    if (conflict !== null) return { ok: false, refusal: conflict }
    return this.commit(prepared, outcome.record, {
      kind: 'candidate',
      id: candidate.id,
      expected: from,
      next: outcome.to,
    })
  }

  /** Record an authenticated approval of a candidate. */
  async recordApproval(
    input: EditorialWriteInput<EditorialApproval>,
  ): Promise<EditorialWriteResult<EditorialApproval>> {
    const prepared = await this.prepare(input, 'approval')
    if (!prepared.ok) return prepared
    if (prepared.replay !== null) {
      return { ok: true, record: prepared.replay, replayed: true }
    }
    const candidate = await this.repository.findRecord(
      'candidate',
      input.record.candidateId,
    )
    if (candidate === null || candidate.kind !== 'candidate') {
      return {
        ok: false,
        refusal: {
          code: 'editorial_record_missing',
          message: `the approval names a candidate the store does not hold: ${input.record.candidateId}`,
        },
      }
    }
    const validations = await this.validations()
    const approvals = await this.approvals()
    const expected = await this.repository.readAggregateState(
      'candidate',
      candidate.id,
    )
    const outcome = applyTransition({
      action: 'record-approval',
      actor: input.actor,
      now: input.now,
      candidate,
      approval: input.record,
      validations,
      approvals,
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    const from = outcome.from
    if (from === null) {
      return {
        ok: false,
        refusal: {
          code: 'cas_conflict',
          message:
            'the transition was decided in no state, so there is nothing to compare and swap',
        },
      }
    }
    const conflict = this.expectedVersionConflict(expected, from)
    if (conflict !== null) return { ok: false, refusal: conflict }
    return this.commit(prepared, outcome.record, {
      kind: 'candidate',
      id: candidate.id,
      expected: from,
      next: outcome.to,
    })
  }

  /** Publish a release. */
  async recordRelease(
    input: EditorialWriteInput<EditorialRelease>,
  ): Promise<EditorialWriteResult<EditorialRelease>> {
    const prepared = await this.prepare(input, 'release')
    if (!prepared.ok) return prepared
    if (prepared.replay !== null) {
      return { ok: true, record: prepared.replay, replayed: true }
    }
    const revision = await this.repository.findRecord(
      'revision',
      input.record.revisionId,
    )
    const candidate = await this.repository.findRecord(
      'candidate',
      input.record.candidateId,
    )
    if (revision === null || revision.kind !== 'revision') {
      return {
        ok: false,
        refusal: {
          code: 'editorial_record_missing',
          message: `the release names a revision the store does not hold: ${input.record.revisionId}`,
        },
      }
    }
    if (candidate === null || candidate.kind !== 'candidate') {
      return {
        ok: false,
        refusal: {
          code: 'editorial_record_missing',
          message: `the release names a candidate the store does not hold: ${input.record.candidateId}`,
        },
      }
    }
    const pin = checkPackagePin(input.record.sourceBinding, this.pins)
    if (!pin.ok) {
      return { ok: false, refusal: { code: pin.code, message: pin.message } }
    }
    const validations = await this.validations()
    const approvals = await this.approvals()
    const releases = await this.releases()
    const supersessions = await this.supersessions()
    const expected = await this.repository.readAggregateState(
      'candidate',
      candidate.id,
    )
    const outcome = applyTransition({
      action: 'record-release',
      actor: input.actor,
      now: input.now,
      revision,
      candidate,
      release: input.record,
      validations,
      approvals,
      releases,
      supersessions,
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    const from = outcome.from
    if (from === null) {
      return {
        ok: false,
        refusal: {
          code: 'cas_conflict',
          message:
            'the transition was decided in no state, so there is nothing to compare and swap',
        },
      }
    }
    const conflict = this.expectedVersionConflict(expected, from)
    if (conflict !== null) return { ok: false, refusal: conflict }
    return this.commit(prepared, outcome.record, {
      kind: 'candidate',
      id: candidate.id,
      expected: from,
      next: 'candidate-released',
    })
  }

  /** Retire a release. */
  async supersedeRelease(
    input: EditorialWriteInput<EditorialSupersession>,
  ): Promise<EditorialWriteResult<EditorialSupersession>> {
    const prepared = await this.prepare(input, 'supersession')
    if (!prepared.ok) return prepared
    if (prepared.replay !== null) {
      return { ok: true, record: prepared.replay, replayed: true }
    }
    const release = await this.repository.findRecord(
      'release',
      input.record.subjectReleaseId,
    )
    if (release === null || release.kind !== 'release') {
      return {
        ok: false,
        refusal: {
          code: 'editorial_record_missing',
          message: `the supersession names a release the store does not hold: ${input.record.subjectReleaseId}`,
        },
      }
    }
    const releases = await this.releases()
    const supersessions = await this.supersessions()
    const expected = await this.repository.readAggregateState(
      'release',
      release.id,
    )
    const outcome = applyTransition({
      action: 'supersede-release',
      actor: input.actor,
      now: input.now,
      release,
      supersession: input.record,
      releases,
      supersessions,
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    const from = outcome.from
    if (from === null) {
      return {
        ok: false,
        refusal: {
          code: 'cas_conflict',
          message:
            'the transition was decided in no state, so there is nothing to compare and swap',
        },
      }
    }
    const conflict = this.expectedVersionConflict(expected, from)
    if (conflict !== null) return { ok: false, refusal: conflict }
    return this.commit(prepared, outcome.record, {
      kind: 'release',
      id: release.id,
      expected: from,
      next: outcome.to,
    })
  }

  /* ------------------------------------------------------------- the reads */

  /**
   * The current release of one target, as the store holds it.
   *
   * It is the *store's* answer. The expanded reader — the one that falls
   * back to the legacy source — is a separate component, because a writer
   * that could see the legacy source would be a writer that could publish
   * something the store never approved.
   */
  async currentReleaseForTarget(
    targetId: string,
  ): Promise<EditorialRelease | null> {
    const releases = await this.releases()
    const supersessions = await this.supersessions()
    return projectCurrentRelease(releases, supersessions, targetId)
  }

  /* ------------------------------------------------------------ the inside */

  /**
   * The preparation of a write: the activation, the replay check and the
   * receipt.
   */
  private async prepare<T extends EditorialRecord>(
    input: EditorialWriteInput<T>,
    kind: EditorialRecordKind,
  ): Promise<WritePreparation<T>> {
    if (!isEditorialActivation(input.activation)) {
      return {
        ok: false,
        refusal: {
          code: 'editorial_writer_inactive',
          message: EDITORIAL_INACTIVE_MESSAGE,
        },
      }
    }
    const fingerprint = idempotencyFingerprint(input.record)
    const actor = editorialActorKey(input.actor)

    if (input.requestKey !== undefined) {
      const receipt = await this.repository.findReceipt({
        actor,
        recordKind: kind,
        requestKey: input.requestKey,
      })
      if (receipt !== null) {
        if (receipt.fingerprint !== fingerprint) {
          return {
            ok: false,
            refusal: {
              code: 'idempotency_key_reused',
              message: `the idempotency key was already used for a different submission of this kind`,
            },
          }
        }
        const stored = await this.repository.findRecord(kind, receipt.recordId)
        if (stored === null) {
          return {
            ok: false,
            refusal: {
              code: 'editorial_record_missing',
              message: `the receipt names a record the store does not hold: ${receipt.recordId}`,
            },
          }
        }
        return { ok: true, replay: stored as T, fingerprint, receipt: null }
      }
    }

    // The same content is the same record: the id is the content's digest.
    // A submission whose record is already stored is a duplicate, and it
    // writes nothing.
    const existing = await this.repository.findRecord(kind, input.record.id)
    if (existing !== null) {
      return { ok: true, replay: existing as T, fingerprint, receipt: null }
    }

    return {
      ok: true,
      replay: null,
      fingerprint,
      receipt:
        input.requestKey === undefined
          ? null
          : {
              actor,
              recordKind: kind,
              requestKey: input.requestKey,
              fingerprint,
              created: input.now,
            },
    }
  }

  /**
   * Whether the aggregate's materialised state disagrees with the
   * transition's `from`.
   *
   * A disagreement means somebody else moved the aggregate between the read
   * and the decision. It is refused, and nothing is written.
   */
  private expectedVersionConflict(
    expected: string | null,
    from: string | null,
  ): EditorialWriterRefusal | null {
    if (expected === from) return null
    return {
      code: 'cas_conflict',
      message: `the aggregate is in state ${expected ?? 'absent'} and the transition was decided in ${from ?? 'absent'}: somebody moved it first, so nothing was written`,
    }
  }

  /** The write itself: one batch, one transaction. */
  private async commit<T extends EditorialRecord>(
    prepared: { receipt: EditorialReceiptInput | null },
    record: EditorialRecord,
    transition: EditorialAggregateTransition | undefined,
  ): Promise<EditorialWriteResult<T>> {
    const outcome = await this.repository.append({
      record,
      ...(transition === undefined ? {} : { transition }),
      ...(prepared.receipt === null ? {} : { receipt: prepared.receipt }),
    })
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal }
    return { ok: true, record: record as T, replayed: false }
  }

  /* ------------------------------------------------------------- the reads */

  private async decisions(): Promise<EditorialDecision[]> {
    const records = await this.repository.listRecords('decision')
    return records.filter(
      (record): record is EditorialDecision => record.kind === 'decision',
    )
  }

  private async validations(): Promise<EditorialValidation[]> {
    const records = await this.repository.listRecords('validation')
    return records.filter(
      (record): record is EditorialValidation => record.kind === 'validation',
    )
  }

  private async approvals(): Promise<EditorialApproval[]> {
    const records = await this.repository.listRecords('approval')
    return records.filter(
      (record): record is EditorialApproval => record.kind === 'approval',
    )
  }

  private async releases(): Promise<EditorialRelease[]> {
    const records = await this.repository.listRecords('release')
    return records.filter(
      (record): record is EditorialRelease => record.kind === 'release',
    )
  }

  private async supersessions(): Promise<EditorialSupersession[]> {
    const records = await this.repository.listRecords('supersession')
    return records.filter(
      (record): record is EditorialSupersession =>
        record.kind === 'supersession',
    )
  }
}

/**
 * The writer's own view of the store, for a reader that does not write.
 *
 * It exists so a caller that only reads does not have to hold a writer, and
 * therefore does not have to hold an activation.
 */
export type EditorialReader = Pick<
  InactiveEditorialWriter,
  'currentReleaseForTarget'
>
