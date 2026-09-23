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

type ExchangeResult =
  | { kind: 'success'; payload: AuthenticateResponse }
  | { kind: 'terminal' }
  | { kind: 'retryable' }

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
): Promise<ExchangeResult> {
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
    if (!response.ok) {
      // Only the provider's explicit invalid_grant proves this refresh token
      // cannot recover. A timeout, rate limit, 5xx, or opaque error leaves the
      // sealed cookie available for a later retry.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null
        if (body?.error === 'invalid_grant') return { kind: 'terminal' }
      }
      return { kind: 'retryable' }
    }
    return { kind: 'success', payload: (await response.json()) as AuthenticateResponse }
  } catch {
    return { kind: 'retryable' }
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

  const exchanged = await exchange(config, options, {
    grant_type: 'authorization_code',
    code,
  })
  if (exchanged.kind !== 'success') return loginFailed()
  const payload = exchanged.payload

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
    // Only when the profile names this token's subject. The profile block is not
    // signed, so an email from a response whose `user.id` does not match the
    // signed `sub` is somebody else's address — and it would have been persisted
    // by `recordSignIn`, sealed into the session and returned by `/auth/me`,
    // attaching one account's identity to another's email.
    ...(email && profileIsSubject ? { email } : {}),
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
      ...(principal.email ? { email: principal.email } : {}),
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

/**
 * Whether the browser says this request came from this site.
 *
 * `Sec-Fetch-Site` is the direct answer where it exists; `Origin` is the
 * fallback, and a cross-site form submission always carries one. Absent both,
 * the caller is not a browser, so there is no ambient cookie to abuse.
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin' || site === 'none'
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
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
  kind: 'renewed'
  /** Absent when the exchange succeeded but the new token could not be verified. */
  principal?: Principal
  /** A rotated refresh token must reach the browser even if verification fails. */
  cookie: string
  session: MarginSession
} | {
  kind: 'terminal'
  /** Expire a refresh token the provider has definitively rejected. */
  cookie: string
}

/**
 * Renewals in flight, keyed by the sealed cookie they started from.
 *
 * A page with several requests open sends the same refresh token on each, and the
 * exchange consumes it — so without this the first wins and the rest come back
 * anonymous or 401 while holding a token the provider has already spent. One
 * exchange per session, shared by everybody who asked for it.
 *
 * Per isolate, which is where the requests of one page almost always land. Two
 * isolates racing is a smaller and rarer window, and closing it needs a Durable
 * Object — worth its own issue rather than a guess here.
 */
const renewalsInFlight = new Map<string, Promise<SessionRenewal | null>>()

export async function renewSession(
  request: Request,
  config: WorkosConfig,
  options: AuthOptions,
): Promise<SessionRenewal | null> {
  const sealed = readCookie(request, SESSION_COOKIE_NAME)
  if (!sealed) return null

  const inFlight = renewalsInFlight.get(sealed)
  if (inFlight) return inFlight
  const started = renewOnce(request, config, options, sealed).finally(() => {
    renewalsInFlight.delete(sealed)
  })
  renewalsInFlight.set(sealed, started)
  return started
}

async function renewOnce(
  request: Request,
  config: WorkosConfig,
  options: AuthOptions,
  sealed: string,
): Promise<SessionRenewal | null> {
  const session = await unsealSession(sealed, config.cookiePassword)
  if (!session?.refreshToken) return null

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  const ceiling = session.ceiling ?? session.expiresAt
  if (nowSeconds >= ceiling) return null

  const exchanged = await exchange(config, options, {
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  })
  if (exchanged.kind === 'terminal') {
    return {
      kind: 'terminal',
      cookie: clearedCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_PATH),
    }
  }
  if (exchanged.kind !== 'success') return null
  const payload = exchanged.payload
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
    return { kind: 'renewed', ...(await reseal()), principal: undefined }
  }

  const expiresAt = Math.min(verified.claims.exp, ceiling)
  if (expiresAt <= nowSeconds) return { kind: 'renewed', ...(await reseal()), principal: undefined }

  return {
    kind: 'renewed',
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
      // Return either the rotated token or a terminal expiry even when the
      // principal could not be established.
      renewed = again.cookie
      if (again.kind === 'renewed') {
        session = again.session
        principal = again.principal ?? null
      }
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

  return whoami(env, principal, renewed)
}

/**
 * The `/auth/me` answer for a principal that is already established.
 *
 * Split out because there are two ways to get one: a verified WorkOS session,
 * and the development stub — which needs no WorkOS configuration at all.
 */
async function whoami(
  env: AuthEnv,
  principal: Principal,
  renewed: string | null,
): Promise<Response> {
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
    // And POST alone is not enough. `SameSite=Lax` may stop a cross-site form
    // sending the cookie, but the response's `Set-Cookie` deletes it anyway, so
    // a page anywhere could sign a reader out. A browser always labels the
    // request it is making; a non-browser client sends neither header and is not
    // the threat.
    if (!sameOrigin(request)) {
      return json({ error: 'cross_origin' }, 403)
    }
    return handleLogout()
  }

  const config = readWorkosConfig(env)
  if (!config) {
    // The development stub needs no WorkOS credentials, and the write gate
    // already honours it, so `/auth/me` must be able to report it too —
    // otherwise a local client cannot discover an identity its own writes
    // recognise. Nothing else is answerable without configuration.
    if (path === AUTH_ME_PATH && request.method === 'GET') {
      const stubbed = await getPrincipal(request, env, options)
      if (stubbed) return whoami(env, stubbed, null)
    }
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
