import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  legacySeal,
  TEST_COOKIE_PASSWORD,
  TEST_OTHER_PASSWORD,
} from './fake-workos'
import {
  AUTH_COOKIE_NAMES,
  clearedCookie,
  clearedLegacyCookie,
  HOST_COOKIE_PREFIX,
  LEGACY_AUTH_COOKIES,
  LEGACY_SESSION_COOKIE,
  LEGACY_STATE_COOKIE,
  migrateLegacyAuthCookies,
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

describe('migrating the unprefixed legacy cookies', () => {
  const NOW_MS = 1_800_000_000_000
  const NOW_SECONDS = NOW_MS / 1000
  const live = {
    accessToken: 'header.payload.signature',
    expiresAt: NOW_SECONDS + 300,
    ceiling: NOW_SECONDS + 3600,
    refreshToken: 'refresh-token',
  }
  const withCookie = (cookie: string) =>
    new Request('https://ernie.sg/auth/me', { headers: { cookie } })

  it('leaves a request with no legacy cookie alone', async () => {
    await expect(
      migrateLegacyAuthCookies(withCookie('a=1'), TEST_COOKIE_PASSWORD, NOW_MS),
    ).resolves.toBeNull()
  })

  it('moves a live legacy session to the prefixed name once, then clears it', async () => {
    const legacy = await legacySeal(live, TEST_COOKIE_PASSWORD)
    const migration = await migrateLegacyAuthCookies(
      withCookie(`a=1; margin-session=${legacy}`),
      TEST_COOKIE_PASSWORD,
      NOW_MS,
    )
    expect(migration).not.toBeNull()
    const { request, setCookies } = migration!

    // Downstream readers see only the prefixed cookie, holding the same session.
    const sealed = readCookie(request, SESSION_COOKIE_NAME) as string
    expect(sealed.startsWith('v2.')).toBe(true)
    await expect(unsealSession(sealed, TEST_COOKIE_PASSWORD)).resolves.toEqual(
      live,
    )
    expect(request.headers.get('cookie')).not.toContain('margin-session=v1')
    expect(request.headers.get('cookie')).toContain('a=1')

    expect(setCookies).toContain(clearedLegacyCookie(LEGACY_SESSION_COOKIE))
    const moved = setCookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    )
    expect(moved).toContain('; Max-Age=3600')
  })

  it('clears the legacy state cookie on its old path without trusting it', async () => {
    const state = await legacySeal(
      { state: 's', returnTo: '/' },
      TEST_COOKIE_PASSWORD,
    )
    const migration = await migrateLegacyAuthCookies(
      withCookie(`margin-auth-state=${state}`),
      TEST_COOKIE_PASSWORD,
      NOW_MS,
    )
    expect(migration!.setCookies).toEqual([
      clearedLegacyCookie(LEGACY_STATE_COOKIE),
    ])
    expect(migration!.setCookies[0]).toContain('; Path=/auth;')
    expect(migration!.request.headers.get('cookie')).toBeNull()
  })

  it('never lets a legacy cookie override a prefixed session', async () => {
    const legacy = await legacySeal(live, TEST_COOKIE_PASSWORD)
    const current = await sealSession(
      { ...live, email: 'me@example.test' },
      TEST_COOKIE_PASSWORD,
    )
    const migration = await migrateLegacyAuthCookies(
      withCookie(`margin-session=${legacy}; ${SESSION_COOKIE_NAME}=${current}`),
      TEST_COOKIE_PASSWORD,
      NOW_MS,
    )
    expect(readCookie(migration!.request, SESSION_COOKIE_NAME)).toBe(current)
    expect(migration!.setCookies).toEqual([
      clearedLegacyCookie(LEGACY_SESSION_COOKIE),
    ])
  })

  it('refuses a legacy cookie holding a current seal, an ended session, or garbage', async () => {
    // A v2 seal under the old name is what a sibling host would toss in after
    // the rename: it must not be carried into the prefixed cookie.
    const tossed = await sealSession(live, TEST_COOKIE_PASSWORD)
    const ended = await legacySeal(
      { ...live, ceiling: NOW_SECONDS - 1 },
      TEST_COOKIE_PASSWORD,
    )
    for (const value of [tossed, ended, 'garbage']) {
      const migration = await migrateLegacyAuthCookies(
        withCookie(`margin-session=${value}`),
        TEST_COOKIE_PASSWORD,
        NOW_MS,
      )
      expect(migration!.setCookies).toEqual([
        clearedLegacyCookie(LEGACY_SESSION_COOKIE),
      ])
      expect(readCookie(migration!.request, SESSION_COOKIE_NAME)).toBeNull()
    }
  })

  it('never accepts a v1 seal outside the migration', async () => {
    const legacy = await legacySeal(live, TEST_COOKIE_PASSWORD)
    await expect(
      unsealSession(legacy, TEST_COOKIE_PASSWORD),
    ).resolves.toBeNull()
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

  it('returns null with no cookie header at all', () => {
    expect(
      readCookie(new Request('https://ernie.sg/auth/me'), SESSION_COOKIE_NAME),
    ).toBeNull()
  })
})
