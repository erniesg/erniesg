import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKnownPRReader } from './known-pr-reader'
import { planKnownPRRefresh } from './known-pr-refresh'
const token = 'synthetic-reader-token'
const api = 'https://api.github.com/repos/erniesg/erniesg/pulls/42'
const html = 'https://github.com/erniesg/erniesg/pull/42'
function wire() {
  return {
    url: api,
    html_url: html,
    number: 42,
    state: 'open',
    merged: false,
    merge_commit_sha: 'c'.repeat(40),
    head: { sha: 'b'.repeat(40), repo: null },
    base: { repo: { full_name: 'erniesg/erniesg' } },
    title: 'Synthetic title',
    body: 'Not in output',
  }
}
function response(value: unknown = wire()) {
  return new Response(JSON.stringify(value, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('known PR reader initial behavioral controls', () => {
  it('normalizes an unmerged test SHA and composes a checks-unknown refresh', async () => {
    const reader = createKnownPRReader({ token }, async () => response())
    const r = await reader.readPR({ number: 42 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') throw Error('expected ready')
    expect(r.observation.mergeCommit).toBeNull()
    const planned = planKnownPRRefresh(
      { site: 'https://ernie.sg' },
      {
        binding: {
          work: 'refresh_pr',
          site: 'https://ernie.sg',
          proposalId: 'synthetic-private',
          approvedRevision: 3,
          expectedStateVersion: 7,
          pr: { number: 42, url: html, head: 'a'.repeat(40) },
        },
        observation: r.observation,
        eventId: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
    )
    expect(planned.status).toBe('planned')
    if (planned.status !== 'planned') throw Error('planned')
    expect(planned.command.outcome).toEqual({
      state: 'pr_open',
      pr: { number: 42, url: html, head: 'b'.repeat(40) },
      checks: 'not_evaluated',
      detail: null,
    })
  })
  it('rejects a wrong repository without treating it as a closed PR', async () => {
    const w = wire()
    w.base.repo.full_name = 'other/repo'
    const reader = createKnownPRReader({ token }, async () => response(w))
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'response',
    })
  })
  it('keeps a provider refusal distinct from repository closure', async () => {
    const reader = createKnownPRReader(
      { token },
      async () => new Response('', { status: 403 }),
    )
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'refused',
      reason: 'provider_refused',
      httpStatus: 403,
    })
  })
  it('refuses implicit credentials without dispatch', async () => {
    const transport = vi.fn(async () => response())
    const reader = createKnownPRReader({ token: '' }, transport)
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'refused',
      reason: 'config',
    })
    expect(transport).not.toHaveBeenCalled()
  })
  it('holds occupancy across ignored abort and cancels the late response', async () => {
    vi.useFakeTimers()
    let resolve!: (r: Response) => void
    const late = new Promise<Response>((r) => {
      resolve = r
    })
    const reader = createKnownPRReader({ token }, () => late)
    const pending = reader.readPR({ number: 42 })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await pending).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
    })
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    const cancelled = vi.fn()
    resolve(new Response(new ReadableStream({ cancel: cancelled })))
    await tick()
    expect(cancelled).toHaveBeenCalledTimes(1)
    reader.dispose()
  })
})

function textResponse(text: string, headers: Record<string, string> = {}) {
  return new Response(text, {
    headers: { 'content-type': 'application/json', ...headers },
  })
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
describe('known PR protocol and authority', () => {
  it('makes exactly the fixed read-only request with explicit copied credentials', async () => {
    const config = { token }
    const calls: { url: string; init?: RequestInit }[] = []
    const reader = createKnownPRReader(config, async (url, init) => {
      calls.push({ url: String(url), init })
      return response()
    })
    config.token = 'changed'
    expect((await reader.readPR({ number: 42 })).status).toBe('ready')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(api)
    expect(calls[0].init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'margin-known-pr-reader',
      },
    })
    expect(calls[0].init?.body).toBeUndefined()
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
  })
  for (const cfg of [
    null,
    {},
    { token: 'a b' },
    { token: 'a\nb' },
    { token: 'a'.repeat(4097) },
    { token, origin: 'https://example.invalid' },
    { token, repository: 'other/repo' },
  ])
    it('rejects config ' + JSON.stringify(cfg).slice(0, 60), async () => {
      const transport = vi.fn(async () => response())
      expect(
        (await createKnownPRReader(cfg, transport).readPR({ number: 42 }))
          .status,
      ).toBe('refused')
      expect(transport).not.toHaveBeenCalled()
    })
  for (const input of [
    null,
    {},
    { number: 0 },
    { number: -1 },
    { number: 1.5 },
    { number: '42' },
    { number: Number.MAX_SAFE_INTEGER + 1 },
    { number: 42, url: 'https://example.invalid' },
  ])
    it('rejects unsafe/extra input ' + JSON.stringify(input), async () => {
      const transport = vi.fn(async () => response())
      expect(
        await createKnownPRReader({ token }, transport).readPR(input),
      ).toEqual({ status: 'refused', reason: 'input' })
      expect(transport).not.toHaveBeenCalled()
    })
  it('allows a safe integer boundary without rounding the requested identity', async () => {
    const n = Number.MAX_SAFE_INTEGER,
      w = wire()
    w.number = n
    w.url = 'https://api.github.com/repos/erniesg/erniesg/pulls/' + n
    w.html_url = 'https://github.com/erniesg/erniesg/pull/' + n
    const r = await createKnownPRReader({ token }, async (url) => {
      expect(String(url)).toBe(w.url)
      return response(w)
    }).readPR({ number: n })
    expect(r.status).toBe('ready')
  })
  for (const [key, value] of [
    ['url', 'https://api.github.com/repos/other/repo/pulls/42'],
    ['html_url', html + '/'],
    ['number', 43],
    ['state', 'unknown'],
    ['merged', null],
    ['merge_commit_sha', 'abc'],
    ['head', null],
    ['base', null],
  ] as const)
    it('does not promote wrong ' + key, async () => {
      const w: any = wire()
      w[key] = value
      expect(
        await createKnownPRReader({ token }, async () => response(w)).readPR({
          number: 42,
        }),
      ).toEqual({ status: 'not_evaluated', reason: 'response' })
    })
  for (const field of [
    'url',
    'html_url',
    'number',
    'state',
    'merged',
    'merge_commit_sha',
    'head',
    'base',
  ])
    it('does not default missing ' + field, async () => {
      const w: any = wire()
      delete w[field]
      expect(
        (
          await createKnownPRReader({ token }, async () => response(w)).readPR({
            number: 42,
          })
        ).status,
      ).toBe('not_evaluated')
    })
  for (const [state, merged, sha, want] of [
    ['closed', false, 'c'.repeat(40), 'closed'],
    ['closed', true, 'd'.repeat(40), 'merged'],
    ['closed', true, 'd'.repeat(64), 'merged'],
  ] as const)
    it('keeps outcome ' + want + ' ' + sha.length, async () => {
      const w = { ...wire(), state, merged, merge_commit_sha: sha }
      const r = await createKnownPRReader({ token }, async () =>
        response(w),
      ).readPR({ number: 42 })
      expect(r.status).toBe('ready')
      if (r.status !== 'ready') throw Error('ready')
      expect(r.observation).toEqual({
        status: 'observed',
        repository: 'erniesg/erniesg',
        number: 42,
        url: html,
        head: 'b'.repeat(40),
        state,
        merged,
        mergeCommit: merged ? sha : null,
      })
    })
  for (const w of [
    { ...wire(), merged: true },
    { ...wire(), state: 'closed', merged: true, merge_commit_sha: null },
  ])
    it(
      'refuses contradictory merge association ' +
        JSON.stringify(w.merged) +
        ' ' +
        w.state,
      async () => {
        expect(
          (
            await createKnownPRReader({ token }, async () =>
              response(w),
            ).readPR({ number: 42 })
          ).status,
        ).toBe('not_evaluated')
      },
    )
  for (const status of [401, 403, 404, 304, 406, 422, 429, 500, 503])
    it('HTTP ' + status + ' neither observes closure nor retries', async () => {
      const transport = vi.fn(async () => new Response(null, { status }))
      const r = await createKnownPRReader({ token }, transport).readPR({
        number: 42,
      })
      expect(r).toEqual({
        status: [401, 403].includes(status) ? 'refused' : 'not_evaluated',
        reason: [401, 403].includes(status)
          ? 'provider_refused'
          : status === 404
            ? 'not_found_or_hidden'
            : 'response_status',
        httpStatus: status,
      })
      expect(transport).toHaveBeenCalledTimes(1)
    })
  for (const prop of ['redirected', 'url'])
    it(
      'rejects response ' + prop + ' mismatch without a second request',
      async () => {
        const r = response()
        Object.defineProperty(r, prop, {
          value: prop === 'url' ? 'https://example.invalid/' : true,
        })
        const transport = vi.fn(async () => r)
        expect(
          (
            await createKnownPRReader({ token }, transport).readPR({
              number: 42,
            })
          ).status,
        ).toBe('not_evaluated')
        expect(transport).toHaveBeenCalledTimes(1)
      },
    )
  it('prunes private-looking extra fields and returns detached outputs', async () => {
    const w = wire()
    const r = await createKnownPRReader({ token }, async () =>
      response(w),
    ).readPR({ number: 42 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') throw Error('ready')
    w.head.sha = 'e'.repeat(40)
    expect(r.observation.head).toBe('b'.repeat(40))
    expect(JSON.stringify(r)).not.toContain('Not in output')
    expect(JSON.stringify(r)).not.toContain(token)
    expect(Object.keys(r.observation).sort()).toEqual(
      [
        'status',
        'repository',
        'number',
        'url',
        'head',
        'state',
        'merged',
        'mergeCommit',
      ].sort(),
    )
  })
})

describe('known PR raw JSON and bounds', () => {
  for (const style of ['pretty', 'reordered', 'escaped', 'trailing whitespace'])
    it('accepts ordinary valid JSON ' + style, async () => {
      const w = wire()
      const text =
        style === 'pretty'
          ? JSON.stringify(w, null, 2)
          : style === 'reordered'
            ? JSON.stringify(Object.fromEntries(Object.entries(w).reverse()))
            : style === 'escaped'
              ? JSON.stringify(w).replace('"merged"', '"m\\u0065rged"')
              : JSON.stringify(w) + '\r\n\t '
      expect(
        (
          await createKnownPRReader({ token }, async () =>
            textResponse(text),
          ).readPR({ number: 42 })
        ).status,
      ).toBe('ready')
    })
  for (const [name, mutate] of [
    [
      'duplicate key',
      (t: string) =>
        t.replace('"merged":false', '"merged":true,"merged":false'),
    ],
    [
      'escaped alias',
      (t: string) =>
        t.replace('"merged":false', '"m\\u0065rged":true,"merged":false'),
    ],
    [
      'nested duplicate',
      (t: string) =>
        t.replace('"sha":', '"sha":"' + 'a'.repeat(40) + '","sha":'),
    ],
    [
      'extra object duplicate',
      (t: string) => t.replace('"title":', '"extra":{"x":1,"x":2},"title":'),
    ],
    ['trailing JSON', (t: string) => t + '{}'],
    [
      'deep extra',
      (t: string) =>
        t.replace(
          '"title":',
          '"extra":' + '['.repeat(17) + '0' + ']'.repeat(17) + ',"title":',
        ),
    ],
    ['unterminated', (t: string) => t.slice(0, -3)],
  ] as const)
    it('rejects raw ' + name + ' before projection', async () => {
      expect(
        (
          await createKnownPRReader({ token }, async () =>
            textResponse(mutate(JSON.stringify(wire()))),
          ).readPR({ number: 42 })
        ).status,
      ).toBe('not_evaluated')
    })
  it('permits same keys in separate objects and syntax characters inside strings', async () => {
    const w = { ...wire(), extra: [{ x: '\\" { : } [ \\n' }, { x: 2 }] }
    expect(
      (
        await createKnownPRReader({ token }, async () => response(w)).readPR({
          number: 42,
        })
      ).status,
    ).toBe('ready')
  })
  for (const bytes of [
    new Uint8Array([0xff]),
    new Uint8Array([0xef, 0xbb, 0xbf, 123, 125]),
  ])
    it('refuses invalid UTF8 or BOM-prefixed wire', async () => {
      expect(
        (
          await createKnownPRReader(
            { token },
            async () =>
              new Response(bytes, {
                headers: { 'content-type': 'application/json' },
              }),
          ).readPR({ number: 42 })
        ).status,
      ).toBe('not_evaluated')
    })
  for (const headers of [
    { 'content-type': 'text/html' },
    { 'content-type': 'application/json; charset=latin1' },
    { 'content-length': '-1' },
    { 'content-length': '01' },
    { 'content-length': '1048577' },
  ] as Record<string, string>[])
    it('refuses media/declared bound ' + JSON.stringify(headers), async () => {
      expect(
        (
          await createKnownPRReader({ token }, async () =>
            textResponse(JSON.stringify(wire()), headers),
          ).readPR({ number: 42 })
        ).status,
      ).toBe('not_evaluated')
    })
  it('accepts the negotiated vendor JSON media type', async () => {
    expect(
      (
        await createKnownPRReader({ token }, async () =>
          textResponse(JSON.stringify(wire()), {
            'content-type': 'application/vnd.github+json',
          }),
        ).readPR({ number: 42 })
      ).status,
    ).toBe('ready')
  })
  it('enforces actual chunked bytes independently of Content-Length', async () => {
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(1024 * 1024))
        c.enqueue(new Uint8Array(1))
      },
      cancel: cancelled,
    })
    const reader = createKnownPRReader(
      { token },
      async () =>
        new Response(body, {
          headers: {
            'content-type': 'application/json',
            'content-length': '1',
          },
        }),
    )
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'body',
    })
    await tick()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
  it('accepts a complete 1MiB envelope and refuses one byte more', async () => {
    const base = JSON.stringify(wire())
    for (const extra of [0, 1]) {
      const text = base + ' '.repeat(1024 * 1024 - base.length + extra)
      const r = await createKnownPRReader({ token }, async () =>
        textResponse(text),
      ).readPR({ number: 42 })
      expect(r.status).toBe(extra ? 'not_evaluated' : 'ready')
    }
  })
  it('handles multibyte strings split between chunks', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...wire(), body: 'λ😀' }),
    )
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < bytes.length) c.enqueue(bytes.slice(i, (i += 1)))
        else c.close()
      },
    })
    expect(
      (
        await createKnownPRReader(
          { token },
          async () =>
            new Response(body, {
              headers: { 'content-type': 'application/json' },
            }),
        ).readPR({ number: 42 })
      ).status,
    ).toBe('ready')
  })
})

describe('known PR occupied lifetime', () => {
  it('retains the slot until non200 cancellation is acknowledged', async () => {
    const cancel = deferred<void>()
    let calls = 0
    const reader = createKnownPRReader({ token }, async () => {
      calls++
      return calls === 1
        ? new Response(
            new ReadableStream({
              cancel() {
                return cancel.promise
              },
            }),
            { status: 404 },
          )
        : response()
    })
    expect((await reader.readPR({ number: 42 })).status).toBe('not_evaluated')
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    expect(calls).toBe(1)
    cancel.resolve()
    await tick()
    expect((await reader.readPR({ number: 42 })).status).toBe('ready')
    expect(calls).toBe(2)
  })
  it('a rejected cancellation does not release uncertain occupancy', async () => {
    const reader = createKnownPRReader(
      { token },
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              return Promise.reject(Error('private failure'))
            },
          }),
          { status: 403 },
        ),
    )
    expect((await reader.readPR({ number: 42 })).status).toBe('refused')
    await tick()
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    reader.dispose()
  })
  it('disposal aborts without allowing a late response to revive the client', async () => {
    const late = deferred<Response>()
    let signal: AbortSignal | null | undefined
    const reader = createKnownPRReader({ token }, (_u, init) => {
      signal = init?.signal
      return late.promise
    })
    const p = reader.readPR({ number: 42 })
    reader.dispose()
    expect(await p).toEqual({ status: 'not_evaluated', reason: 'aborted' })
    expect(signal?.aborted).toBe(true)
    const cancel = vi.fn()
    late.resolve(new Response(new ReadableStream({ cancel })))
    await tick()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'refused',
      reason: 'closed',
    })
  })
  it('terminal reader failure releases the slot without leaking the exception', async () => {
    let calls = 0
    const reader = createKnownPRReader({ token }, async () =>
      ++calls === 1
        ? new Response(
            new ReadableStream({
              start(c) {
                c.error(Error(token))
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : response(),
    )
    const r = await reader.readPR({ number: 42 })
    expect(r).toEqual({ status: 'not_evaluated', reason: 'body' })
    expect(JSON.stringify(r)).not.toContain(token)
    expect((await reader.readPR({ number: 42 })).status).toBe('ready')
  })
  for (const sync of [true, false])
    it('transport failure releases without retry ' + sync, async () => {
      let calls = 0
      const reader = createKnownPRReader({ token }, () => {
        calls++
        if (calls > 1) return Promise.resolve(response())
        if (sync) throw Error(token)
        return Promise.reject(Error(token))
      })
      expect(await reader.readPR({ number: 42 })).toEqual({
        status: 'not_evaluated',
        reason: 'transport',
      })
      expect(calls).toBe(1)
      expect((await reader.readPR({ number: 42 })).status).toBe('ready')
    })
  it('validation time consumes the original deadline before dispatch', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const transport = vi.fn(async () => response())
    const reader = createKnownPRReader({ token }, transport)
    expect(
      await reader.readPR({
        get number() {
          now = 10_001
          return 42
        },
      }),
    ).toEqual({ status: 'not_evaluated', reason: 'timeout' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('decoding cannot replace the original deadline with a fresh interval', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const real = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, ...args) => {
      const out = real(text, ...args)
      if (text.startsWith('{')) now = 10_001
      return out
    })
    const reader = createKnownPRReader({ token }, async () => response())
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
    })
  })
  it('rechecks disposal caused by a host input accessor before dispatch', async () => {
    const transport = vi.fn(async () => response())
    const reader = createKnownPRReader({ token }, transport)
    expect(
      await reader.readPR({
        get number() {
          reader.dispose()
          return 42
        },
      }),
    ).toEqual({ status: 'refused', reason: 'closed' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('a late rejected fetch releases a retired slot only after settlement', async () => {
    vi.useFakeTimers()
    const late = deferred<Response>()
    let calls = 0
    const reader = createKnownPRReader({ token }, () =>
      ++calls === 1 ? late.promise : Promise.resolve(response()),
    )
    const p = reader.readPR({ number: 42 })
    await vi.advanceTimersByTimeAsync(10_001)
    expect((await p).status).toBe('not_evaluated')
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    late.reject(Error(token))
    await tick()
    expect((await reader.readPR({ number: 42 })).status).toBe('ready')
  })
  it('a timed-out stream does not free occupancy while cancellation is pending', async () => {
    vi.useFakeTimers()
    const pendingCancel = deferred<void>()
    const reader = createKnownPRReader(
      { token },
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {})
            },
            cancel() {
              return pendingCancel.promise
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )
    const p = reader.readPR({ number: 42 })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await p).toEqual({ status: 'not_evaluated', reason: 'timeout' })
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    pendingCancel.resolve()
    await tick()
    reader.dispose()
  })
})

describe('known PR lifetime ownership boundaries', () => {
  it('does not overwrite a reentrant operation started by an input accessor', async () => {
    const late = deferred<Response>()
    const transport = vi.fn(() => late.promise)
    const reader = createKnownPRReader({ token }, transport)
    let inner: ReturnType<typeof reader.readPR> | undefined
    const outer = await reader.readPR({
      get number() {
        inner ??= reader.readPR({ number: 42 })
        return 42
      },
    })
    expect(outer).toEqual({ status: 'not_evaluated', reason: 'busy' })
    expect(transport).toHaveBeenCalledTimes(1)
    late.resolve(response())
    expect((await inner!).status).toBe('ready')
  })
  it('does not use ambient fetch when explicit transport is missing', async () => {
    const ambient = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Error('must not run'))
    expect(
      await createKnownPRReader({ token }, undefined as never).readPR({
        number: 42,
      }),
    ).toEqual({ status: 'refused', reason: 'config' })
    expect(ambient).not.toHaveBeenCalled()
  })
  it('does not leak a throwing credential accessor', async () => {
    const transport = vi.fn(async () => response())
    const reader = createKnownPRReader(
      {
        get token() {
          throw Error(token)
        },
      },
      transport,
    )
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'refused',
      reason: 'config',
    })
    expect(transport).not.toHaveBeenCalled()
  })
  it('refuses non-byte stream chunks and cancels that owned stream', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(c) {
        c.enqueue('wrong chunk')
      },
      cancel,
    })
    const reader = createKnownPRReader(
      { token },
      async () =>
        new Response(body as never, {
          headers: { 'content-type': 'application/json' },
        }),
    )
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'body',
    })
    await tick()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('keeps a late response cancellation rejection occupied after timeout', async () => {
    vi.useFakeTimers()
    const late = deferred<Response>()
    const reader = createKnownPRReader({ token }, () => late.promise)
    const first = reader.readPR({ number: 42 })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await first).toEqual({ status: 'not_evaluated', reason: 'timeout' })
    late.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            return Promise.reject(Error(token))
          },
        }),
      ),
    )
    await tick()
    expect(await reader.readPR({ number: 42 })).toEqual({
      status: 'not_evaluated',
      reason: 'busy',
    })
    reader.dispose()
  })
  it('does not turn optional mergeability or checks fields into success authority', async () => {
    const w = {
      ...wire(),
      mergeable: true,
      mergeable_state: 'clean',
      checks: 'passed',
      auto_merge: { enabled: true },
    }
    const r = await createKnownPRReader({ token }, async () =>
      response(w),
    ).readPR({ number: 42 })
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') throw Error('ready')
    expect(r.observation.merged).toBe(false)
    expect(r.observation.mergeCommit).toBeNull()
    expect(r.observation).not.toHaveProperty('checks')
  })
})
