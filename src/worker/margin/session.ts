import { z } from 'zod'
import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
} from './base64url'

/**
 * The sealed `__Host-margin-session` cookie.
 *
 * Sealing is AES-256-GCM under a key derived from `WORKOS_COOKIE_PASSWORD`
 * with HKDF-SHA256 and a fresh random salt per seal. GCM authenticates the
 * ciphertext, so a tampered or re-signed cookie does not unseal — but the
 * cookie is still only a carrier. `getPrincipal` re-validates the access token
 * inside it on every request, so unsealing alone never grants anything.
 *
 * Cookie attributes are fixed here rather than at each call site: `Secure`,
 * `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain` at all.
 *
 * Every auth cookie name carries the `__Host-` prefix. Leaving out `Domain`
 * keeps our cookie off sibling hosts, but it does not stop a sibling of
 * `ernie.sg` from setting a parent-domain cookie with the same name. The
 * browser sends both, `readCookie` takes the first, and that shadow cookie can
 * block sign-in or pin a victim to the attacker's session. The browser accepts
 * a `__Host-` cookie only when it is `Secure`, has `Path=/` and has no `Domain`,
 * which means it can come only from this exact host. `serializeCookie` refuses
 * any other name or path, so a new auth cookie cannot skip the prefix.
 */

export const HOST_COOKIE_PREFIX = '__Host-'
export const SESSION_COOKIE_NAME = '__Host-margin-session'
export const STATE_COOKIE_NAME = '__Host-margin-auth-state'

/** `__Host-` requires `Path=/`, so both cookies are scoped to the whole host. */
export const SESSION_COOKIE_PATH = '/'
export const STATE_COOKIE_PATH = '/'

/** Every cookie this worker sets for authentication. */
export const AUTH_COOKIE_NAMES = [
  SESSION_COOKIE_NAME,
  STATE_COOKIE_NAME,
] as const

/**
 * The unprefixed names these cookies had before, with the paths they were set
 * on. They are read once, only to migrate a live session, and then cleared.
 * They are never trusted as-is. See `migrateLegacyAuthCookies`.
 */
export const LEGACY_SESSION_COOKIE = {
  name: 'margin-session',
  path: '/',
} as const
export const LEGACY_STATE_COOKIE = {
  name: 'margin-auth-state',
  path: '/auth',
} as const
export const LEGACY_AUTH_COOKIES = [
  LEGACY_SESSION_COOKIE,
  LEGACY_STATE_COOKIE,
] as const

/** A login attempt is worth ten minutes and no more. */
export const STATE_COOKIE_MAX_AGE_SECONDS = 600

/** Upper bound on a session regardless of what the provider says. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8

/**
 * `v2` began with the `__Host-` names. Nothing seals `v1` any more, so the set
 * of valid `v1` seals stopped growing at deploy, and every one of them ends
 * within `SESSION_MAX_AGE_SECONDS` of then. Only the one-time migration of the
 * legacy session cookie accepts `v1`. A legacy-named cookie that a sibling host
 * tosses in later therefore cannot carry a fresh session into the migration.
 */
const SEAL_VERSION = 'v2'
const LEGACY_SEAL_VERSION = 'v1'
// Named rather than written inline at the call: a string literal sitting next
// to an argument called `password` reads to a generic secret scanner as that
// password's value, and a false positive on every pull request that touches
// this file costs more than a constant does. There is no secret in this file —
// the password is supplied at runtime from the platform secret store.
const KDF = 'HKDF'
const HKDF_INFO = 'margin-session-seal-v1'
const SALT_BYTES = 16
const IV_BYTES = 12

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encodeUtf8(password),
    KDF,
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: KDF, hash: 'SHA-256', salt, info: encodeUtf8(HKDF_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function seal(value: unknown, password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES)
  const iv = new Uint8Array(IV_BYTES)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(iv)
  const key = await deriveKey(password, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encodeUtf8(SEAL_VERSION) },
    key,
    encodeUtf8(JSON.stringify(value)),
  )
  return [
    SEAL_VERSION,
    encodeBase64Url(salt),
    encodeBase64Url(iv),
    encodeBase64Url(new Uint8Array(ciphertext)),
  ].join('.')
}

export type UnsealOptions = {
  /**
   * Accept only a pre-`__Host-` `v1` seal instead of a current one. Only the
   * legacy migration sets this. It is exclusive, so a current seal carried
   * under a legacy name is refused and cannot be moved into the prefixed
   * cookie.
   */
  legacySeal?: boolean
}

/** Returns `null` for anything that is not an intact seal of ours. */
export async function unseal(
  sealed: string,
  password: string,
  { legacySeal = false }: UnsealOptions = {},
): Promise<unknown> {
  const parts = sealed.split('.')
  const version = legacySeal ? LEGACY_SEAL_VERSION : SEAL_VERSION
  if (parts.length !== 4 || parts[0] !== version) return null
  const salt = decodeBase64Url(parts[1] as string)
  const iv = decodeBase64Url(parts[2] as string)
  const ciphertext = decodeBase64Url(parts[3] as string)
  if (!salt || !iv || !ciphertext) return null
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) return null
  try {
    const key = await deriveKey(password, salt)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encodeUtf8(version) },
      key,
      ciphertext,
    )
    return JSON.parse(decodeUtf8(new Uint8Array(plaintext))) as unknown
  } catch {
    return null
  }
}

/**
 * What the cookie carries.
 *
 * The access token is the credential; `email` rides along as profile data for
 * `/auth/me` and is never the durable key for anything. Identity is always
 * `(provider, issuer, subject)`, read back out of the verified token.
 */
export const marginSessionSchema = z
  .object({
    accessToken: z.string().min(1),
    /**
     * Seconds since the epoch: the lesser of the token's `exp` and `ceiling`.
     * Checked server-side, because a cookie copied out of a browser has no
     * `Max-Age` to obey.
     */
    expiresAt: z.number().int().positive(),
    /**
     * The absolute end of this sign-in, fixed once at login.
     *
     * A refresh moves `expiresAt`, never this: otherwise refreshing in a loop
     * would make `SESSION_MAX_AGE_SECONDS` unreachable and the ceiling
     * decorative. Optional so a session sealed before this field existed still
     * unseals.
     */
    ceiling: z.number().int().positive().optional(),
    /**
     * The WorkOS refresh token. Access tokens are short-lived, so without this
     * a sign-in would last minutes; it never leaves the sealed cookie.
     */
    refreshToken: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    /**
     * Whether the provider said this session's own subject holds a verified
     * `email`. Sealed so a later request can finish the identity and admin
     * bootstrap that a database outage during the callback interrupted; it is
     * never a substitute for the token, which still has to verify.
     */
    emailVerified: z.literal(true).optional(),
  })
  .strict()

export type MarginSession = z.infer<typeof marginSessionSchema>

export const loginStateSchema = z
  .object({
    state: z.string().min(1),
    returnTo: z.string().startsWith('/'),
  })
  .strict()

export type LoginState = z.infer<typeof loginStateSchema>

export async function sealSession(
  session: MarginSession,
  password: string,
): Promise<string> {
  return seal(marginSessionSchema.parse(session), password)
}

export async function unsealSession(
  sealed: string,
  password: string,
  options: UnsealOptions = {},
): Promise<MarginSession | null> {
  const result = marginSessionSchema.safeParse(
    await unseal(sealed, password, options),
  )
  return result.success ? result.data : null
}

export async function sealLoginState(
  state: LoginState,
  password: string,
): Promise<string> {
  return seal(loginStateSchema.parse(state), password)
}

export async function unsealLoginState(
  sealed: string,
  password: string,
): Promise<LoginState | null> {
  const result = loginStateSchema.safeParse(await unseal(sealed, password))
  return result.success ? result.data : null
}

export type CookieOptions = {
  path: string
  maxAgeSeconds: number
}

export function serializeCookie(
  name: string,
  value: string,
  { path, maxAgeSeconds }: CookieOptions,
): string {
  // A browser drops a `__Host-` cookie that is not `Path=/`, so both checks
  // fail here instead of in a sign-in that silently never sticks.
  if (!name.startsWith(HOST_COOKIE_PREFIX)) {
    throw new Error(
      `auth cookie ${name} must carry the ${HOST_COOKIE_PREFIX} prefix`,
    )
  }
  if (path !== '/') {
    throw new Error(`${HOST_COOKIE_PREFIX} cookie ${name} must have Path=/`)
  }
  return headerFor(name, value, path, maxAgeSeconds)
}

// No `Domain`: a host-only cookie is never offered to a parent domain.
function headerFor(
  name: string,
  value: string,
  path: string,
  maxAgeSeconds: number,
): string {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ')
}

export function clearedCookie(name: string, path: string): string {
  return serializeCookie(name, '', { path, maxAgeSeconds: 0 })
}

/** Expires one of the unprefixed legacy cookies, on the path it was set on. */
export function clearedLegacyCookie(
  legacy: (typeof LEGACY_AUTH_COOKIES)[number],
): string {
  return headerFor(legacy.name, '', legacy.path, 0)
}

function cookiePairs(header: string | null): Array<[string, string]> {
  if (!header) return []
  const pairs: Array<[string, string]> = []
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    pairs.push([
      pair.slice(0, separator).trim(),
      pair.slice(separator + 1).trim(),
    ])
  }
  return pairs
}

export type LegacyCookieMigration = {
  /** The request with every legacy auth cookie removed, plus any migrated one. */
  request: Request
  /** Headers that clear the legacy cookies and set any migrated session. */
  setCookies: string[]
}

/**
 * Reads the pre-`__Host-` auth cookies once, then clears them.
 *
 * A session signed in before the rename is re-sealed under
 * `__Host-margin-session`, so the user stays signed in. This happens only when
 * the request has no prefixed session, the legacy value is an intact `v1` seal
 * (see `SEAL_VERSION`), and that seal has not reached its own end. The
 * returned request carries the migrated cookie, so every reader downstream
 * sees only the prefixed name. A login still in progress under the legacy
 * state cookie is not migrated. That cookie is only cleared, and the sign-in
 * starts again. Nothing on the server bounds a state seal's age, so trusting
 * an unprefixed one would reopen the shadowing it was renamed to prevent.
 *
 * Returns `null` when the request carries no legacy cookie.
 */
export async function migrateLegacyAuthCookies(
  request: Request,
  password: string | null,
  nowMs: number = Date.now(),
): Promise<LegacyCookieMigration | null> {
  const pairs = cookiePairs(request.headers.get('cookie'))
  const legacyNames = new Set<string>(
    LEGACY_AUTH_COOKIES.map(({ name }) => name),
  )
  const present = LEGACY_AUTH_COOKIES.filter(({ name }) =>
    pairs.some(([key]) => key === name),
  )
  if (present.length === 0) return null

  const setCookies = present.map(clearedLegacyCookie)
  const kept = pairs.filter(([key]) => !legacyNames.has(key))

  const legacySession = pairs.find(
    ([key, value]) => key === LEGACY_SESSION_COOKIE.name && value,
  )?.[1]
  const hasSession = kept.some(
    ([key, value]) => key === SESSION_COOKIE_NAME && value,
  )
  if (legacySession && !hasSession && password) {
    const session = await unsealSession(legacySession, password, {
      legacySeal: true,
    })
    const nowSeconds = Math.floor(nowMs / 1000)
    const end = session ? (session.ceiling ?? session.expiresAt) : 0
    if (session && end > nowSeconds) {
      const resealed = await sealSession({ ...session, ceiling: end }, password)
      setCookies.push(
        serializeCookie(SESSION_COOKIE_NAME, resealed, {
          path: SESSION_COOKIE_PATH,
          maxAgeSeconds: end - nowSeconds,
        }),
      )
      kept.push([SESSION_COOKIE_NAME, resealed])
    }
  }

  const headers = new Headers(request.headers)
  if (kept.length > 0) {
    headers.set(
      'cookie',
      kept.map(([key, value]) => `${key}=${value}`).join('; '),
    )
  } else {
    headers.delete('cookie')
  }
  return { request: new Request(request, { headers }), setCookies }
}

/**
 * The first value of an auth cookie. Only `__Host-` names can be read, because
 * an unprefixed name is exactly the one a sibling host can shadow. The legacy
 * names are read only by `migrateLegacyAuthCookies`.
 */
export function readCookie(request: Request, name: string): string | null {
  if (!name.startsWith(HOST_COOKIE_PREFIX)) {
    throw new Error(
      `auth cookie ${name} must carry the ${HOST_COOKIE_PREFIX} prefix`,
    )
  }
  for (const [key, value] of cookiePairs(request.headers.get('cookie'))) {
    if (key === name) return value || null
  }
  return null
}
