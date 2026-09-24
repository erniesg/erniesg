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
  it('uses an aligned printed number to crop a formula whose transcript is unsafe to publish', async () => {
    const formula = equationRegion(
      'garbled-numbered-equation',
      'B hala helix coscosa T k CBAA sinsin',
      box(0.55, 0.31, 0.27, 0.075),
    )
    const printedNumber = {
      ...textRegion(
        'garbled-numbered-equation-label',
        '(2)',
        box(0.86, 0.335, 0.025, 0.014),
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
          width: 48,
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, printedNumber],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        label: 'Equation 2',
        status: 'matched',
        sourceRegionIds: [formula.id, printedNumber.id],
        sourceText: '',
        altText: 'Equation 2',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-text-transcript-unresolved',
        ]),
      }),
    ])
  })

  it('does not promote a detached printed number without a formula', async () => {
    const printedNumber = equationRegion(
      'detached-equation-number',
      '(2)',
      box(0.86, 0.335, 0.025, 0.014),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [printedNumber],
    })

    expect(result.relationships).toEqual([])
  })

  it('requires explicit script markers before certifying a Computer Modern transcript', async () => {
    const formula = equationRegion(
      'numbered-computer-modern-equation',
      'di = LLM (ri, RInf o.i, Pdetailed_outline), (2)',
      box(0.13616, 0.39664, 0.35079, 0.01507),
    )
    const line = formula.lines[0]
    line.runs = [
      {
        ...line.box,
        text: 'd',
        x: 0.13616,
        width: 0.00954,
        fontName: 'UEWCFI+CMMI10',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...line.box,
        text: 'i',
        x: 0.1457,
        y: 0.40207,
        width: 0.00484,
        height: 0.00947,
        fontName: 'CXQAES+CMMI8',
        fontSize: 7.9701,
        confidence: 1,
      },
      {
        ...line.box,
        text: '=',
        x: 0.15647,
        width: 0.01425,
        fontName: 'XGAHUM+CMR10',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...line.box,
        text: 'LLM (r',
        x: 0.17581,
        width: 0.06012,
        fontName: 'UEWCFI+CMMI10',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...line.box,
        text: 'i',
        x: 0.23593,
        y: 0.40207,
        width: 0.00484,
        height: 0.00947,
        fontName: 'CXQAES+CMMI8',
        fontSize: 7.9701,
        confidence: 1,
      },
      {
        ...line.box,
        text: ', RInf o.i, P',
        x: 0.24161,
        width: 0.09321,
        fontName: 'UEWCFI+CMMI10',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...line.box,
        text: 'detailed_outline',
        x: 0.33481,
        y: 0.40224,
        width: 0.10121,
        height: 0.00947,
        fontName: 'CXQAES+CMMI8',
        fontSize: 7.9701,
        confidence: 1,
      },
      {
        ...line.box,
        text: '),',
        x: 0.43685,
        width: 0.01222,
        fontName: 'XGAHUM+CMR10',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...line.box,
        text: '(2)',
        x: 0.46557,
        width: 0.02137,
        fontName: 'LMKBCN+NimbusRomNo9L-Regu',
        fontSize: 10.9091,
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
          width: 72,
          height: 18,
          pixels: new Uint8Array(72 * 18 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula],
      rasterizeFigure,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        label: 'Equation 2',
        status: 'matched',
        sourceRegionIds: [formula.id],
        sourceText: '',
        altText: 'Equation 2',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-text-transcript-unresolved',
        ]),
      }),
    ])
    expect(result.relationships[0].evidence).not.toContain(
      'source-math-font-transcript',
    )

    formula.text = 'd_i = LLM (r_i, RInfo.i, P_detailed_outline), (2)'
    line.text = formula.text
    line.runs[0].text = 'd_'
    line.runs[3].text = 'LLM (r_'
    line.runs[5].text = ', RInfo.i, P_'

    const explicitlyEncoded = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula],
      rasterizeFigure,
    })

    expect(explicitlyEncoded.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        label: 'Equation 2',
        status: 'matched',
        sourceText: formula.text,
        altText: formula.text,
        altTextSource: 'source-text',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-math-font-transcript',
          'source-script-geometry',
          'source-text-alt',
        ]),
      }),
    ])
  })

  it('crops a numbered equation when its printed number shares the formula region', async () => {
    const formula = equationRegion(
      'numbered-equation-with-inline-label',
      'd_i = Model(r_i, R_info_i, P_detailed_outline), (2)',
      box(0.18, 0.31, 0.64, 0.035),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 72,
          height: 18,
          pixels: new Uint8Array(72 * 18 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        label: 'Equation 2',
        status: 'matched',
        sourceRegionIds: [formula.id],
        sourceText: '',
        altText: 'Equation 2',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-text-transcript-unresolved',
        ]),
      }),
    ])
  })

  it('crops detached math-extension glyphs without claiming a corrupt transcript', async () => {
    const left: PdfPageRegion = equationRegion(
      'equation-left-fragment',
      'N_n^l(a,b) =',
      box(0.502, 0.11, 0.075, 0.017),
    )
    const middle = equationRegion(
      'equation-middle-fragment',
      'c_t t +',
      box(0.642, 0.111, 0.032, 0.014),
    )
    const right: PdfPageRegion = equationRegion(
      'equation-right-fragment',
      'T=[2,5,10,100] c_T cos(2π(t-d_T))',
      box(0.674, 0.103, 0.232, 0.037),
    )
    const subscript = textRegion(
      'equation-subscript-fragment',
      't=a,b,a+b',
      box(0.581, 0.13, 0.058, 0.009),
    )
    const opening = textRegion(
      'equation-opening-delimiter',
      '\u0012',
      box(0.81, 0.093, 0.012, 0.013),
    )
    const closing = textRegion(
      'equation-closing-delimiter',
      '\u0013',
      box(0.906, 0.093, 0.012, 0.013),
    )
    const firstSum = textRegion(
      'equation-first-large-operator',
      'X',
      box(0.599, 0.099, 0.024, 0.013),
      'page-number',
    )
    const secondSum = textRegion(
      'equation-second-large-operator',
      'X',
      box(0.704, 0.099, 0.024, 0.013),
      'page-number',
    )
    for (const fragment of [opening, closing, firstSum, secondSum]) {
      fragment.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    }
    opening.kind = 'equation'
    closing.kind = 'equation'
    const printedNumber = textRegion(
      'equation-number',
      '(3)',
      box(0.867, 0.14, 0.019, 0.013),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 42,
          height: 9,
          pixels: new Uint8Array(42 * 9 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        opening,
        closing,
        firstSum,
        secondSum,
        right,
        left,
        middle,
        subscript,
        printedNumber,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(crop.x).toBeLessThanOrEqual(left.box.x)
    expect(crop.y).toBeLessThanOrEqual(opening.box.y)
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(
      closing.box.x + closing.box.width,
    )
    expect(crop.y + crop.height).toBeGreaterThanOrEqual(
      printedNumber.box.y + printedNumber.box.height,
    )
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 3',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        left.id,
        middle.id,
        right.id,
        subscript.id,
        opening.id,
        closing.id,
        firstSum.id,
        secondSum.id,
        printedNumber.id,
      ]),
      sourceText: '',
      altText: 'Equation 3',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(result.relationships[0].sourceText).not.toMatch(
      /[\u0000-\u001f\u007f]/u,
    )
    for (const fragment of [opening, closing, firstSum, secondSum]) {
      expect(result.consumedRegionIds.has(fragment.id)).toBe(true)
    }
  })

  it('assigns a detached math-extension glyph to the nearest display equation', async () => {
    const first = equationRegion(
      'equation-nearest-first',
      'a = b',
      box(0.2, 0.1, 0.24, 0.014),
    )
    const second = equationRegion(
      'equation-nearest-second',
      'c = d',
      box(0.2, 0.14, 0.24, 0.014),
    )
    const delimiter = textRegion(
      'equation-nearest-delimiter',
      '\u0000',
      box(0.3, 0.128, 0.01, 0.014),
      'equation',
    )
    delimiter.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
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
      regions: [first, delimiter, second],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(result.relationships[0].sourceRegionIds).toEqual([first.id])
    expect(
      result.relationships[1].sourceRegionIds,
      `${result.relationships[1].evidence.join(',')}; candidate=${result.relationships[1].candidates[0]?.sourceRegionIds.join(',')}`,
    ).toEqual([delimiter.id, second.id])
    expect(result.consumedRegionIds.has(delimiter.id)).toBe(true)
  })

  it('builds one deterministic owned component from fragmented math glyphs', async () => {
    const displayBase = equationRegion(
      'component-display-base',
      'F =',
      box(0.3, 0.3, 0.06, 0.02),
    )
    const largeOperator = textRegion(
      'component-large-operator',
      '∑',
      box(0.365, 0.3, 0.018, 0.02),
    )
    largeOperator.lines[0].runs[0].fontName = 'Synthetic-STIXGeneral-Regular'
    const operand = textRegion(
      'component-operand',
      'x',
      box(0.388, 0.3, 0.015, 0.016),
    )
    operand.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const subscript = textRegion(
      'component-subscript',
      'i',
      box(0.403, 0.313, 0.008, 0.009),
    )
    subscript.lines[0].runs[0].fontName = 'Synthetic-CMMI7'
    subscript.lines[0].runs[0].fontSize = 7
    const superscript = textRegion(
      'component-superscript',
      '2',
      box(0.403, 0.289, 0.008, 0.009),
    )
    superscript.lines[0].runs[0].fontName = 'Synthetic-CMR7'
    superscript.lines[0].runs[0].fontSize = 7
    const printedNumber = textRegion(
      'component-printed-number',
      '(4)',
      box(0.86, 0.3, 0.025, 0.014),
    )
    const neighboringProse = textRegion(
      'component-neighboring-prose',
      'where the estimate converges',
      box(0.3, 0.342, 0.2, 0.014),
    )
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
    const componentRegions = [
      displayBase,
      largeOperator,
      operand,
      subscript,
      superscript,
      printedNumber,
    ]

    const first = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [neighboringProse, ...componentRegions],
      rasterizeFigure,
    })
    const shuffled = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        superscript,
        neighboringProse,
        printedNumber,
        operand,
        displayBase,
        subscript,
        largeOperator,
      ],
      rasterizeFigure,
    })

    for (const result of [first, shuffled]) {
      expect(result.relationships).toHaveLength(1)
      expect(result.relationships[0]).toMatchObject({
        label: 'Equation 4',
        status: 'matched',
        sourceRegionIds: expect.arrayContaining(
          componentRegions.map((region) => region.id),
        ),
        evidence: expect.arrayContaining(['source-page-crop']),
      })
      expect(result.relationships[0].sourceRegionIds).not.toContain(
        neighboringProse.id,
      )
    }
    expect(shuffled.relationships[0].sourceRegionIds).toEqual(
      first.relationships[0].sourceRegionIds,
    )
    for (const region of componentRegions) {
      expect(
        containsSourceBox(
          rasterizeFigure.mock.calls[0]![0].sourceBox,
          region.box,
        ),
      ).toBe(true)
    }
  })
})
