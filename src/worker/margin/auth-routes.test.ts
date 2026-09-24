import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { jwksUrl, readWorkosConfig, type WorkosConfig } from './config'
import {
  createFakeD1,
  createFakeProvider,
  foreignSigner,
  sessionCookieHeader,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  type FakeD1,
  type FakeProvider,
  type TestSigner,
} from './fake-workos'
import { createJwksSource } from './jwt'
import {
  AUTH_CALLBACK_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_ME_PATH,
  handleAuthRequest,
  renewalBounds,
  renewSession,
  safeReturnPath,
  type AuthEnv,
  type AuthOptions,
} from './auth-routes'
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  STATE_COOKIE_NAME,
  unsealSession,
} from './session'

const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = Math.floor(NOW_MS / 1000)
const ADMIN_EMAIL = 'hello@ernie.sg'

const config = readWorkosConfig(testWorkosEnv()) as WorkosConfig

let signer: TestSigner

beforeAll(async () => {
  signer = await testSigner()
})

function setCookies(response: Response): string[] {
  return (
    response.headers as unknown as { getSetCookie(): string[] }
  ).getSetCookie()
}

function cookieNamed(response: Response, name: string): string | undefined {
  return setCookies(response).find((header) => header.startsWith(`${name}=`))
}

function accessToken(overrides: Record<string, unknown> = {}) {
  return signer.sign({
    iss: TEST_ISSUER,
    sub: 'user_01HREADER',
    client_id: TEST_CLIENT_ID,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
    ...overrides,
  })
}

function providerWith(
  authenticate: unknown,
  authenticateStatus?: number,
): FakeProvider {
  return createFakeProvider({
    jwks: signer.jwks,
    authenticate,
    ...(authenticateStatus === undefined ? {} : { authenticateStatus }),
  })
}

function optionsFor(provider: FakeProvider): AuthOptions {
  return {
    now: NOW_MS,
    fetchImpl: provider.fetchImpl,
    jwks: createJwksSource(jwksUrl(config), {
      fetchImpl: provider.fetchImpl,
      now: () => NOW_MS,
    }),
  }
}

function envWith(db?: FakeD1): AuthEnv {
  return {
    ...testWorkosEnv(),
    MARGIN_ENVIRONMENT: 'production',
    ...(db ? { MARGIN_DB: db } : {}),
  }
}

async function call(
  path: string,
  init: RequestInit = {},
  env: AuthEnv = envWith(),
  options: AuthOptions = {},
): Promise<Response | null> {
  return handleAuthRequest(
    new Request(`https://ernie.sg${path}`, init),
    env,
    options,
  )
}

async function beginLogin(
  returnTo?: string,
): Promise<{ state: string; cookie: string }> {
  const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''
  const response = await call(`${AUTH_LOGIN_PATH}${query}`)
  const location = new URL(response?.headers.get('location') as string)
  const stateCookie = cookieNamed(response as Response, STATE_COOKIE_NAME)
  return {
    state: location.searchParams.get('state') as string,
    cookie: (stateCookie as string).split(';')[0] as string,
  }
}

describe('GET /auth/login', () => {
  it('redirects to the hosted AuthKit UI with an opaque state', async () => {
    const response = (await call(AUTH_LOGIN_PATH)) as Response
    const location = new URL(response.headers.get('location') as string)

    expect(response.status).toBe(302)
    expect(location.origin).toBe(TEST_ISSUER)
    expect(location.pathname).toBe('/user_management/authorize')
    expect(location.searchParams.get('client_id')).toBe(TEST_CLIENT_ID)
    expect(location.searchParams.get('state')?.length).toBeGreaterThan(20)
  })

  it('pins the state to the browser in a short-lived __Host- cookie', async () => {
    const response = (await call(AUTH_LOGIN_PATH)) as Response
    const cookie = cookieNamed(response, STATE_COOKIE_NAME) as string

    expect(cookie.startsWith('__Host-margin-auth-state=')).toBe(true)
    expect(cookie).toContain('; Path=/;')
    expect(cookie).toContain('; HttpOnly')
    expect(cookie).toContain('; Secure')
    expect(cookie).toContain('; SameSite=Lax')
    expect(cookie).toContain('; Max-Age=600')
    expect(cookie.toLowerCase()).not.toContain('domain=')
  })

  it('never leaks the API key into the redirect', async () => {
    const response = (await call(AUTH_LOGIN_PATH)) as Response

    expect(response.headers.get('location')).not.toContain(config.apiKey)
  })

  it('refuses anything but GET', async () => {
    const response = (await call(AUTH_LOGIN_PATH, { method: 'POST' })) as Response

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })
})

describe('safeReturnPath', () => {
  it('keeps a same-origin path', () => {
    expect(safeReturnPath('/challenges/one?page=2#anchor')).toBe(
      '/challenges/one?page=2#anchor',
    )
  })

  it('refuses everything that could leave the origin', () => {
    for (const candidate of [
      'https://evil.test/',
      '//evil.test/',
      '/\\evil.test',
      'javascript:alert(1)',
      'challenges',
      '',
      null,
      undefined,
    ]) {
      expect(safeReturnPath(candidate)).toBe('/')
    }
  })

  it('refuses a header-splitting path', () => {
    expect(safeReturnPath('/ok\r\nSet-Cookie: margin-session=forged')).toBe('/')
  })
})

describe('GET /auth/callback', () => {
  const user = { email: 'reader@example.test', email_verified: true }

  it('exchanges the code and seals the session', async () => {
    const { state, cookie } = await beginLogin('/challenges/one')
    const provider = providerWith({
      access_token: await accessToken(),
      user,
    })

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/challenges/one')

    const session = cookieNamed(response, SESSION_COOKIE_NAME) as string
    expect(session).toContain('; Path=/')
    expect(session).toContain('; HttpOnly')
    expect(session).toContain('; Secure')
    expect(session).toContain('; SameSite=Lax')
    expect(session.toLowerCase()).not.toContain('domain=')
    // To the ceiling, not to the 300-second access token: the cookie carries
    // the refresh token, and a browser that dropped it at token expiry would
    // throw away the only thing that can renew the session.
    expect(session).toContain(`; Max-Age=${SESSION_MAX_AGE_SECONDS}`)

    const cleared = cookieNamed(response, STATE_COOKIE_NAME) as string
    expect(cleared).toContain('; Max-Age=0')
  })

  // The eight-hour ceiling has to be in the seal, not only in `Max-Age`: a
  // copied cookie has no `Max-Age`, and a WorkOS token may outlive the limit.
  it('seals the lesser of the token expiry and the session ceiling', async () => {
    const longLived = SESSION_MAX_AGE_SECONDS + 100_000
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ exp: NOW_SECONDS + longLived }),
      user,
    })

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response

    const header = cookieNamed(response, SESSION_COOKIE_NAME) as string
    expect(header).toContain(`; Max-Age=${SESSION_MAX_AGE_SECONDS}`)

    const sealed = header.slice(
      header.indexOf('=') + 1,
      header.indexOf(';'),
    )
    const session = await unsealSession(sealed, config.cookiePassword)
    expect(session?.expiresAt).toBe(NOW_SECONDS + SESSION_MAX_AGE_SECONDS)
  })

  // The bug this guards: sizing the cookie to the access token had a conforming
  // browser delete the sealed refresh token at the moment it became the only
  // thing that could renew the session.
  it('outlives the access token it was sealed with', async () => {
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ exp: NOW_SECONDS + 300 }),
      refresh_token: 'refresh_one',
      user,
    })

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response

    const header = cookieNamed(response, SESSION_COOKIE_NAME) as string
    const maxAge = Number(/; Max-Age=(\d+)/.exec(header)?.[1])
    expect(maxAge).toBe(SESSION_MAX_AGE_SECONDS)
    expect(maxAge).toBeGreaterThan(300)

    // While the seal still bounds the access token at its own expiry.
    const sealed = header.slice(header.indexOf('=') + 1, header.indexOf(';'))
    const session = await unsealSession(sealed, config.cookiePassword)
    expect(session?.expiresAt).toBe(NOW_SECONDS + 300)
    expect(session?.ceiling).toBe(NOW_SECONDS + SESSION_MAX_AGE_SECONDS)
    expect(session?.refreshToken).toBe('refresh_one')
  })

  it('exchanges the code server-side, never in the browser', async () => {
    const { state, cookie } = await beginLogin()
    const provider = providerWith({ access_token: await accessToken(), user })

    await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )

    const exchange = provider.calls.find((entry) =>
      entry.url.includes('/user_management/authenticate'),
    )
    expect(exchange?.init?.method).toBe('POST')
    expect(String(exchange?.init?.body)).toContain(config.clientId)
  })

  it('records the identity and binds the admin once, by verified email', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HADMIN' }),
      user: { id: 'user_01HADMIN', email: ADMIN_EMAIL, email_verified: true },
    })

    await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )

    expect(db.schemaApplied()).toBe(true)
    expect(db.identities).toHaveLength(1)
    expect(db.identities[0]).toMatchObject({
      provider: 'workos',
      issuer: TEST_ISSUER,
      subject: 'user_01HADMIN',
    })
    expect(db.allowlist).toEqual([
      expect.objectContaining({ identity_id: 1, role: 'admin' }),
    ])
  })

  // The profile block is not signed. Only the token is, so a profile that
  // names a different subject is not this session's profile — and this is the
  // one place an email address decides anything at all.
  it('does not bind an admin when the profile names another subject', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HVICTIM' }),
      user: { id: 'user_01HATTACKER', email: ADMIN_EMAIL, email_verified: true },
    })

    await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )

    expect(db.identities).toHaveLength(1)
    expect(db.allowlist).toEqual([])
  })

  it('does not bind an admin when the profile names no subject', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HADMIN' }),
      user: { email: ADMIN_EMAIL, email_verified: true },
    })

    await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )

    expect(db.allowlist).toEqual([])
  })

  // `identity_id` is the allowlist's primary key, so the owner already added
  // as a writer would collide instead of being promoted, and there would be no
  // admin at all.
  it('promotes the owner to admin when they are already a writer', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    db.allow(
      { provider: 'workos', issuer: TEST_ISSUER, subject: 'user_01HADMIN' },
      'writer',
    )
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HADMIN' }),
      user: { id: 'user_01HADMIN', email: ADMIN_EMAIL, email_verified: true },
    })

    await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )

    expect(db.allowlist).toEqual([
      expect.objectContaining({ identity_id: 1, role: 'admin' }),
    ])
  })

  it('does not bind an admin on an unverified email', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HIMPOSTER' }),
      user: { email: ADMIN_EMAIL, email_verified: false },
    })

    await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )

    expect(db.identities).toHaveLength(1)
    expect(db.allowlist).toEqual([])
  })

  it('does not rebind the admin once one exists', async () => {
    const db = createFakeD1()
    db.allow(
      { provider: 'workos', issuer: TEST_ISSUER, subject: 'user_01HADMIN' },
      'admin',
    )

    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HLATECOMER' }),
      user: { email: ADMIN_EMAIL, email_verified: true },
    })

    await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )

    expect(db.allowlist.filter((row) => row.role === 'admin')).toEqual([
      expect.objectContaining({ identity_id: 1 }),
    ])
  })

  it('rejects a state that does not match the cookie', async () => {
    const { cookie } = await beginLogin()
    const provider = providerWith({ access_token: await accessToken(), user })

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=forged-state`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response

    expect(response.status).toBe(400)
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
    expect(provider.calls).toHaveLength(0)
  })

  it('rejects a callback with no state cookie at all', async () => {
    const { state } = await beginLogin()

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
    )) as Response

    expect(response.status).toBe(400)
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it('rejects a callback with no code', async () => {
    const { state, cookie } = await beginLogin()

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    )) as Response

    expect(response.status).toBe(400)
  })

  it('fails closed when the exchange is refused', async () => {
    const { state, cookie } = await beginLogin()
    const provider = providerWith({ error: 'invalid_grant' }, 401)

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'login_failed' })
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it('fails closed when the provider is unreachable', async () => {
    const { state, cookie } = await beginLogin()
    const provider = providerWith({ access_token: await accessToken(), user })
    provider.offline = true

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response

    expect(response.status).toBe(400)
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it('refuses a token minted for another application', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ client_id: 'client_somebody_else' }),
      user,
    })

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )) as Response

    expect(response.status).toBe(400)
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
    expect(db.identities).toEqual([])
  })

  it('never echoes the provider’s failure back to the caller', async () => {
    const { state, cookie } = await beginLogin()
    const provider = providerWith(
      { error: 'invalid_client', error_description: config.apiKey },
      400,
    )

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response
    const body = await response.text()

    expect(body).not.toContain(config.apiKey)
    expect(body).not.toContain('invalid_client')
  })
})

describe('POST /auth/logout', () => {
  it('clears the session on the path that set it', async () => {
    const response = (await call(AUTH_LOGOUT_PATH, {
      method: 'POST',
    })) as Response
    const cleared = cookieNamed(response, SESSION_COOKIE_NAME) as string

    expect(response.status).toBe(200)
    expect(cleared).toContain('; Path=/')
    expect(cleared).toContain('; Max-Age=0')
  })

  it('refuses GET, which a cross-site link could forge', async () => {
    const response = (await call(AUTH_LOGOUT_PATH)) as Response

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })
})

describe('GET /auth/me', () => {
  async function me(db?: FakeD1, subject = 'user_01HREADER') {
    const provider = providerWith({})
    const cookie = await sessionCookieHeader(await accessToken({ sub: subject }))

    return (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )) as Response
  }

  it('is anonymous and cacheable by nobody when signed out', async () => {
    const response = (await call(AUTH_ME_PATH)) as Response

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      authenticated: false,
      canWrite: false,
      isAdmin: false,
    })
  })

  it('reports a signed-in identity that may not write', async () => {
    const response = await me(createFakeD1())

    expect(await response.json()).toEqual({
      authenticated: true,
      principal: {
        provider: 'workos',
        issuer: TEST_ISSUER,
        subject: 'user_01HREADER',
      },
      canWrite: false,
      isAdmin: false,
    })
  })

  it('reports an allowlisted writer and the admin', async () => {
    const writers = createFakeD1()
    writers.allow(
      { provider: 'workos', issuer: TEST_ISSUER, subject: 'user_01HWRITER' },
      'writer',
    )
    const admins = createFakeD1()
    admins.allow(
      { provider: 'workos', issuer: TEST_ISSUER, subject: 'user_01HADMIN' },
      'admin',
    )

    await expect(
      (await me(writers, 'user_01HWRITER')).json(),
    ).resolves.toMatchObject({ canWrite: true, isAdmin: false })
    await expect(
      (await me(admins, 'user_01HADMIN')).json(),
    ).resolves.toMatchObject({ canWrite: true, isAdmin: true })
  })
})

describe('routing', () => {
  it('claims exactly the four documented paths', async () => {
    for (const path of [
      AUTH_LOGIN_PATH,
      AUTH_CALLBACK_PATH,
      AUTH_LOGOUT_PATH,
      AUTH_ME_PATH,
    ]) {
      expect(await call(path, { method: 'PUT' })).not.toBeNull()
    }
  })

  it('leaves any other path to the asset binding', async () => {
    for (const path of ['/auth', '/auth/', '/authorize', '/auth/unknown']) {
      expect(await call(path)).toBeNull()
    }
  })

  it('is 503 everywhere when WorkOS is not configured', async () => {
    for (const path of [
      AUTH_LOGIN_PATH,
      AUTH_CALLBACK_PATH,
      AUTH_ME_PATH,
    ]) {
      const response = (await call(path, {}, {})) as Response
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'auth_unavailable' })
    }
  })
})

describe('logout does not need the provider', () => {
  // Clearing a cookie needs no credentials, and a half-configured or
  // mid-rotation deployment is exactly when somebody wants out. A 503 there
  // would leave the session cookie in place with no way to remove it.
  it('clears the session even with no WorkOS configuration at all', async () => {
    for (const env of [
      {} as AuthEnv,
      { ...envWith(), WORKOS_CLIENT_ID: undefined } as AuthEnv,
      { ...envWith(), WORKOS_COOKIE_PASSWORD: 'too-short' } as AuthEnv,
    ]) {
      const response = (await call(
        AUTH_LOGOUT_PATH,
        { method: 'POST' },
        env,
      )) as Response

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const cleared = cookieNamed(response, SESSION_COOKIE_NAME) as string
      expect(cleared).toContain('; Max-Age=0')
    }
  })

  // POST alone is not a defence: `SameSite=Lax` may stop a cross-site form
  // *sending* the cookie, but the response's `Set-Cookie` deletes it anyway, so
  // any page could sign a reader out.
  it('refuses a cross-site logout', async () => {
    const cases: Record<string, string>[] = [
      { origin: 'https://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]
    for (const headers of cases) {
      const response = (await call(
        AUTH_LOGOUT_PATH,
        { method: 'POST', headers },
        envWith(),
      )) as Response

      expect(response.status, JSON.stringify(headers)).toBe(403)
      expect(await response.json()).toEqual({ error: 'cross_origin' })
      expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
    }
  })

  it('allows a logout the browser labels as this site', async () => {
    const cases: Record<string, string>[] = [
      { origin: 'https://ernie.sg' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      {},
    ]
    for (const headers of cases) {
      const response = (await call(
        AUTH_LOGOUT_PATH,
        { method: 'POST', headers },
        envWith(),
      )) as Response

      expect(response.status, JSON.stringify(headers)).toBe(200)
      expect(cookieNamed(response, SESSION_COOKIE_NAME)).toContain('; Max-Age=0')
    }
  })

  it('still refuses a GET, which a cross-site navigation could forge', async () => {
    const response = (await call(AUTH_LOGOUT_PATH, {}, {} as AuthEnv)) as Response

    expect(response.status).toBe(405)
  })

  it('still fails closed on login without configuration', async () => {
    const response = (await call(AUTH_LOGIN_PATH, {}, {} as AuthEnv)) as Response

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'auth_unavailable' })
  })
})

describe('GET /auth/me renews a lapsed access token', () => {
  const user = { email: 'reader@example.test', email_verified: true }

  async function signIn(
    accessTokenClaims: Record<string, unknown> = {},
  ): Promise<{ cookie: string }> {
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken(accessTokenClaims),
      refresh_token: 'refresh_one',
      user,
    })
    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response
    const header = cookieNamed(response, SESSION_COOKIE_NAME) as string
    return { cookie: header.slice(0, header.indexOf(';')) }
  }

  // WorkOS access tokens are short-lived, so without a refresh a sign-in would
  // last minutes rather than the eight hours the cookie claims.
  it('exchanges the sealed refresh token and re-seals the cookie', async () => {
    const { cookie } = await signIn({ exp: NOW_SECONDS + 60 })

    // Well past the access token's expiry, well inside the session ceiling.
    const later = NOW_MS + 3_600_000
    const laterSeconds = Math.floor(later / 1000)
    const provider = createFakeProvider({
      jwks: signer.jwks,
      authenticate: {
        access_token: await signer.sign({
          iss: TEST_ISSUER,
          sub: 'user_01HREADER',
          client_id: config.clientId,
          iat: laterSeconds - 10,
          exp: laterSeconds + 300,
        }),
        refresh_token: 'refresh_two',
        user,
      },
    })

    const response = (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(),
      { ...optionsFor(provider), now: later },
    )) as Response

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authenticated: true })

    const renewed = cookieNamed(response, SESSION_COOKIE_NAME) as string
    expect(renewed, 'a renewed session must come back as a cookie').toBeTruthy()
    const sealed = renewed.slice(renewed.indexOf('=') + 1, renewed.indexOf(';'))
    const session = await unsealSession(sealed, config.cookiePassword)
    expect(session?.refreshToken).toBe('refresh_two')
    expect(session?.expiresAt).toBeGreaterThan(laterSeconds)

    const refresh = provider.calls.find((entry) =>
      String(entry.init?.body ?? '').includes('refresh_token'),
    )
    expect(refresh, 'the refresh grant must be used').toBeTruthy()
  })

  // Otherwise refreshing in a loop would make the ceiling decorative.
  it('will not refresh past the ceiling fixed at login', async () => {
    const { cookie } = await signIn({ exp: NOW_SECONDS + 60 })

    const past = NOW_MS + (SESSION_MAX_AGE_SECONDS + 60) * 1000
    const provider = providerWith({
      access_token: await accessToken({ exp: Math.floor(past / 1000) + 300 }),
      refresh_token: 'refresh_two',
      user,
    })

    const response = (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(),
      { ...optionsFor(provider), now: past },
    )) as Response

    expect(await response.json()).toMatchObject({ authenticated: false })
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it('does not renew when the provider refuses the refresh token', async () => {
    const { cookie } = await signIn({ exp: NOW_SECONDS + 60 })

    const response = (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(),
      { ...optionsFor(providerWith({}, 401)), now: NOW_MS + 3_600_000 },
    )) as Response

    expect(await response.json()).toMatchObject({ authenticated: false })
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it.each([400, 401, 422])('clears a terminal invalid_grant refresh at HTTP %i', async (status) => {
    const { cookie } = await signIn({ exp: NOW_SECONDS + 60 })
    const provider = providerWith({ error: 'invalid_grant' }, status)

    const response = (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(),
      { ...optionsFor(provider), now: NOW_MS + 3_600_000 },
    )) as Response

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authenticated: false })
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toContain('; Max-Age=0')
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toContain('; Path=/')
  })

  it.each([408, 429, 503])('keeps a retryable HTTP %i refresh session', async (status) => {
    const { cookie } = await signIn({ exp: NOW_SECONDS + 60 })
    const response = (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(),
      { ...optionsFor(providerWith({ error: 'invalid_grant' }, status)), now: NOW_MS + 3_600_000 },
    )) as Response

    expect(await response.json()).toMatchObject({ authenticated: false })
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it('keeps the session when the refresh network is unavailable', async () => {
    const { cookie } = await signIn({ exp: NOW_SECONDS + 60 })
    const provider = providerWith({ error: 'invalid_grant' }, 400)
    provider.offline = true
    const response = (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(),
      { ...optionsFor(provider), now: NOW_MS + 3_600_000 },
    )) as Response

    expect(await response.json()).toMatchObject({ authenticated: false })
    expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })
})

describe('a partial outage is not a permanent logout', () => {
  const user = { id: 'user_01HREADER', email: 'reader@example.test', email_verified: true }

  // The exchange consumes the old refresh token. If verification then fails
  // transiently and no cookie goes back, the browser keeps a spent token and no
  // later attempt can recover, however healthy the provider becomes.
  it('returns the rotated refresh token even when verification fails', async () => {
    const cookie = `${SESSION_COOKIE_NAME}=${await (async () => {
      const header = await sessionCookieHeader(await accessToken(), {
        expiresAt: NOW_SECONDS - 60,
        ceiling: NOW_SECONDS + 3_600,
        refreshToken: 'refresh_one',
      })
      return header.slice(header.indexOf('=') + 1)
    })()}`

    // The exchange succeeds and rotates; the key set is unavailable, so the new
    // token cannot be verified.
    const provider = createFakeProvider({
      authenticate: {
        access_token: await accessToken({ exp: NOW_SECONDS + 300 }),
        refresh_token: 'refresh_two',
        user,
      },
    })

    const response = (await call(
      AUTH_ME_PATH,
      { headers: { cookie } },
      envWith(),
      optionsFor(provider),
    )) as Response

    expect(await response.json()).toMatchObject({ authenticated: false })
    const renewed = cookieNamed(response, SESSION_COOKIE_NAME) as string
    expect(renewed, 'the rotated token must reach the browser').toBeTruthy()
    const sealed = renewed.slice(renewed.indexOf('=') + 1, renewed.indexOf(';'))
    const session = await unsealSession(sealed, config.cookiePassword)
    expect(session?.refreshToken).toBe('refresh_two')
    // And the cookie authorises nothing on its own: `expiresAt` did not move.
    expect(session?.expiresAt).toBe(NOW_SECONDS - 60)
  })

  // A database outage during the callback used to leave a valid session with no
  // identity row, and the documented out-of-band allowlist insert selects on it.
  it('writes the identity a callback outage skipped, on the next /auth/me', async () => {
    const db = createFakeD1()
    db.offline = true
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HADMIN' }),
      refresh_token: 'refresh_one',
      user: { id: 'user_01HADMIN', email: ADMIN_EMAIL, email_verified: true },
    })

    const callback = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )) as Response

    // The session was still issued — the provider validated it.
    expect(callback.status).toBe(302)
    expect(db.identities).toHaveLength(0)
    expect(db.allowlist).toHaveLength(0)

    const header = cookieNamed(callback, SESSION_COOKIE_NAME) as string
    const session = header.slice(0, header.indexOf(';'))

    db.offline = false
    const me = (await call(
      AUTH_ME_PATH,
      { headers: { cookie: session } },
      envWith(db),
      optionsFor(provider),
    )) as Response

    expect(await me.json()).toMatchObject({ authenticated: true, isAdmin: true })
    expect(db.identities).toHaveLength(1)
    expect(db.identities[0]).toMatchObject({ subject: 'user_01HADMIN' })
    expect(db.allowlist).toEqual([
      expect.objectContaining({ identity_id: 1, role: 'admin' }),
    ])
  })
})

describe('/auth/me in local development', () => {
  // `MARGIN_ENVIRONMENT=development` with a stub and no WorkOS credentials is
  // the ordinary `wrangler dev` state. The write gate honours the stub, so this
  // has to as well, or a local client cannot see the identity its own writes use.
  const devEnv = {
    MARGIN_ENVIRONMENT: 'development',
    MARGIN_DEV_PRINCIPAL: 'reader',
  } as AuthEnv

  function localMe(env: AuthEnv = devEnv) {
    return handleAuthRequest(
      new Request(`http://localhost:8788${AUTH_ME_PATH}`),
      env,
      { now: NOW_MS },
    )
  }

  it('reports the development principal with no WorkOS configuration', async () => {
    const response = (await localMe()) as Response

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      authenticated: true,
      principal: { provider: 'dev', subject: 'reader' },
    })
  })

  it('reports its allowlist role like any other identity', async () => {
    const db = createFakeD1()
    db.allow(
      { provider: 'dev', issuer: 'urn:margin:dev', subject: 'reader' },
      'admin',
    )

    const response = (await localMe({ ...devEnv, MARGIN_DB: db } as AuthEnv)) as Response

    expect(await response.json()).toMatchObject({ canWrite: true, isAdmin: true })
  })

  it('still fails closed with no configuration and no stub', async () => {
    const response = (await handleAuthRequest(
      new Request(`http://localhost:8788${AUTH_ME_PATH}`),
      { MARGIN_ENVIRONMENT: 'development' } as AuthEnv,
      {},
    )) as Response

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'auth_unavailable' })
  })

  it('does not answer on a deployed hostname, stub or no stub', async () => {
    const response = (await handleAuthRequest(
      new Request(`https://ernie.sg${AUTH_ME_PATH}`),
      devEnv,
      {},
    )) as Response

    expect(response.status).toBe(503)
  })

  it('leaves login and callback failing closed', async () => {
    for (const path of [AUTH_LOGIN_PATH, AUTH_CALLBACK_PATH]) {
      const response = (await handleAuthRequest(
        new Request(`http://localhost:8788${path}`),
        devEnv,
        {},
      )) as Response
      expect(response.status, path).toBe(503)
    }
  })
})

describe('review findings, round six', () => {
  const user = { id: 'user_01HREADER', email: 'reader@example.test', email_verified: true }

  // The profile block is not signed. An email from a response whose `user.id`
  // does not match the signed `sub` is somebody else's address, and it was being
  // persisted, sealed and reported by `/auth/me`.
  it('keeps an email that does not belong to this subject out of the session', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HVICTIM' }),
      refresh_token: 'refresh_one',
      // A valid token for one subject, a profile naming another.
      user: { id: 'user_01HSOMEBODYELSE', email: 'other@example.test', email_verified: true },
    })

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )) as Response

    // The session is still issued: the token verified.
    expect(response.status).toBe(302)

    const header = cookieNamed(response, SESSION_COOKIE_NAME) as string
    const sealed = header.slice(header.indexOf('=') + 1, header.indexOf(';'))
    const session = await unsealSession(sealed, config.cookiePassword)
    expect(session?.email, 'the seal must not carry the other account\'s email')
      .toBeUndefined()

    // And nothing persisted it either.
    expect(db.identities).toHaveLength(1)
    expect(db.identities[0]).toMatchObject({
      subject: 'user_01HVICTIM',
      email: null,
    })
  })

  it('keeps the email when the profile does name this subject', async () => {
    const db = createFakeD1()
    const { state, cookie } = await beginLogin()
    const provider = providerWith({
      access_token: await accessToken({ sub: 'user_01HREADER' }),
      refresh_token: 'refresh_one',
      user,
    })

    const response = (await call(
      `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
      envWith(db),
      optionsFor(provider),
    )) as Response

    const header = cookieNamed(response, SESSION_COOKIE_NAME) as string
    const sealed = header.slice(header.indexOf('=') + 1, header.indexOf(';'))
    const session = await unsealSession(sealed, config.cookiePassword)
    expect(session?.email).toBe('reader@example.test')
    expect(db.identities[0]).toMatchObject({ email: 'reader@example.test' })
  })

  // A page with several requests open sends the same refresh token on each, and
  // the exchange consumes it — so without coalescing the first wins and the rest
  // come back anonymous while holding a spent token.
  it('exchanges once for several parallel requests on one session', async () => {
    const { cookie } = await (async () => {
      const { state, cookie: state_cookie } = await beginLogin()
      const provider = providerWith({
        access_token: await accessToken({ exp: NOW_SECONDS + 60 }),
        refresh_token: 'refresh_one',
        user,
      })
      const response = (await call(
        `${AUTH_CALLBACK_PATH}?code=code_placeholder&state=${encodeURIComponent(state)}`,
        { headers: { cookie: state_cookie } },
        envWith(),
        optionsFor(provider),
      )) as Response
      const header = cookieNamed(response, SESSION_COOKIE_NAME) as string
      return { cookie: header.slice(0, header.indexOf(';')) }
    })()

    const later = NOW_MS + 3_600_000
    const laterSeconds = Math.floor(later / 1000)
    const provider = createFakeProvider({
      jwks: signer.jwks,
      authenticate: {
        access_token: await signer.sign({
          iss: TEST_ISSUER,
          sub: 'user_01HREADER',
          client_id: config.clientId,
          iat: laterSeconds - 10,
          exp: laterSeconds + 300,
        }),
        refresh_token: 'refresh_two',
        user,
      },
    })
    const options = { ...optionsFor(provider), now: later }

    const request = () =>
      handleAuthRequest(
        new Request(`https://ernie.sg${AUTH_ME_PATH}`, { headers: { cookie } }),
        envWith(),
        options,
      )
    const responses = (await Promise.all([
      request(),
      request(),
      request(),
    ])) as Response[]

    // Every one of them is signed in, not just the first.
    for (const [index, response] of responses.entries()) {
      expect(await response.json(), `request ${index}`).toMatchObject({
        authenticated: true,
      })
    }

    // And the refresh grant was exchanged exactly once.
    const exchanges = provider.calls.filter((entry) =>
      String(entry.init?.body ?? '').includes('refresh_token'),
    )
    expect(exchanges).toHaveLength(1)
  })
})

/**
 * No test in this file waits on a real timeout. Every bound the code under
 * test enforces (provider calls, waiters, the renewal slot, the grace window)
 * runs on `setTimeout` and `Date`, which are virtual here: time passes only
 * when a test advances it, so a loaded CI machine cannot push a test past a
 * bound it did not mean to cross. Real I/O (WebCrypto) still runs for real.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

/** A virtual delay inside a fake provider; passes only when a test advances time. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Lets real work (WebCrypto) run until `ready()` holds. No virtual time passes. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; !ready(); turn += 1) {
    if (turn > 200_000) throw new Error('the awaited state was never reached')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Starts `work` and returns once it has parked on `timers` new timers, so a
 * following `advance` lands on a known state instead of racing real work.
 */
async function parked<T>(
  work: () => Promise<T>,
  timers = 1,
): Promise<{ result: Promise<T> }> {
  const before = vi.getTimerCount()
  const result = work()
  await until(() => vi.getTimerCount() >= before + timers)
  // Wrapped, so awaiting this does not also await the work itself.
  return { result }
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/**
 * A fetch whose token-exchange response the test controls: it can hang
 * forever and ignore its abort signal (an originating request that was
 * cancelled), hang until its signal aborts (a slow provider), answer after a
 * delay, or answer at once. Key-set requests answer after `jwksDelayMs`.
 */
function controlledTokenEndpoint(
  answer: () => Promise<unknown>,
  { jwksDelayMs = 0 }: { jwksDelayMs?: number } = {},
) {
  let mode: 'orphaned' | 'slow' | 'delayed' | 'answer' = 'orphaned'
  let delayMs = 0
  const signals: Array<AbortSignal | null | undefined> = []
  let exchanges = 0
  let keySetCalls = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!url.includes('/user_management/authenticate')) {
      keySetCalls += 1
      if (jwksDelayMs) await sleep(jwksDelayMs)
      return new Response(JSON.stringify(signer.jwks), { status: 200 })
    }
    exchanges += 1
    signals.push(init?.signal)
    if (mode === 'orphaned') return new Promise<Response>(() => {})
    if (mode === 'slow') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }
    if (mode === 'delayed') await sleep(delayMs)
    return new Response(JSON.stringify(await answer()), { status: 200 })
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    signals,
    exchanges: () => exchanges,
    keySetCalls: () => keySetCalls,
    set(next: typeof mode, ms = 0) {
      mode = next
      delayMs = ms
    },
  }
}

describe('a shared renewal never outlives its waiters', () => {
  const later = NOW_MS + 3_600_000
  const laterSeconds = Math.floor(later / 1000)
  // Short bounds so the test runs in milliseconds. The originator's budget is
  // derived from these by `renewalBounds`, as in production.
  const PROVIDER_TIMEOUT_MS = 50

  async function lapsedSession(): Promise<Request> {
    const stale = await accessToken({ iat: NOW_SECONDS - 70, exp: NOW_SECONDS - 60 })
    const cookie = await sessionCookieHeader(stale, {
      expiresAt: NOW_SECONDS - 60,
      ceiling: laterSeconds + 3_600,
      refreshToken: 'refresh_one',
    })
    return new Request(`https://ernie.sg${AUTH_ME_PATH}`, { headers: { cookie } })
  }

  const fresh = async () => ({
    access_token: await signer.sign({
      iss: TEST_ISSUER,
      sub: 'user_01HREADER',
      client_id: config.clientId,
      iat: laterSeconds - 10,
      exp: laterSeconds + 300,
    }),
    refresh_token: 'refresh_two',
  })

  function options(
    endpoint: ReturnType<typeof controlledTokenEndpoint>,
    jwks?: AuthOptions['jwks'],
  ): AuthOptions {
    return {
      now: later,
      fetchImpl: endpoint.fetchImpl,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      jwks:
        jwks ??
        createJwksSource(jwksUrl(config), {
          fetchImpl: endpoint.fetchImpl,
          now: () => later,
          fetchTimeoutMs: PROVIDER_TIMEOUT_MS,
        }),
    }
  }

  // The rule: only the originator frees the slot, so a renewal that is slow
  // but healthy (longer than a waiter's wait, shorter than the originator's
  // bound) is never duplicated with the same single-use refresh token.
  it('never starts a second exchange under a slow but healthy renewal', async () => {
    // Exchange 40 ms, then a cold key-set fetch of 40 ms: about 80 ms in all,
    // past the 50 ms a waiter waits and inside the 200 ms originator bound.
    const endpoint = controlledTokenEndpoint(fresh, { jwksDelayMs: 40 })
    endpoint.set('delayed', 40)
    const request = await lapsedSession()
    const shared = options(endpoint)

    // The originator parks on its exchange: the abort bound and the 40 ms delay.
    const originator = (await parked(() => renewSession(request.clone(), config, shared), 2)).result
    await advance(5)
    const earlyWaiter = (await parked(() => renewSession(request.clone(), config, shared))).result
    // 50 ms later the exchange has answered (at 40) and the waiter has given up.
    await advance(50)
    const early = await earlyWaiter
    expect(early, 'a waiter past its own wait goes unrenewed').toBeNull()
    // The originator is now in its 40 ms key-set fetch.
    await until(() => endpoint.keySetCalls() >= 1)
    // Arrives after that waiter gave up, while the originator is still working.
    const late = (await parked(() => renewSession(request.clone(), config, shared))).result
    // The key set answers before this waiter's own 50 ms bound.
    await advance(40)

    const [first, joined] = await Promise.all([originator, late])
    expect(first?.kind).toBe('renewed')
    expect(joined?.kind).toBe('renewed')
    expect(endpoint.exchanges(), 'one exchange for the whole burst').toBe(1)
  })

  it('lets waiters go when the originating request is cancelled, and frees the slot only past its bound', async () => {
    const endpoint = controlledTokenEndpoint(fresh)
    const request = await lapsedSession()

    // The originator's exchange never settles, as when its request is gone.
    void renewSession(request.clone(), config, options(endpoint))
    await until(() => endpoint.exchanges() === 1)
    const started = Date.now()
    const waiting = (await parked(() => renewSession(request.clone(), config, options(endpoint)))).result
    await advance(PROVIDER_TIMEOUT_MS)
    const waiter = await waiting
    expect(waiter, 'a waiter goes unrenewed rather than hanging').toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)

    // Inside the originator's bound the slot is still its own: no second
    // exchange with the single-use refresh token.
    const inside = (await parked(() => renewSession(request.clone(), config, options(endpoint)))).result
    await advance(PROVIDER_TIMEOUT_MS)
    expect(await inside).toBeNull()
    expect(endpoint.exchanges()).toBe(1)

    // Past the bound every part of that renewal has been aborted, so the next
    // request renews on its own.
    const { slot } = renewalBounds(
      PROVIDER_TIMEOUT_MS,
      options(endpoint).jwks as NonNullable<AuthOptions['jwks']>,
    )
    await advance(slot + 20)
    endpoint.set('answer')
    const next = await renewSession(request.clone(), config, options(endpoint))
    expect(next?.kind).toBe('renewed')
    expect(endpoint.exchanges()).toBe(2)
  })

  it('bounds the token exchange, and a timeout keeps the session', async () => {
    const endpoint = controlledTokenEndpoint(async () => ({}))
    endpoint.set('slow')
    const request = await lapsedSession()

    const started = Date.now()
    const renewing = (await parked(() => renewSession(request, config, options(endpoint)))).result
    await advance(PROVIDER_TIMEOUT_MS)
    const renewal = await renewing
    // Retryable, not terminal: no cleared cookie, the user stays signed in.
    expect(renewal).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(endpoint.signals[0], 'the exchange carries an abort signal').toBeInstanceOf(
      AbortSignal,
    )
    expect(endpoint.signals[0]?.aborted).toBe(true)
  })

  it('answers a renewal that throws as unrenewed, never as a 500', async () => {
    const endpoint = controlledTokenEndpoint(fresh)
    endpoint.set('answer')
    // The first key lookup (the ordinary principal check) works; every one
    // after it, inside the renewal, throws.
    let lookups = 0
    const good = createJwksSource(jwksUrl(config), {
      fetchImpl: endpoint.fetchImpl,
      now: () => later,
    })
    const throwing: AuthOptions['jwks'] = {
      worstCaseMs: good.worstCaseMs,
      async getKey(kid) {
        lookups += 1
        if (lookups > 1) throw new Error('key store exploded')
        return good.getKey(kid)
      },
    }

    const request = await lapsedSession()
    // Called directly, the renewal's own lookup is the first: make it throw.
    lookups = 1
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        renewSession(request.clone(), config, options(endpoint, throwing)),
      ).resolves.toBeNull()
      // Logged by class only: never the message, which could carry tokens.
      expect(logged).toHaveBeenCalledWith('[margin] session renewal failed: Error')
      expect(JSON.stringify(logged.mock.calls)).not.toContain('exploded')
    } finally {
      logged.mockRestore()
    }

    lookups = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = (await handleAuthRequest(
      request.clone(),
      envWith(),
      options(endpoint, throwing),
    )) as Response
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authenticated: false })
    vi.restoreAllMocks()
  })

  // Verification after the exchange can run a whole key-set refresh chain
  // during a rotation. The originator must still settle inside its slot, and
  // hand back the rotated refresh token, so no one re-exchanges the spent one.
  it('settles inside its bound when key-set verification stalls during a rotation', async () => {
    const rotated = await foreignSigner('rotated-during-renewal')
    // The key-set endpoint serves the old keys once (a warm cache), then hangs
    // and ignores its abort signal, as a stalled fetch of the new key would.
    let keySetCalls = 0
    const keySetFetch = (async () => {
      keySetCalls += 1
      if (keySetCalls === 1) {
        return new Response(JSON.stringify(signer.jwks), { status: 200 })
      }
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const jwks = createJwksSource(jwksUrl(config), {
      fetchImpl: keySetFetch,
      now: () => later,
      fetchTimeoutMs: PROVIDER_TIMEOUT_MS,
    })
    await jwks.getKey(signer.jwks.keys[0]!.kid)

    const endpoint = controlledTokenEndpoint(async () => ({
      access_token: await rotated.sign(
        {
          iss: TEST_ISSUER,
          sub: 'user_01HREADER',
          client_id: config.clientId,
          iat: laterSeconds - 10,
          exp: laterSeconds + 300,
        },
        { kid: 'rotated-during-renewal' },
      ),
      refresh_token: 'refresh_two',
    }))
    endpoint.set('answer')
    const request = await lapsedSession()
    const shared = options(endpoint, jwks)
    const { verifyBy, slot } = renewalBounds(PROVIDER_TIMEOUT_MS, jwks)

    const started = Date.now()
    const originator = renewSession(request.clone(), config, shared)
    // Verification is now stuck on the stalled fetch of the new key.
    await until(() => keySetCalls >= 2)
    // Requests keep arriving for as long as it is stuck. Past a 5 s-scale
    // bound, the previous code treated this slot as abandoned and let one of
    // them exchange the spent token. A request that arrives with the old
    // cookie after the originator has settled is a new renewal by design: the
    // browser holds the rotated cookie by then.
    const burst: Array<Promise<unknown>> = []
    for (const at of [10, verifyBy / 2, verifyBy - 20]) {
      await advance(Math.max(0, started + at - Date.now()))
      burst.push((await parked(() => renewSession(request.clone(), config, shared))).result)
    }
    // Up to the originator's own verification deadline, and no further.
    await advance(started + verifyBy - Date.now())
    const renewal = await originator
    const settledAfter = Date.now() - started
    await Promise.all(burst)

    expect(settledAfter, 'the originator settles inside its slot').toBeLessThan(slot)
    expect(endpoint.exchanges(), 'no second exchange of the spent token').toBe(1)
    // Unverified, but the rotated refresh token still reaches the browser.
    expect(renewal?.kind).toBe('renewed')
    const cookie = (renewal as { cookie: string }).cookie
    const sealedValue = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))
    const session = await unsealSession(sealedValue, config.cookiePassword)
    expect(session?.refreshToken).toBe('refresh_two')
    expect((renewal as { principal?: unknown }).principal).toBeUndefined()
  })

  // The browser sends some requests with the old cookie before it applies the
  // rotated one. They must get the same new session, not re-exchange the
  // spent refresh token and come back with a sign-out.
  it('hands a just-finished renewal to requests that still carry the old cookie', async () => {
    const endpoint = controlledTokenEndpoint(fresh)
    endpoint.set('answer')
    const request = await lapsedSession()
    const shared = options(endpoint)

    const first = await renewSession(request.clone(), config, shared)
    expect(first?.kind).toBe('renewed')

    const stragglers = await Promise.all(
      Array.from({ length: 5 }, () => renewSession(request.clone(), config, shared)),
    )
    expect(endpoint.exchanges(), 'one exchange for the renewal and every straggler').toBe(1)
    for (const straggler of stragglers) {
      expect(straggler?.kind).toBe('renewed')
      expect((straggler as { cookie: string }).cookie).toBe(
        (first as { cookie: string }).cookie,
      )
      const session = (straggler as { session: { refreshToken?: string } }).session
      expect(session.refreshToken).toBe('refresh_two')
      expect((straggler as { principal?: unknown }).principal).toEqual(
        (first as { principal?: unknown }).principal,
      )
    }
  })

  it('does not remember a failed renewal, so the next request retries', async () => {
    const endpoint = controlledTokenEndpoint(fresh)
    endpoint.set('slow')
    const request = await lapsedSession()
    const shared = options(endpoint)

    const failing = (await parked(() => renewSession(request.clone(), config, shared))).result
    await advance(PROVIDER_TIMEOUT_MS)
    await expect(failing).resolves.toBeNull()
    expect(endpoint.exchanges()).toBe(1)

    endpoint.set('answer')
    const retried = await renewSession(request.clone(), config, shared)
    expect(retried?.kind).toBe('renewed')
    expect(endpoint.exchanges(), 'the failure was retried, not replayed').toBe(2)
  })

  it('does not remember a terminal renewal either', async () => {
    let exchanges = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.includes('/user_management/authenticate')) {
        return new Response(JSON.stringify(signer.jwks), { status: 200 })
      }
      exchanges += 1
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }) as unknown as typeof fetch
    const request = await lapsedSession()
    const shared: AuthOptions = {
      now: later,
      fetchImpl,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    }

    expect((await renewSession(request.clone(), config, shared))?.kind).toBe('terminal')
    expect((await renewSession(request.clone(), config, shared))?.kind).toBe('terminal')
    expect(exchanges).toBe(2)
  })

  // The rule: a logout ends every path back to that session in this isolate.
  describe('logout ends every path back to the session', () => {
    async function renewedPair() {
      const endpoint = controlledTokenEndpoint(fresh)
      endpoint.set('answer')
      const request = await lapsedSession()
      const shared = options(endpoint)
      const renewal = await renewSession(request.clone(), config, shared)
      expect(renewal?.kind).toBe('renewed')
      const setCookie = (renewal as { cookie: string }).cookie
      return {
        endpoint,
        shared,
        request,
        oldCookie: request.headers.get('cookie') as string,
        newCookie: setCookie.slice(0, setCookie.indexOf(';')),
      }
    }

    async function logOutWith(cookie: string) {
      const response = (await call(AUTH_LOGOUT_PATH, {
        method: 'POST',
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
      })) as Response
      expect(response.status).toBe(200)
    }

    async function replayOldCookie(pair: Awaited<ReturnType<typeof renewedPair>>) {
      const replayed = await renewSession(pair.request.clone(), config, pair.shared)
      const handled = (await handleAuthRequest(
        pair.request.clone(),
        envWith(),
        pair.shared,
      )) as Response
      const restored = setCookies(handled).filter(
        (header) =>
          header.startsWith(`${SESSION_COOKIE_NAME}=`) && !header.includes('Max-Age=0'),
      )
      return { replayed, restored }
    }

    it('after logging out with the new cookie, a replayed old cookie gets no session', async () => {
      const pair = await renewedPair()
      await logOutWith(pair.newCookie)
      const { replayed, restored } = await replayOldCookie(pair)
      expect(replayed).toBeNull()
      expect(restored, 'no session Set-Cookie').toEqual([])
      expect(pair.endpoint.exchanges(), 'and no new exchange').toBe(1)
    })

    it('after logging out with the old cookie, replaying it gets no session either', async () => {
      const pair = await renewedPair()
      await logOutWith(pair.oldCookie)
      const { replayed, restored } = await replayOldCookie(pair)
      expect(replayed).toBeNull()
      expect(restored, 'no session Set-Cookie').toEqual([])
      expect(pair.endpoint.exchanges()).toBe(1)
    })

    it('follows a chain of renewals from its newest cookie back to the first', async () => {
      const pair = await renewedPair()
      // Renew again from the new cookie, so old -> new -> newer.
      const second = controlledTokenEndpoint(async () => ({
        ...(await fresh()),
        refresh_token: 'refresh_three',
      }))
      second.set('answer')
      const newRequest = new Request(`https://ernie.sg${AUTH_ME_PATH}`, {
        headers: { cookie: pair.newCookie },
      })
      // Its access token is the unverified old one, so it is lapsed too.
      const again = await renewSession(newRequest, config, options(second))
      expect(again?.kind).toBe('renewed')
      const newer = (again as { cookie: string }).cookie
      await logOutWith(newer.slice(0, newer.indexOf(';')))

      expect((await replayOldCookie(pair)).replayed).toBeNull()
      expect(
        await renewSession(
          new Request(`https://ernie.sg${AUTH_ME_PATH}`, { headers: { cookie: pair.newCookie } }),
          config,
          options(second),
        ),
      ).toBeNull()
    })

    it('drops a renewal that was still in flight when its session logged out', async () => {
      const endpoint = controlledTokenEndpoint(fresh)
      endpoint.set('delayed', 40)
      const request = await lapsedSession()
      // Parked in its 40 ms exchange when the logout lands.
      const pending = (await parked(
        () => renewSession(request.clone(), config, options(endpoint)),
        2,
      )).result
      await advance(5)
      await logOutWith(request.headers.get('cookie') as string)
      await advance(40)
      await expect(pending).resolves.toBeNull()
      expect(await renewSession(request.clone(), config, options(endpoint))).toBeNull()
    })
  })

  it('caps a replayed cookie at the session ceiling', async () => {
    const endpoint = controlledTokenEndpoint(fresh)
    endpoint.set('answer')
    const request = await lapsedSession()
    const first = await renewSession(request.clone(), config, options(endpoint))
    const firstCookie = (first as { cookie: string }).cookie
    const firstMaxAge = Number(/Max-Age=(\d+)/u.exec(firstCookie)?.[1])

    // Replayed ten seconds later by the session clock: ten seconds less.
    const replayed = await renewSession(request.clone(), config, {
      ...options(endpoint),
      now: later + 10_000,
    })
    const replayedMaxAge = Number(
      /Max-Age=(\d+)/u.exec((replayed as { cookie: string }).cookie)?.[1],
    )
    expect(replayedMaxAge).toBe(firstMaxAge - 10)
    expect(endpoint.exchanges()).toBe(1)
  })
})

