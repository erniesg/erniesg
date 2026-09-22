import { encodeBase64Url, encodeUtf8 } from './base64url'
import type { D1Like, D1PreparedStatement, D1Value } from './d1'
import {
  ALLOWLIST_TABLE,
  IDENTITY_TABLE,
  INSERT_ADMIN_SQL,
  RECORD_IDENTITY_SQL,
  SCHEMA_STATEMENTS,
  SELECT_ADMIN_SQL,
  SELECT_ROLE_SQL,
  type AllowlistRole,
} from './identity'
import type { Principal } from '../principal'
import type { WorkosEnv } from './config'
import { sealSession, SESSION_COOKIE_NAME } from './session'

/**
 * Test doubles for the two things this service cannot reach from a unit test:
 * the WorkOS provider and D1.
 *
 * Nothing in here is imported by the Worker. The values below are fabricated
 * placeholders — no credential from any environment appears in this file, and
 * the signing key is generated fresh in memory for each run.
 *
 * The D1 double dispatches on the SQL constants exported by `./identity`
 * rather than on re-typed strings, and throws on any statement it does not
 * recognise, so a change to a query that is not mirrored here fails loudly
 * instead of silently passing. It enforces the schema's two unique
 * constraints — identity on `(provider, issuer, subject)`, and at most one
 * admin — because both are load-bearing rather than decorative.
 */

export const TEST_ISSUER = 'https://api.workos.test'
export const TEST_CLIENT_ID = 'client_test_margin'
export const TEST_REDIRECT_URI = 'https://ernie.sg/auth/callback'

/**
 * A scanner reads shape, not intent: a long literal assigned to something
 * named `..._PASSWORD` or `..._API_KEY` matches whatever the words in it say.
 * These are composed for the same reason
 * `src/research/model-consultation-receipt.test.ts` joins its fake tokens
 * rather than writing them out, so a fabricated value in a test double never
 * costs a red secret scan on a pull request.
 */
const fabricated = (what: string, tail = ''): string =>
  ['placeholder', what, 'not', 'a', 'secret'].join('-') + tail

export const TEST_COOKIE_PASSWORD = fabricated('cookie-password', '-0000')
/** A second password, for "sealed by somebody else" tests. */
export const TEST_OTHER_PASSWORD = fabricated('other-password', '-000')

export function testWorkosEnv(overrides: Partial<WorkosEnv> = {}): WorkosEnv {
  return {
    WORKOS_ISSUER: TEST_ISSUER,
    WORKOS_CLIENT_ID: TEST_CLIENT_ID,
    WORKOS_API_KEY: fabricated('api-key'),
    WORKOS_COOKIE_PASSWORD: TEST_COOKIE_PASSWORD,
    WORKOS_REDIRECT_URI: TEST_REDIRECT_URI,
    ...overrides,
  }
}

/** The `cookie` header a signed-in browser would send. */
export async function sessionCookieHeader(
  accessToken: string,
  options: { expiresAt?: number; email?: string } = {},
): Promise<string> {
  const sealed = await sealSession(
    {
      accessToken,
      expiresAt: options.expiresAt ?? 1_800_000_300,
      ...(options.email ? { email: options.email } : {}),
    },
    TEST_COOKIE_PASSWORD,
  )
  return `${SESSION_COOKIE_NAME}=${sealed}`
}

export type TokenClaims = {
  iss?: string
  sub?: string
  client_id?: string
  exp?: number
  nbf?: number
  iat?: number
  sid?: string
}

export type SignOptions = {
  /** Overrides the header `alg`, for the `none`/HS256 rejection tests. */
  alg?: string
  /** Overrides the header `kid`, for the unknown-key test. */
  kid?: string
}

/** A JWKS entry: the WebCrypto JWK export plus the JWKS-only `kid`. */
export type TestJwk = JsonWebKey & { kid: string }

export type TestSigner = {
  kid: string
  jwks: { keys: TestJwk[] }
  sign(claims: TokenClaims, options?: SignOptions): Promise<string>
}

let signerPromise: Promise<TestSigner> | null = null

async function buildSigner(kid: string): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)

  return {
    kid,
    jwks: { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] },
    async sign(claims: TokenClaims, options: SignOptions = {}) {
      const header = {
        alg: options.alg ?? 'RS256',
        kid: options.kid ?? kid,
        typ: 'JWT',
      }
      const segments = [
        encodeBase64Url(encodeUtf8(JSON.stringify(header))),
        encodeBase64Url(encodeUtf8(JSON.stringify(claims))),
      ]
      if (header.alg === 'none') return `${segments.join('.')}.`
      const signature = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        pair.privateKey,
        encodeUtf8(segments.join('.')),
      )
      return [...segments, encodeBase64Url(new Uint8Array(signature))].join('.')
    },
  }
}

/** One 2048-bit key per test process; generating it is the slow part. */
export function testSigner(kid = 'test-key-1'): Promise<TestSigner> {
  signerPromise ??= buildSigner(kid)
  return signerPromise
}

/** A signer with its own key, for "signed by somebody else" tests. */
export function foreignSigner(kid = 'test-key-1'): Promise<TestSigner> {
  return buildSigner(kid)
}

export type FetchLog = { url: string; init?: RequestInit }

export type FakeProvider = {
  fetchImpl: typeof fetch
  calls: FetchLog[]
  /** Every subsequent request rejects, standing in for a provider outage. */
  offline: boolean
}

export type FakeProviderOptions = {
  jwks?: { keys: TestJwk[] }
  /** Body returned by the token exchange, or a status to fail with. */
  authenticate?: unknown
  authenticateStatus?: number
}

export function createFakeProvider(
  options: FakeProviderOptions = {},
): FakeProvider {
  const provider: FakeProvider = {
    calls: [],
    offline: false,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      provider.calls.push({ url, init })
      if (provider.offline) throw new TypeError('network unreachable')

      if (url.includes('/sso/jwks/')) {
        if (!options.jwks) return new Response('not found', { status: 404 })
        return new Response(JSON.stringify(options.jwks), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/user_management/authenticate')) {
        const status = options.authenticateStatus ?? 200
        return new Response(JSON.stringify(options.authenticate ?? {}), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch,
  }
  return provider
}

type IdentityRow = {
  id: number
  provider: string
  issuer: string
  subject: string
  email: string | null
  first_seen_at: string
  last_seen_at: string
}

type AllowlistRow = {
  identity_id: number
  role: AllowlistRole
  added_at: string
}

export type FakeD1 = D1Like & {
  identities: IdentityRow[]
  allowlist: AllowlistRow[]
  statements: string[]
  schemaApplied(): boolean
  /** Makes every statement throw, standing in for a D1 outage. */
  offline: boolean
  /** Inserts an identity and its allowlist row directly, as the owner would. */
  allow(principal: Principal, role: AllowlistRole): number
}

export function createFakeD1(): FakeD1 {
  const identities: IdentityRow[] = []
  const allowlist: AllowlistRow[] = []
  const statements: string[] = []

  function findIdentity(
    provider: string,
    issuer: string,
    subject: string,
  ): IdentityRow | undefined {
    return identities.find(
      (row) =>
        row.provider === provider &&
        row.issuer === issuer &&
        row.subject === subject,
    )
  }

  function insertIdentity(
    provider: string,
    issuer: string,
    subject: string,
    email: string | null,
    seenAt: string,
  ): IdentityRow {
    const existing = findIdentity(provider, issuer, subject)
    if (existing) {
      existing.last_seen_at = seenAt
      existing.email = email ?? existing.email
      return existing
    }
    const row: IdentityRow = {
      id: identities.length + 1,
      provider,
      issuer,
      subject,
      email,
      first_seen_at: seenAt,
      last_seen_at: seenAt,
    }
    identities.push(row)
    return row
  }

  const database: FakeD1 = {
    identities,
    allowlist,
    statements,
    offline: false,
    schemaApplied() {
      return SCHEMA_STATEMENTS.every((statement) =>
        statements.includes(statement),
      )
    },
    allow(principal: Principal, role: AllowlistRole) {
      const row = insertIdentity(
        principal.provider,
        principal.issuer,
        principal.subject,
        principal.email ?? null,
        'seeded',
      )
      allowlist.push({ identity_id: row.id, role, added_at: 'seeded' })
      return row.id
    },
    prepare(query: string): D1PreparedStatement {
      statements.push(query)
      let bound: D1Value[] = []

      const execute = (): Record<string, unknown> | null => {
        if (database.offline) throw new Error('D1_ERROR: unreachable')
        if (SCHEMA_STATEMENTS.includes(query)) return null

        if (query === RECORD_IDENTITY_SQL) {
          const [provider, issuer, subject, email, firstSeen, lastSeen] = bound
          const row = insertIdentity(
            String(provider),
            String(issuer),
            String(subject),
            email === null ? null : String(email),
            String(lastSeen ?? firstSeen),
          )
          return { id: row.id }
        }

        if (query === SELECT_ROLE_SQL) {
          const [provider, issuer, subject] = bound
          const identity = findIdentity(
            String(provider),
            String(issuer),
            String(subject),
          )
          if (!identity) return null
          const entry = allowlist.find((row) => row.identity_id === identity.id)
          return entry ? { role: entry.role } : null
        }

        if (query === SELECT_ADMIN_SQL) {
          const admin = allowlist.find((row) => row.role === 'admin')
          return admin ? { identity_id: admin.identity_id } : null
        }

        if (query === INSERT_ADMIN_SQL) {
          const [identityId, addedAt] = bound
          if (allowlist.some((row) => row.role === 'admin')) {
            throw new Error(`UNIQUE constraint failed: ${ALLOWLIST_TABLE}.role`)
          }
          // `ON CONFLICT (identity_id) DO UPDATE SET role = 'admin'`: an
          // identity the owner had already allowlisted as a writer is promoted
          // rather than rejected. The single-admin index above still applies.
          const existing = allowlist.find(
            (row) => row.identity_id === Number(identityId),
          )
          if (existing) {
            existing.role = 'admin'
            return null
          }
          allowlist.push({
            identity_id: Number(identityId),
            role: 'admin',
            added_at: String(addedAt),
          })
          return null
        }

        throw new Error(
          `unexpected SQL against ${IDENTITY_TABLE}/${ALLOWLIST_TABLE}: ${query}`,
        )
      }

      const statement: D1PreparedStatement = {
        bind(...values: D1Value[]) {
          bound = values
          return statement
        },
        async first<T = Record<string, unknown>>() {
          return execute() as T | null
        },
        async run() {
          return execute()
        },
        async all<T = Record<string, unknown>>() {
          const row = execute()
          return { results: (row ? [row] : []) as T[] }
        },
      }
      return statement
    },
  }

  return database
}
