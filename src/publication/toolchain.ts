import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import manifest from './toolchain-manifest.json'

const require = createRequire(import.meta.url)

export const PUBLICATION_TOOLCHAIN = manifest

export type PublicationPdfRenderer = 'vivliostyle-cli' | 'playwright-chromium'

export type PublicationPlatformKey =
  | 'linux-x64'
  | 'linux-arm64'
  | 'mac-x64'
  | 'mac-arm64'
  | 'win-x64'
  | 'win-arm64'

export type PublicationPlaywrightRuntimeEvidence = {
  platformKey: PublicationPlatformKey
  packageName: string
  packageVersion: string
  browserRevision: string
  expectedVersion: string
  observedVersion: string
  executableSha256: string
  executableByteLength: number
  playwrightPackageJsonSha256: string
  playwrightCorePackageJsonSha256: string
  browsersJsonSha256: string
}

type PublicationPlaywrightObservedIdentity = Pick<
  PublicationPlaywrightRuntimeEvidence,
  | 'observedVersion'
  | 'executableSha256'
  | 'executableByteLength'
  | 'playwrightPackageJsonSha256'
  | 'playwrightCorePackageJsonSha256'
  | 'browsersJsonSha256'
>

const EXACT_BROWSER_VERSION = /^\d+\.\d+\.\d+\.\d+$/u
const SHA256 = /^[a-f0-9]{64}$/u

export function publicationPlatformKey(
  platform: string = process.platform,
  architecture: string = process.arch,
): PublicationPlatformKey {
  if (architecture !== 'x64' && architecture !== 'arm64')
    throw new Error(`Unsupported publication architecture: ${architecture}`)
  const operatingSystem =
    platform === 'linux'
      ? 'linux'
      : platform === 'darwin'
        ? 'mac'
        : platform === 'win32'
          ? 'win'
          : null
  if (!operatingSystem)
    throw new Error(`Unsupported publication operating system: ${platform}`)
  return `${operatingSystem}-${architecture}` as PublicationPlatformKey
}

export function publicationPlaywrightCompatibilityForPlatform(
  platform: string = process.platform,
  architecture: string = process.arch,
) {
  const platformKey = publicationPlatformKey(platform, architecture)
  const platforms = manifest.browser.compatibility.platforms as Record<
    string,
    { revision?: unknown; expectedVersion?: unknown } | undefined
  >
  const selected = platforms[platformKey]
  if (!selected)
    throw new Error(
      `There is no reviewed Playwright Chromium compatibility entry for ${platformKey}`,
    )
  if (
    typeof selected.revision !== 'string' ||
    !/^\d+$/u.test(selected.revision) ||
    typeof selected.expectedVersion !== 'string' ||
    !EXACT_BROWSER_VERSION.test(selected.expectedVersion)
  )
    throw new Error(
      `Playwright Chromium compatibility entry for ${platformKey} is invalid`,
    )
  return {
    platformKey,
    packageName: manifest.browser.compatibility.package,
    packageVersion: manifest.browser.compatibility.version,
    browserRevision: selected.revision,
    expectedVersion: selected.expectedVersion,
  }
}

export function publicationPlaywrightRuntimeEvidenceForPlatform(
  identity: PublicationPlaywrightObservedIdentity,
  platform: string = process.platform,
  architecture: string = process.arch,
): PublicationPlaywrightRuntimeEvidence {
  const compatibility = publicationPlaywrightCompatibilityForPlatform(
    platform,
    architecture,
  )
  if (
    !EXACT_BROWSER_VERSION.test(identity.observedVersion) ||
    identity.observedVersion !== compatibility.expectedVersion
  )
    throw new Error(
      `Observed Playwright Chromium ${identity.observedVersion || '(missing)'} does not match expected ${compatibility.expectedVersion} for ${compatibility.platformKey}`,
    )
  for (const [name, value] of [
    ['executableSha256', identity.executableSha256],
    ['playwrightPackageJsonSha256', identity.playwrightPackageJsonSha256],
    [
      'playwrightCorePackageJsonSha256',
      identity.playwrightCorePackageJsonSha256,
    ],
    ['browsersJsonSha256', identity.browsersJsonSha256],
  ] as const)
    if (!SHA256.test(value))
      throw new Error(`Playwright Chromium ${name} is not a SHA-256 digest`)
  if (
    !Number.isSafeInteger(identity.executableByteLength) ||
    identity.executableByteLength <= 0
  )
    throw new Error(
      'Playwright Chromium executableByteLength must be a positive safe integer',
    )
  return {
    ...compatibility,
    observedVersion: identity.observedVersion,
    executableSha256: identity.executableSha256,
    executableByteLength: identity.executableByteLength,
    playwrightPackageJsonSha256: identity.playwrightPackageJsonSha256,
    playwrightCorePackageJsonSha256: identity.playwrightCorePackageJsonSha256,
    browsersJsonSha256: identity.browsersJsonSha256,
  }
}

export function publicationPdfRendererForRuntime(
  platform: string = process.platform,
  architecture: string = process.arch,
): PublicationPdfRenderer {
  publicationPlatformKey(platform, architecture)
  const key = architecture as 'x64' | 'arm64'
  const renderer = manifest.rendererPolicy[key].pdf
  if (renderer !== 'vivliostyle-cli' && renderer !== 'playwright-chromium')
    throw new Error(
      `Unsupported PDF renderer policy for ${architecture}: ${String(renderer)}`,
    )
  if (renderer === 'playwright-chromium')
    publicationPlaywrightCompatibilityForPlatform(platform, architecture)
  return renderer
}

export function publicationToolchainForRuntime(
  publicationBrowser: PublicationPlaywrightRuntimeEvidence | null = null,
  platform: string = process.platform,
  architecture: string = process.arch,
) {
  const node = process.versions.node
  if (!/^\d+\.\d+\.\d+$/.test(node))
    throw new Error(`Node runtime ${node} is not normalized`)
  const platformKey = publicationPlatformKey(platform, architecture)
  const pdfRenderer = publicationPdfRendererForRuntime(platform, architecture)
  if (pdfRenderer === 'vivliostyle-cli' && publicationBrowser !== null)
    throw new Error(
      `Publication browser evidence is invalid for ${pdfRenderer} on ${platformKey}`,
    )
  if (pdfRenderer === 'playwright-chromium' && publicationBrowser === null)
    throw new Error(
      `Publication browser evidence is required for ${pdfRenderer} on ${platformKey}`,
    )
  if (publicationBrowser !== null) {
    const normalized = publicationPlaywrightRuntimeEvidenceForPlatform(
      publicationBrowser,
      platform,
      architecture,
    )
    const keys = Object.keys(normalized) as Array<keyof typeof normalized>
    if (
      Object.keys(publicationBrowser).length !== keys.length ||
      keys.some((key) => publicationBrowser[key] !== normalized[key])
    )
      throw new Error(
        `Publication browser evidence does not match ${platformKey}`,
      )
  }
  return {
    ...PUBLICATION_TOOLCHAIN,
    node,
    runtime: { node, platformKey, pdfRenderer, publicationBrowser },
  }
}

export function publicationPdfRendererForArchitecture(
  architecture: string = process.arch,
): PublicationPdfRenderer {
  return publicationPdfRendererForRuntime(process.platform, architecture)
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function packageVersion(name: string) {
  return (require(`${name}/package.json`) as { version: string }).version
}

export async function verifyPublicationToolchain(
  repositoryRoot = process.cwd(),
) {
  const errors: string[] = []
  const minimumNode = manifest.node.match(/^(?:>=)?(\d+)\.(\d+)\.(\d+)$/)
  const runtimeNode = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!minimumNode || !runtimeNode) {
    errors.push(`Node runtime ${process.versions.node} is not normalized`)
  } else {
    const minimum = minimumNode.slice(1).map(Number)
    const runtime = runtimeNode.slice(1).map(Number)
    if (
      runtime[0] < minimum[0] ||
      (runtime[0] === minimum[0] && runtime[1] < minimum[1]) ||
      (runtime[0] === minimum[0] &&
        runtime[1] === minimum[1] &&
        runtime[2] < minimum[2])
    )
      errors.push(
        `Node runtime ${process.versions.node} is below ${manifest.node}`,
      )
  }
  if (manifest.rendererPolicy.x64.pdf !== 'vivliostyle-cli')
    errors.push('x64 renderer policy must select vivliostyle-cli')
  if (manifest.rendererPolicy.arm64.pdf !== 'playwright-chromium')
    errors.push('arm64 renderer policy must select playwright-chromium')
  const compatibilityPlatforms = Object.keys(
    manifest.browser.compatibility.platforms,
  ).sort()
  if (
    JSON.stringify(compatibilityPlatforms) !==
    JSON.stringify(['linux-arm64', 'mac-arm64'])
  )
    errors.push(
      'Playwright compatibility platforms must be exactly linux-arm64 and mac-arm64',
    )
  for (const [platform, architecture] of [
    ['linux', 'arm64'],
    ['darwin', 'arm64'],
  ] as const) {
    try {
      publicationPlaywrightCompatibilityForPlatform(platform, architecture)
    } catch (error) {
      errors.push(String(error))
    }
  }
  const exactPackages = [
    manifest.vivliostyleCli,
    { package: manifest.browser.package, version: manifest.browser.version },
    {
      package: manifest.browser.compatibility.package,
      version: manifest.browser.compatibility.version,
    },
    {
      package: manifest.epubcheck.package,
      version: manifest.epubcheck.packageVersion,
    },
  ]
  for (const expected of exactPackages) {
    try {
      const actual = packageVersion(expected.package)
      if (actual !== expected.version)
        errors.push(
          `${expected.package} is ${actual}; expected ${expected.version}`,
        )
    } catch {
      errors.push(`${expected.package} is not installed`)
    }
  }
  for (const font of manifest.fonts) {
    try {
      const actual = sha256(await readFile(resolve(repositoryRoot, font.path)))
      if (actual !== font.sha256)
        errors.push(`${font.path} checksum does not match the manifest`)
    } catch {
      errors.push(`${font.path} is missing`)
    }
  }
  try {
    const epubcheck = await import('epubcheck-static')
    const actual = sha256(await readFile(epubcheck.path))
    if (actual !== manifest.epubcheck.sha256)
      errors.push('EPUBCheck checksum does not match the manifest')
  } catch {
    errors.push('EPUBCheck release artifact is unavailable')
  }
  if (errors.length)
    throw new Error(
      `Publication toolchain validation failed:\n${errors.join('\n')}`,
    )
  return manifest
}
