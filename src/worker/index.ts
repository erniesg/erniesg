import type { WorkerEnv } from './env'
import { getPrincipal, type PrincipalOptions } from './principal'
import { requireAdmin, requireWriter } from './margin/authorize'
import { readWorkosConfig } from './margin/config'
import {
  AUTH_PREFIX,
  handleAuthRequest,
  renewSession,
} from './margin/auth-routes'

import { isD1Database } from './margin/d1'
import { D1MarginRepository } from './margin/d1-repository'
import { handleMarginRequest, MARGIN_API_PREFIX } from './margin/routes'

export { MARGIN_API_PREFIX }
export const MARGIN_HEALTH_PATH = `${MARGIN_API_PREFIX}/health`

/** The Worker-owned prefixes, mirrored by `run_worker_first` in Wrangler. */
export const WORKER_FIRST_PREFIXES = [MARGIN_API_PREFIX, AUTH_PREFIX] as const

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Methods that change something, and therefore need an allowlist row. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Match the service router's decoded segments, including repeated slashes. */
function isProposalApply(pathname: string): boolean {
  try {
    const parts = pathname
      .slice(MARGIN_API_PREFIX.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
    return (
      parts.length === 3 && parts[0] === 'proposals' && parts[2] === 'apply'
    )
  } catch {
    return false
  }
}

/**
 * The gate on the margin API prefix, rather than on each route.
 *
 * Keeping authorization at the composition root means every service write
 * is refused without an allowlist row whatever route ends up serving it — gated
 * by omission rather than open by omission.
 *
 * It does three things, and the last two are why it also touches reads:
 *
 *  - **Same-origin.** A cookie-authenticated write needs more than a method.
 *    `SameSite=Lax` sends the host cookie for a *same-site* request, and an
 *    HTTPS sibling of `ernie.sg` is same-site, so a form POST from one would
 *    otherwise be authorized. Logout already validates this; writes must too.
 *  - **Renewal.** A page left open past the access token's expiry has a live
 *    refresh token in its own cookie and hours left on the session. Renewing
 *    here beats requiring the client to have polled `/auth/me` first.
 *  - **Forwarding the renewed request.** The handler below reads the caller
 *    from the request it is given, so it has to be given the renewed one.
 *    Authorizing a stand-in and forwarding the stale original would leave the
 *    service handlers seeing nobody — an anonymous write, or a read that hides the
 *    caller's own private annotations.
 *
 * Reads stay open: renewal never denies one, it only re-identifies the caller.
 */
export type MarginGate = {
  /** The refusal to return, if there is one. */
  denied?: Response
  /** A renewed session or terminal expiry to set on the response. */
  setCookie?: string
  /** The request to forward downstream, when it is not the one passed in. */
  forward?: Request
}

export async function marginWriteGate(
  request: Request,
  env: Partial<Omit<WorkerEnv, 'ASSETS'>>,
  options: PrincipalOptions = {},
): Promise<MarginGate | null> {
  const { pathname } = new URL(request.url)
  if (
    pathname !== MARGIN_API_PREFIX &&
    !pathname.startsWith(`${MARGIN_API_PREFIX}/`)
  ) {
    return null
  }

  const mutating = MUTATING_METHODS.has(request.method)
  if (mutating && !sameOriginRequest(request)) {
    return {
      denied: json(
        {
          error: {
            code: 'cross_origin',
            message: 'a write must come from this site',
          },
        },
        403,
      ),
    }
  }

  const renewal = await renewIfStale(request, env, options)
  const effective = renewal?.request ?? request
  const cookie = renewal?.cookie

  if (!mutating) {
    // A read is never refused here. It is only re-identified, so the service handlers
    // see the caller they would have seen a minute earlier and a private
    // annotation stays visible to its owner.
    return cookie ? { setCookie: cookie, forward: effective } : null
  }

  const decision = isProposalApply(pathname)
    ? await requireAdmin(effective, env, options)
    : await requireWriter(effective, env, options)

  if (decision.ok) {
    return cookie
      ? { setCookie: cookie, forward: effective }
      : { forward: effective }
  }
  // The cookie travels even when the write is refused: it either holds a
  // rotated refresh token or expires one the provider has rejected.
  return cookie
    ? { denied: withCookie(decision.response, cookie), setCookie: cookie }
    : { denied: decision.response }
}

/**
 * The request again, with a renewed or expired session on it — or nothing to do.
 *
 * Only when the cookie holds a session the access token has outlived and the
 * ceiling has not. `new Request(request, …)` transfers the body, which is why
 * the original is never used again after this: the returned request is the one
 * that gets both authorized and forwarded.
 */
async function renewIfStale(
  request: Request,
  env: Partial<Omit<WorkerEnv, 'ASSETS'>>,
  options: PrincipalOptions,
): Promise<{ request: Request; cookie: string } | null> {
  if (await getPrincipal(request, env, options)) return null
  const config = readWorkosConfig(env)
  if (!config) return null

  const renewal = await renewSession(request, config, {
    now: options.now,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.jwks ? { jwks: options.jwks } : {}),
  })
  if (!renewal) return null

  const headers = new Headers(request.headers)
  headers.set('cookie', renewal.cookie.slice(0, renewal.cookie.indexOf(';')))
  return {
    cookie: renewal.cookie,
    request: new Request(request, { headers }),
  }
}

/**
 * Whether the browser says this request came from this site.
 *
 * `same-site` is refused along with `cross-site`: a sibling subdomain is not
 * this origin, and the session cookie is deliberately never scoped to a parent
 * domain. A caller that sends neither header is not a browser and has no ambient
 * cookie to abuse.
 */
function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
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
 * Compose AuthKit, prefix-wide authorization and the canonical margin service.
 * Resolve identity from the effective (possibly renewed) request for every
 * service route. Only requests outside the API fall through to static assets.
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
    if (
      pathname !== MARGIN_API_PREFIX &&
      !pathname.startsWith(`${MARGIN_API_PREFIX}/`)
    ) {
      return env.ASSETS.fetch(request)
    }

    const gate = await marginWriteGate(request, env)
    if (gate?.denied) return gate.denied
    const forwarded = gate?.forward ?? request
    let response: Response
    if (!isD1Database(env.MARGIN_DB)) {
      response = json(
        {
          error: {
            code: 'storage_unavailable',
            message: 'the MARGIN_DB binding is missing',
          },
        },
        503,
      )
    } else {
      try {
        response = await handleMarginRequest(forwarded, {
          repository: new D1MarginRepository(env.MARGIN_DB),
          principal: await getPrincipal(forwarded, env),
          now: () => new Date().toISOString(),
          newId: () => crypto.randomUUID(),
        })
      } catch {
        response = json(
          {
            error: {
              code: 'storage_unavailable',
              message:
                'the margin store did not answer; check that its migrations are applied',
            },
          },
          503,
        )
      }
    }
    // Both rotation and terminal expiry reach the browser on success, missing
    // storage and downstream errors. Never lose a cleared cookie to a throw.
    return gate?.setCookie ? withCookie(response, gate.setCookie) : response
  },
}
