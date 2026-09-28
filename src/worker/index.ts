import type { WorkerEnv } from './env'
import { getPrincipal } from './principal'
import { legacyCookieClears } from './margin/session'
import { handleAuthRequest } from './margin/auth-routes'
import { isD1Database } from './margin/d1'
import { D1MarginRepository } from './margin/d1-repository'
import { handleMarginRequest } from './margin/routes'
import {
  json,
  MARGIN_API_PREFIX,
  MARGIN_HEALTH_PATH,
  marginWriteGate,
  withCookie,
} from './gate'

// The entry exports only `default`. Local `wrangler dev` treats every named
// runtime export here as an entrypoint and refuses to start on a constant, so
// shared paths and the gate live in `./gate`.

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

    // The pre-release unprefixed cookie names are never read. A browser that
    // still sends one gets it cleared, on whichever route it hits first.
    const clears = legacyCookieClears(request)
    const response = await route(request, env)
    return clears.reduce(withCookie, response)
  },
}

async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const { pathname } = new URL(request.url)
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
}
