import { afterEach, describe, expect, it, vi } from 'vitest'
import { strFromU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import { buildEpub, inspectEpub } from './epub'
import { reconstructPdf } from './pdf'
import {
  fixtureFile,
  oversizedPdfFixture,
} from '../../tests/fixtures/pdf-fixtures'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PDF.js browser ingestion', () => {
  it('opens an actual born-digital PDF and reconstructs text with boxes', async () => {
    const file = await fixtureFile('born-digital.pdf')
    const result = await reconstructPdf(file)

    expect(result.source.pageCount).toBe(1)
    expect(result.pages[0]).toMatchObject({
      kind: 'born-digital',
      rotation: 0,
    })
    expect(result.paper.nodes.length).toBeGreaterThan(0)
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node && node.text.includes('Reconstructed Research Paper'),
      ),
    ).toBe(true)
    expect(Object.values(result.provenance)[0].boxes[0]).toMatchObject({
      page: 1,
      method: 'pdf-text',
    })
    expect(result.completeness).toMatchObject({
      textCoverage: 1,
      assetCoverage: 1,
      relationshipCoverage: 1,
      unresolvedObjectCount: 0,
    })
    expect(result.readiness).toMatchObject({ ready: true, status: 'ready' })

    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    expect(epub.fileName).toMatch(/\.epub$/)
    expect(strFromU8(files['EPUB/content.xhtml'])).toContain(
      'Reconstructed Research Paper',
    )
    expect(JSON.parse(strFromU8(files['EPUB/export.json']))).toMatchObject({
      sourcePdfSha256: result.source.sha256,
      sourceReadiness: { ready: true },
      rendition: 'reflowable-epub',
    })
  })

  it('fails closed when scientific objects and relationships are unresolved', async () => {
    const result = await reconstructPdf(
      await fixtureFile('structured-scientific.pdf'),
    )

    expect(result.pages[0].imageCount).toBeGreaterThan(0)
    expect(result.pages[0].objects).toEqual([
      expect.objectContaining({
        id: 'image-p001-001',
        kind: 'image',
        box: expect.objectContaining({
          method: 'pdf-object',
          x: expect.closeTo(220 / 612, 4),
          y: expect.closeTo(222 / 792, 4),
          width: expect.closeTo(170 / 612, 4),
          height: expect.closeTo(110 / 792, 4),
        }),
      }),
    ])
    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'caption' }),
        expect.objectContaining({ kind: 'figure' }),
        expect.objectContaining({ kind: 'footnote' }),
      ]),
    )
    expect(result.readingOrder.evaluation).toMatchObject({
      mode: 'deterministic-only',
      cycleRate: 0,
      unresolvedEdgeCount: 0,
    })
    expect(result.noteRelationships).toEqual([
      expect.objectContaining({ status: 'matched', targetNoteId: 'fn-p001-1' }),
    ])
    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'fn-p001-1',
          type: 'footnote',
          label: '1',
        }),
      ]),
    )
    expect(result.semanticSignals).toEqual({
      captions: 1,
      tables: 1,
      equations: 1,
      footnoteReferences: 1,
      footnotes: 1,
    })
    expect(result.completeness).toMatchObject({
      textCoverage: 1,
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 0.5,
      readingOrderDiagnostics: 0,
    })
    expect(result.completeness.unresolvedObjectCount).toBeGreaterThan(0)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPLETE_ASSET_COVERAGE',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'UNRESOLVED_SEMANTIC_OBJECTS',
          severity: 'error',
        }),
      ]),
    )
    await expect(buildEpub(result.paper, result)).rejects.toMatchObject({
      code: 'INCOMPLETE_RECONSTRUCTION',
    })
  })

  it('classifies scanned, mixed, and two-page scanned fixtures', async () => {
    const [scanned, mixed, twoPage] = await Promise.all([
      reconstructPdf(await fixtureFile('scanned-page.pdf')),
      reconstructPdf(await fixtureFile('mixed-page.pdf')),
      reconstructPdf(await fixtureFile('two-page-scan.pdf')),
    ])

    expect(scanned.pages.map((page) => page.kind)).toEqual(['ocr-required'])
    expect(mixed.pages.map((page) => page.kind)).toEqual(['mixed'])
    expect(twoPage.pages.map((page) => page.kind)).toEqual([
      'ocr-required',
      'ocr-required',
    ])
    expect(twoPage.completeness.ocrRequiredPages).toEqual([1, 2])
    expect(
      [scanned, mixed, twoPage].every((result) => !result.readiness.ready),
    ).toBe(true)
  })

  it('rejects the virtual oversized fixture before reading document bytes', async () => {
    let read = false
    await expect(
      reconstructPdf(
        oversizedPdfFixture(() => {
          read = true
        }),
      ),
    ).rejects.toMatchObject({ code: 'OVERSIZED_PDF' })
    expect(read).toBe(false)
  })

  it('cancels before PDF.js opens when abort fires during hashing', async () => {
    const controller = new AbortController()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      const result = await digest(...args)
      controller.abort()
      return result
    })
    const file = new File(['%PDF-1.4\ninvalid'], 'cancel-during-hash.pdf', {
      type: 'application/pdf',
      lastModified: 0,
    })

    await expect(
      reconstructPdf(file, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })

  it('cancels when the operator aborts at reconstruction', async () => {
    const controller = new AbortController()

    await expect(
      reconstructPdf(
        await fixtureFile('born-digital.pdf'),
        (progress) => {
          if (progress.phase === 'reconstructing') controller.abort()
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })

  it('retains the published fellowship PDF as non-private local audit evidence', async () => {
    const bytes = await readFile(
      new URL(
        '../../public/research/if-letters-home-could-sing/if-letters-home-could-sing.pdf',
        import.meta.url,
      ),
    )
    const result = await reconstructPdf(
      new File([bytes], 'if-letters-home-could-sing.pdf', {
        type: 'application/pdf',
        lastModified: 0,
      }),
    )

    expect(result.source.sha256).toBe(
      'ddf25768bcc2ec8866037c553102071ee8fbb73db168f975852f69482c1eb042',
    )
    expect(result.source.pageCount).toBeGreaterThan(1)
    expect(result.completeness.sourceTextCharacters).toBeGreaterThan(0)
    expect(['ready', 'review-required']).toContain(result.readiness.status)
  })
})
