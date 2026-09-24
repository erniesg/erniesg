import type { WorkerEnv } from './env'
import { isD1Database } from './margin/d1'
import { D1MarginRepository } from './margin/d1-repository'
import { handleMarginRequest, MARGIN_API_PREFIX } from './margin/routes'
import { getPrincipal } from './principal'

export { MARGIN_API_PREFIX }
export const MARGIN_HEALTH_PATH = `${MARGIN_API_PREFIX}/health`

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: JSON_HEADERS,
  })
}

/**
 * The Worker entry point for ernie.sg.
 *
 * It owns the margin API prefix and hands every other request straight to the
 * static asset binding, unchanged. Wrangler's `run_worker_first` list scopes
 * the Worker to `/api/margin/v1/*`, so existing pages never reach this handler
 * at all and are served exactly as they were before `main` was added. The
 * asset fallthrough below keeps that true for any request that does arrive
 * here.
 *
 * This function is the whole composition root: it resolves the caller through
 * the `getPrincipal` seam, wraps the D1 binding in the repository, and hands
 * both to the route table. Nothing downstream of `handleMarginRequest` knows
 * that storage is D1.
 *
 * Health is answered here rather than in the route table because it reports
 * whether the Worker is running, which is a question that must still have an
 * answer when the database binding is the thing that is missing.
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url)
    const withinMargin =
      pathname === MARGIN_API_PREFIX ||
      pathname.startsWith(`${MARGIN_API_PREFIX}/`)

    if (!withinMargin) return env.ASSETS.fetch(request)

    const health =
      pathname === MARGIN_HEALTH_PATH || pathname === `${MARGIN_HEALTH_PATH}/`
    if (health) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, {
          status: 405,
          headers: { allow: 'GET, HEAD' },
        })
      }
      return json({ status: 'ok', service: 'margin' }, 200)
    }

    if (!isD1Database(env.MARGIN_DB)) {
      return json(
        {
          error: {
            code: 'storage_unavailable',
            message: 'the MARGIN_DB binding is missing',
          },
        },
        503,
      )
    }

    try {
      return await handleMarginRequest(request, {
        repository: new D1MarginRepository(env.MARGIN_DB),
        principal: await getPrincipal(request, env),
        now: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      })
    } catch {
      // The store answering with something the route did not expect — most
      // likely a deploy that reached the Worker before
      // `wrangler d1 migrations apply` reached the database, where every query
      // fails on a missing table. That is a 503 the operator can read, not a
      // raw 500 with a SQL message in it.
      return json(
        {
          error: {
            code: 'storage_unavailable',
            message: 'the margin store did not answer; check that its migrations are applied',
          },
        },
        503,
      )
    }
  },
}
