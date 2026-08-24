import { describe, expect, it, vi } from 'vitest'
import type { PdfPageRegion } from './import-types'
import {
  isProbableDisplayEquation,
  reconstructPdfVisuals,
  type PdfFigureRasterizer,
} from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'
import {
  box,
  containsSourceBox,
  equationRegion,
  page,
  textRegion,
} from './pdf-visuals.test-fixtures'

describe('PDF visual equation grouping', () => {
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

  it('does not assign an upright argmax row between two separate displays', async () => {
    const first = equationRegion(
      'unrelated-upright-between-first',
      'x = y',
      box(0.25, 0.3, 0.3, 0.02),
    )
    const unrelated = equationRegion(
      'unrelated-upright-between-row',
      '= arg max',
      box(0.36, 0.3385, 0.09, 0.013),
    )
    unrelated.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
    const second = equationRegion(
      'unrelated-upright-between-second',
      'u = v',
      box(0.25, 0.37, 0.3, 0.02),
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
      regions: [first, unrelated, second],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.flatMap(
        (relationship) => relationship.sourceRegionIds,
      ),
    ).not.toContain(unrelated.id)
    expect(result.consumedRegionIds.has(unrelated.id)).toBe(false)
  })

  it('groups a fragmented Latin Modern probability vector with its closing row and scripts', async () => {
    const top = textRegion(
      'latin-modern-vector-top',
      'pW,θ',
      box(0.343, 0.741, 0.063, 0.024),
    )
    top.lines[0].runs = [
      {
        ...top.lines[0].box,
        text: '',
        x: 0.343,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'pW',
        x: 0.355,
        width: 0.02,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'θ',
        x: 0.377,
        width: 0.008,
        fontName: 'Synthetic-LMMathItalic8-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: '',
        x: 0.395,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
    ]
    const topMathLine = top.lines[0]
    const proseBox = box(0.141, 0.722, 0.532, 0.013)
    top.lines = [
      {
        ...topMathLine,
        id: 'latin-modern-vector-top-prose-line',
        text: 'language model, and the output is a sequence of probability distributions',
        box: proseBox,
        runs: [
          {
            ...proseBox,
            text: 'language model, and the output is a sequence of probability distributions',
            fontName: 'Synthetic-NimbusRoman-Regular',
            fontSize: 10,
            confidence: 1,
          },
        ],
      },
      topMathLine,
    ]
    top.text =
      'language model, and the output is a sequence of probability distributions pW,θ'
    top.box = box(0.141, 0.722, 0.532, 0.043)
    const middle = equationRegion(
      'latin-modern-vector-middle',
      ' 1 ...  = Softmax(Encoder(x))',
      box(0.343, 0.759, 0.309, 0.025),
    )
    middle.lines[0].runs = [
      {
        ...middle.lines[0].box,
        text: '',
        x: 0.343,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...middle.lines[0].box,
        text: '1 ...',
        x: 0.366,
        width: 0.02,
        fontName: 'Synthetic-LMRoman8-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...middle.lines[0].box,
        text: '',
        x: 0.395,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...middle.lines[0].box,
        text: '= Softmax(Encoder(x))',
        x: 0.423,
        width: 0.229,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10,
        confidence: 1,
      },
    ]
    const printedNumber = textRegion(
      'latin-modern-vector-number',
      '(1.9)',
      box(0.819, 0.771, 0.035, 0.013),
    )
    printedNumber.column = 'right'
    middle.column = 'left'
    const bottom = textRegion(
      'latin-modern-vector-bottom',
      ' . ',
      box(0.343, 0.775, 0.063, 0.014),
    )
    bottom.lines[0].runs = [
      {
        ...bottom.lines[0].box,
        text: '',
        x: 0.343,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...bottom.lines[0].box,
        text: '.',
        x: 0.373,
        width: 0.005,
        fontName: 'Synthetic-LMRoman8-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...bottom.lines[0].box,
        text: '',
        x: 0.395,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
    ]
    const romanScript = textRegion(
      'latin-modern-vector-roman-script',
      'W',
      box(0.52, 0.777, 0.017, 0.009),
    )
    romanScript.lines[0].runs[0].fontName = 'Synthetic-LMRoman8-Bold'
    romanScript.lines[0].runs[0].fontSize = 8
    const mathScript = textRegion(
      'latin-modern-vector-math-script',
      'θ',
      box(0.611, 0.777, 0.007, 0.009),
    )
    mathScript.lines[0].runs[0].fontName = 'Synthetic-LMMathItalic8-Regular'
    const lowerEntry = equationRegion(
      'latin-modern-vector-lower-entry',
      'pWm,θ',
      box(0.355, 0.791, 0.039, 0.017),
    )
    lowerEntry.lines[0].id = 'latin-modern-vector-inline-stacked-0049-formula'
    lowerEntry.lines[0].runs = [
      {
        ...lowerEntry.lines[0].box,
        text: 'pW',
        width: 0.02,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...lowerEntry.lines[0].box,
        text: 'm,θ',
        x: 0.375,
        width: 0.019,
        fontName: 'Synthetic-LMMathItalic8-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
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
        middle,
        printedNumber,
        bottom,
        romanScript,
        mathScript,
        lowerEntry,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1.9',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        top.id,
        middle.id,
        printedNumber.id,
        bottom.id,
        romanScript.id,
        mathScript.id,
        lowerEntry.id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
  })

  it('does not absorb extension-delimited ordinary text into a display equation', async () => {
    const formula = equationRegion(
      'mixed-extension-prose-display',
      'x = y',
      box(0.25, 0.3, 0.3, 0.02),
    )
    const mixedProse = textRegion(
      'mixed-extension-prose-fragment',
      ' note. ',
      box(0.31, 0.323, 0.12, 0.014),
    )
    mixedProse.lines[0].runs = [
      {
        ...mixedProse.lines[0].box,
        text: '',
        width: 0.012,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...mixedProse.lines[0].box,
        text: 'note.',
        x: 0.335,
        width: 0.06,
        fontName: 'Synthetic-NimbusRoman-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...mixedProse.lines[0].box,
        text: '',
        x: 0.418,
        width: 0.012,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
    ]
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
      regions: [formula, mixedProse],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].sourceRegionIds).not.toContain(mixedProse.id)
    expect(result.consumedRegionIds.has(mixedProse.id)).toBe(false)
    expect(result.consumedLineIds.has(mixedProse.lines[0].id)).toBe(false)
  })

  it('does not assign a small bold Roman script between competing stacked displays', async () => {
    const first = equationRegion(
      'competing-stacked-display-first',
      'x = y',
      box(0.05, 0.3, 0.5, 0.025),
    )
    const second = equationRegion(
      'competing-stacked-display-second',
      'u = v',
      box(0.45, 0.3, 0.5, 0.025),
    )
    for (const display of [first, second]) {
      display.lines[0].runs = [
        {
          ...display.lines[0].box,
          text: '',
          width: 0.012,
          fontName: 'Synthetic-LMMathExtension10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...display.lines[0].box,
          text: display === first ? 'x = y' : 'u = v',
          x: display.box.x + 0.02,
          width: 0.08,
          fontName: 'Synthetic-LMRoman10-Regular',
          fontSize: 10,
          confidence: 1,
        },
      ]
    }
    const ambiguousScript = textRegion(
      'competing-stacked-display-script',
      'W',
      box(0.493, 0.326, 0.014, 0.009),
    )
    ambiguousScript.lines[0].runs[0].fontName = 'Synthetic-LMRoman8-Bold'
    ambiguousScript.lines[0].runs[0].fontSize = 8
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
      regions: [first, second, ambiguousScript],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.flatMap(
        (relationship) => relationship.sourceRegionIds,
      ),
    ).not.toContain(ambiguousScript.id)
    expect(result.consumedRegionIds.has(ambiguousScript.id)).toBe(false)
    expect(result.consumedLineIds.has(ambiguousScript.lines[0].id)).toBe(false)
  })

  it('keeps a contextual Roman script from splitting adjacent rows of one stacked display', async () => {
    const middle = equationRegion(
      'contextual-roman-stacked-middle',
      ' 1  = Softmax(Encoder(x))',
      box(0.343, 0.759, 0.309, 0.025),
    )
    middle.lines[0].runs = [
      {
        ...middle.lines[0].box,
        text: '',
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...middle.lines[0].box,
        text: '= Softmax(Encoder(x))',
        x: 0.423,
        width: 0.229,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10,
        confidence: 1,
      },
    ]
    const contextualScript = textRegion(
      'contextual-roman-stacked-script',
      'W',
      box(0.52, 0.777, 0.017, 0.009),
    )
    contextualScript.lines[0].runs[0].fontName = 'Synthetic-LMRoman8-Bold'
    contextualScript.lines[0].runs[0].fontSize = 8
    const printedNumber = textRegion(
      'contextual-roman-stacked-number',
      '(1.9)',
      box(0.819, 0.771, 0.035, 0.013),
    )
    printedNumber.column = 'right'
    middle.column = 'left'
    const lowerEntry = equationRegion(
      'contextual-roman-stacked-lower-entry',
      'pWm,θ',
      box(0.355, 0.791, 0.039, 0.017),
    )
    lowerEntry.lines[0].id =
      'contextual-roman-stacked-inline-stacked-0049-formula'
    lowerEntry.lines[0].runs = [
      {
        ...lowerEntry.lines[0].box,
        text: 'pW',
        width: 0.02,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...lowerEntry.lines[0].box,
        text: 'm,θ',
        x: 0.375,
        width: 0.019,
        fontName: 'Synthetic-LMMathItalic8-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
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
      regions: [middle, contextualScript, printedNumber, lowerEntry],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        middle.id,
        contextualScript.id,
        printedNumber.id,
        lowerEntry.id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
  })

  it('groups a neutral vertical ellipsis and embedded printed number inside a stacked delimiter matrix', async () => {
    const top = textRegion(
      'stacked-delimiter-matrix-top',
      ' Pr(·|x0, ..., xm−1) ',
      box(0.326, 0.747, 0.159, 0.024),
    )
    top.lines[0].runs = [
      {
        ...top.lines[0].box,
        text: '',
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'Pr(·|x0, ..., xm−1)',
        x: 0.337,
        width: 0.136,
        fontName: 'Synthetic-LMMathSymbols10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: '',
        x: 0.473,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
    ]
    const matrix = equationRegion(
      'stacked-delimiter-matrix',
      'x = y',
      box(0.326, 0.768, 0.343, 0.034),
    )
    matrix.lines[0].runs = [
      {
        ...matrix.lines[0].box,
        text: '',
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...matrix.lines[0].box,
        text: 'x = y',
        x: 0.473,
        width: 0.196,
        fontName: 'Synthetic-LMMathItalic10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...matrix.lines[0].box,
        text: '',
        x: 0.473,
        width: 0.011,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
    ]
    const verticalEllipsis = textRegion(
      'stacked-delimiter-neutral-ellipsis',
      '...',
      box(0.403, 0.77, 0.005, 0.022),
    )
    verticalEllipsis.lines[0].runs = [0, 1, 2].map((index) => ({
      ...verticalEllipsis.lines[0].box,
      text: '.',
      y: 0.77 + index * 0.0047,
      height: 0.013,
      fontName: 'Synthetic-NimbusRoman-Regular',
      fontSize: 10,
      confidence: 1,
    }))
    const bottom = textRegion(
      'stacked-delimiter-number-and-bottom',
      '(2.12)  Pr(·|x0, x1) ',
      box(0.326, 0.785, 0.528, 0.028),
    )
    const numberLine = {
      ...bottom.lines[0],
      id: 'stacked-delimiter-printed-number-line',
      text: '(2.12)',
      box: box(0.81, 0.785, 0.044, 0.013),
      runs: [
        {
          ...box(0.81, 0.785, 0.044, 0.013),
          text: '(2.12)',
          fontName: 'Synthetic-NimbusRoman-Regular',
          fontSize: 10,
          confidence: 1,
        },
      ],
    }
    const bottomLine = {
      ...bottom.lines[0],
      id: 'stacked-delimiter-bottom-line',
      text: ' Pr(·|x0, x1) ',
      box: box(0.326, 0.796, 0.159, 0.015),
      runs: [
        {
          ...box(0.326, 0.796, 0.011, 0.012),
          text: '',
          fontName: 'Synthetic-LMMathExtension10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...box(0.36, 0.796, 0.09, 0.013),
          text: 'Pr(·|x0, x1)',
          fontName: 'Synthetic-LMMathSymbols10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...box(0.473, 0.796, 0.011, 0.012),
          text: '',
          fontName: 'Synthetic-LMMathExtension10-Regular',
          fontSize: 10,
          confidence: 1,
        },
      ],
    }
    bottom.lines = [numberLine, bottomLine]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 24,
          pixels: new Uint8Array(64 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [top, matrix, verticalEllipsis, bottom],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 2.12',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        top.id,
        matrix.id,
        verticalEllipsis.id,
        bottom.id,
      ]),
      sourceLineIds: expect.arrayContaining([
        matrix.lines[0].id,
        verticalEllipsis.lines[0].id,
        numberLine.id,
        bottomLine.id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
  })

  it.each(['plain equation', 'one delimiter side'])(
    'does not absorb a neutral ellipsis beside a %s',
    async (fixture) => {
      const formula = equationRegion(
        `neutral-ellipsis-${fixture.replaceAll(' ', '-')}`,
        'x = y',
        box(0.25, 0.3, 0.3, 0.025),
      )
      formula.lines[0].runs = [
        ...(fixture === 'one delimiter side'
          ? [
              {
                ...formula.lines[0].box,
                text: '',
                width: 0.011,
                fontName: 'Synthetic-LMMathExtension10-Regular',
                fontSize: 10,
                confidence: 1,
              },
            ]
          : []),
        {
          ...formula.lines[0].box,
          text: 'x = y',
          x: 0.3,
          width: 0.1,
          fontName: 'Synthetic-LMMathItalic10-Regular',
          fontSize: 10,
          confidence: 1,
        },
      ]
      const ellipsis = textRegion(
        `neutral-ellipsis-${fixture.replaceAll(' ', '-')}-fragment`,
        '...',
        box(0.41, 0.304, 0.005, 0.018),
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
        regions: [formula, ellipsis],
        rasterizeFigure,
      })

      expect(result.relationships).toHaveLength(1)
      expect(result.relationships[0].sourceRegionIds).not.toContain(ellipsis.id)
      expect(result.consumedRegionIds.has(ellipsis.id)).toBe(false)
      expect(result.consumedLineIds.has(ellipsis.lines[0].id)).toBe(false)
    },
  )

  it('does not bridge a neutral ellipsis between separate stacked displays', async () => {
    const first = equationRegion(
      'neutral-ellipsis-separate-first',
      'x = y',
      box(0.1, 0.3, 0.3, 0.025),
    )
    const second = equationRegion(
      'neutral-ellipsis-separate-second',
      'u = v',
      box(0.6, 0.3, 0.3, 0.025),
    )
    for (const display of [first, second]) {
      display.lines[0].runs = [
        {
          ...display.lines[0].box,
          text: '',
          width: 0.011,
          fontName: 'Synthetic-LMMathExtension10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...display.lines[0].box,
          text: display === first ? 'x = y' : 'u = v',
          x: display.box.x + 0.04,
          width: 0.1,
          fontName: 'Synthetic-LMMathItalic10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...display.lines[0].box,
          text: '',
          x: display.box.x + display.box.width - 0.011,
          width: 0.011,
          fontName: 'Synthetic-LMMathExtension10-Regular',
          fontSize: 10,
          confidence: 1,
        },
      ]
    }
    const ellipsis = textRegion(
      'neutral-ellipsis-between-separate-displays',
      '...',
      box(0.497, 0.304, 0.006, 0.018),
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
      regions: [first, ellipsis, second],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.flatMap(
        (relationship) => relationship.sourceRegionIds,
      ),
    ).not.toContain(ellipsis.id)
    expect(result.consumedRegionIds.has(ellipsis.id)).toBe(false)
  })

  it('does not absorb an upright argmax phrase from prose into a display', async () => {
    const formula = equationRegion(
      'upright-derivation-prose-boundary-display',
      'x = y',
      box(0.25, 0.2, 0.24, 0.02),
    )
    const prose = textRegion(
      'upright-derivation-prose-boundary',
      '= arg max',
      box(0.35, 0.225, 0.1, 0.015),
    )
    prose.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
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
      regions: [formula, prose],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].sourceRegionIds).toEqual([formula.id])
    expect(result.consumedLineIds.has(prose.lines[0].id)).toBe(false)
  })
})
