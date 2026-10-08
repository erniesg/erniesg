import { afterEach, expect, it, vi } from 'vitest'
import worker from './index'
import { ADA, createHarness } from './margin/fixtures'

afterEach(() => vi.unstubAllGlobals())
it('isolates the adapter route and bearer from human cookies and every normal API capability', async () => {
  const h = createHarness(),
    fetcher = vi.fn().mockRejectedValue(new Error('no provider calls'))
  vi.stubGlobal('fetch', fetcher)
  const env = {
    ASSETS: { fetch: async () => new Response('asset') },
    MARGIN_DB: h.database,
    MARGIN_ENVIRONMENT: 'development' as const,
    MARGIN_DEV_PRINCIPAL: JSON.stringify(ADA),
  }
  const cookieOnly = await worker.fetch(
    new Request('http://localhost/api/margin/v1/adapter/feed'),
    env,
  )
  expect(cookieOnly.status).toBe(401)
  for (const path of [
    '/api/margin/v1/annotations',
    '/api/margin/v1/prefs',
    '/auth/me',
    '/api/margin/v1/health',
  ]) {
    const r = await worker.fetch(
      new Request('http://localhost' + path, {
        headers: { authorization: 'Bearer margin-adapter-v1.invalid' },
      }),
      env,
    )
    expect(r.status).toBe(403)
  }
  expect(fetcher).not.toHaveBeenCalled()
})

import { encodeBase64Url } from './margin/base64url'
import {
  sessionCookieHeader,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_ISSUER,
} from './margin/fake-workos'
import { principalKey, recordIdentity } from './margin/identity'

async function integration() {
  const h = createHarness(),
    selector = encodeBase64Url(new Uint8Array(16).fill(5))
  const token = `margin-adapter-v1.${selector}.${encodeBase64Url(new Uint8Array(32).fill(6))}`
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('')
  h.database.execute('INSERT INTO margin_adapters VALUES(?,?,1,?)', [
    'https://ernie.sg',
    'test-adapter',
    '2026-10-08T00:00:00.000Z',
  ])
  h.database.execute('INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)', [
    selector,
    'https://ernie.sg',
    'test-adapter',
    digest,
    'approved_feed',
    '2026-10-08T00:00:00.000Z',
  ])
  const assets = vi.fn(async () => new Response('asset'))
  const env = { ...testWorkosEnv(), ASSETS: { fetch: assets }, MARGIN_DB: h.database }
  const call = (
    path = '/api/margin/v1/adapter/feed',
    method = 'GET',
    authorization: string | undefined = `Bearer ${token}`,
    cookie?: string,
  ) =>
    worker.fetch(
      new Request('https://ernie.sg' + path, {
        method,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(cookie ? { cookie } : {}),
          origin: 'https://unrelated.example',
        },
      }),
      env,
    )
  return { h, token, env, call, assets }
}

it('ignores even valid or expired authenticated admin sessions without renewal', async () => {
  const f = await integration(),
    fetcher = vi.fn().mockRejectedValue(new Error('provider forbidden'))
  vi.stubGlobal('fetch', fetcher)
  const principal = {
    provider: 'workos',
    issuer: TEST_ISSUER,
    subject: 'offline-admin',
  }
  const identity = await recordIdentity(
    f.h.database,
    principal,
    '2026-10-08T00:00:00.000Z',
  )
  f.h.database.execute(
    "INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)",
    [identity, '2026-10-08T00:00:00.000Z'],
  )
  const signer = await testSigner(),
    now = Math.floor(Date.now() / 1000)
  for (const expiry of [now + 300, now - 60]) {
    const signed = await signer.sign({
      iss: TEST_ISSUER,
      sub: principal.subject,
      client_id: TEST_CLIENT_ID,
      iat: now - 300,
      exp: expiry,
    })
    const cookie = await sessionCookieHeader(signed, {
      expiresAt: expiry,
      ceiling: now + 3600,
      refreshToken: 'fixture-refresh',
    })
    expect((await f.call(undefined, 'GET', '', cookie)).status).toBe(401)
    expect((await f.call(undefined, 'GET', `Bearer ${f.token}`, cookie)).status).toBe(
      200,
    )
    expect(
      (await f.call('/api/margin/v1/prefs', 'PATCH', `Bearer ${f.token}`, cookie))
        .status,
    ).toBe(403)
  }
  expect(fetcher).not.toHaveBeenCalled()
  expect(f.assets).not.toHaveBeenCalled()
  expect(principalKey(principal)).toContain('offline-admin')
})

it.each([
  '/api/margin/v1/adapter',
  '/api/margin/v1/adapter/feed/',
  '/api/margin/v1/adapter/report',
  '/api/margin/v1/%61dapter/feed',
  '/api/margin/v1/adapter/%66eed',
  '//api//margin//v1//adapter//feed',
  '/api/margin/v1/adapter%2ffeed',
  '/api/margin/v1/adapter/feed%2f',
])('refuses reserved namespace alias %s', async (path) => {
  const f = await integration(),
    r = await f.call(path)
  expect(r.status).toBe(404)
  expect(r.headers.get('cache-control')).toBe('no-store')
  expect(f.assets).not.toHaveBeenCalled()
})
it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])(
  'does not grant method %s',
  async (method) => {
    const f = await integration(),
      r = await f.call(undefined, method)
    expect(r.status).toBe(405)
    expect(r.headers.get('allow')).toBe('GET')
    expect(r.headers.has('access-control-allow-origin')).toBe(false)
    expect(r.headers.has('set-cookie')).toBe(false)
    if (method === 'HEAD') expect(await r.text()).toBe('')
  },
)
it.each([
  '/api/margin/v1/annotations',
  '/api/margin/v1/proposals',
  '/api/margin/v1/mine',
  '/api/margin/v1/prefs',
  '/api/margin/v1/progress',
  '/api/margin/v1/review',
  '/api/margin/v1/health',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
])('adapter bearer cannot become a human on %s', async (path) => {
  const f = await integration(),
    fetcher = vi.fn().mockRejectedValue(new Error('provider forbidden'))
  vi.stubGlobal('fetch', fetcher)
  for (const method of ['GET', 'POST', 'HEAD']) {
    const r = await f.call(path, method)
    expect(r.status).toBe(403)
    if (method === 'HEAD') expect(await r.text()).toBe('')
  }
  expect(fetcher).not.toHaveBeenCalled()
  expect(f.assets).not.toHaveBeenCalled()
})
it.each([
  'Basic dummy',
  'Bearer dummy',
  'Bearer margin-adapter-v1.invalid',
  'Bearer margin-adapter-v1.' + 'x'.repeat(22) + '.' + 'x'.repeat(43),
])('rejects malformed or noncanonical bearer spelling %s', async (authorization) => {
  const f = await integration()
  expect((await f.call(undefined, 'GET', authorization)).status).toBe(401)
})
it('returns sanitized storage failures and preserves only legacy cookie clears on bodyless HEAD', async () => {
  const f = await integration()
  const url = 'https://ernie.sg/api/margin/v1/adapter/feed'
  const r = await worker.fetch(
    new Request(url, { headers: { authorization: `Bearer ${f.token}` } }),
    { ASSETS: f.env.ASSETS },
  )
  expect(r.status).toBe(503)
  expect(await r.json()).toEqual({ error: { code: 'storage_unavailable' } })
  const head = await worker.fetch(
    new Request(url, {
      method: 'HEAD',
      headers: { cookie: 'margin-session=obsolete' },
    }),
    { ASSETS: f.env.ASSETS },
  )
  expect(head.status).toBe(405)
  expect(await head.text()).toBe('')
  expect(head.headers.get('cache-control')).toBe('no-store')
  expect(head.headers.get('set-cookie')).toContain('margin-session=;')
})

import * as authRoutes from './margin/auth-routes'
it.each(['/api/margin/v1/%61dapter/invalid%ZZ', '/api/margin/v1/%2fadapter/feed'])(
  'rejects namespace alias before human authentication even with malformed suffix: %s',
  async (path) => {
    const f = await integration(),
      spy = vi.spyOn(authRoutes, 'handleAuthRequest')
    try {
      const r = await f.call(path, 'GET', '')
      expect(r.status).toBe(404)
      expect(spy.mock.calls.length).toBe(0)
    } finally {
      spy.mockRestore()
    }
  },
)
