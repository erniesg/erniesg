import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import manifest from './toolchain-manifest.json'

const require = createRequire(import.meta.url)

export const PUBLICATION_TOOLCHAIN = manifest

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
