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

describe('PDF visual association graph', () => {
  it('projects every accepted composite crop to lane-local text lineage', async () => {
    const compositeBox = box(0.04, 0.08, 0.92, 0.24)
    const objects = [
      {
        id: 'image-p001-final-crop-projection-1',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'image-p001-final-crop-projection-2',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const leftOverlay = textRegion(
      'final-crop-left-overlay',
      'left overlay alpha',
      box(0.1, 0.13, 0.22, 0.018),
    )
    const leftSecondLine = textRegion(
      'final-crop-left-overlay-second',
      'left overlay beta',
      box(0.28, 0.24, 0.18, 0.018),
    ).lines[0]
    const straddlingLine = textRegion(
      'final-crop-boundary-straddler',
      'boundary straddler stays canonical',
      box(0.498, 0.19, 0.04, 0.018),
    ).lines[0]
    leftOverlay.lines.push(leftSecondLine, straddlingLine)
    leftOverlay.text = leftOverlay.lines.map((line) => line.text).join(' ')
    leftOverlay.box = {
      ...leftOverlay.box,
      width: 0.438,
      height: 0.128,
    }
    const rightOverlay = textRegion(
      'final-crop-right-overlay',
      'right overlay alpha',
      box(0.61, 0.13, 0.22, 0.018),
    )
    const rightSecondLine = textRegion(
      'final-crop-right-overlay-second',
      'right overlay beta',
      box(0.72, 0.24, 0.18, 0.018),
    ).lines[0]
    rightOverlay.lines.push(rightSecondLine)
    rightOverlay.text = rightOverlay.lines.map((line) => line.text).join(' ')
    rightOverlay.box = {
      ...rightOverlay.box,
      width: 0.29,
      height: 0.128,
    }
    const unrelatedBody = textRegion(
      'final-crop-unrelated-body',
      'unrelated body prose remains canonical',
      box(0.12, 0.43, 0.32, 0.018),
    )
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The accepted left crop.',
          box(0.03, 0.35, 0.47, 0.025),
        ),
        id: 'final-crop-left-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The accepted right crop.',
          box(0.5, 0.35, 0.47, 0.025),
        ),
        id: 'final-crop-right-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const requestedRight = input.sourceBox.x + input.sourceBox.width
        const leftLane = input.sourceBox.x < 0.5
        const sourceCropBox = {
          ...input.sourceBox,
          x: leftLane ? input.sourceBox.x + 0.008 : 0.5,
          y: input.sourceBox.y + 0.012,
          width: leftLane
            ? 0.5 - (input.sourceBox.x + 0.008)
            : requestedRight - 0.008 - 0.5,
          height: input.sourceBox.height - 0.024,
        }
        const sourceBoxes = input.sourceBoxes.flatMap((sourceBox) => {
          const left = Math.max(sourceCropBox.x, sourceBox.x)
          const top = Math.max(sourceCropBox.y, sourceBox.y)
          const right = Math.min(
            sourceCropBox.x + sourceCropBox.width,
            sourceBox.x + sourceBox.width,
          )
          const bottom = Math.min(
            sourceCropBox.y + sourceCropBox.height,
            sourceBox.y + sourceBox.height,
          )
          return right > left && bottom > top
            ? [
                {
                  ...sourceBox,
                  x: left,
                  y: top,
                  width: right - left,
                  height: bottom - top,
                },
              ]
            : []
        })
        expect(sourceBoxes).toHaveLength(input.sourceBoxes.length)
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: sourceCropBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `final-crop-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        leftOverlay,
        rightOverlay,
        unrelatedBody,
        ...captions,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(result.relationships).toMatchObject([
      { status: 'matched' },
      { status: 'matched' },
    ])
    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    const acceptedAssets = result.relationships.map((relationship) =>
      result.assets.find((asset) => asset.id === relationship.assetIds[0]),
    )
    expect(acceptedAssets[0]?.sourceCropBox).toMatchObject({
      x: expect.any(Number),
      width: expect.any(Number),
    })
    expect(
      acceptedAssets[0]!.sourceCropBox!.x +
        acceptedAssets[0]!.sourceCropBox!.width,
    ).toBe(0.5)
    expect(acceptedAssets[1]?.sourceCropBox?.x).toBe(0.5)
    expect(
      (acceptedAssets[0]!.sourceCropBox!.x +
        acceptedAssets[0]!.sourceCropBox!.width -
        straddlingLine.box.x) /
        straddlingLine.box.width,
    ).toBeLessThan(0.1)
    for (const [index, asset] of acceptedAssets.entries()) {
      const request = rasterizeFigure.mock.calls[index][0]
      expect(asset).toBeDefined()
      expect(containsSourceBox(request.sourceBox, asset!.sourceCropBox!)).toBe(
        true,
      )
      expect(asset!.sourceCropBox).not.toEqual(request.sourceBox)
      expect(result.relationships[index].assetIds).toEqual([asset!.id])
      expect(result.relationships[index].sourceObjectIds).toEqual(
        asset!.sourceObjectIds,
      )
      expect(result.relationships[index].sourceObjectIds).toEqual(
        expect.arrayContaining(objects.map((object) => object.id)),
      )
      expect(result.relationships[index].sourceBoxes.slice(1)).toEqual(
        asset!.sourceBoxes,
      )
      expect(
        asset!.sourceBoxes.every((sourceBox) =>
          containsSourceBox(asset!.sourceCropBox!, sourceBox),
        ),
      ).toBe(true)
      expect(
        asset!.sourceBoxes.every((sourceBox) =>
          index === 0
            ? sourceBox.x + sourceBox.width <= 0.5
            : sourceBox.x >= 0.5,
        ),
      ).toBe(true)
    }
    expect(acceptedAssets[0]!.id).not.toBe(acceptedAssets[1]!.id)
    expect(result.relationships[0].sourceRegionIds).toEqual([
      'final-crop-object-region-1',
      'final-crop-object-region-2',
      leftOverlay.id,
    ])
    expect(result.relationships[1].sourceRegionIds).toEqual([
      'final-crop-object-region-1',
      'final-crop-object-region-2',
      rightOverlay.id,
    ])
    expect(result.relationships[0].sourceLineIds).toEqual([
      leftOverlay.lines[0].id,
      leftSecondLine.id,
    ])
    expect(result.relationships[1].sourceLineIds).toEqual([
      rightOverlay.lines[0].id,
      rightSecondLine.id,
    ])
    expect(result.relationships[0].sourceText).toBe(
      'left overlay alpha left overlay beta',
    )
    expect(result.relationships[1].sourceText).toBe(
      'right overlay alpha right overlay beta',
    )
    expect(result.relationships[0].sourceText).not.toContain('right overlay')
    expect(result.relationships[1].sourceText).not.toContain('left overlay')
    for (const relationship of result.relationships) {
      expect(relationship.sourceLineIds).not.toContain(straddlingLine.id)
      expect(relationship.sourceRegionIds).not.toContain(unrelatedBody.id)
      expect(relationship.sourceText).not.toContain(unrelatedBody.text)
      expect(relationship.sourceRegionIds).not.toContain(
        captions.find((caption) => caption.id !== relationship.captionRegionId)!
          .id,
      )
    }
    expect(result.consumedLineIds).toEqual(
      new Set([leftOverlay.lines[0].id, leftSecondLine.id]),
    )
    expect(result.consumedRegionIds).toEqual(new Set([rightOverlay.id]))
    expect(result.consumedLineIds.has(straddlingLine.id)).toBe(false)
    expect(result.consumedRegionIds.has(leftOverlay.id)).toBe(false)
    expect(result.consumedRegionIds.has(unrelatedBody.id)).toBe(false)
    expect(result.consumedLineIds.has(unrelatedBody.lines[0].id)).toBe(false)
    expect(
      captions.every((caption) => !result.consumedRegionIds.has(caption.id)),
    ).toBe(true)
  })

  it('keeps edge-recovery crops and synthetic ownership inside adjacent caption lanes', async () => {
    const panelObjectSpecs = [
      ['left', 0],
      ['right', 0.5],
    ] as const
    const objects = panelObjectSpecs.flatMap(([side, offset]) => [
      {
        id: `image-p001-${side}-lane-recovery-1`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.06, 0.07, 0.38, 0.17),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `image-p001-${side}-lane-recovery-2`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.065, 0.075, 0.37, 0.16),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `vector-p001-${side}-lane-recovery-top-band`,
        page: 1,
        kind: 'vector' as const,
        box: box(offset + 0.08, 0.035, 0.34, 0.02),
        confidence: 0.99,
        assetId: null,
      },
    ])
    const panelText = [
      textRegion(
        'left-lane-recovery-label-1',
        'Left owned panel label one',
        box(0.12, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'left-lane-recovery-label-2',
        'Left owned panel label two',
        box(0.35, 0.16, 0.145, 0.018),
      ),
      textRegion(
        'right-lane-recovery-label-1',
        'Right owned panel label one',
        box(0.505, 0.08, 0.145, 0.018),
      ),
      textRegion(
        'right-lane-recovery-label-2',
        'Right owned panel label two',
        box(0.68, 0.16, 0.2, 0.018),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The left recovered panel.',
          box(0.03, 0.26, 0.47, 0.025),
        ),
        id: 'lane-recovery-left-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The right recovered panel.',
          box(0.5, 0.26, 0.47, 0.025),
        ),
        id: 'lane-recovery-right-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
    ]
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
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        })
      },
    )
    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `lane-recovery-object-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        ...captions,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(result.relationships).toMatchObject([
      { status: 'matched' },
      { status: 'matched' },
    ])
    expect(
      result.relationships.map((relationship) => relationship.sourceObjectIds),
    ).toEqual([
      ['source-panel:lane-recovery-left-caption'],
      ['source-panel:lane-recovery-right-caption'],
    ])
    const recoveryInputs = rasterizeFigure.mock.calls
      .map(([input]) => input)
      .filter((input) => input.sourceObjectIds[0].startsWith('source-panel:'))
    expect(recoveryInputs).toHaveLength(2)
    expect(
      recoveryInputs.map((input) => ({
        left: input.sourceBox.x,
        right: input.sourceBox.x + input.sourceBox.width,
      })),
    ).toEqual([
      expect.objectContaining({ left: expect.any(Number), right: 0.5 }),
      expect.objectContaining({ left: 0.5, right: expect.any(Number) }),
    ])
    expect(
      result.relationships.map((relationship) => relationship.sourceBoxes[1]),
    ).toEqual(recoveryInputs.map((input) => input.sourceBox))
    expect(
      result.relationships.map((relationship) => relationship.sourceLineIds),
    ).toEqual([
      panelText.slice(0, 2).map((region) => region.lines[0].id),
      panelText.slice(2).map((region) => region.lines[0].id),
    ])
  })

  it('keeps native conflict accounting after disjoint synthetic crop recovery', async () => {
    const panelObjectSpecs = [
      ['left', 0],
      ['right', 0.5],
    ] as const
    const objects = panelObjectSpecs.flatMap(([side, offset]) => [
      {
        id: `image-p001-${side}-synthetic-scope-1`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.06, 0.07, 0.38, 0.17),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `image-p001-${side}-synthetic-scope-2`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.065, 0.075, 0.37, 0.16),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `vector-p001-${side}-synthetic-scope-top-band`,
        page: 1,
        kind: 'vector' as const,
        box: box(offset + 0.08, 0.035, 0.34, 0.02),
        confidence: 0.99,
        assetId: null,
      },
    ])
    const panelText = [
      textRegion(
        'synthetic-scope-left-overlay-1',
        'left recovered alpha',
        box(0.12, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'synthetic-scope-left-overlay-2',
        'left recovered beta',
        box(0.3, 0.16, 0.16, 0.018),
      ),
      textRegion(
        'synthetic-scope-right-overlay-1',
        'right recovered alpha',
        box(0.54, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'synthetic-scope-right-overlay-2',
        'right recovered beta',
        box(0.7, 0.16, 0.18, 0.018),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The first recovered left crop.',
          box(0.03, 0.35, 0.47, 0.025),
        ),
        id: 'synthetic-scope-left-caption',
        column: 'left' as const,
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The disjoint recovered right crop.',
          box(0.5, 0.35, 0.47, 0.025),
        ),
        id: 'synthetic-scope-right-caption',
        column: 'right' as const,
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
      {
        ...captionRegion(
          'Figure 3. A later overlapping left claim.',
          box(0.04, 0.385, 0.46, 0.025),
        ),
        id: 'synthetic-scope-overlap-caption',
        column: 'single' as const,
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (
          !input.sourceObjectIds.some((sourceObjectId) =>
            sourceObjectId.startsWith('source-panel:'),
          )
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(112),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `synthetic-scope-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        ...captions,
      ],
      rasterizeFigure,
    })

    const left = result.relationships.find(
      (relationship) =>
        relationship.captionRegionId === 'synthetic-scope-left-caption',
    )!
    const right = result.relationships.find(
      (relationship) =>
        relationship.captionRegionId === 'synthetic-scope-right-caption',
    )!
    const overlapping = result.relationships.find(
      (relationship) =>
        relationship.captionRegionId === 'synthetic-scope-overlap-caption',
    )!
    expect(left).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:synthetic-scope-left-caption'],
      sourceRegionIds: expect.arrayContaining([
        'synthetic-scope-object-region-1',
        'synthetic-scope-object-region-2',
        'synthetic-scope-object-region-3',
        panelText[0].id,
        panelText[1].id,
      ]),
      sourceLineIds: panelText.slice(0, 2).map((region) => region.lines[0].id),
      sourceText: 'left recovered alpha left recovered beta',
    })
    expect(right).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:synthetic-scope-right-caption'],
      sourceRegionIds: expect.arrayContaining([
        'synthetic-scope-object-region-4',
        'synthetic-scope-object-region-5',
        'synthetic-scope-object-region-6',
        panelText[2].id,
        panelText[3].id,
      ]),
      sourceLineIds: panelText.slice(2).map((region) => region.lines[0].id),
      sourceText: 'right recovered alpha right recovered beta',
    })
    expect(overlapping).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'cross-type-source-lineage-conflict',
        'source-rendition-unavailable',
      ]),
    })
    expect(
      overlapping.candidates.some((candidate) =>
        objects
          .slice(0, 3)
          .every((object) => candidate.sourceObjectIds.includes(object.id)),
      ),
    ).toBe(true)
    const recoveryInputs = rasterizeFigure.mock.calls
      .map(([input]) => input)
      .filter((input) =>
        input.sourceObjectIds.some((sourceObjectId) =>
          sourceObjectId.startsWith('source-panel:'),
        ),
      )
    expect(recoveryInputs).toHaveLength(2)
    const recoveryBounds = recoveryInputs.map((input) => ({
      left: input.sourceBox.x,
      right: input.sourceBox.x + input.sourceBox.width,
    }))
    expect(recoveryBounds[0].right).toBeLessThanOrEqual(0.5)
    expect(recoveryBounds[1].left).toBeGreaterThanOrEqual(0.5)
    expect(recoveryBounds[0].right).toBeLessThanOrEqual(recoveryBounds[1].left)
    const recoveredAssets = [left, right].map((relationship) =>
      result.assets.find((asset) => asset.id === relationship.assetIds[0]),
    )
    expect(recoveredAssets[0]!.id).not.toBe(recoveredAssets[1]!.id)
    for (const [index, relationship] of [left, right].entries()) {
      expect(recoveredAssets[index]).toMatchObject({
        sourceCropBox: recoveryInputs[index].sourceBox,
        sourceObjectIds: recoveryInputs[index].sourceObjectIds,
        sourceBoxes: recoveryInputs[index].sourceBoxes,
      })
      expect(relationship.sourceBoxes.slice(1)).toEqual(
        recoveryInputs[index].sourceBoxes,
      )
    }
  })
})
