import type { WorkerEnv } from './env'
import type { PrincipalOptions } from './principal'
import { requireAdmin, requireWriter } from './margin/authorize'
import { readWorkosConfig } from './margin/config'
import {
  AUTH_PREFIX,
  handleAuthRequest,
  renewSession,
} from './margin/routes'

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
export type WriteGate = {
  /** The refusal to return, if there is one. */
  denied?: Response
  /** A renewed session cookie to set on whatever response is returned. */
  setCookie?: string
}

export async function marginWriteGate(
  request: Request,
  env: Partial<Omit<WorkerEnv, 'ASSETS'>>,
  options: PrincipalOptions = {},
): Promise<WriteGate | null> {
  const { pathname } = new URL(request.url)
  if (
    pathname !== MARGIN_API_PREFIX &&
    !pathname.startsWith(`${MARGIN_API_PREFIX}/`)
  ) {
    return null
  }
  if (!MUTATING_METHODS.has(request.method)) return null

  const rest = pathname.slice(MARGIN_API_PREFIX.length).replace(/\/+$/u, '')
  const authorize = (candidate: Request) =>
    APPLY_PATH.test(rest)
      ? requireAdmin(candidate, env, options)
      : requireWriter(candidate, env, options)

  let decision = await authorize(request)
  if (decision.ok) return {}

  // A page left open past the access token's expiry would otherwise get a 401
  // with a live refresh token sitting in the cookie and hours left on the
  // session. Renew here rather than relying on the client having polled
  // `/auth/me` immediately before the write, and hand the new cookie back so the
  // caller sets it on whatever response it returns.
  if (decision.response.status !== 401) return { denied: decision.response }
  const config = readWorkosConfig(env)
  if (!config) return { denied: decision.response }

  const renewal = await renewSession(request, config, {
    now: options.now,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.jwks ? { jwks: options.jwks } : {}),
  })
  if (!renewal) return { denied: decision.response }

  // The renewed cookie travels even when the write is still refused: the refresh
  // token may have rotated, and the browser must end up holding the live one.
  if (!renewal.principal) {
    return { denied: withCookie(decision.response, renewal.cookie) }
  }

  const retried = await authorize(withSessionCookie(request, renewal.cookie))
  return retried.ok
    ? { setCookie: renewal.cookie }
    : { denied: withCookie(retried.response, renewal.cookie), setCookie: renewal.cookie }
}

/** The same request, carrying a renewed session cookie. */
function withSessionCookie(request: Request, cookie: string): Request {
  const value = cookie.slice(0, cookie.indexOf(';'))
  const headers = new Headers(request.headers)
  headers.set('cookie', value)
  return new Request(request, { headers })
}

/** The same response, plus a `set-cookie`. */
function withCookie(response: Response, cookie: string): Response {
  const next = new Response(response.body, response)
  next.headers.append('set-cookie', cookie)
  return next
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

    const gate = await marginWriteGate(request, env)
    if (gate?.denied) return gate.denied

    const response = await env.ASSETS.fetch(request)
    return gate?.setCookie ? withCookie(response, gate.setCookie) : response
  },
}
