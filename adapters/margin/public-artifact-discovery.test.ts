import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createKnownPRReader } from './known-pr-reader'
const api = 'https://api.github.com/repos/erniesg/erniesg'
const repository = 'erniesg/erniesg',
  repositoryId = 123
const value = '1'.repeat(64),
  branch = `coordinator/margin-proposal-${value}`
const marker = `<!-- margin-proposal:${value} -->`
const input = () => ({ publicCorrelation: { version: 1, value } })
const metadata = () => ({
  id: repositoryId,
  full_name: repository,
  url: api,
  html_url: 'https://github.com/' + repository,
})
const repo = () => ({ id: repositoryId, full_name: repository })
const issue = (number = 1, body: string | null = marker) => ({
  id: number + 100,
  number,
  url: `${api}/issues/${number}`,
  html_url: `https://github.com/${repository}/issues/${number}`,
  repository_url: api,
  state: 'open',
  title: 'Synthetic',
  body,
  created_at: '2026-01-01T00:00:00Z',
})
const pull = (number = 2) => ({
  ...issue(number),
  url: `${api}/pulls/${number}`,
  html_url: `https://github.com/${repository}/pull/${number}`,
  head: { ref: branch, sha: 'a'.repeat(40), repo: repo() },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: repo() },
  merged_at: null,
  draft: false,
})
const response = (data: unknown, link?: string) =>
  new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json',
      ...(link === undefined ? {} : { link }),
    },
  })
const query = (kind: 'issues' | 'pulls', page = 1, cursor?: string) => {
  const q = new URLSearchParams({
    state: 'all',
    ...(kind === 'pulls' ? { head: 'erniesg:' + branch } : {}),
    sort: 'created',
    direction: 'asc',
    per_page: '100',
    page: String(page),
  })
  if (cursor !== undefined) q.set('after', cursor)
  return `${api}/${kind}?${q}`
}
function discover(
  reader: ReturnType<typeof createKnownPRReader>,
  request?: unknown,
) {
  const method = Reflect.get(reader, 'discoverPublicArtifacts')
  expect(typeof method).toBe('function')
  return (
    method as (
      input: unknown,
    ) => Promise<{ status: string; reason?: string; observation?: unknown }>
  )(arguments.length < 2 ? input() : request)
}
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw Error('external transport forbidden')
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('enumerates fixed repository issue and head-filtered PR lists without granting adoption authority', async () => {
  const calls: string[] = []
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async (url, init) => {
      calls.push(String(url))
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(init?.credentials).toBe('omit')
      return response(
        calls.length === 1
          ? metadata()
          : calls.length === 2
            ? [issue()]
            : [pull()],
      )
    },
  )
  const r = await discover(reader)
  expect(calls).toEqual([api, query('issues'), query('pulls')])
  expect(r).toMatchObject({
    status: 'ready',
    observation: {
      provenance: 'github-api-observed',
      repository,
      repositoryId,
      branch,
      marker,
      issues: {
        pageCount: 1,
        rowCount: 1,
        pullRowCount: 0,
        matches: [{ number: 1, markerOccurrences: 1 }],
      },
      pulls: {
        pageCount: 1,
        rowCount: 1,
        matches: [{ number: 2, headSha: 'a'.repeat(40) }],
      },
      coverage: { kind: 'terminal-provider-visible-traversals', atomic: false },
    },
  })
  expect(JSON.stringify(r)).not.toContain('Synthetic')
  expect(r).not.toHaveProperty('adopted')
  reader.dispose()
})
it('rejects all five omitted mandatory query keys both with and without cursor', async () => {
  for (const cursor of [undefined, 'synthetic-cursor=='])
    for (const missing of ['state', 'sort', 'direction', 'per_page', 'page']) {
      const next = new URL(query('issues', 2, cursor))
      next.searchParams.delete(missing)
      const calls: string[] = []
      const reader = createKnownPRReader(
        { token: 'synthetic-offline' },
        async (url) => {
          calls.push(String(url))
          return calls.length === 1
            ? response(metadata())
            : response([], `<${next}>; rel="next"`)
        },
      )
      expect(await discover(reader)).toMatchObject({
        status: 'not_evaluated',
        reason: 'pagination',
      })
      expect(calls).toHaveLength(2)
      reader.dispose()
    }
})
it('walks metadata-bound alias and opaque cursor, counting PR rows and preserving duplicate marker ambiguity', async () => {
  const next = query('issues', 2, 'synthetic-cursor==').replace(
    '/repos/erniesg/erniesg/',
    '/repositories/123/',
  )
  const prRow = {
    ...issue(3, null),
    html_url: `https://github.com/${repository}/pull/3`,
    pull_request: {
      url: `${api}/pulls/3`,
      html_url: `https://github.com/${repository}/pull/3`,
    },
  }
  const calls: string[] = []
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async (url) => {
      calls.push(String(url))
      return calls.length === 1
        ? response(metadata())
        : calls.length === 2
          ? response([prRow], `<${next}>; rel="next"`)
          : calls.length === 3
            ? response([issue(5, marker + '\r\n' + marker), issue(4)])
            : response([])
    },
  )
  expect(await discover(reader)).toMatchObject({
    status: 'ready',
    observation: {
      issues: {
        pageCount: 2,
        rowCount: 3,
        pullRowCount: 1,
        matches: [
          { number: 4, markerOccurrences: 1 },
          { number: 5, markerOccurrences: 2 },
        ],
      },
      pulls: { pageCount: 1, rowCount: 0 },
    },
  })
  expect(calls[2]).toBe(query('issues', 2, 'synthetic-cursor=='))
  reader.dispose()
})
it('refuses malformed body, duplicate identity and filtered foreign PR instead of partial observations', async () => {
  for (const bad of ['body', 'duplicate', 'foreign']) {
    const row = issue()
    if (bad === 'body') delete (row as Partial<typeof row>).body
    const pr = pull()
    if (bad === 'foreign') pr.head.repo.full_name = 'foreign/repo'
    let calls = 0
    const reader = createKnownPRReader(
      { token: 'synthetic-offline' },
      async () =>
        response(
          ++calls === 1
            ? metadata()
            : calls === 2
              ? bad === 'duplicate'
                ? [row, row]
                : [row]
              : [pr],
        ),
    )
    expect(await discover(reader)).toMatchObject({
      status: 'not_evaluated',
      reason: 'row_binding',
    })
    reader.dispose()
  }
})
it('captures correlation before first await and keeps shared occupancy through late cancellation', async () => {
  vi.useFakeTimers()
  let resolve!: (r: Response) => void, ack!: () => void
  const pendingResponse = new Promise<Response>((r) => (resolve = r)),
    pendingCancel = new Promise<void>((r) => (ack = r))
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    () => pendingResponse,
  )
  const request = input()
  const pending = discover(reader, request)
  request.publicCorrelation.value = '2'.repeat(64)
  expect(await reader.readPR({ number: 2 })).toMatchObject({ reason: 'busy' })
  expect(
    await reader.readPublicSource({
      branch,
      sourcePath: 'books/chapters/intro.md',
    }),
  ).toMatchObject({ reason: 'busy' })
  await vi.advanceTimersByTimeAsync(10001)
  expect(await pending).toMatchObject({ reason: 'timeout' })
  let cancels = 0
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancels++
          return pendingCancel
        },
      }),
    ),
  )
  await tick()
  expect(cancels).toBe(1)
  expect(await discover(reader)).toMatchObject({ reason: 'busy' })
  ack()
  await tick()
  reader.dispose()
  expect(await discover(reader)).toMatchObject({ reason: 'closed' })
})

function transcript(pages: Response[]) {
  const calls: string[] = []
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async (url) => {
      calls.push(String(url))
      const page = pages.shift()
      if (!page) throw Error('unexpected fixture request')
      return page
    },
  )
  return { reader, calls }
}
const nextLink = (kind: 'issues' | 'pulls', page: number, cursor?: string) =>
  `<${query(kind, page, cursor)}>; rel="next"`
it('rejects missing next after an earlier last-page claim instead of silently declaring terminal coverage', async () => {
  const { reader, calls } = transcript([
    response(metadata()),
    response(
      [],
      `${nextLink('issues', 2)}, <${query('issues', 3)}>; rel="last"`,
    ),
    response([]),
  ])
  expect(await discover(reader)).toMatchObject({
    status: 'not_evaluated',
    reason: 'pagination',
  })
  expect(calls).toHaveLength(3)
  reader.dispose()
})
it('reports actual consumed response and aggregate byte overflow as bounds', async () => {
  const oversized = new Uint8Array(4 * 1024 * 1024 + 1)
  const { reader, calls } = transcript([
    response(metadata()),
    new Response(oversized, {
      headers: { 'content-type': 'application/json' },
    }),
  ])
  expect(await discover(reader)).toMatchObject({
    status: 'not_evaluated',
    reason: 'bounds',
  })
  expect(calls).toHaveLength(2)
  reader.dispose()
})
it('captures primitive correlation before the pending repository read resolves', async () => {
  let resolve!: (r: Response) => void
  const pendingResponse = new Promise<Response>((r) => (resolve = r)),
    calls: string[] = []
  const reader = createKnownPRReader({ token: 'synthetic-offline' }, (url) => {
    calls.push(String(url))
    return calls.length === 1 ? pendingResponse : Promise.resolve(response([]))
  })
  const request = input(),
    pending = discover(reader, request)
  request.publicCorrelation.value = '2'.repeat(64)
  request.publicCorrelation.version = 2
  resolve(response(metadata()))
  expect(await pending).toMatchObject({
    status: 'ready',
    observation: { branch, marker },
  })
  expect(calls).toEqual([api, query('issues'), query('pulls')])
  reader.dispose()
})
it.each([
  undefined,
  null,
  {},
  [],
  { publicCorrelation: { version: 1, value, extra: 1 } },
  { publicCorrelation: { version: 2, value } },
  { publicCorrelation: { version: 1, value: value + '\n' } },
  { publicCorrelation: { version: 1, value: 'a'.repeat(63) } },
  { publicCorrelation: { version: 1, value: 'A'.repeat(64) } },
  { publicCorrelation: { version: 1, value }, complete: true },
  Object.create({ publicCorrelation: { version: 1, value } }),
])(
  'refuses noncanonical or caller-completeness input before requests (%#)',
  async (request) => {
    let calls = 0
    const reader = createKnownPRReader(
      { token: 'synthetic-offline' },
      async () => {
        calls++
        return response(metadata())
      },
    )
    expect(await discover(reader, request)).toMatchObject({
      status: 'refused',
      reason: 'input',
    })
    expect(calls).toBe(0)
    reader.dispose()
  },
)
it('does not invoke getters or accept symbol and inherited nested input authority', async () => {
  let getters = 0,
    calls = 0
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async () => {
      calls++
      return response(metadata())
    },
  )
  const requests = [
    {
      get publicCorrelation() {
        getters++
        return { version: 1, value }
      },
    },
    {
      publicCorrelation: {
        get value() {
          getters++
          return value
        },
        version: 1,
      },
    },
    { ...input(), [Symbol('extra')]: 1 },
    { publicCorrelation: Object.create({ version: 1, value }) },
    new Proxy(
      {},
      {
        ownKeys() {
          throw Error('synthetic')
        },
      },
    ),
  ]
  for (const request of requests)
    expect(await discover(reader, request)).toMatchObject({ reason: 'input' })
  expect(getters).toBe(0)
  expect(calls).toBe(0)
  reader.dispose()
})
it('supports all four relations and a consistent last claim across numbered pages', async () => {
  const links = [
    `${nextLink('issues', 2)}, <${query('issues', 3)}>; rel="last"`,
    `${nextLink('issues', 3)}, <${query('issues', 1)}>; rel="first", <${query('issues', 1)}>; rel="prev", <${query('issues', 3)}>; rel="last"`,
    `<${query('issues', 2)}>; rel="prev", <${query('issues', 1)}>; rel="first", <${query('issues', 3)}>; rel="last"`,
  ]
  const { reader, calls } = transcript([
    response(metadata()),
    ...links.map((l) => response([], l)),
    response([]),
  ])
  expect(await discover(reader)).toMatchObject({
    status: 'ready',
    observation: {
      issues: { pageCount: 3, rowCount: 0 },
      pulls: { pageCount: 1 },
    },
  })
  expect(calls).toHaveLength(5)
  reader.dispose()
})
it.each(['state', 'sort', 'direction', 'per_page', 'page', 'head'])(
  'requires every PR walk query key, with and without cursor: %s',
  async (missing) => {
    for (const cursor of [undefined, 'synthetic-cursor']) {
      const next = new URL(query('pulls', 2, cursor))
      next.searchParams.delete(missing)
      const { reader, calls } = transcript([
        response(metadata()),
        response([]),
        response([], `<${next}>; rel="next"`),
      ])
      expect(await discover(reader)).toMatchObject({ reason: 'pagination' })
      expect(calls).toHaveLength(3)
      reader.dispose()
    }
  },
)
const badLinks: [string, (url: string) => string][] = [
  ['duplicate relation', (u) => `<${u}>; rel="next", <${u}>; rel="next"`],
  ['unknown relation', (u) => `<${u}>; rel="alternate"`],
  ['unquoted relation', (u) => `<${u}>; rel=next`],
  ['trailing garbage', (u) => `<${u}>; rel="next" trailing`],
  ['trailing comma', (u) => `<${u}>; rel="next",`],
  ['extra Link parameter', (u) => `<${u}>; rel="next"; title="synthetic"`],
  ['duplicate page', (u) => `<${u}&page=2>; rel="next"`],
  ['unknown query', (u) => `<${u}&since=now>; rel="next"`],
  ['before on next', (u) => `<${u}&before=synthetic>; rel="next"`],
  ['both cursors', (u) => `<${u}&before=a&after=b>; rel="next"`],
  ['empty cursor', (u) => `<${u}&after=>; rel="next"`],
  ['long cursor', (u) => `<${u}&after=${'x'.repeat(1025)}>; rel="next"`],
  ['nonascii cursor', (u) => `<${u}&after=%C3%A9>; rel="next"`],
  ['space cursor', (u) => `<${u}&after=a+b>; rel="next"`],
  ['malformed encoding', (u) => `<${u}&after=%ZZ>; rel="next"`],
  ['wrong page', (u) => `<${u.replace('page=2', 'page=3')}>; rel="next"`],
  [
    'leading zero page',
    (u) => `<${u.replace('page=2', 'page=02')}>; rel="next"`,
  ],
  [
    'foreign repo',
    (u) => `<${u.replace('/erniesg/erniesg/', '/foreign/repo/')}>; rel="next"`,
  ],
  [
    'unbound numeric alias',
    (u) =>
      `<${u.replace('/repos/erniesg/erniesg/', '/repositories/124/')}>; rel="next"`,
  ],
  [
    'foreign origin',
    (u) => `<${u.replace('api.github.com', 'example.test')}>; rel="next"`,
  ],
  [
    'credentials',
    (u) => `<${u.replace('https://', 'https://synthetic@')}>; rel="next"`,
  ],
  ['fragment', (u) => `<${u}#synthetic>; rel="next"`],
  ['wrong walk', (u) => `<${u.replace('/issues?', '/pulls?')}>; rel="next"`],
  [
    'changed filter',
    (u) => `<${u.replace('state=all', 'state=open')}>; rel="next"`,
  ],
  ['prev on first', (u) => `<${u.replace('page=2', 'page=1')}>; rel="prev"`],
  ['first wrong page', (u) => `<${u}>; rel="first"`],
  ['last beyond without next', (u) => `<${u}>; rel="last"`],
  [
    'next beyond last',
    (u) => `<${u}>; rel="next", <${u.replace('page=2', 'page=1')}>; rel="last"`,
  ],
  ['empty', () => ''],
  ['nonlink', () => 'synthetic'],
]
it.each(badLinks)(
  'rejects the whole pagination envelope: %s',
  async (_name, make) => {
    const { reader, calls } = transcript([
      response(metadata()),
      response([], make(query('issues', 2))),
    ])
    expect(await discover(reader)).toMatchObject({ reason: 'pagination' })
    expect(calls).toHaveLength(2)
    reader.dispose()
  },
)
it.each([
  'cursor-to-number',
  'number-to-cursor',
  'repeat-cursor',
  'changed-last',
  'invalid-prev',
  'both-nonnext-cursors',
])('rejects cross-page pagination uncertainty: %s', async (kind) => {
  const first =
    kind === 'number-to-cursor'
      ? nextLink('issues', 2)
      : kind === 'changed-last'
        ? `${nextLink('issues', 2)}, <${query('issues', 3)}>; rel="last"`
        : nextLink('issues', 2, 'first-cursor')
  const next =
    kind === 'cursor-to-number'
      ? nextLink('issues', 3)
      : kind === 'repeat-cursor'
        ? nextLink('issues', 3, 'first-cursor')
        : kind === 'changed-last'
          ? `${nextLink('issues', 3)}, <${query('issues', 4)}>; rel="last"`
          : kind === 'invalid-prev'
            ? `<${query('issues', 2)}>; rel="prev"`
            : kind === 'both-nonnext-cursors'
              ? `<${query('issues', 1, 'x')}&before=y>; rel="first"`
              : nextLink('issues', 3, 'new-cursor')
  const { reader, calls } = transcript([
    response(metadata()),
    response([], first),
    response([], next),
  ])
  expect(await discover(reader)).toMatchObject({ reason: 'pagination' })
  expect(calls).toHaveLength(3)
  reader.dispose()
})
it('preserves encoded cursor contents while rebuilding only the fixed named path', async () => {
  const cursor = 'opaque+=,/%?',
    u = new URL(query('issues', 2, cursor))
  u.pathname = '/repositories/123/issues'
  const { reader, calls } = transcript([
    response(metadata()),
    response([], `<${u}>; rel="next"`),
    response([], `<${query('issues', 1)}&before=prior>; rel="prev"`),
    response([]),
  ])
  expect(await discover(reader)).toMatchObject({ status: 'ready' })
  expect(calls[2]).toBe(query('issues', 2, cursor))
  reader.dispose()
})
it('validates full terminal pages and consumes exactly the twenty-one request ceiling', async () => {
  let calls = 0
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async (url) => {
      calls++
      if (String(url) === api) return response(metadata())
      const u = new URL(String(url)),
        kind = u.pathname.endsWith('/issues') ? 'issues' : 'pulls',
        page = Number(u.searchParams.get('page'))
      const rows = Array.from({ length: 100 }, (_, i) =>
        kind === 'issues'
          ? issue((page - 1) * 100 + i + 1, null)
          : pull((page - 1) * 100 + i + 1),
      )
      return response(rows, page < 10 ? nextLink(kind, page + 1) : undefined)
    },
  )
  expect(await discover(reader)).toMatchObject({
    status: 'ready',
    observation: {
      issues: { pageCount: 10, rowCount: 1000 },
      pulls: { pageCount: 10, rowCount: 1000 },
    },
  })
  expect(calls).toBe(21)
  reader.dispose()
})
it.each(['issues', 'pulls'] as const)(
  'refuses page11 without issuing its request: %s',
  async (kind) => {
    let calls = 0
    const reader = createKnownPRReader(
      { token: 'synthetic-offline' },
      async (url) => {
        calls++
        if (String(url) === api) return response(metadata())
        const u = new URL(String(url))
        if (!u.pathname.endsWith('/' + kind)) return response([])
        return response(
          [],
          nextLink(kind, Number(u.searchParams.get('page')) + 1),
        )
      },
    )
    expect(await discover(reader)).toMatchObject({ reason: 'bounds' })
    expect(calls).toBe(kind === 'issues' ? 11 : 12)
    reader.dispose()
  },
)
it.each([
  ['id zero', { id: 0 }],
  ['id fractional', { id: 1.5 }],
  ['number unsafe', { number: Number.MAX_SAFE_INTEGER + 1 }],
  ['url wrong suffix', { url: api + '/issues/1/extra' }],
  ['html wrong kind', { html_url: htmlIssuePull() }],
  [
    'foreign repository',
    { repository_url: 'https://api.github.com/repos/foreign/repo' },
  ],
  ['state unknown', { state: 'unknown' }],
  ['title absent', { title: undefined }],
  ['body absent', { body: undefined }],
  ['body wrong', { body: 0 }],
  ['timestamp missing', { created_at: undefined }],
  ['timestamp invalid', { created_at: 'not-a-date' }],
  ['null PR discriminator', { pull_request: null }],
  ['malformed PR discriminator', { pull_request: {} }],
  [
    'wrong PR discriminator',
    {
      html_url: htmlIssuePull(),
      pull_request: { url: api + '/pulls/2', html_url: htmlIssuePull() },
    },
  ],
] as [string, Record<string, unknown>][])(
  'validates even nonmatching issue rows: %s',
  async (_name, patch) => {
    const { reader } = transcript([
      response(metadata()),
      response([{ ...issue(1, null), ...patch }]),
    ])
    expect(await discover(reader)).toMatchObject({ reason: 'row_binding' })
    reader.dispose()
  },
)
function htmlIssuePull() {
  return `https://github.com/${repository}/pull/1`
}
it.each([
  ['head deleted', { head: { ref: branch, sha: 'a'.repeat(40), repo: null } }],
  [
    'head foreign',
    {
      head: {
        ref: branch,
        sha: 'a'.repeat(40),
        repo: { id: 123, full_name: 'foreign/repo' },
      },
    },
  ],
  [
    'head id',
    {
      head: {
        ref: branch,
        sha: 'a'.repeat(40),
        repo: { id: 124, full_name: repository },
      },
    },
  ],
  [
    'wrong branch',
    { head: { ref: 'other', sha: 'a'.repeat(40), repo: repo() } },
  ],
  ['head sha', { head: { ref: branch, sha: 'A'.repeat(40), repo: repo() } }],
  ['base deleted', { base: { ref: 'main', sha: 'b'.repeat(40), repo: null } }],
  [
    'base id',
    {
      base: {
        ref: 'main',
        sha: 'b'.repeat(40),
        repo: { id: 124, full_name: repository },
      },
    },
  ],
  [
    'base foreign',
    {
      base: {
        ref: 'main',
        sha: 'b'.repeat(40),
        repo: { id: 123, full_name: 'foreign/repo' },
      },
    },
  ],
  ['base sha', { base: { ref: 'main', sha: 'b'.repeat(39), repo: repo() } }],
  ['base empty', { base: { ref: '', sha: 'b'.repeat(40), repo: repo() } }],
  ['merged missing', { merged_at: undefined }],
  ['merged invalid', { merged_at: 'invalid' }],
  ['merged but open', { merged_at: '2026-01-02T00:00:00Z' }],
  ['draft missing', { draft: undefined }],
  ['draft wrong', { draft: 'false' }],
] as [string, Record<string, unknown>][])(
  'requires every filtered PR binding: %s',
  async (_name, patch) => {
    const { reader } = transcript([
      response(metadata()),
      response([]),
      response([{ ...pull(), ...patch }]),
    ])
    expect(await discover(reader)).toMatchObject({ reason: 'row_binding' })
    reader.dispose()
  },
)
it('preserves draft, closed, merged and alternate-base observations without inferring merge policy', async () => {
  const rows = [
    pull(4),
    { ...pull(2), draft: true },
    { ...pull(3), state: 'closed' },
    {
      ...pull(1),
      state: 'closed',
      merged_at: '2026-01-02T00:00:00Z',
      base: { ...pull(1).base, ref: 'release' },
    },
  ]
  const { reader } = transcript([
    response(metadata()),
    response([]),
    response(rows),
  ])
  expect(await discover(reader)).toMatchObject({
    status: 'ready',
    observation: {
      pulls: {
        rowCount: 4,
        matches: [
          { number: 1, baseRef: 'release', mergedAt: '2026-01-02T00:00:00Z' },
          { number: 2, draft: true },
          { number: 3, state: 'closed', mergedAt: null },
          { number: 4, state: 'open' },
        ],
      },
    },
  })
  reader.dispose()
})
it.each(['issues', 'pulls'] as const)(
  'rejects duplicate ids, numbers and created-order reversal across pages: %s',
  async (kind) => {
    for (const shape of ['id', 'number', 'created']) {
      const a = kind === 'issues' ? issue(1) : pull(1),
        b = { ...(kind === 'issues' ? issue(2) : pull(2)) }
      if (shape === 'id') b.id = a.id
      if (shape === 'number') b.number = a.number
      if (shape === 'created') b.created_at = '2025-01-01T00:00:00Z'
      const pages = [
        response(metadata()),
        ...(kind === 'pulls' ? [response([])] : []),
        response([a], nextLink(kind, 2)),
        response([b]),
      ]
      const { reader } = transcript(pages)
      expect(await discover(reader)).toMatchObject({ reason: 'row_binding' })
      reader.dispose()
    }
  },
)
it('treats null body distinctly and does not conflate issue-list versus PR-list ID domains', async () => {
  const i = {
    ...issue(2, null),
    html_url: `https://github.com/${repository}/pull/2`,
    pull_request: {
      url: api + '/pulls/2',
      html_url: `https://github.com/${repository}/pull/2`,
    },
  }
  const { reader } = transcript([
    response(metadata()),
    response([i]),
    response([{ ...pull(2), body: null }]),
  ])
  expect(await discover(reader)).toMatchObject({
    status: 'ready',
    observation: {
      issues: { pullRowCount: 1, matches: [] },
      pulls: { matches: [{ id: 102, number: 2, body: { kind: 'null' } }] },
    },
  })
  reader.dispose()
})
it('matches exact LF/CRLF lines, retains copied fenced markers and returns only hashes of body/title', async () => {
  const bodies = [
    marker + '\r\n',
    marker + 'x',
    ' ' + marker,
    '> ' + marker,
    '```\n' + marker + '\n```',
    marker + '\r' + marker,
  ]
  const { reader } = transcript([
    response(metadata()),
    response(bodies.map((body, i) => issue(i + 1, body))),
    response([]),
  ])
  const result = await discover(reader)
  expect(result).toMatchObject({
    status: 'ready',
    observation: {
      issues: {
        rowCount: 6,
        matches: [
          { number: 1, markerOccurrences: 1 },
          { number: 5, markerOccurrences: 1 },
        ],
      },
    },
  })
  expect(JSON.stringify(result)).not.toContain('```')
  expect(JSON.stringify(result)).not.toContain('title":')
  reader.dispose()
})
it.each(['id', 'full_name', 'url', 'html_url'])(
  'rejects repository metadata mismatch before list requests: %s',
  async (field) => {
    const { reader, calls } = transcript([
      response({ ...metadata(), [field]: field === 'id' ? 0 : 'foreign' }),
    ])
    expect((await discover(reader)).status).toBe('not_evaluated')
    expect(calls).toHaveLength(1)
    reader.dispose()
  },
)
it.each(['issues', 'pulls'] as const)(
  'enforces row count before scanning and accepts exactly100: %s',
  async (kind) => {
    for (const count of [100, 101]) {
      const rows = Array.from({ length: count }, (_, i) =>
        kind === 'issues' ? issue(i + 1, null) : pull(i + 1),
      )
      const { reader } = transcript([
        response(metadata()),
        ...(kind === 'pulls' ? [response([])] : []),
        response(rows),
        ...(kind === 'issues' ? [response([])] : []),
      ])
      expect(await discover(reader)).toMatchObject(
        count === 100
          ? { status: 'ready' }
          : { status: 'not_evaluated', reason: 'bounds' },
      )
      reader.dispose()
    }
  },
)
it.each(['body', 'title', 'baseRef', 'link'] as const)(
  'checks byte boundary and over-bound before scanning: %s',
  async (kind) => {
    const limit = kind === 'body' ? 65536 : kind === 'link' ? 8192 : 1024
    for (const over of [false, true]) {
      const text = 'x'.repeat(limit + (over ? 1 : 0)),
        row = pull()
      if (kind === 'body') row.body = text
      if (kind === 'title') row.title = text
      if (kind === 'baseRef') row.base.ref = text
      // A legal terminal first relation padded with whitespace to exact header bound.
      const core = `<${query('pulls', 1)}>; rel="first"`
      const link =
        kind === 'link'
          ? core.replace(
              '>;',
              '>' + ' '.repeat(limit - core.length + (over ? 1 : 0)) + ';',
            )
          : undefined
      const { reader } = transcript([
        response(metadata()),
        response([]),
        response([row], link),
      ])
      expect(await discover(reader)).toMatchObject(
        over ? { reason: 'bounds' } : { status: 'ready' },
      )
      reader.dispose()
    }
  },
)
it('enforces UTF-8 body/title/base sizes rather than code-unit-only bounds', async () => {
  for (const key of ['body', 'title', 'base']) {
    const row = pull()
    if (key === 'body') row.body = 'é'.repeat(32769)
    else if (key === 'title') row.title = 'é'.repeat(513)
    else row.base.ref = 'é'.repeat(513)
    const { reader } = transcript([
      response(metadata()),
      response([]),
      response([row]),
    ])
    expect(await discover(reader)).toMatchObject({ reason: 'bounds' })
    reader.dispose()
  }
})
it('retains the original shared deadline through metadata and both list reads', async () => {
  let now = 0,
    calls = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async () => {
      now += 3500
      return response(++calls === 1 ? metadata() : [])
    },
  )
  expect(await discover(reader)).toMatchObject({ reason: 'timeout' })
  expect(calls).toBe(3)
  reader.dispose()
})
it('does not publish a ready result when final envelope encoding reaches the deadline', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const original = JSON.stringify
  vi.spyOn(JSON, 'stringify').mockImplementation(((
    value: unknown,
    ...args: unknown[]
  ) => {
    if (
      value &&
      typeof value === 'object' &&
      'observation' in value &&
      'status' in value
    )
      now = 10000
    return Reflect.apply(original, JSON, [value, ...args])
  }) as typeof JSON.stringify)
  const { reader } = transcript([
    response(metadata()),
    response([]),
    response([]),
  ])
  expect(await discover(reader)).toMatchObject({ reason: 'timeout' })
  reader.dispose()
})
it('uses the shared duplicate-key/depth JSON guard before projecting rows', async () => {
  for (const body of [
    '[{"id":1,"id":2}]',
    '['.repeat(17) + ']'.repeat(17),
    '{}',
  ]) {
    const { reader } = transcript([
      response(metadata()),
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    ])
    expect((await discover(reader)).status).toBe('not_evaluated')
    reader.dispose()
  }
})
it('enforces the consumed aggregate across pages including metadata rather than resetting per response', async () => {
  const MiB = 1024 * 1024,
    padded = '[]' + ' '.repeat(4 * MiB - 2)
  let calls = 0
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async (url) => {
      calls++
      if (String(url) === api) return response(metadata())
      const page = Number(new URL(String(url)).searchParams.get('page'))
      return new Response(padded, {
        headers: {
          'content-type': 'application/json',
          link: nextLink('issues', page + 1),
        },
      })
    },
  )
  expect(await discover(reader)).toMatchObject({ reason: 'bounds' })
  expect(calls).toBe(5)
  reader.dispose()
})
it('accepts exactly the aggregate body budget and refuses one extra consumed byte', async () => {
  for (const extra of [0, 1]) {
    const MiB = 1024 * 1024,
      metaText = JSON.stringify(metadata()),
      sizes = [
        4 * MiB,
        4 * MiB,
        4 * MiB,
        4 * MiB - Buffer.byteLength(metaText) - 2 + extra,
      ]
    let calls = 0
    const reader = createKnownPRReader(
      { token: 'synthetic-offline' },
      async (url) => {
        calls++
        if (String(url) === api) return response(metadata())
        if (new URL(String(url)).pathname.endsWith('/pulls'))
          return response([])
        const page = Number(new URL(String(url)).searchParams.get('page')),
          body = '[]' + ' '.repeat(sizes[page - 1] - 2)
        return new Response(body, {
          headers: {
            'content-type': 'application/json',
            ...(page < 4 ? { link: nextLink('issues', page + 1) } : {}),
          },
        })
      },
    )
    expect(await discover(reader)).toMatchObject(
      extra ? { reason: 'bounds' } : { status: 'ready' },
    )
    expect(calls).toBe(6)
    reader.dispose()
  }
})
it('refuses oversized closed projection without returning any partial candidates', async () => {
  let calls = 0
  const reader = createKnownPRReader(
    { token: 'synthetic-offline' },
    async (url) => {
      calls++
      if (String(url) === api) return response(metadata())
      const u = new URL(String(url))
      if (u.pathname.endsWith('/issues')) return response([])
      const page = Number(u.searchParams.get('page'))
      const rows = Array.from({ length: 100 }, (_, i) => ({
        ...pull((page - 1) * 100 + i + 1),
        base: { ...pull().base, ref: 'x'.repeat(1024) },
      }))
      return response(rows, page < 10 ? nextLink('pulls', page + 1) : undefined)
    },
  )
  expect(await discover(reader)).toEqual({
    status: 'not_evaluated',
    reason: 'bounds',
  })
  expect(calls).toBe(12)
  reader.dispose()
})
it.each([401, 403, 404, 429, 500])(
  'preserves refused versus unavailable HTTP classification at every phase: %s',
  async (status) => {
    for (const phase of [1, 2, 3]) {
      let calls = 0,
        cancelled = 0
      const reader = createKnownPRReader(
        { token: 'synthetic-offline' },
        async () => {
          calls++
          if (calls < phase) return response(calls === 1 ? metadata() : [])
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++
              },
            }),
            { status },
          )
        },
      )
      expect(await discover(reader)).toEqual({
        status: [401, 403].includes(status) ? 'refused' : 'not_evaluated',
        reason: [401, 403].includes(status)
          ? 'provider_refused'
          : status === 404
            ? 'not_found_or_hidden'
            : 'response_status',
        httpStatus: status,
      })
      expect(calls).toBe(phase)
      expect(cancelled).toBe(1)
      reader.dispose()
    }
  },
)
it('reads Link metadata exactly once per list response and does not read it on the default PR path', async () => {
  const pages = [response(metadata()), response([]), response([])],
    reads: number[] = []
  for (const [i, page] of pages.entries()) {
    const get = page.headers.get.bind(page.headers)
    vi.spyOn(page.headers, 'get').mockImplementation((name) => {
      if (name === 'link') reads.push(i)
      return get(name)
    })
  }
  const { reader } = transcript(pages)
  expect(await discover(reader)).toMatchObject({ status: 'ready' })
  expect(reads).toEqual([1, 2])
  reader.dispose()
})
it.each(['next', 'prev', 'first', 'last'] as const)(
  'requires complete fixed query on every relation: %s',
  async (relation) => {
    for (const missing of ['state', 'sort', 'direction', 'per_page', 'page'])
      for (const cursor of [undefined, 'opaque']) {
        const page = relation === 'next' ? 3 : relation === 'last' ? 2 : 1
        const u = new URL(query('issues', page))
        u.searchParams.delete(missing)
        if (cursor !== undefined)
          u.searchParams.set(relation === 'prev' ? 'before' : 'after', cursor)
        const { reader, calls } = transcript([
          response(metadata()),
          response([], nextLink('issues', 2)),
          response([], `<${u}>; rel="${relation}"`),
        ])
        expect(await discover(reader)).toMatchObject({ reason: 'pagination' })
        expect(calls).toHaveLength(3)
        reader.dispose()
      }
  },
)
it('supports a1024-byte next cursor and rejects duplicate decoded keys and a changed PR head filter', async () => {
  const good = query('issues', 2, 'x'.repeat(1024))
  const { reader } = transcript([
    response(metadata()),
    response([], `<${good}>; rel="next"`),
    response([]),
    response([]),
  ])
  expect(await discover(reader)).toMatchObject({ status: 'ready' })
  reader.dispose()
  for (const target of [
    query('issues', 2) + '&pa%67e=2',
    query('issues', 2, 'x') + '&after=y',
  ]) {
    const { reader } = transcript([
      response(metadata()),
      response([], `<${target}>; rel="next"`),
    ])
    expect(await discover(reader)).toMatchObject({ reason: 'pagination' })
    reader.dispose()
  }
  const changed = new URL(query('pulls', 2))
  changed.searchParams.set('head', 'erniesg:other')
  const w = transcript([
    response(metadata()),
    response([]),
    response([], `<${changed}>; rel="next"`),
  ])
  expect(await discover(w.reader)).toMatchObject({ reason: 'pagination' })
  w.reader.dispose()
})
it('refuses response redirection, foreign final URL and declared body lengths without reading them', async () => {
  for (const shape of ['redirected', 'url', 'length']) {
    let cancelled = 0
    const page = new Response(
      new ReadableStream({
        cancel() {
          cancelled++
        },
      }),
      {
        headers: {
          'content-type': 'application/json',
          ...(shape === 'length'
            ? { 'content-length': String(4 * 1024 * 1024 + 1) }
            : {}),
        },
      },
    )
    if (shape === 'redirected')
      Object.defineProperty(page, 'redirected', { value: true })
    if (shape === 'url')
      Object.defineProperty(page, 'url', { value: 'https://example.test/' })
    const { reader, calls } = transcript([response(metadata()), page])
    expect((await discover(reader)).status).toBe('not_evaluated')
    expect(cancelled).toBe(1)
    expect(calls).toHaveLength(2)
    reader.dispose()
  }
})
