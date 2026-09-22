import { decodeBase64Url, decodeJsonSegment, encodeUtf8 } from './base64url'
import type { WorkosConfig } from './config'

/**
 * Access-token validation, ported from the checks in
 * `rucksack/src/rucksack/workos_auth.py` rather than the code — this surface
 * is TypeScript on WebCrypto, so there is no shared implementation to reuse.
 *
 * Every check is mandatory and the verifier fails closed. There is no path
 * through this module that trusts a header, an email address, an unsigned
 * token, or a token whose key could not be fetched. A `false` result is the
 * only thing a caller ever gets when anything at all is wrong, and the reason
 * string exists for tests and never for a response body.
 */

/** Only RS256. `none`, HMAC and anything else is rejected before key lookup. */
export const ALLOWED_ALGORITHMS = ['RS256'] as const

/**
 * Tolerance for `nbf`/`iat` only, so a token minted a moment ahead of our
 * clock still works. `exp` is checked with no tolerance: expiry fails closed.
 */
export const CLOCK_SKEW_SECONDS = 60

export type AccessTokenClaims = {
  iss: string
  sub: string
  client_id: string
  exp: number
  nbf?: number
  iat?: number
  sid?: string
}

export type VerifyFailureReason =
  | 'malformed'
  | 'algorithm'
  | 'kid'
  | 'jwks-unavailable'
  | 'signature'
  | 'issuer'
  | 'client-id'
  | 'subject'
  | 'expired'
  | 'not-yet-valid'

export type VerifyResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: VerifyFailureReason }

export type JwksSource = {
  /** Resolves to `null` when the key is unknown or the provider is down. */
  getKey(kid: string): Promise<CryptoKey | null>
}

type JwkLike = {
  kid?: unknown
  kty?: unknown
  alg?: unknown
  use?: unknown
  n?: unknown
  e?: unknown
}

const RSA_IMPORT_ALGORITHM = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
} as const

async function importJwk(jwk: JwkLike): Promise<CryptoKey | null> {
  if (jwk.kty !== 'RSA') return null
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') return null
  if (jwk.use !== undefined && jwk.use !== 'sig') return null
  if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      RSA_IMPORT_ALGORITHM,
      false,
      ['verify'],
    )
  } catch {
    return null
  }
}

export type JwksSourceOptions = {
  fetchImpl?: typeof fetch
  now?: () => number
  /** How long a successfully fetched key set is reused. */
  ttlMs?: number
  /** Floor between refetches triggered by an unknown `kid`, for rotation. */
  minRefreshMs?: number
}

/**
 * A JWKS reader with a small cache.
 *
 * A failed fetch is never cached and never downgrades to "no signature
 * required" — `getKey` simply resolves to `null` and the verifier rejects the
 * token. A previously fetched key set keeps working while the provider is
 * unreachable, which is a cache hit rather than a fallback: the signature is
 * still checked against a real key.
 */
export function createJwksSource(
  url: string,
  options: JwksSourceOptions = {},
): JwksSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 600_000
  const minRefreshMs = options.minRefreshMs ?? 60_000

  let keys: Map<string, CryptoKey> | null = null
  let fetchedAt = 0
  let attemptedAt = 0

  async function refresh(): Promise<boolean> {
    attemptedAt = now()
    let payload: unknown
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return false
      payload = await response.json()
    } catch {
      return false
    }

    const candidates = (payload as { keys?: unknown } | null)?.keys
    if (!Array.isArray(candidates)) return false

    const next = new Map<string, CryptoKey>()
    for (const candidate of candidates as JwkLike[]) {
      if (typeof candidate?.kid !== 'string' || !candidate.kid) continue
      const key = await importJwk(candidate)
      if (key) next.set(candidate.kid, key)
    }
    keys = next
    fetchedAt = now()
    return true
  }

  return {
    async getKey(kid: string): Promise<CryptoKey | null> {
      if (!keys || now() - fetchedAt > ttlMs) {
        // A key set past its TTL has stopped being evidence. Keeping it when
        // the refresh fails would let a key WorkOS has revoked go on
        // validating tokens for as long as the provider stays unreachable,
        // which is the fallback this must not have: drop it and refuse.
        if (!(await refresh())) {
          keys = null
          return null
        }
      }
      const cached = keys?.get(kid)
      if (cached) return cached
      // An unknown `kid` is the signal for key rotation. Refetch, but no more
      // often than `minRefreshMs`, so a bogus `kid` cannot drive traffic.
      if (keys && now() - attemptedAt >= minRefreshMs) await refresh()
      return keys?.get(kid) ?? null
    },
  }
}

function asClaims(value: unknown): AccessTokenClaims | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.iss !== 'string') return null
  if (typeof record.sub !== 'string') return null
  if (typeof record.client_id !== 'string') return null
  if (typeof record.exp !== 'number' || !Number.isFinite(record.exp)) return null
  for (const optional of ['nbf', 'iat'] as const) {
    const claim = record[optional]
    if (claim !== undefined && typeof claim !== 'number') return null
  }
  return record as unknown as AccessTokenClaims
}

export type VerifyOptions = {
  config: WorkosConfig
  jwks: JwksSource
  /** Milliseconds since the epoch. Injected so expiry is testable. */
  now?: number
}

export async function verifyAccessToken(
  token: string,
  { config, jwks, now = Date.now() }: VerifyOptions,
): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [
    string,
    string,
    string,
  ]

  const header = decodeJsonSegment(headerSegment) as {
    alg?: unknown
    kid?: unknown
  } | null
  if (!header || typeof header !== 'object') {
    return { ok: false, reason: 'malformed' }
  }
  if (
    typeof header.alg !== 'string' ||
    !(ALLOWED_ALGORITHMS as readonly string[]).includes(header.alg)
  ) {
    return { ok: false, reason: 'algorithm' }
  }
  if (typeof header.kid !== 'string' || !header.kid) {
    return { ok: false, reason: 'kid' }
  }

  const claims = asClaims(decodeJsonSegment(payloadSegment))
  if (!claims) return { ok: false, reason: 'malformed' }

  const key = await jwks.getKey(header.kid)
  if (!key) return { ok: false, reason: 'jwks-unavailable' }

  const signature = decodeBase64Url(signatureSegment)
  if (!signature) return { ok: false, reason: 'malformed' }

  let verified = false
  try {
    verified = await crypto.subtle.verify(
      RSA_IMPORT_ALGORITHM,
      key,
      signature,
      encodeUtf8(`${headerSegment}.${payloadSegment}`),
    )
  } catch {
    verified = false
  }
  if (!verified) return { ok: false, reason: 'signature' }

  if (claims.iss !== config.issuer) return { ok: false, reason: 'issuer' }
  if (claims.client_id !== config.clientId) {
    return { ok: false, reason: 'client-id' }
  }
  if (!claims.sub.trim()) return { ok: false, reason: 'subject' }

  const seconds = Math.floor(now / 1000)
  if (seconds >= claims.exp) return { ok: false, reason: 'expired' }
  if (claims.nbf !== undefined && seconds + CLOCK_SKEW_SECONDS < claims.nbf) {
    return { ok: false, reason: 'not-yet-valid' }
  }
  if (claims.iat !== undefined && seconds + CLOCK_SKEW_SECONDS < claims.iat) {
    return { ok: false, reason: 'not-yet-valid' }
  }

  return { ok: true, claims }
}
