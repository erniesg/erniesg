import { describe, expect, it } from 'vitest'
import type { EpubExport } from './epub'
import type { EpubPreviewPayload } from './epub-preview'
import type { PdfReconstruction } from './import-types'
import {
  transferableEpubBuffers,
  transferableReconstructionBuffers,
} from './publication-worker-protocol'

describe('publication worker transfer protocol', () => {
  it('deduplicates shared asset buffers before posting a reconstruction', () => {
    const buffer = new ArrayBuffer(16)
    const pageBuffer = new ArrayBuffer(24)
    const reconstruction = {
      assets: [
        { bytes: new Uint8Array(buffer, 0, 8) },
        { bytes: new Uint8Array(buffer, 8, 8) },
      ],
      pages: [
        {
          assets: [
            { bytes: new Uint8Array(buffer, 4, 4) },
            { bytes: new Uint8Array(pageBuffer, 0, 12) },
            { bytes: new Uint8Array(pageBuffer, 12, 12) },
          ],
        },
      ],
    } as PdfReconstruction

    expect(transferableReconstructionBuffers(reconstruction)).toEqual([
      buffer,
      pageBuffer,
    ])
  })

  it('transfers the unchanged EPUB and every referenced preview asset once', () => {
    const epubBuffer = new ArrayBuffer(16)
    const assetBuffer = new ArrayBuffer(12)
    const epub = {
      bytes: new Uint8Array(epubBuffer),
    } as EpubExport
    const preview = {
      template: { segments: ['', '', ''], assetIndices: [0, 1] },
      assets: [
        {
          href: 'assets/a.png',
          mediaType: 'image/png',
          bytes: new Uint8Array(assetBuffer, 0, 6),
        },
        {
          href: 'assets/b.png',
          mediaType: 'image/png',
          bytes: new Uint8Array(assetBuffer, 6, 6),
        },
      ],
    } satisfies EpubPreviewPayload

    expect(transferableEpubBuffers(epub, preview)).toEqual([
      epubBuffer,
      assetBuffer,
    ])
  })
})
