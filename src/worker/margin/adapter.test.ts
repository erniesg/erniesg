import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import {
  ADA,
  BOB,
  BASE_COMMIT,
  SOURCE_PATH,
  createHarness,
  proposalBody,
  scopeQuery,
  webAnnotation,
} from './fixtures'
import { handleMarginRequest } from './routes'
import { encodeBase64Url } from './base64url'
import type { D1Database } from './d1'

const SITE = 'https://ernie.sg'
const OTHER = 'https://example.org'
const AT = '2026-10-08T00:00:00.000Z'
const FEED = '/api/margin/v1/adapter/feed'
const digest = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('')
afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const h = createHarness()
  h.database.execute(
    'INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
    [ADA.provider, ADA.issuer, ADA.subject, AT, AT],
  )
  const identity = h.database.query('SELECT id FROM margin_identity')[0].id
  h.database.execute(
    "INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)",
    [identity, AT],
  )
  for (const site of [SITE, OTHER])
    h.database.execute('INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)', [
      site,
      identity,
    ])
  async function token(site = SITE, index = 1) {
    const selector = encodeBase64Url(new Uint8Array(16).fill(index))
    const value = `margin-adapter-v1.${selector}.${encodeBase64Url(new Uint8Array(32).fill(index + 10))}`
    h.database.execute(
      'INSERT OR IGNORE INTO margin_adapters(site,adapter,enabled,created_at) VALUES(?,?,1,?)',
      [site, 'fixture-adapter', AT],
    )
    h.database.execute(
      'INSERT INTO margin_adapter_tokens(token_id,site,adapter,token_sha256,capability,created_at,revoked_at) VALUES(?,?,?,?,?,?,NULL)',
      [selector, site, 'fixture-adapter', await digest(value), 'approved_feed', AT],
    )
    return value
  }
  async function approve(
    source = SITE + '/books/example/?edition=one#passage',
    visibility = 'private',
    body = proposalBody(),
    at?: string,
  ) {
    const created = await h.request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({
        source,
        motivation: 'editing',
        body,
        visibility: visibility as 'private' | 'public',
      }),
    })
    expect(created.status).toBe(201)
    const wire = await created.json(),
      id = wire.id.replace('urn:margin:annotation:', '')
    const path = `/proposals/${id}/apply${scopeQuery(source)}`
    const applied = at
      ? await handleMarginRequest(
          new Request(SITE + '/api/margin/v1' + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision: 1 }),
          }),
          {
            repository: h.repository,
            principal: ADA,
            now: () => at,
            newId: () => 'unused',
          },
        )
      : await h.request('POST', path, { body: { revision: 1 } })
    expect(applied.status).toBe(202)
    h.database.execute(
      'UPDATE margin_proposal_applications SET state=state WHERE proposal_id=?',
      [id],
    )
    return { id, source, wire }
  }
  const call = (value?: string, suffix = '', db: D1Database = h.database) =>
    worker.fetch(
      new Request(SITE + FEED + suffix, {
        headers: value ? { authorization: `Bearer ${value}` } : {},
      }),
      { ASSETS: { fetch: async () => new Response('asset') }, MARGIN_DB: db },
    )
  return { h, token, approve, call }
}

describe('approved adapter feed RED pilots', () => {
  it('projects only the credential site immutable approval after creator revision', async () => {
    const f = await fixture(),
      token = await f.token(),
      own = await f.approve()
    await f.token(OTHER, 2)
    await f.approve(OTHER + '/books/example/', 'public')
    expect(
      (
        await f.h.request('PATCH', `/annotations/${own.id}${scopeQuery(own.source)}`, {
          as: BOB,
          body: { body: proposalBody('Changed {++draft++}.') },
        })
      ).status,
    ).toBe(200)
    const response = await f.call(token)
    expect(response.status).toBe(200)
    const page = await response.json()
    expect(page.eligibility).toBe('approved')
    expect(page.items).toEqual([
      {
        proposalId: own.id,
        site: SITE,
        document: '/books/example/?edition=one#passage',
        source: own.source,
        approvedRevision: 1,
        body: proposalBody(),
        baseCommit: BASE_COMMIT,
        sourcePath: SOURCE_PATH,
        visibility: 'private',
        approvedAt: expect.any(String),
      },
    ])
  })
  it('distinguishes revoked row-bound authority from an authorized empty page', async () => {
    const f = await fixture(),
      token = await f.token()
    expect((await f.call(token)).status).toBe(200)
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.includes('LIMIT 2'))
        f.h.database.execute('UPDATE margin_adapter_tokens SET revoked_at=?', [AT])
      return rows
    })
    expect((await f.call(token)).status).toBe(403)
  })
  it('pages keyset snapshots without widening eligibility or tenant cursor scope', async () => {
    const f = await fixture(),
      token = await f.token(),
      other = await f.token(OTHER, 2)
    const first = await f.approve(),
      second = await f.approve(),
      excluded = await f.approve()
    f.h.database.execute(
      "UPDATE margin_proposal_applications SET state='apply_failed' WHERE proposal_id=?",
      [excluded.id],
    )
    const page = await (await f.call(token, '?limit=1')).json()
    expect(page.items.map((x: { proposalId: string }) => x.proposalId)).toEqual([
      first.id,
    ])
    const next = await (
      await f.call(token, '?limit=1&cursor=' + page.nextCursor)
    ).json()
    expect(next.items.map((x: { proposalId: string }) => x.proposalId)).toEqual([
      second.id,
    ])
    expect(next.nextCursor).toBeNull()
    expect((await f.call(other, '?cursor=' + page.nextCursor)).status).toBe(400)
    expect((await f.call(token, '?limit=1&limit=2')).status).toBe(400)
  })
  it('enforces real registry constraints and refuses a malformed snapshot whole-page', async () => {
    const f = await fixture(),
      token = await f.token()
    await f.approve()
    expect(() =>
      f.h.database.execute(
        'INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)',
        ['x', OTHER, 'absent', 'a'.repeat(64), 'approved_feed', AT],
      ),
    ).toThrow()
    expect(() =>
      f.h.database.execute('UPDATE margin_adapter_tokens SET capability=?', ['report']),
    ).toThrow()
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) =>
      query(sql, params).map((row) =>
        row.kind === 'item' ? { ...row, revision: null } : row,
      ),
    )
    expect((await f.call(token)).status).toBe(503)
  })
})

// Each mutation models an invalid storage response, after the real SQL has
// selected its rows. No invalid row may be repaired, skipped, or partly served.
describe('adapter stored-result boundaries', () => {
  const badRows: [string, unknown][] = [
    ['proposal_id', ''],
    ['proposal_id', null],
    ['site', OTHER],
    ['site', SITE + '/'],
    ['document', 'https://elsewhere/path'],
    ['document', '/a/../b'],
    ['document', 'relative'],
    ['visibility', 'team'],
    ['visibility', null],
    ['body', 'legacy free text'],
    ['body', '{}'],
    ['body', proposalBody() + ' '],
    ['base_commit', 'abc'],
    ['base_commit', 'A'.repeat(40)],
    ['source_path', '../chapter.md'],
    ['source_path', '/chapter.md'],
    ['revision', true],
    ['revision', 0],
    ['revision', 1.5],
    ['revision', Number.MAX_SAFE_INTEGER + 1],
    ['approved_at', 'yesterday'],
    ['approved_at', null],
    ['state', 'pr_open'],
    ['authorized', true],
    ['kind', 'unknown'],
  ]
  it.each(badRows)(
    'refuses malformed snapshot %s=%j including lookahead rows',
    async (key, value) => {
      const f = await fixture(),
        token = await f.token()
      await f.approve()
      await f.approve()
      const query = f.h.database.query.bind(f.h.database)
      vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
        const rows = query(sql, params)
        return rows.map((row, i) =>
          row.kind === 'item' && i === rows.length - 1 ? { ...row, [key]: value } : row,
        )
      })
      const r = await f.call(token, '?limit=1')
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ error: { code: 'storage_unavailable' } })
    },
  )
  it.each([
    'missing',
    'duplicate',
    'false-with-items',
    'extra-column',
    'missing-column',
    'wrong-order',
    'duplicate-item',
  ])('refuses %s tagged page shape', async (shape) => {
    const f = await fixture(),
      token = await f.token()
    await f.approve()
    await f.approve()
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (!rows.some((r) => r.kind === 'authority')) return rows
      if (shape === 'missing') return rows.slice(1)
      if (shape === 'duplicate') return [rows[0], ...rows]
      if (shape === 'false-with-items')
        return [{ ...rows[0], authorized: 0 }, ...rows.slice(1)]
      if (shape === 'extra-column')
        return [{ ...rows[0], extra: null }, ...rows.slice(1)]
      if (shape === 'missing-column') {
        const row = { ...rows[0] }
        delete row.state
        return [row, ...rows.slice(1)]
      }
      if (shape === 'wrong-order') return [rows[0], ...rows.slice(1).reverse()]
      return [...rows, rows[1]]
    })
    expect((await f.call(token)).status).toBe(503)
  })
  it.each([
    ['token_id', 'B'.repeat(22)],
    ['site', SITE + '/'],
    ['adapter', ''],
    ['token_sha256', 'a'],
    ['token_sha256', 'A'.repeat(64)],
    ['enabled', true],
    ['enabled', 2],
    ['capability', null],
    ['created_at', 'unknown'],
    ['revoked_at', 0],
    ['registration_created_at', null],
  ])('refuses malformed credential %s', async (key, value) => {
    const f = await fixture(),
      token = await f.token(),
      query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) =>
      query(sql, params).map((row) =>
        'token_id' in row ? { ...row, [key]: value } : row,
      ),
    )
    expect((await f.call(token)).status).toBe(503)
  })
  it.each(['duplicate', 'extra', 'missing'])(
    'refuses %s credential row contract',
    async (shape) => {
      const f = await fixture(),
        token = await f.token(),
        query = f.h.database.query.bind(f.h.database)
      vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
        const rows = query(sql, params)
        if (!rows[0] || !('token_id' in rows[0])) return rows
        if (shape === 'duplicate') return [...rows, ...rows]
        if (shape === 'extra') return [{ ...rows[0], secret: 'not-a-token' }]
        const row = { ...rows[0] }
        delete row.revoked_at
        return [row]
      })
      expect((await f.call(token)).status).toBe(503)
    },
  )
  it.each([
    false,
    true,
    0,
    null,
    {},
    { success: false, results: [] },
    { success: true, results: null },
  ])('refuses incomplete D1 envelope %j', async (result) => {
    const f = await fixture(),
      token = await f.token()
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        all: async () => result,
      }),
    } as unknown as D1Database
    expect((await f.call(token, '', db)).status).toBe(503)
  })
})

describe('adapter revocation and credential scope', () => {
  it.each(['revoked', 'disabled', 'digest', 'site', 'adapter', 'removed'])(
    'rechecks %s between credential authentication and page',
    async (kind) => {
      const f = await fixture(),
        token = await f.token()
      await f.approve()
      await f.token(OTHER, 2)
      f.h.database.execute('INSERT INTO margin_adapters(site,adapter,enabled,created_at) VALUES(?,?,1,?)', [
        'https://third.example',
        'other-adapter',
        AT,
      ])
      const query = f.h.database.query.bind(f.h.database)
      vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
        const rows = query(sql, params)
        if (sql.includes('LIMIT 2')) {
          if (kind === 'revoked')
            f.h.database.execute('UPDATE margin_adapter_tokens SET revoked_at=?', [AT])
          if (kind === 'disabled')
            f.h.database.execute('UPDATE margin_adapters SET enabled=0')
          if (kind === 'digest')
            f.h.database.execute('UPDATE margin_adapter_tokens SET token_sha256=?', [
              'f'.repeat(64),
            ])
          if (kind === 'site')
            f.h.database.execute('UPDATE margin_adapter_tokens SET site=?', [OTHER])
          if (kind === 'adapter')
            f.h.database.execute(
              "UPDATE margin_adapter_tokens SET site='https://third.example',adapter='other-adapter'",
            )
          if (kind === 'removed')
            f.h.database.execute('DELETE FROM margin_adapter_tokens')
        }
        return rows
      })
      expect((await f.call(token)).status).toBe(403)
    },
  )
  it('does not authenticate selector alone and distinguishes verified disabled tokens', async () => {
    const f = await fixture(),
      token = await f.token()
    expect(
      (await f.call(token.slice(0, -43) + encodeBase64Url(new Uint8Array(32).fill(33))))
        .status,
    ).toBe(401)
    expect(
      (
        await f.call(
          `margin-adapter-v1.${encodeBase64Url(new Uint8Array(16).fill(44))}.${encodeBase64Url(new Uint8Array(32).fill(45))}`,
        )
      ).status,
    ).toBe(401)
    f.h.database.execute('UPDATE margin_adapters SET enabled=0')
    expect((await f.call(token)).status).toBe(403)
  })
  it('reads one authority-page snapshot after bounded selector lookup and never writes', async () => {
    const f = await fixture(),
      token = await f.token()
    await f.approve()
    f.h.database.executed.length = 0
    expect((await f.call(token)).status).toBe(200)
    expect(f.h.database.executed).toHaveLength(2)
    expect(f.h.database.executed[0].sql).toContain('LIMIT 2')
    expect(f.h.database.executed[1].sql).toContain('WITH authority AS')
    expect(f.h.database.executed[1].sql).not.toContain('margin_annotations')
  })
})

describe('adapter paging and migration', () => {
  it.each([
    '?limit=0',
    '?limit=51',
    '?limit=1.0',
    '?limit=01',
    '?limit=-1',
    '?limit=',
    '?site=https://example.org',
    '?cursor=',
    '?cursor=a',
    '?limit=1&limit=1',
    '?cursor=a&cursor=b',
  ])('rejects query %s', async (suffix) => {
    const f = await fixture(),
      token = await f.token()
    expect((await f.call(token, suffix)).status).toBe(400)
  })
  it('retains empty delimiters and excludes every non-approved state without retry defaults', async () => {
    const f = await fixture(),
      token = await f.token()
    for (const suffix of ['?', '#', '?#']) await f.approve(SITE + '/document' + suffix)
    for (const state of ['pr_open', 'conflict', 'merged', 'closed', 'apply_failed']) {
      const item = await f.approve()
      f.h.database.execute(
        'UPDATE margin_proposal_applications SET state=? WHERE proposal_id=?',
        [state, item.id],
      )
    }
    const page = await (await f.call(token)).json()
    expect(page.items.map((x: { document: string }) => x.document)).toEqual([
      '/document?',
      '/document#',
      '/document?#',
    ])
    expect(JSON.stringify(page)).not.toMatch(
      /creator|reviewer|comments|attempt|failureCount/,
    )
  })
  it('keeps tied keys in SQLite order and refuses replay of a cursor under a rotated token', async () => {
    const f = await fixture(),
      token = await f.token()
    await f.approve(undefined, undefined, undefined, AT)
    await f.approve(undefined, undefined, undefined, AT)
    expect(
      f.h.database.query(
        'SELECT DISTINCT approved_at FROM margin_proposal_applications',
      ),
    ).toEqual([{ approved_at: AT }])
    const expected = f.h.database
      .query(
        'SELECT proposal_id FROM margin_proposal_applications ORDER BY approved_at,proposal_id',
      )
      .map((r) => r.proposal_id)
    const page = await (await f.call(token, '?limit=1')).json(),
      next = await (await f.call(token, '?cursor=' + page.nextCursor)).json()
    expect([...page.items, ...next.items].map((x) => x.proposalId)).toEqual(expected)
    const rotated = await f.token(SITE, 3)
    expect((await f.call(rotated, '?cursor=' + page.nextCursor)).status).toBe(400)
  })
  it('enforces SQL registry owner, capability, digest and uniqueness constraints', async () => {
    const f = await fixture(),
      token = await f.token()
    expect(token).toBeTypeOf('string')
    const selector = f.h.database.query('SELECT token_id FROM margin_adapter_tokens')[0]
      .token_id
    for (const [column, value] of [
      ['token_sha256', 'g'.repeat(64)],
      ['token_id', 'short'],
      ['capability', 'report'],
    ])
      expect(() =>
        f.h.database.execute(`UPDATE margin_adapter_tokens SET ${column}=?`, [value]),
      ).toThrow()
    expect(() => f.h.database.execute('UPDATE margin_adapters SET enabled=2')).toThrow()
    expect(() =>
      f.h.database.execute('INSERT INTO margin_adapters(site,adapter,enabled,created_at) VALUES(?,?,1,?)', [
        SITE,
        'another',
        AT,
      ]),
    ).toThrow()
    expect(() =>
      f.h.database.execute(
        'INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)',
        [selector, SITE, 'fixture-adapter', 'f'.repeat(64), 'approved_feed', AT],
      ),
    ).toThrow()
    expect(() => f.h.database.execute('DELETE FROM margin_adapters')).toThrow()
    expect(
      f.h.database.query(
        "SELECT name FROM sqlite_master WHERE name='margin_applications_approved_feed'",
      ),
    ).toHaveLength(1)
  })
})

it('bounds UTF-8 response bytes and resumes after the last emitted item without loss', async () => {
  const f = await fixture(),
    token = await f.token(),
    body = proposalBody('漢'.repeat(63_800))
  const expected = []
  for (let i = 0; i < 26; i++)
    expected.push((await f.approve(undefined, undefined, body, AT)).id)
  const seen: string[] = []
  let suffix = '?limit=50',
    pages = 0
  do {
    const response = await f.call(token, suffix)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    )
    const page = JSON.parse(text)
    expect(page.items.length).toBeGreaterThan(0)
    seen.push(...page.items.map((x: { proposalId: string }) => x.proposalId))
    pages++
    suffix = page.nextCursor ? '?limit=50&cursor=' + page.nextCursor : ''
    expect(pages).toBeLessThan(4)
  } while (suffix)
  expect(pages).toBe(2)
  expect(seen).toEqual(expected)
})

it('preserves a canonical double-slash document as same-site absolute source', async () => {
  const f = await fixture(),
    token = await f.token()
  await f.approve(SITE + '//elsewhere/path')
  const response = await f.call(token)
  expect(response.status).toBe(200)
  expect((await response.json()).items[0].source).toBe(SITE + '//elsewhere/path')
})

it('refuses noncanonical cursor JSON, changed scope and extra fields without querying the page', async () => {
  const f = await fixture(),
    token = await f.token()
  await f.approve()
  await f.approve()
  const page = await (await f.call(token, '?limit=1')).json()
  const canonical = Buffer.from(page.nextCursor, 'base64url').toString('utf8'),
    value = JSON.parse(canonical)
  const variants = [
    canonical + ' ',
    canonical.replace('"version":1', '"version":1,"version":1'),
    JSON.stringify({ ...value, extra: 1 }),
    JSON.stringify({ ...value, site: OTHER }),
    JSON.stringify({ ...value, eligibility: 'apply_failed' }),
    JSON.stringify({ ...value, approvedAt: 'not-a-date' }),
  ]
  for (const input of variants) {
    f.h.database.executed.length = 0
    expect(
      (
        await f.call(
          token,
          '?cursor=' + encodeBase64Url(new TextEncoder().encode(input)),
        )
      ).status,
    ).toBe(400)
    expect(f.h.database.executed).toHaveLength(1)
  }
})
it('validates failure envelopes again at the authority/page boundary', async () => {
  const f = await fixture(),
    token = await f.token()
  await f.approve()
  for (const bad of [
    { success: false, results: [] },
    { success: true, results: [] },
    { success: true, results: 'partial' },
  ]) {
    const db = {
      prepare: (sql: string) => {
        if (sql.includes('LIMIT 2')) return f.h.database.prepare(sql)
        return {
          bind() {
            return this
          },
          all: async () => bad,
        }
      },
    } as D1Database
    expect((await f.call(token, '', db)).status).toBe(503)
  }
})
it('refuses missing and extra snapshot fields, including otherwise valid content', async () => {
  const f = await fixture(),
    token = await f.token()
  await f.approve()
  const query = f.h.database.query.bind(f.h.database)
  for (const mode of ['extra', 'missing']) {
    const spy = vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) =>
      query(sql, params).map((row) => {
        if (row.kind !== 'item') return row
        if (mode === 'extra')
          return { ...row, review_comments: 'private metadata never in projection' }
        const changed = { ...row }
        delete changed.visibility
        return changed
      }),
    )
    expect((await f.call(token)).status).toBe(503)
    spy.mockRestore()
  }
})
it('treats an unsupported stored capability as forbidden after verifying the exact digest', async () => {
  const f = await fixture(),
    token = await f.token(),
    query = f.h.database.query.bind(f.h.database)
  vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) =>
    query(sql, params).map((row) =>
      'token_id' in row ? { ...row, capability: 'future_scope' } : row,
    ),
  )
  expect((await f.call(token)).status).toBe(403)
})

it('emits replayable cursors for the full accepted stored identifier size', async () => {
  const f = await fixture(),
    token = await f.token()
  const identifiers = ['漢'.repeat(2047) + 'a', '漢'.repeat(2047) + 'b']
  for (const id of identifiers) {
    const response = await f.h.request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({ source: SITE + '/document', motivation: 'editing' }),
    })
    expect(response.status).toBe(201)
    const original = (await response.json()).id.replace('urn:margin:annotation:', '')
    f.h.database.execute('UPDATE margin_annotations SET id=? WHERE id=?', [
      id,
      original,
    ])
    expect(
      (
        await f.h.request(
          'POST',
          `/proposals/${encodeURIComponent(id)}/apply${scopeQuery(SITE + '/document')}`,
          { body: { revision: 1 } },
        )
      ).status,
    ).toBe(202)
  }
  const page = await (await f.call(token, '?limit=1')).json()
  expect(page.items[0].proposalId).toBe(identifiers[0])
  const resumed = await f.call(token, '?cursor=' + page.nextCursor)
  expect(resumed.status).toBe(200)
  expect(
    (await resumed.json()).items.map((x: { proposalId: string }) => x.proposalId),
  ).toEqual([identifiers[1]])
})
it('refuses excessive cursor and raw query lengths before a page query', async () => {
  const f = await fixture(),
    token = await f.token()
  for (const suffix of [
    '?cursor=' + 'a'.repeat(32_769),
    '?limit=' + '1'.repeat(40_001),
  ]) {
    f.h.database.executed.length = 0
    expect((await f.call(token, suffix)).status).toBe(400)
    expect(f.h.database.executed).toHaveLength(1)
  }
})

const REPORTS = '/api/margin/v1/adapter/reports'
const reportEvent = (n: number) => encodeBase64Url(new Uint8Array(16).fill(n))
async function reportFixture() {
  const f = await fixture(),
    value = await f.token(),
    proposal = await f.approve()
  const grant = async () =>
    f.h.database.execute(
      'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
      [value.split('.')[1], await digest(value), SITE, 'fixture-adapter', AT],
    )
  const report = (n = 1) => ({
    eventId: reportEvent(n),
    proposalId: proposal.id,
    approvedRevision: 1,
    expectedStateVersion: 0,
    outcome: { state: 'apply_failed', detail: 'offline fixture result' },
  })
  const call = (path: string, method: string, body?: unknown, bearer = value) =>
    worker.fetch(
      new Request(SITE + path, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { ASSETS: { fetch: async () => new Response('asset') }, MARGIN_DB: f.h.database },
    )
  return { ...f, value, proposal, grant, report, requestReport: call }
}

describe('report HTTP representative RED pilots', () => {
  it('requires the exact report grant and returns the same stored acknowledgement on replay', async () => {
    const f = await reportFixture(),
      input = f.report()
    expect((await f.requestReport(REPORTS, 'POST', input)).status).toBe(403)
    await f.grant()
    const first = await f.requestReport(REPORTS, 'POST', input)
    expect(first.status).toBe(200)
    const stored = await first.json()
    expect(stored.ack).toMatchObject({
      eventId: input.eventId,
      proposalId: f.proposal.id,
      stateVersion: 1,
      failedApplyCount: 1,
    })
    expect(await (await f.requestReport(REPORTS, 'POST', input)).json()).toEqual(stored)
    expect((await f.requestReport(REPORTS, 'POST', f.report(2))).status).toBe(409)
    f.h.database.execute('UPDATE margin_adapter_report_grants SET revoked_at=?', [AT])
    expect(
      (await f.requestReport('/api/margin/v1/adapter/receipts/' + input.eventId, 'GET'))
        .status,
    ).toBe(403)
    expect(
      f.h.database.query('SELECT * FROM margin_adapter_report_receipts'),
    ).toHaveLength(1)
  })
  it('maps uncertain committed writes to503 and reconciles through a read-only receipt', async () => {
    const f = await reportFixture()
    await f.grant()
    const input = f.report(),
      query = f.h.database.query.bind(f.h.database)
    const spy = vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.startsWith('INSERT INTO margin_adapter_report_receipts'))
        throw Error('fixture response lost after commit')
      return rows
    })
    const uncertain = await f.requestReport(REPORTS, 'POST', input)
    expect(uncertain.status).toBe(503)
    expect(await uncertain.json()).toEqual({ error: { code: 'storage_unavailable' } })
    spy.mockRestore()
    const recovered = await f.requestReport(
      '/api/margin/v1/adapter/receipts/' + input.eventId,
      'GET',
    )
    expect(recovered.status).toBe(200)
    expect((await recovered.json()).ack).toMatchObject({
      stateVersion: 1,
      failedApplyCount: 1,
    })
    expect(
      f.h.database.query('SELECT * FROM margin_adapter_report_receipts'),
    ).toHaveLength(1)
  })
})

async function rawReport(
  f: Awaited<ReturnType<typeof reportFixture>>,
  body: BodyInit | null,
  extra: Record<string, string> = {},
  method = 'POST',
  path = REPORTS,
) {
  return worker.fetch(
    new Request(SITE + path, {
      method,
      headers: {
        authorization: `Bearer ${f.value}`,
        'content-type': 'application/json',
        ...extra,
      },
      ...(body === null ? {} : { body }),
      duplex: 'half',
    } as RequestInit),
    { ASSETS: { fetch: async () => new Response('asset') }, MARGIN_DB: f.h.database },
  )
}

describe('bounded report transport and shared schema', () => {
  const invalid: Record<
    string,
    (r: ReturnType<Awaited<ReturnType<typeof reportFixture>>['report']>) => string
  > = {
    'root duplicate': (r) =>
      JSON.stringify(r).replace('{', '{"eventId":"' + r.eventId + '",'),
    'escaped duplicate': (r) =>
      JSON.stringify(r).replace('{', '{"event\\u0049d":"' + r.eventId + '",'),
    'nested duplicate': (r) =>
      JSON.stringify(r).replace('"detail":', '"detail":"first","detail":'),
    'unknown key': (r) => JSON.stringify({ ...r, extra: true }),
    'unknown outcome key': (r) =>
      JSON.stringify({ ...r, outcome: { ...r.outcome, extra: true } }),
    'array root': (r) => JSON.stringify([r]),
    'null root': () => 'null',
    'array member': (r) => JSON.stringify({ ...r, outcome: [] }),
    'excess nesting': (r) =>
      JSON.stringify({
        ...r,
        outcome: { state: 'closed', pr: { head: { nested: 'fixture' } } },
      }),
    'member bound': (r) =>
      JSON.stringify({
        ...r,
        ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['key' + i, i])),
      }),
    'trailing bytes': (r) => JSON.stringify(r) + ' false',
    'trailing comma': (r) => JSON.stringify(r).replace(/}$/, ',}'),
    'infinite numeric value': (r) =>
      JSON.stringify(r).replace(
        '"expectedStateVersion":0',
        '"expectedStateVersion":1e999',
      ),
    'boolean version': (r) => JSON.stringify({ ...r, expectedStateVersion: true }),
    'fraction revision': (r) => JSON.stringify({ ...r, approvedRevision: 1.5 }),
    'unsafe integer': (r) =>
      JSON.stringify({ ...r, expectedStateVersion: Number.MAX_SAFE_INTEGER + 1 }),
    'unknown state': (r) =>
      JSON.stringify({ ...r, outcome: { state: 'pending', detail: 'fixture' } }),
    'empty detail': (r) =>
      JSON.stringify({ ...r, outcome: { ...r.outcome, detail: '' } }),
    BOM: (r) => '\uFEFF' + JSON.stringify(r),
  }
  it.each(Object.keys(invalid))('rejects %s before mutation', async (name) => {
    const f = await reportFixture()
    await f.grant()
    const response = await rawReport(f, invalid[name](f.report()))
    expect(response.status).toBe(400)
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  })
  it('rejects duplicate nested PR fields and permits harmless string braces/escaped quotes', async () => {
    const f = await reportFixture()
    await f.grant()
    const raw = JSON.stringify({
      ...f.report(),
      outcome: {
        state: 'closed',
        pr: { number: 1, url: 'https://code.example/pr/1', head: 'a'.repeat(40) },
      },
    })
    expect(
      (await rawReport(f, raw.replace('"number":1', '"number":1,"num\\u0062er":1')))
        .status,
    ).toBe(400)
    const valid = {
      ...f.report(),
      outcome: {
        state: 'conflict',
        detail: 'literal {braces}, "quote", \\slash and café',
      },
    }
    expect((await rawReport(f, ' \n' + JSON.stringify(valid) + '\r\n')).status).toBe(
      200,
    )
  })
  it.each([
    'text/plain',
    'application/json; charset=latin1',
    'application/json; extra=one',
    '',
  ])('rejects unsupported media %s', async (media) => {
    const f = await reportFixture()
    await f.grant()
    expect(
      (await rawReport(f, JSON.stringify(f.report()), { 'content-type': media }))
        .status,
    ).toBe(415)
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  })
  it('refuses encoded content and malformed UTF8; handles a missing body', async () => {
    const f = await reportFixture()
    await f.grant()
    expect(
      (await rawReport(f, JSON.stringify(f.report()), { 'content-encoding': 'gzip' }))
        .status,
    ).toBe(415)
    expect(
      (await rawReport(f, new Uint8Array([123, 34, 255, 34, 58, 49, 125]))).status,
    ).toBe(400)
    expect((await rawReport(f, null)).status).toBe(400)
  })
  it('accepts exactly64KiB with whitespace, ignoring misleading larger Content-Length', async () => {
    const f = await reportFixture()
    await f.grant()
    const raw = JSON.stringify(f.report())
    expect(
      (
        await rawReport(
          f,
          raw + ' '.repeat(65_536 - new TextEncoder().encode(raw).length),
          { 'content-length': '90000' },
        )
      ).status,
    ).toBe(200)
  })
  it('bounds actual multibyte streamed bytes and cancels the unfinished stream', async () => {
    const f = await reportFixture()
    await f.grant()
    const cancel = vi.fn(),
      bytes = new TextEncoder().encode('é'.repeat(32_769))
    let n = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes.subarray(n, n + 8192))
        n += 8192
      },
      cancel,
    })
    const response = await rawReport(f, stream, { 'content-length': '1' })
    expect(response.status).toBe(413)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  })
  it('accepts valid JSON split across UTF8/codepoint and token boundaries', async () => {
    const f = await reportFixture()
    await f.grant()
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ...f.report(),
        outcome: { state: 'conflict', detail: 'café fixture' },
      }),
    )
    let n = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n === bytes.length) c.close()
        else {
          const byte = bytes.slice(n, n + 1)
          n++
          c.enqueue(byte)
        }
      },
    })
    expect(
      (
        await rawReport(f, stream, {
          'content-type': 'Application/JSON; charset="UTF-8"',
        })
      ).status,
    ).toBe(200)
  })
  it('bounds empty chunk churn and cancels without a receipt', async () => {
    const f = await reportFixture()
    await f.grant()
    const cancel = vi.fn(),
      stream = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new Uint8Array())
        },
        cancel,
      })
    expect((await rawReport(f, stream)).status).toBe(400)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it.each(['pr_open', 'conflict', 'apply_failed', 'merged', 'closed'])(
    'uses the shared command schema for %s',
    async (state) => {
      const f = await reportFixture()
      await f.grant()
      const pr = { number: 1, url: 'https://code.example/pr/1', head: 'a'.repeat(40) }
      const outcome =
        state === 'pr_open'
          ? { state, pr, checks: 'pending', detail: null }
          : state === 'merged'
            ? { state, pr, mergeCommit: 'b'.repeat(40) }
            : state === 'closed'
              ? { state, pr }
              : { state, detail: 'offline fixture' }
      const response = await rawReport(f, JSON.stringify({ ...f.report(), outcome }))
      expect(response.status).toBe(200)
      expect((await response.json()).ack.state).toBe(state)
    },
  )
})

describe('report transport authority and result taxonomy', () => {
  it('rechecks grant authority after bearer verification without leaking targets', async () => {
    const f = await reportFixture()
    await f.grant()
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.includes('LIMIT 2'))
        f.h.database.execute('UPDATE margin_adapter_report_grants SET revoked_at=?', [
          AT,
        ])
      return rows
    })
    expect((await f.requestReport(REPORTS, 'POST', f.report())).status).toBe(403)
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  })
  it('returns generic forbidden for foreign and missing targets and scoped404 for receipts', async () => {
    const f = await reportFixture()
    await f.grant()
    await f.token(OTHER, 2)
    const foreign = await f.approve(OTHER + '/books/example/')
    for (const id of [foreign.id, 'missing']) {
      const response = await f.requestReport(REPORTS, 'POST', {
        ...f.report(),
        proposalId: id,
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'adapter_forbidden' } })
    }
    const missing = await f.requestReport(
      '/api/margin/v1/adapter/receipts/' + reportEvent(12),
      'GET',
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: 'receipt_not_found' } })
  })
  it('returns not-evaluated for a historical missing execution row without defaulting counts', async () => {
    const f = await reportFixture()
    await f.grant()
    f.h.database.execute('DROP TRIGGER margin_execution_initialize')
    const legacy = await f.approve()
    const response = await f.requestReport(REPORTS, 'POST', {
      ...f.report(),
      proposalId: legacy.id,
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'execution_not_evaluated' },
    })
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  })
  it('classifies a malformed committed RETURNING as storage503, never input400', async () => {
    const f = await reportFixture()
    await f.grant()
    const query = f.h.database.query.bind(f.h.database)
    const spy = vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      return sql.startsWith('INSERT INTO margin_adapter_report_receipts')
        ? [{ ...rows[0], extra: 'private fixture diagnostic' }]
        : rows
    })
    const response = await f.requestReport(REPORTS, 'POST', f.report())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'storage_unavailable' } })
    spy.mockRestore()
    expect(
      (
        await f.requestReport(
          '/api/margin/v1/adapter/receipts/' + reportEvent(1),
          'GET',
        )
      ).status,
    ).toBe(200)
    expect(
      f.h.database.query('SELECT * FROM margin_adapter_report_receipts'),
    ).toHaveLength(1)
  })
  it('rejects unknown/duplicate query keys before report or receipt repository work', async () => {
    const f = await reportFixture()
    await f.grant()
    for (const suffix of ['?extra=1', '?eventId=one&eventId=two']) {
      expect((await f.requestReport(REPORTS + suffix, 'POST', f.report())).status).toBe(
        400,
      )
      expect(
        (
          await f.requestReport(
            '/api/margin/v1/adapter/receipts/' + reportEvent(1) + suffix,
            'GET',
          )
        ).status,
      ).toBe(400)
    }
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
  })
})

import { D1MarginRepository } from './d1-repository'
import {
  adapterExecutionReportSchema,
  adapterSelectorSchema as sharedSelector,
  canonicalSegment as sharedSegment,
} from './repository'
import {
  adapterSelectorSchema as transportSelector,
  canonicalSegment as transportSegment,
} from './adapter'

describe('transport result and module contracts', () => {
  it('shares the command and selector implementation without a duplicate decoder', async () => {
    expect(sharedSelector).toBe(transportSelector)
    expect(sharedSegment).toBe(transportSegment)
    const f = await reportFixture()
    expect(adapterExecutionReportSchema.parse(f.report())).toEqual(f.report())
    expect(
      adapterExecutionReportSchema.safeParse({ ...f.report(), site: SITE }).success,
    ).toBe(false)
  })
  it.each(['precommit', 'unexpected', 'malformed-ack', 'unknown-ack-key'])(
    'returns storage503 for %s without exposing diagnostics',
    async (kind) => {
      const f = await reportFixture()
      await f.grant()
      const replacement =
        kind === 'unexpected'
          ? { status: 'missing' }
          : kind === 'malformed-ack'
            ? { status: 'accepted', ack: {} }
            : {
                status: 'accepted',
                ack: {
                  eventId: reportEvent(1),
                  proposalId: f.proposal.id,
                  approvedRevision: 1,
                  stateVersion: 1,
                  failedApplyCount: 1,
                  state: 'apply_failed',
                  acceptedAt: AT,
                  extra: 'private fixture diagnostic',
                },
              }
      const spy = vi.spyOn(D1MarginRepository.prototype, 'reportProposalExecution')
      if (kind === 'precommit')
        spy.mockRejectedValue(Error('private fixture diagnostic'))
      else spy.mockResolvedValue(replacement as any)
      const response = await f.requestReport(REPORTS, 'POST', f.report())
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'storage_unavailable' } })
      expect(
        f.h.database.query('SELECT * FROM margin_adapter_report_receipts'),
      ).toEqual([])
    },
  )
  it('does not map unexpected receipt states to report errors', async () => {
    const f = await reportFixture()
    await f.grant()
    vi.spyOn(
      D1MarginRepository.prototype,
      'readAdapterReportReceipt',
    ).mockResolvedValue({ status: 'conflict' })
    const response = await f.requestReport(
      '/api/margin/v1/adapter/receipts/' + reportEvent(1),
      'GET',
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'storage_unavailable' } })
  })
})

it.each([
  { order: ['repository', 'adapter', 'd1', 'worker'] },
  { order: ['adapter', 'd1', 'repository', 'worker'] },
  { order: ['d1', 'worker', 'adapter', 'repository'] },
])('initializes a fresh module graph in entry order $order', async ({ order }) => {
  vi.resetModules()
  const loaders = {
    repository: () => import('./repository'),
    adapter: () => import('./adapter'),
    d1: () => import('./d1-repository'),
    worker: () => import('../index'),
  }
  for (const name of order) await loaders[name as keyof typeof loaders]()
  const shared = await import('./repository'),
    transport = await import('./adapter')
  expect(shared.adapterSelectorSchema).toBe(transport.adapterSelectorSchema)
  expect(
    shared.adapterExecutionReportSchema.safeParse({
      eventId: reportEvent(1),
      proposalId: 'fixture',
      approvedRevision: 1,
      expectedStateVersion: 0,
      outcome: { state: 'conflict', detail: 'fixture' },
    }).success,
  ).toBe(true)
  expect(typeof (await import('./d1-repository')).D1MarginRepository).toBe('function')
})

const WORK = '/api/margin/v1/adapter/work'
describe('known execution work RED pilots', () => {
  it('requires current report authority while keeping the immutable feed unchanged', async () => {
    const f = await reportFixture()
    expect((await f.call(f.value)).status).toBe(200)
    expect((await f.requestReport(WORK, 'GET')).status).toBe(403)
    await f.grant()
    const response = await f.requestReport(WORK, 'GET')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      eligibility: 'known_execution',
      scanned: 1,
      notEvaluated: { unknownExecution: 0 },
      excluded: { exhaustedFailures: 0, otherAdapter: 0 },
      items: [
        {
          proposalId: f.proposal.id,
          work: 'apply',
          execution: {
            state: 'approved',
            stateVersion: 0,
            failedApplyCount: 0,
            pr: null,
            lastEvent: null,
          },
        },
      ],
      nextCursor: null,
    })
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.includes('LIMIT 2'))
        f.h.database.execute('UPDATE margin_adapter_report_grants SET revoked_at=?', [
          AT,
        ])
      return rows
    })
    expect((await f.requestReport(WORK, 'GET')).status).toBe(403)
    expect((await f.call(f.value)).status).toBe(200)
  })
  it('classifies cumulative failure and known PR states from immutable approval only', async () => {
    const f = await reportFixture()
    await f.grant()
    await f.h.request(
      'PATCH',
      `/annotations/${f.proposal.id}${scopeQuery(f.proposal.source)}`,
      {
        as: BOB,
        body: { body: proposalBody('New {++current++}.') },
      },
    )
    const initial = await f.requestReport(WORK, 'GET')
    expect(initial.status).toBe(200)
    expect((await initial.json()).items[0]).toMatchObject({
      body: proposalBody(),
      approvedRevision: 1,
      work: 'apply',
    })
    let version = 0
    const send = async (outcome: unknown) => {
      const r = await f.requestReport(REPORTS, 'POST', {
        ...f.report(++version),
        expectedStateVersion: version - 1,
        outcome,
      })
      expect(r.status).toBe(200)
      const page = await f.requestReport(WORK, 'GET')
      expect(page.status).toBe(200)
      return page.json()
    }
    for (let n = 1; n <= 3; n++) {
      const page = await send({ state: 'apply_failed', detail: 'offline failure' })
      expect(page.excluded.exhaustedFailures).toBe(n === 3 ? 1 : 0)
      expect(page.items.map((x: any) => x.work)).toEqual(n === 3 ? [] : ['apply'])
    }
    expect(
      (await send({ state: 'conflict', detail: 'offline conflict' })).items[0].work,
    ).toBe('reconcile_only')
    const pr = { number: 4, url: 'https://code.example/pr/4', head: 'c'.repeat(40) }
    expect(
      (await send({ state: 'pr_open', pr, checks: 'not_evaluated', detail: null }))
        .items[0],
    ).toMatchObject({ work: 'refresh_pr', execution: { failedApplyCount: 3, pr } })
    expect(
      (await send({ state: 'conflict', detail: 'retain known PR' })).items[0],
    ).toMatchObject({ work: 'refresh_pr', execution: { failedApplyCount: 3, pr } })
    expect((await send({ state: 'closed', pr })).items).toEqual([])
  })
  it('advances an empty legacy page and rejects feed or another token cursor', async () => {
    const f = await reportFixture()
    await f.grant()
    f.h.database.execute('DROP TRIGGER margin_execution_initialize')
    await f.approve(
      SITE + '/legacy/',
      'private',
      proposalBody(),
      '2020-01-01T00:00:00.000Z',
    )
    const first = await f.requestReport(WORK + '?limit=1', 'GET')
    expect(first.status).toBe(200)
    const page = await first.json()
    expect(page).toMatchObject({
      items: [],
      scanned: 1,
      notEvaluated: { unknownExecution: 1 },
    })
    expect(page.nextCursor).toEqual(expect.any(String))
    const next = await f.requestReport(
      WORK + '?limit=1&cursor=' + page.nextCursor,
      'GET',
    )
    expect(next.status).toBe(200)
    expect((await next.json()).items[0].proposalId).toBe(f.proposal.id)
    const feed = await (await f.call(f.value, '?limit=1')).json()
    expect(
      (await f.requestReport(WORK + '?cursor=' + feed.nextCursor, 'GET')).status,
    ).toBe(400)
    const otherToken = await f.token(SITE, 8)
    expect(
      (
        await f.requestReport(
          WORK + '?cursor=' + page.nextCursor,
          'GET',
          undefined,
          otherToken,
        )
      ).status,
    ).toBe(400)
  })
  it('rejects malformed execution in lookahead before classifying any rows', async () => {
    const f = await reportFixture()
    await f.grant()
    await f.approve()
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.includes('margin_proposal_execution') && rows.length === 3) {
        rows[2] = { ...rows[2], execution: JSON.stringify({ malformed: true }) }
      }
      return rows
    })
    expect((await f.requestReport(WORK + '?limit=1', 'GET')).status).toBe(503)
  })
})

function alterWorkRows(
  f: Awaited<ReturnType<typeof reportFixture>>,
  alter: (rows: Record<string, any>[]) => Record<string, any>[],
) {
  const query = f.h.database.query.bind(f.h.database)
  return vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
    const rows = query(sql, params)
    return sql.includes('page AS') && sql.includes('margin_proposal_execution')
      ? alter(rows)
      : rows
  })
}
function workState(
  row: Record<string, any>,
  state: string,
  count: number,
  hasPR: boolean,
) {
  const e = JSON.parse(row.execution)
  Object.assign(e, {
    state_version: state === 'approved' ? 0 : Math.max(1, count),
    failed_apply_count: count,
    bound_adapter: state === 'approved' ? null : 'fixture-adapter',
    last_event: state === 'approved' ? null : reportEvent(3),
    pr_number: hasPR ? 4 : null,
    pr_url: hasPR ? 'https://code.example/pr/4' : null,
    pr_head: hasPR ? 'd'.repeat(40) : null,
    merge_commit: null,
    checks: state === 'pr_open' ? 'passed' : hasPR ? 'not_evaluated' : null,
    detail: ['conflict', 'apply_failed'].includes(state) ? 'offline detail' : null,
  })
  return { ...row, state, execution: JSON.stringify(e) }
}

describe('work projection invariant sweep', () => {
  const states = [
    { state: 'approved', count: 0, pr: false, work: 'apply' },
    ...[0, 1, 2, 3].flatMap((count) => [
      { state: 'pr_open', count, pr: true, work: 'refresh_pr' },
      { state: 'conflict', count, pr: true, work: 'refresh_pr' },
      {
        state: 'conflict',
        count,
        pr: false,
        work: count === 3 ? 'reconcile_only' : 'apply',
      },
    ]),
    ...[1, 2, 3].map((count) => ({
      state: 'apply_failed',
      count,
      pr: false,
      work: count === 3 ? null : 'apply',
    })),
  ]
  it.each(states)(
    'classifies $state count$count PR$pr',
    async ({ state, count, pr, work }) => {
      const f = await reportFixture()
      await f.grant()
      alterWorkRows(f, (rows) => [rows[0], workState(rows[1], state, count, pr)])
      const response = await f.requestReport(WORK, 'GET')
      expect(response.status).toBe(200)
      const page = await response.json()
      expect(page.items.map((x: any) => x.work)).toEqual(work ? [work] : [])
      expect(page.excluded.exhaustedFailures).toBe(work ? 0 : 1)
      if (work) {
        expect(page.items[0].execution).toMatchObject({
          state,
          failedApplyCount: count,
        })
        expect(page.items[0].execution).not.toHaveProperty('boundAdapter')
      }
    },
  )
  const invalid: Record<string, (e: Record<string, any>) => void> = {
    'unknown column': (e) => {
      e.extra = true
    },
    'foreign site': (e) => {
      e.site = OTHER
    },
    'other proposal': (e) => {
      e.proposal_id = 'another'
    },
    'other revision': (e) => {
      e.approved_revision = 2
    },
    'boolean count': (e) => {
      e.failed_apply_count = false
    },
    'fraction version': (e) => {
      e.state_version = 0.5
    },
    'unsafe version': (e) => {
      e.state_version = Number.MAX_SAFE_INTEGER + 1
    },
    'excess count': (e) => {
      e.failed_apply_count = 4
    },
    'partial PR': (e) => {
      e.pr_url = 'https://code.example/pr/1'
    },
    'empty stamp': (e) => {
      e.updated_at = ''
    },
    'initial timestamp mismatch': (e) => {
      e.updated_at = AT
    },
    'initial bound adapter': (e) => {
      e.bound_adapter = 'other-adapter'
    },
    'initial last event': (e) => {
      e.last_event = reportEvent(2)
    },
    'initial detail': (e) => {
      e.detail = 'unexpected'
    },
    'initial checks': (e) => {
      e.checks = 'passed'
    },
    'initial merge': (e) => {
      e.merge_commit = 'a'.repeat(40)
    },
  }
  it.each(Object.entries(invalid).map(([name, mutate]) => ({ name, mutate })))(
    'refuses $name in selected and lookahead before exclusion',
    async ({ mutate }) => {
      for (const position of [1, 2]) {
        const f = await reportFixture()
        await f.grant()
        await f.approve()
        const spy = alterWorkRows(f, (rows) => {
          const e = JSON.parse(rows[position].execution)
          mutate(e)
          return rows.map((row, i) =>
            i === position ? { ...row, execution: JSON.stringify(e) } : row,
          )
        })
        const response = await f.requestReport(WORK + '?limit=1', 'GET')
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
          error: { code: 'storage_unavailable' },
        })
        spy.mockRestore()
      }
    },
  )
  it.each([
    'scope',
    'body',
    'unknown',
    'terminal',
    'duplicate',
    'reverse',
    'absent-authority',
    'false-authority-with-data',
    'extra-authority',
    'excess-rows',
    'bad-execution-json',
  ])('refuses invalid candidate envelope %s', async (kind) => {
    const f = await reportFixture()
    await f.grant()
    await f.approve()
    alterWorkRows(f, (rows) => {
      if (kind === 'scope') rows[1].site = OTHER
      if (kind === 'body') rows[1].body = 'not structured hunks'
      if (kind === 'unknown') rows[1].extra = true
      if (kind === 'terminal') rows[1].state = 'merged'
      if (kind === 'duplicate') rows[2] = { ...rows[1] }
      if (kind === 'reverse') [rows[1], rows[2]] = [rows[2], rows[1]]
      if (kind === 'absent-authority') rows.shift()
      if (kind === 'false-authority-with-data') rows[0].authorized = 0
      if (kind === 'extra-authority') rows[0].execution = '{}'
      if (kind === 'excess-rows') return [...rows, rows[1]]
      if (kind === 'bad-execution-json') rows[2].execution = '{'
      return rows
    })
    expect((await f.requestReport(WORK + '?limit=1', 'GET')).status).toBe(503)
  })
  it('excludes a valid other-adapter binding without cross-site rows or counters', async () => {
    const f = await reportFixture()
    await f.grant()
    await f.token(OTHER, 2)
    await f.approve(OTHER + '/private/')
    const spy = alterWorkRows(f, (rows) => {
      const item = workState(rows[1], 'conflict', 3, false),
        e = JSON.parse(item.execution)
      e.bound_adapter = 'another-valid-adapter'
      item.execution = JSON.stringify(e)
      return [rows[0], item]
    })
    const page = await (await f.requestReport(WORK, 'GET')).json()
    expect(page).toMatchObject({
      items: [],
      scanned: 1,
      excluded: { otherAdapter: 1, exhaustedFailures: 0 },
      notEvaluated: { unknownExecution: 0 },
    })
    spy.mockRestore()
    f.h.database.executed.length = 0
    expect((await f.requestReport(WORK, 'GET')).status).toBe(200)
    expect(f.h.database.executed).toHaveLength(2)
    expect(f.h.database.executed[1].sql).toContain('a.site=p.site')
    expect(f.h.database.executed[1].sql).toContain('margin_adapter_report_grants')
    expect(f.h.database.executed[1].sql).not.toContain('margin_annotations')
    expect(f.h.database.executed[1].params).toContain(SITE)
  })
  it('bounds the entire candidate result and recovers with a smaller limit without truncation', async () => {
    const f = await reportFixture()
    await f.grant()
    const body = proposalBody('{++' + '界'.repeat(60_000) + '++}')
    for (let n = 0; n < 24; n++) await f.approve(SITE + '/large/' + n, 'private', body)
    const tooLarge = await f.requestReport(WORK + '?limit=25', 'GET')
    expect(tooLarge.status).toBe(503)
    expect(await tooLarge.json()).toEqual({ error: { code: 'storage_unavailable' } })
    const smaller = await f.requestReport(WORK + '?limit=1', 'GET')
    expect(smaller.status).toBe(200)
    const page = await smaller.json()
    expect(page.scanned).toBe(1)
    expect(page.nextCursor).toEqual(expect.any(String))
    const next = await f.requestReport(
      WORK + '?limit=1&cursor=' + page.nextCursor,
      'GET',
    )
    expect(next.status).toBe(200)
    expect((await next.json()).items[0].body).toBe(body)
  })
  it.each([
    '?limit=0',
    '?limit=51',
    '?limit=01',
    '?limit=1.0',
    '?limit=-1',
    '?cursor=',
    '?limit=1&limit=1',
    '?cursor=x&cursor=y',
    '?site=x',
    '?cursor=' + 'a'.repeat(32769),
    '?extra=' + 'a'.repeat(40001),
  ])('rejects bounded query %s', async (suffix) => {
    const f = await reportFixture()
    await f.grant()
    f.h.database.executed.length = 0
    expect((await f.requestReport(WORK + suffix, 'GET')).status).toBe(400)
    expect(f.h.database.executed).toHaveLength(1)
  })
  it('validates canonical cursor shape, scope, and UTF8 BINARY ordering', async () => {
    const f = await reportFixture()
    await f.grant()
    await f.approve()
    const page = await (await f.requestReport(WORK + '?limit=1', 'GET')).json()
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(page.nextCursor.replace(/-/g, '+').replace(/_/g, '/')),
          (c) => c.charCodeAt(0),
        ),
      ),
    )
    for (const patch of [
      { version: 2 },
      { purpose: 'approved' },
      { site: OTHER },
      { adapter: 'other' },
      { tokenId: reportEvent(44) },
      { extra: true },
    ]) {
      const cursor = encodeBase64Url(
        new TextEncoder().encode(JSON.stringify({ ...decoded, ...patch })),
      )
      expect((await f.requestReport(WORK + '?cursor=' + cursor, 'GET')).status).toBe(
        400,
      )
    }
    for (const raw of [
      JSON.stringify(decoded).replace('{', '{"version":1,'),
      JSON.stringify(decoded, null, 2),
    ]) {
      expect(
        (
          await f.requestReport(
            WORK + '?cursor=' + encodeBase64Url(new TextEncoder().encode(raw)),
            'GET',
          )
        ).status,
      ).toBe(400)
    }
    const spy = alterWorkRows(f, (rows) =>
      rows.map((r, i) => {
        if (!i) return r
        const e = JSON.parse(r.execution),
          id = i === 1 ? '\uE000' : '\u{10000}'
        return {
          ...r,
          proposal_id: id,
          approved_at: AT,
          execution: JSON.stringify({ ...e, proposal_id: id, updated_at: AT }),
        }
      }),
    )
    const ordered = await f.requestReport(WORK, 'GET')
    expect(ordered.status).toBe(200)
    expect((await ordered.json()).items.map((x: any) => x.proposalId)).toEqual([
      '\uE000',
      '\u{10000}',
    ])
    spy.mockRestore()
  })
})

import { createApprovedWorkClient } from '../../../adapters/margin/service-client'
const CORRELATION_WORK = '/api/margin/v1/adapter/work'
const correlationBindings = {
  MARGIN_PUBLIC_CORRELATION_KEY: encodeBase64Url(new Uint8Array(32).fill(23)),
  MARGIN_PUBLIC_CORRELATION_KEY_ID: 'delivery-fixture',
}
async function correlationFixture() {
  const f = await fixture(),
    token = await f.token()
  f.h.database.execute(
    'INSERT INTO margin_adapter_report_grants(token_id,token_sha256,site,adapter,granted_at,revoked_at) SELECT token_id,token_sha256,site,adapter,created_at,NULL FROM margin_adapter_tokens',
  )
  const credential = (await f.h.repository.findAdapterCredential(
    token.split('.')[1],
  ))!
  const call = (
    suffix = '?include=publicCorrelation',
    bindings: Record<string, unknown> = correlationBindings,
  ) =>
    worker.fetch(
      new Request(SITE + CORRELATION_WORK + suffix, {
        headers: { authorization: 'Bearer ' + token },
      }),
      {
        ASSETS: { fetch: async () => new Response('asset') },
        MARGIN_DB: f.h.database,
        ...bindings,
      },
    )
  const client = (bindings: Record<string, unknown> = correlationBindings) =>
    createApprovedWorkClient({ origin: SITE, token }, async (input, init) =>
      worker.fetch(new Request(input, init), {
        ASSETS: { fetch: async () => new Response('asset') },
        MARGIN_DB: f.h.database,
        ...bindings,
      }),
    )
  return { ...f, token, credential, call, client }
}
describe('explicit correlation delivery initial behavioral RED families', () => {
  it('round-trips actual Worker/SQLite/client while default wire and keyless recovery stay unchanged', async () => {
    const f = await correlationFixture()
    await f.approve()
    const before = await (await f.call('', {})).text()
    const client = f.client()
    const enriched = await client.readPage({
      include: 'publicCorrelation',
    } as any)
    expect(enriched.status).toBe('ready')
    expect((enriched as any).page.publicCorrelation).toBe('v1')
    expect((enriched as any).page.items[0].publicCorrelation).toEqual({
      version: 1,
      value: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(await (await f.call('', {})).text()).toBe(before)
    const retired = f.client({})
    expect(
      await retired.readPage({ include: 'publicCorrelation' } as any),
    ).toEqual(enriched)
    client.dispose()
    retired.dispose()
  })
  it('bounds opt-in to ten with real lookahead and 33 SQL/10 HMAC while ordinary50 still works', async () => {
    const f = await correlationFixture()
    for (let i = 0; i < 11; i++) await f.approve()
    const sign = vi.spyOn(crypto.subtle, 'sign')
    f.h.database.executed.length = 0
    const r = await f.call()
    expect(r.status).toBe(200)
    const page = await r.json()
    expect(page.items).toHaveLength(10)
    expect(page.scanned).toBe(10)
    expect(page.nextCursor).not.toBeNull()
    expect(f.h.database.executed).toHaveLength(33)
    expect(sign).toHaveBeenCalledTimes(10)
    expect((await f.call('?include=publicCorrelation&limit=11')).status).toBe(
      400,
    )
    expect((await f.call('?limit=50', {})).status).toBe(200)
  })
  it('returns no partial page when a later eligible item cannot issue without a key', async () => {
    const f = await correlationFixture(),
      a = await f.approve()
    await f.approve()
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(23),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    expect(
      (
        await f.h.repository.getOrIssuePublicCorrelation(
          f.credential,
          { proposalId: a.id, approvedRevision: 1 },
          { keyId: 'delivery-fixture', key },
        )
      ).status,
    ).toBe('ready')
    const r = await f.call('?include=publicCorrelation', {})
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({
      error: { code: 'public_correlation_unavailable' },
    })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toHaveLength(1)
  })
  it('rechecks complete real execution projection after signing before returning a page', async () => {
    const f = await correlationFixture(),
      a = await f.approve(),
      b = await f.approve()
    const original = crypto.subtle.sign.bind(crypto.subtle)
    let n = 0
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      const value = await original(...args)
      if (++n === 2)
        expect(
          (
            await f.h.repository.reportProposalExecution(
              f.credential,
              {
                eventId: encodeBase64Url(new Uint8Array(16).fill(91)),
                proposalId: a.id,
                approvedRevision: 1,
                expectedStateVersion: 0,
                outcome: {
                  state: 'apply_failed',
                  detail: 'synthetic changed projection',
                },
              },
              AT,
            )
          ).status,
        ).toBe('accepted')
      return value
    })
    const r = await f.call()
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({
      error: { code: 'public_correlation_page_changed' },
    })
    expect(b.id).not.toBe(a.id)
  })
  it('honors one page deadline and rejects late signing with no partial response', async () => {
    const f = await correlationFixture()
    await f.approve()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const original = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      const value = await original(...args)
      now = 10000
      return value
    })
    const r = await f.call()
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({
      error: { code: 'public_correlation_deadline' },
    })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toHaveLength(0)
  })
})

function observeWorkFinal(
  transform: (
    page: Awaited<ReturnType<D1MarginRepository['listAdapterWork']>>,
  ) => void,
) {
  const original = D1MarginRepository.prototype.listAdapterWork
  let calls = 0
  return vi
    .spyOn(D1MarginRepository.prototype, 'listAdapterWork')
    .mockImplementation(async function (this: D1MarginRepository, c, o) {
      const page = await original.call(this, c, o)
      if (++calls === 2) transform(page)
      return page
    })
}
describe('explicit correlation delivery boundary sweep', () => {
  it('returns an explicitly marked empty page with three SQL and no key import/signing', async () => {
    const f = await correlationFixture(),
      imported = vi.spyOn(crypto.subtle, 'importKey'),
      sign = vi.spyOn(crypto.subtle, 'sign')
    f.h.database.executed.length = 0
    const r = await f.call()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      eligibility: 'known_execution',
      items: [],
      nextCursor: null,
      scanned: 0,
      notEvaluated: { unknownExecution: 0 },
      excluded: { exhaustedFailures: 0, otherAdapter: 0 },
      publicCorrelation: 'v1',
    })
    expect(f.h.database.executed).toHaveLength(3)
    expect(imported).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
  for (const suffix of [
    '?include=wrong',
    '?include=',
    '?include=publicCorrelation&include=publicCorrelation',
    '?include=publicCorrelation&limit=11',
    '?include=publicCorrelation&limit=50',
    '?include=publicCorrelation&limit=01',
    '?include=publicCorrelation&limit=1.0',
    '?include=publicCorrelation&limit=0',
    '?include=publicCorrelation&limit=1&limit=1',
    '?include=publicCorrelation&other=yes',
  ])
    it(
      'refuses malformed opt-in query before page SQL/crypto ' + suffix,
      async () => {
        const f = await correlationFixture(),
          list = vi.spyOn(D1MarginRepository.prototype, 'listAdapterWork'),
          imported = vi.spyOn(crypto.subtle, 'importKey')
        const r = await f.call(suffix)
        expect(r.status).toBe(400)
        expect(await r.json()).toEqual({
          error: { code: 'invalid_work_query' },
        })
        expect(list).not.toHaveBeenCalled()
        expect(imported).not.toHaveBeenCalled()
      },
    )
  for (const bindings of [
    {},
    {
      MARGIN_PUBLIC_CORRELATION_KEY: 'bad',
      MARGIN_PUBLIC_CORRELATION_KEY_ID: 'valid',
    },
    {
      ...correlationBindings,
      MARGIN_PUBLIC_CORRELATION_KEY:
        correlationBindings.MARGIN_PUBLIC_CORRELATION_KEY + '=',
    },
    { ...correlationBindings, MARGIN_PUBLIC_CORRELATION_KEY_ID: 1 },
    { ...correlationBindings, MARGIN_PUBLIC_CORRELATION_KEY_ID: 'bad space' },
  ])
    it(
      'missing or malformed service binding keeps ordinary bytes and existing correlation usable ' +
        JSON.stringify(Object.keys(bindings)),
      async () => {
        const f = await correlationFixture()
        await f.approve()
        const before = await (await f.call('', {})).text()
        expect(
          (await f.call('?include=publicCorrelation', bindings)).status,
        ).toBe(503)
        expect(await (await f.call('', bindings)).text()).toBe(before)
        const ready = await (await f.call()).text()
        expect(
          await (await f.call('?include=publicCorrelation', bindings)).text(),
        ).toBe(ready)
      },
    )
  it('imports one nonextractable sign-only key, retains first value across configured rotation', async () => {
    const f = await correlationFixture()
    await f.approve()
    await f.approve()
    const imported = vi.spyOn(crypto.subtle, 'importKey'),
      sign = vi.spyOn(crypto.subtle, 'sign')
    const first = await (await f.call()).text()
    expect(imported).toHaveBeenCalledTimes(1)
    expect(imported.mock.calls[0].slice(2)).toEqual([
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ])
    expect(sign).toHaveBeenCalledTimes(2)
    expect(
      await (
        await f.call('?include=publicCorrelation', {
          MARGIN_PUBLIC_CORRELATION_KEY: encodeBase64Url(
            new Uint8Array(32).fill(24),
          ),
          MARGIN_PUBLIC_CORRELATION_KEY_ID: 'rotated',
        })
      ).text(),
    ).toBe(first)
    expect(sign).toHaveBeenCalledTimes(2)
  })
  it('does not accept key material from the request or echo a failed key import', async () => {
    const f = await correlationFixture()
    await f.approve()
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(
      Error('private fixture key detail'),
    )
    const r = await f.call()
    expect(r.status).toBe(503)
    expect(await r.text()).toBe(
      '{"error":{"code":"public_correlation_unavailable"}}\n',
    )
    expect(
      (await f.call('?include=publicCorrelation&key=untrusted')).status,
    ).toBe(400)
  })
  it('retains count/cursor semantics across unknown rows and reuses default cursors without a new mode', async () => {
    const f = await correlationFixture()
    const initializer = f.h.database.query(
      "SELECT sql FROM sqlite_master WHERE name='margin_execution_initialize'",
    )[0].sql as string
    f.h.database.execute('DROP TRIGGER margin_execution_initialize')
    await f.approve()
    f.h.database.execute(initializer)
    await f.approve()
    await f.approve()
    const ordinary = await (await f.call('?limit=2', {})).json(),
      enriched = await (
        await f.call('?include=publicCorrelation&limit=2')
      ).json()
    expect(enriched.scanned).toBe(2)
    expect(enriched.notEvaluated).toEqual({ unknownExecution: 1 })
    expect(enriched.items).toHaveLength(1)
    expect(enriched.nextCursor).toBe(ordinary.nextCursor)
    expect(
      (
        await f.call(
          '?include=publicCorrelation&limit=2&cursor=' + ordinary.nextCursor,
        )
      ).status,
    ).toBe(200)
    expect(
      (await f.call('?limit=2&cursor=' + enriched.nextCursor, {})).status,
    ).toBe(200)
  })
  it('does not backfill already-active legacy execution or expose an earlier item/cursor', async () => {
    const f = await correlationFixture()
    await f.approve()
    const b = await f.approve()
    expect(
      (
        await f.h.repository.reportProposalExecution(
          f.credential,
          {
            eventId: encodeBase64Url(new Uint8Array(16).fill(87)),
            proposalId: b.id,
            approvedRevision: 1,
            expectedStateVersion: 0,
            outcome: { state: 'apply_failed', detail: 'existing activity' },
          },
          AT,
        )
      ).status,
    ).toBe('accepted')
    const r = await f.call()
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({
      error: { code: 'public_correlation_legacy_unavailable' },
    })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toHaveLength(1)
    expect((await f.call('', {})).status).toBe(200)
  })
  for (const revoke of [
    'DELETE FROM margin_adapter_report_grants',
    'UPDATE margin_adapters SET enabled=0',
    'UPDATE margin_adapter_tokens SET revoked_at=created_at',
  ])
    it(
      'requires fresh final authority even for an already-issued item: ' +
        revoke,
      async () => {
        const f = await correlationFixture()
        await f.approve()
        expect((await f.call()).status).toBe(200)
        const original = D1MarginRepository.prototype.listAdapterWork
        let n = 0
        vi.spyOn(
          D1MarginRepository.prototype,
          'listAdapterWork',
        ).mockImplementation(async function (this: D1MarginRepository, c, o) {
          if (++n === 2) f.h.database.execute(revoke)
          return original.call(this, c, o)
        })
        const r = await f.call()
        expect(r.status).toBe(403)
        expect(await r.json()).toEqual({ error: { code: 'adapter_forbidden' } })
      },
    )
  const changes: Record<string, (p: any) => void> = {
    proposalId: (p) => (p.candidates[0].proposalId += 'changed'),
    site: (p) => (p.candidates[0].site = OTHER),
    document: (p) => (p.candidates[0].document += '#new'),
    source: (p) => (p.candidates[0].source += '#new'),
    approvedRevision: (p) => p.candidates[0].approvedRevision++,
    body: (p) => (p.candidates[0].body += ' '),
    baseCommit: (p) => (p.candidates[0].baseCommit = 'f'.repeat(40)),
    sourcePath: (p) => (p.candidates[0].sourcePath = 'different.md'),
    visibility: (p) => (p.candidates[0].visibility = 'public'),
    approvedAt: (p) => (p.candidates[0].approvedAt = AT),
    'execution-state': (p) => (p.candidates[0].execution.state = 'conflict'),
    'execution-version': (p) => p.candidates[0].execution.stateVersion++,
    'execution-count': (p) => p.candidates[0].execution.failedApplyCount++,
    'execution-bound': (p) =>
      (p.candidates[0].execution.boundAdapter = 'changed'),
    'execution-pr': (p) =>
      (p.candidates[0].execution.pr = {
        number: 1,
        url: 'https://example.org/pr/1',
        head: 'a'.repeat(40),
      }),
    'execution-checks': (p) => (p.candidates[0].execution.checks = 'passed'),
    'execution-detail': (p) => (p.candidates[0].execution.detail = 'changed'),
    'execution-merge': (p) =>
      (p.candidates[0].execution.mergeCommit = 'a'.repeat(40)),
    'execution-event': (p) => (p.candidates[0].execution.lastEvent = 'changed'),
    'execution-time': (p) => (p.candidates[0].execution.updatedAt = AT),
    'execution-null': (p) => (p.candidates[0].execution = null),
    'lookahead-body': (p) => (p.candidates[1].body += ' '),
    'lookahead-removed': (p) => p.candidates.pop(),
    order: (p) => p.candidates.reverse(),
  }
  for (const [name, change] of Object.entries(changes))
    it('compares complete final projection including ' + name, async () => {
      const f = await correlationFixture()
      await f.approve()
      await f.approve()
      observeWorkFinal(change)
      const r = await f.call('?include=publicCorrelation&limit=1')
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({
        error: { code: 'public_correlation_page_changed' },
      })
    })
  for (const field of [
    'site',
    'proposalId',
    'approvedRevision',
    'version',
    'value',
  ])
    it('binds issuer ready result ' + field, async () => {
      const f = await correlationFixture()
      await f.approve()
      const original = D1MarginRepository.prototype.getOrIssuePublicCorrelation
      vi.spyOn(
        D1MarginRepository.prototype,
        'getOrIssuePublicCorrelation',
      ).mockImplementation(async function (this: D1MarginRepository, ...args) {
        const result = await original.apply(this, args)
        if (result.status === 'ready') {
          if (field === 'version') result.publicCorrelation.version = 2 as any
          else if (field === 'value') result.publicCorrelation.value = 'bad'
          else (result as any)[field] = 'changed'
        }
        return result
      })
      const r = await f.call()
      expect(r.status).toBe(503)
      expect(await r.text()).not.toContain('items')
    })
  for (const stage of [
    'auth',
    'import',
    'initial-page',
    'final-page',
    'final-serialize',
  ])
    it('checks shared deadline after ' + stage, async () => {
      const f = await correlationFixture()
      await f.approve()
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      if (stage === 'auth') {
        const old = crypto.subtle.digest.bind(crypto.subtle)
        vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...a) => {
          const r = await old(...a)
          now = 10000
          return r
        })
      }
      if (stage === 'import') {
        const old = crypto.subtle.importKey.bind(crypto.subtle)
        vi.spyOn(crypto.subtle, 'importKey').mockImplementation(
          async (...a: any[]) => {
            const r = await (old as any)(...a)
            now = 10000
            return r
          },
        )
      }
      if (stage === 'initial-page' || stage === 'final-page') {
        const old = D1MarginRepository.prototype.listAdapterWork
        let n = 0
        vi.spyOn(
          D1MarginRepository.prototype,
          'listAdapterWork',
        ).mockImplementation(async function (this: D1MarginRepository, ...a) {
          const r = await old.apply(this, a)
          if (++n === (stage === 'initial-page' ? 1 : 2)) now = 10000
          return r
        })
      }
      if (stage === 'final-serialize') {
        const old = JSON.stringify
        vi.spyOn(JSON, 'stringify').mockImplementation(((...a: any[]) => {
          const text = (old as any)(...a)
          if (a[0]?.publicCorrelation === 'v1') now = 10000
          return text
        }) as any)
      }
      const r = await f.call()
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({
        error: { code: 'public_correlation_deadline' },
      })
    })
  it('passes exactly the same absolute deadline to every issuer and recovers a late committed row', async () => {
    const f = await correlationFixture()
    await f.approve()
    await f.approve()
    let now = 400
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const old = D1MarginRepository.prototype.getOrIssuePublicCorrelation,
      seen: number[] = []
    vi.spyOn(
      D1MarginRepository.prototype,
      'getOrIssuePublicCorrelation',
    ).mockImplementation(async function (this: D1MarginRepository, ...args) {
      seen.push(args[3]!)
      const result = await old.apply(this, args)
      now += 100
      return result
    })
    expect((await f.call()).status).toBe(200)
    expect(seen).toEqual([10400, 10400])
    vi.restoreAllMocks()
    const g = await correlationFixture()
    await g.approve()
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const query = g.h.database.query.bind(g.h.database)
    const watcher = vi
      .spyOn(g.h.database, 'query')
      .mockImplementation((sql, params) => {
        const r = query(sql, params)
        if (sql.startsWith('INSERT INTO margin_public_correlations'))
          now = 10000
        return r
      })
    expect((await g.call()).status).toBe(503)
    watcher.mockRestore()
    expect(
      g.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toHaveLength(1)
    expect((await g.call('?include=publicCorrelation', {})).status).toBe(200)
  })
  it('captures runtime bindings before authentication awaits', async () => {
    const f = await correlationFixture()
    await f.approve()
    const bindings = { ...correlationBindings },
      old = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...a) => {
      bindings.MARGIN_PUBLIC_CORRELATION_KEY = 'invalid'
      return old(...a)
    })
    expect((await f.call('?include=publicCorrelation', bindings)).status).toBe(
      200,
    )
  })
  it('ordinary work is unaffected by malformed optional key bindings and HEAD stays bodyless', async () => {
    const f = await correlationFixture()
    await f.approve()
    const before = await (await f.call('', {})).text(),
      imported = vi.spyOn(crypto.subtle, 'importKey')
    expect(
      await (await f.call('', { MARGIN_PUBLIC_CORRELATION_KEY: 'bad' })).text(),
    ).toBe(before)
    const r = await worker.fetch(
      new Request(SITE + CORRELATION_WORK + '?include=publicCorrelation', {
        method: 'HEAD',
        headers: { authorization: 'Bearer ' + f.token },
      }),
      {
        ASSETS: { fetch: async () => new Response('asset') },
        MARGIN_DB: f.h.database,
        ...correlationBindings,
      },
    )
    expect(r.status).toBe(405)
    expect(await r.text()).toBe('')
    expect(imported).not.toHaveBeenCalled()
  })
})

it('does not start authentication digest after the opt-in deadline expires during credential SQL', async () => {
  const f = await correlationFixture()
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const old = D1MarginRepository.prototype.findAdapterCredential
  vi.spyOn(
    D1MarginRepository.prototype,
    'findAdapterCredential',
  ).mockImplementation(async function (this: D1MarginRepository, ...a) {
    const r = await old.apply(this, a)
    now = 10000
    return r
  })
  const digest = vi.spyOn(crypto.subtle, 'digest')
  const r = await f.call()
  expect(r.status).toBe(503)
  expect(await r.json()).toEqual({
    error: { code: 'public_correlation_deadline' },
  })
  expect(digest).not.toHaveBeenCalled()
})

it('bounds malformed runtime key length before base64 decoding', async () => {
  const f = await correlationFixture()
  await f.approve()
  const decode = vi.spyOn(globalThis, 'atob')
  expect(
    (
      await f.call('?include=publicCorrelation', {
        ...correlationBindings,
        MARGIN_PUBLIC_CORRELATION_KEY: 'x'.repeat(10000),
      })
    ).status,
  ).toBe(503)
  expect(decode.mock.calls.every(([value]) => value.length < 100)).toBe(true)
})
for (const [name, ending] of [
  ['LF', '\n'],
  ['CR', '\r'],
  ['CRLF', '\r\n'],
  ['LS', '\u2028'],
  ['PS', '\u2029'],
])
  it('refuses ready correlation terminal line terminator ' + name, async () => {
    const f = await correlationFixture()
    await f.approve()
    const old = D1MarginRepository.prototype.getOrIssuePublicCorrelation
    vi.spyOn(
      D1MarginRepository.prototype,
      'getOrIssuePublicCorrelation',
    ).mockImplementation(async function (this: D1MarginRepository, ...a) {
      const r = await old.apply(this, a)
      if (r.status === 'ready') r.publicCorrelation.value += ending
      return r
    })
    expect((await f.call()).status).toBe(503)
  })

for (const stage of [1, 2])
  it(
    'classifies a rejected page SQL promise at the shared deadline, stage ' +
      stage,
    async () => {
      const f = await correlationFixture()
      await f.approve()
      let now = 0,
        calls = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const original = D1MarginRepository.prototype.listAdapterWork
      vi.spyOn(
        D1MarginRepository.prototype,
        'listAdapterWork',
      ).mockImplementation(async function (this: D1MarginRepository, ...args) {
        if (++calls === stage) {
          now = 10000
          throw Error('private delayed SQL failure')
        }
        return original.apply(this, args)
      })
      const r = await f.call()
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({
        error: { code: 'public_correlation_deadline' },
      })
    },
  )
