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
  it('does not split disjoint overlay text across candidates sharing native sources', async () => {
    const panelBoxes = [box(0.2, 0.08, 0.5, 0.12), box(0.2, 0.4, 0.5, 0.12)]
    const sharedSourceObjectId = 'vector-p001-shared-native-layer'
    const objectGroups = panelBoxes.map((panelBox, panelIndex) =>
      Array.from({ length: 3 }, (_, layerIndex) => {
        const inset = layerIndex * 0.005
        return {
          id:
            layerIndex === 0
              ? sharedSourceObjectId
              : `vector-p001-shared-native-panel-${panelIndex + 1}-layer-${layerIndex + 1}`,
          page: 1,
          kind: 'vector' as const,
          box: box(
            panelBox.x + inset,
            panelBox.y + inset,
            panelBox.width - inset * 2,
            panelBox.height - inset * 2,
          ),
          confidence: 0.99,
          assetId: null,
        }
      }),
    )
    const panelOverlays = panelBoxes.map((panelBox, panelIndex) =>
      ['alpha', 'beta', 'gamma', 'delta'].map((text, lineIndex) =>
        textRegion(
          `shared-native-panel-${panelIndex + 1}-overlay-${lineIndex + 1}`,
          `${text} ${panelIndex + 1}`,
          box(
            0.27 + (lineIndex % 2) * 0.2,
            panelBox.y + 0.025 + Math.floor(lineIndex / 2) * 0.045,
            0.12,
            0.012,
          ),
          'chart-label',
        ),
      ),
    )
    const captions = [
      {
        ...captionRegion(
          'Figure 1. First shared-source panel.',
          box(0.2, 0.24, 0.5, 0.02),
        ),
        id: 'shared-native-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Second shared-source panel.',
          box(0.2, 0.56, 0.5, 0.02),
        ),
        id: 'shared-native-caption-b',
      },
    ]
    const regionObjects = objectGroups.flat()
    const pageObjects = [
      ...new Map(regionObjects.map((object) => [object.id, object])).values(),
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(pageObjects)],
      regions: [
        ...regionObjects.map((object, index) =>
          objectRegion(
            `shared-native-vector-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelOverlays.flat(),
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    const firstNativeIds =
      result.relationships[0].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    const secondNativeIds =
      result.relationships[1].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    expect(firstNativeIds).toContain(sharedSourceObjectId)
    expect(secondNativeIds).toContain(sharedSourceObjectId)
    expect(panelOverlays[0].map((region) => region.lines[0].id)).not.toEqual(
      panelOverlays[1].map((region) => region.lines[0].id),
    )
    for (const relationship of result.relationships) {
      expect(relationship).toMatchObject({
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
      })
    }
    expect(
      panelOverlays
        .flat()
        .every(
          (region) =>
            !result.consumedRegionIds.has(region.id) &&
            !result.consumedLineIds.has(region.lines[0].id),
        ),
    ).toBe(true)
  })

  it('treats a shared overlay line as contested across different region aliases', async () => {
    const panelBoxes = [box(0.2, 0.08, 0.5, 0.12), box(0.2, 0.4, 0.5, 0.12)]
    const objectGroups = panelBoxes.map((panelBox, panelIndex) =>
      Array.from({ length: 3 }, (_, layerIndex) => {
        const inset = layerIndex * 0.005
        return {
          id: `vector-p001-aliased-line-panel-${panelIndex + 1}-layer-${layerIndex + 1}`,
          page: 1,
          kind: 'vector' as const,
          box: box(
            panelBox.x + inset,
            panelBox.y + inset,
            panelBox.width - inset * 2,
            panelBox.height - inset * 2,
          ),
          confidence: 0.99,
          assetId: null,
        }
      }),
    )
    const panelOverlays = panelBoxes.map((panelBox, panelIndex) =>
      ['alpha', 'beta', 'gamma', 'delta'].map((text, lineIndex) => {
        const region = textRegion(
          `aliased-line-panel-${panelIndex + 1}-overlay-${lineIndex + 1}`,
          `${text} ${panelIndex + 1}`,
          box(
            0.27 + (lineIndex % 2) * 0.2,
            panelBox.y + 0.025 + Math.floor(lineIndex / 2) * 0.045,
            0.12,
            0.012,
          ),
          'chart-label',
        )
        region.lines[0].id = `shared-aliased-overlay-line-${lineIndex + 1}`
        return region
      }),
    )
    const captions = [
      {
        ...captionRegion(
          'Figure 1. First independent layered panel.',
          box(0.2, 0.24, 0.5, 0.02),
        ),
        id: 'aliased-line-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Second independent layered panel.',
          box(0.2, 0.56, 0.5, 0.02),
        ),
        id: 'aliased-line-caption-b',
      },
    ]
    const objects = objectGroups.flat()

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `aliased-line-vector-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelOverlays.flat(),
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    const firstNativeIds =
      result.relationships[0].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    const secondNativeIds =
      result.relationships[1].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    expect(
      firstNativeIds.some((sourceObjectId) =>
        secondNativeIds.includes(sourceObjectId),
      ),
    ).toBe(false)
    expect(panelOverlays[0].map((region) => region.lines[0].id)).toEqual(
      panelOverlays[1].map((region) => region.lines[0].id),
    )
    for (const relationship of result.relationships) {
      expect(relationship).toMatchObject({
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
      })
    }
    expect(
      panelOverlays
        .flat()
        .every(
          (region) =>
            !result.consumedRegionIds.has(region.id) &&
            !result.consumedLineIds.has(region.lines[0].id),
        ),
    ).toBe(true)
  })

  it('reserves uniquely owned figure overlay lines before resolving an earlier table', async () => {
    const tableCaption = {
      ...captionRegion(
        'Table 1. Bounded metric records.',
        box(0.12, 0.1, 0.68, 0.02),
      ),
      id: 'reserved-overlay-table-caption',
    }
    const tableRows = [0.124, 0.142, 0.16, 0.178, 0.196, 0.214, 0.232].map(
      (y, index) => {
        const region = textRegion(
          `reserved-overlay-table-row-${index + 1}`,
          `Metric ${index + 1}: source bounded value`,
          box(0.12, y, 0.68, 0.012),
        )
        region.lines[0].fontSize = 8
        region.lines[0].runs[0] = {
          ...region.lines[0].runs[0],
          fontName: 'TableSerif-Bold',
          fontSize: 8,
        }
        if (index >= 5) {
          region.kind = 'chart-label'
          region.includedInReadingOrder = false
        }
        return region
      },
    )
    const figureBox = box(0.12, 0.25, 0.68, 0.08)
    const figureObjectIds = [
      'vector-p001-reserved-overlay-a',
      'vector-p001-reserved-overlay-b',
    ]
    const figureAssets = figureObjectIds.map((id) =>
      sourcePreservedSvgAsset(id, figureBox),
    )
    const figureObjects = figureObjectIds.map((id, index) => ({
      id,
      page: 1,
      kind: 'vector' as const,
      box: figureBox,
      confidence: 0.99,
      assetId: figureAssets[index].id,
    }))
    const figureRegions = figureObjects.map((object, index) =>
      objectRegion(
        `reserved-overlay-figure-region-${index + 1}`,
        object.id,
        figureBox,
      ),
    )
    const plotOverlays = [0.262, 0.28, 0.298].map((y, index) => {
      const region = textRegion(
        `reserved-plot-overlay-${index + 1}`,
        `series ${index + 1}`,
        box(0.2 + index * 0.14, y, 0.1, 0.012),
        'chart-label',
      )
      region.lines[0].fontSize = 8
      region.lines[0].runs[0] = {
        ...region.lines[0].runs[0],
        fontName: 'TableSerif-Bold',
        fontSize: 8,
      }
      return region
    })
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Multi-panel metric plot.',
        box(0.12, 0.35, 0.68, 0.02),
      ),
      id: 'reserved-overlay-figure-caption',
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
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
          width: 120,
          height: 80,
          pixels: new Uint8Array(120 * 80 * 4).fill(96),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(figureObjects, 1, figureAssets)],
      regions: [
        tableCaption,
        ...tableRows,
        ...figureRegions,
        ...plotOverlays,
        figureCaption,
      ],
      rasterizeFigure,
    })

    const tableRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'table',
    )
    const figureRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'figure',
    )
    expect(tableRelationship).toMatchObject({
      status: 'matched',
      sourceRegionIds: tableRows.map((region) => region.id),
      sourceLineIds: tableRows.map((region) => region.lines[0].id),
      sourceText: tableRows.map((region) => region.text).join(' '),
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(tableRelationship?.sourceRegionIds).not.toEqual(
      expect.arrayContaining(plotOverlays.map((region) => region.id)),
    )
    expect(tableRelationship?.sourceLineIds).not.toEqual(
      expect.arrayContaining(plotOverlays.map((region) => region.lines[0].id)),
    )
    expect(
      tableRelationship!.sourceBoxes
        .slice(1)
        .every(
          (sourceBox) =>
            sourceBox.y + sourceBox.height <= figureBox.y + 0.00001,
        ),
    ).toBe(true)
    expect(figureRelationship).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        ...figureRegions.map((region) => region.id),
        ...plotOverlays.map((region) => region.id),
      ]),
      sourceLineIds: plotOverlays.map((region) => region.lines[0].id),
      sourceText: plotOverlays.map((region) => region.text).join(' '),
      assetIds: [expect.stringMatching(/^asset-/)],
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining([
            ...figureObjectIds,
            ...plotOverlays.map((region) => `text-overlay:${region.id}`),
          ]),
          evidence: expect.arrayContaining(['connected-native-scaffold']),
        }),
      ],
    })
    expect(figureRelationship?.candidates[0].evidence).not.toContain(
      'caption-bounded-native-scaffold',
    )
    expect(figureRelationship?.sourceRegionIds).not.toEqual(
      expect.arrayContaining(tableRows.map((region) => region.id)),
    )
    expect(
      tableRelationship?.assetIds[0] === figureRelationship?.assetIds[0],
    ).toBe(false)
    expect(rasterizeFigure.mock.calls.map(([input]) => input.kind)).toEqual(
      expect.arrayContaining(['table', 'figure']),
    )
  })

  it('keeps adjacent panel-label prose inside its uniquely captioned multi-panel figure', async () => {
    const panelBoxes = [
      box(0.176, 0.103, 0.291, 0.169),
      box(0.532, 0.103, 0.291, 0.169),
    ]
    const sourceAssets = await Promise.all(
      panelBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-labelled-panel-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(72 + index * 64),
        }),
      ),
    )
    const objects = panelBoxes.map((sourceBox, index) => ({
      id: `image-p001-labelled-panel-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const leftPanelLabel = textRegion(
      'left-panel-label',
      '(a) Accuracy as a function of program length.',
      box(0.176, 0.277, 0.291, 0.024),
    )
    const rightPanelLabel = textRegion(
      'right-panel-label',
      '(b) Accuracy as a function of sequence length.',
      box(0.532, 0.277, 0.291, 0.024),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `labelled-panel-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        leftPanelLabel,
        rightPanelLabel,
        captionRegion(
          'Figure 1. Accuracy by program and sequence length.',
          box(0.182, 0.315, 0.635, 0.013),
        ),
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        leftPanelLabel.id,
        rightPanelLabel.id,
      ]),
      evidence: expect.arrayContaining([
        'source-text-overlay',
        'panel-label-source-owned',
      ]),
    })
    expect(result.consumedRegionIds.has(leftPanelLabel.id)).toBe(true)
    expect(result.consumedRegionIds.has(rightPanelLabel.id)).toBe(true)
  })

  it('prefers a conventional above-caption figure before using caption-above fallback', async () => {
    const above = box(0.12, 0.18, 0.76, 0.18)
    const below = box(0.12, 0.42, 0.76, 0.18)
    const sourceAssets = await Promise.all(
      [above, below].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 4,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 2 * 4).fill(80 + index * 40),
        }),
      ),
    )
    const objects = [above, below].map((sourceBox, index) => ({
      id: `image-p001-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        objectRegion('above-region', objects[0].id, above),
        objectRegion('below-region', objects[1].id, below),
        captionRegion(
          'Figure IV. Directionally bounded source figure.',
          box(0.12, 0.38, 0.76, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[0].id],
      assetIds: [sourceAssets[0].id],
      evidence: expect.arrayContaining(['object-above-caption']),
    })
  })

  it('does not let a thin aligned vector sliver tie a caption-width figure', async () => {
    const figureBox = box(0.2, 0.2, 0.45, 0.18)
    const sliverBox = box(0.82, 0.2, 0.015, 0.18)
    const figureAsset = sourcePreservedSvgAsset(
      'vector-p001-caption-width-figure',
      figureBox,
    )
    const sliverAsset = sourcePreservedSvgAsset(
      'vector-p001-caption-sliver',
      sliverBox,
    )
    const objects = [
      {
        id: 'vector-p001-caption-width-figure',
        page: 1,
        kind: 'vector' as const,
        box: figureBox,
        confidence: 0.99,
        assetId: figureAsset.id,
      },
      {
        id: 'vector-p001-caption-sliver',
        page: 1,
        kind: 'vector' as const,
        box: sliverBox,
        confidence: 0.99,
        assetId: sliverAsset.id,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset, sliverAsset])],
      regions: [
        objectRegion('caption-width-figure-region', objects[0].id, figureBox),
        objectRegion('caption-sliver-region', objects[1].id, sliverBox),
        captionRegion(
          'Figure IV. Caption-width figure with a decorative sliver.',
          box(0.2, 0.4, 0.65, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-caption-width-figure'],
      assetIds: [figureAsset.id],
    })
    expect(result.relationships[0].candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceObjectIds: ['vector-p001-caption-width-figure'],
          evidence: expect.arrayContaining(['horizontal-alignment']),
        }),
        expect.objectContaining({
          sourceObjectIds: ['vector-p001-caption-sliver'],
          evidence: expect.not.arrayContaining(['horizontal-alignment']),
        }),
      ]),
    )
  })

  it('retains equally scored Roman-label candidates instead of guessing', async () => {
    const left = box(0.05, 0.2)
    const right = box(0.7, 0.2)
    const rasterizeFigure = vi.fn(async () => null)
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: left,
        confidence: 0.98,
        assetId: 'asset-left',
      },
      {
        id: 'image-p001-002',
        page: 1,
        kind: 'image' as const,
        box: right,
        confidence: 0.98,
        assetId: 'asset-right',
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('left-region', objects[0].id, left),
        objectRegion('right-region', objects[1].id, right),
        captionRegion(
          'Figure I. Competing candidates.',
          box(0.05, 0.32, 0.85, 0.02),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'ambiguous',
      candidates: [
        expect.objectContaining({ score: expect.any(Number) }),
        expect.objectContaining({ score: expect.any(Number) }),
      ],
    })
  })
})
