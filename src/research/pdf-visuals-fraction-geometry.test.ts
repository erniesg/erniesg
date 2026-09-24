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
  it('preserves a fraction crop without claiming a linear transcript or absorbing nearby prose', async () => {
    const formula = equationRegion(
      'fraction-formula',
      'β_i←j ≈ Cov(dp_i, dp_j) ≈ S_i′ ρ_ij',
      box(0.35, 0.435, 0.3, 0.027),
    )
    const varianceDenominator = textRegion(
      'variance-denominator',
      'Var(dp_j)',
      box(0.45, 0.455, 0.08, 0.015),
    )
    varianceDenominator.lines[0].runs = [
      {
        ...varianceDenominator.lines[0].box,
        text: 'Var(',
        width: 0.038,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...varianceDenominator.lines[0].box,
        text: 'dp',
        x: 0.488,
        width: 0.02,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...varianceDenominator.lines[0].box,
        text: 'j',
        x: 0.508,
        y: 0.457,
        width: 0.006,
        height: 0.009,
        fontName: 'Synthetic-CMMI8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...varianceDenominator.lines[0].box,
        text: ')',
        x: 0.515,
        width: 0.008,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
    ]
    const retainedProseBox = {
      ...box(0.12, 0.482, 0.7, 0.016),
      method: 'pdf-text' as const,
    }
    varianceDenominator.text =
      'Var(dp_j) In practice, use a shrinkage hedge and retain this prose.'
    varianceDenominator.box = {
      ...box(0.12, 0.455, 0.7, 0.043),
      method: 'pdf-text',
    }
    varianceDenominator.lines.push({
      id: 'retained-prose-line',
      text: 'In practice, use a shrinkage hedge and retain this prose.',
      fontSize: 12,
      box: retainedProseBox,
      runs: [
        {
          ...retainedProseBox,
          text: 'In practice, use a shrinkage hedge and retain this prose.',
          fontName: 'Synthetic-CMR12',
          fontSize: 12,
          confidence: 1,
        },
      ],
    })
    const sensitivityDenominator = textRegion(
      'sensitivity-denominator',
      'S_j′',
      box(0.59, 0.455, 0.025, 0.018),
    )
    sensitivityDenominator.lines[0].runs = [
      {
        ...sensitivityDenominator.lines[0].box,
        text: 'S',
        width: 0.012,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...sensitivityDenominator.lines[0].box,
        text: 'j',
        x: 0.602,
        y: 0.463,
        width: 0.006,
        height: 0.009,
        fontName: 'Synthetic-CMMI8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...sensitivityDenominator.lines[0].box,
        text: '′',
        x: 0.603,
        width: 0.004,
        height: 0.009,
        fontName: 'Synthetic-CMSY8',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const ordinaryProse = textRegion(
      'nearby-ordinary-prose',
      'for hedging',
      box(0.66, 0.454, 0.09, 0.016),
    )
    ordinaryProse.lines[0].runs[0].fontName = 'Synthetic-CMR12'
    ordinaryProse.lines[0].runs[0].fontSize = 12
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 14,
          pixels: new Uint8Array(48 * 14 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        formula,
        varianceDenominator,
        sensitivityDenominator,
        ordinaryProse,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: [
        formula.id,
        varianceDenominator.id,
        sensitivityDenominator.id,
      ],
      sourceText: '',
      altText: 'Display equation p001-001',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(result.relationships[0].sourceLineIds).toEqual([
      formula.lines[0].id,
      varianceDenominator.lines[0].id,
      sensitivityDenominator.lines[0].id,
    ])
    expect(result.consumedRegionIds.has(varianceDenominator.id)).toBe(false)
    expect(result.consumedLineIds.has(varianceDenominator.lines[0].id)).toBe(
      true,
    )
    expect(result.consumedLineIds.has('retained-prose-line')).toBe(false)
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const sourceCropBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(
      containsSourceBox(sourceCropBox, varianceDenominator.lines[0].box),
    ).toBe(true)
    expect(containsSourceBox(sourceCropBox, sensitivityDenominator.box)).toBe(
      true,
    )
  })

  it('does not let a right-column equation number detach a left-column denominator', async () => {
    const numerator: PdfPageRegion = equationRegion(
      'left-fraction-numerator',
      '⟨f_X(x_a), f_X(x_b)⟩ ≈ log P(pos | x_a, x_b) + c̃_X(x_a) (3)',
      box(0.1037, 0.64, 0.3703, 0.023),
    )
    numerator.column = 'left'
    const denominator: PdfPageRegion = textRegion(
      'left-fraction-denominator',
      'P(neg | x_a, x_b)',
      box(0.27, 0.6571, 0.1069, 0.0145),
    )
    denominator.column = 'left'
    denominator.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const rightColumnEquation: PdfPageRegion = equationRegion(
      'right-column-equation',
      'K_PMI(z_a, z_b) = ⟨f_X(x_a), f_X(x_b)⟩ − c_X',
      box(0.5607, 0.6523, 0.264, 0.0145),
    )
    rightColumnEquation.column = 'right'
    const rightColumnNumber: PdfPageRegion = textRegion(
      'right-column-equation-number',
      '(7)',
      box(0.8668, 0.6523, 0.019, 0.0126),
    )
    rightColumnNumber.column = 'right'
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
      regions: [numerator, denominator, rightColumnEquation, rightColumnNumber],
      rasterizeFigure,
    })

    const equationThree = result.relationships.find(
      (relationship) => relationship.label === 'Equation 3',
    )
    expect(equationThree).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([numerator.id, denominator.id]),
      sourceText: '',
      altText: 'Equation 3',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(equationThree?.sourceRegionIds).not.toContain(rightColumnNumber.id)
    const equationThreeCrop = rasterizeFigure.mock.calls.find((call) =>
      containsSourceBox(call[0].sourceBox, denominator.box),
    )?.[0].sourceBox
    expect(equationThreeCrop).toBeDefined()
    expect(containsSourceBox(equationThreeCrop!, denominator.box)).toBe(true)
  })

  it('does not linearize a denominator centered beneath an aggregate numerator envelope', async () => {
    const upperLeft: PdfPageRegion = equationRegion(
      'aggregate-fraction-upper-left',
      '∫ (1/2 S′′(x) σb²(t, x) +',
      box(0.31, 0.292, 0.175, 0.038),
    )
    upperLeft.column = 'left'
    upperLeft.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const upperRight: PdfPageRegion = equationRegion(
      'aggregate-fraction-upper-right',
      '∫ (S(x + z) − S(x) − S′(x)χ(z))νt(dz)',
      box(0.485, 0.3, 0.312, 0.028),
    )
    upperRight.column = 'span'
    const domain: PdfPageRegion = textRegion(
      'aggregate-fraction-domain',
      'R',
      box(0.382, 0.322, 0.012, 0.012),
    )
    domain.column = 'left'
    domain.lines[0].runs[0].fontName = 'Synthetic-MSBM10'
    const lowerLeft: PdfPageRegion = equationRegion(
      'aggregate-fraction-lower-left',
      'μ(t, x) = −',
      box(0.195, 0.33, 0.107, 0.014),
    )
    lowerLeft.column = 'left'
    const punctuation: PdfPageRegion = textRegion(
      'aggregate-fraction-punctuation',
      '.',
      box(0.799, 0.33, 0.0055, 0.014),
    )
    punctuation.column = 'right'
    punctuation.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
    const denominator: PdfPageRegion = textRegion(
      'aggregate-fraction-denominator',
      'S′(x)',
      box(0.53, 0.34, 0.045, 0.014),
    )
    denominator.column = 'right'
    denominator.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
    const printedNumber: PdfPageRegion = textRegion(
      'aggregate-fraction-number',
      '(3)',
      box(0.854, 0.33, 0.025, 0.014),
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
          height: 20,
          pixels: new Uint8Array(96 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        upperLeft,
        upperRight,
        domain,
        lowerLeft,
        punctuation,
        printedNumber,
        denominator,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 3',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        upperLeft.id,
        upperRight.id,
        domain.id,
        lowerLeft.id,
        punctuation.id,
        denominator.id,
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
  })

  it('owns stacked STIXMath fragments and only a contextual upright operator', async () => {
    const formula: PdfPageRegion = equationRegion(
      'stix-control-formula',
      'Control = 1 ∑ 𝕀(𝑎 ≤ 𝑎 ≤ 𝑎)',
      box(0.56803, 0.1028, 0.251, 0.02405),
    )
    formula.column = 'right'
    const printedNumber: PdfPageRegion = textRegion(
      'stix-control-number',
      '(1)',
      box(0.86682, 0.11427, 0.01898, 0.01258),
    )
    printedNumber.column = 'right'
    const denominator: PdfPageRegion = textRegion(
      'stix-control-denominator',
      '|A| a∈A min',
      box(0.63983, 0.12056, 0.09439, 0.02054),
    )
    denominator.column = 'right'
    denominator.lines[0].runs = [
      {
        ...denominator.lines[0].box,
        text: '|A|',
        x: 0.63983,
        y: 0.12308,
        width: 0.02429,
        height: 0.01258,
        fontName: 'Synthetic-STIXMathExtensions-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...denominator.lines[0].box,
        text: 'a',
        x: 0.66878,
        y: 0.13167,
        width: 0.00613,
        height: 0.00943,
        fontName: 'Synthetic-STIXMath-Italic',
        fontSize: 7.5,
        confidence: 1,
      },
      {
        ...denominator.lines[0].box,
        text: '∈',
        x: 0.67491,
        y: 0.13167,
        width: 0.00836,
        height: 0.00943,
        fontName: 'Synthetic-STIXMath-Regular',
        fontSize: 7.5,
        confidence: 1,
      },
      {
        ...denominator.lines[0].box,
        text: 'A',
        x: 0.68328,
        y: 0.13167,
        width: 0.0104,
        height: 0.00943,
        fontName: 'Synthetic-STIXMathCalligraphy-Regular',
        fontSize: 7.5,
        confidence: 1,
      },
      {
        ...denominator.lines[0].box,
        text: 'min',
        x: 0.71523,
        y: 0.12056,
        width: 0.019,
        height: 0.00943,
        fontName: 'Synthetic-STIXGeneral-Regular',
        fontSize: 7.5,
        confidence: 1,
      },
    ]
    const contextualMaximum: PdfPageRegion = textRegion(
      'stix-control-contextual-maximum',
      'max',
      box(0.79177, 0.12056, 0.02102, 0.00943),
      'chart-label',
    )
    contextualMaximum.column = 'right'
    contextualMaximum.lines[0].runs[0].fontName =
      'Synthetic-STIXGeneral-Regular'
    const unrelatedMaximum: PdfPageRegion = textRegion(
      'stix-control-unrelated-maximum',
      'max',
      box(0.18, 0.12056, 0.02102, 0.00943),
      'chart-label',
    )
    unrelatedMaximum.column = 'left'
    unrelatedMaximum.lines[0].runs[0].fontName = 'Synthetic-STIXGeneral-Regular'
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
        denominator,
        contextualMaximum,
        unrelatedMaximum,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        formula.id,
        printedNumber.id,
        denominator.id,
        contextualMaximum.id,
      ]),
      sourceText: '',
      altText: 'Equation 1',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(result.relationships[0].sourceRegionIds).not.toContain(
      unrelatedMaximum.id,
    )
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const source of [
      formula,
      printedNumber,
      denominator,
      contextualMaximum,
    ]) {
      expect(containsSourceBox(crop, source.box)).toBe(true)
    }
    expect(result.consumedRegionIds.has(printedNumber.id)).toBe(true)
    expect(result.consumedRegionIds.has(denominator.id)).toBe(true)
    expect(result.consumedRegionIds.has(contextualMaximum.id)).toBe(true)
    expect(result.consumedRegionIds.has(unrelatedMaximum.id)).toBe(false)
  })

  it('owns a complete multi-row STIXMath fraction and side condition', async () => {
    const formula: PdfPageRegion = equationRegion(
      'stix-scaling-formula',
      'Scaling = 1 ∑ 𝑓(𝑏) − 𝑓(𝑎)',
      box(0.57989, 0.26459, 0.22532, 0.02405),
    )
    formula.column = 'right'
    const printedNumber: PdfPageRegion = textRegion(
      'stix-scaling-number',
      '(2)',
      box(0.86682, 0.27605, 0.01898, 0.01258),
    )
    printedNumber.column = 'right'
    const denominator: PdfPageRegion = textRegion(
      'stix-scaling-denominator',
      '(|A|)',
      box(0.65088, 0.27831, 0.03345, 0.0166),
    )
    denominator.column = 'right'
    denominator.lines[0].runs[0].fontName =
      'Synthetic-STIXMathExtensions-Regular'
    const difference: PdfPageRegion = equationRegion(
      'stix-scaling-difference',
      '𝑏 − 𝑎',
      box(0.74918, 0.28486, 0.03421, 0.01258),
    )
    difference.column = 'right'
    difference.lines[0].runs[0].fontName = 'Synthetic-STIXMath-Italic'
    const membership: PdfPageRegion = textRegion(
      'stix-scaling-membership',
      '2 𝑎,𝑏∈A',
      box(0.66455, 0.29345, 0.05813, 0.01353),
    )
    membership.column = 'right'
    membership.lines[0].runs[0].fontName = 'Synthetic-STIXMath-Regular'
    const condition: PdfPageRegion = textRegion(
      'stix-scaling-condition',
      '𝑏>𝑎',
      box(0.69572, 0.30301, 0.02023, 0.00943),
      'side',
    )
    condition.column = 'right'
    condition.lines[0].runs[0].fontName = 'Synthetic-STIXMath-Italic'
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
        denominator,
        difference,
        membership,
        condition,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 2',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        formula.id,
        printedNumber.id,
        denominator.id,
        difference.id,
        membership.id,
        condition.id,
      ]),
      sourceText: '',
      altText: 'Equation 2',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const source of [
      formula,
      printedNumber,
      denominator,
      difference,
      membership,
      condition,
    ]) {
      expect(containsSourceBox(crop, source.box)).toBe(true)
    }
  })
})
