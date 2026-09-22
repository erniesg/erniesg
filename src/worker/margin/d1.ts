/**
 * The slice of the D1 API the margin service uses.
 *
 * Typed structurally, for the same reason `src/worker/env.ts` is: the Worker
 * must not drag `@cloudflare/workers-types` into the Astro type-check graph.
 * A real `D1Database` satisfies this shape.
 */

export type D1Value = string | number | null

export type D1PreparedStatement = {
  bind(...values: D1Value[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<unknown>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

export type D1Like = {
  prepare(query: string): D1PreparedStatement
}
