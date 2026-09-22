import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Result } from './d1'

/**
 * A real SQLite implementation of the D1 slice margin uses, over `node:sqlite`.
 *
 * It exists so the tests can run the production statements against the
 * production migration rather than against a hand-written stand-in. The
 * visibility proof depends on that: asserting that a non-owner's query cannot
 * return someone else's private row is only worth anything if a genuine SQL
 * engine is the one deciding.
 *
 * It also records every statement it executes, which is how the tests show
 * that a list request runs one scoped query and no unscoped follow-up.
 */

export type ExecutedStatement = { sql: string; params: unknown[] }

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'migrations')

/** Applies `migrations/*.sql` in filename order, the way Wrangler does. */
export function applyMigrations(database: DatabaseSync): string[] {
  const files = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  for (const file of files) {
    database.exec(readFileSync(join(MIGRATIONS_DIRECTORY, file), 'utf8'))
  }
  return files
}

class SqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly owner: SqliteD1Database,
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
    const changes = this.owner.execute(this.sql, this.params)
    return { results: [], success: true, meta: { changes } }
  }
}

export class SqliteD1Database implements D1Database {
  readonly executed: ExecutedStatement[] = []

  constructor(private readonly database: DatabaseSync) {}

  static inMemory(): SqliteD1Database {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    return new SqliteD1Database(database)
  }

  prepare(query: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this, query, [])
  }

  /** Statements run outside the repository, for seeding and for assertions. */
  query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    this.executed.push({ sql, params })
    return this.database.prepare(sql).all(...(params as never[])) as Record<
      string,
      unknown
    >[]
  }

  execute(sql: string, params: unknown[] = []): number {
    this.executed.push({ sql, params })
    const result = this.database.prepare(sql).run(...(params as never[]))
    return Number(result.changes)
  }

  reads(): ExecutedStatement[] {
    return this.executed.filter((entry) =>
      entry.sql.trimStart().toUpperCase().startsWith('SELECT'),
    )
  }
}
