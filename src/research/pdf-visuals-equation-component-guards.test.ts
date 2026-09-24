import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { pdfTextLedgerSha256 } from './pdf-text-paint'
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
  it('absorbs a bare Computer Modern numeric fraction part into the display crop scope', async () => {
    const formula = equationRegion(
      'fraction-with-detached-denominator',
      'p t = 1.58 t (p c + p r + p g )',
      box(0.599, 0.6137, 0.284, 0.0238),
    )
    formula.lines[0].runs[0].fontName = 'CJMJKD+CMMI10'
    // The denominator reaches line assembly as the first line of the body
    // paragraph that follows the display equation, so only line-level
    // absorption can reclaim it for the crop scope.
    const denominatorBox = {
      ...box(0.7012, 0.634, 0.0364, 0.013),
      method: 'pdf-text' as const,
    }
    const proseBox = {
      ...box(0.599, 0.655, 0.284, 0.013),
      method: 'pdf-text' as const,
    }
    const followingParagraph = {
      ...textRegion(
        'fraction-following-paragraph',
        '1000 where p c is the average power draw',
        box(0.599, 0.634, 0.284, 0.034),
      ),
      lines: [
        {
          id: 'fraction-following-paragraph-denominator-line',
          text: '1000',
          fontSize: 9,
          box: denominatorBox,
          runs: [
            {
              ...denominatorBox,
              text: '1000',
              fontName: 'CJMJKD+CMR10',
              fontSize: 9,
              confidence: 0.99,
            },
          ],
        },
        {
          id: 'fraction-following-paragraph-prose-line',
          text: 'where p c is the average power draw',
          fontSize: 9,
          box: proseBox,
          runs: [
            {
              ...proseBox,
              text: 'where p c is the average power draw',
              fontName: 'NimbusRomanNo9L',
              fontSize: 9,
              confidence: 0.99,
            },
          ],
        },
      ],
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 20,
          pixels: new Uint8Array(96 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, followingParagraph],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(result.relationships[0].sourceLineIds).toContain(
      'fraction-following-paragraph-denominator-line',
    )
    expect(result.relationships[0].sourceLineIds).not.toContain(
      'fraction-following-paragraph-prose-line',
    )
  })

  it('never absorbs Computer Modern prose beside a display equation into its crop scope', async () => {
    const formula = equationRegion(
      'fraction-beside-prose',
      'p t = 1.58 t (p c + p r + p g )',
      box(0.599, 0.6137, 0.284, 0.0238),
    )
    formula.lines[0].runs[0].fontName = 'CJMJKD+CMMI10'
    const prose = textRegion(
      'fraction-neighboring-prose',
      'the market makers utility function',
      box(0.6, 0.634, 0.28, 0.013),
    )
    prose.lines[0].runs[0].fontName = 'CJMJKD+CMR10'
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 20,
          pixels: new Uint8Array(96 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, prose],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].sourceRegionIds).not.toContain(prose.id)
    expect(result.relationships[0].sourceLineIds).not.toContain(
      prose.lines[0].id,
    )
  })

  it('does not treat punctuation-only mixed Computer Modern prose as a detached integrand', async () => {
    const formula = equationRegion(
      'short-prose-neighbor-formula',
      'f(x) = x',
      box(0.42, 0.42, 0.18, 0.018),
    )
    formula.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
    const prose = textRegion(
      'short-prose-neighbor',
      'if x is y,',
      box(0.605, 0.42, 0.075, 0.014),
    )
    prose.lines[0].runs = [
      {
        ...prose.lines[0].box,
        text: 'if ',
        width: 0.018,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: 'x',
        x: 0.623,
        width: 0.008,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: ' is ',
        x: 0.631,
        width: 0.024,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: 'y',
        x: 0.655,
        width: 0.008,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: ',',
        x: 0.663,
        width: 0.004,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
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
          height: 20,
          pixels: new Uint8Array(96 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, prose],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].sourceRegionIds).not.toContain(prose.id)
    expect(result.relationships[0].sourceLineIds).not.toContain(
      prose.lines[0].id,
    )
    expect(result.consumedRegionIds.has(prose.id)).toBe(false)
  })

  it.each([
    {
      name: 'one upright prose run with an equals sign',
      text: 'if x=y',
      segments: [
        { text: 'if ', width: 0.018, fontName: 'Synthetic-CMR12' },
        { text: 'x', width: 0.008, fontName: 'Synthetic-CMMI12' },
        { text: '=', width: 0.008, fontName: 'Synthetic-CMR12' },
        { text: 'y', width: 0.008, fontName: 'Synthetic-CMMI12' },
      ],
    },
    {
      name: 'one upright prose run with parentheses',
      text: 'if (x)',
      segments: [
        { text: 'if (', width: 0.026, fontName: 'Synthetic-CMR12' },
        { text: 'x', width: 0.008, fontName: 'Synthetic-CMMI12' },
        { text: ')', width: 0.006, fontName: 'Synthetic-CMR12' },
      ],
    },
    {
      name: 'an upright prose word split across source runs',
      text: 'if x=y',
      segments: [
        { text: 'i', width: 0.008, fontName: 'Synthetic-CMR12' },
        { text: 'f ', width: 0.01, fontName: 'Synthetic-CMR12' },
        { text: 'x', width: 0.008, fontName: 'Synthetic-CMMI12' },
        { text: '=', width: 0.008, fontName: 'Synthetic-CMR12' },
        { text: 'y', width: 0.008, fontName: 'Synthetic-CMMI12' },
      ],
    },
  ])(
    'rejects short Computer Modern prose with structural math punctuation: $name',
    async ({ name, text, segments }) => {
      const formula = equationRegion(
        `short-structural-prose-formula-${name}`,
        'f(x) = x',
        box(0.42, 0.47, 0.18, 0.018),
      )
      formula.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
      const prose = textRegion(
        `short-structural-prose-${name}`,
        text,
        box(0.605, 0.47, 0.075, 0.014),
      )
      let runX = prose.box.x
      prose.lines[0].runs = segments.map((segment) => {
        const run = {
          ...prose.lines[0].box,
          text: segment.text,
          x: runX,
          width: segment.width,
          fontName: segment.fontName,
          fontSize: 12,
          confidence: 1,
        }
        runX += segment.width
        return run
      })
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) =>
          createSourcePageCropAsset({
            kind: 'equation',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 96,
            height: 20,
            pixels: new Uint8Array(96 * 20 * 4).fill(72),
          }),
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [formula, prose],
        rasterizeFigure,
      })

      expect(result.relationships).toHaveLength(1)
      expect(result.relationships[0].sourceRegionIds).not.toContain(prose.id)
      expect(result.relationships[0].sourceLineIds).not.toContain(
        prose.lines[0].id,
      )
      expect(result.consumedRegionIds.has(prose.id)).toBe(false)
    },
  )

  it('owns a detached Computer Modern integrand beside its large operator', async () => {
    const integral = equationRegion(
      'jump-integral-large-operator',
      '∫',
      box(0.59889, 0.8615, 0.01116, 0.0142),
    )
    integral.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const formula = equationRegion(
      'jump-integral-formula',
      'dxt = μ(t, xt) dt + σb(t, xt) dWt +',
      box(0.27774, 0.88083, 0.3111, 0.01633),
    )
    formula.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
    const integrand = textRegion(
      'jump-integral-integrand',
      'z N˜ (dt, dz),',
      box(0.6239, 0.87724, 0.09837, 0.01779),
    )
    integrand.lines[0].runs = [
      {
        ...integrand.lines[0].box,
        text: 'z N',
        width: 0.02912,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integrand.lines[0].box,
        text: '˜ (',
        x: 0.65302,
        width: 0.01774,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integrand.lines[0].box,
        text: 'dt, dz',
        x: 0.67076,
        width: 0.04549,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integrand.lines[0].box,
        text: '),',
        x: 0.71625,
        width: 0.00602,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
    ]
    const domain = textRegion(
      'jump-integral-domain',
      'R',
      box(0.61004, 0.89838, 0.00967, 0.00947),
    )
    domain.lines[0].runs[0].fontName = 'Synthetic-MSBM10'
    const printedNumber = textRegion(
      'jump-integral-number',
      '(1)',
      box(0.85391, 0.88083, 0.02513, 0.0142),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 120,
          height: 24,
          pixels: new Uint8Array(120 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [integral, integrand, formula, printedNumber, domain],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        integral.id,
        integrand.id,
        formula.id,
        domain.id,
        printedNumber.id,
      ]),
      sourceText: '',
      altText: 'Equation 1',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const source of [
      integral,
      integrand,
      formula,
      domain,
      printedNumber,
    ]) {
      expect(containsSourceBox(crop, source.box)).toBe(true)
    }
    expect(result.consumedRegionIds.has(integrand.id)).toBe(true)
    expect(result.consumedRegionIds.has(domain.id)).toBe(true)
    expect(result.consumedRegionIds.has(printedNumber.id)).toBe(true)
  })

  it('keeps two close numbered equation components separate', async () => {
    const firstBase = equationRegion(
      'close-component-first-base',
      'a =',
      box(0.3, 0.4, 0.08, 0.018),
    )
    const firstTerm = textRegion(
      'close-component-first-term',
      'x',
      box(0.385, 0.4, 0.012, 0.014),
    )
    firstTerm.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const firstNumber = textRegion(
      'close-component-first-number',
      '(1)',
      box(0.86, 0.4, 0.025, 0.014),
    )
    const secondBase = equationRegion(
      'close-component-second-base',
      'b =',
      box(0.3, 0.436, 0.08, 0.018),
    )
    const secondTerm = textRegion(
      'close-component-second-term',
      'y',
      box(0.385, 0.436, 0.012, 0.014),
    )
    secondTerm.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const secondNumber = textRegion(
      'close-component-second-number',
      '(2)',
      box(0.86, 0.436, 0.025, 0.014),
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
        secondNumber,
        firstTerm,
        secondBase,
        firstNumber,
        secondTerm,
        firstBase,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        label: 'Equation 1',
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([
          firstBase.id,
          firstTerm.id,
          firstNumber.id,
        ]),
      }),
      expect.objectContaining({
        label: 'Equation 2',
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([
          secondBase.id,
          secondTerm.id,
          secondNumber.id,
        ]),
      }),
    ])
    expect(result.relationships[0].sourceRegionIds).not.toContain(secondTerm.id)
    expect(result.relationships[1].sourceRegionIds).not.toContain(firstTerm.id)
  })

  it('suppresses singleton math fragments and inline math without display evidence', async () => {
    const singletonOperator = textRegion(
      'singleton-math-operator',
      '∑',
      box(0.3, 0.2, 0.018, 0.02),
    )
    singletonOperator.lines[0].runs[0].fontName =
      'Synthetic-STIXGeneral-Regular'
    const inlineMath = textRegion(
      'inline-math-prose',
      'The value x = 2 remains bounded.',
      box(0.2, 0.3, 0.4, 0.018),
    )
    inlineMath.lines[0].runs = [
      {
        ...inlineMath.lines[0].box,
        text: 'The value ',
        width: 0.08,
        fontName: 'Synthetic-CMR10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...inlineMath.lines[0].box,
        x: 0.28,
        width: 0.04,
        text: 'x = 2',
        fontName: 'Synthetic-CMMI10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...inlineMath.lines[0].box,
        x: 0.32,
        width: 0.14,
        text: ' remains bounded.',
        fontName: 'Synthetic-CMR10',
        fontSize: 10,
        confidence: 1,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [inlineMath, singletonOperator],
    })

    expect(result.relationships).toEqual([])
  })

  it('fails closed when prose is inseparable from an owned equation component', async () => {
    const display = equationRegion(
      'inseparable-component-display',
      'h = x + y',
      box(0.3, 0.5, 0.2, 0.02),
    )
    const overlappingProse = textRegion(
      'inseparable-component-prose',
      'where the bound holds',
      box(0.38, 0.5, 0.16, 0.018),
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
      regions: [overlappingProse, display],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        status: 'unresolved',
        sourceRegionIds: [display.id],
        sourceLineIds: [display.lines[0].id],
        evidence: expect.arrayContaining([
          'source-proved-atomic-equation-component',
          'overlapping-unowned-source-text',
          'source-rendition-unavailable',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(overlappingProse.id)).toBe(false)
  })
})
