/**
 * The expanded reader.
 *
 * ## What it is
 *
 * A reader that consults the **new store** *and* the **legacy source**, and
 * prefers the new one:
 *
 * 1. read the current release for the target from the editorial store;
 * 2. if there is none, fall back to the legacy source;
 * 3. once the new store has a current release for the target, the legacy
 *    source is not consulted for that target any more.
 *
 * That is §8.2 of the design record, and it is the reader that makes "the
 * production writer is unchanged" true: the production writer keeps writing
 * where it writes, and the new store is filled beside it.
 *
 * ## Why it is correct during a backfill
 *
 * The backfill copies whole records, in dependency order, one transaction at
 * a time. So a record is either in the legacy source or in the store — never
 * half in each — and the reader's answer for a target is either the legacy
 * record or the migrated record, and never a mixture. The reader is
 * *observationally transparent*: the record it returns for a target is the
 * same record before and after that target's row is migrated, because the
 * copy is verbatim and the id is the content's digest.
 *
 * ## The three modes
 *
 * - `expanded` — the store first, the legacy source second. This is the
 *   reader of the day the store exists.
 * - `store-only` — the narrowed reader. Narrowing is the act of activation,
 *   and it is a separate, explicitly authorised one.
 * - `legacy-only` — the rolled-back reader. The cutover was undone, so the
 *   store is not consulted at all.
 *
 * The mode is not a parameter a caller passes: it is the **durable** state
 * of the cutover switch, so a rollback is a fact about the system and not a
 * decision one caller makes for another.
 */
import type { EditorialRelease } from './records'
import type { LegacyPublicationSource } from './migration'
import {
  readModeOf,
  type EditorialReadMode,
  type EditorialRepository,
} from './repository'
import { currentReleaseForTarget as projectCurrentRelease } from './validation'

/** Which source an answer came from. */
export type EditorialReadSource = 'store' | 'legacy'

/** One answer of the reader, and where it came from. */
export type EditorialReadAnswer = {
  release: EditorialRelease | null
  source: EditorialReadSource | null
}

/** The expanded reader. */
export interface EditorialExpandedReader {
  /** The current release of one target, and where it came from. */
  currentReleaseForTarget(targetId: string): Promise<EditorialReadAnswer>
  /** The mode the reader is in right now. */
  mode(): Promise<EditorialReadMode>
}

/**
 * Build the expanded reader over a store and a legacy source.
 */
export function createExpandedReader(input: {
  repository: EditorialRepository
  source: LegacyPublicationSource
}): EditorialExpandedReader {
  return {
    async mode(): Promise<EditorialReadMode> {
      return readModeOf(await input.repository.readSwitchState())
    },

    async currentReleaseForTarget(
      targetId: string,
    ): Promise<EditorialReadAnswer> {
      const mode = readModeOf(await input.repository.readSwitchState())

      if (mode !== 'legacy-only') {
        const releases = await input.repository.listRecords('release')
        const supersessions = await input.repository.listRecords(
          'supersession',
        )
        const current = projectCurrentRelease(
          releases.filter(
            (record): record is EditorialRelease =>
              record.kind === 'release',
          ),
          supersessions.filter(
            (record) => record.kind === 'supersession',
          ),
          targetId,
        )
        if (current !== null) {
          // The store has a current release for the target: the legacy
          // source is not consulted for it any more.
          return { release: current, source: 'store' }
        }
      }

      if (mode === 'store-only') {
        return { release: null, source: null }
      }

      const legacy = await input.source.currentReleaseForTarget(targetId)
      return { release: legacy, source: legacy === null ? null : 'legacy' }
    },
  }
}
