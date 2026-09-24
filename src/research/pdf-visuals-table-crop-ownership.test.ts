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
  it('expands a text-owned table crop through distant horizontal rules while staying between neighboring prose', async () => {
    const precedingProse = textRegion(
      'wide-rule-table-preceding-prose',
      'The preceding paragraph remains outside the table rendition.',
      box(0.1, 0.5, 0.8, 0.014),
    )
    const caption = {
      ...captionRegion(
        'Table 1. A text-owned table with rules wider than its cell text.',
        box(0.1, 0.52, 0.8, 0.025),
      ),
      id: 'wide-rule-table-caption',
    }
    const rows = Array.from({ length: 7 }, (_, index) => {
      const region = textRegion(
        `wide-rule-table-row-${index + 1}`,
        `Metric ${index + 1}  ${40 + index}.0  ${70 + index}.0`,
        box(0.2, 0.55 + index * 0.016, 0.48, 0.012),
      )
      region.lines[0].fontSize = 8
      region.lines[0].runs[0] = {
        ...region.lines[0].runs[0],
        fontName: 'TableSerif-Regular',
        fontSize: 8,
      }
      const baseRun = region.lines[0].runs[0]
      region.lines[0].runs = [
        {
          ...baseRun,
          text: `Metric ${index + 1}`,
          x: 0.2,
          width: 0.14,
        },
        {
          ...baseRun,
          text: `${40 + index}.0`,
          x: 0.45,
          width: 0.05,
        },
        {
          ...baseRun,
          text: `${70 + index}.0`,
          x: 0.6,
          width: 0.05,
        },
      ]
      return region
    })
    const followingProse = textRegion(
      'wide-rule-table-following-prose',
      'The following paragraph also remains canonical prose.',
      box(0.1, 0.72, 0.8, 0.014),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        if (input.sourceBox.x > 0.19 || cropRight < 0.78) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        if (
          input.sourceBox.y <
            precedingProse.box.y + precedingProse.box.height - 0.00001 ||
          input.sourceBox.y + input.sourceBox.height >
            followingProse.box.y + 0.00001
        ) {
          throw new Error('table crop crossed neighboring prose')
        }
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 180,
          height: 80,
          pixels: new Uint8Array(180 * 80 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, caption, ...rows, followingProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    const retainedCrop = rasterizeFigure.mock.calls.at(-1)?.[0].sourceBox
    expect(retainedCrop?.x).toBeLessThanOrEqual(0.19)
    expect(
      retainedCrop ? retainedCrop.x + retainedCrop.width : 0,
    ).toBeGreaterThanOrEqual(0.78)
    expect(retainedCrop?.y).toBeGreaterThanOrEqual(
      precedingProse.box.y + precedingProse.box.height - 0.00001,
    )
    expect(
      retainedCrop ? retainedCrop.y + retainedCrop.height : 1,
    ).toBeLessThanOrEqual(followingProse.box.y + 0.00001)
    expect(
      rasterizeFigure.mock.calls.every(([input]) => {
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        return (
          input.sourceBox.y >=
            precedingProse.box.y + precedingProse.box.height - 0.00001 &&
          cropBottom <= followingProse.box.y + 0.00001
        )
      }),
    ).toBe(true)
    expect(relationship).toMatchObject({
      status: 'matched',
      sourceRegionIds: rows.map((row) => row.id),
      sourceLineIds: rows.map((row) => row.lines[0].id),
      sourceText: rows.map((row) => row.text).join(' '),
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
    expect(result.consumedRegionIds.has(precedingProse.id)).toBe(false)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('uses a neighbor-bounded caption-text-slab envelope before accepting an initially successful crop', async () => {
    const topRuleY = 0.17
    const bottomRuleY = 0.373
    const precedingProse = textRegion(
      'initial-success-table-preceding-prose',
      'The preceding paragraph remains outside the table rendition.',
      box(0.12, 0.143, 0.324, 0.016),
    )
    const captionBox = box(0.12, 0.38, 0.68, 0.02)
    const captionText = 'Table 4. Source-authored prompt template.'
    const caption = {
      ...captionRegion(captionText, captionBox),
      id: 'initial-success-table-caption',
      lines: [
        textRegion(
          'initial-success-table-caption-line',
          captionText,
          captionBox,
        ).lines[0],
      ],
    }
    const slab = textRegion(
      'initial-success-table-slab',
      'Field 1: structured table value',
      box(0.12, 0.18, 0.68, 0.184),
    )
    const baseLine = slab.lines[0]
    slab.lines = Array.from({ length: 8 }, (_, index) => {
      const sourceBox = {
        ...box(0.12, 0.18 + index * 0.024, 0.68 - index * 0.02, 0.016),
        method: 'pdf-text' as const,
      }
      const text = `Field ${index + 1}: structured table value`
      return {
        ...baseLine,
        id: `initial-success-table-line-${index + 1}`,
        text,
        box: sourceBox,
        fontSize: 9,
        runs: [
          {
            ...baseLine.runs[0],
            ...sourceBox,
            text,
            fontName: 'PromptSerif-Bold',
            fontSize: 9,
            bold: true,
          },
        ],
      }
    })
    slab.text = slab.lines.map((line) => line.text).join(' ')
    const followingProse = textRegion(
      'initial-success-table-following-prose',
      'The following paragraph also remains canonical prose.',
      box(0.12, 0.42, 0.68, 0.016),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 180,
          height: 80,
          pixels: new Uint8Array(180 * 80 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, slab, caption, followingProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    const acceptedCrop = rasterizeFigure.mock.calls[0]?.[0].sourceBox
    expect(rasterizeFigure).toHaveBeenCalledTimes(1)
    expect(relationship?.sourceObjectIds[0]).toMatch(
      /^table-scope-source:pdf-table-scope:caption-bounded-text-slab:/,
    )
    expect(relationship?.candidates[0].evidence).toContain(
      'contiguous-single-anchor-slab',
    )
    expect(acceptedCrop?.y).toBeGreaterThanOrEqual(
      precedingProse.box.y + precedingProse.box.height - 0.00001,
    )
    expect(acceptedCrop?.y).toBeLessThanOrEqual(topRuleY)
    expect(
      acceptedCrop ? acceptedCrop.y + acceptedCrop.height : 1,
    ).toBeGreaterThanOrEqual(bottomRuleY)
    expect(
      acceptedCrop ? acceptedCrop.y + acceptedCrop.height : 1,
    ).toBeLessThanOrEqual(caption.box.y + 0.00001)
    expect(relationship).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
    expect(result.consumedRegionIds.has(precedingProse.id)).toBe(false)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('does not accept a tight text-only fallback after an expanded caption-text-slab crop touches an outer rule', async () => {
    const bottomRuleY = 0.525
    const captionBox = box(0.12, 0.26, 0.68, 0.02)
    const captionText = 'Table 5. Outer rules extend beyond the text slab.'
    const caption = {
      ...captionRegion(captionText, captionBox),
      id: 'expanded-edge-table-caption',
      lines: [
        textRegion('expanded-edge-table-caption-line', captionText, captionBox)
          .lines[0],
      ],
    }
    const slab = textRegion(
      'expanded-edge-table-slab',
      'Field 1: structured table value',
      box(0.12, 0.3, 0.68, 0.184),
    )
    const baseLine = slab.lines[0]
    slab.lines = Array.from({ length: 8 }, (_, index) => {
      const sourceBox = {
        ...box(0.12, 0.3 + index * 0.024, 0.68 - index * 0.02, 0.016),
        method: 'pdf-text' as const,
      }
      const text = `Field ${index + 1}: structured table value`
      return {
        ...baseLine,
        id: `expanded-edge-table-line-${index + 1}`,
        text,
        box: sourceBox,
        fontSize: 9,
        runs: [
          {
            ...baseLine.runs[0],
            ...sourceBox,
            text,
            fontName: 'PromptSerif-Bold',
            fontSize: 9,
            bold: true,
          },
        ],
      }
    })
    slab.text = slab.lines.map((line) => line.text).join(' ')
    const followingProse = textRegion(
      'expanded-edge-table-following-prose',
      'The following paragraph remains outside the table rendition.',
      box(0.12, 0.55, 0.68, 0.016),
    )
    const tightTextBox = {
      page: slab.box.page,
      x: slab.box.x,
      y: slab.box.y,
      width: slab.box.width,
      height: slab.box.height,
      rotation: slab.box.rotation,
    }
    const successfulCrops: NormalizedSourceBox[] = []
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        const tightTextOnlyFallback =
          Math.abs(input.sourceBox.x - tightTextBox.x) < 0.00001 &&
          Math.abs(input.sourceBox.y - tightTextBox.y) < 0.00001 &&
          Math.abs(input.sourceBox.width - tightTextBox.width) < 0.00001 &&
          Math.abs(input.sourceBox.height - tightTextBox.height) < 0.00001
        if (!tightTextOnlyFallback && cropBottom < bottomRuleY) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        successfulCrops.push({ ...input.sourceBox })
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 180,
          height: 80,
          pixels: new Uint8Array(180 * 80 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [caption, slab, followingProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    expect(
      rasterizeFigure.mock.calls.some(
        ([input]) =>
          Math.abs(input.sourceBox.y - tightTextBox.y) < 0.00001 &&
          Math.abs(input.sourceBox.height - tightTextBox.height) < 0.00001,
      ),
    ).toBe(false)
    expect(successfulCrops).toHaveLength(1)
    expect(
      successfulCrops[0].y + successfulCrops[0].height,
    ).toBeGreaterThanOrEqual(bottomRuleY)
    expect(
      successfulCrops[0].y + successfulCrops[0].height,
    ).toBeLessThanOrEqual(followingProse.box.y + 0.00001)
    expect(relationship).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
    expect(relationship?.evidence).not.toContain(
      'source-page-crop-tightened-away-from-adjacent-text',
    )
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('does not clear a wide-rule table edge by crossing side prose', async () => {
    const caption = {
      ...captionRegion(
        'Table 1. A table whose unproved rule extension meets side prose.',
        box(0.1, 0.52, 0.8, 0.025),
      ),
      id: 'wide-rule-side-prose-table-caption',
    }
    const rows = Array.from({ length: 7 }, (_, index) => {
      const region = textRegion(
        `wide-rule-side-prose-table-row-${index + 1}`,
        `Metric ${index + 1}  ${40 + index}.0  ${70 + index}.0`,
        box(0.2, 0.55 + index * 0.016, 0.48, 0.012),
      )
      region.lines[0].fontSize = 8
      region.lines[0].runs[0] = {
        ...region.lines[0].runs[0],
        fontName: 'TableSerif-Regular',
        fontSize: 8,
      }
      const baseRun = region.lines[0].runs[0]
      region.lines[0].runs = [
        {
          ...baseRun,
          text: `Metric ${index + 1}`,
          x: 0.2,
          width: 0.14,
        },
        {
          ...baseRun,
          text: `${40 + index}.0`,
          x: 0.45,
          width: 0.05,
        },
        {
          ...baseRun,
          text: `${70 + index}.0`,
          x: 0.6,
          width: 0.05,
        },
      ]
      return region
    })
    const sideProse = textRegion(
      'wide-rule-table-side-prose',
      'Side prose must never be absorbed by a speculative table rule.',
      box(0.72, 0.56, 0.22, 0.085),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        if (cropRight >= sideProse.box.x) {
          throw new Error('unsafe table crop crossed side prose')
        }
        throw new Error('PDF page crop has source ink touching its edge')
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [caption, ...rows, sideProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    expect(relationship).toMatchObject({
      status: 'unresolved',
      assetIds: [],
      evidence: expect.arrayContaining([
        'source-page-crop-edge-contact',
        'source-rendition-unavailable',
      ]),
    })
    expect(
      rasterizeFigure.mock.calls.every(([input]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        return cropRight < sideProse.box.x
      }),
    ).toBe(true)
    expect(result.consumedRegionIds.has(sideProse.id)).toBe(false)
    expect(result.consumedLineIds.has(sideProse.lines[0].id)).toBe(false)
  })

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
})
