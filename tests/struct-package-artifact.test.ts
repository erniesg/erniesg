import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const provenance = readJson('vendor/struct/provenance.json')
const artifactPath = `vendor/struct/${provenance.artifact}`
const bytes = readFileSync(new URL(artifactPath, root))

// npm tarballs use a POSIX tar container. Read headers without executing or
// extracting archive paths; padding is rounded to whole 512-byte blocks.
function packageManifest() {
  const archive = gunzipSync(bytes)
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString().replace(/\0.*$/su, '')
    const size = Number.parseInt(
      header.subarray(124, 136).toString().replace(/\0.*$/su, '').trim(),
      8,
    )
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > archive.length
    ) {
      throw new Error('Invalid packed Struct tar header')
    }
    if (name === 'package/package.json') {
      return JSON.parse(
        archive.subarray(offset + 512, offset + 512 + size).toString(),
      )
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Packed Struct package manifest is missing')
}

describe('exact standalone Struct artifact', () => {
  it('pins immutable repository provenance and tarball bytes', () => {
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      packageName: '@erniesg/struct',
      packageVersion: '0.0.0',
      state: 'implemented-unreleased',
      sourceRepository: 'https://github.com/erniesg/struct',
    })
    expect(provenance.sourceCommit).toMatch(/^[a-f0-9]{40}$/u)
    expect(provenance.sourceLockfileSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(provenance.artifact).toBe(
      `erniesg-struct-${provenance.packageVersion}-${provenance.sourceCommit}.tgz`,
    )
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      provenance.sha256,
    )
    expect(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    ).toBe(provenance.integrity)
  })

  it('uses the same exact artifact in the dependency and lockfile', () => {
    const specifier = `file:${artifactPath}`
    const packageJson = readJson('package.json')
    const lock = readJson('package-lock.json')
    expect(packageJson.dependencies['@erniesg/struct']).toBe(specifier)
    expect(lock.packages[''].dependencies['@erniesg/struct']).toBe(specifier)
    expect(lock.packages['node_modules/@erniesg/struct']).toMatchObject({
      version: provenance.packageVersion,
      resolved: specifier,
      integrity: provenance.integrity,
    })
  })

  it('installs the declared public surface without a sibling repository', () => {
    const packed = packageManifest()
    expect(packed.name).toBe(provenance.packageName)
    expect(packed.version).toBe(provenance.packageVersion)
    expect(Object.keys(packed.exports)).toEqual([
      '.',
      './document',
      './identity',
      './ordering',
      './receipt',
      './recovery',
      './renderers/xhtml',
      './renderers/epub',
    ])
    const installedManifest = readJson(
      'node_modules/@erniesg/struct/package.json',
    )
    expect(installedManifest).toEqual(packed)
    const installedPath = fileURLToPath(
      new URL('node_modules/@erniesg/struct/', root),
    )
    // Compared by segment, so a Windows path (backslashes) passes too.
    expect(installedPath.split(/[\\/]/u).filter(Boolean).slice(-3)).toEqual([
      'node_modules',
      '@erniesg',
      'struct',
    ])
  })
})
