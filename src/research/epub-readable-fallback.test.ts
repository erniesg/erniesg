import { strFromU8 } from 'fflate'
import { PDFDocument, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import {
  buildEpub,
  buildReadableEpub,
  inspectEpub,
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK,
  projectReadableFallbackReconstruction,
} from './epub'
import {
  readableFallbackEquation,
  readableFallbackEquationSharingFigureAsset,
  readableFallbackFigure,
  staleEquationTranscriptFixture,
  withReadableFallbackEquations,
  withReadableFallbackFigures,
} from './epub-readable-fallback-fixtures'
import type {
  PdfPageAnalysis,
  PdfReconstruction,
  PdfSourceRun,
  PublicationAsset,
} from './import-types'
import {
  attachRequiredSourcePageRenders,
  reconstructPdf,
  sourcePageRenderBudgetUsage,
} from './pdf'
import { reconstructPageAnalyses } from './pdf-layout'
import { MAX_EPUB_ASSETS_PER_BOOK } from './publication-resource-limits'
import { getTargetProfile } from './targets'
import { createSourcePageCropAsset } from './visual-assets'

describe('EPUB 3 export', () => {
  it('builds an explicitly non-publication-grade readable fallback without weakening the strict gate', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable text must still flow when a decorative image is unresolved.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: run.text.length,
      imageCount: 1,
      objects: [],
      runs: [run],
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [page],
      sourceHash: 'a'.repeat(64),
      fileName: 'readable-fallback.pdf',
      byteLength: 1024,
    })
    reconstruction.paper.title = run.text

    expect(reconstruction.readiness.ready).toBe(false)
    await expect(
      buildEpub(reconstruction.paper, reconstruction),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })

    const fallback = await buildReadableEpub(
      reconstruction.paper,
      reconstruction,
    )
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(fallback.mode).toBe('readable-fallback')
    expect(fallback.fileName).toMatch(/-readable\.epub$/)
    expect(content).toContain('Readable text must still flow')
    expect(content).toContain(
      '<title>Readable text must still flow when a decorative image is unresolved.</title>',
    )
    expect(content).not.toContain('<title>Publication</title>')
    expect(content.match(/Readable text must still flow/g)).toHaveLength(2)
    expect(content).not.toContain(
      'This readable fallback is incomplete and is not publication-grade.',
    )
    expect(content).not.toContain(
      'Omitted source visuals and unresolved relationships require review against the source PDF.',
    )
    expect(content).not.toContain('class="reconstruction-status"')
    expect(content).not.toContain('class="publication-header"')
    expect(content).not.toContain('class="reconstructed-header"')
    expect(content).not.toContain('class="reconstructed-header"')
    expect(content).not.toContain('working · 1970-01-01')
    expect(manifest).toMatchObject({
      exportMode: 'readable-fallback',
      publicationGrade: false,
      sourceReadiness: { ready: false },
    })
  })

  it('refuses a readable fallback for a sparse mixed raster page without OCR evidence', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Sparse embedded heading',
      x: 0.1,
      y: 0.1,
      width: 0.35,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 12,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'mixed',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'mixed-without-ocr.pdf',
      byteLength: 1024,
    })

    expect(reconstruction.completeness.ocrRequiredPages).toEqual([1])
    await expect(
      buildReadableEpub(reconstruction.paper, reconstruction),
    ).rejects.toMatchObject({
      code: 'INCOMPLETE_RECONSTRUCTION',
    })
  })

  it('builds a bounded source-preserved page fallback when a scan has no recovered text', async () => {
    const reconstruction = await reconstructPdf(
      await fixtureFile('scanned-page.pdf'),
    )

    expect(reconstruction.completeness.ocrRequiredPages).toEqual([1])
    const fallback = await buildReadableEpub(
      reconstruction.paper,
      reconstruction,
    )
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(fallback.mode).toBe('readable-fallback')
    expect(content).toContain('Source page 1')
    expect(content).toContain('text recovery required')
    expect(content).toContain('<img')
    expect(manifest).toMatchObject({
      publicationGrade: false,
      sourceCompleteness: { ocrRequiredPages: [1] },
      excludedUnresolvedVisualRelationshipCount: 0,
    })
    expect(manifest.assets).toHaveLength(1)
    const sourceAsset = reconstruction.pages[0]!.assets!.find(
      (asset) => asset.rendition === 'source-page-render',
    )!
    expect(manifest.assets[0]).toMatchObject({ sourceAssetId: sourceAsset.id })
    expect(files[`EPUB/${sourceAsset.href}`]).toBeInstanceOf(Uint8Array)
  })

  it.each([
    {
      name: 'an oversized unselected ordinary top-level asset',
      ordinaryAssets: (source: PublicationAsset) => [
        {
          ...source,
          id: 'ordinary-oversized-top-level',
          bytes: {
            byteLength: MAX_EPUB_ASSET_BYTES_PER_BOOK + 1,
          } as unknown as Uint8Array,
        },
      ],
    },
    {
      name: '512 unselected ordinary top-level assets',
      ordinaryAssets: (source: PublicationAsset) =>
        Array.from({ length: MAX_EPUB_ASSETS_PER_BOOK }, (_, index) => ({
          ...source,
          id: `ordinary-top-level-${index + 1}`,
        })),
    },
  ])(
    'keeps an unresolved page render bounded when reconstruction also has $name',
    async ({ ordinaryAssets }) => {
      const reconstruction = await reconstructPdf(
        await fixtureFile('scanned-page.pdf'),
      )
      const sourceRender = reconstruction.pages[0]!.assets!.find(
        (asset) => asset.rendition === 'source-page-render',
      )!
      const sourceObject = reconstruction.pages[0]!.objects!.find(
        (object) => object.rolePolicy === 'pdfjs-complete-page-render-v1',
      )!
      const ordinarySource = reconstruction.pages[0]!.assets!.find(
        (asset) => asset.rendition === 'source-preserved',
      )!
      reconstruction.pages[0]!.assets = reconstruction.pages[0]!.assets!.filter(
        (asset) => asset.id !== sourceRender.id,
      )
      reconstruction.pages[0]!.objects =
        reconstruction.pages[0]!.objects!.filter(
          (object) => object.id !== sourceObject.id,
        )
      reconstruction.assets = ordinaryAssets(ordinarySource)

      expect(reconstruction.completeness.ocrRequiredPages).toEqual([1])
      expect(
        reconstruction.pages[0]!.assets!.some(
          (asset) => asset.rendition === 'source-page-render',
        ),
      ).toBe(false)
      await attachRequiredSourcePageRenders(
        reconstruction,
        async (target, maximumBytes) => {
          expect(maximumBytes).toBeGreaterThanOrEqual(
            sourceRender.bytes.byteLength,
          )
          target.assets = [...(target.assets ?? []), sourceRender]
          target.objects = [...(target.objects ?? []), sourceObject]
          return sourceRender.bytes.byteLength
        },
      )
      expect(
        reconstruction.pages[0]!.assets!.some(
          (asset) => asset.id === sourceRender.id,
        ),
      ).toBe(true)
      expect(
        sourcePageRenderBudgetUsage(
          reconstruction.assets,
          reconstruction.pages,
        ),
      ).toEqual({
        count: 1,
        byteLength: sourceRender.bytes.byteLength,
      })

      const projected = projectReadableFallbackReconstruction(reconstruction)
      expect(projected.assets).toEqual([sourceRender])
      expect(projected.assets.length).toBeLessThanOrEqual(
        MAX_EPUB_ASSETS_PER_BOOK,
      )
      expect(
        projected.assets.reduce(
          (total, asset) => total + asset.bytes.byteLength,
          0,
        ),
      ).toBeLessThanOrEqual(MAX_EPUB_ASSET_BYTES_PER_BOOK)
    },
    120_000,
  )

  it.each([
    'scanned-page.pdf',
    'rotated-scan.pdf',
    'two-page-scan.pdf',
    'two-physical-page-scan.pdf',
    'tiled-multi-image-scan.pdf',
    'multilingual-scan.pdf',
  ])(
    'uses complete rendered source pages with closed fallback lineage for %s',
    async (name) => {
      const reconstruction = await reconstructPdf(await fixtureFile(name))
      const projected = projectReadableFallbackReconstruction(reconstruction)

      expect(projected.assets).toHaveLength(reconstruction.pages.length)
      for (const page of reconstruction.pages) {
        const surface = page.objects?.find(
          (object) =>
            object.role === 'scan-source' &&
            object.rolePolicy === 'pdfjs-complete-page-render-v1' &&
            object.box.x === 0 &&
            object.box.y === 0 &&
            object.box.width === 1 &&
            object.box.height === 1,
        )
        expect(surface).toBeDefined()
        const sourceAsset = page.assets?.find(
          (asset) => asset.id === surface?.assetId,
        )
        expect(sourceAsset).toMatchObject({
          rendition: 'source-page-render',
          mediaType: 'image/png',
          sourceObjectIds: [surface!.id],
          sourceBoxes: [surface!.box],
        })
        expect(sourceAsset!.width / sourceAsset!.height).toBeCloseTo(
          page.width / page.height,
          2,
        )
        expect(sourceAsset!.sourceBoxes[0]!.rotation).toBe(page.rotation)
        expect(
          projected.assets.some((asset) => asset.id === sourceAsset!.id),
        ).toBe(true)
      }
      for (const relationship of projected.visualRelationships) {
        expect(
          projected.regions.some(
            (region) => region.id === relationship.captionRegionId,
          ),
        ).toBe(true)
        expect(projected.provenance[relationship.captionNodeId!]).toMatchObject(
          {
            confidence: 0,
            regionIds: [relationship.captionRegionId],
          },
        )
      }
    },
    120_000,
  )

  it.each(['mixed-page.pdf', 'sparse-embedded-text.pdf'])(
    'preserves readable text and appends a complete-page figure for unresolved %s',
    async (name) => {
      const reconstruction = await reconstructPdf(await fixtureFile(name))
      const readableNodeIds = reconstruction.paper.nodes
        .filter((node) => 'text' in node && node.text.trim())
        .map((node) => node.id)
      const projected = projectReadableFallbackReconstruction(reconstruction)

      expect(reconstruction.completeness.ocrRequiredPages).toEqual([1])
      expect(readableNodeIds.length).toBeGreaterThan(0)
      expect(projected.paper.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining(readableNodeIds),
      )
      expect(
        projected.paper.nodes.filter(
          (node) =>
            node.type === 'figure' && node.id === 'source-scan-page-001',
        ),
      ).toHaveLength(1)
      expect(
        projected.assets.filter(
          (asset) => asset.rendition === 'source-page-render',
        ),
      ).toHaveLength(1)
      const fallback = await buildReadableEpub(
        reconstruction.paper,
        reconstruction,
      )
      const { files } = inspectEpub(fallback.bytes)
      const content = strFromU8(files['EPUB/content.xhtml'])
      expect(content).toContain('Source page 1')
      expect(content).toContain('<img')
    },
    120_000,
  )

  it('keeps a resolved digital page readable and renders only the unresolved physical page', async () => {
    const reconstruction = await reconstructPdf(
      await fixtureFile('mixed-digital-scan.pdf'),
    )
    const projected = projectReadableFallbackReconstruction(reconstruction)

    expect(reconstruction.completeness.ocrRequiredPages).toEqual([2])
    expect(
      reconstruction.pages[0]!.assets?.some(
        (asset) => asset.rendition === 'source-page-render',
      ) ?? false,
    ).toBe(false)
    expect(
      reconstruction.pages[1]!.assets?.some(
        (asset) => asset.rendition === 'source-page-render',
      ),
    ).toBe(true)
    expect(
      projected.paper.nodes.some(
        (node) =>
          'text' in node && node.text.includes('Readable digital introduction'),
      ),
    ).toBe(true)
    expect(
      projected.paper.nodes
        .filter(
          (node) =>
            node.type === 'figure' && node.id.startsWith('source-scan-page-'),
        )
        .map((node) => node.id),
    ).toEqual(['source-scan-page-002'])
  }, 120_000)

  it('places a scan-first fallback before readable nodes from later physical pages', async () => {
    const reconstruction = await reconstructPdf(
      await fixtureFile('scan-digital-hybrid.pdf'),
    )
    const projected = projectReadableFallbackReconstruction(reconstruction)
    const nodeIds = projected.paper.nodes.map((node) => node.id)
    const fallbackIndex = nodeIds.indexOf('source-scan-page-001')
    const laterTextIndex = projected.paper.nodes.findIndex(
      (node) =>
        'text' in node && node.text.includes('Readable digital conclusion'),
    )

    expect(reconstruction.completeness.ocrRequiredPages).toEqual([1])
    expect(fallbackIndex).toBeGreaterThanOrEqual(0)
    expect(laterTextIndex).toBeGreaterThan(fallbackIndex)
  }, 120_000)

  it('uses a complete page render instead of a large embedded image when the page adds an overlay', async () => {
    const source = await fixtureFile('scanned-page.pdf')
    const sourceDocument = await PDFDocument.load(await source.arrayBuffer())
    const overlaidDocument = await PDFDocument.create()
    const [page] = await overlaidDocument.copyPages(sourceDocument, [0])
    overlaidDocument.addPage(page)
    page.drawRectangle({
      x: 12,
      y: 12,
      width: 72,
      height: 36,
      borderColor: rgb(0.8, 0.1, 0.1),
      borderWidth: 5,
    })
    const bytes = await overlaidDocument.save({ useObjectStreams: false })
    const reconstruction = await reconstructPdf(
      new File([bytes], 'unseen-overlay-scan.pdf', {
        type: 'application/pdf',
        lastModified: 0,
      }),
    )
    const projected = projectReadableFallbackReconstruction(reconstruction)
    const nativeAssets = reconstruction.pages[0]!.assets!.filter(
      (asset) => asset.rendition === 'source-preserved',
    )

    expect(nativeAssets.length).toBeGreaterThan(0)
    expect(projected.assets).toHaveLength(1)
    expect(projected.assets[0]).toMatchObject({
      rendition: 'source-page-render',
    })
    expect(
      nativeAssets.some(
        (asset) => asset.sha256 === projected.assets[0]!.sha256,
      ),
    ).toBe(false)
  })

  it.each([
    {
      name: 'a derived rendition',
      mutate: (reconstruction: PdfReconstruction) => {
        reconstruction.pages[0]!.assets!.find(
          (asset) => asset.rendition === 'source-page-render',
        )!.rendition = 'profile-downscaled'
      },
    },
    {
      name: 'content that no longer matches its digest',
      mutate: (reconstruction: PdfReconstruction) => {
        reconstruction.pages[0]!.assets!.find(
          (asset) => asset.rendition === 'source-page-render',
        )!.bytes[0] ^= 0xff
      },
    },
    {
      name: 'an href that no longer matches its digest',
      mutate: (reconstruction: PdfReconstruction) => {
        reconstruction.pages[0]!.assets!.find(
          (asset) => asset.rendition === 'source-page-render',
        )!.href = 'assets/forged-source-page.png'
      },
    },
  ])('refuses a scan fallback backed by $name', async ({ mutate }) => {
    const reconstruction = await reconstructPdf(
      await fixtureFile('scanned-page.pdf'),
    )
    mutate(reconstruction)

    await expect(
      buildReadableEpub(reconstruction.paper, reconstruction),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })
  })

  it('keeps a complete bounded source-backed table image in readable fallback', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable prose around a source-backed table.',
      x: 0.1,
      y: 0.1,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'bounded-table-fallback.pdf',
      byteLength: 1024,
    })
    const captionBox = {
      page: 1,
      x: 0.15,
      y: 0.28,
      width: 0.7,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const tableBox = {
      page: 1,
      x: 0.18,
      y: 0.33,
      width: 0.64,
      height: 0.24,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const sourceTableWidth = 1_000
    const sourceTableHeight = 900
    const crop = await createSourcePageCropAsset({
      kind: 'table',
      cropBox: { ...tableBox, method: 'pdf-object' },
      sourceObjectIds: ['bounded-table-source'],
      sourceBoxes: [tableBox],
      width: sourceTableWidth,
      height: sourceTableHeight,
      pixels: new Uint8Array(sourceTableWidth * sourceTableHeight * 4).fill(80),
    })
    const sourceText = 'Method Score Baseline 72 Proposed 81'
    const figureNode = {
      id: 'bounded-table-node',
      type: 'figure' as const,
      objectType: 'table' as const,
      title: 'Table 1. Source-backed comparison.',
      sourceText,
      inlineRuns: [
        { start: 0, end: 'Method'.length, bold: true },
        {
          start: sourceText.indexOf('Proposed'),
          end: sourceText.indexOf('Proposed') + 'Proposed'.length,
          italic: true,
        },
      ],
      relationships: {
        caption: 'bounded-table-caption',
        assets: [crop.id],
      },
      source: 'synthetic-bounded-table',
    }
    const captionNode = {
      id: 'bounded-table-caption',
      type: 'caption' as const,
      text: 'Table 1. Source-backed comparison.',
      source: 'synthetic-bounded-table',
    }
    const relationship = {
      id: 'bounded-table-relationship',
      kind: 'table' as const,
      label: 'Table 1',
      captionRegionId: 'bounded-table-caption-region',
      sourceRegionIds: ['bounded-table-source-region'],
      sourceLineIds: ['bounded-table-header-line', 'bounded-table-body-line'],
      sourceObjectIds: ['bounded-table-source'],
      assetIds: [crop.id],
      status: 'matched' as const,
      confidence: 1,
      evidence: [
        'bounded-table-scope',
        'non-semantic-source-scope',
        'source-page-crop',
      ],
      candidates: [],
      sourceBoxes: [captionBox, tableBox],
      sourceText,
      altText: captionNode.text,
      altTextSource: 'caption' as const,
      canonicalNodeId: figureNode.id,
      captionNodeId: captionNode.id,
    }
    const withTable = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [...reconstruction.paper.nodes, figureNode, captionNode],
      },
      provenance: {
        ...reconstruction.provenance,
        [figureNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: relationship.sourceRegionIds,
          boxes: relationship.sourceBoxes,
          links: [],
        },
        [captionNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [relationship.captionRegionId],
          boxes: [captionBox],
          links: [],
        },
      },
      assets: [crop],
      visualRelationships: [relationship],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(withTable.paper, withTable)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('data-object-type="table"')
    expect(content).toContain(`data-asset-id="${crop.id}"`)
    expect(content).not.toContain('loading="lazy"')
    expect(content).toContain('loading="eager"')
    expect(content).toContain('Table 1. Source-backed comparison.')
    expect(content).toContain(
      '<span class="visually-hidden visual-source-transcript"',
    )
    expect(content).toContain(
      '<strong>Method</strong> Score Baseline 72 <em>Proposed</em> 81',
    )
    expect(content).not.toContain('<table')
    expect(manifest.visualRelationships).toEqual([
      expect.objectContaining({
        id: relationship.id,
        kind: 'table',
        assetIds: [crop.id],
      }),
    ])
    expect(manifest.assets).toEqual([
      expect.objectContaining({
        id: crop.id,
        kind: 'table',
        rendition: 'source-page-crop',
      }),
    ])

    const moveProfile = getTargetProfile('paperProMove')
    const moveFallback = await buildReadableEpub(
      withTable.paper,
      withTable,
      moveProfile,
    )
    const moveInspection = inspectEpub(moveFallback.bytes, moveProfile)
    const moveContent = strFromU8(moveInspection.files['EPUB/content.xhtml'])
    const moveManifest = moveInspection.manifest as {
      assets?: Array<Record<string, unknown>>
    }
    const moveTableAsset = moveManifest.assets?.find(
      (candidate) => candidate.sourceAssetId === crop.id,
    )

    expect(moveContent).toContain(
      'data-wide-source-visual="true" data-source-visual-kind="table"',
    )
    expect(moveContent).toContain(
      `<img src="${crop.href}" width="${sourceTableWidth}" height="${sourceTableHeight}"`,
    )
    expect(moveInspection.files[`EPUB/${crop.href}`]).toEqual(crop.bytes)
    expect(moveTableAsset).toMatchObject({
      id: crop.id,
      width: sourceTableWidth,
      height: sourceTableHeight,
      sourceAssetId: crop.id,
      policy: {
        id: 'preserve-scrollable-table-source',
        action: 'preserved',
        sourceWidth: sourceTableWidth,
        sourceHeight: sourceTableHeight,
        packagedWidth: sourceTableWidth,
        packagedHeight: sourceTableHeight,
        maximumWidth: null,
        resampling: 'none',
        neverUpscaled: true,
      },
    })
  })

  it('retains more than 64 unique matched equation assets outside the optional cap', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const equations = await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        readableFallbackEquation(index + 1),
      ),
    )
    const projected = projectReadableFallbackReconstruction(
      withReadableFallbackEquations(reconstruction, equations),
    )
    const equationRelationships = projected.visualRelationships.filter(
      (relationship) => relationship.kind === 'equation',
    )
    const equationAssetIds = new Set(
      equationRelationships.flatMap((relationship) => relationship.assetIds),
    )

    expect(equationRelationships).toHaveLength(66)
    expect(equationAssetIds).toHaveLength(66)
    expect(projected.assets).toHaveLength(66)
    const epub = await buildReadableEpub(
      projected.paper,
      projected,
      getTargetProfile('paperPro'),
    )
    const content = strFromU8(
      inspectEpub(epub.bytes, getTargetProfile('paperPro')).files[
        'EPUB/content.xhtml'
      ],
    )
    expect(content.match(/data-object-type="equation"/gu)).toHaveLength(66)
    for (const relationship of equationRelationships) {
      expect(content).toContain(
        `id="${relationship.canonicalNodeId}" data-canonical-id="${relationship.canonicalNodeId}"`,
      )
    }
  })

  it('fails closed when relationships share a canonical or caption owner', async () => {
    const { reconstruction, relationship } =
      await staleEquationTranscriptFixture()
    for (const duplicate of [
      {
        ...relationship,
        id: 'duplicate-equation-canonical-owner',
        captionNodeId: 'independent-caption-owner',
      },
      {
        ...relationship,
        id: 'duplicate-equation-caption-owner',
        canonicalNodeId: 'independent-canonical-owner',
      },
    ]) {
      expect(() =>
        projectReadableFallbackReconstruction({
          ...reconstruction,
          visualRelationships: [relationship, duplicate],
        }),
      ).toThrow(/ambiguously share/u)
    }
  })

  it('fails before packaging an unbounded mandatory equation workset', async () => {
    const { reconstruction, relationship } =
      await staleEquationTranscriptFixture()
    const excessiveRelationships = Array.from(
      { length: MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK + 1 },
      (_, index) => ({
        ...relationship,
        id: `resource-bounded-equation-${index + 1}`,
      }),
    )
    expect(() =>
      projectReadableFallbackReconstruction({
        ...reconstruction,
        visualRelationships: excessiveRelationships,
      }),
    ).toThrow(/EPUB asset resource limit exceeded/u)

    expect(() =>
      projectReadableFallbackReconstruction({
        ...reconstruction,
        assets: [
          {
            ...reconstruction.assets[0],
            bytes: {
              byteLength: MAX_EPUB_ASSET_BYTES_PER_BOOK + 1,
            } as unknown as Uint8Array,
          },
        ],
      }),
    ).toThrow(/EPUB asset resource limit exceeded/u)
  })

  it('caps unique optional asset IDs without collapsing relationship ownership', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const uniqueFigures = Array.from({ length: 65 }, (_, index) =>
      readableFallbackFigure(index + 1),
    )
    const uniqueProjection = projectReadableFallbackReconstruction(
      withReadableFallbackFigures(reconstruction, uniqueFigures),
    )

    expect(
      uniqueProjection.visualRelationships.filter(
        (relationship) => relationship.kind === 'equation',
      ),
    ).toHaveLength(1)
    expect(
      uniqueProjection.visualRelationships.filter(
        (relationship) => relationship.kind === 'figure',
      ),
    ).toHaveLength(64)

    const crossKindSharedFigure = readableFallbackFigure(1)
    const crossKindOptionalFigures = [
      crossKindSharedFigure,
      ...Array.from({ length: 64 }, (_, index) =>
        readableFallbackFigure(index + 2),
      ),
    ]
    const crossKindEquation = readableFallbackEquationSharingFigureAsset(
      crossKindSharedFigure,
    )
    const crossKindBase = withReadableFallbackFigures(
      reconstruction,
      crossKindOptionalFigures,
    )
    const crossKindProjection = projectReadableFallbackReconstruction({
      ...crossKindBase,
      paper: {
        ...crossKindBase.paper,
        nodes: [...crossKindBase.paper.nodes, ...crossKindEquation.nodes],
      },
      provenance: {
        ...crossKindBase.provenance,
        ...crossKindEquation.provenance,
      },
      regions: [...crossKindBase.regions, crossKindEquation.region],
      visualRelationships: [
        ...reconstruction.visualRelationships,
        ...crossKindOptionalFigures.map((figure) => figure.relationship),
        crossKindEquation.relationship,
      ],
    })

    expect(
      crossKindProjection.visualRelationships.filter(
        (relationship) => relationship.kind === 'figure',
      ),
    ).toHaveLength(65)
    expect(crossKindProjection.assets).toHaveLength(66)
  })

  it('fails readable fallback explicitly for missing or invalid matched equation assets', async () => {
    const { reconstruction, relationship } =
      await staleEquationTranscriptFixture()
    const invalidReconstructions = [
      {
        name: 'missing',
        reconstruction: { ...reconstruction, assets: [] },
      },
      {
        name: 'invalid',
        reconstruction: {
          ...reconstruction,
          assets: [
            {
              ...reconstruction.assets[0],
              sha256: '0'.repeat(64),
            },
          ],
        },
      },
    ] satisfies Array<{ name: string; reconstruction: PdfReconstruction }>

    for (const fixture of invalidReconstructions) {
      let error: unknown
      try {
        projectReadableFallbackReconstruction(fixture.reconstruction)
      } catch (caught) {
        error = caught
      }
      expect(error, fixture.name).toMatchObject({
        code: 'INCOMPLETE_RECONSTRUCTION',
      })
      expect(String(error)).toContain(relationship.id)
    }
  })

  it('projects readable-fallback note backlinks onto anchors that can actually render', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'A claim with note 1.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'readable-note-projection.pdf',
      byteLength: 1024,
    })
    const paragraph = reconstruction.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text === run.text,
    )
    expect(paragraph?.type).toBe('paragraph')
    if (paragraph?.type !== 'paragraph') throw new Error('missing paragraph')
    paragraph.noteReferences = [
      {
        id: 'rendered-reference',
        label: '1',
        target: 'rendered-note',
        start: run.text.indexOf('1'),
        end: run.text.indexOf('1') + 1,
        confidence: 1,
      },
    ]
    reconstruction.paper.nodes.push(
      {
        id: 'rendered-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'A source-backed note.',
        relationships: {
          backlinks: ['rendered-reference', 'orphan-source-marker'],
        },
        source: 'pdf:synthetic#page=1',
      },
      {
        id: 'orphan-note',
        type: 'footnote',
        kind: 'footnote',
        label: '2',
        text: 'A note whose extracted marker cannot render.',
        relationships: { backlinks: ['another-orphan-source-marker'] },
        source: 'pdf:synthetic#page=1',
      },
    )
    const referenceStart = run.text.indexOf('1')
    reconstruction.noteRelationships.push({
      id: 'rendered-reference',
      label: '1',
      referenceRegionId: reconstruction.provenance[paragraph.id].regionIds[0],
      referenceStart,
      referenceEnd: referenceStart + 1,
      targetNoteId: 'rendered-note',
      status: 'matched',
      canonicalAnchor: {
        kind: 'node',
        nodeId: paragraph.id,
        start: referenceStart,
        end: referenceStart + 1,
      },
      confidence: 1,
      threshold: 0.72,
      evidence: ['synthetic-rendered-note-reference'],
      candidates: [],
      sourceBoxes: reconstruction.provenance[paragraph.id].boxes,
    })

    const fallback = await buildReadableEpub(
      reconstruction.paper,
      reconstruction,
    )
    const { files } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('id="rendered-reference"')
    expect(content).toContain('href="#rendered-reference"')
    expect(content).not.toContain('orphan-source-marker')
    expect(content).not.toContain('another-orphan-source-marker')
    expect(content).toContain('A note whose extracted marker cannot render.')
  })
})
