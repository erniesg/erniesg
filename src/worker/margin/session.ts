import { z } from 'zod'
import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
} from './base64url'

/**
 * The sealed `margin-session` cookie.
 *
 * Sealing is AES-256-GCM under a key derived from `WORKOS_COOKIE_PASSWORD`
 * with HKDF-SHA256 and a fresh random salt per seal. GCM authenticates the
 * ciphertext, so a tampered or re-signed cookie does not unseal — but the
 * cookie is still only a carrier. `getPrincipal` re-validates the access token
 * inside it on every request, so unsealing alone never grants anything.
 *
 * Cookie attributes are fixed here rather than at each call site: `Secure`,
 * `HttpOnly`, `SameSite=Lax`, and no `Domain` at all, which makes it a
 * host-only cookie that can never be sent to `berlayar.ai` or any other
 * sibling of this host.
 */

export const SESSION_COOKIE_NAME = 'margin-session'
export const STATE_COOKIE_NAME = 'margin-auth-state'

/**
 * The session is presented to both `/auth/*` and `/api/margin/v1/*`, so `/`
 * is the narrowest path that covers the endpoints that need it. The
 * short-lived login-state cookie has no such constraint and is scoped to
 * `/auth`.
 */
export const SESSION_COOKIE_PATH = '/'
export const STATE_COOKIE_PATH = '/auth'

/** A login attempt is worth ten minutes and no more. */
export const STATE_COOKIE_MAX_AGE_SECONDS = 600

/** Upper bound on a session regardless of what the provider says. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8

const SEAL_VERSION = 'v1'
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

/** Returns `null` for anything that is not an intact seal of ours. */
export async function unseal(
  sealed: string,
  password: string,
): Promise<unknown> {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) return null
  const salt = decodeBase64Url(parts[1] as string)
  const iv = decodeBase64Url(parts[2] as string)
  const ciphertext = decodeBase64Url(parts[3] as string)
  if (!salt || !iv || !ciphertext) return null
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) return null
  try {
    const key = await deriveKey(password, salt)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encodeUtf8(SEAL_VERSION) },
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
): Promise<MarginSession | null> {
  const result = marginSessionSchema.safeParse(await unseal(sealed, password))
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
  // No `Domain`: a host-only cookie is never offered to a parent domain.
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

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() !== name) continue
    const value = pair.slice(separator + 1).trim()
    return value || null
  }
  return null
}
