import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKnownPRReader } from './known-pr-reader'
import type { PublicSourceReadResult } from './public-source-reader'

const base = 'https://api.github.com/repos/erniesg/erniesg'
const branch = `coordinator/margin-proposal-${'1'.repeat(64)}`,
  sourcePath = 'books/chapters/intro.md'
const parent = 'a'.repeat(40),
  head = 'b'.repeat(40)
const hash = (kind: string, bytes: Buffer) =>
  createHash('sha1')
    .update(`${kind} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')
type Row = { path: string; mode: string; type: string; sha: string }
const treeOID = (rows: Row[]) =>
  hash(
    'tree',
    Buffer.concat(
      [...rows]
        .sort((a, b) =>
          Buffer.compare(
            Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
            Buffer.from(b.path + (b.type === 'tree' ? '/' : '')),
          ),
        )
        .map((r) =>
          Buffer.concat([
            Buffer.from(
              `${r.mode === '040000' ? '40000' : r.mode} ${r.path}\0`,
            ),
            Buffer.from(r.sha, 'hex'),
          ]),
        ),
    ),
  )
function tree(bytes: Buffer, mode = '100644') {
  const blob = {
    path: 'intro.md',
    mode,
    type: 'blob',
    sha: hash('blob', bytes),
  }
  const chapters = {
    path: 'chapters',
    mode: '040000',
    type: 'tree',
    sha: treeOID([blob]),
  }
  const books = {
    path: 'books',
    mode: '040000',
    type: 'tree',
    sha: treeOID([chapters]),
  }
  const empty = {
    path: 'empty',
    mode: '040000',
    type: 'tree',
    sha: treeOID([]),
  }
  return {
    sha: treeOID([books, empty]),
    truncated: false,
    tree: [
      books,
      { ...chapters, path: 'books/chapters' },
      { ...blob, path: sourcePath },
      empty,
    ],
  }
}
function fixture(bytes = Buffer.from('\ufeffnew\r\nlast')) {
  const previous = tree(Buffer.from('old\n')),
    current = tree(bytes)
  const reference = {
    ref: `refs/heads/${branch}`,
    object: { type: 'commit', sha: head },
  }
  const bodies: unknown[] = [
    reference,
    {
      sha: head,
      tree: { sha: current.sha },
      parents: [{ sha: parent }],
      message: 'Margin proposal for intro\n',
    },
    {
      sha: parent,
      tree: { sha: previous.sha },
      parents: [],
      message: 'parent',
    },
    current,
    previous,
    {
      sha: hash('blob', bytes),
      size: bytes.length,
      encoding: 'base64',
      content: bytes.toString('base64') + '\n',
    },
    reference,
  ]
  const urls = [
    base + '/git/ref/heads/' + encodeURIComponent(branch),
    base + '/git/commits/' + head,
    base + '/git/commits/' + parent,
    base + '/git/trees/' + current.sha + '?recursive=1',
    base + '/git/trees/' + previous.sha + '?recursive=1',
    base + '/git/blobs/' + hash('blob', bytes),
    base + '/git/ref/heads/' + encodeURIComponent(branch),
  ]
  const calls: string[] = []
  const reader = createKnownPRReader(
    { token: 'synthetic-source-reader' },
    async (url, init) => {
      calls.push(String(url))
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(init?.credentials).toBe('omit')
      return new Response(JSON.stringify(bodies[calls.length - 1], null, 2), {
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  return { reader, bodies, calls, urls, bytes, previous, current }
}
async function read(
  reader: ReturnType<typeof createKnownPRReader>,
  input: unknown = { branch, sourcePath },
): Promise<PublicSourceReadResult> {
  const method = Reflect.get(reader, 'readPublicSource')
  expect(method).toBeTypeOf('function')
  return method(input)
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('public source reader initial capability', () => {
  it('observes exact immutable trees/blob and equal ref samples in seven GETs', async () => {
    const f = fixture(),
      r = await read(f.reader)
    f.reader.dispose()
    expect(r).toMatchObject({
      status: 'ready',
      observation: {
        repository: 'erniesg/erniesg',
        branch,
        head,
        parent,
        refWitness: 'same-head-at-two-reads',
        source: {
          status: 'regular',
          oid: hash('blob', f.bytes),
          bytes: f.bytes.length,
          sha256: createHash('sha256').update(f.bytes).digest('hex'),
        },
      },
    })
    expect(f.calls).toEqual(f.urls)
  })
  it('refuses a tree whose actual closure differs from its object identity', async () => {
    const f = fixture()
    f.current.tree.pop()
    expect(await read(f.reader)).toMatchObject({
      status: 'not_evaluated',
      reason: 'object_mismatch',
    })
    f.reader.dispose()
  })
  it('does not treat truncated trees as complete', async () => {
    const f = fixture()
    f.current.truncated = true
    expect(await read(f.reader)).toMatchObject({
      status: 'not_evaluated',
      reason: 'tree_incomplete',
    })
    f.reader.dispose()
  })
  it('keeps a hidden or missing branch unavailable rather than absent', async () => {
    const reader = createKnownPRReader(
      { token: 'synthetic-source-reader' },
      async () => new Response('{}', { status: 404 }),
    )
    expect(await read(reader)).toEqual({
      status: 'not_evaluated',
      reason: 'not_found_or_hidden',
      httpStatus: 404,
    })
    reader.dispose()
  })
  it('shares occupied lifetime with known PR reads after ignored abort', async () => {
    vi.useFakeTimers()
    let reject!: (error: Error) => void
    const reader = createKnownPRReader(
      { token: 'synthetic-source-reader' },
      () =>
        new Promise<Response>((_, r) => {
          reject = r
        }),
    )
    expect(Reflect.get(reader, 'readPublicSource')).toBeTypeOf('function')
    const pending = read(reader)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await pending).toMatchObject({
      status: 'not_evaluated',
      reason: 'timeout',
    })
    expect(await reader.readPR({ number: 42 })).toMatchObject({
      reason: 'busy',
    })
    reject(Error('synthetic transport ended'))
    for (let i = 0; i < 30; i++) await Promise.resolve()
    reader.dispose()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
async function tick() {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
function json(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...headers },
  })
}
function scripted(
  bodies: unknown[],
  change?: (stage: number) => Response | Promise<Response> | undefined,
) {
  let calls = 0
  const reader = createKnownPRReader(
    { token: 'synthetic-source-reader' },
    () => {
      const stage = ++calls
      return Promise.resolve(change?.(stage) ?? json(bodies[stage - 1]))
    },
  )
  return { reader, count: () => calls }
}
function replaceHeadTree(
  f: ReturnType<typeof fixture>,
  current: ReturnType<typeof tree>,
) {
  f.bodies[3] = current
  ;(f.bodies[1] as { tree: { sha: string } }).tree.sha = current.sha
}

describe('public source input and closed observation', () => {
  it.each([
    null,
    [],
    {},
    { branch },
    { branch, sourcePath, observed: true },
    { branch: branch + '\n', sourcePath },
    { branch: branch.toUpperCase(), sourcePath },
    { branch: 'refs/heads/' + branch, sourcePath },
    { branch: branch.slice(1), sourcePath },
    { branch, sourcePath: 'books/chapters/../intro.md' },
    { branch, sourcePath: '/' + sourcePath },
    { branch, sourcePath: sourcePath + '\n' },
    { branch, sourcePath: 'books/chapters/%69ntro.md' },
    { branch, sourcePath: 'books/chapters/INTRO.md' },
    { branch, sourcePath: new String(sourcePath) },
    { branch, sourcePath, [Symbol('unknown')]: 1 },
  ])('refuses invalid closed input before dispatch %#', async (input) => {
    const f = scripted([])
    expect(await f.reader.readPublicSource(input)).toEqual({
      status: 'refused',
      reason: 'input',
    })
    expect(f.count()).toBe(0)
  })
  it('copies scalar input before the first transport await and never invokes getters', async () => {
    const f = fixture(),
      d = deferred<Response>(),
      s = scripted(f.bodies, (stage) => (stage === 1 ? d.promise : undefined))
    const input = { branch, sourcePath }
    const pending = s.reader.readPublicSource(input)
    input.branch = 'private-identifier'
    input.sourcePath = 'changed'
    d.resolve(json(f.bodies[0]))
    expect(await pending).toMatchObject({
      status: 'ready',
      observation: { branch, source: { status: 'regular' } },
    })
    const getter = vi.fn(() => branch)
    expect(
      await s.reader.readPublicSource({
        get branch() {
          return getter()
        },
        sourcePath,
      }),
    ).toMatchObject({ status: 'refused', reason: 'input' })
    expect(getter).not.toHaveBeenCalled()
  })
  it('accepts the challenge input grammar and proves absence only in the verified tree', async () => {
    const f = fixture()
    f.bodies.splice(5, 1)
    const s = scripted(f.bodies),
      r = await s.reader.readPublicSource({
        branch,
        sourcePath: 'books/challenges/intro/challenge.md',
      })
    expect(r).toMatchObject({
      status: 'ready',
      observation: {
        source: { status: 'absent' },
        refWitness: 'same-head-at-two-reads',
      },
    })
    expect(s.count()).toBe(6)
  })
  it('retains only the closed projection and never authors/provider URLs/blob bytes', async () => {
    const f = fixture()
    Object.assign(f.bodies[1] as object, {
      author: { email: 'person@example.test' },
      verification: {},
      url: 'https://elsewhere.test/',
    })
    const r = await read(f.reader)
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(Object.keys(r.observation).sort()).toEqual(
      [
        'branch',
        'commitMessage',
        'head',
        'headTree',
        'parent',
        'parentTree',
        'provenance',
        'refWitness',
        'repository',
        'source',
      ].sort(),
    )
    expect(Object.keys(r.observation.headTree.entries[0]).sort()).toEqual([
      'mode',
      'oid',
      'path',
      'type',
    ])
    expect(JSON.stringify(r)).not.toContain('person@example.test')
    expect(JSON.stringify(r)).not.toContain('synthetic-source-reader')
    expect(JSON.stringify(r)).not.toContain(f.bytes.toString('base64'))
  })
})

describe('public immutable object association and closure', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])(
    'rejects wrong object identity at stage %i',
    async (index) => {
      const f = fixture(),
        value = f.bodies[index] as Record<string, unknown>
      if (index === 0 || index === 6)
        f.bodies[index] = { ...value, ref: 'refs/heads/unrelated' }
      else value.sha = 'c'.repeat(40)
      expect(await read(f.reader)).toMatchObject({
        status: 'not_evaluated',
        reason: 'object_mismatch',
      })
      expect(f.calls.length).toBe(index + 1)
    },
  )
  it.each([{ parents: [] }, { parents: [{ sha: parent }, { sha: head }] }])(
    'refuses unsupported head parent topology %j',
    async ({ parents }) => {
      const f = fixture()
      ;(f.bodies[1] as { parents: unknown[] }).parents = parents
      expect(await read(f.reader)).toMatchObject({
        reason: 'unsupported_topology',
      })
      expect(f.calls).toHaveLength(2)
    },
  )
  it('invalidates all earlier data on a final ref change', async () => {
    const f = fixture()
    f.bodies[6] = {
      ref: `refs/heads/${branch}`,
      object: { type: 'commit', sha: parent },
    }
    expect(await read(f.reader)).toEqual({
      status: 'not_evaluated',
      reason: 'ref_changed',
    })
  })
  it.each(['100644', '100755'])(
    'verifies exact binary/BOM/newline bytes for regular mode %s',
    async (mode) => {
      const f = fixture(Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff, 13, 10, 65])),
        current = tree(f.bytes, mode)
      replaceHeadTree(f, current)
      expect(await read(f.reader)).toMatchObject({
        status: 'ready',
        observation: {
          source: {
            mode,
            bytes: 8,
            sha256: createHash('sha256').update(f.bytes).digest('hex'),
          },
        },
      })
    },
  )
  it.each(['120000', '160000', '040000'])(
    'retains unsupported selected mode %s without fetching or following it',
    async (mode) => {
      const leafType =
        mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'
      const leaf: Row = {
        path: 'intro.md',
        mode,
        type: leafType,
        sha: mode === '040000' ? treeOID([]) : parent,
      }
      const dir: Row = {
        path: 'chapters',
        mode: '040000',
        type: 'tree',
        sha: treeOID([leaf]),
      }
      const root: Row = {
        path: 'books',
        mode: '040000',
        type: 'tree',
        sha: treeOID([dir]),
      }
      const current = {
        sha: treeOID([root]),
        truncated: false,
        tree: [
          root,
          { ...dir, path: 'books/chapters' },
          { ...leaf, path: sourcePath },
        ],
      }
      const f = fixture()
      replaceHeadTree(f, current)
      f.bodies.splice(5, 1)
      const s = scripted(f.bodies),
        r = await s.reader.readPublicSource({ branch, sourcePath })
      expect(r).toMatchObject({
        status: 'ready',
        observation: {
          source: {
            status: 'unsupported_type',
            mode,
            type: leafType,
            oid: leaf.sha,
          },
        },
      })
      expect(s.count()).toBe(6)
    },
  )
  it('verifies byte order, tree slash ordering, Unicode and explicit empty trees', async () => {
    const rows: Row[] = [
      { path: 'a', mode: '040000', type: 'tree', sha: treeOID([]) },
      ...['a.c', 'a0', 'é', 'e\u0301', '中'].map((path) => ({
        path,
        mode: '100644',
        type: 'blob',
        sha: parent,
      })),
    ]
    const f = fixture()
    replaceHeadTree(f, {
      sha: treeOID(rows),
      truncated: false,
      tree: [...rows].reverse(),
    })
    f.bodies.splice(5, 1)
    expect(
      await scripted(f.bodies).reader.readPublicSource({ branch, sourcePath }),
    ).toMatchObject({
      status: 'ready',
      observation: { source: { status: 'absent' } },
    })
  })
  const badRows: [string, (rows: Row[]) => void][] = [
    ['duplicate', (rows) => rows.push({ ...rows[0] })],
    ['missing ancestor', (rows) => rows.splice(1, 1)],
    [
      'type mismatch',
      (rows) => {
        rows[2].type = 'tree'
      },
    ],
    [
      'unknown mode',
      (rows) => {
        rows[2].mode = '100664'
      },
    ],
    [
      'ancestor leaf',
      (rows) => {
        rows[0].mode = '100644'
        rows[0].type = 'blob'
      },
    ],
    ...[
      '',
      '/absolute',
      'x/',
      'x//y',
      'x/./y',
      'x/../y',
      'x\\y',
      'x\0y',
      'x\u007fy',
      'x\ud800y',
    ].map(
      (path) =>
        [
          JSON.stringify(path),
          (rows: Row[]) => {
            rows[2].path = path
          },
        ] as [string, (rows: Row[]) => void],
    ),
  ]
  it.each(badRows)('refuses invalid tree closure: %s', async (_, change) => {
    const f = fixture()
    change(f.current.tree)
    expect(await read(f.reader)).toMatchObject({ status: 'not_evaluated' })
    expect(f.calls).toHaveLength(4)
  })
  it.each([3, 4])(
    'checks truncation independently for each tree %i',
    async (i) => {
      const f = fixture()
      ;(f.bodies[i] as { truncated: boolean }).truncated = true
      expect(await read(f.reader)).toMatchObject({ reason: 'tree_incomplete' })
      expect(f.calls).toHaveLength(i + 1)
    },
  )
  it.each([undefined, null, 'false', 0])(
    'requires explicit Boolean nontruncation %s',
    async (truncated) => {
      const f = fixture()
      Object.assign(f.bodies[3] as object, { truncated })
      expect(await read(f.reader)).toMatchObject({ status: 'not_evaluated' })
      expect(f.calls).toHaveLength(4)
    },
  )
  it.each([
    'AA=',
    'A===',
    '!!!!',
    'YQ==junk',
    'YQ== ',
    'YQ==\t',
    'YQ==\r',
    'YR==',
  ])('refuses malformed or noncanonical base64 %j', async (content) => {
    const f = fixture()
    Object.assign(f.bodies[5] as object, { content, size: 1 })
    expect(await read(f.reader)).toMatchObject({ status: 'not_evaluated' })
    expect(f.calls).toHaveLength(6)
  })
  it.each(['size', 'content', 'encoding'])(
    'binds the exact blob %s',
    async (key) => {
      const f = fixture()
      Object.assign(f.bodies[5] as object, {
        [key]: key === 'size' ? 1 : key === 'content' ? 'YQ==' : 'utf-8',
      })
      expect(await read(f.reader)).toMatchObject({ status: 'not_evaluated' })
      expect(f.calls).toHaveLength(6)
    },
  )
  it.each(['\n', '\r\n'])(
    'accepts only API base64 wrapping %j',
    async (wrap) => {
      const f = fixture()
      ;(f.bodies[5] as { content: string }).content =
        f.bytes
          .toString('base64')
          .match(/.{1,4}/g)!
          .join(wrap) + wrap
      expect(await read(f.reader)).toMatchObject({ status: 'ready' })
    },
  )
  it.each([0, 2 * 1024 * 1024])(
    'supports the exact decoded blob bound %i',
    async (size) => {
      const f = fixture(Buffer.alloc(size, 0xa5))
      expect(await read(f.reader)).toMatchObject({
        status: 'ready',
        observation: { source: { bytes: size } },
      })
    },
  )
  it('refuses decoded blob overflow before the final witness', async () => {
    const f = fixture(Buffer.alloc(2 * 1024 * 1024 + 1, 0xa5))
    expect(await read(f.reader)).toMatchObject({ status: 'not_evaluated' })
    expect(f.calls).toHaveLength(6)
  })
})

describe('public source lifetime at every request', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'retains occupancy through ignored abort and late cancellation at stage %i',
    async (stage) => {
      vi.useFakeTimers()
      const f = fixture(),
        late = deferred<Response>(),
        cancel = deferred<void>(),
        cancelled = vi.fn(() => cancel.promise)
      const s = scripted(f.bodies, (n) =>
          n === stage ? late.promise : undefined,
        ),
        pending = s.reader.readPublicSource({ branch, sourcePath })
      await tick()
      expect(s.count()).toBe(stage)
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await pending).toEqual({
        status: 'not_evaluated',
        reason: 'timeout',
      })
      expect(await s.reader.readPR({ number: 42 })).toMatchObject({
        reason: 'busy',
      })
      late.resolve(new Response(new ReadableStream({ cancel: cancelled })))
      await tick()
      expect(cancelled).toHaveBeenCalledTimes(1)
      expect(
        await s.reader.readPublicSource({ branch, sourcePath }),
      ).toMatchObject({ reason: 'busy' })
      cancel.resolve()
      await tick()
      expect(await s.reader.readPublicSource({})).toMatchObject({
        reason: 'input',
      })
      expect(s.count()).toBe(stage)
      s.reader.dispose()
    },
  )
  for (const stage of [1, 2, 3, 4, 5, 6, 7]) {
    it.each([401, 403, 404, 'media'])(
      'awaits refusal-body cancellation for stage ' + stage + ' / %s',
      async (failure) => {
        const f = fixture(),
          cancel = deferred<void>(),
          cancelled = vi.fn(() => cancel.promise)
        const response = new Response(
          new ReadableStream({ cancel: cancelled }),
          {
            status: typeof failure === 'number' ? failure : 200,
            headers: { 'content-type': 'text/plain' },
          },
        )
        const s = scripted(f.bodies, (n) =>
            n === stage ? response : undefined,
          ),
          pending = s.reader.readPublicSource({ branch, sourcePath })
        await tick()
        expect(s.count()).toBe(stage)
        expect(cancelled).toHaveBeenCalledTimes(1)
        expect(await s.reader.readPR({ number: 42 })).toMatchObject({
          reason: 'busy',
        })
        cancel.resolve()
        const r = await pending
        expect(r).toMatchObject({
          status:
            failure === 401 || failure === 403 ? 'refused' : 'not_evaluated',
          reason:
            failure === 'media'
              ? 'response'
              : failure === 404
                ? 'not_found_or_hidden'
                : 'provider_refused',
        })
        expect(s.count()).toBe(stage)
        s.reader.dispose()
      },
    )
  }
  it('uses one absolute deadline rather than resetting for each successful response', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const s = scripted(
      f.bodies,
      (stage) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(json(f.bodies[stage - 1])), 1500),
        ),
    )
    const pending = s.reader.readPublicSource({ branch, sourcePath })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await pending).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
    })
    expect(s.count()).toBe(7)
    expect(await s.reader.readPR({ number: 42 })).toMatchObject({
      reason: 'busy',
    })
    await vi.advanceTimersByTimeAsync(1000)
    await tick()
    expect(await s.reader.readPublicSource({})).toMatchObject({
      reason: 'input',
    })
  })
  it.each([1, 4, 7])(
    'preserves occupancy after a rejected body cancellation at stage %i',
    async (stage) => {
      const f = fixture(),
        s = scripted(f.bodies, (n) =>
          n === stage
            ? new Response(
                new ReadableStream({
                  cancel() {
                    return Promise.reject(
                      Error('synthetic unavailable cleanup'),
                    )
                  },
                }),
                { status: 403 },
              )
            : undefined,
        )
      expect(
        await s.reader.readPublicSource({ branch, sourcePath }),
      ).toMatchObject({ status: 'not_evaluated', reason: 'body' })
      expect(await s.reader.readPR({ number: 42 })).toMatchObject({
        reason: 'busy',
      })
      s.reader.dispose()
    },
  )
})

function paddedJSON(value: unknown, length: number) {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > length) throw Error('synthetic padding bound')
  return body + ' '.repeat(length - Buffer.byteLength(body))
}
describe('public source bounded work and parser', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'rejects duplicate JSON keys at stage %i',
    async (stage) => {
      const f = fixture(),
        value = JSON.stringify(f.bodies[stage - 1]),
        field = stage === 1 || stage === 7 ? 'ref' : 'sha'
      const s = scripted(f.bodies, (n) =>
        n === stage
          ? new Response(`{"${field}":"duplicate",${value.slice(1)}`, {
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
      )
      expect(
        await s.reader.readPublicSource({ branch, sourcePath }),
      ).toMatchObject({ status: 'not_evaluated', reason: 'response' })
      expect(s.count()).toBe(stage)
    },
  )
  it.each([1, 4, 7])(
    'never follows a Link next header at stage %i',
    async (stage) => {
      const f = fixture(),
        s = scripted(f.bodies, (n) =>
          n === stage
            ? json(f.bodies[n - 1], {
                link: '<https://elsewhere.test/page>; rel="next"',
              })
            : undefined,
        )
      expect(
        await s.reader.readPublicSource({ branch, sourcePath }),
      ).toMatchObject({ status: 'not_evaluated' })
      expect(s.count()).toBe(stage)
    },
  )
  it.each([false, true])(
    'bounds actually consumed response bytes independently of declared length / overflow=%s',
    async (overflow) => {
      const f = fixture(),
        cancel = vi.fn(),
        large = paddedJSON(f.bodies[0], 4 * 1024 * 1024 + (overflow ? 1 : 0)),
        encoded = Buffer.from(large)
      const s = scripted(f.bodies, (n) =>
        n === 1
          ? new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(encoded)
                  c.close()
                },
                cancel,
              }),
              {
                headers: {
                  'content-type': 'application/json',
                  'content-length': '1',
                },
              },
            )
          : undefined,
      )
      const r = await s.reader.readPublicSource({ branch, sourcePath })
      expect(r.status).toBe(overflow ? 'not_evaluated' : 'ready')
      expect(s.count()).toBe(overflow ? 1 : 7)
    },
  )
  it.each([false, true])(
    'enforces shared 16 MiB consumed bytes across all responses / overflow=%s',
    async (overflow) => {
      const f = fixture(),
        lengths = f.bodies.map((body) =>
          Buffer.byteLength(JSON.stringify(body)),
        ),
        cap = 4 * 1024 * 1024
      const rest = lengths.slice(4).reduce((a, b) => a + b, 0)
      lengths[0] = cap - rest + (overflow ? 1 : 0)
      lengths[1] = cap
      lengths[2] = cap
      lengths[3] = cap
      const s = scripted(
        f.bodies,
        (n) =>
          new Response(paddedJSON(f.bodies[n - 1], lengths[n - 1]), {
            headers: { 'content-type': 'application/json' },
          }),
      )
      const r = await s.reader.readPublicSource({ branch, sourcePath })
      expect(r.status).toBe(overflow ? 'not_evaluated' : 'ready')
      expect(s.count()).toBe(7)
    },
  )
  it.each([10_000, 10_001])(
    'bounds the complete tree row count %i',
    async (count) => {
      const rows: Row[] = Array.from({ length: count }, (_, i) => ({
        path: `entry-${i}`,
        mode: '100644',
        type: 'blob',
        sha: parent,
      }))
      const f = fixture()
      replaceHeadTree(f, { sha: treeOID(rows), truncated: false, tree: rows })
      f.bodies.splice(5, 1)
      const s = scripted(f.bodies),
        r = await s.reader.readPublicSource({ branch, sourcePath })
      expect(r.status).toBe(count === 10_000 ? 'ready' : 'not_evaluated')
      expect(s.count()).toBe(count === 10_000 ? 6 : 4)
    },
  )
  it.each([1024, 1025])(
    'bounds each complete tree path by UTF8 bytes %i',
    async (size) => {
      const path = 'é'.repeat(Math.floor(size / 2)) + (size % 2 ? 'a' : ''),
        rows: Row[] = [{ path, mode: '100644', type: 'blob', sha: parent }]
      const f = fixture()
      replaceHeadTree(f, { sha: treeOID(rows), truncated: false, tree: rows })
      f.bodies.splice(5, 1)
      expect(
        (
          await scripted(f.bodies).reader.readPublicSource({
            branch,
            sourcePath,
          })
        ).status,
      ).toBe(size === 1024 ? 'ready' : 'not_evaluated')
    },
  )
  it.each([64, 65])('bounds path component depth %i', async (depth) => {
    let row: Row = { path: 'x', mode: '100644', type: 'blob', sha: parent },
      rows: Row[] = [row]
    for (let i = 1; i < depth; i++) {
      const dir: Row = {
        path: 'x',
        mode: '040000',
        type: 'tree',
        sha: treeOID([row]),
      }
      rows = [dir, ...rows.map((r) => ({ ...r, path: 'x/' + r.path }))]
      row = dir
    }
    const f = fixture()
    replaceHeadTree(f, { sha: treeOID([row]), truncated: false, tree: rows })
    f.bodies.splice(5, 1)
    expect(
      (await scripted(f.bodies).reader.readPublicSource({ branch, sourcePath }))
        .status,
    ).toBe(depth === 64 ? 'ready' : 'not_evaluated')
  })
  it.each([32 * 1024, 32 * 1024 + 1])(
    'bounds retained commit message by bytes %i',
    async (size) => {
      const f = fixture()
      ;(f.bodies[1] as { message: string }).message = 'x'.repeat(size)
      expect((await read(f.reader)).status).toBe(
        size === 32 * 1024 ? 'ready' : 'not_evaluated',
      )
    },
  )
  it('counts final parsing/output construction within the same deadline', async () => {
    const f = fixture()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const s = scripted(f.bodies, (n) => {
      if (n === 7) {
        const response = json(f.bodies[6])
        const original = response.body!.getReader.bind(response.body)
        vi.spyOn(response.body!, 'getReader').mockImplementation(
          (...args: unknown[]) => {
            const reader = Reflect.apply(original, response.body, args)
            const read = reader.read.bind(reader)
            reader.read = async () => {
              const value = await read()
              if (value.done) clock = 10_000
              return value
            }
            return reader
          },
        )
        return response
      }
    })
    expect(await s.reader.readPublicSource({ branch, sourcePath })).toEqual({
      status: 'not_evaluated',
      reason: 'timeout',
    })
    expect(s.count()).toBe(7)
  })
})

describe('public source final envelope and owned body work', () => {
  it('rejects an oversized closed output even when each verified input fits its individual cap', async () => {
    const cap = 4 * 1024 * 1024,
      target = cap - 1024
    let rows: Row[] = Array.from({ length: 10000 }, (_, i) => ({
      path: `entry-${String(i).padStart(5, '0')}`,
      mode: '100644',
      type: 'blob',
      sha: parent,
    }))
    const envelope = () => ({ sha: parent, truncated: false, tree: rows })
    const padding = Math.floor(
      (target - Buffer.byteLength(JSON.stringify(envelope()))) / rows.length,
    )
    rows = rows.map((r) => ({ ...r, path: r.path + 'x'.repeat(padding) }))
    let remaining = target - Buffer.byteLength(JSON.stringify(envelope()))
    for (let i = 0; remaining; i++) {
      const n = Math.min(500, remaining)
      rows[i].path += 'x'.repeat(n)
      remaining -= n
    }
    const complete = { sha: treeOID(rows), truncated: false, tree: rows },
      f = fixture()
    replaceHeadTree(f, complete)
    f.bodies[4] = complete
    ;(f.bodies[2] as { tree: { sha: string } }).tree.sha = complete.sha
    ;(f.bodies[1] as { message: string }).message = 'm'.repeat(32 * 1024)
    f.bodies.splice(5, 1)
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThan(cap)
    const s = scripted(f.bodies)
    expect(await s.reader.readPublicSource({ branch, sourcePath })).toEqual({
      status: 'not_evaluated',
      reason: 'bounds',
    })
    expect(s.count()).toBe(6)
  })
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'holds an outstanding body/cancel through timeout at stage %i',
    async (stage) => {
      vi.useFakeTimers()
      const f = fixture(),
        ack = deferred<void>(),
        cancelled = vi.fn(() => ack.promise)
      const body = new ReadableStream<Uint8Array>({ cancel: cancelled })
      const s = scripted(f.bodies, (n) =>
        n === stage
          ? new Response(body, {
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
      )
      const pending = s.reader.readPublicSource({ branch, sourcePath })
      await tick()
      expect(s.count()).toBe(stage)
      await vi.advanceTimersByTimeAsync(10001)
      expect(await pending).toMatchObject({ reason: 'timeout' })
      expect(cancelled).toHaveBeenCalledTimes(1)
      expect(await s.reader.readPR({ number: 42 })).toMatchObject({
        reason: 'busy',
      })
      ack.resolve()
      await tick()
      expect(await s.reader.readPublicSource({})).toMatchObject({
        reason: 'input',
      })
      expect(s.count()).toBe(stage)
    },
  )
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'disposal aborts but still cleans up a late response at stage %i',
    async (stage) => {
      const f = fixture(),
        late = deferred<Response>(),
        cancelled = vi.fn()
      const s = scripted(f.bodies, (n) =>
          n === stage ? late.promise : undefined,
        ),
        pending = s.reader.readPublicSource({ branch, sourcePath })
      await tick()
      s.reader.dispose()
      expect(await pending).toEqual({
        status: 'not_evaluated',
        reason: 'aborted',
      })
      late.resolve(new Response(new ReadableStream({ cancel: cancelled })))
      await tick()
      expect(cancelled).toHaveBeenCalledTimes(1)
      expect(await s.reader.readPR({ number: 42 })).toMatchObject({
        reason: 'closed',
      })
      expect(s.count()).toBe(stage)
    },
  )
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'rejects redirected or unexpected response URL at stage %i',
    async (stage) => {
      const f = fixture(),
        s = scripted(f.bodies, (n) => {
          if (n !== stage) return
          const r = json(f.bodies[n - 1])
          Object.defineProperty(r, 'url', {
            value: 'https://unrelated.example.test/',
          })
          return r
        })
      expect(
        await s.reader.readPublicSource({ branch, sourcePath }),
      ).toMatchObject({ status: 'not_evaluated', reason: 'response' })
      expect(s.count()).toBe(stage)
    },
  )
})
