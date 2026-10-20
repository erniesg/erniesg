/**
 * The slice of the D1 client the editorial store uses, typed structurally.
 *
 * It is the same slice `src/worker/margin/d1.ts` declares, restated here
 * rather than imported: the editorial store is a **separate database** with a
 * separate binding, and E-05c may not touch `src/worker/**`. Importing the
 * margin module would also couple the two stores' types, which is exactly the
 * coupling the separate database exists to avoid (§1.1 of the design record).
 *
 * The slice is deliberately small: `prepare`, `bind`, `all`, `first`, `run` and
 * an atomic `batch`. Everything the store needs is in it, and nothing in it
 * mentions Cloudflare's types, so the repository type-checks without pulling
 * `@cloudflare/workers-types` into the graph.
 */

/** What a D1 statement reports about the rows it touched. */
export type D1Meta = {
  changes?: number
  last_row_id?: number
}

/** The result of a D1 statement. */
export type D1Result<T = Record<string, unknown>> = {
  results: T[]
  success: boolean
  meta?: D1Meta
}

/** A prepared D1 statement. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result<never>>
}

/** The D1 database the editorial store talks to. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement
  /**
   * D1 executes a batch atomically: every statement commits, or none does.
   *
   * The editorial store depends on it. The record, the aggregate's state
   * change and the idempotency receipt are one batch, and the batch is the
   * only reason a reader never sees half a write.
   */
  batch?<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>
}

/** Whether a value is a D1 database. */
export function isD1Database(value: unknown): value is D1Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as D1Database).prepare === 'function'
  )
}

/** The value a D1 parameter may take. */
export type D1Value = string | number | null
