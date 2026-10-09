/** Real HTTP handlers and SQL across fresh adapter instances; GitHub stays synthetic. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createKnownPRRefreshOperation } from './known-pr-refresh-operation'
import { createApprovedWorkClient, type WorkTransport } from './service-client'
import { handleAdapterRequest } from '../../src/worker/margin/adapter'
import { encodeBase64Url } from '../../src/worker/margin/base64url'
import {
  ADA,
  BOB,
  createHarness,
  scopeQuery,
  webAnnotation,
} from '../../src/worker/margin/fixtures'

const site = 'https://ernie.sg',
  origin = 'https://margin.example.invalid'
const at = '2026-10-08T00:00:00.000Z'
const event = (n: number) => encodeBase64Url(new Uint8Array(16).fill(n))
const token = [
  'margin-adapter-v1',
  event(11),
  encodeBase64Url(new Uint8Array(32).fill(11)),
].join('.')
const tokenHash = createHash('sha256').update(token).digest('hex')
const pr = {
  number: 42,
  url: 'https://github.com/erniesg/erniesg/pull/42',
  head: 'a'.repeat(40),
}
function providerResponse(state: 'open' | 'merged') {
  return new Response(
    JSON.stringify({
      url: 'https://api.github.com/repos/erniesg/erniesg/pulls/42',
      html_url: pr.url,
      number: pr.number,
      head: { sha: 'b'.repeat(40) },
      base: { repo: { full_name: 'erniesg/erniesg' } },
      state: state === 'open' ? 'open' : 'closed',
      merged: state === 'merged',
      merge_commit_sha: 'c'.repeat(40),
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}
async function fixture() {
  const h = createHarness(),
    clients: { dispose(): void }[] = []
  const close = () => {
    for (const client of clients) client.dispose()
    ;(Reflect.get(h.database, 'database') as DatabaseSync).close()
  }
  try {
    h.database.execute(
      'INSERT INTO margin_adapters(site,adapter,enabled,created_at) VALUES(?,?,1,?)',
      [site, 'integration-refresh', at],
    )
    h.database.execute(
      'INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)',
      [event(11), site, 'integration-refresh', tokenHash, 'approved_feed', at],
    )
    h.database.execute(
      'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
      [event(11), tokenHash, site, 'integration-refresh', at],
    )
    h.database.execute(
      'INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
      [ADA.provider, ADA.issuer, ADA.subject, at, at],
    )
    const identity = h.database.query('SELECT id FROM margin_identity')[0].id
    h.database.execute(
      "INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)",
      [identity, at],
    )
    h.database.execute('INSERT INTO margin_site_admins VALUES(?,?)', [
      site,
      identity,
    ])
    const source = site + '/books/chapter/'
    const created = await h.request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({
        source,
        motivation: 'editing',
        visibility: 'private',
      }),
    })
    expect(created.status).toBe(201)
    const proposalId = (await created.json()).id.replace(
      'urn:margin:annotation:',
      '',
    ) as string
    expect(
      (
        await h.request(
          'POST',
          `/proposals/${proposalId}/apply${scopeQuery(source)}`,
          { body: { revision: 1 } },
        )
      ).status,
    ).toBe(202)
    const serviceCalls: {
      method: string | undefined
      path: string
      body?: string
    }[] = []
    const serviceTransport: WorkTransport = async (input, init = {}) => {
      expect(new URL(String(input)).origin).toBe(origin)
      serviceCalls.push({
        method: init.method,
        path: new URL(String(input)).pathname,
        ...(init.body ? { body: String(init.body) } : {}),
      })
      return handleAdapterRequest(new Request(input, init), h.repository)
    }
    function serviceClient() {
      const client = createApprovedWorkClient(
        { origin, token },
        serviceTransport,
      )
      clients.push(client)
      return client
    }
    const seed = serviceClient()
    expect(
      (
        await seed.reportExecution({
          eventId: event(1),
          proposalId,
          approvedRevision: 1,
          expectedStateVersion: 0,
          outcome: {
            state: 'apply_failed',
            detail: 'Synthetic earlier failure',
          },
        })
      ).status,
    ).toBe('accepted')
    expect(
      (
        await seed.reportExecution({
          eventId: event(2),
          proposalId,
          approvedRevision: 1,
          expectedStateVersion: 1,
          outcome: { state: 'pr_open', pr, checks: 'pending', detail: null },
        })
      ).status,
    ).toBe('accepted')
    seed.dispose()
    serviceCalls.length = 0
    const providerCalls: string[] = []
    function operation(
      state: 'open' | 'merged',
      options: {
        wait?: () => Promise<void>
        dropReportResponse?: boolean
      } = {},
    ) {
      const op = createKnownPRRefreshOperation(
        {
          site,
          service: { origin, token },
          provider: { token: 'synthetic-explicit-token' },
        },
        {
          serviceTransport: async (input, init) => {
            const response = await serviceTransport(input, init)
            if (options.dropReportResponse && init?.method === 'POST') {
              // The real handler has already committed and returned its actual acknowledgement.
              expect(response.status).toBe(200)
              await response.arrayBuffer()
              throw Error('synthetic response lost after commit')
            }
            return response
          },
          providerTransport: async (input, init) => {
            expect(String(input)).toBe(
              'https://api.github.com/repos/erniesg/erniesg/pulls/42',
            )
            expect(init?.method).toBe('GET')
            providerCalls.push(String(input))
            await options.wait?.()
            return providerResponse(state)
          },
        },
      )
      clients.push(op)
      return op
    }
    const stored = () => ({
      ...h.database.query(
        'SELECT state_version,failed_apply_count,pr_head,merge_commit FROM margin_proposal_execution',
      )[0],
      ...h.database.query('SELECT state FROM margin_proposal_applications')[0],
      receipts: h.database.query(
        'SELECT COUNT(*) AS receipts FROM margin_adapter_report_receipts',
      )[0].receipts,
    })
    expect(stored()).toMatchObject({
      state: 'pr_open',
      state_version: 2,
      failed_apply_count: 1,
      receipts: 2,
    })
    return {
      h,
      proposalId,
      operation,
      serviceClient,
      stored,
      serviceCalls,
      providerCalls,
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}

describe('known-PR refresh operation with real handlers and SQLite persistence', () => {
  it('fresh invocations read open→merged state and exclude a terminal row without provider access', async () => {
    const f = await fixture()
    try {
      const first = f.operation('open')
      const open = await first.refresh({
        proposalId: f.proposalId,
        eventId: event(3),
      })
      first.dispose()
      expect(open.phase).toBe('report')
      if (open.phase !== 'report') throw Error('open report expected')
      expect(open.command).toMatchObject({
        eventId: event(3),
        approvedRevision: 1,
        expectedStateVersion: 2,
        outcome: { state: 'pr_open', checks: 'not_evaluated' },
      })
      expect(open.result).toMatchObject({
        status: 'accepted',
        ack: { stateVersion: 3, failedApplyCount: 1 },
      })
      expect(f.stored()).toMatchObject({
        state: 'pr_open',
        state_version: 3,
        failed_apply_count: 1,
        pr_head: 'b'.repeat(40),
        receipts: 3,
      })
      const second = f.operation('merged')
      const merged = await second.refresh({
        proposalId: f.proposalId,
        eventId: event(4),
      })
      second.dispose()
      expect(merged.phase).toBe('report')
      if (merged.phase !== 'report') throw Error('merged report expected')
      expect(merged.command).toMatchObject({
        eventId: event(4),
        expectedStateVersion: 3,
        outcome: { state: 'merged', mergeCommit: 'c'.repeat(40) },
      })
      expect(merged.result).toMatchObject({
        status: 'accepted',
        ack: { stateVersion: 4, failedApplyCount: 1 },
      })
      expect(f.stored()).toMatchObject({
        state: 'merged',
        state_version: 4,
        failed_apply_count: 1,
        merge_commit: 'c'.repeat(40),
        receipts: 4,
      })
      const before = f.stored(),
        third = f.operation('merged')
      expect(
        await third.refresh({ proposalId: f.proposalId, eventId: event(5) }),
      ).toEqual({
        phase: 'selection',
        status: 'not_evaluated',
        reason: 'not_in_page',
        nextCursor: null,
      })
      third.dispose()
      expect(f.stored()).toEqual(before)
      expect(f.providerCalls).toHaveLength(2)
      expect(f.serviceCalls.map((call) => call.method)).toEqual([
        'GET',
        'POST',
        'GET',
        'POST',
        'GET',
      ])
    } finally {
      f.close()
    }
  })
  it('fresh invocations racing one real CAS commit only one distinct event without Apply failures or retry', async () => {
    const f = await fixture()
    try {
      let arrivals = 0,
        release!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const wait = () => {
        if (++arrivals === 2) release()
        return barrier
      }
      const left = f.operation('open', { wait }),
        right = f.operation('open', { wait })
      const results = await Promise.all([
        left.refresh({ proposalId: f.proposalId, eventId: event(3) }),
        right.refresh({ proposalId: f.proposalId, eventId: event(4) }),
      ])
      left.dispose()
      right.dispose()
      const statuses: string[] = []
      for (const result of results) {
        expect(result.phase).toBe('report')
        if (result.phase !== 'report') throw Error('report expected')
        expect(result.command.expectedStateVersion).toBe(2)
        expect(result.command.outcome.state).toBe('pr_open')
        statuses.push(result.result.status)
        if (result.result.status === 'conflict')
          expect(result.result).toEqual({
            status: 'conflict',
            reason: 'report_conflict',
            delivery: 'unconfirmed',
          })
      }
      expect(statuses.sort()).toEqual(['accepted', 'conflict'])
      expect(f.stored()).toMatchObject({
        state: 'pr_open',
        state_version: 3,
        failed_apply_count: 1,
        receipts: 3,
      })
      expect(f.serviceCalls.map((call) => call.method)).toEqual([
        'GET',
        'GET',
        'POST',
        'POST',
      ])
      expect(f.providerCalls).toHaveLength(2)
      const receiptEvents = f.h.database
        .query('SELECT event_id FROM margin_adapter_report_receipts')
        .map((row) => row.event_id)
      expect(
        receiptEvents.filter((id) => id === event(3) || id === event(4)),
      ).toHaveLength(1)
    } finally {
      f.close()
    }
  })
  it('preserves a committed lost response for explicit exact-command replay and later fresh-state progression', async () => {
    const f = await fixture()
    try {
      const first = f.operation('open', { dropReportResponse: true })
      const lost = await first.refresh({
        proposalId: f.proposalId,
        eventId: event(3),
      })
      first.dispose()
      expect(lost.phase).toBe('report')
      if (lost.phase !== 'report') throw Error('report expected')
      expect(lost.command).toMatchObject({
        eventId: event(3),
        expectedStateVersion: 2,
        approvedRevision: 1,
      })
      expect(lost.result).toEqual({
        status: 'not_evaluated',
        reason: 'transport',
        delivery: 'unconfirmed',
      })
      expect(f.stored()).toMatchObject({
        state: 'pr_open',
        state_version: 3,
        failed_apply_count: 1,
        receipts: 3,
      })
      expect(f.serviceCalls.map((call) => call.method)).toEqual(['GET', 'POST'])
      // These are deliberate caller recovery actions, never an automatic operation retry.
      const recovery = f.serviceClient(),
        committed = f.stored()
      const receipt = await recovery.readReportReceipt(event(3))
      expect(receipt.status).toBe('found')
      if (receipt.status !== 'found') throw Error('receipt expected')
      expect(receipt.ack).not.toHaveProperty('fingerprint')
      expect(receipt.ack).not.toHaveProperty('outcome')
      const replayed = await recovery.reportExecution(lost.command)
      expect(replayed).toEqual({ status: 'accepted', ack: receipt.ack })
      expect(f.stored()).toEqual(committed)
      expect(
        await recovery.reportExecution({
          ...lost.command,
          outcome: {
            state: 'pr_open',
            pr: { ...pr, head: 'd'.repeat(40) },
            checks: 'not_evaluated',
            detail: null,
          },
        }),
      ).toEqual({
        status: 'conflict',
        reason: 'report_conflict',
        delivery: 'unconfirmed',
      })
      expect(f.stored()).toEqual(committed)
      recovery.dispose()
      const next = f.operation('merged'),
        merged = await next.refresh({
          proposalId: f.proposalId,
          eventId: event(4),
        })
      next.dispose()
      expect(merged.phase).toBe('report')
      if (merged.phase !== 'report') throw Error('merged report expected')
      expect(merged.command.expectedStateVersion).toBe(3)
      expect(merged.result.status).toBe('accepted')
      expect(f.stored()).toMatchObject({
        state: 'merged',
        state_version: 4,
        failed_apply_count: 1,
        receipts: 4,
      })
      expect(f.serviceCalls.map((call) => call.method)).toEqual([
        'GET',
        'POST',
        'GET',
        'POST',
        'POST',
        'GET',
        'POST',
      ])
      expect(f.providerCalls).toHaveLength(2)
    } finally {
      f.close()
    }
  })
})
