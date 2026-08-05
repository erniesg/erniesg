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

export const PUBLICATION_BOUNDARY_EXECUTABLES = {
  sudo: '/usr/bin/sudo',
  systemdRun: '/usr/bin/systemd-run',
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
  runInvocation?: typeof runPublicationSystemdInvocation
  normalizePdf?: typeof normalizePublicationPdf
  createRuntimeAttestations?: typeof createPublicationRuntimeAttestations
  verifyRuntimeAttestations?: typeof verifyPublicationRuntimeAttestations
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
      entryCount: number
      device: string
      inode: string
      ctimeNanoseconds: string
      parentPath: string
      parentDevice: string
      parentInode: string
      parentCtimeNanoseconds: string
    }

export class PublicationSystemdError extends Error {
  exitCode?: number
  signal?: NodeJS.Signals
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
  const canonical = await realpath(path)
  if (canonical !== path)
    throw new Error(`Publication runtime tree is not canonical: ${path}`)
  const before = await stat(path, { bigint: true })
  if (!before.isDirectory())
    throw new Error(`Publication runtime tree is not a directory: ${path}`)
  const digest = createHash('sha256')
  let entryCount = 0
  const visit = async (directory: string) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      lexicalName,
    )
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name)
      const relativePath = relative(path, entryPath).split(sep).join('/')
      const metadata = await lstat(entryPath, { bigint: true })
      entryCount += 1
      if (metadata.isDirectory()) {
        digest.update(
          `${JSON.stringify(['directory', relativePath, metadata.mode.toString(), metadata.ctimeNs.toString()])}\n`,
        )
        await visit(entryPath)
      } else if (metadata.isFile()) {
        const file = await hashOpenRegularFile(entryPath)
        digest.update(
          `${JSON.stringify(['file', relativePath, file.metadata.mode.toString(), file.metadata.size.toString(), file.metadata.ctimeNs.toString(), file.sha256])}\n`,
        )
      } else if (metadata.isSymbolicLink()) {
        digest.update(
          `${JSON.stringify(['symlink', relativePath, metadata.ctimeNs.toString(), await readlink(entryPath)])}\n`,
        )
      } else {
        throw new Error(
          `Unsupported publication runtime tree entry: ${entryPath}`,
        )
      }
    }
  }
  await visit(path)
  const after = await stat(path, { bigint: true })
  if (!sameBigIntFileIdentity(before, after))
    throw new Error(`Publication runtime tree changed while hashing: ${path}`)
  const parent = await runtimeParentIdentity(path)
  return {
    kind: 'tree',
    label,
    path,
    sha256: digest.digest('hex'),
    entryCount,
    device: before.dev.toString(),
    inode: before.ino.toString(),
    ctimeNanoseconds: before.ctimeNs.toString(),
    ...parent,
  }
}

async function createPublicationRuntimeAttestations(
  request: PublicationIsolatedRenderRequest,
  browserPath: string,
) {
  const fileInputs = [
    ['node-executable', PUBLICATION_BOUNDARY_EXECUTABLES.node],
    ['isolation-helper', PUBLICATION_OFFLINE_HELPER_PATH],
    ['browser-executable', browserPath],
  ] as const
  const treeInputs =
    request.renderer === 'vivliostyle-cli'
      ? [
          ['resource-parser', PUBLICATION_RUNTIME_PATHS.parse5],
          ['renderer-package', PUBLICATION_RUNTIME_PATHS.vivliostyle],
        ]
      : [
          ['resource-parser', PUBLICATION_RUNTIME_PATHS.parse5],
          ['renderer-package', PUBLICATION_RUNTIME_PATHS.playwright],
          ['renderer-core', PUBLICATION_RUNTIME_PATHS.playwrightCore],
        ]
  return (
    await Promise.all([
      ...fileInputs.map(([label, path]) =>
        attestPublicationRuntimeFile(label, path),
      ),
      ...treeInputs.map(([label, path]) =>
        attestPublicationRuntimeTree(label, path),
      ),
    ])
  ).sort(lexicalLabel)
}

export async function verifyPublicationRuntimeAttestations(
  expected: PublicationRuntimeAttestation[],
) {
  const actual = (
    await Promise.all(
      expected.map((entry) =>
        entry.kind === 'file'
          ? attestPublicationRuntimeFile(entry.label, entry.path)
          : attestPublicationRuntimeTree(entry.label, entry.path),
      ),
    )
  ).sort(lexicalLabel)
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Publication runtime attestation changed')
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
  'childMountNamespaces',
  'childNetworkNamespaces',
  'environmentSha256',
  'event',
  'filesystemDiagnostics',
  'gid',
  'interfaces',
  'mountNamespace',
  'networkDiagnostic',
  'networkNamespace',
  'nodeVersion',
  'outputByteLength',
  'outputSha256',
  'renderer',
  'rendererVersion',
  'requestSha256',
  'runtimeEntries',
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
  if (
    record.version !== 1 ||
    record.event !== 'publication-isolation-proof' ||
    record.requestSha256 !== requestSha256 ||
    record.renderer !== authenticatedRequest.renderer ||
    record.rendererVersion !== authenticatedRequest.expectedRendererVersion ||
    record.browserVersion !== authenticatedRequest.expectedBrowserVersion ||
    record.nodeVersion !== authenticatedRequest.expectedNodeVersion ||
    record.uid !== authenticatedRequest.expectedUid ||
    record.gid !== authenticatedRequest.expectedGid ||
    record.environmentSha256 !==
      authenticatedRequest.expectedEnvironmentSha256 ||
    record.outputSha256 !== sha256(renderedPdf.bytes) ||
    record.outputByteLength !== renderedPdf.size ||
    JSON.stringify(record.runtimeEntries) !==
      JSON.stringify(authenticatedRequest.runtimeEntries) ||
    !/^net:\[\d+\]$/.test(String(networkNamespace)) ||
    networkNamespace === authenticatedRequest.hostNetworkNamespace ||
    !/^mnt:\[\d+\]$/.test(String(mountNamespace)) ||
    mountNamespace === authenticatedRequest.hostMountNamespace ||
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
}: {
  publicationRoot: string
  stagingDirectory: string
  requestPath: string
  requestSha256: string
  runtimeReadOnlyPaths: string[]
  uid: number
  gid: number
  unitName?: string
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
    ].some((path) => /[%\0\r\n]/u.test(path))
  )
    throw new Error('Publication boundary paths contain unsafe systemd syntax')
  if (
    !isPathInside(publicationRoot, stagingDirectory) ||
    !isPathInside(stagingDirectory, requestPath)
  )
    throw new Error(
      'Publication request must be inside its private staging directory',
    )
  if (!/^[a-f0-9]{64}$/.test(requestSha256))
    throw new Error('Publication request digest must be SHA-256')
  if (!/^[a-z0-9-]+$/.test(unitName) || unitName.length > 63)
    throw new Error('Publication systemd unit name is invalid')

  const properties = [
    'Type=exec',
    'PrivateNetwork=yes',
    'NoNewPrivileges=yes',
    'AmbientCapabilities=',
    'CapabilityBoundingSet=CAP_SETUID CAP_SETGID',
    'PrivateDevices=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    'ProtectHome=tmpfs',
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
    `BindReadOnlyPaths=${systemdPathListItem(publicationRoot)}`,
    ...runtimeReadOnlyPaths.map(
      (path) => `BindReadOnlyPaths=${systemdPathListItem(path)}`,
    ),
    `BindPaths=${systemdPathListItem(stagingDirectory)}`,
    `ReadWritePaths=${systemdPathListItem(stagingDirectory)}`,
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
    PUBLICATION_BOUNDARY_EXECUTABLES.setpriv,
    `--reuid=${uid}`,
    `--regid=${gid}`,
    '--clear-groups',
    '--inh-caps=-all',
    '--ambient-caps=-all',
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
  }
}

export async function runPublicationSystemdInvocation(
  invocation: PublicationSystemdInvocation,
  spawnProcess: typeof spawn = spawn,
) {
  await new Promise<void>((accept, reject) => {
    let timedOut = false
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd: invocation.publicationRoot,
      env: invocation.environment,
      shell: false,
      stdio: 'inherit',
    })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, invocation.timeoutMilliseconds)
    const finish = (result: () => void) => {
      clearTimeout(timeout)
      result()
    }
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code, signal) =>
      finish(() => {
        if (timedOut) {
          reject(
            new Error(
              `systemd-run exceeded ${invocation.timeoutMilliseconds}ms`,
            ),
          )
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
      }),
    )
  })
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
  const [hostNetworkNamespace, hostMountNamespace] = await Promise.all([
    readlink('/proc/self/ns/net'),
    readlink('/proc/self/ns/mnt'),
  ])
  const stagingDirectory = await createPrivateStagingDirectory(outputParent)
  const requestPath = resolve(stagingDirectory, 'request.json')
  const proofPath = resolve(stagingDirectory, 'proof.json')
  const renderedPath = resolve(stagingDirectory, 'rendered.pdf')
  const normalizedPath = resolve(stagingDirectory, 'normalized.pdf')
  try {
    const expectedEnvironmentSha256 = environmentSha256(
      childEnvironment(publicationRoot),
    )
    const authenticatedRequest = {
      version: 2,
      renderer: request.renderer,
      publicationRoot,
      stagingDirectory,
      inputPath,
      outputPath: renderedPath,
      size: request.size,
      browserPath,
      expectedBrowserVersion: request.expectedBrowserVersion,
      expectedRendererVersion: request.expectedRendererVersion,
      expectedNodeVersion: process.versions.node,
      expectedEnvironmentSha256,
      expectedUid: uid!,
      expectedGid: gid!,
      hostNetworkNamespace,
      hostMountNamespace,
      proofPath,
      runtimeEntries,
      networkDiagnostic,
      filesystemDiagnosticPaths,
    }
    const serialized = `${JSON.stringify(authenticatedRequest)}\n`
    const requestSha256 = sha256(serialized)
    await writeFile(requestPath, serialized, { flag: 'wx', mode: 0o600 })
    const invocation = buildPublicationSystemdInvocation({
      publicationRoot,
      stagingDirectory,
      requestPath,
      requestSha256,
      runtimeReadOnlyPaths: [
        ...new Set([
          PUBLICATION_OFFLINE_HELPER_PATH,
          PUBLICATION_NODE_MODULES,
          browserPath,
        ]),
      ],
      uid: uid!,
      gid: gid!,
    })
    await (dependencies.runInvocation ?? runPublicationSystemdInvocation)(
      invocation,
    )
    await (
      dependencies.verifyRuntimeAttestations ??
      verifyPublicationRuntimeAttestations
    )(runtimeEntries)
    const [proofFile, renderedPdf] = await Promise.all([
      readOpenedRegularFile(proofPath, MAX_PROOF_BYTES, 'Publication proof'),
      readOpenedRegularFile(
        renderedPath,
        MAX_PDF_BYTES,
        'Rendered publication PDF',
      ),
    ])
    let proof: unknown
    try {
      proof = JSON.parse(Buffer.from(proofFile.bytes).toString('utf8'))
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
      rm(proofPath, { force: true }),
    ])
    if (
      JSON.stringify((await readdir(stagingDirectory)).sort()) !==
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
