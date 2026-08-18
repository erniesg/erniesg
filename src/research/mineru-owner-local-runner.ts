import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants, createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MINERU_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  MINERU_MAX_ARTIFACT_COUNT,
  MINERU_MAX_OWNER_CACHE_BYTES,
  MINERU_MAX_RAW_OUTPUT_BYTES,
  MINERU_PRODUCTION_BINDING,
  MINERU_PRODUCTION_MODEL_ARCHITECTURE,
  MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
  MINERU_PRODUCTION_MODEL_FILE,
  MINERU_PRODUCTION_MODEL_SHA256,
  type MineruArtifactKind,
  type MineruArtifactManifest,
  type MineruProducerReceipt,
} from './mineru-source-evidence.ts'

const MAX_RUNNER_OUTPUT_BYTES = 4 * 1024 * 1024
const RUNNER_SCHEMA_VERSION = '1.0.0' as const

export const OWNER_LOCAL_MINERU_HELP = `Usage:
  node --experimental-strip-types src/research/mineru-owner-local-runner.ts \\
    --pdf /absolute/input.pdf \\
    --run-root /absolute/private-runs \\
    --mineru /absolute/venv/bin/mineru \\
    --python /absolute/venv/bin/python3.12 \\
    --config /absolute/mineru.json \\
    --model-root /absolute/pinned-model \\
    --max-output-bytes 1073741824

The runner creates a new mode-0700 directory, forces MinerU offline, and prints
only a hash-bound JSON receipt. It never uploads the source or writes raw output
inside the Git checkout.`

export type OwnerLocalMineruRunnerOptions = {
  pdfPath: string
  runRoot: string
  mineruExecutable: string
  pythonExecutable: string
  configPath: string
  modelRoot: string
  maxCacheBytes?: number
  maxOutputBytes?: number
}

export type OwnerLocalMineruRun = {
  schemaVersion: typeof RUNNER_SCHEMA_VERSION
  runDirectory: string
  manifestPath: string
  manifest: MineruArtifactManifest
}

type IdentityMeasurement = {
  execution: MineruArtifactManifest['execution']
  mineruExecutableSha256: string
  mineruConfigSha256: string
  modelConfigSha256: string
  runtimeInventorySha256: string
  runtimeTreeByteLength: number
  cacheInventorySha256: string
  cacheByteLength: number
}

type StableFileIdentity = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

type MeasuredRunnerIdentity = IdentityMeasurement & {
  rootRef: string
  mineruExecutablePath: string
  pythonExecutablePath: string
  networkIsolationExecutablePath: string
  networkIsolationExecutableSha256: string
  mineruExecutableIdentity: StableFileIdentity
  pythonExecutableIdentity: StableFileIdentity
  networkIsolationExecutableIdentity: StableFileIdentity
  networkIsolationAuxiliaryFiles: Array<{
    path: string
    sha256: string
    identity: StableFileIdentity
  }>
  modelRootPath: string
  configPath: string
}

type SealedOwnerLocalExecution = Readonly<{
  options: OwnerLocalMineruRunnerOptions
  sourcePreflight: Awaited<ReturnType<typeof inspectPdf>>
  identity: MeasuredRunnerIdentity
  readOnlyRoots: readonly string[]
  privateSnapshotByteLength: number
  sealedIsolationSha256: string
  preflightConfigPath: string
  preflightConfigSha256: string
}>

type OutputFile = {
  absolutePath: string
  relativePath: string
  size: number
}

export type OwnerLocalSealedTreeSnapshot = Readonly<{
  sourceRoot: string
  sealedRoot: string
  byteLength: number
  allocatedByteLength: number
  fileCount: number
  inventorySha256: string
}>

function fail(code: string): never {
  throw new Error(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) fail('MINERU_RUNNER_NON_CANONICAL_VALUE')
  return encoded
}

function canonicalHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

async function hashFile(path: string) {
  const digest = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => digest.update(chunk))
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  return digest.digest('hex')
}

async function secureRegularFile(path: string, code: string) {
  if (!isAbsolute(path)) fail(code)
  const canonical = await realpath(path)
  const before = await stat(canonical)
  if (!before.isFile() || before.size < 1) fail(code)
  const identity = fileIdentity(before)
  const sha256 = await hashFile(canonical)
  const after = await stat(canonical)
  if (!after.isFile() || !sameFileIdentity(identity, fileIdentity(after))) {
    fail(`${code}_CHANGED_DURING_MEASUREMENT`)
  }
  return { canonical, size: before.size, sha256, identity }
}

function fileIdentity(
  details: Awaited<ReturnType<typeof stat>>,
): StableFileIdentity {
  return {
    dev: Number(details.dev),
    ino: Number(details.ino),
    size: Number(details.size),
    mtimeMs: Number(details.mtimeMs),
    ctimeMs: Number(details.ctimeMs),
  }
}

function sameFileIdentity(
  left: StableFileIdentity,
  right: StableFileIdentity,
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function compareCanonicalCodeUnits(left: string, right: string) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

async function listFiles(
  root: string,
  options: { accountSymlinksWithoutFollowing?: boolean } = {},
): Promise<OutputFile[]> {
  const canonicalRoot = await realpath(root)
  const output: OutputFile[] = []
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(canonicalRoot, path)
      if (
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        fail('MINERU_RUNNER_PATH_ESCAPE')
      }
      const details = await lstat(path)
      if (details.isSymbolicLink()) {
        if (!options.accountSymlinksWithoutFollowing) {
          fail('MINERU_RUNNER_SYMLINK_REJECTED')
        }
        output.push({
          absolutePath: path,
          relativePath,
          size: Math.max(1, details.size, Number(details.blocks) * 512),
        })
        continue
      }
      if (details.isDirectory()) await visit(path)
      else if (details.isFile()) {
        output.push({
          absolutePath: path,
          relativePath,
          size: details.size,
        })
      } else fail('MINERU_RUNNER_UNSUPPORTED_FILE')
    }
  }
  await visit(canonicalRoot)
  return output.sort((left, right) =>
    compareCanonicalCodeUnits(left.relativePath, right.relativePath),
  )
}

async function listMaterializedExecutionFiles(
  root: string,
): Promise<OutputFile[]> {
  const canonicalRoot = await realpath(root)
  const output: OutputFile[] = []
  const visit = async (
    sourceDirectory: string,
    logicalDirectory: string,
    ancestry: ReadonlySet<string>,
  ) => {
    const canonicalDirectory = await realpath(sourceDirectory)
    if (ancestry.has(canonicalDirectory)) {
      fail('MINERU_RUNNER_SEALED_SNAPSHOT_CYCLE')
    }
    const nextAncestry = new Set(ancestry).add(canonicalDirectory)
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    entries.sort((left, right) =>
      compareCanonicalCodeUnits(left.name, right.name),
    )
    for (const entry of entries) {
      const sourcePath = join(sourceDirectory, entry.name)
      const logicalPath = join(logicalDirectory, entry.name)
      const sourceDetails = await lstat(sourcePath)
      const copySource = sourceDetails.isSymbolicLink()
        ? await realpath(sourcePath)
        : sourcePath
      const copyDetails = await stat(copySource)
      if (copyDetails.isDirectory()) {
        await visit(copySource, logicalPath, nextAncestry)
      } else if (copyDetails.isFile()) {
        output.push({
          absolutePath: copySource,
          relativePath: relative(canonicalRoot, logicalPath),
          size: copyDetails.size,
        })
      } else {
        fail('MINERU_RUNNER_UNSUPPORTED_SEALED_SNAPSHOT_ENTRY')
      }
    }
  }
  await visit(canonicalRoot, canonicalRoot, new Set())
  return output.sort((left, right) =>
    compareCanonicalCodeUnits(left.relativePath, right.relativePath),
  )
}

async function treeMeasurement(
  root: string,
  precomputed = new Map<string, string>(),
  options: { materializeSymlinks?: boolean } = {},
) {
  const files = options.materializeSymlinks
    ? await listMaterializedExecutionFiles(root)
    : await listFiles(root)
  const inventory = []
  for (const file of files) {
    inventory.push({
      pathSha256: createHash('sha256').update(file.relativePath).digest('hex'),
      byteLength: file.size,
      sha256:
        precomputed.get(await realpath(file.absolutePath)) ??
        (await hashFile(file.absolutePath)),
    })
  }
  return {
    sha256: canonicalHash(inventory),
    byteLength: inventory.reduce((total, item) => total + item.byteLength, 0),
  }
}

export async function measureOwnerLocalExecutionTree(sourceRoot: string) {
  if (!isAbsolute(sourceRoot)) {
    fail('MINERU_RUNNER_INVALID_SEALED_SNAPSHOT')
  }
  return treeMeasurement(sourceRoot, new Map(), {
    materializeSymlinks: true,
  })
}

/**
 * Clone an execution tree into the private run directory before inference.
 * Symlinks are materialized as their referenced file bytes, so the child
 * process never follows a mutable path outside the sealed tree. Reflinks are
 * requested when the filesystem supports them and copyFile safely falls back
 * to an ordinary copy otherwise.
 */
export async function sealOwnerLocalExecutionTree(input: {
  sourceRoot: string
  sealedRoot: string
  maximumLogicalBytes: number
  maximumAllocatedBytes: number
  copyMode?: 'reflink-or-copy' | 'ordinary-copy'
}): Promise<OwnerLocalSealedTreeSnapshot> {
  if (
    !isAbsolute(input.sourceRoot) ||
    !isAbsolute(input.sealedRoot) ||
    !Number.isSafeInteger(input.maximumLogicalBytes) ||
    input.maximumLogicalBytes < 1 ||
    !Number.isSafeInteger(input.maximumAllocatedBytes) ||
    input.maximumAllocatedBytes < 1
  ) {
    fail('MINERU_RUNNER_INVALID_SEALED_SNAPSHOT')
  }
  const sourceRoot = await realpath(input.sourceRoot)
  const sourceDetails = await stat(sourceRoot)
  if (!sourceDetails.isDirectory()) {
    fail('MINERU_RUNNER_INVALID_SEALED_SNAPSHOT')
  }
  await mkdir(input.sealedRoot, { recursive: false, mode: 0o700 })
  const sealedRoot = await realpath(input.sealedRoot)
  if (
    sealedRoot === sourceRoot ||
    sealedRoot.startsWith(`${sourceRoot}${sep}`) ||
    sourceRoot.startsWith(`${sealedRoot}${sep}`)
  ) {
    fail('MINERU_RUNNER_INVALID_SEALED_SNAPSHOT')
  }
  let byteLength = 0
  let allocatedByteLength = 0
  let fileCount = 0
  const inventory: Array<{
    relativePath: string
    pathSha256: string
    byteLength: number
    sha256: string
  }> = []
  const visit = async (
    sourceDirectory: string,
    sealedDirectory: string,
    ancestry: ReadonlySet<string>,
  ) => {
    const canonicalSourceDirectory = await realpath(sourceDirectory)
    if (ancestry.has(canonicalSourceDirectory)) {
      fail('MINERU_RUNNER_SEALED_SNAPSHOT_CYCLE')
    }
    const nextAncestry = new Set(ancestry).add(canonicalSourceDirectory)
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    entries.sort((left, right) =>
      compareCanonicalCodeUnits(left.name, right.name),
    )
    for (const entry of entries) {
      const sourcePath = join(sourceDirectory, entry.name)
      const sealedPath = join(sealedDirectory, entry.name)
      const sourcePathDetails = await lstat(sourcePath)
      let copySource = sourcePath
      if (sourcePathDetails.isSymbolicLink()) {
        copySource = await realpath(sourcePath)
      }
      const copyDetails = await stat(copySource)
      if (copyDetails.isDirectory()) {
        await mkdir(sealedPath, { mode: 0o700 })
        await visit(copySource, sealedPath, nextAncestry)
        await chmod(sealedPath, 0o555)
        continue
      }
      if (!copyDetails.isFile()) {
        fail('MINERU_RUNNER_UNSUPPORTED_SEALED_SNAPSHOT_ENTRY')
      }
      byteLength += copyDetails.size
      fileCount += 1
      if (byteLength > input.maximumLogicalBytes) {
        fail('MINERU_RUNNER_SEALED_SNAPSHOT_BOUND_EXCEEDED')
      }
      await copyFile(
        copySource,
        sealedPath,
        input.copyMode === 'ordinary-copy'
          ? 0
          : fsConstants.COPYFILE_FICLONE,
      )
      const executable = (copyDetails.mode & 0o111) !== 0
      await chmod(sealedPath, executable ? 0o555 : 0o444)
      const sealedDetails = await stat(sealedPath)
      allocatedByteLength += Math.max(
        0,
        Number(sealedDetails.blocks) * 512,
      )
      if (allocatedByteLength > input.maximumAllocatedBytes) {
        fail('MINERU_RUNNER_SEALED_SNAPSHOT_BOUND_EXCEEDED')
      }
      const relativePath = relative(sealedRoot, sealedPath)
      inventory.push({
        relativePath,
        pathSha256: createHash('sha256').update(relativePath).digest('hex'),
        byteLength: copyDetails.size,
        sha256: await hashFile(sealedPath),
      })
    }
  }
  await visit(sourceRoot, sealedRoot, new Set())
  await chmod(sealedRoot, 0o555)
  const canonicalInventory = inventory
    .sort((left, right) =>
      compareCanonicalCodeUnits(left.relativePath, right.relativePath),
    )
    .map(({ relativePath: _relativePath, ...item }) => item)
  return Object.freeze({
    sourceRoot,
    sealedRoot,
    byteLength,
    allocatedByteLength,
    fileCount,
    inventorySha256: canonicalHash(canonicalInventory),
  })
}

export async function assertOwnerLocalSealedPreflightIdentity(input: {
  runtimeSnapshot: OwnerLocalSealedTreeSnapshot
  expectedRuntimeInventorySha256: string
  expectedRuntimeTreeByteLength: number
  sealedPreflightConfigPath: string
  expectedPreflightConfigSha256: string
}) {
  if (
    input.runtimeSnapshot.inventorySha256 !==
      input.expectedRuntimeInventorySha256 ||
    input.runtimeSnapshot.byteLength !== input.expectedRuntimeTreeByteLength
  ) {
    fail('MINERU_RUNNER_SEALED_RUNTIME_IDENTITY_MISMATCH')
  }
  const config = await secureRegularFile(
    input.sealedPreflightConfigPath,
    'MINERU_RUNNER_SEALED_PREFLIGHT_CONFIG',
  )
  if (config.sha256 !== input.expectedPreflightConfigSha256) {
    fail('MINERU_RUNNER_SEALED_CONFIG_IDENTITY_MISMATCH')
  }
}

async function insideGitCheckout(path: string) {
  let current = await realpath(path)
  for (;;) {
    try {
      await lstat(join(current, '.git'))
      return true
    } catch (error) {
      if (
        !record(error) ||
        (error as unknown as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw error
      }
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function installedPackageRoots(mineruExecutable: string) {
  const environmentRoot = dirname(dirname(mineruExecutable))
  const sitePackages = join(
    environmentRoot,
    'lib',
    'python3.12',
    'site-packages',
  )
  return {
    sitePackages,
    mineru: join(sitePackages, 'mineru-3.4.4.dist-info'),
    mineruVl: join(sitePackages, 'mineru_vl_utils-1.2.1.dist-info'),
    mlx: join(sitePackages, 'mlx-0.31.1.dist-info'),
    mlxVlm: join(sitePackages, 'mlx_vlm-0.3.12.dist-info'),
  }
}

async function assertPackageMetadata(
  sitePackages: string,
  path: string,
  name: string,
  version: string,
) {
  const metadata = await readFile(join(path, 'METADATA'), 'utf8')
  const normalizeDistributionName = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[._-]+/gu, '-')
  const installedName = metadata
    .split(/\r?\n/u)
    .find((line) => line.startsWith('Name: '))
    ?.slice('Name: '.length)
  if (
    installedName === undefined ||
    normalizeDistributionName(installedName) !==
      normalizeDistributionName(name) ||
    !metadata.split(/\r?\n/u).includes(`Version: ${version}`)
  ) {
    fail('MINERU_RUNNER_PACKAGE_IDENTITY_MISMATCH')
  }
  const recordFile = await secureRegularFile(
    join(path, 'RECORD'),
    'MINERU_RUNNER_PACKAGE_RECORD_MISSING',
  )
  const recordText = await readFile(recordFile.canonical, 'utf8')
  const environmentRoot = resolve(sitePackages, '../../..')
  const verifiedFiles: Array<{
    pathSha256: string
    byteLength: number
    sha256: string
  }> = []
  for (const line of recordText.split(/\r?\n/u).filter(Boolean)) {
    const columns = line.split(',')
    if (columns.length !== 3) fail('MINERU_RUNNER_INVALID_PACKAGE_RECORD')
    const [relativePath, digestField, sizeField] = columns
    if (!relativePath || relativePath.includes('\\')) {
      fail('MINERU_RUNNER_INVALID_PACKAGE_RECORD')
    }
    if (digestField === '' && sizeField === '') {
      if (resolve(sitePackages, relativePath) !== recordFile.canonical) {
        fail('MINERU_RUNNER_INVALID_PACKAGE_RECORD')
      }
      continue
    }
    if (
      !digestField?.startsWith('sha256=') ||
      !/^\d+$/u.test(sizeField ?? '')
    ) {
      fail('MINERU_RUNNER_INVALID_PACKAGE_RECORD')
    }
    const absolutePath = resolve(sitePackages, relativePath)
    const relativeToRoot = relative(environmentRoot, absolutePath)
    if (
      relativeToRoot === '..' ||
      relativeToRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeToRoot)
    ) {
      fail('MINERU_RUNNER_INVALID_PACKAGE_RECORD')
    }
    const details = await lstat(absolutePath)
    if (!details.isFile() || details.isSymbolicLink()) {
      fail('MINERU_RUNNER_PACKAGE_IDENTITY_MISMATCH')
    }
    const actualSha256 = await hashFile(absolutePath)
    const expectedDigest = digestField.slice('sha256='.length)
    const actualDigest = Buffer.from(actualSha256, 'hex').toString('base64url')
    if (Number(sizeField) !== details.size || actualDigest !== expectedDigest) {
      fail('MINERU_RUNNER_PACKAGE_IDENTITY_MISMATCH')
    }
    verifiedFiles.push({
      pathSha256: createHash('sha256').update(relativePath).digest('hex'),
      byteLength: details.size,
      sha256: actualSha256,
    })
  }
  if (verifiedFiles.length === 0) fail('MINERU_RUNNER_INVALID_PACKAGE_RECORD')
  return {
    name,
    version,
    metadataSha256: createHash('sha256').update(metadata).digest('hex'),
    recordSha256: recordFile.sha256,
    installedFilesSha256: canonicalHash(verifiedFiles),
  }
}

async function inspectPdf(pdfPath: string) {
  const source = await secureRegularFile(pdfPath, 'MINERU_RUNNER_INVALID_PDF')
  const sourceBytes = new Uint8Array(await readFile(source.canonical))
  if (
    createHash('sha256').update(sourceBytes).digest('hex') !== source.sha256 ||
    !sameFileIdentity(
      source.identity,
      fileIdentity(await stat(source.canonical)),
    )
  ) {
    fail('MINERU_RUNNER_SOURCE_CHANGED_DURING_PREFLIGHT')
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data: sourceBytes,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  })
  const document = await task.promise
  const pages = []
  try {
    for (let page = 1; page <= document.numPages; page += 1) {
      const sourcePage = await document.getPage(page)
      const viewport = sourcePage.getViewport({ scale: 1 })
      pages.push({
        page,
        width: viewport.width,
        height: viewport.height,
        rotation: ((viewport.rotation % 360) + 360) % 360,
      })
      sourcePage.cleanup()
    }
  } finally {
    await document.destroy()
  }
  if (pages.length < 1) fail('MINERU_RUNNER_INVALID_PDF')
  return { source, pages }
}

function samePdfInspection(
  left: Awaited<ReturnType<typeof inspectPdf>>,
  right: Awaited<ReturnType<typeof inspectPdf>>,
) {
  return (
    left.source.canonical === right.source.canonical &&
    left.source.sha256 === right.source.sha256 &&
    sameFileIdentity(left.source.identity, right.source.identity) &&
    canonicalJson(left.pages) === canonicalJson(right.pages)
  )
}

const MACOS_DENY_NETWORK_PROFILE =
  '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))'
const LINUX_LOOPBACK_SETUP =
  'set -eu; readonly_count="$1"; shift; while [ "$readonly_count" -gt 0 ]; do target="$1"; shift; /usr/bin/mount --bind "$target" "$target"; /usr/bin/mount -o remount,bind,ro "$target"; readonly_count=$((readonly_count - 1)); done; /usr/sbin/ip link set lo up; exec "$@"'

function networkIsolationBinding() {
  if (platform() === 'darwin' && arch() === 'arm64') {
    return {
      kind: 'macos-sandbox-exec-deny-network-v1' as const,
      executable: '/usr/bin/sandbox-exec',
      policy: MACOS_DENY_NETWORK_PROFILE,
      auxiliaries: [] as string[],
    }
  }
  if (platform() === 'linux' && arch() === 'arm64') {
    return {
      kind: 'linux-user-netns-loopback-only-v1' as const,
      executable: '/usr/bin/unshare',
      policy: `unshare --user --map-root-user --net; ${LINUX_LOOPBACK_SETUP}`,
      auxiliaries: ['/bin/sh', '/usr/bin/mount', '/usr/sbin/ip'],
    }
  }
  fail('MINERU_RUNNER_UNSUPPORTED_HOST')
}

async function measureIdentity(options: OwnerLocalMineruRunnerOptions) {
  const mineru = await secureRegularFile(
    options.mineruExecutable,
    'MINERU_RUNNER_INVALID_EXECUTABLE',
  )
  const runtime = await secureRegularFile(
    options.pythonExecutable,
    'MINERU_RUNNER_INVALID_RUNTIME',
  )
  const config = await secureRegularFile(
    options.configPath,
    'MINERU_RUNNER_INVALID_CONFIG',
  )
  const model = await secureRegularFile(
    join(options.modelRoot, MINERU_PRODUCTION_MODEL_FILE),
    'MINERU_RUNNER_INVALID_MODEL',
  )
  if (
    model.size !== MINERU_PRODUCTION_MODEL_BYTE_LENGTH ||
    model.sha256 !== MINERU_PRODUCTION_MODEL_SHA256
  ) {
    fail('MINERU_RUNNER_MODEL_IDENTITY_MISMATCH')
  }
  const modelConfigFile = await secureRegularFile(
    join(options.modelRoot, 'config.json'),
    'MINERU_RUNNER_INVALID_MODEL_CONFIG',
  )
  const isolation = networkIsolationBinding()
  const networkIsolationExecutable = await secureRegularFile(
    isolation.executable,
    'MINERU_RUNNER_NETWORK_ISOLATION_UNAVAILABLE',
  )
  const networkIsolationAuxiliaryFiles = await Promise.all(
    isolation.auxiliaries.map(async (path) => {
      const measured = await secureRegularFile(
        path,
        'MINERU_RUNNER_NETWORK_ISOLATION_UNAVAILABLE',
      )
      return {
        path: resolve(path),
        sha256: measured.sha256,
        identity: measured.identity,
      }
    }),
  )
  const isolationPolicySha256 = canonicalHash({
    executableSha256: networkIsolationExecutable.sha256,
    auxiliarySha256: networkIsolationAuxiliaryFiles.map(
      ({ path, sha256 }) => ({ path, sha256 }),
    ),
    policy: isolation.policy,
  })
  let modelConfig: unknown
  let mineruConfig: unknown
  try {
    modelConfig = JSON.parse(await readFile(modelConfigFile.canonical, 'utf8'))
    mineruConfig = JSON.parse(await readFile(config.canonical, 'utf8'))
  } catch {
    fail('MINERU_RUNNER_INVALID_CONFIG')
  }
  if (
    !record(modelConfig) ||
    !Array.isArray(modelConfig.architectures) ||
    !modelConfig.architectures.includes(MINERU_PRODUCTION_MODEL_ARCHITECTURE) ||
    modelConfig.model_type !== 'qwen2_vl' ||
    !record(mineruConfig) ||
    mineruConfig['model-source'] !== 'local' ||
    !record(mineruConfig['models-dir']) ||
    typeof mineruConfig['models-dir'].vlm !== 'string' ||
    (await realpath(mineruConfig['models-dir'].vlm)) !==
      (await realpath(options.modelRoot))
  ) {
    fail('MINERU_RUNNER_CONFIG_BINDING_MISMATCH')
  }
  const packages = installedPackageRoots(mineru.canonical)
  const packageRecords = [
    await assertPackageMetadata(
      packages.sitePackages,
      packages.mineru,
      'mineru',
      '3.4.4',
    ),
    await assertPackageMetadata(
      packages.sitePackages,
      packages.mineruVl,
      'mineru-vl-utils',
      '1.2.1',
    ),
  ]
  let execution: MineruArtifactManifest['execution']
  if (platform() === 'darwin' && arch() === 'arm64') {
    packageRecords.push(
      await assertPackageMetadata(
        packages.sitePackages,
        packages.mlx,
        'mlx',
        '0.31.1',
      ),
      await assertPackageMetadata(
        packages.sitePackages,
        packages.mlxVlm,
        'mlx-vlm',
        '0.3.12',
      ),
    )
    execution = {
      hostClass: 'owner-laptop',
      operatingSystem: `macOS-${release()}`,
      architecture: 'arm64',
      runtime: 'python-3.12',
      backend: 'mlx-vlm',
      backendVersion: 'mlx-vlm-0.3.12+mlx-0.31.1',
      runtimeSha256: runtime.sha256,
      backendSha256: canonicalHash(packageRecords.slice(2)),
      packageSetSha256: canonicalHash(packageRecords),
      cacheNamespaceSha256: '0'.repeat(64),
      networkIsolation: isolation.kind,
      networkIsolationSha256: isolationPolicySha256,
    }
  } else if (platform() === 'linux' && arch() === 'arm64') {
    const torch = join(packages.sitePackages, 'torch-2.13.0+cpu.dist-info')
    packageRecords.push(
      await assertPackageMetadata(
        packages.sitePackages,
        torch,
        'torch',
        '2.13.0+cpu',
      ),
    )
    execution = {
      hostClass: 'trusted-vm',
      operatingSystem: `Linux-${release()}`,
      architecture: 'arm64',
      runtime: 'python-3.12',
      backend: 'torch-cpu',
      backendVersion: 'torch-2.13.0+cpu',
      runtimeSha256: runtime.sha256,
      backendSha256: canonicalHash(packageRecords.slice(2)),
      packageSetSha256: canonicalHash(packageRecords),
      cacheNamespaceSha256: '0'.repeat(64),
      networkIsolation: isolation.kind,
      networkIsolationSha256: isolationPolicySha256,
    }
  } else fail('MINERU_RUNNER_UNSUPPORTED_HOST')
  const cache = await treeMeasurement(
    options.modelRoot,
    new Map([[model.canonical, model.sha256]]),
  )
  const runtimeTree = await measureOwnerLocalExecutionTree(
    dirname(dirname(options.mineruExecutable)),
  )
  const rootRef = `cache-${cache.sha256.slice(0, 32)}`
  execution.cacheNamespaceSha256 = canonicalHash({
    rootRef,
    namespace: 'mineru-production',
  })
  return {
    execution,
    mineruExecutableSha256: mineru.sha256,
    mineruConfigSha256: config.sha256,
    modelConfigSha256: modelConfigFile.sha256,
    runtimeInventorySha256: runtimeTree.sha256,
    runtimeTreeByteLength: runtimeTree.byteLength,
    cacheInventorySha256: cache.sha256,
    cacheByteLength: cache.byteLength,
    rootRef,
    mineruExecutablePath: resolve(options.mineruExecutable),
    // Preserve the venv invocation path (and therefore pyvenv.cfg discovery)
    // while measuring and rechecking the exact canonical runtime it targets.
    pythonExecutablePath: resolve(options.pythonExecutable),
    networkIsolationExecutablePath: networkIsolationExecutable.canonical,
    networkIsolationExecutableSha256: networkIsolationExecutable.sha256,
    mineruExecutableIdentity: mineru.identity,
    pythonExecutableIdentity: runtime.identity,
    networkIsolationExecutableIdentity: networkIsolationExecutable.identity,
    networkIsolationAuxiliaryFiles,
    modelRootPath: await realpath(options.modelRoot),
    configPath: config.canonical,
  }
}

function measuredIdentityProjection(identity: MeasuredRunnerIdentity) {
  return {
    execution: identity.execution,
    mineruExecutableSha256: identity.mineruExecutableSha256,
    mineruConfigSha256: identity.mineruConfigSha256,
    modelConfigSha256: identity.modelConfigSha256,
    runtimeInventorySha256: identity.runtimeInventorySha256,
    runtimeTreeByteLength: identity.runtimeTreeByteLength,
    cacheInventorySha256: identity.cacheInventorySha256,
    cacheByteLength: identity.cacheByteLength,
    rootRef: identity.rootRef,
    mineruExecutablePath: identity.mineruExecutablePath,
    pythonExecutablePath: identity.pythonExecutablePath,
    networkIsolationExecutablePath: identity.networkIsolationExecutablePath,
    networkIsolationExecutableSha256:
      identity.networkIsolationExecutableSha256,
    networkIsolationAuxiliaryFiles: identity.networkIsolationAuxiliaryFiles.map(
      ({ path, sha256 }) => ({ path, sha256 }),
    ),
    modelRootPath: identity.modelRootPath,
    configPath: identity.configPath,
  }
}

function portableMeasuredIdentityProjection(identity: MeasuredRunnerIdentity) {
  return {
    execution: identity.execution,
    mineruExecutableSha256: identity.mineruExecutableSha256,
    modelConfigSha256: identity.modelConfigSha256,
    runtimeInventorySha256: identity.runtimeInventorySha256,
    runtimeTreeByteLength: identity.runtimeTreeByteLength,
    cacheInventorySha256: identity.cacheInventorySha256,
    cacheByteLength: identity.cacheByteLength,
    rootRef: identity.rootRef,
    networkIsolationExecutableSha256:
      identity.networkIsolationExecutableSha256,
    networkIsolationAuxiliaryFiles: identity.networkIsolationAuxiliaryFiles.map(
      ({ sha256 }) => sha256,
    ),
  }
}

async function sealOwnerLocalExecution(input: {
  options: OwnerLocalMineruRunnerOptions
  measured: MeasuredRunnerIdentity
  sourcePreflight: Awaited<ReturnType<typeof inspectPdf>>
  runDirectory: string
  maximumCacheBytes: number
  reservedOutputByteLength: number
  reservedPrivateScratchByteLength: number
}): Promise<SealedOwnerLocalExecution> {
  const snapshotRoot = join(input.runDirectory, 'sealed-execution')
  await mkdir(snapshotRoot, { mode: 0o700 })
  const environmentRoot = dirname(dirname(input.options.mineruExecutable))
  const mineruRelativePath = relative(
    environmentRoot,
    input.options.mineruExecutable,
  )
  const pythonRelativePath = relative(
    environmentRoot,
    input.options.pythonExecutable,
  )
  if (
    [mineruRelativePath, pythonRelativePath].some(
      (value) =>
        value === '..' ||
        value.startsWith(`..${sep}`) ||
        isAbsolute(value),
    )
  ) {
    fail('MINERU_RUNNER_EXECUTABLE_OUTSIDE_ENVIRONMENT')
  }
  const additionalBudget =
    input.maximumCacheBytes - input.measured.cacheByteLength
  if (additionalBudget < input.sourcePreflight.source.size + 1) {
    fail('MINERU_RUNNER_CACHE_BOUND_EXCEEDED')
  }
  const environment = await sealOwnerLocalExecutionTree({
    sourceRoot: environmentRoot,
    sealedRoot: join(snapshotRoot, 'runtime'),
    maximumLogicalBytes:
      additionalBudget - input.sourcePreflight.source.size,
    maximumAllocatedBytes: additionalBudget,
  })
  const sealedPdfPath = join(snapshotRoot, 'source.pdf')
  await copyFile(
    input.sourcePreflight.source.canonical,
    sealedPdfPath,
    fsConstants.COPYFILE_FICLONE,
  )
  await chmod(sealedPdfPath, 0o444)
  const preflightConfigBytes = await readFile(input.options.configPath)
  if (
    createHash('sha256').update(preflightConfigBytes).digest('hex') !==
    input.measured.mineruConfigSha256
  ) {
    fail('MINERU_RUNNER_CONFIG_IDENTITY_DRIFT')
  }
  const preflightConfigPath = join(snapshotRoot, 'preflight-mineru.json')
  await writeFile(preflightConfigPath, preflightConfigBytes, { mode: 0o400 })
  await assertOwnerLocalSealedPreflightIdentity({
    runtimeSnapshot: environment,
    expectedRuntimeInventorySha256: input.measured.runtimeInventorySha256,
    expectedRuntimeTreeByteLength: input.measured.runtimeTreeByteLength,
    sealedPreflightConfigPath: preflightConfigPath,
    expectedPreflightConfigSha256: input.measured.mineruConfigSha256,
  })
  const configValue = JSON.parse(
    preflightConfigBytes.toString('utf8'),
  ) as Record<string, unknown>
  if (!record(configValue['models-dir'])) {
    fail('MINERU_RUNNER_CONFIG_BINDING_MISMATCH')
  }
  const sealedModelRoot = join(snapshotRoot, 'model')
  configValue['models-dir'] = {
    ...configValue['models-dir'],
    vlm: sealedModelRoot,
  }
  const sealedConfigPath = join(snapshotRoot, 'mineru.json')
  await writeFile(sealedConfigPath, canonicalJson(configValue), { mode: 0o400 })
  const sourceAllocatedByteLength = Math.max(
    0,
    Number((await stat(sealedPdfPath)).blocks) * 512,
  )
  const preflightConfigAllocatedByteLength = Math.max(
    0,
    Number((await stat(preflightConfigPath)).blocks) * 512,
  )
  const effectiveConfigAllocatedByteLength = Math.max(
    0,
    Number((await stat(sealedConfigPath)).blocks) * 512,
  )
  const modelAllocatedLimit =
    remainingOwnerLocalSealedModelAllocatedBytes({
      maximumCacheBytes: input.maximumCacheBytes,
      originalCacheByteLength: input.measured.cacheByteLength,
      runtimeAllocatedByteLength: environment.allocatedByteLength,
      sourceAllocatedByteLength,
      preflightConfigAllocatedByteLength,
      effectiveConfigAllocatedByteLength,
      reservedOutputByteLength: input.reservedOutputByteLength,
      reservedPrivateScratchByteLength:
        input.reservedPrivateScratchByteLength,
    })
  const model = await sealOwnerLocalExecutionTree({
    sourceRoot: input.options.modelRoot,
    sealedRoot: sealedModelRoot,
    maximumLogicalBytes: input.measured.cacheByteLength,
    maximumAllocatedBytes: modelAllocatedLimit,
  })
  if (
    model.byteLength !== input.measured.cacheByteLength ||
    model.inventorySha256 !== input.measured.cacheInventorySha256
  ) {
    fail('MINERU_RUNNER_SEALED_MODEL_IDENTITY_MISMATCH')
  }
  const sealedOptions: OwnerLocalMineruRunnerOptions = {
    ...input.options,
    pdfPath: sealedPdfPath,
    mineruExecutable: join(environment.sealedRoot, mineruRelativePath),
    pythonExecutable: join(environment.sealedRoot, pythonRelativePath),
    configPath: sealedConfigPath,
    modelRoot: model.sealedRoot,
  }
  const sourcePreflight = await inspectPdf(sealedPdfPath)
  if (
    sourcePreflight.source.sha256 !== input.sourcePreflight.source.sha256 ||
    sourcePreflight.source.size !== input.sourcePreflight.source.size ||
    canonicalJson(sourcePreflight.pages) !==
      canonicalJson(input.sourcePreflight.pages)
  ) {
    fail('MINERU_RUNNER_SEALED_SOURCE_IDENTITY_MISMATCH')
  }
  const identity = await measureIdentity(sealedOptions)
  if (
    canonicalJson(portableMeasuredIdentityProjection(input.measured)) !==
    canonicalJson(portableMeasuredIdentityProjection(identity))
  ) {
    fail('MINERU_RUNNER_SEALED_PROCESS_IDENTITY_MISMATCH')
  }
  identity.mineruConfigSha256 = input.measured.mineruConfigSha256
  const sealedIsolationSha256 = canonicalHash({
    policy: 'sealed-read-only-owner-local-execution-v1',
    baseNetworkIsolationSha256: identity.execution.networkIsolationSha256,
    sourcePdfSha256: sourcePreflight.source.sha256,
    runtimeInventorySha256: environment.inventorySha256,
    modelInventorySha256: model.inventorySha256,
    configSha256: await hashFile(sealedConfigPath),
    preflightConfigSha256: input.measured.mineruConfigSha256,
  })
  identity.execution.networkIsolationSha256 = sealedIsolationSha256
  await chmod(snapshotRoot, 0o555)
  return Object.freeze({
    options: sealedOptions,
    sourcePreflight,
    identity,
    readOnlyRoots: Object.freeze([
      environment.sealedRoot,
      model.sealedRoot,
      sealedPdfPath,
      preflightConfigPath,
      sealedConfigPath,
    ]),
    privateSnapshotByteLength: ownerLocalPrivateSnapshotAllocatedBytes({
      runtimeAllocatedByteLength: environment.allocatedByteLength,
      modelAllocatedByteLength: model.allocatedByteLength,
      sourceAllocatedByteLength,
      preflightConfigAllocatedByteLength,
      effectiveConfigAllocatedByteLength,
    }),
    sealedIsolationSha256,
    preflightConfigPath,
    preflightConfigSha256: input.measured.mineruConfigSha256,
  })
}

async function rebindSealedIsolationIdentity(
  identity: MeasuredRunnerIdentity,
  sealed: SealedOwnerLocalExecution,
) {
  const runtime = await measureOwnerLocalExecutionTree(
    dirname(dirname(sealed.options.mineruExecutable)),
  )
  const model = await treeMeasurement(sealed.options.modelRoot)
  const source = await secureRegularFile(
    sealed.options.pdfPath,
    'MINERU_RUNNER_SEALED_SOURCE',
  )
  const config = await secureRegularFile(
    sealed.options.configPath,
    'MINERU_RUNNER_SEALED_CONFIG',
  )
  const preflightConfig = await secureRegularFile(
    sealed.preflightConfigPath,
    'MINERU_RUNNER_SEALED_PREFLIGHT_CONFIG',
  )
  if (preflightConfig.sha256 !== sealed.preflightConfigSha256) {
    fail('MINERU_RUNNER_SEALED_PREFLIGHT_CONFIG_IDENTITY_DRIFT')
  }
  identity.execution.networkIsolationSha256 = canonicalHash({
    policy: 'sealed-read-only-owner-local-execution-v1',
    baseNetworkIsolationSha256: identity.execution.networkIsolationSha256,
    sourcePdfSha256: source.sha256,
    runtimeInventorySha256: runtime.sha256,
    modelInventorySha256: model.sha256,
    configSha256: config.sha256,
    preflightConfigSha256: preflightConfig.sha256,
  })
  if (
    identity.execution.networkIsolationSha256 !== sealed.sealedIsolationSha256
  ) {
    fail('MINERU_RUNNER_SEALED_ISOLATION_IDENTITY_DRIFT')
  }
  identity.mineruConfigSha256 = preflightConfig.sha256
  return identity
}

export function buildOwnerLocalMineruIsolationCommand(input: {
  isolation: MineruArtifactManifest['execution']['networkIsolation']
  isolationExecutable: string
  runDirectory: string
  program: string
  args: string[]
  readOnlyPaths?: readonly string[]
}) {
  const readOnlyPaths = [...new Set(input.readOnlyPaths ?? [])]
  if (readOnlyPaths.some((path) => !isAbsolute(path))) {
    fail('MINERU_RUNNER_INVALID_READ_ONLY_PATH')
  }
  if (input.isolation === 'macos-sandbox-exec-deny-network-v1') {
    const escapeSandboxLiteral = (value: string) =>
      value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    const profile = `${MACOS_DENY_NETWORK_PROFILE}${readOnlyPaths
      .map(
        (path) =>
          `(deny file-write* (subpath "${escapeSandboxLiteral(path)}"))`,
      )
      .join('')}`
    return {
      command: input.isolationExecutable,
      args: ['-p', profile, input.program, ...input.args],
    }
  }
  return {
    command: input.isolationExecutable,
    args: [
      '--user',
      '--map-root-user',
      '--net',
      '--mount',
      '/bin/sh',
      '-c',
      LINUX_LOOPBACK_SETUP,
      'mineru-netns',
      String(readOnlyPaths.length),
      ...readOnlyPaths,
      input.program,
      ...input.args,
    ],
  }
}

async function assertMeasuredFile(
  path: string,
  identity: StableFileIdentity,
  sha256: string,
  code: string,
) {
  const reopened = await secureRegularFile(path, code)
  if (
    reopened.sha256 !== sha256 ||
    !sameFileIdentity(reopened.identity, identity)
  ) {
    fail(`${code}_IDENTITY_DRIFT`)
  }
}

export async function measureOwnerLocalResourceTreeUsage(outputRoot: string) {
  const files = await listFiles(outputRoot, {
    accountSymlinksWithoutFollowing: true,
  })
  return {
    count: files.length,
    byteLength: files.reduce((total, file) => total + file.size, 0),
  }
}

async function outputUsageForRoots(roots: readonly string[]) {
  const usage = await Promise.all(
    roots.map((root) => measureOwnerLocalResourceTreeUsage(root)),
  )
  return {
    count: usage.reduce((total, value) => total + value.count, 0),
    byteLength: usage.reduce(
      (total, value) => total + value.byteLength,
      0,
    ),
    outputByteLength: usage[0]?.byteLength ?? 0,
  }
}

export function assertOwnerLocalMineruResourceUsage(input: {
  maximumOutputBytes: number
  maximumCacheBytes: number
  cacheByteLength: number
  privateSnapshotByteLength: number
  outputByteLength: number
  privateScratchByteLength: number
  fileCount: number
}) {
  if (
    !Object.values(input).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    input.maximumOutputBytes < 1 ||
    input.maximumCacheBytes < 1
  ) {
    fail('MINERU_RUNNER_INVALID_RESOURCE_BOUND')
  }
  if (
    input.fileCount > MINERU_MAX_ARTIFACT_COUNT ||
    input.outputByteLength > input.maximumOutputBytes
  ) {
    fail('MINERU_RUNNER_OUTPUT_BOUND_EXCEEDED')
  }
  if (
    input.cacheByteLength +
      input.privateSnapshotByteLength +
      input.outputByteLength +
      input.privateScratchByteLength >
    input.maximumCacheBytes
  ) {
    fail('MINERU_RUNNER_CACHE_BOUND_EXCEEDED')
  }
}

export function ownerLocalPrivateSnapshotAllocatedBytes(input: {
  runtimeAllocatedByteLength: number
  modelAllocatedByteLength: number
  sourceAllocatedByteLength: number
  preflightConfigAllocatedByteLength: number
  effectiveConfigAllocatedByteLength: number
}) {
  const values = Object.values(input)
  if (
    !values.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    values.reduce((total, value) => total + value, 0) >
      Number.MAX_SAFE_INTEGER
  ) {
    fail('MINERU_RUNNER_INVALID_RESOURCE_BOUND')
  }
  return values.reduce((total, value) => total + value, 0)
}

export function remainingOwnerLocalSealedModelAllocatedBytes(input: {
  maximumCacheBytes: number
  originalCacheByteLength: number
  runtimeAllocatedByteLength: number
  sourceAllocatedByteLength: number
  preflightConfigAllocatedByteLength: number
  effectiveConfigAllocatedByteLength: number
  reservedOutputByteLength: number
  reservedPrivateScratchByteLength: number
}) {
  const values = Object.values(input)
  if (
    !values.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    input.maximumCacheBytes < 1
  ) {
    fail('MINERU_RUNNER_INVALID_RESOURCE_BOUND')
  }
  const committedBytes =
    input.originalCacheByteLength +
    input.runtimeAllocatedByteLength +
    input.sourceAllocatedByteLength +
    input.preflightConfigAllocatedByteLength +
    input.effectiveConfigAllocatedByteLength +
    input.reservedOutputByteLength +
    input.reservedPrivateScratchByteLength
  if (
    !Number.isSafeInteger(committedBytes) ||
    committedBytes >= input.maximumCacheBytes
  ) {
    fail('MINERU_RUNNER_CACHE_BOUND_EXCEEDED')
  }
  return input.maximumCacheBytes - committedBytes
}

async function runMineru(
  options: OwnerLocalMineruRunnerOptions,
  measured: MeasuredRunnerIdentity,
  runDirectory: string,
  outputRoot: string,
  maximumOutputBytes: number,
  maximumCacheBytes: number,
  privateSnapshotByteLength: number,
  readOnlyRoots: readonly string[],
) {
  await assertMeasuredFile(
    measured.mineruExecutablePath,
    measured.mineruExecutableIdentity,
    measured.mineruExecutableSha256,
    'MINERU_RUNNER_EXECUTABLE',
  )
  for (const auxiliary of measured.networkIsolationAuxiliaryFiles) {
    await assertMeasuredFile(
      auxiliary.path,
      auxiliary.identity,
      auxiliary.sha256,
      'MINERU_RUNNER_NETWORK_ISOLATION_AUXILIARY',
    )
  }
  await assertMeasuredFile(
    measured.pythonExecutablePath,
    measured.pythonExecutableIdentity,
    measured.execution.runtimeSha256,
    'MINERU_RUNNER_RUNTIME',
  )
  await assertMeasuredFile(
    measured.networkIsolationExecutablePath,
    measured.networkIsolationExecutableIdentity,
    measured.networkIsolationExecutableSha256,
    'MINERU_RUNNER_NETWORK_ISOLATION',
  )
  const privateHome = join(runDirectory, 'home')
  const privateTmp = join(runDirectory, 'tmp')
  await mkdir(privateHome, { mode: 0o700 })
  await mkdir(privateTmp, { mode: 0o700 })
  const environment = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    HOME: privateHome,
    TMPDIR: privateTmp,
    MINERU_MODEL_SOURCE: 'local',
    MINERU_TOOLS_CONFIG_JSON: measured.configPath,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    NO_PROXY: '*',
    no_proxy: '*',
  }
  const mineruArgs = [
    '-p',
    options.pdfPath,
    '-o',
    outputRoot,
    '-b',
    'vlm-engine',
    '-f',
    'true',
    '-t',
    'true',
    '--image-analysis',
    'true',
  ]
  const isolated = buildOwnerLocalMineruIsolationCommand({
    isolation: measured.execution.networkIsolation,
    isolationExecutable: measured.networkIsolationExecutablePath,
    runDirectory,
    program: measured.pythonExecutablePath,
    args: [measured.mineruExecutablePath, ...mineruArgs],
    readOnlyPaths: readOnlyRoots,
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(isolated.command, isolated.args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let outputBytes = 0
    let boundFailure: Error | undefined
    let checking = false
    const interval = setInterval(() => {
      if (checking || boundFailure) return
      checking = true
      void outputUsageForRoots([outputRoot, privateHome, privateTmp])
        .then((usage) => {
          assertOwnerLocalMineruResourceUsage({
            maximumOutputBytes,
            maximumCacheBytes,
            cacheByteLength: measured.cacheByteLength,
            privateSnapshotByteLength,
            outputByteLength: usage.outputByteLength,
            privateScratchByteLength:
              usage.byteLength - usage.outputByteLength,
            fileCount: usage.count,
          })
        })
        .catch((error) => {
          boundFailure =
            error instanceof Error
              ? error
              : new Error('MINERU_RUNNER_OUTPUT_MEASUREMENT_FAILED')
          child.kill('SIGKILL')
        })
        .finally(() => {
          checking = false
        })
    }, 100)
    const consume = (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_RUNNER_OUTPUT_BYTES) {
        boundFailure = new Error('MINERU_RUNNER_LOG_BOUND_EXCEEDED')
        child.kill('SIGKILL')
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      clearInterval(interval)
      if (boundFailure) rejectPromise(boundFailure)
      else if (code === 0 && signal === null) resolvePromise()
      else rejectPromise(new Error('MINERU_RUNNER_EXECUTION_FAILED'))
    })
  })
  const finalUsage = await outputUsageForRoots([
    outputRoot,
    privateHome,
    privateTmp,
  ])
  assertOwnerLocalMineruResourceUsage({
    maximumOutputBytes,
    maximumCacheBytes,
    cacheByteLength: measured.cacheByteLength,
    privateSnapshotByteLength,
    outputByteLength: finalUsage.outputByteLength,
    privateScratchByteLength:
      finalUsage.byteLength - finalUsage.outputByteLength,
    fileCount: finalUsage.count,
  })
  return {
    privateScratchByteLength:
      finalUsage.byteLength - finalUsage.outputByteLength,
  }
}

function flattenContentList(value: unknown) {
  if (!Array.isArray(value)) fail('MINERU_RUNNER_INVALID_CONTENT_LIST')
  const records: Array<Record<string, unknown> & { _page: number }> = []
  for (const [index, item] of value.entries()) {
    if (Array.isArray(item)) {
      for (const nested of item) {
        if (!record(nested)) fail('MINERU_RUNNER_INVALID_CONTENT_LIST')
        records.push({ ...nested, _page: index + 1 })
      }
    } else {
      if (!record(item)) fail('MINERU_RUNNER_INVALID_CONTENT_LIST')
      const pageIndex = item.page_idx
      records.push({
        ...item,
        _page: Number.isSafeInteger(pageIndex) ? Number(pageIndex) + 1 : 1,
      })
    }
  }
  return records
}

function recordClass(recordValue: Record<string, unknown>) {
  return String(recordValue.type ?? '').toLowerCase()
}

function referencedImagePaths(value: unknown, output: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((nested) => referencedImagePaths(nested, output))
  } else if (record(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (
        typeof nested === 'string' &&
        /^(?:img|image)(?:_?path)?$/iu.test(key)
      ) {
        output.push(nested)
      } else referencedImagePaths(nested, output)
    }
  }
  return output
}

function resolveReferencedImages(files: OutputFile[], values: unknown[]) {
  const references = [
    ...new Set(values.flatMap((value) => referencedImagePaths(value))),
  ]
  for (const reference of references) {
    if (
      reference.length === 0 ||
      isAbsolute(reference) ||
      reference.includes('\\') ||
      reference.split('/').includes('..')
    ) {
      fail('MINERU_RUNNER_INVALID_REFERENCED_IMAGE')
    }
    const matches = files.filter(
      ({ relativePath }) =>
        relativePath === reference || relativePath.endsWith(`/${reference}`),
    )
    if (
      matches.length !== 1 ||
      !/\.(?:png|jpe?g|webp)$/iu.test(matches[0]!.relativePath)
    ) {
      fail('MINERU_RUNNER_MISSING_REFERENCED_IMAGE')
    }
  }
}

async function copyOpaqueArtifact(
  source: string,
  destinationRoot: string,
  index: number,
  suffix: string,
) {
  const relativePath = `artifacts/${String(index).padStart(4, '0')}.${suffix}`
  const destination = join(destinationRoot, relativePath)
  await copyFile(source, destination)
  await chmod(destination, 0o600)
  return relativePath
}

async function writeOpaqueJson(
  value: unknown,
  destinationRoot: string,
  index: number,
) {
  const relativePath = `artifacts/${String(index).padStart(4, '0')}.json`
  const destination = join(destinationRoot, relativePath)
  await writeFile(destination, canonicalJson(value), { mode: 0o600 })
  return relativePath
}

async function descriptor(
  root: string,
  id: string,
  kind: MineruArtifactKind,
  relativePath: string,
  mediaType: string,
  pageScope: 'document' | number[],
) {
  const path = join(root, relativePath)
  const details = await stat(path)
  return {
    id,
    kind,
    relativePath,
    mediaType,
    byteLength: details.size,
    sha256: await hashFile(path),
    pageScope,
  }
}

async function findUnique(files: OutputFile[], suffix: string) {
  const matches = files.filter(({ relativePath }) =>
    relativePath.endsWith(suffix),
  )
  if (matches.length !== 1) fail('MINERU_RUNNER_OUTPUT_SHAPE_MISMATCH')
  return matches[0]!
}

export async function normalizeMineruRunArtifacts(input: {
  sourcePdfPath: string
  runDirectory: string
  outputRoot: string
  identity: IdentityMeasurement & { rootRef: string }
  maximumCacheBytes: number
  maximumOutputBytes?: number
  sourcePreflight?: Awaited<ReturnType<typeof inspectPdf>>
  privateScratchByteLength?: number
  privateSnapshotByteLength?: number
}): Promise<MineruArtifactManifest> {
  const runMode = (await lstat(input.runDirectory)).mode & 0o777
  if (runMode !== 0o700) fail('MINERU_RUNNER_DIRECTORY_MODE_MISMATCH')
  const pdf = await inspectPdf(input.sourcePdfPath)
  if (input.sourcePreflight && !samePdfInspection(input.sourcePreflight, pdf)) {
    fail('MINERU_RUNNER_SOURCE_IDENTITY_DRIFT')
  }
  const files = await listFiles(input.outputRoot)
  const rawOutputByteLength = files.reduce(
    (total, file) => total + file.size,
    0,
  )
  const maximumOutputBytes =
    input.maximumOutputBytes ?? MINERU_MAX_RAW_OUTPUT_BYTES
  if (
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > MINERU_MAX_RAW_OUTPUT_BYTES ||
    files.length > MINERU_MAX_ARTIFACT_COUNT ||
    rawOutputByteLength > maximumOutputBytes
  ) {
    fail('MINERU_RUNNER_OUTPUT_BOUND_EXCEEDED')
  }
  const markdown = await findUnique(files, '.md')
  const contentV1 = await findUnique(files, '_content_list.json')
  const contentV2 = await findUnique(files, '_content_list_v2.json')
  const middle = await findUnique(files, '_middle.json')
  const model = await findUnique(files, '_model.json')
  const layoutPdf = await findUnique(files, '_layout.pdf')
  const parse = async (file: OutputFile) => {
    try {
      return JSON.parse(await readFile(file.absolutePath, 'utf8'))
    } catch {
      fail('MINERU_RUNNER_INVALID_JSON_OUTPUT')
    }
  }
  const contentV1Json = await parse(contentV1)
  const contentV2Json = await parse(contentV2)
  const middleJson = await parse(middle)
  const modelJson = await parse(model)
  resolveReferencedImages(files, [
    contentV1Json,
    contentV2Json,
    middleJson,
    modelJson,
  ])
  const records = flattenContentList(contentV2Json)
  const byClass = (pattern: RegExp) =>
    records.filter((item) => pattern.test(recordClass(item)))
  const readingOrder = {
    schemaVersion: '1.0.0',
    pages: pdf.pages.map(({ page }) => ({
      page,
      order: records
        .map((recordValue, index) => ({ recordValue, index }))
        .filter(({ recordValue }) => recordValue._page === page)
        .map(({ index }) => index),
    })),
  }
  const normalizedValues: Array<{
    kind: MineruArtifactKind
    value: unknown
  }> = [
    { kind: 'layout-json', value: modelJson },
    { kind: 'ocr', value: byClass(/ocr/u) },
    { kind: 'table', value: byClass(/table/u) },
    { kind: 'formula', value: byClass(/formula|equation/u) },
    { kind: 'figure', value: byClass(/figure|image|chart/u) },
    {
      kind: 'image',
      value: files
        .filter(({ relativePath }) =>
          /\.(?:png|jpe?g|webp)$/iu.test(relativePath),
        )
        .map(async ({ absolutePath, relativePath, size }) => ({
          pathSha256: createHash('sha256').update(relativePath).digest('hex'),
          byteLength: size,
          sha256: await hashFile(absolutePath),
        })),
    },
    { kind: 'reading-order', value: readingOrder },
    {
      kind: 'page-geometry',
      value: { schemaVersion: '1.0.0', pages: pdf.pages },
    },
  ]
  await mkdir(join(input.runDirectory, 'artifacts'), {
    recursive: true,
    mode: 0o700,
  })
  const artifacts: MineruArtifactManifest['artifacts'] = []
  let index = 1
  const addCopied = async (
    file: OutputFile,
    kind: MineruArtifactKind,
    mediaType: string,
    suffix: string,
  ) => {
    const relativePath = await copyOpaqueArtifact(
      file.absolutePath,
      input.runDirectory,
      index,
      suffix,
    )
    artifacts.push(
      await descriptor(
        input.runDirectory,
        `artifact-${String(index).padStart(4, '0')}`,
        kind,
        relativePath,
        mediaType,
        'document',
      ),
    )
    index += 1
  }
  await addCopied(markdown, 'markdown', 'text/markdown', 'md')
  await addCopied(contentV1, 'content-list-v1', 'application/json', 'json')
  await addCopied(contentV2, 'content-list-v2', 'application/json', 'json')
  await addCopied(middle, 'middle-json', 'application/json', 'json')
  await addCopied(model, 'model-json', 'application/json', 'json')
  await addCopied(layoutPdf, 'layout-pdf', 'application/pdf', 'pdf')
  for (const { kind, value } of normalizedValues) {
    const resolvedValue = Array.isArray(value)
      ? await Promise.all(value)
      : value
    const relativePath = await writeOpaqueJson(
      resolvedValue,
      input.runDirectory,
      index,
    )
    artifacts.push(
      await descriptor(
        input.runDirectory,
        `artifact-${String(index).padStart(4, '0')}`,
        kind,
        relativePath,
        'application/json',
        'document',
      ),
    )
    index += 1
  }
  for (const file of files) {
    await chmod(file.absolutePath, 0o600)
    const relativePath = relative(input.runDirectory, file.absolutePath)
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      fail('MINERU_RUNNER_PATH_ESCAPE')
    }
    artifacts.push(
      await descriptor(
        input.runDirectory,
        `artifact-${String(index).padStart(4, '0')}`,
        'raw-output',
        relativePath,
        'application/octet-stream',
        'document',
      ),
    )
    index += 1
  }
  const retainedBytes = artifacts.reduce(
    (total, artifactValue) => total + artifactValue.byteLength,
    0,
  )
  const maximumBytes = input.maximumCacheBytes
  const privateScratchByteLength = input.privateScratchByteLength ?? 0
  const privateSnapshotByteLength = input.privateSnapshotByteLength ?? 0
  if (
    !Number.isSafeInteger(maximumBytes) ||
    !Number.isSafeInteger(privateScratchByteLength) ||
    privateScratchByteLength < 0 ||
    !Number.isSafeInteger(privateSnapshotByteLength) ||
    privateSnapshotByteLength < 0 ||
    maximumBytes <
      retainedBytes +
        input.identity.cacheByteLength +
        privateScratchByteLength +
        privateSnapshotByteLength ||
    maximumBytes > MINERU_MAX_OWNER_CACHE_BYTES
  ) {
    fail('MINERU_RUNNER_CACHE_BOUND_EXCEEDED')
  }
  const document = {
    id: `document-${pdf.source.sha256.slice(0, 32)}`,
    sha256: pdf.source.sha256,
    byteLength: pdf.source.size,
    pageCount: pdf.pages.length,
  }
  const rawOutputInventory = artifacts
    .filter(({ kind }) => kind === 'raw-output')
    .map(({ relativePath, byteLength, sha256 }) => ({
      relativePath,
      byteLength,
      sha256,
    }))
  const producerProjection = {
    schemaVersion: '1.0.0' as const,
    sourcePdfSha256: document.sha256,
    sourceByteLength: document.byteLength,
    sourcePageCount: document.pageCount,
    sourcePageGeometrySha256: canonicalHash(pdf.pages),
    mineruExecutableSha256: input.identity.mineruExecutableSha256,
    mineruConfigSha256: input.identity.mineruConfigSha256,
    runtimeSha256: input.identity.execution.runtimeSha256,
    runtimeInventorySha256: input.identity.runtimeInventorySha256,
    runtimeTreeByteLength: input.identity.runtimeTreeByteLength,
    packageSetSha256: input.identity.execution.packageSetSha256,
    backendSha256: input.identity.execution.backendSha256,
    modelSha256: MINERU_PRODUCTION_MODEL_SHA256,
    modelConfigSha256: input.identity.modelConfigSha256,
    cacheInventorySha256: input.identity.cacheInventorySha256,
    cacheByteLength: input.identity.cacheByteLength,
    privateSnapshotAllocatedByteLength: privateSnapshotByteLength,
    rawOutputInventorySha256: canonicalHash(rawOutputInventory),
    rawOutputByteLength,
    networkIsolation: input.identity.execution.networkIsolation,
    networkIsolationSha256:
      input.identity.execution.networkIsolationSha256,
    artifactSetSha256: canonicalHash(artifacts),
    offline: true as const,
    runDirectoryMode: '0700' as const,
  }
  const producerReceipt: MineruProducerReceipt = {
    ...producerProjection,
    receiptSha256: canonicalHash(producerProjection),
  }
  return {
    schemaVersion: MINERU_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    document,
    binding: structuredClone(MINERU_PRODUCTION_BINDING),
    execution: structuredClone(input.identity.execution),
    cache: {
      scope: 'owner-local',
      rootRef: input.identity.rootRef,
      namespace: 'mineru-production',
      maximumBytes,
      retainedBytes,
      artifactCount: artifacts.length,
    },
    artifacts,
    producerReceipt,
  }
}

export async function runOwnerLocalMineru(
  options: OwnerLocalMineruRunnerOptions,
): Promise<OwnerLocalMineruRun> {
  for (const path of [
    options.pdfPath,
    options.runRoot,
    options.mineruExecutable,
    options.pythonExecutable,
    options.configPath,
    options.modelRoot,
  ]) {
    if (!isAbsolute(path)) fail('MINERU_RUNNER_ABSOLUTE_PATH_REQUIRED')
  }
  const sourceRoot = await realpath(options.runRoot)
  const sourceDetails = await stat(sourceRoot)
  if (!sourceDetails.isDirectory()) fail('MINERU_RUNNER_INVALID_RUN_ROOT')
  if (await insideGitCheckout(sourceRoot)) {
    fail('MINERU_RUNNER_RUN_ROOT_INSIDE_GIT_CHECKOUT')
  }
  const sourcePdf = await realpath(options.pdfPath)
  if (sourcePdf === sourceRoot || sourcePdf.startsWith(`${sourceRoot}${sep}`)) {
    fail('MINERU_RUNNER_SOURCE_INSIDE_OUTPUT_ROOT')
  }
  const sourcePreflight = await inspectPdf(sourcePdf)
  const maximumCacheBytes =
    options.maxCacheBytes ?? MINERU_MAX_OWNER_CACHE_BYTES
  const maximumOutputBytes =
    options.maxOutputBytes ?? MINERU_MAX_RAW_OUTPUT_BYTES
  if (
    !Number.isSafeInteger(maximumCacheBytes) ||
    maximumCacheBytes < 1 ||
    maximumCacheBytes > MINERU_MAX_OWNER_CACHE_BYTES ||
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > MINERU_MAX_RAW_OUTPUT_BYTES
  ) {
    fail('MINERU_RUNNER_INVALID_RESOURCE_BOUND')
  }
  const runDirectory = await realpath(
    await mkdtemp(join(sourceRoot, 'mineru-run-')),
  )
  await chmod(runDirectory, 0o700)
  const outputRoot = join(runDirectory, 'raw-output')
  await mkdir(outputRoot, { mode: 0o700 })
  const measured = await measureIdentity(options)
  if (measured.cacheByteLength >= maximumCacheBytes) {
    fail('MINERU_RUNNER_CACHE_BOUND_EXCEEDED')
  }
  const sealed = await sealOwnerLocalExecution({
    options: { ...options, pdfPath: sourcePdf },
    measured,
    sourcePreflight,
    runDirectory,
    maximumCacheBytes,
    reservedOutputByteLength: maximumOutputBytes,
    reservedPrivateScratchByteLength: maximumOutputBytes,
  })
  assertOwnerLocalMineruResourceUsage({
    maximumOutputBytes,
    maximumCacheBytes,
    cacheByteLength: measured.cacheByteLength,
    privateSnapshotByteLength: sealed.privateSnapshotByteLength,
    outputByteLength: 0,
    privateScratchByteLength: 0,
    fileCount: 0,
  })
  const runUsage = await runMineru(
    sealed.options,
    sealed.identity,
    runDirectory,
    outputRoot,
    maximumOutputBytes,
    maximumCacheBytes,
    sealed.privateSnapshotByteLength,
    sealed.readOnlyRoots,
  )
  const sourceAfterInference = await inspectPdf(sourcePdf)
  if (!samePdfInspection(sourcePreflight, sourceAfterInference)) {
    fail('MINERU_RUNNER_SOURCE_IDENTITY_DRIFT')
  }
  const identityAfterInference = await measureIdentity(options)
  if (
    canonicalJson(measuredIdentityProjection(measured)) !==
    canonicalJson(measuredIdentityProjection(identityAfterInference))
  ) {
    fail('MINERU_RUNNER_PROCESS_OR_CACHE_IDENTITY_DRIFT')
  }
  const sealedSourceAfterInference = await inspectPdf(sealed.options.pdfPath)
  if (
    !samePdfInspection(sealed.sourcePreflight, sealedSourceAfterInference)
  ) {
    fail('MINERU_RUNNER_SEALED_SOURCE_IDENTITY_DRIFT')
  }
  const sealedIdentityAfterInference = await rebindSealedIsolationIdentity(
    await measureIdentity(sealed.options),
    sealed,
  )
  if (
    canonicalJson(measuredIdentityProjection(sealed.identity)) !==
    canonicalJson(measuredIdentityProjection(sealedIdentityAfterInference))
  ) {
    fail('MINERU_RUNNER_SEALED_PROCESS_IDENTITY_DRIFT')
  }
  const manifest = await normalizeMineruRunArtifacts({
    sourcePdfPath: sealed.options.pdfPath,
    runDirectory,
    outputRoot,
    identity: sealed.identity,
    maximumCacheBytes,
    maximumOutputBytes,
    sourcePreflight: sealed.sourcePreflight,
    privateScratchByteLength: runUsage.privateScratchByteLength,
    privateSnapshotByteLength: sealed.privateSnapshotByteLength,
  })
  const manifestPath = join(runDirectory, 'manifest.json')
  await writeFile(manifestPath, canonicalJson(manifest), { mode: 0o600 })
  return {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    runDirectory,
    manifestPath,
    manifest,
  }
}

export function parseOwnerLocalMineruArguments(argv: readonly string[]) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) {
    return { help: true as const }
  }
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (
      !key?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      fail('MINERU_RUNNER_INVALID_ARGUMENTS')
    }
    if (values.has(key)) fail('MINERU_RUNNER_DUPLICATE_ARGUMENT')
    values.set(key, value)
  }
  const allowed = new Set([
    '--pdf',
    '--run-root',
    '--mineru',
    '--python',
    '--config',
    '--model-root',
    '--max-cache-bytes',
    '--max-output-bytes',
  ])
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    fail('MINERU_RUNNER_INVALID_ARGUMENTS')
  }
  const required = [
    '--pdf',
    '--run-root',
    '--mineru',
    '--python',
    '--config',
    '--model-root',
  ]
  if (required.some((key) => !values.has(key))) {
    fail('MINERU_RUNNER_INVALID_ARGUMENTS')
  }
  if (
    required.some((key) => !isAbsolute(values.get(key)!)) ||
    (values.has('--max-cache-bytes') &&
      !/^\d+$/u.test(values.get('--max-cache-bytes')!)) ||
    (values.has('--max-output-bytes') &&
      !/^\d+$/u.test(values.get('--max-output-bytes')!))
  ) {
    fail('MINERU_RUNNER_ABSOLUTE_PATH_REQUIRED')
  }
  const maximum = values.get('--max-cache-bytes')
  const maximumOutput = values.get('--max-output-bytes')
  const options: OwnerLocalMineruRunnerOptions = {
    pdfPath: resolve(values.get('--pdf')!),
    runRoot: resolve(values.get('--run-root')!),
    mineruExecutable: resolve(values.get('--mineru')!),
    pythonExecutable: resolve(values.get('--python')!),
    configPath: resolve(values.get('--config')!),
    modelRoot: resolve(values.get('--model-root')!),
    ...(maximum === undefined ? {} : { maxCacheBytes: Number(maximum) }),
    ...(maximumOutput === undefined
      ? {}
      : { maxOutputBytes: Number(maximumOutput) }),
  }
  return { help: false as const, options }
}

async function main() {
  const parsed = parseOwnerLocalMineruArguments(process.argv.slice(2))
  if (parsed.help) {
    process.stdout.write(`${OWNER_LOCAL_MINERU_HELP}\n`)
    return
  }
  const result = await runOwnerLocalMineru(parsed.options)
  process.stdout.write(
    `${canonicalJson({
      schemaVersion: result.schemaVersion,
      sourcePdfSha256: result.manifest.document.sha256,
      graphInputManifestSha256: createHash('sha256')
        .update(await readFile(result.manifestPath))
        .digest('hex'),
      producerReceiptSha256: result.manifest.producerReceipt.receiptSha256,
      artifactCount: result.manifest.artifacts.length,
      runDirectoryRefSha256: createHash('sha256')
        .update(basename(result.runDirectory))
        .digest('hex'),
    })}\n`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'MINERU_RUNNER_FAILED'}\n`,
    )
    process.exitCode = 1
  })
}
