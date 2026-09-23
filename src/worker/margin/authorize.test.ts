import { beforeAll, describe, expect, it } from 'vitest'
import type { Principal } from '../principal'
import { marginWriteGate } from '../index'
import { requireAdmin, requireWriter } from './authorize'
import { jwksUrl, readWorkosConfig, type WorkosConfig } from './config'
import {
  createFakeD1,
  createFakeProvider,
  type FakeProvider,
  sessionCookieHeader,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  type FakeD1,
  type TestSigner,
} from './fake-workos'
import { createJwksSource } from './jwt'

/**
 * The acceptance tests for the write gate.
 *
 * 054's annotation routes are not in this tree, so the last block here drives
 * the guard through `marginWriteGate` — the Worker's own dispatch — rather than
 * only through the helpers. A helper that works and that nothing calls is the
 * failure mode these have to rule out, so the route-level answers are asserted
 * on the path a request actually takes.
 */

const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = Math.floor(NOW_MS / 1000)

const config = readWorkosConfig(testWorkosEnv()) as WorkosConfig

const reader: Principal = {
  provider: 'workos',
  issuer: TEST_ISSUER,
  subject: 'user_01HREADER',
}
const writer: Principal = { ...reader, subject: 'user_01HWRITER' }
const admin: Principal = { ...reader, subject: 'user_01HADMIN' }

let signer: TestSigner

beforeAll(async () => {
  signer = await testSigner()
})

function options(provider = createFakeProvider({ jwks: signer.jwks })) {
  return {
    now: NOW_MS,
    jwks: createJwksSource(jwksUrl(config), {
      fetchImpl: provider.fetchImpl,
      now: () => NOW_MS,
    }),
  }
}

async function signedIn(principal: Principal): Promise<Request> {
  const token = await signer.sign({
    iss: principal.issuer,
    sub: principal.subject,
    client_id: TEST_CLIENT_ID,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
  })
  return new Request('https://ernie.sg/api/margin/v1/annotations', {
    method: 'POST',
    headers: { cookie: await sessionCookieHeader(token) },
  })
}

function anonymous(): Request {
  return new Request('https://ernie.sg/api/margin/v1/annotations', {
    method: 'POST',
  })
}

async function at(url: string, principal?: Principal): Promise<Request> {
  if (!principal) return new Request(url, { method: 'POST' })
  const token = await signer.sign({
    iss: principal.issuer,
    sub: principal.subject,
    client_id: TEST_CLIENT_ID,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
  })
  return new Request(url, {
    method: 'POST',
    headers: { cookie: await sessionCookieHeader(token) },
  })
}

function envWith(db: FakeD1) {
  return { ...testWorkosEnv(), MARGIN_ENVIRONMENT: 'production', MARGIN_DB: db }
}

describe('requireWriter', () => {
  it('is 401 for an anonymous write', async () => {
    const result = await requireWriter(
      anonymous(),
      envWith(createFakeD1()),
      options(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(401)
    await expect(result.response.json()).resolves.toEqual({
      error: 'authentication_required',
    })
  })

  it('is 403 for a signed-in identity that is not on the allowlist', async () => {
    const result = await requireWriter(
      await signedIn(reader),
      envWith(createFakeD1()),
      options(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
    await expect(result.response.json()).resolves.toEqual({
      error: 'not_allowed',
    })
  })

  it('lets an allowlisted identity through', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')

    const result = await requireWriter(
      await signedIn(writer),
      envWith(db),
      options(),
    )

    expect(result).toMatchObject({
      ok: true,
      role: 'writer',
      principal: { provider: 'workos', subject: 'user_01HWRITER' },
    })
  })

  it('does not let one identity inherit another identity’s row', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')

    const result = await requireWriter(
      await signedIn(reader),
      envWith(db),
      options(),
    )

    expect(result.ok).toBe(false)
  })

  it('fails closed with no database binding', async () => {
    const result = await requireWriter(
      await signedIn(writer),
      { ...testWorkosEnv(), MARGIN_ENVIRONMENT: 'production' },
      options(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(503)
  })

  it('fails closed when the allowlist cannot be read', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')
    db.offline = true

    const result = await requireWriter(
      await signedIn(writer),
      envWith(db),
      options(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(503)
  })

  it('fails closed with the provider unreachable', async () => {
    const provider = createFakeProvider({ jwks: signer.jwks })
    provider.offline = true
    const db = createFakeD1()
    db.allow(writer, 'writer')

    const result = await requireWriter(
      await signedIn(writer),
      envWith(db),
      options(provider),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(401)
  })
})

describe('requireAdmin', () => {
  it('is 403 for an allowlisted non-admin', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')

    const result = await requireAdmin(
      await signedIn(writer),
      envWith(db),
      options(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
    await expect(result.response.json()).resolves.toEqual({
      error: 'admin_required',
    })
  })

  it('succeeds for the admin', async () => {
    const db = createFakeD1()
    db.allow(admin, 'admin')

    const result = await requireAdmin(
      await signedIn(admin),
      envWith(db),
      options(),
    )

    expect(result).toMatchObject({ ok: true, role: 'admin' })
  })

  it('is 401 for an anonymous apply', async () => {
    const result = await requireAdmin(
      anonymous(),
      envWith(createFakeD1()),
      options(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(401)
  })

  it('is not granted by an email, only by the allowlist row', async () => {
    const db = createFakeD1()
    db.allow({ ...writer, email: 'hello@ernie.sg' }, 'writer')

    const token = await signer.sign({
      iss: writer.issuer,
      sub: writer.subject,
      client_id: TEST_CLIENT_ID,
      exp: NOW_SECONDS + 300,
    })
    const request = new Request('https://ernie.sg/api/margin/v1/proposals/1/apply', {
      method: 'POST',
      headers: {
        cookie: await sessionCookieHeader(token, { email: 'hello@ernie.sg' }),
      },
    })

    const result = await requireAdmin(request, envWith(db), options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })
})

// The dispatch, not the helper: a gate nothing calls protects nothing.
describe('the Worker dispatch applies the gate', () => {
  const ANNOTATIONS = 'https://ernie.sg/api/margin/v1/annotations'
  const APPLY = 'https://ernie.sg/api/margin/v1/proposals/ann-1/apply'

  function populated(): FakeD1 {
    const db = createFakeD1()
    db.allow(writer, 'writer')
    db.allow(admin, 'admin')
    return db
  }

  it('is 401 anonymous, 403 signed in without a row, and through for a writer', async () => {
    const db = populated()

    const anon = await marginWriteGate(await at(ANNOTATIONS), envWith(db), options())
    expect(anon?.denied?.status).toBe(401)

    const outsider = await marginWriteGate(
      await at(ANNOTATIONS, reader),
      envWith(db),
      options(),
    )
    expect(outsider?.denied?.status).toBe(403)

    const allowed = await marginWriteGate(
      await at(ANNOTATIONS, writer),
      envWith(db),
      options(),
    )
    expect(allowed?.denied).toBeUndefined()
  })

  it('needs the admin for apply, not merely a writer', async () => {
    const db = populated()

    const asWriter = await marginWriteGate(await at(APPLY, writer), envWith(db), options())
    expect(asWriter?.denied?.status).toBe(403)
    await expect(asWriter?.denied?.json()).resolves.toEqual({ error: 'admin_required' })

    const asAdmin = await marginWriteGate(await at(APPLY, admin), envWith(db), options())
    expect(asAdmin?.denied).toBeUndefined()
  })

  it('never stands between a reader and the book', async () => {
    const db = populated()
    const read = new Request(ANNOTATIONS)

    expect(await marginWriteGate(read, envWith(db), options())).toBeNull()
  })
})

// A page left open past the access token's expiry: the cookie still holds a live
// refresh token and the session has hours left, so a write must renew rather
// than answer 401 and wait for the client to have polled `/auth/me` first.
describe('the write gate renews a lapsed session', () => {
  const ANNOTATIONS = 'https://ernie.sg/api/margin/v1/annotations'

  async function lapsedSession(): Promise<{ request: Request; provider: FakeProvider }> {
    // A token that expired an hour ago, sealed with a refresh token and a
    // ceiling eight hours out.
    const stale = await signer.sign({
      iss: TEST_ISSUER,
      sub: writer.subject,
      client_id: TEST_CLIENT_ID,
      iat: NOW_SECONDS - 3_700,
      exp: NOW_SECONDS - 3_600,
    })
    const cookie = await sessionCookieHeader(stale, {
      expiresAt: NOW_SECONDS - 3_600,
      ceiling: NOW_SECONDS + 3_600,
      refreshToken: 'refresh_one',
    })
    const fresh = await signer.sign({
      iss: TEST_ISSUER,
      sub: writer.subject,
      client_id: TEST_CLIENT_ID,
      iat: NOW_SECONDS - 10,
      exp: NOW_SECONDS + 300,
    })
    const provider = createFakeProvider({
      jwks: signer.jwks,
      authenticate: { access_token: fresh, refresh_token: 'refresh_two' },
    })
    return {
      request: new Request(ANNOTATIONS, { method: 'POST', headers: { cookie } }),
      provider,
    }
  }

  // The request handed downstream has to carry both the renewed session and the
  // body. Earlier this asserted the *original* stayed readable, which was the
  // invariant when the gate forwarded it; now the gate forwards the renewed one,
  // and that is the request 054's handler reads the caller and the JSON from.
  it('forwards a request carrying the renewed session and the body', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')
    const { request, provider } = await lapsedSession()
    const withBody = new Request(request, {
      body: JSON.stringify({ motivation: 'commenting' }),
    })

    const gate = await marginWriteGate(withBody, envWith(db), {
      now: NOW_MS,
      fetchImpl: provider.fetchImpl,
      jwks: createJwksSource(jwksUrl(config), {
        fetchImpl: provider.fetchImpl,
        now: () => NOW_MS,
      }),
    })

    expect(gate?.denied).toBeUndefined()
    expect(gate?.forward, 'a renewal must hand back the request to forward')
      .toBeDefined()
    expect(gate?.forward?.bodyUsed).toBe(false)
    expect(await gate!.forward!.json()).toEqual({ motivation: 'commenting' })
    // And that request is the one the session is on.
    expect(gate?.forward?.headers.get('cookie')).toContain('margin-session=')
    expect(gate?.forward?.headers.get('cookie')).not.toBe(
      withBody.headers.get('cookie'),
    )
  })

  // A read is never refused, but it is re-identified: otherwise 054's handlers
  // see an anonymous caller past the access token's expiry and hide the reader's
  // own private annotations.
  it('renews a read without refusing it', async () => {
    const db = createFakeD1()
    const { request, provider } = await lapsedSession()
    const read = new Request(request.url, {
      headers: { cookie: request.headers.get('cookie') as string },
    })

    const gate = await marginWriteGate(read, envWith(db), {
      now: NOW_MS,
      fetchImpl: provider.fetchImpl,
      jwks: createJwksSource(jwksUrl(config), {
        fetchImpl: provider.fetchImpl,
        now: () => NOW_MS,
      }),
    })

    expect(gate?.denied).toBeUndefined()
    expect(gate?.setCookie).toContain('margin-session=')
    expect(gate?.forward?.headers.get('cookie')).not.toBe(
      read.headers.get('cookie'),
    )
  })

  // `SameSite=Lax` sends the host cookie for a *same-site* request, and an HTTPS
  // sibling of ernie.sg is same-site — so a form POST from one would be
  // authorized on the reader's own session. Logout validates this; writes must.
  it('refuses a write the browser labels as coming from elsewhere', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')

    const cases: Record<string, string>[] = [
      { origin: 'https://evil.test' },
      { origin: 'https://sibling.ernie.sg' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]
    for (const headers of cases) {
      const request = await at(ANNOTATIONS, writer)
      const flagged = new Request(request.url, {
        method: 'POST',
        headers: { ...headers, cookie: request.headers.get('cookie') as string },
      })

      const gate = await marginWriteGate(flagged, envWith(db), options())
      expect(gate?.denied?.status, JSON.stringify(headers)).toBe(403)
      await expect(gate?.denied?.json()).resolves.toMatchObject({
        error: { code: 'cross_origin' },
      })
    }
  })

  it('allows a write the browser labels as this site, and a read from anywhere', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')

    for (const headers of [
      { origin: 'https://ernie.sg' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
    ] as Record<string, string>[]) {
      const request = await at(ANNOTATIONS, writer)
      const labelled = new Request(request.url, {
        method: 'POST',
        headers: { ...headers, cookie: request.headers.get('cookie') as string },
      })

      const gate = await marginWriteGate(labelled, envWith(db), options())
      expect(gate?.denied, JSON.stringify(headers)).toBeUndefined()
    }

    // A read is not a write: nothing to forge, and the book is open.
    const crossSiteRead = new Request(ANNOTATIONS, {
      headers: { origin: 'https://evil.test' },
    })
    const gate = await marginWriteGate(crossSiteRead, envWith(db), options())
    expect(gate?.denied).toBeUndefined()
  })

  it('renews and lets the write through, returning the new cookie', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')
    const { request, provider } = await lapsedSession()

    const gate = await marginWriteGate(request, envWith(db), {
      now: NOW_MS,
      fetchImpl: provider.fetchImpl,
      jwks: createJwksSource(jwksUrl(config), {
        fetchImpl: provider.fetchImpl,
        now: () => NOW_MS,
      }),
    })

    expect(gate?.denied, 'the write must not be refused').toBeUndefined()
    expect(gate?.setCookie, 'the renewed cookie must come back').toContain(
      'margin-session=',
    )
  })

  it('still refuses when the caller is not on the allowlist, cookie and all', async () => {
    const db = createFakeD1()
    const { request, provider } = await lapsedSession()

    const gate = await marginWriteGate(request, envWith(db), {
      now: NOW_MS,
      fetchImpl: provider.fetchImpl,
      jwks: createJwksSource(jwksUrl(config), {
        fetchImpl: provider.fetchImpl,
        now: () => NOW_MS,
      }),
    })

    // Renewal authenticates; it does not authorise.
    expect(gate?.denied?.status).toBe(403)
    expect(gate?.setCookie).toContain('margin-session=')
  })

  it('does not renew past the ceiling', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')
    const stale = await signer.sign({
      iss: TEST_ISSUER,
      sub: writer.subject,
      client_id: TEST_CLIENT_ID,
      iat: NOW_SECONDS - 3_700,
      exp: NOW_SECONDS - 3_600,
    })
    const request = new Request(ANNOTATIONS, {
      method: 'POST',
      headers: {
        cookie: await sessionCookieHeader(stale, {
          expiresAt: NOW_SECONDS - 3_600,
          ceiling: NOW_SECONDS - 1,
          refreshToken: 'refresh_one',
        }),
      },
    })
    const provider = createFakeProvider({ jwks: signer.jwks })

    const gate = await marginWriteGate(request, envWith(db), {
      now: NOW_MS,
      fetchImpl: provider.fetchImpl,
      jwks: createJwksSource(jwksUrl(config), {
        fetchImpl: provider.fetchImpl,
        now: () => NOW_MS,
      }),
    })

    expect(gate?.denied?.status).toBe(401)
    expect(gate?.setCookie).toBeUndefined()
  })
})
