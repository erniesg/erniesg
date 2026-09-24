import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_COOKIE_PASSWORD, TEST_OTHER_PASSWORD } from './fake-workos'
import {
  AUTH_COOKIE_NAMES,
  clearedCookie,
  HOST_COOKIE_PREFIX,
  LEGACY_AUTH_COOKIES,
  legacyCookieClears,
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
      await expect(unseal(candidate, TEST_COOKIE_PASSWORD)).resolves.toBeNull()
    }
  })

  it('rejects a payload that is not the shape we sealed', async () => {
    const sealed = await seal(
      { accessToken: '', expiresAt: -1 },
      TEST_COOKIE_PASSWORD,
    )

    await expect(
      unsealSession(sealed, TEST_COOKIE_PASSWORD),
    ).resolves.toBeNull()
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
    expect(SESSION_COOKIE_NAME).toBe('__Host-margin-session')
    expect(header.startsWith('__Host-margin-session=sealed-value;')).toBe(true)
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

  it('clears by expiring in place, on the same path', () => {
    const cleared = clearedCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_PATH)

    expect(cleared).toContain('__Host-margin-session=;')
    expect(cleared).toContain('; Max-Age=0')
    expect(cleared).toContain(`; Path=${SESSION_COOKIE_PATH}`)
  })
})

/**
 * The rule: every auth cookie is a `__Host-` cookie. A sibling host of
 * `ernie.sg` can set a parent-domain cookie with any unprefixed name and
 * shadow ours. These fail for any auth cookie, current or added later, that
 * lacks the prefix or anything the browser requires of it.
 */
describe('every auth cookie is a __Host- cookie', () => {
  const hostCookie = /^__Host-[^=;\s]+=/u

  function expectHostCookie(header: string) {
    expect(header).toMatch(hostCookie)
    const attributes = header.split('; ').slice(1)
    expect(attributes).toContain('Path=/')
    expect(attributes).toContain('Secure')
    expect(header.toLowerCase()).not.toContain('domain=')
  }

  it('names every auth cookie with the prefix', () => {
    expect(AUTH_COOKIE_NAMES.length).toBeGreaterThanOrEqual(2)
    for (const name of [
      ...AUTH_COOKIE_NAMES,
      SESSION_COOKIE_NAME,
      STATE_COOKIE_NAME,
    ]) {
      expect(name.startsWith(HOST_COOKIE_PREFIX), name).toBe(true)
    }
    expect(SESSION_COOKIE_PATH).toBe('/')
    expect(STATE_COOKIE_PATH).toBe('/')
  })

  it('sets and clears every auth cookie as a valid __Host- cookie', () => {
    for (const name of AUTH_COOKIE_NAMES) {
      expectHostCookie(
        serializeCookie(name, 'v', { path: '/', maxAgeSeconds: 60 }),
      )
      expectHostCookie(clearedCookie(name, '/'))
    }
  })

  it('refuses to set or read a cookie without the prefix, or off Path=/', () => {
    for (const { name } of LEGACY_AUTH_COOKIES) {
      expect(() =>
        serializeCookie(name, 'v', { path: '/', maxAgeSeconds: 1 }),
      ).toThrow()
      expect(() => clearedCookie(name, '/')).toThrow()
      expect(() => readCookie(new Request('https://ernie.sg/'), name)).toThrow()
    }
    expect(() =>
      serializeCookie(STATE_COOKIE_NAME, 'v', {
        path: '/auth',
        maxAgeSeconds: 1,
      }),
    ).toThrow()
  })

  it('declares every set-cookie in the worker source through a prefixed constant', () => {
    // Belt and braces for the runtime check: a raw `set-cookie` string in the
    // worker would bypass `serializeCookie`.
    const root = resolve('src/worker')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (
          /\.ts$/u.test(entry.name) &&
          !/\.test\.ts$/u.test(entry.name)
        ) {
          const text = readFileSync(full, 'utf8')
          for (const match of text.matchAll(
            /['"`]set-cookie['"`]\s*,\s*(['"`])/gu,
          )) {
            offenders.push(`${full}: ${match[0]}`)
          }
          for (const match of text.matchAll(
            /(['"`])(?!__Host-)[A-Za-z0-9_-]+=[^'"`]*; Path=/gu,
          )) {
            offenders.push(`${full}: ${match[0]}`)
          }
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

describe('the unprefixed pre-release cookie names', () => {
  const withCookie = (cookie: string) =>
    new Request('https://ernie.sg/auth/me', { headers: { cookie } })

  it('clears each one it sees, host-only, on the path it was set on', () => {
    expect(legacyCookieClears(withCookie('a=1'))).toEqual([])
    const clears = legacyCookieClears(
      withCookie('margin-session=x; margin-auth-state=y'),
    )
    expect(clears).toHaveLength(2)
    expect(clears[0]).toMatch(/^margin-session=; Path=\/; Max-Age=0;/u)
    expect(clears[1]).toMatch(/^margin-auth-state=; Path=\/auth; Max-Age=0;/u)
    for (const clear of clears) {
      expect(clear.toLowerCase()).not.toContain('domain=')
    }
  })

  it('never reads a planted old-name cookie as a session, whatever it holds', async () => {
    // A sibling host can plant these with `Domain=ernie.sg`, which a host-only
    // clear cannot remove. The defence is that nothing reads them.
    const genuine = await sealSession(
      { accessToken: 'a.b.c', expiresAt: 4_000_000_000 },
      TEST_COOKIE_PASSWORD,
    )
    for (const { name } of LEGACY_AUTH_COOKIES) {
      const request = withCookie(`${name}=${genuine}`)
      expect(readCookie(request, SESSION_COOKIE_NAME)).toBeNull()
      expect(readCookie(request, STATE_COOKIE_NAME)).toBeNull()
    }
  })
})

describe('readCookie', () => {
  const request = (cookie: string) =>
    new Request('https://ernie.sg/auth/me', { headers: { cookie } })

  it('reads the named cookie out of a crowded header', () => {
    expect(
      readCookie(
        request(`a=1; ${SESSION_COOKIE_NAME}=sealed; b=2`),
        SESSION_COOKIE_NAME,
      ),
    ).toBe('sealed')
  })

  it('does not match a cookie whose name merely ends the same way', () => {
    expect(
      readCookie(
        request(`not-${SESSION_COOKIE_NAME}=other`),
        SESSION_COOKIE_NAME,
      ),
    ).toBeNull()
  })

  it('does not read the unprefixed name a sibling host could set', () => {
    expect(
      readCookie(request('margin-session=shadow'), SESSION_COOKIE_NAME),
    ).toBeNull()
  })

  it('reads an auth cookie that appears twice as absent', () => {
    // Only a nameless cookie planted by a sibling on an old browser can
    // duplicate a __Host- name. Picking either copy would let the plant pick.
    expect(
      readCookie(
        request(`${SESSION_COOKIE_NAME}=planted; ${SESSION_COOKIE_NAME}=mine`),
        SESSION_COOKIE_NAME,
      ),
    ).toBeNull()
  })

  it('returns null with no cookie header at all', () => {
    expect(
      readCookie(new Request('https://ernie.sg/auth/me'), SESSION_COOKIE_NAME),
    ).toBeNull()
  })
})
