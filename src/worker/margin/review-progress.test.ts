import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Principal } from '../principal'
import type { AdapterReportOutcome } from './repository'
import {
  ADA,
  BOB,
  CHAPTER_ONE,
  createHarness,
  proposalBody,
  scopeQuery,
  webAnnotation,
} from './fixtures'
import { annotationIdFromIri } from './web-annotation'
import { encodeBase64Url } from './base64url'
import { recordIdentity } from './identity'
import {
  createFakeProvider,
  sessionCookieHeader,
  testSigner,
  testWorkosEnv,
  TEST_CLIENT_ID,
  TEST_ISSUER,
} from './fake-workos'

const SITE = 'https://ernie.sg',
  AT = '2026-10-08T00:00:00.000Z'
const PR = {
  number: 3,
  url: 'https://github.com/fixture/book/pull/3',
  head: 'b'.repeat(40),
}
const event = (n: number) => encodeBase64Url(new Uint8Array(16).fill(n))
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValue(new Error('no external calls in progress fixtures')),
  ),
)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function fixture(approve = true, source = CHAPTER_ONE) {
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
  h.database.execute(
    'INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)',
    [SITE, identity],
  )
  const created = await h.request('POST', '/annotations', {
    as: BOB,
    body: webAnnotation({
      source,
      motivation: 'editing',
      visibility: 'private',
    }),
  })
  expect(created.status).toBe(201)
  const row = await created.json(),
    id = annotationIdFromIri(row.id)
  const route = `/proposals/${id}/review${scopeQuery(source)}`
  if (approve)
    expect(
      (
        await h.request('POST', `/proposals/${id}/apply${scopeQuery(source)}`, {
          body: { revision: 1 },
        })
      ).status,
    ).toBe(202)
  const call = (
    method = 'GET',
    principal: Principal | null = ADA,
    path = route + '&include=execution',
    db: unknown = h.database,
  ) =>
    worker.fetch(
      new Request('http://localhost/api/margin/v1' + path, { method }),
      {
        MARGIN_ENVIRONMENT: 'development',
        ...(principal
          ? { MARGIN_DEV_PRINCIPAL: JSON.stringify(principal) }
          : {}),
        MARGIN_DB: db as typeof h.database,
        ASSETS: {
          fetch: async () => {
            throw new Error('no asset fallback')
          },
        },
      },
    )
  const report = async (outcome: AdapterReportOutcome, version = 0) => {
    const selector = event(11)
    if (!h.database.query('SELECT * FROM margin_adapters').length) {
      h.database.execute(
        'INSERT INTO margin_adapters(site,adapter,enabled,created_at) VALUES(?,?,1,?)',
        [SITE, 'fixture', AT],
      )
      h.database.execute(
        'INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)',
        [selector, SITE, 'fixture', 'a'.repeat(64), 'approved_feed', AT],
      )
      h.database.execute(
        'INSERT INTO margin_adapter_report_grants(token_id,token_sha256,site,adapter,granted_at,revoked_at) VALUES(?,?,?,?,?,NULL)',
        [selector, 'a'.repeat(64), SITE, 'fixture', AT],
      )
    }
    const credential = (await h.repository.findAdapterCredential(selector))!
    expect(
      (
        await h.repository.reportProposalExecution(
          credential,
          {
            eventId: event(version + 1),
            proposalId: id,
            approvedRevision: 1,
            expectedStateVersion: version,
            outcome,
          },
          AT,
        )
      ).status,
    ).toBe('accepted')
  }
  return { h, id, row, source, identity, route, call, report }
}

describe('private review execution readback RED pilots', () => {
  it('opts in without changing default or ordinary presentation and performs one scoped read', async () => {
    const f = await fixture()
    const original = await (await f.call('GET', ADA, f.route)).text()
    f.h.database.executed.length = 0
    const response = await f.call()
    expect(response.status).toBe(200)
    const value = await response.json()
    expect(value.execution).toMatchObject({
      approvedRevision: 1,
      state: 'approved',
      stateVersion: 0,
      failedApplyCount: 0,
      pr: null,
      checks: null,
      detail: null,
      mergeCommit: null,
    })
    expect(Object.keys(value.execution).sort()).toEqual([
      'approvedRevision',
      'checks',
      'detail',
      'failedApplyCount',
      'mergeCommit',
      'pr',
      'state',
      'stateVersion',
      'updatedAt',
    ])
    expect(f.h.database.executed).toHaveLength(1)
    expect(f.h.database.executed[0].sql).toMatch(/^SELECT /)
    expect(await (await f.call('GET', ADA, f.route)).text()).toBe(original)
    expect(JSON.parse(original)).not.toHaveProperty('execution')
    const own = await f.h.request(
      'GET',
      `/annotations/${f.id}${scopeQuery(f.source)}`,
      { as: BOB },
    )
    expect(await own.json()).not.toHaveProperty('execution')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses current full identity and own-site authority even for creator or foreign private rows', async () => {
    const f = await fixture()
    for (const principal of [
      BOB,
      { ...ADA, issuer: 'other' },
      { ...ADA, provider: 'other' },
      { ...ADA, subject: 'other' },
    ])
      expect((await f.call('GET', principal)).status).toBe(403)
    expect((await f.call('GET', null)).status).toBe(401)
    f.h.database.execute('UPDATE margin_site_admins SET site=?', [
      'https://second.example',
    ])
    expect((await f.call()).status).toBe(403)
    f.h.database.execute('UPDATE margin_site_admins SET site=?', [SITE])
    const other = await f.h.request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({
        source: 'https://second.example/secret',
        motivation: 'editing',
        visibility: 'private',
      }),
    })
    const id = annotationIdFromIri((await other.json()).id)
    expect(
      (
        await f.call(
          'GET',
          ADA,
          `/proposals/${id}/review${scopeQuery('https://second.example/secret')}&include=execution`,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await f.call(
          'GET',
          ADA,
          `/proposals/${id}/review${scopeQuery(f.source)}&include=execution`,
        )
      ).status,
    ).toBe(404)
    expect((await (await f.call()).json()).execution.state).toBe('approved')
  })
  it('projects every canonical execution state while current body stays separate from approved revision', async () => {
    for (const state of [
      'approved',
      'pr_open',
      'conflict',
      'apply_failed',
      'merged',
      'closed',
    ] as const) {
      const f = await fixture()
      if (state === 'pr_open')
        await f.report({ state, pr: PR, checks: 'pending', detail: null })
      if (state === 'conflict' || state === 'apply_failed')
        await f.report({ state, detail: 'private diagnostic <img src=x>' })
      if (state === 'merged' || state === 'closed') {
        await f.report({
          state: 'pr_open',
          pr: PR,
          checks: 'passed',
          detail: null,
        })
        await f.report(
          state === 'merged'
            ? { state, pr: PR, mergeCommit: 'c'.repeat(40) }
            : { state, pr: PR },
          1,
        )
      }
      expect(
        (
          await f.h.request(
            'PATCH',
            `/annotations/${f.id}${scopeQuery(f.source)}`,
            {
              as: BOB,
              body: { body: proposalBody('Later {++current++} text') },
            },
          )
        ).status,
      ).toBe(200)
      const response = await f.call()
      expect(response.status).toBe(200)
      const value = await response.json()
      expect(value.annotation).toMatchObject({
        'margin:revision': 2,
        'margin:approvedRevision': 1,
        'margin:proposalState': state,
      })
      expect(value.execution).toMatchObject({
        approvedRevision: 1,
        state,
        failedApplyCount: state === 'apply_failed' ? 1 : 0,
      })
      expect(value.execution.pr).toEqual(
        ['pr_open', 'merged', 'closed'].includes(state) ? PR : null,
      )
      expect(JSON.stringify(value.execution)).not.toMatch(
        /token|boundAdapter|lastEvent|fingerprint|approved_by/,
      )
    }
  })
  it('distinguishes absent observations from malformed tuples and missing storage schemas', async () => {
    const pending = await fixture(false)
    expect((await (await pending.call()).json()).execution).toBeNull()
    const legacy = await fixture()
    legacy.h.database.execute('DROP TRIGGER margin_execution_no_delete')
    legacy.h.database.execute('DELETE FROM margin_proposal_execution')
    expect((await (await legacy.call()).json()).execution).toBeNull()
    const malformed = await fixture()
    await malformed.report({
      state: 'pr_open',
      pr: PR,
      checks: 'passed',
      detail: null,
    })
    // Structurally legal stored rows can still disagree across the two tables.
    malformed.h.database.execute(
      "UPDATE margin_proposal_applications SET state='approved'",
    )
    const refused = await malformed.call()
    expect(refused.status).toBe(503)
    expect((await refused.json()).error.code).toBe('storage_unavailable')
    expect((await malformed.call('GET', ADA, malformed.route)).status).toBe(200)
    const missing = await fixture()
    missing.h.database.execute(
      'ALTER TABLE margin_proposal_execution RENAME TO fixture_missing_execution',
    )
    const response = await missing.call()
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await missing.call('GET', ADA, missing.route)).status).toBe(200)
  })
  it('keeps HEAD bodyless and no-store for opt-in validation, success, denial and storage failures', async () => {
    const f = await fixture()
    for (const suffix of [
      '&include=',
      '&include=other',
      '&include=execution&include=execution',
    ]) {
      const response = await f.call('HEAD', ADA, f.route + suffix)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    for (const [principal, database, status] of [
      [ADA, f.h.database, 200],
      [BOB, f.h.database, 403],
      [ADA, null, 503],
      [
        ADA,
        {
          prepare() {
            throw new Error('private diagnostic')
          },
        },
        503,
      ],
    ] as const) {
      const response = await f.call(
        'HEAD',
        principal,
        f.route + '&include=execution',
        database,
      )
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('progress decoder and authority invariants', () => {
  it('refuses every missing execution field and invalid application association after a real SQLite read', async () => {
    const f = await fixture()
    await f.report({
      state: 'pr_open',
      pr: PR,
      checks: 'pending',
      detail: null,
    })
    const query = f.h.database.query.bind(f.h.database)
    let change = (_payload: any) => {}
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.includes(' AS review') && rows[0]?.review) {
        const payload = JSON.parse(rows[0].review as string)
        change(payload)
        return [{ ...rows[0], review: JSON.stringify(payload) }]
      }
      return rows
    })
    const refuse = async (label: string, mutate: (value: any) => void) => {
      change = mutate
      const response = await f.call()
      expect(response.status, label).toBe(503)
      expect(await response.json(), label).toEqual({
        error: {
          code: 'storage_unavailable',
          message:
            'the margin store did not answer; check that its migrations are applied',
        },
      })
    }
    for (const key of [
      'proposal_id',
      'site',
      'approved_revision',
      'state_version',
      'failed_apply_count',
      'bound_adapter',
      'pr_number',
      'pr_url',
      'pr_head',
      'checks',
      'detail',
      'merge_commit',
      'last_event',
      'updated_at',
    ]) {
      await refuse('missing ' + key, (value) => {
        delete value.application.execution[key]
      })
    }
    const invalid: Record<string, unknown[]> = {
      proposal_id: ['other'],
      site: ['https://other.example'],
      approved_revision: [2],
      state_version: [-1, 1.5, Number.MAX_SAFE_INTEGER + 1],
      failed_apply_count: [4, 2],
      bound_adapter: [null, ''],
      last_event: [null, 'not-a-selector'],
      pr_number: [null, 0],
      pr_url: [null, 'javascript:alert(1)', 'https://u:p@example.test/'],
      pr_head: [null, 'abc'],
      checks: [null, 'unknown'],
      detail: ['x'.repeat(4097), '💠'.repeat(1025)],
      merge_commit: ['c'.repeat(40)],
      updated_at: ['not-a-date'],
    }
    for (const [key, values] of Object.entries(invalid))
      for (const value of values)
        await refuse('invalid ' + key, (row) => {
          row.application.execution[key] = value
        })
    for (const [key, value] of Object.entries({
      proposal_id: 'other',
      site: 'https://other.example',
      document: '/other',
      revision: 2,
      state: 'merged',
      approved_at: 'not-a-date',
    }))
      await refuse('application ' + key, (row) => {
        row.application[key] = value
      })
    for (const key of [
      'proposal_id',
      'site',
      'document',
      'revision',
      'state',
      'approved_at',
      'execution',
    ])
      await refuse('missing application ' + key, (row) => {
        delete row.application[key]
      })
    await refuse('missing application tuple', (row) => {
      delete row.application
    })
    await refuse('missing approved target', (row) => {
      row.application = null
    })
    await refuse('extra application field', (row) => {
      row.application.private = true
    })
    await refuse('extra execution field', (row) => {
      row.application.execution.private = true
    })
    change = () => {}
    expect((await f.call()).status).toBe(200)
  })
  it('retains canonical max version and full SHA-256 PR heads without inventing retries or counts', async () => {
    const f = await fixture()
    const pr = { ...PR, head: 'd'.repeat(64), url: 'http://example.test/pr/3' }
    await f.report({
      state: 'pr_open',
      pr,
      checks: 'not_evaluated',
      detail: 'waiting for repository evidence',
    })
    f.h.database.execute(
      'UPDATE margin_proposal_execution SET state_version=?,failed_apply_count=3',
      [Number.MAX_SAFE_INTEGER],
    )
    const response = await f.call()
    expect(response.status).toBe(200)
    expect((await response.json()).execution).toMatchObject({
      stateVersion: Number.MAX_SAFE_INTEGER,
      failedApplyCount: 3,
      pr,
      checks: 'not_evaluated',
      detail: 'waiting for repository evidence',
    })
  })
  it('keeps all authority and data in the same statement under role and mapping revocation', async () => {
    for (const table of ['margin_site_admins', 'margin_allowlist']) {
      const f = await fixture(),
        query = f.h.database.query.bind(f.h.database)
      const spy = vi
        .spyOn(f.h.database, 'query')
        .mockImplementation((sql, params) => {
          if (sql.includes(' AS review'))
            f.h.database.execute('DELETE FROM ' + table)
          return query(sql, params)
        })
      f.h.database.executed.length = 0
      expect((await f.call()).status).toBe(403)
      const reads = f.h.database.executed.filter((row) =>
        /^SELECT /.test(row.sql),
      )
      expect(reads).toHaveLength(1)
      expect(reads[0].sql).toContain('margin_proposal_execution')
      spy.mockRestore()
    }
  })
  it('keeps missing identity schema distinct from evaluated denial and does not bootstrap on read', async () => {
    const f = await fixture(),
      missing = createHarness({ identitySchema: false }).database
    missing.executed.length = 0
    const response = await f.call(
      'GET',
      ADA,
      f.route + '&include=execution',
      missing,
    )
    expect(response.status).toBe(503)
    expect(missing.executed.every((row) => /^SELECT /.test(row.sql))).toBe(true)
  })
  it('does not let adapter credentials enter private human progress readback', async () => {
    const f = await fixture(),
      token = `margin-adapter-v1.${event(5)}.${encodeBase64Url(new Uint8Array(32).fill(6))}`
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(
        new Request(SITE + '/api/margin/v1' + f.route + '&include=execution', {
          method,
          headers: { authorization: `Bearer ${token}` },
        }),
        {
          MARGIN_ENVIRONMENT: 'development',
          MARGIN_DEV_PRINCIPAL: JSON.stringify(ADA),
          MARGIN_DB: f.h.database,
          ASSETS: {
            fetch: async () => {
              throw new Error('asset fallback')
            },
          },
        },
      )
      expect(response.status).toBe(403)
      if (method === 'HEAD') expect(await response.text()).toBe('')
      else
        expect((await response.json()).error.code).toBe(
          'adapter_route_forbidden',
        )
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('requires valid opt-in selectors without changing exact default response bytes', async () => {
    const f = await fixture(false)
    const before = await (await f.call('GET', ADA, f.route)).text()
    for (const suffix of [
      '&include=',
      '&include=other',
      '&include=Execution',
      '&include=execution&include=execution',
    ]) {
      const response = await f.call('GET', ADA, f.route + suffix)
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('invalid_include')
    }
    const encoded = await f.call('GET', ADA, f.route + '&include=%65xecution')
    expect(encoded.status).toBe(200)
    expect((await encoded.json()).execution).toBeNull()
    expect(await (await f.call('GET', ADA, f.route)).text()).toBe(before)
  })
})

it('retains renewed and cleared authentication cookies on every opted-in HEAD outcome', async () => {
  const f = await fixture(),
    signer = await testSigner()
  const principal = {
    provider: 'workos',
    issuer: TEST_ISSUER,
    subject: 'progress-reviewer',
  }
  const identity = await recordIdentity(f.h.database, principal, AT)
  //055 permits one global admin; move that fixture role to the signed identity.
  f.h.database.execute('DELETE FROM margin_allowlist WHERE identity_id=?', [
    f.identity,
  ])
  f.h.database.execute(
    "INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)",
    [identity, AT],
  )
  f.h.database.execute(
    'INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)',
    [SITE, identity],
  )
  const now = Math.floor(Date.now() / 1000)
  const sign = (exp: number) =>
    signer.sign({
      iss: TEST_ISSUER,
      sub: principal.subject,
      client_id: TEST_CLIENT_ID,
      iat: now - 3600,
      exp,
    })
  const fresh = await sign(now + 300),
    stale = await sessionCookieHeader(await sign(now - 60), {
      expiresAt: now - 60,
      ceiling: now + 3600,
      refreshToken: 'fixture-progress-renewal',
    })
  const provider = createFakeProvider({
    jwks: signer.jwks,
    authenticate: {
      access_token: fresh,
      refresh_token: 'fixture-progress-rotated',
      user: { id: principal.subject },
    },
  })
  vi.stubGlobal('fetch', provider.fetchImpl)
  const path = `/api/margin/v1//%70roposals//${encodeURIComponent(f.row.id)}//%72eview//${scopeQuery(f.source)}&include=execution`
  const assets = vi.fn(async () => new Response('unreachable'))
  const call = (
    suffix = '',
    database: unknown = f.h.database,
    cookie = stale,
  ) =>
    worker.fetch(
      new Request(SITE + path + suffix, {
        method: 'HEAD',
        headers: { cookie },
      }),
      {
        ...testWorkosEnv(),
        MARGIN_DB: database as typeof f.h.database,
        ASSETS: { fetch: assets },
      },
    )
  const responses: [Response, number][] = [
    [await call(), 200],
    [await call('&include=execution'), 400],
  ]
  f.h.database.execute('DELETE FROM margin_site_admins')
  responses.push(
    [await call(), 403],
    [await call('', null), 503],
    [
      await call('', {
        prepare() {
          throw new Error('private storage detail')
        },
      }),
      503,
    ],
  )
  for (const [response, status] of responses) {
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toContain(
      '__Host-margin-session=',
    )
    expect(response.headers.get('set-cookie')).not.toContain('Max-Age=0')
  }
  vi.stubGlobal(
    'fetch',
    createFakeProvider({
      jwks: signer.jwks,
      authenticateStatus: 400,
      authenticate: { error: 'invalid_grant' },
    }).fetchImpl,
  )
  // Use a distinct expired credential: prior successful renewal is cached.
  const terminal = await sessionCookieHeader(await sign(now - 61), {
    expiresAt: now - 61,
    ceiling: now + 3600,
    refreshToken: 'fixture-progress-terminal',
  })
  const cleared = await call(
    '',
    f.h.database,
    terminal + '; margin-session=legacy-fixture',
  )
  expect(cleared.status).toBe(401)
  expect(await cleared.text()).toBe('')
  expect(cleared.headers.get('cache-control')).toBe('no-store')
  expect(cleared.headers.get('set-cookie')).toContain('Max-Age=0')
  expect(cleared.headers.get('set-cookie')).toContain('__Host-margin-session=')
  expect(cleared.headers.get('set-cookie')).toContain('margin-session=')
  expect(assets).not.toHaveBeenCalled()
})
