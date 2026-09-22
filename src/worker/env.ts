import type { D1Like } from './margin/d1'
import type { WorkosEnv } from './margin/config'

/**
 * Bindings the Worker entry point receives from Wrangler.
 *
 * Typed structurally so the Worker does not pull `@cloudflare/workers-types`
 * into the Astro type-check graph. Every `WORKOS_*` value is a secret held in
 * the Cloudflare secret store (`wrangler secret put`) and appears in this
 * repository by name only.
 */
export type AssetFetcher = {
  fetch(request: Request): Promise<Response>
}

/**
 * Which deployment this is. Set as a plain var in the Wrangler configs.
 *
 * Anything other than the exact string `development` disables the principal
 * stub, so an unset value fails closed and a production build cannot reach it.
 */
export const DEVELOPMENT_ENVIRONMENT = 'development'

export type WorkerEnv = WorkosEnv & {
  /** Static asset binding. Everything the Worker does not handle goes here. */
  ASSETS: AssetFetcher
  /** `margin-db` in production, `margin-db-stg` in preview. */
  MARGIN_DB?: D1Like
  /** `development`, `staging` or `production`. Absent means production. */
  MARGIN_ENVIRONMENT?: string
  /** Principal stub, reachable only when `MARGIN_ENVIRONMENT=development`. */
  MARGIN_DEV_PRINCIPAL?: string
}
