/** Local prerequisite pilots. Git writes belong only to disposable synthetic fixtures. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawnSync: vi.fn(actual.spawnSync) }
})
const trusted = vi.hoisted(() => ({ root: undefined as string | undefined, python: undefined as string | undefined }))
vi.mock('../../src/lib/book-history-rendered', async original => {
  const actual = await original<typeof import('../../src/lib/book-history-rendered')>()
  return { ...actual, trustedBookRendererRoot: vi.fn(() => trusted.root ?? (actual as any).trustedBookRendererRoot()), trustedBookPythonPath: vi.fn(() => trusted.python ?? (actual as any).trustedBookPythonPath()) }
})
import * as books from '../../src/lib/books'
import * as rendered from '../../src/lib/book-history-rendered'
import { withExactBookBaseSnapshot } from '../../src/lib/book-history'
import * as preview from './proposal-preview'
import { applyHunks, formatHunks, parseHunks } from '../../src/annotations/criticmarkup'
const realExec = vi.mocked(execFileSync).getMockImplementation()!
const realSpawn = vi.mocked(spawnSync).getMockImplementation()!
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex')
const SITE = 'https://ernie.sg', SOURCE = 'books/chapters/one.md', HEAD = 'a'.repeat(40)
const doc = (body: string, kind = 'concept', id = 'one') => `+++\nid = "${id}"\nkind = "${kind}"\ntitle = "Synthetic preview"\n+++\n${body}`
const row = (name: string, content: string) => ({ path: name, mode: '100644', content, sha256: sha(content) })
function supplied(source = SOURCE, content = doc('Old prose.\n')) {
  return {
    expectedHead: HEAD,
    snapshot: { site: SITE, document: SITE + '/books/fixture/one/', revision: 2, body: formatHunks([{ baseStartLine: 6, baseEndLine: 6, criticMarkup: '{~~Old~>New~~} prose.\n' }]), baseCommit: HEAD, sourcePath: source },
    mapping: { site: SITE, head: HEAD, documents: [{ document: SITE + '/books/fixture/one/', sourcePath: source }] },
    tree: { commit: HEAD, files: [row(source, content)], occupied: ['books', 'books/chapters', source] },
  }
}
const roots: string[] = []
const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0' }
function git(root: string, ...args: string[]) {
  if (!roots.includes(root)) throw Error('only owned disposable Git fixture allowed')
  return realExec('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trimEnd()
}
function put(root: string, name: string, text: string) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text) }
function fixture(files: ReturnType<typeof row>[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'local-preview-pilot-')); roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const name of ['books/tools/manifest.py', 'books/tools/render.py', 'src/lib/books.ts', 'src/lib/book-history.ts', 'src/consts.ts', 'src/pages/books/[book]/[node]/history.json.ts']) put(root, name, '# Historical fixture data must never execute\n')
  put(root, 'books/fixture.toml', 'slug = "fixture"\n')
  for (const file of files) put(root, file.path, file.content)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'synthetic source')
  const base = git(root, 'rev-parse', 'HEAD')
  put(root, 'unrelated.txt', 'Unchanged source ancestor fixture\n')
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'unrelated change')
  return { root, base, head: git(root, 'rev-parse', 'HEAD') }
}
afterEach(() => {
  trusted.root = trusted.python = undefined; vi.unstubAllEnvs()
  vi.restoreAllMocks(); vi.mocked(execFileSync).mockImplementation(realExec).mockClear(); vi.mocked(spawnSync).mockImplementation(realSpawn).mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local proposal preview prerequisite RED', () => {
  it('inherits the absolute deadline after earlier stages instead of resetting it', () => {
    let time = 119_950
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    expect(() => rendered.withReadOnlyBookRenderer(handle => {
      time = 120_001
      return handle.fingerprint
    }, { deadline: 120_000 } as any)).toThrow(/deadline/)
  })
  it('passes only the shared absolute remainder to its renderer child', () => {
    const data = supplied()
    rendered.withReadOnlyBookRenderer(handle => handle.render({ sourcePath: SOURCE, files: data.tree.files, occupied: data.tree.occupied }))
    const captured = vi.mocked(spawnSync).mock.results[0].value
    vi.mocked(spawnSync).mockClear().mockReturnValue(captured)
    vi.spyOn(performance, 'now').mockReturnValue(119_900)
    rendered.withReadOnlyBookRenderer(handle => handle.render({ sourcePath: SOURCE, files: data.tree.files, occupied: data.tree.occupied }), { deadline: 120_000 } as any)
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect((vi.mocked(spawnSync).mock.calls[0][2] as any).timeout).toBeLessThanOrEqual(100)
  })
  it('shares the real renderer handle without relabeling the legacy offline result', () => {
    const fn = (preview as any).previewCurrentProposalWithRenderer
    expect(fn, 'shared-handle preview API absent').toBeTypeOf('function')
    const data = supplied(), old = preview.previewCurrentProposal(data)
    const next = rendered.withReadOnlyBookRenderer(handle => fn(data, handle))
    expect(next).toEqual(old)
    expect(next.provenance).toBe('unverified-input-provenance')
  })
  it('captures exact-base metadata using the shared bounded map implementation', () => {
    const capture = (rendered as any).captureExactBookInput
    expect(capture, 'exact-base shared map capture API absent').toBeTypeOf('function')
    const data = supplied(), f = fixture(data.tree.files)
    withExactBookBaseSnapshot(f.root, SITE, () => [{ book: 'fixture', node: 'one', path: '/books/fixture/one/', sourcePath: SOURCE }], { expectedHead: f.head, baseCommit: f.base, gitCalls: 4080 }, (_nodes, snapshot) => {
      const result = capture(snapshot, SOURCE)
      expect(result.treeOID).toBe(snapshot.tree().treeOID)
      expect(result.files).toEqual(data.tree.files)
      expect(result.occupied).toContain(SOURCE)
    })
  })
  it('rejects caller mapping/root authority at the new fixed-site local entry', async () => {
    const url = new URL('./local-proposal-preview.ts', import.meta.url)
    const api = existsSync(url) ? await import(/* @vite-ignore */ url.href) : {}
    expect(api.previewLocalProposal, 'local Git-bound preview wrapper absent').toBeTypeOf('function')
    const data = supplied()
    for (const extra of [{ mapping: data.mapping }, { root: '/untrusted' }, { approved: true }]) {
      const result = api.previewLocalProposal({ expectedHead: HEAD, snapshot: data.snapshot, ...extra })
      expect(result.status).toBe('refused')
      expect(result).not.toHaveProperty('preview')
    }
  })
})

const cases = [
  { name: 'concept', source: SOURCE, content: doc('Old prose.\n'), extra: [] },
  { name: 'challenge-optional-absence', source: 'books/challenges/one/challenge.md', content: doc('Old prose.\n:::run\n:::\n', 'challenge'), extra: [] },
  { name: 'figure', source: SOURCE, content: doc('Old prose.\n:::figure{id="cells"}\n:::\n'), extra: [row('books/figures/cells.json', JSON.stringify({ type: 'cells', values: [1, 2], caption: 'Synthetic figure' }))] },
  { name: 'included-challenge', source: SOURCE, content: doc('Old prose.\n:::problem{id="included"}\n:::\n'), extra: [row('books/challenges/included/challenge.md', doc(':::statement\nSynthetic included statement.\n:::\n', 'challenge', 'included'))] },
  { name: 'unicode-links', source: SOURCE, content: doc('Old prose.\n' + Array.from({ length: 32 }, (_, i) => `Paragraph ${i}: naïve λ reader [inert link](https://example.invalid/).\n\n`).join('')), extra: [] },
]
describe('local preview existing-primitives resource pilot', () => {
  for (const item of cases) it(item.name, () => {
    const files = [row(item.source, item.content), ...item.extra], f = fixture(files)
    const before = { head: git(f.root, 'rev-parse', 'HEAD'), index: sha(readFileSync(path.join(f.root, '.git/index'))), status: git(f.root, 'status', '--porcelain=v1') }
    const calls = vi.mocked(execFileSync).mock.calls.length, children = vi.mocked(spawnSync).mock.calls.length, started = performance.now()
    const result = withExactBookBaseSnapshot(f.root, SITE, () => [{ book: 'fixture', node: 'one', path: '/books/fixture/one/', sourcePath: item.source }], { expectedHead: f.head, baseCommit: f.base, gitCalls: 4080 }, (_nodes, snapshot) => {
      const tree = snapshot.tree(), entries = files.map(file => tree.entries.get(file.path)!)
      const blobs = snapshot.blobs(entries.map(entry => entry.oid), 64 * 1024 * 1024)
      const captured = files.map((file, i) => {
        const bytes = blobs.get(entries[i].oid)!
        expect(bytes).toEqual(Buffer.from(file.content))
        expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe(entries[i].oid)
        return { path: file.path, mode: entries[i].mode, content: bytes.toString('utf8'), sha256: sha(bytes) }
      })
      const data = supplied(item.source, item.content)
      data.expectedHead = data.mapping.head = f.head; data.snapshot.baseCommit = data.tree.commit = f.base
      data.tree.files = captured; data.tree.occupied = [...tree.occupied]
      const unchanged = JSON.stringify(data)
      const output = preview.previewCurrentProposal(data)
      expect(output.status).toBe('previewed')
      if (output.status !== 'previewed') throw Error(output.reason)
      expect(output.provenance).toBe('unverified-input-provenance')
      expect(output.staleBase).toBe(true)
      expect(output.proposedSha256).toBe(sha(applyHunks(parseHunks(data.snapshot.body), item.content)))
      expect(JSON.stringify(data)).toBe(unchanged)
      for (const missing of output.optionalAbsences) expect(tree.occupied.has(missing)).toBe(false)
      if (item.name === 'challenge-optional-absence') expect(output.optionalAbsences).toEqual(['books/challenges/one/starter.py'])
      for (const dependency of output.dependencies) {
        const entry = tree.entries.get(dependency.path)!
        expect(entry).toBeDefined(); expect(dependency.mode).toBe(entry.mode)
        expect(dependency.sha256).toBe(sha(blobs.get(entry.oid)!))
      }
      return { output, treeOID: tree.treeOID, files: captured }
    })
    const elapsedMs = performance.now() - started, gitCalls = vi.mocked(execFileSync).mock.calls.length - calls, childCount = vi.mocked(spawnSync).mock.calls.length - children
    expect(childCount).toBe(1); expect(gitCalls).toBeLessThanOrEqual(4080)
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(sha(readFileSync(path.join(f.root, '.git/index')))).toBe(before.index)
    expect(git(f.root, 'status', '--porcelain=v1')).toBe(before.status)
    const observation = { name: item.name, selectedObjects: files.length, selectedBytes: files.reduce((n, x) => n + Buffer.byteLength(x.content), 0), mapJsonBytes: Buffer.byteLength(JSON.stringify(result.files)), outputBytes: Buffer.byteLength(JSON.stringify(result.output)), gitCalls, childCount, elapsedMs, treeOID: result.treeOID, actualBase: f.base, sourcePreserved: true, canonicalMapping: 'trusted synthetic callback only; fixed-root wrapper not implemented' }
    if (process.env.LOCAL_PREVIEW_PILOT_OUTPUT) writeFileSync(path.join(process.env.LOCAL_PREVIEW_PILOT_OUTPUT, item.name + '.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' })
    else console.log('LOCAL_PREVIEW_PILOT ' + JSON.stringify(observation))
  })
})


// These use a private copy of the current trusted tools, never historical tools.
const CURRENT = new URL('../../', import.meta.url)
const PREVIEW_INPUTS = [
  'src/lib/book-history-safe-html.ts', 'src/lib/book-history-publication.ts',
  'src/lib/books.ts', 'src/lib/book-history.ts', 'src/lib/book-history-rendered.ts',
  'src/lib/margin-history-data.ts', 'src/consts.ts',
  'src/pages/books/[book]/[node]/history.json.ts',
  'src/pages/books/[book]/[node]/history-rendered/[asset].json.ts',
  'adapters/margin/local-source.ts', 'adapters/margin/source-plan.ts', 'src/annotations/criticmarkup.ts',
  'package.json', 'package-lock.json', 'tsconfig.json', 'astro.config.ts',
  'adapters/margin/proposal-preview.ts', 'adapters/margin/local-proposal-preview.ts',
  'books/tools/manifest.py', 'books/tools/render.py', 'books/tools/markdown.py', 'books/tools/history_render.py',
]
function canonicalFixture(files = [row(SOURCE, doc('Old prose.\n'))]) {
  const root = mkdtempSync(path.join(tmpdir(), 'local-preview-canonical-')); roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const name of PREVIEW_INPUTS) {
    const filename = new URL(name, CURRENT)
    put(root, name, existsSync(filename) ? readFileSync(filename, 'utf8') : '// future wrapper; fixture data only\n')
  }
  for (const file of files) put(root, file.path, file.content)
  put(root, 'books/collection.toml', 'collection = "Fixture"\n')
  put(root, 'books/fixture.toml', 'id = "fixture"\nslug = "fixture"\ntitle = "Fixture"\n[[parts]]\nid = "one"\ntitle = "One"\nnodes = ["one"]\n')
  put(root, 'books/topics.toml', '')
  mkdirSync(path.join(root, 'books/challenges'), { recursive: true })
  mkdirSync(path.join(root, 'books/chapters'), { recursive: true })
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'trusted current canonical fixture')
  trusted.root = root
  return { root, head: git(root, 'rev-parse', 'HEAD') }
}
function previewInputs<T>(visit: (context: any) => T, deadline = performance.now() + 120_000): T {
  const fn = (books as any).withLocalBookPreviewInputs
  expect(fn, 'fixed-root preview witness bridge absent').toBeTypeOf('function')
  return fn(deadline, visit)
}
describe('preview mapping/runtime lifetime required before code', () => {
  it('uses the fixed trusted root despite cwd and returns only four canonical mapping fields', () => {
    const f = canonicalFixture()
    expect(process.cwd()).not.toBe(f.root)
    const result = previewInputs(context => {
      expect(context.root).toBe(f.root)
      expect(context.head).toBe(f.head)
      const nodes = context.loadNodes()
      expect(nodes).toEqual([{ book: 'fixture', node: 'one', path: '/books/fixture/one/', sourcePath: SOURCE }])
      expect(Object.keys(nodes[0]).sort()).toEqual(['book', 'node', 'path', 'sourcePath'])
      return nodes
    })
    expect(result).toHaveLength(1)
    const calls = vi.mocked(execFileSync).mock.calls.filter(call => (call[1] as string[])?.[0] === '-I' && (call[1] as string[])?.[2] === path.join(f.root, 'books/tools/manifest.py'))
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual(['-I', '-B', path.join(f.root, 'books/tools/manifest.py')])
    expect((calls[0][2] as any).cwd).toBe(f.root)
  })
  it('holds the mapping runtime from child return through final envelope completion', () => {
    const f = canonicalFixture(), binary = path.join(f.root, 'mapping-python')
    copyFileSync('/usr/bin/python3.12', binary); trusted.python = binary
    for (const phase of ['after-child', 'final-envelope']) {
      let drifted = false
      vi.mocked(execFileSync).mockImplementation(((...args: any[]) => {
        const value = (realExec as any)(...args)
        if (phase === 'after-child' && (args[1] as string[])?.[0] === '-I' && (args[1] as string[])?.[2] === path.join(f.root, 'books/tools/manifest.py')) { appendFileSync(binary, '\n'); drifted = true }
        return value
      }) as any)
      expect(() => previewInputs(context => {
        context.loadNodes()
        if (phase === 'final-envelope') { appendFileSync(binary, '\n'); drifted = true }
        return { status: 'would-return-envelope' }
      })).toThrow(/drift|changed/)
      expect(drifted).toBe(true)
    }
    vi.mocked(execFileSync).mockImplementation(realExec)
  })
  it('retains renderer runtime identity after render and rejects late outer result', () => {
    const f = canonicalFixture(), binary = path.join(f.root, 'renderer-python')
    copyFileSync('/usr/bin/python3.12', binary); vi.stubEnv('CHALLENGES_PYTHON', binary)
    const data = supplied()
    expect(() => rendered.withReadOnlyBookRenderer(handle => {
      handle.render({ sourcePath: SOURCE, files: data.tree.files, occupied: data.tree.occupied })
      appendFileSync(binary, '\n')
      return { status: 'would-return-envelope' }
    })).toThrow(/changed/)
    let clock = 100
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    expect(() => rendered.withReadOnlyBookRenderer(() => { clock = 201; return 'late-envelope' }, { deadline: 200 } as any)).toThrow(/deadline/)
  })
})

describe('complete local preview and one inherited lifetime', () => {
  it('renders exact base bytes under fresh canonical mapping, preserving supplied provenance and source', async () => {
    const f = canonicalFixture(), base = f.head
    // Current content deliberately differs: rendered proposal must use its own base.
    put(f.root, SOURCE, doc('Current content must not become the preview base.\n'))
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-qm', 'different current source')
    const head = git(f.root, 'rev-parse', 'HEAD'), beforeIndex = sha(readFileSync(path.join(f.root, '.git/index')))
    const input = supplied(); input.expectedHead = head; input.snapshot.baseCommit = base
    const { previewLocalProposal } = await import('./local-proposal-preview')
    const firstCall = vi.mocked(execFileSync).mock.calls.length
    const output = previewLocalProposal({ expectedHead: head, snapshot: input.snapshot })
    expect(output.status).toBe('previewed')
    if (output.status !== 'previewed') throw Error(output.reason)
    expect(output.proposalProvenance).toBe('supplied-unverified')
    expect(output.sourceProvenance).toBe('git-bound')
    expect(output.preview.provenance).toBe('unverified-input-provenance')
    expect(output.preview.safeHtml).toContain('New prose.')
    expect(output.preview.safeHtml).not.toContain('Current content')
    expect(output.preview.staleBase).toBe(true)
    expect(output.evidence.sourceSha256).toBe(sha(doc('Old prose.\n')))
    expect(output.evidence.sourceOID).toBe(git(f.root, 'rev-parse', `${base}:${SOURCE}`))
    expect(output.evidence.treeOID).toBe(git(f.root, 'rev-parse', `${base}^{tree}`))
    const calls = vi.mocked(execFileSync).mock.calls.slice(firstCall).filter(call => call[0] === '/usr/bin/git')
    expect(calls.length).toBeGreaterThan(16); expect(calls.length).toBeLessThanOrEqual(4096)
    expect(calls.every(call => (call[2] as any).timeout > 0 && (call[2] as any).timeout <= 15_000)).toBe(true)
    expect(git(f.root, 'status', '--porcelain=v1')).toBe('')
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head)
    expect(sha(readFileSync(path.join(f.root, '.git/index')))).toBe(beforeIndex)
    for (const change of [{ site: 'https://other.invalid', document: 'https://other.invalid/books/fixture/one/' }, { document: SITE + '/books/fixture/missing/' }, { sourcePath: 'books/chapters/other.md' }]) {
      const result = previewLocalProposal({ expectedHead: head, snapshot: { ...input.snapshot, ...change } })
      expect(result.status).toBe('refused'); expect(result).not.toHaveProperty('preview')
    }
    expect(previewLocalProposal({ expectedHead: HEAD, snapshot: input.snapshot }).status).toBe('refused')
  })
  it('expires mapping and exact-base capabilities including inherited final checks', () => {
    const f = canonicalFixture()
    let expiredLoad: (() => unknown) | undefined
    previewInputs(context => { expiredLoad = context.loadNodes; return context.loadNodes() })
    const calls = vi.mocked(execFileSync).mock.calls.length
    expect(() => expiredLoad!()).toThrow(/scope expired/)
    expect(vi.mocked(execFileSync).mock.calls.length).toBe(calls)
    let time = 100, escaped: any
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    expect(() => withExactBookBaseSnapshot(f.root, SITE, () => [{ book: 'fixture', node: 'one', path: '/books/fixture/one/', sourcePath: SOURCE }], { expectedHead: f.head, baseCommit: f.head, deadline: 10_100, gitCalls: 4080 }, (_nodes, snapshot) => {
      escaped = snapshot; time = 10_101; return 'late result'
    })).toThrow(/deadline|resource bound/)
    expect(escaped).toBeDefined()
    expect(() => escaped.tree()).toThrow(/expired/)
    for (const deadline of [NaN, Infinity, 100]) expect(() => withExactBookBaseSnapshot(f.root, SITE, () => [], { expectedHead: f.head, baseCommit: f.head, deadline }, () => 'unreachable')).toThrow(/deadline/)
  })
  it('checks mapping child remainder and rejects expired return without resetting the next stage', () => {
    const f = canonicalFixture()
    let time = 100, mappingCalled = false
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    vi.mocked(execFileSync).mockImplementation(((...args: any[]) => {
      const value = (realExec as any)(...args)
      if (args[1]?.[0] === '-I') {
        mappingCalled = true; expect(args[2].timeout).toBeLessThanOrEqual(4_900); time = 5_001
      }
      return value
    }) as any)
    expect(() => previewInputs(context => context.loadNodes(), 5_000)).toThrow(/deadline/)
    expect(mappingCalled).toBe(true)
  })
})


describe('complete envelope and source-witness closure', () => {
  for (const item of cases.slice(1, 4)) it(`binds ${item.name} reads and absences to exact base objects`, async () => {
    const f = canonicalFixture([row(item.source, item.content), ...item.extra]), input = supplied(item.source, item.content)
    input.snapshot.baseCommit = f.head
    const { previewLocalProposal } = await import('./local-proposal-preview')
    const result = previewLocalProposal({ expectedHead: f.head, snapshot: input.snapshot })
    expect(result.status).toBe('previewed')
    if (result.status !== 'previewed') throw Error(result.reason)
    expect(result.evidence.sourceOID).toBe(git(f.root, 'rev-parse', `${f.head}:${item.source}`))
    for (const dependency of result.evidence.dependencies) {
      expect(dependency.oid).toBe(git(f.root, 'rev-parse', `${f.head}:${dependency.path}`))
      const expected = item.extra.find(file => file.path === dependency.path)!
      expect(dependency.sha256).toBe(expected.sha256)
    }
    if (item.name === 'challenge-optional-absence') expect(result.evidence.optionalAbsences).toEqual([{ path: 'books/challenges/one/starter.py', treeOID: result.evidence.treeOID }])
  })
  it('rejects a covered preview module changed after renderer return', async () => {
    const f = canonicalFixture(), input = supplied(); input.snapshot.baseCommit = f.head
    const { previewLocalProposal } = await import('./local-proposal-preview')
    let changed = false
    vi.mocked(spawnSync).mockImplementation(((...args: any[]) => {
      const result = (realSpawn as any)(...args)
      appendFileSync(path.join(f.root, 'adapters/margin/local-proposal-preview.ts'), '// private fixture drift\n')
      changed = true; return result
    }) as any)
    const result = previewLocalProposal({ expectedHead: f.head, snapshot: input.snapshot })
    expect(changed).toBe(true)
    expect(result).toEqual({ status: 'not_evaluated', reason: 'local-preview-inspection-unavailable' })
  })
  it('counts the Git metadata in the complete output limit without omitting evidence', async () => {
    const f = canonicalFixture(), input = supplied(); input.snapshot.baseCommit = f.head
    const original = preview.previewCurrentProposalWithRenderer
    let previewBytes = 0
    vi.spyOn(preview, 'previewCurrentProposalWithRenderer').mockImplementation((...args) => {
      const result = original(...args)
      if (result.status !== 'previewed') throw Error('positive rendering fixture required')
      const empty = { ...result, safeHtml: '' }
      // Named transport-only size control: a bounded prior result leaves less
      // room than its required Git envelope. This does not claim rendered fidelity.
      const expanded = { ...empty, safeHtml: 'x'.repeat(8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty)) - 16) }
      previewBytes = Buffer.byteLength(JSON.stringify(expanded)); return expanded
    })
    const { previewLocalProposal } = await import('./local-proposal-preview')
    const result = previewLocalProposal({ expectedHead: f.head, snapshot: input.snapshot })
    expect(previewBytes).toBeGreaterThan(0); expect(previewBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(result).toEqual({ status: 'not_evaluated', reason: 'local-preview-envelope-limit' })
  })
})

describe('last stage and alias preservation', () => {
  it('discards an envelope assembled after the shared outer deadline', async () => {
    const f = canonicalFixture(), input = supplied(); input.snapshot.baseCommit = f.head
    const { previewLocalProposal } = await import('./local-proposal-preview')
    const stringify = JSON.stringify
    let time = 100, assembled = false
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    vi.spyOn(JSON, 'stringify').mockImplementation(((...args: any[]) => {
      const value = (stringify as any)(...args)
      if (args[0]?.proposalProvenance === 'supplied-unverified') { assembled = true; time = 120_101 }
      return value
    }) as any)
    expect(previewLocalProposal({ expectedHead: f.head, snapshot: input.snapshot })).toEqual({ status: 'not_evaluated', reason: 'local-preview-inspection-unavailable' })
    expect(assembled).toBe(true)
  })
  it('resolves a second canonical book alias without reassigning source authority', async () => {
    const f = canonicalFixture()
    put(f.root, 'books/alternate.toml', 'id = "alternate"\nslug = "alternate"\ntitle = "Alternate"\n[[parts]]\nid = "one"\ntitle = "One"\nnodes = ["one"]\n')
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-qm', 'second canonical alias')
    const head = git(f.root, 'rev-parse', 'HEAD'), input = supplied(); input.snapshot.baseCommit = head
    input.snapshot.document = SITE + '/books/alternate/one/'
    const { previewLocalProposal } = await import('./local-proposal-preview')
    const result = previewLocalProposal({ expectedHead: head, snapshot: input.snapshot })
    expect(result.status).toBe('previewed')
    if (result.status !== 'previewed') throw Error(result.reason)
    expect(result.evidence.document).toBe(input.snapshot.document)
    expect(result.evidence.sourcePath).toBe(SOURCE)
    expect(result.evidence.sourceOID).toBe(git(f.root, 'rev-parse', `${head}:${SOURCE}`))
  })
})
