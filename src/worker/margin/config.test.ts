import { describe, expect, it } from 'vitest'
import {
  authorizationUrl,
  DEFAULT_ADMIN_EMAIL,
  jwksUrl,
  readWorkosConfig,
  tokenEndpoint,
  type WorkosConfig,
  type WorkosEnv,
} from './config'
import { testWorkosEnv, TEST_CLIENT_ID, TEST_ISSUER } from './fake-workos'

const config = readWorkosConfig(testWorkosEnv()) as WorkosConfig

describe('readWorkosConfig', () => {
  it('reads every value from the platform store', () => {
    expect(config).toMatchObject({
      issuer: TEST_ISSUER,
      clientId: TEST_CLIENT_ID,
      adminEmail: DEFAULT_ADMIN_EMAIL,
    })
  })

  it('returns null when any single value is missing', () => {
    const names = [
      'WORKOS_ISSUER',
      'WORKOS_CLIENT_ID',
      'WORKOS_API_KEY',
      'WORKOS_COOKIE_PASSWORD',
      'WORKOS_REDIRECT_URI',
    ] as const

    for (const name of names) {
      const missing: Partial<WorkosEnv> = {}
      missing[name] = undefined
      const blank: Partial<WorkosEnv> = {}
      blank[name] = ''

      expect(readWorkosConfig(testWorkosEnv(missing))).toBeNull()
      expect(readWorkosConfig(testWorkosEnv(blank))).toBeNull()
    }
    expect(readWorkosConfig({})).toBeNull()
  })

  it('refuses a short cookie password', () => {
    expect(
      readWorkosConfig(testWorkosEnv({ WORKOS_COOKIE_PASSWORD: 'too-short' })),
    ).toBeNull()
  })

  it('refuses a non-https issuer or redirect', () => {
    expect(
      readWorkosConfig(testWorkosEnv({ WORKOS_ISSUER: 'http://api.workos.test' })),
    ).toBeNull()
    expect(
      readWorkosConfig(testWorkosEnv({ WORKOS_ISSUER: 'api.workos.test' })),
    ).toBeNull()
    expect(
      readWorkosConfig(
        testWorkosEnv({ WORKOS_REDIRECT_URI: 'http://evil.test/auth/callback' }),
      ),
    ).toBeNull()
  })

  it('allows a plain-http loopback callback for local development', () => {
    expect(
      readWorkosConfig(
        testWorkosEnv({
          WORKOS_REDIRECT_URI: 'http://localhost:8788/auth/callback',
        }),
      ),
    ).not.toBeNull()
  })

  it('defaults the admin identity to the owner and lowercases an override', () => {
    expect(config.adminEmail).toBe('hello@ernie.sg')
    expect(
      readWorkosConfig(
        testWorkosEnv({ MARGIN_ADMIN_EMAIL: 'Owner@Example.Test' }),
      )?.adminEmail,
    ).toBe('owner@example.test')
  })
})

describe('derived endpoints', () => {
  it('keeps every endpoint on the issuer origin', () => {
    expect(jwksUrl(config)).toBe(
      `${TEST_ISSUER}/sso/jwks/${TEST_CLIENT_ID}`,
    )
    expect(tokenEndpoint(config)).toBe(
      `${TEST_ISSUER}/user_management/authenticate`,
    )
    expect(authorizationUrl(config, 'opaque').startsWith(TEST_ISSUER)).toBe(true)
  })

  it('carries the client id, redirect and state into the hosted UI', () => {
    const url = new URL(authorizationUrl(config, 'opaque-state'))

    expect(url.pathname).toBe('/user_management/authorize')
    expect(url.searchParams.get('client_id')).toBe(TEST_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('provider')).toBe('authkit')
    expect(url.searchParams.get('state')).toBe('opaque-state')
  })

  it('never puts the API key in a URL', () => {
    const urls = [
      jwksUrl(config),
      tokenEndpoint(config),
      authorizationUrl(config, 'opaque'),
    ]

    for (const url of urls) expect(url).not.toContain(config.apiKey)
  })
})
