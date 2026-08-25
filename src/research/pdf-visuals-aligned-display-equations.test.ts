import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import {
  isProbableDisplayEquation,
  reconstructPdfVisuals,
  type PdfFigureRasterizer,
} from './pdf-visuals'
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
  it('groups adjacent aligned display lines and their printed equation number into one crop', async () => {
    const first = equationRegion(
      'aligned-equation-line-1',
      'h_i^l = h_i^(l-1) + a_i^l + m_i^l',
      box(0.2, 0.2, 0.5, 0.025),
    )
    const second = equationRegion(
      'aligned-equation-line-2',
      'a_i^l = Attention(h_i^(l-1))',
      box(0.24, 0.235, 0.42, 0.025),
    )
    const third = equationRegion(
      'aligned-equation-line-3',
      'm_i^l = MLP(a_i^l + h_i^(l-1))',
      box(0.22, 0.27, 0.46, 0.025),
    )
    const printedNumber = {
      ...textRegion(
        'aligned-equation-number',
        '(1)',
        box(0.82, 0.235, 0.03, 0.02),
      ),
      kind: 'body' as const,
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 30,
          height: 12,
          pixels: new Uint8Array(30 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, second, third, printedNumber],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0]![0].sourceBox).toEqual(
      expect.objectContaining({
        y: expect.any(Number),
        height: expect.any(Number),
      }),
    )
    expect(
      rasterizeFigure.mock.calls[0]![0].sourceBox.y +
        rasterizeFigure.mock.calls[0]![0].sourceBox.height,
    ).toBeGreaterThan(third.box.y + third.box.height)
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'matched',
      sourceRegionIds: [first.id, second.id, printedNumber.id, third.id],
      sourceText: expect.stringContaining('Attention'),
    })

    const unresolved = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, second, third, printedNumber],
    })
    expect(unresolved.relationships).toHaveLength(1)
    expect(unresolved.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'unresolved',
    })
  })

  it.each([
    { printedLabel: '(1.22)', equationLabel: 'Equation 1.22' },
    { printedLabel: '(2.3.1b)', equationLabel: 'Equation 2.3.1b' },
  ])(
    'groups an argmin display with its detached sum, loss, subscript, and printed number $printedLabel',
    async ({ printedLabel, equationLabel }) => {
      const proseBox = {
        ...box(0.169, 0.845, 0.526, 0.013),
        method: 'pdf-text' as const,
      }
      const sumBox = {
        ...box(0.492, 0.865, 0.024, 0.012),
        method: 'pdf-text' as const,
      }
      const proseAndSum: PdfPageRegion = {
        ...textRegion(
          'argmin-prose-and-sum',
          'Then fine-tune the model by ∑',
          box(0.169, 0.845, 0.526, 0.032),
        ),
        lines: [
          {
            id: 'argmin-prose-line',
            text: 'Then fine-tune the model by',
            fontSize: 11,
            box: proseBox,
            runs: [
              {
                ...proseBox,
                text: 'Then fine-tune the model by',
                fontName: 'Synthetic-Roman',
                fontSize: 11,
                confidence: 1,
              },
            ],
          },
          {
            id: 'argmin-sum-line',
            text: '∑',
            fontSize: 10,
            box: sumBox,
            runs: [
              {
                ...sumBox,
                text: '∑',
                fontName: 'Synthetic-CMEX10',
                fontSize: 10,
                confidence: 1,
              },
            ],
          },
        ],
      }
      const argmin = equationRegion(
        'argmin-display-head',
        '(ω, θ) = arg min',
        box(0.312, 0.872, 0.151, 0.016),
      )
      argmin.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
      const loss = equationRegion(
        'argmin-loss-term',
        'Loss(yω,θ+, ygold)',
        box(0.545, 0.876, 0.138, 0.018),
      )
      loss.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
      const printedNumber = textRegion(
        'argmin-printed-number',
        printedLabel,
        box(0.81, 0.876, 0.044, 0.013),
      )
      const subscript = textRegion(
        'argmin-subscript',
        'ω,θ+ (x,ygold)∈D',
        box(0.417, 0.89, 0.125, 0.015),
      )
      subscript.lines[0].runs[0].fontName = 'Synthetic-CMMI8'
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) =>
          createSourcePageCropAsset({
            kind: 'equation',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 96,
            height: 24,
            pixels: new Uint8Array(96 * 24 * 4).fill(72),
          }),
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [proseAndSum, argmin, loss, printedNumber, subscript],
        rasterizeFigure,
      })

      expect(result.relationships).toHaveLength(1)
      expect(result.relationships[0]).toMatchObject({
        label: equationLabel,
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([
          proseAndSum.id,
          argmin.id,
          loss.id,
          printedNumber.id,
          subscript.id,
        ]),
        sourceLineIds: expect.arrayContaining([
          'argmin-sum-line',
          argmin.lines[0].id,
          loss.lines[0].id,
          printedNumber.lines[0].id,
          subscript.lines[0].id,
        ]),
      })
      expect(result.relationships[0].sourceLineIds).not.toContain(
        'argmin-prose-line',
      )
      expect(rasterizeFigure).toHaveBeenCalledOnce()
      const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
      for (const sourceBox of [
        sumBox,
        argmin.box,
        loss.box,
        printedNumber.box,
        subscript.box,
      ]) {
        expect(containsSourceBox(crop, sourceBox)).toBe(true)
      }
      expect(containsSourceBox(crop, proseBox)).toBe(false)
    },
  )

  it('groups a numbered summation with detached Latin Modern scripts and its lower bound', async () => {
    const formula = equationRegion(
      'latin-modern-summation',
      'Loss = − 1 ∑m log p(tag)',
      box(0.403, 0.397, 0.235, 0.025),
    )
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: 'Loss = 1 log p(tag)',
        width: 0.18,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 11,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '−',
        x: 0.486,
        width: 0.014,
        fontName: 'Synthetic-LMMathSymbols10-Regular',
        fontSize: 11,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '∑',
        x: 0.523,
        width: 0.024,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'm',
        x: 0.529,
        y: 0.397,
        width: 0.013,
        height: 0.009,
        fontName: 'Synthetic-LMMathItalic8-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const printedNumber = textRegion(
      'latin-modern-summation-number',
      '(1.23)',
      box(0.81, 0.408, 0.044, 0.013),
    )
    const firstDetachedScript = textRegion(
      'latin-modern-detached-script-first',
      'i',
      box(0.586, 0.414, 0.005, 0.009),
    )
    firstDetachedScript.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic8-Regular'
    const secondDetachedScript = textRegion(
      'latin-modern-detached-script-second',
      'i',
      box(0.625, 0.415, 0.005, 0.009),
    )
    secondDetachedScript.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic8-Regular'
    const lowerBound = equationRegion(
      'latin-modern-summation-lower-bound',
      'm i=1',
      box(0.502, 0.417, 0.045, 0.019),
    )
    lowerBound.lines[0].runs[0].fontName = 'Synthetic-LMMathItalic10-Regular'
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 24,
          pixels: new Uint8Array(96 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        formula,
        printedNumber,
        firstDetachedScript,
        secondDetachedScript,
        lowerBound,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1.23',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        formula.id,
        printedNumber.id,
        firstDetachedScript.id,
        secondDetachedScript.id,
        lowerBound.id,
      ]),
      sourceLineIds: expect.arrayContaining([
        formula.lines[0].id,
        printedNumber.lines[0].id,
        firstDetachedScript.lines[0].id,
        secondDetachedScript.lines[0].id,
        lowerBound.lines[0].id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const source of [
      formula,
      printedNumber,
      firstDetachedScript,
      secondDetachedScript,
      lowerBound,
    ]) {
      expect(containsSourceBox(crop, source.box)).toBe(true)
    }
  })

  it.each(['Regular', 'Bold'])(
    'does not promote Latin Modern Roman %s prose as a math fragment',
    async (style) => {
      const prose = textRegion(
        `latin-modern-roman-${style.toLowerCase()}-prose`,
        'A Latin Modern paragraph remains ordinary prose.',
        box(0.15, 0.3, 0.7, 0.02),
      )
      prose.lines[0].runs[0].fontName = `Synthetic-LMRoman10-${style}`

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [prose],
      })

      expect(result.relationships).toEqual([])
      expect(result.consumedRegionIds.has(prose.id)).toBe(false)
      expect(result.consumedLineIds.has(prose.lines[0].id)).toBe(false)
    },
  )

  it('keeps Latin Modern Roman letters and prose outside adjacent display equations', async () => {
    const first = equationRegion(
      'latin-modern-roman-boundary-first',
      'x = y',
      box(0.2, 0.2, 0.2, 0.02),
    )
    const detachedRomanLetter = textRegion(
      'latin-modern-detached-roman-letter',
      'i',
      box(0.41, 0.202, 0.008, 0.012),
    )
    detachedRomanLetter.lines[0].runs[0].fontName = 'Synthetic-LMRoman8-Regular'
    const prose = textRegion(
      'latin-modern-interstitial-prose',
      'where the estimate remains ordinary prose',
      box(0.2, 0.228, 0.32, 0.016),
    )
    prose.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
    const second = equationRegion(
      'latin-modern-roman-boundary-second',
      'u = v',
      box(0.2, 0.252, 0.2, 0.02),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 16,
          pixels: new Uint8Array(48 * 16 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, detachedRomanLetter, prose, second],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.flatMap(
        (relationship) => relationship.sourceRegionIds,
      ),
    ).not.toContain(detachedRomanLetter.id)
    expect(
      result.relationships.flatMap(
        (relationship) => relationship.sourceRegionIds,
      ),
    ).not.toContain(prose.id)
    expect(result.consumedLineIds.has(detachedRomanLetter.lines[0].id)).toBe(
      false,
    )
    expect(result.consumedLineIds.has(prose.lines[0].id)).toBe(false)
  })

  it('groups an aligned upright derivation continuation with its cross-column equation number', async () => {
    const first = equationRegion(
      'upright-derivation-first-line',
      'θ = arg max ∑ log Prθ(x)',
      box(0.319, 0.408, 0.235, 0.026),
    )
    first.column = 'left'
    const sumBridge = textRegion(
      'upright-derivation-sum-bridge',
      '∑',
      box(0.445, 0.451, 0.054, 0.013),
    )
    sumBridge.column = 'left'
    sumBridge.lines[0].runs[0].fontName = 'Synthetic-LMMathExtension10-Regular'
    const uprightContinuation = equationRegion(
      'upright-derivation-operator-continuation',
      '= arg max',
      box(0.345, 0.463, 0.094, 0.013),
    )
    uprightContinuation.column = 'left'
    uprightContinuation.lines[0].runs[0].fontName =
      'Synthetic-LMRoman10-Regular'
    const formulaContinuation = equationRegion(
      'upright-derivation-formula-continuation',
      'log Prθ(x_i+1|x_0,...,x_i)',
      box(0.502, 0.463, 0.174, 0.015),
    )
    formulaContinuation.column = 'left'
    formulaContinuation.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic10-Regular'
    const lowerScope = textRegion(
      'upright-derivation-lower-scope',
      'x∈D i=0',
      box(0.442, 0.48, 0.056, 0.01),
    )
    lowerScope.column = 'left'
    lowerScope.lines[0].runs[0].fontName = 'Synthetic-LMMathSymbols8-Regular'
    const printedNumber = textRegion(
      'upright-derivation-cross-column-number',
      '(1.7)',
      box(0.819, 0.463, 0.035, 0.013),
    )
    printedNumber.column = 'right'
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 24,
          pixels: new Uint8Array(96 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        first,
        sumBridge,
        uprightContinuation,
        formulaContinuation,
        lowerScope,
        printedNumber,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1.7',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        first.id,
        sumBridge.id,
        uprightContinuation.id,
        formulaContinuation.id,
        lowerScope.id,
        printedNumber.id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
  })

  it('groups an argmax derivation when the upright continuation is the lower display row', async () => {
    const top = equationRegion(
      'endpoint-upright-derivation-top',
      'yˆ = arg max log Pr(y|x)',
      box(0.29929, 0.32662, 0.21325, 0.01296),
    )
    top.lines[0].runs = [
      {
        ...top.lines[0].box,
        text: 'y',
        width: 0.01113,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'ˆ',
        x: 0.3003,
        width: 0.00917,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: '=',
        x: 0.32733,
        width: 0.01426,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'arg max',
        x: 0.35819,
        width: 0.06292,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'log Pr(',
        x: 0.42454,
        width: 0.05354,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'y',
        x: 0.47798,
        width: 0.01113,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: '|',
        x: 0.48907,
        width: 0.0051,
        fontName: 'Synthetic-LMMathSymbols10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'x',
        x: 0.49412,
        width: 0.01113,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: ')',
        x: 0.50541,
        width: 0.00713,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
    ]
    expect(isProbableDisplayEquation(top)).toBe(true)
    const upperScript = textRegion(
      'endpoint-upright-derivation-upper-script',
      'y',
      box(0.38561, 0.33966, 0.00867, 0.00947),
    )
    upperScript.lines[0].runs[0].fontName = 'Synthetic-LMRoman8-Bold'
    upperScript.lines[0].runs[0].fontSize = 8
    const sumBridge = textRegion(
      'endpoint-upright-derivation-sum',
      '∑n',
      box(0.42454, 0.35263, 0.02418, 0.01303),
    )
    sumBridge.lines[0].runs = [
      {
        ...sumBridge.lines[0].box,
        text: '∑',
        width: 0.014,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...sumBridge.lines[0].box,
        text: 'n',
        x: 0.439,
        width: 0.01,
        fontName: 'Synthetic-LMMathItalic8-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const lower = equationRegion(
      'endpoint-upright-derivation-lower',
      '= arg max',
      box(0.32733, 0.36424, 0.09379, 0.01296),
    )
    lower.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
    const formulaContinuation = equationRegion(
      'endpoint-upright-derivation-formula',
      'log Pr(yi|x0,...,xm,y1,...,yi−1)',
      box(0.452, 0.364, 0.244, 0.015),
    )
    formulaContinuation.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic10-Regular'
    const printedNumber = textRegion(
      'endpoint-upright-derivation-number',
      '(2.15)',
      box(0.81, 0.364, 0.044, 0.013),
    )
    const lowerScript = textRegion(
      'endpoint-upright-derivation-lower-script',
      'y',
      box(0.386, 0.377, 0.009, 0.009),
    )
    lowerScript.lines[0].runs[0].fontName = 'Synthetic-LMMathItalic8-Regular'
    const lowerBound = textRegion(
      'endpoint-upright-derivation-lower-bound',
      'i=1',
      box(0.425, 0.382, 0.023, 0.009),
      'side',
    )
    lowerBound.lines[0].runs[0].fontName = 'Synthetic-LMMathItalic8-Regular'
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 24,
          pixels: new Uint8Array(96 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        top,
        upperScript,
        sumBridge,
        lower,
        formulaContinuation,
        printedNumber,
        lowerScript,
        lowerBound,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 2.15',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        top.id,
        upperScript.id,
        sumBridge.id,
        lower.id,
        formulaContinuation.id,
        printedNumber.id,
        lowerScript.id,
        lowerBound.id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
  })

  it.each(['math bridge', 'printed number'])(
    'does not join endpoint argmax rows without a unique %s',
    async (missingEvidence) => {
      const top = equationRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-top`,
        'yˆ = arg max log Pr(y|x)',
        box(0.299, 0.327, 0.213, 0.013),
      )
      top.lines[0].runs = [
        {
          ...top.lines[0].box,
          text: 'yˆ = arg max log Pr(y',
          width: 0.17,
          fontName: 'Synthetic-LMRoman10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...top.lines[0].box,
          text: '|',
          x: 0.469,
          width: 0.008,
          fontName: 'Synthetic-LMMathSymbols10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...top.lines[0].box,
          text: 'x)',
          x: 0.477,
          width: 0.035,
          fontName: 'Synthetic-LMRoman10-Regular',
          fontSize: 10,
          confidence: 1,
        },
      ]
      const bridge = textRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-bridge`,
        '∑n',
        box(0.425, 0.353, 0.024, 0.013),
      )
      bridge.lines[0].runs = [
        {
          ...bridge.lines[0].box,
          text: '∑',
          width: 0.014,
          fontName: 'Synthetic-LMMathExtension10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...bridge.lines[0].box,
          text: 'n',
          x: 0.439,
          width: 0.01,
          fontName: 'Synthetic-LMMathItalic8-Regular',
          fontSize: 8,
          confidence: 1,
        },
      ]
      const lower = equationRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-lower`,
        '= arg max',
        box(0.327, 0.364, 0.094, 0.013),
      )
      lower.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
      const continuation = equationRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-continuation`,
        'log Pr(yi|x)',
        box(0.432, 0.364, 0.16, 0.015),
      )
      continuation.lines[0].runs[0].fontName =
        'Synthetic-LMMathItalic10-Regular'
      const printedNumber = textRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-number`,
        '(2.15)',
        box(0.81, 0.364, 0.044, 0.013),
      )
      const regions = [
        top,
        ...(missingEvidence === 'math bridge' ? [] : [bridge]),
        lower,
        continuation,
        ...(missingEvidence === 'printed number' ? [] : [printedNumber]),
      ]
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) =>
          createSourcePageCropAsset({
            kind: 'equation',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 64,
            height: 20,
            pixels: new Uint8Array(64 * 20 * 4).fill(72),
          }),
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions,
        rasterizeFigure,
      })

      expect(
        result.relationships.some(
          (relationship) =>
            relationship.sourceRegionIds.includes(top.id) &&
            relationship.sourceRegionIds.includes(lower.id),
        ),
      ).toBe(false)
    },
  )
})
