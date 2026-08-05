import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  access,
  lstat,
  readFile,
  readlink,
  realpath,
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
const UNIT_RUNTIME_SECONDS = 120
const INVOCATION_TIMEOUT_MILLISECONDS = 135_000

export type PublicationSystemdInvocation = {
  command: string
  args: string[]
  environment: NodeJS.ProcessEnv
  publicationRoot: string
  timeoutMilliseconds: number
}

export type PublicationIsolatedRenderRequest = {
  renderer: 'vivliostyle-cli' | 'playwright-chromium'
  publicationRoot: string
  inputPath: string
  outputPath: string
  size: 'A4' | 'A5'
  browserPath: string
  expectedBrowserVersion: string
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
  requestPath,
  requestSha256,
  uid,
  gid,
  unitName = createPublicationUnitName(),
}: {
  publicationRoot: string
  requestPath: string
  requestSha256: string
  uid: number
  gid: number
  unitName?: string
}): PublicationSystemdInvocation {
  assertPublicationBoundaryRuntime({ platform: 'linux', uid, gid })
  if (!isAbsolute(publicationRoot) || !isAbsolute(requestPath))
    throw new Error('Publication boundary paths must be absolute')
  if (/[%\0\r\n]/u.test(publicationRoot) || /[%\0\r\n]/u.test(requestPath))
    throw new Error('Publication boundary paths contain unsafe systemd syntax')
  if (!isPathInside(publicationRoot, requestPath))
    throw new Error('Publication request must be inside the publication root')
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
    'ProtectHome=read-only',
    `ReadWritePaths=${systemdPathListItem(publicationRoot)}`,
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
    'KillMode=mixed',
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
) {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  assertPublicationBoundaryRuntime({ platform: process.platform, uid, gid })
  await verifyPublicationBoundaryExecutables()
  const publicationRoot = await realpath(request.publicationRoot)
  const inputPath = await realpath(request.inputPath)
  const browserPath = await realpath(request.browserPath)
  const outputParent = await realpath(dirname(request.outputPath))
  const outputPath = resolve(outputParent, basename(request.outputPath))
  if (
    !isPathInside(publicationRoot, inputPath) ||
    !isPathInside(publicationRoot, outputPath)
  )
    throw new Error(
      'Publication render paths must stay inside the publication root',
    )
  try {
    const outputMetadata = await lstat(outputPath)
    if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink())
      throw new Error('Publication PDF output must be a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await Promise.all([
    access(PUBLICATION_OFFLINE_HELPER_PATH, constants.R_OK),
    access(browserPath, constants.X_OK),
  ])
  if (
    (await realpath(PUBLICATION_OFFLINE_HELPER_PATH)) !==
    PUBLICATION_OFFLINE_HELPER_PATH
  )
    throw new Error('Publication isolation helper path is not canonical')
  const hostNetworkNamespace = await readlink('/proc/self/ns/net')
  await rm(outputPath, { force: true })
  const requestPath = resolve(
    publicationRoot,
    `.publication-render-${randomBytes(8).toString('hex')}.json`,
  )
  const proofPath = resolve(
    publicationRoot,
    `.publication-proof-${randomBytes(8).toString('hex')}.json`,
  )
  const authenticatedRequest = {
    version: 1,
    renderer: request.renderer,
    publicationRoot,
    inputPath,
    outputPath,
    size: request.size,
    browserPath,
    expectedBrowserVersion: request.expectedBrowserVersion,
    expectedUid: uid!,
    expectedGid: gid!,
    hostNetworkNamespace,
    proofPath,
  }
  const finalSerialized = `${JSON.stringify(authenticatedRequest)}\n`
  const finalRequestSha256 = createHash('sha256')
    .update(finalSerialized)
    .digest('hex')
  await writeFile(requestPath, finalSerialized, { flag: 'wx', mode: 0o600 })
  let proof: unknown
  try {
    const invocation = buildPublicationSystemdInvocation({
      publicationRoot,
      requestPath,
      requestSha256: finalRequestSha256,
      uid: uid!,
      gid: gid!,
    })
    await runPublicationSystemdInvocation(invocation)
    proof = JSON.parse(await readFile(proofPath, 'utf8'))
  } finally {
    await Promise.all([
      rm(requestPath, { force: true }),
      rm(proofPath, { force: true }),
    ])
  }
  const outputMetadata = await lstat(outputPath)
  if (
    !outputMetadata.isFile() ||
    outputMetadata.isSymbolicLink() ||
    outputMetadata.size === 0
  )
    throw new Error('Isolated publication renderer did not create a PDF')
  if (
    !proof ||
    typeof proof !== 'object' ||
    (proof as { event?: unknown }).event !== 'publication-isolation-proof' ||
    (proof as { renderer?: unknown }).renderer !== request.renderer ||
    !/^net:\[\d+\]$/.test(
      String((proof as { networkNamespace?: unknown }).networkNamespace),
    ) ||
    (proof as { networkNamespace?: unknown }).networkNamespace ===
      hostNetworkNamespace ||
    JSON.stringify((proof as { interfaces?: unknown }).interfaces) !==
      JSON.stringify(['lo']) ||
    !Array.isArray(
      (proof as { childNetworkNamespaces?: unknown }).childNetworkNamespaces,
    ) ||
    (
      proof as {
        childNetworkNamespaces: unknown[]
        networkNamespace: unknown
      }
    ).childNetworkNamespaces.length === 0 ||
    (
      proof as {
        childNetworkNamespaces: unknown[]
        networkNamespace: unknown
      }
    ).childNetworkNamespaces.some(
      (identity) =>
        identity !== (proof as { networkNamespace: unknown }).networkNamespace,
    )
  )
    throw new Error(
      'Isolated publication renderer returned invalid attestation',
    )
  return proof
}

export const PUBLICATION_OFFLINE_HELPER_PATH = resolve(PUBLICATION_HELPER)
