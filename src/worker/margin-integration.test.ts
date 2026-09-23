import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerEnv } from './env'
import worker from './index'
import type { Principal } from './principal'
import { ensureSchema, principalKey, recordIdentity } from './margin/identity'
import { SqliteD1Database } from './margin/sqlite-database'
import { CHAPTER_ONE, scopeQuery, webAnnotation } from './margin/fixtures'
import {
  createFakeProvider,
  sessionCookieHeader,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_ISSUER,
} from './margin/fake-workos'

const PREFIX = '/api/margin/v1'
const scope = scopeQuery(CHAPTER_ONE)
const writer: Principal = {
  provider: 'workos',
  issuer: TEST_ISSUER,
  subject: 'integration-writer',
}
const other: Principal = { ...writer, subject: 'integration-other' }
afterEach(() => vi.unstubAllGlobals())

async function setup() {
  const db = SqliteD1Database.inMemory()
  await ensureSchema(db)
  for (const principal of [writer, other]) {
    const id = await recordIdentity(db, principal, new Date().toISOString())
    db.execute(
      "INSERT INTO margin_allowlist (identity_id, role, added_at) VALUES (?, 'writer', ?)",
      [id, 'now'],
    )
  }
  const signer = await testSigner()
  const provider = createFakeProvider({ jwks: signer.jwks })
  vi.stubGlobal('fetch', provider.fetchImpl)
  const assets = vi.fn(async () => new Response('asset'))
  const env: WorkerEnv = {
    ...testWorkosEnv(),
    MARGIN_DB: db,
    ASSETS: { fetch: assets },
  }
  async function cookie(principal = writer, stale = false) {
    const now = Math.floor(Date.now() / 1000)
    const exp = now + (stale ? -60 : 300)
    const token = await signer.sign({
      iss: principal.issuer,
      sub: principal.subject,
      client_id: TEST_CLIENT_ID,
      iat: now - 3600,
      exp,
    })
    return sessionCookieHeader(token, {
      expiresAt: exp,
      ceiling: now + 3600,
      ...(stale ? { refreshToken: `refresh-${crypto.randomUUID()}` } : {}),
    })
  }
  async function request(
    path: string,
    method = 'GET',
    cookieValue?: string,
    body?: unknown,
    headers: HeadersInit = {},
  ) {
    const combined = new Headers(headers)
    if (cookieValue) combined.set('cookie', cookieValue)
    if (body !== undefined) combined.set('content-type', 'application/json')
    return worker.fetch(
      new Request(
        `https://ernie.sg${path.startsWith('/auth/') ? path : PREFIX + path}`,
        {
          method,
          headers: combined,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
      env,
    )
  }
  return { db, env, assets, signer, cookie, request }
}

describe('AuthKit and canonical service composition', () => {
  it('binds CRUD and prefs to the verified identity and keeps private annotations private', async () => {
    const h = await setup()
    const owner = await h.cookie()
    const outsider = await h.cookie(other)
    expect(
      (
        await h.request('/prefs', 'PATCH', owner, {
          defaultVisibility: 'private',
        })
      ).status,
    ).toBe(200)
    const created = await h.request(
      '/annotations',
      'POST',
      owner,
      webAnnotation({ source: CHAPTER_ONE }),
      {
        'x-margin-dev-principal': JSON.stringify(other),
      },
    )
    expect(created.status).toBe(201)
    const annotation = await created.json()
    expect(annotation.creator).toBe(principalKey(writer))
    expect(annotation['margin:visibility']).toBe('private')
    const item = created.headers.get('location')!.slice(PREFIX.length)
    expect((await h.request(item, 'GET', owner)).status).toBe(200)
    for (const viewer of [undefined, outsider]) {
      expect((await h.request(item, 'GET', viewer)).status).toBe(404)
      expect(
        await (await h.request(`/annotations${scope}`, 'GET', viewer)).json(),
      ).toMatchObject({ annotations: [] })
    }
    expect(
      (await h.request(item, 'PATCH', outsider, { body: 'forged' })).status,
    ).toBe(404)
    expect(
      (await h.request(item, 'PATCH', owner, { body: 'updated' })).status,
    ).toBe(200)
    expect((await h.request(item, 'DELETE', outsider)).status).toBe(404)
    expect((await h.request(item, 'DELETE', owner)).status).toBe(204)
    expect(h.assets).not.toHaveBeenCalled()
  })

  it('renews into the service with a readable W3C body and the same private owner', async () => {
    const h = await setup()
    const stale = await h.cookie(writer, true)
    const now = Math.floor(Date.now() / 1000)
    const fresh = await h.signer.sign({
      iss: TEST_ISSUER,
      sub: writer.subject,
      client_id: TEST_CLIENT_ID,
      iat: now,
      exp: now + 300,
    })
    const provider = createFakeProvider({
      jwks: h.signer.jwks,
      authenticate: {
        access_token: fresh,
        refresh_token: 'rotated-integration',
        user: { id: writer.subject },
      },
    })
    vi.stubGlobal('fetch', provider.fetchImpl)
    const created = await h.request(
      '/annotations',
      'POST',
      stale,
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'private',
        motivation: 'editing',
        body: 'replacement',
      }),
    )
    expect(created.status).toBe(201)
    expect(created.headers.get('set-cookie')).toContain('margin-session=')
    expect(created.headers.get('set-cookie')).not.toContain('Max-Age=0')
    expect(await created.json()).toMatchObject({
      creator: principalKey(writer),
      motivation: 'editing',
      body: { value: 'replacement' },
    })
    const read = await h.request(`/proposals${scope}`, 'GET', stale)
    expect(read.status).toBe(200)
    expect(read.headers.get('set-cookie')).toContain('margin-session=')
    expect((await read.json()).annotations).toHaveLength(1)
    expect(h.assets).not.toHaveBeenCalled()
  })

  it('clears terminal refreshes on real service responses and preserves transient sessions', async () => {
    const h = await setup()
    for (const status of [400, 408, 429, 500, 503, 'network'] as const) {
      const stale = await h.cookie(writer, true)
      const provider = createFakeProvider({
        jwks: h.signer.jwks,
        authenticateStatus: typeof status === 'number' ? status : 503,
        authenticate: { error: 'invalid_grant' },
      })
      vi.stubGlobal(
        'fetch',
        status === 'network'
          ? vi.fn(async () => {
              throw new Error('network')
            })
          : provider.fetchImpl,
      )
      for (const [path, method, expected] of [
        ['/auth/me', 'GET', 200],
        [`/annotations${scope}`, 'GET', 200],
        ['/prefs', 'GET', 401],
        ['/annotations', 'POST', 401],
        ['/proposals/id/apply', 'POST', 401],
      ] as const) {
        const response = await h.request(path, method, stale)
        expect(response.status, `${status} ${path}`).toBe(expected)
        if (status === 400)
          expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
        else expect(response.headers.get('set-cookie')).toBeNull()
      }
    }
  })

  it('rejects forged identity on every protected route and hides private data on every read', async () => {
    const h = await setup()
    const created = await h.request(
      '/annotations',
      'POST',
      await h.cookie(),
      webAnnotation({
        source: CHAPTER_ONE,
        motivation: 'editing',
        visibility: 'private',
      }),
    )
    const item = created.headers.get('location')!.slice(PREFIX.length)
    h.env.MARGIN_ENVIRONMENT = 'development'
    h.env.MARGIN_DEV_PRINCIPAL = JSON.stringify(writer)
    const now = Math.floor(Date.now() / 1000)
    const forgedToken = await h.signer.sign(
      { iss: TEST_ISSUER, sub: writer.subject, exp: now + 300 },
      { alg: 'HS256' },
    )
    const forged = await sessionCookieHeader(forgedToken)
    const headers = {
      'x-margin-dev-principal': JSON.stringify(writer),
      authorization: `Bearer ${forgedToken}`,
    }
    for (const [path, method] of [
      ['/annotations', 'POST'],
      [item, 'PATCH'],
      [item, 'DELETE'],
      ['/prefs', 'GET'],
      ['/prefs', 'PATCH'],
      ['/proposals/id/apply', 'POST'],
    ] as const) {
      expect(
        (await h.request(path, method, forged, undefined, headers)).status,
        `${method} ${path}`,
      ).toBe(401)
    }
    for (const path of [`/annotations${scope}`, `/proposals${scope}`]) {
      expect(
        await (await h.request(path, 'GET', forged, undefined, headers)).json(),
      ).toMatchObject({ annotations: [] })
    }
    expect(
      (await h.request(item, 'GET', forged, undefined, headers)).status,
    ).toBe(404)
    expect(
      (
        await h.request(
          '/documents/id/history',
          'GET',
          forged,
          undefined,
          headers,
        )
      ).status,
    ).toBe(501)
    expect(h.assets).not.toHaveBeenCalled()
  })

  it('keeps normalized apply paths admin-only and checks both browser origin signals', async () => {
    const h = await setup()
    const cookie = await h.cookie()
    for (const path of [
      '/proposals/id/apply',
      '/%70roposals/id/%61pply',
      '//proposals//id//apply/',
    ]) {
      expect((await h.request(path, 'POST', cookie)).status).toBe(403)
    }
    const browserHeaders: HeadersInit[] = [
      { origin: 'https://sibling.ernie.sg' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' },
    ]
    for (const headers of browserHeaders) {
      expect(
        (
          await h.request(
            '/annotations',
            'POST',
            cookie,
            webAnnotation({ source: CHAPTER_ONE }),
            headers,
          )
        ).status,
      ).toBe(403)
    }
    h.db.execute(
      "UPDATE margin_allowlist SET role = 'admin' WHERE identity_id = (SELECT id FROM margin_identity WHERE subject = ?)",
      [writer.subject],
    )
    for (const path of [
      '/proposals/id/apply',
      '/%70roposals/id/%61pply',
      '//proposals//id//apply/',
    ]) {
      expect((await h.request(path, 'POST', cookie)).status).toBe(501)
    }
    expect(h.assets).not.toHaveBeenCalled()
  })

  it('forwards rotated cookies on allowlist refusal, missing storage and downstream failures', async () => {
    const h = await setup()
    const now = Math.floor(Date.now() / 1000)
    const fresh = await h.signer.sign({
      iss: TEST_ISSUER,
      sub: writer.subject,
      client_id: TEST_CLIENT_ID,
      iat: now,
      exp: now + 300,
    })
    const provider = createFakeProvider({
      jwks: h.signer.jwks,
      authenticate: {
        access_token: fresh,
        refresh_token: 'rotated-after-failure',
        user: { id: writer.subject },
      },
    })
    vi.stubGlobal('fetch', provider.fetchImpl)
    const stale = await h.cookie(writer, true)
    h.db.execute('DELETE FROM margin_allowlist')
    const denied = await h.request(
      '/annotations',
      'POST',
      stale,
      webAnnotation({ source: CHAPTER_ONE }),
    )
    expect(denied.status).toBe(403)
    h.env.MARGIN_DB = undefined
    const missing = await h.request(`/annotations${scope}`, 'GET', stale)
    expect(missing.status).toBe(503)
    h.env.MARGIN_DB = {
      prepare() {
        throw new Error('private SQL details')
      },
    }
    const failed = await h.request(`/annotations${scope}`, 'GET', stale)
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('private SQL details')
    for (const response of [denied, missing, failed]) {
      expect(response.headers.get('set-cookie')).toContain('margin-session=')
      expect(response.headers.get('set-cookie')).not.toContain('Max-Age=0')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('preserves W3C code-point selectors, bounded pages and canonical source/body validation', async () => {
    const h = await setup()
    const cookie = await h.cookie()
    for (const body of [
      webAnnotation({ source: 'https://user:password@ernie.sg/chapter' }),
      webAnnotation({ source: CHAPTER_ONE, body: 'x'.repeat(8001) }),
      webAnnotation({ source: 'https://ernie.sg/' + '🌊'.repeat(200) }),
    ]) {
      expect(
        (await h.request('/annotations', 'POST', cookie, body)).status,
      ).toBe(400)
    }
    for (let i = 0; i < 3; i++) {
      const body = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        motivation: 'editing',
        body: { type: 'TextualBody', value: `replacement ${i}` },
        target: {
          source: CHAPTER_ONE,
          selector: [
            { type: 'TextQuoteSelector', exact: '🌊x' },
            { type: 'TextPositionSelector', start: 0, end: 2 },
          ],
        },
        'margin:visibility': 'private',
      }
      const response = await h.request('/annotations', 'POST', cookie, body)
      expect(response.status).toBe(201)
      expect((await response.json()).target.selector).toEqual(
        body.target.selector,
      )
    }
    const stored = await h.db
      .prepare('SELECT position_unit FROM margin_annotations')
      .all<{ position_unit: string }>()
    for (const row of stored.results)
      expect(row.position_unit).toBe(
        'codepoint',
      )
    const first = await h.request(`/proposals${scope}&limit=2`, 'GET', cookie)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const page = await first.json()
    expect(page.annotations).toHaveLength(2)
    expect(typeof page.nextCursor).toBe('string')
    const next = await h.request(
      `/proposals${scope}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
      'GET',
      cookie,
    )
    expect((await next.json()).annotations).toHaveLength(1)
    expect(
      (await h.request(`/proposals${scope}&limit=201`, 'GET', cookie)).status,
    ).toBe(400)
    expect(
      await (
        await h.request(`/proposals${scope}`, 'GET', await h.cookie(other))
      ).json(),
    ).toMatchObject({ annotations: [] })
  })
})
