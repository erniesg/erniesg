import { afterEach, describe, expect, it, vi } from 'vitest'
import * as adapter from './adapter'
import worker from '../index'
import {
  createHarness,
  ADA,
  BOB,
  webAnnotation,
  scopeQuery,
  proposalBody,
} from './fixtures'
import { encodeBase64Url } from './base64url'
const SITE = 'https://ernie.sg',
  OTHER = 'https://example.org',
  AT = '2026-10-09T00:00:00.000Z'
const sha = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
    ),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('')
async function material(n = 1) {
  return {
    keyId: 'fixture-' + n,
    key: await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(n),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
  }
}
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
    h.database.execute('INSERT INTO margin_site_admins VALUES(?,?)', [
      site,
      identity,
    ])
  async function grant(site: string, n: number) {
    const selector = encodeBase64Url(new Uint8Array(16).fill(n)),
      value = [
        'margin-adapter-v1',
        selector,
        encodeBase64Url(new Uint8Array(32).fill(n + 10)),
      ].join('.'),
      hash = await sha(value)
    h.database.execute(
      'INSERT OR IGNORE INTO margin_adapters(site,adapter,enabled,created_at) VALUES(?,?,1,?)',
      [site, 'fixture-adapter', AT],
    )
    h.database.execute(
      'INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)',
      [selector, site, 'fixture-adapter', hash, 'approved_feed', AT],
    )
    h.database.execute(
      'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
      [selector, hash, site, 'fixture-adapter', AT],
    )
    return (await h.repository.findAdapterCredential(selector))!
  }
  async function approve(site: string) {
    const source = site + '/books/example/'
    const r = await h.request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({
        source,
        motivation: 'editing',
        visibility: 'private',
      }),
    })
    expect(r.status).toBe(201)
    const id = (await r.json()).id.replace('urn:margin:annotation:', '')
    expect(
      (
        await h.request('POST', `/proposals/${id}/apply${scopeQuery(source)}`, {
          body: { revision: 1 },
        })
      ).status,
    ).toBe(202)
    return { id, source }
  }
  const own = await approve(SITE),
    foreign = await approve(OTHER),
    credential = await grant(SITE, 1)
  const issue = (
    key: Awaited<ReturnType<typeof material>> | null = null,
    id = own.id,
    revision = 1,
  ) =>
    h.repository.getOrIssuePublicCorrelation(
      credential,
      { proposalId: id, approvedRevision: revision },
      key,
    )
  return { h, own, foreign, credential, grant, issue }
}
describe('durable public correlation initial RED families', () => {
  it('derives a bounded domain-separated value without public raw identity', async () => {
    const k = await material(),
      a = await adapter.derivePublicCorrelation(k, SITE, 'private-synthetic-id')
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(
      await adapter.derivePublicCorrelation(k, SITE, 'private-synthetic-id'),
    ).toBe(a)
    expect(
      await adapter.derivePublicCorrelation(k, OTHER, 'private-synthetic-id'),
    ).not.toBe(a)
    expect(
      await adapter.derivePublicCorrelation(k, SITE, 'other-private-id'),
    ).not.toBe(a)
    expect(
      await adapter.derivePublicCorrelation(
        await material(2),
        SITE,
        'private-synthetic-id',
      ),
    ).not.toBe(a)
    expect(
      `coordinator/margin-proposal-${a}\nmargin-proposal:${a}\nMargin-Proposal: ${a}`,
    ).not.toContain('private-synthetic-id')
  })
  it('uses exact approved revision and preserves the issued value across retry/key retirement/rotation', async () => {
    const f = await fixture(),
      key = await material()
    expect(await f.issue(key, f.own.id, 2)).toEqual({ status: 'conflict' })
    const first = await f.issue(key)
    expect(first).toMatchObject({
      status: 'ready',
      proposalId: f.own.id,
      site: SITE,
      approvedRevision: 1,
      publicCorrelation: {
        version: 1,
        value: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(await f.issue(null)).toEqual(first)
    expect(await f.issue(await material(2))).toEqual(first)
    expect(
      f.h.database.query('SELECT key_id FROM margin_public_correlations'),
    ).toEqual([{ key_id: 'fixture-1' }])
    expect(
      (
        await f.h.request(
          'PATCH',
          `/annotations/${f.own.id}${scopeQuery(f.own.source)}`,
          { as: BOB, body: { body: proposalBody('Later {++draft++}.') } },
        )
      ).status,
    ).toBe(200)
    expect(await f.issue(null)).toEqual(first)
  })
  it('rechecks current authority and hides foreign versus absent targets', async () => {
    const f = await fixture(),
      key = await material()
    expect(await f.issue(key, f.foreign.id)).toEqual({ status: 'not_found' })
    expect(await f.issue(key, 'absent')).toEqual({ status: 'not_found' })
    f.h.database.execute(
      'UPDATE margin_adapter_report_grants SET revoked_at=? WHERE token_id=?',
      [AT, f.credential.tokenId],
    )
    expect(await f.issue(key)).toEqual({ status: 'forbidden' })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
  })
  it('concurrent different-key issuance returns only the first committed value', async () => {
    const f = await fixture(),
      keys = await Promise.all([material(), material(2)])
    const both = await Promise.all(keys.map((k) => f.issue(k)))
    expect(both[0].status).toBe('ready')
    expect(both[1]).toEqual(both[0])
    expect(
      f.h.database.query('SELECT public_id FROM margin_public_correlations'),
    ).toHaveLength(1)
  })
  it('missing key is unavailable rather than granting raw-ID fallback; later provision can issue', async () => {
    const f = await fixture()
    expect(await f.issue(null)).toEqual({
      status: 'not_evaluated',
      reason: 'key_unavailable',
    })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
    expect(await f.issue(await material())).toMatchObject({ status: 'ready' })
  })
})

function watchQuery(
  f: Awaited<ReturnType<typeof fixture>>,
  transform: (
    sql: string,
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[],
) {
  const original = f.h.database.query.bind(f.h.database)
  return vi
    .spyOn(f.h.database, 'query')
    .mockImplementation((sql, params) => transform(sql, original(sql, params)))
}
async function report(
  f: Awaited<ReturnType<typeof fixture>>,
  outcome: any = { state: 'apply_failed', detail: 'fixture failure' },
  version = 0,
) {
  return f.h.repository.reportProposalExecution(
    f.credential,
    {
      eventId: encodeBase64Url(new Uint8Array(16).fill(version + 51)),
      proposalId: f.own.id,
      approvedRevision: 1,
      expectedStateVersion: version,
      outcome,
    },
    AT,
  )
}
describe('public correlation boundary controls', () => {
  for (const keyId of ['', 'x'.repeat(33), 'bad space', 1])
    it(`refuses malformed service key label ${JSON.stringify(keyId)}`, async () => {
      const k = await material()
      await expect(
        adapter.derivePublicCorrelation(
          { ...k, keyId: keyId as string },
          SITE,
          'id',
        ),
      ).rejects.toThrow()
    })
  for (const params of [
    { length: 16, hash: 'SHA-256', extractable: false, usages: ['sign'] },
    { length: 32, hash: 'SHA-512', extractable: false, usages: ['sign'] },
    { length: 32, hash: 'SHA-256', extractable: true, usages: ['sign'] },
    {
      length: 32,
      hash: 'SHA-256',
      extractable: false,
      usages: ['sign', 'verify'],
    },
  ])
    it(`requires dedicated 256-bit nonextractable sign-only HMAC ${JSON.stringify(params)}`, async () => {
      const key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(params.length).fill(3),
        { name: 'HMAC', hash: params.hash },
        params.extractable,
        params.usages as KeyUsage[],
      )
      await expect(
        adapter.derivePublicCorrelation({ keyId: 'fixture', key }, SITE, 'id'),
      ).rejects.toThrow()
    })
  it('preserves valid Unicode/BOM/control framing and refuses replacement-codepoint collisions', async () => {
    const key = await material(),
      values = [
        'id',
        '\ufeffid',
        'e\u0301',
        'é',
        'id\u0000id',
        '💡'.repeat(1024),
      ]
    const digests = await Promise.all(
      values.map((id) => adapter.derivePublicCorrelation(key, SITE, id)),
    )
    expect(new Set(digests).size).toBe(values.length)
    for (const id of ['\ud800', 'x'.repeat(2049), ''])
      await expect(
        adapter.derivePublicCorrelation(key, SITE, id),
      ).rejects.toThrow()
    for (const site of [
      'https://ernie.sg/path',
      'http://ernie.sg/',
      'https://ernie.sg/',
    ])
      await expect(
        adapter.derivePublicCorrelation(key, site, 'id'),
      ).rejects.toThrow()
  })
  it('rechecks revocation after real crypto await and before insertion', async () => {
    const f = await fixture(),
      key = await material(),
      sign = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      f.h.database.execute(
        'UPDATE margin_adapter_tokens SET revoked_at=? WHERE token_id=?',
        [AT, f.credential.tokenId],
      )
      return sign(...args)
    })
    expect(await f.issue(key)).toEqual({ status: 'forbidden' })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
  })
  it('does not disclose after grant revocation following a committed insert', async () => {
    const f = await fixture(),
      key = await material()
    const spy = watchQuery(f, (sql, rows) => {
      if (sql.startsWith('INSERT INTO margin_public_correlations'))
        f.h.database.execute(
          'UPDATE margin_adapter_report_grants SET revoked_at=? WHERE token_id=?',
          [AT, f.credential.tokenId],
        )
      return rows
    })
    expect(await f.issue(key)).toEqual({ status: 'forbidden' })
    spy.mockRestore()
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toHaveLength(1)
  })
  it('does not mint after execution changes during derivation', async () => {
    const f = await fixture(),
      key = await material(),
      sign = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      expect((await report(f)).status).toBe('accepted')
      return sign(...args)
    })
    expect(await f.issue(key)).toEqual({
      status: 'not_evaluated',
      reason: 'legacy_reconciliation_required',
    })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
  })
  it('recovers the committed identity after an actual SQL commit and lost response', async () => {
    const f = await fixture(),
      key = await material()
    const spy = watchQuery(f, (sql, rows) => {
      if (sql.startsWith('INSERT INTO margin_public_correlations'))
        throw Error('lost acknowledgement')
      return rows
    })
    expect(await f.issue(key)).toEqual({
      status: 'not_evaluated',
      reason: 'storage_unavailable',
    })
    spy.mockRestore()
    const rows = f.h.database.query(
      'SELECT public_id FROM margin_public_correlations',
    )
    expect(rows).toHaveLength(1)
    expect(await f.issue(null)).toMatchObject({
      status: 'ready',
      publicCorrelation: { value: rows[0].public_id },
    })
  })
  for (const stage of ['snapshot', 'crypto', 'insert', 'final'])
    it(`uses one deadline across ${stage} and preserves uncertain late commit`, async () => {
      const f = await fixture(),
        key = await material()
      let now = 0,
        reads = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const sign = crypto.subtle.sign.bind(crypto.subtle)
      vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
        const result = await sign(...args)
        if (stage === 'crypto') now = 5000
        return result
      })
      const spy = watchQuery(f, (sql, rows) => {
        if (sql.includes('AS correlation')) {
          reads++
          if (stage === 'snapshot' || (stage === 'final' && reads === 2))
            now = 5000
        }
        if (
          stage === 'insert' &&
          sql.startsWith('INSERT INTO margin_public_correlations')
        )
          now = 5000
        return rows
      })
      expect(await f.issue(key)).toEqual({
        status: 'not_evaluated',
        reason: 'deadline',
      })
      spy.mockRestore()
      expect(
        f.h.database.query('SELECT * FROM margin_public_correlations'),
      ).toHaveLength(['insert', 'final'].includes(stage) ? 1 : 0)
    })
  it('uses at most three SQL statements/one HMAC and at most one SQL read on existing identity', async () => {
    const f = await fixture(),
      key = await material(),
      sign = vi.spyOn(crypto.subtle, 'sign')
    f.h.database.executed.length = 0
    expect((await f.issue(key)).status).toBe('ready')
    expect(f.h.database.executed).toHaveLength(3)
    expect(sign).toHaveBeenCalledTimes(1)
    f.h.database.executed.length = 0
    await f.issue(null)
    expect(f.h.database.executed).toHaveLength(1)
    expect(sign).toHaveBeenCalledTimes(1)
  })
  it('adopts persisted identity after adapter-token rotation and never derives from the token', async () => {
    const f = await fixture(),
      first = await f.issue(await material()),
      other = await f.grant(SITE, 2)
    f.h.database.execute(
      'UPDATE margin_adapter_tokens SET revoked_at=? WHERE token_id=?',
      [AT, f.credential.tokenId],
    )
    expect(
      await f.h.repository.getOrIssuePublicCorrelation(
        other,
        { proposalId: f.own.id, approvedRevision: 1 },
        null,
      ),
    ).toEqual(first)
    expect(await f.issue(null)).toEqual({ status: 'forbidden' })
  })
  it('immutable associations do not modify execution counts/state or permit updates/delete/replacement', async () => {
    const f = await fixture(),
      before = f.h.database.query('SELECT * FROM margin_proposal_execution'),
      result = await f.issue(await material())
    expect(
      f.h.database.query('SELECT * FROM margin_proposal_execution'),
    ).toEqual(before)
    for (const sql of [
      'DELETE FROM margin_public_correlations',
      'UPDATE margin_public_correlations SET public_id=public_id',
      'INSERT OR REPLACE INTO margin_public_correlations SELECT * FROM margin_public_correlations',
    ])
      expect(() => f.h.database.execute(sql)).toThrow()
    expect(await f.issue(null)).toEqual(result)
  })
  it('migration enforces application/revision/site binding and globally unique public values even under REPLACE', async () => {
    const f = await fixture()
    await f.issue(await material())
    const row = f.h.database.query(
      'SELECT * FROM margin_public_correlations',
    )[0]
    const sql =
      'INSERT OR REPLACE INTO margin_public_correlations VALUES(?,?,?,?,?,?,?)'
    for (const patch of [
      { proposal_id: f.foreign.id },
      { proposal_id: f.foreign.id, site: OTHER },
      { proposal_id: 'absent', public_id: 'b'.repeat(64) },
      {
        proposal_id: f.foreign.id,
        site: OTHER,
        approved_revision: 2,
        public_id: 'c'.repeat(64),
      },
      { proposal_id: f.foreign.id, site: OTHER, public_id: 'a'.repeat(63) },
    ]) {
      const x: Record<string, unknown> = { ...row, ...patch }
      expect(() =>
        f.h.database.execute(sql, [
          x.proposal_id,
          x.site,
          x.approved_revision,
          x.public_id,
          x.key_id,
          x.scheme_version,
          x.issued_at,
        ]),
      ).toThrow()
    }
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toHaveLength(1)
  })
  it('does not backfill a legacy application missing execution metadata', async () => {
    const f = await fixture()
    f.h.database.execute('DROP TRIGGER margin_execution_no_delete')
    f.h.database.execute(
      'DELETE FROM margin_proposal_execution WHERE proposal_id=?',
      [f.own.id],
    )
    expect(await f.issue(await material())).toEqual({
      status: 'not_evaluated',
      reason: 'legacy_reconciliation_required',
    })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
  })
  it('does not issue into historical activity and can still read an existing association for eligible retry', async () => {
    const f = await fixture()
    expect((await report(f)).status).toBe('accepted')
    expect(await f.issue(await material())).toEqual({
      status: 'not_evaluated',
      reason: 'legacy_reconciliation_required',
    })
    const g = await fixture(),
      first = await g.issue(await material())
    expect((await report(g)).status).toBe('accepted')
    expect(await g.issue(null)).toEqual(first)
  })
  for (const state of ['closed', 'merged'])
    it(`does not turn terminal ${state} into eligible correlation work`, async () => {
      const f = await fixture()
      await f.issue(await material())
      const pr = {
        number: 1,
        url: 'https://github.com/erniesg/erniesg/pull/1',
        head: 'b'.repeat(40),
      }
      expect(
        (
          await report(f, {
            state: 'pr_open',
            pr,
            checks: 'not_evaluated',
            detail: null,
          })
        ).status,
      ).toBe('accepted')
      expect(
        (
          await report(
            f,
            {
              state,
              pr,
              ...(state === 'merged' ? { mergeCommit: 'c'.repeat(40) } : {}),
            },
            1,
          )
        ).status,
      ).toBe('accepted')
      expect(await f.issue(null)).toEqual({ status: 'conflict' })
    })
  it('refuses exhausted retries even if an opaque association was already issued', async () => {
    const f = await fixture()
    await f.issue(await material())
    for (let n = 0; n < 3; n++)
      expect((await report(f, undefined, n)).status).toBe('accepted')
    expect(await f.issue(null)).toEqual({ status: 'conflict' })
  })
  it('global HMAC collision is unavailable with no overwrite or alternate identity', async () => {
    const f = await fixture(),
      key = await material()
    vi.spyOn(crypto.subtle, 'sign').mockResolvedValue(new Uint8Array(32).buffer)
    expect((await f.issue(key)).status).toBe('ready')
    const foreignCredential = await f.grant(OTHER, 2)
    expect(
      await f.h.repository.getOrIssuePublicCorrelation(
        foreignCredential,
        { proposalId: f.foreign.id, approvedRevision: 1 },
        key,
      ),
    ).toEqual({ status: 'not_evaluated', reason: 'storage_unavailable' })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toHaveLength(1)
  })
  for (const patch of [
    { public_id: 'not-a-digest' },
    { site: OTHER },
    { approved_revision: 2 },
    { issued_at: 'yesterday' },
    { key_id: 'bad key' },
    { scheme_version: 2 },
  ])
    it(`refuses malformed or mismatched stored association ${JSON.stringify(patch)}`, async () => {
      const f = await fixture()
      await f.issue(await material())
      const spy = watchQuery(f, (sql, rows) =>
        sql.includes('AS correlation')
          ? rows.map((r) => ({
              ...r,
              correlation: JSON.stringify({
                ...JSON.parse(r.correlation as string),
                ...patch,
              }),
            }))
          : rows,
      )
      expect(await f.issue(null)).toEqual({
        status: 'not_evaluated',
        reason: 'storage_unavailable',
      })
      spy.mockRestore()
      expect(
        f.h.database.query('SELECT * FROM margin_public_correlations'),
      ).toHaveLength(1)
    })
  it('missing schema and malformed snapshot are unavailable, never treated as absent identity', async () => {
    const f = await fixture()
    f.h.database.execute('DROP TABLE margin_public_correlations')
    expect(await f.issue(await material())).toEqual({
      status: 'not_evaluated',
      reason: 'storage_unavailable',
    })
  })
  it('captures caller-owned target/credential/key labels before awaited work', async () => {
    const f = await fixture(),
      key = await material(),
      c = { ...f.credential },
      target = { proposalId: f.own.id, approvedRevision: 1 }
    const promise = f.h.repository.getOrIssuePublicCorrelation(c, target, key)
    c.site = OTHER
    target.proposalId = f.foreign.id
    key.keyId = 'changed-after-call'
    expect(await promise).toMatchObject({
      status: 'ready',
      proposalId: f.own.id,
      site: SITE,
    })
    expect(
      f.h.database.query('SELECT key_id FROM margin_public_correlations'),
    ).toEqual([{ key_id: 'fixture-1' }])
  })
})

describe('public correlation preservation and malformed boundaries', () => {
  it('preserves actual default work/feed bytes and keeps correlation HTTP opt-in unimplemented', async () => {
    const f = await fixture(),
      token = [
        'margin-adapter-v1',
        f.credential.tokenId,
        encodeBase64Url(new Uint8Array(32).fill(11)),
      ].join('.')
    const read = (path: string) =>
      worker.fetch(
        new Request(SITE + '/api/margin/v1/adapter/' + path, {
          headers: { authorization: 'Bearer ' + token },
        }),
        {
          MARGIN_DB: f.h.database,
          ASSETS: { fetch: async () => new Response('asset') },
        },
      )
    const before = await Promise.all(
      ['work', 'feed'].map(async (path) => {
        const r = await read(path)
        expect(r.status).toBe(200)
        return r.text()
      }),
    )
    expect((await f.issue(await material())).status).toBe('ready')
    for (const [n, path] of ['work', 'feed'].entries()) {
      const r = await read(path)
      expect(r.status).toBe(200)
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(await r.text()).toBe(before[n])
    }
    expect((await read('work?include=publicCorrelation')).status).toBe(400)
  })
  it('does not hide report grant absence or registry disablement behind an existing association', async () => {
    for (const revoke of [
      'DELETE FROM margin_adapter_report_grants',
      'UPDATE margin_adapters SET enabled=0',
    ]) {
      const f = await fixture()
      await f.issue(await material())
      f.h.database.execute(revoke)
      expect(await f.issue(null)).toEqual({ status: 'forbidden' })
    }
  })
  it('refuses foreign-bound eligible execution even when correlation exists', async () => {
    const f = await fixture()
    await f.issue(await material())
    expect((await report(f)).status).toBe('accepted')
    const spy = watchQuery(f, (sql, rows) =>
      sql.includes('AS correlation')
        ? rows.map((r) => {
            const target = JSON.parse(r.target as string)
            target.execution.bound_adapter = 'another-adapter'
            return { ...r, target: JSON.stringify(target) }
          })
        : rows,
    )
    expect(await f.issue(null)).toEqual({ status: 'forbidden' })
    spy.mockRestore()
  })
  for (const mode of [
    'empty',
    'duplicate',
    'unauthorized-data',
    'invalid-execution',
  ])
    it(`malformed ${mode} snapshot never issues`, async () => {
      const f = await fixture()
      const spy = watchQuery(f, (sql, rows) => {
        if (!sql.includes('AS correlation')) return rows
        if (mode === 'empty') return []
        if (mode === 'duplicate') return [...rows, ...rows]
        if (mode === 'unauthorized-data')
          return rows.map((r) => ({ ...r, authorized: 0 }))
        return rows.map((r) => {
          const target = JSON.parse(r.target as string)
          target.execution.approved_revision = 2
          return { ...r, target: JSON.stringify(target) }
        })
      })
      expect(await f.issue(await material())).toEqual({
        status: 'not_evaluated',
        reason: 'storage_unavailable',
      })
      spy.mockRestore()
      expect(
        f.h.database.query('SELECT * FROM margin_public_correlations'),
      ).toEqual([])
    })
  it('malformed committed RETURNING is uncertain and recovers without replacing it', async () => {
    const f = await fixture()
    const spy = watchQuery(f, (sql, rows) =>
      sql.startsWith('INSERT INTO margin_public_correlations')
        ? rows.map((r) => ({ ...r, public_id: 'f'.repeat(64) }))
        : rows,
    )
    expect(await f.issue(await material())).toEqual({
      status: 'not_evaluated',
      reason: 'storage_unavailable',
    })
    spy.mockRestore()
    const first = f.h.database.query(
      'SELECT public_id FROM margin_public_correlations',
    )[0].public_id
    expect(first).not.toBe('f'.repeat(64))
    expect(await f.issue(null)).toMatchObject({
      status: 'ready',
      publicCorrelation: { value: first },
    })
  })
  it('crypto unavailability is classified without storing secret/key/input error details', async () => {
    const f = await fixture()
    vi.spyOn(crypto.subtle, 'sign').mockRejectedValue(
      Error('private key or proposal detail'),
    )
    expect(await f.issue(await material())).toEqual({
      status: 'not_evaluated',
      reason: 'key_unavailable',
    })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
  })
})

describe('inherited public-correlation monotonic deadline amendment', () => {
  it('an earlier absolute deadline is not reset at the crypto boundary', async () => {
    const f = await fixture(),
      key = await material()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const sign = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      const value = await sign(...args)
      now = 12
      return value
    })
    expect(
      await f.h.repository.getOrIssuePublicCorrelation(
        f.credential,
        { proposalId: f.own.id, approvedRevision: 1 },
        key,
        10,
      ),
    ).toEqual({ status: 'not_evaluated', reason: 'deadline' })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
  })
  it('an expired inherited deadline does not start SQL or crypto', async () => {
    const f = await fixture(),
      key = await material()
    vi.spyOn(performance, 'now').mockReturnValue(100)
    const sign = vi.spyOn(crypto.subtle, 'sign')
    f.h.database.executed.length = 0
    expect(
      await f.h.repository.getOrIssuePublicCorrelation(
        f.credential,
        { proposalId: f.own.id, approvedRevision: 1 },
        key,
        50,
      ),
    ).toEqual({ status: 'not_evaluated', reason: 'deadline' })
    expect(f.h.database.executed).toHaveLength(0)
    expect(sign).not.toHaveBeenCalled()
  })
  it('a distant inherited deadline never extends the existing five-second ceiling', async () => {
    const f = await fixture(),
      key = await material()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const sign = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      const value = await sign(...args)
      now = 5000
      return value
    })
    expect(
      await f.h.repository.getOrIssuePublicCorrelation(
        f.credential,
        { proposalId: f.own.id, approvedRevision: 1 },
        key,
        1e9,
      ),
    ).toEqual({ status: 'not_evaluated', reason: 'deadline' })
    expect(
      f.h.database.query('SELECT * FROM margin_public_correlations'),
    ).toEqual([])
  })
  for (const deadline of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    null,
    true,
    '5000',
    [],
    {},
  ])
    it(`rejects invalid inherited scalar ${String(deadline)} before D1/HMAC`, async () => {
      const f = await fixture(),
        key = await material(),
        sign = vi.spyOn(crypto.subtle, 'sign')
      f.h.database.executed.length = 0
      await expect(
        f.h.repository.getOrIssuePublicCorrelation(
          f.credential,
          { proposalId: f.own.id, approvedRevision: 1 },
          key,
          deadline as number,
        ),
      ).rejects.toThrow(TypeError)
      expect(f.h.database.executed).toHaveLength(0)
      expect(sign).not.toHaveBeenCalled()
    })
  it('an inherited deadline expiring after SQL commit leaves a recoverable first row', async () => {
    const f = await fixture(),
      key = await material()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const spy = watchQuery(f, (sql, rows) => {
      if (sql.startsWith('INSERT INTO margin_public_correlations')) now = 12
      return rows
    })
    expect(
      await f.h.repository.getOrIssuePublicCorrelation(
        f.credential,
        { proposalId: f.own.id, approvedRevision: 1 },
        key,
        10,
      ),
    ).toEqual({ status: 'not_evaluated', reason: 'deadline' })
    spy.mockRestore()
    const rows = f.h.database.query(
      'SELECT public_id FROM margin_public_correlations',
    )
    expect(rows).toHaveLength(1)
    expect(await f.issue(null)).toMatchObject({
      status: 'ready',
      publicCorrelation: { value: rows[0].public_id },
    })
  })
  it('omitted and explicitly undefined deadline have identical result and bounded SQL shape', async () => {
    const f = await fixture(),
      g = await fixture(),
      key = await material()
    vi.spyOn(performance, 'now').mockReturnValue(100)
    f.h.database.executed.length = 0
    g.h.database.executed.length = 0
    const a = await f.issue(key)
    const b = await g.h.repository.getOrIssuePublicCorrelation(
      g.credential,
      { proposalId: g.own.id, approvedRevision: 1 },
      key,
      undefined,
    )
    expect(b).toEqual(a)
    expect(g.h.database.executed.map((s) => s.sql)).toEqual(
      f.h.database.executed.map((s) => s.sql),
    )
    expect(g.h.database.executed).toHaveLength(3)
  })
})
