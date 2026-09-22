import type { WorkerEnv } from './env'
import type { PrincipalOptions } from './principal'
import { requireAdmin, requireWriter } from './margin/authorize'
import { AUTH_PREFIX, handleAuthRequest } from './margin/routes'

export const MARGIN_API_PREFIX = '/api/margin/v1'
export const MARGIN_HEALTH_PATH = `${MARGIN_API_PREFIX}/health`

/** The Worker-owned prefixes, mirrored by `run_worker_first` in Wrangler. */
export const WORKER_FIRST_PREFIXES = [MARGIN_API_PREFIX, AUTH_PREFIX] as const

/** Methods that change something, and therefore need an allowlist row. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** `POST /proposals/<id>/apply`, relative to the margin API prefix. */
const APPLY_PATH = /^\/proposals\/[^/]+\/apply$/

/**
 * The write gate, on the prefix rather than on each route.
 *
 * 054's mutation routes are not in this tree yet, and a gate every future route
 * has to remember to call is a gate one of them will not. Putting it here means
 * a write under the margin API is refused unless the caller holds an allowlist
 * row, whatever route ends up serving it — a route added without an
 * authorization call is gated anyway rather than open by omission.
 *
 * Reads pass straight through: reading the book requires nothing.
 */
export async function marginWriteGate(
  request: Request,
  env: Partial<Omit<WorkerEnv, 'ASSETS'>>,
  options: PrincipalOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  if (
    pathname !== MARGIN_API_PREFIX &&
    !pathname.startsWith(`${MARGIN_API_PREFIX}/`)
  ) {
    return null
  }
  if (!MUTATING_METHODS.has(request.method)) return null

  const rest = pathname.slice(MARGIN_API_PREFIX.length).replace(/\/+$/u, '')
  const decision = APPLY_PATH.test(rest)
    ? await requireAdmin(request, env, options)
    : await requireWriter(request, env, options)
  return decision.ok ? null : decision.response
}

function healthResponse(): Response {
  const body = JSON.stringify({ status: 'ok', service: 'margin' })
  return new Response(`${body}\n`, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * The Worker entry point for ernie.sg.
 *
 * It serves the margin health check and the four AuthKit endpoints, and hands
 * every other request straight to the static asset binding, unchanged.
 * Wrangler's `run_worker_first` list scopes the Worker to `/api/margin/v1/*`
 * and `/auth/*`, so existing pages never reach this handler at all and are
 * served exactly as they were before `main` was added. The asset fallthrough
 * below keeps that true for any request that does arrive here, including an
 * unrecognised path under `/auth/`. Issue 054 adds the rest of the API prefix,
 * behind `marginWriteGate`, which already refuses every write under that prefix
 * from anybody without an allowlist row.
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url)
    const health =
      pathname === MARGIN_HEALTH_PATH || pathname === `${MARGIN_HEALTH_PATH}/`

    if (health) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, {
          status: 405,
          headers: { allow: 'GET, HEAD' },
        })
      }
      return healthResponse()
    }

    const auth = await handleAuthRequest(request, env)
    if (auth) return auth

    const denied = await marginWriteGate(request, env)
    if (denied) return denied

    return env.ASSETS.fetch(request)
  },
}
