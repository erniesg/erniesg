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
import { afterAll, describe, expect, it } from 'vitest'
import type { WorkerEnv } from './env'
import worker, { MARGIN_HEALTH_PATH } from './index'
import { testWorkosEnv } from './margin/fake-workos'
import { AUTH_ME_PATH } from './margin/routes'

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
