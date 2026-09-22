import type { WorkerEnv } from './env'

export const MARGIN_API_PREFIX = '/api/margin/v1'
export const MARGIN_HEALTH_PATH = `${MARGIN_API_PREFIX}/health`

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
 * It serves one route — the margin health check — and hands every other
 * request straight to the static asset binding, unchanged. Wrangler's
 * `run_worker_first` list scopes the Worker to `/api/margin/v1/*`, so existing
 * pages never reach this handler at all and are served exactly as they were
 * before `main` was added. The asset fallthrough below keeps that true for any
 * request that does arrive here. Issue 054 adds the rest of the prefix.
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

    return env.ASSETS.fetch(request)
  },
}
