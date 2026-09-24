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
import { PROVIDER_FETCH_TIMEOUT_MS, settleWithin } from './deadline'
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
 * before anything is stored, then sealed into the `__Host-margin-session` cookie.
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
  /**
   * Bound on a token exchange, and on how long a request waits for a renewal
   * another request started. Injected so the bound is testable.
   */
  providerTimeoutMs?: number
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
    // Bounded, so a renewal other requests are waiting on cannot hang. A
    // timeout is `retryable`, like any other failure to hear back.
    //
    // A known limit: WorkOS may still complete an exchange this side has
    // abandoned, and rotate the refresh token. The browser then holds a spent
    // token, and the next renewal gets invalid_grant and clears the session.
    // Treating that invalid_grant as retryable would not save the session:
    // the spent token can never be exchanged again, so the user would stay
    // signed out either way, only with a dead cookie kept longer. Recovering
    // it would need WorkOS to offer refresh-token reuse within a grace
    // window, which this code does not rely on.
    const response = await fetchImpl(tokenEndpoint(config), {
      signal: AbortSignal.timeout(options.providerTimeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS),
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
      // cannot recover. A 408 timeout, 429 rate limit, 5xx, network failure,
      // or opaque error leaves the sealed cookie available for a later retry.
      if (
        response.status >= 400 && response.status < 500 &&
        response.status !== 408 && response.status !== 429
      ) {
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

/**
 * Logout clears this browser's cookies. It does not revoke the WorkOS session
 * or its refresh token, so a sealed cookie copied out of the browser keeps
 * working, renewal included, until its sealed ceiling. The guarantee is "this
 * browser", not "this session". Revoking at WorkOS on logout is a follow-up.
 */
async function handleLogout(request: Request): Promise<Response> {
  // Every path back to this session in this isolate ends here too: a grace
  // entry would otherwise hand the session straight back to a replayed old
  // cookie.
  const sealed = readCookie(request, SESSION_COOKIE_NAME)
  if (sealed) await revokeSession(sealed)
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
 * Renewals in flight, keyed by a SHA-256 of the sealed cookie they started from.
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
type RenewalInFlight = {
  promise: Promise<SessionRenewal | null>
  startedAt: number
}

const renewalsInFlight = new Map<string, RenewalInFlight>()

/**
 * How long a finished renewal is handed to requests that still carry the
 * cookie it replaced. A page fires several requests around access-token
 * expiry, and some leave the browser before it applies the rotated
 * `Set-Cookie`. Without this, each of them would exchange the spent refresh
 * token, get invalid_grant, and send back a cookie clear that could sign the
 * user out mid-use. One minute covers that burst.
 */
export const RENEWAL_REUSE_GRACE_MS = 60_000

/** Upper bound on remembered renewals per isolate. The oldest go first. */
export const RENEWAL_REUSE_MAX_ENTRIES = 1_000

/**
 * Finished renewals, keyed by a SHA-256 of the sealed cookie they replaced.
 *
 * Each entry holds the new sealed `Set-Cookie` value, unsealed again on use,
 * its hash, the session ceiling, and the verified principal, which is
 * identity rather than a credential. No token is kept in plaintext, and the
 * old cookie is kept only as a hash.
 *
 * The cost, stated plainly: for up to `RENEWAL_REUSE_GRACE_MS` after a
 * rotation, whoever holds the old sealed cookie, including someone who stole
 * it, can still turn it into the new session. Without this map the old cookie
 * dies as soon as its refresh token is spent. This window is the price of not
 * signing out the owner's own in-flight requests.
 *
 * Logout ends every path back to the session it logs out, in this isolate:
 * see `revokeSession`. All of this is per isolate. An old cookie, or a logout,
 * that lands on another isolate does not see these entries. Closing that needs
 * shared state (a Durable Object keyed by these hashes) or a reuse grace on
 * the WorkOS side.
 */
type RecentRenewal = {
  value: string
  newKey: string
  ceiling: number
  principal?: Principal
  until: number
}

const renewalsRecent = new Map<string, RecentRenewal>()

/**
 * Hashes of sessions logged out in this isolate, for as long as any session
 * can live (`SESSION_MAX_AGE_SECONDS`), within the same size bound. A logged-out
 * cookie never renews here again. A renewal already in flight when its session
 * is logged out is dropped when it finishes, not remembered or handed out.
 */
const revokedSessions = new Map<string, number>()

async function sessionKey(sealed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sealed))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function sweep<T>(map: Map<string, T>, expiry: (entry: T) => number, now: number): void {
  for (const [key, entry] of map) {
    if (expiry(entry) <= now) map.delete(key)
  }
  while (map.size >= RENEWAL_REUSE_MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function isRevoked(key: string): boolean {
  const until = revokedSessions.get(key)
  if (until === undefined) return false
  if (until > Date.now()) return true
  revokedSessions.delete(key)
  return false
}

function sealedValueOf(setCookie: string): string {
  return setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'))
}

async function rememberRenewal(key: string, renewal: SessionRenewal): Promise<void> {
  if (renewal.kind !== 'renewed') return
  const value = sealedValueOf(renewal.cookie)
  const newKey = await sessionKey(value)
  const now = Date.now()
  sweep(renewalsRecent, (entry) => entry.until, now)
  renewalsRecent.set(key, {
    value,
    newKey,
    ceiling: renewal.session.ceiling ?? renewal.session.expiresAt,
    ...(renewal.principal ? { principal: renewal.principal } : {}),
    until: now + RENEWAL_REUSE_GRACE_MS,
  })
}

async function recentRenewal(
  key: string,
  config: WorkosConfig,
  nowMs: number,
): Promise<SessionRenewal | null> {
  const entry = renewalsRecent.get(key)
  if (!entry) return null
  if (entry.until <= Date.now()) {
    renewalsRecent.delete(key)
    return null
  }
  // Never past the session's own ceiling, whenever in the window it is replayed.
  const remaining = entry.ceiling - Math.floor(nowMs / 1000)
  if (remaining <= 0) return null
  const session = await unsealSession(entry.value, config.cookiePassword)
  if (!session) return null
  return {
    kind: 'renewed',
    cookie: serializeCookie(SESSION_COOKIE_NAME, entry.value, {
      path: SESSION_COOKIE_PATH,
      maxAgeSeconds: remaining,
    }),
    session,
    principal: entry.principal,
  }
}

/**
 * Ends every path back to a session in this isolate.
 *
 * Starting from the cookie being logged out, this follows grace entries in
 * both directions: from an old cookie to the cookie it was renewed into, and
 * from a new cookie back to the one it replaced, across whole chains. Every
 * entry it touches is removed, and every cookie it reaches is marked revoked,
 * so a renewal still in flight for any of them is dropped when it finishes.
 */
async function revokeSession(sealed: string): Promise<void> {
  const reached = new Set([await sessionKey(sealed)])
  let grew = true
  while (grew) {
    grew = false
    for (const [key, entry] of renewalsRecent) {
      if (reached.has(key) || reached.has(entry.newKey)) {
        for (const one of [key, entry.newKey]) {
          if (!reached.has(one)) {
            reached.add(one)
            grew = true
          }
        }
      }
    }
  }
  for (const [key, entry] of renewalsRecent) {
    if (reached.has(key) || reached.has(entry.newKey)) renewalsRecent.delete(key)
  }
  const now = Date.now()
  sweep(revokedSessions, (until) => until, now)
  for (const key of reached) {
    revokedSessions.set(key, now + SESSION_MAX_AGE_SECONDS * 1000)
  }
}

/**
 * The time budget of one renewal, from the real timeouts it runs under.
 *
 * - `verifyBy`: the exchange (aborted at `providerTimeoutMs`), plus the
 *   longest key-set refresh chain verification can run (`jwks.worstCaseMs`).
 *   The originator stops waiting for verification at this point, whatever
 *   state it is in.
 * - `slot`: `verifyBy` plus one more `providerTimeoutMs` for sealing the
 *   result. The originator always settles before this. A slot older than it
 *   can only belong to a request cancelled before its `finally` ran, and that
 *   is the only time another request may replace it.
 */
export function renewalBounds(
  providerTimeoutMs: number,
  jwks: JwksSource,
): { verifyBy: number; slot: number } {
  const verifyBy = providerTimeoutMs + jwks.worstCaseMs
  return { verifyBy, slot: verifyBy + providerTimeoutMs }
}

export async function renewSession(
  request: Request,
  config: WorkosConfig,
  options: AuthOptions,
): Promise<SessionRenewal | null> {
  const sealed = readCookie(request, SESSION_COOKIE_NAME)
  if (!sealed) return null
  const key = await sessionKey(sealed)
  // Logged out in this isolate: no path leads back to it.
  if (isRevoked(key)) return null

  // Already renewed moments ago from this very cookie: hand back the same
  // new session instead of exchanging a refresh token that is now spent.
  const recent = await recentRenewal(key, config, options.now ?? Date.now())
  if (recent) return recent

  const providerTimeoutMs = options.providerTimeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS
  const bounds = renewalBounds(providerTimeoutMs, jwksFor(config, options))
  const inFlight = renewalsInFlight.get(key)
  // Only the request that started a renewal frees its slot, in `finally`. The
  // one exception is an entry older than the originator's worst case: every
  // part of that renewal has been aborted by then, so it can only be one whose
  // request was cancelled before its `finally` could run.
  if (inFlight && Date.now() - inFlight.startedAt < bounds.slot) {
    // Waited for on this request's own timer, never for as long as the request
    // that started it lives. A waiter that runs out of time goes unrenewed for
    // this one request and keeps its cookie. It leaves the slot alone and
    // never exchanges itself: the refresh token is single-use, so a second
    // exchange racing a slow but healthy first one could be answered with
    // invalid_grant and sign the user out.
    const waited = await settleWithin(inFlight.promise, providerTimeoutMs)
    return waited.settled ? waited.value : null
  }

  // A renewal that throws is an unrenewed request, never a 500: callers read
  // `null` as "no fresh session" and answer anonymously or with a 401. The
  // failure is still logged, by error class only, so a persistent throw does
  // not pass for "not renewed" forever. The message is not logged, because a
  // provider or crypto error could carry token material.
  const startedAt = Date.now()
  const promise: Promise<SessionRenewal | null> = renewOnce(
    request,
    config,
    options,
    sealed,
    startedAt + bounds.verifyBy,
  )
    .catch((error: unknown) => {
      console.error(
        `[margin] session renewal failed: ${error instanceof Error ? error.name : typeof error}`,
      )
      return null
    })
    .then(async (result) => {
      // Logged out while this was running: hand nothing back and keep
      // nothing, so the logout is not undone by a renewal that finished late.
      if (isRevoked(key)) return null
      // Kept only when renewed. A failed or terminal renewal is forgotten at
      // once, so the next request can retry.
      if (result) await rememberRenewal(key, result)
      return result
    })
    .finally(() => {
      if (renewalsInFlight.get(key)?.promise === promise) {
        renewalsInFlight.delete(key)
      }
    })
  renewalsInFlight.set(key, { promise, startedAt })
  return promise
}

async function renewOnce(
  request: Request,
  config: WorkosConfig,
  options: AuthOptions,
  sealed: string,
  verifyBy: number,
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

  // Verification runs against the renewal's own deadline. A key-set refresh
  // chain during a rotation can outlast it, and until this settles the slot is
  // held and the rotated refresh token has not reached the browser. On overrun
  // it is treated like a verification failure: the rotated token still goes
  // back, and this request is unauthenticated.
  const verification = await settleWithin(
    verifyAccessToken(accessToken, {
      config,
      jwks: jwksFor(config, options),
      now: options.now,
    }),
    Math.max(0, verifyBy - Date.now()),
  )
  const verified = verification.settled
    ? verification.value
    : ({ ok: false, reason: 'jwks-unavailable' } as const)
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
    return handleLogout(request)
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
