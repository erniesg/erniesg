import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PUBLICATION_TOOLCHAIN,
  publicationPdfRendererForRuntime,
  publicationPlatformKey,
  publicationPlaywrightCompatibilityForPlatform,
  publicationPlaywrightRuntimeEvidenceForPlatform,
  publicationToolchainForRuntime,
  publicationPdfRendererForArchitecture,
  verifyPublicationToolchain,
} from './toolchain'

const identity = {
  executableSha256: 'a'.repeat(64),
  executableByteLength: 123,
  playwrightPackageJsonSha256: 'b'.repeat(64),
  playwrightCorePackageJsonSha256: 'c'.repeat(64),
  browsersJsonSha256: 'd'.repeat(64),
}

describe('publication toolchain manifest', () => {
  it('pins and verifies the renderer, browser, EPUBCheck artifact, and fonts', async () => {
    await expect(verifyPublicationToolchain()).resolves.toBe(
      PUBLICATION_TOOLCHAIN,
    )
    expect(PUBLICATION_TOOLCHAIN).toMatchObject({
      vivliostyleCli: { version: '11.1.0' },
      browser: {
        revision: '150.0.7871.115',
        browserVersion: '150.0.7871.115',
        compatibility: {
          platforms: {
            'linux-arm64': {
              revision: '1228',
              expectedVersion: '149.0.7827.0',
            },
            'mac-arm64': {
              revision: '1228',
              expectedVersion: '149.0.7827.55',
            },
          },
        },
      },
      rendererPolicy: {
        x64: { pdf: 'vivliostyle-cli' },
        arm64: { pdf: 'playwright-chromium' },
      },
      epubcheck: { version: '5.3.0' },
      fonts: expect.arrayContaining([
        expect.objectContaining({
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    })
    expect(publicationPdfRendererForArchitecture('x64')).toBe('vivliostyle-cli')
    expect(publicationPdfRendererForArchitecture('arm64')).toBe(
      'playwright-chromium',
    )
    expect(
      publicationToolchainForRuntime(null, process.platform, 'x64').node,
    ).toBe(process.versions.node)
    expect(
      publicationToolchainForRuntime(null, process.platform, 'x64').runtime
        .node,
    ).toBe(process.versions.node)
  })

  it('selects reviewed Playwright identities by OS and architecture', () => {
    expect(publicationPlatformKey('linux', 'arm64')).toBe('linux-arm64')
    expect(publicationPlatformKey('darwin', 'arm64')).toBe('mac-arm64')
    expect(
      publicationPlaywrightCompatibilityForPlatform('linux', 'arm64'),
    ).toMatchObject({
      platformKey: 'linux-arm64',
      browserRevision: '1228',
      expectedVersion: '149.0.7827.0',
    })
    expect(
      publicationPlaywrightCompatibilityForPlatform('darwin', 'arm64'),
    ).toMatchObject({
      platformKey: 'mac-arm64',
      browserRevision: '1228',
      expectedVersion: '149.0.7827.55',
    })
  })

  it('accepts each observed ARM64 browser only under its own platform contract', () => {
    const linuxEvidence = publicationPlaywrightRuntimeEvidenceForPlatform(
      { ...identity, observedVersion: '149.0.7827.0' },
      'linux',
      'arm64',
    )
    expect(linuxEvidence).toMatchObject({
      platformKey: 'linux-arm64',
      expectedVersion: '149.0.7827.0',
      observedVersion: '149.0.7827.0',
    })
    expect(
      publicationToolchainForRuntime(linuxEvidence, 'linux', 'arm64').runtime
        .publicationBrowser,
    ).toEqual(linuxEvidence)
    expect(() =>
      publicationToolchainForRuntime(
        { ...linuxEvidence, expectedVersion: '149.0.7827.55' },
        'linux',
        'arm64',
      ),
    ).toThrow(/does not match linux-arm64/)
    expect(() =>
      publicationPlaywrightRuntimeEvidenceForPlatform(
        { ...identity, observedVersion: '149.0.7827.55' },
        'linux',
        'arm64',
      ),
    ).toThrow(/149\.0\.7827\.55.*149\.0\.7827\.0/)
    expect(
      publicationPlaywrightRuntimeEvidenceForPlatform(
        { ...identity, observedVersion: '149.0.7827.55' },
        'darwin',
        'arm64',
      ),
    ).toMatchObject({
      platformKey: 'mac-arm64',
      expectedVersion: '149.0.7827.55',
      observedVersion: '149.0.7827.55',
    })
    expect(() =>
      publicationPlaywrightRuntimeEvidenceForPlatform(
        { ...identity, observedVersion: '149.0.7827.0' },
        'darwin',
        'arm64',
      ),
    ).toThrow(/149\.0\.7827\.0.*149\.0\.7827\.55/)
  })

  it('fails closed for unsupported runtime and Playwright platform keys', () => {
    expect(() => publicationPlatformKey('linux', 'riscv64')).toThrow(
      /Unsupported publication architecture/,
    )
    expect(() =>
      publicationPlaywrightCompatibilityForPlatform('win32', 'arm64'),
    ).toThrow(/no reviewed Playwright Chromium compatibility/i)
    expect(() => publicationPdfRendererForRuntime('win32', 'arm64')).toThrow(
      /no reviewed Playwright Chromium compatibility/i,
    )
    expect(() =>
      publicationToolchainForRuntime(null, 'linux', 'arm64'),
    ).toThrow(/browser evidence is required/)
    expect(() =>
      publicationToolchainForRuntime(
        publicationPlaywrightRuntimeEvidenceForPlatform(
          { ...identity, observedVersion: '149.0.7827.0' },
          'linux',
          'arm64',
        ),
        'linux',
        'x64',
      ),
    ).toThrow(/invalid for vivliostyle-cli/)
  })

  it('fails closed when repository toolchain assets are missing or mismatched', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-toolchain-'))
    await mkdir(resolve(root, 'public/fonts'), { recursive: true })
    await expect(verifyPublicationToolchain(root)).rejects.toThrow(
      /Geist-Regular\.ttf is missing|checksum does not match/,
    )
  })
})
