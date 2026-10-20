/**
 * The migration scheme of the editorial store, and the backfill it carries.
 *
 * ## The scheme
 *
 * The app's scheme: `NNNN_snake_case_subject.sql`, four digits, sequential
 * from `0001`, applied in filename order, **forward-only**. There are no
 * down migrations. A destructive change is a new table, a backfill and a
 * read expansion; the old thing is dropped by a later numbered file, once
 * nothing reads it.
 *
 * The editorial store's migrations live in `migrations/editorial/`, their
 * own directory, because the editorial store is a **separate database** with
 * a separate binding and its own `migrations_dir`. The Wrangler runner for
 * `MARGIN_DB` reads `migrations/*.sql` and the margin test harness applies
 * every `migrations/*.sql` in filename order; a *directory* is neither, so
 * the editorial DDL cannot land in the margin database by accident.
 *
 * ## The ledger
 *
 * `editorial_schema_migrations` is the runner's own table: it records which
 * numbered files have been applied. It is created by the runner itself
 * rather than by a migration file, because the runner has to know what is
 * applied before it can decide what to apply.
 *
 * ## The backfill
 *
 * The backfill copies the legacy source's records into the store, in
 * dependency order, in bounded batches, and records its cursor after every
 * batch. It is therefore **interruptible** (a run that stops leaves a
 * cursor) and **resumable** (the next run continues from the cursor), and
 * the expanded reader is correct throughout: a record is either in the
 * legacy source or in the store, never half in each.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type {
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
import type { EditorialRepository } from './repository'
import {
  projectCandidateState,
  projectReleaseState,
  projectRevisionState,
} from './validation'

/** The numbered migrations of the editorial store, in apply order. */
export const EDITORIAL_MIGRATION_FILES = [
  '0001_editorial_store.sql',
  '0002_editorial_control.sql',
] as const

export type EditorialMigrationFile = (typeof EDITORIAL_MIGRATION_FILES)[number]

/** The directory the numbered migrations live in. */
export const EDITORIAL_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../migrations/editorial/', import.meta.url),
)

/**
 * The connection the migration runner needs.
 *
 * It is `node:sqlite`'s own shape, stated structurally so this module does
 * not import `node:sqlite` and stays out of any Worker bundle.
 */
export interface MigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint }
    all(...params: unknown[]): Record<string, unknown>[]
  }
}

/** The ledger of the applied migrations. */
const LEDGER = 'editorial_schema_migrations'

/**
 * Apply the migrations that have not been applied.
 *
 * It returns the names it applied. Applying it twice applies nothing the
 * second time: the ledger says what is already there.
 */
export function applyEditorialMigrations(
  database: MigrationDatabase,
): string[] {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       version TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  )
  const applied = new Set(appliedEditorialMigrations(database))
  const ran: string[] = []
  for (const file of EDITORIAL_MIGRATION_FILES) {
    if (applied.has(file)) continue
    const sql = readFileSync(
      `${EDITORIAL_MIGRATIONS_DIRECTORY}${file}`,
      'utf8',
    )
    database.exec(sql)
    database.prepare(
      `INSERT INTO ${LEDGER} (version, applied_at) VALUES (?, datetime('now'))`,
    ).run(file)
    ran.push(file)
  }
  return ran
}

/** The migrations that have been applied, in apply order. */
export function appliedEditorialMigrations(
  database: MigrationDatabase,
): string[] {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       version TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  )
  return database
    .prepare(`SELECT version FROM ${LEDGER} ORDER BY version`)
    .all()
    .map((row) => String(row.version))
}

/* ------------------------------------------------------------------ backfill */

/**
 * The order the backfill copies the records in.
 *
 * It is the **dependency order**: a revision before the decision about it, a
 * decision before the candidate it authorises, a candidate before the
 * validations and the approval about it, and a release last, after
 * everything it binds. A reader that finds a release in the store therefore
 * finds its whole chain beside it, and never a release whose approval has
 * not arrived yet.
 *
 * The supersessions come after the releases, because a supersession is a
 * *transition* of a release: the release row is created and the supersession
 * moves it out of `release-released`.
 */
export const EDITORIAL_BACKFILL_ORDER: readonly EditorialRecordKind[] = [
  'revision',
  'decision',
  'candidate',
  'validation',
  'approval',
  'release',
  'supersession',
]

/** The legacy source the backfill copies from. */
export interface LegacyPublicationSource {
  /**
   * Every record the legacy source holds.
   *
   * The order does not matter: the backfill sorts the records into the
   * dependency order itself, so the source only has to be *stable*.
   */
  listRecords(): Promise<EditorialRecord[]>

  /**
   * The current release of one target, as the legacy source sees it.
   *
   * It is the fallback of the expanded reader: when the store has no
   * current release for the target, this is what the reader serves.
   */
  currentReleaseForTarget(targetId: string): Promise<EditorialRelease | null>
}

/** The cursor of a record: its kind and its id. */
export function backfillCursorOf(record: EditorialRecord): string {
  return `${record.kind}:${record.id}`
}

/** The records of a legacy source, in the backfill's dependency order. */
export function orderedBackfillRecords(
  records: readonly EditorialRecord[],
): EditorialRecord[] {
  return [...records].sort((left, right) => {
    const leftRank = EDITORIAL_BACKFILL_ORDER.indexOf(left.kind)
    const rightRank = EDITORIAL_BACKFILL_ORDER.indexOf(right.kind)
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/** How the backfill may be run. */
export type EditorialBackfillOptions = {
  /** The records to copy. */
  source: LegacyPublicationSource
  /** The store to copy them into. */
  repository: EditorialRepository
  /** The name of the backfill, for the progress cursor. */
  name: string
  /** How many records one batch copies. */
  batchSize?: number
  /**
   * How many batches to run.
   *
   * `undefined` runs them all. A finite number is how a rehearsal
   * interrupts the backfill and shows that it resumes.
   */
  maxBatches?: number
}

/** What one backfill run did. */
export type EditorialBackfillResult = {
  /** How many records were copied. */
  migrated: number
  /** The cursor the run stopped at. */
  cursor: string | null
  /** Whether every record of the source has been copied. */
  complete: boolean
  /** How many records the source holds in total. */
  total: number
}

/** The default number of records one backfill batch copies. */
export const DEFAULT_BACKFILL_BATCH_SIZE = 32

/**
 * The materialised state every record of a legacy source is restored with.
 *
 * The backfill restores **history**, so the state a row is created with is
 * the *projected* state of the whole legacy record set, not the state a new
 * record starts in. A revision that was approved before the cutover is
 * restored as `revision-approved`; a release that was superseded before the
 * cutover is restored as `release-superseded`, so the store's partial
 * unique index — one current release per target — holds over the restored
 * set exactly as it holds over a live one.
 *
 * The projection is E05a's own (`validation.ts`), so the restored column and
 * the restored projection cannot disagree about what the history says.
 */
export function backfillInitialStates(
  records: readonly EditorialRecord[],
): Map<string, string> {
  const revisions = records.filter(
    (record): record is EditorialRevision => record.kind === 'revision',
  )
  const decisions = records.filter(
    (record): record is EditorialDecision => record.kind === 'decision',
  )
  const candidates = records.filter(
    (record): record is EditorialCandidate => record.kind === 'candidate',
  )
  const validations = records.filter(
    (record): record is EditorialValidation => record.kind === 'validation',
  )
  const approvals = records.filter(
    (record): record is EditorialApproval => record.kind === 'approval',
  )
  const releases = records.filter(
    (record): record is EditorialRelease => record.kind === 'release',
  )
  const supersessions = records.filter(
    (record): record is EditorialSupersession => record.kind === 'supersession',
  )
  const states = new Map<string, string>()
  for (const revision of revisions) {
    states.set(revision.id, projectRevisionState(revision, decisions))
  }
  for (const candidate of candidates) {
    states.set(
      candidate.id,
      projectCandidateState(candidate, validations, approvals, releases),
    )
  }
  for (const release of releases) {
    states.set(release.id, projectReleaseState(release, supersessions))
  }
  return states
}

/**
 * Run the backfill, or part of it.
 *
 * A record that is already in the store is not copied again: the store's
 * primary key is the record's content-addressed id, so a resumed backfill
 * converges on the same rows.
 */
export async function runEditorialBackfill(
  options: EditorialBackfillOptions,
): Promise<EditorialBackfillResult> {
  const batchSize = options.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE
  const records = orderedBackfillRecords(await options.source.listRecords())
  const states = backfillInitialStates(records)
  const cursor = await options.repository.readBackfillProgress(options.name)
  const start = 0

  let migrated = 0
  let position = start
  let lastCursor: string | null = cursor
  let batches = 0
  while (position < records.length) {
    if (options.maxBatches !== undefined && batches >= options.maxBatches) {
      break
    }
    const batch = records.slice(position, position + batchSize)
    for (const record of batch) {
      const existing = await options.repository.findRecord(
        record.kind,
        record.id,
      )
      if (existing !== null) continue
      const initialState = states.get(record.id)
      const outcome = await options.repository.append({
        record,
        ...(initialState === undefined ? {} : { initialState }),
      })
      if (!outcome.ok) {
        // A refused append stops the backfill. The cursor stays where it
        // was, so the next run tries the same record again.
        return {
          migrated,
          cursor: lastCursor,
          complete: false,
          total: records.length,
        }
      }
      migrated += 1
    }
    position += batch.length
    const last = batch[batch.length - 1]
    if (last !== undefined) {
      lastCursor = backfillCursorOf(last)
      await options.repository.writeBackfillProgress(options.name, lastCursor)
    }
    batches += 1
  }

  return {
    migrated,
    cursor: lastCursor,
    complete: position >= records.length,
    total: records.length,
  }
}

/** The index just after the record a cursor names. */
function indexAfterCursor(
  records: readonly EditorialRecord[],
  cursor: string,
): number {
  const index = records.findIndex(
    (record) => backfillCursorOf(record) === cursor,
  )
  if (index === -1) return 0
  return index + 1
}
