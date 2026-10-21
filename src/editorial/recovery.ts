/**
 * The rollback and forward-recovery rehearsal.
 *
 * ## What is rehearsed
 *
 * The cutover is a change of authority: before it the legacy source is
 * authoritative, after it the editorial store is. A rehearsal of the two
 * directions is what makes the change safe to make, because both directions
 * are exercised on **representative pre-switch and post-switch records**
 * before either is needed in anger.
 *
 * - **Rollback.** The cutover is undone. The reader stops consulting the
 *   store and serves the legacy source again, and the post-switch records
 *   are not served. Nothing is deleted: the store still holds them, which
 *   is what makes the rollback recoverable rather than destructive.
 * - **Forward recovery.** The cutover is re-made. The reader serves the
 *   store again, and the records the backfill has not copied yet are still
 *   served from the legacy source — the reader is expanded, so it is
 *   correct in both directions at once.
 *
 * ## The unsafe package downgrade
 *
 * The rehearsal also proves that a **downgrade is refused**. The app's
 * approved package pins are an ordered registry, and a source binding that
 * names a pin older than the current one would publish the pipeline's
 * output under an older Struct. The writer refuses such a candidate, and
 * the refusal writes nothing.
 *
 * The rehearsal moves the registry forward — the app is re-pinned — and then
 * offers a candidate cut under the pin that was current before. That is the
 * shape of the accident this refuses: not a forged pin, but a *stale* one.
 */
import type { EditorialActivation } from './activation'
import type { EditorialExpandedReader, EditorialReadAnswer } from './expanded-reader'
import type { LegacyPublicationSource } from './migration'
import type { ApprovedPackagePin, PackagePinRegistry } from './package-pin'
import type {
  EditorialCandidate,
  EditorialRecord,
  EditorialRelease,
  EditorialRevision,
} from './records'
import type { EditorialRepository } from './repository'
import type { InactiveEditorialWriter } from './writer'

/** One reader answer, as the rehearsal records it. */
export type RecoveryAnswer = {
  releaseId: string | null
  source: 'store' | 'legacy' | null
}

/** The evidence one rehearsal produces. */
export type EditorialRecoveryEvidence = {
  /** What the reader served while the cutover was in force. */
  beforeRollback: RecoveryAnswer
  /** What the reader served after the cutover was undone. */
  afterRollback: RecoveryAnswer
  /** What the reader served after the cutover was re-made. */
  afterForwardRecovery: RecoveryAnswer
  /** How many records the store held before the rollback. */
  recordsBeforeRollback: number
  /** How many records the store held after the rollback. */
  recordsAfterRollback: number
  /** The refusal an unsafe package downgrade produced. */
  downgrade: {
    refused: boolean
    code: string | null
    message: string | null
  }
}

/** What the rehearsal needs. */
export type EditorialRecoveryInput = {
  /** The store. */
  repository: EditorialRepository
  /** The expanded reader. */
  reader: EditorialExpandedReader
  /** The legacy source: the pre-switch records. */
  source: LegacyPublicationSource
  /** The inactive writer. */
  writer: InactiveEditorialWriter
  /** The approved package pins. The rehearsal re-pins it. */
  registry: PackagePinRegistry
  /** The activation the rehearsal writes with. */
  activation: EditorialActivation
  /** The target both the pre-switch and the post-switch records publish to. */
  targetId: string
  /** The writer's clock. */
  now: string
  /**
   * The pin the app is re-pinned to.
   *
   * The rehearsal adds it to the registry, so every pin before it becomes
   * older — which is what makes a downgrade a downgrade.
   */
  newerPin: ApprovedPackagePin
  /**
   * The revision cut under the pin that is about to become older.
   *
   * It is expected to be in the store already: the backfill put it there.
   */
  downgradeRevision: EditorialRevision
  /**
   * The candidate cut under that revision.
   *
   * It must differ from any candidate the store already holds, or the
   * writer would answer it as a replay rather than as a refusal.
   */
  downgradeCandidate: EditorialCandidate
}

/** How many records the store holds. */
async function countRecords(
  repository: EditorialRepository,
): Promise<number> {
  const kinds = [
    'revision',
    'decision',
    'candidate',
    'validation',
    'approval',
    'release',
    'supersession',
  ] as const
  let total = 0
  for (const kind of kinds) {
    total += (await repository.listRecords(kind)).length
  }
  return total
}

/** An answer, as the rehearsal records it. */
function answerOf(answer: EditorialReadAnswer): RecoveryAnswer {
  return {
    releaseId: answer.release === null ? null : answer.release.id,
    source: answer.source,
  }
}

/**
 * Rehearse the rollback and the forward recovery.
 *
 * It changes two things in the system and puts both back the way it found
 * them: the cutover switch (which it moves to rolled back and back to
 * switched) and the package pin registry (which it adds the newer pin to).
 * The second is not put back, because a re-pin is not something a rehearsal
 * may undo: the app is pinned to a newer Struct, and the older pin is older
 * from then on.
 */
export async function rehearseEditorialRecovery(
  input: EditorialRecoveryInput,
): Promise<EditorialRecoveryEvidence> {
  const switchedAt = input.now
  const rolledBackAt = input.now

  // The cutover is in force: the store is authoritative.
  await input.repository.writeSwitchState({
    switchedAt,
    rolledBackAt: null,
  })
  const beforeRollback = answerOf(
    await input.reader.currentReleaseForTarget(input.targetId),
  )
  const recordsBeforeRollback = await countRecords(input.repository)

  // The rollback: the cutover is undone and the legacy source is
  // authoritative again.
  await input.repository.writeSwitchState({ switchedAt, rolledBackAt })
  const afterRollback = answerOf(
    await input.reader.currentReleaseForTarget(input.targetId),
  )
  const recordsAfterRollback = await countRecords(input.repository)

  // The forward recovery: the cutover is re-made.
  await input.repository.writeSwitchState({ switchedAt, rolledBackAt: null })
  const afterForwardRecovery = answerOf(
    await input.reader.currentReleaseForTarget(input.targetId),
  )

  // The unsafe package downgrade. The app is re-pinned, so every pin before
  // the new one is older, and a candidate cut under one of them would move
  // the pipeline backwards.
  input.registry.pins = [...input.registry.pins, input.newerPin]
  const refused = await input.writer.assembleCandidate({
    activation: input.activation,
    actor: input.downgradeCandidate.author,
    now: input.now,
    record: input.downgradeCandidate,
  })

  return {
    beforeRollback,
    afterRollback,
    afterForwardRecovery,
    recordsBeforeRollback,
    recordsAfterRollback,
    downgrade: refused.ok
      ? { refused: false, code: null, message: null }
      : {
          refused: true,
          code: refused.refusal.code,
          message: refused.refusal.message,
        },
  }
}

/**
 * The records the rehearsal needs from the legacy source.
 *
 * It is the pre-switch record set, in the shape the backfill copies.
 */
export type RecoveryRecords = {
  /** Every record of the legacy source. */
  legacy: readonly EditorialRecord[]
  /** The current release of the target, as the legacy source sees it. */
  preSwitchRelease: EditorialRelease | null
}
