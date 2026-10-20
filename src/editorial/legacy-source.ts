/**
 * The legacy publication source: what the editorial store is filled *from*.
 *
 * ## What it is
 *
 * Before the cutover, the production side of the app published on its own.
 * The editorial store is being filled beside it, and this interface is the
 * seam between the two: the **legacy source** is whatever the pre-cutover
 * side holds, and the backfill copies from it into the store.
 *
 * For E05c the legacy source is a **fixture** — a fixed set of representative
 * pre-switch records — because the production writer is unchanged and E-05c
 * may not run it or read its output. The interface is the seam: when the
 * cutover is authorised, the production side supplies a real implementation
 * of exactly this interface, and the backfill, the expanded reader and the
 * recovery rehearsal do not change.
 *
 * ## Why the reader falls back to it
 *
 * The expanded reader (§8.2) consults the store first and the legacy source
 * second, so the fallback is there from the day the store exists. The
 * fallback is what makes "the production writer is unchanged" true rather
 * than merely asserted: the production writer keeps writing where it
 * writes, and the new store is filled beside it.
 */
import type { EditorialRecord, EditorialRelease, EditorialSupersession } from './records'
import type { LegacyPublicationSource } from './migration'
import { currentReleaseForTarget as projectCurrentRelease } from './validation'

/**
 * A legacy source over a fixed set of records.
 *
 * It is stable: it returns the same records every time, in the same order.
 * The backfill depends on that — its cursor names a record, and the next run
 * has to find the same record again.
 */
export function staticLegacySource(
  records: readonly EditorialRecord[],
): LegacyPublicationSource {
  const held = [...records]
  return {
    async listRecords(): Promise<EditorialRecord[]> {
      return [...held]
    },
    async currentReleaseForTarget(
      targetId: string,
    ): Promise<EditorialRelease | null> {
      const releases = held.filter(
        (record): record is EditorialRelease => record.kind === 'release',
      )
      const supersessions = held.filter(
        (record): record is EditorialSupersession =>
          record.kind === 'supersession',
      )
      return projectCurrentRelease(releases, supersessions, targetId)
    },
  }
}
