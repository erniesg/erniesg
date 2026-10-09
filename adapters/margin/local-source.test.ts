import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatHunks } from '../../src/annotations/criticmarkup'
import { createHash } from 'node:crypto'

vi.mock('node:child_process', async importOriginal => { const actual = await importOriginal<typeof import('node:child_process')>(); return { ...actual, spawn: vi.fn(actual.spawn) } })
const roots: string[] = []
const cleanEnv = { PATH: '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
function fixture(current = 'old\nkeep\nchanged\n') {
  const root = mkdtempSync(join(tmpdir(), 'margin-plan-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 })
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repo, env: cleanEnv, encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  const sourcePath = 'books/chapters/intro.md'; mkdirSync(join(repo, 'books/chapters'), { recursive: true, mode: 0o700 })
  writeFileSync(join(repo, sourcePath), 'old\nkeep\nlast\n'); git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, sourcePath), current); git('add', '.'); git('commit', '-qm', 'current'); const head = git('rev-parse', 'HEAD')
  const scratch = join(root, 'scratch'); mkdirSync(scratch, { mode: 0o700 })
  const data = { repoRoot: repo, scratchRoot: scratch, expectedHead: head, snapshot: { site: 'https://ernie.sg', document: 'https://ernie.sg/books/test/intro/', revision: 1, baseCommit: base, sourcePath, body: formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '{~~old~>new~~}\n' }]) }, mapping: { site: 'https://ernie.sg', head, documents: [{ document: 'https://ernie.sg/books/test/intro/', sourcePath }] } }
  return { root, repo, git, sourcePath, scratch, data }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('local read-only source planning', () => {
  it('rebases cleanly without modifying source/index/refs/unrelated dirty work', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); writeFileSync(join(f.repo, 'unrelated'), 'preserve')
    const before = [readFileSync(join(f.repo, f.sourcePath)), readFileSync(join(f.repo, '.git/index')), f.git('show-ref')]
    const result = await planLocalApprovedSource(f.data)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') throw Error('not planned')
    expect(Buffer.from(result.proposedBytes).toString()).toBe('new\nkeep\nchanged\n')
    expect(result.rebased).toBe(true)
    expect([readFileSync(join(f.repo, f.sourcePath)), readFileSync(join(f.repo, '.git/index')), f.git('show-ref')]).toEqual(before)
    expect(readFileSync(join(f.repo, 'unrelated'), 'utf8')).toBe('preserve')
    expect(readdirSync(f.scratch)).toEqual([])
  })
  it('distinguishes completed merge conflict from dirty selected source', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture('other\nkeep\nlast\n')
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'conflict', reason: 'merge-conflict' })
    writeFileSync(join(f.repo, f.sourcePath), 'dirty\n')
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'not_evaluated', reason: 'selected-source-dirty' })
    expect(readFileSync(join(f.repo, f.sourcePath), 'utf8')).toBe('dirty\n')
    expect(readdirSync(f.scratch)).toEqual([])
  })
})

describe('local authority and preservation boundaries', () => {
  it('uses no caller repository code or ambient Node/Git configuration', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const other = fixture('different\nkeep\nlast\n')
    mkdirSync(join(f.repo, 'adapters/margin'), { recursive: true })
    writeFileSync(join(f.repo, 'adapters/margin/source-plan.ts'), 'throw Error("caller module must not execute")')
    for (const [key, value] of Object.entries({ GIT_DIR: join(other.repo, '.git'), GIT_WORK_TREE: other.repo, GIT_INDEX_FILE: join(other.repo, '.git/index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other.repo, NODE_OPTIONS: '--require=/nonexistent/private-loader.cjs', NODE_PATH: other.repo, TSX_TSCONFIG_PATH: '/nonexistent/tsconfig.json' })) vi.stubEnv(key, value)
    const r = await planLocalApprovedSource(f.data)
    expect(r.status).toBe('planned')
    expect(readFileSync(join(other.repo, other.sourcePath), 'utf8')).toBe('different\nkeep\nlast\n')
    const calls = vi.mocked(spawn).mock.calls
    expect(calls.every(c => c[2]?.env?.NODE_OPTIONS === undefined)).toBe(true)
    expect(calls.every(c => c[2]?.env?.GIT_DIR === undefined)).toBe(true)
  })
  it.each(['staged', 'unmerged', 'symlink', 'dirty', 'mode'] as const)('holds selected %s state and preserves its bytes/index', async kind => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture()
    if (kind === 'staged') { writeFileSync(join(f.repo, f.sourcePath), 'stage\n'); f.git('add', f.sourcePath) }
    if (kind === 'unmerged') {
      const oid = f.git('rev-parse', `HEAD:${f.sourcePath}`)
      execFileSync('/usr/bin/git', ['update-index', '--index-info'], { cwd: f.repo, env: cleanEnv, input: `0 ${'0'.repeat(40)}\t${f.sourcePath}\n100644 ${oid} 1\t${f.sourcePath}\n100644 ${oid} 2\t${f.sourcePath}\n` })
    }
    if (kind === 'symlink') { rmSync(join(f.repo, f.sourcePath)); symlinkSync('/nonexistent/held', join(f.repo, f.sourcePath)) }
    if (kind === 'dirty') writeFileSync(join(f.repo, f.sourcePath), 'dirty\n')
    if (kind === 'mode') chmodSync(join(f.repo, f.sourcePath), 0o755)
    const index = readFileSync(join(f.repo, '.git/index')); const refs = f.git('show-ref')
    const result = await planLocalApprovedSource(f.data)
    expect(result.status).toBe('not_evaluated')
    expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index); expect(f.git('show-ref')).toBe(refs)
    expect(readdirSync(f.scratch)).toEqual([])
  })
  it.each(['shallow', 'promisor', 'graft', 'alternate', 'include'] as const)('holds incomplete or unsupported %s metadata', async kind => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture()
    if (kind === 'shallow') writeFileSync(join(f.repo, '.git/shallow'), f.data.expectedHead + '\n')
    if (kind === 'promisor') f.git('config', 'remote.fixture.promisor', 'true')
    if (kind === 'graft') writeFileSync(join(f.repo, '.git/info/grafts'), '')
    if (kind === 'alternate') writeFileSync(join(f.repo, '.git/objects/info/alternates'), '/not-read\n')
    if (kind === 'include') f.git('config', 'include.path', join(f.root, 'absent-config'))
    const result = await planLocalApprovedSource(f.data)
    expect(result.status).toBe('not_evaluated'); expect(readdirSync(f.scratch)).toEqual([])
  })
  it('separates missing object from known nonancestor and missing source', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture()
    const original = f.data.snapshot.baseCommit
    f.data.snapshot.baseCommit = f.git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated-root')
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'refused', reason: 'base-not-ancestor' })
    f.data.snapshot.baseCommit = 'e'.repeat(40)
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'not_evaluated', reason: 'base-inspection-failed' })
    f.data.snapshot.baseCommit = original
    f.git('rm', f.sourcePath); f.git('commit', '-qm', 'delete')
    f.data.expectedHead = f.data.mapping.head = f.git('rev-parse', 'HEAD')
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'refused', reason: 'source-missing-or-moved' })
  })
  it('binds direct base and does not infer conflict from literal markers', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture()
    f.data.snapshot.baseCommit = f.data.expectedHead
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'planned', rebased: false })
  })
  it('refuses an in-repository or nonprivate scratch directory', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const nested = join(f.repo, 'scratch'); mkdirSync(nested, { mode: 0o700 })
    expect(await planLocalApprovedSource({ ...f.data, scratchRoot: nested })).toMatchObject({ status: 'not_evaluated', reason: 'unsafe-scratch' })
    chmodSync(f.scratch, 0o755)
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'not_evaluated', reason: 'unsafe-scratch' })
  })
  it('kills and reaps only the owned converter on deadline and removes owned temporary files', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); let owned: ReturnType<typeof spawn> | undefined
    let started!: () => void; const ready = new Promise<void>(r => { started = r })
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      if (Array.isArray(args) && args.includes('--input-type=module')) {
        owned = actual.spawn(process.execPath, ['-e', 'process.stdin.resume();setTimeout(()=>{},60000)'], options ?? {})
        started(); return owned
      }
      return actual.spawn(file, args as string[], options ?? {})
    }) as typeof spawn)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const promise = planLocalApprovedSource(f.data); await ready
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await promise).toMatchObject({ status: 'not_evaluated', reason: 'deadline' })
    expect(owned?.signalCode).toBe('SIGKILL'); expect(readdirSync(f.scratch)).toEqual([])
    expect(readFileSync(join(f.repo, f.sourcePath), 'utf8')).toBe('old\nkeep\nchanged\n')
  })
})

describe('bounded failure classification and read witnesses', () => {
  it.each(['merge-fatal', 'converter-overflow', 'stderr-overflow', 'tool-absent'] as const)('does not turn %s into an evaluated conflict', async failure => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture()
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      const argv = args as string[]
      if (failure === 'tool-absent') return actual.spawn('/nonexistent/margin-test-tool', [], options ?? {})
      if (failure === 'merge-fatal' && argv.includes('merge-file')) return actual.spawn(process.execPath, ['-e', 'process.exit(255)'], options ?? {})
      if (argv.includes('--input-type=module') && failure.endsWith('overflow')) return actual.spawn(process.execPath, ['-e', failure === 'converter-overflow' ? 'process.stdin.resume();process.stdout.write(Buffer.alloc(9*1024*1024));' : 'process.stdin.resume();process.stderr.write(Buffer.alloc(300*1024));'], options ?? {})
      return actual.spawn(file, argv, options ?? {})
    }) as typeof spawn)
    const r = await planLocalApprovedSource(f.data)
    expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('detail'); expect(r).not.toHaveProperty('proposedBytes')
    expect(readdirSync(f.scratch)).toEqual([])
  })
  it('copies supplied snapshot/mapping data before asynchronous inspection', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); let changed = false
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      if (!changed) { changed = true; f.data.snapshot.body = 'later current body'; f.data.snapshot.sourcePath = '../../outside'; f.data.mapping.documents.length = 0 }
      return actual.spawn(file, args as string[], options ?? {})
    }) as typeof spawn)
    const r = await planLocalApprovedSource(f.data)
    expect(r.status).toBe('planned')
    if (r.status !== 'planned') throw Error('not planned')
    expect(Buffer.from(r.proposedBytes).toString()).toBe('new\nkeep\nchanged\n')
  })
  it('holds final source drift and preserves an unexpected scratch entry', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); let heldPath = ''
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      if ((args as string[]).includes('--input-type=module')) {
        const cwd = options?.cwd as string
        heldPath = join(cwd, 'not-owned'); writeFileSync(heldPath, 'preserve')
        writeFileSync(join(f.repo, f.sourcePath), 'concurrent source edit\n')
      }
      return actual.spawn(file, args as string[], options ?? {})
    }) as typeof spawn)
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'not_evaluated', reason: 'temp-cleanup-failed' })
    expect(readFileSync(heldPath, 'utf8')).toBe('preserve')
    expect(readFileSync(join(f.repo, f.sourcePath), 'utf8')).toBe('concurrent source edit\n')
  })
  it('retains explicit source-drift classification when temp cleanup succeeds', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture()
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      if ((args as string[]).includes('--input-type=module')) writeFileSync(join(f.repo, f.sourcePath), 'concurrent source edit\n')
      return actual.spawn(file, args as string[], options ?? {})
    }) as typeof spawn)
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'not_evaluated', reason: 'inspection-drift' })
    expect(readdirSync(f.scratch)).toEqual([])
  })
  it('supports a Git-managed linked worktree without touching the original worktree', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const linked = join(f.root, 'linked')
    f.git('worktree', 'add', '--detach', linked, f.data.expectedHead)
    const index = readFileSync(join(f.repo, '.git/index')); const refs = f.git('show-ref')
    const r = await planLocalApprovedSource({ ...f.data, repoRoot: linked })
    expect(r.status).toBe('planned'); expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index); expect(f.git('show-ref')).toBe(refs)
  })
  it('does not spawn on import or invoke transport/writing Git commands during a normal plan', async () => {
    vi.resetModules(); vi.mocked(spawn).mockClear()
    const { planLocalApprovedSource } = await import('./local-source')
    expect(spawn).not.toHaveBeenCalled()
    const f = fixture(); expect((await planLocalApprovedSource(f.data)).status).toBe('planned')
    const gitCommands = vi.mocked(spawn).mock.calls.filter(c => String(c[0]).endsWith('/git')).map(c => c[1] as string[])
    expect(gitCommands.length).toBeLessThanOrEqual(16)
    const allowed = ['rev-parse', 'config', 'merge-base', 'ls-tree', 'cat-file', 'ls-files', 'merge-file']
    expect(gitCommands.every(args => allowed.some(command => args.includes(command)))).toBe(true)
  })
})

it('rejects HEAD drift without undoing the concurrent fixture change', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const { planLocalApprovedSource } = await import('./local-source')
  const f = fixture()
  vi.mocked(spawn).mockImplementation(((file, args, options) => {
    if ((args as string[]).includes('--input-type=module')) f.git('update-ref', 'HEAD', f.data.snapshot.baseCommit)
    return actual.spawn(file, args as string[], options ?? {})
  }) as typeof spawn)
  expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'not_evaluated', reason: 'head-drift' })
  expect(f.git('rev-parse', 'HEAD')).toBe(f.data.snapshot.baseCommit)
  expect(readdirSync(f.scratch)).toEqual([])
})

describe('complete Git selection and partial-clone metadata lifetime', () => {
  it.each(['filter-only', 'promisor-pack'] as const)('holds %s even with all selected objects present', async kind => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture()
    if (kind === 'filter-only') f.git('config', 'remote.fixture.partialclonefilter', 'blob:none')
    else writeFileSync(join(f.repo, '.git/objects/pack/pack-fixture.promisor'), '')
    const index = readFileSync(join(f.repo, '.git/index'))
    expect((await planLocalApprovedSource(f.data)).status).toBe('not_evaluated')
    expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index)
  })
  it('binds the linked .git entry before the first asynchronous metadata read', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const first = join(f.root, 'first'); const second = join(f.root, 'second')
    f.git('worktree', 'add', '--detach', first, f.data.expectedHead); f.git('worktree', 'add', '--detach', second, f.data.snapshot.baseCommit)
    const other = readFileSync(join(second, '.git')); let changed = false
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      const child = actual.spawn(file, args as string[], options ?? {})
      if (!changed && (args as string[]).includes('--show-toplevel')) { changed = true; child.once('close', () => writeFileSync(join(first, '.git'), other)) }
      return child
    }) as typeof spawn)
    const r = await planLocalApprovedSource({ ...f.data, repoRoot: first })
    expect(changed).toBe(true); expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('proposedBytes')
    expect(readFileSync(join(first, '.git'))).toEqual(other)
  })
  it('binds commondir bytes across the converter wait', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const linked = join(f.root, 'linked'); const other = join(f.root, 'other-common')
    f.git('worktree', 'add', '--detach', linked, f.data.expectedHead); cpSync(join(f.repo, '.git'), other, { recursive: true })
    const gitdir = readFileSync(join(linked, '.git'), 'utf8').trim().slice('gitdir: '.length); let changed = false
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      if (!changed && (args as string[]).includes('--input-type=module')) { changed = true; writeFileSync(join(gitdir, 'commondir'), other + '\n') }
      return actual.spawn(file, args as string[], options ?? {})
    }) as typeof spawn)
    const r = await planLocalApprovedSource({ ...f.data, repoRoot: linked })
    expect(changed).toBe(true); expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('proposedBytes')
  })
  it.each(['commondir', 'promisor-pack', 'worktree-config'] as const)('retains initial %s absence across waits', async kind => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const other = join(f.root, 'other-common'); cpSync(join(f.repo, '.git'), other, { recursive: true })
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      if ((args as string[]).includes('--input-type=module')) {
        const path = kind === 'commondir' ? join(f.repo, '.git/commondir') : kind === 'promisor-pack' ? join(f.repo, '.git/objects/pack/pack-late.promisor') : join(f.repo, '.git/config.worktree')
        writeFileSync(path, kind === 'commondir' ? other + '\n' : '')
      }
      return actual.spawn(file, args as string[], options ?? {})
    }) as typeof spawn)
    const r = await planLocalApprovedSource(f.data)
    expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('proposedBytes')
  })
})

describe('selection-closure shape sweep', () => {
  it.each(['pack-absence', 'backpointer-absence', 'config-absence', 'backpointer-change'] as const)('holds %s changes during asynchronous computation', async kind => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); let repo = f.repo; let metadata = join(repo, '.git')
    if (kind === 'backpointer-change') { repo = join(f.root, 'linked'); f.git('worktree', 'add', '--detach', repo, f.data.expectedHead); metadata = readFileSync(join(repo, '.git'), 'utf8').trim().slice(8) }
    if (kind === 'pack-absence') rmSync(join(metadata, 'objects/pack'), { recursive: true })
    if (kind === 'config-absence') rmSync(join(metadata, 'config'))
    let changed = false
    vi.mocked(spawn).mockImplementation(((file, args, options) => {
      if (!changed && (args as string[]).includes('--input-type=module')) {
        changed = true
        if (kind === 'pack-absence') mkdirSync(join(metadata, 'objects/pack'))
        else if (kind === 'config-absence') writeFileSync(join(metadata, 'config'), '[core]\nrepositoryformatversion = 0\n')
        else writeFileSync(join(metadata, 'gitdir'), join(f.root, 'other-entry') + '\n')
      }
      return actual.spawn(file, args as string[], options ?? {})
    }) as typeof spawn)
    const r = await planLocalApprovedSource({ ...f.data, repoRoot: repo })
    expect(changed).toBe(true); expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('proposedBytes')
  })
  it('allows stable absent pack directory in an otherwise complete loose-object repository', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); rmSync(join(f.repo, '.git/objects/pack'), { recursive: true })
    expect((await planLocalApprovedSource(f.data)).status).toBe('planned')
  })
  it('keeps pack enumeration bounded with an inclusive4096-member positive', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const pack = join(f.repo, '.git/objects/pack')
    for (let i = 0; i < 4096; i++) writeFileSync(join(pack, `fixture-${i}`), '')
    expect((await planLocalApprovedSource(f.data)).status).toBe('planned')
    writeFileSync(join(pack, 'one-too-many'), '')
    expect(await planLocalApprovedSource(f.data)).toMatchObject({ status: 'not_evaluated', reason: 'pack-membership-limit' })
  })
  it.each(['symlink-pack', 'regular-pack', 'symlink-selector', 'malformed-selector'] as const)('refuses unreadable or unsupported %s without a usable result', async kind => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const pack = join(f.repo, '.git/objects/pack')
    if (kind === 'symlink-pack') { rmSync(pack, { recursive: true }); symlinkSync(f.scratch, pack) }
    if (kind === 'regular-pack') { rmSync(pack, { recursive: true }); writeFileSync(pack, '') }
    if (kind === 'symlink-selector') symlinkSync(join(f.root, 'unavailable'), join(f.repo, '.git/commondir'))
    if (kind === 'malformed-selector') writeFileSync(join(f.repo, '.git/commondir'), Buffer.from([0xff]))
    const r = await planLocalApprovedSource(f.data); expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('proposedBytes')
  })
})

const publicContext = () => ({ version: 1 as const, publicCorrelation: { version: 1 as const, value: '1'.repeat(64) } })
const blobOID = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

describe('public source identity initial behavior', () => {
  it('attaches opaque metadata to the exact actual post-merge source plan', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const r = await planLocalApprovedSource({ ...f.data, publicContext: publicContext() } as Parameters<typeof planLocalApprovedSource>[0])
    expect(r.status).toBe('planned')
    if (r.status !== 'planned') throw Error('source unavailable')
    const value = (r as typeof r & { publicSource?: unknown }).publicSource
    expect(value).toMatchObject({ version: 1, intent: 'source-change', repository: 'erniesg/erniesg', node: 'intro',
      branch: `coordinator/margin-proposal-${'1'.repeat(64)}`, title: 'Margin proposal for intro',
      content: { parent: f.data.expectedHead, mode: '100644', path: f.sourcePath, currentBlob: r.currentBlob,
        proposedBlob: blobOID(r.proposedBytes), proposedSha256: r.proposedSha256, proposedBytes: r.proposedBytes.length } })
    expect(Buffer.from(r.proposedBytes).toString()).toBe('new\nkeep\nchanged\n')
  })
  it('refuses explicit null before any child command', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); vi.mocked(spawn).mockClear()
    expect(await planLocalApprovedSource({ ...f.data, publicContext: null } as unknown as Parameters<typeof planLocalApprovedSource>[0])).toEqual({ status: 'refused', reason: 'invalid-public-context' })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('refuses a noncanonical correlation before any child command', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); vi.mocked(spawn).mockClear()
    expect(await planLocalApprovedSource({ ...f.data, publicContext: { version: 1, publicCorrelation: { version: 1, value: 'A'.repeat(64) } } } as Parameters<typeof planLocalApprovedSource>[0])).toEqual({ status: 'refused', reason: 'invalid-public-context' })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('refuses another site for public metadata without restricting the default source planner', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); f.data.snapshot.site = f.data.mapping.site = 'https://elsewhere.invalid'
    f.data.snapshot.document = f.data.mapping.documents[0].document = 'https://elsewhere.invalid/books/test/intro/'
    expect((await planLocalApprovedSource(f.data)).status).toBe('planned')
    expect(await planLocalApprovedSource({ ...f.data, publicContext: publicContext() } as Parameters<typeof planLocalApprovedSource>[0])).toEqual({ status: 'refused', reason: 'unsupported-public-target' })
  })
  it('captures option and context before returning the first pending promise', async () => {
    const { planLocalApprovedSource } = await import('./local-source')
    const f = fixture(); const option = publicContext()
    const pending = planLocalApprovedSource({ ...f.data, publicContext: option } as Parameters<typeof planLocalApprovedSource>[0])
    option.publicCorrelation.value = '2'.repeat(64)
    f.data.snapshot.document = f.data.mapping.documents[0].document = 'https://ernie.sg/books/changed/other/'
    f.data.snapshot.body = 'changed after dispatch'
    const r = await pending
    expect(r.status).toBe('planned')
    expect(r).toMatchObject({ publicSource: { document: 'https://ernie.sg/books/test/intro/', node: 'intro', branch: `coordinator/margin-proposal-${'1'.repeat(64)}` } })
  })
})

describe('public metadata lifetime and default parity', () => {
  it.each([
    ['array', []], ['extra', { ...publicContext(), observed: {} }], ['version', { ...publicContext(), version: 2 }],
    ['nested-extra', { version: 1, publicCorrelation: { ...publicContext().publicCorrelation, privateId: 'private' } }],
    ['boxed', { version: 1, publicCorrelation: { version: 1, value: new String('1'.repeat(64)) } }],
    ['oversized', { version: 1, publicCorrelation: { version: 1, value: '1'.repeat(100_000) } }],
    ['symbol-key', { ...publicContext(), [Symbol('extra')]: 1 }], ['inherited', Object.create(publicContext())],
  ])('refuses %s before commands', async (_name, value) => {
    const { planLocalApprovedSource } = await import('./local-source'); const f = fixture(); vi.mocked(spawn).mockClear()
    expect(await planLocalApprovedSource({ ...f.data, publicContext: value } as unknown as Parameters<typeof planLocalApprovedSource>[0])).toEqual({ status: 'refused', reason: 'invalid-public-context' })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('never invokes option getters, serializers or a late read of the original', async () => {
    const { planLocalApprovedSource } = await import('./local-source'); const f = fixture()
    const getter = vi.fn(() => '1'.repeat(64)), bad = { version: 1, publicCorrelation: { version: 1 } }
    Object.defineProperty(bad.publicCorrelation, 'value', { enumerable: true, get: getter })
    expect(await planLocalApprovedSource({ ...f.data, publicContext: bad } as unknown as Parameters<typeof planLocalApprovedSource>[0])).toEqual({ status: 'refused', reason: 'invalid-public-context' }); expect(getter).not.toHaveBeenCalled()
    const option = publicContext(); const pending = planLocalApprovedSource({ ...f.data, publicContext: option })
    Object.defineProperty(option.publicCorrelation, 'value', { get() { throw Error('late original read') } })
    expect(await pending).toMatchObject({ status: 'planned', publicSource: { branch: `coordinator/margin-proposal-${'1'.repeat(64)}` } })
  })
  it('omitted and undefined opt-in never load the new helper', async () => {
    vi.resetModules(); vi.doMock('./public-source-identity', () => { throw Error('default must not import public helper') })
    try {
      const { planLocalApprovedSource } = await import('./local-source'); const f = fixture()
      const first = await planLocalApprovedSource(f.data); expect(first.status).toBe('planned')
      expect(await planLocalApprovedSource({ ...f.data, publicContext: undefined })).toEqual(first)
    } finally { vi.doUnmock('./public-source-identity'); vi.resetModules() }
  })
  it('preserves original result and exact child calls under explicit opt-in', async () => {
    const { planLocalApprovedSource } = await import('./local-source'); const f = fixture()
    const trace = () => vi.mocked(spawn).mock.calls.map(([file, args, options]) => ({ file,
      args: (args as string[]).map(arg => arg.replace(/margin-source-[^/]+/g, 'margin-source-OWNED')),
      cwd: String(options?.cwd).replace(/margin-source-[^/]+/g, 'margin-source-OWNED'),
      env: Object.fromEntries(Object.entries(options?.env ?? {}).map(([key, value]) => [key, value?.replace(/margin-source-[^/]+/g, 'margin-source-OWNED')])) }))
    vi.mocked(spawn).mockClear(); const original = await planLocalApprovedSource(f.data), originalTrace = trace()
    vi.mocked(spawn).mockClear(); const optin = await planLocalApprovedSource({ ...f.data, publicContext: publicContext() })
    expect(optin.status).toBe('planned'); if (optin.status !== 'planned') throw Error('source unavailable')
    const { publicSource, ...same } = optin
    expect(publicSource).toBeDefined(); expect(same).toEqual(original); expect(trace()).toEqual(originalTrace)
    expect(readdirSync(f.scratch)).toEqual([])
  })
  it('attaches no-op after the actual merge and preserves source/index/refs', async () => {
    const { planLocalApprovedSource } = await import('./local-source'); const f = fixture()
    f.data.snapshot.body = formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: 'old\n' }])
    const before = [readFileSync(join(f.repo, f.sourcePath)), readFileSync(join(f.repo, '.git/index')), f.git('show-ref')]
    const r = await planLocalApprovedSource({ ...f.data, publicContext: publicContext() })
    expect(r).toMatchObject({ status: 'planned', changed: false, publicSource: { intent: 'no-op' } })
    if (r.status !== 'planned') throw Error('source unavailable')
    expect(r.publicSource?.content.proposedBlob).toBe(r.currentBlob)
    expect([readFileSync(join(f.repo, f.sourcePath)), readFileSync(join(f.repo, '.git/index')), f.git('show-ref')]).toEqual(before)
  })
  it('does not attach metadata to an actual merge conflict', async () => {
    const { planLocalApprovedSource } = await import('./local-source'); const f = fixture('other\nkeep\nlast\n')
    const r = await planLocalApprovedSource({ ...f.data, publicContext: publicContext() })
    expect(r.status).toBe('conflict'); expect(r).not.toHaveProperty('publicSource')
  })
  it.each(['100644', '100755'])('binds actual regular mode %s', async mode => {
    const { planLocalApprovedSource } = await import('./local-source'); const f = fixture()
    chmodSync(join(f.repo, f.sourcePath), mode === '100755' ? 0o755 : 0o644)
    f.git('add', f.sourcePath); f.git('commit', '--allow-empty', '-qm', 'fixture mode')
    f.data.expectedHead = f.data.mapping.head = f.git('rev-parse', 'HEAD')
    expect(await planLocalApprovedSource({ ...f.data, publicContext: publicContext() })).toMatchObject({ status: 'planned', publicSource: { content: { mode } } })
  })
  it.each([
    ['BOM/CRLF', '\ufeffold\r\nlast', '\ufeff{~~old~>new~~}\r\n', '\ufeffnew\r\nlast'],
    ['no final newline', 'old', '{~~old~>new~~}', 'new'],
    ['Unicode', 'old\n', '{~~old~>新しい~~}\n', '新しい\n'],
  ])('binds actual %s Git bytes without normalization', async (_label, base, markup, expected) => {
    const { planLocalApprovedSource } = await import('./local-source'); const f = fixture()
    writeFileSync(join(f.repo, f.sourcePath), base); f.git('add', f.sourcePath); f.git('commit', '-qm', 'fixture bytes')
    f.data.expectedHead = f.data.mapping.head = f.data.snapshot.baseCommit = f.git('rev-parse', 'HEAD')
    f.data.snapshot.body = formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: markup }])
    const r = await planLocalApprovedSource({ ...f.data, publicContext: publicContext() })
    expect(r).toMatchObject({ status: 'planned', publicSource: { content: { proposedBlob: blobOID(Buffer.from(expected)), proposedBytes: Buffer.byteLength(expected) } } })
    if (r.status !== 'planned') throw Error('source unavailable')
    expect(Buffer.from(r.proposedBytes)).toEqual(Buffer.from(expected))
  })
  it.each(['head', 'source', 'index', 'cleanup'] as const)('retains final %s refusal after metadata derivation', async kind => {
    const actual = await vi.importActual<typeof import('./public-source-identity')>('./public-source-identity'); const f = fixture()
    vi.resetModules(); vi.doMock('./public-source-identity', () => ({ ...actual, bindPublicSource: (...args: Parameters<typeof actual.bindPublicSource>) => {
      const value = actual.bindPublicSource(...args)
      if (kind === 'head') f.git('update-ref', 'HEAD', f.data.snapshot.baseCommit)
      if (kind === 'source') writeFileSync(join(f.repo, f.sourcePath), 'concurrent edit\n')
      if (kind === 'index') { writeFileSync(join(f.repo, f.sourcePath), 'concurrent staged edit\n'); f.git('add', f.sourcePath) }
      if (kind === 'cleanup') writeFileSync(join(f.scratch, readdirSync(f.scratch)[0], 'unexpected'), 'preserve')
      return value
    } }))
    try {
      const { planLocalApprovedSource } = await import('./local-source')
      const r = await planLocalApprovedSource({ ...f.data, publicContext: publicContext() })
      expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('publicSource')
      if (kind === 'cleanup') expect(r).toMatchObject({ reason: 'temp-cleanup-failed' })
    } finally { vi.doUnmock('./public-source-identity'); vi.resetModules() }
  })
  it('counts dynamic import and final binding inside the same absolute deadline', async () => {
    const { performance } = await import('node:perf_hooks')
    const actual = await vi.importActual<typeof import('./public-source-identity')>('./public-source-identity')
    for (const phase of ['import', 'binding'] as const) {
      const f = fixture(), start = performance.now(); vi.resetModules(); vi.mocked(spawn).mockClear()
      vi.doMock('./public-source-identity', () => {
        if (phase === 'import') vi.spyOn(performance, 'now').mockReturnValue(start + 30_000)
        return { ...actual, bindPublicSource: (...args: Parameters<typeof actual.bindPublicSource>) => {
          const value = actual.bindPublicSource(...args)
          if (phase === 'binding') vi.spyOn(performance, 'now').mockReturnValue(start + 30_000)
          return value
        } }
      })
      try {
        const { planLocalApprovedSource } = await import('./local-source')
        expect(await planLocalApprovedSource({ ...f.data, publicContext: publicContext() })).toEqual({ status: 'not_evaluated', reason: 'deadline' })
        if (phase === 'import') expect(spawn).not.toHaveBeenCalled()
      } finally { vi.restoreAllMocks(); vi.doUnmock('./public-source-identity'); vi.resetModules() }
    }
  })
})
