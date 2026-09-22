import { z } from 'zod'

/**
 * WorkOS configuration, read from the deployment platform's secret store.
 *
 * Every value arrives as a Worker binding (`wrangler secret put`) and none of
 * them may ever be written to a file in this repository, a log line, or a
 * response body. This module only names them and validates their shape.
 *
 * `readWorkosConfig` fails closed: an absent or malformed value yields `null`
 * and every caller treats `null` as "nobody is authenticated", never as "let
 * this through".
 */

export const WORKOS_PROVIDER = 'workos'

/** The admin identity is bootstrapped once, by verified email, and only once. */
export const DEFAULT_ADMIN_EMAIL = 'hello@ernie.sg'

/** Names only. Values live in the platform secret store. */
export type WorkosEnv = {
  WORKOS_ISSUER?: string
  WORKOS_CLIENT_ID?: string
  WORKOS_API_KEY?: string
  WORKOS_COOKIE_PASSWORD?: string
  WORKOS_REDIRECT_URI?: string
  MARGIN_ADMIN_EMAIL?: string
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    // A local development callback is the only plain-http address allowed.
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}

const workosConfigSchema = z
  .object({
    /** Compared byte-for-byte against the token's `iss` claim. */
    issuer: z.string().min(1).refine(httpsUrl),
    /** Compared byte-for-byte against the token's `client_id` claim. */
    clientId: z.string().min(1),
    apiKey: z.string().min(1),
    /** Sealing key material. 32 bytes is the iron-session floor. */
    cookiePassword: z.string().min(32),
    redirectUri: z.string().min(1).refine(httpsUrl),
    adminEmail: z.string().min(3).includes('@'),
  })
  .strict()

export type WorkosConfig = z.infer<typeof workosConfigSchema>

export function readWorkosConfig(env: WorkosEnv): WorkosConfig | null {
  const result = workosConfigSchema.safeParse({
    issuer: env.WORKOS_ISSUER?.trim(),
    clientId: env.WORKOS_CLIENT_ID?.trim(),
    apiKey: env.WORKOS_API_KEY?.trim(),
    cookiePassword: env.WORKOS_COOKIE_PASSWORD,
    redirectUri: env.WORKOS_REDIRECT_URI?.trim(),
    adminEmail: (env.MARGIN_ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL)
      .toLowerCase(),
  })
  return result.success ? result.data : null
}

/**
 * The WorkOS API origin for this environment, taken from the issuer rather
 * than hardcoded, so staging and production never cross over.
 */
function apiOrigin(config: WorkosConfig): string {
  return new URL(config.issuer).origin
}

export function authorizationUrl(
  config: WorkosConfig,
  state: string,
): string {
  const url = new URL('/user_management/authorize', apiOrigin(config))
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('provider', 'authkit')
  url.searchParams.set('state', state)
  return url.toString()
}

export function tokenEndpoint(config: WorkosConfig): string {
  return new URL('/user_management/authenticate', apiOrigin(config)).toString()
}

export function jwksUrl(config: WorkosConfig): string {
  return new URL(
    `/sso/jwks/${encodeURIComponent(config.clientId)}`,
    apiOrigin(config),
  ).toString()
}
