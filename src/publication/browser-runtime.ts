import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
const PUPPETEER_BROWSERS_PACKAGE_JSON = require.resolve(
  '@puppeteer/browsers/package.json',
)
const PUPPETEER_CORE_PACKAGE_JSON = require.resolve(
  'puppeteer-core/package.json',
)
const VIVLIOSTYLE_CLI_PACKAGE_JSON = require.resolve(
  '@vivliostyle/cli/package.json',
)

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
export const PUBLICATION_BROWSER_SNAPSHOT_ROOT = resolve(
  tmpdir(),
  `erniesg-publication-browser-snapshots-${process.getuid?.() ?? 'user'}`,
)
// Snapshot isolation protects against ordinary concurrent installer/cache
// replacement and untrusted child symlinks. The private tree is mode 0700;
// processes with the same uid (and root) remain inside the trusted VM boundary.

export type PreparedPublicationPlaywrightRuntime = {
  executablePath: string
  publicationBrowser: PublicationPlaywrightRuntimeEvidence
  assertUnchanged: () => Promise<void>
  cleanup: () => Promise<void>
}

export type PreparedPublicationPuppeteerRuntime = {
  executablePath: string
  publicationBrowser: PublicationPuppeteerRuntimeEvidence
  assertUnchanged: () => Promise<void>
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
): Promise<void> {
  const entry = await lstat(path, { bigint: true })
  if (!sameFileIdentity(entry, expectedEntry))
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after an entry identity changed',
    )
  if (!entry.isDirectory()) {
    await unlink(path)
    return
  }
  const entries = (await readdir(path)).sort((left, right) =>
    left.localeCompare(right),
  )
  for (const entryName of entries) {
    const entryPath = resolve(path, entryName)
    const childEntry = await lstat(entryPath, { bigint: true })
    await removePublicationBrowserTree(entryPath, childEntry)
  }
  const confirmedEntry = await lstat(path, { bigint: true })
  if (!confirmedEntry.isDirectory() || !sameFileIdentity(entry, confirmedEntry))
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after an entry identity changed',
    )
  await rmdir(path)
}

async function assertPublicationBrowserSnapshotIdentity(
  canonicalRoot: string,
  rootEntry: FileIdentity,
  privateRoot: string,
  privateEntry: FileIdentity,
) {
  const [currentRoot, currentPrivate] = await Promise.all([
    lstat(canonicalRoot, { bigint: true }),
    lstat(privateRoot, { bigint: true }),
  ])
  const [currentCanonicalRoot, canonicalPrivate] = await Promise.all([
    realpath(canonicalRoot),
    realpath(privateRoot),
  ])
  const [confirmedRoot, confirmedPrivate] = await Promise.all([
    lstat(canonicalRoot, { bigint: true }),
    lstat(privateRoot, { bigint: true }),
  ])
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
    canonicalPrivate !== privateRoot ||
    dirname(privateRoot) !== canonicalRoot
  )
    throw new Error(
      'Pinned publication browser snapshot directory identity changed',
    )
}

async function cleanupPublicationBrowserSnapshot(
  canonicalRoot: string,
  rootEntry: FileIdentity,
  privateRoot: string,
  privateEntry: FileIdentity,
) {
  try {
    await assertPublicationBrowserSnapshotIdentity(
      canonicalRoot,
      rootEntry,
      privateRoot,
      privateEntry,
    )
  } catch {
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after its directory identity changed',
    )
  }
  // The private tree is mode 0700 and processes with the same uid are trusted.
  // Refuse identity changes and remove entries one at a time without following
  // symlinks; never hand a mutable pathname to recursive deletion.
  await removePublicationBrowserTree(privateRoot, privateEntry)
}

export async function snapshotPublicationBrowserBundle(
  bundle: PublicationBrowserBundle,
  snapshotRoot = PUBLICATION_BROWSER_SNAPSHOT_ROOT,
) {
  const { bundleEntry, canonicalBundle, canonicalRoot, rootEntry } =
    await publicationBrowserSnapshotRoot(snapshotRoot, bundle.bundleRoot)
  const privateRoot = await mkdtemp(resolve(canonicalRoot, 'browser-'))
  const snapshotBundleRoot = resolve(privateRoot, basename(canonicalBundle))
  const privateEntry = await lstat(privateRoot, { bigint: true })
  if (
    !privateEntry.isDirectory() ||
    (privateEntry.mode & 0o077n) !== 0n
  )
    throw new Error(
      'Pinned publication browser private snapshot directory is unsafe',
    )
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () =>
    (cleanupPromise ??= cleanupPublicationBrowserSnapshot(
      canonicalRoot,
      rootEntry,
      privateRoot,
      privateEntry,
    ))
  const assertDirectoryIdentity = () =>
    assertPublicationBrowserSnapshotIdentity(
      canonicalRoot,
      rootEntry,
      privateRoot,
      privateEntry,
    )
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
    const executable = await stat(snapshot.executablePath)
    const executableSha256 = await sha256File(snapshot.executablePath)
    await snapshot.assertDirectoryIdentity()
    const assertUnchanged = async () => {
      await snapshot.assertDirectoryIdentity()
      const current = await stat(snapshot.executablePath)
      const currentSha256 = await sha256File(snapshot.executablePath)
      if (
        current.size !== executable.size ||
        currentSha256 !== executableSha256
      )
        throw new Error(
          'Pinned publication browser executable changed during rendering',
        )
      verifyPublicationBrowserExecutable(
        snapshot.executablePath,
        expectedVersion,
      )
      await snapshot.assertDirectoryIdentity()
    }
    return {
      executablePath: snapshot.executablePath,
      observedVersion: publicationBrowserVersion(versionOutput),
      executableSha256,
      executableByteLength: executable.size,
      assertUnchanged,
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
    await assertUnchanged()
    return {
      executablePath: snapshot.executablePath,
      publicationBrowser,
      assertUnchanged,
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
    const executable = await stat(snapshot.executablePath)
    const [executableSha256, packageIdentity] = await Promise.all([
      sha256File(snapshot.executablePath),
      publicationPlaywrightPackageIdentity(),
    ])
    const publicationBrowser = publicationPlaywrightRuntimeEvidenceForPlatform({
      observedVersion: publicationBrowserVersion(versionOutput),
      executableSha256,
      executableByteLength: executable.size,
      ...packageIdentity,
    })
    await snapshot.assertDirectoryIdentity()
    const assertUnchanged = async () => {
      await snapshot.assertDirectoryIdentity()
      const current = await stat(snapshot.executablePath)
      const [currentSha256, currentPackages] = await Promise.all([
        sha256File(snapshot.executablePath),
        publicationPlaywrightPackageIdentity(),
      ])
      if (
        current.size !== publicationBrowser.executableByteLength ||
        currentSha256 !== publicationBrowser.executableSha256 ||
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
      verifyPublicationBrowserExecutable(
        snapshot.executablePath,
        publicationBrowser.expectedVersion,
      )
      await snapshot.assertDirectoryIdentity()
    }
    return {
      executablePath: snapshot.executablePath,
      publicationBrowser,
      assertUnchanged,
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
    await prepared.assertUnchanged()
    return prepared.publicationBrowser
  } finally {
    await prepared.cleanup()
  }
}

export async function publicationPuppeteerRuntimeEvidenceForCurrentPlatform() {
  const prepared = await preparePublicationPuppeteerRuntime()
  try {
    await prepared.assertUnchanged()
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
