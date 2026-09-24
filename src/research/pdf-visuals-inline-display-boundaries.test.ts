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
  it('vetoes an equation crop intersected by unproved non-flow text paint', async () => {
    const equation: PdfPageRegion = textRegion(
      'inventory-veto-equation',
      '√x=y',
      box(0.2, 0.2, 0.2, 0.02),
      'equation',
    )
    const equationRun: PdfSourceRun = {
      ...equation.lines[0].runs[0],
      method: 'pdf-text',
      sourceSequenceIndex: 0,
      sourceTextPaint: {
        algorithm: 'pdfjs-text-paint-run-v1',
        textLedgerSha256: pdfTextLedgerSha256('√x=ySTAMP'),
        normalizedTextStart: 0,
        normalizedTextEnd: 4,
        operatorLedgerSha256: 'a'.repeat(64),
        operationIndexes: [1],
        filterableOperationIndexes: [1],
      },
    }
    equation.lines[0].runs[0] = equationRun
    const sourcePage = page([])
    sourcePage.renderVisibleTextRuns = [
      { ...equationRun },
      {
        ...equationRun,
        text: 'STAMP',
        x: equation.box.x + 0.01,
        y: equation.box.y,
        width: 0.03,
        sourceSequenceIndex: 1,
        sourceTextPaint: undefined,
      },
    ]
    const rasterizeFigure = vi.fn(async () => {
      throw new Error('unproved render-visible paint must veto rasterization')
    })

    const result = await reconstructPdfVisuals({
      pages: [sourcePage],
      regions: [equation],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      evidence: expect.arrayContaining([
        'overlapping-unowned-source-text',
        'source-rendition-unavailable',
      ]),
    })
  })

  it('keeps a split inline fraction atomic without absorbing its prose sibling or a nearby display', async () => {
    const nearbyDisplay = equationRegion(
      'nearby-display-before-inline-fraction',
      'F(x) = x + 1',
      box(0.3, 0.23, 0.4, 0.025),
    )
    const proseBefore = textRegion(
      'inline-fraction-prose-before',
      'The geometric ratio therefore gives G =',
      box(0.1, 0.282, 0.53, 0.018),
    )
    proseBefore.lines[0].id = 'page-001-inline-stacked-0042-before'
    const formula = equationRegion(
      'inline-fraction-formula',
      '1−1.',
      box(0.64, 0.27, 0.065, 0.04),
    )
    formula.lines[0].id = 'page-001-inline-stacked-0042-formula'
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: '1',
        x: 0.67,
        y: 0.277,
        width: 0.01,
        height: 0.009,
        fontName: 'Synthetic-CMR8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '−',
        x: 0.655,
        y: 0.282,
        width: 0.012,
        height: 0.016,
        fontName: 'Synthetic-CMSY12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '1',
        x: 0.67,
        y: 0.287,
        width: 0.01,
        height: 0.009,
        fontName: 'Synthetic-CMR8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '.',
        x: 0.692,
        y: 0.282,
        width: 0.006,
        height: 0.016,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
    ]
    const denominatorTail = textRegion(
      'inline-fraction-denominator-tail',
      'r',
      box(0.681, 0.287, 0.008, 0.009),
      'side',
    )
    denominatorTail.lines[0].id = 'page-001-inline-stacked-0042-after'
    denominatorTail.lines[0].runs[0].fontName = 'Synthetic-CMMI8'
    denominatorTail.lines[0].runs[0].fontSize = 8
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 62,
          height: 24,
          pixels: new Uint8Array(62 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [nearbyDisplay, proseBefore, formula, denominatorTail],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    const fraction = result.relationships.find((relationship) =>
      relationship.sourceRegionIds.includes(formula.id),
    )
    expect(fraction).toMatchObject({
      kind: 'equation',
      status: 'matched',
      captionRegionId: formula.id,
      sourceRegionIds: [formula.id, denominatorTail.id],
      sourceLineIds: [formula.lines[0].id, denominatorTail.lines[0].id],
      sourceText: '',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-proved-atomic-equation-component',
        'source-page-crop',
      ]),
    })
    expect(fraction?.sourceRegionIds).not.toContain(proseBefore.id)
    expect(fraction?.sourceRegionIds).not.toContain(nearbyDisplay.id)
    expect(result.consumedRegionIds.has(proseBefore.id)).toBe(false)
    expect(result.consumedRegionIds.has(denominatorTail.id)).toBe(true)
    const fractionCrop = rasterizeFigure.mock.calls.find(([input]) =>
      input.sourceBoxes.some((sourceBox) =>
        containsSourceBox(sourceBox, denominatorTail.box),
      ),
    )?.[0].sourceBox
    expect(fractionCrop).toBeDefined()
    expect(containsSourceBox(fractionCrop!, formula.box)).toBe(true)
    expect(containsSourceBox(fractionCrop!, denominatorTail.box)).toBe(true)
    expect(containsSourceBox(fractionCrop!, proseBefore.box)).toBe(false)
  })

  it('does not attach a two-dimensional inline formula from following prose to a numbered display', async () => {
    const display = equationRegion(
      'numbered-display-before-inline-definition',
      'Cov(dp_i, dp_j) = D + J, (4)',
      box(0.2, 0.76, 0.68, 0.035),
    )
    const baseId = 'page-001-inline-stacked-0050'
    const before = textRegion(
      'inline-definition-before',
      'where',
      box(0.12, 0.8, 0.05, 0.014),
    )
    before.lines[0].id = `${baseId}-before`
    const formula = equationRegion(
      'inline-definition-formula',
      'Sk′ = S′(xkt',
      box(0.176, 0.798, 0.1, 0.02),
    )
    formula.lines[0].id = `${baseId}-formula`
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: 'S′(x',
        x: 0.176,
        y: 0.8,
        width: 0.05,
        height: 0.014,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'k',
        x: 0.226,
        y: 0.798,
        width: 0.008,
        height: 0.009,
        fontName: 'Synthetic-CMMI8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 't',
        x: 0.226,
        y: 0.809,
        width: 0.008,
        height: 0.009,
        fontName: 'Synthetic-CMMI8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: ')',
        x: 0.236,
        y: 0.8,
        width: 0.008,
        height: 0.014,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
    ]
    const after = textRegion(
      'inline-definition-after',
      '. The first term is the diffusive covariation.',
      box(0.28, 0.8, 0.5, 0.014),
      'spanning',
    )
    after.lines[0].id = `${baseId}-after`
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
      regions: [display, before, formula, after],
      rasterizeFigure,
    })

    const displayRelationship = result.relationships.find(
      (relationship) => relationship.label === 'Equation 4',
    )
    expect(displayRelationship).toMatchObject({
      status: 'matched',
      sourceRegionIds: [display.id],
    })
    expect(displayRelationship?.sourceRegionIds).not.toContain(formula.id)
    expect(result.consumedRegionIds.has(before.id)).toBe(false)
    expect(result.consumedRegionIds.has(after.id)).toBe(false)
  })

  it('does not let one math-only body sibling prove both sides of an inline split', async () => {
    const nearbyDisplay = equationRegion(
      'nearby-display-before-unproved-inline-split',
      'F(x) = x + 1',
      box(0.3, 0.23, 0.4, 0.025),
    )
    const formula = equationRegion(
      'unproved-inline-split-formula',
      '1−1.',
      box(0.64, 0.27, 0.065, 0.04),
    )
    formula.lines[0].id = 'page-001-inline-stacked-0043-formula'
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: '1',
        x: 0.67,
        y: 0.277,
        width: 0.01,
        height: 0.009,
        fontName: 'Synthetic-CMR8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '−',
        x: 0.655,
        y: 0.282,
        width: 0.012,
        height: 0.016,
        fontName: 'Synthetic-CMSY12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '1',
        x: 0.67,
        y: 0.287,
        width: 0.01,
        height: 0.009,
        fontName: 'Synthetic-CMR8',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '.',
        x: 0.692,
        y: 0.282,
        width: 0.006,
        height: 0.016,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
    ]
    const onlySibling = textRegion(
      'unproved-inline-split-only-sibling',
      'r',
      box(0.681, 0.287, 0.008, 0.009),
    )
    onlySibling.lines[0].id = 'page-001-inline-stacked-0043-after'
    onlySibling.lines[0].runs[0].fontName = 'Synthetic-CMMI8'
    onlySibling.lines[0].runs[0].fontSize = 8
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 62,
          height: 24,
          pixels: new Uint8Array(62 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [nearbyDisplay, formula, onlySibling],
      rasterizeFigure,
    })

    expect(
      result.relationships.some(
        (relationship) => relationship.captionRegionId === formula.id,
      ),
    ).toBe(false)
    expect(
      rasterizeFigure.mock.calls.some(
        ([input]) =>
          containsSourceBox(input.sourceBox, formula.box) &&
          !containsSourceBox(input.sourceBox, nearbyDisplay.box),
      ),
    ).toBe(false)
  })

  it('keeps adjacent displays with distinct printed equation numbers separate', async () => {
    const equationEight = equationRegion(
      'numbered-equation-eight',
      'r_x(t) = x_t - q_t, (8)',
      box(0.27, 0.28, 0.45, 0.025),
    )
    const equationNine = equationRegion(
      'numbered-equation-nine',
      '2δ_x(t) = γσ_b^2 + 2 log(1 + γ/k), (9)',
      box(0.24, 0.312, 0.52, 0.025),
    )
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
      regions: [equationEight, equationNine],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(
      result.relationships.map((relationship) => ({
        label: relationship.label,
        sourceRegionIds: relationship.sourceRegionIds,
      })),
    ).toEqual([
      {
        label: 'Equation 8',
        sourceRegionIds: [equationEight.id],
      },
      {
        label: 'Equation 9',
        sourceRegionIds: [equationNine.id],
      },
    ])
  })

  it('does not absorb a prose-leading conditional expectation from a mixed body region into an adjacent display equation', async () => {
    const formula = equationRegion(
      'conditional-expectation-display',
      'E[Yk+1 | A, Z0, …, Zk−1] = Yk.',
      box(0.24, 0.3, 0.46, 0.02),
    )
    const mixedBody = textRegion(
      'conditional-expectation-following-prose',
      'Consider E[Y∞ | B, Y0, Y1, …]. Since this does not simplify easily.',
      box(0.12, 0.324, 0.7, 0.04),
    )
    const considerLineBox = {
      ...box(0.12, 0.324, 0.3, 0.014),
      method: 'pdf-text' as const,
    }
    const retainedLineBox = {
      ...box(0.12, 0.348, 0.42, 0.014),
      method: 'pdf-text' as const,
    }
    mixedBody.lines = [
      {
        id: 'conditional-expectation-consider-line',
        text: 'Consider E[Y∞ | B, Y0, Y1, …].',
        fontSize: 10,
        box: considerLineBox,
        runs: [
          {
            ...considerLineBox,
            text: 'Consider ',
            width: 0.065,
            fontName: 'Synthetic-CMR10',
            fontSize: 10,
            confidence: 1,
          },
          {
            ...considerLineBox,
            x: considerLineBox.x + 0.065,
            width: considerLineBox.width - 0.065,
            text: 'E[Y∞ | B, Y0, Y1, …].',
            fontName: 'Synthetic-CMMI10',
            fontSize: 10,
            confidence: 1,
          },
        ],
      },
      {
        id: 'conditional-expectation-retained-line',
        text: 'Since this does not simplify easily.',
        fontSize: 10,
        box: retainedLineBox,
        runs: [
          {
            ...retainedLineBox,
            text: 'Since this does not simplify easily.',
            fontName: 'Synthetic-CMR10',
            fontSize: 10,
            confidence: 1,
          },
        ],
      },
    ]
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
      regions: [formula, mixedBody],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      sourceRegionIds: [formula.id],
      sourceLineIds: [formula.lines[0].id],
    })
    expect(result.consumedRegionIds.has(mixedBody.id)).toBe(false)
    expect(result.consumedLineIds.has(mixedBody.lines[0].id)).toBe(false)
    expect(result.consumedLineIds.has(mixedBody.lines[1].id)).toBe(false)
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(
      containsSourceBox(
        rasterizeFigure.mock.calls[0]![0].sourceBox,
        considerLineBox,
      ),
    ).toBe(false)
  })

  it.each(['Recall', 'Observe'])(
    'does not absorb an unseen upright prose lead %s from a single-line body region',
    async (proseLead) => {
      const formula = equationRegion(
        `upright-prose-lead-display-${proseLead}`,
        'E[Yk+1 | A, Z0, …, Zk−1] = Yk.',
        box(0.24, 0.3, 0.46, 0.02),
      )
      const bodyLineBox = {
        ...box(0.12, 0.324, 0.3, 0.014),
        method: 'pdf-text' as const,
      }
      const body = textRegion(
        `upright-prose-lead-body-${proseLead}`,
        `${proseLead} E[Y∞ | B, Y0, Y1, …].`,
        bodyLineBox,
      )
      const proseWidth = 0.065
      body.lines[0].runs = [
        {
          ...bodyLineBox,
          text: `${proseLead} `,
          width: proseWidth,
          fontName: 'Synthetic-CMR10',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...bodyLineBox,
          x: bodyLineBox.x + proseWidth,
          width: bodyLineBox.width - proseWidth,
          text: 'E[Y∞ | B, Y0, Y1, …].',
          fontName: 'Synthetic-CMMI10',
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
            width: 64,
            height: 16,
            pixels: new Uint8Array(64 * 16 * 4).fill(72),
          }),
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [formula, body],
        rasterizeFigure,
      })

      expect(result.relationships).toHaveLength(1)
      expect(result.relationships[0]).toMatchObject({
        status: 'matched',
        sourceRegionIds: [formula.id],
        sourceLineIds: [formula.lines[0].id],
      })
      expect(result.consumedRegionIds.has(body.id)).toBe(false)
      expect(result.consumedLineIds.has(body.lines[0].id)).toBe(false)
      expect(
        containsSourceBox(
          rasterizeFigure.mock.calls[0]![0].sourceBox,
          bodyLineBox,
        ),
      ).toBe(false)
    },
  )
})
