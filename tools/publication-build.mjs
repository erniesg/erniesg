import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'parse5'
import { canonicalPublicationSubsetSha256 } from '../src/publication/adapter-conformance.ts'
import { serializeAssetBundle } from '../src/publication/asset-bundle.ts'
import { createDefaultPublicationAdapterRegistry } from '../src/publication/adapter-registry.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import { serializePublicationGraph } from '../src/publication/schema.ts'

export function parsePublicationBuildArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (
      ![
        '--adapter',
        '--entry',
        '--input',
        '--mapping',
        '--output',
      ].includes(option)
    )
      throw new Error(`Unknown publication:build option: ${option}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${option}`)
    options[option.slice(2)] = value
  }
  if (!options.adapter || !options.output)
    throw new Error(
      'Usage: publication:build --adapter astro --entry <blog-id> --output <directory> | --adapter payload --input <json> [--mapping <json>] --output <directory>',
    )
  if (options.adapter === 'payload') options.adapter = 'payload-lexical'
  if (options.adapter === 'astro') {
    if (!options.entry)
      throw new Error('Astro publication builds require --entry <blog-id>')
    if (options.input || options.mapping)
      throw new Error('Astro publication builds do not accept Payload input or mapping files')
  } else if (options.adapter === 'payload-lexical') {
    if (!options.input)
      throw new Error('Payload publication builds require --input <json>')
    if (options.entry)
      throw new Error('Payload publication builds do not accept an Astro --entry')
  } else {
    throw new Error(`Unsupported publication source adapter: ${options.adapter}`)
  }
  return options
}

export function assertAtomicPublicationPlatform(platform) {
  if (platform === 'linux' || platform === 'darwin') return
  const error = new Error(
    'Atomic directory publication is unsupported on this platform',
  )
  error.code = 'ENOTSUP'
  throw error
}

export function assertAtomicPublicationRuntime() {
  // The final atomic publish shells out to python3 for renameat2/renameatx_np
  // (see ATOMIC_RENAME_SCRIPT). The runtime is not declared in package.json
  // engines, so probe it before any adapter resolution, staging, rendering,
  // or output work instead of failing after the full profile matrix.
  try {
    execFileSync('python3', ['-c', 'import ctypes, os, sys'], {
      stdio: 'ignore',
    })
  } catch {
    // The probe failure detail can embed environment-specific paths; keep the
    // dependency error actionable and sanitized.
    const error = new Error(
      'Atomic directory publication requires a python3 runtime on PATH; install python3 before running publication builds',
    )
    error.code = 'ENOENT'
    throw error
  }
}

function resolveThroughExistingAncestor(value) {
  let ancestor = resolve(value)
  const unresolved = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    unresolved.unshift(basename(ancestor))
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), ...unresolved)
}

export function assertPublicationOutputDirectory(output) {
  const repositoryRoot = resolveThroughExistingAncestor(
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim(),
  )
  const candidate = resolve(output)
  const candidateRepositoryRelative = relative(repositoryRoot, candidate)
  const candidateRepositoryLocal =
    candidateRepositoryRelative === '' ||
    (!candidateRepositoryRelative.startsWith(`..${sep}`) &&
      candidateRepositoryRelative !== '..' &&
      !isAbsolute(candidateRepositoryRelative))
  if (
    candidateRepositoryLocal &&
    existsSync(candidate) &&
    lstatSync(candidate).isSymbolicLink()
  )
    throw new Error(
      `Repository-local publication output path cannot be a symbolic link: ${candidate}`,
    )
  const policyCandidate = resolveThroughExistingAncestor(candidate)
  const repositoryRelative = relative(repositoryRoot, policyCandidate)
  const repositoryLocal =
    repositoryRelative === '' ||
    (!repositoryRelative.startsWith(`..${sep}`) &&
      repositoryRelative !== '..' &&
      !isAbsolute(repositoryRelative))
  if (!repositoryLocal) return candidate
  let ignored = false
  if (repositoryRelative) {
    try {
      execFileSync(
        'git',
        ['check-ignore', '--quiet', '--no-index', '--', policyCandidate],
        { stdio: 'ignore' },
      )
      ignored = true
    } catch {
      ignored = false
    }
  }
  if (!ignored)
    throw new Error(
      `Repository-local publication output must be ignored before generation: ${candidate}`,
    )
  return candidate
}

export async function createPublicationStagingDirectory(finalOutput) {
  const parent = dirname(resolve(finalOutput))
  await mkdir(parent, { recursive: true })
  // mkdtemp gives the staging root an unpredictable name and mode 0700, so no
  // other principal can pre-place or insert entries for the build to follow.
  return mkdtemp(resolve(parent, '.publication-staging-'))
}

function publicationPublishError(error) {
  if (error?.code === 'EXDEV')
    // The staging directory lives next to the publish target, so a
    // cross-device rename only happens when the target itself is a mount
    // point. Copying into a possibly hostile directory is never a fallback.
    return new Error(
      'Publication output cannot be published with an atomic rename (cross-device); failing closed instead of degrading to a copy',
    )
  return error
}

function publicationRecoveryError(error, message) {
  const sanitized = new Error(message)
  if (typeof error?.code === 'string') sanitized.code = error.code
  return sanitized
}

const ATOMIC_RENAME_SCRIPT = String.raw`
import ctypes
import os
import sys

operation = sys.argv[1]
left_path = os.fsencode(os.path.abspath(sys.argv[2]))
right_path = os.fsencode(os.path.abspath(sys.argv[3]))
libc = ctypes.CDLL(None, use_errno=True)

def split_path(path):
    parent, name = os.path.split(path)
    if not name:
        raise OSError(22, 'atomic rename requires a basename')
    return parent, name

def open_parent(parent):
    flags = os.O_RDONLY
    flags |= getattr(os, 'O_CLOEXEC', 0)
    flags |= getattr(os, 'O_DIRECTORY', 0)
    flags |= getattr(os, 'O_NOFOLLOW', 0)
    return os.open(parent, flags)

left_parent, left = split_path(left_path)
right_parent, right = split_path(right_path)
left_directory = open_parent(left_parent)
try:
    right_directory = os.dup(left_directory) if right_parent == left_parent else open_parent(right_parent)
    try:
        if sys.platform.startswith('linux'):
            rename = getattr(libc, 'renameat2', None)
            if rename is None:
                raise OSError(38, 'renameat2 is unavailable')
            rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            rename.restype = ctypes.c_int
            flag = 2 if operation == 'exchange' else 1 if operation == 'no-replace' else None
            if flag is None:
                raise OSError(22, 'unsupported atomic rename operation')
            result = rename(left_directory, left, right_directory, right, flag)
        elif sys.platform == 'darwin':
            rename = getattr(libc, 'renameatx_np', None)
            if rename is None:
                raise OSError(38, 'renameatx_np is unavailable')
            rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            rename.restype = ctypes.c_int
            flag = 2 if operation == 'exchange' else 4 if operation == 'no-replace' else None
            if flag is None:
                raise OSError(22, 'unsupported atomic rename operation')
            result = rename(left_directory, left, right_directory, right, flag)
        else:
            raise OSError(95, 'atomic rename is unsupported on this platform')

        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
    finally:
        os.close(right_directory)
finally:
    os.close(left_directory)
`

function atomicRenameFailure(error, message) {
  const failure = new Error(message)
  const errorNumber = Number(
    String(error?.stderr ?? '').match(/\[Errno (\d+)\]/u)?.[1],
  )
  if (errorNumber === 17) failure.code = 'EEXIST'
  if (errorNumber === 18) failure.code = 'EXDEV'
  if (errorNumber === 38) failure.code = 'ENOSYS'
  if (errorNumber === 95) failure.code = 'ENOTSUP'
  return failure
}

function atomicRenamePublicationPaths(operation, left, right, message) {
  try {
    execFileSync(
      'python3',
      [
        '-c',
        ATOMIC_RENAME_SCRIPT,
        operation,
        resolve(left),
        resolve(right),
      ],
      { stdio: 'pipe' },
    )
  } catch (error) {
    throw atomicRenameFailure(error, message)
  }
}

export async function atomicExchangePublicationPaths(left, right) {
  atomicRenamePublicationPaths(
    'exchange',
    left,
    right,
    'Atomic publication path exchange failed',
  )
}

export async function atomicPublishNewPublicationPath(staged, final) {
  atomicRenamePublicationPaths(
    'no-replace',
    staged,
    final,
    'Atomic publication no-replace failed',
  )
}

function fileIdentityType(identity) {
  if (identity.isSymbolicLink()) return 'symbolic-link'
  if (identity.isDirectory()) return 'directory'
  if (identity.isFile()) return 'file'
  if (identity.isBlockDevice()) return 'block-device'
  if (identity.isCharacterDevice()) return 'character-device'
  if (identity.isFIFO()) return 'fifo'
  if (identity.isSocket()) return 'socket'
  return 'unknown'
}

function sameFileIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      fileIdentityType(left) === fileIdentityType(right),
  )
}

async function pathIdentity(path) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function restorePublicationExchange(
  exchange,
  staged,
  final,
  expectedFinalIdentity,
  expectedStagedIdentity,
) {
  await exchange(staged, final)
  const [finalIdentity, stagedIdentity] = await Promise.all([
    pathIdentity(final),
    pathIdentity(staged),
  ])
  if (
    !sameFileIdentity(finalIdentity, expectedFinalIdentity) ||
    !sameFileIdentity(stagedIdentity, expectedStagedIdentity)
  )
    throw new Error(
      'Atomic publication restoration identity verification failed',
    )
}

function publicationRecoveryAggregate(
  primaryError,
  primaryMessage,
  restorationError,
) {
  return new AggregateError(
    [
      publicationRecoveryError(primaryError, primaryMessage),
      publicationRecoveryError(
        restorationError,
        'Atomic publication restoration failed',
      ),
    ],
    'Atomic publication replacement failed and restoration also failed',
  )
}

export async function publishPublicationOutput(
  stagedOutput,
  finalOutput,
  operations = {},
) {
  const final = resolve(finalOutput)
  const staged = resolve(stagedOutput)
  const exchange =
    operations.atomicExchange ?? atomicExchangePublicationPaths
  const publishNew =
    operations.atomicPublishNew ?? atomicPublishNewPublicationPath
  const candidateIdentity = await lstat(staged, { bigint: true })
  const previousIdentity = await pathIdentity(final)
  if (!previousIdentity) {
    await publishNew(staged, final).catch((error) => {
      throw publicationPublishError(error)
    })
    const finalIdentity = await pathIdentity(final)
    if (!sameFileIdentity(finalIdentity, candidateIdentity))
      throw new Error(
        'Publication output identity changed during atomic publication',
      )
    return
  }
  if (previousIdentity.isSymbolicLink())
    throw new Error('Publication output path cannot be a symbolic link')
  try {
    // RENAME_EXCHANGE/RENAME_SWAP keeps the stable publication path bound to
    // either the complete previous tree or the complete candidate tree.
    await exchange(staged, final)
  } catch (error) {
    const finalAfterFailure = await pathIdentity(final)
    const stagedAfterFailure = await pathIdentity(staged)
    const exchangeCompleted =
      sameFileIdentity(finalAfterFailure, candidateIdentity) &&
      sameFileIdentity(stagedAfterFailure, previousIdentity)
    if (!exchangeCompleted) throw publicationPublishError(error)
    try {
      await restorePublicationExchange(
        exchange,
        staged,
        final,
        previousIdentity,
        candidateIdentity,
      )
    } catch (restorationError) {
      throw publicationRecoveryAggregate(
        error,
        'Atomic publication exchange reported failure after completion',
        restorationError,
      )
    }
    throw publicationPublishError(error)
  }
  const [finalAfterExchange, stagedAfterExchange] = await Promise.all([
    pathIdentity(final),
    pathIdentity(staged),
  ])
  if (
    !sameFileIdentity(finalAfterExchange, candidateIdentity) ||
    !sameFileIdentity(stagedAfterExchange, previousIdentity)
  ) {
    const identityError = new Error(
      'Publication output identity changed during atomic replacement',
    )
    try {
      await restorePublicationExchange(
        exchange,
        staged,
        final,
        stagedAfterExchange,
        finalAfterExchange,
      )
    } catch (restorationError) {
      throw publicationRecoveryAggregate(
        identityError,
        identityError.message,
        restorationError,
      )
    }
    throw identityError
  }
  // After exchange the old publication lives at the private staging path;
  // removing it cannot make the stable final path disappear.
  await rm(staged, { recursive: true, force: true })
}

export function publicationSourceReceipt(bundle, routeParity) {
  return {
    adapterId: bundle.provenance.adapterId,
    adapterVersion: bundle.provenance.adapterVersion,
    sourceType: bundle.provenance.sourceType,
    sourceId: bundle.provenance.sourceId,
    ...(bundle.provenance.sourceRevision
      ? { sourceRevision: bundle.provenance.sourceRevision }
      : {}),
    ...(bundle.provenance.mappingVersion
      ? { mappingVersion: bundle.provenance.mappingVersion }
      : {}),
    graphSha256: createHash('sha256')
      .update(serializePublicationGraph(bundle.graph))
      .digest('hex'),
    assetBundleSha256: createHash('sha256')
      .update(serializeAssetBundle(bundle.assetBundle))
      .digest('hex'),
    canonicalSubsetSha256: canonicalPublicationSubsetSha256(bundle),
    routeParity,
  }
}

function collectElements(node, result = { headings: [], images: [] }) {
  if (node.tagName && /^h[1-6]$/.test(node.tagName)) {
    const text = []
    const collectText = (child) => {
      if (child.nodeName === '#text') text.push(child.value)
      child.childNodes?.forEach(collectText)
    }
    collectText(node)
    result.headings.push(text.join('').trim())
  }
  if (node.tagName === 'img') {
    const attributes = Object.fromEntries(
      (node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]),
    )
    result.images.push({ src: attributes.src, alt: attributes.alt })
  }
  node.childNodes?.forEach((child) => collectElements(child, result))
  return result
}

function bodyText(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .replaceAll('’', "'")
    .trim()
}

function graphNodeText(node) {
  if ('text' in node) return bodyText(node.text)
  return ''
}

export function publicationGraphBodyFingerprint(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nestedListIds = new Set(
    graph.nodes
      .filter((node) => node.type === 'list-item')
      .flatMap((node) => node.childListIds ?? []),
  )
  const fingerprint = []
  const captionToken = (captionId, tag = 'figcaption') => {
    const caption = captionId ? byId.get(captionId) : undefined
    if (caption?.type === 'caption')
      fingerprint.push(`${tag}:${graphNodeText(caption)}`)
  }
  const visit = (node) => {
    switch (node.type) {
      case 'heading':
        fingerprint.push(`h${node.level}:${graphNodeText(node)}`)
        break
      case 'paragraph':
        fingerprint.push(`p:${graphNodeText(node)}`)
        break
      case 'list':
        fingerprint.push(node.ordered ? 'ol' : 'ul')
        for (const itemId of node.itemIds) {
          const item = byId.get(itemId)
          if (!item || item.type !== 'list-item') continue
          fingerprint.push(`li:${graphNodeText(item)}`)
          for (const childId of item.childListIds ?? []) {
            const child = byId.get(childId)
            if (child?.type === 'list') visit(child)
          }
        }
        break
      case 'list-item':
        break
      case 'quote':
        fingerprint.push(
          `blockquote:${bodyText([node.text, node.attribution].filter(Boolean).join(' '))}`,
        )
        break
      case 'code':
        fingerprint.push(`pre:${bodyText(node.code)}`)
        break
      case 'table':
        fingerprint.push('table')
        captionToken(node.captionId, 'caption')
        for (const row of node.rows)
          for (const cell of row.cells)
            fingerprint.push(`${cell.headerScope ? 'th' : 'td'}:${bodyText(cell.text)}`)
        break
      case 'equation':
        fingerprint.push(`math:${bodyText([node.source, node.label].filter(Boolean).join(' '))}`)
        captionToken(node.captionId)
        break
      case 'aside':
        fingerprint.push(`aside:${graphNodeText(node)}`)
        break
      case 'note':
        fingerprint.push(`aside:${node.noteKind}:${bodyText([node.label, node.text].join(' '))}`)
        break
      case 'reference':
        fingerprint.push(`p:doc-biblioentry:${graphNodeText(node)}`)
        break
      case 'caption':
        break
      case 'figure':
        if (node.assetIds.length === 0 && node.sourceText)
          fingerprint.push(`figure:${bodyText([node.title, node.sourceText].join(' '))}`)
        captionToken(node.captionId)
        break
      case 'media':
        if (node.mediaKind === 'interactive' && node.accessibility.transcript)
          fingerprint.push(`figure:${bodyText(node.accessibility.transcript)}`)
        captionToken(node.captionId)
        break
      default:
        break
    }
  }
  for (const node of graph.nodes) {
    if (node.type === 'list-item' || nestedListIds.has(node.id) || node.type === 'caption') continue
    visit(node)
  }
  return fingerprint
}

function findTag(root, tagName) {
  if (!root) return undefined
  if (root.tagName === tagName) return root
  for (const child of root.childNodes ?? []) {
    const found = findTag(child, tagName)
    if (found) return found
  }
  return undefined
}

function directBodyText(node, excludedTags = new Set()) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && excludedTags.has(node.tagName)) return ''
  return (node.childNodes ?? [])
    .map((child) => directBodyText(child, excludedTags))
    .join('')
}

function attribute(node, name) {
  return node?.attrs?.find((value) => value.name === name)?.value
}

function textContent(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  return (node.childNodes ?? []).map(textContent).join('')
}

export function canonicalRouteBodyFingerprint(html) {
  const root = findTag(parse(html), 'article') ?? findTag(parse(html), 'main')
  const fingerprint = []
  const visit = (node) => {
    const tag = node.tagName
    if (!tag) {
      for (const child of node.childNodes ?? []) visit(child)
      return
    }
    if (/^h[1-6]$/u.test(tag)) {
      fingerprint.push(`${tag}:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'p') {
      const images = []
      const collectImages = (candidate) => {
        if (candidate.tagName === 'img') images.push(candidate)
        for (const child of candidate.childNodes ?? []) collectImages(child)
      }
      collectImages(node)
      if (images.length && !textContent(node).trim()) {
        for (const image of images) {
          const title = attribute(image, 'title')
          if (title) fingerprint.push(`figcaption:${bodyText(title)}`)
        }
        return
      }
      const role = attribute(node, 'role')
      fingerprint.push(
        role === 'doc-biblioentry'
          ? `p:doc-biblioentry:${bodyText(textContent(node))}`
          : `p:${bodyText(textContent(node))}`,
      )
      return
    }
    if (tag === 'blockquote') {
      fingerprint.push(`blockquote:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'pre') {
      fingerprint.push(`pre:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'img') {
      const title = attribute(node, 'title')
      if (title) fingerprint.push(`figcaption:${bodyText(title)}`)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      fingerprint.push(tag)
      for (const child of node.childNodes ?? []) if (child.tagName === 'li') visit(child)
      return
    }
    if (tag === 'li') {
      fingerprint.push(
        `li:${bodyText(directBodyText(node, new Set(['ul', 'ol'])))}`,
      )
      for (const child of node.childNodes ?? []) if (child.tagName === 'ul' || child.tagName === 'ol') visit(child)
      return
    }
    if (tag === 'table') {
      fingerprint.push('table')
      for (const child of node.childNodes ?? []) visit(child)
      return
    }
    if (tag === 'caption') {
      fingerprint.push(`caption:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'th' || tag === 'td') {
      fingerprint.push(`${tag}:${bodyText(textContent(node))}`)
      return
    }
    if (attribute(node, 'role') === 'math') {
      fingerprint.push(`math:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'aside') {
      const role = attribute(node, 'role')
      const prefix = role?.startsWith('doc-') ? `aside:${role}:` : 'aside:'
      fingerprint.push(`${prefix}${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'figcaption') {
      fingerprint.push(`figcaption:${bodyText(textContent(node))}`)
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  if (root) visit(root)
  return fingerprint
}

function isLocalRouteAsset(src) {
  return Boolean(src) && !/^[a-z][a-z\d+.-]*:/iu.test(src)
}

function assetStem(fileName) {
  return (fileName ?? '')
    .replace(/\.[^.]*$/u, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '')
}

export function consumeRouteImageIndex(
  images,
  usedIndexes,
  alternativeText,
  stem,
) {
  const index = images.findIndex(
    (candidate, candidateIndex) =>
      !usedIndexes.has(candidateIndex) &&
      candidate.alt === alternativeText &&
      isLocalRouteAsset(candidate.src) &&
      (!stem || assetStem(candidate.src).includes(stem)),
  )
  if (index >= 0) usedIndexes.add(index)
  return index
}

export function publicationRouteHtmlDigest(html) {
  return createHash('sha256').update(html).digest('hex')
}

export function publicationReceiptDigest(receipt) {
  return createHash('sha256').update(receipt).digest('hex')
}

function canonicalMacOSTemporaryPath(value) {
  const candidate = resolve(value)
  if (process.platform !== 'darwin') return candidate
  for (const [aliasRoot, canonicalRoot] of [
    ['/var', '/private/var'],
    ['/tmp', '/private/tmp'],
  ]) {
    if (
      candidate !== aliasRoot &&
      !candidate.startsWith(`${aliasRoot}${sep}`)
    )
      continue
    try {
      const alias = lstatSync(aliasRoot)
      if (
        !alias.isSymbolicLink() ||
        alias.uid !== 0 ||
        realpathSync(aliasRoot) !== canonicalRoot
      )
        return candidate
    } catch {
      return candidate
    }
    return resolve(canonicalRoot, relative(aliasRoot, candidate))
  }
  return candidate
}

function currentEffectiveUserId() {
  if (typeof process.geteuid === 'function') return process.geteuid()
  if (typeof process.getuid === 'function') return process.getuid()
  return undefined
}

function publicationCleanlinessExclusion(repositoryRoot, excludedPath) {
  const repositoryIdentity = canonicalMacOSTemporaryPath(repositoryRoot)
  const candidate = resolve(excludedPath)
  const candidateIdentity = canonicalMacOSTemporaryPath(candidate)
  const repositoryRelative = relative(repositoryIdentity, candidateIdentity)
    .split(sep)
    .join('/')
  if (
    repositoryRelative === '..' ||
    repositoryRelative.startsWith('../') ||
    isAbsolute(repositoryRelative)
  )
    return undefined
  const rejected = { rejected: true }
  if (
    !repositoryRelative ||
    String(excludedPath).split(/[\\/]+/u).includes('..')
  )
    return rejected
  let entry
  try {
    // Only the root-owned macOS temporary aliases above may change a path's
    // spelling. Any other symlink, missing target, or mount boundary fails
    // closed and remains visible to `git status`.
    entry = lstatSync(candidate, { bigint: true })
    const privateMode = entry.mode & 0o777n
    const effectiveUserId = currentEffectiveUserId()
    if (
      realpathSync(repositoryRoot) !== repositoryIdentity ||
      realpathSync(candidate) !== candidateIdentity ||
      !entry.isDirectory() ||
      statSync(repositoryIdentity, { bigint: true }).dev !== entry.dev ||
      (effectiveUserId !== undefined &&
        (entry.uid !== BigInt(effectiveUserId) || privateMode !== 0o700n))
    )
      return rejected
  } catch {
    return rejected
  }
  return {
    rejected: false,
    pathspec: `:(exclude,top,literal)${repositoryRelative}`,
    candidate,
    candidateIdentity,
    identity: {
      dev: entry.dev,
      ino: entry.ino,
      uid: entry.uid,
      gid: entry.gid,
      mode: entry.mode,
    },
  }
}

function publicationCleanlinessExclusionIsCurrent(exclusion) {
  try {
    if (realpathSync(exclusion.candidate) !== exclusion.candidateIdentity)
      return false
    const entry = lstatSync(exclusion.candidate, { bigint: true })
    const effectiveUserId = currentEffectiveUserId()
    return (
      entry.isDirectory() &&
      (effectiveUserId === undefined ||
        entry.uid === BigInt(effectiveUserId)) &&
      entry.dev === exclusion.identity.dev &&
      entry.ino === exclusion.identity.ino &&
      entry.uid === exclusion.identity.uid &&
      entry.gid === exclusion.identity.gid &&
      entry.mode === exclusion.identity.mode
    )
  } catch {
    return false
  }
}

export function publicationRepositoryForCurrentCheckout(excludedPaths = []) {
  const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()
  const requestedExclusions = excludedPaths
    .map((path) => publicationCleanlinessExclusion(repositoryRoot, path))
    .filter(Boolean)
  const exclusionReceipts = requestedExclusions.filter(
    ({ rejected }) => !rejected,
  )
  const exclusions = exclusionReceipts.map(({ pathspec }) => pathspec)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  const status = execFileSync(
    'git',
    ['status', '--short', '--untracked-files=all', '--', '.', ...exclusions],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim()
  return {
    commit,
    dirty:
      status.length > 0 ||
      requestedExclusions.some(({ rejected }) => rejected) ||
      !exclusionReceipts.every(publicationCleanlinessExclusionIsCurrent),
  }
}

export async function writeRouteParity(entry, output, bundle, repository) {
  const { graph } = bundle
  const routePath = resolve('dist/blog', entry, 'index.html')
  let html
  try {
    html = await readFile(routePath, 'utf8')
  } catch {
    throw new Error(
      `Canonical Astro route is unavailable at ${routePath}; run the normal Astro build before publication:build`,
    )
  }
  const route = collectElements(parse(html))
  const graphHeadings = graph.nodes
    .filter((node) => node.type === 'heading')
    .map((node) => node.text)
  let cursor = 0
  for (const heading of graphHeadings) {
    const index = route.headings.indexOf(heading, cursor)
    if (index < 0)
      throw new Error(
        `Canonical Astro route is missing publication heading: ${heading}`,
      )
    cursor = index + 1
  }
  const graphBody = publicationGraphBodyFingerprint(graph)
  const routeBody = canonicalRouteBodyFingerprint(html)
  if (JSON.stringify(graphBody) !== JSON.stringify(routeBody))
    throw new Error('Canonical Astro route body semantics differ from the publication graph')
  const graphImageNodes = graph.nodes.filter(
    (node) =>
      (node.type === 'figure' && node.assetIds.length > 0) ||
      (node.type === 'media' && node.mediaKind === 'image'),
  )
  const usedRouteImageIndexes = new Set()
  const graphImages = []
  for (const node of graphImageNodes) {
    const assetId = node.type === 'figure' ? node.assetIds[0] : node.assetId
    const descriptor = bundle.assetBundle.descriptor.assets.find(
      (asset) => asset.id === assetId,
    )
    if (!descriptor)
      throw new Error(`Publication graph image asset is missing: ${assetId}`)
    const alternativeText =
      [
        node.accessibility.alternativeText,
        node.accessibility.longDescription,
        node.accessibility.transcript,
      ].find((value) => typeof value === 'string' && value.trim()) ?? ''
    const stem = assetStem(descriptor.fileName)
    const imageIndex = consumeRouteImageIndex(
      route.images,
      usedRouteImageIndexes,
      alternativeText,
      stem,
    )
    const image = imageIndex >= 0 ? route.images[imageIndex] : undefined
    if (!image)
      throw new Error(
        `Canonical Astro route is missing local image asset for ${assetId}`,
      )
    graphImages.push({
      assetId,
      fileName: descriptor.fileName,
      sha256: descriptor.sha256,
      routeSrc: image.src,
      routeSha256: await (async () => {
        const rawSrc = String(image.src ?? '').split(/[?#]/u)[0]
        if (!isLocalRouteAsset(rawSrc) || !rawSrc)
          throw new Error(`Canonical Astro route image is not local for ${assetId}`)
        const routeRoot = resolve('dist')
        const candidate = isAbsolute(rawSrc)
          ? resolve(routeRoot, rawSrc.replace(/^[/\\]+/u, ''))
          : resolve(dirname(routePath), rawSrc)
        const escaped = relative(routeRoot, candidate).split(sep).join('/')
        if (escaped.startsWith('../') || isAbsolute(escaped))
          throw new Error(`Canonical Astro route image escapes dist for ${assetId}`)
        return createHash('sha256').update(await readFile(candidate)).digest('hex')
      })(),
      alternativeText,
    })
  }
  const graphImageAlternatives = graphImages
    .map((image) => image.alternativeText)
    .filter(Boolean)
  const publicationReceipt = await readFile(
    resolve(output, 'publication-receipt.json'),
  )
  await writeFile(
    resolve(output, 'astro-route-parity.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        canonicalRoute: `/blog/${entry}`,
        graphSha256: createHash('sha256')
          .update(serializePublicationGraph(graph))
          .digest('hex'),
        assetBundleSha256: createHash('sha256')
          .update(serializeAssetBundle(bundle.assetBundle))
          .digest('hex'),
        publicationReceiptSha256: publicationReceiptDigest(publicationReceipt),
        repositoryCommit:
          repository?.commit ?? publicationRepositoryForCurrentCheckout().commit,
        repositoryDirty:
          repository?.dirty ?? publicationRepositoryForCurrentCheckout().dirty,
        routeHtmlSha256: publicationRouteHtmlDigest(html),
        headingOrder: graphHeadings,
        bodyOrder: graphBody,
        localImageAlternatives: graphImageAlternatives,
        imageBindings: graphImages,
        result: 'passed',
      },
      null,
      2,
    )}\n`,
    // Exclusive creation inside the invocation-owned staging directory.
    { flag: 'wx' },
  )
}

export async function bindPublicationSourceReceipt(
  output,
  bundle,
  routeParity,
  cleanlinessExclusions = [],
) {
  const receiptPath = resolve(output, 'publication-receipt.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const source = publicationSourceReceipt(bundle, routeParity)
  if (
    receipt.source?.graphSha256 !== source.graphSha256 ||
    receipt.source?.assetBundleSha256 !== source.assetBundleSha256
  )
    throw new Error('Publication renderer receipt does not match its source bundle')
  receipt.source = source
  receipt.repository = publicationRepositoryForCurrentCheckout(
    cleanlinessExclusions,
  )
  // In-place update of a receipt this invocation created inside its private
  // staging directory; the bound result is then published atomically.
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

export async function publicationBuild(argv = process.argv.slice(2), runtime = {}) {
  const options = parsePublicationBuildArgs(argv)
  assertAtomicPublicationPlatform(runtime.platform ?? process.platform)
  assertAtomicPublicationRuntime()
  // Repository-local final outputs must already be git-ignored. Invocation-owned
  // staging is excluded explicitly from the clean-source receipt evidence.
  const finalOutput = assertPublicationOutputDirectory(options.output)
  const registry = createDefaultPublicationAdapterRegistry()
  const locator =
    options.adapter === 'astro'
      ? { entryId: options.entry }
      : {
          document: JSON.parse(await readFile(resolve(options.input), 'utf8')),
          ...(options.mapping
            ? {
                mapping: JSON.parse(
                  await readFile(resolve(options.mapping), 'utf8'),
                ),
              }
            : {}),
        }
  const bundle = await registry.resolve(options.adapter, locator)
  // The whole build writes into a private invocation-owned staging directory
  // and only ever touches the caller-supplied output path through one final
  // atomic swap, so a reused (possibly attacker-seeded) output directory is
  // never followed into, merged into, or partially mutated.
  const staging = await createPublicationStagingDirectory(finalOutput)
  let receipt
  let boundReceipt
  try {
    const stagedOutput = resolve(staging, 'output')
    receipt = await vivliostyleRenderer.render(bundle, {
      outputDirectory: stagedOutput,
      profiles: PUBLICATION_PROFILES,
    })
    boundReceipt = await bindPublicationSourceReceipt(
      stagedOutput,
      bundle,
      options.adapter === 'astro'
        ? 'astro-canonical-route'
        : 'not-applicable',
      [staging],
    )
    if (options.adapter === 'astro')
      await writeRouteParity(options.entry, stagedOutput, bundle, boundReceipt.repository)
    await publishPublicationOutput(stagedOutput, finalOutput)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  process.stdout.write(
    `Publication matrix built at ${finalOutput} (${receipt.artifacts.length} artifacts)\n`,
  )
  return boundReceipt
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  publicationBuild().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
}
