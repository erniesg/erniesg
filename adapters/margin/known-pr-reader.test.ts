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

// Configured-check feature: upstream job envelopes intentionally omit run_attempt.
const configuredProfile =
  'a18da97e6446100605fc3b3accb53ffed12f1597d5a5433577aead8086a01859'
const runApi = 'https://api.github.com/repos/erniesg/erniesg/actions/runs'
function checkRuns() {
  return ['ci.yml', 'agent-evidence.yml'].map((file, i) => ({
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
  }))
}
function checkJobs(i: number) {
  return (i === 0 ? ['checks', 'secret-scan'] : ['evidence']).map(
    (name, j) => ({
      id: 701 + i * 10 + j,
      run_id: 501 + i,
      head_sha: 'b'.repeat(40),
      name,
      html_url: `https://github.com/erniesg/erniesg/actions/runs/${501 + i}/job/${701 + i * 10 + j}`,
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
    }),
  )
}
function checkSequence() {
  return [
    wire(),
    { total_count: 2, workflow_runs: checkRuns() },
    { total_count: 2, jobs: checkJobs(0) },
    { total_count: 1, jobs: checkJobs(1) },
    { total_count: 2, workflow_runs: checkRuns() },
    wire(),
  ]
}
async function configuredRead(sequence = checkSequence()) {
  const calls: string[] = []
  const reader = createKnownPRReader({ token }, async (url) => {
    calls.push(String(url))
    const value = sequence.shift()
    if (value === undefined) throw Error('unexpected request')
    return response(value)
  })
  try {
    return {
      result: await reader.readPR({ number: 42, checks: 'configured' }),
      calls,
    }
  } finally {
    reader.dispose()
  }
}
describe('configured head-job observation initial behavioral REDs', () => {
  it('reads exactly two selected attempts and returns informational passed for three successes', async () => {
    const { result, calls } = await configuredRead()
    expect(result).toMatchObject({
      status: 'ready',
      observation: {
        head: 'b'.repeat(40),
        checks: {
          profile: configuredProfile,
          head: 'b'.repeat(40),
          state: 'passed',
          reason: 'complete',
        },
      },
    })
    expect(calls).toEqual([
      api,
      runApi +
        '?head_sha=' +
        'b'.repeat(40) +
        '&event=pull_request&per_page=100',
      runApi + '/501/attempts/2/jobs?per_page=100',
      runApi + '/502/attempts/2/jobs?per_page=100',
      runApi +
        '?head_sha=' +
        'b'.repeat(40) +
        '&event=pull_request&per_page=100',
      api,
    ])
  })
  it('distinguishes evaluated failure and pending from neutral/partial unknown', async () => {
    for (const [conclusion, status, state] of [
      ['failure', 'completed', 'failed'],
      [null, 'in_progress', 'pending'],
      ['neutral', 'completed', 'not_evaluated'],
    ] as const) {
      const sequence = checkSequence()
      const jobs = sequence[2] as { jobs: ReturnType<typeof checkJobs> }
      jobs.jobs[0].status = status
      jobs.jobs[0].conclusion = conclusion as string
      expect((await configuredRead(sequence)).result).toMatchObject({
        status: 'ready',
        observation: { checks: { state } },
      })
    }
  })
  it('returns the exact final changed head and discards prior green jobs', async () => {
    const sequence = checkSequence()
    ;(sequence[5] as ReturnType<typeof wire>).head.sha = 'd'.repeat(40)
    expect((await configuredRead(sequence)).result).toMatchObject({
      status: 'ready',
      observation: {
        head: 'd'.repeat(40),
        checks: {
          head: 'd'.repeat(40),
          state: 'not_evaluated',
          reason: 'head_changed',
        },
      },
    })
  })
  it('preserves observed head when check access is refused without classifying it failed', async () => {
    let calls = 0
    const reader = createKnownPRReader({ token }, async () =>
      ++calls === 2 ? new Response('', { status: 403 }) : response(wire()),
    )
    try {
      expect(
        await reader.readPR({ number: 42, checks: 'configured' }),
      ).toMatchObject({
        status: 'ready',
        observation: {
          head: 'b'.repeat(40),
          checks: { state: 'not_evaluated', reason: 'provider_refused' },
        },
      })
      expect(calls).toBe(3)
    } finally {
      reader.dispose()
    }
  })
  it('rejects observed selected-attempt drift without a seventh request or job-field fiction', async () => {
    const sequence = checkSequence()
    ;(sequence[4] as { workflow_runs: ReturnType<typeof checkRuns> })
      .workflow_runs[0].run_attempt++
    const { result, calls } = await configuredRead(sequence)
    expect(result).toMatchObject({
      status: 'ready',
      observation: {
        checks: { state: 'not_evaluated', reason: 'run_changed' },
      },
    })
    expect(calls).toHaveLength(6)
  })
})

function routeValue(url: string) {
  if (url === api) return wire()
  if (
    url ===
    runApi + '?head_sha=' + 'b'.repeat(40) + '&event=pull_request&per_page=100'
  )
    return { total_count: 2, workflow_runs: checkRuns() }
  if (url === runApi + '/501/attempts/2/jobs?per_page=100')
    return { total_count: 2, jobs: checkJobs(0) }
  if (url === runApi + '/502/attempts/2/jobs?per_page=100')
    return { total_count: 1, jobs: checkJobs(1) }
  throw Error('unapproved route')
}
async function routeRead(
  change: (value: any, url: string, count: number) => any,
) {
  let count = 0
  const reader = createKnownPRReader({ token }, async (u) => {
    const url = String(u)
    const v = change(routeValue(url), url, ++count)
    return v instanceof Response ? v : response(v)
  })
  try {
    return {
      result: await reader.readPR({ number: 42, checks: 'configured' }),
      count,
    }
  } finally {
    reader.dispose()
  }
}
describe('configured producer, completeness and resource rule sweep', () => {
  it('rejects unknown or contradictory workflow states at both selected producer paths', async () => {
    for (const index of [0, 1])
      for (const delta of [
        { status: 'unknown' },
        { status: 'completed', conclusion: null },
        { status: 'queued', conclusion: 'success' },
      ]) {
        const { result } = await routeRead((v, u, c) => {
          if (c === 2 || c === 5) Object.assign(v.workflow_runs[index], delta)
          return v
        })
        expect(result).toMatchObject({
          status: 'ready',
          observation: { checks: { state: 'not_evaluated' } },
        })
      }
  })
  it('binds every required job to its actual run/head/url with complete unique membership', async () => {
    for (const stage of [3, 4])
      for (const key of [
        'id',
        'run_id',
        'head_sha',
        'html_url',
        'name',
        'runner_id',
        'steps',
      ]) {
        const { result } = await routeRead((v, u, c) => {
          if (c === stage)
            v.jobs[0][key] =
              key === 'steps'
                ? []
                : key === 'id' || key === 'run_id' || key === 'runner_id'
                  ? 0
                  : 'wrong'
          return v
        })
        expect(result).toMatchObject({
          status: 'ready',
          observation: { checks: { state: 'not_evaluated' } },
        })
      }
  })
  it('refuses incomplete and duplicate IDs/names in each listing without treating truncated data as green', async () => {
    for (const stage of [2, 3, 4, 5])
      for (const mutation of ['total', 'tooMany', 'duplicate']) {
        const { result, count } = await routeRead((v, u, c) => {
          if (c === stage) {
            const rows = v.workflow_runs ?? v.jobs
            if (mutation === 'total') v.total_count++
            else if (mutation === 'tooMany') v.total_count = 101
            else {
              rows.push({ ...rows[0] })
              v.total_count++
            }
          }
          return v
        })
        expect(result).toMatchObject({
          status: 'ready',
          observation: { checks: { state: 'not_evaluated' } },
        })
        expect(count).toBeLessThanOrEqual(6)
      }
  })
  it('refuses next links and duplicate JSON keys on every graph response', async () => {
    for (const stage of [2, 3, 4, 5])
      for (const form of ['next', 'duplicate']) {
        const { result } = await routeRead((v, u, c) =>
          c !== stage
            ? v
            : form === 'next'
              ? new Response(JSON.stringify(v), {
                  headers: {
                    'content-type': 'application/json',
                    link: '<https://api.github.com/other>; rel="next"',
                  },
                })
              : new Response('{"total_count":0,' + JSON.stringify(v).slice(1), {
                  headers: { 'content-type': 'application/json' },
                }),
        )
        expect(result).toMatchObject({
          status: 'ready',
          observation: { checks: { state: 'not_evaluated' } },
        })
      }
  })
  it('selects the newest run independent of row ordering and refuses ambiguous run numbers', async () => {
    const reversed = await routeRead((v) => {
      v.workflow_runs?.reverse()
      return v
    })
    expect(reversed.result).toMatchObject({
      observation: { checks: { state: 'passed' } },
    })
    const tied = await routeRead((v, u, c) => {
      if (c === 2) {
        v.workflow_runs.push({
          ...v.workflow_runs[0],
          id: 999,
          html_url: 'https://github.com/erniesg/erniesg/actions/runs/999',
        })
        v.total_count++
      }
      return v
    })
    expect(tied.result).toMatchObject({
      observation: { checks: { state: 'not_evaluated' } },
    })
  })
  it('caps every response at one MiB including otherwise harmless unprojected data', async () => {
    for (const stage of [2, 3, 4, 5, 6]) {
      const { result, count } = await routeRead((v, u, c) =>
        c === stage ? { ...v, padding: 'x'.repeat(1024 * 1024) } : v,
      )
      expect(result).toMatchObject({
        status: 'ready',
        observation: { checks: { state: 'not_evaluated' } },
      })
      expect(count).toBeLessThanOrEqual(6)
    }
  })
  it('allows six exact-limit small-depth bodies and never exceeds six MiB or six calls', async () => {
    const sizes: number[] = []
    const { result, count } = await routeRead((v) => {
      const x = { ...v, padding: '' }
      x.padding = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(x)))
      sizes.push(Buffer.byteLength(JSON.stringify(x)))
      return new Response(JSON.stringify(x), {
        headers: { 'content-type': 'application/json' },
      })
    })
    expect(result).toMatchObject({
      status: 'ready',
      observation: { checks: { state: 'passed' } },
    })
    expect(count).toBe(6)
    expect(sizes).toEqual(Array(6).fill(1024 * 1024))
  })
  it('uses one absolute deadline across child reads, including the final witness', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { result, count } = await routeRead((v) => {
      now += 2001
      return v
    })
    expect(count).toBe(5)
    expect(result).toMatchObject({
      status: 'ready',
      observation: {
        head: 'b'.repeat(40),
        checks: { state: 'not_evaluated', reason: 'timeout' },
      },
    })
  })
  it('does not read checks for a closed PR, and adopts a valid terminal final PR', async () => {
    for (const stage of [1, 6]) {
      const { result, count } = await routeRead((v, u, c) => {
        if (c === stage) {
          v.state = 'closed'
          v.merged = true
          v.merge_commit_sha = 'e'.repeat(40)
        }
        return v
      })
      expect(result).toMatchObject({
        status: 'ready',
        observation: {
          state: 'closed',
          merged: true,
          mergeCommit: 'e'.repeat(40),
        },
      })
      if (result.status === 'ready')
        expect(result.observation).not.toHaveProperty('checks')
      expect(count).toBe(stage === 1 ? 1 : 6)
    }
  })
})
const configuredTick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
describe('configured persistent operation lifetime at every owned GET', () => {
  for (const stage of [1, 2, 3, 4, 5, 6])
    it(`retains ignored-abort fetch and late-cancel occupancy at GET ${stage}`, async () => {
      vi.useFakeTimers()
      let deliver!: (r: Response) => void,
        ack!: () => void,
        count = 0
      const late = new Promise<Response>((r) => (deliver = r)),
        cancelled = new Promise<void>((r) => (ack = r)),
        cancel = vi.fn(() => cancelled)
      const reader = createKnownPRReader({ token }, async (u) =>
        ++count === stage ? late : response(routeValue(String(u))),
      )
      const pending = reader.readPR({ number: 42, checks: 'configured' })
      await configuredTick()
      expect(count).toBe(stage)
      await vi.advanceTimersByTimeAsync(10001)
      const r = await pending
      expect(r).toMatchObject(
        stage === 1
          ? { status: 'not_evaluated', reason: 'timeout' }
          : {
              status: 'ready',
              observation: {
                checks: { state: 'not_evaluated', reason: 'timeout' },
              },
            },
      )
      expect(
        await reader.readPR({ number: 42, checks: 'configured' }),
      ).toMatchObject({ reason: 'busy' })
      deliver(new Response(new ReadableStream({ cancel })))
      await configuredTick()
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(await reader.readPR({ number: 42 })).toMatchObject({
        reason: 'busy',
      })
      expect(count).toBe(stage)
      ack()
      await configuredTick()
      reader.dispose()
      expect(await reader.readPR({ number: 42 })).toMatchObject({
        reason: 'closed',
      })
    })
  for (const stage of [2, 3, 4, 5, 6])
    for (const form of ['status', 'header'])
      it(`keeps refused ${form} body owned at GET ${stage}`, async () => {
        vi.useFakeTimers()
        let count = 0,
          ack!: () => void
        const cancelled = new Promise<void>((r) => (ack = r))
        const cancel = vi.fn(() => cancelled)
        const reader = createKnownPRReader({ token }, async (u) =>
          ++count === stage
            ? new Response(new ReadableStream({ cancel }), {
                status: form === 'status' ? 403 : 200,
                headers: { 'content-type': 'text/plain' },
              })
            : response(routeValue(String(u))),
        )
        const pending = reader.readPR({ number: 42, checks: 'configured' })
        await configuredTick()
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(count).toBe(stage)
        await vi.advanceTimersByTimeAsync(10001)
        expect(await pending).toMatchObject({
          status: 'ready',
          observation: { checks: { state: 'not_evaluated' } },
        })
        expect(await reader.readPR({ number: 42 })).toMatchObject({
          reason: 'busy',
        })
        expect(count).toBe(stage)
        ack()
        await configuredTick()
        reader.dispose()
      })
  for (const stage of [2, 3, 4, 5, 6])
    it(`retains permanently failed cancellation at GET ${stage}`, async () => {
      let count = 0
      const reader = createKnownPRReader({ token }, async (u) =>
        ++count === stage
          ? new Response(
              new ReadableStream({
                cancel() {
                  return Promise.reject(Error('synthetic'))
                },
              }),
              { status: 403 },
            )
          : response(routeValue(String(u))),
      )
      const r = await reader.readPR({ number: 42, checks: 'configured' })
      expect(r).toMatchObject({
        status: 'ready',
        observation: { checks: { state: 'not_evaluated' } },
      })
      expect(await reader.readPR({ number: 42 })).toMatchObject({
        reason: 'busy',
      })
      expect(count).toBe(stage)
      reader.dispose()
    })
})

describe('configured profile and unavailable final witness', () => {
  it('binds the finite display profile to reviewed immutable configuration bytes', async () => {
    const { readFileSync } = await import('node:fs')
    const { createHash } = await import('node:crypto')
    for (const [path, sha] of [
      [
        '.agent/merge-policy.yaml',
        '78e0d44046351082265519a7fbc87b3bf978ea3953692300780c5870637fb0fe',
      ],
      [
        '.github/workflows/ci.yml',
        'cf48d167a4d831c36929e446012a57f6807f68df0340d88400915073bbef51fb',
      ],
      [
        '.github/workflows/agent-evidence.yml',
        '58ff392bd83d357272da7b8cc0ecd92974dbe87f115d4e85e0003b0257b1e3ad',
      ],
    ])
      expect(
        createHash('sha256')
          .update(readFileSync(new URL('../../' + path, import.meta.url)))
          .digest('hex'),
      ).toBe(sha)
  })
  it('reports only the initial observed head when the final PR witness is refused', async () => {
    const { result } = await routeRead((v, u, c) =>
      c === 6 ? new Response(null, { status: 403 }) : v,
    )
    expect(result).toMatchObject({
      status: 'ready',
      observation: {
        head: 'b'.repeat(40),
        checks: { state: 'not_evaluated', reason: 'final_pr_unavailable' },
      },
    })
  })
  it('does not serialize provider messages or credentials into a classified partial result', async () => {
    const { result } = await routeRead((v, u, c) =>
      c === 2
        ? new Response('private error text ' + token, { status: 500 })
        : v,
    )
    expect(result).toMatchObject({
      status: 'ready',
      observation: { checks: { reason: 'response_status' } },
    })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('private error')
  })
})

describe('IC-OUTCOME-1 success-only execution witness', () => {
  const selected = [
    { name: 'checks', stage: 3, index: 0 },
    { name: 'secret-scan', stage: 3, index: 1 },
    { name: 'evidence', stage: 4, index: 0 },
  ]
  for (const target of selected)
    for (const conclusion of [
      'failure',
      'timed_out',
      'cancelled',
      'action_required',
    ])
      it(`${target.name} ${conclusion} remains evaluated without a runner/step witness`, async () => {
        for (const runner of [null, 0, undefined]) {
          const { result } = await routeRead((v, u, stage) => {
            if (stage === target.stage) {
              const job = v.jobs[target.index]
              job.conclusion = conclusion
              if (runner === undefined) delete job.runner_id
              else job.runner_id = runner
              delete job.steps
            }
            return v
          })
          expect(result).toMatchObject({
            status: 'ready',
            observation: { checks: { state: 'failed', reason: 'failed' } },
          })
        }
      })
  for (const target of selected)
    it(`${target.name} success still needs positive runner and nonempty steps`, async () => {
      for (const runner of [null, 0, undefined]) {
        const { result } = await routeRead((v, u, stage) => {
          if (stage === target.stage) {
            const job = v.jobs[target.index]
            if (runner === undefined) delete job.runner_id
            else job.runner_id = runner
            job.steps = []
          }
          return v
        })
        expect(result).toMatchObject({
          status: 'ready',
          observation: { checks: { state: 'not_evaluated' } },
        })
      }
    })
  it('provided malformed runner identities and wrong producer binding remain unknown even for failure', async () => {
    for (const target of selected)
      for (const patch of [
        { runner_id: -1 },
        { runner_id: '91' },
        { run_id: 9 },
        { head_sha: 'f'.repeat(40) },
      ]) {
        const { result } = await routeRead((v, u, stage) => {
          if (stage === target.stage)
            Object.assign(
              v.jobs[target.index],
              { conclusion: 'failure' },
              patch,
            )
          return v
        })
        expect(result).toMatchObject({
          status: 'ready',
          observation: { checks: { state: 'not_evaluated' } },
        })
      }
  })
  it('an unknown required job still dominates another evaluated failure', async () => {
    const { result } = await routeRead((v, u, stage) => {
      if (stage === 3) {
        v.jobs[0].conclusion = 'failure'
        v.jobs[0].runner_id = null
        delete v.jobs[0].steps
      }
      if (stage === 4) v.jobs[0].conclusion = 'neutral'
      return v
    })
    expect(result).toMatchObject({
      status: 'ready',
      observation: { checks: { state: 'not_evaluated' } },
    })
  })
  it('schema absence is not a failure to identify a completed failed job', async () => {
    const { result } = await routeRead((v, u, stage) => {
      if (stage === 4) {
        v.jobs[0].conclusion = 'failure'
        delete v.jobs[0].runner_id
        delete v.jobs[0].steps
      }
      return v
    })
    expect(result).toMatchObject({
      status: 'ready',
      observation: { checks: { state: 'failed', reason: 'failed' } },
    })
  })
})

describe('cross-method source observation occupancy', () => {
  it.each([undefined, 'configured'] as const)('keeps source observation busy during a PR operation %s', async checks => {
    const d = deferred<Response>(), reader = createKnownPRReader({ token }, () => d.promise)
    const pending = reader.readPR({ number: 42, ...(checks ? { checks } : {}) })
    expect(await reader.readPublicSource({ branch: `coordinator/margin-proposal-${'1'.repeat(64)}`, sourcePath: 'books/chapters/intro.md' })).toEqual({ status: 'not_evaluated', reason: 'busy' })
    reader.dispose(); expect(await pending).toMatchObject({ reason: 'aborted' })
    d.resolve(response()); await tick()
  })
})

describe('artifact discovery shares the existing occupied lifetime', () => {
  const base = 'https://api.github.com/repos/erniesg/erniesg'
  const correlation = {
    publicCorrelation: { version: 1, value: '1'.repeat(64) },
  }
  const branch = 'coordinator/margin-proposal-' + '1'.repeat(64)
  const meta = {
    id: 123,
    full_name: 'erniesg/erniesg',
    url: base,
    html_url: 'https://github.com/erniesg/erniesg',
  }
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), {
      headers: { 'content-type': 'application/json' },
    })
  it.each(['pr', 'source'] as const)(
    'refuses discovery while %s owns an unresolved transport',
    async (mode) => {
      let resolve!: (r: Response) => void
      const reader = createKnownPRReader(
        { token },
        () => new Promise<Response>((r) => (resolve = r)),
      )
      const pending =
        mode === 'pr'
          ? reader.readPR({ number: 42 })
          : reader.readPublicSource({
              branch,
              sourcePath: 'books/chapters/intro.md',
            })
      expect(await reader.discoverPublicArtifacts(correlation)).toMatchObject({
        reason: 'busy',
      })
      reader.dispose()
      expect(await pending).toMatchObject({ reason: 'aborted' })
      resolve(response())
      await tick()
    },
  )
  for (const stage of [1, 2, 3])
    for (const refusal of ['status', 'media', 'link'] as const) {
      if (stage === 1 && refusal === 'link') continue
      it(`retains ${stage}/${refusal} cleanup occupancy until cancellation acknowledgment`, async () => {
        vi.useFakeTimers()
        let ack!: () => void,
          cancels = 0,
          calls = 0
        const cancellation = new Promise<void>((r) => (ack = r))
        const reader = createKnownPRReader({ token }, async () => {
          calls++
          if (calls < stage) return json(calls === 1 ? meta : [])
          if (calls > stage) return response()
          return new Response(
            new ReadableStream({
              cancel() {
                cancels++
                return cancellation
              },
            }),
            {
              status: refusal === 'status' ? 403 : 200,
              headers: {
                'content-type':
                  refusal === 'media' ? 'text/html' : 'application/json',
                ...(refusal === 'link' ? { link: 'malformed' } : {}),
              },
            },
          )
        })
        const pending = reader.discoverPublicArtifacts(correlation)
        await tick()
        expect(cancels).toBe(1)
        expect(await reader.readPR({ number: 42 })).toMatchObject({
          reason: 'busy',
        })
        expect(
          await reader.readPublicSource({
            branch,
            sourcePath: 'books/chapters/intro.md',
          }),
        ).toMatchObject({ reason: 'busy' })
        expect(await reader.discoverPublicArtifacts(correlation)).toMatchObject(
          { reason: 'busy' },
        )
        await vi.advanceTimersByTimeAsync(10001)
        expect(await pending).toMatchObject({ reason: 'timeout' })
        expect(await reader.discoverPublicArtifacts(correlation)).toMatchObject(
          { reason: 'busy' },
        )
        expect(calls).toBe(stage)
        expect(cancels).toBe(1)
        ack()
        await tick()
        expect(await reader.readPR({ number: 42 })).toMatchObject({
          status: 'ready',
        })
        reader.dispose()
      })
    }
  it.each([1, 2, 3])(
    'retains unresolved body-read ownership on dispose at discovery phase%s',
    async (stage) => {
      let calls = 0,
        ack!: () => void,
        cancelled = 0
      const cancellation = new Promise<void>((r) => (ack = r))
      const reader = createKnownPRReader({ token }, async () => {
        calls++
        if (calls < stage) return json(calls === 1 ? meta : [])
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {})
            },
            cancel() {
              cancelled++
              return cancellation
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      })
      const pending = reader.discoverPublicArtifacts(correlation)
      await tick()
      reader.dispose()
      expect(await pending).toMatchObject({ reason: 'aborted' })
      await tick()
      expect(cancelled).toBe(1)
      expect(await reader.readPR({ number: 42 })).toMatchObject({
        reason: 'closed',
      })
      expect(
        await reader.readPublicSource({
          branch,
          sourcePath: 'books/chapters/intro.md',
        }),
      ).toMatchObject({ reason: 'closed' })
      expect(await reader.discoverPublicArtifacts(correlation)).toMatchObject({
        reason: 'closed',
      })
      ack()
      await tick()
      expect(calls).toBe(stage)
    },
  )
  it('never frees a discovery slot when body cancellation rejects', async () => {
    let calls = 0
    const reader = createKnownPRReader({ token }, async () => {
      calls++
      return new Response(
        new ReadableStream({
          cancel() {
            throw Error('synthetic refusal')
          },
        }),
        { status: 403 },
      )
    })
    expect(await reader.discoverPublicArtifacts(correlation)).toMatchObject({
      reason: 'body',
    })
    expect(await reader.readPR({ number: 42 })).toMatchObject({
      reason: 'busy',
    })
    expect(await reader.discoverPublicArtifacts(correlation)).toMatchObject({
      reason: 'busy',
    })
    expect(calls).toBe(1)
    reader.dispose()
  })
})

describe('artifact discovery late list transport ownership', () => {
  it.each([2, 3])(
    'keeps phase%s occupied after ignored abort until late body cancel completes',
    async (phase) => {
      vi.useFakeTimers()
      let calls = 0,
        resolve!: (r: Response) => void,
        ack!: () => void,
        cancelled = 0
      const late = new Promise<Response>((r) => (resolve = r)),
        cancellation = new Promise<void>((r) => (ack = r))
      const base = 'https://api.github.com/repos/erniesg/erniesg'
      const reader = createKnownPRReader({ token }, async () => {
        calls++
        if (calls === phase) return late
        return new Response(
          JSON.stringify(
            calls === 1
              ? {
                  id: 123,
                  full_name: 'erniesg/erniesg',
                  url: base,
                  html_url: 'https://github.com/erniesg/erniesg',
                }
              : [],
          ),
          { headers: { 'content-type': 'application/json' } },
        )
      })
      const request = {
        publicCorrelation: { version: 1, value: '1'.repeat(64) },
      }
      const pending = reader.discoverPublicArtifacts(request)
      await tick()
      expect(calls).toBe(phase)
      await vi.advanceTimersByTimeAsync(10001)
      expect(await pending).toMatchObject({ reason: 'timeout' })
      expect(await reader.discoverPublicArtifacts(request)).toMatchObject({
        reason: 'busy',
      })
      resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++
              return cancellation
            },
          }),
        ),
      )
      await tick()
      expect(cancelled).toBe(1)
      expect(await reader.readPR({ number: 42 })).toMatchObject({
        reason: 'busy',
      })
      ack()
      await tick()
      reader.dispose()
      expect(calls).toBe(phase)
    },
  )
})
