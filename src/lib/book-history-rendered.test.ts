/** Collector RED pilots: all Git mutations are confined to owned disposable fixtures. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawnSync: vi.fn(actual.spawnSync) }
})
const realExec = vi.mocked(execFileSync).getMockImplementation()!
const realSpawn = vi.mocked(spawnSync).getMockImplementation()!
import { captureGitSelection } from '../../adapters/margin/local-source'
import { collectBookHistories, serializeBookHistory, withBookHistorySnapshot, type HistorySnapshot } from './book-history'

const SITE = 'https://ernie.sg'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const roots: string[] = []
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const env = {
  PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Public Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Public Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00',
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
}
function git(root: string, ...args: string[]): Buffer {
  return execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', ...args],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })
}
const text = (root: string, ...args: string[]) => git(root, ...args).toString('utf8').trimEnd()
function put(root: string, name: string, content: string | Buffer) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  writeFileSync(path.join(root, name), content)
}
function commit(root: string, subject: string) {
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', subject)
  return text(root, 'rev-parse', 'HEAD')
}
function document(body: string, kind = 'concept', id = 'one') {
  return `+++\nid = "${id}"\nkind = "${kind}"\ntitle = "Historical fixture"\n+++\n${body}`
}
function fixture(source = 'books/chapters/one.md', body = document('Original prose.\n'), objectFormat = 'sha1') {
  const root = mkdtempSync(path.join(tmpdir(), 'rendered-history-'))
  roots.push(root); git(root, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`)
  const fixed = [
    'src/lib/books.ts', 'src/lib/book-history.ts', 'src/consts.ts',
    'src/pages/books/[book]/[node]/history.json.ts',
    'adapters/margin/local-source.ts', 'adapters/margin/source-plan.ts', 'src/annotations/criticmarkup.ts',
    'books/tools/manifest.py', 'books/tools/history_render.py', 'books/tools/render.py', 'books/tools/markdown.py',
  ]
  for (const name of fixed) put(root, name, readFileSync(path.join(ROOT, name)))
  // Before implementation the new source is absent. This placeholder is data
  // in the fixture only, never an executable renderer or successful mock.
  const collector = 'src/lib/book-history-rendered.ts'
  put(root, collector, existsSync(path.join(ROOT, collector)) ? readFileSync(path.join(ROOT, collector)) : '// collector not yet implemented\n')
  put(root, 'books/dsa.toml', 'slug = "fixture-book"\n')
  put(root, source, body); commit(root, 'First public version')
  return root
}
const nodes = (sourcePath = 'books/chapters/one.md') => [{ book: 'fixture-book', node: 'one', path: '/books/fixture-book/one/', sourcePath }]
async function api() {
  const filename = new URL('./book-history-rendered.ts', import.meta.url)
  const module = existsSync(filename) ? await import(/* @vite-ignore */ filename.href) : {}
  expect(module.collectRenderedBookHistories, 'the provenance-bound collector must be implemented').toBeTypeOf('function')
  return module.collectRenderedBookHistories as (...args: any[]) => any
}
function preserved(root: string) {
  return { head: text(root, 'rev-parse', 'HEAD'), refs: text(root, 'show-ref'), status: text(root, 'status', '--porcelain=v1'), index: sha(readFileSync(path.join(root, '.git/index'))) }
}
function emptyTreeVersion(root: string, source: string, emptyPath: string) {
  const inputGit = (args: string[], input: string) => realExec('/usr/bin/git', args,
    { cwd: root, env, input, encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }).toString().trim()
  const empty = inputGit(['mktree'], '')
  // An explicit empty tree is valid Git data although the index cannot store
  // it. Also change the source so this exact tree is a --follow version.
  put(root, source, readFileSync(path.join(root, source), 'utf8') + '\nEmpty tree version.\n')
  git(root, 'add', source)
  function insert(tree: string, parts: string[]): string {
    const [name, ...rest] = parts
    const rows = text(root, 'ls-tree', tree).split('\n').filter(Boolean)
    const existing = rows.find(row => row.endsWith(`\t${name}`))
    const next = rest.length ? insert(existing?.split(/\s+/)[2] ?? empty, rest) : empty
    return inputGit(['mktree'], [...rows.filter(row => !row.endsWith(`\t${name}`)), `040000 tree ${next}\t${name}`].join('\n') + '\n')
  }
  const tree = insert(text(root, 'write-tree'), emptyPath.split('/'))
  const commit = inputGit(['commit-tree', tree, '-p', text(root, 'rev-parse', 'HEAD'), '-m', 'Fixture explicit empty tree'], '')
  git(root, 'reset', '--hard', commit) // Only this owned disposable fixture.
  return empty
}
afterEach(() => { vi.mocked(execFileSync).mockImplementation(realExec); vi.mocked(spawnSync).mockImplementation(realSpawn); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('historical rendered collector first five RED families', () => {
  it('preserves raw-v1 bytes and full HEAD provenance without changing unrelated dirty work', async () => {
    const root = fixture('books/chapters/one.md', document('\ufeffA first paragraph.\r\n'))
    put(root, 'unrelated.txt', 'committed unrelated data'); commit(root, 'Not a node version')
    put(root, 'unrelated.txt', 'dirty unrelated work must survive')
    const before = preserved(root)
    const raw = collectBookHistories(root, SITE, () => nodes())
    const collect = await api()
    const bundle = await collect(root, SITE, () => nodes(), { expectedHead: before.head })
    expect(bundle.buildCommit).toBe(before.head)
    expect(bundle.rawAssets.map(serializeBookHistory)).toEqual(raw.map(serializeBookHistory))
    expect(bundle.documents[0].document).toBe(raw[0].document)
    expect(bundle.documents[0].rawHistorySha256).toBe(sha(serializeBookHistory(raw[0])))
    expect(bundle.documents[0].versions[0].commit).not.toBe(before.head)
    expect(preserved(root)).toEqual(before)
    expect(readFileSync(path.join(root, 'unrelated.txt'), 'utf8')).toBe('dirty unrelated work must survive')
  })

  it('renders each commit figure, included problem and starter as data with exact OID witnesses', async () => {
    const source = 'books/challenges/one/challenge.md'
    const root = fixture(source, document(':::figure{id="cells"}\n:::\n:::problem{id="included"}\n:::\n:::run\n:::\n', 'challenge'))
    put(root, 'books/figures/cells.json', JSON.stringify({ type: 'cells', values: [1], caption: 'Older figure' }))
    put(root, 'books/challenges/included/challenge.md', document(':::statement\nOlder included problem.\n:::\n', 'challenge', 'included'))
    put(root, 'books/challenges/one/starter.py', 'raise RuntimeError("MUST_NOT_EXECUTE_OLD")\n')
    // Amend only the disposable initial fixture so every recorded version is complete.
    git(root, 'add', '-A'); git(root, 'commit', '--amend', '--no-edit', '-q')
    const older = text(root, 'rev-parse', 'HEAD')
    put(root, source, document('Changed prose.\n:::figure{id="cells"}\n:::\n:::problem{id="included"}\n:::\n:::run\n:::\n', 'challenge'))
    put(root, 'books/figures/cells.json', JSON.stringify({ type: 'cells', values: [2], caption: 'Newer figure' }))
    put(root, 'books/challenges/included/challenge.md', document(':::statement\nNewer included problem.\n:::\n', 'challenge', 'included'))
    put(root, 'books/challenges/one/starter.py', 'raise RuntimeError("MUST_NOT_EXECUTE_NEW")\n')
    const newer = commit(root, 'Changed node and its own dependencies')
    const collect = await api(); const before = preserved(root)
    const bundle = await collect(root, SITE, () => nodes(source))
    const versions = bundle.documents[0].versions
    expect(versions.map((v: any) => v.commit)).toEqual([newer, older])
    for (const [index, label] of ['Newer', 'Older'].entries()) {
      const row = versions[index]
      expect(row.render.html).toContain(`${label} figure`)
      expect(row.render.html).toContain(`${label} included problem`)
      expect(row.render.html).toContain(index ? 'MUST_NOT_EXECUTE_OLD' : 'MUST_NOT_EXECUTE_NEW')
      expect(row.render.html).not.toMatch(/<(?:button|textarea|input|form)\b/)
      expect(row.dependencies.map((d: any) => d.path).sort()).toEqual([source, 'books/figures/cells.json', 'books/challenges/included/challenge.md', 'books/challenges/one/starter.py'].sort())
      for (const dependency of row.dependencies) {
        const bytes = git(root, 'show', `${row.commit}:${dependency.path}`)
        expect(dependency.oid).toBe(text(root, 'rev-parse', `${row.commit}:${dependency.path}`))
        expect(dependency.sha256).toBe(sha(bytes))
      }
    }
    expect(preserved(root)).toEqual(before)
  })

  it('keeps legacy rename and deletion/restore order, never rendering tombstones', async () => {
    const legacy = 'challenges/one.md', current = 'books/chapters/one.md'
    const root = fixture(legacy)
    const first = text(root, 'rev-parse', 'HEAD')
    git(root, 'rm', legacy); const deleted = commit(root, 'Deleted node')
    put(root, legacy, document('Restored version.\n')); commit(root, 'Restored node')
    mkdirSync(path.join(root, 'books/chapters'), { recursive: true })
    git(root, 'mv', legacy, current); commit(root, 'Renamed node')
    const collect = await api(); const before = preserved(root)
    const bundle = await collect(root, SITE, () => nodes(current))
    const rows = bundle.documents[0].versions
    expect(rows.map((v: any) => v.commit)).toEqual(text(root, 'log', '--follow', '--format=%H', 'HEAD', '--', current).split('\n'))
    expect(rows.find((v: any) => v.commit === first).sourcePath).toBe(legacy)
    expect(rows.find((v: any) => v.commit === deleted)).toMatchObject({ deleted: true, render: null })
    for (const row of rows.filter((v: any) => !v.deleted)) {
      expect(row.sourceSha256).toBe(sha(git(root, 'show', `${row.commit}:${row.sourcePath}`)))
      expect(row.render.html).toBeTypeOf('string')
    }
    expect(preserved(root)).toEqual(before)
  })

  it('fails visibly on bounded-map refusal or Git selection/config drift instead of partial success', async () => {
    const root = fixture(); const collect = await api(); const before = preserved(root)
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(), { limits: { mapBytes: 1 } }))).rejects.toThrow(/bound|limit/i)
    expect(preserved(root)).toEqual(before)
    const config = readFileSync(path.join(root, '.git/config'))
    await expect(Promise.resolve().then(() => collect(root, SITE, () => {
      git(root, 'config', 'remote.fixture.partialclonefilter', 'blob:none')
      return nodes()
    }))).rejects.toThrow(/partial|metadata|changed|drift/i)
    writeFileSync(path.join(root, '.git/config'), config)
    expect(preserved(root)).toEqual(before)
  })

  it('proves optional absence from the whole tree while refusing explicit missing or symlink starter', async () => {
    const source = 'books/challenges/one/challenge.md'
    const root = fixture(source, document(':::run\n:::\n', 'challenge'))
    const collect = await api()
    const bundle = await collect(root, SITE, () => nodes(source))
    const row = bundle.documents[0].versions[0]
    expect(row.optionalAbsences).toEqual([{ path: 'books/challenges/one/starter.py', treeOID: row.treeOID }])
    expect(text(root, 'ls-tree', row.commit, '--', 'books/challenges/one/starter.py')).toBe('')
    put(root, source, document(':::run{starter="required.py"}\n:::\n', 'challenge')); commit(root, 'Explicit required dependency absent')
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(source)))).rejects.toThrow(/absent|required|render/i)
    symlinkSync('challenge.md', path.join(root, 'books/challenges/one/required.py'))
    // A dependency-only commit is intentionally absent from node --follow.
    put(root, source, document('New node revision.\n:::run{starter="required.py"}\n:::\n', 'challenge'))
    commit(root, 'A symlink cannot substitute for dependency bytes')
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(source)))).rejects.toThrow(/regular|type|symlink/i)
  })
})

describe('collector behavioral lifetime and framing controls', () => {
  it('expires every escaped snapshot read capability and rejects an asynchronous visitor', () => {
    const root = fixture(); let escaped: HistorySnapshot | undefined
    const hooks = { selection: captureGitSelection(root), extraInputs: [], gitCalls: 4096, checkInputs() {} }
    withBookHistorySnapshot(root, SITE, () => nodes(), {}, hooks, (_assets, reader) => { escaped = reader; return true })
    expect(() => escaped!.remaining()).toThrow(/expired/)
    expect(() => escaped!.tree(text(root, 'rev-parse', 'HEAD'))).toThrow(/expired/)
    expect(() => escaped!.blobs([])).toThrow(/expired/)
    expect(() => escaped!.head).toThrow(/expired/)
    expect(() => withBookHistorySnapshot(root, SITE, () => nodes(), {}, hooks, () => Promise.resolve('late'))).toThrow(/synchronous/)
  })

  it('refuses malformed batch headers, nonASCII framing, content OID mismatch and trailing bytes', async () => {
    const root = fixture(), collect = await api()
    for (const corruption of ['highbit-header', 'wrong-type', 'content', 'truncated', 'extra']) {
      vi.mocked(execFileSync).mockImplementation(((command: any, args: any, options: any) => {
        const output = realExec(command, args, options) as Buffer
        if (!args.includes('--batch')) return output
        const bytes = Buffer.from(output)
        if (corruption === 'highbit-header') { bytes[0] |= 0x80; return bytes }
        if (corruption === 'wrong-type') return Buffer.from(bytes.toString().replace(' blob ', ' tree '))
        if (corruption === 'content') { bytes[bytes.indexOf(10) + 1] ^= 1; return bytes }
        if (corruption === 'truncated') return bytes.subarray(0, bytes.length - 1)
        return Buffer.concat([bytes, Buffer.from('extra')])
      }) as typeof execFileSync)
      await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes())), corruption).rejects.toThrow(/batch|OID|Git/i)
      vi.mocked(execFileSync).mockImplementation(realExec)
    }
  })

  it('checks lower map and complete serialized bundle bounds before accepting output', async () => {
    const root = fixture(), collect = await api()
    vi.mocked(execFileSync).mockClear()
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(), { limits: { mapBytes: 1 } }))).rejects.toThrow(/bound/)
    expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => Array.isArray(args) && args.includes('--batch'))).toBe(false)
    const bundle = await collect(root, SITE, () => nodes())
    const size = Buffer.byteLength(JSON.stringify(bundle))
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(), { limits: { totalBytes: size - 1 } }))).rejects.toThrow(/aggregate|bound/)
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(), { limits: { gitCalls: 1 } }))).rejects.toThrow(/call bound/)
  })

  it('rejects fabricated absence, source binding and duplicate JSON members from a child', async () => {
    const root = fixture(), collect = await api()
    for (const corruption of ['unknown-absence', 'source', 'duplicate-json']) {
      vi.mocked(spawnSync).mockImplementation(((command: any, args: any, options: any) => {
        const child = realSpawn(command, args, options)
        let raw = (child.stdout as Buffer).toString('utf8')
        if (corruption === 'unknown-absence') raw = raw.replace('"optionalAbsences": []', '"optionalAbsences": ["books/challenges/ghost/starter.py"]')
        if (corruption === 'source') raw = raw.replace(/"sourceSha256": "[a-f0-9]+"/, `"sourceSha256": "${'0'.repeat(64)}"`)
        if (corruption === 'duplicate-json') raw = raw.replace('{"schemaVersion": 1,', '{"schemaVersion": 1, "schemaVersion": 1,')
        return { ...child, stdout: Buffer.from(raw) }
      }) as typeof spawnSync)
      await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes())), corruption).rejects.toThrow(/renderer|absence|shape|JSON/)
      vi.mocked(spawnSync).mockImplementation(realSpawn)
    }
  })

  it('uses only the owned child timeout with SIGKILL and reaps before refusing', async () => {
    const root = fixture(), collect = await api(); let pid = 0
    vi.mocked(spawnSync).mockImplementation(((command: any, args: any, options: any) => {
      expect(args.slice(0, 2)).toEqual(['-I', '-B'])
      expect(options.killSignal).toBe('SIGKILL')
      expect(options.timeout).toBeGreaterThan(0); expect(options.timeout).toBeLessThanOrEqual(15_000)
      expect(Object.keys(options.env).sort()).toEqual(['LANG', 'LC_ALL', 'PATH'])
      // Real owned child only; replace the expensive computation in this fixture.
      const child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { ...options, input: undefined, timeout: 50 })
      pid = child.pid
      expect(child.signal).toBe('SIGKILL')
      return child
    }) as typeof spawnSync)
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes()))).rejects.toThrow(/unavailable|bound/)
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('checks selector metadata again after a renderer wait', async () => {
    const root = fixture(), collect = await api(), config = path.join(root, '.git/config')
    vi.mocked(spawnSync).mockImplementation(((command: any, args: any, options: any) => {
      const child = realSpawn(command, args, options)
      writeFileSync(config, Buffer.concat([readFileSync(config), Buffer.from('\n# changed during renderer wait\n')]))
      return child
    }) as typeof spawnSync)
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes()))).rejects.toThrow(/drift|changed/)
  })

  it('never fills historical missing figures from another source or the current trusted renderer tree', async () => {
    expect(existsSync(path.join(ROOT, 'books/figures/two-biggest.json'))).toBe(true)
    const collect = await api()
    for (const source of ['books/chapters/one.md', 'challenges/one.md']) {
      const root = fixture(source, document(':::figure{id="two-biggest"}\n:::\n'))
      const current = source.startsWith('books/') ? source : 'books/chapters/one.md'
      if (current !== source) { mkdirSync(path.dirname(path.join(root, current)), { recursive: true }); git(root, 'mv', source, current); commit(root, 'Renamed source still lacks its figure') }
      await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(current)))).rejects.toThrow(/rendering unavailable/)
    }
  })
})


describe('collector complete-map and cross-source regressions', () => {
  it('counts repeated blob aliases per path before any batch content allocation', async () => {
    const root = fixture(), collect = await api()
    const bytes = readFileSync(path.join(root, 'books/chapters/one.md'))
    put(root, 'books/chapters/alias.md', bytes)
    // Include the alias in the node's actual version tree, not a later
    // dependency-only commit that authoritative --follow correctly omits.
    git(root, 'add', '-A'); git(root, 'commit', '--amend', '--no-edit', '-q')
    vi.mocked(execFileSync).mockClear()
    await expect(Promise.resolve().then(() => collect(root, SITE, () => nodes(), { limits: { mapBytes: bytes.length * 2 - 1 } }))).rejects.toThrow(/map bound/)
    expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => Array.isArray(args) && args.includes('--batch'))).toBe(false)
  })

  it('cannot fill an older missing dependency from a previously rendered different source', async () => {
    const root = fixture('books/chapters/one.md', document(':::figure{id="later-only"}\n:::\n'))
    put(root, 'books/chapters/two.md', document(Array.from({ length: 30 }, (_, i) => `A distinct second chapter paragraph ${i} about its own material.\n\n`).join('') + ':::figure{id="later-only"}\n:::\n', 'concept', 'two'))
    put(root, 'books/figures/later-only.json', JSON.stringify({ type: 'cells', values: [1], caption: 'Only the later source version has this figure' }))
    commit(root, 'Second source introduces the dependency, without changing the first')
    const collect = await api(), before = preserved(root)
    vi.mocked(spawnSync).mockClear()
    await expect(Promise.resolve().then(() => collect(root, SITE, () => [
      { book: 'fixture-book', node: 'two', path: '/books/fixture-book/two/', sourcePath: 'books/chapters/two.md' }, ...nodes(),
    ]))).rejects.toThrow(/rendering unavailable/)
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2)
    expect(preserved(root)).toEqual(before)
  })

  it('authenticates raw blob OIDs in a supported SHA256 fixture repository', async () => {
    const root = fixture('books/chapters/one.md', document('SHA256 source.\n'), 'sha256')
    const collect = await api(), result = await collect(root, SITE, () => nodes())
    const row = result.documents[0].versions[0]
    expect(row.commit).toHaveLength(64); expect(row.treeOID).toHaveLength(64)
    expect(row.sourceOID).toBe(text(root, 'rev-parse', `${row.commit}:${row.sourcePath}`))
    expect(row.sourceSha256).toBe(sha(git(root, 'cat-file', 'blob', row.sourceOID)))
  })
})

describe('optional absence excludes every occupied historical path', () => {
  for (const legacy of [false, true]) for (const included of [false, true]) {
    const label = `${legacy ? 'legacy' : 'current'} ${included ? 'included challenge' : 'source challenge'}`
    const prefix = legacy ? 'challenges/' : 'books/challenges/'
    const folder = `${prefix}${included ? 'included' : 'one'}`
    const source = included ? (legacy ? 'challenges/one.md' : 'books/chapters/one.md') : `${folder}/challenge.md`
    const current = included ? 'books/chapters/one.md' : 'books/challenges/one/challenge.md'
    const missing = `${folder}/starter.py`
    function setup(occupied: boolean | 'empty') {
      const root = fixture(source, document(included ? ':::problem{id="included"}\n:::\n' : ':::run\n:::\n', included ? 'concept' : 'challenge'))
      if (included) put(root, `${folder}/challenge.md`, document(':::statement\nIncluded statement.\n:::\n', 'challenge', 'included'))
      // A sibling with the same string prefix is not occupancy of starter.py.
      put(root, `${missing}.backup/retained.txt`, 'harmless sibling')
      if (occupied === true) put(root, `${missing}/nested/retained.txt`, 'harmless directory member')
      git(root, 'add', '-A'); git(root, 'commit', '--amend', '--no-edit', '-q')
      if (occupied === 'empty') emptyTreeVersion(root, source, missing)
      const old = text(root, 'rev-parse', 'HEAD')
      if (legacy) {
        mkdirSync(path.dirname(path.join(root, current)), { recursive: true })
        git(root, 'mv', source, current)
        if (included) {
          mkdirSync(path.join(root, 'books/challenges'), { recursive: true })
          git(root, 'mv', folder, 'books/challenges/included')
        }
        commit(root, 'Move source to canonical current mapping')
      }
      return { root, old }
    }
    for (const occupied of [true, 'empty'] as const) it(`refuses ${occupied === 'empty' ? 'empty tree' : 'directory'} occupancy as optional absence: ${label}`, async () => {
      const { root, old } = setup(occupied), collect = await api(), before = preserved(root)
      expect(text(root, 'cat-file', '-t', text(root, 'rev-parse', `${old}:${missing}`))).toBe('tree')
      // Current canonical :::problem renders the card, not the included run.
      // Exercise the shared decoder's included-read boundary with an inert
      // child-result claim; the direct source case uses unmodified output.
      if (included) vi.mocked(spawnSync).mockImplementation(((command: any, args: any, options: any) => {
        const child = realSpawn(command, args, options)
        const raw = (child.stdout as Buffer).toString('utf8')
        if (!raw.includes(JSON.stringify(`${folder}/challenge.md`))) return child
        return { ...child, stdout: Buffer.from(raw.replace('"optionalAbsences": []', `"optionalAbsences": [${JSON.stringify(missing)}]`)) }
      }) as typeof spawnSync)
      expect(() => collect(root, SITE, () => nodes(current))).toThrow(/absence lacks tree proof/)
      expect(preserved(root)).toEqual(before)
    })
    it(`retains actual absence and prefix siblings: ${label}`, async () => {
      const { root, old } = setup(false), collect = await api(), before = preserved(root)
      expect(text(root, 'ls-tree', old, '--', missing)).toBe('')
      const bundle = collect(root, SITE, () => nodes(current))
      const row = bundle.documents[0].versions.find((v: any) => v.commit === old)
      expect(row).toBeDefined()
      expect(row.dependencies.some((d: any) => d.path === `${folder}/challenge.md`)).toBe(true)
      expect(row.optionalAbsences).toEqual(included ? [] : [{ path: missing, treeOID: row.treeOID }])
      expect(preserved(root)).toEqual(before)
    })
  }
  it('exposes complete occupancy once while excluding directory OIDs from resource blobs', () => {
    const root = fixture(), empty = emptyTreeVersion(root, 'books/chapters/one.md', 'data/empty')
    vi.mocked(execFileSync).mockClear()
    collectBookHistories(root, SITE, () => nodes())
    expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => Array.isArray(args) && args.includes('ls-tree') && args.includes('-t'))).toBe(false)
    const hooks = { selection: captureGitSelection(root), extraInputs: [], gitCalls: 4096, checkInputs() {} }
    withBookHistorySnapshot(root, SITE, () => nodes(), {}, hooks, (_assets, snapshot) => {
      vi.mocked(execFileSync).mockClear()
      const tree = snapshot.tree(snapshot.head)
      expect(tree.occupied.has('data/empty')).toBe(true)
      expect(tree.occupied.has('data')).toBe(true)
      expect(tree.occupied.has('books/chapters/one.md')).toBe(true)
      expect(tree.entries.has('data/empty')).toBe(false)
      expect(tree.entries.has('data')).toBe(false)
      expect(() => snapshot.blobs([empty])).toThrow(/invalid historical blob selection/)
      const calls = vi.mocked(execFileSync).mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('ls-tree'))
      expect(calls).toHaveLength(1)
      expect(calls[0][1]).toContain('-t')
    })
  })
  it('refuses malformed complete-tree mode/type and object-format pairs', async () => {
    const root = fixture(), collect = await api()
    for (const replacement of ['040000 blob', '100644 tree', '160000 tree', 'short-oid']) {
      vi.mocked(execFileSync).mockImplementation(((command: any, args: any, options: any) => {
        const raw = realExec(command, args, options)
        if (!args.includes('ls-tree') || !args.includes('-t')) return raw
        const text = (raw as Buffer).toString('utf8')
        return Buffer.from(replacement === 'short-oid'
          ? text.replace(/(040000 tree )([a-f0-9]{40})/, (_, prefix, oid) => prefix + oid.slice(0, 39))
          : text.replace('040000 tree', replacement))
      }) as typeof execFileSync)
      expect(() => collect(root, SITE, () => nodes())).toThrow(/malformed.*tree/)
      vi.mocked(execFileSync).mockImplementation(realExec)
    }
  })
})


describe('bundled trusted renderer location', () => {
  it('uses the Astro source-root binding after relocation, never the caller tree or cwd', async () => {
    const { buildSync } = await import('esbuild')
    const config = (await import('../../astro.config')).default
    const source = 'books/chapters/one.md'
    const root = fixture(source, document('Actual bundled renderer prose.\n'))
    // Historical code is data, including a caller-tree renderer that must not run.
    put(root, 'books/tools/history_render.py', 'raise RuntimeError("CALLER_RENDERER_MUST_NOT_RUN")\n')
    commit(root, 'Caller renderer is untrusted data')
    const outputRoot = mkdtempSync(path.join(tmpdir(), 'relocated-history-bundle-'))
    roots.push(outputRoot)
    const output = path.join(outputRoot, 'dist/.prerender/chunks/books.mjs')
    mkdirSync(path.dirname(output), { recursive: true })
    buildSync({
      entryPoints: [path.join(ROOT, 'src/lib/book-history-rendered.ts')],
      outfile: output, bundle: true, platform: 'node', format: 'esm',
      target: 'node22', define: config.vite?.define ?? {},
      logLevel: 'silent',
    })
    const before = preserved(root)
    const code = `import { collectRenderedBookHistories } from ${JSON.stringify(pathToFileURL(output).href)};
      const result = collectRenderedBookHistories(${JSON.stringify(root)}, ${JSON.stringify(SITE)}, () => ${JSON.stringify(nodes(source))});
      console.log(JSON.stringify(result.documents[0].versions[0].render));`
    const run = realSpawn(process.execPath, ['--input-type=module', '-e', code], {
      // The historical checkout and cwd are both untrusted code locations.
      cwd: root, env: { PATH: '/usr/bin:/bin', CHALLENGES_PYTHON: '/usr/bin/python3', LANG: 'C.UTF-8' },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    })
    expect(run.error).toBeUndefined()
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const result = JSON.parse(run.stdout.toString())
    expect(result.html).toContain('Actual bundled renderer prose.')
    expect(result.sourceSha256).toBe(sha(readFileSync(path.join(root, source))))
    // Relocation must not weaken post-render lifetime checks. Only inert
    // metadata returned inside this owned child changes; no source is edited.
    const driftCode = `import fs from 'node:fs'; import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const stat = fs.lstatSync, spawn = cp.spawnSync; let rendered = false;
      fs.lstatSync = (...args) => { const value = stat(...args);
        if (rendered && String(args[0]) === ${JSON.stringify(path.join(ROOT, 'books/tools/history_render.py'))}) value.ino += 1;
        return value; };
      cp.spawnSync = (...args) => { const value = spawn(...args); rendered = true; return value; };
      syncBuiltinESMExports();
      const { collectRenderedBookHistories } = await import(${JSON.stringify(pathToFileURL(output).href)});
      try { collectRenderedBookHistories(${JSON.stringify(root)}, ${JSON.stringify(SITE)}, () => ${JSON.stringify(nodes(source))});
        console.log(JSON.stringify({unexpectedSuccess:true})); }
      catch (error) { console.log(JSON.stringify({message:error.message, rendered})); }`
    const drift = realSpawn(process.execPath, ['--input-type=module', '-e', driftCode], {
      cwd: root, env: { PATH: '/usr/bin:/bin', CHALLENGES_PYTHON: '/usr/bin/python3', LANG: 'C.UTF-8' },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    })
    expect(drift.status).toBe(0)
    expect(drift.stderr).toBe('')
    expect(JSON.parse(drift.stdout.toString())).toEqual({ message: 'trusted renderer input changed', rendered: true })
    // A bundle built without the trusted config binding must not fall back to
    // a convenient cwd, even when that cwd contains the genuine renderer.
    buildSync({ entryPoints: [path.join(ROOT, 'src/lib/book-history-rendered.ts')],
      outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' })
    const unbound = realSpawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT, env: { PATH: '/usr/bin:/bin', CHALLENGES_PYTHON: '/usr/bin/python3', LANG: 'C.UTF-8' },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    })
    expect(unbound.status).not.toBe(0)
    expect(unbound.stderr).toContain(path.join(outputRoot, 'dist/src'))
    expect(preserved(root)).toEqual(before)
  }, 30_000)
})
