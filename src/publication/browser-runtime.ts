import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import {
  PUBLICATION_TOOLCHAIN,
  publicationPlatformKey,
  publicationPlaywrightCompatibilityForPlatform,
  publicationPlaywrightRuntimeEvidenceForPlatform,
  type PublicationPlaywrightRuntimeEvidence,
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

export type PreparedPublicationPlaywrightRuntime = {
  executablePath: string
  publicationBrowser: PublicationPlaywrightRuntimeEvidence
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

async function copyRegularTree(
  source: string,
  destination: string,
  sourceBundleRoot: string,
) {
  const sourceEntry = await lstat(source)
  if (sourceEntry.isSymbolicLink()) {
    const target = await readlink(source)
    const resolvedTarget = resolve(dirname(source), target)
    if (
      target.startsWith(sep) ||
      !pathIsWithin(sourceBundleRoot, resolvedTarget)
    )
      throw new Error(
        'Pinned publication browser cache bundle contains an escaping symlink',
      )
    await symlink(target, destination)
    return
  }
  if (sourceEntry.isDirectory()) {
    await mkdir(destination, { mode: 0o700 })
    const entries = (await readdir(source, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    )
    for (const entry of entries)
      await copyRegularTree(
        resolve(source, entry.name),
        resolve(destination, entry.name),
        sourceBundleRoot,
      )
    return
  }
  if (!sourceEntry.isFile())
    throw new Error(
      'Pinned publication browser cache bundles may contain only regular files and directories',
    )
  await copyFile(
    source,
    destination,
    fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
  )
  await chmod(destination, sourceEntry.mode & 0o555)
}

async function publicationBrowserSnapshotRoot(
  snapshotRoot: string,
  bundleRoot: string,
) {
  const requestedRoot = resolve(snapshotRoot)
  const canonicalParent = await realpath(dirname(requestedRoot))
  const expectedRoot = resolve(canonicalParent, basename(requestedRoot))
  const canonicalBundle = await realpath(bundleRoot)
  const bundleEntry = await lstat(canonicalBundle)
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
    rootEntry = await lstat(requestedRoot)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    try {
      await mkdir(requestedRoot, { mode: 0o700 })
    } catch (mkdirError) {
      if ((mkdirError as { code?: string }).code !== 'EEXIST') throw mkdirError
    }
    rootEntry = await lstat(requestedRoot)
  }
  if (
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    (rootEntry.mode & 0o022) !== 0
  )
    throw new Error(
      'Pinned publication browser snapshot root is a symlink, unsafe, or not a directory',
    )
  const canonicalRoot = await realpath(requestedRoot)
  const confirmedRoot = await lstat(requestedRoot)
  if (
    canonicalRoot !== expectedRoot ||
    confirmedRoot.dev !== rootEntry.dev ||
    confirmedRoot.ino !== rootEntry.ino
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

async function cleanupPublicationBrowserSnapshot(
  canonicalRoot: string,
  rootEntry: { dev: number; ino: number },
  privateRoot: string,
  privateEntry: { dev: number; ino: number },
) {
  let currentRoot
  let currentPrivate
  let currentCanonicalRoot
  let currentCanonicalPrivate
  try {
    ;[currentRoot, currentPrivate, currentCanonicalRoot, currentCanonicalPrivate] =
      await Promise.all([
        lstat(canonicalRoot),
        lstat(privateRoot),
        realpath(canonicalRoot),
        realpath(privateRoot),
      ])
  } catch {
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after its directory identity changed',
    )
  }
  if (
    !currentRoot.isDirectory() ||
    currentRoot.dev !== rootEntry.dev ||
    currentRoot.ino !== rootEntry.ino ||
    currentCanonicalRoot !== canonicalRoot ||
    !currentPrivate.isDirectory() ||
    currentPrivate.dev !== privateEntry.dev ||
    currentPrivate.ino !== privateEntry.ino ||
    currentCanonicalPrivate !== privateRoot ||
    dirname(privateRoot) !== canonicalRoot
  )
    throw new Error(
      'Pinned publication browser snapshot cleanup refused after its directory identity changed',
    )
  await rm(privateRoot, { recursive: true, force: true })
}

export async function snapshotPublicationBrowserBundle(
  bundle: PublicationBrowserBundle,
  snapshotRoot = resolve(PLAYWRIGHT_BROWSER_CACHE, '.snapshots'),
) {
  const { bundleEntry, canonicalBundle, canonicalRoot, rootEntry } =
    await publicationBrowserSnapshotRoot(snapshotRoot, bundle.bundleRoot)
  const privateRoot = await mkdtemp(resolve(canonicalRoot, 'browser-'))
  const snapshotBundleRoot = resolve(privateRoot, basename(canonicalBundle))
  const privateEntry = await lstat(privateRoot)
  const cleanup = () =>
    cleanupPublicationBrowserSnapshot(
      canonicalRoot,
      rootEntry,
      privateRoot,
      privateEntry,
    )
  try {
    const [confirmedBundle, confirmedRoot, canonicalPrivateRoot] =
      await Promise.all([
        lstat(canonicalBundle),
        lstat(canonicalRoot),
        realpath(privateRoot),
      ])
    if (
      !confirmedBundle.isDirectory() ||
      confirmedBundle.dev !== bundleEntry.dev ||
      confirmedBundle.ino !== bundleEntry.ino ||
      !confirmedRoot.isDirectory() ||
      confirmedRoot.dev !== rootEntry.dev ||
      confirmedRoot.ino !== rootEntry.ino ||
      !privateEntry.isDirectory() ||
      !pathIsWithin(canonicalRoot, canonicalPrivateRoot) ||
      canonicalPrivateRoot === canonicalBundle ||
      pathIsWithin(canonicalBundle, canonicalPrivateRoot) ||
      pathIsWithin(canonicalPrivateRoot, canonicalBundle)
    )
      throw new Error(
        'Pinned publication browser snapshot directory overlaps or escapes its private root',
      )
    await copyRegularTree(
      canonicalBundle,
      snapshotBundleRoot,
      canonicalBundle,
    )
    const copiedBundle = await lstat(canonicalBundle)
    if (
      !copiedBundle.isDirectory() ||
      copiedBundle.dev !== bundleEntry.dev ||
      copiedBundle.ino !== bundleEntry.ino
    )
      throw new Error(
        'Pinned publication browser source bundle changed during snapshot creation',
      )
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
    await chmod(snapshot.executablePath, 0o500)
    verifyPublicationBrowserExecutable(snapshot.executablePath, expectedVersion)
    const executable = await stat(snapshot.executablePath)
    const executableSha256 = await sha256File(snapshot.executablePath)
    const assertUnchanged = async () => {
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
    }
    return {
      executablePath: snapshot.executablePath,
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
    const assertUnchanged = async () => {
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
