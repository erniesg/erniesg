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
import { SESSION_COOKIE_NAME, STATE_COOKIE_NAME } from './session'

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
    expect(session).toContain('; Max-Age=300')

    const cleared = cookieNamed(response, STATE_COOKIE_NAME) as string
    expect(cleared).toContain('; Max-Age=0')
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
      user: { email: ADMIN_EMAIL, email_verified: true },
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
