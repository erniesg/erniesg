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
  it('owns only render-contained overlays when a strong figure rendition remains unresolved', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const firstAsset = sourcePreservedSvgAsset(
      'vector-p001-contained-overlay-a',
      sourceBox,
    )
    const secondAsset = sourcePreservedSvgAsset(
      'vector-p001-contained-overlay-b',
      sourceBox,
    )
    const containedOverlays = [
      textRegion('contained-overlay-a', 'alpha', box(0.3, 0.205, 0.06, 0.012)),
      textRegion('contained-overlay-b', 'beta', box(0.3, 0.22, 0.08, 0.012)),
      textRegion('contained-overlay-c', 'gamma', box(0.3, 0.235, 0.09, 0.012)),
    ]
    const outsideRenderOverlay = textRegion(
      'outside-render-overlay',
      'neighboring table row',
      box(0.3, 0.177, 0.12, 0.012),
    )
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Contained overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'contained-overlay-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-contained-overlay-a',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: firstAsset.id,
            },
            {
              id: 'vector-p001-contained-overlay-b',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: secondAsset.id,
            },
          ],
          1,
          [firstAsset, secondAsset],
        ),
      ],
      regions: [
        objectRegion(
          'contained-overlay-vector-a',
          'vector-p001-contained-overlay-a',
          sourceBox,
        ),
        objectRegion(
          'contained-overlay-vector-b',
          'vector-p001-contained-overlay-b',
          sourceBox,
        ),
        outsideRenderOverlay,
        ...containedOverlays,
        figureCaption,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'unresolved',
        sourceRegionIds: containedOverlays.map((region) => region.id),
        sourceLineIds: containedOverlays.map((region) => region.lines[0].id),
        sourceText: 'alpha beta gamma',
        sourceBoxes: [
          figureCaption.box,
          ...containedOverlays.map((region) => region.box),
        ],
        evidence: expect.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
          'unresolved-visual-text-owned',
          'source-rendition-unavailable',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(outsideRenderOverlay.id)).toBe(false)
    expect(
      containedOverlays.every((region) =>
        result.consumedRegionIds.has(region.id),
      ),
    ).toBe(true)
  })

  it('retains only contained lines from a partially enclosed figure overlay region', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-partial-overlay-a',
      'vector-p001-partial-overlay-b',
      'vector-p001-partial-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const partialOverlay = textRegion(
      'partial-overlay-region',
      'outside label inside alpha inside beta',
      box(0.3, 0.1772, 0.12, 0.06),
    )
    const overlayLine = (
      id: string,
      text: string,
      sourceLineBox: NormalizedSourceBox,
    ) => {
      const textBox = { ...sourceLineBox, method: 'pdf-text' as const }
      return {
        id,
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
      }
    }
    const outsideLine = overlayLine(
      'partial-overlay-outside-line',
      'outside label',
      box(0.3, 0.1772, 0.12, 0.004),
    )
    const containedLines = [
      overlayLine(
        'partial-overlay-inside-line-a',
        'inside alpha',
        box(0.3, 0.205, 0.12, 0.012),
      ),
      overlayLine(
        'partial-overlay-inside-line-b',
        'inside beta',
        box(0.3, 0.225, 0.12, 0.012),
      ),
    ]
    partialOverlay.lines = [outsideLine, ...containedLines]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Partial overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'partial-overlay-caption',
    }
    const retainedOverlayBox = {
      ...box(0.3, 0.205, 0.12, 0.032),
      method: 'pdf-text' as const,
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `partial-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        partialOverlay,
        figureCaption,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'unresolved',
        sourceRegionIds: [partialOverlay.id],
        sourceLineIds: containedLines.map((line) => line.id),
        sourceText: 'inside alpha inside beta',
        sourceBoxes: [figureCaption.box, retainedOverlayBox],
        evidence: expect.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
          'unresolved-visual-text-owned',
          'source-rendition-unavailable',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(partialOverlay.id)).toBe(false)
    expect(result.consumedLineIds.has(outsideLine.id)).toBe(false)
    expect(
      containedLines.every((line) => result.consumedLineIds.has(line.id)),
    ).toBe(true)
  })

  it('consumes only retained lines from a partially enclosed matched figure overlay', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-matched-partial-overlay-a',
      'vector-p001-matched-partial-overlay-b',
      'vector-p001-matched-partial-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const partialOverlay = textRegion(
      'matched-partial-overlay-region',
      'outside label inside alpha inside beta',
      box(0.3, 0.1772, 0.12, 0.06),
    )
    const overlayLine = (
      id: string,
      text: string,
      sourceLineBox: NormalizedSourceBox,
    ) => {
      const textBox = { ...sourceLineBox, method: 'pdf-text' as const }
      return {
        id,
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
      }
    }
    const outsideLine = overlayLine(
      'matched-partial-overlay-outside-line',
      'outside label',
      box(0.3, 0.1772, 0.12, 0.004),
    )
    const containedLines = [
      overlayLine(
        'matched-partial-overlay-inside-line-a',
        'inside alpha',
        box(0.3, 0.205, 0.12, 0.012),
      ),
      overlayLine(
        'matched-partial-overlay-inside-line-b',
        'inside beta',
        box(0.3, 0.225, 0.12, 0.012),
      ),
    ]
    partialOverlay.lines = [outsideLine, ...containedLines]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Matched partial overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'matched-partial-overlay-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `matched-partial-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        partialOverlay,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        }),
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([partialOverlay.id]),
        sourceLineIds: containedLines.map((line) => line.id),
        sourceText: 'inside alpha inside beta',
        evidence: expect.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
          'source-page-crop',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(partialOverlay.id)).toBe(false)
    expect(result.consumedLineIds.has(outsideLine.id)).toBe(false)
    expect(
      containedLines.every((line) => result.consumedLineIds.has(line.id)),
    ).toBe(true)
  })

  it('records exact line atoms when every matched figure overlay is retained', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-complete-overlay-a',
      'vector-p001-complete-overlay-b',
      'vector-p001-complete-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const overlays = [
      textRegion(
        'complete-overlay-a',
        'inside alpha',
        box(0.3, 0.205, 0.12, 0.012),
      ),
      textRegion(
        'complete-overlay-b',
        'inside beta',
        box(0.3, 0.225, 0.12, 0.012),
      ),
    ]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Complete overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'complete-overlay-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `complete-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        ...overlays,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        }),
    })

    const expectedLineIds = overlays.map((region) => region.lines[0].id)
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'matched',
        sourceLineIds: expectedLineIds,
        sourceText: 'inside alpha inside beta',
        evidence: expect.not.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
        ]),
        candidates: [
          expect.objectContaining({
            sourceLineIds: expectedLineIds,
            sourceText: 'inside alpha inside beta',
          }),
        ],
      }),
    ])
    expect(
      overlays.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
  })

  it('does not give contested unresolved figure overlays to either caption', async () => {
    const sourceBox = box(0.2, 0.18, 0.36, 0.12)
    const sourceObjectIds = [
      'vector-p001-contested-overlay-a',
      'vector-p001-contested-overlay-b',
    ]
    const assets = sourceObjectIds.map((sourceObjectId) =>
      sourcePreservedSvgAsset(sourceObjectId, sourceBox),
    )
    const overlays = [
      textRegion(
        'contested-overlay-a',
        'shared alpha',
        box(0.27, 0.21, 0.09, 0.012),
      ),
      textRegion(
        'contested-overlay-b',
        'shared beta',
        box(0.39, 0.24, 0.09, 0.012),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. First possible owner.',
          box(0.2, 0.32, 0.36, 0.02),
        ),
        id: 'contested-overlay-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Second possible owner.',
          box(0.2, 0.355, 0.36, 0.02),
        ),
        id: 'contested-overlay-caption-b',
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: sourceBox,
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(`contested-overlay-vector-${index + 1}`, id, sourceBox),
        ),
        ...overlays,
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    for (const [index, relationship] of result.relationships.entries()) {
      expect(relationship).toMatchObject({
        kind: 'figure',
        captionRegionId: captions[index].id,
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
        sourceBoxes: [captions[index].box],
      })
      expect(relationship.evidence).not.toContain(
        'unresolved-visual-text-owned',
      )
    }
    expect(
      overlays.every(
        (region) =>
          !result.consumedRegionIds.has(region.id) &&
          !result.consumedLineIds.has(region.lines[0].id),
      ),
    ).toBe(true)
  })

  it('does not split duplicate overlay lineage between semantic and connected candidates', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-cross-candidate-overlay-a',
      'vector-p001-cross-candidate-overlay-b',
      'vector-p001-cross-candidate-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const overlays = [
      textRegion(
        'cross-candidate-overlay-a',
        'shared alpha',
        box(0.26, 0.205, 0.09, 0.012),
      ),
      textRegion(
        'cross-candidate-overlay-b',
        'shared beta',
        box(0.38, 0.22, 0.09, 0.012),
      ),
      textRegion(
        'cross-candidate-overlay-c',
        'shared gamma',
        box(0.5, 0.235, 0.09, 0.012),
      ),
      textRegion(
        'cross-candidate-overlay-d',
        'shared delta',
        box(0.32, 0.255, 0.12, 0.012),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. Semantic-envelope owner.',
          box(0.2, 0.32, 0.5, 0.02),
        ),
        id: 'cross-candidate-overlay-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Connected-scaffold owner.',
          box(0.2, 0.355, 0.5, 0.02),
        ),
        id: 'cross-candidate-overlay-caption-b',
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `cross-candidate-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        ...overlays,
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    expect(result.relationships[0].candidates[0].evidence).toContain(
      'caption-bounded-semantic-envelope',
    )
    expect(result.relationships[1].candidates[0].evidence).toContain(
      'connected-native-scaffold',
    )
    for (const [index, relationship] of result.relationships.entries()) {
      expect(relationship).toMatchObject({
        kind: 'figure',
        captionRegionId: captions[index].id,
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
        sourceBoxes: [captions[index].box],
      })
      expect(relationship.evidence).not.toContain(
        'unresolved-visual-text-owned',
      )
    }
    expect(
      overlays.every(
        (region) =>
          !result.consumedRegionIds.has(region.id) &&
          !result.consumedLineIds.has(region.lines[0].id),
      ),
    ).toBe(true)
  })
})
