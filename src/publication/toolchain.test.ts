import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PUBLICATION_TOOLCHAIN,
  publicationToolchainForRuntime,
  publicationPdfRendererForArchitecture,
  verifyPublicationToolchain,
} from './toolchain'

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
        compatibility: { arm64Revision: '1228' },
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
    expect(publicationToolchainForRuntime().node).toBe(process.versions.node)
    expect(publicationToolchainForRuntime().runtime.node).toBe(
      process.versions.node,
    )
  })

  it('fails closed when repository toolchain assets are missing or mismatched', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-toolchain-'))
    await mkdir(resolve(root, 'public/fonts'), { recursive: true })
    await expect(verifyPublicationToolchain(root)).rejects.toThrow(
      /Geist-Regular\.ttf is missing|checksum does not match/,
    )
  })
})
