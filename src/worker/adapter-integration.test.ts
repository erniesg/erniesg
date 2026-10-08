import { afterEach, expect, it, vi } from 'vitest'
import worker from './index'
import { ADA, BOB, createHarness, webAnnotation, scopeQuery } from './margin/fixtures'

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

it('report transport pilot bounds actual body bytes and isolates receipt HEAD and aliases from human auth', async () => {
  const f = await integration(),
    selector = f.token.split('.')[1]
  const row = f.h.database.query(
    'SELECT token_sha256 FROM margin_adapter_tokens WHERE token_id=?',
    [selector],
  )[0]
  f.h.database.execute(
    'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
    [
      selector,
      row.token_sha256,
      'https://ernie.sg',
      'test-adapter',
      '2026-10-08T00:00:00.000Z',
    ],
  )
  const auth = vi.spyOn(authRoutes, 'handleAuthRequest')
  try {
    const oversized = await worker.fetch(
      new Request('https://ernie.sg/api/margin/v1/adapter/reports', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.token}`,
          'content-type': 'application/json',
          'content-length': '1',
        },
        body: ' '.repeat(65_537),
      }),
      f.env,
    )
    expect(oversized.status).toBe(413)
    const missing = encodeBase64Url(new Uint8Array(16).fill(18))
    for (const method of ['HEAD', 'head', 'HeAd']) {
      const head = await f.call(
        '/api/margin/v1/adapter/receipts/' + missing,
        method,
        `Bearer ${f.token}`,
        'margin-session=obsolete',
      )
      expect(head.status).toBe(404)
      expect(await head.text()).toBe('')
      expect(head.headers.get('set-cookie')).toContain('margin-session=;')
    }
    expect((await f.call('/api/margin/v1/adapter/reports', 'HEAD')).status).toBe(405)
    expect((await f.call('/api/margin/v1/adapter/%72eports', 'POST')).status).toBe(404)
    expect((await f.call('/api/margin/v1/adapter/reports', 'POST', '')).status).toBe(
      401,
    )
    expect(auth).not.toHaveBeenCalled()
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  } finally {
    auth.mockRestore()
  }
})

it.each([
  '/API/MARGIN/V1/ADAPTER/reports',
  '/api/margin/v1/Adapter/reports',
  '/api/margin/v1/%41dapter/reports',
  '/api/margin/v1/adapter/Reports',
  '/api/margin/v1/adapter/reports/',
  '/api/margin/v1/adapter/%72eports',
  '//api//margin//v1//adapter//reports',
  '/api/margin/v1/adapter%2freports',
  '/api/margin/v1/ADAPTER/receipts/invalid%ZZ',
  '/api/margin/v1/adapter/Receipts/AQEBAQEBAQEBAQEBAQEBAQ',
])(
  'outer Worker reserves report alias %s before all human session handling',
  async (path) => {
    const f = await integration(),
      auth = vi.spyOn(authRoutes, 'handleAuthRequest'),
      fetcher = vi.fn().mockRejectedValue(Error('provider forbidden'))
    vi.stubGlobal('fetch', fetcher)
    try {
      for (const method of ['GET', 'POST', 'HEAD']) {
        const response = await f.call(path, method, '', 'margin-session=obsolete')
        expect(response.status).toBe(404)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('set-cookie')).toContain('margin-session=;')
        if (method === 'HEAD') expect(await response.text()).toBe('')
      }
      expect(auth).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
      expect(f.assets).not.toHaveBeenCalled()
    } finally {
      auth.mockRestore()
    }
  },
)

async function storedReport(f: Awaited<ReturnType<typeof integration>>) {
  const at = '2026-10-08T00:00:00.000Z'
  f.h.database.execute(
    'INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
    [ADA.provider, ADA.issuer, ADA.subject, at, at],
  )
  const identity = f.h.database.query('SELECT id FROM margin_identity')[0].id
  f.h.database.execute(
    "INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)",
    [identity, at],
  )
  f.h.database.execute('INSERT INTO margin_site_admins VALUES(?,?)', [
    'https://ernie.sg',
    identity,
  ])
  const source = 'https://ernie.sg/books/example/'
  const created = await f.h.request('POST', '/annotations', {
    as: BOB,
    body: webAnnotation({ source, motivation: 'editing' }),
  })
  expect(created.status).toBe(201)
  const id = (await created.json()).id.replace('urn:margin:annotation:', '')
  expect(
    (
      await f.h.request('POST', `/proposals/${id}/apply${scopeQuery(source)}`, {
        body: { revision: 1 },
      })
    ).status,
  ).toBe(202)
  const credential = (await f.h.repository.findAdapterCredential(
    f.token.split('.')[1],
  ))!
  f.h.database.execute(
    'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
    [
      credential.tokenId,
      credential.tokenSha256,
      credential.site,
      credential.adapter,
      at,
    ],
  )
  const eventId = encodeBase64Url(new Uint8Array(16).fill(19))
  const accepted = await f.h.repository.reportProposalExecution(
    credential,
    {
      eventId,
      proposalId: id,
      approvedRevision: 1,
      expectedStateVersion: 0,
      outcome: { state: 'conflict', detail: 'private fixture detail' },
    },
    at,
  )
  expect(accepted.status).toBe('accepted')
  return { eventId, path: '/api/margin/v1/adapter/receipts/' + eventId }
}

it.each(['HEAD', 'head', 'HeAd'])(
  'receipt %s matches GET authority and strips every result/error body',
  async (method) => {
    const f = await integration(),
      stored = await storedReport(f),
      cookie = 'margin-session=obsolete'
    for (const [suffix, bearer, status] of [
      ['', `Bearer ${f.token}`, 200],
      ['', undefined, 401],
      ['', 'Bearer margin-adapter-v1.invalid', 401],
      ['?extra=1', `Bearer ${f.token}`, 400],
      ['/', '', 404],
    ] as const) {
      const response = await f.call(stored.path + suffix, method, bearer ?? '', cookie)
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('set-cookie')).toContain('margin-session=;')
      expect(response.headers.has('access-control-allow-origin')).toBe(false)
    }
    f.h.database.execute('UPDATE margin_adapter_report_grants SET revoked_at=?', [
      '2026-10-08T01:00:00.000Z',
    ])
    const denied = await f.call(stored.path, method, `Bearer ${f.token}`, cookie)
    expect(denied.status).toBe(403)
    expect(await denied.text()).toBe('')
    const absentDB = await worker.fetch(
      new Request('https://ernie.sg' + stored.path, {
        method,
        headers: { authorization: `Bearer ${f.token}`, cookie },
      }),
      { ASSETS: f.env.ASSETS },
    )
    expect(absentDB.status).toBe(503)
    expect(await absentDB.text()).toBe('')
    expect(absentDB.headers.get('set-cookie')).toContain('margin-session=;')
    const spy = vi.spyOn(f.h.database, 'query').mockImplementation(() => {
      throw Error('private storage diagnostic')
    })
    try {
      const malformed = await f.call(stored.path, method, `Bearer ${f.token}`, cookie)
      expect(malformed.status).toBe(503)
      expect(await malformed.text()).toBe('')
      expect(malformed.headers.get('set-cookie')).toContain('margin-session=;')
    } finally {
      spy.mockRestore()
    }
  },
)

it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])(
  'report endpoint method %s cannot mutate or renew human authority',
  async (method) => {
    const f = await integration(),
      auth = vi.spyOn(authRoutes, 'handleAuthRequest')
    try {
      const response = await f.call(
        '/api/margin/v1/adapter/reports',
        method,
        '',
        'margin-session=obsolete',
      )
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
      if (method === 'HEAD') expect(await response.text()).toBe('')
      expect(response.headers.has('access-control-allow-origin')).toBe(false)
      expect(auth).not.toHaveBeenCalled()
      expect(
        f.h.database.query('SELECT * FROM margin_adapter_report_receipts'),
      ).toEqual([])
    } finally {
      auth.mockRestore()
    }
  },
)
it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
  'receipt method %s is read-only denial',
  async (method) => {
    const f = await integration(),
      path =
        '/api/margin/v1/adapter/receipts/' +
        encodeBase64Url(new Uint8Array(16).fill(20))
    const response = await f.call(path, method)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  },
)
it('valid and expired human admin cookies cannot authorize either report or receipt or renew', async () => {
  const f = await integration(),
    signer = await testSigner(),
    now = Math.floor(Date.now() / 1000),
    fetcher = vi.fn().mockRejectedValue(Error('provider forbidden'))
  vi.stubGlobal('fetch', fetcher)
  for (const expiry of [now + 300, now - 60]) {
    const signed = await signer.sign({
      iss: TEST_ISSUER,
      sub: 'offline-admin',
      client_id: TEST_CLIENT_ID,
      iat: now - 300,
      exp: expiry,
    })
    const cookie = await sessionCookieHeader(signed, {
      expiresAt: expiry,
      ceiling: now + 3600,
      refreshToken: 'fixture-refresh',
    })
    for (const [path, method] of [
      ['/api/margin/v1/adapter/reports', 'POST'],
      [
        '/api/margin/v1/adapter/receipts/' +
          encodeBase64Url(new Uint8Array(16).fill(21)),
        'GET',
      ],
    ]) {
      const response = await f.call(path, method, '', cookie)
      expect(response.status).toBe(401)
      expect(response.headers.has('set-cookie')).toBe(false)
    }
  }
  expect(fetcher).not.toHaveBeenCalled()
  expect(f.assets).not.toHaveBeenCalled()
})

it('reserves work route aliases and keeps GET-only work separate from human sessions', async () => {
  const f = await integration(),
    fetcher = vi.fn().mockRejectedValue(new Error('no external calls'))
  vi.stubGlobal('fetch', fetcher)
  expect((await f.call('/api/margin/v1/adapter/work', 'GET', '')).status).toBe(401)
  expect((await f.call('/api/margin/v1/adapter/work')).status).toBe(403)
  for (const method of ['HEAD', 'POST', 'OPTIONS']) {
    const r = await f.call('/api/margin/v1/adapter/work', method)
    expect(r.status).toBe(405)
    expect(r.headers.get('allow')).toBe('GET')
    if (method === 'HEAD') expect(await r.text()).toBe('')
  }
  for (const path of [
    '/api/margin/v1/adapter/WORK',
    '/api/margin/v1/adapter/%77ork',
    '/api/margin/v1/adapter/work/',
  ]) {
    expect((await f.call(path)).status).toBe(404)
  }
  expect(fetcher).not.toHaveBeenCalled()
  expect(f.assets).not.toHaveBeenCalled()
})

it('work HEAD aliases and missing storage retain bodyless refusal and cookie clearing without AuthKit', async () => {
  const f = await integration(),
    auth = vi.spyOn(authRoutes, 'handleAuthRequest')
  try {
    for (const method of ['HEAD', 'head', 'HeAd']) {
      const response = await f.call(
        '/api/margin/v1/adapter/work',
        method,
        `Bearer ${f.token}`,
        'margin-session=obsolete',
      )
      expect(response.status).toBe(405)
      expect(await response.text()).toBe('')
      expect(response.headers.get('allow')).toBe('GET')
      expect(response.headers.get('set-cookie')).toContain('margin-session=;')
    }
    for (const path of [
      '/API/MARGIN/V1/ADAPTER/work',
      '/api/margin/v1/%61dapter/work',
      '/api/margin/v1//adapter/work',
    ]) {
      const response = await f.call(
        path,
        'HEAD',
        `Bearer ${f.token}`,
        'margin-session=obsolete',
      )
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
    const unavailable = await worker.fetch(
      new Request('https://ernie.sg/api/margin/v1/adapter/work', {
        headers: {
          authorization: `Bearer ${f.token}`,
          cookie: 'margin-session=obsolete',
        },
      }),
      { ASSETS: f.env.ASSETS },
    )
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get('cache-control')).toBe('no-store')
    expect(unavailable.headers.get('set-cookie')).toContain('margin-session=;')
    expect(auth).not.toHaveBeenCalled()
    expect(f.assets).not.toHaveBeenCalled()
  } finally {
    auth.mockRestore()
  }
})
