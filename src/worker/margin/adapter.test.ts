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
