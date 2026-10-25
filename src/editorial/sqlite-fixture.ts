/**
 * The durable SQLite fixture the editorial store is exercised against.
 *
 * It is the same shape as `src/worker/margin/sqlite-database.ts`: a real
 * SQLite engine behind the D1 slice, so the statements the store runs are
 * the statements a genuine SQL engine decides. The compare-and-swap proof
 * depends on that — asserting that a stale expected version writes nothing
 * is only worth anything if the database, not a mock, is what declines.
 *
 * ## Why it is a *file* and not `:memory:`
 *
 * An in-memory database proves nothing about durability: a reader that opens
 * a second connection sees nothing. The fixture here is a **file**, so:
 *
 * - a second connection to the same file sees the committed rows, which is
 *   what "durable" means;
 * - the file survives the close of the first connection, so a test can
 *   close, reopen and read back;
 * - an interrupted run leaves a real file behind, which is what the
 *   backfill's resumability is about.
 *
 * The file lives in a temporary directory the fixture owns and removes when
 * it is cleaned up, so a test never leaves anything behind and never reads
 * a database it did not create.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { applyEditorialMigrations } from './migration'
import type { D1Database, D1PreparedStatement, D1Result } from './d1'

/** One statement the fixture executed. */
export type ExecutedStatement = { sql: string; params: unknown[] }

class SqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly owner: SqliteEditorialDatabase,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlitePreparedStatement(this.owner, this.sql, values)
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.owner.query(this.sql, this.params) as T[]
    return { results, success: true }
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { results } = await this.all<T>()
    return results[0] ?? null
  }

  async run(): Promise<D1Result<never>> {
    return this.runSynchronously()
  }

  runSynchronously(): D1Result<never> {
    const changes = this.owner.execute(this.sql, this.params)
    return { results: [], success: true, meta: { changes } }
  }
}

/** A SQLite database behind the D1 slice the editorial store uses. */
export class SqliteEditorialDatabase implements D1Database {
  readonly executed: ExecutedStatement[] = []

  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this, query, [])
  }

  /**
   * Run the statements in one transaction.
   *
   * D1's `batch()` commits all of them or none of them, and the store's
   * atomicity depends on it: the record, the state change and the receipt
   * are one unit.
   */
  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.database.exec('BEGIN')
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqlitePreparedStatement)) {
          throw new Error('SQLite batches require SQLite prepared statements')
        }
        return statement.runSynchronously() as D1Result<T>
      })
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Statements run outside the store, for seeding and for assertions. */
  query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    this.executed.push({ sql, params })
    return this.database.prepare(sql).all(...(params as never[])) as Record<
      string,
      unknown
    >[]
  }

  /** Run a statement and report how many rows it touched. */
  execute(sql: string, params: unknown[] = []): number {
    this.executed.push({ sql, params })
    const result = this.database.prepare(sql).run(...(params as never[]))
    return Number(result.changes)
  }

  /** The read statements the fixture ran. */
  reads(): ExecutedStatement[] {
    return this.executed.filter((entry) =>
      entry.sql.trimStart().toUpperCase().startsWith('SELECT'),
    )
  }

  /** The raw connection, for the statements the store does not own. */
  raw(): DatabaseSync {
    return this.database
  }
}

/** A durable editorial fixture: a file, and the connections to it. */
export type EditorialFixture = {
  /** The D1 slice over the fixture's file. */
  readonly database: SqliteEditorialDatabase
  /** The file the fixture lives in. */
  readonly path: string
  /** The directory the fixture owns. */
  readonly directory: string
  /** Close this connection. The file stays. */
  close(): void
  /** A second connection to the same file. */
  reopen(): SqliteEditorialDatabase
  /** Close and remove the fixture's directory. */
  cleanup(): void
}

/**
 * Open a durable editorial fixture.
 *
 * `applyMigrations` runs the store's numbered migrations first; the default
 * is `true`, because a store without its schema is not a store.
 */
export function openEditorialFixture(options?: {
  /** The directory to create the file in. A temporary one by default. */
  directory?: string
  /** The file's name. `editorial.sqlite` by default. */
  fileName?: string
  /** Whether to apply the numbered migrations. */
  applyMigrations?: boolean
}): EditorialFixture {
  const directory =
    options?.directory ?? mkdtempSync(join(tmpdir(), 'editorial-store-'))
  const path = join(directory, options?.fileName ?? 'editorial.sqlite')
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = ON')
  if (options?.applyMigrations !== false) {
    applyEditorialMigrations(database)
  }
  const connection = new SqliteEditorialDatabase(database)
  return {
    database: connection,
    path,
    directory,
    close: () => database.close(),
    reopen: () => {
      const second = new DatabaseSync(path)
      second.exec('PRAGMA foreign_keys = ON')
      return new SqliteEditorialDatabase(second)
    },
    cleanup: () => {
      try {
        database.close()
      } catch {
        // The connection may already be closed; the directory still goes.
      }
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Run a body against a durable fixture, and clean up afterwards.
 *
 * The body may open more connections to the same file; they are closed when
 * the fixture is cleaned up.
 */
export async function withEditorialFixture(
  body: (fixture: EditorialFixture) => Promise<void>,
): Promise<void> {
  const fixture = openEditorialFixture()
  try {
    await body(fixture)
  } finally {
    fixture.cleanup()
  }
}
