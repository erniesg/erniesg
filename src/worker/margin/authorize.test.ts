import { beforeAll, describe, expect, it } from 'vitest'
import type { Principal } from '../principal'
import { requireAdmin, requireWriter } from './authorize'
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
  type TestSigner,
} from './fake-workos'
import { createJwksSource } from './jwt'

/**
 * The acceptance tests for the write gate.
 *
 * 054 has not landed, so there are no annotation routes to drive these through
 * yet. These exercise the guard those routes will call, which is the thing
 * that decides the answer; the route handler only forwards its response.
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
