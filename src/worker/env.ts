/**
 * Bindings the Worker entry point receives from Wrangler.
 *
 * Typed structurally so the Worker does not pull `@cloudflare/workers-types`
 * into the Astro type-check graph for two bindings. Issue 054 is the first
 * consumer of `MARGIN_DB` and can give it a real `D1Database` type then.
 */
export type AssetFetcher = {
  fetch(request: Request): Promise<Response>
}

export type WorkerEnv = {
  /** Static asset binding. Everything the Worker does not handle goes here. */
  ASSETS: AssetFetcher
  /** `margin-db` in production, `margin-db-stg` in preview. Unused so far. */
  MARGIN_DB?: unknown
  /** Dev-only principal stub. See `getPrincipal`; 055 replaces it. */
  MARGIN_DEV_PRINCIPAL?: string
}
