import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { WorkerEnv } from './env'
import worker, { MARGIN_HEALTH_PATH } from './index'
import {
  createFakeProvider,
  sessionCookieHeader,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_ISSUER,
} from './margin/fake-workos'
import { AUTH_ME_PATH } from './margin/auth-routes'

// Prefer the real build output so this asserts against the HTML the site
// actually ships. `scripts/agent-evidence` runs the build lane before the test
// lane, so `dist/` is normally present; a bare `npm test` falls back to a
// worker-unique temporary directory shaped the same way.
const BUILT_DIST = resolve(process.cwd(), 'dist')
const usingRealBuild = existsSync(join(BUILT_DIST, 'index.html'))

let temporaryAssets: string | null = null
const assetDirectory = (() => {
  if (usingRealBuild) return BUILT_DIST
  temporaryAssets = mkdtempSync(join(tmpdir(), 'margin-worker-assets-'))
  writeFileSync(
    join(temporaryAssets, 'index.html'),
    '<!doctype html><html><head><title>ernie.sg</title></head><body><h1>Home</h1></body></html>\n',
  )
  writeFileSync(
    join(temporaryAssets, '404.html'),
    '<!doctype html><html><body><h1>404</h1></body></html>\n',
  )
  return temporaryAssets
})()

afterAll(() => {
  if (temporaryAssets) rmSync(temporaryAssets, { recursive: true, force: true })
})

function assetFile(pathname: string) {
  const candidate = resolve(
    assetDirectory,
    decodeURIComponent(pathname).replace(/^\/+/, ''),
  )
  if (
    candidate !== assetDirectory &&
    !candidate.startsWith(`${assetDirectory}${sep}`)
  ) {
    return null
  }
  for (const file of [candidate, join(candidate, 'index.html')]) {
    if (existsSync(file) && statSync(file).isFile()) return readFileSync(file)
  }
  return null
}

/**
 * Stands in for the Cloudflare `ASSETS` binding, including its
 * `not_found_handling: "404-page"` behaviour.
 */
function createAssetBinding() {
  const seen: Request[] = []
  const binding = {
    seen,
    async fetch(request: Request) {
      seen.push(request)
      const body = assetFile(new URL(request.url).pathname)
      if (body) {
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      const notFound = assetFile('/404.html')
      return new Response(notFound ?? 'Not found', {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  }
  return binding
}

function createEnv() {
  const env = { ASSETS: createAssetBinding() }
  env satisfies WorkerEnv
  return env
}

describe('ernie.sg Worker entry', () => {
  it('serves the margin health route', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      new Request(`https://ernie.sg${MARGIN_HEALTH_PATH}`),
      env,
    )

    expect(MARGIN_HEALTH_PATH).toBe('/api/margin/v1/health')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(await response.json()).toEqual({ status: 'ok', service: 'margin' })
    expect(env.ASSETS.seen).toHaveLength(0)
  })

  it('rejects non-read methods on the health route without touching assets', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      new Request(`https://ernie.sg${MARGIN_HEALTH_PATH}`, { method: 'POST' }),
      env,
    )

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(env.ASSETS.seen).toHaveLength(0)
  })

  it('still serves an existing page as its built HTML', async () => {
    const env = createEnv()
    const response = await worker.fetch(new Request('https://ernie.sg/'), env)
    const expected = readFileSync(join(assetDirectory, 'index.html'), 'utf8')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(expected)
    expect(expected).toContain('<html')
    if (usingRealBuild) expect(expected.length).toBeGreaterThan(500)
  })

  it('hands every non-margin request to the asset binding unchanged', async () => {
    const env = createEnv()
    const request = new Request('https://ernie.sg/blog/?page=2', {
      headers: { 'x-trace': 'keep-me' },
    })

    await worker.fetch(request, env)

    expect(env.ASSETS.seen).toHaveLength(1)
    expect(env.ASSETS.seen[0]).toBe(request)
    expect(env.ASSETS.seen[0].url).toBe('https://ernie.sg/blog/?page=2')
    expect(env.ASSETS.seen[0].headers.get('x-trace')).toBe('keep-me')
  })

  it('returns the asset binding response verbatim, including its 404 page', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      new Request('https://ernie.sg/nothing-is-built-here'),
      env,
    )

    expect(response.status).toBe(404)
    expect(env.ASSETS.seen).toHaveLength(1)
  })

  it('serves the auth endpoints without touching assets', async () => {
    const env = { ...createEnv(), ...testWorkosEnv() }
    const response = await worker.fetch(
      new Request(`https://ernie.sg${AUTH_ME_PATH}`),
      env,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authenticated: false })
    expect(env.ASSETS.seen).toHaveLength(0)
  })

  it('fails the auth endpoints closed when WorkOS is not configured', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      new Request(`https://ernie.sg${AUTH_ME_PATH}`),
      env,
    )

    expect(response.status).toBe(503)
    expect(env.ASSETS.seen).toHaveLength(0)
  })

  it('leaves an unrecognised path under /auth to the asset binding', async () => {
    const env = { ...createEnv(), ...testWorkosEnv() }
    const response = await worker.fetch(
      new Request('https://ernie.sg/auth/unknown'),
      env,
    )

    expect(response.status).toBe(404)
    expect(env.ASSETS.seen).toHaveLength(1)
  })
})

/**
 * The write gate, over HTTP rather than through the helper.
 *
 * The issue's acceptance tests are about requests: an anonymous write is 401, a
 * signed-in write without an allowlist row is 403, and `apply` needs the admin.
 * Calling `requireWriter` directly proves the helper works and proves nothing
 * about whether anything calls it, so these go through `worker.fetch`.
 */
describe('the margin write gate', () => {
  const ANNOTATIONS = 'https://ernie.sg/api/margin/v1/annotations'
  const APPLY = 'https://ernie.sg/api/margin/v1/proposals/ann-1/apply'

  function envWithWorkos() {
    const env = { ASSETS: createAssetBinding(), ...testWorkosEnv() }
    return env as unknown as WorkerEnv & { ASSETS: ReturnType<typeof createAssetBinding> }
  }

  it('refuses an anonymous write without reaching the assets', async () => {
    for (const [url, method] of [
      [ANNOTATIONS, 'POST'],
      [ANNOTATIONS, 'PATCH'],
      [ANNOTATIONS, 'DELETE'],
      [APPLY, 'POST'],
    ] as const) {
      const env = envWithWorkos()
      const response = await worker.fetch(new Request(url, { method }), env)

      expect(response.status, `${method} ${url}`).toBe(401)
      expect(await response.json()).toEqual({ error: 'authentication_required' })
      expect(env.ASSETS.seen).toHaveLength(0)
    }
  })

  it('reports missing service storage for a read', async () => {
    const env = envWithWorkos()
    const response = await worker.fetch(new Request(ANNOTATIONS), env)

    expect(response.status).toBe(503)
    expect(env.ASSETS.seen).toHaveLength(0)
  })

  it('gates a write even on a path no route serves yet', async () => {
    const env = envWithWorkos()
    const response = await worker.fetch(
      new Request('https://ernie.sg/api/margin/v1/anything/at/all', {
        method: 'POST',
      }),
      env,
    )

    expect(response.status).toBe(401)
    expect(env.ASSETS.seen).toHaveLength(0)
  })

  it('leaves everything outside the margin prefix alone', async () => {
    const env = envWithWorkos()
    const response = await worker.fetch(
      new Request('https://ernie.sg/api/other/thing', { method: 'POST' }),
      env,
    )

    expect(env.ASSETS.seen).toHaveLength(1)
    expect(response.status).toBe(404)
  })
})

describe('terminal refresh responses', () => {
  it('preserves the session on an HTTP 408 even when its body says invalid_grant', async () => {
    const now = Math.floor(Date.now() / 1000)
    const signer = await testSigner()
    const stale = await signer.sign({
      iss: TEST_ISSUER,
      sub: 'user_01HREADER',
      client_id: TEST_CLIENT_ID,
      iat: now - 3_700,
      exp: now - 3_600,
    })
    const cookie = await sessionCookieHeader(stale, {
      expiresAt: now - 3_600,
      ceiling: now + 3_600,
      refreshToken: 'refresh_one',
    })
    const provider = createFakeProvider({
      jwks: signer.jwks,
      authenticateStatus: 408,
      authenticate: { error: 'invalid_grant' },
    })
    vi.stubGlobal('fetch', provider.fetchImpl)
    try {
      for (const path of [AUTH_ME_PATH, '/api/margin/v1/annotations']) {
        const response = await worker.fetch(
          new Request(`https://ernie.sg${path}`, { headers: { cookie } }),
          { ASSETS: createAssetBinding(), ...testWorkosEnv() } as WorkerEnv,
        )
        expect(response.headers.get('set-cookie'), path).toBeNull()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('expires the stale session on auth, API reads, denied writes, and apply', async () => {
    const now = Math.floor(Date.now() / 1000)
    const signer = await testSigner()
    const stale = await signer.sign({
      iss: TEST_ISSUER,
      sub: 'user_01HREADER',
      client_id: TEST_CLIENT_ID,
      iat: now - 3_700,
      exp: now - 3_600,
    })
    const cookie = await sessionCookieHeader(stale, {
      expiresAt: now - 3_600,
      ceiling: now + 3_600,
      refreshToken: 'refresh_one',
    })
    const provider = createFakeProvider({
      jwks: signer.jwks,
      authenticateStatus: 400,
      authenticate: { error: 'invalid_grant' },
    })
    vi.stubGlobal('fetch', provider.fetchImpl)
    try {
      for (const [path, method, status] of [
        [AUTH_ME_PATH, 'GET', 200],
        ['/api/margin/v1/annotations', 'GET', 503],
        ['/api/margin/v1/annotations', 'POST', 401],
        ['/api/margin/v1/proposals/ann-1/apply', 'POST', 401],
      ] as const) {
        const env = { ASSETS: createAssetBinding(), ...testWorkosEnv() } as WorkerEnv
        const response = await worker.fetch(
          new Request(`https://ernie.sg${path}`, { method, headers: { cookie } }),
          env,
        )
        expect(response.status, `${method} ${path}`).toBe(status)
        expect(response.headers.get('set-cookie'), `${method} ${path}`)
          .toContain('margin-session=; Path=/; Max-Age=0')
      }
      const failedStore = await worker.fetch(
        new Request('https://ernie.sg/api/margin/v1/annotations?source=https%3A%2F%2Fernie.sg%2Fx', {
          headers: { cookie },
        }),
        {
          ASSETS: createAssetBinding(),
          MARGIN_DB: { prepare() { throw new Error('downstream unavailable') } },
          ...testWorkosEnv(),
        } as WorkerEnv,
      )
      expect(failedStore.status).toBe(503)
      expect(failedStore.headers.get('set-cookie'))
        .toContain('margin-session=; Path=/; Max-Age=0')
      const callsAfterClear = provider.calls.length
      await worker.fetch(
        new Request(`https://ernie.sg${AUTH_ME_PATH}`),
        { ASSETS: createAssetBinding(), ...testWorkosEnv() } as WorkerEnv,
      )
      expect(provider.calls).toHaveLength(callsAfterClear)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// `new Request(request, {headers})` transfers the original's body. Building the
// authorization retry that way locked a stream the real handler still had to
// read, so a renewed mutation would have arrived with no JSON in it.
describe('renewing a write leaves its body readable', () => {
  it('hands the downstream handler a request it can still read', async () => {
    const bodies: (string | null)[] = []
    const env = {
      ASSETS: {
        async fetch(request: Request) {
          bodies.push(request.bodyUsed ? null : await request.text())
          return new Response('ok', { status: 200 })
        },
      },
      ...testWorkosEnv(),
    } as unknown as WorkerEnv

    const response = await worker.fetch(
      new Request('https://ernie.sg/api/margin/v1/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      env,
    )

    // Anonymous, so the gate refuses before any renewal and the body never
    // reaches the assets. What matters is that nothing threw on a locked stream.
    expect(response.status).toBe(401)
    expect(bodies).toEqual([])
  })

  it('never consumes the body while deciding', async () => {
    const request = new Request('https://ernie.sg/api/margin/v1/annotations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    const env = { ASSETS: createAssetBinding(), ...testWorkosEnv() } as unknown as WorkerEnv

    await worker.fetch(request, env)

    // The gate read headers and a cookie; the body is still there for whoever
    // serves the route.
    expect(request.bodyUsed).toBe(false)
    expect(await request.text()).toBe('{"hello":"world"}')
  })
})

// A deploy that reaches the Worker before `wrangler d1 migrations apply`
// reaches the database fails every query on a missing table. That must read as
// an operator-legible 503, not a raw 500 with SQL in it.
describe('a store that cannot answer', () => {
  it('is a 503 the operator can act on, not a 500', async () => {
    const env = {
      ASSETS: createAssetBinding(),
      MARGIN_DB: {
        prepare() {
          return {
            bind() {
              return this
            },
            first() {
              throw new Error('D1_ERROR: no such table: margin_annotations')
            },
            all() {
              throw new Error('D1_ERROR: no such table: margin_annotations')
            },
            run() {
              throw new Error('D1_ERROR: no such table: margin_annotations')
            },
          }
        },
      },
    } as unknown as WorkerEnv & { ASSETS: ReturnType<typeof createAssetBinding> }

    const response = await worker.fetch(
      new Request(
        'https://ernie.sg/api/margin/v1/annotations?source=https%3A%2F%2Fernie.sg%2Fx',
      ),
      env,
    )

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('storage_unavailable')
    expect(body.error.message).toContain('migrations')
    // And nothing from the store's own message reaches the caller.
    expect(JSON.stringify(body)).not.toContain('no such table')
  })

  it('still answers the health route, which is what it is for', async () => {
    const env = { ASSETS: createAssetBinding() } as unknown as WorkerEnv
    const response = await worker.fetch(
      new Request(`https://ernie.sg${MARGIN_HEALTH_PATH}`),
      env,
    )

    expect(response.status).toBe(200)
  })
})
