import { z } from 'zod'
import { DEVELOPMENT_ENVIRONMENT, type WorkerEnv } from './env'
import {
  jwksUrl,
  readWorkosConfig,
  WORKOS_PROVIDER,
  type WorkosConfig,
} from './margin/config'
import { createJwksSource, verifyAccessToken, type JwksSource } from './margin/jwt'
import {
  readCookie,
  SESSION_COOKIE_NAME,
  unsealSession,
} from './margin/session'

/**
 * The single place any route learns who the caller is.
 *
 * A caller is whoever holds a sealed `margin-session` cookie containing a
 * WorkOS access token that still passes every check in `verifyAccessToken` —
 * signature, allowed algorithm, expiry, activation, exact issuer, exact
 * `client_id`, non-empty subject. Nothing else produces a principal. There is
 * no header, no email, and no unauthenticated default that reaches this
 * return value; when anything is missing or wrong the answer is `null` and the
 * caller is anonymous, which for reading the book is entirely fine and for
 * writing is a 401.
 *
 * The development stub survives, but only when `MARGIN_ENVIRONMENT` is
 * exactly `development`. An unset variable is treated as production, so a
 * production build cannot reach it even if `MARGIN_DEV_PRINCIPAL` is set.
 */

/** Identity is `(provider, issuer, subject)`. Email is profile data only. */
export const principalSchema = z
  .object({
    provider: z.string().min(1),
    issuer: z.string().min(1),
    subject: z.string().min(1),
    email: z.string().min(1).optional(),
  })
  .strict()

export type Principal = z.infer<typeof principalSchema>

/** Header a caller uses to claim an identity while the stub is enabled. */
export const DEV_PRINCIPAL_HEADER = 'x-margin-dev-principal'

const DEV_PRINCIPAL_PROVIDER = 'dev'
const DEV_PRINCIPAL_ISSUER = 'urn:margin:dev'

function parseDevPrincipal(value: string): Principal | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const candidate = trimmed.startsWith('{')
    ? (() => {
        try {
          return JSON.parse(trimmed) as unknown
        } catch {
          return null
        }
      })()
    : {
        provider: DEV_PRINCIPAL_PROVIDER,
        issuer: DEV_PRINCIPAL_ISSUER,
        subject: trimmed,
      }
  if (candidate === null) return null

  const result = principalSchema.safeParse(candidate)
  return result.success ? result.data : null
}

export type PrincipalEnv = Partial<Omit<WorkerEnv, 'ASSETS'>>

export type PrincipalOptions = {
  /** Milliseconds since the epoch. Injected so expiry is testable. */
  now?: number
  /** Used for the JWKS fetch. Injected so provider outages are testable. */
  fetchImpl?: typeof fetch
  /** Overrides the cached JWKS reader. Tests supply their own. */
  jwks?: JwksSource
}

/**
 * One JWKS reader per key-set URL, per isolate.
 *
 * Caching the reader is what keeps signature checks cheap. It never caches a
 * failure, so a provider outage means "no key" and therefore "no principal".
 */
const jwksSources = new Map<string, JwksSource>()

function jwksFor(config: WorkosConfig, fetchImpl?: typeof fetch): JwksSource {
  const url = jwksUrl(config)
  const existing = jwksSources.get(url)
  if (existing) return existing
  const created = createJwksSource(url, { fetchImpl })
  jwksSources.set(url, created)
  return created
}

/**
 * Whether the request arrived on a loopback address.
 *
 * `MARGIN_ENVIRONMENT` is configuration, and configuration drifts. The stub
 * hands out an identity with no token behind it, so it must not depend on one
 * variable being right: a deployed Worker answers on `ernie.sg` or a
 * `workers.dev` subdomain, never on loopback, so this closes the stub on every
 * deployed hostname whatever the environment says.
 */
function onLoopback(request: Request): boolean {
  try {
    const { hostname } = new URL(request.url)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    )
  } catch {
    return false
  }
}

function devPrincipal(
  request: Request,
  env: PrincipalEnv,
): Principal | null {
  if (env.MARGIN_ENVIRONMENT !== DEVELOPMENT_ENVIRONMENT) return null
  if (!onLoopback(request)) return null
  const stub = env.MARGIN_DEV_PRINCIPAL
  if (!stub) return null
  return parseDevPrincipal(request.headers.get(DEV_PRINCIPAL_HEADER) ?? stub)
}

export async function getPrincipal(
  request: Request,
  env: PrincipalEnv = {},
  options: PrincipalOptions = {},
): Promise<Principal | null> {
  const stubbed = devPrincipal(request, env)
  if (stubbed) return stubbed

  const config = readWorkosConfig(env)
  if (!config) return null

  const sealed = readCookie(request, SESSION_COOKIE_NAME)
  if (!sealed) return null

  const session = await unsealSession(sealed, config.cookiePassword)
  if (!session) return null

  // The seal carries the session's own ceiling — the lesser of the token's
  // `exp` and `SESSION_MAX_AGE_SECONDS`. Checking it here is what makes the
  // ceiling real: `Max-Age` only governs the browser's copy, and a cookie
  // lifted out of one is accepted on its contents alone.
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  if (nowSeconds >= session.expiresAt) return null

  const verified = await verifyAccessToken(session.accessToken, {
    config,
    jwks: options.jwks ?? jwksFor(config, options.fetchImpl),
    now: options.now,
  })
  if (!verified.ok) return null

  const result = principalSchema.safeParse({
    provider: WORKOS_PROVIDER,
    issuer: verified.claims.iss,
    subject: verified.claims.sub,
    ...(session.email ? { email: session.email } : {}),
  })
  return result.success ? result.data : null
}
