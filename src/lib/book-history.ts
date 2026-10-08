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

class LocalHistory {
  readonly limits: Limits
  readonly deadline: number
  readonly root: string
  readonly env: NodeJS.ProcessEnv
  constructor(root: string, limits: Partial<Limits> = {}) {
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
    this.deadline = performance.now() + this.limits.collectionMs
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
  remaining(): number {
    const left = Math.floor(this.deadline - performance.now())
    if (left <= 0) fail('history collection time bound exceeded')
    return left
  }
  git(
    args: string[],
    missingConfig = false,
    maxBuffer = this.limits.commandBytes,
  ): Buffer {
    try {
      return execFileSync(
        'git',
        [
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
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: Math.min(this.remaining(), this.limits.commandMs),
          maxBuffer,
        },
      )
    } catch (error) {
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
  ): Map<string, { mode: string; oid: string }> {
    const raw = this.git([
      'ls-tree',
      '-r',
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
    const names = new Set(FIXED_INPUTS)
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
      expected = [...tree.keys()].filter(inputPath).sort()
    if (JSON.stringify([...names].sort()) !== JSON.stringify(expected))
      fail('history input membership differs from HEAD')
    const staged = this.git(['ls-files', '--stage', '-z'])
    const index = new Map<string, string>()
    for (const record of fields(staged)) {
      const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
      if (!match) fail('malformed Git index')
      if (!inputPath(match[4])) continue
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
      if (/^R(?:100|[1-9]?\d)$/.test(change)) {
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

/** The callback must freshly use the site's canonical mapping producer inside
 * this witness. It receives its remaining time bound; no unkeyed prior cache.
 * A lower resource budget is allowed; callers cannot bypass the fixed ceilings.
 */
export function collectBookHistories(
  root: string,
  site: string,
  loadNodes: (remainingMs: number) => readonly HistoryNode[],
  options: { expectedHead?: string; limits?: Partial<Limits> } = {},
): BookHistoryAsset[] {
  if (!/^https?:\/\//.test(site) || new URL(site).origin !== site)
    fail('invalid history site origin')
  const reader = new LocalHistory(root, options.limits),
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
  reader.complete()
  if (
    reader.head() !== head ||
    reader.inputs(head) !== witness ||
    reader.head() !== head
  )
    fail('history HEAD or mapping inputs changed')
  reader.remaining()
  return assets
}
