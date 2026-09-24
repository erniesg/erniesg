import { decodeBase64Url, decodeJsonSegment, encodeUtf8 } from './base64url'
import type { WorkosConfig } from './config'
import { PROVIDER_FETCH_TIMEOUT_MS, settleWithin } from './deadline'

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
  /**
   * Optional: AuthKit access tokens carry neither `client_id` nor `aud`. The
   * application binding is the key set — see `verifyAccessToken`.
   */
  client_id?: string
  aud?: string | string[]
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
  /**
   * The longest one `getKey` can take when every refresh on its path runs to
   * its bound. Callers that must finish inside a deadline of their own, such
   * as a session renewal, size that deadline from this.
   */
  readonly worstCaseMs: number
}

/**
 * The most refreshes one `getKey` can run in sequence: a TTL refresh, a join
 * on a fetch another request has in flight, and the rotation refetch.
 */
export const JWKS_REFRESHES_PER_LOOKUP = 3

/**
 * One refresh at its worst: waiting out another request's fetch for the full
 * bound, then fetching for itself for the full bound.
 */
export function jwksWorstCaseMs(fetchTimeoutMs: number): number {
  return JWKS_REFRESHES_PER_LOOKUP * 2 * fetchTimeoutMs
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
  /**
   * Bound on one key-set fetch, and on how long a caller waits for a fetch
   * another request started before it fetches for itself.
   */
  fetchTimeoutMs?: number
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
  const fetchTimeoutMs = options.fetchTimeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS

  let keys: Map<string, CryptoKey> | null = null
  let fetchedAt = 0
  /**
   * When a rotation refetch was last attempted. It is its own clock, not the
   * time of the last fetch of any kind: an ordinary cache fill used to share one
   * clock with rotation, so a key published just after that fill was throttled
   * for up to `minRefreshMs`, rejecting valid callbacks for a minute after
   * every rotation. The first unknown `kid` now refetches immediately, and only
   * a *second* one inside the window is throttled, which is the traffic this
   * guards against.
   */
  let rotationAt = 0
  /**
   * The one key-set fetch in flight, shared by every caller that needs it.
   *
   * Every refresh goes through `refresh()`, and a caller that arrives while a
   * fetch is running awaits that fetch instead of starting or skipping one.
   * Without this, a second request carrying a newly rotated `kid` saw the
   * rotation throttle already set by the first, skipped the refetch, and read
   * the stale map, so a valid token got a 401 during key rotation.
   */
  let inflight: Promise<boolean> | null = null

  function startFetch(): Promise<boolean> {
    const started: Promise<boolean> = fetchKeySet().finally(() => {
      if (inflight === started) inflight = null
    })
    inflight = started
    return started
  }

  /**
   * Joins the fetch in flight, or starts one.
   *
   * A joiner does not depend on the request that started the fetch. It waits
   * on its own timer for at most `fetchTimeoutMs`. If the shared fetch has not
   * settled by then (its request was cancelled, or the provider is slow), the
   * joiner empties the slot so it cannot stay pinned, and fetches for itself.
   */
  async function refresh(): Promise<boolean> {
    const shared = inflight
    if (!shared) return startFetch()
    const waited = await settleWithin(shared, fetchTimeoutMs)
    if (waited.settled) return waited.value
    if (inflight === shared) inflight = null
    return startFetch()
  }

  async function fetchKeySet(): Promise<boolean> {
    let payload: unknown
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(fetchTimeoutMs),
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
    worstCaseMs: jwksWorstCaseMs(fetchTimeoutMs),
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
      // An unknown `kid` is the signal for key rotation. A fetch already in
      // flight may be the one that brings the new key, so wait for it first:
      // that costs no extra traffic, and it is what keeps a second request with
      // the same new `kid` from reading the stale map.
      if (inflight) {
        await refresh()
        const fetched = keys?.get(kid)
        if (fetched) return fetched
      }
      // Otherwise refetch, but no more often than `minRefreshMs`, so a bogus
      // `kid` cannot drive traffic.
      if (keys && now() - rotationAt >= minRefreshMs) {
        rotationAt = now()
        await refresh()
      }
      return keys?.get(kid) ?? null
    },
  }
}

/**
 * Whether two issuer spellings name the same issuer.
 *
 * Canonical origin plus path with any trailing slash removed. Anything that is
 * not a parseable absolute URL falls back to a byte comparison, so a malformed
 * issuer cannot match a well-formed one by accident.
 */
function sameIssuer(claimed: string, configured: string): boolean {
  const canonical = (value: string): string | null => {
    try {
      const url = new URL(value)
      return `${url.origin}${url.pathname.replace(/\/+$/u, '')}${url.search}`
    } catch {
      return null
    }
  }
  const a = canonical(claimed)
  const b = canonical(configured)
  if (a === null || b === null) return claimed === configured
  return a === b
}

function asClaims(value: unknown): AccessTokenClaims | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.iss !== 'string') return null
  if (typeof record.sub !== 'string') return null
  if (record.client_id !== undefined && typeof record.client_id !== 'string') {
    return null
  }
  if (
    record.aud !== undefined &&
    typeof record.aud !== 'string' &&
    !(Array.isArray(record.aud) && record.aud.every((one) => typeof one === 'string'))
  ) {
    return null
  }
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

  // Compared as URLs, not as strings. WorkOS's own documentation writes this
  // issuer both ways — `https://api.workos.com` on the access-token reference and
  // `https://api.workos.com/` on the AuthKit sessions page — and the operator
  // types it by hand into a secret. A byte comparison would reject every token
  // over a trailing slash, with `reason: 'issuer'` and nothing to say which
  // character was wrong. This is still exact about the thing that matters: the
  // same origin and the same path, and a different issuer is still a rejection.
  if (!sameIssuer(claims.iss, config.issuer)) {
    return { ok: false, reason: 'issuer' }
  }
  // The application binding is cryptographic, not a claim. The key set lives at
  // `/sso/jwks/<clientId>`, so a signature that verifies against it was made by
  // a key belonging to this application and no other — which is why a token
  // from a different application is rejected even though AuthKit access tokens
  // carry neither `client_id` nor `aud`. Requiring `client_id` rejected every
  // genuine token; it is checked when a provider does send it, and `aud` with it.
  // Each is checked when present, and they are checked separately: preferring
  // one would let a token whose `client_id` is right and whose `aud` names
  // another application through.
  if (
    claims.client_id !== undefined &&
    claims.client_id !== config.clientId
  ) {
    return { ok: false, reason: 'client-id' }
  }
  // Exactly this application, not "among others". A contains-check would accept
  // a token minted for a different service that happens to list us too, and an
  // application binding is not a general-purpose audience. An `aud` that is
  // present and names nobody is refused for the same reason: present and
  // meaningless is not the same as absent.
  if (claims.aud !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (audiences.length !== 1 || audiences[0] !== config.clientId) {
      return { ok: false, reason: 'client-id' }
    }
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
