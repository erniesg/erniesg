import { beforeAll, describe, expect, it } from 'vitest'
import { jwksUrl, readWorkosConfig, type WorkosConfig } from './margin/config'
import {
  createFakeProvider,
  sessionCookieHeader,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_COOKIE_PASSWORD,
  TEST_ISSUER,
  TEST_OTHER_PASSWORD,
  type TestSigner,
} from './margin/fake-workos'
import { createJwksSource } from './margin/jwt'
import { sealSession, SESSION_COOKIE_NAME } from './margin/session'
import {
  DEV_PRINCIPAL_HEADER,
  getPrincipal,
  principalSchema,
  type PrincipalEnv,
} from './principal'

const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = Math.floor(NOW_MS / 1000)

const config = readWorkosConfig(testWorkosEnv()) as WorkosConfig

let signer: TestSigner

beforeAll(async () => {
  signer = await testSigner()
})

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: TEST_ISSUER,
    sub: 'user_01HREADER',
    client_id: TEST_CLIENT_ID,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
    ...overrides,
  }
}

function request(headers: Record<string, string> = {}) {
  return new Request('https://ernie.sg/api/margin/v1/annotations', { headers })
}

function signedInEnv(overrides: Partial<PrincipalEnv> = {}): PrincipalEnv {
  return { ...testWorkosEnv(), MARGIN_ENVIRONMENT: 'production', ...overrides }
}

function options(provider = createFakeProvider({ jwks: signer.jwks })) {
  return {
    now: NOW_MS,
    jwks: createJwksSource(jwksUrl(config), {
      fetchImpl: provider.fetchImpl,
      now: () => NOW_MS,
    }),
  }
}

describe('getPrincipal with a real session', () => {
  it('returns the identity carried by a valid access token', async () => {
    const cookie = await sessionCookieHeader(await signer.sign(claims()), {
      email: 'reader@example.test',
    })

    await expect(
      getPrincipal(request({ cookie }), signedInEnv(), options()),
    ).resolves.toEqual({
      provider: 'workos',
      issuer: TEST_ISSUER,
      subject: 'user_01HREADER',
      email: 'reader@example.test',
    })
  })

  it('is anonymous with no cookie at all, which is how reading works', async () => {
    await expect(
      getPrincipal(request(), signedInEnv(), options()),
    ).resolves.toBeNull()
  })

  it('rejects a cookie sealed with a different password', async () => {
    const sealed = await sealSession(
      { accessToken: await signer.sign(claims()), expiresAt: NOW_SECONDS + 300 },
      TEST_OTHER_PASSWORD,
    )

    await expect(
      getPrincipal(
        request({ cookie: `${SESSION_COOKIE_NAME}=${sealed}` }),
        signedInEnv(),
        options(),
      ),
    ).resolves.toBeNull()
  })

  it('rejects a cookie that is not a seal of ours', async () => {
    for (const value of ['', 'not-sealed', 'v1.a.b.c']) {
      await expect(
        getPrincipal(
          request({ cookie: `${SESSION_COOKIE_NAME}=${value}` }),
          signedInEnv(),
          options(),
        ),
      ).resolves.toBeNull()
    }
  })

  it('rejects an expired token even though the seal is intact', async () => {
    const cookie = await sessionCookieHeader(
      await signer.sign(claims({ exp: NOW_SECONDS - 1 })),
    )

    await expect(
      getPrincipal(request({ cookie }), signedInEnv(), options()),
    ).resolves.toBeNull()
  })

  it('rejects a token issued to a different WorkOS application', async () => {
    const cookie = await sessionCookieHeader(
      await signer.sign(claims({ client_id: 'client_some_other_application' })),
    )

    await expect(
      getPrincipal(request({ cookie }), signedInEnv(), options()),
    ).resolves.toBeNull()
  })

  it('rejects a token from the wrong issuer', async () => {
    const cookie = await sessionCookieHeader(
      await signer.sign(claims({ iss: 'https://api.workos.example' })),
    )

    await expect(
      getPrincipal(request({ cookie }), signedInEnv(), options()),
    ).resolves.toBeNull()
  })

  it('is anonymous when WorkOS is not configured at all', async () => {
    const cookie = await sessionCookieHeader(await signer.sign(claims()))

    await expect(
      getPrincipal(
        request({ cookie }),
        { MARGIN_ENVIRONMENT: 'production' },
        options(),
      ),
    ).resolves.toBeNull()
  })

  it('keys identity on (provider, issuer, subject)', () => {
    expect(() =>
      principalSchema.parse({
        provider: 'workos',
        issuer: TEST_ISSUER,
        subject: 'user_123',
        role: 'admin',
      }),
    ).toThrow()
  })
})

describe('with the provider unreachable', () => {
  it('fails closed instead of falling back to a header or an email', async () => {
    const provider = createFakeProvider({ jwks: signer.jwks })
    provider.offline = true
    const cookie = await sessionCookieHeader(await signer.sign(claims()), {
      email: 'hello@ernie.sg',
    })

    await expect(
      getPrincipal(
        request({
          cookie,
          [DEV_PRINCIPAL_HEADER]: 'user_01HADMIN',
          'x-forwarded-email': 'hello@ernie.sg',
        }),
        signedInEnv(),
        options(provider),
      ),
    ).resolves.toBeNull()
  })
})

describe('the development stub', () => {
  it('is unreachable unless MARGIN_ENVIRONMENT is exactly development', async () => {
    for (const environment of [undefined, 'production', 'staging', 'Development']) {
      await expect(
        getPrincipal(request({ [DEV_PRINCIPAL_HEADER]: 'anyone' }), {
          MARGIN_ENVIRONMENT: environment,
          MARGIN_DEV_PRINCIPAL: 'reader',
        }),
      ).resolves.toBeNull()
    }
  })

  it('still works in development, where it is the point', async () => {
    const env: PrincipalEnv = {
      MARGIN_ENVIRONMENT: 'development',
      MARGIN_DEV_PRINCIPAL: 'reader',
    }

    await expect(getPrincipal(request(), env)).resolves.toEqual({
      provider: 'dev',
      issuer: 'urn:margin:dev',
      subject: 'reader',
    })
    await expect(
      getPrincipal(request({ [DEV_PRINCIPAL_HEADER]: 'other' }), env),
    ).resolves.toMatchObject({ subject: 'other' })
  })

  it('needs the env var as well as the environment', async () => {
    await expect(
      getPrincipal(request({ [DEV_PRINCIPAL_HEADER]: 'reader' }), {
        MARGIN_ENVIRONMENT: 'development',
      }),
    ).resolves.toBeNull()
  })

  it('fails closed on a malformed claim rather than inventing an identity', async () => {
    for (const claim of ['{', '{}', '{"subject":""}', '   ']) {
      await expect(
        getPrincipal(request({ [DEV_PRINCIPAL_HEADER]: claim }), {
          MARGIN_ENVIRONMENT: 'development',
          MARGIN_DEV_PRINCIPAL: 'reader',
        }),
      ).resolves.toBeNull()
    }
  })

  it('does not shadow a real session in a configured environment', async () => {
    const cookie = await sessionCookieHeader(await signer.sign(claims()))

    await expect(
      getPrincipal(
        request({ cookie, [DEV_PRINCIPAL_HEADER]: 'user_01HADMIN' }),
        signedInEnv({ MARGIN_DEV_PRINCIPAL: 'user_01HADMIN' }),
        options(),
      ),
    ).resolves.toMatchObject({ subject: 'user_01HREADER' })
  })
})

describe('the cookie password', () => {
  it('is only ever read from the environment', () => {
    expect(config.cookiePassword).toBe(TEST_COOKIE_PASSWORD)
    expect(readWorkosConfig({ ...testWorkosEnv(), WORKOS_COOKIE_PASSWORD: '' }))
      .toBeNull()
  })
})
