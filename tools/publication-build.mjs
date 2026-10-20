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
import {
  buildPublicationPlan,
  canonicalRouteBodyFingerprint,
  consumeRouteImageIndex,
  publicationSourceReceiptForPlan,
  renderPublicationPlan,
  writeRouteParityFromPlan,
} from '../src/publication/publishing-facade.ts'
import { PUBLICATION_PROFILES } from '../src/publication/renderers/vivliostyle.ts'

// The canonical route helpers live with the facade, which owns the route
// parity payload. They are re-exported here so the checker and the tests
// keep one import path.
export {
  canonicalRouteBodyFingerprint,
  consumeRouteImageIndex,
} from '../src/publication/publishing-facade.ts'

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

export function publicationSourceReceipt(plan, routeParity) {
  return {
    ...publicationSourceReceiptForPlan(plan),
    routeParity,
  }
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

export async function bindPublicationSourceReceipt(
  output,
  source,
  routeParity,
  cleanlinessExclusions = [],
) {
  const receiptPath = resolve(output, 'publication-receipt.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const bound = { ...source, routeParity }
  if (
    receipt.source?.graphSha256 !== bound.graphSha256 ||
    receipt.source?.assetBundleSha256 !== bound.assetBundleSha256
  )
    throw new Error('Publication renderer receipt does not match its source bundle')
  receipt.source = bound
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
  const source =
    options.adapter === 'astro'
      ? { adapterId: 'astro', entryId: options.entry }
      : {
          adapterId: 'payload-lexical',
          document: JSON.parse(await readFile(resolve(options.input), 'utf8')),
          ...(options.mapping
            ? {
                mapping: JSON.parse(
                  await readFile(resolve(options.mapping), 'utf8'),
                ),
              }
            : {}),
        }
  // The facade owns the source-to-plan conversion. The plan is the only
  // publication semantics the builder sees; it never sees the renderer plan.
  const buildPlan = runtime.buildPlan ?? buildPublicationPlan
  const plan = await buildPlan(source)
  const routeParity =
    options.adapter === 'astro' ? 'astro-canonical-route' : 'not-applicable'
  // The whole build writes into a private invocation-owned staging directory
  // and only ever touches the caller-supplied output path through one final
  // atomic swap, so a reused (possibly attacker-seeded) output directory is
  // never followed into, merged into, or partially mutated.
  const staging = await createPublicationStagingDirectory(finalOutput)
  let receipt
  let boundReceipt
  try {
    const stagedOutput = resolve(staging, 'output')
    receipt = await renderPublicationPlan(plan, {
      outputDirectory: stagedOutput,
      profiles: PUBLICATION_PROFILES,
      routeParity,
    })
    boundReceipt = await bindPublicationSourceReceipt(
      stagedOutput,
      publicationSourceReceiptForPlan(plan),
      routeParity,
      [staging],
    )
    if (options.adapter === 'astro')
      await writeRouteParityFromPlan(plan, {
        entry: options.entry,
        output: stagedOutput,
        repository: boundReceipt.repository,
      })
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
