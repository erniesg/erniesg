import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  createReadStream,
  type BigIntStats,
} from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import { Browser, computeExecutablePath } from '@puppeteer/browsers'
import {
  PUBLICATION_TOOLCHAIN,
  publicationPdfRendererForRuntime,
  publicationPlatformKey,
  publicationPlaywrightCompatibilityForPlatform,
  publicationPlaywrightRuntimeEvidenceForPlatform,
  publicationPuppeteerRuntimeEvidenceForPlatform,
  type PublicationBrowserRuntimeEvidence,
  type PublicationPlaywrightRuntimeEvidence,
  type PublicationPuppeteerRuntimeEvidence,
} from './toolchain'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_PACKAGE_JSON = require.resolve('playwright/package.json')
const PLAYWRIGHT_CORE_PACKAGE_JSON =
  require.resolve('playwright-core/package.json')
const PLAYWRIGHT_CORE_BROWSERS_JSON = resolve(
  dirname(PLAYWRIGHT_CORE_PACKAGE_JSON),
  'browsers.json',
)
const NODE_MODULES_ROOT = resolve(dirname(PLAYWRIGHT_PACKAGE_JSON), '..')
const REPOSITORY_ROOT = resolve(NODE_MODULES_ROOT, '..')
const PUPPETEER_BROWSERS_PACKAGE_JSON =
  require.resolve('@puppeteer/browsers/package.json')
const PUPPETEER_CORE_PACKAGE_JSON =
  require.resolve('puppeteer-core/package.json')
const VIVLIOSTYLE_CLI_PACKAGE_JSON =
  require.resolve('@vivliostyle/cli/package.json')

export const PUBLICATION_BROWSER_CACHE = resolve(
  NODE_MODULES_ROOT,
  '.cache/publication-browsers',
)
export const PLAYWRIGHT_BROWSER_CACHE = resolve(
  PUBLICATION_BROWSER_CACHE,
  'playwright',
)
export const PUPPETEER_BROWSER_CACHE = resolve(
  PUBLICATION_BROWSER_CACHE,
  'puppeteer',
)
export function publicationBrowserSnapshotRootPath(
  environment: { PUBLICATION_BROWSER_SNAPSHOT_ROOT?: string } = process.env,
) {
  const configured = environment.PUBLICATION_BROWSER_SNAPSHOT_ROOT
  if (configured !== undefined) {
    if (
      configured.trim() !== configured ||
      !isAbsolute(configured) ||
      resolve(configured) !== configured
    )
      throw new Error(
        'PUBLICATION_BROWSER_SNAPSHOT_ROOT must be an absolute normalized path',
      )
    return resolve(configured)
  }
  return resolve(REPOSITORY_ROOT, '.publication-browser-snapshots')
}

export const PUBLICATION_BROWSER_SNAPSHOT_ROOT =
  publicationBrowserSnapshotRootPath()
const PUBLICATION_BROWSER_SNAPSHOT_LEASE = '.lease'
const PUBLICATION_BROWSER_SNAPSHOT_REAP_PREFIX = 'reap-'
const PUBLICATION_BROWSER_SNAPSHOT_DELETE_PREFIX = 'delete-'
const PUBLICATION_BROWSER_SNAPSHOT_HEARTBEAT_MS = 15_000
const PUBLICATION_BROWSER_SNAPSHOT_STALE_MS = 120_000
// Snapshot isolation protects against ordinary concurrent installer/cache
// replacement and untrusted child symlinks. The private tree is mode 0700;
// processes with the same uid (and root) remain inside the trusted VM boundary.
// A heartbeat lease keeps concurrent builds distinct. A later preparation
// atomically quarantines crash orphans after two quiet minutes, then waits a
// second quiet interval before atomically claiming and removing the fenced
// tree.

export type PreparedPublicationPlaywrightRuntime = {
  executablePath: string
  publicationBrowser: PublicationPlaywrightRuntimeEvidence
  assertUnchanged: () => Promise<void>
  verifyUnchanged: () => Promise<void>
  cleanup: () => Promise<void>
}

export type PreparedPublicationPuppeteerRuntime = {
  executablePath: string
  publicationBrowser: PublicationPuppeteerRuntimeEvidence
  assertUnchanged: () => Promise<void>
  verifyUnchanged: () => Promise<void>
  cleanup: () => Promise<void>
}

function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function publicationPlaywrightPackageIdentityPaths() {
  return {
    playwrightPackageJson: PLAYWRIGHT_PACKAGE_JSON,
    playwrightCorePackageJson: PLAYWRIGHT_CORE_PACKAGE_JSON,
    browsersJson: PLAYWRIGHT_CORE_BROWSERS_JSON,
  }
}

export function publicationPlaywrightExecutableCandidates(
  revision: string,
  platform = process.platform,
  architecture = process.arch,
) {
  const platformKey = publicationPlatformKey(platform, architecture)
  const chromiumPaths: Record<string, string[]> = {
    'linux-x64': ['chrome-linux64', 'chrome'],
    'linux-arm64': ['chrome-linux', 'chrome'],
    'mac-x64': [
      'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ],
    'mac-arm64': [
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ],
  }
  const headlessPaths: Record<string, string[]> = {
    'linux-x64': ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    'linux-arm64': ['chrome-linux', 'headless_shell'],
    'mac-x64': ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
    'mac-arm64': ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
  }
  if (!chromiumPaths[platformKey] || !headlessPaths[platformKey])
    throw new Error(
      `Unsupported Playwright Chromium platform layout: ${platformKey}`,
    )
  return [
    resolve(
      PLAYWRIGHT_BROWSER_CACHE,
      `chromium-${revision}`,
      ...chromiumPaths[platformKey],
    ),
    resolve(
      PLAYWRIGHT_BROWSER_CACHE,
      `chromium_headless_shell-${revision}`,
      ...headlessPaths[platformKey],
    ),
  ]
}

export function publicationBrowserVersion(versionOutput: string) {
  return String(versionOutput).match(/\b(\d+\.\d+\.\d+\.\d+)\b/u)?.[1] ?? ''
}

export function publicationBrowserVersionMatches(
  versionOutput: string,
  expectedVersion: string,
) {
  const actual = publicationBrowserVersion(versionOutput)
  const expected = String(expectedVersion).match(/^(\d+\.\d+\.\d+\.\d+)$/u)?.[1]
  return Boolean(actual && expected && actual === expected)
}

export function verifyPublicationBrowserExecutable(
  executablePath: string,
  expectedVersion: string,
) {
  let versionOutput = ''
  try {
    versionOutput = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch (error) {
    throw new Error(
      `Pinned publication browser could not report its version: ${String(error)}`,
    )
  }
  if (!publicationBrowserVersionMatches(versionOutput, expectedVersion))
    throw new Error(
      `Pinned publication browser version ${versionOutput.trim() || '(missing)'} does not match ${expectedVersion}`,
    )
  return versionOutput.trim()
}

async function firstAccessiblePath(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue through the closed, platform-specific candidate list.
    }
  }
  return ''
}

export type PublicationBrowserBundle = {
  bundleRoot: string
  executableRelativePath: string
}

function pathIsWithin(root: string, path: string) {
  const child = relative(root, path)
  return child !== '' && !child.startsWith(`..${sep}`) && child !== '..'
}

export async function publicationBrowserBundleForExecutable(
  executablePath: string,
  cacheRoot = PLAYWRIGHT_BROWSER_CACHE,
): Promise<PublicationBrowserBundle> {
  const [canonicalCache, canonicalExecutable] = await Promise.all([
    realpath(cacheRoot),
    realpath(executablePath),
  ])
  if (
    resolve(executablePath) !== canonicalExecutable ||
    !pathIsWithin(canonicalCache, canonicalExecutable)
  )
    throw new Error(
      'Pinned publication browser executable is a symlink or outside its repository-local cache',
    )
  const relativeExecutable = relative(canonicalCache, canonicalExecutable)
  const bundleName = relativeExecutable.split(sep)[0]
  if (!/^chromium(?:_headless_shell)?-\d+$/u.test(bundleName))
    throw new Error(
      'Pinned publication browser executable has no recognized cache bundle',
    )
  const executable = await lstat(canonicalExecutable)
  if (!executable.isFile())
    throw new Error(
      'Pinned publication browser executable is not a regular file',
    )
  return {
    bundleRoot: resolve(canonicalCache, bundleName),
    executableRelativePath: relative(
      resolve(canonicalCache, bundleName),
      canonicalExecutable,
    ),
  }
}

export async function publicationPuppeteerBrowserBundleForExecutable(
  executablePath: string,
  options: {
    cacheRoot?: string
    platform?: string
    architecture?: string
    buildId?: string
  } = {},
): Promise<PublicationBrowserBundle> {
  const cacheRoot = options.cacheRoot ?? PUPPETEER_BROWSER_CACHE
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const buildId = options.buildId ?? PUBLICATION_TOOLCHAIN.browser.revision
  const platformKey = publicationPlatformKey(platform, architecture)
  if (platformKey !== 'linux-x64' && platformKey !== 'mac-x64')
    throw new Error(
      `Unsupported Puppeteer publication browser platform: ${platformKey}`,
    )
  if (buildId !== PUBLICATION_TOOLCHAIN.browser.revision)
    throw new Error('Puppeteer publication browser revision is not pinned')

  const [canonicalCache, canonicalExecutable] = await Promise.all([
    realpath(cacheRoot),
    realpath(executablePath),
  ])
  if (
    resolve(executablePath) !== canonicalExecutable ||
    !pathIsWithin(canonicalCache, canonicalExecutable)
  )
    throw new Error(
      'Pinned Puppeteer browser executable is a symlink or outside its repository-local cache',
    )

  const installationPlatform = platformKey === 'linux-x64' ? 'linux' : 'mac'
  const bundleRoot = resolve(
    canonicalCache,
    'chrome',
    `${installationPlatform}-${buildId}`,
  )
  if (!pathIsWithin(bundleRoot, canonicalExecutable))
    throw new Error(
      'Pinned Puppeteer browser executable is outside its expected cache bundle',
    )
  const executable = await lstat(canonicalExecutable)
  if (!executable.isFile())
    throw new Error('Pinned Puppeteer browser executable is not a regular file')
  return {
    bundleRoot,
    executableRelativePath: relative(bundleRoot, canonicalExecutable),
  }
}

type FileIdentity = { dev: bigint; ino: bigint }

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameStableSourceEntry(
  left: FileIdentity & {
    size: bigint
    mode: bigint
    mtimeNs: bigint
    ctimeNs: bigint
  },
  right: FileIdentity & {
    size: bigint
    mode: bigint
    mtimeNs: bigint
    ctimeNs: bigint
  },
) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function publicationBrowserReadFlags(directory = false) {
  return (
    fsConstants.O_RDONLY |
    fsConstants.O_NOFOLLOW |
    fsConstants.O_NONBLOCK |
    (directory ? fsConstants.O_DIRECTORY : 0)
  )
}

function publicationBrowserSourceChanged() {
  return new Error(
    'Pinned publication browser cache bundle changed during snapshot creation',
  )
}

async function copyPublicationBrowserFile(
  source: string,
  destination: string,
  sourceEntry: BigIntStats,
) {
  const sourceFile = await open(source, publicationBrowserReadFlags())
  try {
    const openedSource = await sourceFile.stat({ bigint: true })
    if (!openedSource.isFile() || !sameFileIdentity(sourceEntry, openedSource))
      throw publicationBrowserSourceChanged()
    const destinationFile = await open(
      destination,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    )
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let copiedBytes = 0n
      for (;;) {
        const { bytesRead } = await sourceFile.read(
          buffer,
          0,
          buffer.length,
          null,
        )
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const result = await destinationFile.write(
            buffer,
            written,
            bytesRead - written,
            null,
          )
          if (result.bytesWritten === 0)
            throw new Error(
              'Pinned publication browser snapshot write made no progress',
            )
          written += result.bytesWritten
        }
        copiedBytes += BigInt(bytesRead)
      }
      await destinationFile.chmod(Number(openedSource.mode & 0o555n))
      const confirmedSource = await sourceFile.stat({ bigint: true })
      if (
        copiedBytes !== openedSource.size ||
        !sameStableSourceEntry(openedSource, confirmedSource)
      )
        throw publicationBrowserSourceChanged()
    } finally {
      await destinationFile.close()
    }
  } finally {
    await sourceFile.close()
  }
}

async function copyPublicationBrowserTree(
  source: string,
  destination: string,
  sourceBundleRoot: string,
  expectedSource?: FileIdentity,
): Promise<void> {
  const sourceEntry = await lstat(source, { bigint: true })
  if (expectedSource && !sameFileIdentity(sourceEntry, expectedSource))
    throw publicationBrowserSourceChanged()
  if (sourceEntry.isSymbolicLink()) {
    const target = await readlink(source)
    const resolvedTarget = resolve(dirname(source), target)
    if (
      isAbsolute(target) ||
      (resolvedTarget !== sourceBundleRoot &&
        !pathIsWithin(sourceBundleRoot, resolvedTarget))
    )
      throw new Error(
        'Pinned publication browser cache bundle contains an escaping symlink',
      )
    await symlink(target, destination)
    const [confirmedEntry, confirmedTarget] = await Promise.all([
      lstat(source, { bigint: true }),
      readlink(source),
    ])
    if (
      !confirmedEntry.isSymbolicLink() ||
      !sameStableSourceEntry(sourceEntry, confirmedEntry) ||
      confirmedTarget !== target
    )
      throw publicationBrowserSourceChanged()
    return
  }
  if (sourceEntry.isFile()) {
    await copyPublicationBrowserFile(source, destination, sourceEntry)
    return
  }
  if (!sourceEntry.isDirectory())
    throw new Error(
      'Pinned publication browser cache bundles may contain only regular files, directories, and internal symlinks',
    )

  const sourceDirectory = await open(source, publicationBrowserReadFlags(true))
  try {
    const openedSource = await sourceDirectory.stat({ bigint: true })
    if (
      !openedSource.isDirectory() ||
      !sameFileIdentity(sourceEntry, openedSource)
    )
      throw publicationBrowserSourceChanged()
    await mkdir(destination, { mode: 0o700 })
    const entries = (await readdir(source)).sort((left, right) =>
      left.localeCompare(right),
    )
    for (const entryName of entries)
      await copyPublicationBrowserTree(
        resolve(source, entryName),
        resolve(destination, entryName),
        sourceBundleRoot,
      )
    const [confirmedHandle, confirmedPath] = await Promise.all([
      sourceDirectory.stat({ bigint: true }),
      lstat(source, { bigint: true }),
    ])
    if (
      !confirmedPath.isDirectory() ||
      !sameStableSourceEntry(openedSource, confirmedHandle) ||
      !sameStableSourceEntry(openedSource, confirmedPath)
    )
      throw publicationBrowserSourceChanged()
  } finally {
    await sourceDirectory.close()
  }
}

async function publicationBrowserSnapshotRoot(
  snapshotRoot: string,
  bundleRoot: string,
) {
  const requestedRoot = resolve(snapshotRoot)
  const canonicalParent = await realpath(dirname(requestedRoot))
  const expectedRoot = resolve(canonicalParent, basename(requestedRoot))
  const canonicalBundle = await realpath(bundleRoot)
  const bundleEntry = await lstat(canonicalBundle, { bigint: true })
  if (!bundleEntry.isDirectory())
    throw new Error(
      'Pinned publication browser source bundle is not a directory',
    )
  if (
    expectedRoot === canonicalBundle ||
    pathIsWithin(canonicalBundle, expectedRoot)
  )
    throw new Error(
      'Pinned publication browser snapshot directory overlaps its source bundle',
    )

  let rootEntry
  try {
    rootEntry = await lstat(requestedRoot, { bigint: true })
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    try {
      await mkdir(requestedRoot, { mode: 0o700 })
    } catch (mkdirError) {
      if ((mkdirError as { code?: string }).code !== 'EEXIST') throw mkdirError
    }
    rootEntry = await lstat(requestedRoot, { bigint: true })
  }
  const currentUid = process.getuid?.()
  if (
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    (rootEntry.mode & 0o022n) !== 0n ||
    (currentUid !== undefined && rootEntry.uid !== BigInt(currentUid))
  )
    throw new Error(
      'Pinned publication browser snapshot root is a symlink, unsafe, or not a directory',
    )
  const canonicalRoot = await realpath(requestedRoot)
  const confirmedRoot = await lstat(requestedRoot, { bigint: true })
  if (
    canonicalRoot !== expectedRoot ||
    !sameFileIdentity(confirmedRoot, rootEntry)
  )
    throw new Error(
      'Pinned publication browser snapshot root is redirected by a symlink',
    )
  return {
    bundleEntry,
    canonicalBundle,
    canonicalRoot,
    rootEntry: confirmedRoot,
  }
}

async function removePublicationBrowserTree(
  path: string,
  expectedEntry: FileIdentity,
  tolerateMissing = false,
): Promise<void> {
  let entry
  try {
    entry = await lstat(path, { bigint: true })
  } catch (error) {
    if (tolerateMissing && (error as { code?: string }).code === 'ENOENT')
      return
    throw error
  }
  if (!sameFileIdentity(entry, expectedEntry))
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after an entry identity changed',
    )
  if (!entry.isDirectory()) {
    try {
      await unlink(path)
    } catch (error) {
      if (tolerateMissing && (error as { code?: string }).code === 'ENOENT')
        return
      throw error
    }
    return
  }
  let entries
  try {
    entries = (await readdir(path)).sort((left, right) =>
      left.localeCompare(right),
    )
  } catch (error) {
    if (tolerateMissing && (error as { code?: string }).code === 'ENOENT')
      return
    throw error
  }
  for (const entryName of entries) {
    const entryPath = resolve(path, entryName)
    let childEntry
    try {
      childEntry = await lstat(entryPath, { bigint: true })
    } catch (error) {
      if (tolerateMissing && (error as { code?: string }).code === 'ENOENT')
        continue
      throw error
    }
    await removePublicationBrowserTree(entryPath, childEntry, tolerateMissing)
  }
  let confirmedEntry
  try {
    confirmedEntry = await lstat(path, { bigint: true })
  } catch (error) {
    if (tolerateMissing && (error as { code?: string }).code === 'ENOENT')
      return
    throw error
  }
  if (!confirmedEntry.isDirectory() || !sameFileIdentity(entry, confirmedEntry))
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after an entry identity changed',
    )
  try {
    await rmdir(path)
  } catch (error) {
    if (tolerateMissing && (error as { code?: string }).code === 'ENOENT')
      return
    throw error
  }
}

function publicationBrowserSnapshotEntryIsStale(
  entry: BigIntStats,
  now = Date.now(),
) {
  return (
    BigInt(now) - entry.mtimeMs > BigInt(PUBLICATION_BROWSER_SNAPSHOT_STALE_MS)
  )
}

function publicationBrowserPrivateDirectoryIsSafe(
  entry: BigIntStats,
  currentUid: number | undefined,
) {
  return (
    entry.isDirectory() &&
    (entry.mode & 0o077n) === 0n &&
    (currentUid === undefined || entry.uid === BigInt(currentUid))
  )
}

async function quarantinePublicationBrowserSnapshot(
  canonicalRoot: string,
  privateRoot: string,
  privateEntry: FileIdentity,
) {
  const quarantineRoot = await mkdtemp(
    resolve(canonicalRoot, PUBLICATION_BROWSER_SNAPSHOT_REAP_PREFIX),
  )
  const quarantinedSnapshot = resolve(quarantineRoot, 'snapshot')
  let fenced = false
  try {
    const confirmedPrivate = await lstat(privateRoot, { bigint: true })
    if (
      !confirmedPrivate.isDirectory() ||
      !sameFileIdentity(privateEntry, confirmedPrivate)
    )
      return false
    await rename(privateRoot, quarantinedSnapshot)
    fenced = true
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false
    throw error
  } finally {
    if (!fenced)
      try {
        await rmdir(quarantineRoot)
      } catch (error) {
        if (
          !['ENOENT', 'ENOTEMPTY'].includes(
            (error as { code?: string }).code ?? '',
          )
        )
          throw error
      }
  }
}

async function claimPublicationBrowserQuarantine(
  canonicalRoot: string,
  quarantineRoot: string,
  quarantineEntry: FileIdentity,
) {
  const deletionRoot = resolve(
    canonicalRoot,
    `${PUBLICATION_BROWSER_SNAPSHOT_DELETE_PREFIX}${randomUUID()}`,
  )
  try {
    const confirmedQuarantine = await lstat(quarantineRoot, { bigint: true })
    if (
      !confirmedQuarantine.isDirectory() ||
      !sameFileIdentity(quarantineEntry, confirmedQuarantine)
    )
      return ''
    // Moving the quarantine out of the publisher-visible reap namespace is the
    // deletion claim. A publisher paused after mkdtemp can no longer add its
    // snapshot after this point; its destination path has disappeared.
    await rename(quarantineRoot, deletionRoot)
    return deletionRoot
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return ''
    throw error
  }
}

async function scavengePublicationBrowserSnapshots(canonicalRoot: string) {
  const currentUid = process.getuid?.()
  const entries = (await readdir(canonicalRoot)).sort((left, right) =>
    left.localeCompare(right),
  )
  for (const entryName of entries) {
    const entryPath = resolve(canonicalRoot, entryName)
    let privateEntry
    try {
      privateEntry = await lstat(entryPath, { bigint: true })
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue
      throw error
    }
    if (
      entryName.startsWith(PUBLICATION_BROWSER_SNAPSHOT_DELETE_PREFIX) &&
      publicationBrowserPrivateDirectoryIsSafe(privateEntry, currentUid) &&
      publicationBrowserSnapshotEntryIsStale(privateEntry)
    ) {
      // Deletion roots can only be created by an atomic rename from the reap
      // namespace. A prior scavenger may have crashed during traversal.
      await removePublicationBrowserTree(entryPath, privateEntry, true)
      continue
    }
    if (
      entryName.startsWith(PUBLICATION_BROWSER_SNAPSHOT_REAP_PREFIX) &&
      publicationBrowserPrivateDirectoryIsSafe(privateEntry, currentUid) &&
      publicationBrowserSnapshotEntryIsStale(privateEntry)
    ) {
      const deletionRoot = await claimPublicationBrowserQuarantine(
        canonicalRoot,
        entryPath,
        privateEntry,
      )
      if (deletionRoot) {
        let claimedEntry
        try {
          claimedEntry = await lstat(deletionRoot, { bigint: true })
        } catch (error) {
          if ((error as { code?: string }).code === 'ENOENT') continue
          throw error
        }
        // A paused publisher may win the race immediately before the atomic
        // claim. Its rename refreshes the directory mtime, so retain the now-
        // fenced payload for a full second grace interval.
        if (
          sameFileIdentity(privateEntry, claimedEntry) &&
          publicationBrowserSnapshotEntryIsStale(claimedEntry)
        )
          await removePublicationBrowserTree(deletionRoot, claimedEntry, true)
      }
      continue
    }
    if (
      !entryName.startsWith('browser-') ||
      !publicationBrowserPrivateDirectoryIsSafe(privateEntry, currentUid)
    )
      continue
    const privateRoot = entryPath
    const leasePath = resolve(privateRoot, PUBLICATION_BROWSER_SNAPSHOT_LEASE)
    let leaseEntry
    try {
      leaseEntry = await lstat(leasePath, { bigint: true })
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        if (publicationBrowserSnapshotEntryIsStale(privateEntry))
          await quarantinePublicationBrowserSnapshot(
            canonicalRoot,
            privateRoot,
            privateEntry,
          )
        continue
      }
      throw error
    }
    if (
      !leaseEntry.isFile() ||
      (leaseEntry.mode & 0o077n) !== 0n ||
      !publicationBrowserSnapshotEntryIsStale(leaseEntry)
    )
      continue
    try {
      const [confirmedPrivate, confirmedLease] = await Promise.all([
        lstat(privateRoot, { bigint: true }),
        lstat(leasePath, { bigint: true }),
      ])
      if (
        confirmedPrivate.isDirectory() &&
        sameFileIdentity(privateEntry, confirmedPrivate) &&
        confirmedLease.isFile() &&
        sameFileIdentity(leaseEntry, confirmedLease) &&
        publicationBrowserSnapshotEntryIsStale(confirmedLease)
      )
        await quarantinePublicationBrowserSnapshot(
          canonicalRoot,
          privateRoot,
          confirmedPrivate,
        )
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }
}

function heartbeatPublicationBrowserSnapshot(leasePath: string) {
  let stopped = false
  let ownershipLost = false
  const timer = setInterval(() => {
    if (stopped) return
    const now = new Date()
    void utimes(leasePath, now, now).catch(() => {
      ownershipLost = true
    })
  }, PUBLICATION_BROWSER_SNAPSHOT_HEARTBEAT_MS)
  timer.unref()
  return {
    assertOwned() {
      if (ownershipLost)
        throw new Error(
          'Pinned publication browser snapshot lease ownership was lost',
        )
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

async function assertPublicationBrowserSnapshotIdentity(
  canonicalRoot: string,
  rootEntry: FileIdentity,
  privateRoot: string,
  privateEntry: FileIdentity,
  leasePath: string,
  leaseEntry: FileIdentity,
) {
  try {
    const [currentRoot, currentPrivate, currentLease] = await Promise.all([
      lstat(canonicalRoot, { bigint: true }),
      lstat(privateRoot, { bigint: true }),
      lstat(leasePath, { bigint: true }),
    ])
    const [currentCanonicalRoot, canonicalPrivate] = await Promise.all([
      realpath(canonicalRoot),
      realpath(privateRoot),
    ])
    const [confirmedRoot, confirmedPrivate, confirmedLease] = await Promise.all(
      [
        lstat(canonicalRoot, { bigint: true }),
        lstat(privateRoot, { bigint: true }),
        lstat(leasePath, { bigint: true }),
      ],
    )
    if (
      !currentRoot.isDirectory() ||
      !sameFileIdentity(currentRoot, rootEntry) ||
      !confirmedRoot.isDirectory() ||
      !sameFileIdentity(confirmedRoot, rootEntry) ||
      currentCanonicalRoot !== canonicalRoot ||
      !currentPrivate.isDirectory() ||
      !sameFileIdentity(currentPrivate, privateEntry) ||
      !confirmedPrivate.isDirectory() ||
      !sameFileIdentity(confirmedPrivate, privateEntry) ||
      !currentLease.isFile() ||
      !sameFileIdentity(currentLease, leaseEntry) ||
      !confirmedLease.isFile() ||
      !sameFileIdentity(confirmedLease, leaseEntry) ||
      canonicalPrivate !== privateRoot ||
      dirname(privateRoot) !== canonicalRoot
    )
      throw new Error('snapshot identity mismatch')
  } catch {
    throw new Error(
      'Pinned publication browser snapshot directory identity changed',
    )
  }
}

async function cleanupPublicationBrowserSnapshot(
  canonicalRoot: string,
  rootEntry: FileIdentity,
  privateRoot: string,
  privateEntry: FileIdentity,
  leasePath: string,
  leaseEntry: FileIdentity,
  beforeLeaseRemoval: () => void,
) {
  try {
    await assertPublicationBrowserSnapshotIdentity(
      canonicalRoot,
      rootEntry,
      privateRoot,
      privateEntry,
      leasePath,
      leaseEntry,
    )
  } catch {
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after its directory identity changed',
    )
  }
  // The private tree is mode 0700 and processes with the same uid are trusted.
  // Keep the lease in place until every payload entry is gone so a crash during
  // cleanup cannot leave a large lease-less tree. Remove entries one at a time
  // without following symlinks; never hand a mutable pathname to recursive
  // deletion.
  const entries = (await readdir(privateRoot))
    .filter((entryName) => entryName !== PUBLICATION_BROWSER_SNAPSHOT_LEASE)
    .sort((left, right) => left.localeCompare(right))
  for (const entryName of entries) {
    const entryPath = resolve(privateRoot, entryName)
    const entry = await lstat(entryPath, { bigint: true })
    await removePublicationBrowserTree(entryPath, entry)
  }
  try {
    await assertPublicationBrowserSnapshotIdentity(
      canonicalRoot,
      rootEntry,
      privateRoot,
      privateEntry,
      leasePath,
      leaseEntry,
    )
  } catch {
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after its directory identity changed',
    )
  }
  beforeLeaseRemoval()
  await unlink(leasePath)
  const confirmedPrivate = await lstat(privateRoot, { bigint: true })
  if (
    !confirmedPrivate.isDirectory() ||
    !sameFileIdentity(privateEntry, confirmedPrivate)
  )
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after its directory identity changed',
    )
  await rmdir(privateRoot)
}

export async function snapshotPublicationBrowserBundle(
  bundle: PublicationBrowserBundle,
  snapshotRoot = PUBLICATION_BROWSER_SNAPSHOT_ROOT,
) {
  const { bundleEntry, canonicalBundle, canonicalRoot, rootEntry } =
    await publicationBrowserSnapshotRoot(snapshotRoot, bundle.bundleRoot)
  await scavengePublicationBrowserSnapshots(canonicalRoot)
  const privateRoot = await mkdtemp(resolve(canonicalRoot, 'browser-'))
  const snapshotBundleRoot = resolve(privateRoot, basename(canonicalBundle))
  const privateEntry = await lstat(privateRoot, { bigint: true })
  if (!privateEntry.isDirectory() || (privateEntry.mode & 0o077n) !== 0n)
    throw new Error(
      'Pinned publication browser private snapshot directory is unsafe',
    )
  const leasePath = resolve(privateRoot, PUBLICATION_BROWSER_SNAPSHOT_LEASE)
  await writeFile(leasePath, 'publication browser snapshot lease\n', {
    flag: 'wx',
    mode: 0o600,
  })
  const leaseEntry = await lstat(leasePath, { bigint: true })
  if (
    !leaseEntry.isFile() ||
    (leaseEntry.mode & 0o077n) !== 0n ||
    (process.getuid?.() !== undefined &&
      leaseEntry.uid !== BigInt(process.getuid()))
  )
    throw new Error('Pinned publication browser snapshot lease is unsafe')
  const heartbeat = heartbeatPublicationBrowserSnapshot(leasePath)
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      try {
        await cleanupPublicationBrowserSnapshot(
          canonicalRoot,
          rootEntry,
          privateRoot,
          privateEntry,
          leasePath,
          leaseEntry,
          heartbeat.stop,
        )
      } finally {
        heartbeat.stop()
      }
    })())
  const assertDirectoryIdentity = () => {
    heartbeat.assertOwned()
    return assertPublicationBrowserSnapshotIdentity(
      canonicalRoot,
      rootEntry,
      privateRoot,
      privateEntry,
      leasePath,
      leaseEntry,
    )
  }
  try {
    await assertDirectoryIdentity()
    await copyPublicationBrowserTree(
      canonicalBundle,
      snapshotBundleRoot,
      canonicalBundle,
      bundleEntry,
    )
    await assertDirectoryIdentity()
    const executablePath = resolve(
      snapshotBundleRoot,
      bundle.executableRelativePath,
    )
    const executable = await lstat(executablePath)
    if (!executable.isFile())
      throw new Error(
        'Pinned publication browser snapshot executable is not a regular file',
      )
    return {
      executablePath,
      assertDirectoryIdentity,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function preparePublicationBrowserSnapshot(
  bundle: PublicationBrowserBundle,
  expectedVersion: string,
  snapshotRoot?: string,
) {
  const snapshot = await snapshotPublicationBrowserBundle(bundle, snapshotRoot)
  try {
    await snapshot.assertDirectoryIdentity()
    await chmod(snapshot.executablePath, 0o500)
    const versionOutput = verifyPublicationBrowserExecutable(
      snapshot.executablePath,
      expectedVersion,
    )
    const executable = await lstat(snapshot.executablePath, { bigint: true })
    if (
      !executable.isFile() ||
      executable.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error(
        'Pinned publication browser executable has an invalid size or type',
      )
    const executableSha256 = await sha256File(snapshot.executablePath)
    await snapshot.assertDirectoryIdentity()
    // The mode-0700 snapshot treats same-uid/root processes as trusted. Cheap
    // inode and metadata checks bracket each render; verifyUnchanged performs
    // the bounded final digest and exact-version verification for the matrix.
    const assertUnchanged = async () => {
      await snapshot.assertDirectoryIdentity()
      const current = await lstat(snapshot.executablePath, { bigint: true })
      if (!current.isFile() || !sameStableSourceEntry(executable, current))
        throw new Error(
          'Pinned publication browser executable changed during rendering',
        )
      await snapshot.assertDirectoryIdentity()
    }
    const verifyUnchanged = async () => {
      await assertUnchanged()
      const currentSha256 = await sha256File(snapshot.executablePath)
      if (currentSha256 !== executableSha256)
        throw new Error(
          'Pinned publication browser executable changed during rendering',
        )
      verifyPublicationBrowserExecutable(
        snapshot.executablePath,
        expectedVersion,
      )
      await assertUnchanged()
    }
    return {
      executablePath: snapshot.executablePath,
      observedVersion: publicationBrowserVersion(versionOutput),
      executableSha256,
      executableByteLength: Number(executable.size),
      assertUnchanged,
      verifyUnchanged,
      cleanup: snapshot.cleanup,
    }
  } catch (error) {
    await snapshot.cleanup()
    throw error
  }
}

async function publicationPuppeteerPackageIdentity() {
  const [puppeteerBrowsersBytes, puppeteerCoreBytes, vivliostyleCliBytes] =
    await Promise.all([
      readFile(PUPPETEER_BROWSERS_PACKAGE_JSON),
      readFile(PUPPETEER_CORE_PACKAGE_JSON),
      readFile(VIVLIOSTYLE_CLI_PACKAGE_JSON),
    ])
  const puppeteerBrowsers = JSON.parse(puppeteerBrowsersBytes.toString('utf8'))
  const puppeteerCore = JSON.parse(puppeteerCoreBytes.toString('utf8'))
  const vivliostyleCli = JSON.parse(vivliostyleCliBytes.toString('utf8'))
  if (
    puppeteerBrowsers.name !== PUBLICATION_TOOLCHAIN.browser.package ||
    puppeteerBrowsers.version !== PUBLICATION_TOOLCHAIN.browser.version ||
    puppeteerCore.name !== PUBLICATION_TOOLCHAIN.browser.launcher.package ||
    puppeteerCore.version !== PUBLICATION_TOOLCHAIN.browser.launcher.version ||
    vivliostyleCli.name !== PUBLICATION_TOOLCHAIN.vivliostyleCli.package ||
    vivliostyleCli.version !== PUBLICATION_TOOLCHAIN.vivliostyleCli.version
  )
    throw new Error(
      'Loaded Puppeteer or Vivliostyle package identity does not match the publication manifest',
    )
  return {
    puppeteerBrowsersPackageJsonSha256: sha256(puppeteerBrowsersBytes),
    puppeteerCorePackageJsonSha256: sha256(puppeteerCoreBytes),
    vivliostyleCliPackageJsonSha256: sha256(vivliostyleCliBytes),
  }
}

export async function preparePublicationPuppeteerRuntime(): Promise<PreparedPublicationPuppeteerRuntime> {
  let executablePath: string
  try {
    executablePath = computeExecutablePath({
      browser: Browser.CHROME,
      buildId: PUBLICATION_TOOLCHAIN.browser.revision,
      cacheDir: PUPPETEER_BROWSER_CACHE,
    })
    await access(executablePath, fsConstants.R_OK)
  } catch {
    throw new Error(
      'Pinned Chromium is not installed in the repository-local publication browser cache. Run `npm ci` before disabling network access.',
    )
  }
  const sourceBundle =
    await publicationPuppeteerBrowserBundleForExecutable(executablePath)
  const snapshot = await preparePublicationBrowserSnapshot(
    sourceBundle,
    PUBLICATION_TOOLCHAIN.browser.browserVersion,
  )
  try {
    const packageIdentity = await publicationPuppeteerPackageIdentity()
    const publicationBrowser = publicationPuppeteerRuntimeEvidenceForPlatform({
      observedVersion: snapshot.observedVersion,
      executableSha256: snapshot.executableSha256,
      executableByteLength: snapshot.executableByteLength,
      ...packageIdentity,
    })
    const assertUnchanged = async () => {
      await snapshot.assertUnchanged()
      const currentPackages = await publicationPuppeteerPackageIdentity()
      if (
        currentPackages.puppeteerBrowsersPackageJsonSha256 !==
          publicationBrowser.puppeteerBrowsersPackageJsonSha256 ||
        currentPackages.puppeteerCorePackageJsonSha256 !==
          publicationBrowser.puppeteerCorePackageJsonSha256 ||
        currentPackages.vivliostyleCliPackageJsonSha256 !==
          publicationBrowser.vivliostyleCliPackageJsonSha256
      )
        throw new Error(
          'Pinned publication browser or package identity changed during rendering',
        )
    }
    const verifyUnchanged = async () => {
      await snapshot.verifyUnchanged()
      await assertUnchanged()
    }
    await assertUnchanged()
    return {
      executablePath: snapshot.executablePath,
      publicationBrowser,
      assertUnchanged,
      verifyUnchanged,
      cleanup: snapshot.cleanup,
    }
  } catch (error) {
    await snapshot.cleanup()
    throw error
  }
}

async function publicationPlaywrightPackageIdentity() {
  const paths = publicationPlaywrightPackageIdentityPaths()
  const [playwrightBytes, playwrightCoreBytes, browsersBytes] =
    await Promise.all([
      readFile(paths.playwrightPackageJson),
      readFile(paths.playwrightCorePackageJson),
      readFile(paths.browsersJson),
    ])
  const playwright = JSON.parse(playwrightBytes.toString('utf8'))
  const playwrightCore = JSON.parse(playwrightCoreBytes.toString('utf8'))
  const browsers = JSON.parse(browsersBytes.toString('utf8'))
  if (
    playwright.name !== 'playwright' ||
    playwright.version !==
      PUBLICATION_TOOLCHAIN.browser.compatibility.version ||
    playwrightCore.name !== 'playwright-core' ||
    playwrightCore.version !==
      PUBLICATION_TOOLCHAIN.browser.compatibility.version ||
    !browsers.browsers?.some(
      (browser: { name?: unknown; revision?: unknown }) =>
        browser.name === 'chromium' &&
        browser.revision ===
          publicationPlaywrightCompatibilityForPlatform().browserRevision,
    )
  )
    throw new Error(
      'Loaded Playwright package identity does not match the publication manifest',
    )
  return {
    playwrightPackageJsonSha256: sha256(playwrightBytes),
    playwrightCorePackageJsonSha256: sha256(playwrightCoreBytes),
    browsersJsonSha256: sha256(browsersBytes),
  }
}

export async function preparePublicationPlaywrightRuntime(): Promise<PreparedPublicationPlaywrightRuntime> {
  const compatibility = publicationPlaywrightCompatibilityForPlatform()
  const executablePath = await firstAccessiblePath(
    publicationPlaywrightExecutableCandidates(compatibility.browserRevision),
  )
  if (!executablePath)
    throw new Error(
      'Pinned Playwright Chromium is not installed in the repository-local publication browser cache. Run `npm ci` before disabling network access.',
    )
  const sourceBundle =
    await publicationBrowserBundleForExecutable(executablePath)
  const snapshot = await snapshotPublicationBrowserBundle(sourceBundle)
  try {
    await snapshot.assertDirectoryIdentity()
    const versionOutput = verifyPublicationBrowserExecutable(
      snapshot.executablePath,
      compatibility.expectedVersion,
    )
    const executable = await lstat(snapshot.executablePath, { bigint: true })
    if (
      !executable.isFile() ||
      executable.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error(
        'Pinned publication browser executable has an invalid size or type',
      )
    const [executableSha256, packageIdentity] = await Promise.all([
      sha256File(snapshot.executablePath),
      publicationPlaywrightPackageIdentity(),
    ])
    const publicationBrowser = publicationPlaywrightRuntimeEvidenceForPlatform({
      observedVersion: publicationBrowserVersion(versionOutput),
      executableSha256,
      executableByteLength: Number(executable.size),
      ...packageIdentity,
    })
    await snapshot.assertDirectoryIdentity()
    const assertUnchanged = async () => {
      await snapshot.assertDirectoryIdentity()
      const [current, currentPackages] = await Promise.all([
        lstat(snapshot.executablePath, { bigint: true }),
        publicationPlaywrightPackageIdentity(),
      ])
      if (
        !current.isFile() ||
        !sameStableSourceEntry(executable, current) ||
        currentPackages.playwrightPackageJsonSha256 !==
          publicationBrowser.playwrightPackageJsonSha256 ||
        currentPackages.playwrightCorePackageJsonSha256 !==
          publicationBrowser.playwrightCorePackageJsonSha256 ||
        currentPackages.browsersJsonSha256 !==
          publicationBrowser.browsersJsonSha256
      )
        throw new Error(
          'Pinned publication browser or package identity changed during rendering',
        )
      await snapshot.assertDirectoryIdentity()
    }
    const verifyUnchanged = async () => {
      await assertUnchanged()
      const currentSha256 = await sha256File(snapshot.executablePath)
      if (currentSha256 !== publicationBrowser.executableSha256)
        throw new Error(
          'Pinned publication browser or package identity changed during rendering',
        )
      verifyPublicationBrowserExecutable(
        snapshot.executablePath,
        publicationBrowser.expectedVersion,
      )
      await assertUnchanged()
    }
    return {
      executablePath: snapshot.executablePath,
      publicationBrowser,
      assertUnchanged,
      verifyUnchanged,
      cleanup: snapshot.cleanup,
    }
  } catch (error) {
    await snapshot.cleanup()
    throw error
  }
}

export async function publicationPlaywrightRuntimeEvidenceForCurrentPlatform() {
  const prepared = await preparePublicationPlaywrightRuntime()
  try {
    await prepared.verifyUnchanged()
    return prepared.publicationBrowser
  } finally {
    await prepared.cleanup()
  }
}

export async function publicationPuppeteerRuntimeEvidenceForCurrentPlatform() {
  const prepared = await preparePublicationPuppeteerRuntime()
  try {
    await prepared.verifyUnchanged()
    return prepared.publicationBrowser
  } finally {
    await prepared.cleanup()
  }
}

export async function publicationBrowserRuntimeEvidenceForCurrentPlatform(): Promise<PublicationBrowserRuntimeEvidence> {
  return publicationPdfRendererForRuntime() === 'playwright-chromium'
    ? publicationPlaywrightRuntimeEvidenceForCurrentPlatform()
    : publicationPuppeteerRuntimeEvidenceForCurrentPlatform()
}
