import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import worker from '../index'
import type { Principal } from '../principal'
import type { D1Database } from './d1'
import { ADA, BOB, createHarness, scopeQuery, webAnnotation, type MarginHarness } from './fixtures'
import { ensureSchema, SCHEMA_STATEMENTS } from './identity'
import { applyMigrations } from './sqlite-database'
import { listReviewProposalsQuery } from './queries'

const SITE = 'https://ernie.sg'
const OTHER_SITE = 'https://berlayar.ai'
const DOCUMENT = '/books/chapter/?edition=one#passage'
const SOURCE = SITE + DOCUMENT
const NOW = '2026-10-07T00:00:00.000Z'
type Wire = { id: string; target: { source: string }; creator: string; 'margin:visibility': string }
type Page = { annotations: Wire[]; nextCursor?: string }
let harness: MarginHarness

beforeEach(() => {
  harness = createHarness({ identitySchema: false })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network is outside this fixture')))
})
afterEach(() => vi.unstubAllGlobals())

async function grant(principal = ADA, role = 'admin', sites = [SITE]): Promise<number> {
  await ensureSchema(harness.database)
  expect(harness.database.query("SELECT name FROM sqlite_master WHERE name = 'margin_site_admins'")).toHaveLength(1)
  harness.database.execute('INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
    [principal.provider, principal.issuer, principal.subject, NOW, NOW])
  const id = harness.database.query('SELECT id FROM margin_identity WHERE provider=? AND issuer=? AND subject=?',
    [principal.provider, principal.issuer, principal.subject])[0].id as number
  harness.database.execute('INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,?,?)', [id, role, NOW])
  for (const site of sites) harness.database.execute('INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)', [site, id])
  return id
}

async function post(source = SOURCE, motivation: 'editing' | 'commenting' = 'editing', visibility: 'private' | 'public' = 'private') {
  const response = await harness.request('POST', '/annotations', {
    as: BOB, body: webAnnotation({ source, motivation, visibility }),
  })
  expect(response.status).toBe(201)
  return await response.json() as Wire
}

function review(params: Record<string, string> = {}) {
  return '/proposals?' + new URLSearchParams({ scope: 'review', ...params })
}

async function page(params: Record<string, string> = {}): Promise<Page> {
  const response = await harness.request('GET', review(params))
  expect(response.status).toBe(200)
  return await response.json() as Page
}

function workerRequest(database: D1Database, params: Record<string, string> = {}, principal: Principal = ADA) {
  return worker.fetch(new Request('http://localhost/api/margin/v1' + review(params)), {
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    MARGIN_DB: database, MARGIN_ENVIRONMENT: 'development', MARGIN_DEV_PRINCIPAL: JSON.stringify(principal),
  })
}

describe('site-admin read-only proposal review', () => {
  it('mapped global admin reads another creator pending proposals only in review scope', async () => {
    await grant()
    const privateRow = await post()
    const publicRow = await post(SITE + '/elsewhere/', 'editing', 'public')
    await post(SOURCE, 'commenting')
    expect((await page()).annotations.map(row => row.id)).toEqual([privateRow.id, publicRow.id])
    for (const collection of ['annotations', 'proposals']) {
      const ordinary = await harness.request('GET', '/' + collection + scopeQuery(SOURCE))
      expect((await ordinary.json()).annotations).toEqual([])
    }
    const own = await harness.request('GET', '/mine?' + new URLSearchParams({ site: SITE, prefix: '/' }))
    expect((await own.json()).annotations).toEqual([])
    const last = harness.database.executed.at(-1)!
    expect(last.sql).toContain('creator = ?')
  })

  it('requires authenticated stored global admin plus explicit site mapping', async () => {
    expect((await harness.request('GET', review(), { as: null })).status).toBe(401)
    await ensureSchema(harness.database)
    expect((await harness.request('GET', review())).status).toBe(403)
    await grant(ADA, 'admin', [])
    expect((await harness.request('GET', review({ site: SITE, identity_id: '1', isAdmin: 'true' }))).status).toBe(403)
    await grant(BOB, 'writer')
    expect((await harness.request('GET', review(), { as: BOB })).status).toBe(403)
  })

  it('site filters only narrow authority and revoked mappings deny instead of authorized-empty', async () => {
    const id = await grant()
    const ownSite = await post()
    const otherSite = await post(OTHER_SITE + DOCUMENT)
    expect((await page()).annotations.map(row => row.id)).toEqual([ownSite.id])
    expect((await harness.request('GET', review({ site: OTHER_SITE }))).status).toBe(403)
    harness.database.execute('INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)', [OTHER_SITE, id])
    expect((await page()).annotations.map(row => row.id)).toEqual([ownSite.id, otherSite.id])
    expect((await page({ site: OTHER_SITE })).annotations.map(row => row.id)).toEqual([otherSite.id])
    harness.database.execute('DELETE FROM margin_site_admins WHERE identity_id=?', [id])
    expect((await harness.request('GET', review())).status).toBe(403)
  })

  it('pages in created/id order and binds the complete query-fragment document filter', async () => {
    await grant()
    const first = await post()
    const second = await post()
    await post(SITE + '/books/chapter/?edition=two#passage')
    harness.database.execute('UPDATE margin_annotations SET created=?', [NOW])
    const filters = { site: SITE, document: DOCUMENT, limit: '1' }
    const one = await page(filters)
    expect(one.annotations.map(row => row.id)).toEqual([first.id])
    expect(one.nextCursor).toBeTypeOf('string')
    expect((await page({ ...filters, cursor: one.nextCursor! })).annotations.map(row => row.id)).toEqual([second.id])
    expect((await harness.request('GET', review({ ...filters, document: '/books/chapter/', cursor: one.nextCursor! }))).status).toBe(400)
    expect((await harness.request('GET', review({ state: 'approved' }))).status).toBe(200)
  })

  it('missing storage is unavailable while mapped empty and missing authority remain distinct', async () => {
    const unavailable = await workerRequest(harness.database)
    expect(unavailable.status).toBe(503)
    expect((await unavailable.json()).error.code).toBe('storage_unavailable')
    await ensureSchema(harness.database)
    expect((await workerRequest(harness.database)).status).toBe(403)
    await grant()
    expect((await page()).annotations).toEqual([])
    const reads = harness.database.executed.length
    expect((await workerRequest(harness.database)).status).toBe(200)
    expect(harness.database.executed.slice(reads).every(query => /^(SELECT|WITH)\b/i.test(query.sql.trim()))).toBe(true)
  })
})

// The same production D1 call with a damaged reply; no alternate query path.
function alterResults(change: (result: unknown) => unknown): D1Database {
  const wrap = (statement: import('./d1').D1PreparedStatement): import('./d1').D1PreparedStatement => ({
    bind: (...values) => wrap(statement.bind(...values)),
    first: statement.first.bind(statement),
    run: statement.run.bind(statement),
    async all<T>() { return change(await statement.all<T>()) as import('./d1').D1Result<T> },
  })
  return { prepare: sql => wrap(harness.database.prepare(sql)) }
}

describe('review authority and storage boundaries', () => {
  it.each(['approved', ''])('anonymous review stays unauthenticated with state=%s', async state => {
    expect((await harness.request('GET', review({ state }), { as: null })).status).toBe(401)
    expect(harness.database.executed).toEqual([])
  })

  it.each(['mapping', 'role', 'identity'])('revocation of %s at the single row-read boundary is forbidden, not empty', async kind => {
    const id = await grant()
    await post()
    expect((await page()).annotations).toHaveLength(1)
    const query = harness.database.query.bind(harness.database)
    let revoked = false
    const spy = vi.spyOn(harness.database, 'query').mockImplementation((sql, params) => {
      if (sql.startsWith('WITH review_authority')) {
        expect(revoked).toBe(false)
        revoked = true
        const table = { mapping: 'margin_site_admins', role: 'margin_allowlist', identity: 'margin_identity' }[kind]!
        harness.database.execute(`DELETE FROM ${table} WHERE ${kind === 'identity' ? 'id' : 'identity_id'}=?`, [id])
      }
      return query(sql, params)
    })
    try {
      expect((await harness.request('GET', review())).status).toBe(403)
      expect(revoked).toBe(true)
    } finally { spy.mockRestore() }
  })

  it.each(['provider', 'issuer', 'subject'] as const)('binds the %s component, never an email alias', async component => {
    await grant()
    const principal = { ...ADA, [component]: 'another-fixture-value', email: 'same@example.test' }
    expect((await harness.request('GET', review(), { as: principal })).status).toBe(403)
    expect((await harness.request('GET', review(), { as: { ...ADA, email: 'changed@example.test' } })).status).toBe(200)
  })

  it.each(['margin_site_admins', 'margin_identity', 'margin_allowlist'])('missing %s remains a 503 and creates no schema', async table => {
    await grant()
    harness.database.execute(`DROP TABLE ${table}`)
    const before = harness.database.executed.length
    const response = await workerRequest(harness.database)
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('storage_unavailable')
    expect(harness.database.executed.slice(before).every(query => /^(SELECT|WITH)\b/.test(query.sql))).toBe(true)
  })

  it.each([
    null, [], {}, { success: false, results: [] }, { success: 1, results: [] },
    { success: true }, { success: true, results: null }, { success: true, results: {} },
    { success: true, results: [null] }, { success: true, results: [{ review_kind: 'unknown' }] },
  ])('refuses malformed D1 envelope %#', async value => {
    await grant()
    const response = await workerRequest(alterResults(() => value))
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('storage_unavailable')
  })

  it.each([
    ['review_identity_id', '1'], ['review_identity_id', 0], ['review_identity_id', 1.5],
    ['review_identity_id', Number.MAX_SAFE_INTEGER + 1], ['review_role', 'reviewer'],
    ['review_site', 'https://ernie.sg/path'], ['review_site', 'https://ernie.sg/'],
    ['review_site', 'https://reader@ernie.sg'], ['review_site', 1], ['review_site', undefined],
    ['id', 'unexpected-annotation-in-authority'],
  ])('rejects malformed authority field %s=%s', async (field, value) => {
    await grant()
    const response = await workerRequest(alterResults(result => {
      const data = result as { results: Record<string, unknown>[] }
      return { ...data, results: data.results.map(row => row.review_kind === 'authority' ? { ...row, [field as string]: value } : row) }
    }))
    expect(response.status).toBe(503)
  })

  it.each([
    ['id', null], ['site', OTHER_SITE], ['site', 'https://ernie.sg/'],
    ['document', 'relative'], ['document', '/books/chapter/../other'], ['creator', 1],
    ['creator', 'ordinary text'], ['creator', 'urn:margin:principal:dev:issuer:'],
    ['node_id', 'x'.repeat(257)], ['quote_exact', 'x'.repeat(2001)], ['quote_prefix', 'x'.repeat(501)], ['quote_suffix', 'x'.repeat(501)],
    ['visibility', 'unknown'], ['motivation', 'commenting'], ['parent_id', 'parent'],
    ['position_start', -1], ['position_end', 0], ['position_start', 1.5], ['position_unit', 'byte'],
    ['created', 'yesterday'], ['modified', 0], ['base_commit', 'unknown'],
    ['base_commit', null], ['source_path', '/absolute'], ['revision', '1'], ['revision', 0],
    ['revision', 1.5], ['withdrawn_at', NOW], ['body', null], ['quote_exact', null],
    ['review_role', 'admin'], ['unexpected', true],
  ])('rejects malformed or out-of-scope proposal field %s=%s', async (field, value) => {
    await grant()
    await post()
    const response = await workerRequest(alterResults(result => {
      const data = result as { results: Record<string, unknown>[] }
      return { ...data, results: data.results.map(row => row.review_kind === 'annotation' ? { ...row, [field as string]: value } : row) }
    }))
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('storage_unavailable')
  })

  it('a thrown read is unavailable and an oversized returned page is not accepted', async () => {
    await grant()
    await post()
    expect((await workerRequest(alterResults(() => { throw new Error('fixture D1 unavailable') }))).status).toBe(503)
    const response = await workerRequest(alterResults(result => {
      const data = result as { results: Record<string, unknown>[] }
      return { ...data, results: [...data.results, ...Array(201).fill(data.results.find(row => row.review_kind === 'annotation'))] }
    }))
    expect(response.status).toBe(503)
  })

  it('supports HEAD without a body, refuses writes, and grants no private individual read', async () => {
    await grant()
    const row = await post()
    const before = harness.database.executed.length
    const head = await harness.request('HEAD', review())
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await harness.request('POST', review())).status).toBe(405)
    expect(harness.database.executed.slice(before)).toHaveLength(1)
    const item = `/annotations/${row.id.replace('urn:margin:annotation:', '')}${scopeQuery(SOURCE)}`
    expect((await harness.request('GET', item)).status).toBe(404)
    expect((await harness.request('PATCH', item, { body: { body: 'unchanged' } })).status).toBe(404)
  })
})

describe('review filters and keyset boundaries', () => {
  it.each([
    { site: SITE + '/path' }, { site: SITE + '?' }, { site: SITE + '#' }, { site: 'https://reader@ernie.sg' },
    { site: '' }, { document: DOCUMENT }, { site: SITE, document: '' }, { site: SITE, document: 'relative' },
    { state: '' }, { state: 'unknown' }, { scope: 'all' }, { scope: '' }, { source: SOURCE },
    ...['0', '-1', '201', '1.5', 'Infinity', 'bad'].map(limit => ({ limit })),
  ] as Record<string, string>[])('rejects invalid review selectors %#', async params => {
    await grant()
    const response = await harness.request('GET', review(params))
    expect(response.status).toBe(400)
  })

  it('rejects repeated recognized parameters', async () => {
    await grant()
    for (const [key, value] of Object.entries({ scope: 'review', site: SITE, document: DOCUMENT, state: 'pending', limit: '1', cursor: 'bad' })) {
      const response = await harness.request('GET', review({ site: SITE, document: DOCUMENT, [key]: value }) + `&${key}=${encodeURIComponent(value)}`)
      expect(response.status, key).toBe(400)
    }
  })

  it('pages tied times across authorized sites/documents, excludes withdrawn rows and enforces caps', async () => {
    await grant(ADA, 'admin', [SITE, OTHER_SITE])
    const written: Wire[] = []
    for (let index = 0; index < 205; index++) written.push(await post((index % 2 ? SITE : OTHER_SITE) + `/doc-${index % 3}/`))
    const removed = written.pop()!
    const id = removed.id.replace('urn:margin:annotation:', '')
    expect((await harness.request('POST', `/proposals/${id}/withdraw${scopeQuery(removed.target.source)}`, { as: BOB })).status).toBe(200)
    harness.database.execute('UPDATE margin_annotations SET created=?', [NOW])
    expect((await page()).annotations).toHaveLength(100)
    expect((await page({ limit: '200' })).annotations).toHaveLength(200)
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const result = await page({ limit: '37', ...(cursor ? { cursor } : {}) })
      seen.push(...result.annotations.map(row => row.id))
      cursor = result.nextCursor
    } while (cursor && seen.length < 300)
    expect(seen).toEqual(written.map(row => row.id))
    expect(new Set(seen).size).toBe(204)
  })

  it('normalizes origin/path while keeping query, fragment, and empty delimiters distinct', async () => {
    await grant()
    for (const document of ['/doc', '/doc?', '/doc#', '/doc?q=one#x', '/doc?q=two#x', '/doc?q=one#y']) {
      const row = await post(SITE + document)
      expect((await page({ site: 'https://ERNIE.sg:443/', document })).annotations.map(value => value.id)).toEqual([row.id])
    }
    expect((await page({ site: SITE, document: '/prefix/../doc?q=one#x' })).annotations[0].target.source).toBe(SITE + '/doc?q=one#x')
  })

  it('rejects malformed, extra-member, duplicate-member and filter-mismatched cursors', async () => {
    await grant()
    await post(); await post()
    const filters = { site: SITE, document: DOCUMENT, limit: '1' }
    const cursor = (await page(filters)).nextCursor!
    const decoded = JSON.parse(cursor)
    for (const damaged of [
      '', 'bad', 'x'.repeat(16_385), '[]', 'null', JSON.stringify({ ...decoded, version: true }),
      JSON.stringify({ ...decoded, version: 1 }), JSON.stringify({ ...decoded, extra: true }),
      JSON.stringify({ ...decoded, created: 'yesterday' }), JSON.stringify({ ...decoded, id: 1 }),
      JSON.stringify({ ...decoded, document: '/other' }), JSON.stringify({ ...decoded, site: OTHER_SITE }),
      cursor.replace('"version":2', '"version":2,"version":2'),
    ]) {
      expect((await harness.request('GET', review({ ...filters, cursor: damaged }))).status, damaged.slice(0, 70)).toBe(400)
    }
    expect((await harness.request('GET', review({ cursor }))).status).toBe(400)
    // State omitted and explicit pending mean the same supported query.
    expect((await page({ ...filters, state: 'pending', cursor })).annotations).toHaveLength(1)
  })
})

describe('review migration and SQL invariants', () => {
  it.each([true, false])('supports identity-first=%s initialization, no seed, and identity FK deletion', async identityFirst => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('PRAGMA foreign_keys=ON')
      if (identityFirst) for (const statement of SCHEMA_STATEMENTS) database.exec(statement)
      expect(applyMigrations(database)).toContain('0006_margin_site_admins.sql')
      expect(database.prepare('SELECT * FROM margin_site_admins').all()).toEqual([])
      if (!identityFirst) for (const statement of SCHEMA_STATEMENTS) database.exec(statement)
      expect(database.prepare('SELECT * FROM margin_identity').all()).toEqual([])
      expect(database.prepare('SELECT * FROM margin_allowlist').all()).toEqual([])
      expect(() => database.prepare('INSERT INTO margin_site_admins VALUES(?,?)').run(SITE, 999)).toThrow(/FOREIGN KEY/)
      database.prepare('INSERT INTO margin_identity(id,provider,issuer,subject,first_seen_at,last_seen_at) VALUES(1,?,?,?,?,?)')
        .run(ADA.provider, ADA.issuer, ADA.subject, NOW, NOW)
      database.prepare('INSERT INTO margin_allowlist VALUES(?,?,?)').run(1, 'admin', NOW)
      database.prepare('INSERT INTO margin_site_admins VALUES(?,?)').run(SITE, 1)
      expect(() => database.prepare('INSERT INTO margin_site_admins VALUES(?,?)').run(SITE, 1)).toThrow(/UNIQUE/)
      database.prepare('DELETE FROM margin_identity WHERE id=1').run()
      expect(database.prepare('SELECT * FROM margin_site_admins').all()).toEqual([])
      expect(database.prepare('SELECT * FROM margin_allowlist').all()).toEqual([])
    } finally { database.close() }
  })

  it('the actual SQL returns no unmapped site, non-proposal, or withdrawn private row', async () => {
    await grant()
    const visible = await post()
    await post(OTHER_SITE + DOCUMENT)
    await post(SOURCE, 'commenting')
    const withdrawn = await post()
    await harness.request('POST', `/proposals/${withdrawn.id.replace('urn:margin:annotation:', '')}/withdraw${scopeQuery(SOURCE)}`, { as: BOB })
    const statement = listReviewProposalsQuery(ADA, { limit: 10 })
    const raw = harness.database.query(statement.sql, statement.params)
    expect(raw.filter(row => row.review_kind === 'annotation').map(row => row.id)).toEqual([visible.id.replace('urn:margin:annotation:', '')])
    const noAuthority = listReviewProposalsQuery(BOB, { limit: 10 })
    expect(harness.database.query(noAuthority.sql, noAuthority.params)).toEqual([])
  })

  it('a genuine legacy proposal with all three metadata fields absent remains readable', async () => {
    await grant()
    const saved = await post()
    harness.database.execute('DROP TRIGGER margin_annotations_proposal_fields_update')
    harness.database.execute('UPDATE margin_annotations SET base_commit=NULL,source_path=NULL,revision=NULL')
    const result = await page()
    expect(result.annotations.map(row => row.id)).toEqual([saved.id])
    expect(result.annotations[0]).not.toHaveProperty('margin:baseCommit')
    expect(result.annotations[0]).not.toHaveProperty('margin:revision')
  })
})
