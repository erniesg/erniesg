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
