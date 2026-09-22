import type { Principal } from '../principal'
import type { D1Like } from './d1'

/**
 * The identity and allowlist tables.
 *
 * Identity is `(provider, issuer, subject)` and the schema says so with a
 * unique constraint, so recording a sign-in is idempotent by construction
 * rather than by convention. `email` is a nullable profile column that is
 * never read as a key — the one place an email is consulted at all is the
 * single admin bootstrap in `bindAdmin`, and only while no admin exists.
 *
 * The allowlist is the security boundary for writing. A row here, and only a
 * row here, is what separates "has a Berlayar account" from "can write on the
 * book". There is no self-service path to one: rows are added out of band with
 * `wrangler d1 execute`, which is the whole point of shipping without a
 * moderation surface.
 *
 * The SQL below is exported so the test double dispatches on the same strings
 * the Worker sends, and `schema.sql` carries the identical DDL for anyone
 * applying it by hand.
 */

export const IDENTITY_TABLE = 'margin_identity'
export const ALLOWLIST_TABLE = 'margin_allowlist'

export type AllowlistRole = 'admin' | 'writer'

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${IDENTITY_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (provider, issuer, subject)
)`,
  `CREATE TABLE IF NOT EXISTS ${ALLOWLIST_TABLE} (
  identity_id INTEGER PRIMARY KEY REFERENCES ${IDENTITY_TABLE}(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('writer', 'admin')),
  added_at TEXT NOT NULL
)`,
  // At most one admin, enforced by the database rather than by a read-then-write
  // race in the callback handler.
  `CREATE UNIQUE INDEX IF NOT EXISTS ${ALLOWLIST_TABLE}_single_admin
  ON ${ALLOWLIST_TABLE} (role) WHERE role = 'admin'`,
]

export const RECORD_IDENTITY_SQL = `INSERT INTO ${IDENTITY_TABLE}
  (provider, issuer, subject, email, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (provider, issuer, subject) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    email = COALESCE(excluded.email, ${IDENTITY_TABLE}.email)
  RETURNING id`

export const SELECT_ROLE_SQL = `SELECT allowlist.role AS role
  FROM ${ALLOWLIST_TABLE} AS allowlist
  JOIN ${IDENTITY_TABLE} AS identity ON identity.id = allowlist.identity_id
  WHERE identity.provider = ? AND identity.issuer = ? AND identity.subject = ?
  LIMIT 1`

export const SELECT_ADMIN_SQL = `SELECT identity_id AS identity_id
  FROM ${ALLOWLIST_TABLE} WHERE role = 'admin' LIMIT 1`

export const INSERT_ADMIN_SQL = `INSERT INTO ${ALLOWLIST_TABLE}
  (identity_id, role, added_at) VALUES (?, 'admin', ?)`

export async function ensureSchema(db: D1Like): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.prepare(statement).run()
  }
}

/**
 * Records a sign-in and returns the identity row id.
 *
 * Idempotent: the same `(provider, issuer, subject)` always resolves to the
 * same row, whatever the email on the profile has become since.
 */
export async function recordIdentity(
  db: D1Like,
  principal: Principal,
  nowIso: string,
): Promise<number | null> {
  const row = await db
    .prepare(RECORD_IDENTITY_SQL)
    .bind(
      principal.provider,
      principal.issuer,
      principal.subject,
      principal.email ?? null,
      nowIso,
      nowIso,
    )
    .first<{ id: number }>()
  return typeof row?.id === 'number' ? row.id : null
}

/** `null` means "not on the allowlist", which means "may not write". */
export async function allowlistRole(
  db: D1Like,
  principal: Principal,
): Promise<AllowlistRole | null> {
  const row = await db
    .prepare(SELECT_ROLE_SQL)
    .bind(principal.provider, principal.issuer, principal.subject)
    .first<{ role: string }>()
  if (row?.role === 'admin' || row?.role === 'writer') return row.role
  return null
}

export async function hasAdmin(db: D1Like): Promise<boolean> {
  const row = await db.prepare(SELECT_ADMIN_SQL).first<{
    identity_id: number
  }>()
  return row !== null && row !== undefined
}

/**
 * Binds the one admin, once.
 *
 * This is the single place in the service where an email address decides
 * anything, and it only decides it while `margin_allowlist` holds no admin
 * row. Afterwards the admin is `(provider, issuer, subject)` like everybody
 * else, and changing the email on the WorkOS profile changes nothing here.
 */
export async function bindAdmin(
  db: D1Like,
  identityId: number,
  nowIso: string,
): Promise<boolean> {
  if (await hasAdmin(db)) return false
  try {
    await db.prepare(INSERT_ADMIN_SQL).bind(identityId, nowIso).run()
    return true
  } catch {
    // The unique index lost a race. Somebody else is the admin; that is fine.
    return false
  }
}
