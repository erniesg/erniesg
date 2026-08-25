import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

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

describe('PDF visual association graph', () => {
  it('reclaims reading-order labels only when coextensive native layers prove a caption-bounded figure', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.32)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.318)
    const firstLayer = sourcePreservedSvgAsset(
      'vector-p001-caption-scaffold-001',
      firstLayerBox,
    )
    const secondLayer = sourcePreservedSvgAsset(
      'vector-p001-caption-scaffold-002',
      secondLayerBox,
    )
    const internalLabels = textRegion(
      'ordered-internal-diagram-labels',
      'Input profile   Dialogue response   Aligned output',
      box(0.2, 0.18, 0.5, 0.035),
    )
    const internalOutcomes = textRegion(
      'ordered-internal-diagram-outcomes',
      'Local evidence   Owner checks   Final graph',
      box(0.2, 0.3, 0.5, 0.035),
    )
    const followingProse = textRegion(
      'following-prose-region',
      'Canonical prose after the figure remains in reading order.',
      box(0.12, 0.5, 0.76, 0.03),
    )
    const objects = [
      {
        id: 'vector-p001-caption-scaffold-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: firstLayer.id,
      },
      {
        id: 'vector-p001-caption-scaffold-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: secondLayer.id,
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 20,
          height: 10,
          pixels: new Uint8Array(20 * 10 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [firstLayer, secondLayer])],
      regions: [
        objectRegion(
          'caption-scaffold-region-001',
          objects[0].id,
          firstLayerBox,
        ),
        objectRegion(
          'caption-scaffold-region-002',
          objects[1].id,
          secondLayerBox,
        ),
        internalLabels,
        internalOutcomes,
        captionRegion(
          'Figure 1. A source-native layered framework diagram.',
          box(0.12, 0.44, 0.76, 0.025),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-caption-scaffold-001',
        'vector-p001-caption-scaffold-002',
        'text-overlay:ordered-internal-diagram-labels',
        'text-overlay:ordered-internal-diagram-outcomes',
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(internalLabels.id)).toBe(true)
    expect(result.consumedRegionIds.has(internalOutcomes.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('expands a proven layered panel to its caption lane before owning wide internal text', async () => {
    const firstLayerBox = box(0.2, 0.1, 0.25, 0.3)
    const secondLayerBox = box(0.201, 0.101, 0.248, 0.298)
    const objects = [
      {
        id: 'vector-p001-narrow-panel-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-narrow-panel-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const panelTitle = textRegion(
      'ordered-wide-panel-title',
      'Five stages writing theory',
      box(0.32, 0.14, 0.35, 0.025),
    )
    const panelText = textRegion(
      'ordered-wide-panel-text',
      'The complete panel explanation extends beyond the narrow native bounds.',
      box(0.14, 0.2, 0.7, 0.05),
    )
    const followingProse = textRegion(
      'wide-panel-following-prose',
      'Following article prose remains outside the figure.',
      box(0.12, 0.5, 0.76, 0.03),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('narrow-panel-region-001', objects[0].id, firstLayerBox),
        objectRegion('narrow-panel-region-002', objects[1].id, secondLayerBox),
        panelTitle,
        panelText,
        captionRegion(
          'Figure 1. A wide textual panel with narrow native bounds.',
          box(0.18, 0.42, 0.62, 0.025),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([panelTitle.id, panelText.id]),
    })
    expect(result.consumedRegionIds.has(panelTitle.id)).toBe(true)
    expect(result.consumedRegionIds.has(panelText.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('owns a large text block inside a proven layered prompt panel', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.32)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.318)
    const objects = [
      {
        id: 'vector-p001-large-prompt-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-large-prompt-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const promptHeading = textRegion(
      'ordered-large-prompt-heading',
      'Output',
      box(0.16, 0.14, 0.12, 0.025),
    )
    const promptBody = textRegion(
      'ordered-large-prompt-body',
      'A long source prompt occupies most of this boxed panel and must remain owned by its figure rather than leaking into article prose.',
      box(0.15, 0.18, 0.7, 0.2),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('large-prompt-region-001', objects[0].id, firstLayerBox),
        objectRegion('large-prompt-region-002', objects[1].id, secondLayerBox),
        promptHeading,
        promptBody,
        captionRegion(
          'Figure 1. A complete source prompt.',
          box(0.12, 0.44, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        promptHeading.id,
        promptBody.id,
      ]),
    })
    expect(result.consumedRegionIds.has(promptHeading.id)).toBe(true)
    expect(result.consumedRegionIds.has(promptBody.id)).toBe(true)
  })

  it('owns an arithmetic example inside a proven caption-bounded prompt panel', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.3)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.298)
    const firstLayer = sourcePreservedSvgAsset(
      'vector-p001-prompt-panel-001',
      firstLayerBox,
    )
    const secondLayer = sourcePreservedSvgAsset(
      'vector-p001-prompt-panel-002',
      secondLayerBox,
    )
    const promptHeading = textRegion(
      'ordered-prompt-heading',
      'Scoring example',
      box(0.2, 0.16, 0.22, 0.025),
    )
    const promptInstruction = textRegion(
      'ordered-prompt-instruction',
      'Count each accepted item in the bounded panel.',
      box(0.2, 0.21, 0.46, 0.025),
    )
    const arithmeticExample = textRegion(
      'ordered-arithmetic-example',
      '1 + 1 + 0 = 2',
      box(0.24, 0.27, 0.18, 0.025),
      'equation',
    )
    const objects = [
      {
        id: 'vector-p001-prompt-panel-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: firstLayer.id,
      },
      {
        id: 'vector-p001-prompt-panel-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: secondLayer.id,
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: input.kind === 'equation' ? 'equation' : 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [firstLayer, secondLayer])],
      regions: [
        objectRegion('prompt-panel-region-001', objects[0].id, firstLayerBox),
        objectRegion('prompt-panel-region-002', objects[1].id, secondLayerBox),
        promptHeading,
        promptInstruction,
        arithmeticExample,
        captionRegion(
          'Figure 11. A bounded scoring prompt and its worked example.',
          box(0.12, 0.42, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'figure',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        promptHeading.id,
        promptInstruction.id,
        arithmeticExample.id,
      ]),
      sourceObjectIds: expect.arrayContaining([
        `text-overlay:${arithmeticExample.id}`,
      ]),
    })
    expect(result.consumedRegionIds.has(arithmeticExample.id)).toBe(true)
  })

  it('keeps a numbered section heading out of caption-bounded visual ownership', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.3)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.298)
    const objects = [
      {
        id: 'vector-p001-chart-panel-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-chart-panel-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const chartLabel = textRegion(
      'bounded-chart-label',
      'Evil projection',
      box(0.25, 0.18, 0.16, 0.012),
      'chart-label',
    )
    const sectionHeading = textRegion(
      'following-section-heading',
      '6.2 SAMPLE-LEVEL DETECTION OF PROBLEMATIC DATA',
      box(0.12, 0.35, 0.5, 0.01),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('chart-panel-region-001', objects[0].id, firstLayerBox),
        objectRegion('chart-panel-region-002', objects[1].id, secondLayerBox),
        chartLabel,
        sectionHeading,
        captionRegion(
          'Figure 9. A caption-bounded chart above the next section.',
          box(0.12, 0.42, 0.76, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'figure',
      status: 'unresolved',
      candidates: [
        expect.objectContaining({
          sourceRegionIds: expect.arrayContaining([chartLabel.id]),
        }),
      ],
    })
    expect(result.relationships[0].candidates[0].sourceRegionIds).not.toContain(
      sectionHeading.id,
    )
    expect(result.consumedRegionIds.has(sectionHeading.id)).toBe(false)
  })

  it('reclaims chart text when one bounded scaffold contains four native layers', async () => {
    const scaffold = box(0.5, 0.08, 0.38, 0.14)
    const fragments = [
      box(0.57, 0.11, 0.27, 0.06),
      box(0.58, 0.115, 0.25, 0.012),
      box(0.58, 0.115, 0.25, 0.05),
      box(0.67, 0.13, 0.17, 0.025),
    ]
    const objects = [scaffold, ...fragments].map((sourceBox, index) => ({
      id: `vector-p001-contained-layer-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const title = textRegion(
      'ordered-chart-title',
      'Performance by threshold',
      box(0.61, 0.09, 0.2, 0.012),
    )
    const ticks = textRegion(
      'ordered-chart-ticks',
      '0 25 50 75 100',
      box(0.57, 0.18, 0.29, 0.012),
    )
    const axis = textRegion(
      'ordered-chart-axis',
      'Answer threshold',
      box(0.66, 0.2, 0.1, 0.01),
    )
    const followingProse = textRegion(
      'prose-after-contained-chart',
      'Canonical prose after the chart remains independent.',
      box(0.5, 0.34, 0.38, 0.025),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `contained-layer-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        title,
        ticks,
        axis,
        captionRegion(
          'Figure 1. A source-native chart with extracted labels.',
          box(0.5, 0.24, 0.38, 0.04),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        `text-overlay:${title.id}`,
        `text-overlay:${ticks.id}`,
        `text-overlay:${axis.id}`,
      ]),
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(title.id)).toBe(true)
    expect(result.consumedRegionIds.has(ticks.id)).toBe(true)
    expect(result.consumedRegionIds.has(axis.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('reclaims one short legend line when a dense caption-bounded chart proves its ownership', async () => {
    const scaffoldBox = box(0.12, 0.1, 0.34, 0.12)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.16 + (index % 4) * 0.07,
        0.12 + Math.floor(index / 4) * 0.055,
        0.035,
        0.025,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-chart-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffoldBox,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-chart-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const legend = textRegion(
      'ordered-single-line-chart-legend',
      'helix(a+b)',
      box(0.36, 0.135, 0.07, 0.012),
    )
    const seriesLabel = textRegion(
      'non-flow-chart-series-label',
      'DE',
      box(0.36, 0.16, 0.02, 0.01),
      'chart-label',
    )
    const followingProse = textRegion(
      'prose-after-chart-caption',
      'Canonical prose after the chart remains in reading order.',
      box(0.12, 0.31, 0.34, 0.025),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `chart-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        legend,
        seriesLabel,
        captionRegion(
          'Figure 7. Two source-native chart series.',
          box(0.12, 0.24, 0.34, 0.04),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        'text-overlay:ordered-single-line-chart-legend',
        'text-overlay:non-flow-chart-series-label',
      ]),
      evidence: expect.arrayContaining([
        'single-line-chart-overlay-source-owned',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-native-envelope-incomplete',
    )
    expect(result.consumedRegionIds.has(legend.id)).toBe(true)
    expect(result.consumedRegionIds.has(seriesLabel.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('forms the caption-bounded float envelope before trimming a prose-overlapping scaffold', async () => {
    const scaffold = box(0.1, 0.08, 0.8, 0.4)
    const fragmentBoxes = Array.from({ length: 4 }, (_, index) =>
      box(0.22 + index * 0.15, 0.24, 0.08, 0.1),
    )
    const objects = [
      {
        id: 'vector-p001-float-envelope-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-float-envelope-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const instructions = textRegion(
      'ordered-multiline-figure-instructions',
      'Step 1: translate arrows. Step 2: read the result.',
      box(0.22, 0.12, 0.56, 0.05),
    )
    instructions.lines = [
      {
        ...instructions.lines[0],
        id: 'ordered-multiline-figure-instructions-line-1',
        text: 'Step 1: translate arrows.',
        box: { ...instructions.lines[0].box, height: 0.02 },
      },
      {
        ...instructions.lines[0],
        id: 'ordered-multiline-figure-instructions-line-2',
        text: 'Step 2: read the result.',
        box: { ...instructions.lines[0].box, y: 0.145, height: 0.02 },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`float-envelope-region-${index}`, object.id, object.box),
        ),
        textRegion(
          'prose-crossing-scaffold',
          'Author names and affiliation remain prose.',
          box(0.02, 0.085, 0.52, 0.025),
        ),
        instructions,
        captionRegion(
          'Figure 1. Complete instructions and diagram.',
          box(0.16, 0.5, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0]![0].sourceBox.y).toBeLessThan(0.12)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...objects.slice(1).map((object) => object.id),
        'text-overlay:ordered-multiline-figure-instructions',
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-scaffold-trimmed-reading-order-overlap',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(instructions.id)).toBe(true)
  })

  it('fails closed when prose trimming would omit native material inside the float envelope', async () => {
    const scaffold = box(0.1, 0.1, 0.8, 0.38)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.22 + (index % 4) * 0.14,
        0.22 + Math.floor(index / 4) * 0.12,
        0.08,
        0.08,
      ),
    )
    const omittedGlyph = box(0.31, 0.27, 0.025, 0.025)
    const objects = [
      {
        id: 'vector-p001-incomplete-envelope-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-incomplete-envelope-glyph',
        page: 1,
        kind: 'vector' as const,
        box: omittedGlyph,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-incomplete-envelope-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
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
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `incomplete-envelope-region-${index}`,
            object.id,
            object.box,
          ),
        ),
        textRegion(
          'canonical-prose-crossing-native-glyph',
          'Canonical prose crossing one source glyph remains in reading order.',
          box(0.02, 0.26, 0.32, 0.045),
        ),
        captionRegion(
          'Figure 1. Native material must not disappear during trimming.',
          box(0.16, 0.5, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'source-native-envelope-incomplete',
        'source-rendition-unavailable',
      ]),
    })
  })
})
