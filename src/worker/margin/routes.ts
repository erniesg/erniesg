import type { WorkerEnv } from '../env'
import {
  getPrincipal,
  type Principal,
  type PrincipalOptions,
} from '../principal'
import { randomToken, timingSafeEqual } from './base64url'
import {
  authorizationUrl,
  jwksUrl,
  readWorkosConfig,
  tokenEndpoint,
  WORKOS_PROVIDER,
  type WorkosConfig,
} from './config'
import {
  allowlistRole,
  bindAdmin,
  ensureSchema,
  recordIdentity,
} from './identity'
import { createJwksSource, verifyAccessToken, type JwksSource } from './jwt'
import {
  clearedCookie,
  readCookie,
  sealLoginState,
  sealSession,
  serializeCookie,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  SESSION_MAX_AGE_SECONDS,
  STATE_COOKIE_MAX_AGE_SECONDS,
  STATE_COOKIE_NAME,
  STATE_COOKIE_PATH,
  unsealLoginState,
} from './session'

/**
 * `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`.
 *
 * The authorization-code half of AuthKit: the browser is redirected to the
 * hosted UI, comes back with a code, and the code is exchanged server-side so
 * the API key never leaves the Worker. The resulting access token is validated
 * before anything is stored, then sealed into the `margin-session` cookie.
 *
 * Error responses are deliberately uninformative. A caller learns that login
 * failed and nothing about why, because the interesting reasons involve
 * provider responses we do not want to paraphrase back to the internet.
 */

export const AUTH_PREFIX = '/auth'
export const AUTH_LOGIN_PATH = `${AUTH_PREFIX}/login`
export const AUTH_CALLBACK_PATH = `${AUTH_PREFIX}/callback`
export const AUTH_LOGOUT_PATH = `${AUTH_PREFIX}/logout`
export const AUTH_ME_PATH = `${AUTH_PREFIX}/me`

export const AUTH_PATHS: readonly string[] = [
  AUTH_LOGIN_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_ME_PATH,
]

export type AuthEnv = Partial<Omit<WorkerEnv, 'ASSETS'>>

export type AuthOptions = PrincipalOptions & {
  /** Used for the token exchange too. Injected so the provider is testable. */
  fetchImpl?: typeof fetch
}

function json(
  body: unknown,
  status = 200,
  extraHeaders: Array<[string, string]> = [],
): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  for (const [name, value] of extraHeaders) headers.append(name, value)
  return new Response(`${JSON.stringify(body)}\n`, { status, headers })
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } })
}

const CONTROL_CHARACTER_MAX = 0x1f
const DELETE_CHARACTER = 0x7f

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= CONTROL_CHARACTER_MAX || code === DELETE_CHARACTER) return true
  }
  return false
}

/**
 * Keeps only a same-origin path across login.
 *
 * Anything absolute, protocol-relative, backslash-smuggled or carrying control
 * characters becomes `/`. An open redirect through the login endpoint would
 * hand an attacker a credible `ernie.sg` link to somewhere else.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value) return '/'
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//') || value.startsWith('/\\')) return '/'
  if (hasControlCharacter(value)) return '/'
  return value
}

function jwksFor(config: WorkosConfig, options: AuthOptions): JwksSource {
  return (
    options.jwks ??
    createJwksSource(jwksUrl(config), { fetchImpl: options.fetchImpl })
  )
}

async function handleLogin(
  request: Request,
  config: WorkosConfig,
): Promise<Response> {
  const url = new URL(request.url)
  const returnTo = safeReturnPath(url.searchParams.get('return_to'))
  const state = randomToken()
  const sealed = await sealLoginState({ state, returnTo }, config.cookiePassword)

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizationUrl(config, state),
      'cache-control': 'no-store',
      'set-cookie': serializeCookie(STATE_COOKIE_NAME, sealed, {
        path: STATE_COOKIE_PATH,
        maxAgeSeconds: STATE_COOKIE_MAX_AGE_SECONDS,
      }),
    },
  })
}

type AuthenticateResponse = {
  access_token?: unknown
  user?: { email?: unknown; email_verified?: unknown } | null
}

function loginFailed(): Response {
  return json({ error: 'login_failed' }, 400, [
    ['set-cookie', clearedCookie(STATE_COOKIE_NAME, STATE_COOKIE_PATH)],
  ])
}

async function handleCallback(
  request: Request,
  env: AuthEnv,
  config: WorkosConfig,
  options: AuthOptions,
): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return loginFailed()

  const sealedState = readCookie(request, STATE_COOKIE_NAME)
  if (!sealedState) return loginFailed()
  const loginState = await unsealLoginState(sealedState, config.cookiePassword)
  if (!loginState || !timingSafeEqual(loginState.state, state)) {
    return loginFailed()
  }

  const fetchImpl = options.fetchImpl ?? fetch
  let payload: AuthenticateResponse
  try {
    const response = await fetchImpl(tokenEndpoint(config), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.apiKey,
        code,
      }),
    })
    if (!response.ok) return loginFailed()
    payload = (await response.json()) as AuthenticateResponse
  } catch {
    return loginFailed()
  }

  const accessToken = payload?.access_token
  if (typeof accessToken !== 'string' || !accessToken) return loginFailed()

  const verified = await verifyAccessToken(accessToken, {
    config,
    jwks: jwksFor(config, options),
    now: options.now,
  })
  if (!verified.ok) return loginFailed()

  const email =
    typeof payload.user?.email === 'string' ? payload.user.email : undefined
  const emailVerified = payload.user?.email_verified === true

  const principal: Principal = {
    provider: WORKOS_PROVIDER,
    issuer: verified.claims.iss,
    subject: verified.claims.sub,
    ...(email ? { email } : {}),
  }

  const db = env.MARGIN_DB
  if (db) {
    const nowIso = new Date(options.now ?? Date.now()).toISOString()
    try {
      await ensureSchema(db)
      const identityId = await recordIdentity(db, principal, nowIso)
      // The one place an email decides anything, and only while there is no
      // admin yet. Afterwards the admin is an `(issuer, subject)` row like any
      // other and this branch can never fire again.
      if (
        identityId !== null &&
        emailVerified &&
        email?.toLowerCase() === config.adminEmail
      ) {
        await bindAdmin(db, identityId, nowIso)
      }
    } catch {
      // Recording the sign-in is not what authorises it. A database hiccup
      // must not deny a session the provider already validated, and the
      // allowlist check on the next write reads the database again anyway.
    }
  }

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  const maxAge = Math.min(
    SESSION_MAX_AGE_SECONDS,
    Math.max(0, verified.claims.exp - nowSeconds),
  )
  const sealedSession = await sealSession(
    {
      accessToken,
      expiresAt: verified.claims.exp,
      ...(email ? { email } : {}),
    },
    config.cookiePassword,
  )

  const headers = new Headers({
    location: loginState.returnTo,
    'cache-control': 'no-store',
  })
  headers.append(
    'set-cookie',
    serializeCookie(SESSION_COOKIE_NAME, sealedSession, {
      path: SESSION_COOKIE_PATH,
      maxAgeSeconds: maxAge,
    }),
  )
  headers.append(
    'set-cookie',
    clearedCookie(STATE_COOKIE_NAME, STATE_COOKIE_PATH),
  )
  return new Response(null, { status: 302, headers })
}

function handleLogout(): Response {
  return json({ ok: true }, 200, [
    ['set-cookie', clearedCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_PATH)],
    ['set-cookie', clearedCookie(STATE_COOKIE_NAME, STATE_COOKIE_PATH)],
  ])
}

async function handleMe(
  request: Request,
  env: AuthEnv,
  options: AuthOptions,
): Promise<Response> {
  const principal = await getPrincipal(request, env, options)
  if (!principal) {
    return json({ authenticated: false, canWrite: false, isAdmin: false })
  }

  let role: string | null = null
  if (env.MARGIN_DB) {
    try {
      role = await allowlistRole(env.MARGIN_DB, principal)
    } catch {
      role = null
    }
  }

  return json({
    authenticated: true,
    principal,
    canWrite: role !== null,
    isAdmin: role === 'admin',
  })
}

/**
 * Routes an `/auth/*` request, or returns `null` when the path is not ours so
 * the Worker entry can fall through to the asset binding unchanged.
 */
export async function handleAuthRequest(
  request: Request,
  env: AuthEnv,
  options: AuthOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const path =
    pathname.length > 1 ? pathname.replace(/\/+$/u, '') || '/' : pathname
  if (!AUTH_PATHS.includes(path)) return null

  const config = readWorkosConfig(env)
  if (!config) {
    // No credentials means no login. Failing closed here is what keeps a
    // half-configured deployment from serving an unauthenticated session.
    return json({ error: 'auth_unavailable' }, 503)
  }

  switch (path) {
    case AUTH_LOGIN_PATH:
      if (request.method !== 'GET') return methodNotAllowed('GET')
      return handleLogin(request, config)
    case AUTH_CALLBACK_PATH:
      if (request.method !== 'GET') return methodNotAllowed('GET')
      return handleCallback(request, env, config, options)
    case AUTH_LOGOUT_PATH:
      // POST only: a `SameSite=Lax` cookie rides along with a cross-site GET
      // navigation, so a GET logout would be forgeable.
      if (request.method !== 'POST') return methodNotAllowed('POST')
      return handleLogout()
    default:
      if (request.method !== 'GET') return methodNotAllowed('GET')
      return handleMe(request, env, options)
  }
}
