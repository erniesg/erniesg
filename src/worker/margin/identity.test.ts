import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Principal } from '../principal'
import { createFakeD1 } from './fake-workos'
import {
  allowlistRole,
  bindAdmin,
  ensureSchema,
  hasAdmin,
  recordIdentity,
  SCHEMA_STATEMENTS,
} from './identity'

const reader: Principal = {
  provider: 'workos',
  issuer: 'https://api.workos.test',
  subject: 'user_01HREADER',
  email: 'reader@example.test',
}

const writer: Principal = { ...reader, subject: 'user_01HWRITER' }

describe('the identity table', () => {
  it('records a sign-in and is idempotent on (provider, issuer, subject)', async () => {
    const db = createFakeD1()

    const first = await recordIdentity(db, reader, '2026-09-22T00:00:00.000Z')
    const second = await recordIdentity(db, reader, '2026-09-22T01:00:00.000Z')

    expect(first).toBe(second)
    expect(db.identities).toHaveLength(1)
    expect(db.identities[0]).toMatchObject({
      provider: 'workos',
      issuer: 'https://api.workos.test',
      subject: 'user_01HREADER',
      first_seen_at: '2026-09-22T00:00:00.000Z',
      last_seen_at: '2026-09-22T01:00:00.000Z',
    })
  })

  it('treats email as profile data, not as the key', async () => {
    const db = createFakeD1()

    const original = await recordIdentity(db, reader, 'now')
    const renamed = await recordIdentity(
      db,
      { ...reader, email: 'renamed@example.test' },
      'later',
    )

    expect(renamed).toBe(original)
    expect(db.identities).toHaveLength(1)
    expect(db.identities[0]?.email).toBe('renamed@example.test')
  })

  it('keeps a different subject at the same issuer separate', async () => {
    const db = createFakeD1()

    const one = await recordIdentity(db, reader, 'now')
    const other = await recordIdentity(db, writer, 'now')

    expect(one).not.toBe(other)
    expect(db.identities).toHaveLength(2)
  })

  it('keeps the same subject at a different issuer separate', async () => {
    const db = createFakeD1()

    await recordIdentity(db, reader, 'now')
    await recordIdentity(
      db,
      { ...reader, issuer: 'https://api.workos.example' },
      'now',
    )

    expect(db.identities).toHaveLength(2)
  })
})

describe('the allowlist', () => {
  it('says no for an identity with no row', async () => {
    const db = createFakeD1()
    await recordIdentity(db, reader, 'now')

    await expect(allowlistRole(db, reader)).resolves.toBeNull()
  })

  it('says no for an identity it has never seen', async () => {
    await expect(allowlistRole(createFakeD1(), reader)).resolves.toBeNull()
  })

  it('reports the role of an allowlisted identity', async () => {
    const db = createFakeD1()
    db.allow(writer, 'writer')

    await expect(allowlistRole(db, writer)).resolves.toBe('writer')
    await expect(allowlistRole(db, reader)).resolves.toBeNull()
  })
})

describe('the admin binding', () => {
  it('binds exactly once and then stops consulting anything', async () => {
    const db = createFakeD1()
    const identityId = await recordIdentity(db, reader, 'now')

    await expect(hasAdmin(db)).resolves.toBe(false)
    await expect(bindAdmin(db, identityId as number, 'now')).resolves.toBe(true)
    await expect(hasAdmin(db)).resolves.toBe(true)
    await expect(allowlistRole(db, reader)).resolves.toBe('admin')

    const second = await recordIdentity(db, writer, 'now')
    await expect(bindAdmin(db, second as number, 'now')).resolves.toBe(false)
    expect(db.allowlist.filter((row) => row.role === 'admin')).toHaveLength(1)
  })

  it('survives losing the race to the unique index', async () => {
    const db = createFakeD1()
    const first = (await recordIdentity(db, reader, 'now')) as number
    const second = (await recordIdentity(db, writer, 'now')) as number

    const [a, b] = await Promise.all([
      bindAdmin(db, first, 'now'),
      bindAdmin(db, second, 'now'),
    ])

    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(db.allowlist.filter((row) => row.role === 'admin')).toHaveLength(1)
  })
})

describe('the schema', () => {
  it('applies idempotently', async () => {
    const db = createFakeD1()

    await ensureSchema(db)
    await ensureSchema(db)

    expect(db.schemaApplied()).toBe(true)
  })

  it('makes identity unique and allows at most one admin', () => {
    const ddl = SCHEMA_STATEMENTS.join('\n')

    expect(ddl).toContain('UNIQUE (provider, issuer, subject)')
    expect(ddl).toContain("role IN ('writer', 'admin')")
    expect(ddl).toMatch(/CREATE UNIQUE INDEX[^;]*WHERE role = 'admin'/u)
  })

  it('matches schema.sql, which is what a human applies by hand', () => {
    const file = readFileSync(
      resolve(process.cwd(), 'src/worker/margin/schema.sql'),
      'utf8',
    )
    const applied = file
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)

    expect(applied).toEqual(SCHEMA_STATEMENTS.map((sql) => sql.trim()))
  })
})
