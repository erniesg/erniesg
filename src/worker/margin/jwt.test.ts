import { beforeAll, describe, expect, it } from 'vitest'
import { encodeBase64Url, encodeUtf8 } from './base64url'
import { jwksUrl, readWorkosConfig, type WorkosConfig } from './config'
import {
  createFakeProvider,
  foreignSigner,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  type TestJwk,
  type TestSigner,
} from './fake-workos'
import { createJwksSource, verifyAccessToken } from './jwt'

const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = Math.floor(NOW_MS / 1000)

const config = readWorkosConfig(testWorkosEnv()) as WorkosConfig

let signer: TestSigner

beforeAll(async () => {
  signer = await testSigner()
})

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: TEST_ISSUER,
    sub: 'user_01HREADER',
    client_id: TEST_CLIENT_ID,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
    ...overrides,
  }
}

function sourceFor(provider: ReturnType<typeof createFakeProvider>) {
  return createJwksSource(jwksUrl(config), {
    fetchImpl: provider.fetchImpl,
    now: () => NOW_MS,
  })
}

async function verify(token: string, provider = createFakeProvider({ jwks: signer.jwks })) {
  return verifyAccessToken(token, {
    config,
    jwks: sourceFor(provider),
    now: NOW_MS,
  })
}

describe('verifyAccessToken', () => {
  it('accepts a token signed by the environment key set', async () => {
    const result = await verify(await signer.sign(validClaims()))

    expect(result).toEqual({
      ok: true,
      claims: expect.objectContaining({
        iss: TEST_ISSUER,
        sub: 'user_01HREADER',
        client_id: TEST_CLIENT_ID,
      }),
    })
  })

  it('rejects a token from a different WorkOS application', async () => {
    const token = await signer.sign(
      validClaims({ client_id: 'client_some_other_application' }),
    )

    await expect(verify(token)).resolves.toEqual({
      ok: false,
      reason: 'client-id',
    })
  })

  it('rejects a validly signed token with the wrong issuer', async () => {
    const token = await signer.sign(
      validClaims({ iss: 'https://api.workos.example' }),
    )

    await expect(verify(token)).resolves.toEqual({ ok: false, reason: 'issuer' })
  })

  it('rejects an expired token with no grace period', async () => {
    const expired = await signer.sign(validClaims({ exp: NOW_SECONDS - 1 }))
    const onTheSecond = await signer.sign(validClaims({ exp: NOW_SECONDS }))

    await expect(verify(expired)).resolves.toEqual({
      ok: false,
      reason: 'expired',
    })
    await expect(verify(onTheSecond)).resolves.toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects a token that is not yet valid', async () => {
    const token = await signer.sign(
      validClaims({ nbf: NOW_SECONDS + 3600, iat: NOW_SECONDS + 3600 }),
    )

    await expect(verify(token)).resolves.toEqual({
      ok: false,
      reason: 'not-yet-valid',
    })
  })

  it('rejects every algorithm but RS256, including none', async () => {
    for (const alg of ['none', 'HS256', 'RS512', 'ES256']) {
      const token = await signer.sign(validClaims(), { alg })
      await expect(verify(token)).resolves.toEqual({
        ok: false,
        reason: 'algorithm',
      })
    }
  })

  it('rejects a token whose payload was edited after signing', async () => {
    const token = await signer.sign(validClaims())
    const [header, , signature] = token.split('.') as [string, string, string]
    const forged = encodeBase64Url(
      encodeUtf8(JSON.stringify(validClaims({ sub: 'user_01HADMIN' }))),
    )

    await expect(verify([header, forged, signature].join('.'))).resolves.toEqual(
      { ok: false, reason: 'signature' },
    )
  })

  it('rejects a token signed by a key that is not in the key set', async () => {
    const other = await foreignSigner(signer.kid)
    const token = await other.sign(validClaims())

    await expect(verify(token)).resolves.toEqual({
      ok: false,
      reason: 'signature',
    })
  })

  it('rejects a token with an empty subject', async () => {
    const token = await signer.sign(validClaims({ sub: '   ' }))

    await expect(verify(token)).resolves.toEqual({
      ok: false,
      reason: 'subject',
    })
  })

  it('rejects anything that is not a three-part token', async () => {
    for (const token of ['', 'a.b', 'a.b.c.d', 'not-a-token', '!!.??.$$']) {
      const result = await verify(token)
      expect(result.ok).toBe(false)
    }
  })

  it('rejects an unknown key id rather than skipping the signature', async () => {
    const token = await signer.sign(validClaims(), { kid: 'rotated-away' })

    await expect(verify(token)).resolves.toEqual({
      ok: false,
      reason: 'jwks-unavailable',
    })
  })
})

// AuthKit access tokens carry neither `client_id` nor `aud`: the application
// binding is the key set at `/sso/jwks/<clientId>`. Requiring the claim rejected
// every genuine token before a session could be sealed.
describe('the application binding', () => {
  it('accepts a token with no client_id and no aud at all', async () => {
    const claims = validClaims()
    delete (claims as Record<string, unknown>).client_id
    const token = await signer.sign(claims)

    await expect(verify(token)).resolves.toMatchObject({ ok: true })
  })

  it('still rejects a client_id that names another application', async () => {
    const token = await signer.sign(
      validClaims({ client_id: 'client_some_other_application' }),
    )

    await expect(verify(token)).resolves.toMatchObject({ ok: false })
  })

  it('checks aud when a provider sends one instead', async () => {
    const claims = validClaims()
    delete (claims as Record<string, unknown>).client_id
    const mine = await signer.sign({ ...claims, aud: TEST_CLIENT_ID })
    const theirs = await signer.sign({ ...claims, aud: 'client_somebody_else' })
    const array = await signer.sign({ ...claims, aud: [TEST_CLIENT_ID] })

    await expect(verify(mine)).resolves.toMatchObject({ ok: true })
    await expect(verify(array)).resolves.toMatchObject({ ok: true })
    await expect(verify(theirs)).resolves.toMatchObject({ ok: false })
  })

  // An application binding, not a general-purpose audience: a token minted for
  // another service that happens to list us as well is not a token for us.
  it('refuses an aud that names this application among others', async () => {
    const claims = validClaims()
    delete (claims as Record<string, unknown>).client_id

    for (const aud of [
      [TEST_CLIENT_ID, 'client_somebody_else'],
      ['client_somebody_else', TEST_CLIENT_ID],
      [],
    ]) {
      const token = await signer.sign({ ...claims, aud })
      await expect(verify(token), JSON.stringify(aud)).resolves.toMatchObject({
        ok: false,
      })
    }
  })

  // And they are checked separately, so a right `client_id` cannot carry a wrong
  // `aud` through.
  it('refuses a right client_id beside a wrong aud, and the reverse', async () => {
    const right = await signer.sign(
      validClaims({ aud: 'client_somebody_else' } as Record<string, unknown>),
    )
    const wrong = await signer.sign(
      validClaims({
        client_id: 'client_somebody_else',
        aud: TEST_CLIENT_ID,
      } as Record<string, unknown>),
    )

    await expect(verify(right)).resolves.toMatchObject({ ok: false })
    await expect(verify(wrong)).resolves.toMatchObject({ ok: false })
  })

  it('refuses a malformed client_id or aud rather than ignoring it', async () => {
    for (const claim of [{ client_id: 7 }, { aud: 7 }, { aud: [7] }]) {
      const token = await signer.sign(validClaims(claim as Record<string, unknown>))
      await expect(verify(token), JSON.stringify(claim)).resolves.toMatchObject({
        ok: false,
      })
    }
  })
})

describe('JWKS availability', () => {
  it('fails closed when the provider is unreachable', async () => {
    const provider = createFakeProvider({ jwks: signer.jwks })
    provider.offline = true
    const token = await signer.sign(validClaims())

    await expect(verify(token, provider)).resolves.toEqual({
      ok: false,
      reason: 'jwks-unavailable',
    })
  })

  it('fails closed when the key set request errors', async () => {
    const provider = createFakeProvider({})
    const token = await signer.sign(validClaims())

    await expect(verify(token, provider)).resolves.toEqual({
      ok: false,
      reason: 'jwks-unavailable',
    })
  })

  it('never caches a failure, so recovery needs no restart', async () => {
    let jwks: { keys: TestJwk[] } | undefined
    const fetchImpl = (async (input: RequestInfo | URL) => {
      void input
      if (!jwks) throw new TypeError('network unreachable')
      return new Response(JSON.stringify(jwks), { status: 200 })
    }) as unknown as typeof fetch

    const source = createJwksSource(jwksUrl(config), {
      fetchImpl,
      now: () => NOW_MS,
    })
    const token = await signer.sign(validClaims())

    await expect(
      verifyAccessToken(token, { config, jwks: source, now: NOW_MS }),
    ).resolves.toEqual({ ok: false, reason: 'jwks-unavailable' })

    jwks = signer.jwks
    const recovered = await verifyAccessToken(token, {
      config,
      jwks: source,
      now: NOW_MS,
    })
    expect(recovered.ok).toBe(true)
  })

  // The requirement is that a provider failure never falls back to something
  // trusted, and a key set past its TTL is something trusted: WorkOS may have
  // revoked the key in the meantime, and the cache cannot know.
  it('drops a key set past its TTL rather than trusting it through an outage', async () => {
    let reachable = true
    let clock = NOW_MS
    const calls: number[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      void input
      calls.push(clock)
      if (!reachable) return new Response('gateway', { status: 503 })
      return new Response(JSON.stringify(signer.jwks), { status: 200 })
    }) as unknown as typeof fetch

    const source = createJwksSource(jwksUrl(config), {
      fetchImpl,
      now: () => clock,
      ttlMs: 600_000,
    })
    const token = await signer.sign(validClaims())

    // Warm, then let the key set go stale while the provider is down.
    await expect(
      verifyAccessToken(token, { config, jwks: source, now: NOW_MS }),
    ).resolves.toMatchObject({ ok: true })

    reachable = false
    clock = NOW_MS + 600_001
    await expect(
      verifyAccessToken(token, { config, jwks: source, now: NOW_MS }),
    ).resolves.toEqual({ ok: false, reason: 'jwks-unavailable' })

    // Still fresh, and still unreachable: nothing was kept to fall back on.
    await expect(
      verifyAccessToken(token, { config, jwks: source, now: NOW_MS }),
    ).resolves.toEqual({ ok: false, reason: 'jwks-unavailable' })

    // And it recovers without a restart once the provider answers again.
    reachable = true
    await expect(
      verifyAccessToken(token, { config, jwks: source, now: NOW_MS }),
    ).resolves.toMatchObject({ ok: true })
    expect(calls.length).toBeGreaterThan(1)
  })

  it('keeps trusting a cached key set inside its TTL', async () => {
    let clock = NOW_MS
    const provider = createFakeProvider({ jwks: signer.jwks })
    const source = createJwksSource(jwksUrl(config), {
      fetchImpl: provider.fetchImpl,
      now: () => clock,
      ttlMs: 600_000,
    })
    const token = await signer.sign(validClaims())

    await expect(
      verifyAccessToken(token, { config, jwks: source, now: NOW_MS }),
    ).resolves.toMatchObject({ ok: true })

    provider.offline = true
    clock = NOW_MS + 599_000
    await expect(
      verifyAccessToken(token, { config, jwks: source, now: NOW_MS }),
    ).resolves.toMatchObject({ ok: true })
    expect(provider.calls).toHaveLength(1)
  })

  it('caches a fetched key set instead of refetching per request', async () => {
    const provider = createFakeProvider({ jwks: signer.jwks })
    const source = sourceFor(provider)
    const token = await signer.sign(validClaims())

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await verifyAccessToken(token, {
        config,
        jwks: source,
        now: NOW_MS,
      })
      expect(result.ok).toBe(true)
    }

    expect(provider.calls).toHaveLength(1)
  })
})
