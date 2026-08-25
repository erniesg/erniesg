import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { createPngAsset, createSourcePageCropAsset } from './visual-assets'

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

describe('PDF visual association graph', () => {
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

  it('keeps a fragmented figure unresolved when no browser rasterizer exists', async () => {
    const boxes = [
      box(0.2, 0.18, 0.12, 0.12),
      box(0.33, 0.18, 0.12, 0.12),
      box(0.46, 0.18, 0.12, 0.12),
      box(0.59, 0.18, 0.12, 0.12),
    ]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(result.relationships[0].evidence).toContain(
      'source-rendition-unavailable',
    )
  })

  it('matches a narrow caption to the complete connected diagram envelope', async () => {
    const scaffold = box(0.52, 0.25, 0.36, 0.24)
    const fragments = [
      box(0.525, 0.27, 0.03, 0.03),
      box(0.57, 0.31, 0.03, 0.03),
      box(0.64, 0.35, 0.03, 0.03),
      box(0.81, 0.43, 0.03, 0.03),
    ]
    const sourceBoxes = [scaffold, ...fragments]
    const objects = sourceBoxes.map((sourceBox, index) => ({
      id: `vector-p001-narrow-caption-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 72,
          height: 48,
          pixels: new Uint8Array(72 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `narrow-caption-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. High-level overview.',
          box(0.58, 0.5, 0.23, 0.02),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      label: 'Figure 1',
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
  })

  it('ignores a thin title-page rule without hiding bounded visual objects', async () => {
    const rule = box(0.18, 0.1, 0.65, 0.005)
    const figure = box(0.2, 0.6, 0.58, 0.23)
    const figureAsset = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: figure,
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(128),
    })
    const objects = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: rule,
        confidence: 0.98,
        assetId: 'asset-rule',
      },
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: figure,
        confidence: 0.98,
        assetId: figureAsset.id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset])],
      regions: [
        objectRegion('rule-region', objects[0].id, rule),
        objectRegion('figure-region', objects[1].id, figure),
        captionRegion(
          'Figure 1. Bounded source figure.',
          box(0.18, 0.84, 0.65, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-001'],
      assetIds: [figureAsset.id],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [rule],
        }),
      ]),
    )
  })

  it('does not require an interior short hairline to have a figure caption', async () => {
    const rule = box(0.2, 0.46, 0.03, 0.00001)
    const figure = box(0.2, 0.62, 0.58, 0.23)
    const figureAsset = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: figure,
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(128),
    })
    const objects = [
      {
        id: 'vector-p001-table-rule',
        page: 1,
        kind: 'vector' as const,
        box: rule,
        confidence: 0.98,
        assetId: 'asset-table-rule',
      },
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: figure,
        confidence: 0.98,
        assetId: figureAsset.id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset])],
      regions: [
        objectRegion('rule-region', objects[0].id, rule),
        objectRegion('figure-region', objects[1].id, figure),
      ],
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [rule],
        }),
      ]),
    )
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [figure],
        }),
      ]),
    )
  })
})
