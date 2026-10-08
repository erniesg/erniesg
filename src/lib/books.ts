/**
 * The books, as `books/tools/render.py` renders them.
 *
 * This module runs the Python renderer once per build and hands its HTML on
 * verbatim. It is deliberately the only bridge: nothing in `src/` parses a
 * node, emits block markup, or re-implements a figure. The moment a second
 * renderer exists the web and EPUB editions drift and the reader sees two
 * different books.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, openSync, closeSync, fstatSync, readSync, constants, opendirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { SITE } from '../consts'
import { resolveStampMode, stampSource, type SourceStamp } from './book-source'
import {
  collectBookHistories,
  HISTORY_LIMITS,
  type BookHistoryAsset,
} from './book-history'
import { captureGitSelection } from '../../adapters/margin/local-source'
import { collectRenderedBookHistories, trustedBookRendererRoot, trustedBookPythonPath } from './book-history-rendered'
import { publishRenderedHistory, type RenderedHistoryAsset } from './book-history-publication'

/**
 * `digest` verifies the anchor. `id` is positional, so inserting a block
 * shifts every later ordinal of that kind and a stored note would otherwise
 * resolve to a real element holding different content. Same id and same
 * digest is the same block; same id and a different digest is drift to
 * confirm, not to follow.
 */
export type BookBlock = { kind: string; id: string; digest: string }

export type BookOutlineEntry = { level: number; id: string; text: string }

export type BookNode = {
  id: string
  title: string
  kind: string
  support: string
  part: string
  partNumber: string
  number: string
  path: string
  /** The node's Markdown source, repo-relative, as `books/tools/manifest.py` names it. */
  sourcePath: string
  html: string
  blocks: BookBlock[]
  outline: BookOutlineEntry[]
  /** The inline exercises on this node, by the id reading progress keys them under. */
  exercises: string[]
  /** A challenge's tiers, for the grader that runs in the reader's browser. */
  grading: BookGrading | null
  /** Previous and next in reading order, as `render.py` writes them. */
  pager: string
  /** The chapter progress indicator, as `render.py` writes it. */
  progress: string
}

export type BookGrading = {
  /** The name the tests import the reader's file by. */
  module: string
  /** In the order `grade.py` runs them; `timeout` is its limit in seconds. */
  tiers: { tier: string; timeout: number; source: string }[]
}

export type BookPart = { id: string; title: string; nodes: string[] }

export type BookTopicNode = { id: string; title: string; kind: string }

export type BookTopic = {
  id: string
  title: string
  part: number
  partName: string
  agent: string
  requires: string[]
  /** The same requirements by topic id: the map's edges. */
  requiresIds: string[]
  unlocks: string[]
  nodes: BookTopicNode[]
}

export type Book = {
  pathId: string
  slug: string
  id: string
  title: string
  subtitle: string
  edition: string
  author: string
  collection: string
  path: string
  frontMatter: string
  parts: BookPart[]
  nodes: BookNode[]
  topics: BookTopic[]
}

export type BookManifest = {
  schemaVersion: number
  generator: string
  collection: string
  poolNodeCount: number
  contentCss: string
  /** The challenge side-by-side view's CSS, rooted on <html>; include unscoped. */
  splitCss: string
  /** The side-by-side toggle's behaviour, shared with `books/tools/preview.py`. */
  splitScript: string
  /** The indicator, pager and shortcut sheet; unscoped, their classes are their own. */
  navCss: string
  /** The map page's markup, drawn by `books/tools/runtime/map.mjs`. */
  mapHtml: string
  /** The map's stylesheet; scoped to the map's container. */
  mapCss: string
  /** The map's at-rules, which only touch map classes; include unscoped. */
  mapAtRules: string
  /** Cytoscape and its dagre layout, which the map draws with. */
  mapLibraries: { url: string; integrity: string }[]
  books: Book[]
}

const RENDERER_FROM_ROOT = path.join('books', 'tools', 'manifest.py')

/**
 * Where the node pool lives.
 *
 * Found by climbing from the working directory rather than from
 * `import.meta.url`: this module is bundled into the build output, so its own
 * location says nothing about where the book is.
 */
function repoRoot(): string {
  let directory = process.cwd()
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(directory, RENDERER_FROM_ROOT))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`cannot find ${RENDERER_FROM_ROOT} from ${process.cwd()}`)
}

/** Render the whole collection afresh. Callers that just want the build's copy want `bookManifest()`. */
export function renderBookManifest(
  bounds: { timeoutMs?: number; maxBuffer?: number } = {},
): BookManifest {
  const python = process.env.CHALLENGES_PYTHON ?? 'python3'
  const root = repoRoot()
  return renderBookManifestAt(root, python, bounds)
}

/** One canonical manifest bridge; preview selects its fixed isolated transport. */
function renderBookManifestAt(root: string, python: string, bounds: { timeoutMs?: number; maxBuffer?: number }, isolated = false): BookManifest {
  const stdout = execFileSync(python, [...(isolated ? ['-I', '-B'] : []), path.join(root, RENDERER_FROM_ROOT)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: bounds.maxBuffer ?? 256 * 1024 * 1024,
    ...(bounds.timeoutMs === undefined ? {} : { timeout: bounds.timeoutMs }),
    ...(isolated ? { killSignal: 'SIGKILL' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] } : {}),
    // The book is full of typographic punctuation; never let the build host's
    // locale decide how the renderer hands it over.
    env: isolated ? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' } : { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  return JSON.parse(stdout) as BookManifest
}

let cached: BookManifest | null = null

/** The rendered collection, computed once per build. */
export function bookManifest(): BookManifest {
  if (!cached) cached = renderBookManifest()
  return cached
}

/** Complete static history inputs are rendered afresh inside the strict Git
 * witness. The ordinary page cache may predate it, so it is not evidence here.
 * This can invoke the same canonical renderer a second time in a build; it
 * never introduces another renderer or runs historical source code.
 */
export function bookHistoryAssets(): BookHistoryAsset[] {
  return collectBookHistories(
    repoRoot(),
    new URL(SITE.SITEURL).origin,
    (remainingMs) => {
      const manifest = renderBookManifest({
        timeoutMs: remainingMs,
        maxBuffer: HISTORY_LIMITS.commandBytes,
      })
      return manifest.books.flatMap((book) =>
        book.nodes.map((node) => ({
          book: book.slug,
          node: node.id,
          path: node.path,
          sourcePath: node.sourcePath,
        })),
      )
    },
  )
}

const PUBLICATION_INPUTS = [
  'src/lib/book-history-safe-html.ts', 'src/lib/book-history-publication.ts',
  'src/lib/books.ts', 'src/lib/book-history.ts', 'src/lib/book-history-rendered.ts',
  'src/lib/margin-history-data.ts', 'src/consts.ts',
  'src/pages/books/[book]/[node]/history.json.ts',
  'src/pages/books/[book]/[node]/history-rendered/[asset].json.ts',
  'adapters/margin/local-source.ts', 'adapters/margin/source-plan.ts', 'src/annotations/criticmarkup.ts',
  'package.json', 'package-lock.json', 'tsconfig.json', 'astro.config.ts',
] as const
const OPTIONAL_PUBLICATION_INPUTS = ['pnpm-lock.yaml', '.npmrc', '.pnpmfile.cjs'] as const
const PUBLICATION_SOURCE_BYTES = 32 * 1024 * 1024
const contentHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function publicationHold(reason: string): never { throw new Error(`history publication witness: ${reason}`) }

/** Build-only trusted-source witness. Unrelated dirty work is preserved;
 * covered inputs must equal HEAD before execution and remain stable after it.
 * Trusted locked installation is assumed; captured dependency bytes establish
 * stable identity, not independent registry-tarball authentication. */
type SourceWitnessContext = { head: string; fingerprint: string; remaining(): number }
type PreviewWitnessProfile = { deadline: number; python: string; checkRuntime(): void }
function withBookSourceWitness<T>(root: string, run: (context: SourceWitnessContext) => T, preview?: PreviewWitnessProfile): T {
  const started = performance.now()
  if (preview && (!Number.isFinite(preview.deadline) || preview.deadline <= started)) publicationHold('expired preview deadline')
  const deadline = Math.min(started + 120_000, preview?.deadline ?? Infinity)
  const requiredInputs = [...PUBLICATION_INPUTS, ...(preview ? ['adapters/margin/proposal-preview.ts', 'adapters/margin/local-proposal-preview.ts'] : [])]
  const remaining = () => { const ms = Math.floor(deadline - performance.now()); if (ms <= 0) publicationHold('deadline'); return ms }
  const resolved = realpathSync(root)
  if (resolved !== path.resolve(root)) publicationHold('source root alias')
  const selection = captureGitSelection(resolved)
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  let calls = 0
  const git = (args: string[], missing = false) => {
    if (++calls > 16) publicationHold('Git call bound')
    selection.check(); remaining()
    try {
      const result = execFileSync('/usr/bin/git', [`--git-dir=${selection.gitdir}`, `--work-tree=${resolved}`, '--no-replace-objects', '--literal-pathspecs', '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', ...args], { cwd: resolved, env, timeout: Math.min(15_000, remaining()), killSignal: 'SIGKILL', maxBuffer: PUBLICATION_SOURCE_BYTES, stdio: ['ignore', 'pipe', 'pipe'] })
      selection.check(); remaining(); return result
    } catch (error) { if (missing && (error as { status?: number }).status === 1) return Buffer.alloc(0); throw error }
  }
  const head = git(['rev-parse', '--verify', 'HEAD']).toString().trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) || git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false' || git(['config', '--get-regexp', '^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$'], true).length) publicationHold('complete repository required')
  const snapshots: { check(): void }[] = []; let sourceBytes = 0
  const identity = (name: string) => {
    const s = lstatSync(name)
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) publicationHold('unsafe input type')
    return { dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, file: s.isFile() }
  }
  const pin = (name: string) => {
    remaining()
    const chain: { name: string; value: ReturnType<typeof identity> }[] = []; let cursor = path.parse(name).root
    chain.push({ name: cursor, value: identity(cursor) })
    for (const component of name.slice(cursor.length).split('/')) { cursor = path.join(cursor, component); chain.push({ name: cursor, value: identity(cursor) }) }
    const before = chain.at(-1)!.value
    if (!before.file || before.size > PUBLICATION_SOURCE_BYTES || sourceBytes + before.size > PUBLICATION_SOURCE_BYTES) publicationHold('input bytes')
    sourceBytes += before.size
    const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const check = () => {
      for (const old of chain) {
        const now = identity(old.name)
        if (old.value.dev !== now.dev || old.value.ino !== now.ino || old.value.mode !== now.mode || (old.value.file && (old.value.size !== now.size || old.value.mtime !== now.mtime || old.value.ctime !== now.ctime))) publicationHold('input identity drift')
      }
    }
    let bytes: Buffer
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) publicationHold('input open drift')
      const data = Buffer.alloc(before.size + 1); let used = 0
      for (;;) { const n = readSync(fd, data, used, data.length - used, null); if (!n) break; used += n; if (used === data.length) publicationHold('input growth') }
      const after = fstatSync(fd)
      if (used !== before.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) publicationHold('input read drift')
      check(); bytes = data.subarray(0, used)
    } finally { closeSync(fd) }
    snapshots.push({ check }); return bytes
  }
  const safeName = (name: string) => name.length > 0 && !/[\\\x00-\x1f\x7f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..')
  const covered = (name: string) => [...requiredInputs, ...OPTIONAL_PUBLICATION_INPUTS].includes(name as never) || /^books\/[^/]+\.toml$|^books\/tools\/[^/]+\.py$|^books\/chapters\/[^/]+\.md$|^books\/challenges\/[^/]+\/challenge\.md$/.test(name)
  // Include tree rows: an explicit empty tree is occupied, never optional absence.
  const rawTree = git(['ls-tree', '-r', '-t', '-z', '--full-tree', head])
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawTree)
  if (!decoded.endsWith('\0')) publicationHold('tree framing')
  const expected = new Map<string, { mode: string; oid: string }>()
  for (const row of decoded.slice(0, -1).split('\0')) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row)
    if (!match || !safeName(match[4])) publicationHold('tree framing/path')
    if (covered(match[4])) { if (match[2] !== 'blob' || !['100644', '100755'].includes(match[1]) || expected.has(match[4])) publicationHold('covered tree type'); expected.set(match[4], { mode: match[1], oid: match[3] }) }
  }
  for (const required of requiredInputs) if (!expected.has(required)) publicationHold('missing covered source')
  const directoryNames = (directory: string) => {
    const result: string[] = [], dir = opendirSync(directory)
    try { for (;;) { const entry = dir.readSync(); if (!entry) break; if (result.length >= 10_000) publicationHold('directory membership bound'); result.push(entry.name) } }
    finally { dir.closeSync() }
    return result
  }
  const present = (name: string) => { try { lstatSync(path.join(resolved, name)); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
  const membership = () => {
    const names: string[] = [...requiredInputs]
    for (const optional of OPTIONAL_PUBLICATION_INPUTS) if (present(optional)) names.push(optional)
    for (const [folder, suffix] of [['books', '.toml'], ['books/tools', '.py'], ['books/chapters', '.md']]) {
      for (const name of directoryNames(path.join(resolved, folder))) if (name.endsWith(suffix)) names.push(`${folder}/${name}`)
    }
    for (const name of directoryNames(path.join(resolved, 'books/challenges'))) {
      const folder = `books/challenges/${name}`, s = lstatSync(path.join(resolved, folder))
      if (s.isSymbolicLink()) publicationHold('mapping directory alias')
      if (s.isDirectory() && present(`${folder}/challenge.md`)) names.push(`${folder}/challenge.md`)
    }
    if (names.length > 10_000) publicationHold('source membership bound')
    return [...new Set(names)].sort()
  }
  const names = membership()
  if (JSON.stringify(names) !== JSON.stringify([...expected.keys()].sort())) publicationHold('source membership differs from HEAD')
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...names]).length) publicationHold('covered source is dirty/staged')
  const contents = new Map<string, Buffer>(), sourceHashes: [string, string][] = []
  for (const name of names) {
    const bytes = pin(path.join(resolved, name)), item = expected.get(name)!
    const blob = createHash(head.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (blob !== item.oid || (item.mode === '100755') !== Boolean(lstatSync(path.join(resolved, name)).mode & 0o111)) publicationHold('source differs from HEAD')
    contents.set(name, bytes); sourceHashes.push([name, contentHash(bytes)])
  }
  pin(path.join(selection.gitdir, 'index'))
  const lock = JSON.parse(contents.get('package-lock.json')!.toString('utf8'))
  const require = createRequire(import.meta.url), parserEntry = require.resolve('parse5')
  const entityEntry = createRequire(parserEntry).resolve('entities/decode')
  const dependencyHashes: unknown[] = []
  const resolutions = [[() => require.resolve('parse5'), parserEntry, 'parse5', 'node_modules/parse5'], [() => createRequire(parserEntry).resolve('entities/decode'), entityEntry, 'entities', lock.packages?.['node_modules/parse5/node_modules/entities'] ? 'node_modules/parse5/node_modules/entities' : 'node_modules/entities']] as const
  for (const [resolveEntry, entry, packageName, lockKey] of resolutions) {
    let directory = path.dirname(realpathSync(entry))
    for (let depth = 0; !existsSync(path.join(directory, 'package.json')); depth++) { if (depth >= 8) publicationHold('dependency manifest missing'); directory = path.dirname(directory) }
    const manifest = JSON.parse(pin(path.join(directory, 'package.json')).toString('utf8')), locked = lock.packages?.[lockKey]
    if (manifest.name !== packageName || manifest.version !== locked?.version || typeof locked?.integrity !== 'string' || !locked.integrity.startsWith('sha512-')) publicationHold('installed dependency/lock mismatch')
    const expectedDependencies = packageName === 'parse5' ? ['entities'] : []
    const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort()
    if (JSON.stringify(dependencyNames) !== JSON.stringify(expectedDependencies) || dependencyNames.some(name => manifest.dependencies[name] !== locked.dependencies?.[name]) || Object.keys(locked.dependencies ?? {}).length !== dependencyNames.length) publicationHold('dependency closure differs')
    const walk = () => {
      const found: string[] = [], stack = ['']; let visited = 0
      while (stack.length) {
        const relative = stack.pop()!
        if (++visited > 4096 || relative.split(path.sep).length > 32) publicationHold('dependency membership bound')
        remaining()
        for (const name of directoryNames(path.join(directory, relative))) {
          if (name === 'node_modules') continue
          const child = path.join(relative, name), s = lstatSync(path.join(directory, child))
          if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) publicationHold('dependency alias/type')
          if (s.isDirectory()) stack.push(child)
          else if (s.isFile() && /\.(?:[cm]?js|json)$/.test(name)) found.push(child)
          if (found.length + stack.length > 4096) publicationHold('dependency membership bound')
        }
      }
      return found.sort()
    }
    const files = walk(), hashes: [string, string][] = []
    if (!files.includes(path.relative(directory, realpathSync(entry)))) publicationHold('dependency entry is not pinned')
    for (const name of files) hashes.push([name, contentHash(pin(path.join(directory, name)))])
    snapshots.push({ check() { if (resolveEntry() !== entry || realpathSync(entry) !== entry || JSON.stringify(walk()) !== JSON.stringify(files)) publicationHold('dependency resolution/membership drift') } })
    dependencyHashes.push({ name: packageName, version: manifest.version, integrity: locked.integrity, files: hashes })
  }
  let runtimeHash: string | undefined
  if (preview) {
    preview.checkRuntime()
    runtimeHash = contentHash(pin(preview.python))
    snapshots.push({ check: preview.checkRuntime })
  }
  const fingerprint = contentHash(JSON.stringify({ head, sourceHashes, dependencyHashes, ...(preview ? { mappingRuntime: { path: preview.python, sha256: runtimeHash } } : {}) }))
  remaining(); selection.check()
  for (const snapshot of snapshots) snapshot.check()
  const result = run({ head, fingerprint, remaining })
  if (result && typeof (result as { then?: unknown }).then === 'function') publicationHold('synchronous publication required')
  remaining(); selection.check()
  if (git(['rev-parse', '--verify', 'HEAD']).toString().trim() !== head || JSON.stringify(membership()) !== JSON.stringify(names)) publicationHold('HEAD/source membership drift')
  for (const snapshot of snapshots) snapshot.check()
  remaining(); return result
}

/** Existing publication entry keeps the original fixed profile and default budget. */
export function withHistoryPublicationWitness<T>(root: string, run: (context: SourceWitnessContext) => T): T {
  return withBookSourceWitness(root, run)
}

/** Local trusted-site bridge. No caller root, cached mapping, or private transport. */
export function withLocalBookPreviewInputs<T>(deadline: number, visit: (context: SourceWitnessContext & {
  root: string; site: string; loadNodes(): { book: string; node: string; path: string; sourcePath: string }[]
}) => T): T {
  const root = trustedBookRendererRoot(), python = trustedBookPythonPath()
  const checkRuntime = () => { if (trustedBookRendererRoot() !== root || trustedBookPythonPath() !== python) publicationHold('preview runtime selector drift') }
  return withBookSourceWitness(root, context => {
    let active = true
    const check = () => { if (!active) publicationHold('preview mapping scope expired'); context.remaining(); checkRuntime() }
    const loadNodes = () => {
      check()
      const manifest = renderBookManifestAt(root, python, { timeoutMs: Math.min(15_000, context.remaining()), maxBuffer: HISTORY_LIMITS.commandBytes }, true)
      check()
      if (!Array.isArray(manifest.books) || manifest.books.length > 10_000) publicationHold('preview mapping shape/count')
      const nodes: { book: string; node: string; path: string; sourcePath: string }[] = []
      let bytes = 0
      for (const book of manifest.books) {
        if (!Array.isArray(book.nodes)) publicationHold('preview mapping node shape')
        for (const node of book.nodes) {
          const row = { book: book.slug, node: node.id, path: node.path, sourcePath: node.sourcePath }
          bytes += Buffer.byteLength(JSON.stringify(row)); if (nodes.length >= 10_000 || bytes > 2 * 1024 * 1024) publicationHold('preview mapping bound')
          nodes.push(row)
        }
      }
      check(); return nodes
    }
    try { check(); const value = visit({ ...context, root, site: new URL(SITE.SITEURL).origin, loadNodes }); check(); return value }
    finally { active = false }
  }, { deadline, python, checkRuntime })
}

/** No cached manifest or cross-invocation history result is authority. */
export function renderedBookHistoryAssets(): RenderedHistoryAsset[] {
  const root = repoRoot()
  return withHistoryPublicationWitness(root, context => {
    let contentCss: string | undefined
    const bundle = collectRenderedBookHistories(root, new URL(SITE.SITEURL).origin, remainingMs => {
      const manifest = renderBookManifest({ timeoutMs: Math.min(remainingMs, context.remaining()), maxBuffer: HISTORY_LIMITS.commandBytes })
      contentCss = manifest.contentCss
      return manifest.books.flatMap(book => book.nodes.map(node => ({ book: book.slug, node: node.id, path: node.path, sourcePath: node.sourcePath })))
    }, { expectedHead: context.head, limits: { collectionMs: context.remaining() } })
    if (typeof contentCss !== 'string') publicationHold('fresh CSS unavailable')
    context.remaining()
    const assets = publishRenderedHistory(bundle, { content: contentCss, scoped: scopeContentCss(contentCss, '.history-content') }, context.fingerprint)
    context.remaining(); return assets
  })
}

export function books(): Book[] {
  return bookManifest().books
}

export function bookBySlug(slug: string): Book | undefined {
  return books().find((book) => book.slug === slug)
}

/**
 * The anchor every annotation hangs off. Absolute, because a note may be
 * stored by a service that never sees this site's routing.
 */
export function documentUri(pathname: string): string {
  return new URL(pathname, SITE.SITEURL).toString()
}

/**
 * What a node's page was built from: its source file and the commit that last
 * touched it (issue 059). A build fails rather than stamp a page wrongly; a dev
 * server stamps an uncommitted file `dirty` and edit mode is off there. See
 * `book-source.ts` for the modes.
 */
export function nodeSourceStamp(node: BookNode, dev: boolean): SourceStamp {
  return stampSource(repoRoot(), node.sourcePath, resolveStampMode({ dev, env: process.env }))
}

/**
 * The book's own stylesheet, confined to one container.
 *
 * `render.py` writes plain element selectors because the EPUB has a document
 * to itself. The site does not, so every selector is prefixed rather than
 * rewritten — the stylesheet still has exactly one author.
 */
export function scopeContentCss(css: string, scope: string): string {
  if (css.includes('@')) {
    throw new Error(
      'the book stylesheet grew an at-rule; scoping it by selector prefix is no longer safe',
    )
  }
  return css.replace(
    /(^|\})([^{}]+)\{/g,
    (_match: string, close: string, selectors: string) =>
      `${close}${selectors
        .split(',')
        .map((selector) => selector.trim())
        .filter(Boolean)
        .map((selector) => (selector === ':root' ? scope : `${scope} ${selector}`))
        .join(', ')} {`,
  )
}
