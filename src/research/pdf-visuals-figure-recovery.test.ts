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

function containsSourceBox(
  container: NormalizedSourceBox,
  candidate: NormalizedSourceBox,
  tolerance = 0.00001,
) {
  return (
    container.page === candidate.page &&
    container.rotation === candidate.rotation &&
    candidate.x >= container.x - tolerance &&
    candidate.y >= container.y - tolerance &&
    candidate.x + candidate.width <=
      container.x + container.width + tolerance &&
    candidate.y + candidate.height <= container.y + container.height + tolerance
  )
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

describe('PDF visual figure recovery', () => {
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

  it('keeps a top-of-chart numeric tick sequence inside its caption-bounded native figure', async () => {
    const scaffold = box(0.1, 0.084, 0.8, 0.19)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.16 + (index % 4) * 0.18,
        0.098 + Math.floor(index / 4) * 0.096,
        0.12,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-chart-tick-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-chart-tick-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const chartTicks = {
      ...textRegion(
        'side-classified-top-chart-ticks',
        '25 20 15',
        box(0.7, 0.092, 0.12, 0.012),
        'side',
      ),
      includedInReadingOrder: false,
    }
    chartTicks.lines = [
      {
        ...chartTicks.lines[0],
        box: chartTicks.box,
        runs: [0.7, 0.75, 0.8].map((x, index) => ({
          ...box(x, 0.092, 0.025, 0.012),
          method: 'pdf-text' as const,
          text: ['25', '20', '15'][index],
          fontName: 'ChartSans',
          fontSize: 8,
          confidence: 0.99,
        })),
      },
    ]
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
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `chart-tick-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        chartTicks,
        captionRegion(
          'Figure 3. Complete source chart with internal numeric axes.',
          box(0.12, 0.285, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        `text-overlay:${chartTicks.id}`,
      ]),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-native-envelope-incomplete',
    )
    expect(result.consumedRegionIds.has(chartTicks.id)).toBe(true)
  })

  it('still excludes one isolated extreme-margin page number from an overbroad figure scaffold', async () => {
    const scaffold = box(0.1, 0.035, 0.8, 0.3)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.2 + (index % 4) * 0.15,
        0.14 + Math.floor(index / 4) * 0.1,
        0.08,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-page-number-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-page-number-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const pageNumber = {
      ...textRegion(
        'side-classified-isolated-page-number',
        '17',
        box(0.48, 0.05, 0.025, 0.012),
        'side',
      ),
      includedInReadingOrder: false,
    }
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
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `page-number-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        pageNumber,
        captionRegion(
          'Figure 1. Native panel below the printed page number.',
          box(0.16, 0.36, 0.68, 0.025),
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
      'vector-p001-page-number-scaffold',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      `text-overlay:${pageNumber.id}`,
    )
    expect(result.consumedRegionIds.has(pageNumber.id)).toBe(false)
  })

  it('uses the caption width to complete a trimmed dense scaffold with non-flow labels', async () => {
    const scaffold = box(0.48, 0.12, 0.36, 0.36)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.52 + (index % 4) * 0.07,
        0.26 + Math.floor(index / 4) * 0.12,
        0.05,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-non-flow-overbroad-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-non-flow-fragment-${index + 1}`,
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
    const caption = captionRegion(
      'Figure 1. The caption and diagram share one bounded column.',
      box(0.5, 0.5, 0.36, 0.025),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `non-flow-scaffold-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        textRegion(
          'non-flow-author-line',
          'Author One, Author Two, University Laboratory',
          box(0.3, 0.17, 0.45, 0.035),
          'body',
        ),
        textRegion(
          'non-flow-diagram-label-one',
          'Premise',
          box(0.55, 0.27, 0.08, 0.015),
          'chart-label',
        ),
        textRegion(
          'non-flow-diagram-label-two',
          'Write content',
          box(0.68, 0.39, 0.09, 0.015),
          'side',
        ),
        caption,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const sourceBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(sourceBox.x).toBeLessThanOrEqual(caption.box.x)
    expect(sourceBox.x + sourceBox.width).toBeGreaterThanOrEqual(
      caption.box.x + caption.box.width,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-scaffold-trimmed-reading-order-overlap',
        'source-page-crop',
      ]),
    })
  })

  it('claims an adjacent non-flow title above a proven caption-bounded scaffold', async () => {
    const ruleBoxes = [
      box(0.18, 0.18, 0.64, 0.002),
      box(0.18, 0.35, 0.64, 0.002),
      box(0.18, 0.18, 0.002, 0.172),
      box(0.818, 0.18, 0.002, 0.172),
    ]
    const objects = ruleBoxes.map((sourceBox, index) => ({
      id: `vector-p001-titled-rule-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const title = textRegion(
      'caption-lane-panel-title',
      'Reasoning modules',
      box(0.28, 0.145, 0.44, 0.018),
      'chart-label',
    )
    const panelLabels = [
      textRegion(
        'titled-panel-label-one',
        'Retrieve evidence',
        box(0.24, 0.22, 0.2, 0.018),
        'chart-label',
      ),
      textRegion(
        'titled-panel-label-two',
        'Compose response',
        box(0.56, 0.22, 0.2, 0.018),
        'chart-label',
      ),
      textRegion(
        'titled-panel-label-three',
        'Verify output',
        box(0.4, 0.3, 0.2, 0.018),
        'chart-label',
      ),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `titled-rule-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        title,
        ...panelLabels,
        captionRegion(
          'Figure 1. One titled semantic panel.',
          box(0.12, 0.38, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeLessThanOrEqual(
      title.box.y,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        `text-overlay:${title.id}`,
      ]),
      evidence: expect.arrayContaining([
        'caption-bounded-non-flow-title',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(title.id)).toBe(true)
  })

  it('reconstructs one disconnected ruled panel with exact native and text child lineage', async () => {
    const ruleBoxes = [
      box(0.18, 0.1, 0.64, 0.002),
      box(0.18, 0.36, 0.64, 0.002),
      box(0.1, 0.1, 0.002, 0.262),
      box(0.898, 0.1, 0.002, 0.262),
    ]
    const objects = ruleBoxes.map((sourceBox, index) => ({
      id: `vector-p001-disconnected-rule-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const unrelatedObject = {
      id: 'image-p001-unrelated-object',
      page: 1,
      kind: 'image' as const,
      box: box(0.03, 0.2, 0.04, 0.04),
      confidence: 0.99,
      assetId: null,
    }
    const panelText = [
      textRegion(
        'disconnected-panel-flow-one',
        'Panel-owned explanation one',
        box(0.2, 0.16, 0.25, 0.018),
      ),
      textRegion(
        'disconnected-panel-flow-two',
        'Panel-owned explanation two',
        box(0.55, 0.16, 0.25, 0.018),
      ),
      textRegion(
        'disconnected-panel-label-one',
        'Input state',
        box(0.2, 0.27, 0.16, 0.018),
        'chart-label',
      ),
      textRegion(
        'disconnected-panel-label-two',
        'Output state',
        box(0.64, 0.27, 0.16, 0.018),
        'chart-label',
      ),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([...objects, unrelatedObject])],
      regions: [
        ...[...objects, unrelatedObject].map((object, index) =>
          objectRegion(
            `disconnected-rule-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        captionRegion(
          'Figure 1. One disconnected ruled semantic panel.',
          box(0.08, 0.39, 0.84, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...objects.map((object) => object.id),
        ...panelText.map((region) => `text-overlay:${region.id}`),
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-semantic-envelope',
        'caption-bounded-rule-scaffold',
        'caption-bounded-unique-text-ownership',
        'source-page-crop',
      ]),
    })
    expect(
      panelText.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
    for (const region of panelText) {
      expect(
        result.relationships[0].sourceText.split(region.text),
      ).toHaveLength(2)
    }
    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.sourceBoxes?.some((sourceBox) =>
            ruleBoxes.some((ruleBox) => containsSourceBox(ruleBox, sourceBox)),
          ),
      ),
    ).toEqual([])
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      unrelatedObject.id,
    )
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(unrelatedObject.id),
      ),
    ).toBe(true)
  })

  it('keeps two stacked caption-bounded panels separate with disjoint child lineage', async () => {
    const panelObjects = (prefix: string, top: number, bottom: number) =>
      [
        box(0.18, top, 0.64, 0.002),
        box(0.18, bottom, 0.64, 0.002),
        box(0.1, top, 0.002, bottom - top + 0.002),
        box(0.898, top, 0.002, bottom - top + 0.002),
      ].map((sourceBox, index) => ({
        id: `vector-p001-${prefix}-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      }))
    const firstObjects = panelObjects('stacked-first', 0.06, 0.27)
    const secondObjects = panelObjects('stacked-second', 0.4, 0.61)
    const panelText = (prefix: string, top: number) => [
      textRegion(
        `${prefix}-flow`,
        `${prefix} panel explanation`,
        box(0.2, top + 0.05, 0.3, 0.018),
      ),
      ...['Input', 'Transform', 'Output'].map((text, index) =>
        textRegion(
          `${prefix}-label-${index + 1}`,
          `${prefix} ${text}`,
          box(0.2 + index * 0.22, top + 0.13, 0.16, 0.018),
          'chart-label',
        ),
      ),
    ]
    const firstText = panelText('first', 0.06)
    const secondText = panelText('second', 0.4)
    const firstCaption = {
      ...captionRegion(
        'Figure 1. First independent ruled panel.',
        box(0.08, 0.3, 0.84, 0.025),
      ),
      id: 'stacked-caption-first',
    }
    const secondCaption = {
      ...captionRegion(
        'Figure 2. Second independent ruled panel.',
        box(0.08, 0.64, 0.84, 0.025),
      ),
      id: 'stacked-caption-second',
    }
    const objects = [...firstObjects, ...secondObjects]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `stacked-bounded-rule-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...firstText,
        firstCaption,
        ...secondText,
        secondCaption,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    const first = result.relationships.find(
      (relationship) => relationship.label === 'Figure 1',
    )!
    const second = result.relationships.find(
      (relationship) => relationship.label === 'Figure 2',
    )!
    expect(first.status).toBe('matched')
    expect(second.status).toBe('matched')
    expect(first.sourceObjectIds).toEqual([
      ...firstObjects.map((object) => object.id),
      ...firstText.map((region) => `text-overlay:${region.id}`),
    ])
    expect(second.sourceObjectIds).toEqual([
      ...secondObjects.map((object) => object.id),
      ...secondText.map((region) => `text-overlay:${region.id}`),
    ])
    expect(
      first.sourceObjectIds.some((sourceObjectId) =>
        second.sourceObjectIds.includes(sourceObjectId),
      ),
    ).toBe(false)
    expect(first.sourceText).not.toContain('second panel')
    expect(second.sourceText).not.toContain('first panel')
  })

  it('keeps a disconnected singleton outside a dense caption-bounded grid', async () => {
    const gridBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.2 + (index % 2) * 0.3,
        0.1 + Math.floor(index / 2) * 0.07,
        0.03,
        0.03,
      ),
    )
    const gridObjects = gridBoxes.map((sourceBox, index) => ({
      id: `image-p001-dense-grid-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const unrelatedObject = {
      id: 'image-p001-dense-grid-unrelated',
      page: 1,
      kind: 'image' as const,
      box: box(0.85, 0.2, 0.03, 0.03),
      confidence: 0.99,
      assetId: null,
    }
    const panelText = ['Input', 'Plan', 'Draft', 'Output'].map((text, index) =>
      textRegion(
        `dense-grid-label-${index + 1}`,
        text,
        box(
          0.22 + (index % 2) * 0.3,
          0.145 + Math.floor(index / 2) * 0.14,
          0.12,
          0.018,
        ),
        'chart-label',
      ),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        }),
    )
    const allObjects = [...gridObjects, unrelatedObject]

    const result = await reconstructPdfVisuals({
      pages: [page(allObjects)],
      regions: [
        ...allObjects.map((object, index) =>
          objectRegion(
            `dense-grid-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        captionRegion(
          'Figure 1. One dense disconnected semantic grid.',
          box(0.08, 0.39, 0.84, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...gridObjects.map((object) => object.id),
        ...panelText.map((region) => `text-overlay:${region.id}`),
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-semantic-envelope',
        'caption-bounded-envelope-proof',
      ]),
    })
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      unrelatedObject.id,
    )
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(unrelatedObject.id),
      ),
    ).toBe(true)
  })

  it('uses repeated coextensive backdrop layers to bind a full-width dense panel', async () => {
    const backdropBox = box(0, 0.08, 1, 0.75)
    const backdropObjects = ['a', 'b'].map((suffix, index) => ({
      id: `vector-p001-reused-panel-${suffix}`,
      page: 1,
      kind: 'vector' as const,
      box: {
        ...backdropBox,
        height: backdropBox.height - index * Number.EPSILON,
      },
      confidence: 0.99,
      assetId: null as string | null,
    }))
    const backdropAssets = await Promise.all(
      backdropObjects.map((object) =>
        solidRectangleFallbackAsset(object.id, object.box),
      ),
    )
    backdropObjects.forEach((object, index) => {
      object.assetId = backdropAssets[index].id
    })
    const repeatedBackdropObjects = backdropObjects.map((object) => ({
      ...object,
      id: object.id.replace('p001', 'p002'),
      page: 2,
      box: { ...object.box, page: 2 },
    }))
    const repeatedBackdropAssets = backdropAssets.map((asset, index) => ({
      ...asset,
      sourceObjectIds: [repeatedBackdropObjects[index].id],
      sourceBoxes: [repeatedBackdropObjects[index].box],
    }))
    const gridObjects = Array.from({ length: 9 }, (_, index) => ({
      id: `image-p001-full-width-grid-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: box(
        [0.1, 0.475, 0.85][index % 3],
        0.18 + Math.floor(index / 3) * 0.17,
        0.05,
        0.05,
      ),
      confidence: 0.99,
      assetId: null,
    }))
    const panelText = Array.from({ length: 4 }, (_, index) =>
      textRegion(
        `full-width-panel-label-${index + 1}`,
        `Panel label ${index + 1}`,
        box(0.14 + (index % 2) * 0.42, 0.12 + index * 0.13, 0.18, 0.018),
        'chart-label',
      ),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 120,
          height: 80,
          pixels: new Uint8Array(120 * 80 * 4).fill(72),
        }),
    )
    const pageOneObjects = [...backdropObjects, ...gridObjects]

    const result = await reconstructPdfVisuals({
      pages: [
        page(pageOneObjects, 1, backdropAssets),
        page(repeatedBackdropObjects, 2, repeatedBackdropAssets),
      ],
      regions: [
        ...pageOneObjects.map((object, index) =>
          objectRegion(
            `full-width-panel-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        captionRegion(
          'Figure 1. A full-width repeated-layer panel.',
          box(0.275, 0.72, 0.45, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...gridObjects.map((object) => object.id),
        ...panelText.map((region) => `text-overlay:${region.id}`),
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-semantic-envelope',
        'caption-bounded-reused-layer-grid-scaffold',
      ]),
    })
    expect(
      result.relationships[0].sourceObjectIds.some((sourceObjectId) =>
        backdropObjects.some((object) => object.id === sourceObjectId),
      ),
    ).toBe(false)
    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          gridObjects.some((object) => diagnostic.message.includes(object.id)),
      ),
    ).toEqual([])
  })

  it('keeps proved caption-bounded grid recovery ahead of a complete-lineage retry', async () => {
    const backdropBox = box(0, 0.06, 1, 0.68)
    const backdropObjects = ['a', 'b'].map((suffix, index) => ({
      id: `vector-p001-recovery-backdrop-${suffix}`,
      page: 1,
      kind: 'vector' as const,
      box: {
        ...backdropBox,
        height: backdropBox.height - index * Number.EPSILON,
      },
      confidence: 0.99,
      assetId: null as string | null,
    }))
    const backdropAssets = await Promise.all(
      backdropObjects.map((object) =>
        solidRectangleFallbackAsset(object.id, object.box),
      ),
    )
    backdropObjects.forEach((object, index) => {
      object.assetId = backdropAssets[index].id
    })
    const repeatedBackdropObjects = backdropObjects.map((object) => ({
      ...object,
      id: object.id.replace('p001', 'p002'),
      page: 2,
      box: { ...object.box, page: 2 },
    }))
    const repeatedBackdropAssets = backdropAssets.map((asset, index) => ({
      ...asset,
      sourceObjectIds: [repeatedBackdropObjects[index].id],
      sourceBoxes: [repeatedBackdropObjects[index].box],
    }))
    const gridObjects = Array.from({ length: 9 }, (_, index) => ({
      id: `image-p001-recovery-grid-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: box(
        [0.1, 0.475, 0.85][index % 3],
        0.16 + Math.floor(index / 3) * 0.16,
        0.05,
        0.05,
      ),
      confidence: 0.99,
      assetId: null,
    }))
    const panelText = Array.from({ length: 4 }, (_, index) =>
      textRegion(
        `recovery-grid-label-${index + 1}`,
        `Grid label ${index + 1}`,
        box(0.14 + (index % 2) * 0.42, 0.2 + index * 0.1, 0.18, 0.018),
        'chart-label',
      ),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const synthetic = input.sourceObjectIds[0].startsWith('source-panel:')
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds:
            synthetic || input.tightenToSourceInk === false
              ? input.sourceObjectIds
              : input.sourceObjectIds.slice(1),
          sourceBoxes:
            synthetic || input.tightenToSourceInk === false
              ? input.sourceBoxes
              : input.sourceBoxes.slice(1),
          width: 120,
          height: 80,
          pixels: new Uint8Array(120 * 80 * 4).fill(72),
        })
      },
    )
    const pageOneObjects = [...backdropObjects, ...gridObjects]

    const result = await reconstructPdfVisuals({
      pages: [
        page(pageOneObjects, 1, backdropAssets),
        page(repeatedBackdropObjects, 2, repeatedBackdropAssets),
      ],
      regions: [
        ...pageOneObjects.map((object, index) =>
          objectRegion(
            `recovery-grid-object-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        captionRegion(
          'Figure 1. A proved reused-layer grid.',
          box(0.275, 0.7, 0.45, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.some(([input]) =>
        input.sourceObjectIds[0].startsWith('source-panel:'),
      ),
    ).toBe(true)
    expect(
      rasterizeFigure.mock.calls.some(
        ([input]) => input.tightenToSourceInk === false,
      ),
    ).toBe(false)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:caption-region'],
      evidence: expect.arrayContaining([
        'caption-bounded-reused-layer-grid-scaffold',
        'caption-bounded-reused-grid-recovery',
        'source-panel-synthetic-crop-lineage',
        'source-page-crop',
      ]),
    })
  })

  it('recovers a caption-owned multipart raster only after exact lineage rejection', async () => {
    const nativeObjects = [
      {
        id: 'image-p001-multipart-recovery-1',
        page: 1,
        kind: 'image' as const,
        box: box(0.18, 0.07, 0.64, 0.17),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'image-p001-multipart-recovery-2',
        page: 1,
        kind: 'image' as const,
        box: box(0.185, 0.075, 0.63, 0.16),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-multipart-recovery-whitespace-separated-top-band',
        page: 1,
        kind: 'vector' as const,
        box: box(0.22, 0.035, 0.56, 0.02),
        confidence: 0.99,
        assetId: null,
      },
    ]
    const overlayRegions = [
      textRegion(
        'multipart-recovery-label-1',
        'First owned panel label',
        box(0.24, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'multipart-recovery-label-2',
        'Second owned panel label',
        box(0.56, 0.16, 0.2, 0.018),
      ),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const synthetic = input.sourceObjectIds[0].startsWith('source-panel:')
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: synthetic
            ? input.sourceObjectIds
            : input.sourceObjectIds.slice(1),
          sourceBoxes: synthetic
            ? input.sourceBoxes
            : input.sourceBoxes.slice(1),
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(nativeObjects)],
      regions: [
        ...nativeObjects.map((object, index) =>
          objectRegion(
            `multipart-recovery-object-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...overlayRegions,
        captionRegion(
          'Figure 1. Two raster panels in one exact caption lane.',
          box(0.18, 0.26, 0.64, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    const recoveryInput = rasterizeFigure.mock.calls
      .map(([input]) => input)
      .find((input) => input.sourceObjectIds[0].startsWith('source-panel:'))
    expect(recoveryInput).toBeDefined()
    expect(recoveryInput?.sourceBox.y).toBe(0.035)
    expect(
      nativeObjects.every(
        (object) =>
          recoveryInput !== undefined &&
          recoveryInput.sourceBox.x <= object.box.x &&
          recoveryInput.sourceBox.y <= object.box.y &&
          recoveryInput.sourceBox.x + recoveryInput.sourceBox.width >=
            object.box.x + object.box.width &&
          recoveryInput.sourceBox.y + recoveryInput.sourceBox.height >=
            object.box.y + object.box.height,
      ),
    ).toBe(true)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:caption-region'],
      evidence: expect.arrayContaining([
        'caption-bounded-multipart-raster-recovery',
        'source-panel-synthetic-crop-lineage',
        'source-page-crop',
      ]),
    })
    expect(
      overlayRegions.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
  })

  it('does not synthesize multipart recovery from only one raster component', async () => {
    const nativeObjects = [
      {
        id: 'image-p001-single-raster-recovery',
        page: 1,
        kind: 'image' as const,
        box: box(0.18, 0, 0.64, 0.24),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-single-raster-recovery',
        page: 1,
        kind: 'vector' as const,
        box: box(0.185, 0.005, 0.63, 0.23),
        confidence: 0.99,
        assetId: null,
      },
    ]
    const overlayRegions = [
      textRegion(
        'single-raster-recovery-label-1',
        'First panel label',
        box(0.24, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'single-raster-recovery-label-2',
        'Second panel label',
        box(0.56, 0.16, 0.2, 0.018),
      ),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds.slice(1),
          sourceBoxes: input.sourceBoxes.slice(1),
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(nativeObjects)],
      regions: [
        ...nativeObjects.map((object, index) =>
          objectRegion(
            `single-raster-recovery-object-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...overlayRegions,
        captionRegion(
          'Figure 1. One raster is not a proved multipart source.',
          box(0.18, 0.26, 0.64, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.some(([input]) =>
        input.sourceObjectIds[0].startsWith('source-panel:'),
      ),
    ).toBe(false)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      evidence: expect.not.arrayContaining([
        'caption-bounded-multipart-raster-recovery',
      ]),
    })
  })

  it('does not synthesize multipart recovery across unclaimed prose', async () => {
    const nativeObjects = [
      {
        id: 'image-p001-prose-veto-1',
        page: 1,
        kind: 'image' as const,
        box: box(0.18, 0, 0.64, 0.24),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'image-p001-prose-veto-2',
        page: 1,
        kind: 'image' as const,
        box: box(0.185, 0.005, 0.63, 0.23),
        confidence: 0.99,
        assetId: null,
      },
    ]
    const overlays = [
      textRegion(
        'prose-veto-label-1',
        'First panel label',
        box(0.24, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'prose-veto-label-2',
        'Second panel label',
        box(0.56, 0.16, 0.2, 0.018),
      ),
    ]
    const unclaimedHeading = textRegion(
      'prose-veto-heading',
      '2. METHODS AND RESULTS',
      box(0.3, 0.12, 0.2, 0.03),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (!input.sourceObjectIds[0].startsWith('source-panel:')) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(nativeObjects)],
      regions: [
        ...nativeObjects.map((object, index) =>
          objectRegion(`prose-veto-object-${index + 1}`, object.id, object.box),
        ),
        ...overlays,
        unclaimedHeading,
        captionRegion(
          'Figure 1. Unclaimed prose prevents synthetic recovery.',
          box(0.18, 0.26, 0.64, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.some(([input]) =>
        input.sourceObjectIds[0].startsWith('source-panel:'),
      ),
    ).toBe(false)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
      ]),
    })
    expect(result.consumedRegionIds.has(unclaimedHeading.id)).toBe(false)
  })

  it('keeps a disconnected singleton outside coextensive caption-bounded layers', async () => {
    const layerBoxes = [
      box(0.2, 0.1, 0.5, 0.2),
      box(0.205, 0.105, 0.49, 0.19),
      box(0.21, 0.11, 0.48, 0.18),
    ]
    const layerObjects = layerBoxes.map((sourceBox, index) => ({
      id: `image-p001-coextensive-layer-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const unrelatedObject = {
      id: 'image-p001-coextensive-unrelated',
      page: 1,
      kind: 'image' as const,
      box: box(0.85, 0.2, 0.03, 0.03),
      confidence: 0.99,
      assetId: null,
    }
    const panelText = ['Input', 'Plan', 'Draft', 'Output'].map((text, index) =>
      textRegion(
        `coextensive-layer-label-${index + 1}`,
        text,
        box(
          0.24 + (index % 2) * 0.25,
          0.15 + Math.floor(index / 2) * 0.08,
          0.12,
          0.018,
        ),
        'chart-label',
      ),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        }),
    )
    const allObjects = [...layerObjects, unrelatedObject]

    const result = await reconstructPdfVisuals({
      pages: [page(allObjects)],
      regions: [
        ...allObjects.map((object, index) =>
          objectRegion(
            `coextensive-layer-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        captionRegion(
          'Figure 1. One coextensive layered semantic panel.',
          box(0.08, 0.39, 0.84, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...layerObjects.map((object) => object.id),
        ...panelText.map((region) => `text-overlay:${region.id}`),
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-semantic-envelope',
        'caption-bounded-coextensive-layer',
      ]),
    })
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      unrelatedObject.id,
    )
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(unrelatedObject.id),
      ),
    ).toBe(true)
  })
})
