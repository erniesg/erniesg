/** Initial contract REDs and actual-handler synthetic resource pilots. No live transport. */
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleAdapterRequest,
  ADAPTER_WORK_PATH,
  ADAPTER_PAGE_BYTES,
} from '../../src/worker/margin/adapter'
import * as repository from '../../src/worker/margin/repository'
import type { AdapterWorkCandidate } from '../../src/worker/margin/repository'
import { encodeBase64Url } from '../../src/worker/margin/base64url'
import { formatHunks } from '../../src/annotations/criticmarkup'
const ORIGIN = 'https://margin.example.invalid',
  SITE = 'https://second.example.invalid'
const date = '2026-10-08T00:00:00.000Z',
  later = '2026-10-08T00:01:00.000Z'
const segment = (length: number) =>
  encodeBase64Url(new Uint8Array(length).fill(7))
const token = ['margin-adapter-v1', segment(16), segment(32)].join('.')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function candidate(
  id: string,
  state: 'approved' | 'pr_open' | 'conflict' | 'apply_failed' = 'approved',
  content = 'Old text.',
): AdapterWorkCandidate {
  const pr =
    state === 'pr_open'
      ? {
          number: 1,
          url: 'http://forge.example.invalid/pull/1',
          head: 'b'.repeat(40),
        }
      : null
  return {
    proposalId: id,
    site: SITE,
    document: '/manual/chapter?view=1#section',
    source: SITE + '/manual/chapter?view=1#section',
    approvedRevision: 1,
    body: formatHunks([
      { baseStartLine: 1, baseEndLine: 1, criticMarkup: content },
    ]),
    baseCommit: 'a'.repeat(40),
    sourcePath: 'manual/chapter.txt',
    visibility: 'private',
    approvedAt: date,
    execution: {
      state,
      stateVersion: state === 'approved' ? 0 : 2,
      failedApplyCount: state === 'apply_failed' ? 1 : 0,
      boundAdapter: state === 'approved' ? null : 'fixture',
      pr,
      checks: pr ? 'pending' : null,
      detail: ['conflict', 'apply_failed'].includes(state)
        ? 'Synthetic result'
        : null,
      mergeCommit: null,
      lastEvent: state === 'approved' ? null : segment(16),
      updatedAt: state === 'approved' ? date : later,
    },
  }
}
function service(candidates: AdapterWorkCandidate[]) {
  const credential = {
    tokenId: segment(16),
    site: SITE,
    adapter: 'fixture',
    tokenSha256: sha(token),
    capability: 'approved_feed',
    createdAt: date,
    revokedAt: null,
    enabled: true,
    registrationCreatedAt: date,
  }
  const repo = {
    findAdapterCredential: vi.fn(async () => credential),
    listAdapterWork: vi.fn(async () => ({ authorized: true, candidates })),
    listApprovedFeed: vi.fn(async () => {
      throw Error('wrong route')
    }),
    reportProposalExecution: vi.fn(async () => {
      throw Error('write forbidden')
    }),
    readAdapterReport: vi.fn(async () => {
      throw Error('write transport excluded')
    }),
  }
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handleAdapterRequest(new Request(input, init), repo as any),
  )
  return { transport, repo }
}
async function api() {
  const url = new URL('./service-client.ts', import.meta.url)
  const module = existsSync(url)
    ? await import(/* @vite-ignore */ url.href)
    : {}
  expect(
    module.createApprovedWorkClient,
    'new client API absent; not an old behavior failure',
  ).toBeTypeOf('function')
  return module.createApprovedWorkClient as any
}
function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value) + '\n', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
function emptyPage() {
  return {
    eligibility: 'known_execution',
    items: [],
    nextCursor: null,
    scanned: 0,
    notEvaluated: { unknownExecution: 0 },
    excluded: { exhaustedFailures: 0, otherAdapter: 0 },
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('approved work client initial RED families', () => {
  it('reuses the existing pure execution tuple rule before accepting an actual service page', async () => {
    expect(
      (repository as any).validReportTuple,
      'shared tuple export absent; extraction not yet implemented',
    ).toBeTypeOf('function')
    const create = await api(),
      f = service([
        candidate('p0'),
        candidate('p1', 'pr_open'),
        candidate('p2', 'conflict'),
        candidate('p3', 'apply_failed'),
      ])
    const client = create({ origin: ORIGIN, token }, f.transport)
    const result = await client.readPage()
    expect(result.status).toBe('ready')
    expect(result.page.items.map((r: any) => r.work)).toEqual([
      'apply',
      'refresh_pr',
      'apply',
      'apply',
    ])
    expect(
      result.page.items.every(
        (r: any) => r.site === SITE && r.sourcePath === 'manual/chapter.txt',
      ),
    ).toBe(true)
    expect(f.repo.reportProposalExecution).not.toHaveBeenCalled()
    client.dispose()
  })
  it('confines bearer transport to configured origin and refuses cookie/redirect/cursor authority', async () => {
    const create = await api(),
      f = service([]),
      client = create({ origin: ORIGIN, token }, f.transport)
    expect((await client.readPage()).status).toBe('ready')
    const [url, init] = f.transport.mock.calls[0]
    expect(String(url)).toBe(ORIGIN + ADAPTER_WORK_PATH + '?limit=25')
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    })
    expect(
      new Headers(init?.headers).get('authorization') === 'Bearer ' + token,
    ).toBe(true)
    expect(new Headers(init?.headers).has('cookie')).toBe(false)
    const result = await client.readPage({
      cursor: 'https://other.example.invalid/',
    })
    expect(result.status).toBe('refused')
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result).includes(token)).toBe(false)
    client.dispose()
  })
  it('refuses complete malformed data and excess bytes rather than returning partial work', async () => {
    const create = await api()
    for (const response of [
      new Response(
        '{"eligibility":"wrong","eligibility":"known_execution","items":[],"nextCursor":null,"scanned":0,"notEvaluated":{"unknownExecution":0},"excluded":{"exhaustedFailures":0,"otherAdapter":0}}\n',
        { headers: { 'content-type': 'application/json' } },
      ),
      jsonResponse({ ...emptyPage(), scanned: 1 }),
      new Response(new Uint8Array([0xff]), {
        headers: { 'content-type': 'application/json' },
      }),
      new Response(new Uint8Array(ADAPTER_PAGE_BYTES + 1), {
        headers: { 'content-type': 'application/json' },
      }),
    ]) {
      const transport = vi.fn(async () => response),
        client = create({ origin: ORIGIN, token }, transport)
      const result = await client.readPage()
      expect(result.status).toBe('not_evaluated')
      expect(result).not.toHaveProperty('page')
      expect(transport).toHaveBeenCalledTimes(1)
      client.dispose()
    }
  })
  it('keeps one occupied slot after ignored abort and cancels the eventual late body', async () => {
    const create = await api()
    vi.useFakeTimers()
    let settle!: (response: Response) => void
    const cancelled = vi.fn(),
      transport = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve
          }),
      )
    const client = create({ origin: ORIGIN, token }, transport)
    const first = client.readPage()
    await vi.advanceTimersByTimeAsync(10_001)
    expect((await first).status).toBe('not_evaluated')
    expect((await client.readPage()).reason).toBe('busy')
    expect(transport).toHaveBeenCalledTimes(1)
    settle(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled()
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled).toHaveBeenCalledTimes(1)
    transport.mockImplementation(async () => jsonResponse(emptyPage()))
    expect((await client.readPage()).status).toBe('ready')
    client.dispose()
    expect((await client.readPage()).status).toBe('refused')
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('distinguishes service authorization refusal from unavailable reads without retries', async () => {
    const create = await api()
    for (const status of [401, 403, 503]) {
      const transport = vi.fn(async () => new Response('', { status })),
        client = create({ origin: ORIGIN, token }, transport)
      const result = await client.readPage()
      expect(result.status).toBe(status === 503 ? 'not_evaluated' : 'refused')
      expect(result).not.toHaveProperty('page')
      expect(transport).toHaveBeenCalledTimes(1)
      client.dispose()
    }
  })
})

describe('existing approved-work handler synthetic resource pilot', () => {
  const mixed = () => {
    const rows = [
      candidate('p0'),
      candidate('p1', 'pr_open'),
      candidate('p2', 'conflict'),
      candidate('p3', 'apply_failed'),
      candidate('p4'),
      candidate('p5', 'apply_failed'),
      candidate('p6', 'pr_open'),
    ]
    rows[4].execution = null
    rows[5].execution!.failedApplyCount = rows[5].execution!.stateVersion = 3
    rows[6].execution!.boundAdapter = 'other'
    return rows
  }
  const cases = [
    { name: 'empty', rows: () => [], limit: 25, expected: 200 },
    { name: 'mixed-state-diagnostics', rows: mixed, limit: 25, expected: 200 },
    {
      name: 'fifty-near-body-ascii',
      rows: () =>
        Array.from({ length: 50 }, (_, i) =>
          candidate(
            'p' + String(i).padStart(2, '0'),
            'approved',
            'x'.repeat(62_000),
          ),
        ),
      limit: 50,
      expected: 200,
    },
    {
      name: 'unicode-visible-byte-refusal',
      rows: () =>
        Array.from({ length: 50 }, (_, i) =>
          candidate(
            'p' + String(i).padStart(2, '0'),
            'approved',
            'λ'.repeat(62_000),
          ),
        ),
      limit: 50,
      expected: 503,
    },
    {
      name: 'long-id-cursor',
      rows: () => [
        candidate('λ'.repeat(2047) + '1'),
        candidate('λ'.repeat(2047) + '2'),
      ],
      limit: 1,
      expected: 200,
    },
  ]
  for (const item of cases)
    it(item.name, async () => {
      const rows = item.rows(),
        f = service(rows),
        started = performance.now()
      const response = await f.transport(
        ORIGIN + ADAPTER_WORK_PATH + '?limit=' + item.limit,
        { headers: { authorization: 'Bearer ' + token } },
      )
      const text = await response.text(),
        bytes = Buffer.byteLength(text),
        elapsedMs = performance.now() - started
      expect(response.status).toBe(item.expected)
      expect(bytes).toBeLessThanOrEqual(ADAPTER_PAGE_BYTES)
      const body = JSON.parse(text)
      if (item.name === 'mixed-state-diagnostics')
        expect(body).toMatchObject({
          scanned: 7,
          notEvaluated: { unknownExecution: 1 },
          excluded: { exhaustedFailures: 1, otherAdapter: 1 },
        })
      if (item.name === 'long-id-cursor') {
        expect(body.nextCursor.length).toBeLessThanOrEqual(32_768)
        expect(body.scanned).toBe(1)
      }
      if (item.expected === 200) {
        expect(text).toBe(JSON.stringify(body) + '\n')
        expect(body.items).toHaveLength(
          item.name === 'mixed-state-diagnostics'
            ? 4
            : Math.min(rows.length, item.limit),
        )
        expect(
          body.items.every(
            (r: any) => !Object.hasOwn(r.execution, 'boundAdapter'),
          ),
        ).toBe(true)
      }
      expect(f.repo.reportProposalExecution).not.toHaveBeenCalled()
      const observation = {
        name: item.name,
        status: response.status,
        rows: rows.length,
        responseBytes: bytes,
        maxBodyCharacters: Math.max(0, ...rows.map((r) => r.body.length)),
        cursorCharacters: body.nextCursor?.length ?? 0,
        elapsedMs,
        actualExistingHandler: true,
        repositoryAuthorityMocked: true,
        clientExercisedByThisPilot: false,
        networkCalls: 0,
      }
      if (process.env.SERVICE_CLIENT_PILOT_OUTPUT)
        writeFileSync(
          path.join(
            process.env.SERVICE_CLIENT_PILOT_OUTPUT,
            item.name + '.json',
          ),
          JSON.stringify(observation, null, 2) + '\n',
          { flag: 'wx' },
        )
    })
})

async function pageFrom(rows = [candidate('p0')]) {
  const f = service(rows)
  return (
    await f.transport(ORIGIN + ADAPTER_WORK_PATH, {
      headers: { authorization: 'Bearer ' + token },
    })
  ).json()
}
async function readValue(value: unknown) {
  const create = await api(),
    client = create({ origin: ORIGIN, token }, async () => jsonResponse(value))
  const result = await client.readPage()
  client.dispose()
  return result
}
describe('closed work-page behavioral boundaries', () => {
  it('accepts all work classifications and generic HTTP tenant metadata without local planner narrowing', async () => {
    const rows = [
      candidate('p0'),
      candidate('p1', 'conflict'),
      candidate('p2', 'pr_open'),
    ]
    for (const row of rows) {
      row.site = 'http://second.example.invalid'
      row.source = row.site + row.document
      row.approvedRevision = Number.MAX_SAFE_INTEGER
    }
    rows[0].body = formatHunks([
      { baseStartLine: 1, baseEndLine: 1, criticMarkup: 'λ'.repeat(62_000) },
    ])
    rows[1].execution!.stateVersion = rows[1].execution!.failedApplyCount = 3
    rows[2].execution!.stateVersion = rows[2].execution!.failedApplyCount = 3
    const result = await readValue(await pageFrom(rows))
    expect(result.status).toBe('ready')
    expect(result.page.items.map((r: any) => r.work)).toEqual([
      'apply',
      'reconcile_only',
      'refresh_pr',
    ])
    expect(result.page.items[0].body).toBe(rows[0].body)
  })
  const changes: [string, (page: any) => void][] = [
    ['unknown page key', (p) => (p.extra = true)],
    ['unknown item key', (p) => (p.items[0].secret = true)],
    ['private adapter', (p) => (p.items[0].execution.boundAdapter = 'fixture')],
    ['source binding', (p) => (p.items[0].source += 'different')],
    ['tenant suffix', (p) => (p.items[0].document = p.items[0].source)],
    ['source traversal', (p) => (p.items[0].sourcePath = '../secret')],
    ['noncanonical body', (p) => (p.items[0].body += ' ')],
    ['short commit', (p) => (p.items[0].baseCommit = 'abc')],
    [
      'unsafe revision',
      (p) => (p.items[0].approvedRevision = Number.MAX_SAFE_INTEGER + 1),
    ],
    ['invalid date', (p) => (p.items[0].approvedAt = 'yesterday')],
    ['legacy execution', (p) => (p.items[0].execution = null)],
    ['unknown state', (p) => (p.items[0].execution.state = 'merged')],
    ['wrong work', (p) => (p.items[0].work = 'refresh_pr')],
    [
      'initial last event',
      (p) => (p.items[0].execution.lastEvent = segment(16)),
    ],
    ['initial timestamp', (p) => (p.items[0].execution.updatedAt = later)],
    ['partial PR', (p) => (p.items[0].execution.pr = { number: 1 })],
    ['counter conservation', (p) => (p.scanned = 2)],
    ['fractional count', (p) => (p.excluded.otherAdapter = 0.5)],
    ['continuation underfull', (p) => (p.nextCursor = segment(16))],
    ['missing diagnostics', (p) => delete p.notEvaluated],
    ['unknown nested key', (p) => (p.excluded.extra = 0)],
  ]
  for (const [name, change] of changes)
    it('refuses ' + name, async () => {
      const page = await pageFrom()
      change(page)
      expect(await readValue(page)).toMatchObject({ status: 'not_evaluated' })
    })
  it('binds every execution tuple and stamp, including PR conflict and exhausted failures', async () => {
    for (const change of [
      (p: any) => (p.items[0].execution.lastEvent = null),
      (p: any) => (p.items[0].execution.failedApplyCount = 3),
      (p: any) => (p.items[0].execution.stateVersion = 0),
      (p: any) => (p.items[0].execution.detail = null),
    ]) {
      const p = await pageFrom([candidate('p0', 'apply_failed')])
      change(p)
      expect((await readValue(p)).status).toBe('not_evaluated')
    }
    const p = await pageFrom([candidate('p0', 'pr_open')])
    p.items[0].execution.state = 'conflict'
    p.items[0].execution.detail = 'Conflict'
    expect((await readValue(p)).status).toBe('not_evaluated')
    p.items[0].execution.checks = 'not_evaluated'
    expect((await readValue(p)).status).toBe('ready')
  })
  it('requires UTF8 BINARY row order, unique IDs and consistent site', async () => {
    const p = await pageFrom([candidate('\ue000'), candidate('\u{10000}')])
    expect((await readValue(p)).status).toBe('ready')
    p.items.reverse()
    expect((await readValue(p)).status).toBe('not_evaluated')
    p.items.reverse()
    p.items[1].proposalId = p.items[0].proposalId
    p.items[1].approvedAt = later
    p.items[1].execution.updatedAt = later
    expect((await readValue(p)).status).toBe('not_evaluated')
    const q = await pageFrom([candidate('p0'), candidate('p1')])
    q.items[1].site = 'https://third.example.invalid'
    q.items[1].source = q.items[1].site + q.items[1].document
    expect((await readValue(q)).status).toBe('not_evaluated')
  })
  it('accepts an actual full-page cursor without treating it as authority or following it', async () => {
    const create = await api(),
      f = service([candidate('p0'), candidate('p1')]),
      client = create({ origin: ORIGIN, token }, f.transport)
    const result = await client.readPage({ limit: 1 })
    expect(result.status).toBe('ready')
    expect(result.page.nextCursor).toBeTypeOf('string')
    expect(f.transport).toHaveBeenCalledTimes(1)
    client.dispose()
  })
  it('checks canonical raw JSON before any object transformation and bounds nesting', async () => {
    const create = await api(),
      canonical = JSON.stringify(emptyPage())
    for (const text of [
      canonical,
      ' ' + canonical + '\n',
      '\ufeff' + canonical + '\n',
      canonical.replace('"scanned":0', '"scanned":-0') + '\n',
      '['.repeat(17) + '0' + ']'.repeat(17) + '\n',
    ]) {
      const client = create(
        { origin: ORIGIN, token },
        async () =>
          new Response(text, {
            headers: { 'content-type': 'application/json' },
          }),
      )
      expect((await client.readPage()).status).toBe('not_evaluated')
      client.dispose()
    }
  })
  it('refuses invalid config and options without dispatch or payload echo', async () => {
    const create = await api(),
      transport = vi.fn(async () => jsonResponse(emptyPage()))
    for (const config of [
      { origin: 'http://margin.example.invalid', token },
      { origin: ORIGIN + '/', token },
      { origin: ORIGIN + '?x=1', token },
      { origin: ORIGIN, token: token + '=' },
      { origin: ORIGIN, token, extra: true },
    ]) {
      const client = create(config, transport)
      expect((await client.readPage()).status).toBe('refused')
      client.dispose()
    }
    const client = create({ origin: ORIGIN, token }, transport)
    for (const options of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { cursor: '' },
      { cursor: 'x'.repeat(32_769) },
      { site: SITE },
    ])
      expect((await client.readPage(options)).status).toBe('refused')
    expect(transport).not.toHaveBeenCalled()
    client.dispose()
  })
})
describe('owned offline transport lifecycle', () => {
  for (const mode of ['denied', 'header', 'oversize'] as const)
    it(
      'retains occupancy until cancellation acknowledgement on ' + mode,
      async () => {
        const create = await api()
        vi.useFakeTimers()
        let acknowledge!: () => void
        const cancel = vi.fn(
          () =>
            new Promise<void>((r) => {
              acknowledge = r
            }),
        )
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            if (mode === 'oversize')
              c.enqueue(new Uint8Array(ADAPTER_PAGE_BYTES + 1))
          },
          cancel,
        })
        const transport = vi.fn(
          async () =>
            new Response(body, {
              status: mode === 'denied' ? 403 : 200,
              headers: {
                'content-type':
                  mode === 'header' ? 'text/plain' : 'application/json',
              },
            }),
        )
        const client = create({ origin: ORIGIN, token }, transport),
          pending = client.readPage()
        await vi.advanceTimersByTimeAsync(10_001)
        const result = await pending
        expect(result.status).toBe(
          mode === 'denied' ? 'refused' : 'not_evaluated',
        )
        expect(cancel).toHaveBeenCalledTimes(1)
        expect((await client.readPage()).reason).toBe('busy')
        expect(transport).toHaveBeenCalledTimes(1)
        acknowledge()
        await vi.advanceTimersByTimeAsync(0)
        transport.mockImplementation(async () => jsonResponse(emptyPage()))
        expect((await client.readPage()).status).toBe('ready')
        client.dispose()
      },
    )
  it('does not reset the deadline between fetch and body, suppresses late success', async () => {
    const create = await api()
    vi.useFakeTimers()
    let resolve!: (r: Response) => void,
      controller!: ReadableStreamDefaultController<Uint8Array>,
      acknowledge!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        return new Promise<void>((r) => {
          acknowledge = r
        })
      },
    })
    const transport = vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r
          }),
      ),
      client = create({ origin: ORIGIN, token }, transport)
    const result = client.readPage()
    await vi.advanceTimersByTimeAsync(8_000)
    resolve(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    )
    await vi.advanceTimersByTimeAsync(1_999)
    let done = false
    void result.then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await result).toMatchObject({
      status: 'not_evaluated',
      reason: 'timeout',
    })
    // The ignored pending read must be cancelled even though it has not settled.
    expect(acknowledge).toBeTypeOf('function')
    expect((await client.readPage()).reason).toBe('busy')
    acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    client.dispose()
    expect(() => controller.enqueue(new Uint8Array())).toThrow()
  })
  it('disposal cancels outstanding bodies and permanently refuses new work', async () => {
    const create = await api()
    vi.useFakeTimers()
    const cancel = vi.fn(),
      body = new ReadableStream<Uint8Array>({ cancel }),
      transport = vi.fn(
        async () =>
          new Response(body, {
            headers: { 'content-type': 'application/json' },
          }),
      )
    const client = create({ origin: ORIGIN, token }, transport),
      pending = client.readPage()
    await vi.advanceTimersByTimeAsync(0)
    client.dispose()
    expect((await pending).status).toBe('not_evaluated')
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect((await client.readPage()).status).toBe('refused')
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('settlement and complete resource boundaries', () => {
  it('permits the next explicit read immediately after a fully consumed successful page', async () => {
    const create = await api(),
      transport = vi.fn(async () => jsonResponse(emptyPage())),
      client = create({ origin: ORIGIN, token }, transport)
    expect((await client.readPage()).status).toBe('ready')
    expect((await client.readPage()).status).toBe('ready')
    expect(transport).toHaveBeenCalledTimes(2)
    client.dispose()
  })
  it('keeps rejected cancellation unavailable and does not echo private transport exceptions', async () => {
    const create = await api(),
      cancel = vi.fn(async () => {
        throw Error('private cancellation detail')
      })
    const transport = vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), { status: 403 }),
      ),
      client = create({ origin: ORIGIN, token }, transport)
    expect((await client.readPage()).status).toBe('refused')
    await Promise.resolve()
    await Promise.resolve()
    expect((await client.readPage()).reason).toBe('busy')
    expect(transport).toHaveBeenCalledTimes(1)
    client.dispose()
    for (const transport of [
      () => {
        throw Error(token)
      },
      async () => {
        throw Error(token)
      },
    ]) {
      const failing = create({ origin: ORIGIN, token }, transport),
        result = await failing.readPage()
      expect(result).toEqual({ status: 'not_evaluated', reason: 'transport' })
      expect(JSON.stringify(result).includes(token)).toBe(false)
      failing.dispose()
    }
  })
  it('cancels every early response refusal body without consuming it', async () => {
    const create = await api()
    const responses: ResponseInit[] = [
      { status: 400 },
      { status: 401 },
      { status: 404 },
      { status: 405 },
      { status: 500 },
      { status: 503 },
      { headers: { 'content-type': 'text/html' } },
      {
        headers: {
          'content-type': 'application/json',
          'content-length': String(ADAPTER_PAGE_BYTES + 1),
        },
      },
      {
        headers: {
          'content-type': 'application/json',
          'content-length': 'unknown',
        },
      },
    ]
    for (const options of responses) {
      const cancel = vi.fn(),
        response = new Response(new ReadableStream({ cancel }), options)
      const client = create({ origin: ORIGIN, token }, async () => response)
      expect((await client.readPage()).status).not.toBe('ready')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cancel).toHaveBeenCalledTimes(1)
      client.dispose()
    }
  })
  it('refuses a redirected transport response, even if its page is otherwise valid', async () => {
    const create = await api(),
      response = jsonResponse(emptyPage())
    Object.defineProperty(response, 'url', {
      value: 'https://other.example.invalid/api/margin/v1/adapter/work',
    })
    const client = create({ origin: ORIGIN, token }, async () => response)
    expect(await client.readPage()).toEqual({
      status: 'not_evaluated',
      reason: 'response',
    })
    client.dispose()
  })
  it('checks the original deadline after synchronous parsing and before any ready result', async () => {
    const create = await api()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const original = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, ...args) => {
      const value = original(text, ...args)
      if (text.includes('known_execution')) clock = 10_001
      return value
    })
    const client = create({ origin: ORIGIN, token }, async () => {
      clock = 8_000
      return jsonResponse(emptyPage())
    })
    expect(await client.readPage()).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
    })
    client.dispose()
  })
  it('supports chunked UTF8 with empty chunks and JSON brackets inside escaped strings', async () => {
    const p = await pageFrom([candidate('p0', 'conflict')])
    p.items[0].execution.detail = 'Quoted "' + '['.repeat(30) + '\\λ'
    const bytes = new TextEncoder().encode(JSON.stringify(p) + '\n')
    const create = await api(),
      body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 1000; i++) c.enqueue(new Uint8Array())
          for (const byte of bytes) c.enqueue(new Uint8Array([byte]))
          c.close()
        },
      })
    const client = create(
      { origin: ORIGIN, token },
      async () =>
        new Response(body, { headers: { 'content-type': 'application/json' } }),
    )
    const result = await client.readPage()
    expect(result.status).toBe('ready')
    expect(result.page.items[0].execution.detail).toBe(
      p.items[0].execution.detail,
    )
    client.dispose()
  })
  it('counts the final newline within the exact 4 MiB limit for an actual-handler page', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      candidate(
        'p' + String(i).padStart(2, '0'),
        'approved',
        'x'.repeat(62_000),
      ),
    )
    const f = service(rows),
      response = await f.transport(ORIGIN + ADAPTER_WORK_PATH + '?limit=50', {
        headers: { authorization: 'Bearer ' + token },
      })
    const p = await response.json()
    let extra = ADAPTER_PAGE_BYTES - Buffer.byteLength(JSON.stringify(p) + '\n')
    for (const item of p.items) {
      const take = Math.min(extra, 62_000)
      extra -= take
      item.body = formatHunks([
        {
          baseStartLine: 1,
          baseEndLine: 1,
          criticMarkup: 'λ'.repeat(take) + 'x'.repeat(62_000 - take),
        },
      ])
    }
    expect(extra).toBe(0)
    const wire = JSON.stringify(p) + '\n'
    expect(Buffer.byteLength(wire)).toBe(ADAPTER_PAGE_BYTES)
    const create = await api(),
      client = create(
        { origin: ORIGIN, token },
        async () =>
          new Response(wire, {
            headers: { 'content-type': 'application/json' },
          }),
      )
    expect((await client.readPage({ limit: 50 })).status).toBe('ready')
    client.dispose()
    const excess = create(
      { origin: ORIGIN, token },
      async () =>
        new Response(wire + ' ', {
          headers: { 'content-type': 'application/json' },
        }),
    )
    expect((await excess.readPage({ limit: 50 })).status).toBe('not_evaluated')
    excess.dispose()
  })
})

describe('shared rule and terminal lifecycle completion', () => {
  it('preserves unknown and excluded diagnostics even when no work item is returned', async () => {
    const rows = [
      candidate('p0'),
      candidate('p1', 'apply_failed'),
      candidate('p2', 'pr_open'),
    ]
    rows[0].execution = null
    rows[1].execution!.stateVersion = rows[1].execution!.failedApplyCount = 3
    rows[2].execution!.boundAdapter = 'other'
    const result = await readValue(await pageFrom(rows))
    expect(result.status).toBe('ready')
    expect(result.page).toMatchObject({
      items: [],
      scanned: 3,
      notEvaluated: { unknownExecution: 1 },
      excluded: { exhaustedFailures: 1, otherAdapter: 1 },
    })
  })
  it('rejects exhausted failures even with otherwise consistent version and work fields', async () => {
    const p = await pageFrom([candidate('p0', 'apply_failed')])
    p.items[0].execution.stateVersion =
      p.items[0].execution.failedApplyCount = 3
    p.items[0].work = 'reconcile_only'
    expect((await readValue(p)).status).toBe('not_evaluated')
  })
  it('refuses every malformed scalar or partial PR before shared state validation', async () => {
    for (const change of [
      (e: any) => (e.stateVersion = true),
      (e: any) => (e.failedApplyCount = 4),
      (e: any) => (e.lastEvent += '='),
      (e: any) => (e.updatedAt = 'not a date'),
      (e: any) => (e.pr.number = 0),
      (e: any) => (e.pr.head = 'abc'),
      (e: any) => (e.pr.url = 'https://forge.example.invalid/a/../b'),
      (e: any) => (e.checks = 'unknown'),
      (e: any) => (e.mergeCommit = 'c'.repeat(40)),
      (e: any) => (e.pr = null),
    ]) {
      const p = await pageFrom([candidate('p0', 'pr_open')])
      change(p.items[0].execution)
      expect((await readValue(p)).status).toBe('not_evaluated')
    }
  })
  it('checks deadline again after the final hunk parse rather than promoting late decoded work', async () => {
    const p = await pageFrom(),
      wire = JSON.stringify(p) + '\n',
      create = await api()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const original = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, ...args) => {
      const value = original(text, ...args)
      if (text === p.items[0].body) clock = 10_001
      return value
    })
    const client = create(
      { origin: ORIGIN, token },
      async () =>
        new Response(wire, { headers: { 'content-type': 'application/json' } }),
    )
    expect(await client.readPage()).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
    })
    client.dispose()
  })
  it('cancels late response bodies after disposal and never dispatches again', async () => {
    const create = await api()
    vi.useFakeTimers()
    let resolve!: (r: Response) => void
    const cancel = vi.fn(),
      transport = vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r
          }),
      ),
      client = create({ origin: ORIGIN, token }, transport)
    const pending = client.readPage()
    client.dispose()
    expect(await pending).toEqual({
      status: 'not_evaluated',
      reason: 'aborted',
    })
    resolve(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect((await client.readPage()).reason).toBe('closed')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('refuses and cancels on oversized later chunks without returning a partial page', async () => {
    const create = await api(),
      cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(emptyPage()) + '\n'))
        c.enqueue(new Uint8Array(ADAPTER_PAGE_BYTES))
      },
      cancel,
    })
    const client = create(
      { origin: ORIGIN, token },
      async () =>
        new Response(body, { headers: { 'content-type': 'application/json' } }),
    )
    expect((await client.readPage()).status).toBe('not_evaluated')
    await new Promise((r) => setTimeout(r, 0))
    expect(cancel).toHaveBeenCalledTimes(1)
    client.dispose()
  })
})

it('releases a terminally errored owned reader while refusing the incomplete page', async () => {
  const create = await api()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(Error('private stream failure'))
    },
  })
  const transport = vi.fn(
    async () =>
      new Response(body, { headers: { 'content-type': 'application/json' } }),
  )
  const client = create({ origin: ORIGIN, token }, transport)
  expect(await client.readPage()).toEqual({
    status: 'not_evaluated',
    reason: 'body',
  })
  transport.mockImplementation(async () => jsonResponse(emptyPage()))
  expect((await client.readPage()).status).toBe('ready')
  expect(transport).toHaveBeenCalledTimes(2)
  client.dispose()
})


// Report transport pilot families: the absent API is recorded separately from
// the behavioral failures once the shared transport is reachable.
function reportCommand(): repository.AdapterExecutionReport {
  return {
    eventId: segment(16),
    proposalId: 'private-proposal',
    approvedRevision: 2,
    expectedStateVersion: 3,
    outcome: { state: 'conflict', detail: 'Synthetic conflict' },
  }
}
function reportAck(command = reportCommand()) {
  return {
    eventId: command.eventId,
    proposalId: command.proposalId,
    approvedRevision: command.approvedRevision,
    stateVersion: command.expectedStateVersion + 1,
    failedApplyCount: 1,
    state: command.outcome.state,
    acceptedAt: later,
  }
}
function reportError(status: number, code: string) {
  return new Response(JSON.stringify({ error: { code } }) + '\n', {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
async function reportClient(transport: any) {
  const create = await api(),
    client = create({ origin: ORIGIN, token }, transport)
  expect(
    client.reportExecution,
    'report API absence, not behavioral RED',
  ).toBeTypeOf('function')
  expect(
    client.readReportReceipt,
    'receipt API absence, not behavioral RED',
  ).toBeTypeOf('function')
  return client
}
describe('explicit report pilot families', () => {
  it('binds successful acknowledgements to the submitted event and version', async () => {
    const transport = vi.fn(async () =>
      jsonResponse({ ack: { ...reportAck(), stateVersion: 3 } }),
    )
    const client = await reportClient(transport)
    expect(await client.reportExecution(reportCommand())).toMatchObject({
      status: 'not_evaluated',
      delivery: 'unconfirmed',
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('classifies synchronous transport throws as dispatched and never retries', async () => {
    const transport = vi.fn(() => {
      throw Error('private error')
    })
    const client = await reportClient(transport)
    expect(await client.reportExecution(reportCommand())).toEqual({
      status: 'not_evaluated',
      reason: 'transport',
      delivery: 'unconfirmed',
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('holds all three methods during ignored abort until the original fetch settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let release!: (r: Response) => void
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    const client = await reportClient(transport),
      pending = client.reportExecution(reportCommand())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
      delivery: 'unconfirmed',
    })
    expect(await client.readPage()).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    expect(await client.readReportReceipt(segment(16))).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    expect(await client.reportExecution(reportCommand())).toMatchObject({
      reason: 'busy',
      delivery: 'not_dispatched',
    })
    release(jsonResponse({ ack: reportAck() }))
    await vi.advanceTimersByTimeAsync(0)
    client.dispose()
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('rejects a mismatched HTTP error/code pair instead of inventing conflict', async () => {
    const client = await reportClient(async () =>
      reportError(409, 'adapter_forbidden'),
    )
    expect(await client.reportExecution(reportCommand())).toMatchObject({
      status: 'not_evaluated',
      delivery: 'unconfirmed',
    })
  })
  it('returns explicit receipt absence without initiating a report or assuming rollback', async () => {
    const transport = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        reportError(404, 'receipt_not_found'),
    )
    const client = await reportClient(transport)
    expect(await client.readReportReceipt(segment(16))).toEqual({
      status: 'missing',
    })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'GET' })
  })
})

describe('report validation deadline', () => {
  it('does not reset elapsed validation time even when schema validation refuses', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const transport = vi.fn(async () => jsonResponse({ ack: reportAck() }))
    const client = await reportClient(transport),
      command = reportCommand()
    Object.defineProperty(command, 'proposalId', {
      get() {
        now = 10_000
        return ''
      },
    })
    expect(await client.reportExecution(command)).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
      delivery: 'not_dispatched',
    })
    expect(transport).not.toHaveBeenCalled()
  })
})

const reportStates: repository.AdapterReportOutcome[] = [
  {
    state: 'pr_open',
    pr: {
      number: 7,
      url: 'http://forge.example.invalid/p/7',
      head: 'b'.repeat(64),
    },
    checks: 'not_evaluated',
    detail: null,
  },
  { state: 'conflict', detail: 'Synthetic conflict' },
  { state: 'apply_failed', detail: 'Synthetic failure' },
  {
    state: 'merged',
    pr: {
      number: 7,
      url: 'http://forge.example.invalid/p/7',
      head: 'b'.repeat(40),
    },
    mergeCommit: 'a'.repeat(64),
  },
  {
    state: 'closed',
    pr: {
      number: 7,
      url: 'http://forge.example.invalid/p/7',
      head: 'b'.repeat(40),
    },
  },
]
describe('report command and wire boundaries', () => {
  for (const outcome of reportStates)
    it(
      'sends only the explicit frozen ' +
        outcome.state +
        ' command to the configured origin',
      async () => {
        const command = { ...reportCommand(), outcome },
          expected = structuredClone(command)
        let observed!: Request
        const client = await reportClient(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            observed = new Request(input, init)
            return jsonResponse({ ack: reportAck(expected) })
          },
        )
        const pending = client.reportExecution(command)
        command.proposalId = 'changed'
        command.outcome = { state: 'apply_failed', detail: 'changed' }
        expect(await pending).toEqual({
          status: 'accepted',
          ack: reportAck(expected),
        })
        expect(observed.url).toBe(ORIGIN + '/api/margin/v1/adapter/reports')
        expect(observed.method).toBe('POST')
        expect(observed.credentials).toBe('omit')
        expect(observed.redirect).toBe('error')
        expect(observed.cache).toBe('no-store')
        expect(observed.headers.get('authorization')).toBe('Bearer ' + token)
        expect(observed.headers.get('content-type')).toBe('application/json')
        expect(await observed.json()).toEqual(expected)
      },
    )
  it('accepts maximal supported scalar values without fabricating prior failure counts', async () => {
    const command = reportCommand()
    command.approvedRevision = Number.MAX_SAFE_INTEGER
    command.expectedStateVersion = Number.MAX_SAFE_INTEGER - 1
    command.proposalId = 'λ'.repeat(2048)
    command.outcome = { state: 'conflict', detail: 'λ'.repeat(2048) }
    const ack = { ...reportAck(command), failedApplyCount: 3 }
    const client = await reportClient(async () => jsonResponse({ ack }))
    expect(await client.reportExecution(command)).toEqual({
      status: 'accepted',
      ack,
    })
  })
  it('sends an exhausted safe expected version once for server conflict', async () => {
    const command = reportCommand()
    command.expectedStateVersion = Number.MAX_SAFE_INTEGER
    const transport = vi.fn(async () => reportError(409, 'report_conflict')),
      client = await reportClient(transport)
    expect(await client.reportExecution(command)).toEqual({
      status: 'conflict',
      reason: 'report_conflict',
      delivery: 'unconfirmed',
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed commands and selectors without dispatch', async () => {
    const transport = vi.fn(async () => jsonResponse({ ack: reportAck() })),
      client = await reportClient(transport)
    for (const patch of [
      { eventId: 'bad' },
      { eventId: segment(16) + '=' },
      { proposalId: '' },
      { approvedRevision: 0 },
      { expectedStateVersion: -1 },
      { expectedStateVersion: Number.MAX_SAFE_INTEGER + 1 },
      { site: SITE },
      { outcome: { state: 'apply_failed', detail: 'λ'.repeat(2049) } },
      { outcome: { state: 'approved' } },
      { outcome: { ...reportStates[0], extra: true } },
    ])
      expect(
        await client.reportExecution({ ...reportCommand(), ...patch }),
      ).toEqual({
        status: 'refused',
        reason: 'command',
        delivery: 'not_dispatched',
      })
    for (const id of ['', '../bad', segment(16) + '=', 'x'.repeat(23)])
      expect(await client.readReportReceipt(id)).toEqual({
        status: 'refused',
        reason: 'command',
      })
    expect(transport).not.toHaveBeenCalled()
  })
  it('rejects invalid configuration and permanent disposal across both new methods', async () => {
    const create = await api(),
      transport = vi.fn()
    const bad = create({ origin: ORIGIN + '/', token }, transport)
    expect(await bad.reportExecution(reportCommand())).toEqual({
      status: 'refused',
      reason: 'config',
      delivery: 'not_dispatched',
    })
    expect(await bad.readReportReceipt(segment(16))).toEqual({
      status: 'refused',
      reason: 'config',
    })
    const client = await reportClient(transport)
    client.dispose()
    expect(await client.reportExecution(reportCommand())).toEqual({
      status: 'refused',
      reason: 'closed',
      delivery: 'not_dispatched',
    })
    expect(await client.readReportReceipt(segment(16))).toEqual({
      status: 'refused',
      reason: 'closed',
    })
    expect(transport).not.toHaveBeenCalled()
  })
  it('binds every POST acknowledgement identity field and rejects closed-shape/scalar drift', async () => {
    for (const patch of [
      { eventId: encodeBase64Url(new Uint8Array(16).fill(8)) },
      { proposalId: 'different' },
      { approvedRevision: 3 },
      { stateVersion: 3 },
      { state: 'apply_failed' },
      { stateVersion: Number.MAX_SAFE_INTEGER + 1 },
      { failedApplyCount: 4 },
      { failedApplyCount: -1 },
      { acceptedAt: 'yesterday' },
      { privateField: 'hidden' },
    ]) {
      const client = await reportClient(async () =>
        jsonResponse({ ack: { ...reportAck(), ...patch } }),
      )
      expect(await client.reportExecution(reportCommand())).toMatchObject({
        status: 'not_evaluated',
        delivery: 'unconfirmed',
      })
    }
    const command = { ...reportCommand(), expectedStateVersion: 0 }
    const client = await reportClient(async () =>
      jsonResponse({ ack: { ...reportAck(command), failedApplyCount: 2 } }),
    )
    expect((await client.reportExecution(command)).status).toBe('not_evaluated')
  })
  it('receipt lookup binds only event identity and the closed projection, without outcome attestation', async () => {
    const ack = {
      ...reportAck(),
      proposalId: 'unrelated-proposal',
      state: 'closed',
      stateVersion: 9,
    }
    const transport = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ack }),
    )
    const client = await reportClient(transport)
    expect(await client.readReportReceipt(segment(16))).toEqual({
      status: 'found',
      ack,
    })
    expect(transport.mock.calls[0][0]).toBe(
      ORIGIN + '/api/margin/v1/adapter/receipts/' + segment(16),
    )
    expect(transport.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    })
    expect(transport.mock.calls[0][1]?.body).toBeUndefined()
    const other = await reportClient(async () =>
      jsonResponse({
        ack: { ...ack, eventId: encodeBase64Url(new Uint8Array(16).fill(8)) },
      }),
    )
    expect((await other.readReportReceipt(segment(16))).status).toBe(
      'not_evaluated',
    )
  })
  const common: [number, string, string][] = [
    [401, 'adapter_unauthorized', 'refused'],
    [403, 'adapter_forbidden', 'refused'],
    [400, 'invalid_report_query', 'refused'],
    [404, 'not_found', 'refused'],
    [405, 'method_not_allowed', 'refused'],
    [503, 'storage_unavailable', 'not_evaluated'],
  ]
  for (const receipt of [false, true])
    it(
      'requires every exact error-status association for ' +
        (receipt ? 'receipt' : 'report'),
      async () => {
        const cases: [number, string, string][] = [
          ...common,
          ...(receipt
            ? ([
                [400, 'invalid_receipt_id', 'refused'],
                [404, 'receipt_not_found', 'missing'],
              ] as [number, string, string][])
            : ([
                [400, 'invalid_report', 'refused'],
                [413, 'report_too_large', 'refused'],
                [415, 'unsupported_report_media', 'refused'],
                [409, 'report_conflict', 'conflict'],
                [503, 'execution_not_evaluated', 'not_evaluated'],
              ] as [number, string, string][])),
        ]
        for (const [status, code, expected] of cases) {
          const client = await reportClient(async () =>
            reportError(status, code),
          )
          const result = receipt
            ? await client.readReportReceipt(segment(16))
            : await client.reportExecution(reportCommand())
          expect(result.status).toBe(expected)
          if (!receipt) expect(result.delivery).toBe('unconfirmed')
          const wrong = await reportClient(async () => reportError(418, code))
          expect(
            (receipt
              ? await wrong.readReportReceipt(segment(16))
              : await wrong.reportExecution(reportCommand())
            ).status,
          ).toBe('not_evaluated')
        }
        for (const [status, code] of [
          [200, 'adapter_forbidden'],
          [403, 'constructor'],
          [503, 'receipt_not_found'],
          [409, 'unknown'],
        ] as const) {
          const client = await reportClient(async () =>
            reportError(status, code),
          )
          expect(
            (receipt
              ? await client.readReportReceipt(segment(16))
              : await client.reportExecution(reportCommand())
            ).status,
          ).toBe('not_evaluated')
        }
      },
    )
  it('refuses raw JSON ambiguity, malformed UTF8, noncanonical errors and excessive nesting', async () => {
    const canonical = JSON.stringify({ ack: reportAck() })
    for (const raw of [
      canonical,
      ' ' + canonical + '\n',
      '\ufeff' + canonical + '\n',
      canonical.replace(
        '"stateVersion":4',
        '"stateVersion":4,"stateVersion":4',
      ) + '\n',
      canonical.replace('"failedApplyCount":1', '"failedApplyCount":-0') + '\n',
      '['.repeat(17) + '0' + ']'.repeat(17) + '\n',
      new Uint8Array([0xff]),
      JSON.stringify({ ack: reportAck(), extra: true }) + '\n',
    ]) {
      const client = await reportClient(
        async () =>
          new Response(raw, {
            headers: { 'content-type': 'application/json' },
          }),
      )
      expect(await client.reportExecution(reportCommand())).toMatchObject({
        status: 'not_evaluated',
        delivery: 'unconfirmed',
      })
    }
    const client = await reportClient(
      async () =>
        new Response(
          '{"error":{"code":"adapter_forbidden","code":"adapter_forbidden"}}\n',
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    )
    expect((await client.reportExecution(reportCommand())).status).toBe(
      'not_evaluated',
    )
  })
  it('bounds response bytes independently of declared length and preserves the valid schema size', async () => {
    for (const mode of [
      'advertised',
      'streamed',
      'wrong-media',
      'redirect',
    ] as const) {
      const client = await reportClient(async () => {
        const response = new Response(
          mode === 'streamed'
            ? new Uint8Array(65_537)
            : JSON.stringify({ ack: reportAck() }) + '\n',
          {
            headers: {
              'content-type':
                mode === 'wrong-media' ? 'text/plain' : 'application/json',
              ...(mode === 'advertised' ? { 'content-length': '65537' } : {}),
            },
          },
        )
        if (mode === 'redirect')
          Object.defineProperty(response, 'url', {
            value: 'https://other.example.invalid/',
          })
        return response
      })
      expect(await client.reportExecution(reportCommand())).toMatchObject({
        status: 'not_evaluated',
        delivery: 'unconfirmed',
      })
    }
  })
})

type CallKind = 'work' | 'report' | 'receipt'
const invoke = (client: any, kind: CallKind) =>
  kind === 'work'
    ? client.readPage()
    : kind === 'report'
      ? client.reportExecution(reportCommand())
      : client.readReportReceipt(segment(16))
const responseFor = (url: string) =>
  jsonResponse(url.includes('/work?') ? emptyPage() : { ack: reportAck() })
describe('shared report and read lifetime', () => {
  for (const first of ['work', 'report', 'receipt'] as const) {
    it(
      'keeps the slot across ignored abort from ' +
        first +
        ' through late cancellation',
      async () => {
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'performance'],
        })
        let release!: (value: Response) => void, acknowledge!: () => void
        const transport = vi.fn(
          (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Promise<Response>((resolve) => {
              release = resolve
            }),
        )
        const client = await reportClient(transport),
          pending = invoke(client, first)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await pending).toMatchObject({
          status: 'not_evaluated',
          reason: 'timeout',
        })
        for (const kind of ['work', 'report', 'receipt'] as const)
          expect(await invoke(client, kind)).toMatchObject({ reason: 'busy' })
        release(
          new Response(
            new ReadableStream({
              cancel() {
                return new Promise<void>((resolve) => {
                  acknowledge = resolve
                })
              },
            }),
            { status: 403 },
          ),
        )
        await vi.advanceTimersByTimeAsync(0)
        for (const kind of ['work', 'report', 'receipt'] as const)
          expect(await invoke(client, kind)).toMatchObject({ reason: 'busy' })
        acknowledge()
        await vi.advanceTimersByTimeAsync(0)
        transport.mockImplementation(async (url) => responseFor(String(url)))
        for (const [kind, status] of [
          ['work', 'ready'],
          ['report', 'accepted'],
          ['receipt', 'found'],
        ] as const)
          expect((await invoke(client, kind)).status).toBe(status)
        expect(transport).toHaveBeenCalledTimes(4)
        client.dispose()
      },
    )
    it(
      'releases terminal reader errors from ' +
        first +
        ' for explicit subsequent calls',
      async () => {
        const transport = vi.fn(
          async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.error(Error('synthetic'))
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
        )
        const client = await reportClient(transport)
        expect(await invoke(client, first)).toMatchObject({
          status: 'not_evaluated',
          reason: 'body',
        })
        transport.mockImplementation(async (url) => responseFor(String(url)))
        for (const [kind, status] of [
          ['work', 'ready'],
          ['report', 'accepted'],
          ['receipt', 'found'],
        ] as const)
          expect((await invoke(client, kind)).status).toBe(status)
        expect(transport).toHaveBeenCalledTimes(4)
      },
    )
  }
  it('preserves unknown cleanup on rejected cancellation without replacement requests', async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              return Promise.reject(Error('unacknowledged'))
            },
          }),
          { headers: { 'content-type': 'text/plain' } },
        ),
    )
    const client = await reportClient(transport)
    expect(await client.reportExecution(reportCommand())).toMatchObject({
      status: 'not_evaluated',
      reason: 'response',
      delivery: 'unconfirmed',
    })
    await Promise.resolve()
    await Promise.resolve()
    for (const kind of ['work', 'report', 'receipt'] as const)
      expect(await invoke(client, kind)).toMatchObject({ reason: 'busy' })
    expect(transport).toHaveBeenCalledTimes(1)
    client.dispose()
  })
  it('retains a single deadline through validation, fetch and decode', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const command = reportCommand()
    Object.defineProperty(command, 'proposalId', {
      get() {
        now = 9_000
        return 'private-proposal'
      },
    })
    const transport = vi.fn(async () => {
      now = 10_000
      return jsonResponse({ ack: reportAck() })
    })
    const client = await reportClient(transport)
    expect(await client.reportExecution(command)).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
      delivery: 'unconfirmed',
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('rechecks elapsed decoding time before returning an acknowledgement', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const decode = TextDecoder.prototype.decode
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (
      this: TextDecoder,
      ...args
    ) {
      const text = decode.apply(this, args)
      now = 10_000
      return text
    })
    const client = await reportClient(async () =>
      jsonResponse({ ack: reportAck() }),
    )
    expect(await client.reportExecution(reportCommand())).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
      delivery: 'unconfirmed',
    })
  })
  it('dispose returns aborted uncertainty and permanently closes all entry points', async () => {
    let reject!: (error: Error) => void
    const transport = vi.fn(
        () =>
          new Promise<Response>((_resolve, r) => {
            reject = r
          }),
      ),
      client = await reportClient(transport)
    const pending = client.reportExecution(reportCommand())
    client.dispose()
    expect(await pending).toEqual({
      status: 'not_evaluated',
      reason: 'aborted',
      delivery: 'unconfirmed',
    })
    for (const kind of ['work', 'report', 'receipt'] as const)
      expect(await invoke(client, kind)).toMatchObject({
        status: 'refused',
        reason: 'closed',
      })
    reject(Error('late'))
    await Promise.resolve()
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

async function reportDatabase(granted = true) {
  const { createHarness, ADA, BOB, webAnnotation, scopeQuery } =
    await import('../../src/worker/margin/fixtures')
  const h = createHarness(),
    site = 'https://ernie.sg',
    adapter = 'client-report-fixture'
  h.database.execute(
    'INSERT INTO margin_adapters(site,adapter,enabled,created_at) VALUES(?,?,1,?)',
    [site, adapter, date],
  )
  h.database.execute(
    'INSERT INTO margin_adapter_tokens VALUES(?,?,?,?,?,?,NULL)',
    [segment(16), site, adapter, sha(token), 'approved_feed', date],
  )
  const grant = () =>
    h.database.execute(
      'INSERT INTO margin_adapter_report_grants VALUES(?,?,?,?,?,NULL)',
      [segment(16), sha(token), site, adapter, date],
    )
  if (granted) grant()
  h.database.execute(
    'INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
    [ADA.provider, ADA.issuer, ADA.subject, date, date],
  )
  const id = h.database.query('SELECT id FROM margin_identity')[0].id
  h.database.execute(
    "INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)",
    [id, date],
  )
  h.database.execute('INSERT INTO margin_site_admins VALUES(?,?)', [site, id])
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
  )
  expect(
    (
      await h.request(
        'POST',
        `/proposals/${proposalId}/apply${scopeQuery(source)}`,
        { body: { revision: 1 } },
      )
    ).status,
  ).toBe(202)
  const command: repository.AdapterExecutionReport = {
    ...reportCommand(),
    proposalId,
    approvedRevision: 1,
    expectedStateVersion: 0,
    outcome: { state: 'apply_failed', detail: 'Synthetic failure' },
  }
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handleAdapterRequest(new Request(input, init), h.repository),
  )
  const client = await reportClient(transport)
  const counts = () => ({
    receipts: h.database.query(
      'SELECT COUNT(*) AS n FROM margin_adapter_report_receipts',
    )[0].n,
    ...h.database.query(
      'SELECT state_version,failed_apply_count FROM margin_proposal_execution',
    )[0],
  })
  return {
    h,
    command,
    transport,
    client,
    counts,
    grant,
    close() {
      client.dispose()
      // The shared private fixture has no public close; only its owned SQLite
      // handle is reached here, solely to finish test resource lifetime.
      const sqlite = Reflect.get(
        h.database,
        'database',
      ) as import('node:sqlite').DatabaseSync
      sqlite.close()
    },
  }
}
describe('explicit report client actual handler and SQLite', () => {
  it('accepts exact caller replay once and rejects changed fingerprint or stale expected version', async () => {
    const f = await reportDatabase()
    try {
      const accepted = await f.client.reportExecution(f.command)
      expect(accepted.status).toBe('accepted')
      expect(await f.client.reportExecution(f.command)).toEqual(accepted)
      expect(
        await f.client.reportExecution({
          ...f.command,
          outcome: {
            state: 'apply_failed',
            detail: 'Changed synthetic content',
          },
        }),
      ).toEqual({
        status: 'conflict',
        reason: 'report_conflict',
        delivery: 'unconfirmed',
      })
      expect(
        await f.client.reportExecution({
          ...f.command,
          eventId: encodeBase64Url(new Uint8Array(16).fill(9)),
        }),
      ).toEqual({
        status: 'conflict',
        reason: 'report_conflict',
        delivery: 'unconfirmed',
      })
      expect(f.counts()).toEqual({
        receipts: 1,
        state_version: 1,
        failed_apply_count: 1,
      })
      expect(f.transport).toHaveBeenCalledTimes(4)
    } finally {
      f.close()
    }
  })
  it('observes committed response loss only through an explicit receipt GET', async () => {
    const f = await reportDatabase()
    try {
      const query = f.h.database.query.bind(f.h.database)
      const spy = vi
        .spyOn(f.h.database, 'query')
        .mockImplementation((sql, params) => {
          const rows = query(sql, params)
          if (sql.startsWith('INSERT INTO margin_adapter_report_receipts'))
            throw Error('synthetic postcommit response loss')
          return rows
        })
      expect(await f.client.reportExecution(f.command)).toEqual({
        status: 'not_evaluated',
        reason: 'service_unavailable',
        delivery: 'unconfirmed',
      })
      spy.mockRestore()
      expect(f.transport).toHaveBeenCalledTimes(1)
      expect(f.counts()).toEqual({
        receipts: 1,
        state_version: 1,
        failed_apply_count: 1,
      })
      const found = await f.client.readReportReceipt(f.command.eventId)
      expect(found.status).toBe('found')
      expect(found.ack).not.toHaveProperty('fingerprint')
      expect(found.ack).not.toHaveProperty('detail')
      expect(f.transport.mock.calls.map(([, init]) => init?.method)).toEqual([
        'POST',
        'GET',
      ])
    } finally {
      f.close()
    }
  })
  it('rechecks current report grant for both submission and receipt projection', async () => {
    const f = await reportDatabase(false)
    try {
      expect(await f.client.reportExecution(f.command)).toEqual({
        status: 'refused',
        reason: 'service_refused',
        delivery: 'unconfirmed',
      })
      f.grant()
      expect((await f.client.reportExecution(f.command)).status).toBe(
        'accepted',
      )
      f.h.database.execute(
        'UPDATE margin_adapter_report_grants SET revoked_at=?',
        [later],
      )
      expect((await f.client.reportExecution(f.command)).status).toBe('refused')
      expect((await f.client.readReportReceipt(f.command.eventId)).status).toBe(
        'refused',
      )
      expect(f.counts().receipts).toBe(1)
    } finally {
      f.close()
    }
  })
  it('distinguishes receipt absence from unavailable storage without any report', async () => {
    const f = await reportDatabase()
    try {
      expect(await f.client.readReportReceipt(f.command.eventId)).toEqual({
        status: 'missing',
      })
      const spy = vi.spyOn(f.h.database, 'query').mockImplementation(() => {
        throw Error('synthetic unavailable')
      })
      expect(await f.client.readReportReceipt(f.command.eventId)).toEqual({
        status: 'not_evaluated',
        reason: 'service_unavailable',
      })
      spy.mockRestore()
      expect(f.counts()).toEqual({
        receipts: 0,
        state_version: 0,
        failed_apply_count: 0,
      })
      expect(f.transport.mock.calls.map(([, init]) => init?.method)).toEqual([
        'GET',
        'GET',
      ])
    } finally {
      f.close()
    }
  })
})

describe('report outcomes through the actual handler', () => {
  for (const outcome of reportStates)
    it(
      'accepts the supported ' + outcome.state + ' report through real SQL',
      async () => {
        const f = await reportDatabase()
        try {
          const result = await f.client.reportExecution({
            ...f.command,
            outcome,
          })
          expect(result.status).toBe('accepted')
          expect(result.ack.state).toBe(outcome.state)
          expect(result.ack.stateVersion).toBe(1)
          expect(result.ack.failedApplyCount).toBe(
            outcome.state === 'apply_failed' ? 1 : 0,
          )
          expect(f.transport).toHaveBeenCalledTimes(1)
        } finally {
          f.close()
        }
      },
    )
})

describe('report validation preserves operation ownership', () => {
  it('does not overwrite an operation started synchronously during command validation', async () => {
    const releases: (() => void)[] = []
    const transport = vi.fn(
      (url: RequestInfo | URL) =>
        new Promise<Response>((r) => {
          releases.push(() => r(responseFor(String(url))))
        }),
    )
    const client = await reportClient(transport),
      command = reportCommand()
    let nested: Promise<unknown> | undefined
    Object.defineProperty(command, 'proposalId', {
      get() {
        nested ??= client.readPage()
        return 'private-proposal'
      },
    })
    const result = client.reportExecution(command)
    for (const release of releases) release()
    const settled = await result
    await nested
    client.dispose()
    expect(settled).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
      delivery: 'not_dispatched',
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

function correlatedService(items = [candidate('correlation-item')]) {
  const f = service(items)
  ;(f.repo as any).getOrIssuePublicCorrelation = vi.fn(
    async (c: any, target: any) => ({
      status: 'ready',
      site: c.site,
      proposalId: target.proposalId,
      approvedRevision: target.approvedRevision,
      publicCorrelation: { version: 1, value: 'c'.repeat(64) },
    }),
  )
  return f
}
async function correlationWire() {
  const f = correlatedService(),
    r = await f.transport(
      new Request(ORIGIN + ADAPTER_WORK_PATH + '?include=publicCorrelation', {
        headers: { authorization: 'Bearer ' + token },
      }),
    )
  expect(r.status).toBe(200)
  return r.json()
}
describe('opt-in public correlation client rules', () => {
  it('uses one explicit request and default10 while ordinary default25 and max50 remain exact', async () => {
    const f = correlatedService(),
      create = await api(),
      client = create({ origin: ORIGIN, token }, f.transport)
    expect(
      (await client.readPage({ include: 'publicCorrelation' })).page
        .publicCorrelation,
    ).toBe('v1')
    expect(new URL(String(f.transport.mock.calls[0][0])).search).toBe(
      '?limit=10&include=publicCorrelation',
    )
    expect(f.repo.listAdapterWork).toHaveBeenCalledTimes(2)
    expect((f.repo as any).getOrIssuePublicCorrelation).toHaveBeenCalledTimes(1)
    expect((await client.readPage()).status).toBe('ready')
    expect(new URL(String(f.transport.mock.calls[1][0])).search).toBe(
      '?limit=25',
    )
    expect((await client.readPage({ limit: 50 })).status).toBe('ready')
    client.dispose()
  })
  for (const options of [
    { include: 'publicCorrelation', limit: 11 },
    { include: 'publicCorrelation', limit: 50 },
    { include: 'publicCorrelation', limit: 0 },
    { include: 'publicCorrelation', limit: 1.5 },
    { include: 'other' },
    { include: null },
    { include: 'publicCorrelation', extra: true },
  ])
    it(
      'rejects option without transport ' + JSON.stringify(options),
      async () => {
        const create = await api(),
          transport = vi.fn(),
          client = create({ origin: ORIGIN, token }, transport)
        expect(await client.readPage(options)).toEqual({
          status: 'refused',
          reason: 'options',
        })
        expect(transport).not.toHaveBeenCalled()
        client.dispose()
      },
    )
  const malformed: Record<string, (p: any) => void> = {
    'missing marker': (p) => delete p.publicCorrelation,
    'wrong marker': (p) => (p.publicCorrelation = 'v2'),
    'missing item correlation': (p) => delete p.items[0].publicCorrelation,
    'null item correlation': (p) => (p.items[0].publicCorrelation = null),
    'wrong version': (p) => (p.items[0].publicCorrelation.version = 2),
    'short digest': (p) =>
      (p.items[0].publicCorrelation.value = 'c'.repeat(63)),
    'uppercase digest': (p) =>
      (p.items[0].publicCorrelation.value = 'A'.repeat(64)),
    'extra private key field': (p) =>
      (p.items[0].publicCorrelation.keyId = 'not-deliverable'),
    'extra page field': (p) => (p.extra = true),
    'tuple mismatch': (p) => (p.items[0].execution.checks = 'passed'),
    'stamp mismatch': (p) => (p.items[0].execution.lastEvent = segment(16)),
    'counter mismatch': (p) => (p.scanned = 0),
    'eleven scan': (p) => {
      p.scanned = 11
      p.notEvaluated.unknownExecution = 10
    },
  }
  for (const [name, mutate] of Object.entries(malformed))
    it('refuses closed correlated wire ' + name, async () => {
      const page = await correlationWire()
      mutate(page)
      const create = await api(),
        client = create({ origin: ORIGIN, token }, async () =>
          jsonResponse(page),
        )
      expect(
        (await client.readPage({ include: 'publicCorrelation' })).status,
      ).toBe('not_evaluated')
      client.dispose()
    })
  it('requires mode-specific schemas even for empty pages and checks raw canonical JSON first', async () => {
    const create = await api(),
      page = await correlationWire(),
      texts = [
        JSON.stringify(page),
        JSON.stringify(page).replace('"version":1', '"version":1,"version":1') +
          '\n',
        '\ufeff' + JSON.stringify(page) + '\n',
      ]
    for (const text of texts) {
      const client = create(
        { origin: ORIGIN, token },
        async () =>
          new Response(text, {
            headers: { 'content-type': 'application/json' },
          }),
      )
      expect(
        (await client.readPage({ include: 'publicCorrelation' })).status,
      ).toBe('not_evaluated')
      client.dispose()
    }
    const old = create({ origin: ORIGIN, token }, async () =>
      jsonResponse(page),
    )
    expect((await old.readPage()).status).toBe('not_evaluated')
    old.dispose()
    const empty = emptyPage(),
      next = create({ origin: ORIGIN, token }, async () => jsonResponse(empty))
    expect((await next.readPage({ include: 'publicCorrelation' })).status).toBe(
      'not_evaluated',
    )
    next.dispose()
    const valid = create({ origin: ORIGIN, token }, async () =>
      jsonResponse({ ...empty, publicCorrelation: 'v1' }),
    )
    expect(
      (await valid.readPage({ include: 'publicCorrelation' })).status,
    ).toBe('ready')
    valid.dispose()
  })
  for (const mode of ['timeout', 'non-200', 'invalid-header'] as const)
    it(
      'keeps shared occupancy through ' +
        mode +
        ' and late cancellation acknowledgment',
      async () => {
        vi.useFakeTimers()
        const create = await api()
        let settle!: (r: Response) => void, acknowledge!: () => void
        const cancel = vi.fn(() => new Promise<void>((r) => (acknowledge = r))),
          transport = vi.fn(() => new Promise<Response>((r) => (settle = r))),
          client = create({ origin: ORIGIN, token }, transport)
        const first = client.readPage({ include: 'publicCorrelation' })
        if (mode === 'timeout') {
          await vi.advanceTimersByTimeAsync(10001)
          expect((await first).reason).toBe('timeout')
        }
        settle(
          new Response(new ReadableStream({ cancel }), {
            status: mode === 'non-200' ? 503 : 200,
            headers: {
              'content-type':
                mode === 'invalid-header' ? 'text/plain' : 'application/json',
            },
          }),
        )
        await vi.advanceTimersByTimeAsync(0)
        expect((await first).status).toBe('not_evaluated')
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(
          (await client.readPage({ include: 'publicCorrelation' })).reason,
        ).toBe('busy')
        expect((await client.readReportReceipt(segment(16))).reason).toBe(
          'busy',
        )
        expect(transport).toHaveBeenCalledTimes(1)
        acknowledge()
        await vi.advanceTimersByTimeAsync(0)
        transport.mockImplementation(async () =>
          jsonResponse({ ...emptyPage(), publicCorrelation: 'v1' }),
        )
        expect(
          (await client.readPage({ include: 'publicCorrelation' })).status,
        ).toBe('ready')
        client.dispose()
      },
    )
  it('does not free a slot on rejected cancellation or dispatch after disposal', async () => {
    const create = await api(),
      transport = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              cancel: async () => {
                throw Error('private fixture error')
              },
            }),
            { status: 403 },
          ),
      ),
      client = create({ origin: ORIGIN, token }, transport)
    expect(
      (await client.readPage({ include: 'publicCorrelation' })).status,
    ).toBe('refused')
    await new Promise((r) => setTimeout(r, 0))
    expect(
      (await client.readPage({ include: 'publicCorrelation' })).reason,
    ).toBe('busy')
    expect(transport).toHaveBeenCalledTimes(1)
    client.dispose()
    expect(
      (await client.readPage({ include: 'publicCorrelation' })).reason,
    ).toBe('closed')
  })
})
for (const [name, ending] of [
  ['LF', '\n'],
  ['CR', '\r'],
  ['CRLF', '\r\n'],
  ['LS', '\u2028'],
  ['PS', '\u2029'],
])
  it('refuses wire correlation terminal line terminator ' + name, async () => {
    const page = await correlationWire()
    page.items[0].publicCorrelation.value += ending
    const create = await api(),
      client = create({ origin: ORIGIN, token }, async () => jsonResponse(page))
    expect(
      (await client.readPage({ include: 'publicCorrelation' })).status,
    ).toBe('not_evaluated')
    client.dispose()
  })
