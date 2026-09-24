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
  it('uses horizontal alignment to associate side-by-side figures', async () => {
    const left = box(0.08, 0.2, 0.38, 0.18)
    const right = box(0.54, 0.2, 0.38, 0.18)
    const sourceAssets = await Promise.all(
      [left, right].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(80 + index * 80),
        }),
      ),
    )
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: left,
        confidence: 0.98,
        assetId: sourceAssets[0].id,
      },
      {
        id: 'image-p001-002',
        page: 1,
        kind: 'image' as const,
        box: right,
        confidence: 0.98,
        assetId: sourceAssets[1].id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        objectRegion('left-region', objects[0].id, left),
        objectRegion('right-region', objects[1].id, right),
        captionRegion(
          'Figure 2. Right-hand result.',
          box(0.54, 0.4, 0.38, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-002'],
      assetIds: [sourceAssets[1].id],
    })
    expect(result.relationships[0].candidates[0].evidence).toContain(
      'horizontal-alignment',
    )
  })

  it('does not bridge a narrow caption through a taller neighbouring column', async () => {
    const figure16 = box(0.09, 0.32, 0.383, 0.136)
    const figure17 = box(0.09, 0.576, 0.383, 0.236)
    const figure18 = box(0.502, 0.269, 0.382, 0.368)
    const sourceBoxes = [figure16, figure17, figure18]
    const sourceAssets = await Promise.all(
      sourceBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-column-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(64 + index * 48),
        }),
      ),
    )
    const objects = sourceBoxes.map((sourceBox, index) => ({
      id: `image-p001-column-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`column-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 16. Left-column result.',
          box(0.09, 0.472, 0.386, 0.055),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-column-1'],
      assetIds: [sourceAssets[0].id],
    })
    expect(result.relationships[0].candidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining([
            'image-p001-column-2',
            'image-p001-column-3',
          ]),
        }),
      ]),
    )
  })

  it('does not bridge a left chart to the first panel of a separately captioned right figure', async () => {
    const sourceBoxes = [
      box(0.09, 0.5, 0.383, 0.19),
      box(0.502, 0.5, 0.175, 0.15),
      box(0.702, 0.5, 0.175, 0.15),
    ]
    const sourceAssets = await Promise.all(
      sourceBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-separate-column-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(72 + index * 48),
        }),
      ),
    )
    const objects = sourceBoxes.map((sourceBox, index) => ({
      id: `image-p001-separate-column-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `separate-column-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 13. Two right-column panels.',
          box(0.502, 0.67, 0.383, 0.03),
        ),
        captionRegion(
          'Figure 12. One left-column chart.',
          box(0.09, 0.72, 0.383, 0.03),
        ),
      ],
    })

    expect(
      result.relationships.find(
        (relationship) => relationship.label === 'Figure 13',
      ),
    ).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[1].id, objects[2].id],
    })
    expect(
      result.relationships.find(
        (relationship) => relationship.label === 'Figure 12',
      ),
    ).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[0].id],
    })
  })

  it('does not let a global figure ordinal override the immediately adjacent source object', async () => {
    const priorObjects = Array.from({ length: 15 }, (_, index) => {
      const sourceBox = box(0.12, 0.2, 0.3, 0.1, index + 1)
      return {
        id: `image-prior-${String(index + 1).padStart(2, '0')}`,
        page: sourceBox.page,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: null,
      }
    })
    const targetPage = 16
    const precedingFigure = box(
      0.090588,
      0.091268,
      0.382367,
      0.149264,
      targetPage,
    )
    const adjacentFigure = box(
      0.090588,
      0.320327,
      0.382353,
      0.136364,
      targetPage,
    )
    const sourceAssets = await Promise.all(
      [precedingFigure, adjacentFigure].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-target-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(80 + index * 48),
        }),
      ),
    )
    const targetObjects = [precedingFigure, adjacentFigure].map(
      (sourceBox, index) => ({
        id: `image-target-${index + 1}`,
        page: targetPage,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: sourceAssets[index].id,
      }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        ...priorObjects.map((object) => page([object], object.page)),
        page(targetObjects, targetPage, sourceAssets),
      ],
      regions: [
        ...priorObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        ...targetObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 16. The source object immediately above owns this caption.',
          box(0.089768, 0.47179, 0.3856, 0.0805, targetPage),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-target-2'],
      assetIds: [sourceAssets[1].id],
      evidence: expect.arrayContaining(['bounded-distance']),
    })
  })

  it('orders visual-only figure relationships by column flow before global y', async () => {
    const figureBoxes = [
      box(0.09, 0.09, 0.38, 0.15),
      box(0.09, 0.32, 0.38, 0.14),
      box(0.09, 0.58, 0.38, 0.23),
      box(0.502, 0.27, 0.38, 0.36),
    ]
    const sourceAssets = await Promise.all(
      figureBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-visual-column-${index + 1}`,
          sourceBox,
          width: 8,
          height: 8,
          colorSpace: 'rgba',
          pixels: new Uint8Array(8 * 8 * 4).fill(64 + index * 32),
        }),
      ),
    )
    const objects = figureBoxes.map((sourceBox, index) => ({
      id: `image-visual-column-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const captions = [
      captionRegion(
        'Figure 15. First left-column figure.',
        box(0.09, 0.255, 0.38, 0.03),
      ),
      captionRegion(
        'Figure 16. Second left-column figure.',
        box(0.09, 0.47, 0.38, 0.05),
      ),
      captionRegion(
        'Figure 17. Third left-column figure.',
        box(0.09, 0.827, 0.38, 0.05),
      ),
      captionRegion(
        'Figure 18. Right-column figure.',
        box(0.502, 0.652, 0.38, 0.05),
      ),
    ].map((caption, index) => ({
      ...caption,
      id: `visual-column-caption-${index + 1}`,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `visual-column-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...captions,
      ],
    })

    expect(
      result.relationships.map((relationship) => relationship.label),
    ).toEqual(['Figure 15', 'Figure 16', 'Figure 17', 'Figure 18'])
    expect(
      result.relationships.every(
        (relationship) => relationship.status === 'matched',
      ),
    ).toBe(true)
  })

  it('fails closed for similarly adjacent numeric-label candidates despite their global ordinals', async () => {
    const priorObjects = Array.from({ length: 15 }, (_, index) => {
      const sourceBox = box(0.12, 0.2, 0.3, 0.1, index + 1)
      return {
        id: `image-ambiguous-prior-${String(index + 1).padStart(2, '0')}`,
        page: sourceBox.page,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: null,
      }
    })
    const targetPage = 16
    const competingBoxes = [
      box(0.08, 0.32, 0.38, 0.14, targetPage),
      box(0.51, 0.32, 0.38, 0.14, targetPage),
    ]
    const sourceAssets = await Promise.all(
      competingBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-ambiguous-target-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(96 + index * 48),
        }),
      ),
    )
    const targetObjects = competingBoxes.map((sourceBox, index) => ({
      id: `image-ambiguous-target-${index + 1}`,
      page: targetPage,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [
        ...priorObjects.map((object) => page([object], object.page)),
        page(targetObjects, targetPage, sourceAssets),
      ],
      regions: [
        ...priorObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        ...targetObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 16. Two equally plausible neighbouring panels.',
          box(0.08, 0.48, 0.81, 0.03, targetPage),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'ambiguous',
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({ score: expect.any(Number) }),
        expect.objectContaining({ score: expect.any(Number) }),
      ],
    })
  })

  it('keeps adjacent panels together when one wide caption owns both columns', async () => {
    const panelBoxes = [
      box(0.09, 0.28, 0.383, 0.18),
      box(0.502, 0.28, 0.382, 0.18),
    ]
    const sourceAssets = await Promise.all(
      panelBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-wide-panel-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(72 + index * 64),
        }),
      ),
    )
    const objects = panelBoxes.map((sourceBox, index) => ({
      id: `image-p001-wide-panel-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`wide-panel-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One two-column multi-panel figure.',
          box(0.09, 0.48, 0.794, 0.03),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['headless-composite-raster']),
    })
  })

  it('retains a composite visual whose native source box crosses a caption lane', async () => {
    const compositeBox = box(0.09, 0.2, 0.8, 0.18)
    const sourceAssets = await Promise.all(
      ['image-p001-cross-lane', 'vector-p001-cross-lane'].map(
        (sourceObjectId, index) =>
          createPngAsset({
            sourceObjectId,
            sourceBox: compositeBox,
            width: 4,
            height: 4,
            colorSpace: 'rgba',
            pixels: new Uint8Array(4 * 4 * 4).fill(64 + index * 32),
          }),
      ),
    )
    const objects = [
      {
        id: 'image-p001-cross-lane',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[0].id,
      },
      {
        id: 'vector-p001-cross-lane',
        page: 1,
        kind: 'vector' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[1].id,
      },
    ]
    const caption = {
      ...captionRegion(
        'Figure 1. A composite panel crossing the lane.',
        box(0.09, 0.42, 0.34, 0.03),
      ),
      id: 'cross-lane-caption',
      sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
    }

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`cross-lane-region-${index + 1}`, object.id, object.box),
        ),
        caption,
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

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining(['connected-native-scaffold']),
    })
  })

  it('gives disjoint lane-scoped crops independent composite ownership', async () => {
    const compositeBox = box(0.09, 0.2, 0.8, 0.18)
    const sourceAssets = await Promise.all(
      ['image-p001-disjoint-lanes', 'vector-p001-disjoint-lanes'].map(
        (sourceObjectId, index) =>
          createPngAsset({
            sourceObjectId,
            sourceBox: compositeBox,
            width: 4,
            height: 4,
            colorSpace: 'rgba',
            pixels: new Uint8Array(4 * 4 * 4).fill(64 + index * 32),
          }),
      ),
    )
    const objects = [
      {
        id: 'image-p001-disjoint-lanes',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[0].id,
      },
      {
        id: 'vector-p001-disjoint-lanes',
        page: 1,
        kind: 'vector' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[1].id,
      },
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The left composite panel.',
          box(0.09, 0.42, 0.41, 0.03),
        ),
        id: 'left-disjoint-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The right composite panel.',
          box(0.5, 0.42, 0.39, 0.03),
        ),
        id: 'right-disjoint-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `disjoint-lane-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...captions,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.map((relationship) => relationship.status),
    ).toEqual(['matched', 'matched'])
    expect(
      result.relationships.map((relationship) => relationship.sourceObjectIds),
    ).toEqual([
      objects.map((object) => object.id),
      objects.map((object) => object.id),
    ])
    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.width).toBeLessThan(
      compositeBox.width,
    )
    expect(rasterizeFigure.mock.calls[1][0].sourceBox.width).toBeLessThan(
      compositeBox.width,
    )
    expect(
      rasterizeFigure.mock.calls[0][0].sourceBox.x +
        rasterizeFigure.mock.calls[0][0].sourceBox.width / 2,
    ).toBeLessThan(0.5)
    expect(
      rasterizeFigure.mock.calls[1][0].sourceBox.x +
        rasterizeFigure.mock.calls[1][0].sourceBox.width / 2,
    ).toBeGreaterThanOrEqual(0.5)
    expect(
      rasterizeFigure.mock.calls[0][0].sourceBox.x +
        rasterizeFigure.mock.calls[0][0].sourceBox.width,
    ).toBeLessThanOrEqual(0.5)
    expect(rasterizeFigure.mock.calls[1][0].sourceBox.x).toBeGreaterThanOrEqual(
      0.5,
    )
  })
})
