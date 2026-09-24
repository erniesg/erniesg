import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import {
  createPngAsset,
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

function equationRegion(
  id: string,
  text: string,
  sourceBox: NormalizedSourceBox,
): PdfPageRegion {
  const textBox = { ...sourceBox, method: 'pdf-text' as const }
  return {
    id,
    page: 1,
    kind: 'equation',
    column: 'single',
    text,
    confidence: 0.93,
    box: textBox,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 12,
        box: textBox,
        runs: [
          {
            ...textBox,
            text,
            fontName: 'EquationFont',
            fontSize: 12,
            confidence: 0.98,
          },
        ],
      },
    ],
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
  it('bounds the initial equation crop away from adjacent canonical prose', async () => {
    const equation = equationRegion(
      'equation-near-following-prose',
      'q = r',
      box(0.2, 0.4, 0.5, 0.02),
    )
    const followingProse = textRegion(
      'equation-immediate-following-prose',
      'This prose begins two thousandths below the display.',
      box(0.1, 0.422, 0.7, 0.02),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 12,
          pixels: new Uint8Array(64 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [equation, followingProse],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const attempted = rasterizeFigure.mock.calls[0][0].sourceBox
    expect(attempted.y + attempted.height).toBeLessThanOrEqual(
      followingProse.box.y,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining(['source-page-crop-neighbor-bounded']),
    })
  })

  it('uses the smallest deterministic equation padding that clears source ink', async () => {
    const equation = equationRegion(
      'equation-wide-overhang',
      'q = r',
      box(0.17647, 0.67613, 0.51265, 0.01258),
    )
    const followingProse = textRegion(
      'equation-wide-following-prose',
      'The next paragraph must remain outside the equation crop.',
      box(0.17647, 0.70367, 0.51265, 0.01258),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const padding = equation.box.x - input.sourceBox.x
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        if (padding < 0.0135 || cropBottom > followingProse.box.y) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 12,
          pixels: new Uint8Array(96 * 12 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [equation, followingProse],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.map(([input]) =>
        Math.round((equation.box.x - input.sourceBox.x) * 1_000),
      ),
    ).toEqual([4, 6, 8, 10, 12, 14])
    expect(
      rasterizeFigure.mock.calls.at(-1)![0].sourceBox.y +
        rasterizeFigure.mock.calls.at(-1)![0].sourceBox.height,
    ).toBeLessThanOrEqual(followingProse.box.y)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-adaptive-padding',
      ]),
    })
  })

  it('uses more safe interline whitespace when a dense equation crop still touches ink', async () => {
    const precedingProse = textRegion(
      'dense-equation-preceding-prose',
      'The dense line immediately above remains canonical prose.',
      box(0.1, 0.63, 0.7, 0.018),
    )
    const equation = equationRegion(
      'dense-equation-with-raised-script',
      'cos(k/2(a + b)) to cos(k(a + b)).',
      box(0.1, 0.65, 0.32, 0.024),
    )
    equation.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const followingProse = textRegion(
      'dense-equation-following-prose',
      'The dense line immediately below also remains canonical prose.',
      box(0.1, 0.68, 0.7, 0.018),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (input.sourceBox.y > 0.649) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 16,
          pixels: new Uint8Array(96 * 16 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, equation, followingProse],
      rasterizeFigure,
    })

    const retained = rasterizeFigure.mock.calls.at(-1)![0].sourceBox
    expect(rasterizeFigure).toHaveBeenCalledTimes(9)
    expect(retained.y).toBe(0.649)
    expect(retained.y).toBeGreaterThan(
      precedingProse.box.y + precedingProse.box.height,
    )
    expect(retained.y + retained.height).toBeLessThan(followingProse.box.y)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-adaptive-padding',
        'source-page-crop-neighbor-bounded',
      ]),
    })
  })

  it('does not clear one neighbor by crossing the opposite prose edge', async () => {
    const precedingProse = textRegion(
      'equation-shifted-preceding',
      'Preceding prose.',
      box(0.1, 0.38, 0.6, 0.015),
    )
    const equation = equationRegion(
      'equation-shifted-source',
      'S\u0000x\u0001 = y',
      box(0.2, 0.4, 0.5, 0.03),
    )
    equation.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const followingProse = textRegion(
      'equation-shifted-following',
      'Following prose.',
      box(0.1, 0.434, 0.6, 0.015),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const bottom = input.sourceBox.y + input.sourceBox.height
        if (input.sourceBox.y < 0.397 || bottom < 0.435) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 14,
          pixels: new Uint8Array(64 * 14 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, equation, followingProse],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      assetIds: [],
      evidence: expect.arrayContaining(['source-rendition-unavailable']),
    })
    expect(rasterizeFigure.mock.calls.length).toBeLessThanOrEqual(11)
    for (const [input] of rasterizeFigure.mock.calls.slice(1)) {
      expect(input.sourceBox.y).toBeGreaterThanOrEqual(
        precedingProse.box.y + precedingProse.box.height,
      )
      expect(input.sourceBox.y + input.sourceBox.height).toBeLessThanOrEqual(
        followingProse.box.y,
      )
    }
  })

  it('uses one exact native asset while vetoing a crop across canonical prose', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-loose-prose-scope',
      sourceBox,
    )
    const orderedProse = textRegion(
      'ordered-prose-region',
      'A small canonical paragraph fragment remains in reading order.',
      box(0.2, 0.24, 0.22, 0.025),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-loose-prose-scope',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion(
          'loose-prose-vector-region',
          'vector-p001-loose-prose-scope',
          sourceBox,
        ),
        orderedProse,
        captionRegion(
          'Figure 1. Loose native scope around canonical prose.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-loose-prose-scope'],
      assetIds: [vector.id],
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
        'native-only-exact-rendition',
      ]),
    })
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
  })

  it('uses a native-only headless composite while vetoing ordered page text', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAssets = await Promise.all(
      boxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-safe-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(index === 0 ? 64 : 192),
        }),
      ),
    )
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-safe-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const orderedProse = textRegion(
      'ordered-composite-prose-region',
      'Canonical prose inside a loose composite scope stays in flow.',
      box(0.24, 0.2, 0.16, 0.02),
    )
    const nonFlowLabel = textRegion(
      'non-flow-composite-label-region',
      'State D',
      box(0.28, 0.24, 0.08, 0.015),
      'chart-label',
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`safe-fragment-${index + 1}`, object.id, object.box),
        ),
        orderedProse,
        nonFlowLabel,
        captionRegion(
          'Figure 1. Native-only composite near canonical prose.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: ['safe-fragment-1', 'safe-fragment-2'],
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
        'headless-composite-raster',
      ]),
      candidates: [
        expect.objectContaining({
          sourceObjectIds: [
            ...objects.map((object) => object.id),
            'text-overlay:non-flow-composite-label-region',
          ],
        }),
      ],
    })
    const composite = result.assets.find(
      (asset) => asset.id === result.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      rendition: 'browser-composite-raster',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    expect(
      composite.sourceObjectIds.some((id) => id.startsWith('text-overlay:')),
    ).toBe(false)
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
    expect(result.consumedRegionIds.has(nonFlowLabel.id)).toBe(false)
  })

  it('keeps an incomplete native fragment set unresolved without page crop', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAsset = await createPngAsset({
      sourceObjectId: 'image-p001-incomplete-001',
      sourceBox: boxes[0],
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(64),
    })
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-incomplete-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: index === 0 ? sourceAsset.id : null,
    }))
    const orderedProse = textRegion(
      'ordered-incomplete-prose-region',
      'Canonical prose cannot authorize a missing native fragment.',
      box(0.24, 0.2, 0.16, 0.02),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [sourceAsset])],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `incomplete-fragment-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        orderedProse,
        captionRegion(
          'Figure 1. Incomplete native fragment set.',
          box(0.2, 0.32, 0.25, 0.025),
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
        'source-page-crop-vetoed-reading-order-text',
        'source-rendition-unavailable',
      ]),
    })
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
  })

  it('still matches and consumes safe non-flow diagram labels', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-non-flow-label',
      sourceBox,
    )
    const nonFlowLabel = {
      ...textRegion(
        'non-flow-chart-label-region',
        'State C',
        box(0.24, 0.22, 0.16, 0.025),
        'chart-label',
      ),
      includedInReadingOrder: false,
    } satisfies PdfPageRegion
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-non-flow-label',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion(
          'non-flow-label-vector-region',
          'vector-p001-non-flow-label',
          sourceBox,
        ),
        nonFlowLabel,
        captionRegion(
          'Figure 1. Diagram with a non-flow label.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-non-flow-label',
        'text-overlay:non-flow-chart-label-region',
      ],
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(result.consumedRegionIds.has(nonFlowLabel.id)).toBe(true)
  })

  it('clips loose source-object lineage at the caption boundary before an exact crop', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.23)
    const subprecisionCaptionOverlap = box(0.3, 0.379997, 0.1, 0.01)
    const vector = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-caption-overlap',
      sourceBox,
      path: 'M 0 0 L 40 0 L 20 30 Z',
      viewBox: { x: 0, y: 0, width: 40, height: 30 },
      paint: 'fill-stroke',
    })
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-caption-overlap',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
            {
              id: 'vector-p001-subprecision-overlap',
              page: 1,
              kind: 'vector',
              box: subprecisionCaptionOverlap,
              confidence: 0.98,
              assetId: null,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-caption-overlap', sourceBox),
        objectRegion(
          'subprecision-vector-region',
          'vector-p001-subprecision-overlap',
          subprecisionCaptionOverlap,
        ),
        captionRegion(
          'Figure 1. Caption overlaps the loose source-object box.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: ['vector-region'],
      sourceObjectIds: ['vector-p001-caption-overlap'],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining([
        'source-lineage-clipped-to-render-scope',
        'source-page-crop',
      ]),
      candidates: [
        expect.objectContaining({
          sourceRegionIds: ['vector-region', 'subprecision-vector-region'],
          sourceObjectIds: [
            'vector-p001-caption-overlap',
            'vector-p001-subprecision-overlap',
          ],
        }),
      ],
    })
    const cropInput = rasterizeFigure.mock.calls[0]![0]
    expect(
      cropInput.sourceBox.y + cropInput.sourceBox.height,
    ).toBeLessThanOrEqual(result.relationships[0].sourceBoxes[0].y)
    expect(cropInput.sourceBoxes).toEqual([
      expect.objectContaining({
        x: sourceBox.x,
        y: sourceBox.y,
        width: sourceBox.width,
        height: expect.any(Number),
      }),
    ])
    expect(
      cropInput.sourceBoxes[0].y + cropInput.sourceBoxes[0].height,
    ).toBeLessThanOrEqual(cropInput.sourceBox.y + cropInput.sourceBox.height)
    expect(
      cropInput.sourceBoxes.every(
        (source) => source.width > 0 && source.height > 0,
      ),
    ).toBe(true)
  })

  it('records a bounded safe reason when source crop rasterization fails', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const sourceAsset = sourcePreservedSvgAsset(
      'vector-p001-raster-failure',
      sourceBox,
    )
    const sourceAssetLayer = sourcePreservedSvgAsset(
      'vector-p001-raster-failure-layer',
      sourceBox,
    )
    const distractorBox = box(0.55, 0.02, 0.08, 0.08)
    const distractorAsset = sourcePreservedSvgAsset(
      'vector-p001-raster-failure-distractor',
      distractorBox,
    )
    const rasterizeFigure = vi.fn(async () => {
      throw new Error('Source page crop contains no nontrivial source ink')
    })
    const diagramLabels = [
      textRegion('diagram-label', 'state', box(0.3, 0.205, 0.06, 0.012)),
      textRegion('diagram-label-2', 'transition', box(0.3, 0.22, 0.08, 0.012)),
      textRegion(
        'diagram-label-3',
        'instructions',
        box(0.3, 0.235, 0.09, 0.012),
      ),
    ]

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-raster-failure',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAsset.id,
            },
            {
              id: 'vector-p001-raster-failure-layer',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAssetLayer.id,
            },
            {
              id: 'vector-p001-raster-failure-distractor',
              page: 1,
              kind: 'vector',
              box: distractorBox,
              confidence: 0.98,
              assetId: distractorAsset.id,
            },
          ],
          1,
          [sourceAsset, sourceAssetLayer, distractorAsset],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-raster-failure', sourceBox),
        objectRegion(
          'vector-region-layer',
          'vector-p001-raster-failure-layer',
          sourceBox,
        ),
        objectRegion(
          'vector-region-distractor',
          'vector-p001-raster-failure-distractor',
          distractorBox,
        ),
        ...diagramLabels,
        captionRegion(
          'Figure 1. Bounded source crop failure.',
          box(0.2, 0.32, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0].candidates).toHaveLength(2)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceText: 'state transition instructions',
      evidence: expect.arrayContaining([
        'source-page-crop-payload-rejected',
        'unresolved-visual-text-owned',
        'source-rendition-unavailable',
      ]),
    })
    expect(
      diagramLabels.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
  })
})
