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

describe('PDF visual association graph', () => {
  it('fails equation matching closed when an inline stacked formula omits its sibling text fragments', async () => {
    const fragmentBaseId = 'page-001-inline-stacked-0001'
    const before = textRegion(
      'inline-stacked-before',
      'Caption text before',
      box(0.2, 0.52, 0.16, 0.018),
      'caption',
    )
    before.lines[0].id = `${fragmentBaseId}-before`
    const formula = equationRegion(
      'inline-stacked-formula',
      'h=x',
      box(0.37, 0.52, 0.05, 0.018),
    )
    formula.lines[0].id = `${fragmentBaseId}-formula`
    const after = textRegion(
      'inline-stacked-after',
      'and after',
      box(0.43, 0.52, 0.09, 0.018),
      'caption',
    )
    after.lines[0].id = `${fragmentBaseId}-after`
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 14,
          pixels: new Uint8Array(40 * 14 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [before, formula, after],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        status: 'unresolved',
        sourceRegionIds: [],
        evidence: expect.arrayContaining(['incomplete-equation-source-scope']),
      }),
    ])
  })

  it.each(['added', 'dropped', 'mutated'] as const)(
    'rejects %s exclusion-mask metadata from an inline equation crop',
    async (maskDrift) => {
      const fragmentBaseId = 'page-001-inline-stacked-0002'
      const before = textRegion(
        'mask-bound-inline-before',
        'Before',
        box(0.2, 0.52, 0.169, 0.018),
      )
      before.lines[0].id = `${fragmentBaseId}-before`
      const formula = equationRegion(
        'mask-bound-inline-formula',
        'a/b = c',
        box(0.37, 0.52, 0.05, 0.018),
      )
      formula.lines[0].id = `${fragmentBaseId}-formula`
      formula.lines[0].runs = [
        {
          ...formula.lines[0].box,
          text: 'a',
          x: 0.37,
          y: 0.518,
          width: 0.012,
          height: 0.008,
          fontName: 'Synthetic-CMMI8',
          fontSize: 8,
          confidence: 1,
        },
        {
          ...formula.lines[0].box,
          text: 'b',
          x: 0.37,
          y: 0.53,
          width: 0.012,
          height: 0.008,
          fontName: 'Synthetic-CMMI8',
          fontSize: 8,
          confidence: 1,
        },
        {
          ...formula.lines[0].box,
          text: '= c',
          x: 0.389,
          y: 0.523,
          width: 0.031,
          height: 0.012,
          fontName: 'Synthetic-CMMI12',
          fontSize: 12,
          confidence: 1,
        },
      ]
      const after = textRegion(
        'mask-bound-inline-after',
        'after',
        box(0.421, 0.52, 0.08, 0.018),
      )
      after.lines[0].id = `${fragmentBaseId}-after`
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) => {
          if (maskDrift === 'dropped' && !input.excludedSourceBoxes?.length) {
            throw new Error('PDF page crop has source ink touching its edge')
          }
          expect(input.ownedSourceBoxes?.length).toBeGreaterThan(0)
          expect(input.excludedSourceBoxes).toHaveLength(2)
          const ownedSourceBoxes = input.ownedSourceBoxes!.map((sourceBox) => ({
            ...sourceBox,
          }))
          const excludedSourceBoxes = input.excludedSourceBoxes!.map(
            (sourceBox) => ({ ...sourceBox }),
          )
          if (maskDrift === 'mutated') {
            excludedSourceBoxes[0].x += Number.EPSILON
          } else if (maskDrift === 'added') {
            excludedSourceBoxes.push({
              page: 1,
              x: 0.1,
              y: 0.1,
              width: 0.01,
              height: 0.004,
              rotation: 0,
              method: 'pdf-text',
            })
          }
          return createSourcePageCropAsset({
            kind: 'equation',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 48,
            height: 14,
            pixels: new Uint8Array(48 * 14 * 4).fill(72),
            ...(maskDrift === 'dropped'
              ? {}
              : {
                  sourceExclusionMask: {
                    algorithm: 'nearest-source-box-v1',
                    expansionPixels: 2,
                    ownedSourceBoxes,
                    excludedSourceBoxes,
                  },
                }),
          })
        },
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [before, formula, after],
        rasterizeFigure,
      })

      if (maskDrift === 'dropped') {
        expect(rasterizeFigure.mock.calls.length).toBeGreaterThan(1)
        expect(
          rasterizeFigure.mock.calls.some(
            ([input]) => !input.excludedSourceBoxes?.length,
          ),
        ).toBe(true)
      } else {
        expect(rasterizeFigure).toHaveBeenCalledOnce()
      }
      expect(result.relationships).toEqual([
        expect.objectContaining({
          kind: 'equation',
          status: 'unresolved',
          assetIds: [],
          evidence: expect.arrayContaining(['source-rendition-unavailable']),
        }),
      ])
    },
  )

  it('does not let transitive math fragments bridge distinct numbered equations', async () => {
    const equationTwo = equationRegion(
      'transitive-equation-two',
      'Control = Σ',
      box(0.55, 0.31, 0.18, 0.02),
    )
    const equationTwoNumber = textRegion(
      'transitive-equation-two-number',
      '(2)',
      box(0.86, 0.33, 0.025, 0.014),
    )
    const bridge = textRegion(
      'transitive-equation-math-bridge',
      '∫₀¹ f(x) dx / |A|',
      box(0.7, 0.35, 0.06, 0.014),
    )
    bridge.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const equationThree = equationRegion(
      'transitive-equation-three',
      'Loss = ∫₀∞ q(x) dx',
      box(0.55, 0.39, 0.18, 0.02),
    )
    const equationThreeNumber = textRegion(
      'transitive-equation-three-number',
      '(3)',
      box(0.86, 0.4, 0.025, 0.014),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 16,
          pixels: new Uint8Array(64 * 16 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        equationTwo,
        equationTwoNumber,
        bridge,
        equationThree,
        equationThreeNumber,
      ],
      rasterizeFigure,
    })

    expect(
      result.relationships.map((relationship) => relationship.label),
    ).toEqual(['Equation 2', 'Equation 3'])
    expect(
      result.relationships.map((relationship) =>
        relationship.sourceRegionIds.includes(bridge.id),
      ),
    ).toEqual([true, false])
    expect(result.relationships).toEqual([
      expect.objectContaining({
        label: 'Equation 2',
        status: 'matched',
        assetIds: [expect.any(String)],
        sourceRegionIds: expect.arrayContaining([
          equationTwo.id,
          equationTwoNumber.id,
          bridge.id,
        ]),
      }),
      expect.objectContaining({
        label: 'Equation 3',
        status: 'matched',
        assetIds: [expect.any(String)],
        sourceRegionIds: expect.arrayContaining([
          equationThree.id,
          equationThreeNumber.id,
        ]),
      }),
    ])
    const cropInputs = rasterizeFigure.mock.calls.map(([input]) => input)
    expect(cropInputs).toHaveLength(2)
    expect(containsSourceBox(cropInputs[0].sourceBox, equationTwo.box)).toBe(
      true,
    )
    expect(
      containsSourceBox(cropInputs[0].sourceBox, equationTwoNumber.box),
    ).toBe(true)
    expect(containsSourceBox(cropInputs[0].sourceBox, bridge.box)).toBe(true)
    expect(containsSourceBox(cropInputs[0].sourceBox, equationThree.box)).toBe(
      false,
    )
    expect(containsSourceBox(cropInputs[1].sourceBox, equationThree.box)).toBe(
      true,
    )
    expect(
      containsSourceBox(cropInputs[1].sourceBox, equationThreeNumber.box),
    ).toBe(true)
    expect(containsSourceBox(cropInputs[1].sourceBox, bridge.box)).toBe(false)
    expect(result.consumedRegionIds.has(bridge.id)).toBe(true)
  })

  it('keeps an equation unresolved when an adjacent math fragment has ambiguous ownership', async () => {
    const first = equationRegion(
      'ambiguous-scope-first',
      'a = b',
      box(0.2, 0.1, 0.24, 0.014),
    )
    const second = equationRegion(
      'ambiguous-scope-second',
      'c = d',
      box(0.2, 0.14, 0.24, 0.014),
    )
    const ambiguousDomain = textRegion(
      'ambiguous-scope-domain',
      'R',
      box(0.3, 0.123, 0.012, 0.008),
    )
    ambiguousDomain.lines[0].runs[0].fontName = 'Synthetic-MSBM10'
    const whereBody = textRegion(
      'ambiguous-scope-where-body',
      'where t is the observation time',
      box(0.47, 0.123, 0.24, 0.012),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 32,
          height: 10,
          pixels: new Uint8Array(32 * 10 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, ambiguousDomain, whereBody, second],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.every(
        (relationship) => relationship.status === 'unresolved',
      ),
    ).toBe(true)
    expect(result.consumedRegionIds.has(ambiguousDomain.id)).toBe(false)
    expect(result.consumedRegionIds.has(whereBody.id)).toBe(false)
    expect(
      result.relationships.every(
        (relationship) =>
          !relationship.sourceRegionIds.includes(ambiguousDomain.id) &&
          !relationship.sourceRegionIds.includes(whereBody.id),
      ),
    ).toBe(true)
  })

  it('keeps aligned equations in opposite columns as separate displays', async () => {
    const left: PdfPageRegion = equationRegion(
      'equation-left-column',
      'a = b',
      box(0.1, 0.31, 0.3, 0.02),
    )
    left.column = 'left'
    const right: PdfPageRegion = equationRegion(
      'equation-right-column',
      'c = d',
      box(0.52, 0.31, 0.3, 0.02),
    )
    right.column = 'right'
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 12,
          pixels: new Uint8Array(48 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [left, right],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.map(({ sourceRegionIds }) => sourceRegionIds),
    ).toEqual([[left.id], [right.id]])
  })

  it('retries an edge-touching equation crop inside neighboring prose', async () => {
    const precedingProse = textRegion(
      'equation-preceding-prose',
      'The variable backs off to the baseline when the program errs:',
      box(0.17647, 0.2489, 0.64706, 0.01258),
    )
    const equation = equationRegion(
      'equation-piecewise-value',
      'y = \u001aρx',
      box(0.41481, 0.26492, 0.05178, 0.03879),
    )
    equation.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const condition = equationRegion(
      'equation-piecewise-condition',
      'if [ρ] = x,',
      box(0.49826, 0.27453, 0.06746, 0.01258),
    )
    const followingProse = textRegion(
      'equation-following-prose',
      'We define the following metrics:',
      box(0.17647, 0.31599, 0.2126, 0.01258),
    )
    const previousBottom = precedingProse.box.y + precedingProse.box.height
    const followingTop = followingProse.box.y
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        if (
          input.sourceBox.y < previousBottom ||
          cropBottom > followingTop ||
          input.sourceBox.x > 0.403 ||
          cropRight < 0.577
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 14,
          pixels: new Uint8Array(48 * 14 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, equation, condition, followingProse],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.map(([input]) =>
        Math.round((equation.box.x - input.sourceBox.x) * 1_000),
      ),
    ).toEqual([4, 6, 8, 10, 12])
    const retry = rasterizeFigure.mock.calls.at(-1)![0].sourceBox
    expect(retry.y).toBeGreaterThanOrEqual(previousBottom)
    expect(retry.y + retry.height).toBeLessThanOrEqual(followingTop)
    expect(retry.x).toBeLessThanOrEqual(0.403)
    expect(retry.x + retry.width).toBeGreaterThanOrEqual(0.577)
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      sourceRegionIds: [equation.id, condition.id],
      sourceText: '',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
        'source-text-transcript-unresolved',
      ]),
    })
  })

  it('fails an adaptive equation crop closed before it encloses overlapping following prose', async () => {
    const equation = equationRegion(
      'equation-with-overlapping-neighbor',
      'z = ab',
      box(0.3, 0.4, 0.2, 0.02),
    )
    equation.lines[0].runs = [
      {
        ...equation.lines[0].box,
        text: 'z = ',
        x: 0.32,
        y: 0.405,
        width: 0.06,
        height: 0.012,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...equation.lines[0].box,
        text: 'a',
        x: 0.39,
        y: 0.4,
        width: 0.014,
        height: 0.007,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...equation.lines[0].box,
        text: 'b',
        x: 0.39,
        y: 0.413,
        width: 0.014,
        height: 0.007,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const followingProse = textRegion(
      'overlapping-equation-following-prose',
      'The next sentence remains canonical prose.',
      box(0.1, 0.4195, 0.7, 0.015),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const padding = equation.box.x - input.sourceBox.x
        if (padding < 0.012) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 18,
          pixels: new Uint8Array(64 * 18 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [equation, followingProse],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      assetIds: [],
      sourceText: '',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-unowned-text',
        'source-rendition-unavailable',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })
})
