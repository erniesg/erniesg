import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import {
  createSourcePageCropAsset,
  createVectorSvgAsset,
} from './visual-assets'

function box(x: number, y: number, width = 0.2, height = 0.1, page = 1) {
  return {
    page,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-object',
  } satisfies NormalizedSourceBox
}

function objectRegion(
  id: string,
  objectId: string,
  sourceBox: NormalizedSourceBox,
) {
  return {
    id,
    page: sourceBox.page,
    kind: 'figure',
    column: 'single',
    text: '',
    confidence: 0.98,
    box: sourceBox,
    lines: [],
    nativeObjectIds: [objectId],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function captionRegion(text: string, sourceBox = box(0.2, 0.32, 0.5, 0.02)) {
  return {
    id: 'caption-region',
    page: sourceBox.page,
    kind: 'caption',
    column: 'single',
    text,
    confidence: 0.94,
    box: { ...sourceBox, method: 'pdf-text' as const },
    lines: [],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function textRegion(
  id: string,
  text: string,
  sourceBox: NormalizedSourceBox,
  kind: PdfPageRegion['kind'] = 'body',
): PdfPageRegion {
  const textBox = { ...sourceBox, method: 'pdf-text' as const }
  return {
    id,
    page: textBox.page,
    kind,
    column: 'single',
    text,
    confidence: 0.99,
    box: textBox,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 9,
        box: textBox,
        runs: [
          {
            ...textBox,
            text,
            fontName: 'DiagramSans',
            fontSize: 9,
            confidence: 0.99,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: !['side', 'chart-label'].includes(kind),
  } satisfies PdfPageRegion
}

function page(
  objects: PdfPageAnalysis['objects'],
  pageNumber = objects?.[0]?.page ?? 1,
  assets: PdfVisualAsset[] = [],
): PdfPageAnalysis {
  return {
    page: pageNumber,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 20,
    imageCount: objects?.length ?? 0,
    objects,
    assets,
    runs: [],
  }
}

function sourcePreservedSvgAsset(
  sourceObjectId: string,
  sourceBox: NormalizedSourceBox,
): PdfVisualAsset {
  return {
    id: `asset-${sourceObjectId}`,
    href: `assets/asset-${sourceObjectId}.svg`,
    mediaType: 'image/svg+xml',
    kind: 'vector',
    rendition: 'source-preserved',
    sha256: 'a'.repeat(64),
    bytes: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><path d="M0 0L40 0L20 30Z" fill="#c30" /></svg>',
    ),
    width: 40,
    height: 30,
    resolutionDpi: null,
    sourceObjectIds: [sourceObjectId],
    sourceBoxes: [sourceBox],
  }
}

async function solidRectangleFallbackAsset(
  sourceObjectId: string,
  sourceBox: NormalizedSourceBox,
) {
  return await createVectorSvgAsset({
    sourceObjectId,
    sourceBox,
    path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    paint: 'fill',
  })
}

describe('PDF visual association graph', () => {
  it('retains a broad vector scaffold when it binds disconnected source fragments', async () => {
    const scaffold = box(0.05, 0.1, 0.9, 0.42)
    const fragmentBoxes = [
      box(0.1, 0.15, 0.05, 0.04),
      box(0.32, 0.23, 0.05, 0.04),
      box(0.58, 0.17, 0.05, 0.04),
      box(0.82, 0.36, 0.05, 0.04),
    ]
    const objects = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: 'asset-scaffold',
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `image-p001-00${index + 1}`,
        page: 1,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: `asset-fragment-${index + 1}`,
      })),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )
    const caption = captionRegion(
      'Figure 1. One bounded composite.',
      box(0.1, 0.54, 0.8, 0.02),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`composite-region-${index + 1}`, object.id, object.box),
        ),
        caption,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceObjectIds: objects.map((object) => object.id),
        sourceBox: expect.objectContaining({ page: 1 }),
      }),
    )
    const renderBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(renderBox.y + renderBox.height).toBeLessThanOrEqual(
      caption.box.y + 0.001,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_VISUAL_ASSET' }),
      ]),
    )
  })

  it('trims scaffold and glyph objects that overlap unrelated reading-order text', async () => {
    const scaffold = box(0.48, 0.12, 0.36, 0.36)
    const authorGlyph = box(0.6, 0.18, 0.04, 0.02)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.52 + (index % 4) * 0.07,
        0.26 + Math.floor(index / 4) * 0.12,
        0.05,
        0.06,
      ),
    )
    const figureIds = fragmentBoxes.map(
      (_, index) => `vector-p001-figure-${index + 1}`,
    )
    const objects = [
      {
        id: 'vector-p001-overbroad-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: null,
      },
      {
        id: 'vector-p001-author-glyph',
        page: 1,
        kind: 'vector' as const,
        box: authorGlyph,
        confidence: 0.98,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: figureIds[index],
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: null,
      })),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`scaffold-region-${index + 1}`, object.id, object.box),
        ),
        textRegion(
          'author-line',
          'Author One, Author Two, University Laboratory',
          box(0.3, 0.17, 0.45, 0.035),
          'body',
        ),
        textRegion(
          'diagram-label-one',
          'Premise',
          box(0.55, 0.27, 0.08, 0.015),
          'body',
        ),
        textRegion(
          'diagram-label-two',
          'Write content',
          box(0.68, 0.39, 0.09, 0.015),
          'body',
        ),
        captionRegion(
          'Figure 1. A bounded diagram below the author block.',
          box(0.5, 0.5, 0.36, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceObjectIds: [
          ...figureIds,
          'text-overlay:diagram-label-one',
          'text-overlay:diagram-label-two',
        ],
        sourceBox: expect.objectContaining({ y: expect.any(Number) }),
      }),
    )
    const sourceBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(sourceBox.y).toBeGreaterThan(0.2)
    expect(sourceBox.x).toBeLessThanOrEqual(0.5)
    expect(sourceBox.x + sourceBox.width).toBeGreaterThanOrEqual(0.86)
    expect(sourceBox.y + sourceBox.height).toBeGreaterThanOrEqual(0.49)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...figureIds,
        'text-overlay:diagram-label-one',
        'text-overlay:diagram-label-two',
      ],
      evidence: expect.arrayContaining([
        'source-scaffold-trimmed-reading-order-overlap',
        'source-page-crop',
      ]),
    })
  })

  it('excludes a reused page-edge vector backdrop from a captioned figure crop', async () => {
    const pageBackdrop = box(0.15, 0.08, 0.68, 0.26)
    const repeatedBackdrop = box(0.19, 0.004, 0.68, 0.26, 2)
    const fragmentBoxes = [
      box(0.2, 0.12, 0.14, 0.12),
      box(0.36, 0.12, 0.14, 0.12),
      box(0.52, 0.12, 0.14, 0.12),
      box(0.68, 0.12, 0.14, 0.12),
    ]
    const firstBackdropAsset = await solidRectangleFallbackAsset(
      'vector-p001-page-backdrop',
      pageBackdrop,
    )
    const backdropObjects = [
      {
        id: 'vector-p001-page-backdrop',
        page: 1,
        kind: 'vector' as const,
        box: pageBackdrop,
        confidence: 0.99,
        assetId: firstBackdropAsset.id,
      },
      {
        id: 'vector-p002-page-backdrop',
        page: 2,
        kind: 'vector' as const,
        box: repeatedBackdrop,
        confidence: 0.99,
        assetId: firstBackdropAsset.id,
      },
    ]
    const secondBackdropAsset = {
      ...firstBackdropAsset,
      sourceObjectIds: [backdropObjects[1].id],
      sourceBoxes: [repeatedBackdrop],
    }
    const figureObjects = fragmentBoxes.map((sourceBox, index) => ({
      id: `vector-p001-scientific-fragment-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 32,
          pixels: new Uint8Array(96 * 32 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page([backdropObjects[0], ...figureObjects], 1, [firstBackdropAsset]),
        page([backdropObjects[1]], 2, [secondBackdropAsset]),
      ],
      regions: [
        objectRegion(
          'page-backdrop-region',
          backdropObjects[0].id,
          pageBackdrop,
        ),
        ...figureObjects.map((object, index) =>
          objectRegion(
            `scientific-fragment-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. A scientific panel below reusable page furniture.',
          box(0.18, 0.27, 0.64, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: figureObjects.map((object) => object.id),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0.1)
    expect(rasterizeFigure.mock.calls[0][0].sourceObjectIds).not.toContain(
      backdropObjects[0].id,
    )
  })

  it('does not reclaim repeated running-title text as a figure overlay', async () => {
    const overbroadScaffold = box(0.1, 0.08, 0.8, 0.28)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.2 + (index % 4) * 0.15,
        0.17 + Math.floor(index / 4) * 0.1,
        0.08,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-running-title-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: overbroadScaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-running-title-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const runningTitle = textRegion(
      'misclassified-running-title',
      'DECOMPOSING PERSONA VECTORS USING SPARSE AUTOENCODERS',
      box(0.18, 0.1, 0.6, 0.016),
    )
    const repeatedRunningTitle = {
      ...textRegion(
        'repeated-running-title',
        runningTitle.text,
        box(0.18, 0.03, 0.6, 0.016, 2),
        'header',
      ),
      includedInReadingOrder: false,
    }
    const firstDiagramLabel = textRegion(
      'first-diagram-label',
      'Feature direction',
      box(0.24, 0.19, 0.12, 0.014),
    )
    const secondDiagramLabel = textRegion(
      'second-diagram-label',
      'Cosine similarity',
      box(0.48, 0.28, 0.12, 0.014),
    )
    const sectionHeading = textRegion(
      'section-heading-over-scaffold',
      'M DECOMPOSING PERSONA VECTORS USING SPARSE AUTOENCODERS',
      box(0.11, 0.082, 0.18, 0.016),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 36,
          pixels: new Uint8Array(96 * 36 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects), page([], 2)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `running-title-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        sectionHeading,
        runningTitle,
        repeatedRunningTitle,
        firstDiagramLabel,
        secondDiagramLabel,
        captionRegion(
          'Figure 1. A dense panel below repeated page furniture.',
          box(0.16, 0.37, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        'text-overlay:first-diagram-label',
        'text-overlay:second-diagram-label',
      ]),
    })
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'text-overlay:misclassified-running-title',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'vector-p001-running-title-scaffold',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'text-overlay:section-heading-over-scaffold',
    )
    expect(result.consumedRegionIds.has(runningTitle.id)).toBe(false)
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0.12)
  })

  it('trims an overbroad native scaffold that overlaps repeated side-classified page furniture', async () => {
    const overbroadScaffold = box(0.1, 0.08, 0.8, 0.28)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.2 + (index % 4) * 0.15,
        0.17 + Math.floor(index / 4) * 0.1,
        0.08,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-page-furniture-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: overbroadScaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-page-furniture-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const runningHeader = {
      ...textRegion(
        'running-header-over-scaffold',
        'Paul Pu Liang, Amir Zadeh, and Louis-Philippe Morency',
        box(0.2, 0.095, 0.6, 0.016),
        'side',
      ),
      includedInReadingOrder: false,
    }
    const repeatedRunningHeaders = [2, 3].map((pageNumber) => ({
      ...textRegion(
        `repeated-running-header-page-${pageNumber}`,
        runningHeader.text,
        box(0.2, 0.095, 0.6, 0.016, pageNumber),
        'side',
      ),
      includedInReadingOrder: false,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 36,
          pixels: new Uint8Array(96 * 36 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects), page([], 2), page([], 3)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `page-furniture-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        runningHeader,
        ...repeatedRunningHeaders,
        textRegion(
          'page-furniture-diagram-label-one',
          'Continuous warping',
          box(0.26, 0.19, 0.12, 0.014),
        ),
        textRegion(
          'page-furniture-diagram-label-two',
          'Modality segmentation',
          box(0.5, 0.28, 0.14, 0.014),
        ),
        captionRegion(
          'Figure 1. A dense panel below a running header.',
          box(0.16, 0.37, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-scaffold-trimmed-page-furniture-overlap',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'vector-p001-page-furniture-scaffold',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'text-overlay:running-header-over-scaffold',
    )
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0.12)
  })

  it('excludes repeated side furniture enclosed by every coextensive figure layer', async () => {
    const sourceBox = box(0.14, 0.08, 0.72, 0.24)
    const sourceObjectIds = [
      'vector-p001-coextensive-furniture-layer-a',
      'vector-p001-coextensive-furniture-layer-b',
    ]
    const sourceAssets = sourceObjectIds.map((sourceObjectId) =>
      sourcePreservedSvgAsset(sourceObjectId, sourceBox),
    )
    const runningHeader = {
      ...textRegion(
        'coextensive-running-side-header',
        'REPEATED SOURCE-SIDE RUNNING HEADER ACROSS PAGES',
        box(0.2, 0.095, 0.6, 0.016),
        'side',
      ),
      includedInReadingOrder: false,
    }
    const repeatedHeaders = [2, 3].map((pageNumber) => ({
      ...textRegion(
        `coextensive-running-side-header-page-${pageNumber}`,
        runningHeader.text,
        box(0.2, 0.095, 0.6, 0.016, pageNumber),
        'side',
      ),
      includedInReadingOrder: false,
    }))
    const chartLabels = [
      textRegion(
        'coextensive-genuine-chart-label-a',
        'training',
        box(0.28, 0.19, 0.1, 0.014),
        'chart-label',
      ),
      textRegion(
        'coextensive-genuine-chart-label-b',
        'validation',
        box(0.5, 0.25, 0.1, 0.014),
        'chart-label',
      ),
    ]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Coextensive chart beneath repeated furniture.',
        box(0.16, 0.34, 0.68, 0.025),
      ),
      id: 'coextensive-furniture-figure-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: sourceBox,
            confidence: 0.99,
            assetId: sourceAssets[index].id,
          })),
          1,
          sourceAssets,
        ),
        page([], 2),
        page([], 3),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `coextensive-furniture-layer-region-${index + 1}`,
            id,
            sourceBox,
          ),
        ),
        runningHeader,
        ...repeatedHeaders,
        ...chartLabels,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 100,
          height: 60,
          pixels: new Uint8Array(100 * 60 * 4).fill(96),
        }),
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.label === 'Figure 1',
    )
    expect(relationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...sourceObjectIds,
        ...chartLabels.map((region) => `text-overlay:${region.id}`),
      ]),
      sourceLineIds: chartLabels.map((region) => region.lines[0].id),
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining([
            ...sourceObjectIds,
            ...chartLabels.map((region) => `text-overlay:${region.id}`),
          ]),
        }),
      ],
    })
    expect(relationship?.sourceObjectIds).not.toContain(
      `text-overlay:${runningHeader.id}`,
    )
    expect(relationship?.sourceRegionIds).not.toContain(runningHeader.id)
    expect(relationship?.sourceLineIds).not.toContain(runningHeader.lines[0].id)
    expect(
      relationship?.candidates.some((candidate) =>
        candidate.sourceObjectIds.includes(`text-overlay:${runningHeader.id}`),
      ),
    ).toBe(false)
    expect(result.consumedRegionIds.has(runningHeader.id)).toBe(false)
    expect(result.consumedLineIds.has(runningHeader.lines[0].id)).toBe(false)
  })
})
