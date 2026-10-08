/** Site-owned, build-time Git history. No service data or historical code runs.
 * `message` deliberately projects %s, never commit bodies/trailers or emails.
 * Git's default --follow traversal is authoritative, including omitted merges.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { captureGitSelection } from '../../adapters/margin/local-source'

export type HistoryNode = {
  book: string
  node: string
  path: string
  sourcePath: string
}
export type HistoryVersion = {
  commit: string
  author: string
  date: string
  message: string
  path: string
  change: string
  deleted: boolean
  content: string | null
}
export type BookHistoryAsset = {
  schemaVersion: 1
  site: string
  document: string
  book: string
  node: string
  buildCommit: string
  sourcePath: string
  versions: HistoryVersion[]
}
export const HISTORY_LIMITS = Object.freeze({
  versions: 10_000,
  blobBytes: 2 * 1024 * 1024,
  commandBytes: 32 * 1024 * 1024,
  nodeBytes: 64 * 1024 * 1024,
  assetBytes: 256 * 1024 * 1024,
  commandMs: 15_000,
  collectionMs: 120_000,
})
type Limits = { [K in keyof typeof HISTORY_LIMITS]: number }
export class BookHistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BookHistoryError'
  }
}
const FIXED_INPUTS = [
  'books/tools/manifest.py',
  'books/tools/render.py',
  'src/lib/books.ts',
  'src/lib/book-history.ts',
  'src/consts.ts',
  'src/pages/books/[book]/[node]/history.json.ts',
]
const inputPath = (name: string) =>
  FIXED_INPUTS.includes(name) ||
  /^books\/[^/]+\.toml$/.test(name) ||
  /^books\/tools\/[^/]+\.py$/.test(name) ||
  /^books\/chapters\/[^/]+\.md$/.test(name) ||
  /^books\/challenges\/[^/]+\/challenge\.md$/.test(name)
const sourcePath = (name: string) =>
  /^books\/chapters\/[^/]+\.md$/.test(name) ||
  /^books\/challenges\/[^/]+\/challenge\.md$/.test(name)
const oid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
function fail(message: string): never {
  throw new BookHistoryError(message)
}
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
function text(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch {
    return fail('history input is not valid UTF8')
  }
}
function relative(name: string): string {
  if (
    !name ||
    name.startsWith('/') ||
    /[\0\\]/.test(name) ||
    name.split('/').some((p) => !p || p === '.' || p === '..')
  )
    fail('invalid history path')
  return name
}
function fields(bytes: Buffer): string[] {
  const value = text(bytes)
  if (!value.endsWith('\0')) return fail('incomplete Git NUL record')
  return value.slice(0, -1).split('\0')
}

export type HistorySelection = { gitdir: string; common: string; check(): void }
type SnapshotHooks = { selection: HistorySelection; extraInputs: readonly string[]; gitCalls: number; checkInputs(): void }
export type HistoryTree = { treeOID: string; entries: ReadonlyMap<string, { mode: string; oid: string }>; occupied: ReadonlySet<string> }
export type HistorySnapshot = {
  readonly head: string
  remaining(): number
  tree(commit: string): HistoryTree
  blobs(oids: readonly string[], byteLimit?: number): Map<string, Buffer>
}

class LocalHistory {
  readonly limits: Limits
  readonly deadline: number
  readonly root: string
  readonly env: NodeJS.ProcessEnv
  constructor(root: string, limits: Partial<Limits> = {}, readonly hooks?: SnapshotHooks, deadline?: number) {
    this.root = realpathSync(root)
    for (const [key, value] of Object.entries(limits)) {
      if (
        !Object.hasOwn(HISTORY_LIMITS, key) ||
        !Number.isSafeInteger(value) ||
        value! <= 0 ||
        value! > HISTORY_LIMITS[key as keyof Limits]
      )
        fail('invalid history resource limit')
    }
    this.limits = { ...HISTORY_LIMITS, ...limits }
    this.deadline = deadline ?? performance.now() + this.limits.collectionMs
    this.env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    )
    Object.assign(this.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    })
  }
  private calls = 0
  remaining(): number {
    const left = Math.floor(this.deadline - performance.now())
    if (left <= 0) fail('history collection time bound exceeded')
    return left
  }
  git(
    args: string[],
    missingConfig = false,
    maxBuffer = this.limits.commandBytes,
    input?: Buffer,
  ): Buffer {
    this.hooks?.selection.check()
    this.hooks?.checkInputs()
    if (this.hooks && ++this.calls > this.hooks.gitCalls) fail('history Git call bound exceeded')
    try {
      const result = execFileSync(
        this.hooks ? '/usr/bin/git' : 'git',
        [
          ...(this.hooks ? [`--git-dir=${this.hooks.selection.gitdir}`, `--work-tree=${this.root}`, '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'] : []),
          '--no-replace-objects',
          '--literal-pathspecs',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'log.showSignature=false',
          '-c',
          'i18n.logOutputEncoding=UTF-8',
          ...args,
        ],
        {
          cwd: this.root,
          env: this.env,
          stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          ...(input === undefined ? {} : { input }),
          ...(this.hooks ? { killSignal: 'SIGKILL' as const } : {}),
          timeout: Math.min(this.remaining(), this.limits.commandMs),
          maxBuffer,
        },
      )
      this.hooks?.selection.check()
      this.hooks?.checkInputs()
      return result
    } catch (error) {
      this.hooks?.selection.check()
      this.hooks?.checkInputs()
      if (missingConfig && (error as { status?: number }).status === 1)
        return Buffer.alloc(0)
      return fail(
        `history Git ${args[0]} failed or exceeded its resource bound`,
      )
    }
  }
  head(): string {
    const head = text(
      this.git(['rev-parse', '--verify', 'HEAD^{commit}']),
    ).trim()
    if (!oid(head)) fail('invalid history HEAD')
    return head
  }
  complete(): void {
    if (text(this.git(['rev-parse', '--show-toplevel'])).trim() !== this.root)
      fail('history repository root differs from configured root')
    if (
      text(this.git(['rev-parse', '--is-shallow-repository'])).trim() !==
      'false'
    )
      fail('history requires a complete non-shallow checkout')
    if (
      this.git(
        [
          'config',
          '--get-regexp',
          '^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$',
        ],
        true,
      ).length
    )
      fail('history refuses partial/promisor configuration')
    const common = text(
      this.git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ).trim()
    if (!path.isAbsolute(common)) fail('Git common directory unavailable')
    if (this.hooks && common !== this.hooks.selection.common) fail('history Git selection differs')
    const pack = path.join(common, 'objects/pack')
    if (
      existsSync(pack) &&
      readdirSync(pack).some((p) => p.endsWith('.promisor'))
    )
      fail('history refuses promisor packs')
    if (existsSync(path.join(common, 'info/grafts')))
      fail('history refuses grafted ancestry')
  }
  tree(
    commit: string,
    names: string[] = [],
    includeTrees = false,
  ): Map<string, { mode: string; oid: string }> {
    const raw = this.git([
      'ls-tree',
      '-r',
      ...(includeTrees ? ['-t'] : []),
      '-z',
      '--full-tree',
      commit,
      ...(names.length ? ['--', ...names] : []),
    ])
    const result = new Map<string, { mode: string; oid: string }>()
    if (!raw.length) return result
    for (const row of fields(raw)) {
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(
        row,
      )
      if (!match || !oid(match[3]) || result.has(match[4]))
        fail('malformed Git tree')
      if (includeTrees && (
        match[3].length !== commit.length ||
        !((match[2] === 'tree' && match[1] === '040000') ||
          (match[2] === 'blob' && ['100644', '100755', '120000'].includes(match[1])) ||
          (match[2] === 'commit' && match[1] === '160000'))
      )) fail('malformed historical tree object type')
      result.set(relative(match[4]), { mode: match[1], oid: match[3] })
    }
    return result
  }
  blob(
    commit: string,
    name: string,
    item?: { mode: string; oid: string },
  ): Buffer {
    const object = item ?? this.tree(commit, [name]).get(name)
    if (!object || !['100644', '100755'].includes(object.mode))
      return fail(`history requires regular tracked blob ${name}`)
    const sizeText = text(this.git(['cat-file', '-s', object.oid])).trim()
    if (
      !/^\d+$/.test(sizeText) ||
      !Number.isSafeInteger(Number(sizeText)) ||
      Number(sizeText) > this.limits.blobBytes
    )
      fail(`history blob bytes bound exceeded: ${name}`)
    const bytes = this.git(
      ['show', '--no-ext-diff', '--no-textconv', `${commit}:${name}`],
      false,
      Math.min(this.limits.commandBytes, this.limits.blobBytes + 1),
    )
    if (bytes.length !== Number(sizeText)) fail('history blob size changed')
    return bytes
  }
  inputs(head: string): string {
    this.remaining()
    const selectedInput = (name: string) => inputPath(name) || Boolean(this.hooks?.extraInputs.includes(name))
    const names = new Set([...FIXED_INPUTS, ...(this.hooks?.extraInputs ?? [])])
    const addFiles = (dir: string, suffix: string) => {
      const location = path.join(this.root, dir)
      if (existsSync(location))
        for (const name of readdirSync(location))
          if (name.endsWith(suffix)) names.add(`${dir}/${name}`)
    }
    addFiles('books', '.toml')
    addFiles('books/tools', '.py')
    addFiles('books/chapters', '.md')
    const challenges = path.join(this.root, 'books/challenges')
    if (existsSync(challenges))
      for (const name of readdirSync(challenges)) {
        const dir = path.join(challenges, name)
        if (lstatSync(dir).isSymbolicLink())
          fail('history mapping contains a symlink')
        if (
          lstatSync(dir).isDirectory() &&
          existsSync(path.join(dir, 'challenge.md'))
        )
          names.add(`books/challenges/${name}/challenge.md`)
      }
    if (names.size > HISTORY_LIMITS.versions)
      fail('history input membership bound exceeded')
    const tree = this.tree(head),
      expected = [...tree.keys()].filter(selectedInput).sort()
    if (JSON.stringify([...names].sort()) !== JSON.stringify(expected))
      fail('history input membership differs from HEAD')
    const staged = this.git(['ls-files', '--stage', '-z'])
    const index = new Map<string, string>()
    for (const record of fields(staged)) {
      const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
      if (!match) fail('malformed Git index')
      if (!selectedInput(match[4])) continue
      if (match[3] !== '0' || index.has(match[4]))
        fail('history inputs have an unresolved index')
      index.set(match[4], `${match[1]}:${match[2]}`)
    }
    if (index.size !== expected.length)
      fail('history index membership differs from HEAD')
    const witness: string[] = []
    for (const name of expected) {
      const item = tree.get(name)!
      if (index.get(name) !== `${item.mode}:${item.oid}`)
        fail(`history input staged changes: ${name}`)
      const chain = () => {
        let filename = this.root
        return name
          .split('/')
          .map((component) => {
            filename = path.join(filename, component)
            const stat = lstatSync(filename)
            if (stat.isSymbolicLink()) fail('history input contains a symlink')
            return `${stat.dev}:${stat.ino}:${stat.mode}`
          })
          .join('/')
      }
      const beforeChain = chain(),
        filename = path.join(this.root, name)
      const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = fstatSync(fd)
        if (!before.isFile() || before.size > this.limits.blobBytes)
          fail('history input bytes/type bound exceeded')
        // Bound the read itself, not only a racy pre-read file size.
        const buffer = Buffer.alloc(before.size + 1)
        let count = 0
        while (count < buffer.length) {
          const read = readSync(fd, buffer, count, buffer.length - count, null)
          if (!read) break
          count += read
        }
        const bytes = buffer.subarray(0, count),
          after = fstatSync(fd),
          named = lstatSync(filename)
        if (
          count !== before.size ||
          before.dev !== named.dev ||
          before.ino !== named.ino ||
          before.mode !== after.mode ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          chain() !== beforeChain
        )
          fail('history input changed during read')
        if (
          (item.mode === '100755') !== Boolean(before.mode & 0o111) ||
          !bytes.equals(this.blob(head, name, item))
        )
          fail(`dirty history input differs from HEAD: ${name}`)
        witness.push(
          `${name}\0${item.mode}\0${digest(bytes)}\0${before.dev}:${before.ino}:${before.mode}:${before.size}:${before.mtimeMs}:${before.ctimeMs}\0${beforeChain}`,
        )
      } finally {
        closeSync(fd)
      }
    }
    this.remaining()
    return JSON.stringify(witness)
  }
  versions(head: string, source: string): HistoryVersion[] {
    const raw = this.git([
      'log',
      '--follow',
      '--name-status',
      '-z',
      '--no-color',
      '--no-decorate',
      '--no-ext-diff',
      '--no-textconv',
      '--format=%H%x00%an%x00%aI%x00%s%x00',
      head,
      '--',
      source,
    ])
    if (!raw.length) return fail(`history has no commits for ${source}`)
    const parts = fields(raw),
      versions: HistoryVersion[] = [],
      seen = new Set<string>()
    let cursor = 0,
      historical = source,
      contentBytes = 0
    while (cursor < parts.length) {
      const [commit, author, date, message, gap, rawChange] = parts.slice(
        cursor,
        cursor + 6,
      )
      cursor += 6
      if (
        !oid(commit ?? '') ||
        seen.has(commit) ||
        !author ||
        gap !== '' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(date ?? '') ||
        !rawChange?.startsWith('\n')
      )
        fail('malformed or unsupported Git history record')
      const change = rawChange.slice(1)
      let at: string
      if (/^R(?:100|0\d{2})$/.test(change)) {
        const old = relative(parts[cursor++] ?? ''),
          next = relative(parts[cursor++] ?? '')
        if (next !== historical) fail('ambiguous history rename lineage')
        at = next
        historical = old
      } else if (/^[AMDT]$/.test(change)) {
        at = relative(parts[cursor++] ?? '')
        if (at !== historical) fail('ambiguous history path lineage')
      } else return fail(`unsupported Git history status: ${change}`)
      seen.add(commit)
      if (versions.length >= this.limits.versions)
        fail('history version count bound exceeded')
      const deleted = change === 'D'
      let content: string | null = null
      if (deleted) {
        if (this.tree(commit, [at]).has(at))
          fail('history tombstone still has content')
      } else {
        const bytes = this.blob(commit, at)
        contentBytes += bytes.length
        if (contentBytes > this.limits.nodeBytes)
          fail('history node content bytes bound exceeded')
        content = text(bytes)
      }
      versions.push({
        commit,
        author,
        date,
        message,
        path: at,
        change,
        deleted,
        content,
      })
    }
    return versions
  }
}

/** JSON text is stable across builds; content is data, never injected HTML. */
export function serializeBookHistory(asset: BookHistoryAsset): string {
  return JSON.stringify(asset) + '\n'
}

/** Shared decoder; each caller supplies its own immutable commit authority. */
function historySnapshot(
  reader: LocalHistory, head: string, allowedCommits: ReadonlySet<string>, isActive: () => boolean,
): HistorySnapshot {
  const allowedOids = new Set<string>()
  const check = () => { if (!isActive()) fail('expired history snapshot'); reader.remaining() }
  const snapshot: HistorySnapshot = Object.freeze({
    get head() { check(); return head },
    remaining() { check(); return reader.remaining() },
    tree(commit: string) {
      check()
      if (!allowedCommits.has(commit)) fail('history commit is outside selected versions')
      const treeOID = text(reader.git(['rev-parse', '--verify', `${commit}^{tree}`])).trim()
      if (!oid(treeOID) || treeOID.length !== head.length) fail('invalid historical tree OID')
      // Only rendered snapshots need complete occupancy, including empty
      // trees. Default raw-v1 tree traversal remains leaf-only.
      const entries = reader.tree(treeOID, [], true)
      const occupied = new Set(entries.keys())
      allowedOids.clear()
      for (const [name, item] of entries) {
        if (item.mode === '040000') entries.delete(name)
        else if (['100644', '100755'].includes(item.mode)) allowedOids.add(item.oid)
      }
      return { treeOID, entries, occupied }
    },
    blobs(requested: readonly string[], byteLimit = 64 * 1024 * 1024) {
      check()
      if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 64 * 1024 * 1024) fail('invalid historical map byte limit')
      if (!Array.isArray(requested) || requested.length > 10_000 || requested.some(id => !oid(id) || !allowedOids.has(id))) fail('invalid historical blob selection')
      const oids = [...new Set(requested)]
      const result = new Map<string, Buffer>()
      if (!oids.length) return result
      const sizes = new Map<string, number>()
      for (let start = 0; start < oids.length; start += 512) {
        const group = oids.slice(start, start + 512)
        const raw = text(reader.git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], false, 128 * 1024, Buffer.from(group.join('\n') + '\n')))
        const rows = raw.split('\n')
        if (rows.pop() !== '' || rows.length !== group.length) fail('incomplete historical size framing')
        rows.forEach((row, index) => {
          const match = /^([a-f0-9]+) blob (0|[1-9][0-9]*)$/.exec(row)
          const size = Number(match?.[2])
          if (!match || match[1] !== group[index] || !Number.isSafeInteger(size) || size > reader.limits.blobBytes) fail('historical blob size/type bound')
          sizes.set(group[index], size)
        })
      }
      if (requested.reduce((sum, id) => sum + sizes.get(id)!, 0) > byteLimit) fail('historical batch map bound')
      let cursor = 0
      while (cursor < oids.length) {
        check()
        const group: string[] = []; let expected = 0
        while (cursor < oids.length && group.length < 512 && expected + sizes.get(oids[cursor])! + 128 <= 16 * 1024 * 1024) {
          const id = oids[cursor++]; group.push(id); expected += sizes.get(id)! + 128
        }
        if (!group.length) fail('historical blob batch bound')
        const raw = reader.git(['cat-file', '--batch'], false, 16 * 1024 * 1024, Buffer.from(group.join('\n') + '\n'))
        let offset = 0
        for (const id of group) {
          const newline = raw.indexOf(10, offset), size = sizes.get(id)!
          if (newline < offset || !raw.subarray(offset, newline).equals(Buffer.from(`${id} blob ${size}`, 'ascii'))) fail('historical batch header differs')
          offset = newline + 1
          if (offset + size >= raw.length || raw[offset + size] !== 10) fail('incomplete historical batch body')
          const bytes = Buffer.from(raw.subarray(offset, offset + size)); offset += size + 1
          const actual = createHash(head.length === 40 ? 'sha1' : 'sha256').update(`blob ${size}\0`).update(bytes).digest('hex')
          if (actual !== id) fail('historical blob OID differs')
          result.set(id, bytes)
        }
        if (offset !== raw.length) fail('extra historical batch bytes')
      }
      return result
    },
  })
  return snapshot
}

/** The callback must freshly use the site's canonical mapping producer inside
 * this witness. It receives its remaining time bound; no unkeyed prior cache.
 * A lower resource budget is allowed; callers cannot bypass the fixed ceilings.
 */
function collectHistorySnapshot<T>(
  root: string,
  site: string,
  loadNodes: (remainingMs: number) => readonly HistoryNode[],
  options: { expectedHead?: string; limits?: Partial<Limits> },
  visitor: (assets: BookHistoryAsset[], snapshot: HistorySnapshot) => T,
  hooks?: SnapshotHooks,
): T {
  if (!/^https?:\/\//.test(site) || new URL(site).origin !== site)
    fail('invalid history site origin')
  const reader = new LocalHistory(root, options.limits, hooks),
    head = reader.head()
  if (options.expectedHead !== undefined && options.expectedHead !== head)
    fail('history HEAD differs from expected HEAD')
  reader.complete()
  const witness = reader.inputs(head),
    mappings = loadNodes(reader.remaining())
  reader.remaining()
  if (
    !Array.isArray(mappings) ||
    !mappings.length ||
    mappings.length > HISTORY_LIMITS.versions
  )
    fail('invalid history mapping count')
  const assets: BookHistoryAsset[] = [],
    sources = new Map<string, HistoryVersion[]>(),
    documents = new Set<string>()
  let bytes = 0
  for (const node of mappings) {
    if (
      !node ||
      typeof node.book !== 'string' ||
      typeof node.node !== 'string' ||
      typeof node.path !== 'string' ||
      typeof node.sourcePath !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.book) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.node) ||
      node.path !== `/books/${node.book}/${node.node}/` ||
      !sourcePath(node.sourcePath)
    )
      fail('invalid history mapping/locator')
    relative(node.sourcePath)
    const document = new URL(node.path, site).href
    if (documents.has(document)) fail('duplicate history locator')
    documents.add(document)
    if (!sources.has(node.sourcePath)) {
      reader.blob(head, node.sourcePath) // current-HEAD existence is separate from --follow's newest version
      sources.set(node.sourcePath, reader.versions(head, node.sourcePath))
    }
    const asset: BookHistoryAsset = {
      schemaVersion: 1,
      site,
      document,
      book: node.book,
      node: node.node,
      buildCommit: head,
      sourcePath: node.sourcePath,
      versions: sources.get(node.sourcePath)!,
    }
    // Count JSON escaping per bounded version before allocating a whole asset.
    let assetSize =
      Buffer.byteLength(JSON.stringify({ ...asset, versions: [] })) + 1
    for (let index = 0; index < asset.versions.length; index++) {
      assetSize +=
        Buffer.byteLength(JSON.stringify(asset.versions[index])) +
        (index ? 1 : 0)
      if (bytes + assetSize > reader.limits.assetBytes)
        fail('history serialized asset bytes bound exceeded')
    }
    bytes += assetSize
    if (bytes > reader.limits.assetBytes)
      fail('history serialized asset bytes bound exceeded')
    assets.push(asset)
  }
  let active = true
  const allowedCommits = new Set(assets.flatMap(asset => asset.versions.map(version => version.commit)))
  const snapshot = historySnapshot(reader, head, allowedCommits, () => active)
  let value: T
  try { value = visitor(assets, snapshot) } finally { active = false }
  // An async visitor could retain work after this witness closes. Refuse it.
  if (value && typeof (value as { then?: unknown }).then === 'function') fail('history visitor must be synchronous')
  reader.complete()
  if (
    reader.head() !== head ||
    reader.inputs(head) !== witness ||
    reader.head() !== head
  )
    fail('history HEAD or mapping inputs changed')
  reader.remaining()
  return value
}

/** Existing raw-v1 API and serialization remain unchanged. */
export function collectBookHistories(
  root: string, site: string, loadNodes: (remainingMs: number) => readonly HistoryNode[],
  options: { expectedHead?: string; limits?: Partial<Limits> } = {},
): BookHistoryAsset[] {
  return collectHistorySnapshot(root, site, loadNodes, options, assets => assets)
}

/** Trusted build-only visitor. Read capability expires before final witness validation. */
export function withBookHistorySnapshot<T>(
  root: string, site: string, loadNodes: (remainingMs: number) => readonly HistoryNode[],
  options: { expectedHead?: string; limits?: Partial<Limits> },
  hooks: SnapshotHooks,
  visitor: (assets: BookHistoryAsset[], snapshot: HistorySnapshot) => T,
): T {
  return collectHistorySnapshot(root, site, loadNodes, options, visitor, hooks)
}


export type ExactBookBaseSnapshot = {
  readonly head: string
  readonly baseCommit: string
  remaining(): number
  tree(): HistoryTree
  blobs(oids: readonly string[], byteLimit?: number): Map<string, Buffer>
}

/** Local Git provenance only. loadNodes is trusted host code, not an authenticated
 * mapping supplied by a request. Its canonical freshness/provenance is the caller's
 * responsibility. The complete covered-input witness surrounds that callback and
 * the visitor; this API never grants proposal, renderer or private-data authority. */
export function withExactBookBaseSnapshot<T>(
  root: string,
  site: string,
  loadNodes: (remainingMs: number) => readonly HistoryNode[],
  options: { expectedHead: string; baseCommit: string; limits?: Partial<Limits>; gitCalls?: number },
  visitor: (nodes: readonly HistoryNode[], snapshot: ExactBookBaseSnapshot) => T,
): T {
  const started = performance.now()
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['expectedHead', 'baseCommit', 'limits', 'gitCalls'].includes(key))
        || typeof options.expectedHead !== 'string' || !oid(options.expectedHead)
        || typeof options.baseCommit !== 'string' || !oid(options.baseCommit)
        || options.expectedHead.length !== options.baseCommit.length)
      fail('invalid exact-base options or full object IDs')
    const { expectedHead, baseCommit } = options
    const gitCalls = options.gitCalls ?? 4096
    if (!Number.isSafeInteger(gitCalls) || gitCalls < 1 || gitCalls > 4096)
      fail('invalid exact-base Git call bound')
    if (typeof site !== 'string' || !/^https?:\/\//.test(site) || new URL(site).origin !== site)
      fail('invalid history site origin')
    if (typeof loadNodes !== 'function' || typeof visitor !== 'function')
      fail('exact-base synchronous callbacks required')
    const resolved = realpathSync(root)
    const selection = captureGitSelection(resolved)
    const reader = new LocalHistory(resolved, options.limits, {
      selection, extraInputs: [], gitCalls, checkInputs: () => {},
    }, started + (options.limits?.collectionMs ?? HISTORY_LIMITS.collectionMs))
    reader.remaining()
    const head = reader.head()
    if (head !== expectedHead) fail('history HEAD differs from expected HEAD')
    reader.complete()
    const base = text(reader.git(['rev-parse', '--verify', `${baseCommit}^{commit}`])).trim()
    if (base !== baseCommit) fail('exact base is not the selected commit object')
    reader.git(['merge-base', '--is-ancestor', baseCommit, head])
    const witness = reader.inputs(head)
    const supplied = loadNodes(reader.remaining())
    reader.remaining(); selection.check()
    if (!Array.isArray(supplied) || !supplied.length || supplied.length > reader.limits.versions)
      fail('invalid exact-base mapping count or asynchronous mapping')
    const documents = new Set<string>(), sources = new Set<string>()
    const mappings: Readonly<HistoryNode>[] = []
    let mappingBytes = 0
    for (const node of supplied) {
      reader.remaining()
      if (!node || typeof node.book !== 'string' || typeof node.node !== 'string'
          || typeof node.path !== 'string' || typeof node.sourcePath !== 'string'
          || [node.book, node.node, node.path, node.sourcePath].some(value => value.length > 4096)
          || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.book)
          || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.node)
          || node.path !== `/books/${node.book}/${node.node}/` || !sourcePath(node.sourcePath))
        fail('invalid history mapping/locator')
      mappingBytes += Buffer.byteLength(JSON.stringify([node.book, node.node, node.path, node.sourcePath]))
      if (mappingBytes > reader.limits.nodeBytes) fail('exact-base mapping bytes bound exceeded')
      relative(node.sourcePath)
      const document = new URL(node.path, site).href
      if (documents.has(document)) fail('duplicate history locator')
      documents.add(document)
      if (!sources.has(node.sourcePath)) { reader.blob(head, node.sourcePath); sources.add(node.sourcePath) }
      mappings.push(Object.freeze({ book: node.book, node: node.node, path: node.path, sourcePath: node.sourcePath }))
    }
    let active = true
    const capability = historySnapshot(reader, head, new Set([baseCommit]), () => active)
    const snapshot: ExactBookBaseSnapshot = Object.freeze({
      get head() { return capability.head },
      get baseCommit() { capability.remaining(); return baseCommit },
      remaining: () => capability.remaining(),
      tree: () => capability.tree(baseCommit),
      blobs: (oids: readonly string[], byteLimit?: number) => capability.blobs(oids, byteLimit),
    })
    let value: T
    try { value = visitor(Object.freeze(mappings), snapshot) } finally { active = false }
    if (value && typeof (value as { then?: unknown }).then === 'function')
      fail('exact-base visitor must be synchronous')
    reader.complete()
    if (reader.head() !== head || reader.inputs(head) !== witness || reader.head() !== head)
      fail('history HEAD or mapping inputs changed')
    selection.check(); reader.remaining()
    return value
  } catch (error) {
    if (error instanceof BookHistoryError) throw error
    return fail('exact-base inspection or callback failed')
  }
}
