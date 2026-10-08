import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
const realExec = vi.mocked(execFileSync).getMockImplementation()!
import * as api from './book-history'

const roots: string[] = []
const SITE = 'https://ernie.sg'
const SOURCE = 'books/chapters/one.md'
const nodes = () => [{ book: 'test', node: 'one', path: '/books/test/one/', sourcePath: SOURCE }]
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
function git(root: string, ...args: string[]) { return realExec('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trimEnd() }
function write(root: string, name: string, value: string) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), value) }
function commit(root: string, title: string) { git(root, 'add', '-A'); git(root, 'commit', '-qm', title); return git(root, 'rev-parse', 'HEAD') }
function fixture(format = 'sha1') {
  const root = mkdtempSync(path.join(tmpdir(), 'exact-book-base-')); roots.push(root)
  git(root, 'init', '-q', '-b', 'main', `--object-format=${format}`)
  for (const file of ['books/tools/manifest.py', 'books/tools/render.py', 'src/lib/books.ts', 'src/lib/book-history.ts', 'src/consts.ts', 'src/pages/books/[book]/[node]/history.json.ts']) write(root, file, 'fixture input\n')
  write(root, 'books/test.toml', 'slug = "test"\n'); write(root, SOURCE, '\ufeffsource\r\n')
  const first = commit(root, 'source created'); write(root, 'unrelated.txt', 'unrelated\n'); const base = commit(root, 'unchanged source')
  return { root, first, base, head: base }
}
function exact(root: string, head: string, base: string, visitor: (nodes: any, snapshot: any) => any, extra = {}, load = nodes) {
  const fn = (api as any).withExactBookBaseSnapshot
  expect(fn, 'new exact-base capability is not implemented yet').toBeTypeOf('function')
  return fn(root, SITE, load, { expectedHead: head, baseCommit: base, ...extra }, visitor)
}
function bytes(_nodes: any, snapshot: any) {
  const tree = snapshot.tree(); const entry = tree.entries.get(SOURCE)
  expect(tree.occupied.has(SOURCE)).toBe(true)
  return snapshot.blobs([entry.oid]).get(entry.oid)
}
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockImplementation(realExec); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('exact-base visitor first RED families', () => {
  it('reads unchanged and merge bases without manufacturing raw history versions', () => {
    const { root, base } = fixture()
    git(root, 'checkout', '-qb', 'side'); write(root, 'side.txt', 'side'); commit(root, 'side only')
    git(root, 'checkout', '-q', 'main'); write(root, 'main.txt', 'main'); commit(root, 'main only'); git(root, 'merge', '--no-ff', '-qm', 'merge without source change', 'side')
    const head = git(root, 'rev-parse', 'HEAD'); const raw = api.collectBookHistories(root, SITE, nodes)
    expect(raw[0].versions.map(v => v.commit)).not.toContain(base)
    expect(raw[0].versions.map(v => v.commit)).not.toContain(head)
    for (const selected of [base, head]) expect(exact(root, head, selected, bytes)).toEqual(Buffer.from('\ufeffsource\r\n'))
    expect(api.collectBookHistories(root, SITE, nodes)).toEqual(raw)
  })
  it('requires a full existing ancestor commit in the repository object algorithm', () => {
    for (const format of ['sha1', 'sha256']) {
      const { root, head, first } = fixture(format)
      expect(exact(root, head, first, bytes)).toEqual(Buffer.from('\ufeffsource\r\n'))
      git(root, 'checkout', '-qb', 'other', first); write(root, 'branch.txt', 'other'); const other = commit(root, 'not ancestor'); git(root, 'checkout', '-q', 'main')
      for (const bad of [first.slice(0, 12), first.toUpperCase(), '0'.repeat(first.length), '1'.repeat(first.length === 40 ? 64 : 40), other]) expect(() => exact(root, head, bad, bytes)).toThrow(api.BookHistoryError)
    }
  })
  it('expires retained methods and confines blobs, rejecting asynchronous visitors', () => {
    const { root, head } = fixture(); let retained: any
    exact(root, head, head, (mapping, snapshot) => { retained = snapshot; expect(mapping).toEqual(nodes()); expect(() => snapshot.blobs(['0'.repeat(head.length)])).toThrow(api.BookHistoryError); return bytes(mapping, snapshot) })
    for (const use of [() => retained.head, () => retained.baseCommit, () => retained.remaining(), () => retained.tree(), () => retained.blobs([])]) expect(use).toThrow(api.BookHistoryError)
    expect(() => exact(root, head, head, async () => 'late')).toThrow(api.BookHistoryError)
  })
  it('binds source, mapping membership, index, config and HEAD before and after the visitor', () => {
    const baseline = fixture(); expect(exact(baseline.root, baseline.head, baseline.base, bytes)).toEqual(Buffer.from('\ufeffsource\r\n'))
    for (const mutation of ['source', 'node-pool', 'index', 'config', 'head']) {
      const { root, head } = fixture()
      expect(() => exact(root, head, head, (mapping, snapshot) => {
        const result = bytes(mapping, snapshot)
        if (mutation === 'source') write(root, SOURCE, 'dirty')
        if (mutation === 'node-pool') write(root, 'books/chapters/extra.md', 'new node')
        if (mutation === 'index') git(root, 'update-index', '--force-remove', SOURCE)
        if (mutation === 'config') git(root, 'config', 'fixture.changed', 'true')
        if (mutation === 'head') { write(root, 'unrelated.txt', 'new head'); commit(root, 'head drift') }
        return result
      })).toThrow(api.BookHistoryError)
    }
    const { root, head } = fixture(); write(root, SOURCE, 'initial dirt'); expect(() => exact(root, head, head, bytes)).toThrow(api.BookHistoryError)
  })
  it('keeps one finite deadline and Git budget through final witness validation', () => {
    const { root, head } = fixture()
    expect(exact(root, head, head, bytes)).toEqual(Buffer.from('\ufeffsource\r\n'))
    expect(() => exact(root, head, head, bytes, { gitCalls: 1 })).toThrow(api.BookHistoryError)
    for (const bad of [0, -1, 1.5, 4097, Infinity]) expect(() => exact(root, head, head, bytes, { gitCalls: bad })).toThrow(api.BookHistoryError)
    const clock = vi.spyOn(performance, 'now'); let late = false; clock.mockImplementation(() => late ? 120_001 : 0)
    expect(() => exact(root, head, head, () => { late = true; return 'must not escape after deadline' })).toThrow(api.BookHistoryError)
    clock.mockRestore()
    expect(readFileSync(path.join(root, SOURCE), 'utf8')).toBe('\ufeffsource\r\n')
  })
})


describe('exact-base behavioral closure', () => {
  it('expires capability on a thrown callback as well as thenable return', () => {
    const { root, head } = fixture(); let snapshot: any
    for (const ending of ['throw', 'thenable']) {
      expect(() => exact(root, head, head, (_nodes, value) => {
        snapshot = value
        if (ending === 'throw') throw Error('fixture throw')
        return { then() {} }
      })).toThrow(api.BookHistoryError)
      expect(() => snapshot.tree()).toThrow(/expired/)
    }
  })
  it('passes detached frozen mapping copies and checks all locator shapes', () => {
    const { root, head } = fixture(); const original = nodes()
    exact(root, head, head, (mapped, snapshot) => {
      expect(mapped).not.toBe(original); expect(mapped[0]).not.toBe(original[0])
      expect(Object.isFrozen(mapped)).toBe(true); expect(Object.isFrozen(mapped[0])).toBe(true)
      original[0].sourcePath = 'books/chapters/foreign.md'
      expect(mapped[0].sourcePath).toBe(SOURCE); return bytes(mapped, snapshot)
    }, {}, () => original)
    for (const mapping of [[], [...nodes(), ...nodes()], [{ ...nodes()[0], path: '/books/other/one/' }], [{ ...nodes()[0], sourcePath: '../outside.md' }], [{ ...nodes()[0], sourcePath: 'books/chapters/missing.md' }]])
      expect(() => exact(root, head, head, bytes, {}, () => mapping)).toThrow(api.BookHistoryError)
    expect(() => exact(root, head, head, bytes, {}, (() => Promise.resolve(nodes())) as any)).toThrow(api.BookHistoryError)
    for (const limits of [{ constructor: 1 }, { collectionMs: 0 }, { nodeBytes: 1 }]) expect(() => exact(root, head, head, bytes, { limits })).toThrow(api.BookHistoryError)
  })
  it('refuses initial and callback-time covered source or index changes', () => {
    for (const when of ['initial', 'mapping']) for (const kind of ['source', 'index']) {
      const { root, head } = fixture()
      const mutate = () => { if (kind === 'source') write(root, SOURCE, 'drift'); else git(root, 'update-index', '--force-remove', SOURCE) }
      if (when === 'initial') mutate()
      expect(() => exact(root, head, head, bytes, {}, () => { if (when === 'mapping') mutate(); return nodes() })).toThrow(api.BookHistoryError)
    }
  })
  it('refuses incomplete repositories and binds selection config through the whole interval', () => {
    for (const condition of ['filter', 'promisor', 'shallow', 'config-drift']) {
      const { root, head } = fixture()
      if (condition === 'filter') git(root, 'config', 'remote.origin.partialclonefilter', 'blob:none')
      if (condition === 'promisor') write(root, '.git/objects/pack/fixture.promisor', '')
      if (condition === 'shallow') write(root, '.git/shallow', head + '\n')
      expect(() => exact(root, head, head, bytes, {}, () => {
        if (condition === 'config-drift') git(root, 'config', 'fixture.change', 'yes')
        return nodes()
      })).toThrow(api.BookHistoryError)
    }
  })
  it('includes final witness commands in one budget and keeps async mapping unavailable', () => {
    const { root, head } = fixture(); vi.mocked(execFileSync).mockClear()
    exact(root, head, head, bytes); const total = vi.mocked(execFileSync).mock.calls.length
    expect(total).toBeGreaterThan(20)
    let visited = false
    expect(() => exact(root, head, head, (mapping, snapshot) => { visited = true; return bytes(mapping, snapshot) }, { gitCalls: total - 1 })).toThrow(/Git call bound/)
    expect(visited).toBe(true)
    expect(exact(root, head, head, bytes, { gitCalls: total })).toEqual(Buffer.from('\ufeffsource\r\n'))
  })
  it('charges mapping work to the same deadline before visitor entry', () => {
    const { root, head } = fixture(); let late = false; let visited = false
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => late ? 120_001 : 0)
    expect(() => exact(root, head, head, () => { visited = true }, {}, () => { late = true; return nodes() })).toThrow(/time bound/)
    expect(visited).toBe(false); clock.mockRestore()
  })
  it('rejects a tag object instead of silently peeling it to a permitted commit', () => {
    const { root, head } = fixture(); git(root, 'tag', '-am', 'tag object', 'annotated')
    expect(() => exact(root, head, git(root, 'rev-parse', 'annotated'), bytes)).toThrow(/selected commit/)
  })
})


it('accounts for the real-sized 78-input witness with a reachable bounded default', () => {
  const { root } = fixture()
  for (let index = 0; index < 70; index++) write(root, `books/tools/fixture_${index}.py`, '# inert mapping input\n')
  const head = commit(root, '78 covered inputs')
  vi.mocked(execFileSync).mockClear()
  expect(exact(root, head, head, bytes)).toEqual(Buffer.from('\ufeffsource\r\n'))
  const actualCalls = vi.mocked(execFileSync).mock.calls.length
  // 78 files x size/content reads x two witnesses, plus 24 fixed calls.
  expect(actualCalls).toBe(336)
  let visited = false
  expect(() => exact(root, head, head, (mapping, snapshot) => {
    visited = true; return bytes(mapping, snapshot)
  }, { gitCalls: 256 })).toThrow(/Git call bound/)
  expect(visited).toBe(true)
}, 15_000)
