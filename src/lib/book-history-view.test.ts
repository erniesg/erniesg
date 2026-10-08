import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { safeHistoryHtml } from './book-history-safe-html'
async function api() {
  const url = new URL('./book-history-view.ts', import.meta.url)
  const module = existsSync(url)
    ? await import(/* @vite-ignore */ url.href)
    : {}
  expect(module.HistoryRequests).toBeTypeOf('function')
  return module as any
}
const sha = (x: string) => createHash('sha256').update(x).digest('hex')
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x) + '\n')
const oid = 'a'.repeat(40),
  old = 'b'.repeat(40),
  build = 'c'.repeat(40)
const page = {
  site: 'https://second.example',
  document: 'https://second.example/books/book/node/',
  book: 'book',
  node: 'node',
  sourcePath: 'books/chapters/current.md',
  buildCommit: build,
}
function fixture() {
  const raw = {
    schemaVersion: 1,
    ...page,
    versions: [
      {
        commit: oid,
        author: 'Reader',
        date: '2026-10-07T00:00:00+00:00',
        message: 'Public history',
        path: 'books/chapters/renamed.md',
        change: 'M',
        deleted: false,
        content: 'Historical source',
      },
      {
        commit: old,
        author: 'Reader',
        date: '2026-10-08T00:00:00+00:00',
        message: 'Deleted',
        path: 'books/chapters/older.md',
        change: 'D',
        deleted: true,
        content: null,
      },
    ],
  }
  // Match the publisher's canonical key order, not the page prop order.
  const rawAsset = {
    schemaVersion: 1,
    site: raw.site,
    document: raw.document,
    book: raw.book,
    node: raw.node,
    buildCommit: raw.buildCommit,
    sourcePath: raw.sourcePath,
    versions: raw.versions,
  }
  const css = '.history-content p { color:var(--ink); }'
  const common = {
    schemaVersion: 1,
    profile: 'book-history-safe-html-v1',
    site: page.site,
    document: page.document,
    book: page.book,
    node: page.node,
    buildCommit: build,
    rendererProfile: 'node-content-readonly-v1',
    rendererFingerprint: 'd'.repeat(64),
    publicationFingerprint: 'e'.repeat(64),
    rawHistorySha256: sha(new TextDecoder().decode(bytes(rawAsset))),
    contentCssSha256: 'f'.repeat(64),
    scopedCssSha256: sha(css),
  }
  const safe = safeHistoryHtml('<p>Historical text.</p>', 'h-fixture')
  const version = {
    kind: 'rendered-history-version',
    ...common,
    commit: oid,
    sourcePath: raw.versions[0].path,
    sourceOID: 'd'.repeat(40),
    sourceSha256: sha(raw.versions[0].content!),
    treeOID: 'e'.repeat(40),
    renderSha256: '0'.repeat(64),
    safeHtml: safe.html,
    safeHtmlSha256: sha(safe.html),
    blocks: safe.blocks,
  }
  const data = bytes(version),
    pathname = `/books/book/node/history-rendered/${oid}.json`
  const index = {
    kind: 'rendered-history-index',
    ...common,
    scopedCss: css,
    versions: [
      {
        commit: oid,
        deleted: false,
        pathname,
        sha256: sha(new TextDecoder().decode(data)),
        bytes: data.length,
      },
      { commit: old, deleted: true },
    ],
  }
  return { raw: rawAsset, index, version, data, pathname }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('holds two ignored-abort slots across metadata and version generations until actual settlement', async () => {
  const { HistoryRequests } = await api()
  vi.useFakeTimers()
  const pending: ((response: Response) => void)[] = []
  const fetcher = vi.fn(
    () => new Promise<Response>((resolve) => pending.push(resolve)),
  )
  const pool = new HistoryRequests('https://preview.example', fetcher)
  const a = new AbortController(),
    b = new AbortController()
  const p = pool
    .read('/books/book/node/history.json', 1000, a.signal)
    .catch((e: Error) => e.message)
  const q = pool
    .read('/books/book/node/history-rendered/index.json', 1000, b.signal)
    .catch((e: Error) => e.message)
  a.abort()
  b.abort()
  await Promise.all([p, q])
  await expect(
    pool.read(
      `/books/book/node/history-rendered/${oid}.json`,
      1000,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/busy/i)
  expect(fetcher).toHaveBeenCalledTimes(2)
  const cancelled = vi.fn()
  for (const resolve of pending)
    resolve(new Response(new ReadableStream({ cancel: cancelled })))
  await vi.waitFor(() => expect(pool.outstanding).toBe(0))
  expect(cancelled).toHaveBeenCalledTimes(2)
})
it('binds closed raw/index/version data to canonical identity while transport uses preview origin', async () => {
  const { decodeHistoryMetadata, decodeHistoryVersion, HistoryRequests } =
      await api(),
    f = fixture()
  const metadata = await decodeHistoryMetadata(
    bytes(f.raw),
    bytes(f.index),
    page,
  )
  const version = await decodeHistoryVersion(f.data, oid, metadata, page)
  expect(version.sourcePath).toBe('books/chapters/renamed.md')
  expect(metadata.raw.versions.map((v: any) => v.commit)).toEqual([oid, old])
  await expect(
    decodeHistoryVersion(f.data, old, metadata, page),
  ).rejects.toThrow()
  await expect(
    decodeHistoryMetadata(
      bytes(f.raw),
      bytes({ ...f.index, extra: true }),
      page,
    ),
  ).rejects.toThrow()
  await expect(
    decodeHistoryMetadata(bytes(f.raw), bytes(f.index), {
      ...page,
      buildCommit: 'f'.repeat(40),
    }),
  ).rejects.toThrow()
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => {
    const r = new Response(f.data, {
      headers: { 'Content-Type': 'application/json' },
    })
    Object.defineProperty(r, 'url', { value: url })
    return r
  })
  const pool = new HistoryRequests('https://preview.example', fetcher)
  expect(
    await pool.read(f.pathname, 10000, new AbortController().signal),
  ).toEqual(f.data)
  expect(fetcher.mock.calls[0][0]).toBe('https://preview.example' + f.pathname)
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    credentials: 'omit',
    mode: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  })
})

it('retains timed-out fetch and unacknowledged body cancellation occupancy', async () => {
  const { HistoryRequests } = await api()
  vi.useFakeTimers()
  let finishFetch!: (r: Response) => void, finishCancel!: () => void
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finishFetch = resolve
      }),
  )
  const pool = new HistoryRequests('https://preview.example', fetcher)
  const outcome = pool
    .read('/books/book/node/history.json', 100, new AbortController().signal)
    .catch((e: Error) => e.message)
  await vi.advanceTimersByTimeAsync(20000)
  expect(await outcome).toContain('timed out')
  expect(pool.outstanding).toBe(1)
  finishFetch(
    new Response(
      new ReadableStream({
        cancel: () =>
          new Promise<void>((resolve) => {
            finishCancel = resolve
          }),
      }),
    ),
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(pool.outstanding).toBe(1)
  finishCancel()
  await vi.waitFor(() => expect(pool.outstanding).toBe(0))
})
it('checks exact URL, media type and streamed bytes rather than trusting Content-Length', async () => {
  const { HistoryRequests } = await api()
  for (const variant of ['url', 'media', 'stream', 'length']) {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(101))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(stream, {
      headers: {
        'Content-Type': variant === 'media' ? 'text/html' : 'application/json',
        'Content-Length': variant === 'length' ? '101' : '1',
      },
    })
    Object.defineProperty(response, 'url', {
      value:
        variant === 'url'
          ? 'https://other.example/books/book/node/history.json'
          : 'https://preview.example/books/book/node/history.json',
    })
    const pool = new HistoryRequests(
      'https://preview.example',
      async () => response,
    )
    await expect(
      pool.read(
        '/books/book/node/history.json',
        100,
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(cancelled).toBe(true)
  }
})
it('refuses wire substitutions, aliases and malformed shallow fields before use', async () => {
  const { decodeHistoryMetadata, decodeHistoryVersion } = await api()
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.raw.sourcePath = 'books/chapters/wrong.md'
    },
    (f: ReturnType<typeof fixture>) => {
      f.index.versions.reverse()
    },
    (f: ReturnType<typeof fixture>) => {
      f.index.scopedCss += 'p{background:url(/network)}'
    },
    (f: ReturnType<typeof fixture>) => {
      f.index.versions[0].pathname = '//other.example/data'
    },
    (f: ReturnType<typeof fixture>) => {
      f.index.versions[0].bytes = 1.5
    },
  ]) {
    const f = fixture()
    mutate(f)
    await expect(
      decodeHistoryMetadata(bytes(f.raw), bytes(f.index), page),
    ).rejects.toThrow()
  }
  const f = fixture(),
    raw = new TextDecoder().decode(bytes(f.raw))
  await expect(
    decodeHistoryMetadata(
      new TextEncoder().encode(
        raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      ),
      bytes(f.index),
      page,
    ),
  ).rejects.toThrow()
  const metadata = await decodeHistoryMetadata(
    bytes(f.raw),
    bytes(f.index),
    page,
  )
  await expect(
    decodeHistoryVersion(
      bytes({ ...f.version, safeHtml: '<script>bad</script>' }),
      oid,
      metadata,
      page,
    ),
  ).rejects.toThrow()
})

// A minimal owned document facade exercises the real controller. Browser
// layout, CSP enforcement and assistive-technology behavior remain e2e gates.
class ElementFixture extends EventTarget {
  hidden = false
  textContent = ''
  value = ''
  srcdoc = ''
  children: ElementFixture[] = []
  attrs = new Map<string, string>()
  append(el: ElementFixture) {
    this.children.push(el)
  }
  replaceChildren(...children: ElementFixture[]) {
    this.children = children
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value)
  }
  removeAttribute(name: string) {
    this.attrs.delete(name)
    if (name === 'srcdoc') this.srcdoc = ''
  }
}
function panelFixture() {
  const fields = new Map<string, ElementFixture>()
  for (const name of [
    'toggle',
    'body',
    'status',
    'retry',
    'controls',
    'list',
    'more',
    'before',
    'after',
    'frame-before',
    'frame-after',
  ])
    fields.set(`[data-history-${name}]`, new ElementFixture())
  return {
    panel: {
      querySelector: (selector: string) => fields.get(selector),
    } as unknown as HTMLElement,
    get: (name: string) => fields.get(`[data-history-${name}]`)!,
  }
}
function response(data: Uint8Array, url: string) {
  const r = new Response(new Uint8Array(data), {
    headers: { 'Content-Type': 'application/json' },
  })
  Object.defineProperty(r, 'url', { value: url })
  return r
}
it('runs the actual readonly controller, preserves tombstones, and clears stale frames on close', async () => {
  const { mountBookHistory } = await api(),
    f = fixture(),
    nodes = panelFixture(),
    calls: string[] = []
  vi.stubGlobal('document', { createElement: () => new ElementFixture() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      return response(
        url.endsWith('/history.json')
          ? bytes(f.raw)
          : url.endsWith('/index.json')
            ? bytes(f.index)
            : f.data,
        url,
      )
    }),
  )
  const stop = mountBookHistory(nodes.panel, page, 'https://preview.example')
  nodes.get('toggle').dispatchEvent(new Event('click'))
  await vi.waitFor(() =>
    expect(nodes.get('frame-before').srcdoc).toContain('Historical text.'),
  )
  expect(nodes.get('before').children).toHaveLength(1)
  expect(nodes.get('list').children[1].textContent).toContain(
    'Deleted in this commit',
  )
  expect(calls.filter((url) => url.endsWith(old + '.json'))).toHaveLength(0)
  const html = nodes.get('frame-after').srcdoc
  expect(html).toContain('class="history-content"')
  expect(html).toContain("script-src 'none'")
  expect(html).not.toContain('unsafe-inline')
  expect(html).not.toMatch(/<script|\shref=/)
  nodes.get('toggle').dispatchEvent(new Event('click'))
  expect(nodes.get('frame-before').srcdoc).toBe('')
  expect(nodes.get('frame-before').hidden).toBe(true)
  stop()
})
it('discards an ignored-abort late version after close without stale frame attachment', async () => {
  const { mountBookHistory } = await api(),
    f = fixture(),
    nodes = panelFixture()
  let finish!: () => void
  vi.stubGlobal('document', { createElement: () => new ElementFixture() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/history.json')
        ? response(bytes(f.raw), url)
        : url.endsWith('/index.json')
          ? response(bytes(f.index), url)
          : new Promise<Response>((resolve) => {
              finish = () => resolve(response(f.data, url))
            }),
    ),
  )
  const stop = mountBookHistory(nodes.panel, page, 'https://preview.example')
  nodes.get('toggle').dispatchEvent(new Event('click'))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  nodes.get('toggle').dispatchEvent(new Event('click'))
  finish()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(nodes.get('frame-before').srcdoc).toBe('')
  expect(nodes.get('frame-after').srcdoc).toBe('')
  stop()
})
it('distinguishes evaluated empty history from a failed request', async () => {
  const { mountBookHistory } = await api()
  for (const unavailable of [false, true]) {
    const f = fixture(),
      nodes = panelFixture()
    f.raw.versions = []
    f.index.versions = []
    f.index.rawHistorySha256 = sha(new TextDecoder().decode(bytes(f.raw)))
    vi.stubGlobal('document', { createElement: () => new ElementFixture() })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (unavailable) throw Error('offline')
        return response(
          url.endsWith('/history.json') ? bytes(f.raw) : bytes(f.index),
          url,
        )
      }),
    )
    const stop = mountBookHistory(nodes.panel, page, 'https://preview.example')
    nodes.get('toggle').dispatchEvent(new Event('click'))
    await vi.waitFor(() =>
      expect(nodes.get('status').textContent).toContain(
        unavailable ? 'History unavailable' : 'No versions are recorded',
      ),
    )
    expect(nodes.get('retry').hidden).toBe(!unavailable)
    stop()
  }
})

it('keeps a live reader slot until pending cancellation acknowledges after abort', async () => {
  const { HistoryRequests } = await api()
  let release!: () => void
  const stream = new ReadableStream<Uint8Array>({
    cancel: () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  })
  const r = new Response(stream, {
    headers: { 'Content-Type': 'application/json' },
  })
  Object.defineProperty(r, 'url', {
    value: 'https://preview.example/books/book/node/history.json',
  })
  const pool = new HistoryRequests('https://preview.example', async () => r),
    abort = new AbortController()
  const done = pool
    .read('/books/book/node/history.json', 100, abort.signal)
    .catch((error: Error) => error.message)
  await Promise.resolve()
  await Promise.resolve()
  abort.abort()
  expect(await done).toContain('cancelled')
  expect(pool.outstanding).toBe(1)
  release()
  await vi.waitFor(() => expect(pool.outstanding).toBe(0))
})

it('validates inner payloads even when index hashes correctly describe the changed bytes', async () => {
  const { decodeHistoryMetadata, decodeHistoryVersion } = await api()
  for (const change of [
    { sourcePath: 'books/chapters/current.md' },
    { sourceSha256: '0'.repeat(64) },
    { sourceOID: 'd'.repeat(64) },
    { treeOID: 'not-an-oid' },
    { rendererFingerprint: '0'.repeat(64) },
    {
      blocks: [
        { kind: 'prose', id: 'p', digest: '0'.repeat(12), domId: 'missing' },
      ],
    },
    {
      safeHtml: '<script>unsupported</script>',
      safeHtmlSha256: sha('<script>unsupported</script>'),
    },
  ]) {
    const f = fixture(),
      modified = bytes({ ...f.version, ...change })
    f.index.versions[0].bytes = modified.length
    f.index.versions[0].sha256 = sha(new TextDecoder().decode(modified))
    const metadata = await decodeHistoryMetadata(
      bytes(f.raw),
      bytes(f.index),
      page,
    )
    await expect(
      decodeHistoryVersion(modified, oid, metadata, page),
    ).rejects.toThrow()
  }
})

it('ignores stale metadata digest completion after a close and fresh reopen', async () => {
  const { mountBookHistory } = await api(),
    f = fixture(),
    nodes = panelFixture(),
    original = globalThis.crypto
  let finish!: () => void,
    first = true
  vi.stubGlobal('crypto', {
    subtle: {
      digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const result = original.subtle.digest(algorithm, data)
        if (!first) return result
        first = false
        return new Promise<ArrayBuffer>((resolve) => {
          finish = () => {
            void result.then(resolve)
          }
        })
      },
    },
  })
  vi.stubGlobal('document', { createElement: () => new ElementFixture() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      response(
        url.endsWith('/history.json')
          ? bytes(f.raw)
          : url.endsWith('/index.json')
            ? bytes(f.index)
            : f.data,
        url,
      ),
    ),
  )
  const stop = mountBookHistory(nodes.panel, page, 'https://preview.example')
  nodes.get('toggle').dispatchEvent(new Event('click'))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  nodes.get('toggle').dispatchEvent(new Event('click'))
  nodes.get('toggle').dispatchEvent(new Event('click'))
  await vi.waitFor(() =>
    expect(nodes.get('frame-before').srcdoc).toContain('Historical text.'),
  )
  const before = nodes.get('frame-before').srcdoc,
    status = nodes.get('status').textContent
  finish()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(nodes.get('frame-before').srcdoc).toBe(before)
  expect(nodes.get('status').textContent).toBe(status)
  expect(nodes.get('list').children).toHaveLength(2)
  stop()
})

it('retains panel-wide request occupancy when the same element is disposed and remounted', async () => {
  const { mountBookHistory } = await api(),
    nodes = panelFixture()
  const pending: ((r: Response) => void)[] = []
  const fetcher = vi.fn(
    () => new Promise<Response>((resolve) => pending.push(resolve)),
  )
  vi.stubGlobal('document', { createElement: () => new ElementFixture() })
  vi.stubGlobal('fetch', fetcher)
  const first = mountBookHistory(nodes.panel, page, 'https://preview.example')
  nodes.get('toggle').dispatchEvent(new Event('click'))
  expect(fetcher).toHaveBeenCalledTimes(2)
  first()
  const second = mountBookHistory(nodes.panel, page, 'https://preview.example')
  nodes.get('toggle').dispatchEvent(new Event('click'))
  await vi.waitFor(() =>
    expect(nodes.get('status').textContent).toContain('busy'),
  )
  expect(fetcher).toHaveBeenCalledTimes(2)
  pending.forEach((resolve) => resolve(new Response('late')))
  second()
})

it.each(['default', 'injected'] as const)(
  'invokes the %s fetch callable without a HistoryRequests receiver for every asset family',
  async (mode) => {
    const { HistoryRequests } = await api()
    const calls: string[] = []
    const nativeLike = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (this !== undefined)
        throw new TypeError('Illegal invocation: unexpected fetch receiver')
      const url = String(input)
      calls.push(url)
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      })
      const response = new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
      })
      Object.defineProperty(response, 'url', { value: url })
      return Promise.resolve(response)
    }
    vi.stubGlobal('fetch', nativeLike)
    const pool =
      mode === 'default'
        ? new HistoryRequests('https://preview.example')
        : new HistoryRequests('https://preview.example', nativeLike)
    for (const path of [
      '/books/book/node/history.json',
      '/books/book/node/history-rendered/index.json',
      `/books/book/node/history-rendered/${oid}.json`,
    ]) {
      await expect(
        pool.read(path, 100, new AbortController().signal),
      ).resolves.toEqual(new TextEncoder().encode('{}'))
      await vi.waitFor(() => expect(pool.outstanding).toBe(0))
    }
    expect(calls).toHaveLength(3)
  },
)
