/** Build-only historical data collection. No publication, browser trust or historical code execution. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { captureGitSelection } from '../../adapters/margin/local-source'
import { BookHistoryError, HISTORY_LIMITS, serializeBookHistory, withBookHistorySnapshot, type BookHistoryAsset, type HistoryNode, type HistorySnapshot, type HistoryTree } from './book-history'

export const RENDERED_HISTORY_LIMITS = Object.freeze({
  collectionMs: 120_000, commandMs: 15_000, gitCalls: 4096,
  mapFiles: 10_000, mapBytes: 64 * 1024 * 1024, inputBytes: 72 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024, nodeBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024,
})
type Limits = { [K in keyof typeof RENDERED_HISTORY_LIMITS]: number }
type Read = { path: string; mode: string; sha256: string }
type File = Read & { content: string }
type Render = { schemaVersion: 1; profile: 'node-content-readonly-v1'; sourcePath: string; sourceSha256: string; html: string; blocks: { kind: string; id: string; digest: string }[]; reads: Read[]; optionalAbsences: string[] }
type Live = { commit: string; deleted: false; treeOID: string; sourcePath: string; sourceOID: string; sourceSha256: string; dependencies: (Read & { oid: string })[]; optionalAbsences: { path: string; treeOID: string }[]; render: Render; renderSha256: string }
type Tombstone = { commit: string; sourcePath: string; deleted: true; render: null }
export type RenderedBookHistories = { schemaVersion: 1; site: string; buildCommit: string; rendererProfile: string; rendererFingerprint: string; rawAssets: BookHistoryAsset[]; documents: { document: string; rawHistorySha256: string; versions: (Live | Tombstone)[] }[] }
// Astro binds this literal from its trusted config before relocating chunks.
// Unbundled callers keep the module's fixed source root. Neither the caller's
// historical repository nor its cwd selects executable renderer code.
const TRUSTED_ROOT = (import.meta as ImportMeta & { BOOK_RENDERER_SOURCE_ROOT?: string }).BOOK_RENDERER_SOURCE_ROOT
  ?? fileURLToPath(new URL('../../', import.meta.url))
const TRUSTED_SOURCES = [
  'src/lib/book-history.ts', 'src/lib/book-history-rendered.ts',
  'adapters/margin/local-source.ts', 'adapters/margin/source-plan.ts', 'src/annotations/criticmarkup.ts',
  'books/tools/history_render.py', 'books/tools/render.py', 'books/tools/markdown.py',
] as const
const PROFILE = 'node-content-readonly-v1'
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function fail(message: string): never { throw new BookHistoryError(message) }
const utf8 = (bytes: Buffer): string => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return fail('historical data is not UTF8') }
}
function safePath(name: string): boolean {
  return typeof name === 'string' && Buffer.byteLength(name) <= 4096 && !/[\\\x00-\x1f\x7f]/.test(name) && !name.split('/').some(p => !p || p === '.' || p === '..')
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)))
}
function string(value: unknown): value is string {
  return typeof value === 'string' && Buffer.from(value).toString('utf8') === value
}
function identity(filename: string) {
  const s = lstatSync(filename)
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) fail('unsafe trusted renderer input')
  return { filename, dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, file: s.isFile() }
}
function pin(filename: string, limit: number) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) fail('invalid trusted input path')
  const chain: ReturnType<typeof identity>[] = []; let cursor = path.parse(filename).root
  chain.push(identity(cursor))
  for (const part of filename.slice(cursor.length).split('/')) { cursor = path.join(cursor, part); chain.push(identity(cursor)) }
  const leaf = chain.at(-1)!
  if (!leaf.file || leaf.size > limit) fail('trusted input size/type bound')
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer
  const check = () => {
    for (const old of chain) {
      const current = identity(old.filename)
      if (old.dev !== current.dev || old.ino !== current.ino || old.mode !== current.mode || (old.file && (old.size !== current.size || old.mtime !== current.mtime || old.ctime !== current.ctime))) fail('trusted renderer input changed')
    }
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== leaf.dev || opened.ino !== leaf.ino || opened.size !== leaf.size || opened.mode !== leaf.mode) fail('trusted input changed during open')
    const buffer = Buffer.alloc(leaf.size + 1); let count = 0
    while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n }
    const after = fstatSync(fd)
    if (count !== leaf.size || after.size !== leaf.size || after.mtimeMs !== leaf.mtime || after.ctimeMs !== leaf.ctime) fail('trusted input changed during read')
    bytes = buffer.subarray(0, count); check()
  } finally { closeSync(fd) }
  return { filename, digest: sha(bytes), check }
}
function pythonPath(): string {
  // Operator environment selects the current build runtime, never repository data.
  const command = process.env.CHALLENGES_PYTHON ?? 'python3'
  if (path.isAbsolute(command)) return realpathSync(command)
  if (!/^[A-Za-z0-9_.-]+$/.test(command) || command === '.' || command === '..') fail('invalid trusted Python command')
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue
    const candidate = path.join(directory, command)
    if (existsSync(candidate)) return realpathSync(candidate)
  }
  return fail('current Python runtime unavailable')
}
function boundedOptions(options: Partial<Limits>): Limits {
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(RENDERED_HISTORY_LIMITS, key) || !Number.isSafeInteger(value) || value! <= 0 || value! > RENDERED_HISTORY_LIMITS[key as keyof Limits]) fail('invalid rendered history resource limit')
  }
  return { ...RENDERED_HISTORY_LIMITS, ...options }
}
// The trusted Python CLI emits this exact JSON form. Reconstructing only after
// closed-shape validation also rejects duplicate keys and surplus JSON bytes.
function pythonJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJSON).join(', ')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pythonJSON(v)}`).join(', ')}}`
  return JSON.stringify(value)
}
function decodeRender(raw: Buffer, source: string, files: Map<string, File>, tree: HistoryTree): Render {
  let value: unknown
  try { value = JSON.parse(utf8(raw)) } catch { return fail('historical renderer JSON unavailable') }
  if (!shape(value, ['schemaVersion', 'profile', 'sourcePath', 'sourceSha256', 'html', 'blocks', 'reads', 'optionalAbsences']) || value.schemaVersion !== 1 || value.profile !== PROFILE || value.sourcePath !== source || value.sourceSha256 !== files.get(source)?.sha256 || !string(value.html) || !Array.isArray(value.blocks) || !Array.isArray(value.reads) || !Array.isArray(value.optionalAbsences)) fail('historical renderer result shape differs')
  const result = value as unknown as Render
  const seen = new Set<string>(); let last = ''
  for (const row of result.reads) {
    if (!shape(row, ['path', 'mode', 'sha256']) || !string(row.path) || !safePath(row.path) || row.path <= last || seen.has(row.path)) fail('historical renderer read ordering/shape differs')
    const item = files.get(row.path)
    if (!item || item.mode !== row.mode || item.sha256 !== row.sha256) fail('historical renderer read is outside supplied data')
    seen.add(row.path); last = row.path
  }
  if (!seen.has(source)) fail('historical renderer omitted source read')
  last = ''
  for (const missing of result.optionalAbsences) {
    if (!string(missing) || !safePath(missing) || missing <= last || !missing.endsWith('/starter.py') || !seen.has(missing.slice(0, -'starter.py'.length) + 'challenge.md') || tree.occupied.has(missing) || seen.has(missing)) fail('historical renderer absence lacks tree proof')
    last = missing
  }
  const matches = [...result.html.matchAll(/<div class="block" data-block-kind="([a-z-]+)" data-block-digest="([0-9a-f]+)" id="([^"]+)">/g)]
  if (matches.length !== result.blocks.length || result.blocks.some((row, index) => !shape(row, ['kind', 'id', 'digest']) || row.kind !== matches[index][1] || row.digest !== matches[index][2] || row.id !== matches[index][3])) fail('historical renderer block metadata differs')
  if (pythonJSON(result) + '\n' !== utf8(raw)) fail('historical renderer JSON is not the canonical complete result')
  return result
}
type DataMap = { tree: HistoryTree; files: Map<string, File>; serialized: string[]; cost: number }
function dataMap(snapshot: HistorySnapshot, commit: string, source: string, limits: Limits): DataMap {
  const tree = snapshot.tree(commit), legacy = source.startsWith('challenges/')
  if (!/^(?:books\/(?:chapters\/[a-z0-9-]+\.md|challenges\/[a-z0-9-]+\/challenge\.md)|challenges\/(?:[a-z0-9-]+\.md|[a-z0-9-]+\/challenge\.md))$/.test(source)) fail('unsupported historical source layout')
  const prefix = legacy ? 'challenges/' : 'books/challenges/'
  const selected = [...tree.entries].filter(([name]) => {
    if (legacy ? /^challenges\/[a-z0-9-]+\.md$/.test(name) || /^challenges\/figures\/[^/]+\.json$/.test(name) : /^books\/chapters\/[a-z0-9-]+\.md$/.test(name) || /^books\/figures\/[^/]+\.json$/.test(name)) return true
    if (!name.startsWith(prefix)) return false
    const rest = name.slice(prefix.length), slash = rest.indexOf('/')
    return slash > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rest.slice(0, slash)) && tree.entries.has(`${prefix}${rest.slice(0, slash)}/challenge.md`)
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (!selected.length || selected.length > limits.mapFiles) fail('historical data map file bound')
  for (const [name, item] of selected) if (!safePath(name) || !['100644', '100755'].includes(item.mode)) fail('historical data requires regular safe paths')
  const blobs = snapshot.blobs(selected.map(([, item]) => item.oid), limits.mapBytes)
  const files = new Map<string, File>(), serialized: string[] = []; let bytes = 0, encoded = 0
  for (const [name, item] of selected) {
    snapshot.remaining()
    const raw = blobs.get(item.oid)!, content = utf8(raw)
    bytes += raw.length
    if (bytes > limits.mapBytes) fail('historical map byte bound')
    const row = { path: name, mode: item.mode, sha256: sha(raw), content }, json = JSON.stringify(row)
    encoded += Buffer.byteLength(json) + 1
    if (encoded > limits.inputBytes) fail('historical encoded map byte bound')
    files.set(name, row); serialized.push(json)
  }
  let metadata = [...tree.entries].reduce((sum, [name, item]) => sum + Buffer.byteLength(name) + item.oid.length + item.mode.length + 64, 0)
  for (const name of tree.occupied) metadata += Buffer.byteLength(name) + 64
  return { tree, files, serialized, cost: bytes + encoded + metadata }
}

/** Input-size and checked-deadline bounded; synchronous parsing is not preemptive. */
export function collectRenderedBookHistories(
  root: string, site: string, loadNodes: (remainingMs: number) => readonly HistoryNode[],
  options: { expectedHead?: string; limits?: Partial<Limits> } = {},
): RenderedBookHistories {
  const limits = boundedOptions(options.limits ?? {}), deadline = performance.now() + limits.collectionMs
  const remaining = () => { const ms = Math.floor(deadline - performance.now()); if (ms <= 0) fail('rendered history deadline exceeded'); return ms }
  const pins = TRUSTED_SOURCES.map(name => pin(path.join(TRUSTED_ROOT, name), HISTORY_LIMITS.blobBytes))
  const python = pin(pythonPath(), 128 * 1024 * 1024)
  const checkInputs = () => { remaining(); for (const file of [...pins, python]) file.check() }
  const selection = captureGitSelection(realpathSync(root))
  const rendererFingerprint = sha(JSON.stringify({ profile: PROFILE, sources: TRUSTED_SOURCES.map((name, i) => [name, pins[i].digest]), python: python.digest }))
  const cache = new Map<string, DataMap>(); let cacheBytes = 0
  checkInputs()
  return withBookHistorySnapshot(root, site, loadNodes, {
    expectedHead: options.expectedHead,
    limits: { collectionMs: Math.min(HISTORY_LIMITS.collectionMs, remaining()), commandMs: limits.commandMs },
  }, { selection, extraInputs: TRUSTED_SOURCES, gitCalls: limits.gitCalls, checkInputs }, (rawAssets, snapshot) => {
    const documents: RenderedBookHistories['documents'] = []
    // Count the complete returned envelope, including its raw assets. The
    // extra comma allowance is conservative even for the first array item.
    let total = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, site, buildCommit: snapshot.head, rendererProfile: PROFILE, rendererFingerprint, rawAssets: [], documents: [] }))
    for (const asset of rawAssets) total += Buffer.byteLength(serializeBookHistory(asset))
    if (total > limits.totalBytes) fail('historical rendered result aggregate bound')
    for (const asset of rawAssets) {
      const header = { document: asset.document, rawHistorySha256: sha(serializeBookHistory(asset)) }
      const versions: (Live | Tombstone)[] = []
      let nodeBytes = Buffer.byteLength(JSON.stringify({ ...header, versions: [] })) + 1
      total += nodeBytes
      if (nodeBytes > limits.nodeBytes || total > limits.totalBytes) fail('historical rendered result aggregate bound')
      for (const version of asset.versions) {
        checkInputs(); selection.check(); snapshot.remaining()
        let result: Live | Tombstone
        if (version.deleted) result = { commit: version.commit, sourcePath: version.path, deleted: true, render: null }
        else {
          // Commit IDs are content-addressed; layout keeps renamed pools apart.
          const key = `${version.commit}:${version.path.startsWith('books/') ? 'books' : 'legacy'}`
          let map = cache.get(key)
          if (!map) {
            map = dataMap(snapshot, version.commit, version.path, limits)
            while (cache.size && cacheBytes + map.cost > limits.mapBytes) {
              const first = cache.keys().next().value!; cacheBytes -= cache.get(first)!.cost; cache.delete(first)
            }
            if (map.cost <= limits.mapBytes) { cache.set(key, map); cacheBytes += map.cost }
          }
          const source = map.files.get(version.path)
          if (!source || version.content === null || source.content !== version.content) fail('historical source differs from raw history')
          const prefix = `{"schemaVersion":1,"sourcePath":${JSON.stringify(version.path)},"files":[`
          const inputSize = Buffer.byteLength(prefix) + map.serialized.reduce((sum, row) => sum + Buffer.byteLength(row), 0) + Math.max(0, map.serialized.length - 1) + 2
          if (inputSize > limits.inputBytes) fail('historical renderer input byte bound')
          const input = Buffer.from(prefix + map.serialized.join(',') + ']}')
          checkInputs(); selection.check()
          const child = spawnSync(python.filename, ['-I', '-B', path.join(TRUSTED_ROOT, 'books/tools/history_render.py')], {
            cwd: TRUSTED_ROOT, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
            input, stdio: ['pipe', 'pipe', 'pipe'], timeout: Math.min(limits.commandMs, remaining(), snapshot.remaining()),
            killSignal: 'SIGKILL', maxBuffer: limits.outputBytes,
          })
          checkInputs(); selection.check(); snapshot.remaining()
          if (child.error || child.signal || child.status !== 0 || !Buffer.isBuffer(child.stdout) || !Buffer.isBuffer(child.stderr) || child.stdout.length > limits.outputBytes || child.stderr.length) fail('historical rendering unavailable or resource bound exceeded')
          const render = decodeRender(child.stdout, version.path, map.files, map.tree)
          result = { commit: version.commit, deleted: false, treeOID: map.tree.treeOID, sourcePath: version.path, sourceOID: map.tree.entries.get(version.path)!.oid, sourceSha256: source.sha256,
            dependencies: render.reads.map(row => ({ ...row, oid: map!.tree.entries.get(row.path)!.oid })),
            optionalAbsences: render.optionalAbsences.map(name => ({ path: name, treeOID: map!.tree.treeOID })), render, renderSha256: sha(child.stdout) }
        }
        const size = Buffer.byteLength(JSON.stringify(result)) + 1
        nodeBytes += size; total += size
        if (nodeBytes > limits.nodeBytes || total > limits.totalBytes) fail('historical rendered result aggregate bound')
        versions.push(result)
      }
      documents.push({ ...header, versions })
    }
    checkInputs(); selection.check()
    return { schemaVersion: 1, site, buildCommit: snapshot.head, rendererProfile: PROFILE, rendererFingerprint, rawAssets, documents }
  })
}
