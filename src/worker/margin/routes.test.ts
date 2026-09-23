import { beforeAll, describe, expect, it } from 'vitest'
import { jwksUrl, readWorkosConfig, type WorkosConfig } from './config'
import {
  createFakeD1,
  createFakeProvider,
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
  safeReturnPath,
  type AuthEnv,
  type AuthOptions,
} from './routes'
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

  it('pins the state to the browser in a short-lived /auth cookie', async () => {
    const response = (await call(AUTH_LOGIN_PATH)) as Response
    const cookie = cookieNamed(response, STATE_COOKIE_NAME) as string

    expect(cookie).toContain('; Path=/auth')
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
