import { strFromU8 } from 'fflate'
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
  it('rasterizes a matched multi-object figure into one bounded asset', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
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
          width: 20,
          height: 10,
          pixels: new Uint8Array(20 * 10 * 4).fill(64),
        }),
    )

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
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        sourceObjectIds: objects.map((object) => object.id),
        sourceBox: expect.objectContaining({
          x: 0.196,
          y: 0.176,
          width: 0.258,
          height: 0.128,
        }),
      }),
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(result.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rendition: 'source-page-crop',
        }),
      ]),
    )
  })

  it('credits only fully contained native components inside one exact crop lane', async () => {
    const primaryBoxes = [
      box(0.2, 0.18, 0.22, 0.12),
      box(0.42, 0.18, 0.22, 0.12),
    ]
    const primaryObjects = primaryBoxes.map((sourceBox, index) => ({
      id: `vector-p001-credit-primary-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const containedObjects = [
      {
        id: 'image-p001-credit-inset-raster',
        page: 1,
        kind: 'image' as const,
        box: box(0.25, 0.215, 0.018, 0.018),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-credit-inset-vector',
        page: 1,
        kind: 'vector' as const,
        box: box(0.55, 0.235, 0.012, 0.012),
        confidence: 0.99,
        assetId: null,
      },
    ]
    const partialObject = {
      id: 'image-p001-credit-partial-neighbor',
      page: 1,
      kind: 'image' as const,
      box: box(0.635, 0.215, 0.04, 0.018),
      confidence: 0.99,
      assetId: null,
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 32,
          pixels: new Uint8Array(64 * 32 * 4).fill(72),
        }),
    )
    const result = await reconstructPdfVisuals({
      pages: [page([...primaryObjects, ...containedObjects, partialObject])],
      regions: [
        ...primaryObjects.map((object, index) =>
          objectRegion(
            `credit-primary-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. One exact crop owns its inset source components.',
          box(0.2, 0.33, 0.44, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: primaryObjects.map((object) => object.id),
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-native-object-credit',
      ]),
    })
    for (const object of containedObjects) {
      expect(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
            diagnostic.message.includes(object.id),
        ),
      ).toBe(false)
    }
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(partialObject.id),
      ),
    ).toBe(true)
  })

  it('does not credit a contained native object when another caption competes for the lane', async () => {
    const primaryBoxes = [box(0.2, 0.16, 0.2, 0.1), box(0.4, 0.16, 0.2, 0.1)]
    const primaryObjects = primaryBoxes.map((sourceBox, index) => ({
      id: `vector-p001-competing-caption-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const contestedObject = {
      id: 'image-p001-competing-caption-inset',
      page: 1,
      kind: 'image' as const,
      box: box(0.3, 0.19, 0.018, 0.018),
      confidence: 0.99,
      assetId: null,
    }
    const firstCaption = captionRegion(
      'Figure 1. First candidate caption.',
      box(0.2, 0.3, 0.4, 0.02),
    )
    const secondCaption = {
      ...captionRegion(
        'Figure 2. Competing caption in the same source lane.',
        box(0.2, 0.31, 0.4, 0.02),
      ),
      id: 'competing-caption-region',
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 32,
          pixels: new Uint8Array(64 * 32 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([...primaryObjects, contestedObject])],
      regions: [
        ...primaryObjects.map((object, index) =>
          objectRegion(
            `competing-caption-object-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        firstCaption,
        secondCaption,
      ],
      rasterizeFigure,
    })

    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(contestedObject.id),
      ),
    ).toBe(true)
  })

  it('accepts a source-rendered figure tightened to verified ink bounds', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-ink-bound-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const tightenedBox = box(0.202, 0.182, 0.242, 0.116)
    const tightenedSourceBoxes = [
      box(0.202, 0.182, 0.118, 0.116),
      box(0.33, 0.182, 0.114, 0.116),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: tightenedBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: tightenedSourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`ink-bound-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. Invisible PDF object padding is excluded.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-source-ink-tightened',
      ]),
    })
    expect(
      result.assets.find(
        (asset) => asset.id === result.relationships[0].assetIds[0],
      ),
    ).toMatchObject({
      rendition: 'source-page-crop',
      sourceCropBox: tightenedBox,
      sourceBoxes: tightenedSourceBoxes,
    })
  })

  it('retries an identical complete figure scope without tightening when tightening drops required lineage', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-complete-lineage-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const firstPanelOnly = box(0.202, 0.182, 0.116, 0.116)
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        input.tightenToSourceInk === false
          ? createSourcePageCropAsset({
              kind: 'raster',
              cropBox: input.sourceBox,
              sourceObjectIds: input.sourceObjectIds,
              sourceBoxes: input.sourceBoxes,
              width: 40,
              height: 20,
              pixels: new Uint8Array(40 * 20 * 4).fill(64),
            })
          : createSourcePageCropAsset({
              kind: 'raster',
              cropBox: firstPanelOnly,
              sourceObjectIds: [input.sourceObjectIds[0]],
              sourceBoxes: [firstPanelOnly],
              width: 20,
              height: 20,
              pixels: new Uint8Array(20 * 20 * 4).fill(64),
            }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `complete-lineage-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. Both source panels form one complete figure.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[1][0]).toMatchObject({
      sourceBox: rasterizeFigure.mock.calls[0][0].sourceBox,
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
      tightenToSourceInk: false,
    })
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining([
        'source-page-crop-complete-lineage-preserved',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-page-crop-source-ink-tightened',
    )
    expect(
      result.assets.find(
        (asset) => asset.id === result.relationships[0].assetIds[0],
      ),
    ).toMatchObject({
      rendition: 'source-page-crop',
      sourceCropBox: rasterizeFigure.mock.calls[0][0].sourceBox,
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
  })

  it('rejects a tightened source crop that drops an expected figure object', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-required-panel-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const firstPanelOnly = box(0.202, 0.182, 0.116, 0.116)
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: firstPanelOnly,
          sourceObjectIds: [input.sourceObjectIds[0]],
          sourceBoxes: [firstPanelOnly],
          width: 20,
          height: 20,
          pixels: new Uint8Array(20 * 20 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `required-panel-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. Both source panels are required.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[1][0]).toMatchObject({
      sourceBox: rasterizeFigure.mock.calls[0][0].sourceBox,
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
      tightenToSourceInk: false,
    })
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining(['source-page-crop-lineage-rejected']),
    })
  })

  it('keeps asset-bearing fragments unresolved in headless mode without a composite', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: `asset-fragment-${index + 1}`,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({
          sourceObjectIds: objects.map((object) => object.id),
          assetIds: objects.map((object) => object.assetId),
        }),
      ],
    })
    expect(result.relationships[0].evidence).toContain(
      'source-rendition-unavailable',
    )
  })

  it('composes source PNG fragments deterministically in headless mode', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAssets = await Promise.all(
      boxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(index === 0 ? 64 : 192),
        }),
      ),
    )
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const input = {
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source images.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    }

    const first = await reconstructPdfVisuals(input)
    const second = await reconstructPdfVisuals(input)

    expect(second.relationships).toEqual(first.relationships)
    expect(second.assets).toEqual(first.assets)
    expect(first.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining(['headless-composite-raster']),
    })
    const composite = first.assets.find(
      (asset) => asset.id === first.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'browser-composite-raster',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    expect([...composite.bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ])
  })

  it('composes mixed preserved image and vector fragments into one bounded SVG', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const raster = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: boxes[0],
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(255),
    })
    const vector = sourcePreservedSvgAsset('vector-p001-001', boxes[1])
    const sourceAssets = [raster, vector]
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: boxes[0],
        confidence: 0.98,
        assetId: raster.id,
      },
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: boxes[1],
        confidence: 0.98,
        assetId: vector.id,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. Mixed source-backed fragments.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining(['headless-composite-svg']),
    })
    const composite = result.assets.find(
      (asset) => asset.id === result.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      mediaType: 'image/svg+xml',
      kind: 'vector',
      rendition: 'source-preserved',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    const svg = strFromU8(composite.bytes)
    expect(svg).toContain('data-pdf-composite="true"')
    expect(svg).toContain('href="data:image/png;base64,')
    expect(svg).toContain('href="data:image/svg+xml;base64,')
    expect(svg).not.toContain(raster.href)
    expect(svg).not.toContain(vector.href)
  })
})
