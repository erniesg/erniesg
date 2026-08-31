import { describe, expect, it } from 'vitest'
import type { EpubExport } from './epub'
import type { EpubPreviewPayload } from './epub-preview'
import { PdfImportError, type PdfReconstruction } from './import-types'
import {
  contentFreePublicationWorkerError,
  contentFreePublicationWorkerProgress,
  transferableEpubBuffers,
  transferableReconstructionBuffers,
} from './publication-worker-protocol'

describe('publication worker transfer protocol', () => {
  it('sanitizes private progress and exception payloads before serialization', () => {
    const marker = 'PRIVATE-SERIALIZER-MARKER'
    expect(
      contentFreePublicationWorkerProgress({
        phase: 'extracting',
        completed: 3,
        total: 8,
        message: marker,
        checkpoint: marker,
      }),
    ).toEqual({
      phase: 'extracting',
      completed: 0,
      total: 0,
      message: 'Reading document structure locally…',
    })

    const known = new PdfImportError('ENCRYPTED_PDF', marker)
    known.stack = marker
    expect(contentFreePublicationWorkerError(known)).toEqual({
      code: 'ENCRYPTED_PDF',
      message: 'The local conversion stopped safely.',
    })

    const unexpected = new Error(marker)
    unexpected.name = marker
    unexpected.stack = marker
    expect(contentFreePublicationWorkerError(unexpected)).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: 'The local conversion stopped safely.',
    })

    Object.defineProperty(known, 'code', { value: marker })
    const poisoned = contentFreePublicationWorkerError(known)
    expect(poisoned).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: 'The local conversion stopped safely.',
    })
    expect(JSON.stringify(poisoned)).not.toContain(marker)
  })

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
