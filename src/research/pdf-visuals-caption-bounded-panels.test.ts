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

  it('expands an edge-touching semantic crop only within neighboring source text', async () => {
    const ruleBoxes = [
      box(0.18, 0.1, 0.64, 0.002),
      box(0.18, 0.36, 0.64, 0.002),
      box(0.1, 0.1, 0.002, 0.262),
      box(0.898, 0.1, 0.002, 0.262),
    ]
    const objects = ruleBoxes.map((sourceBox, index) => ({
      id: `vector-p001-edge-rule-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const panelText = ['North', 'South', 'East', 'West'].map((text, index) =>
      textRegion(
        `edge-panel-label-${index + 1}`,
        text,
        box(
          0.22 + (index % 2) * 0.42,
          0.16 + Math.floor(index / 2) * 0.1,
          0.14,
          0.018,
        ),
        'chart-label',
      ),
    )
    const neighboringProse = textRegion(
      'edge-neighboring-prose',
      'Canonical prose remains outside the expanded visual crop.',
      box(0.03, 0.14, 0.05, 0.04),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (Math.abs(input.sourceBox.x - 0.085) > 0.0001) {
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
    const captionDraft = captionRegion(
      'Figure 1. Neighbor-bounded adaptive edge recovery.',
      box(0.1, 0.39, 0.8, 0.025),
    )
    const caption = {
      ...captionDraft,
      lines: textRegion(
        'edge-caption-source-line',
        captionDraft.text,
        captionDraft.box,
      ).lines,
    }

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`edge-rule-region-${index + 1}`, object.id, object.box),
        ),
        ...panelText,
        neighboringProse,
        caption,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure.mock.calls.length).toBeGreaterThan(2)
    const retainedCrop =
      rasterizeFigure.mock.calls[rasterizeFigure.mock.calls.length - 1][0]
        .sourceBox
    expect(retainedCrop.x).toBeCloseTo(0.085, 4)
    expect(retainedCrop.x).toBeGreaterThan(
      neighboringProse.box.x + neighboringProse.box.width,
    )
    expect(retainedCrop.y + retainedCrop.height).toBeLessThan(caption.box.y)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop-adaptive-caption-envelope',
        'source-page-crop',
      ]),
    })
    const retainedAsset = result.assets.find(
      (asset) => asset.id === result.relationships[0].assetIds[0],
    )
    expect(
      retainedAsset?.sourceCropAttempts?.map((attempt) => ({
        sequence: attempt.sequence,
        sourceBox: attempt.request.sourceBox,
        status: attempt.outcome.status,
      })),
    ).toEqual(
      rasterizeFigure.mock.calls.map(([input], index, calls) => ({
        sequence: index + 1,
        sourceBox: input.sourceBox,
        status: index === calls.length - 1 ? 'accepted' : 'edge-contact',
      })),
    )
    expect(result.consumedRegionIds.has(neighboringProse.id)).toBe(false)
  })

  it('rejects enclosed canonical prose while candidate-only children do not resolve coverage or hide a true orphan', async () => {
    const denseBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.12 + (index % 2) * 0.62,
        0.1 + Math.floor(index / 2) * 0.06,
        0.04,
        0.025,
      ),
    )
    const adversarialObjects = denseBoxes.map((sourceBox, index) => ({
      id: `vector-p001-adversarial-fragment-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const adversarialProse = textRegion(
      'adversarial-enclosed-prose',
      'This is ordinary continuous canonical prose, despite being fully enclosed by the tentative visual lane.',
      box(0.2, 0.18, 0.6, 0.06),
    )
    const adversarialLabels = ['A', 'B', 'C', 'D'].map((text, index) =>
      textRegion(
        `adversarial-non-flow-${index + 1}`,
        text,
        box(0.2 + index * 0.16, 0.29, 0.08, 0.015),
        'chart-label',
      ),
    )
    const validRuleBoxes = [
      box(0.18, 0.1, 0.64, 0.002, 2),
      box(0.18, 0.36, 0.64, 0.002, 2),
      box(0.1, 0.1, 0.002, 0.262, 2),
      box(0.898, 0.1, 0.002, 0.262, 2),
    ]
    const candidateOnlyObjects = validRuleBoxes.map((sourceBox, index) => ({
      id: `vector-p002-candidate-only-rule-${index + 1}`,
      page: 2,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const candidateOnlyLabels = ['One', 'Two', 'Three', 'Four'].map(
      (text, index) =>
        textRegion(
          `candidate-only-label-${index + 1}`,
          text,
          box(
            0.2 + (index % 2) * 0.4,
            0.16 + Math.floor(index / 2) * 0.1,
            0.16,
            0.018,
            2,
          ),
          'chart-label',
        ),
    )
    const orphanBox = box(0.2, 0.2, 0.2, 0.15, 3)
    const orphan = {
      id: 'image-p003-true-orphan',
      page: 3,
      kind: 'image' as const,
      box: orphanBox,
      confidence: 0.99,
      assetId: null,
    }
    const firstCaption = {
      ...captionRegion(
        'Figure 1. Tentative dense lane around ordinary prose.',
        box(0.08, 0.39, 0.84, 0.025),
      ),
      id: 'adversarial-caption',
    }
    const secondCaption = {
      ...captionRegion(
        'Figure 2. Valid source candidate without a retained rendition.',
        box(0.08, 0.39, 0.84, 0.025, 2),
      ),
      id: 'candidate-only-caption',
      page: 2,
    }
    const rasterizeFigure = vi.fn(
      async (_input: Parameters<PdfFigureRasterizer>[0]) => null,
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(adversarialObjects, 1),
        page(candidateOnlyObjects, 2),
        page([orphan], 3),
      ],
      regions: [
        ...adversarialObjects.map((object, index) =>
          objectRegion(
            `adversarial-fragment-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        adversarialProse,
        ...adversarialLabels,
        firstCaption,
        ...candidateOnlyObjects.map((object, index) =>
          objectRegion(
            `candidate-only-rule-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...candidateOnlyLabels,
        secondCaption,
        objectRegion('true-orphan-region', orphan.id, orphan.box),
      ],
      rasterizeFigure,
    })

    const adversarial = result.relationships.find(
      (relationship) => relationship.label === 'Figure 1',
    )!
    const candidateOnly = result.relationships.find(
      (relationship) => relationship.label === 'Figure 2',
    )!
    expect(adversarial.status).not.toBe('matched')
    expect(adversarial.sourceObjectIds).toEqual([])
    expect(adversarial.sourceText).toBe('')
    expect(result.consumedRegionIds.has(adversarialProse.id)).toBe(false)
    expect(rasterizeFigure.mock.calls.some(([input]) => input.page === 1)).toBe(
      false,
    )

    expect(candidateOnly.status).toBe('unresolved')
    expect(candidateOnly.sourceObjectIds).toEqual([])
    expect(candidateOnly.assetIds).toEqual([])
    expect(candidateOnly.candidates[0].sourceObjectIds).toEqual([
      ...candidateOnlyObjects.map((object) => object.id),
      ...candidateOnlyLabels.map((region) => `text-overlay:${region.id}`),
    ])
    const unreferencedMessages = result.diagnostics
      .filter((diagnostic) => diagnostic.code === 'UNREFERENCED_VISUAL_ASSET')
      .map((diagnostic) => diagnostic.message)
    expect(
      candidateOnlyObjects.some((object) =>
        unreferencedMessages.some((message) => message.includes(object.id)),
      ),
    ).toBe(false)
    expect(
      unreferencedMessages.some((message) => message.includes(orphan.id)),
    ).toBe(true)
  })

  it('uses an intervening caption to split overlapping composite scaffolds', async () => {
    const firstScaffold = box(0.05, 0.08, 0.9, 0.38)
    const secondScaffold = box(0.05, 0.4, 0.9, 0.36)
    const first = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: firstScaffold,
        confidence: 0.98,
        assetId: 'asset-first-scaffold',
      },
      ...[box(0.12, 0.14, 0.04, 0.03), box(0.78, 0.3, 0.04, 0.03)].map(
        (sourceBox, index) => ({
          id: `image-p001-00${index + 1}`,
          page: 1,
          kind: 'image' as const,
          box: sourceBox,
          confidence: 0.98,
          assetId: `asset-first-${index + 1}`,
        }),
      ),
    ]
    const second = [
      {
        id: 'vector-p001-002',
        page: 1,
        kind: 'vector' as const,
        box: secondScaffold,
        confidence: 0.98,
        assetId: 'asset-second-scaffold',
      },
      ...[box(0.14, 0.48, 0.04, 0.03), box(0.8, 0.67, 0.04, 0.03)].map(
        (sourceBox, index) => ({
          id: `image-p001-00${index + 3}`,
          page: 1,
          kind: 'image' as const,
          box: sourceBox,
          confidence: 0.98,
          assetId: `asset-second-${index + 1}`,
        }),
      ),
    ]
    const objects = [...first, ...second]

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`stacked-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. First bounded composite.',
          box(0.1, 0.38, 0.8, 0.02),
        ),
        captionRegion(
          'Figure 2. Second bounded composite.',
          box(0.1, 0.77, 0.8, 0.02),
        ),
      ],
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        label: 'Figure 1',
        status: 'unresolved',
        sourceObjectIds: [],
        candidates: expect.arrayContaining([
          expect.objectContaining({
            sourceObjectIds: first.map((object) => object.id),
          }),
        ]),
      }),
      expect.objectContaining({
        label: 'Figure 2',
        status: 'unresolved',
        sourceObjectIds: [],
        candidates: expect.arrayContaining([
          expect.objectContaining({
            sourceObjectIds: second.map((object) => object.id),
          }),
        ]),
      }),
    ])
  })

  it('ignores an opposite-column caption while preserving the same-lane caption boundary', async () => {
    const upperRuleBoxes = [
      box(0.52, 0.08, 0.46, 0.002),
      box(0.52, 0.26, 0.46, 0.002),
      box(0.52, 0.08, 0.002, 0.182),
      box(0.978, 0.08, 0.002, 0.182),
    ]
    const lowerRuleBoxes = [
      box(0.52, 0.34, 0.46, 0.002),
      box(0.52, 0.58, 0.46, 0.002),
      box(0.52, 0.34, 0.002, 0.242),
      box(0.978, 0.34, 0.002, 0.242),
    ]
    const upperObjects = upperRuleBoxes.map((sourceBox, index) => ({
      id: `vector-p001-upper-right-rule-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const lowerObjects = lowerRuleBoxes.map((sourceBox, index) => ({
      id: `vector-p001-lower-right-rule-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const labels = [
      ...[0.12, 0.16, 0.2, 0.24].map((y, index) =>
        textRegion(
          `upper-right-label-${index + 1}`,
          `Upper panel label ${index + 1}`,
          box(0.57, y, 0.34, 0.014),
          'chart-label',
        ),
      ),
      ...[0.39, 0.44, 0.49, 0.54].map((y, index) =>
        textRegion(
          `lower-right-label-${index + 1}`,
          `Lower panel label ${index + 1}`,
          box(0.57, y, 0.34, 0.014),
          'chart-label',
        ),
      ),
    ]
    const upperCaption = {
      ...captionRegion(
        'Figure 1. Upper right-column panel.',
        box(0.5, 0.3, 0.49, 0.02),
      ),
      id: 'upper-right-caption',
      column: 'right' as const,
    }
    const oppositeCaption = {
      ...captionRegion(
        'Figure 2. Independent left-column panel.',
        box(0.02, 0.4, 0.46, 0.02),
      ),
      id: 'opposite-left-caption',
      column: 'left' as const,
    }
    const lowerCaption = {
      ...captionRegion(
        'Figure 3. Lower right-column panel.',
        box(0.5, 0.62, 0.49, 0.02),
      ),
      id: 'lower-right-caption',
      column: 'right' as const,
    }
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
      pages: [page([...upperObjects, ...lowerObjects])],
      regions: [
        ...[...upperObjects, ...lowerObjects].map((object, index) =>
          objectRegion(
            `column-caption-rule-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...labels,
        upperCaption,
        oppositeCaption,
        lowerCaption,
      ],
      rasterizeFigure,
    })

    const upperRelationship = result.relationships.find(
      (relationship) => relationship.label === 'Figure 1',
    )
    const lowerRelationship = result.relationships.find(
      (relationship) => relationship.label === 'Figure 3',
    )
    expect(upperRelationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining(
        upperObjects.map((object) => object.id),
      ),
    })
    expect(lowerRelationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining(
        lowerObjects.map((object) => object.id),
      ),
    })
    expect(
      lowerRelationship?.sourceObjectIds.some((sourceObjectId) =>
        upperObjects.some((object) => object.id === sourceObjectId),
      ),
    ).toBe(false)
  })
})
