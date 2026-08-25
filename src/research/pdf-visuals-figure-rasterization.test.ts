import { strFromU8 } from 'fflate'
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

describe('PDF visual figure rasterization', () => {
  it('reserves uniquely owned native figure atoms before an earlier table', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const sourceObjectIds = [
      'image-p001-reserved-native-layer',
      'vector-p001-reserved-native-layer',
    ]
    const assets = sourceObjectIds.map((sourceObjectId) =>
      sourcePreservedSvgAsset(sourceObjectId, sourceBox),
    )
    const tableCaption = {
      ...captionRegion(
        'Table 1. Possible native raster.',
        box(0.2, 0.1, 0.5, 0.02),
      ),
      id: 'reserved-native-table-caption',
    }
    const overlays = [
      textRegion(
        'reserved-native-overlay-a',
        'series alpha',
        box(0.28, 0.21, 0.12, 0.012),
      ),
      textRegion(
        'reserved-native-overlay-b',
        'series beta',
        box(0.45, 0.24, 0.12, 0.012),
      ),
    ]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Proven layered panel.',
        box(0.2, 0.32, 0.5, 0.02),
      ),
      id: 'reserved-native-figure-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: index === 0 ? ('image' as const) : ('vector' as const),
            box: sourceBox,
            confidence: 0.99,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        tableCaption,
        ...sourceObjectIds.map((id, index) =>
          objectRegion(`reserved-native-region-${index + 1}`, id, sourceBox),
        ),
        ...overlays,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind:
            input.kind === 'table'
              ? 'table'
              : input.kind === 'equation'
                ? 'equation'
                : 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 100,
          height: 60,
          pixels: new Uint8Array(100 * 60 * 4).fill(96),
        }),
    })

    const tableRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'table',
    )
    const figureRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'figure',
    )
    expect(tableRelationship).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(
      tableRelationship?.candidates.every((candidate) =>
        candidate.sourceObjectIds.every(
          (sourceObjectId) => !sourceObjectIds.includes(sourceObjectId),
        ),
      ),
    ).toBe(true)
    expect(figureRelationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining(sourceObjectIds),
      sourceLineIds: overlays.map((region) => region.lines[0].id),
    })
  })

  it.each([
    ['nearer', 0.155],
    ['tied', 0.14],
  ])(
    'withholds connected figure reservation when a %s table caption contests the candidate envelope',
    async (_case, tableCaptionY) => {
      const sourceBox = box(0.2, 0.18, 0.5, 0.12)
      const sourceObjectIds = [
        'image-p001-contested-envelope-layer',
        'vector-p001-contested-envelope-layer',
      ]
      const assets = sourceObjectIds.map((sourceObjectId) =>
        sourcePreservedSvgAsset(sourceObjectId, sourceBox),
      )
      const tableCaption = {
        ...captionRegion(
          'Table 1. Contested native source.',
          box(0.2, tableCaptionY, 0.5, 0.02),
        ),
        id: `contested-envelope-${_case}-table-caption`,
      }
      const overlays = [
        textRegion(
          `contested-envelope-${_case}-overlay-a`,
          'series alpha',
          box(0.28, 0.21, 0.12, 0.012),
          'chart-label',
        ),
        textRegion(
          `contested-envelope-${_case}-overlay-b`,
          'series beta',
          box(0.45, 0.24, 0.12, 0.012),
          'chart-label',
        ),
      ]
      const figureCaption = {
        ...captionRegion(
          'Figure 1. Later connected panel.',
          box(0.2, 0.32, 0.5, 0.02),
        ),
        id: `contested-envelope-${_case}-figure-caption`,
      }

      const result = await reconstructPdfVisuals({
        pages: [
          page(
            sourceObjectIds.map((id, index) => ({
              id,
              page: 1,
              kind: index === 0 ? ('image' as const) : ('vector' as const),
              box: sourceBox,
              confidence: 0.99,
              assetId: assets[index].id,
            })),
            1,
            assets,
          ),
        ],
        regions: [
          tableCaption,
          ...sourceObjectIds.map((id, index) =>
            objectRegion(
              `contested-envelope-${_case}-region-${index + 1}`,
              id,
              sourceBox,
            ),
          ),
          ...overlays,
          figureCaption,
        ],
        rasterizeFigure: async (input) =>
          createSourcePageCropAsset({
            kind:
              input.kind === 'table'
                ? 'table'
                : input.kind === 'equation'
                  ? 'equation'
                  : 'raster',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 100,
            height: 60,
            pixels: new Uint8Array(100 * 60 * 4).fill(96),
          }),
      })

      const tableRelationship = result.relationships.find(
        (relationship) => relationship.kind === 'table',
      )
      const figureRelationship = result.relationships.find(
        (relationship) => relationship.kind === 'figure',
      )
      const contestedFigureCandidate = figureRelationship?.candidates.find(
        (candidate) =>
          sourceObjectIds.every((sourceObjectId) =>
            candidate.sourceObjectIds.includes(sourceObjectId),
          ),
      )
      expect(contestedFigureCandidate?.evidence).toContain(
        'connected-native-scaffold',
      )
      expect(contestedFigureCandidate?.evidence).not.toContain(
        'caption-bounded-native-scaffold',
      )
      expect(
        tableRelationship?.candidates.some((candidate) =>
          sourceObjectIds.some((sourceObjectId) =>
            candidate.sourceObjectIds.includes(sourceObjectId),
          ),
        ),
      ).toBe(true)
      expect(tableRelationship).toMatchObject({
        status: 'matched',
        sourceObjectIds: [sourceObjectIds[0]],
      })
      expect(figureRelationship).toMatchObject({
        status: 'unresolved',
        sourceObjectIds: [],
        assetIds: [],
        evidence: expect.arrayContaining([
          'cross-type-source-lineage-conflict',
          'source-rendition-unavailable',
        ]),
      })
    },
  )

  it('fails a later figure closed when a table already owns its native atom', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const sourceObjectId = 'image-p001-cross-type-native-conflict'
    const sourceAsset = sourcePreservedSvgAsset(sourceObjectId, sourceBox)
    const tableCaption = {
      ...captionRegion(
        'Table 1. Exact native source.',
        box(0.2, 0.1, 0.5, 0.02),
      ),
      id: 'native-conflict-table-caption',
    }
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Same exact native source.',
        box(0.2, 0.32, 0.5, 0.02),
      ),
      id: 'native-conflict-figure-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 0.99,
              assetId: sourceAsset.id,
            },
          ],
          1,
          [sourceAsset],
        ),
      ],
      regions: [
        tableCaption,
        objectRegion(
          'native-conflict-source-region',
          sourceObjectId,
          sourceBox,
        ),
        figureCaption,
      ],
    })

    const tableRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'table',
    )
    const figureRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'figure',
    )
    expect(tableRelationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: [sourceObjectId],
      assetIds: [sourceAsset.id],
    })
    expect(figureRelationship).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'cross-type-source-lineage-conflict',
        'source-rendition-unavailable',
      ]),
      candidates: [
        expect.objectContaining({
          sourceObjectIds: [sourceObjectId],
        }),
      ],
    })
  })

  it('retries an edge-touching padded figure crop at its proved render envelope', async () => {
    const firstBox = box(0.2, 0.18, 0.18, 0.12)
    const secondBox = box(0.38, 0.18, 0.18, 0.12)
    const objects = [firstBox, secondBox].map((sourceBox, index) => ({
      id: `vector-p001-edge-touch-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (input.sourceBox.x < firstBox.x) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`edge-touch-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. A complete crop remains available inside adjacent prose.',
          box(0.2, 0.34, 0.36, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[1]![0].sourceBox).toMatchObject({
      x: firstBox.x,
      y: firstBox.y,
      width: 0.36,
      height: firstBox.height,
    })
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
  })

  it('recovers a caption-bounded panel after page furniture corrupts one native envelope', async () => {
    const phantomBox = box(0.14, 0, 0.16, 0.12)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.16 + (index % 4) * 0.15,
        0.09 + Math.floor(index / 4) * 0.11,
        0.13,
        0.08,
      ),
    )
    const objects = [phantomBox, ...fragmentBoxes].map((sourceBox, index) => ({
      id: `vector-p001-panel-envelope-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const panelLabels = [
      textRegion(
        'panel-envelope-label-one',
        'Planning and drafting',
        box(0.18, 0.105, 0.18, 0.018),
      ),
      textRegion(
        'panel-envelope-label-two',
        'Revision and memory',
        box(0.58, 0.205, 0.18, 0.018),
      ),
    ]
    const pageFurniture = textRegion(
      'panel-envelope-page-furniture',
      'Repeated running publication header',
      box(0.14, 0.02, 0.2, 0.08),
      'header',
    )
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
            `panel-envelope-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        pageFurniture,
        ...panelLabels,
        captionRegion(
          'Figure 1. Complete source panel with malformed native envelope.',
          box(0.12, 0.31, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0]).toMatchObject({
      sourceObjectIds: ['source-panel:caption-region'],
      ownedSourceBoxes: panelLabels.map((region) => region.box),
    })
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:caption-region'],
      evidence: expect.arrayContaining([
        'source-native-envelope-incomplete',
        'source-page-crop-caption-bounded-panel-recovery',
        'source-panel-synthetic-crop-lineage',
        'source-page-crop',
      ]),
    })
    expect(
      panelLabels.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
    expect(result.consumedRegionIds.has(pageFurniture.id)).toBe(false)
    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          objects
            .slice(1)
            .some((object) => diagnostic.message.includes(object.id)),
      ),
    ).toEqual([])
  })

  it('recovers a repeated page-edge clipping layer without teaching ordinary page-edge panels to discard lineage', async () => {
    const repeatedClipBox = box(0.05, 0, 0.49, 0.275)
    const repeatedClipAsset = await solidRectangleFallbackAsset(
      'vector-p001-reused-clip-1',
      repeatedClipBox,
    )
    const layerBoxes = [
      repeatedClipBox,
      box(0.14, 0, 0.72, 0.265),
      box(0.141, 0.001, 0.718, 0.263),
      box(0.16, 0.09, 0.2, 0.14),
      box(0.62, 0.09, 0.2, 0.14),
    ]
    const objects = layerBoxes.map((sourceBox, index) => ({
      id: `vector-p001-reused-clip-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: index === 0 ? repeatedClipAsset.id : null,
    }))
    const repeatedObject = {
      id: 'vector-p002-reused-clip',
      page: 2,
      kind: 'vector' as const,
      box: { ...repeatedClipBox, page: 2 },
      confidence: 0.99,
      assetId: repeatedClipAsset.id,
    }
    const repeatedPageAsset = {
      ...repeatedClipAsset,
      sourceObjectIds: [repeatedObject.id],
      sourceBoxes: [repeatedObject.box],
    }
    const panelLabels = Array.from({ length: 8 }, (_, index) =>
      textRegion(
        `reused-clip-label-${index + 1}`,
        `Panel source label ${index + 1}`,
        box(
          0.16 + (index % 2) * 0.36,
          0.09 + Math.floor(index / 2) * 0.04,
          0.28,
          0.018,
        ),
      ),
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
          height: 32,
          pixels: new Uint8Array(96 * 32 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(objects, 1, [repeatedClipAsset]),
        page([repeatedObject], 2, [repeatedPageAsset]),
      ],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `reused-clip-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelLabels,
        captionRegion(
          'Figure 1. A complete source panel below a reused clipping layer.',
          box(0.12, 0.275, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(3)
    expect(rasterizeFigure.mock.calls[2][0].sourceObjectIds).toEqual([
      'source-panel:caption-region',
    ])
    expect(rasterizeFigure.mock.calls[2][0].sourceBox.y).toBeGreaterThan(0)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:caption-region'],
      evidence: expect.arrayContaining([
        'source-reused-page-edge-clipping-layer',
        'source-page-crop-caption-bounded-panel-recovery',
        'source-page-crop',
      ]),
    })
  })

  it('does not retry a page-edge panel by discarding original native lineage', async () => {
    const firstLayerBox = box(0.14, 0, 0.72, 0.27)
    const secondLayerBox = box(0.141, 0.001, 0.718, 0.268)
    const objects = [firstLayerBox, secondLayerBox].map((sourceBox, index) => ({
      id: `vector-p001-page-edge-panel-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const panelTitle = textRegion(
      'page-edge-panel-title',
      'Five stages writing theory',
      box(0.32, 0.09, 0.36, 0.024),
    )
    const panelStages = textRegion(
      'page-edge-panel-stages',
      'Planning Drafting Revising Editing Publishing',
      box(0.145, 0.14, 0.7, 0.08),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (
          objects.every((object) =>
            containsSourceBox(input.sourceBox, object.box),
          )
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('page-edge-panel-region-1', objects[0].id, firstLayerBox),
        objectRegion('page-edge-panel-region-2', objects[1].id, secondLayerBox),
        panelTitle,
        panelStages,
        captionRegion(
          'Figure 1. A layered source-native writing framework.',
          box(0.12, 0.285, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.every(([input]) =>
        objects.every((object) =>
          containsSourceBox(input.sourceBox, object.box),
        ),
      ),
    ).toBe(true)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining(
            objects.map((object) => object.id),
          ),
          sourceBoxes: expect.arrayContaining([firstLayerBox, secondLayerBox]),
        }),
      ],
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-page-crop-caption-text-bounded-edge-retry',
    )
  })

  it('does not use caption width to discard a dense diagram source extent', async () => {
    const scaffoldBox = box(0, 0, 0.47, 0.2)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(0.16 + index * 0.012, 0.01 + index * 0.012, 0.04, 0.04),
    )
    const objects = [scaffoldBox, ...fragmentBoxes].map((sourceBox, index) => ({
      id: `vector-p001-dense-page-edge-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const diagramHeading = textRegion(
      'dense-page-edge-heading',
      'Knowledge Graph',
      box(0.39, 0.08, 0.1, 0.01),
    )
    const diagramTuples = textRegion(
      'dense-page-edge-tuples',
      '<sub1, act1, obj1, idx1> <sub2, act2, obj2, idx2>',
      box(0.52, 0.1, 0.11, 0.02),
    )
    const diagramTail = textRegion(
      'dense-page-edge-tail',
      '<subn, actn, objn, idxn>',
      box(0.515, 0.14, 0.11, 0.01),
    )
    const followingProse = textRegion(
      'dense-page-edge-following-prose',
      'Canonical article prose after the caption remains in reading order.',
      box(0.12, 0.25, 0.36, 0.04),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (
          objects.every((object) =>
            containsSourceBox(input.sourceBox, object.box),
          )
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 24,
          pixels: new Uint8Array(64 * 24 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `dense-page-edge-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        diagramHeading,
        diagramTuples,
        diagramTail,
        captionRegion(
          'Figure 1. A dense querying pipeline diagram.',
          box(0.119, 0.207, 0.762, 0.026),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.every(([input]) =>
        objects.every((object) =>
          containsSourceBox(input.sourceBox, object.box),
        ),
      ),
    ).toBe(true)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining(
            objects.map((object) => object.id),
          ),
          sourceBoxes: expect.arrayContaining(
            objects.map((object) => object.box),
          ),
        }),
      ],
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-page-crop-caption-text-bounded-edge-retry',
    )
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('keeps a single large captioned vector as scientific content', async () => {
    const sourceBox = box(0.1, 0.14, 0.8, 0.5)
    const sourceAsset = sourcePreservedSvgAsset('vector-p001-001', sourceBox)
    const object = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAsset.id,
    }

    const result = await reconstructPdfVisuals({
      pages: [page([object], 1, [sourceAsset])],
      regions: [
        objectRegion('large-vector-region', object.id, sourceBox),
        captionRegion(
          'Figure 1. A full-width scientific vector diagram.',
          box(0.1, 0.66, 0.8, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [object.id],
      assetIds: [object.assetId],
    })
  })

  it('reports a single uncaptioned large vector instead of suppressing it by size', async () => {
    const sourceBox = box(0.1, 0.14, 0.8, 0.5)
    const object = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: 'asset-large-vector',
    }

    const result = await reconstructPdfVisuals({
      pages: [page([object])],
      regions: [],
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNREFERENCED_VISUAL_ASSET',
        sourceBoxes: [sourceBox],
      }),
    ])
  })

  it('suppresses only a repeated large solid-rectangle fallback as page furniture', async () => {
    const firstBox = box(0.05, 0.05, 0.9, 0.8, 1)
    const secondBox = box(0.05, 0.05, 0.9, 0.8, 2)
    const firstAsset = await solidRectangleFallbackAsset(
      'vector-p001-001',
      firstBox,
    )
    const first = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: firstBox,
      confidence: 0.98,
      assetId: firstAsset.id,
    }
    const second = {
      ...first,
      id: 'vector-p002-001',
      page: 2,
      box: secondBox,
      assetId: firstAsset.id,
    }
    const secondAsset = {
      ...firstAsset,
      sourceObjectIds: [second.id],
      sourceBoxes: [secondBox],
    }

    const result = await reconstructPdfVisuals({
      pages: [page([first], 1, [firstAsset]), page([second], 2, [secondAsset])],
      regions: [],
    })

    expect(result.diagnostics).toEqual([])
  })

  it('keeps a lone solid-rectangle fallback as a source obligation', async () => {
    const sourceBox = box(0.08, 0.16, 0.76, 0.42)
    const sourceObjectId = 'vector-p001-lone-data-bar'
    const sourceAsset = await solidRectangleFallbackAsset(
      sourceObjectId,
      sourceBox,
    )
    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAsset.id,
            },
          ],
          1,
          [sourceAsset],
        ),
      ],
      regions: [],
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNREFERENCED_VISUAL_ASSET',
        message: expect.stringContaining(sourceObjectId),
      }),
    ])
  })

  it('does not suppress repeated large non-rectangle vectors as page furniture', async () => {
    const firstBox = box(0.05, 0.05, 0.9, 0.8, 1)
    const secondBox = box(0.05, 0.05, 0.9, 0.8, 2)
    const firstAsset = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-triangle',
      sourceBox: firstBox,
      path: 'M 0 100 L 50 0 L 100 100 Z',
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      paint: 'fill',
    })
    const objects = [
      {
        id: 'vector-p001-triangle',
        page: 1,
        kind: 'vector' as const,
        box: firstBox,
        confidence: 0.98,
        assetId: firstAsset.id,
      },
      {
        id: 'vector-p002-triangle',
        page: 2,
        kind: 'vector' as const,
        box: secondBox,
        confidence: 0.98,
        assetId: firstAsset.id,
      },
    ]
    const secondAsset = {
      ...firstAsset,
      sourceObjectIds: [objects[1].id],
      sourceBoxes: [secondBox],
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page([objects[0]], 1, [firstAsset]),
        page([objects[1]], 2, [secondAsset]),
      ],
      regions: [],
    })

    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNREFERENCED_VISUAL_ASSET',
      ),
    ).toHaveLength(2)
  })

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
