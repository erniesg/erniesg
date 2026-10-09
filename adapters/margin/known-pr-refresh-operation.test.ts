import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKnownPRRefreshOperation } from './known-pr-refresh-operation'
import { formatHunks } from '../../src/annotations/criticmarkup'
import { encodeBase64Url } from '../../src/worker/margin/base64url'
import type { WorkTransport } from './service-client'
const site = 'https://ernie.sg',
  origin = 'https://margin.example.invalid'
const html = 'https://github.com/erniesg/erniesg/pull/42'
const api = 'https://api.github.com/repos/erniesg/erniesg/pulls/42'
const eventId = 'AAAAAAAAAAAAAAAAAAAAAA',
  proposalId = 'synthetic-private'
const serviceToken = [
  'margin-adapter-v1',
  encodeBase64Url(new Uint8Array(16).fill(7)),
  encodeBase64Url(new Uint8Array(32).fill(7)),
].join('.')
const config = () => ({
  site,
  service: { origin, token: serviceToken },
  provider: { token: 'synthetic-provider-token' },
})
const selector = () => ({ proposalId, eventId })
function item() {
  return {
    proposalId,
    site,
    document: '/book/chapter',
    source: site + '/book/chapter',
    approvedRevision: 3,
    body: formatHunks([
      {
        baseStartLine: 1,
        baseEndLine: 1,
        criticMarkup: 'Private approved body.',
      },
    ]),
    baseCommit: 'a'.repeat(40),
    sourcePath: 'books/chapter.md',
    visibility: 'private',
    approvedAt: '2026-10-08T00:00:00.000Z',
    execution: {
      state: 'pr_open',
      stateVersion: 7,
      failedApplyCount: 2,
      pr: { number: 42, url: html, head: 'a'.repeat(40) },
      checks: 'pending',
      detail: null,
      mergeCommit: null,
      lastEvent: encodeBase64Url(new Uint8Array(16).fill(9)),
      updatedAt: '2026-10-08T00:01:00.000Z',
    },
    work: 'refresh_pr',
  }
}
function page(items: unknown[] = [item()], nextCursor: string | null = null) {
  return {
    eligibility: 'known_execution',
    items,
    nextCursor,
    scanned: nextCursor === null ? items.length : 50,
    notEvaluated: {
      unknownExecution: nextCursor === null ? 0 : 50 - items.length,
    },
    excluded: { exhaustedFailures: 0, otherAdapter: 0 },
  }
}
function wire() {
  return {
    url: api,
    html_url: html,
    number: 42,
    state: 'open',
    merged: false,
    merge_commit_sha: 'c'.repeat(40),
    head: { sha: 'b'.repeat(40) },
    base: { repo: { full_name: 'erniesg/erniesg' } },
    body: 'Private provider body',
  }
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body) + '\n', {
    status,
    headers: { 'content-type': 'application/json' },
  })
const ack = () => ({
  ack: {
    eventId,
    proposalId,
    approvedRevision: 3,
    stateVersion: 8,
    failedApplyCount: 2,
    state: 'pr_open',
    acceptedAt: '2026-10-08T00:02:00.000Z',
  },
})
const command = () => ({
  eventId,
  proposalId,
  approvedRevision: 3,
  expectedStateVersion: 7,
  outcome: {
    state: 'pr_open',
    pr: { number: 42, url: html, head: 'b'.repeat(40) },
    checks: 'not_evaluated',
    detail: null,
  },
})
function fixture(
  opts: {
    work?: () => Response | Promise<Response>
    provider?: () => Response | Promise<Response>
    report?: () => Response | Promise<Response>
  } = {},
) {
  const calls: { target: string; url: string; init: RequestInit }[] = []
  const serviceTransport: WorkTransport = vi.fn(async (url, init = {}) => {
    calls.push({ target: 'service', url: String(url), init })
    return init.method === 'POST'
      ? (opts.report?.() ?? response(ack()))
      : (opts.work?.() ?? response(page()))
  })
  const providerTransport: WorkTransport = vi.fn(async (url, init = {}) => {
    calls.push({ target: 'provider', url: String(url), init })
    return opts.provider?.() ?? response(wire())
  })
  const operation = createKnownPRRefreshOperation(config(), {
    serviceTransport,
    providerTransport,
  })
  return { operation, calls, serviceTransport, providerTransport }
}
const tick = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('initial behavioral composition', () => {
  it('serially reports one exact caller event/CAS and keeps private data out of result', async () => {
    const f = fixture()
    const result = await f.operation.refresh(selector())
    expect(result).toEqual({
      phase: 'report',
      command: command(),
      result: { status: 'accepted', ack: ack().ack },
    })
    expect(f.calls.map((x) => [x.target, x.init.method])).toEqual([
      ['service', 'GET'],
      ['provider', 'GET'],
      ['service', 'POST'],
    ])
    expect(JSON.parse(String(f.calls[2].init.body))).toEqual(command())
    expect(JSON.stringify(result)).not.toContain('Private')
    f.operation.dispose()
  })
  it('returns not-in-this-page with cursor without provider or pagination', async () => {
    const f = fixture({ work: () => response(page([], 'YWJj')) })
    expect(await f.operation.refresh(selector())).toEqual({
      phase: 'selection',
      status: 'not_evaluated',
      reason: 'not_in_page',
      nextCursor: 'YWJj',
    })
    expect(f.calls).toHaveLength(1)
    f.operation.dispose()
  })
  it('keeps provider refusal distinct from closed and never reports it', async () => {
    const f = fixture({ provider: () => new Response(null, { status: 403 }) })
    expect(await f.operation.refresh(selector())).toEqual({
      phase: 'provider',
      result: {
        status: 'refused',
        reason: 'provider_refused',
        httpStatus: 403,
      },
    })
    expect(f.calls).toHaveLength(2)
    f.operation.dispose()
  })
  it('returns exact conflict result and command without CAS retry', async () => {
    const f = fixture({
      report: () => response({ error: { code: 'report_conflict' } }, 409),
    })
    expect(await f.operation.refresh(selector())).toEqual({
      phase: 'report',
      command: command(),
      result: {
        status: 'conflict',
        reason: 'report_conflict',
        delivery: 'unconfirmed',
      },
    })
    expect(f.calls).toHaveLength(3)
    f.operation.dispose()
  })
  it('retains response-loss uncertainty and exact command without receipt lookup', async () => {
    const f = fixture({
      report: () => {
        throw Error('private transport error')
      },
    })
    expect(await f.operation.refresh(selector())).toEqual({
      phase: 'report',
      command: command(),
      result: {
        status: 'not_evaluated',
        reason: 'transport',
        delivery: 'unconfirmed',
      },
    })
    expect(f.calls).toHaveLength(3)
    f.operation.dispose()
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
describe('closed selection and authority boundaries', () => {
  it.each([
    'site',
    'url',
    'version',
    'apply',
    'reconcile',
    'tuple',
    'duplicate',
  ] as const)('stops %s before provider access', async (mode) => {
    const row = item()
    const rows: unknown[] = [row]
    if (mode === 'site') {
      row.site = 'https://other.example'
      row.source = row.site + row.document
    }
    if (mode === 'url')
      row.execution.pr.url = 'https://github.com/other/repo/pull/42'
    if (mode === 'version') row.execution.stateVersion = Number.MAX_SAFE_INTEGER
    if (mode === 'apply' || mode === 'reconcile') {
      Object.assign(row.execution, {
        state: mode === 'apply' ? 'approved' : 'conflict',
        pr: null,
        checks: null,
        detail: mode === 'apply' ? null : 'source_mismatch',
        failedApplyCount: mode === 'apply' ? 0 : 3,
      })
      row.work = mode === 'apply' ? 'apply' : 'reconcile_only'
      if (mode === 'apply')
        Object.assign(row.execution, {
          stateVersion: 0,
          lastEvent: null,
          updatedAt: row.approvedAt,
        })
    }
    if (mode === 'tuple') row.execution.stateVersion = 0
    if (mode === 'duplicate') rows.push({ ...row })
    const f = fixture({ work: () => response(page(rows)) })
    const result = await f.operation.refresh(selector())
    expect(result.phase).not.toBe('report')
    expect(f.calls).toHaveLength(1)
    expect(f.providerTransport).not.toHaveBeenCalled()
    if (mode === 'site' || mode === 'url')
      expect(result).toEqual({
        phase: 'selection',
        status: 'refused',
        reason: 'binding_mismatch',
      })
    if (mode === 'version')
      expect(result).toEqual({
        phase: 'selection',
        status: 'not_evaluated',
        reason: 'version_exhausted',
      })
    if (mode === 'apply' || mode === 'reconcile')
      expect(result).toEqual({
        phase: 'selection',
        status: 'refused',
        reason: 'not_refreshable',
      })
    f.operation.dispose()
  })
  it('selects only exact proposal on a decoded ordered page', async () => {
    const other = item()
    other.proposalId = 'a-other'
    other.execution.pr.number = 2
    other.execution.pr.url = 'https://github.com/erniesg/erniesg/pull/2'
    const f = fixture({ work: () => response(page([other, item()])) })
    expect((await f.operation.refresh(selector())).phase).toBe('report')
    expect(f.calls[1].url).toBe(api)
    f.operation.dispose()
  })
  it.each([
    null,
    {},
    { ...selector(), extra: true },
    { ...selector(), eventId: 'bad' },
    { ...selector(), proposalId: '' },
    { ...selector(), proposalId: 'x'.repeat(2049) },
    { ...selector(), cursor: 'a'.repeat(32769) },
    { ...selector(), cursor: '../bad' },
  ])('refuses malformed selector without network %#', async (input) => {
    const f = fixture()
    expect(await f.operation.refresh(input)).toEqual({
      phase: 'operation',
      status: 'refused',
      reason: 'selector',
    })
    expect(f.calls).toEqual([])
    f.operation.dispose()
  })
  it.each([
    null,
    {},
    { ...config(), extra: true },
    { ...config(), service: { ...config().service, extra: true } },
    { ...config(), provider: { token: '' } },
    { ...config(), provider: { token: 'line\nbreak' } },
  ])('refuses closed configuration shape %#', async (value) => {
    const transport = vi.fn()
    const op = createKnownPRRefreshOperation(value, {
      serviceTransport: transport,
      providerTransport: transport,
    })
    expect(await op.refresh(selector())).toEqual({
      phase: 'operation',
      status: 'refused',
      reason: 'config',
    })
    expect(transport).not.toHaveBeenCalled()
    op.dispose()
  })
  it('leaves exact service credential/origin validation to the unchanged client', async () => {
    const c = config()
    c.service.origin = 'http://margin.example.invalid'
    const transport = vi.fn()
    const op = createKnownPRRefreshOperation(c, {
      serviceTransport: transport,
      providerTransport: transport,
    })
    expect(await op.refresh(selector())).toEqual({
      phase: 'work',
      result: { status: 'refused', reason: 'config' },
    })
    expect(transport).not.toHaveBeenCalled()
    op.dispose()
  })
  it('copies credentials and selector before awaits; never crosses tokens or returns bodies', async () => {
    const c = config(),
      input = { ...selector(), cursor: 'YWJj' }
    const first = deferred<Response>()
    const calls: { url: string; init: RequestInit }[] = []
    const op = createKnownPRRefreshOperation(c, {
      serviceTransport: async (url, init = {}) => {
        calls.push({ url: String(url), init })
        return init.method === 'POST' ? response(ack()) : first.promise
      },
      providerTransport: async (url, init = {}) => {
        calls.push({ url: String(url), init })
        return response(wire())
      },
    })
    c.service.token = 'changed'
    c.provider.token = 'changed'
    c.site = 'https://other.example'
    const pending = op.refresh(input)
    input.proposalId = 'changed'
    input.eventId = 'changed'
    input.cursor = 'changed'
    first.resolve(response(page()))
    const r = await pending
    expect(r).toEqual({
      phase: 'report',
      command: command(),
      result: { status: 'accepted', ack: ack().ack },
    })
    expect(new URL(calls[0].url).searchParams.get('cursor')).toBe('YWJj')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(
      'Bearer ' + serviceToken,
    )
    expect(new Headers(calls[1].init.headers).get('authorization')).toBe(
      'Bearer synthetic-provider-token',
    )
    expect(new Headers(calls[2].init.headers).get('authorization')).toBe(
      'Bearer ' + serviceToken,
    )
    for (const call of calls) {
      expect(call.init.redirect).toBe('error')
      expect(call.init.credentials).toBe('omit')
    }
    for (const privateValue of [
      'Private approved body.',
      'Private provider body',
      serviceToken,
      'synthetic-provider-token',
    ])
      expect(JSON.stringify(r)).not.toContain(privateValue)
    if (r.phase === 'report') r.command.proposalId = 'caller-mutated'
    expect(JSON.parse(String(calls[2].init.body))).toEqual(command())
    op.dispose()
  })
  it.each([401, 403, 404, 429, 500])(
    'never interprets provider %i as closure',
    async (status) => {
      const f = fixture({ provider: () => new Response(null, { status }) })
      const r = await f.operation.refresh(selector())
      expect(r.phase).toBe('provider')
      expect(f.calls).toHaveLength(2)
      expect(JSON.stringify(r)).not.toContain('apply_failed')
      f.operation.dispose()
    },
  )
  it.each(['closed', 'merged'] as const)(
    'reports genuine %s projection only',
    async (state) => {
      const w = wire()
      w.state = 'closed'
      w.merged = state === 'merged'
      const a = ack()
      a.ack.state = state
      const f = fixture({
        provider: () => response(w),
        report: () => response(a),
      })
      const r = await f.operation.refresh(selector())
      expect(r.phase).toBe('report')
      if (r.phase !== 'report') throw Error('report')
      expect(r.command.outcome.state).toBe(state)
      expect(r.command.expectedStateVersion).toBe(7)
      expect(r.command.eventId).toBe(eventId)
      expect(r.command.outcome).toEqual(
        state === 'merged'
          ? { state, pr: command().outcome.pr, mergeCommit: 'c'.repeat(40) }
          : { state, pr: command().outcome.pr },
      )
      f.operation.dispose()
    },
  )
  it('stops malformed provider envelopes and retains canonical service decoding', async () => {
    for (const target of ['work', 'provider'] as const) {
      const f = fixture({
        [target]: () => response({ privateError: 'must not escape' }),
      })
      const r = await f.operation.refresh(selector())
      expect(r.phase).toBe(target)
      expect(JSON.stringify(r)).not.toContain('must not escape')
      expect(f.calls).toHaveLength(target === 'work' ? 1 : 2)
      f.operation.dispose()
    }
  })
  it.each([
    [401, 'adapter_unauthorized'],
    [403, 'adapter_forbidden'],
  ] as const)(
    'preserves report authorization refusal %i',
    async (status, code) => {
      const f = fixture({ report: () => response({ error: { code } }, status) })
      const r = await f.operation.refresh(selector())
      expect(r).toEqual({
        phase: 'report',
        command: command(),
        result: {
          status: 'refused',
          reason: 'service_refused',
          delivery: 'unconfirmed',
        },
      })
      expect(f.calls).toHaveLength(3)
      f.operation.dispose()
    },
  )
})

describe('composition lifetime', () => {
  it('acquires before selector accessors, rejects reentry and rechecks disposal', async () => {
    for (const dispose of [false, true]) {
      const f = fixture()
      let reentered: ReturnType<typeof f.operation.refresh> | undefined
      const input = {
        get proposalId() {
          reentered = f.operation.refresh(selector())
          if (dispose) f.operation.dispose()
          return proposalId
        },
        eventId,
      }
      const r = await f.operation.refresh(input)
      expect(await reentered).toEqual({
        phase: 'operation',
        status: 'not_evaluated',
        reason: 'busy',
      })
      expect(r.phase).toBe(dispose ? 'operation' : 'report')
      expect(f.calls).toHaveLength(dispose ? 0 : 3)
      f.operation.dispose()
    }
  })
  it('throwing selector accessors clear wrapper occupancy without dispatch', async () => {
    const f = fixture()
    expect(
      await f.operation.refresh({
        get proposalId() {
          throw Error('private')
        },
        eventId,
      }),
    ).toEqual({ phase: 'operation', status: 'refused', reason: 'selector' })
    expect(f.calls).toEqual([])
    expect((await f.operation.refresh(selector())).phase).toBe('report')
    f.operation.dispose()
  })
  it.each(['work', 'provider', 'report'] as const)(
    'concurrent reentry and disposal at %s cannot advance another phase',
    async (phase) => {
      let f!: ReturnType<typeof fixture>
      let second: ReturnType<typeof f.operation.refresh> | undefined
      const action = () => {
        second = f.operation.refresh(selector())
        f.operation.dispose()
        return response(
          phase === 'work' ? page() : phase === 'provider' ? wire() : ack(),
        )
      }
      f = fixture({ [phase]: action })
      const r = await f.operation.refresh(selector())
      expect(await second).toEqual({
        phase: 'operation',
        status: 'not_evaluated',
        reason: 'busy',
      })
      expect(f.calls).toHaveLength(
        phase === 'work' ? 1 : phase === 'provider' ? 2 : 3,
      )
      if (phase === 'report')
        expect(r).toEqual({
          phase: 'report',
          command: command(),
          result: {
            status: 'not_evaluated',
            reason: 'aborted',
            delivery: 'unconfirmed',
          },
        })
      else
        expect(r).toEqual({
          phase,
          result: { status: 'not_evaluated', reason: 'aborted' },
        })
      expect(await f.operation.refresh(selector())).toEqual({
        phase: 'operation',
        status: 'refused',
        reason: 'closed',
      })
    },
  )
  it.each(['work', 'provider', 'report'] as const)(
    'retains %s occupancy after timeout and through late unsettled cancellation',
    async (phase) => {
      vi.useFakeTimers()
      const late = deferred<Response>(),
        cancellation = deferred<void>()
      let calls = 0
      const f = fixture({
        [phase]: () =>
          ++calls === 1
            ? late.promise
            : response(
                phase === 'work'
                  ? page()
                  : phase === 'provider'
                    ? wire()
                    : ack(),
              ),
      })
      const pending = f.operation.refresh(selector())
      await vi.advanceTimersByTimeAsync(10_001)
      const r = await pending
      expect(r.phase).toBe(phase)
      if (r.phase === 'report')
        expect(r.result).toEqual({
          status: 'not_evaluated',
          reason: 'timeout',
          delivery: 'unconfirmed',
        })
      else
        expect(r).toMatchObject({
          result: { status: 'not_evaluated', reason: 'timeout' },
        })
      const busyPhase = phase === 'provider' ? 'provider' : 'work'
      expect(await f.operation.refresh(selector())).toEqual({
        phase: busyPhase,
        result: { status: 'not_evaluated', reason: 'busy' },
      })
      expect(calls).toBe(1)
      const cancel = vi.fn(() => cancellation.promise)
      late.resolve(new Response(new ReadableStream({ cancel })))
      await tick()
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(await f.operation.refresh(selector())).toEqual({
        phase: busyPhase,
        result: { status: 'not_evaluated', reason: 'busy' },
      })
      expect(calls).toBe(1)
      cancellation.resolve()
      await tick()
      expect((await f.operation.refresh(selector())).phase).toBe('report')
      expect(calls).toBe(2)
      f.operation.dispose()
    },
  )
  it.each(['work', 'provider', 'report'] as const)(
    'preserves %s slot when late cancellation rejects',
    async (phase) => {
      vi.useFakeTimers()
      const late = deferred<Response>()
      const f = fixture({ [phase]: () => late.promise })
      const pending = f.operation.refresh(selector())
      await vi.advanceTimersByTimeAsync(10_001)
      await pending
      late.resolve(
        new Response(
          new ReadableStream({
            cancel: () => Promise.reject(Error('private cancellation failure')),
          }),
        ),
      )
      await tick()
      const r = await f.operation.refresh(selector())
      expect(r).toEqual({
        phase: phase === 'provider' ? 'provider' : 'work',
        result: { status: 'not_evaluated', reason: 'busy' },
      })
      f.operation.dispose()
    },
  )
  it('allows immediate reuse after completed phases, without automatic extra calls', async () => {
    const f = fixture()
    for (let i = 0; i < 2; i++)
      expect((await f.operation.refresh(selector())).phase).toBe('report')
    expect(f.calls).toHaveLength(6)
    f.operation.dispose()
    f.operation.dispose()
    expect(await f.operation.refresh(selector())).toEqual({
      phase: 'operation',
      status: 'refused',
      reason: 'closed',
    })
    expect(f.calls).toHaveLength(6)
  })
})

describe('explicit configured checks operation option', () => {
  it('wires through the real reader/planner and reports unknown permission with the exact observed head', async () => {
    const f = fixture()
    f.operation.dispose()
    let calls = 0
    const op = createKnownPRRefreshOperation(
      { ...config(), provider: { ...config().provider, checks: 'configured' } },
      {
        serviceTransport: f.serviceTransport,
        providerTransport: async () =>
          ++calls === 2
            ? new Response(null, { status: 403 })
            : response(wire()),
      },
    )
    try {
      const r = await op.refresh(selector())
      expect(r.phase).toBe('report')
      if (r.phase !== 'report') throw Error('report')
      expect(r.command.outcome).toMatchObject({
        state: 'pr_open',
        pr: { head: 'b'.repeat(40) },
        checks: 'not_evaluated',
      })
      expect(r.command.outcome).toHaveProperty(
        'detail',
        expect.stringContaining('provider_refused'),
      )
      expect(calls).toBe(3)
      expect(f.calls.filter((c) => c.init.method === 'POST')).toHaveLength(1)
      expect(r.command.eventId).toBe(eventId)
      expect(r.command.expectedStateVersion).toBe(7)
    } finally {
      op.dispose()
    }
  })
})

function configuredProviderValue(url: string) {
  if (url === api) return wire()
  const base = 'https://api.github.com/repos/erniesg/erniesg/actions/runs'
  if (
    url ===
    base + '?head_sha=' + 'b'.repeat(40) + '&event=pull_request&per_page=100'
  )
    return {
      total_count: 2,
      workflow_runs: ['ci.yml', 'agent-evidence.yml'].map((file, i) => ({
        id: 501 + i,
        run_number: 10,
        run_attempt: 2,
        path: '.github/workflows/' + file,
        event: 'pull_request',
        repository: { full_name: 'erniesg/erniesg' },
        head_sha: 'b'.repeat(40),
        html_url: `https://github.com/erniesg/erniesg/actions/runs/${501 + i}`,
        status: 'completed',
        conclusion: 'success',
      })),
    }
  const i =
    url === base + '/501/attempts/2/jobs?per_page=100'
      ? 0
      : url === base + '/502/attempts/2/jobs?per_page=100'
        ? 1
        : -1
  if (i < 0) throw Error('unexpected provider route')
  const names = i === 0 ? ['checks', 'secret-scan'] : ['evidence']
  return {
    total_count: names.length,
    jobs: names.map((name, j) => ({
      id: 700 + i * 10 + j,
      run_id: 501 + i,
      head_sha: 'b'.repeat(40),
      name,
      html_url: `https://github.com/erniesg/erniesg/actions/runs/${501 + i}/job/${700 + i * 10 + j}`,
      status: 'completed',
      conclusion: 'success',
      runner_id: 91,
      steps: [
        {
          number: 1,
          name: 'fixture',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    })),
  }
}
describe('configured checks full existing-component composition', () => {
  it('performs six bounded GETs then submits one unchanged event/CAS informational success', async () => {
    const f = fixture()
    f.operation.dispose()
    const urls: string[] = []
    const op = createKnownPRRefreshOperation(
      { ...config(), provider: { ...config().provider, checks: 'configured' } },
      {
        serviceTransport: f.serviceTransport,
        providerTransport: async (u, init) => {
          expect(init).toMatchObject({
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
          })
          urls.push(String(u))
          return response(configuredProviderValue(String(u)))
        },
      },
    )
    try {
      const r = await op.refresh(selector())
      expect(r.phase).toBe('report')
      if (r.phase !== 'report') throw Error('report')
      expect(r.result.status).toBe('accepted')
      expect(r.command).toMatchObject({
        eventId,
        proposalId,
        approvedRevision: 3,
        expectedStateVersion: 7,
        outcome: {
          state: 'pr_open',
          checks: 'passed',
          pr: { head: 'b'.repeat(40) },
          detail: expect.stringContaining('not merge eligibility'),
        },
      })
      expect(urls).toHaveLength(6)
      expect(f.calls.map((c) => c.init.method)).toEqual(['GET', 'POST'])
      expect(JSON.parse(String(f.calls[1].init.body))).toEqual(r.command)
    } finally {
      op.dispose()
    }
  })
  for (const stage of [2, 3, 4, 5, 6])
    it(`disposal during check/final witness GET ${stage} prevents the report`, async () => {
      const f = fixture()
      f.operation.dispose()
      let calls = 0
      const op = createKnownPRRefreshOperation(
        {
          ...config(),
          provider: { ...config().provider, checks: 'configured' },
        },
        {
          serviceTransport: f.serviceTransport,
          providerTransport: async (u) => {
            if (++calls === stage) op.dispose()
            return response(configuredProviderValue(String(u)))
          },
        },
      )
      try {
        const r = await op.refresh(selector())
        expect(r.phase).not.toBe('report')
        expect(f.calls.map((c) => c.init.method)).toEqual(['GET'])
        expect(calls).toBe(stage)
      } finally {
        op.dispose()
      }
    })
})
