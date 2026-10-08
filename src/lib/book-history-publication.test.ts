import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeBookHistory } from './book-history'
import { scopeContentCss, withHistoryPublicationWitness, renderedBookHistoryAssets, bookManifest, bookHistoryAssets } from './books'

async function api() {
  const url = new URL('./book-history-publication.ts', import.meta.url)
  const module = existsSync(url) ? await import(/* @vite-ignore */ url.href) : {}
  expect(module.publishRenderedHistory).toBeTypeOf('function')
  return module as { publishRenderedHistory: (...args: any[]) => any }
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
function fixture() {
  const commit = '1'.repeat(40), gone = '2'.repeat(40), head = '3'.repeat(40), source = 'books/chapters/one.md'
  const raw = { schemaVersion: 1 as const, site: 'https://example.invalid', document: 'https://example.invalid/books/book/one/', book: 'book', node: 'one', buildCommit: head, sourcePath: source, versions: [
    { commit, author: 'Public fixture', date: '2026-01-01T00:00:00+00:00', message: 'restored', path: source, change: 'A', deleted: false, content: 'Source' },
    { commit: gone, author: 'Public fixture', date: '2026-01-01T00:00:00+00:00', message: 'deleted', path: source, change: 'D', deleted: true, content: null },
  ] }
  const render = { schemaVersion: 1, profile: 'node-content-readonly-v1', sourcePath: source, sourceSha256: sha('Source'), html: '<p>Source</p>', blocks: [], reads: [{ path: source, mode: '100644', sha256: sha('Source') }], optionalAbsences: [] }
  const bundle = { schemaVersion: 1, site: raw.site, buildCommit: head, rendererProfile: render.profile, rendererFingerprint: '4'.repeat(64), rawAssets: [raw], documents: [{ document: raw.document, rawHistorySha256: sha(serializeBookHistory(raw)), versions: [
    { commit, deleted: false, treeOID: '5'.repeat(40), sourcePath: source, sourceOID: '6'.repeat(40), sourceSha256: sha('Source'), dependencies: [{ ...render.reads[0], oid: '6'.repeat(40) }], optionalAbsences: [], render, renderSha256: '7'.repeat(64) },
    { commit: gone, sourcePath: source, deleted: true, render: null },
  ] }] }
  const content = ':root { --ink:#111; } p { color:var(--ink); }'
  return { bundle, css: { content, scoped: scopeContentCss(content, '.history-content') }, fingerprint: '8'.repeat(64) }
}
it('publishes deterministic closed sidecars while preserving raw order and tombstones', async () => {
  const { publishRenderedHistory } = await api(), f = fixture()
  const entries = publishRenderedHistory(f.bundle, f.css, f.fingerprint)
  expect(entries).toHaveLength(2)
  const index = JSON.parse(entries.find((r: any) => r.asset === 'index').json)
  expect(index.kind).toBe('rendered-history-index')
  expect(index.versions.map((v: any) => v.deleted)).toEqual([false, true])
  expect(index.versions[1]).toEqual({ commit: '2'.repeat(40), deleted: true })
  expect(entries).toEqual(publishRenderedHistory(f.bundle, f.css, f.fingerprint))
  f.bundle.documents[0].rawHistorySha256 = '0'.repeat(64)
  expect(() => publishRenderedHistory(f.bundle, f.css, f.fingerprint)).toThrow()
})
it('provides a pre-execution/final whole-publication witness rather than post-hoc labels', async () => {
  const books = await import('./books')
  expect((books as any).withHistoryPublicationWitness).toBeTypeOf('function')
})

const roots: string[] = [], ROOT = fileURLToPath(new URL('../../', import.meta.url))
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00' }
function git(root: string, ...args: string[]) { return execFileSync('/usr/bin/git', args, { cwd: root, env, timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() }
function put(root: string, name: string, data: string | Buffer) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), data) }
function repository() {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-witness-')); roots.push(root); git(root, 'init', '-q', '-b', 'main')
  for (const name of [
    'src/lib/book-history-safe-html.ts', 'src/lib/book-history-publication.ts', 'src/lib/books.ts', 'src/lib/book-history.ts', 'src/lib/book-history-rendered.ts', 'src/lib/margin-history-data.ts', 'src/consts.ts',
    'src/pages/books/[book]/[node]/history.json.ts', 'src/pages/books/[book]/[node]/history-rendered/[asset].json.ts',
    'adapters/margin/local-source.ts', 'adapters/margin/source-plan.ts', 'src/annotations/criticmarkup.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'astro.config.ts',
  ]) put(root, name, readFileSync(path.join(ROOT, name)))
  put(root, 'books/tools/fixture.py', '# data, never executed\n')
  put(root, 'books/chapters/one.md', '+++\nid = "one"\nkind = "concept"\ntitle = "Old title"\n+++\nA historical paragraph.\n'); mkdirSync(path.join(root, 'books/challenges'), { recursive: true })
  put(root, 'unrelated.txt', 'original\n'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'Public fixture')
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('outer publication witness real private repository controls', () => {
  it('binds before callback and after publication, preserving unrelated dirt and stable identity', () => {
    const root = repository(); put(root, 'unrelated.txt', 'dirty work preserved\n')
    const before = { head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), index: sha(readFileSync(path.join(root, '.git/index')).toString('base64')) }
    const first = withHistoryPublicationWitness(root, x => { expect(x.head).toBe(before.head); expect(x.remaining()).toBeGreaterThan(0); return x.fingerprint })
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(withHistoryPublicationWitness(root, x => x.fingerprint)).toBe(first)
    expect({ head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), index: sha(readFileSync(path.join(root, '.git/index')).toString('base64')) }).toEqual(before)
    expect(readFileSync(path.join(root, 'unrelated.txt'), 'utf8')).toBe('dirty work preserved\n')
  })
  it('refuses source, route and lock drift during collection/publication', () => {
    for (const name of ['src/lib/book-history-safe-html.ts', 'src/lib/book-history-publication.ts', 'src/pages/books/[book]/[node]/history-rendered/[asset].json.ts', 'package-lock.json']) {
      const root = repository()
      expect(() => withHistoryPublicationWitness(root, () => { put(root, name, readFileSync(path.join(root, name), 'utf8') + '\n'); return 'would publish' })).toThrow(/drift/)
    }
  })
  it('refuses dirty/staged covered inputs before executing publication', () => {
    for (const staged of [false, true]) {
      const root = repository(); put(root, 'src/lib/book-history-publication.ts', '// changed\n'); if (staged) git(root, 'add', '-A')
      let called = false
      expect(() => withHistoryPublicationWitness(root, () => { called = true })).toThrow(/dirty|HEAD/)
      expect(called).toBe(false)
    }
  })
  it('binds optional absence, source membership and physical index', () => {
    for (const name of ['.npmrc', 'books/chapters/another.md', '.git/index']) {
      const root = repository()
      expect(() => withHistoryPublicationWitness(root, () => { put(root, name, 'new fixture input\n') })).toThrow(/drift/)
    }
  })
  it('refuses a lock-mismatched parser before callback and asynchronous publication', () => {
    const root = repository(), lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
    lock.packages['node_modules/parse5'].version = '0.0.0'
    put(root, 'package-lock.json', JSON.stringify(lock)); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'Fixture lock mismatch')
    let called = false
    expect(() => withHistoryPublicationWitness(root, () => { called = true })).toThrow(/dependency\/lock/)
    expect(called).toBe(false)
    const clean = repository()
    expect(() => withHistoryPublicationWitness(clean, () => Promise.resolve('late'))).toThrow(/synchronous/)
  })
})

it('keeps second-site identity, version bytes and the closed route shape separate from raw-v1', async () => {
  const { publishRenderedHistory } = await api(), f = fixture()
  f.bundle.site = 'https://second.invalid'; f.bundle.rawAssets[0].site = f.bundle.site
  f.bundle.rawAssets[0].document = f.bundle.site + '/books/book/one/'
  f.bundle.documents[0].document = f.bundle.rawAssets[0].document
  f.bundle.documents[0].rawHistorySha256 = sha(serializeBookHistory(f.bundle.rawAssets[0]))
  const entries = publishRenderedHistory(f.bundle, f.css, f.fingerprint)
  const version = entries.find((x: any) => x.asset !== 'index'), index = JSON.parse(entries.find((x: any) => x.asset === 'index').json)
  expect(index.document).toBe('https://second.invalid/books/book/one/')
  expect(index.versions[0].sha256).toBe(sha(version.json))
  expect(index.versions[0].bytes).toBe(Buffer.byteLength(version.json))
  const route = await import('../pages/books/[book]/[node]/history-rendered/[asset].json')
  const get = route.GET({ props: { json: version.json } }), head = route.HEAD({ props: { json: version.json } })
  expect(await get.text()).toBe(version.json); expect(await head.text()).toBe('')
  expect(head.status).toBe(get.status); expect([...head.headers]).toEqual([...get.headers])
  expect(head.headers.get('x-content-type-options')).toBe('nosniff')
  expect(JSON.parse(serializeBookHistory(f.bundle.rawAssets[0]))).not.toHaveProperty('safeHtml')
})

it('refuses each identity/order/shape substitution before returning any asset array', async () => {
  const { publishRenderedHistory } = await api()
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.bundle.buildCommit = 'a'.repeat(40) },
    f => { f.bundle.documents[0].document = 'https://other.invalid/books/book/one/' },
    f => { f.bundle.documents[0].versions.reverse() },
    f => { f.bundle.documents[0].versions[0].sourcePath = 'books/chapters/other.md' },
    f => { f.bundle.documents[0].versions[0].sourceSha256 = '0'.repeat(64) },
    f => { f.bundle.documents[0].versions[0].render!.sourceSha256 = '0'.repeat(64) },
    f => { f.bundle.documents[0].versions[0].render!.html = '<p data-other="x">No</p>' },
    f => { (f.bundle.documents[0].versions[1] as any).render = {} },
    f => { (f.bundle.documents[0].versions[0] as any).privateProposal = 'not-public' },
    f => { (f.bundle as any).unknown = 'not-in-closed-schema' },
    f => { f.bundle.rendererProfile = 'other' },
    f => { f.bundle.rendererFingerprint = '' },
    f => { f.fingerprint = '' },
    f => { f.css.scoped = '.history-content{background:url(/fixture)}' },
    f => { f.css.content = ' '.repeat(65537) },
    f => { f.bundle.documents[0].versions[0].render!.blocks = [{ kind: 'prose', id: 'fake', digest: '012345abcdef' }] as any },
  ]
  for (const change of changes) {
    const value = fixture(); change(value)
    expect(() => publishRenderedHistory(value.bundle, value.css, value.fingerprint)).toThrow()
  }
})
it('retains rename lineage, original Git traversal order and public fields only', async () => {
  const { publishRenderedHistory } = await api(), f = fixture()
  const raw = f.bundle.rawAssets[0], oldPath = 'challenges/one.md'
  raw.versions[1].path = oldPath
  f.bundle.documents[0].versions[1].sourcePath = oldPath
  raw.versions[1].date = '2030-01-01T00:00:00+00:00' // traversal, not date sorting
  f.bundle.documents[0].rawHistorySha256 = sha(serializeBookHistory(raw))
  const before = JSON.stringify(f), entries = publishRenderedHistory(f.bundle, f.css, f.fingerprint)
  const index = JSON.parse(entries.at(-1).json), version = JSON.parse(entries[0].json)
  expect(index.versions.map((v: any) => v.commit)).toEqual(raw.versions.map(v => v.commit))
  expect(index.contentCssSha256).toBe(sha(f.css.content)); expect(index.scopedCssSha256).toBe(sha(f.css.scoped))
  expect(version.safeHtmlSha256).toBe(sha(version.safeHtml))
  for (const forbidden of ['dependencies', 'optionalAbsences', 'reads', 'author', 'message', 'proposalId']) {
    expect(version).not.toHaveProperty(forbidden); expect(index).not.toHaveProperty(forbidden)
  }
  expect(JSON.stringify(f)).toBe(before)
  expect(entries.map((x: any) => new URL(x.pathname, f.bundle.site).origin)).toEqual(entries.map(() => f.bundle.site))
})
it('preserves two-document separation and refuses duplicate mapping identities', async () => {
  const { publishRenderedHistory } = await api(), f = fixture(), other = fixture()
  const raw = other.bundle.rawAssets[0]
  raw.node = 'two'; raw.document = other.bundle.site + '/books/book/two/'
  other.bundle.documents[0].document = raw.document
  other.bundle.documents[0].rawHistorySha256 = sha(serializeBookHistory(raw))
  f.bundle.rawAssets.push(raw); f.bundle.documents.push(other.bundle.documents[0])
  const rows = publishRenderedHistory(f.bundle, f.css, f.fingerprint)
  expect(new Set(rows.map((x: any) => x.pathname)).size).toBe(4)
  f.bundle.rawAssets[1] = f.bundle.rawAssets[0]; f.bundle.documents[1] = f.bundle.documents[0]
  expect(() => publishRenderedHistory(f.bundle, f.css, f.fingerprint)).toThrow()
})
it('holds HEAD changes even when covered file bytes remain identical', () => {
  const root = repository()
  expect(() => withHistoryPublicationWitness(root, () => { git(root, 'commit', '--allow-empty', '-qm', 'Changed identity'); return 'would publish' })).toThrow(/drift/)
})
it('runs fresh canonical mapping/CSS through the real bridge inside the outer witness', () => {
  const root = repository()
  for (const name of ['manifest.py', 'render.py', 'markdown.py', 'history_render.py']) put(root, 'books/tools/' + name, readFileSync(path.join(ROOT, 'books/tools', name)))
  put(root, 'books/collection.toml', 'collection = "Fixture"\n')
  put(root, 'books/topics.toml', '')
  put(root, 'books/example.toml', 'id = "fixture"\nslug = "fixture-book"\ntitle = "Fixture book"\n[[parts]]\nid = "first"\ntitle = "First"\nnodes = ["one"]\n')
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'Current trusted renderer and mapping')
  const cwd = process.cwd(), python = process.env.CHALLENGES_PYTHON, bytecode = process.env.PYTHONDONTWRITEBYTECODE
  try {
    process.chdir(root); process.env.CHALLENGES_PYTHON = '/usr/bin/python3'; process.env.PYTHONDONTWRITEBYTECODE = '1'
    const cached = bookManifest(), css = cached.contentCss
    cached.contentCss = '@import "stale fixture";'; cached.books = []
    const before = { head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), index: sha(readFileSync(path.join(root, '.git/index')).toString('base64')) }
    const rows = renderedBookHistoryAssets(), index = JSON.parse(rows.find(x => x.asset === 'index')!.json)
    expect(index.book).toBe('fixture-book'); expect(index.node).toBe('one')
    expect(index.scopedCss).toBe(scopeContentCss(css, '.history-content'))
    expect(index.contentCssSha256).toBe(sha(css))
    expect(index.buildCommit).toBe(before.head)
    expect(index.rawHistorySha256).toBe(sha(serializeBookHistory(bookHistoryAssets()[0])))
    expect(rows.some(x => x.asset !== 'index')).toBe(true)
    expect({ head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), index: sha(readFileSync(path.join(root, '.git/index')).toString('base64')) }).toEqual(before)
  } finally {
    process.chdir(cwd)
    if (python === undefined) delete process.env.CHALLENGES_PYTHON; else process.env.CHALLENGES_PYTHON = python
    if (bytecode === undefined) delete process.env.PYTHONDONTWRITEBYTECODE; else process.env.PYTHONDONTWRITEBYTECODE = bytecode
  }
})

function addEmptyGitTree(root: string, filename: string) {
  const inputGit = (args: string[], input?: string | Buffer) => execFileSync('/usr/bin/git', args, { cwd: root, env, input, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trimEnd()
  const old = git(root, 'rev-parse', 'HEAD'), empty = inputGit(['mktree'], '')
  const replace = (tree: string, parts: string[]): string => {
    const rows = inputGit(['ls-tree', '-z', tree]).split('\0').filter(Boolean)
    const name = parts[0], oldRow = rows.find(row => row.slice(row.indexOf('\t') + 1) === name)
    if (parts.length > 1 && oldRow && !oldRow.startsWith('040000 tree ')) throw Error('fixture parent must be a tree')
    const child = parts.length === 1 ? empty : replace(oldRow?.split(' ')[2].split('\t')[0] ?? empty, parts.slice(1))
    return inputGit(['mktree', '-z'], rows.filter(row => row !== oldRow).map(row => row + '\0').join('') + `040000 tree ${child}\t${name}\0`)
  }
  const tree = replace(git(root, 'rev-parse', 'HEAD^{tree}'), filename.split('/'))
  const commit = inputGit(['commit-tree', tree, '-p', old], 'Owned complete-occupancy fixture\n')
  git(root, 'update-ref', 'HEAD', commit, old)
  expect(git(root, 'cat-file', '-t', `HEAD:${filename}`)).toBe('tree')
  expect(git(root, 'status', '--porcelain')).toBe('')
}
it.each([
  '.npmrc', '.pnpmfile.cjs', 'pnpm-lock.yaml',
  'books/empty.toml', 'books/tools/empty.py', 'books/chapters/empty.md', 'books/challenges/empty/challenge.md',
])('complete HEAD occupancy refuses an empty tree at covered %s before publication', filename => {
  const root = repository(); addEmptyGitTree(root, filename)
  let called = false
  expect(() => withHistoryPublicationWitness(root, () => { called = true; return 'invalid absence' })).toThrow()
  expect(called).toBe(false)
})
