import type { WorkerEnv } from '../env'
import {
  getPrincipal,
  sharedJwksSource,
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
import { verifyAccessToken, type JwksSource } from './jwt'
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
  unsealSession,
  type MarginSession,
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
  // The same per-isolate cache `getPrincipal` reads. A second cache would mean a
  // second TTL and a second outage window over one key set, so a refresh could
  // fail on a cold cache while verification on the warm one is fine.
  return options.jwks ?? sharedJwksSource(config, options.fetchImpl)
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
  refresh_token?: unknown
  user?: { id?: unknown; email?: unknown; email_verified?: unknown } | null
}

function loginFailed(): Response {
  return json({ error: 'login_failed' }, 400, [
    ['set-cookie', clearedCookie(STATE_COOKIE_NAME, STATE_COOKIE_PATH)],
  ])
}

/**
 * Writes the identity row, and binds the admin if this is the moment for it.
 *
 * Idempotent, and called from the callback *and* from `/auth/me`. A database
 * outage during the callback used to leave a valid session with no identity row
 * at all: the documented out-of-band allowlist insert selects on that row, so
 * the person could not be allowlisted — and the owner could not be bound as
 * admin — until they happened to sign in again, with nothing telling them so.
 * Retrying on a later authenticated request is what makes that recoverable.
 *
 * A failure here is swallowed on purpose. Recording a sign-in is not what
 * authorises it, a database hiccup must not deny a session the provider already
 * validated, and the allowlist check on the next write reads the database again.
 */
async function recordSignIn(
  env: AuthEnv,
  principal: Principal,
  owner: { email?: string; emailVerified: boolean; adminEmail: string },
  options: AuthOptions,
): Promise<void> {
  const db = env.MARGIN_DB
  if (!db) return
  const nowIso = new Date(options.now ?? Date.now()).toISOString()
  try {
    await ensureSchema(db)
    const identityId = await recordIdentity(db, principal, nowIso)
    // The one place an email decides anything, and only while there is no admin
    // yet. Afterwards the admin is an `(issuer, subject)` row like any other and
    // this branch can never fire again.
    if (
      identityId !== null &&
      owner.emailVerified &&
      owner.email?.toLowerCase() === owner.adminEmail
    ) {
      await bindAdmin(db, identityId, nowIso)
    }
  } catch {
    // Deliberately quiet; see above.
  }
}

/**
 * One POST to `/user_management/authenticate`, for both grants.
 *
 * WorkOS authenticates this endpoint with `client_id` and `client_secret` in
 * the request body — the API key is the client secret here, not a bearer
 * token — so the grant is the only thing that differs between the login
 * exchange and a refresh.
 */
async function exchange(
  config: WorkosConfig,
  options: AuthOptions,
  grant: Record<string, string>,
): Promise<AuthenticateResponse | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(tokenEndpoint(config), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.apiKey,
        ...grant,
      }),
    })
    if (!response.ok) return null
    return (await response.json()) as AuthenticateResponse
  } catch {
    return null
  }
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

  const payload = await exchange(config, options, {
    grant_type: 'authorization_code',
    code,
  })
  if (!payload) return loginFailed()

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
  // The profile block is not signed; the token is. So the profile only speaks
  // for this session if it names the same subject the token was issued for.
  // Without that, a provider response carrying somebody else's `sub` beside
  // the owner's verified address would hand the admin row to that subject.
  const profileIsSubject =
    typeof payload.user?.id === 'string' &&
    payload.user.id === verified.claims.sub

  const principal: Principal = {
    provider: WORKOS_PROVIDER,
    issuer: verified.claims.iss,
    subject: verified.claims.sub,
    ...(email ? { email } : {}),
  }

  await recordSignIn(
    env,
    principal,
    { email, emailVerified: emailVerified && profileIsSubject, adminEmail: config.adminEmail },
    options,
  )

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  const maxAge = Math.min(
    SESSION_MAX_AGE_SECONDS,
    Math.max(0, verified.claims.exp - nowSeconds),
  )
  const refreshToken =
    typeof payload.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : undefined
  // Sealed so a later request can finish what a database outage interrupted.
  // Only true when the profile was verified *and* named this token's subject,
  // which is the same pair of conditions the binding below requires.
  const ownerEmailVerified = emailVerified && profileIsSubject
  const ceiling = nowSeconds + SESSION_MAX_AGE_SECONDS
  const sealedSession = await sealSession(
    {
      accessToken,
      // Both bounds go inside the seal, not only on `Max-Age`. A cookie copied
      // out of the browser is still a bearer token, and a cookie jar is not
      // where a session limit can be enforced. `ceiling` is fixed here and a
      // refresh may not move it.
      expiresAt: nowSeconds + maxAge,
      ceiling,
      ...(refreshToken ? { refreshToken } : {}),
      ...(email ? { email } : {}),
      ...(ownerEmailVerified ? { emailVerified: true } : {}),
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
      // To the ceiling, not to the access token's expiry. The cookie carries
      // the refresh token, so sizing it to the short-lived access token would
      // have a conforming browser throw the refresh token away at the moment it
      // becomes the only thing that can renew the session. What bounds the
      // access token is `expiresAt` inside the seal, which the server checks.
      maxAgeSeconds: ceiling - nowSeconds,
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

/**
 * Trades the sealed refresh token for a live access token.
 *
 * WorkOS access tokens are short-lived by design, so without this a sign-in
 * would last minutes rather than the eight hours the cookie claims. It returns
 * the new sealed cookie rather than applying it, because only a route with a
 * response in hand can set one — `getPrincipal` has no response.
 *
 * `ceiling` is copied, never recomputed: refreshing must not extend the
 * session past the bound login fixed for it.
 */
export type SessionRenewal = {
  /** Absent when the exchange succeeded but the new token could not be verified. */
  principal?: Principal
  /** Always present: a rotated refresh token must reach the browser either way. */
  cookie: string
  session: MarginSession
}

export async function renewSession(
  request: Request,
  config: WorkosConfig,
  options: AuthOptions,
): Promise<SessionRenewal | null> {
  const sealed = readCookie(request, SESSION_COOKIE_NAME)
  if (!sealed) return null
  const session = await unsealSession(sealed, config.cookiePassword)
  if (!session?.refreshToken) return null

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  const ceiling = session.ceiling ?? session.expiresAt
  if (nowSeconds >= ceiling) return null

  const payload = await exchange(config, options, {
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  })
  const accessToken = payload?.access_token
  if (typeof accessToken !== 'string' || !accessToken) return null

  // The exchange has consumed the old refresh token by now, and WorkOS may have
  // rotated it. Whatever happens next, the browser must end up holding the token
  // that is still valid — otherwise a transient JWKS outage between here and the
  // verification below turns into a permanent logout, because the browser would
  // keep a token the provider has already spent.
  const nextRefresh =
    typeof payload.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : session.refreshToken

  const reseal = async (
    next: Partial<MarginSession> = {},
  ): Promise<{ cookie: string; session: MarginSession }> => {
    const merged: MarginSession = {
      ...session,
      refreshToken: nextRefresh,
      ceiling,
      ...next,
    }
    return {
      session: merged,
      cookie: serializeCookie(
        SESSION_COOKIE_NAME,
        await sealSession(merged, config.cookiePassword),
        // Again to the ceiling: this cookie still carries the refresh token.
        { path: SESSION_COOKIE_PATH, maxAgeSeconds: ceiling - nowSeconds },
      ),
    }
  }

  const verified = await verifyAccessToken(accessToken, {
    config,
    jwks: jwksFor(config, options),
    now: options.now,
  })
  if (!verified.ok) {
    // Not authenticated, but the rotated token still goes back. `expiresAt` is
    // left where it was, so this cookie authorises nothing on its own.
    return { ...(await reseal()), principal: undefined }
  }

  const expiresAt = Math.min(verified.claims.exp, ceiling)
  if (expiresAt <= nowSeconds) return { ...(await reseal()), principal: undefined }

  return {
    ...(await reseal({ accessToken, expiresAt })),
    principal: {
      provider: WORKOS_PROVIDER,
      issuer: verified.claims.iss,
      subject: verified.claims.sub,
      ...(session.email ? { email: session.email } : {}),
    },
  }
}

async function handleMe(
  request: Request,
  env: AuthEnv,
  config: WorkosConfig,
  options: AuthOptions,
): Promise<Response> {
  let principal = await getPrincipal(request, env, options)
  // A route a client polls, and one holding a response it can set a cookie on,
  // so it is a place a lapsed access token gets renewed.
  let renewed: string | null = null
  let session: MarginSession | null = null
  if (!principal) {
    const again = await renewSession(request, config, options)
    if (again) {
      // The cookie comes back even when the principal does not: the refresh
      // token may have rotated, and the browser has to end up with the live one.
      renewed = again.cookie
      session = again.session
      principal = again.principal ?? null
    }
  }
  if (!principal) {
    return json(
      { authenticated: false, canWrite: false, isAdmin: false },
      200,
      renewed ? [['set-cookie', renewed]] : [],
    )
  }
  if (!session) {
    const sealed = readCookie(request, SESSION_COOKIE_NAME)
    session = sealed
      ? await unsealSession(sealed, config.cookiePassword)
      : null
  }

  // A database outage during the callback leaves a valid session with no
  // identity row, and the documented out-of-band allowlist insert has nothing to
  // select. Finishing it here makes that recoverable without signing out and in
  // again — and picks up the admin bootstrap the same callback skipped.
  await recordSignIn(
    env,
    principal,
    {
      ...(session?.email ? { email: session.email } : {}),
      // Sealed at login only when the profile was verified and named this
      // token's subject, so it is as trustworthy here as it was there.
      emailVerified: session?.emailVerified === true,
      adminEmail: config.adminEmail,
    },
    options,
  )

  let role: string | null = null
  if (env.MARGIN_DB) {
    try {
      role = await allowlistRole(env.MARGIN_DB, principal)
    } catch {
      role = null
    }
  }

  return json(
    {
      authenticated: true,
      principal,
      canWrite: role !== null,
      isAdmin: role === 'admin',
    },
    200,
    renewed ? [['set-cookie', renewed]] : [],
  )
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

  // Logout is answered before the configuration gate. Clearing a cookie needs
  // no provider, and a half-configured or mid-rotation deployment is exactly
  // when somebody wants to get signed out — a 503 there would leave the
  // session cookie in place with no way to remove it.
  if (path === AUTH_LOGOUT_PATH) {
    // POST only: a `SameSite=Lax` cookie rides along with a cross-site GET
    // navigation, so a GET logout would be forgeable.
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return handleLogout()
  }

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
    default:
      if (request.method !== 'GET') return methodNotAllowed('GET')
      return handleMe(request, env, config, options)
  }
}
