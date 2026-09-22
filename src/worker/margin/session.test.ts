import { describe, expect, it } from 'vitest'
import { TEST_COOKIE_PASSWORD, TEST_OTHER_PASSWORD } from './fake-workos'
import {
  clearedCookie,
  readCookie,
  seal,
  sealLoginState,
  sealSession,
  serializeCookie,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  STATE_COOKIE_NAME,
  STATE_COOKIE_PATH,
  unseal,
  unsealLoginState,
  unsealSession,
} from './session'


describe('sealing', () => {
  it('round-trips a session', async () => {
    const session = {
      accessToken: 'header.payload.signature',
      expiresAt: 1_800_000_300,
      email: 'reader@example.test',
    }

    const sealed = await sealSession(session, TEST_COOKIE_PASSWORD)
    await expect(unsealSession(sealed, TEST_COOKIE_PASSWORD)).resolves.toEqual(
      session,
    )
  })

  it('does not unseal under a different password', async () => {
    const sealed = await sealSession(
      { accessToken: 'a.b.c', expiresAt: 1 },
      TEST_COOKIE_PASSWORD,
    )

    await expect(unsealSession(sealed, TEST_OTHER_PASSWORD)).resolves.toBeNull()
  })

  it('does not unseal after a single flipped character', async () => {
    const sealed = await sealSession(
      { accessToken: 'a.b.c', expiresAt: 1 },
      TEST_COOKIE_PASSWORD,
    )
    const parts = sealed.split('.')
    const ciphertext = parts[3] as string
    parts[3] = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1)

    await expect(
      unsealSession(parts.join('.'), TEST_COOKIE_PASSWORD),
    ).resolves.toBeNull()
  })

  it('never produces the same ciphertext twice', async () => {
    const value = { accessToken: 'a.b.c', expiresAt: 1 }
    const first = await sealSession(value, TEST_COOKIE_PASSWORD)
    const second = await sealSession(value, TEST_COOKIE_PASSWORD)

    expect(first).not.toBe(second)
    expect(first.split('.')[3]).not.toBe(second.split('.')[3])
  })

  it('rejects garbage rather than throwing', async () => {
    for (const candidate of [
      '',
      'v1',
      'v1.a.b',
      'v2.a.b.c',
      'v1.!!.??.$$',
      'v1.AAAA.AAAA.AAAA',
    ]) {
      await expect(
        unseal(candidate, TEST_COOKIE_PASSWORD),
      ).resolves.toBeNull()
    }
  })

  it('rejects a payload that is not the shape we sealed', async () => {
    const sealed = await seal({ accessToken: '', expiresAt: -1 }, TEST_COOKIE_PASSWORD)

    await expect(unsealSession(sealed, TEST_COOKIE_PASSWORD)).resolves.toBeNull()
  })

  it('round-trips login state and rejects an off-site return path', async () => {
    const sealed = await sealLoginState(
      { state: 'opaque-state', returnTo: '/challenges/one' },
      TEST_COOKIE_PASSWORD,
    )

    await expect(
      unsealLoginState(sealed, TEST_COOKIE_PASSWORD),
    ).resolves.toEqual({ state: 'opaque-state', returnTo: '/challenges/one' })

    await expect(
      sealLoginState(
        { state: 'opaque-state', returnTo: 'https://evil.test/' },
        TEST_COOKIE_PASSWORD,
      ),
    ).rejects.toThrow()
  })
})

describe('cookie attributes', () => {
  const header = serializeCookie(SESSION_COOKIE_NAME, 'sealed-value', {
    path: SESSION_COOKIE_PATH,
    maxAgeSeconds: 300,
  })

  it('names the app-specific cookie', () => {
    expect(SESSION_COOKIE_NAME).toBe('margin-session')
    expect(header.startsWith('margin-session=sealed-value;')).toBe(true)
  })

  it('is Secure, HttpOnly and SameSite=Lax', () => {
    expect(header).toContain('; HttpOnly')
    expect(header).toContain('; Secure')
    expect(header).toContain('; SameSite=Lax')
    expect(header).toContain('; Max-Age=300')
  })

  it('is host-only, so it can never reach a parent domain', () => {
    expect(header.toLowerCase()).not.toContain('domain=')
  })

  it('scopes the short-lived login state to /auth', () => {
    const state = serializeCookie(STATE_COOKIE_NAME, 'sealed', {
      path: STATE_COOKIE_PATH,
      maxAgeSeconds: 600,
    })

    expect(state).toContain('; Path=/auth')
    expect(state.toLowerCase()).not.toContain('domain=')
  })

  it('clears by expiring in place, on the same path', () => {
    const cleared = clearedCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_PATH)

    expect(cleared).toContain('margin-session=;')
    expect(cleared).toContain('; Max-Age=0')
    expect(cleared).toContain(`; Path=${SESSION_COOKIE_PATH}`)
  })
})

describe('readCookie', () => {
  const request = (cookie: string) =>
    new Request('https://ernie.sg/auth/me', { headers: { cookie } })

  it('reads the named cookie out of a crowded header', () => {
    expect(
      readCookie(request('a=1; margin-session=sealed; b=2'), 'margin-session'),
    ).toBe('sealed')
  })

  it('does not match a cookie whose name merely ends the same way', () => {
    expect(
      readCookie(request('not-margin-session=other'), 'margin-session'),
    ).toBeNull()
  })

  it('returns null with no cookie header at all', () => {
    expect(
      readCookie(new Request('https://ernie.sg/auth/me'), 'margin-session'),
    ).toBeNull()
  })
})
