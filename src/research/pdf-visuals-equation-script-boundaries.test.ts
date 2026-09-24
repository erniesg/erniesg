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
})
