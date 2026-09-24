import type { D1Database } from './margin/d1'

/**
 * Bindings the Worker entry point receives from Wrangler.
 *
 * Typed structurally so the Worker does not pull `@cloudflare/workers-types`
 * into the Astro type-check graph for three bindings. `MARGIN_DB` is the slice
 * of D1 margin actually calls, declared in `./margin/d1`.
 */
export type AssetFetcher = {
  fetch(request: Request): Promise<Response>
}

export type WorkerEnv = {
  /** Static asset binding. Everything the Worker does not handle goes here. */
  ASSETS: AssetFetcher
  /** `margin-db` in production, `margin-db-stg` in preview. */
  MARGIN_DB?: D1Database
  /** Dev-only principal stub. See `getPrincipal`; 055 replaces it. */
  MARGIN_DEV_PRINCIPAL?: string
}
