/**
 * The slice of the D1 client margin uses, typed structurally.
 *
 * `src/worker/env.ts` already avoids pulling `@cloudflare/workers-types` into
 * the Astro type-check graph for two bindings, and this keeps that true. It
 * also means the SQLite-backed double in `margin-database.ts` is a real
 * implementation of the same type rather than a cast.
 */

export type D1Meta = {
  changes?: number
  last_row_id?: number
}

export type D1Result<T = Record<string, unknown>> = {
  results: T[]
  success: boolean
  meta?: D1Meta
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result<never>>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
}

export function isD1Database(value: unknown): value is D1Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as D1Database).prepare === 'function'
  )
}
