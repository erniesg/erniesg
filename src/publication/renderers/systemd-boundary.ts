import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  stat,
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
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { createPublicationSourceSnapshot } from '../../../tools/publication-offline-render.mjs'

export const PUBLICATION_BOUNDARY_EXECUTABLES = {
  sudo: '/usr/bin/sudo',
  systemdRun: '/usr/bin/systemd-run',
  systemctl: '/usr/bin/systemctl',
  unshare: '/usr/bin/unshare',
  setpriv: '/usr/bin/setpriv',
  env: '/usr/bin/env',
  node: '/usr/bin/node',
} as const

const PUBLICATION_HELPER = fileURLToPath(
  new URL('../../../tools/publication-offline-render.mjs', import.meta.url),
)
const PUBLICATION_NODE_MODULES = resolve(
  dirname(PUBLICATION_HELPER),
  '..',
  'node_modules',
)
const PUBLICATION_RUNTIME_PATHS = {
  parse5: resolve(PUBLICATION_NODE_MODULES, 'parse5'),
  playwright: resolve(PUBLICATION_NODE_MODULES, 'playwright'),
  playwrightCore: resolve(PUBLICATION_NODE_MODULES, 'playwright-core'),
  vivliostyle: resolve(PUBLICATION_NODE_MODULES, '@vivliostyle/cli'),
} as const
const UNIT_RUNTIME_SECONDS = 120
const INVOCATION_TIMEOUT_MILLISECONDS = 135_000
const UNIT_CLEANUP_TIMEOUT_MILLISECONDS = 10_000
const MAX_PROOF_BYTES = 64 * 1024
const MAX_PDF_BYTES = 512 * 1024 * 1024
const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z')

export type PublicationSystemdInvocation = {
  command: string
  args: string[]
  environment: NodeJS.ProcessEnv
  publicationRoot: string
  timeoutMilliseconds: number
  unitName: string
  identityName: string
  controlGroup: string
}

export type PublicationIsolatedRenderRequest = {
  renderer: 'vivliostyle-cli' | 'playwright-chromium'
  publicationRoot: string
  inputPath: string
  outputPath: string
  size: 'A4' | 'A5'
  browserPath: string
  expectedBrowserVersion: string
  expectedRendererVersion: string
  title: string
  networkDiagnostic?: PublicationNetworkDiagnostic
  filesystemDiagnosticPaths?: string[]
}

export type PublicationNetworkDiagnostic = {
  tcpIpv4Port: number
  tcpIpv6Port: number
  httpIpv4Port: number
  httpIpv6Port: number
  websocketIpv4Port: number
  websocketIpv6Port: number
  udpIpv4Port: number
  udpIpv6Port: number
}

type PublicationIsolatedRenderDependencies = {
  verifyExecutables?: typeof verifyPublicationBoundaryExecutables
  runInvocation?: (
    invocation: PublicationSystemdInvocation,
  ) => Promise<{ proof: string } | void>
  normalizePdf?: typeof normalizePublicationPdf
  createRuntimeAttestations?: typeof createPublicationRuntimeAttestations
  verifyRuntimeAttestations?: typeof verifyPublicationRuntimeAttestations
  createSourceSnapshot?: typeof createPublicationSourceSnapshot
}

export type PublicationRuntimeAttestation =
  | {
      kind: 'file'
      label: string
      path: string
      sha256: string
      byteLength: string
      device: string
      inode: string
      ctimeNanoseconds: string
      mode: string
      parentPath: string
      parentDevice: string
      parentInode: string
      parentCtimeNanoseconds: string
    }
  | {
      kind: 'tree'
      label: string
      path: string
      sha256: string
      identitySha256: string
      entryCount: number
      device: string
      inode: string
      ctimeNanoseconds: string
      parentPath: string
      parentDevice: string
      parentInode: string
      parentCtimeNanoseconds: string
    }
  | {
      kind: 'forest'
      label: string
      paths: string[]
      sha256: string
      identitySha256: string
      entryCount: number
    }

export class PublicationSystemdError extends Error {
  exitCode?: number
  signal?: NodeJS.Signals
}

type PublicationSystemctlResult = {
  code: number | null
  stdout: string
  stderr: string
}

type PublicationSystemctlRunner = (
  args: string[],
) => Promise<PublicationSystemctlResult>

export type PublicationUnitLease = {
  serviceName: string
  invocationId: string
  controlGroup: string
}

export type PublicationUnitObservation =
  | { kind: 'not-found' }
  | {
      kind: 'loaded'
      lease: PublicationUnitLease
      activeState: string
      subState: string
      mainPid: number
    }

export type PublicationUnitLifecycle = {
  phase: 'unseen' | 'pinned' | 'drained' | 'collected'
  lease?: PublicationUnitLease
}

function isPathInside(root: string, path: string) {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..')
}

function systemdPathListItem(path: string) {
  return path
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '%%')
    .replaceAll(' ', '\\x20')
    .replaceAll('\t', '\\x09')
    .replaceAll('\n', '\\x0a')
}

function childEnvironment(publicationRoot: string) {
  if (!isAbsolute(publicationRoot))
    throw new Error('Publication root must be absolute')
  return {
    HOME: '/tmp',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: '/tmp/.cache',
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_ENV: 'production',
    TZ: 'UTC',
    SOURCE_DATE_EPOCH: '946684800',
    NO_PROXY: '*',
    no_proxy: '*',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
  }
}

function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex')
}

function environmentSha256(environment: NodeJS.ProcessEnv) {
  return sha256(JSON.stringify(Object.entries(environment).sort()))
}

function sameBigIntFileIdentity(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  )
}

function lexicalName(left: { name: string }, right: { name: string }) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function lexicalLabel(
  left: PublicationRuntimeAttestation,
  right: PublicationRuntimeAttestation,
) {
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
}

function runtimeClosureRoot(roots: string[], path: string) {
  const root = roots.find((candidate) => isPathInside(candidate, path))
  if (!root)
    throw new Error(
      `Publication runtime symlink target is outside every attested runtime root: ${path}`,
    )
  return root
}

async function resolveRuntimeSymlinkTarget(
  linkPath: string,
  target: string,
  roots: string[],
) {
  let path = resolve(dirname(linkPath), target)
  let root = runtimeClosureRoot(roots, path)
  let current = root
  let remaining = relative(root, path).split(sep).filter(Boolean)
  let followedLinks = 0
  while (remaining.length) {
    const candidate = resolve(current, remaining.shift()!)
    const before = await lstat(candidate, { bigint: true })
    if (before.isSymbolicLink()) {
      followedLinks += 1
      if (followedLinks > 40)
        throw new Error(
          `Publication runtime symlink chain is too deep: ${linkPath}`,
        )
      const nestedTarget = await readlink(candidate)
      const after = await lstat(candidate, { bigint: true })
      if (!sameBigIntFileIdentity(before, after))
        throw new Error(
          `Publication runtime link changed while resolving: ${candidate}`,
        )
      path = resolve(dirname(candidate), nestedTarget)
      root = runtimeClosureRoot(roots, path)
      current = root
      remaining = [
        ...relative(root, path).split(sep).filter(Boolean),
        ...remaining,
      ]
      continue
    }
    if (remaining.length && !before.isDirectory())
      throw new Error(
        `Publication runtime symlink target is invalid: ${linkPath}`,
      )
    current = candidate
  }
  const canonical = await realpath(linkPath)
  if (
    canonical !== current ||
    !roots.some((root) => isPathInside(root, canonical))
  )
    throw new Error(
      `Publication runtime symlink target is outside every attested runtime root: ${linkPath}`,
    )
  return canonical
}

async function hashOpenRegularFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile())
      throw new Error(`Publication runtime path is not a regular file: ${path}`)
    const digest = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      digest.update(chunk)
    const after = await handle.stat({ bigint: true })
    if (!sameBigIntFileIdentity(before, after))
      throw new Error(`Publication runtime file changed while hashing: ${path}`)
    return { metadata: before, sha256: digest.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function runtimeParentIdentity(path: string) {
  const parentPath = await realpath(dirname(path))
  const metadata = await stat(parentPath, { bigint: true })
  if (!metadata.isDirectory())
    throw new Error(
      `Publication runtime parent is not a directory: ${parentPath}`,
    )
  return {
    parentPath,
    parentDevice: metadata.dev.toString(),
    parentInode: metadata.ino.toString(),
    parentCtimeNanoseconds: metadata.ctimeNs.toString(),
  }
}

export async function attestPublicationRuntimeFile(
  label: string,
  path: string,
): Promise<PublicationRuntimeAttestation> {
  if (!/^[a-z][a-z0-9-]*$/.test(label))
    throw new Error('Publication runtime label is invalid')
  const canonical = await realpath(path)
  if (canonical !== path)
    throw new Error(`Publication runtime file is not canonical: ${path}`)
  const [{ metadata, sha256: digest }, parent] = await Promise.all([
    hashOpenRegularFile(path),
    runtimeParentIdentity(path),
  ])
  return {
    kind: 'file',
    label,
    path,
    sha256: digest,
    byteLength: metadata.size.toString(),
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    ctimeNanoseconds: metadata.ctimeNs.toString(),
    mode: (metadata.mode & 0o777n).toString(8),
    ...parent,
  }
}

export async function attestPublicationRuntimeTree(
  label: string,
  path: string,
): Promise<PublicationRuntimeAttestation> {
  if (!/^[a-z][a-z0-9-]*$/.test(label))
    throw new Error('Publication runtime label is invalid')
  return {
    kind: 'tree',
    label,
    path,
    ...(await inspectPublicationRuntimeTree(path, true)),
  }
}

async function inspectPublicationRuntimeTree(
  path: string,
  hashContents: boolean,
  closureRoots: string[] = [path],
) {
  const canonical = await realpath(path)
  if (canonical !== path)
    throw new Error(`Publication runtime tree is not canonical: ${path}`)
  const before = await stat(path, { bigint: true })
  if (!before.isDirectory())
    throw new Error(`Publication runtime tree is not a directory: ${path}`)
  const contentDigest = createHash('sha256')
  const identityDigest = createHash('sha256')
  let entryCount = 0
  const visit = async (directory: string) => {
    const directoryBefore = await lstat(directory, { bigint: true })
    if (!directoryBefore.isDirectory())
      throw new Error(
        `Publication runtime tree entry is not a directory: ${directory}`,
      )
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      lexicalName,
    )
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name)
      const relativePath = relative(path, entryPath).split(sep).join('/')
      const metadata = await lstat(entryPath, { bigint: true })
      entryCount += 1
      if (metadata.isDirectory()) {
        const identity = [
          'directory',
          relativePath,
          metadata.dev.toString(),
          metadata.ino.toString(),
          metadata.mode.toString(),
          metadata.size.toString(),
          metadata.ctimeNs.toString(),
        ]
        identityDigest.update(`${JSON.stringify(identity)}\n`)
        contentDigest.update(
          `${JSON.stringify(['directory', relativePath, metadata.mode.toString(), metadata.ctimeNs.toString()])}\n`,
        )
        await visit(entryPath)
      } else if (metadata.isFile()) {
        const file = hashContents
          ? await hashOpenRegularFile(entryPath)
          : { metadata, sha256: '' }
        if (!sameBigIntFileIdentity(metadata, file.metadata))
          throw new Error(
            `Publication runtime file changed while inspecting: ${entryPath}`,
          )
        identityDigest.update(
          `${JSON.stringify([
            'file',
            relativePath,
            file.metadata.dev.toString(),
            file.metadata.ino.toString(),
            file.metadata.mode.toString(),
            file.metadata.size.toString(),
            file.metadata.ctimeNs.toString(),
          ])}\n`,
        )
        if (hashContents)
          contentDigest.update(
            `${JSON.stringify(['file', relativePath, file.metadata.mode.toString(), file.metadata.size.toString(), file.metadata.ctimeNs.toString(), file.sha256])}\n`,
          )
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(entryPath)
        const afterLink = await lstat(entryPath, { bigint: true })
        if (!sameBigIntFileIdentity(metadata, afterLink))
          throw new Error(
            `Publication runtime link changed while inspecting: ${entryPath}`,
          )
        const canonicalTarget = await resolveRuntimeSymlinkTarget(
          entryPath,
          target,
          closureRoots,
        )
        const identity = [
          'symlink',
          relativePath,
          metadata.dev.toString(),
          metadata.ino.toString(),
          metadata.mode.toString(),
          metadata.size.toString(),
          metadata.ctimeNs.toString(),
          target,
          canonicalTarget,
        ]
        identityDigest.update(`${JSON.stringify(identity)}\n`)
        contentDigest.update(
          `${JSON.stringify(['symlink', relativePath, metadata.ctimeNs.toString(), target, canonicalTarget])}\n`,
        )
      } else {
        throw new Error(
          `Unsupported publication runtime tree entry: ${entryPath}`,
        )
      }
    }
    const directoryAfter = await lstat(directory, { bigint: true })
    if (!sameBigIntFileIdentity(directoryBefore, directoryAfter))
      throw new Error(
        `Publication runtime directory changed while inspecting: ${directory}`,
      )
  }
  await visit(path)
  const after = await stat(path, { bigint: true })
  if (!sameBigIntFileIdentity(before, after))
    throw new Error(`Publication runtime tree changed while hashing: ${path}`)
  const parent = await runtimeParentIdentity(path)
  return {
    sha256: hashContents ? contentDigest.digest('hex') : '',
    identitySha256: identityDigest.digest('hex'),
    entryCount,
    device: before.dev.toString(),
    inode: before.ino.toString(),
    ctimeNanoseconds: before.ctimeNs.toString(),
    ...parent,
  }
}

function assertRuntimeForestPaths(paths: string[]) {
  if (
    paths.length < 1 ||
    paths.length > 1024 ||
    JSON.stringify(paths) !== JSON.stringify([...new Set(paths)].sort())
  )
    throw new Error('Publication runtime forest paths are invalid')
}

async function inspectPublicationRuntimeForest(
  paths: string[],
  hashContents: boolean,
) {
  assertRuntimeForestPaths(paths)
  const contentDigest = createHash('sha256')
  const identityDigest = createHash('sha256')
  let entryCount = 0
  for (const path of paths) {
    const tree = await inspectPublicationRuntimeTree(path, hashContents, paths)
    entryCount += tree.entryCount
    identityDigest.update(
      `${JSON.stringify([
        path,
        tree.identitySha256,
        tree.entryCount,
        tree.device,
        tree.inode,
        tree.ctimeNanoseconds,
        tree.parentPath,
        tree.parentDevice,
        tree.parentInode,
        tree.parentCtimeNanoseconds,
      ])}\n`,
    )
    if (hashContents)
      contentDigest.update(
        `${JSON.stringify([path, tree.sha256, tree.entryCount])}\n`,
      )
  }
  return {
    sha256: hashContents ? contentDigest.digest('hex') : '',
    identitySha256: identityDigest.digest('hex'),
    entryCount,
  }
}

export async function attestPublicationRuntimeForest(
  label: string,
  paths: string[],
): Promise<PublicationRuntimeAttestation> {
  if (!/^[a-z][a-z0-9-]*$/.test(label))
    throw new Error('Publication runtime label is invalid')
  return {
    kind: 'forest',
    label,
    paths,
    ...(await inspectPublicationRuntimeForest(paths, true)),
  }
}

function packageNameSegments(name: string) {
  const segments = name.startsWith('@') ? name.split('/') : [name]
  if (
    !(
      (segments.length === 1 && !name.startsWith('@')) ||
      (segments.length === 2 && segments[0].startsWith('@'))
    ) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^@?[a-zA-Z0-9._-]+$/.test(segment),
    )
  )
    throw new Error(`Publication runtime package name is unsafe: ${name}`)
  return segments
}

async function resolveInstalledPackage(fromPath: string, name: string) {
  const segments = packageNameSegments(name)
  const repositoryRoot = dirname(PUBLICATION_NODE_MODULES)
  let directory = fromPath
  while (isPathInside(repositoryRoot, directory)) {
    if (basename(directory) !== 'node_modules') {
      const candidate = resolve(directory, 'node_modules', ...segments)
      try {
        const canonical = await realpath(candidate)
        if (!isPathInside(PUBLICATION_NODE_MODULES, canonical))
          throw new Error(
            `Publication runtime package escapes node_modules: ${name}`,
          )
        await access(resolve(canonical, 'package.json'), constants.R_OK)
        return canonical
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (directory === repositoryRoot) break
    directory = dirname(directory)
  }
  return null
}

async function publicationRuntimePackageClosure(
  renderer: PublicationIsolatedRenderRequest['renderer'],
) {
  const seeds = [
    PUBLICATION_RUNTIME_PATHS.parse5,
    ...(renderer === 'vivliostyle-cli'
      ? [PUBLICATION_RUNTIME_PATHS.vivliostyle]
      : [
          PUBLICATION_RUNTIME_PATHS.playwright,
          PUBLICATION_RUNTIME_PATHS.playwrightCore,
        ]),
  ]
  const roots = (await Promise.all(seeds.map((path) => realpath(path)))).sort()
  const queue = [...roots]
  const visited = new Set<string>()
  while (queue.length) {
    const packagePath = queue.pop()!
    if (visited.has(packagePath)) continue
    visited.add(packagePath)
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(
        await readFile(resolve(packagePath, 'package.json'), 'utf8'),
      ) as Record<string, unknown>
    } catch (error) {
      throw new Error(
        `Publication runtime package manifest is invalid: ${packagePath}: ${String(error)}`,
      )
    }
    const dependencyObjects = [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].filter(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
    )
    const optional = new Set([
      ...Object.keys(
        (manifest.optionalDependencies as Record<string, unknown>) ?? {},
      ),
      ...Object.entries(
        (manifest.peerDependenciesMeta as Record<
          string,
          { optional?: unknown }
        >) ?? {},
      )
        .filter(([, metadata]) => metadata?.optional === true)
        .map(([name]) => name),
    ])
    for (const name of new Set(
      dependencyObjects.flatMap((dependencies) => Object.keys(dependencies)),
    )) {
      const dependencyPath = await resolveInstalledPackage(packagePath, name)
      if (!dependencyPath) {
        if (optional.has(name)) continue
        throw new Error(
          `Publication runtime dependency is unavailable: ${name} from ${packagePath}`,
        )
      }
      queue.push(dependencyPath)
      if (!roots.some((root) => isPathInside(root, dependencyPath)))
        roots.push(dependencyPath)
    }
    if (roots.length > 1024)
      throw new Error('Publication runtime package closure is too large')
  }
  return [...new Set(roots)].sort()
}

export async function createPublicationRuntimeAttestations(
  request: PublicationIsolatedRenderRequest,
  browserPath: string,
): Promise<PublicationRuntimeAttestation[]> {
  const fileInputs = [
    ['node-executable', PUBLICATION_BOUNDARY_EXECUTABLES.node],
    ['isolation-helper', PUBLICATION_OFFLINE_HELPER_PATH],
  ] as const
  const runtimePackages = await publicationRuntimePackageClosure(
    request.renderer,
  )
  return (
    await Promise.all([
      ...fileInputs.map(([label, path]) =>
        attestPublicationRuntimeFile(label, path),
      ),
      attestPublicationRuntimeTree('browser-runtime', dirname(browserPath)),
      attestPublicationRuntimeForest(
        'runtime-package-closure',
        runtimePackages,
      ),
    ])
  ).sort(lexicalLabel)
}

export async function verifyPublicationRuntimeAttestations(
  expected: PublicationRuntimeAttestation[],
) {
  await Promise.all(
    expected.map(async (entry) => {
      if (entry.kind === 'file') {
        const actual = await attestPublicationRuntimeFile(
          entry.label,
          entry.path,
        )
        if (JSON.stringify(actual) !== JSON.stringify(entry))
          throw new Error('Publication runtime attestation changed')
        return
      }
      if (entry.kind === 'tree') {
        const actual = await inspectPublicationRuntimeTree(entry.path, false)
        if (
          actual.identitySha256 !== entry.identitySha256 ||
          actual.entryCount !== entry.entryCount ||
          actual.device !== entry.device ||
          actual.inode !== entry.inode ||
          actual.ctimeNanoseconds !== entry.ctimeNanoseconds ||
          actual.parentPath !== entry.parentPath ||
          actual.parentDevice !== entry.parentDevice ||
          actual.parentInode !== entry.parentInode ||
          actual.parentCtimeNanoseconds !== entry.parentCtimeNanoseconds
        )
          throw new Error(
            `Publication runtime attestation changed: ${entry.label}`,
          )
        return
      }
      const actual = await inspectPublicationRuntimeForest(entry.paths, false)
      if (
        actual.identitySha256 !== entry.identitySha256 ||
        actual.entryCount !== entry.entryCount
      )
        throw new Error(
          `Publication runtime attestation changed: ${entry.label}`,
        )
    }),
  )
}

export function publicationRuntimeReadOnlyPaths(
  entries: PublicationRuntimeAttestation[],
) {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.kind === 'forest'
          ? entry.paths
          : entry.path === PUBLICATION_BOUNDARY_EXECUTABLES.node
            ? []
            : [entry.path],
      ),
    ),
  ]
}

async function createPrivateStagingDirectory(parent: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const path = resolve(
      parent,
      `.publication-stage-${randomBytes(16).toString('hex')}`,
    )
    try {
      await mkdir(path, { mode: 0o700 })
      await chmod(path, 0o700)
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Unable to create a private publication staging directory')
}

async function exposePublicationSourceSnapshot(
  root: string,
  entries: Array<{ path: string }>,
) {
  const directories = new Set([root])
  for (const entry of entries) {
    const path = resolve(root, ...entry.path.split('/'))
    await chmod(path, 0o444)
    let parent = dirname(path)
    while (isPathInside(root, parent)) {
      directories.add(parent)
      if (parent === root) break
      parent = dirname(parent)
    }
  }
  await Promise.all([...directories].map((path) => chmod(path, 0o755)))
}

type OpenedRegularFile = {
  bytes: Uint8Array
  device: number
  inode: number
  size: number
}

async function readOpenedRegularFile(
  path: string,
  maximumBytes: number,
  description: string,
): Promise<OpenedRegularFile> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw new Error(`${description} is unavailable or unsafe: ${String(error)}`)
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes)
      throw new Error(`${description} is not a bounded regular file`)
    const bytes = new Uint8Array(await handle.readFile())
    const after = await handle.stat()
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.byteLength !== before.size
    )
      throw new Error(`${description} changed while it was being authenticated`)
    return {
      bytes,
      device: before.dev,
      inode: before.ino,
      size: before.size,
    }
  } finally {
    await handle.close()
  }
}

async function assertRegularPathIdentity(
  path: string,
  expected: Pick<OpenedRegularFile, 'device' | 'inode' | 'size'>,
  description: string,
) {
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.dev !== expected.device ||
    metadata.ino !== expected.inode ||
    metadata.size !== expected.size
  )
    throw new Error(`${description} changed before publication`)
}

async function assertSafeFinalPath(
  publicationRoot: string,
  requestedOutputPath: string,
  expectedParent?: string,
) {
  const parent = await realpath(dirname(requestedOutputPath))
  if (!isPathInside(publicationRoot, parent))
    throw new Error(
      'Publication PDF output parent is outside the publication root',
    )
  if (expectedParent && parent !== expectedParent)
    throw new Error('Publication PDF output parent changed before publication')
  const outputPath = resolve(parent, basename(requestedOutputPath))
  try {
    const metadata = await lstat(outputPath)
    if (metadata.isSymbolicLink())
      throw new Error('Publication PDF output must not be a symbolic link')
    if (!metadata.isFile())
      throw new Error('Publication PDF output must be a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { outputPath, parent }
}

async function normalizePublicationPdf(
  renderedPath: string,
  normalizedPath: string,
  request: PublicationIsolatedRenderRequest,
  authenticatedBytes?: Uint8Array,
) {
  const bytes =
    authenticatedBytes ??
    (
      await readOpenedRegularFile(
        renderedPath,
        MAX_PDF_BYTES,
        'Rendered publication PDF',
      )
    ).bytes
  const pdf = await PDFDocument.load(bytes)
  pdf.setTitle(request.title)
  pdf.setAuthor('')
  pdf.setCreator('ernie.sg publication compiler')
  pdf.setProducer(
    request.renderer === 'vivliostyle-cli'
      ? `Vivliostyle CLI ${request.expectedRendererVersion}`
      : `Playwright Chromium ${request.expectedBrowserVersion}`,
  )
  pdf.setCreationDate(FIXED_DATE)
  pdf.setModificationDate(FIXED_DATE)
  await writeFile(normalizedPath, await pdf.save({ useObjectStreams: false }), {
    flag: 'wx',
    mode: 0o600,
  })
}

const PROOF_FIELDS = [
  'browserVersion',
  'cgroup',
  'childCgroups',
  'childMountNamespaces',
  'childNetworkNamespaces',
  'childPidNamespaces',
  'environmentSha256',
  'event',
  'filesystemDiagnostics',
  'gid',
  'interfaces',
  'mountNamespace',
  'networkDiagnostic',
  'networkNamespace',
  'nspid',
  'nodeVersion',
  'outputByteLength',
  'outputSha256',
  'renderer',
  'rendererVersion',
  'requestSha256',
  'runtimeEntries',
  'pidNamespace',
  'sourceSha256',
  'uid',
  'version',
] as const

const NETWORK_DIAGNOSTIC_ATTEMPTS = [
  'tcp-ipv4',
  'tcp-ipv6',
  'http-ipv4',
  'http-ipv6',
  'websocket-ipv4',
  'websocket-ipv6',
  'udp-ipv4',
  'udp-ipv6',
]

function expectedNetworkDiagnosticProof(value: unknown) {
  return value
    ? {
        attempted: NETWORK_DIAGNOSTIC_ATTEMPTS,
        privateLoopback: { ipv4: true, ipv6: true },
      }
    : null
}

function exactNamespaceChildren(
  value: unknown,
  namespace: unknown,
  pattern: RegExp,
) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (identity) =>
        typeof identity === 'string' &&
        pattern.test(identity) &&
        identity === namespace,
    )
  )
}

function validateIsolationProof({
  proof,
  authenticatedRequest,
  requestSha256,
  renderedPdf,
}: {
  proof: unknown
  authenticatedRequest: Record<string, unknown>
  requestSha256: string
  renderedPdf: OpenedRegularFile
}) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof))
    throw new Error(
      'Isolated publication renderer returned invalid attestation',
    )
  const record = proof as Record<string, unknown>
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify([...PROOF_FIELDS].sort())
  )
    throw new Error(
      'Isolated publication renderer returned invalid proof fields',
    )
  const networkNamespace = record.networkNamespace
  const mountNamespace = record.mountNamespace
  const pidNamespace = record.pidNamespace
  if (
    record.version !== 1 ||
    record.event !== 'publication-isolation-proof' ||
    record.requestSha256 !== requestSha256 ||
    record.renderer !== authenticatedRequest.renderer ||
    record.rendererVersion !== authenticatedRequest.expectedRendererVersion ||
    record.browserVersion !== authenticatedRequest.expectedBrowserVersion ||
    record.nodeVersion !== authenticatedRequest.expectedNodeVersion ||
    !Number.isSafeInteger(record.uid) ||
    (record.uid as number) < 61_184 ||
    (record.uid as number) > 65_519 ||
    record.uid === authenticatedRequest.expectedUid ||
    !Number.isSafeInteger(record.gid) ||
    (record.gid as number) < 61_184 ||
    (record.gid as number) > 65_519 ||
    record.gid === authenticatedRequest.expectedGid ||
    record.environmentSha256 !==
      authenticatedRequest.expectedEnvironmentSha256 ||
    record.outputSha256 !== sha256(renderedPdf.bytes) ||
    record.outputByteLength !== renderedPdf.size ||
    record.sourceSha256 !== authenticatedRequest.sourceSha256 ||
    JSON.stringify(record.runtimeEntries) !==
      JSON.stringify(authenticatedRequest.runtimeEntries) ||
    !/^net:\[\d+\]$/.test(String(networkNamespace)) ||
    networkNamespace === authenticatedRequest.hostNetworkNamespace ||
    !/^mnt:\[\d+\]$/.test(String(mountNamespace)) ||
    mountNamespace === authenticatedRequest.hostMountNamespace ||
    !/^pid:\[\d+\]$/.test(String(pidNamespace)) ||
    pidNamespace === authenticatedRequest.hostPidNamespace ||
    JSON.stringify(record.nspid) !== JSON.stringify([1]) ||
    record.cgroup !== authenticatedRequest.expectedControlGroup ||
    JSON.stringify(record.interfaces) !== JSON.stringify(['lo']) ||
    !exactNamespaceChildren(
      record.childNetworkNamespaces,
      networkNamespace,
      /^net:\[\d+\]$/,
    ) ||
    !exactNamespaceChildren(
      record.childMountNamespaces,
      mountNamespace,
      /^mnt:\[\d+\]$/,
    ) ||
    !exactNamespaceChildren(
      record.childPidNamespaces,
      pidNamespace,
      /^pid:\[\d+\]$/,
    ) ||
    JSON.stringify(record.childCgroups) !==
      JSON.stringify([authenticatedRequest.expectedControlGroup]) ||
    JSON.stringify(record.networkDiagnostic) !==
      JSON.stringify(
        expectedNetworkDiagnosticProof(authenticatedRequest.networkDiagnostic),
      ) ||
    JSON.stringify(record.filesystemDiagnostics) !==
      JSON.stringify(
        (authenticatedRequest.filesystemDiagnosticPaths as string[]).map(
          (path) => ({ path, inaccessible: true }),
        ),
      )
  )
    throw new Error(
      'Isolated publication renderer returned invalid attestation',
    )
  return record
}

export function createPublicationUnitName(
  pid = process.pid,
  randomToken = randomBytes(8).toString('hex'),
) {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !/^[a-f0-9]{16}$/.test(randomToken)
  )
    throw new Error('Invalid publication unit identity')
  const name = `erniesg-publication-${pid}-${randomToken}`
  if (name.length > 63) throw new Error('Publication unit name is too long')
  return name
}

export function createPublicationIdentityName(unitName: string) {
  const token = unitName.match(/-([a-f0-9]{16})$/)?.[1]
  if (!token)
    throw new Error('Publication unit cannot derive a kernel identity')
  return `epub-${token}`
}

export function assertPublicationBoundaryRuntime({
  platform,
  uid,
  gid,
}: {
  platform: string
  uid: number | undefined
  gid: number | undefined
}) {
  if (platform !== 'linux')
    throw new Error('Offline publication rendering requires Linux')
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid))
    throw new Error(
      'Offline publication rendering requires numeric caller UID and GID',
    )
  if (uid === 0)
    throw new Error('The publication renderer must not run as root')
  if (gid === 0)
    throw new Error('The publication renderer must not run with a root group')
}

async function inspectTrustedExecutable(path: string) {
  await access(path, constants.X_OK)
  const [canonical, metadata] = await Promise.all([realpath(path), stat(path)])
  if (canonical !== path)
    throw new Error(`${path} does not resolve to its exact trusted path`)
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
    throw new Error(`${path} is not a root-owned, non-writable executable`)
}

export async function verifyPublicationBoundaryExecutables(
  inspect: (path: string) => Promise<void> = inspectTrustedExecutable,
) {
  for (const path of Object.values(PUBLICATION_BOUNDARY_EXECUTABLES)) {
    try {
      await inspect(path)
    } catch (error) {
      throw new Error(
        `${basename(path)} absolute boundary executable is unavailable or untrusted: ${String(error)}`,
      )
    }
  }
}

export function buildPublicationSystemdInvocation({
  publicationRoot,
  stagingDirectory,
  requestPath,
  requestSha256,
  runtimeReadOnlyPaths,
  uid,
  gid,
  unitName = createPublicationUnitName(),
  identityName = createPublicationIdentityName(unitName),
}: {
  publicationRoot: string
  stagingDirectory: string
  requestPath: string
  requestSha256: string
  runtimeReadOnlyPaths: string[]
  uid: number
  gid: number
  unitName?: string
  identityName?: string
}): PublicationSystemdInvocation {
  assertPublicationBoundaryRuntime({ platform: 'linux', uid, gid })
  if (
    !isAbsolute(publicationRoot) ||
    !isAbsolute(stagingDirectory) ||
    !isAbsolute(requestPath) ||
    runtimeReadOnlyPaths.some((path) => !isAbsolute(path))
  )
    throw new Error('Publication boundary paths must be absolute')
  if (
    [
      publicationRoot,
      stagingDirectory,
      requestPath,
      ...runtimeReadOnlyPaths,
    ].some((path) => /[:%\0\r\n]/u.test(path))
  )
    throw new Error('Publication boundary paths contain unsafe systemd syntax')
  if (
    publicationRoot === stagingDirectory ||
    !isPathInside(stagingDirectory, publicationRoot) ||
    !isPathInside(stagingDirectory, requestPath)
  )
    throw new Error(
      'Publication request must be inside its private staging directory',
    )
  if (!/^[a-f0-9]{64}$/.test(requestSha256))
    throw new Error('Publication request digest must be SHA-256')
  if (!/^[a-z0-9-]+$/.test(unitName) || unitName.length > 63)
    throw new Error('Publication systemd unit name is invalid')
  if (
    !/^epub-[a-f0-9]{16}$/.test(identityName) ||
    identityName !== createPublicationIdentityName(unitName)
  )
    throw new Error('Publication dynamic identity name is invalid')
  const controlGroup = `/system.slice/${unitName}.service`

  const properties = [
    'Type=exec',
    'Slice=system.slice',
    'PrivateNetwork=yes',
    'DynamicUser=yes',
    `User=${identityName}`,
    `Group=${identityName}`,
    'SetLoginEnvironment=no',
    'PrivateUsers=yes',
    'NoNewPrivileges=yes',
    'AmbientCapabilities=',
    'CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SYS_ADMIN',
    'PrivateDevices=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    'ProtectHome=tmpfs',
    'ProtectProc=invisible',
    'InaccessiblePaths=/proc',
    'TemporaryFileSystem=/:ro',
    'BindReadOnlyPaths=/usr',
    'BindReadOnlyPaths=-/lib',
    'BindReadOnlyPaths=-/lib64',
    'BindReadOnlyPaths=-/etc/fonts',
    'BindReadOnlyPaths=-/etc/ld.so.cache',
    'BindReadOnlyPaths=-/etc/nsswitch.conf',
    'BindReadOnlyPaths=-/etc/passwd',
    'BindReadOnlyPaths=-/etc/group',
    'BindReadOnlyPaths=-/etc/localtime',
    'BindReadOnlyPaths=-/var/cache/fontconfig',
    'BindReadOnlyPaths=/run/systemd/userdb/io.systemd.DynamicUser',
    `BindPaths=${systemdPathListItem(stagingDirectory)}`,
    `ReadWritePaths=${systemdPathListItem(stagingDirectory)}`,
    `BindReadOnlyPaths=${systemdPathListItem(publicationRoot)}`,
    ...runtimeReadOnlyPaths.map(
      (path) => `BindReadOnlyPaths=${systemdPathListItem(path)}`,
    ),
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'RestrictRealtime=yes',
    'PrivateMounts=yes',
    'KeyringMode=private',
    'UMask=0077',
    'ExitType=cgroup',
    'KillMode=control-group',
    'SendSIGKILL=yes',
    'FinalKillSignal=SIGKILL',
    'TimeoutStopFailureMode=kill',
    `RuntimeMaxSec=${UNIT_RUNTIME_SECONDS}s`,
    'TimeoutStopSec=10s',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    'SystemCallArchitectures=native',
    'InaccessiblePaths=-/run/systemd/private -/run/dbus/system_bus_socket -/run/docker.sock -/var/run/docker.sock -/run/containerd/containerd.sock -/run/podman/podman.sock -/run/lxd/unix.socket -/var/lib/lxd/unix.socket',
  ]
  const environment = childEnvironment(publicationRoot)
  const environmentArgs = Object.entries(environment).map(
    ([name, value]) => `${name}=${value}`,
  )
  const args = [
    '-n',
    PUBLICATION_BOUNDARY_EXECUTABLES.systemdRun,
    '--system',
    '--quiet',
    '--wait',
    '--collect',
    '--pipe',
    '--expand-environment=no',
    `--unit=${unitName}`,
    ...properties.map((property) => `--property=${property}`),
    `--working-directory=${publicationRoot}`,
    '--',
    `!${PUBLICATION_BOUNDARY_EXECUTABLES.unshare}`,
    '--pid',
    '--fork',
    '--kill-child=SIGKILL',
    '--mount-proc=/proc',
    '--propagation=private',
    PUBLICATION_BOUNDARY_EXECUTABLES.setpriv,
    `--reuid=${identityName}`,
    `--regid=${identityName}`,
    '--clear-groups',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    '--no-new-privs',
    PUBLICATION_BOUNDARY_EXECUTABLES.env,
    '-i',
    ...environmentArgs,
    PUBLICATION_BOUNDARY_EXECUTABLES.node,
    PUBLICATION_HELPER,
    `--request=${requestPath}`,
    `--request-sha256=${requestSha256}`,
  ]
  return {
    command: PUBLICATION_BOUNDARY_EXECUTABLES.sudo,
    args,
    environment: {
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
    publicationRoot,
    timeoutMilliseconds: INVOCATION_TIMEOUT_MILLISECONDS,
    unitName,
    identityName,
    controlGroup,
  }
}

export async function runPublicationSystemdInvocation(
  invocation: PublicationSystemdInvocation,
  spawnProcess: typeof spawn = spawn,
  terminateUnit: (
    invocation: PublicationSystemdInvocation,
    lease?: PublicationUnitLease,
  ) => Promise<void> = (failedInvocation, lease) =>
    terminatePublicationSystemdUnit(
      failedInvocation.unitName,
      undefined,
      undefined,
      lease,
    ),
  monitorUnit: typeof monitorPublicationSystemdUnit = monitorPublicationSystemdUnit,
) {
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd: invocation.publicationRoot,
    env: invocation.environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let proofOutput = ''
  let proofOutputError: Error | undefined
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    proofOutput += String(chunk)
    if (Buffer.byteLength(proofOutput) > MAX_PROOF_BYTES) {
      proofOutputError = new Error('Publication proof output is excessive')
      child.kill('SIGKILL')
    }
  })
  let timeout: NodeJS.Timeout | undefined
  const outcome = new Promise<void>((accept, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (proofOutputError) {
        reject(proofOutputError)
        return
      }
      if (code === 0) {
        accept()
        return
      }
      const error = new PublicationSystemdError(
        code === null
          ? `systemd-run terminated by signal ${signal ?? 'unknown'}`
          : `systemd-run exited with status ${code}`,
      )
      if (code !== null) error.exitCode = code
      if (signal) error.signal = signal
      reject(error)
    })
  })
  const watchdog = new Promise<never>((_accept, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(`systemd-run exceeded ${invocation.timeoutMilliseconds}ms`),
        ),
      invocation.timeoutMilliseconds,
    )
  })
  let pinnedLease: PublicationUnitLease | undefined
  let lifecycleCompleted = false
  const lifecycle = monitorUnit(invocation, (lease) => {
    pinnedLease = lease
  }).then((proof) => {
    lifecycleCompleted = true
    return proof
  })
  try {
    const [, lifecycleProof] = await Promise.all([
      Promise.race([outcome, watchdog]),
      lifecycle,
    ])
    const proofLines = proofOutput.trim().split('\n').filter(Boolean)
    if (proofLines.length !== 1)
      throw new Error('Publication unit returned ambiguous proof output')
    return { proof: proofLines[0], lifecycle: lifecycleProof }
  } catch (error) {
    child.kill('SIGKILL')
    if (lifecycleCompleted) throw error
    try {
      await terminateUnit(invocation, pinnedLease)
    } catch (cleanupError) {
      const collected = await Promise.race([
        lifecycle.then(
          () => true,
          () => false,
        ),
        new Promise<false>((accept) => setTimeout(() => accept(false), 25)),
      ])
      if (collected) throw error
      throw new AggregateError(
        [error, cleanupError],
        `Publication unit ${invocation.unitName} failed and could not be proven inactive`,
      )
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function runPublicationSystemctlCommand(
  args: string[],
): Promise<PublicationSystemctlResult> {
  return new Promise((accept, reject) => {
    const child = spawn(
      PUBLICATION_BOUNDARY_EXECUTABLES.sudo,
      ['-n', PUBLICATION_BOUNDARY_EXECUTABLES.systemctl, ...args],
      {
        env: { PATH: '/usr/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    const maximumOutput = 64 * 1024
    const append = (current: string, chunk: Buffer | string) => {
      const next = `${current}${String(chunk)}`
      if (Buffer.byteLength(next) > maximumOutput) {
        child.kill('SIGKILL')
        reject(new Error('systemctl returned excessive output'))
      }
      return next
    }
    child.stdout?.on('data', (chunk) => (stdout = append(stdout, chunk)))
    child.stderr?.on('data', (chunk) => (stderr = append(stderr, chunk)))
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('systemctl command timed out'))
    }, UNIT_CLEANUP_TIMEOUT_MILLISECONDS)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      accept({ code, stdout, stderr })
    })
  })
}

const UNIT_OBSERVATION_FIELDS = [
  'ActiveState',
  'ControlGroup',
  'DynamicUser',
  'Group',
  'Id',
  'InvocationID',
  'LoadState',
  'MainPID',
  'Slice',
  'SubState',
  'User',
] as const

export function parsePublicationUnitObservation(
  expectedServiceName: string,
  result: PublicationSystemctlResult,
): PublicationUnitObservation {
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const values = new Map<string, string>()
  for (const line of lines) {
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('Publication unit status is malformed')
    const name = line.slice(0, separator)
    if (values.has(name))
      throw new Error(`Publication unit status duplicates ${name}`)
    values.set(name, line.slice(separator + 1))
  }
  if (
    result.code !== 0 &&
    /not[- ]found|not loaded/iu.test(result.stderr) &&
    lines.length === 0
  )
    return { kind: 'not-found' }
  if (
    JSON.stringify([...values.keys()].sort()) !==
    JSON.stringify([...UNIT_OBSERVATION_FIELDS].sort())
  )
    throw new Error('Publication unit status fields are incomplete')
  if (values.get('Id') !== expectedServiceName)
    throw new Error('Publication unit status returned the wrong service')
  if (values.get('LoadState') === 'not-found') return { kind: 'not-found' }
  if (values.get('LoadState') !== 'loaded')
    throw new Error('Publication unit did not remain loaded')
  const invocationId = values.get('InvocationID') ?? ''
  const expectedControlGroup = `/system.slice/${expectedServiceName}`
  const expectedIdentityName = createPublicationIdentityName(
    expectedServiceName.slice(0, -'.service'.length),
  )
  const controlGroup = values.get('ControlGroup') ?? ''
  const mainPidText = values.get('MainPID') ?? ''
  if (
    !/^[a-f0-9]{32}$/.test(invocationId) ||
    controlGroup !== expectedControlGroup ||
    values.get('DynamicUser') !== 'yes' ||
    values.get('User') !== expectedIdentityName ||
    values.get('Group') !== expectedIdentityName ||
    values.get('Slice') !== 'system.slice' ||
    !/^\d+$/.test(mainPidText)
  )
    throw new Error('Publication unit identity is invalid')
  const mainPid = Number(mainPidText)
  if (!Number.isSafeInteger(mainPid))
    throw new Error('Publication unit main PID is invalid')
  return {
    kind: 'loaded',
    lease: { serviceName: expectedServiceName, invocationId, controlGroup },
    activeState: values.get('ActiveState') ?? '',
    subState: values.get('SubState') ?? '',
    mainPid,
  }
}

function populatedCgroupValue(events: string) {
  const values = events
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.startsWith('populated '))
  if (values.length !== 1 || !/^populated [01]$/.test(values[0]))
    throw new Error('Publication cgroup populated state is ambiguous')
  return values[0] === 'populated 1'
}

export function advancePublicationUnitLifecycle(
  lifecycle: PublicationUnitLifecycle,
  observation: PublicationUnitObservation,
  cgroupEvents?: string,
): PublicationUnitLifecycle {
  if (lifecycle.phase === 'collected') return lifecycle
  if (observation.kind === 'not-found') {
    if (lifecycle.phase !== 'drained')
      throw new Error('Publication unit disappeared before a proven drain')
    return { ...lifecycle, phase: 'collected' }
  }
  if (
    lifecycle.lease &&
    (observation.lease.invocationId !== lifecycle.lease.invocationId ||
      observation.lease.controlGroup !== lifecycle.lease.controlGroup ||
      observation.lease.serviceName !== lifecycle.lease.serviceName)
  )
    throw new Error('Publication unit identity changed during execution')
  const lease = lifecycle.lease ?? observation.lease
  if (cgroupEvents === undefined)
    throw new Error('Publication unit cgroup state is unavailable')
  const populated = populatedCgroupValue(cgroupEvents)
  const terminal = ['inactive', 'failed'].includes(observation.activeState)
  if (terminal && observation.mainPid === 0 && !populated)
    return { phase: 'drained', lease }
  if (lifecycle.phase === 'drained')
    throw new Error('Publication unit repopulated after a proven drain')
  return { phase: 'pinned', lease }
}

function publicationUnitShowArguments(serviceName: string) {
  return [
    'show',
    ...UNIT_OBSERVATION_FIELDS.map((field) => `--property=${field}`),
    serviceName,
  ]
}

function publicationProcStatusValue(status: string, name: string) {
  const value = status.match(new RegExp(`^${name}:\\s*(.+)$`, 'mu'))?.[1]
  if (!value) throw new Error(`Publication process status is missing ${name}`)
  return value.trim()
}

function publicationProcessStartTime(statLine: string) {
  const fields = statLine.slice(statLine.lastIndexOf(')') + 2).split(/\s+/u)
  const startTime = fields[19]
  if (!/^\d+$/.test(startTime ?? ''))
    throw new Error('Publication process start time is invalid')
  return startTime
}

export async function inspectPublicationCgroupMembership(
  lease: PublicationUnitLease,
  readCgroup: typeof readFile = readFile,
  inspectCgroup: typeof lstat = lstat,
  listCgroup: typeof readdir = readdir,
) {
  const root = resolve('/sys/fs/cgroup', `.${lease.controlGroup}`)
  const eventsPath = resolve(root, 'cgroup.events')
  const procsPath = resolve(root, 'cgroup.procs')
  const [beforeMetadata, beforeEvents, beforeProcs, children] =
    await Promise.all([
      inspectCgroup(root),
      readCgroup(eventsPath, 'utf8'),
      readCgroup(procsPath, 'utf8'),
      listCgroup(root, { withFileTypes: true }),
    ])
  if (
    !beforeMetadata.isDirectory() ||
    beforeMetadata.isSymbolicLink() ||
    children.some((entry) => entry.isDirectory())
  )
    throw new Error('Publication cgroup closure is not exact')
  const pids = beforeProcs.trim().split(/\s+/u).filter(Boolean).sort()
  if (
    pids.some((pid) => !/^\d+$/.test(pid)) ||
    new Set(pids).size !== pids.length
  )
    throw new Error('Publication cgroup membership is ambiguous')
  const members = await Promise.all(
    pids.map(async (pid) => {
      const [cgroup, status, statLine] = await Promise.all([
        readCgroup(`/proc/${pid}/cgroup`, 'utf8'),
        readCgroup(`/proc/${pid}/status`, 'utf8'),
        readCgroup(`/proc/${pid}/stat`, 'utf8'),
      ])
      if (cgroup.trim() !== `0::${lease.controlGroup}`)
        throw new Error(`Publication process ${pid} escaped its exact cgroup`)
      const startTime = publicationProcessStartTime(statLine)
      const uid = publicationProcStatusValue(status, 'Uid')
        .split(/\s+/u)
        .map(Number)
      const gid = publicationProcStatusValue(status, 'Gid')
        .split(/\s+/u)
        .map(Number)
      const nspid = publicationProcStatusValue(status, 'NSpid')
        .split(/\s+/u)
        .map(Number)
      if (
        uid.length !== 4 ||
        gid.length !== 4 ||
        nspid.some((value) => !Number.isSafeInteger(value) || value < 1)
      )
        throw new Error(`Publication process ${pid} identity is ambiguous`)
      return { pid, startTime, uid, gid, nspid }
    }),
  )
  const [afterMetadata, afterEvents, afterProcs, afterStartTimes] =
    await Promise.all([
      inspectCgroup(root),
      readCgroup(eventsPath, 'utf8'),
      readCgroup(procsPath, 'utf8'),
      Promise.all(
        members.map(({ pid }) =>
          readCgroup(`/proc/${pid}/stat`, 'utf8').then(
            publicationProcessStartTime,
          ),
        ),
      ),
    ])
  const afterPids = afterProcs.trim().split(/\s+/u).filter(Boolean).sort()
  if (
    afterMetadata.dev !== beforeMetadata.dev ||
    afterMetadata.ino !== beforeMetadata.ino ||
    beforeEvents !== afterEvents ||
    JSON.stringify(pids) !== JSON.stringify(afterPids) ||
    members.some(({ startTime }, index) => startTime !== afterStartTimes[index])
  )
    throw new Error('Publication cgroup changed while it was sampled')
  if (populatedCgroupValue(beforeEvents) && pids.length === 0)
    throw new Error('Publication cgroup is populated without visible members')
  const payload = members.filter(({ uid }) => uid.every((value) => value !== 0))
  const supervisors = members.filter(({ uid }) =>
    uid.some((value) => value === 0),
  )
  if (
    populatedCgroupValue(beforeEvents) &&
    (payload.length === 0 ||
      supervisors.some(
        ({ uid, gid, nspid }) =>
          !uid.every((value) => value === 0) ||
          !gid.every((value) => value === 0) ||
          nspid.length !== 1,
      ) ||
      !payload.some(({ nspid }) => nspid.length > 1 && nspid.at(-1) === 1) ||
      payload.some(
        ({ uid, gid, nspid }) =>
          !uid.every(
            (value) => value === uid[0] && value >= 61_184 && value <= 65_519,
          ) ||
          !gid.every(
            (value) => value === gid[0] && value >= 61_184 && value <= 65_519,
          ) ||
          nspid.length < 2,
      ) ||
      new Set(payload.map(({ uid }) => uid[0])).size !== 1 ||
      new Set(payload.map(({ gid }) => gid[0])).size !== 1)
  )
    throw new Error('Publication payload identity is incomplete or ambiguous')
  return {
    events: beforeEvents,
    members,
    payloadPids: payload.map(({ pid }) => pid),
    cgroupDevice: beforeMetadata.dev,
    cgroupInode: beforeMetadata.ino,
  }
}

export async function monitorPublicationSystemdUnit(
  invocation: PublicationSystemdInvocation,
  onPinned: (lease: PublicationUnitLease) => void = () => undefined,
  runSystemctl: PublicationSystemctlRunner = runPublicationSystemctlCommand,
  readCgroup: typeof readFile = readFile,
) {
  const serviceName = `${invocation.unitName}.service`
  const deadline = Date.now() + INVOCATION_TIMEOUT_MILLISECONDS
  const pinDeadline = Date.now() + UNIT_CLEANUP_TIMEOUT_MILLISECONDS
  let lifecycle: PublicationUnitLifecycle = { phase: 'unseen' }
  let announcedLease = false
  let observedPayload = false
  let cgroupIdentity: { device: number; inode: number } | undefined
  const observedProcessStartTimes = new Map<string, string>()
  let incoherentSamples = 0
  while (Date.now() < deadline) {
    const observation = parsePublicationUnitObservation(
      serviceName,
      await runSystemctl(publicationUnitShowArguments(serviceName)),
    )
    if (observation.kind === 'not-found' && lifecycle.phase === 'unseen') {
      if (Date.now() >= pinDeadline)
        throw new Error('Publication unit could not be pinned before execution')
      await new Promise((accept) => setTimeout(accept, 10))
      continue
    }
    let cgroupEvents: string | undefined
    if (observation.kind === 'loaded') {
      try {
        const sample = await inspectPublicationCgroupMembership(
          observation.lease,
          readCgroup,
        )
        if (
          cgroupIdentity &&
          (sample.cgroupDevice !== cgroupIdentity.device ||
            sample.cgroupInode !== cgroupIdentity.inode)
        )
          throw new Error(
            'Publication cgroup identity changed during execution',
          )
        cgroupIdentity ??= {
          device: sample.cgroupDevice,
          inode: sample.cgroupInode,
        }
        for (const member of sample.members) {
          const priorStartTime = observedProcessStartTimes.get(member.pid)
          if (priorStartTime && priorStartTime !== member.startTime)
            throw new Error(
              `Publication cgroup PID ${member.pid} was reused during execution`,
            )
          observedProcessStartTimes.set(member.pid, member.startTime)
        }
        cgroupEvents = sample.events
        if (sample.payloadPids.length > 0) observedPayload = true
      } catch (error) {
        if (
          /changed while it was sampled/u.test(String(error)) ||
          /payload identity is incomplete|populated without visible members/u.test(
            String(error),
          ) ||
          ['ENOENT', 'ESRCH'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          incoherentSamples += 1
          if (incoherentSamples <= 16) continue
          throw new Error(
            `Publication cgroup sampling remained incomplete: ${String(error)}`,
          )
        }
        throw error
      }
      incoherentSamples = 0
    }
    lifecycle = advancePublicationUnitLifecycle(
      lifecycle,
      observation,
      cgroupEvents,
    )
    if (lifecycle.lease && !announcedLease) {
      announcedLease = true
      onPinned(lifecycle.lease)
    }
    if (lifecycle.phase === 'collected') {
      if (!observedPayload)
        throw new Error('Publication unit never exposed a coherent payload')
      return lifecycle
    }
    await new Promise((accept) => setTimeout(accept, 10))
  }
  throw new Error('Publication unit lifecycle proof timed out')
}

export async function terminatePublicationSystemdUnit(
  unitName: string,
  runSystemctl: PublicationSystemctlRunner = runPublicationSystemctlCommand,
  readCgroup: typeof readFile = readFile,
  lease?: PublicationUnitLease,
) {
  if (!/^[a-z0-9-]+$/.test(unitName) || unitName.length > 63)
    throw new Error('Publication systemd unit name is invalid')
  const serviceName = `${unitName}.service`
  if (
    !lease ||
    lease.serviceName !== serviceName ||
    lease.controlGroup !== `/system.slice/${serviceName}`
  )
    throw new Error(
      'Publication unit cannot be terminated without its exact lease',
    )
  const preflight = parsePublicationUnitObservation(
    serviceName,
    await runSystemctl(publicationUnitShowArguments(serviceName)),
  )
  if (
    preflight.kind !== 'loaded' ||
    preflight.lease.invocationId !== lease.invocationId ||
    preflight.lease.controlGroup !== lease.controlGroup
  )
    throw new Error('Publication unit changed before exact-unit termination')
  await runSystemctl([
    'kill',
    '--kill-whom=all',
    '--signal=SIGKILL',
    serviceName,
  ]).catch(() => ({ code: null, stdout: '', stderr: '' }))
  await runSystemctl(['stop', serviceName]).catch(() => ({
    code: null,
    stdout: '',
    stderr: '',
  }))
  const deadline = Date.now() + UNIT_CLEANUP_TIMEOUT_MILLISECONDS
  let lifecycle: PublicationUnitLifecycle = { phase: 'pinned', lease }
  while (Date.now() < deadline) {
    const observation = parsePublicationUnitObservation(
      serviceName,
      await runSystemctl(publicationUnitShowArguments(serviceName)),
    )
    const cgroupEvents =
      observation.kind === 'loaded'
        ? await readCgroup(
            resolve(
              '/sys/fs/cgroup',
              `.${lease.controlGroup}`,
              'cgroup.events',
            ),
            'utf8',
          )
        : undefined
    lifecycle = advancePublicationUnitLifecycle(
      lifecycle,
      observation,
      cgroupEvents,
    )
    if (lifecycle.phase === 'collected') return
    await new Promise((accept) => setTimeout(accept, 25))
  }
  throw new Error(
    `Publication unit ${serviceName} was not drained and collected`,
  )
}

export async function runPublicationIsolatedRender(
  request: PublicationIsolatedRenderRequest,
  dependencies: PublicationIsolatedRenderDependencies = {},
) {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  assertPublicationBoundaryRuntime({ platform: process.platform, uid, gid })
  if (
    !request.title ||
    !/^\d+\.\d+\.\d+$/.test(request.expectedRendererVersion)
  )
    throw new Error('Publication normalization identity is invalid')
  const networkDiagnostic = request.networkDiagnostic ?? null
  if (
    networkDiagnostic &&
    (JSON.stringify(Object.keys(networkDiagnostic).sort()) !==
      JSON.stringify(
        [
          'httpIpv4Port',
          'httpIpv6Port',
          'tcpIpv4Port',
          'tcpIpv6Port',
          'udpIpv4Port',
          'udpIpv6Port',
          'websocketIpv4Port',
          'websocketIpv6Port',
        ].sort(),
      ) ||
      Object.values(networkDiagnostic).some(
        (port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535,
      ))
  )
    throw new Error('Publication network diagnostic is invalid')
  const filesystemDiagnosticPaths = [
    ...new Set(request.filesystemDiagnosticPaths ?? []),
  ]
  if (
    filesystemDiagnosticPaths.length > 8 ||
    filesystemDiagnosticPaths.some(
      (path) => !isAbsolute(path) || /[\0\r\n]/u.test(path),
    )
  )
    throw new Error('Publication filesystem diagnostics are invalid')
  await (
    dependencies.verifyExecutables ?? verifyPublicationBoundaryExecutables
  )()
  const publicationRoot = await realpath(request.publicationRoot)
  const inputPath = await realpath(request.inputPath)
  const browserPath = await realpath(request.browserPath)
  const { outputPath, parent: outputParent } = await assertSafeFinalPath(
    publicationRoot,
    request.outputPath,
  )
  if (!isPathInside(publicationRoot, inputPath))
    throw new Error('Publication HTML must stay inside the publication root')
  await Promise.all([
    access(PUBLICATION_OFFLINE_HELPER_PATH, constants.R_OK),
    access(PUBLICATION_NODE_MODULES, constants.R_OK),
    access(browserPath, constants.X_OK),
  ])
  if (
    (await realpath(PUBLICATION_OFFLINE_HELPER_PATH)) !==
    PUBLICATION_OFFLINE_HELPER_PATH
  )
    throw new Error('Publication isolation helper path is not canonical')
  const runtimeEntries = await (
    dependencies.createRuntimeAttestations ??
    createPublicationRuntimeAttestations
  )(request, browserPath)
  const unitName = createPublicationUnitName()
  const identityName = createPublicationIdentityName(unitName)
  const expectedControlGroup = `/system.slice/${unitName}.service`
  const [hostNetworkNamespace, hostMountNamespace, hostPidNamespace] =
    await Promise.all([
      readlink('/proc/self/ns/net'),
      readlink('/proc/self/ns/mnt'),
      readlink('/proc/self/ns/pid'),
    ])
  const stagingDirectory = await createPrivateStagingDirectory(outputParent)
  const requestPath = resolve(stagingDirectory, 'request.json')
  const mailboxDirectory = resolve(stagingDirectory, 'mailbox')
  const renderedPath = resolve(mailboxDirectory, 'rendered.pdf')
  const normalizedPath = resolve(stagingDirectory, 'normalized.pdf')
  const sourceRoot = resolve(stagingDirectory, 'source')
  try {
    const sourceSnapshot = await (
      dependencies.createSourceSnapshot ?? createPublicationSourceSnapshot
    )(publicationRoot, inputPath, sourceRoot)
    await exposePublicationSourceSnapshot(
      sourceSnapshot.root,
      sourceSnapshot.sourceEntries,
    )
    await mkdir(mailboxDirectory, { mode: 0o733 })
    await chmod(mailboxDirectory, 0o733)
    const expectedEnvironmentSha256 = environmentSha256(
      childEnvironment(sourceSnapshot.root),
    )
    const authenticatedRequest = {
      version: 5,
      renderer: request.renderer,
      publicationRoot: sourceSnapshot.root,
      stagingDirectory,
      inputPath: sourceSnapshot.inputPath,
      sourceEntries: sourceSnapshot.sourceEntries,
      sourceInputPath: sourceSnapshot.sourceInputPath,
      sourceSha256: sourceSnapshot.sourceSha256,
      outputPath: renderedPath,
      size: request.size,
      browserPath,
      expectedBrowserVersion: request.expectedBrowserVersion,
      expectedRendererVersion: request.expectedRendererVersion,
      expectedNodeVersion: process.versions.node,
      expectedEnvironmentSha256,
      expectedUid: uid!,
      expectedGid: gid!,
      expectedUnitName: unitName,
      expectedIdentityName: identityName,
      expectedControlGroup,
      hostNetworkNamespace,
      hostMountNamespace,
      hostPidNamespace,
      runtimeEntries,
      networkDiagnostic,
      filesystemDiagnosticPaths,
    }
    const serialized = `${JSON.stringify(authenticatedRequest)}\n`
    const requestSha256 = sha256(serialized)
    await writeFile(requestPath, serialized, { flag: 'wx', mode: 0o444 })
    await chmod(requestPath, 0o444)
    await chmod(stagingDirectory, 0o711)
    const invocation = buildPublicationSystemdInvocation({
      publicationRoot: sourceSnapshot.root,
      stagingDirectory,
      requestPath,
      requestSha256,
      runtimeReadOnlyPaths: publicationRuntimeReadOnlyPaths(runtimeEntries),
      uid: uid!,
      gid: gid!,
      unitName,
      identityName,
    })
    await (
      dependencies.verifyRuntimeAttestations ??
      verifyPublicationRuntimeAttestations
    )(runtimeEntries)
    const invocationResult = await (
      dependencies.runInvocation ?? runPublicationSystemdInvocation
    )(invocation)
    await chmod(stagingDirectory, 0o700)
    await (
      dependencies.verifyRuntimeAttestations ??
      verifyPublicationRuntimeAttestations
    )(runtimeEntries)
    const renderedPdf = await readOpenedRegularFile(
      renderedPath,
      MAX_PDF_BYTES,
      'Rendered publication PDF',
    )
    let proof: unknown
    try {
      if (!invocationResult?.proof)
        throw new Error('Publication proof output is missing')
      proof = JSON.parse(invocationResult.proof)
    } catch (error) {
      throw new Error(`Publication proof is not valid JSON: ${String(error)}`)
    }
    const validatedProof = validateIsolationProof({
      proof,
      authenticatedRequest,
      requestSha256,
      renderedPdf,
    })
    await Promise.all([
      rm(requestPath, { force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ])
    if (
      JSON.stringify((await readdir(stagingDirectory)).sort()) !==
        JSON.stringify(['mailbox']) ||
      JSON.stringify(await readdir(mailboxDirectory)) !==
        JSON.stringify(['rendered.pdf'])
    )
      throw new Error('Publication staging directory contains unexpected files')
    await (dependencies.normalizePdf ?? normalizePublicationPdf)(
      renderedPath,
      normalizedPath,
      request,
      renderedPdf.bytes,
    )
    const normalizedPdf = await readOpenedRegularFile(
      normalizedPath,
      MAX_PDF_BYTES,
      'Normalized publication PDF',
    )
    await PDFDocument.load(normalizedPdf.bytes)
    await rm(renderedPath)
    await rm(mailboxDirectory, { recursive: true })
    if (
      JSON.stringify(await readdir(stagingDirectory)) !==
      JSON.stringify(['normalized.pdf'])
    )
      throw new Error('Publication staging directory contains unexpected files')
    await assertSafeFinalPath(publicationRoot, request.outputPath, outputParent)
    await assertRegularPathIdentity(
      normalizedPath,
      normalizedPdf,
      'Normalized publication PDF',
    )
    await rename(normalizedPath, outputPath)
    return validatedProof
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export const PUBLICATION_OFFLINE_HELPER_PATH = resolve(PUBLICATION_HELPER)
