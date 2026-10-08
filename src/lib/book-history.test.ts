import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
const realExec = vi.mocked(execFileSync).getMockImplementation()!

import * as api from './book-history'

const roots: string[] = []
const SITE = 'https://ernie.sg'
const fixed = [
  'books/tools/manifest.py',
  'books/tools/render.py',
  'src/lib/books.ts',
  'src/lib/book-history.ts',
  'src/consts.ts',
  'src/pages/books/[book]/[node]/history.json.ts',
]
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'private@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Committer',
  GIT_COMMITTER_EMAIL: 'other@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00',
  GIT_TERMINAL_PROMPT: '0',
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}
function write(root: string, name: string, text: string | Buffer) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  writeFileSync(path.join(root, name), text)
}
function commit(root: string, subject: string) {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', subject)
  return git(root, 'rev-parse', 'HEAD')
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'book-history-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const file of fixed) write(root, file, 'fixture input\n')
  write(root, 'books/dsa.toml', 'slug = "test-book"\n')
  write(root, '.gitignore', 'dist/\n')
  write(root, 'books/chapters/old.md', '\ufefffirst\r\n')
  commit(
    root,
    'first subject\n\nMargin-Proposal: private-body-only\nSigned-off-by: email@example.invalid',
  )
  return root
}
function nodes(sourcePath = 'books/chapters/old.md') {
  return [
    {
      book: 'test-book',
      node: 'one',
      path: '/books/test-book/one/',
      sourcePath,
    },
  ]
}
function collect(root: string, ns = nodes(), options = {}) {
  expect(api?.collectBookHistories).toBeTypeOf('function')
  return api.collectBookHistories(root, SITE, () => ns, options)
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(execFileSync).mockImplementation(realExec)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('history producer representative RED pilots', () => {
  it('matches exact log order, subject projection and bytes without email or message bodies', () => {
    const root = fixture()
    write(root, 'books/chapters/old.md', 'second\n')
    commit(root, 'second subject')
    write(root, 'unrelated.txt', 'other')
    commit(root, 'unrelated')
    const [asset] = collect(root)
    expect(asset.buildCommit).toBe(git(root, 'rev-parse', 'HEAD'))
    expect(asset.versions.map((v: any) => v.commit)).toEqual(
      git(
        root,
        'log',
        '--follow',
        '--format=%H',
        'HEAD',
        '--',
        'books/chapters/old.md',
      ).split('\n'),
    )
    for (const v of asset.versions) {
      expect(typeof v.content).toBe('string')
      expect(Buffer.from(v.content!)).toEqual(
        execFileSync('git', ['show', `${v.commit}:${v.path}`], { cwd: root }),
      )
      expect(v.message).toBe(git(root, 'log', '-1', '--format=%s', v.commit))
      expect(v.author).toBe('Fixture Author')
    }
    expect(JSON.stringify(asset)).not.toMatch(/private-body-only|@example/)
    expect(collect(root)).toEqual([asset])
  })
  it('follows rename, deletion and restoration, retaining a null-content tombstone', () => {
    const root = fixture()
    git(root, 'mv', 'books/chapters/old.md', 'books/chapters/new.md')
    commit(root, 'rename')
    write(root, 'books/chapters/new.md', 'modified\n')
    commit(root, 'modify')
    rmSync(path.join(root, 'books/chapters/new.md'))
    const deleted = commit(root, 'delete')
    write(root, 'books/chapters/new.md', 'restored\n')
    commit(root, 'restore')
    write(root, 'books/chapters/new.md', 'latest\n')
    commit(root, 'latest')
    const [asset] = collect(root, nodes('books/chapters/new.md'))
    expect(asset.versions.map((v: any) => v.commit)).toEqual(
      git(
        root,
        'log',
        '--follow',
        '--format=%H',
        'HEAD',
        '--',
        'books/chapters/new.md',
      ).split('\n'),
    )
    expect(asset.versions.find((v: any) => v.commit === deleted)).toMatchObject(
      { deleted: true, content: null, change: 'D' },
    )
    expect(asset.versions.at(-1)!.path).toBe('books/chapters/old.md')
  })
  it('refuses dirty, shallow and partial inputs instead of emitting partial assets', () => {
    const root = fixture()
    collect(root)
    write(root, 'books/chapters/old.md', 'dirty')
    expect(() => collect(root)).toThrow(/dirty|differ|input/i)
    git(root, 'checkout', '--', 'books/chapters/old.md')
    git(root, 'config', 'remote.origin.promisor', 'true')
    expect(() => collect(root)).toThrow(/partial|promisor/i)
    git(root, 'config', '--unset', 'remote.origin.promisor')
    writeFileSync(
      path.join(root, '.git/shallow'),
      git(root, 'rev-parse', 'HEAD') + '\n',
    )
    expect(() => collect(root)).toThrow(/shallow/i)
  })
  it('fails an explicit resource limit without an empty or truncated success', () => {
    const root = fixture()
    expect(() => collect(root, nodes(), { limits: { blobBytes: 3 } })).toThrow(
      /bound|limit|bytes/i,
    )
    expect(() => collect(root, nodes(), { limits: { assetBytes: 3 } })).toThrow(
      /bound|limit|bytes/i,
    )
  })
  it('uses default merge traversal, binds exact locations, and rejects stale callback inputs', () => {
    const root = fixture()
    git(root, 'checkout', '-q', '-b', 'side')
    write(root, 'books/chapters/old.md', 'side\n')
    commit(root, 'side')
    git(root, 'checkout', '-q', 'main')
    write(root, 'unrelated.txt', 'main')
    commit(root, 'main')
    git(root, 'merge', '-q', '--no-ff', 'side', '-m', 'merge')
    const ns = [
        ...nodes(),
        { ...nodes()[0], book: 'another', path: '/books/another/one/' },
      ],
      assets = collect(root, ns)
    expect(assets).toHaveLength(2)
    expect(assets[0].versions).toEqual(assets[1].versions)
    expect(assets[1].document).toBe(SITE + '/books/another/one/')
    expect(assets[0].versions.map((v: any) => v.commit)).toEqual(
      git(
        root,
        'log',
        '--follow',
        '--format=%H',
        'HEAD',
        '--',
        'books/chapters/old.md',
      ).split('\n'),
    )
    expect(() =>
      collect(root, [{ ...nodes()[0], path: '/unrelated/' }]),
    ).toThrow(/mapping|path|locator/i)
    expect(() =>
      api.collectBookHistories(root, SITE, () => {
        write(root, 'books/dsa.toml', 'changed')
        return nodes()
      }),
    ).toThrow(/dirty|differ|changed|input/i)
  })
})

describe('strict complete history invariant sweep', () => {
  it('never requests content for deletion commits', () => {
    const root = fixture()
    rmSync(path.join(root, 'books/chapters/old.md'))
    const deleted = commit(root, 'delete')
    write(root, 'books/chapters/old.md', 'restored')
    commit(root, 'restore')
    collect(root)
    expect(
      vi
        .mocked(execFileSync)
        .mock.calls.filter(
          ([command, args]) =>
            command === 'git' &&
            Array.isArray(args) &&
            args.includes('show') &&
            args.includes(`${deleted}:books/chapters/old.md`),
        ),
    ).toEqual([])
  })
  it('allows ignored generated output and unrelated dirty work, but not staged source changes', () => {
    const root = fixture()
    write(root, 'unrelated.txt', 'old')
    commit(root, 'unrelated')
    write(root, 'unrelated.txt', 'dirty')
    write(root, 'dist/output.json', 'generated')
    collect(root)
    write(root, 'books/chapters/old.md', 'staged')
    git(root, 'add', 'books/chapters/old.md')
    expect(() => collect(root)).toThrow(/staged|differ|dirty/)
  })
  it.each([
    'books/new.toml',
    'books/chapters/unselected.md',
    'books/challenges/unselected/challenge.md',
    'books/tools/extra.py',
  ])('binds full mapping and node-pool membership at%s', (name) => {
    const root = fixture()
    expect(() =>
      api.collectBookHistories(root, SITE, () => {
        write(root, name, 'new input')
        return nodes()
      }),
    ).toThrow(/membership|input|changed/)
  })
  it('refuses missing historical objects without lazy fetch', () => {
    const root = fixture(),
      old = git(root, 'rev-parse', 'HEAD:books/chapters/old.md')
    write(root, 'books/chapters/old.md', 'latest')
    commit(root, 'latest')
    rmSync(path.join(root, '.git/objects', old.slice(0, 2), old.slice(2)))
    expect(() => collect(root)).toThrow(/Git|blob/)
    const options: any = vi
      .mocked(execFileSync)
      .mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === '--no-replace-objects',
      )
      .at(-1)![2]
    expect(options.env.GIT_NO_LAZY_FETCH).toBe('1')
    expect(options.env.GIT_ALLOW_PROTOCOL).toBe('')
  })
  it('refuses promisor packs and graft metadata even without a promisor remote', () => {
    const root = fixture()
    write(root, '.git/objects/pack/fixture.promisor', '')
    expect(() => collect(root)).toThrow(/promisor/)
    rmSync(path.join(root, '.git/objects/pack/fixture.promisor'))
    write(root, '.git/info/grafts', '')
    expect(() => collect(root)).toThrow(/graft/)
  })
  it('refuses invalid UTF8 in old content and symlink source inputs', () => {
    const root = fixture()
    write(root, 'books/chapters/old.md', Buffer.from([255]))
    commit(root, 'non UTF8')
    write(root, 'books/chapters/old.md', 'valid now')
    commit(root, 'valid now')
    expect(() => collect(root)).toThrow(/UTF8/)
    rmSync(path.join(root, 'books/chapters/old.md'))
    symlinkSync('other.md', path.join(root, 'books/chapters/old.md'))
    expect(() => collect(root)).toThrow(/symlink/)
  })
  it('neutralizes inherited Git repository and configuration environment', () => {
    const root = fixture()
    vi.stubEnv('GIT_DIR', '/not/a/repository')
    vi.stubEnv('GIT_WORK_TREE', '/not/a/worktree')
    vi.stubEnv('GIT_INDEX_FILE', '/not/an/index')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree')
    vi.stubEnv('GIT_CONFIG_VALUE_0', '/not/a/worktree')
    expect(collect(root)[0].versions).toHaveLength(1)
  })
  it('checks expected HEAD and detects even unrelated commits during mapping', () => {
    const root = fixture()
    expect(() =>
      collect(root, nodes(), { expectedHead: '0'.repeat(40) }),
    ).toThrow(/HEAD/)
    expect(() =>
      api.collectBookHistories(root, SITE, () => {
        write(root, 'unrelated.txt', 'new')
        commit(root, 'new HEAD')
        return nodes()
      }),
    ).toThrow(/HEAD|changed/)
  })
  it('enforces exact version and serialization boundaries without truncation', () => {
    const root = fixture(),
      initial = collect(root),
      size = Buffer.byteLength(api.serializeBookHistory(initial[0]))
    expect(
      collect(root, nodes(), { limits: { versions: 1, assetBytes: size } }),
    ).toEqual(initial)
    expect(() =>
      collect(root, nodes(), { limits: { assetBytes: size - 1 } }),
    ).toThrow(/asset bytes/)
    write(root, 'books/chapters/old.md', 'next')
    commit(root, 'next')
    expect(() => collect(root, nodes(), { limits: { versions: 1 } })).toThrow(
      /version count/,
    )
    expect(() => collect(root, nodes(), { limits: { nodeBytes: 1 } })).toThrow(
      /node content bytes/,
    )
    expect(() =>
      collect(root, nodes(), { limits: { commandBytes: 8 } }),
    ).toThrow(/resource bound/)
  })
  it('counts aliases in total serialized bytes and refuses duplicate locators', () => {
    const root = fixture(),
      first = collect(root)[0],
      size = Buffer.byteLength(api.serializeBookHistory(first)),
      aliases = [
        ...nodes(),
        { ...nodes()[0], book: 'second', path: '/books/second/one/' },
      ]
    expect(() =>
      collect(root, aliases, { limits: { assetBytes: size } }),
    ).toThrow(/asset bytes/)
    expect(() => collect(root, [...nodes(), ...nodes()])).toThrow(/duplicate/)
  })
  it('refuses unsupported status or incomplete command output instead of guessing paths', () => {
    const root = fixture()
    for (const change of ['Q', 'R099']) {
      vi.mocked(execFileSync).mockImplementation(((
        command: any,
        args: any,
        options: any,
      ) => {
        const value: any = (realExec as any)(command, args, options)
        return command === 'git' &&
          args.includes('--follow') &&
          args.includes('--name-status')
          ? Buffer.from(value.toString().replace('\nA\0', `\n${change}\0`))
          : value
      }) as any)
      expect(() => collect(root)).toThrow(/unsupported|malformed/)
    }
  })
  it('refuses every Object.prototype name as an undeclared resource limit', () => {
    const root = fixture()
    vi.mocked(execFileSync).mockClear()
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
      const limits = JSON.parse(JSON.stringify({ [key]: 1 }))
      expect(() => api.collectBookHistories(root, SITE, () => nodes(), { limits }), key)
        .toThrow(/invalid history resource limit/)
    }
    expect(execFileSync).not.toHaveBeenCalled()
  })
  it('uses monotonic collection time even when wall time moves backwards', () => {
    const root = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(0)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    expect(() =>
      api.collectBookHistories(root, SITE, (remaining: number) => {
        expect(remaining).toBeGreaterThan(0)
        vi.mocked(Date.now).mockReturnValue(-120_001)
        clock.mockReturnValue(121_001)
        return nodes()
      }),
    ).toThrow(/time bound/)
  })
  it('keeps a resolution-merge HEAD distinct from the default followed history', () => {
    const root = fixture()
    git(root, 'checkout', '-q', '-b', 'side')
    write(root, 'books/chapters/old.md', 'side')
    commit(root, 'side')
    git(root, 'checkout', '-q', 'main')
    write(root, 'books/chapters/old.md', 'main')
    commit(root, 'main')
    try {
      git(root, 'merge', '--no-ff', 'side', '-m', 'merge')
    } catch {
      /* deterministic owned-fixture conflict */
    }
    write(root, 'books/chapters/old.md', 'resolution')
    commit(root, 'resolution merge')
    const [asset] = collect(root)
    expect(asset.buildCommit).toBe(git(root, 'rev-parse', 'HEAD'))
    expect(asset.versions.map((v: any) => v.commit)).toEqual(
      git(
        root,
        'log',
        '--follow',
        '--format=%H',
        'HEAD',
        '--',
        'books/chapters/old.md',
      ).split('\n'),
    )
    expect(asset.versions[0].content).not.toBe('resolution')
  })
  it('generates route props only after a complete collection and never reads Git in GET', async () => {
    const asset = collect(fixture())[0],
      produce = vi.fn(() => [asset])
    vi.doMock('./books', () => ({ bookHistoryAssets: produce }))
    try {
      const route = await import('../pages/books/[book]/[node]/history.json')
      expect(route.prerender).toBe(true)
      const paths = route.getStaticPaths()
      expect(paths[0].params).toEqual({ book: 'test-book', node: 'one' })
      const calls = vi.mocked(execFileSync).mock.calls.length
      const response = route.GET({ props: paths[0].props })
      expect(await response.json()).toEqual(asset)
      expect(vi.mocked(execFileSync).mock.calls.length).toBe(calls)
      expect(produce).toHaveBeenCalledTimes(1)
      produce.mockImplementation(() => {
        throw new Error('incomplete collection')
      })
      expect(() => route.getStaticPaths()).toThrow(/incomplete/)
    } finally {
      vi.doUnmock('./books')
    }
  })
})

it('requires string mapping fields rather than coercing malformed manifest IDs', () => {
  const root = fixture()
  expect(() =>
    collect(root, [
      {
        ...nodes()[0],
        book: 123 as any,
        node: 456 as any,
        path: '/books/123/456/',
      },
    ]),
  ).toThrow(/mapping/)
})
it('freshly renders mapping inside its witness instead of reusing the ordinary page cache', async () => {
  vi.resetModules()
  const root = fixture()
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  let current = {
    books: [
      {
        slug: 'test-book',
        nodes: [
          {
            id: 'old',
            path: '/books/test-book/old/',
            sourcePath: 'books/chapters/old.md',
          },
        ],
      },
    ],
  }
  const renders: any[] = []
  vi.mocked(execFileSync).mockImplementation(((
    command: any,
    args: any,
    options: any,
  ) => {
    if (
      Array.isArray(args) &&
      args[0] === path.join(root, 'books/tools/manifest.py')
    ) {
      renders.push(options)
      return JSON.stringify(current)
    }
    return (realExec as any)(command, args, options)
  }) as any)
  const books = await import('./books')
  expect(books.bookManifest().books[0].nodes[0].id).toBe('old')
  current = {
    books: [
      {
        slug: 'test-book',
        nodes: [
          {
            id: 'one',
            path: '/books/test-book/one/',
            sourcePath: 'books/chapters/old.md',
          },
        ],
      },
    ],
  }
  write(root, 'books/dsa.toml', 'slug = "test-book"\n# current mapping\n')
  const head = commit(root, 'new mapping')
  const assets = books.bookHistoryAssets()
  expect(assets[0].node).toBe('one')
  expect(assets[0].buildCommit).toBe(head)
  expect(renders).toHaveLength(2)
  expect(renders[1].timeout).toBeGreaterThan(0)
  expect(renders[1].timeout).toBeLessThanOrEqual(120000)
  expect(renders[1].maxBuffer).toBe(32 * 1024 * 1024)
})
