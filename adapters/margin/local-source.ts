/** Local, read-only evidence and byte planning. This is not an approval or publication executor. */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, opendirSync, readSync, realpathSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { LIMITS, decodeSource, resolveDocument, sha256, type ContextData, type Failure, type Prepared } from './source-plan'

export type LocalInput = ContextData & { repoRoot: string; scratchRoot: string }
export type LocalPlan = Failure | ({ status: 'conflict'; reason: 'merge-conflict'; detail: string }) | (Omit<Prepared, 'status'> & { status: 'planned'; baseBlob: string; currentBlob: string; mode: string })
class Hold extends Error { constructor(readonly reason: string, readonly status: Failure['status'] = 'not_evaluated') { super(reason) } }
const env = (cwd: string): NodeJS.ProcessEnv => ({ GIT_CEILING_DIRECTORIES: cwd, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', TSX_DISABLE_CACHE: '1' })
const gitFlags = ['--no-replace-objects', '--literal-pathspecs', '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'credential.helper=', '-c', 'diff.external=']
type Identity = { path: string; dev: number; ino: number; mode: number; size: number; mtimeMs: number; ctimeMs: number }
function identity(path: string): Identity {
  const s = lstatSync(path)
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw new Hold('unsafe-path')
  return { path, dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }
}
function same(a: Identity, b: Identity): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function chain(path: string): Identity[] {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Hold('unsafe-path')
  const paths: string[] = []; let cursor = path
  for (;;) { paths.push(cursor); if (cursor === dirname(cursor)) break; cursor = dirname(cursor) }
  return paths.reverse().map((p, i) => { const id = identity(p); if (i < paths.length - 1 && (id.mode & 0o170000) !== 0o040000) throw new Hold('unsafe-path'); return id })
}
function assertChain(entries: Identity[], exact = false): void {
  for (const entry of entries) {
    const now = identity(entry.path)
    // Directory child creation elsewhere is not a change of this directory's identity.
    if (exact || (entry.mode & 0o170000) === 0o100000) { if (!same(entry, now)) throw new Hold('inspection-drift') }
    else if (entry.dev !== now.dev || entry.ino !== now.ino || entry.mode !== now.mode) throw new Hold('inspection-drift')
  }
}
function readRegular(path: string, limit: number): { bytes: Buffer; witness: Identity[] } {
  const witness = chain(path); const before = witness[witness.length - 1]
  if ((before.mode & 0o170000) !== 0o100000 || before.size > limit) throw new Hold('file-limit-or-type')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.mode !== before.mode) throw new Hold('inspection-drift')
    const bytes = Buffer.alloc(before.size + 1); let total = 0
    while (total < bytes.length) { const n = readSync(fd, bytes, total, bytes.length - total, total); if (!n) break; total += n }
    const after = fstatSync(fd)
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Hold('inspection-drift')
    assertChain(witness)
    return { bytes: bytes.subarray(0, total), witness }
  } finally { closeSync(fd) }
}
function absent(path: string): void {
  try { lstatSync(path); throw new Hold('unsupported-repository-metadata') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
type OptionalFile = { path: string; value?: ReturnType<typeof readRegular>; absentParents?: Identity[] }
function missingParents(path: string): Identity[] {
  let parent = dirname(path)
  for (;;) {
    try { const parents = chain(parent); absent(path); return parents }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) throw error; parent = dirname(parent) }
  }
}
function optionalFile(path: string): OptionalFile {
  try { return { path, value: readRegular(path, LIMITS.metadataBytes) } }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { path, absentParents: missingParents(path) }
  }
}
function checkFile(file: OptionalFile): void {
  if (file.value) {
    assertChain(file.value.witness)
    if (!readRegular(file.path, LIMITS.metadataBytes).bytes.equals(file.value.bytes)) throw new Hold('inspection-drift')
  } else { assertChain(file.absentParents!); absent(file.path) }
}
function pointer(bytes: Buffer): string {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!/^[^\0\r\n]+\n?$/.test(value) || !Buffer.from(value).equals(bytes)) throw new Hold('unsupported-git-pointer')
  return value.replace(/\n$/, '')
}
const MAX_PACK_ENTRIES = 4096
function packMembership(path: string): { witness: Identity[]; names: string[] } | { absentParents: Identity[] } {
  let witness: Identity[]
  try { witness = chain(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { absentParents: missingParents(path) }
  }
  const leaf = witness[witness.length - 1]
  if ((leaf.mode & 0o170000) !== 0o040000) throw new Hold('unsafe-pack-directory')
  const directory = opendirSync(path); const names: string[] = []; let bytes = 0
  try {
    for (;;) {
      const entry = directory.readSync(); if (!entry) break
      // Iterate rather than materializing unbounded directory membership first.
      if (names.length >= MAX_PACK_ENTRIES) throw new Hold('pack-membership-limit')
      bytes += Buffer.byteLength(entry.name) + 1
      if (bytes > LIMITS.metadataBytes) throw new Hold('pack-membership-limit')
      if (entry.name.endsWith('.promisor')) throw new Hold('incomplete-pack-metadata')
      names.push(entry.name)
    }
  } finally { directory.closeSync() }
  assertChain(witness)
  if (!same(leaf, identity(path))) throw new Hold('inspection-drift')
  return { witness, names: names.sort() }
}

/** Capture every supported Git selector before the first asynchronous Git read. */
function captureGitSelection(repo: string) {
  const entry = join(repo, '.git'); const entryChain = chain(entry)
  const entryFile = (entryChain[entryChain.length - 1].mode & 0o170000) === 0o100000 ? optionalFile(entry) : undefined
  let gitdir = entry
  if (entryFile) {
    if (!entryFile.value) throw new Hold('git-entry-missing')
    const value = pointer(entryFile.value.bytes)
    if (!value.startsWith('gitdir: ') || value.length === 8) throw new Hold('unsupported-git-pointer')
    gitdir = resolve(repo, value.slice(8))
  }
  const gitChain = chain(gitdir)
  if ((gitChain[gitChain.length - 1].mode & 0o170000) !== 0o040000) throw new Hold('unsafe-git-directory')
  const commonPointer = optionalFile(join(gitdir, 'commondir'))
  const common = commonPointer.value ? resolve(gitdir, pointer(commonPointer.value.bytes)) : gitdir
  const commonChain = chain(common)
  if ((commonChain[commonChain.length - 1].mode & 0o170000) !== 0o040000) throw new Hold('unsafe-git-directory')
  const backPointer = optionalFile(join(gitdir, 'gitdir'))
  if (backPointer.value && resolve(gitdir, pointer(backPointer.value.bytes)) !== entry) throw new Hold('git-selection-mismatch')
  const selectors = [commonPointer, backPointer, optionalFile(join(gitdir, 'HEAD')), ...(entryFile ? [entryFile] : [])]
  const configs = [optionalFile(join(common, 'config')), optionalFile(join(gitdir, 'config.worktree'))]
  if (configs.some(c => c.value && /^\s*\[\s*include(?:if)?\b/im.test(c.value.bytes.toString('utf8')))) throw new Hold('unsupported-config-includes')
  const unsupported = ['info/grafts', 'objects/info/alternates', 'objects/info/http-alternates', 'shallow'].map(name => optionalFile(join(common, name)))
  if (unsupported.some(f => f.value)) throw new Hold('unsupported-repository-metadata')
  const packPath = join(common, 'objects/pack'); const pack = packMembership(packPath)
  const check = () => {
    assertChain(entryChain); assertChain(gitChain); assertChain(commonChain)
    for (const file of [...selectors, ...configs, ...unsupported]) checkFile(file)
    if ('absentParents' in pack) { assertChain(pack.absentParents); absent(packPath) }
    else {
      assertChain(pack.witness)
      if (!same(pack.witness[pack.witness.length - 1], identity(packPath))) throw new Hold('inspection-drift')
      const now = packMembership(packPath)
      if (!('names' in now) || JSON.stringify(now.names) !== JSON.stringify(pack.names)) throw new Hold('inspection-drift')
    }
  }
  check()
  return { gitdir, common, check }
}

function pinned(path: string): { path: string; witness: Identity[]; digest: string } {
  const actual = realpathSync(path); const witness = chain(actual); const before = witness[witness.length - 1]
  if ((before.mode & 0o170000) !== 0o100000 || before.size > 128 * 1024 * 1024) throw new Hold('runtime-limit-or-type')
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.dev !== before.dev || s.ino !== before.ino) throw new Hold('runtime-drift')
    const hash = createHash('sha256'); const chunk = Buffer.alloc(64 * 1024); let count = 0
    for (;;) { const n = readSync(fd, chunk, 0, chunk.length, count); if (!n) break; count += n; if (count > before.size) throw new Hold('runtime-drift'); hash.update(chunk.subarray(0, n)) }
    if (count !== before.size) throw new Hold('runtime-drift')
    assertChain(witness)
    return { path: actual, witness, digest: hash.digest('hex') }
  } finally { closeSync(fd) }
}
function assertPin(pin: ReturnType<typeof pinned>): void {
  assertChain(pin.witness)
  if (pinned(pin.path).digest !== pin.digest) throw new Hold('runtime-drift')
}

/** Spawn only our direct child; kill/reap it before returning on timeout or overflow. No shell. */
async function run(binary: string, args: string[], cwd: string, input: Buffer, deadline: number, cap: number, commandMs: number): Promise<{ code: number; out: Buffer }> {
  const remaining = Math.min(commandMs, deadline - performance.now())
  if (remaining <= 0) throw new Hold('deadline')
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd, env: env(cwd), stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []; let bytes = 0; let errors = 0; let reason: string | undefined
    const stop = (why: string) => { reason ??= why; child.kill('SIGKILL') }
    const timer = setTimeout(() => stop('deadline'), remaining)
    child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > cap) stop('output-limit'); else chunks.push(data) })
    child.stderr.on('data', (data: Buffer) => { errors += data.length; if (errors > LIMITS.metadataBytes) stop('output-limit') })
    child.stdin.on('error', () => { /* EPIPE is classified by the reaped exit below. */ })
    child.on('error', () => { reason ??= 'tool-unavailable' })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (reason || signal || code === null) reject(new Hold(reason ?? 'tool-failed'))
      else if (performance.now() >= deadline) reject(new Hold('deadline'))
      else accept({ code, out: Buffer.concat(chunks) })
    })
    child.stdin.end(input)
  })
}

export async function planLocalApprovedSource(input: LocalInput): Promise<LocalPlan> {
  const deadline = performance.now() + LIMITS.totalMs
  let temp: string | undefined; let tempWitness: Identity[] | undefined; const ownedFiles: Identity[][] = []; let result: LocalPlan
  try {
    const context = resolveDocument(input)
    if ('status' in context) return context
    if (typeof input.repoRoot !== 'string' || typeof input.scratchRoot !== 'string') throw new Hold('invalid-local-context', 'refused')
    const repo = resolve(input.repoRoot); const scratch = resolve(input.scratchRoot)
    if (repo !== input.repoRoot || scratch !== input.scratchRoot || realpathSync(repo) !== repo || realpathSync(scratch) !== scratch) throw new Hold('unsafe-path')
    const repoChain = chain(repo); const scratchChain = chain(scratch); const scratchStat = lstatSync(scratch)
    if (!scratchStat.isDirectory() || scratchStat.uid !== process.getuid?.() || (scratchStat.mode & 0o777) !== 0o700 || !relative(repo, scratch).startsWith(`..${sep}`) && relative(repo, scratch) !== '..') throw new Hold('unsafe-scratch')
    const git = pinned('/usr/bin/git'); const node = pinned(process.execPath)
    const require = createRequire(import.meta.url)
    const loader = pinned(require.resolve('tsx/esm/api'))
    const module = pinned(fileURLToPath(new URL('./source-plan.ts', import.meta.url)))
    const converter = pinned(fileURLToPath(new URL('../../src/annotations/criticmarkup.ts', import.meta.url)))
    const selection = captureGitSelection(repo)
    const bindingArgs = [`--git-dir=${selection.gitdir}`, `--work-tree=${repo}`]
    let calls = 0
    const command = async (args: string[], cap = LIMITS.metadataBytes, data = Buffer.alloc(0)) => {
      if (++calls > LIMITS.gitCalls) throw new Hold('git-call-limit')
      selection.check(); assertPin(git)
      const result = await run(git.path, [...gitFlags, ...bindingArgs, ...args], repo, data, deadline, cap, LIMITS.commandMs)
      selection.check()
      return result
    }
    const checked = async (args: string[], cap?: number) => { const r = await command(args, cap); if (r.code !== 0) throw new Hold('git-inspection-failed'); return r.out }
    const metadata = (await checked(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-object-format', '--is-shallow-repository'])).toString('utf8').trimEnd().split('\n')
    if (metadata.length !== 5 || metadata[0] !== repo || resolve(repo, metadata[1]) !== selection.gitdir || resolve(repo, metadata[2]) !== selection.common || metadata[4] !== 'false' || metadata[3] !== (context.expectedHead.length === 40 ? 'sha1' : 'sha256')) throw new Hold('incomplete-or-mismatched-repository')
    const partial = await command(['config', '--null', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$'])
    if (partial.code !== 1 || partial.out.length) throw new Hold('partial-or-unknown-repository')
    const head = async () => { const value = (await checked(['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim(); if (value !== context.expectedHead) throw new Hold('head-drift') }
    await head()
    const ancestor = await command(['merge-base', '--is-ancestor', context.snapshot.baseCommit, context.expectedHead])
    if (ancestor.code === 1) throw new Hold('base-not-ancestor', 'refused')
    if (ancestor.code !== 0) throw new Hold('base-inspection-failed')
    const sourcePath = context.snapshot.sourcePath
    const blob = async (commit: string) => {
      const raw = await checked(['ls-tree', '-lz', commit, '--', sourcePath])
      if (!raw.length) throw new Hold('source-missing-or-moved', 'refused')
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+)\t([^\0]+)\0$/.exec(raw.toString('utf8'))
      if (!match || match[4] !== sourcePath) throw new Hold('unsupported-source-entry', 'refused')
      const size = Number(match[3]); if (!Number.isSafeInteger(size) || size > LIMITS.sourceBytes) throw new Hold('source-limit')
      const bytes = await checked(['cat-file', 'blob', match[2]], LIMITS.sourceBytes)
      if (bytes.length !== size || match[2].length !== context.expectedHead.length) throw new Hold('blob-size-mismatch')
      const objectId = createHash(context.expectedHead.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if (objectId !== match[2]) throw new Hold('blob-identity-mismatch')
      return { mode: match[1], oid: match[2], bytes }
    }
    const base = await blob(context.snapshot.baseCommit); const current = await blob(context.expectedHead)
    const staged = async () => {
      const index = await checked(['ls-files', '--stage', '-z', '--', sourcePath])
      if (index.toString('utf8') !== `${current.mode} ${current.oid} 0\t${sourcePath}\0`) throw new Hold('selected-source-dirty')
    }
    await staged()
    const selected = readRegular(join(repo, sourcePath), LIMITS.sourceBytes)
    if (!selected.bytes.equals(current.bytes) || ((lstatSync(join(repo, sourcePath)).mode & 0o111) !== 0) !== (current.mode === '100755')) throw new Hold('selected-source-dirty')
    temp = mkdtempSync(join(scratch, 'margin-source-'))
    const tempChain = chain(temp); tempWitness = tempChain
    const payload = Buffer.from(JSON.stringify({ ...context, base64: base.bytes.toString('base64'), current64: current.bytes.toString('base64') }))
    if (payload.length > LIMITS.outputBytes) throw new Hold('input-limit')
    const launcher = `import {register} from ${JSON.stringify(pathToFileURL(loader.path).href)};const unregister=register({tsconfig:false});const {planApprovedSource}=await import(${JSON.stringify(pathToFileURL(module.path).href)});let chunks=[];for await(const c of process.stdin)chunks.push(c);const p=JSON.parse(Buffer.concat(chunks).toString());const r=planApprovedSource({...p,baseBytes:Buffer.from(p.base64,'base64'),currentBytes:Buffer.from(p.current64,'base64')});if('proposedBytes'in r){r.proposed64=Buffer.from(r.proposedBytes).toString('base64');delete r.proposedBytes;}process.stdout.write(JSON.stringify(r));await unregister();`
    assertPin(node); assertPin(loader); assertPin(module); assertPin(converter)
    const child = await run(node.path, ['--input-type=module', '-e', launcher], temp, payload, deadline, LIMITS.outputBytes, LIMITS.totalMs)
    selection.check()
    if (child.code !== 0) throw new Hold('converter-failed')
    const raw = JSON.parse(child.out.toString('utf8'))
    let prepared: Prepared
    if (raw.status === 'refused' || raw.status === 'not_evaluated') result = raw as Failure
    else {
      if (raw.status !== 'planned' && raw.status !== 'needs_merge' || typeof raw.proposed64 !== 'string') throw new Hold('converter-output-invalid')
      const { proposed64, ...rest } = raw
      prepared = { ...rest, proposedBytes: Buffer.from(proposed64, 'base64') } as Prepared
      decodeSource(prepared.proposedBytes)
      if (prepared.status === 'needs_merge') {
        assertChain(tempChain)
        const files = [join(temp, 'current'), join(temp, 'base'), join(temp, 'approved')]
        for (const [index, bytes] of [current.bytes, base.bytes, prepared.proposedBytes].entries()) { assertChain(tempChain); writeFileSync(files[index], bytes, { flag: 'wx', mode: 0o600 }); ownedFiles.push(chain(files[index])) }
        if (++calls > LIMITS.gitCalls) throw new Hold('git-call-limit')
        assertPin(git)
        const merged = await run(git.path, [...gitFlags, 'merge-file', '-p', '--diff3', '-L', 'current', '-L', 'base', '-L', 'approved', '--', ...files], temp, Buffer.alloc(0), deadline, LIMITS.outputBytes, LIMITS.commandMs)
        selection.check()
        if (merged.code >= 1 && merged.code <= 127) result = { status: 'conflict', reason: 'merge-conflict', detail: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(merged.out) }
        else if (merged.code !== 0) throw new Hold('merge-tool-failed')
        else {
          decodeSource(merged.out)
          prepared = { ...prepared, proposedBytes: merged.out, proposedSha256: sha256(merged.out), changed: !merged.out.equals(current.bytes) }
          result = { ...prepared, status: 'planned', baseBlob: base.oid, currentBlob: current.oid, mode: current.mode }
        }
      } else result = { ...prepared, status: 'planned', baseBlob: base.oid, currentBlob: current.oid, mode: current.mode }
    }
    await head(); await staged()
    assertChain(repoChain); assertChain(scratchChain); assertChain(selected.witness); assertChain(tempChain)
    for (const pin of [git, node, loader, module, converter]) assertPin(pin)
    selection.check()
    if (performance.now() >= deadline) throw new Hold('deadline')
  } catch (error) { result = error instanceof Hold ? { status: error.status, reason: error.reason } : { status: 'not_evaluated', reason: 'local-inspection-failed' } }
  finally {
    if (temp) {
      try {
        if (!tempWitness) throw new Hold('temp-identity-missing')
        assertChain(tempWitness)
        const expected = new Set(ownedFiles.map(w => w[w.length - 1].path))
        if (readdirSync(temp).some(name => !expected.has(join(temp!, name)))) throw new Hold('unexpected-temp-entry')
        for (const witness of ownedFiles) assertChain(witness)
        for (const witness of ownedFiles) { assertChain(tempWitness); assertChain(witness); unlinkSync(witness[witness.length - 1].path) }
        assertChain(tempWitness); rmdirSync(temp)
      } catch { result = { status: 'not_evaluated', reason: 'temp-cleanup-failed' } }
    }
  }
  return result!
}
