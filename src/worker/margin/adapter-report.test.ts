import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { SqliteD1Database } from './sqlite-database'
import { D1MarginRepository } from './d1-repository'
import type {
  AdapterReportOutcome,
  AdapterExecutionReport,
  AdapterReportResult,
} from './repository'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADA,
  BOB,
  createHarness,
  proposalBody,
  scopeQuery,
  webAnnotation,
} from './fixtures'
import { encodeBase64Url } from './base64url'
const SITE = 'https://ernie.sg',
  AT = '2026-10-08T00:00:00.000Z'
const event = (n: number) => encodeBase64Url(new Uint8Array(16).fill(n))
afterEach(() => vi.restoreAllMocks())
async function fixture(grant = true) {
  const h = createHarness(),
    selector = event(11),
    hash = 'a'.repeat(64)
  h.database.execute('INSERT INTO margin_adapters VALUES(?,?,1,?)', [
    SITE,
    'fixture-adapter',
    AT,
  ])
  h.database.execute('INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)', [
    selector,
    SITE,
    'fixture-adapter',
    hash,
    'approved_feed',
    AT,
  ])
  const credential = (await h.repository.findAdapterCredential(selector))!
  const grantToken = () =>
    h.database.execute(
      'INSERT INTO margin_adapter_report_grants(token_id,token_sha256,site,adapter,granted_at,revoked_at) VALUES(?,?,?,?,?,NULL)',
      [selector, hash, SITE, 'fixture-adapter', AT],
    )
  if (grant) grantToken()
  h.database.execute(
    'INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
    [ADA.provider, ADA.issuer, ADA.subject, AT, AT],
  )
  const identity = h.database.query('SELECT id FROM margin_identity')[0].id
  h.database.execute(
    "INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)",
    [identity, AT],
  )
  h.database.execute('INSERT INTO margin_site_admins VALUES(?,?)', [SITE, identity])
  const source = SITE + '/books/chapter/'
  const created = await h.request('POST', '/annotations', {
    as: BOB,
    body: webAnnotation({ source, motivation: 'editing', visibility: 'private' }),
  })
  expect(created.status).toBe(201)
  const id = (await created.json()).id.replace('urn:margin:annotation:', '')
  expect(
    (
      await h.request('POST', `/proposals/${id}/apply${scopeQuery(source)}`, {
        body: { revision: 1 },
      })
    ).status,
  ).toBe(202)
  const report = (
    n: number,
    version: number,
    outcome: AdapterReportOutcome = {
      state: 'apply_failed',
      detail: 'fixture failure',
    },
  ) => ({
    eventId: event(n),
    proposalId: id,
    approvedRevision: 1,
    expectedStateVersion: version,
    outcome,
  })
  return { h, credential, id, source, report, grantToken }
}
describe('private execution CAS RED pilots', () => {
  it('initializes new Apply only and atomically refuses absent authority or interrupted projection', async () => {
    const f = await fixture(false)
    expect(
      f.h.database.query(
        'SELECT state_version,failed_apply_count,bound_adapter FROM margin_proposal_execution',
      ),
    ).toEqual([{ state_version: 0, failed_apply_count: 0, bound_adapter: null }])
    expect(
      (await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT))
        .status,
    ).toBe('forbidden')
    f.grantToken()
    f.h.database.execute(
      "CREATE TRIGGER fixture_abort BEFORE UPDATE ON margin_proposal_execution BEGIN SELECT RAISE(ABORT,'fixture stop');END",
    )
    await expect(
      f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT),
    ).rejects.toThrow()
    expect(f.h.database.query('SELECT * FROM margin_adapter_report_receipts')).toEqual(
      [],
    )
    expect(
      f.h.database.query('SELECT state FROM margin_proposal_applications'),
    ).toEqual([{ state: 'approved' }])
  })
  it('commits one CAS, replays exact receipt and reconciles a lost response with current authority', async () => {
    const f = await fixture(),
      input = f.report(1, 0)
    const first = await f.h.repository.reportProposalExecution(f.credential, input, AT)
    expect(first.status).toBe('accepted')
    expect(
      await f.h.repository.reportProposalExecution(f.credential, input, AT),
    ).toEqual(first)
    expect(
      (await f.h.repository.reportProposalExecution(f.credential, f.report(2, 0), AT))
        .status,
    ).toBe('conflict')
    const query = f.h.database.query.bind(f.h.database)
    const spy = vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.startsWith('INSERT INTO margin_adapter_report_receipts'))
        throw Error('after commit')
      return rows
    })
    await expect(
      f.h.repository.reportProposalExecution(f.credential, f.report(3, 1), AT),
    ).rejects.toThrow('after commit')
    spy.mockRestore()
    const read = await f.h.repository.readAdapterReportReceipt(f.credential, event(3))
    expect(ack(read).failedApplyCount).toBe(2)
    f.h.database.execute('UPDATE margin_adapter_report_grants SET revoked_at=?', [AT])
    expect(
      (await f.h.repository.readAdapterReportReceipt(f.credential, event(3))).status,
    ).toBe('forbidden')
  })
  it('counts new failures only and retains known PRs through conflict without granting failed-apply eligibility', async () => {
    const f = await fixture()
    for (let n = 1; n <= 3; n++)
      expect(
        ack(
          await f.h.repository.reportProposalExecution(
            f.credential,
            f.report(n, n - 1),
            AT,
          ),
        ).failedApplyCount,
      ).toBe(n)
    expect(
      (await f.h.repository.reportProposalExecution(f.credential, f.report(4, 3), AT))
        .status,
    ).toBe('conflict')
    const pr = {
      number: 10,
      url: 'https://code.example/review/10',
      head: 'b'.repeat(40),
    }
    const adopted = await f.h.repository.reportProposalExecution(
      f.credential,
      f.report(5, 3, { state: 'pr_open', pr, checks: 'pending', detail: null }),
      AT,
    )
    expect(adopted.status).toBe('accepted')
    expect(
      (
        await f.h.repository.reportProposalExecution(
          f.credential,
          f.report(6, 4, { state: 'conflict', detail: 'fixture conflict' }),
          AT,
        )
      ).status,
    ).toBe('accepted')
    expect(
      (await f.h.repository.reportProposalExecution(f.credential, f.report(7, 5), AT))
        .status,
    ).toBe('conflict')
    expect(
      f.h.database.query(
        'SELECT failed_apply_count,pr_number,pr_url FROM margin_proposal_execution',
      ),
    ).toEqual([{ failed_apply_count: 3, pr_number: 10, pr_url: pr.url }])
  })
})

const PR = { number: 10, url: 'https://code.example/review/10', head: 'b'.repeat(40) }
const outcome = (state: string): any =>
  state === 'pr_open'
    ? { state, pr: PR, checks: 'pending', detail: null }
    : state === 'merged'
      ? { state, pr: PR, mergeCommit: 'c'.repeat(40) }
      : state === 'closed'
        ? { state, pr: PR }
        : { state, detail: 'fixture detail' }
const ack = (result: any) => {
  expect(result.status).toBe('accepted')
  return result.ack
}
const receipts = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.h.database.query('SELECT * FROM margin_adapter_report_receipts')
const metadata = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.h.database.query('SELECT * FROM margin_proposal_execution')

describe('current report authority on both write and read', () => {
  for (const drift of [
    'grant-revoked',
    'token-revoked',
    'disabled',
    'digest',
    'grant-digest',
    'grant-scope',
    'missing-grant',
  ] as const) {
    it(`rechecks ${drift} after credential verification and before receipt recovery`, async () => {
      const f = await fixture()
      await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT)
      const before = metadata(f)
      const sql: Record<typeof drift, string> = {
        'grant-revoked': `UPDATE margin_adapter_report_grants SET revoked_at='${AT}'`,
        'token-revoked': `UPDATE margin_adapter_tokens SET revoked_at='${AT}'`,
        disabled: 'UPDATE margin_adapters SET enabled=0',
        digest: `UPDATE margin_adapter_tokens SET token_sha256='${'b'.repeat(64)}'`,
        'grant-digest': `UPDATE margin_adapter_report_grants SET token_sha256='${'b'.repeat(64)}'`,
        'grant-scope': `UPDATE margin_adapter_report_grants SET site='https://foreign.example',adapter='foreign'`,
        'missing-grant': 'DELETE FROM margin_adapter_report_grants',
      }
      if (drift === 'grant-scope')
        f.h.database.execute('INSERT INTO margin_adapters VALUES(?,?,1,?)', [
          'https://foreign.example',
          'foreign',
          AT,
        ])
      f.h.database.execute(sql[drift])
      for (const input of [f.report(1, 0), f.report(2, 1)])
        expect(
          await f.h.repository.reportProposalExecution(f.credential, input, AT),
        ).toEqual({ status: 'forbidden' })
      expect(
        await f.h.repository.readAdapterReportReceipt(f.credential, event(1)),
      ).toEqual({ status: 'forbidden' })
      expect(metadata(f)).toEqual(before)
      expect(receipts(f)).toHaveLength(1)
    })
  }
  it('rechecks grant revocation between its valid snapshot and atomic write', async () => {
    const f = await fixture(),
      query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      if (sql.startsWith('INSERT INTO margin_adapter_report_receipts'))
        f.h.database.execute('UPDATE margin_adapter_report_grants SET revoked_at=?', [
          AT,
        ])
      return query(sql, params)
    })
    expect(
      await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT),
    ).toEqual({ status: 'forbidden' })
    expect(receipts(f)).toEqual([])
    expect(metadata(f)[0].state_version).toBe(0)
  })
  it('permits an explicitly granted replacement token to reconcile the same adapter receipt only', async () => {
    const f = await fixture(),
      first = await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(1, 0),
        AT,
      )
    f.h.database.execute('UPDATE margin_adapter_tokens SET revoked_at=?', [AT])
    f.h.database.execute('INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)', [
      event(12),
      SITE,
      'fixture-adapter',
      'b'.repeat(64),
      'approved_feed',
      AT,
    ])
    const replacement = (await f.h.repository.findAdapterCredential(event(12)))!
    expect(
      await f.h.repository.readAdapterReportReceipt(replacement, event(1)),
    ).toEqual({ status: 'forbidden' })
    f.h.database.execute(
      'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
      [event(12), 'b'.repeat(64), SITE, 'fixture-adapter', AT],
    )
    expect(
      await f.h.repository.readAdapterReportReceipt(replacement, event(1)),
    ).toEqual(first)
  })
  it('does not expose foreign targets or receipts to another site', async () => {
    const f = await fixture()
    await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT)
    const other = 'https://foreign.example'
    f.h.database.execute('INSERT INTO margin_adapters VALUES(?,?,1,?)', [
      other,
      'foreign',
      AT,
    ])
    f.h.database.execute('INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)', [
      event(13),
      other,
      'foreign',
      'b'.repeat(64),
      'approved_feed',
      AT,
    ])
    f.h.database.execute(
      'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
      [event(13), 'b'.repeat(64), other, 'foreign', AT],
    )
    const credential = (await f.h.repository.findAdapterCredential(event(13)))!
    expect(
      await f.h.repository.reportProposalExecution(credential, f.report(2, 1), AT),
    ).toEqual({ status: 'forbidden' })
    expect(await f.h.repository.readAdapterReportReceipt(credential, event(1))).toEqual(
      { status: 'missing' },
    )
    expect(receipts(f)).toHaveLength(1)
  })
})

describe('atomic CAS and immutable receipt rules', () => {
  it('accepts exactly one of two distinct events racing the same version', async () => {
    const f = await fixture()
    const results = await Promise.all(
      [1, 2].map((n) =>
        f.h.repository.reportProposalExecution(f.credential, f.report(n, 0), AT),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'conflict'])
    expect(receipts(f)).toHaveLength(1)
    expect(metadata(f)[0].failed_apply_count).toBe(1)
  })
  it.each([
    'proposalId',
    'approvedRevision',
    'expectedStateVersion',
    'outcome',
  ] as const)(
    'same event with changed %s conflicts without changing receipt',
    async (field) => {
      const f = await fixture(),
        input = f.report(1, 0)
      await f.h.repository.reportProposalExecution(f.credential, input, AT)
      const before = receipts(f),
        changed: any = { ...input }
      changed[field] =
        field === 'proposalId'
          ? 'other-id'
          : field === 'outcome'
            ? outcome('conflict')
            : 2
      expect(
        await f.h.repository.reportProposalExecution(f.credential, changed, AT),
      ).toEqual({ status: 'conflict' })
      expect(receipts(f)).toEqual(before)
    },
  )
  it('canonical key order and new request time return the immutable original acknowledgement', async () => {
    const f = await fixture(),
      input = f.report(1, 0),
      first = await f.h.repository.reportProposalExecution(f.credential, input, AT)
    const reorder = {
      outcome: { detail: 'fixture failure', state: 'apply_failed' },
      expectedStateVersion: 0,
      approvedRevision: 1,
      proposalId: f.id,
      eventId: event(1),
    } as any
    expect(
      await f.h.repository.reportProposalExecution(
        f.credential,
        reorder,
        '2026-10-09T00:00:00.000Z',
      ),
    ).toEqual(first)
    expect(receipts(f)).toHaveLength(1)
  })
  it.each([
    'DELETE FROM margin_adapter_report_receipts',
    'UPDATE margin_adapter_report_receipts SET accepted_at=accepted_at',
    'INSERT OR REPLACE INTO margin_adapter_report_receipts SELECT * FROM margin_adapter_report_receipts',
  ])('rejects immutable receipt operation: %s', async (sql) => {
    const f = await fixture()
    await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT)
    const before = receipts(f)
    expect(() => f.h.database.execute(sql)).toThrow()
    expect(receipts(f)).toEqual(before)
  })
  it('refuses version exhaustion atomically and still permits a stored receipt read', async () => {
    const f = await fixture(),
      first = await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(1, 0),
        AT,
      )
    f.h.database.execute('UPDATE margin_proposal_execution SET state_version=?', [
      Number.MAX_SAFE_INTEGER,
    ])
    expect(
      await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(2, Number.MAX_SAFE_INTEGER),
        AT,
      ),
    ).toEqual({ status: 'conflict' })
    expect(
      await f.h.repository.readAdapterReportReceipt(f.credential, event(1)),
    ).toEqual(first)
    expect(receipts(f)).toHaveLength(1)
  })
  it('compares complete target metadata inside the write even if version was left unchanged', async () => {
    const f = await fixture()
    await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT)
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      if (sql.startsWith('INSERT INTO margin_adapter_report_receipts'))
        f.h.database.execute('UPDATE margin_proposal_execution SET detail=?', [
          'concurrent valid detail',
        ])
      return query(sql, params)
    })
    expect(
      await f.h.repository.reportProposalExecution(f.credential, f.report(2, 1), AT),
    ).toEqual({ status: 'conflict' })
    expect(receipts(f)).toHaveLength(1)
  })
  it('has one mutation statement and never needs optional D1 batch', async () => {
    const f = await fixture()
    Object.defineProperty(f.h.database, 'batch', { value: undefined })
    const start = f.h.database.executed.length
    ack(await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT))
    expect(
      f.h.database.executed
        .slice(start)
        .filter((x) => /^INSERT|^UPDATE|^DELETE/.test(x.sql)),
    ).toHaveLength(1)
  })
})

describe('all outcome and previous-state edges', () => {
  for (const previous of [
    'approved',
    'pr_open',
    'conflict',
    'apply_failed',
    'merged',
    'closed',
  ])
    for (const next of ['pr_open', 'conflict', 'apply_failed', 'merged', 'closed']) {
      it(`${previous} -> ${next}`, async () => {
        const f = await fixture(),
          version = previous === 'approved' ? 0 : 1
        if (version)
          ack(
            await f.h.repository.reportProposalExecution(
              f.credential,
              f.report(1, 0, outcome(previous)),
              AT,
            ),
          )
        const accepted =
          !['merged', 'closed'].includes(previous) &&
          !(previous === 'pr_open' && next === 'apply_failed')
        const result = await f.h.repository.reportProposalExecution(
          f.credential,
          f.report(2, version, outcome(next)),
          AT,
        )
        expect(result.status).toBe(accepted ? 'accepted' : 'conflict')
        if (accepted)
          expect(ack(result).failedApplyCount).toBe(
            Number(previous === 'apply_failed') + Number(next === 'apply_failed'),
          )
      })
    }
  it('known PR survives conflict and cannot be swapped or converted into a failed apply', async () => {
    const f = await fixture()
    ack(
      await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(1, 0, outcome('pr_open')),
        AT,
      ),
    )
    ack(
      await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(2, 1, outcome('conflict')),
        AT,
      ),
    )
    for (const next of ['pr_open', 'merged', 'closed'])
      for (const field of ['number', 'url']) {
        const o = outcome(next)
        o.pr = {
          ...PR,
          [field]: field === 'number' ? 11 : 'https://code.example/review/11',
        }
        expect(
          (
            await f.h.repository.reportProposalExecution(
              f.credential,
              f.report(3, 2, o),
              AT,
            )
          ).status,
        ).toBe('conflict')
      }
    expect(
      (await f.h.repository.reportProposalExecution(f.credential, f.report(4, 2), AT))
        .status,
    ).toBe('conflict')
    ack(
      await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(5, 2, {
          ...outcome('pr_open'),
          pr: { ...PR, head: 'd'.repeat(64) },
          checks: 'not_evaluated',
          detail: 'observation unavailable',
        }),
        AT,
      ),
    )
    expect(metadata(f)[0]).toMatchObject({
      pr_number: PR.number,
      pr_head: 'd'.repeat(64),
      checks: 'not_evaluated',
      failed_apply_count: 0,
    })
  })
  it('all nonfailure outcomes preserve failure count, including adoption at the ceiling', async () => {
    for (const state of ['pr_open', 'conflict', 'merged', 'closed']) {
      const f = await fixture()
      for (let i = 1; i <= 3; i++)
        ack(
          await f.h.repository.reportProposalExecution(
            f.credential,
            f.report(i, i - 1),
            AT,
          ),
        )
      expect(
        ack(
          await f.h.repository.reportProposalExecution(
            f.credential,
            f.report(4, 3, outcome(state)),
            AT,
          ),
        ).failedApplyCount,
      ).toBe(3)
    }
  })
  it('receipt replay remains valid after terminal progression', async () => {
    const f = await fixture(),
      first = await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(1, 0),
        AT,
      )
    ack(
      await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(2, 1, outcome('merged')),
        AT,
      ),
    )
    expect(
      await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT),
    ).toEqual(first)
  })
})

describe('initialization, immutable approval and private projections', () => {
  it('new Apply initializes without any adapter registration or report grant', async () => {
    const f = await fixture(false)
    f.h.database.execute('DELETE FROM margin_adapter_tokens')
    f.h.database.execute('DELETE FROM margin_adapters')
    const created = await f.h.request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({ source: f.source, motivation: 'editing' }),
    })
    const id = (await created.json()).id.replace('urn:margin:annotation:', '')
    expect(
      (
        await f.h.request('POST', `/proposals/${id}/apply${scopeQuery(f.source)}`, {
          body: { revision: 1 },
        })
      ).status,
    ).toBe(202)
    expect(
      f.h.database.query(
        'SELECT state_version,failed_apply_count,bound_adapter FROM margin_proposal_execution WHERE proposal_id=?',
        [id],
      ),
    ).toEqual([{ state_version: 0, failed_apply_count: 0, bound_adapter: null }])
  })
  it('actual additive migration does not backfill a historical application', async () => {
    const f = await fixture(),
      db = new DatabaseSync(':memory:')
    try {
      for (const file of readdirSync('migrations')
        .filter((n) => n.endsWith('.sql') && n < '0009')
        .sort())
        db.exec(readFileSync('migrations/' + file, 'utf8'))
      for (const table of [
        'margin_annotations',
        'margin_proposal_applications',
        'margin_adapters',
        'margin_adapter_tokens',
      ])
        for (const row of f.h.database.query('SELECT * FROM ' + table)) {
          db.prepare(
            `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(
              row,
            )
              .map(() => '?')
              .join(',')})`,
          ).run(...(Object.values(row) as any[]))
        }
      db.exec(readFileSync('migrations/0009_margin_adapter_execution.sql', 'utf8'))
      const local = new SqliteD1Database(db),
        repo = new D1MarginRepository(local)
      local.execute('INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)', [
        f.credential.tokenId,
        f.credential.tokenSha256,
        SITE,
        f.credential.adapter,
        AT,
      ])
      expect(local.query('SELECT * FROM margin_proposal_execution')).toEqual([])
      expect(
        await repo.reportProposalExecution(f.credential, f.report(1, 0), AT),
      ).toEqual({ status: 'not_evaluated' })
      expect(local.query('SELECT * FROM margin_adapter_report_receipts')).toEqual([])
    } finally {
      db.close()
    }
  })
  it('creator PATCH changes current revision only and private report data never enters ordinary responses', async () => {
    const f = await fixture(),
      before = f.h.database.query('SELECT * FROM margin_proposal_applications')[0]
    const patch = await f.h.request(
      'PATCH',
      `/annotations/${f.id}${scopeQuery(f.source)}`,
      {
        as: BOB,
        body: {
          body: proposalBody('A {++later++} draft.'),
          'margin:baseCommit': 'b'.repeat(40),
        },
      },
    )
    expect(patch.status).toBe(200)
    const report = f.report(1, 0, {
      state: 'conflict',
      detail: 'private fixture diagnostic',
    })
    expect(
      ack(await f.h.repository.reportProposalExecution(f.credential, report, AT))
        .approvedRevision,
    ).toBe(1)
    expect(
      f.h.database.query('SELECT revision FROM margin_annotations WHERE id=?', [
        f.id,
      ])[0].revision,
    ).toBe(2)
    expect(f.h.database.query('SELECT * FROM margin_proposal_applications')[0]).toEqual(
      { ...before, state: 'conflict' },
    )
    for (const path of [
      `/annotations/${f.id}${scopeQuery(f.source)}`,
      `/annotations${scopeQuery(f.source)}`,
      `/mine?site=${encodeURIComponent(SITE)}&prefix=%2Fbooks%2F`,
    ]) {
      const res = await f.h.request('GET', path, { as: BOB })
      expect(res.status).toBe(200)
      const text = await res.text()
      for (const privateText of [
        'private fixture diagnostic',
        'failed_apply_count',
        'state_version',
        'fingerprint',
        'token_sha256',
      ])
        expect(text).not.toContain(privateText)
    }
  })
})

describe('strict bounded input and storage responses', () => {
  const mutations: Record<string, (r: any) => void> = {
    'unknown top key': (r) => (r.extra = true),
    'unknown outcome key': (r) => (r.outcome.extra = true),
    'noncanonical event': (r) => (r.eventId += '='),
    'wrong event size': (r) => (r.eventId = 'a'),
    'empty proposal': (r) => (r.proposalId = ''),
    'fraction revision': (r) => (r.approvedRevision = 1.5),
    'boolean version': (r) => (r.expectedStateVersion = true),
    'overflow version': (r) => (r.expectedStateVersion = Number.MAX_SAFE_INTEGER + 1),
    'missing diagnostic': (r) => delete r.outcome.detail,
    'empty diagnostic': (r) => (r.outcome.detail = ''),
    'oversized diagnostic bytes': (r) => (r.outcome.detail = 'é'.repeat(2049)),
    'unknown state': (r) => (r.outcome.state = 'approved'),
    'partial PR': (r) => (r.outcome = { state: 'closed', pr: { number: 1 } }),
    'PR userinfo': (r) =>
      (r.outcome = {
        state: 'closed',
        pr: { ...PR, url: 'https://user@code.example/review/10' },
      }),
    'noncanonical PR URL': (r) =>
      (r.outcome = {
        state: 'closed',
        pr: { ...PR, url: 'HTTPS://code.example/review/10' },
      }),
    'invalid PR scheme': (r) =>
      (r.outcome = { state: 'closed', pr: { ...PR, url: 'file:///fixture' } }),
    'fraction PR number': (r) =>
      (r.outcome = { state: 'closed', pr: { ...PR, number: 1.5 } }),
    'missing merge SHA': (r) => (r.outcome = { state: 'merged', pr: PR }),
    'short merge SHA': (r) =>
      (r.outcome = { state: 'merged', pr: PR, mergeCommit: 'abc' }),
    'PR unknown key': (r) => (r.outcome = { state: 'closed', pr: { ...PR, extra: 1 } }),
  }
  it.each(Object.keys(mutations))('refuses %s before database work', async (name) => {
    const f = await fixture(),
      r: any = f.report(1, 0)
    mutations[name](r)
    const n = f.h.database.executed.length
    await expect(
      f.h.repository.reportProposalExecution(f.credential, r, AT),
    ).rejects.toThrow()
    expect(f.h.database.executed).toHaveLength(n)
  })
  const corrupt: Record<string, (p: any) => void> = {
    'unknown target key': (p) => (p.extra = true),
    'wrong target site': (p) => (p.site = 'https://foreign.example'),
    'wrong approved revision': (p) => (p.execution.approved_revision = 2),
    'wrong execution site': (p) => (p.execution.site = 'https://foreign.example'),
    'negative count': (p) => (p.execution.failed_apply_count = -1),
    'fraction count': (p) => (p.execution.failed_apply_count = 0.5),
    'overflow count': (p) => (p.execution.failed_apply_count = 4),
    'partial PR': (p) => (p.execution.pr_url = PR.url),
    'unstamped state': (p) => (p.state = 'conflict'),
    'initial adapter stamp': (p) => (p.execution.bound_adapter = 'fixture-adapter'),
    'initial event stamp': (p) => (p.execution.last_event = event(10)),
    'initial time mismatch': (p) => (p.execution.updated_at = AT),
    'nonfinite version': (p) => (p.execution.state_version = null),
    'unknown execution key': (p) => (p.execution.extra = true),
  }
  it.each(Object.keys(corrupt))(
    'refuses malformed current metadata: %s without any write',
    async (name) => {
      const f = await fixture(),
        query = f.h.database.query.bind(f.h.database),
        start = f.h.database.executed.length
      vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
        const rows = query(sql, params)
        if (sql.startsWith('WITH authority') && rows[0]?.target) {
          const p = JSON.parse(rows[0].target as string)
          corrupt[name](p)
          rows[0].target = JSON.stringify(p)
        }
        return rows
      })
      await expect(
        f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT),
      ).rejects.toThrow()
      expect(
        f.h.database.executed.slice(start).some((x) => x.sql.startsWith('INSERT')),
      ).toBe(false)
    },
  )
  it.each([
    'duplicate',
    'missing-field',
    'wrong-scope',
    'wrong-revision',
    'wrong-fingerprint',
    'wrong-state',
    'wrong-version',
    'wrong-time',
    'wrong-count',
  ] as const)(
    'malformed RETURNING %s is uncertain and reconciled by read, without another write',
    async (kind) => {
      const f = await fixture()
      ack(
        await f.h.repository.reportProposalExecution(
          f.credential,
          f.report(1, 0, outcome('conflict')),
          AT,
        ),
      )
      const query = f.h.database.query.bind(f.h.database)
      const spy = vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
        const rows = query(sql, params)
        if (sql.startsWith('INSERT INTO margin_adapter_report_receipts')) {
          if (kind === 'duplicate') return [rows[0], rows[0]]
          const row = { ...rows[0] }
          if (kind === 'missing-field') delete row.detail
          if (kind === 'wrong-scope') row.site = 'https://foreign.example'
          if (kind === 'wrong-revision') row.approved_revision = 2
          if (kind === 'wrong-fingerprint') row.fingerprint = 'b'.repeat(64)
          if (kind === 'wrong-state') row.state = 'conflict'
          if (kind === 'wrong-version') row.state_version = 2.5
          if (kind === 'wrong-time') row.accepted_at = '2026-10-09T00:00:00.000Z'
          if (kind === 'wrong-count') row.failed_apply_count = 2
          return [row]
        }
        return rows
      })
      await expect(
        f.h.repository.reportProposalExecution(f.credential, f.report(2, 1), AT),
      ).rejects.toThrow()
      spy.mockRestore()
      expect(
        ack(await f.h.repository.readAdapterReportReceipt(f.credential, event(2)))
          .failedApplyCount,
      ).toBe(1)
      expect(receipts(f)).toHaveLength(2)
    },
  )
  it.each([
    'success-false',
    'missing-results',
    'two-rows',
    'unknown-row-key',
    'private-unauthorized',
  ] as const)('refuses malformed snapshot envelope: %s', async (kind) => {
    const f = await fixture(),
      prepare = f.h.database.prepare.bind(f.h.database)
    vi.spyOn(f.h.database, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (!sql.startsWith('WITH authority')) return statement
      const wrap = (s: any): any => ({
        ...s,
        bind: (...params: any[]) => wrap(s.bind(...params)),
        all: async () => {
          const result = await s.all()
          if (kind === 'success-false') return { ...result, success: false }
          if (kind === 'missing-results') return { success: true }
          if (kind === 'two-rows')
            return { ...result, results: [...result.results, ...result.results] }
          if (kind === 'unknown-row-key')
            return { ...result, results: [{ ...result.results[0], extra: true }] }
          return { ...result, results: [{ ...result.results[0], authorized: 0 }] }
        },
      })
      return wrap(statement)
    })
    await expect(
      f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT),
    ).rejects.toThrow()
  })
})

describe('complete projection and ceiling binding', () => {
  it('accepts the final safe version once then refuses further mutation', async () => {
    const f = await fixture()
    ack(
      await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(1, 0, outcome('conflict')),
        AT,
      ),
    )
    f.h.database.execute('UPDATE margin_proposal_execution SET state_version=?', [
      Number.MAX_SAFE_INTEGER - 1,
    ])
    const last = ack(
      await f.h.repository.reportProposalExecution(
        f.credential,
        f.report(2, Number.MAX_SAFE_INTEGER - 1, outcome('pr_open')),
        AT,
      ),
    )
    expect(last.stateVersion).toBe(Number.MAX_SAFE_INTEGER)
    expect(
      (
        await f.h.repository.reportProposalExecution(
          f.credential,
          f.report(3, Number.MAX_SAFE_INTEGER, outcome('closed')),
          AT,
        )
      ).status,
    ).toBe('conflict')
  })
  it.each(['pr_number', 'pr_url', 'pr_head', 'checks', 'detail'] as const)(
    'binds returned PR metadata %s even when the substitute is independently valid',
    async (field) => {
      const f = await fixture(),
        query = f.h.database.query.bind(f.h.database)
      const replacement = {
        pr_number: 11,
        pr_url: 'https://code.example/review/11',
        pr_head: 'd'.repeat(40),
        checks: 'passed',
        detail: 'another valid detail',
      }
      const spy = vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
        const rows = query(sql, params)
        return sql.startsWith('INSERT INTO margin_adapter_report_receipts')
          ? [{ ...rows[0], [field]: replacement[field] }]
          : rows
      })
      await expect(
        f.h.repository.reportProposalExecution(
          f.credential,
          f.report(1, 0, outcome('pr_open')),
          AT,
        ),
      ).rejects.toThrow('projection mismatch')
      spy.mockRestore()
      expect(
        ack(await f.h.repository.readAdapterReportReceipt(f.credential, event(1)))
          .state,
      ).toBe('pr_open')
    },
  )
  it('binds returned merge SHA to the accepted report', async () => {
    const f = await fixture(),
      query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      return sql.startsWith('INSERT INTO margin_adapter_report_receipts')
        ? [{ ...rows[0], merge_commit: 'd'.repeat(40) }]
        : rows
    })
    await expect(
      f.h.repository.reportProposalExecution(
        f.credential,
        f.report(1, 0, outcome('merged')),
        AT,
      ),
    ).rejects.toThrow('projection mismatch')
  })
  it.each([
    'partial-pr',
    'wrong-version',
    'foreign-scope',
    'unknown-key',
    'invalid-state',
  ] as const)('receipt recovery refuses malformed stored %s', async (kind) => {
    const f = await fixture()
    ack(await f.h.repository.reportProposalExecution(f.credential, f.report(1, 0), AT))
    const query = f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database, 'query').mockImplementation((sql, params) => {
      const rows = query(sql, params)
      if (sql.startsWith('WITH authority') && rows[0]?.receipt) {
        const row = JSON.parse(rows[0].receipt as string)
        if (kind === 'partial-pr') row.pr_url = PR.url
        if (kind === 'wrong-version') row.state_version = 3
        if (kind === 'foreign-scope') row.adapter = 'foreign'
        if (kind === 'unknown-key') row.extra = true
        if (kind === 'invalid-state') row.state = 'pr_open'
        rows[0].receipt = JSON.stringify(row)
      }
      return rows
    })
    await expect(
      f.h.repository.readAdapterReportReceipt(f.credential, event(1)),
    ).rejects.toThrow()
  })
})
