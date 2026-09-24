import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import {
  pdfVisualMatchCandidateId,
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
  it('retains exact multi-region equation ownership when its source crop is unavailable', async () => {
    const primary = equationRegion(
      'proved-unrendered-equation-primary',
      'x = y +',
      box(0.3, 0.3, 0.22, 0.02),
    )
    const continuation = equationRegion(
      'proved-unrendered-equation-continuation',
      'z',
      box(0.515, 0.3, 0.02, 0.02),
    )
    continuation.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const rasterizeFigure = vi.fn(async () => {
      throw new Error('source crop unavailable')
    })
    const reconstruct = (regions: PdfPageRegion[]) =>
      reconstructPdfVisuals({
        pages: [page([])],
        regions,
        rasterizeFigure,
      })

    const result = await reconstruct([primary, continuation])
    const reordered = await reconstruct([continuation, primary])
    const relationship = result.relationships[0]
    const candidate = relationship.candidates[0]
    const exactSourceLineIds = [primary.lines[0].id, continuation.lines[0].id]

    expect(relationship).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      captionRegionId: primary.id,
      sourceRegionIds: [primary.id, continuation.id],
      sourceLineIds: exactSourceLineIds,
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'source-proved-atomic-equation-component',
        'source-rendition-unavailable',
      ]),
    })
    expect(candidate).toMatchObject({
      sourceRegionIds: [primary.id, continuation.id],
      sourceLineIds: exactSourceLineIds,
      sourceText: 'x = y + z',
    })
    expect(candidate.id).toBe(
      pdfVisualMatchCandidateId(relationship.id, candidate),
    )
    expect(reordered.relationships[0].candidates[0].id).toBe(candidate.id)
    expect(result.consumedRegionIds.has(primary.id)).toBe(false)
    expect(result.consumedRegionIds.has(continuation.id)).toBe(false)
    expect(relationship.evidence).not.toContain('unresolved-visual-text-owned')
  })

  it('transitively owns every source run in a bounded multiline numbered equation', async () => {
    const primary = equationRegion(
      'helix-equation-primary',
      'hla = helix(a() =(CB)(a)T (, (',
      box(0.57946, 0.31879, 0.18716, 0.02406),
    )
    const basis = equationRegion(
      'helix-equation-basis',
      'B(a) = [a, cos',
      box(0.56228, 0.33782, 0.10055, 0.02277),
    )
    const fragment = (
      id: string,
      value: string,
      sourceBox: NormalizedSourceBox,
      parts: Array<{
        text: string
        fontName: string
        fontSize?: number
        yOffset?: number
      }>,
    ) => {
      const region = textRegion(id, value, sourceBox)
      const totalCharacters = parts.reduce(
        (total, part) => total + Array.from(part.text).length,
        0,
      )
      let x = sourceBox.x
      region.lines[0].runs = parts.map((part) => {
        const width =
          sourceBox.width *
          (Array.from(part.text).length / Math.max(1, totalCharacters))
        const run = {
          ...region.lines[0].box,
          text: part.text,
          x,
          y: sourceBox.y + (part.yOffset ?? 0),
          width,
          height:
            part.fontSize && part.fontSize < 9
              ? sourceBox.height * 0.65
              : sourceBox.height,
          fontName: part.fontName,
          fontSize: part.fontSize ?? 10,
          confidence: 1,
        }
        x += width
        return run
      })
      return region
    }
    const fragments = [
      fragment(
        'helix-equation-upper-numerator',
        '2π)',
        box(0.76661, 0.33027, 0.04054, 0.02181),
        [
          { text: '2', fontName: 'Synthetic-CMR10' },
          { text: 'π', fontName: 'Synthetic-CMMI10' },
          { text: ')', fontName: 'Synthetic-CMEX10' },
        ],
      ),
      fragment(
        'helix-equation-first-numerator',
        '2π',
        box(0.67948, 0.3395, 0.01742, 0.01258),
        [
          { text: '2', fontName: 'Synthetic-CMR10' },
          { text: 'π', fontName: 'Synthetic-CMMI10' },
        ],
      ),
      fragment(
        'helix-equation-first-function',
        'a, sin',
        box(0.69944, 0.34801, 0.05052, 0.01258),
        [
          { text: 'a, ', fontName: 'Synthetic-CMMI10' },
          { text: 'sin', fontName: 'Synthetic-CMR10' },
        ],
      ),
      fragment(
        'helix-equation-second-argument',
        'a,',
        box(0.78657, 0.34801, 0.02782, 0.01258),
        [{ text: 'a,', fontName: 'Synthetic-CMMI10' }],
      ),
      fragment(
        'helix-equation-number',
        '(2)',
        box(0.86682, 0.35518, 0.01898, 0.01258),
        [{ text: '(2)', fontName: 'Synthetic-NimbusRoman' }],
      ),
      fragment(
        'helix-equation-first-denominator',
        '(T1)',
        box(0.66915, 0.35663, 0.05448, 0.02144),
        [
          { text: '(', fontName: 'Synthetic-CMEX10' },
          { text: 'T', fontName: 'Synthetic-CMMI10' },
          {
            text: '1',
            fontName: 'Synthetic-CMR7',
            fontSize: 7,
            yOffset: 0.006,
          },
          { text: ')', fontName: 'Synthetic-CMEX10' },
        ],
      ),
      fragment(
        'helix-equation-second-denominator',
        '(T1)',
        box(0.75628, 0.35663, 0.05719, 0.02144),
        [
          { text: '(', fontName: 'Synthetic-CMEX10' },
          { text: 'T', fontName: 'Synthetic-CMMI10' },
          {
            text: '1',
            fontName: 'Synthetic-CMR7',
            fontSize: 7,
            yOffset: 0.006,
          },
          { text: ')', fontName: 'Synthetic-CMEX10' },
        ],
      ),
      fragment(
        'helix-equation-second-numerator-tail',
        '2π a].',
        box(0.77022, 0.37304, 0.05456, 0.02277),
        [
          { text: '2', fontName: 'Synthetic-CMR10' },
          { text: 'π a].', fontName: 'Synthetic-CMMI10' },
        ],
      ),
      fragment(
        'helix-equation-third-numerator',
        '2π',
        box(0.68309, 0.37472, 0.01742, 0.01258),
        [
          { text: '2', fontName: 'Synthetic-CMR10' },
          { text: 'π', fontName: 'Synthetic-CMMI10' },
        ],
      ),
      fragment(
        'helix-equation-ellipsis-function',
        '. . . , cos',
        box(0.6157, 0.38323, 0.05074, 0.01258),
        [
          { text: '. . . , ', fontName: 'Synthetic-CMMI10' },
          { text: 'cos', fontName: 'Synthetic-CMR10' },
        ],
      ),
      fragment(
        'helix-equation-final-function',
        'a, sin Tk',
        box(0.68333, 0.38323, 0.07023, 0.0231),
        [
          { text: 'a, ', fontName: 'Synthetic-CMMI10' },
          { text: 'sin ', fontName: 'Synthetic-CMR10' },
          { text: 'T', fontName: 'Synthetic-CMMI10' },
          {
            text: 'k',
            fontName: 'Synthetic-CMMI7',
            fontSize: 7,
            yOffset: 0.008,
          },
        ],
      ),
      fragment(
        'helix-equation-final-denominator',
        'Tk',
        box(0.77046, 0.39186, 0.01643, 0.01447),
        [
          { text: 'T', fontName: 'Synthetic-CMMI10' },
          {
            text: 'k',
            fontName: 'Synthetic-CMMI7',
            fontSize: 7,
            yOffset: 0.004,
          },
        ],
      ),
    ]
    const followingProse = textRegion(
      'helix-equation-following-prose',
      'C is a matrix applied to the basis of functions B(a), where',
      box(0.50235, 0.42743, 0.38236, 0.01258),
    )
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
      regions: [primary, basis, ...fragments, followingProse],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    const relationship = result.relationships[0]
    expect(relationship.evidence).not.toContain(
      'incomplete-equation-source-scope',
    )
    expect(relationship).toMatchObject({
      kind: 'equation',
      label: 'Equation 2',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        primary.id,
        basis.id,
        ...fragments.map((candidate) => candidate.id),
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
    expect(new Set(relationship.sourceRegionIds).size).toBe(
      2 + fragments.length,
    )
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const source of [primary, basis, ...fragments]) {
      expect(
        containsSourceBox(crop, source.box),
        `crop should contain ${source.id}`,
      ).toBe(true)
    }
    for (const source of [basis, ...fragments]) {
      expect(result.consumedRegionIds.has(source.id)).toBe(true)
    }
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('preserves non-CM two-dimensional script geometry without certifying its flattened transcript', async () => {
    const formula = equationRegion(
      'generic-two-dimensional-script',
      'q2 = r3',
      box(0.4, 0.42, 0.2, 0.03),
    )
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: 'q',
        x: 0.42,
        y: 0.428,
        width: 0.014,
        height: 0.016,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '2',
        x: 0.434,
        y: 0.419,
        width: 0.007,
        height: 0.009,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: ' = r',
        x: 0.448,
        y: 0.428,
        width: 0.06,
        height: 0.016,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '3',
        x: 0.508,
        y: 0.439,
        width: 0.007,
        height: 0.009,
        fontName: 'Synthetic-Math-Regular',
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
      regions: [formula],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        status: 'matched',
        sourceText: '',
        altText: 'Display equation p001-001',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-text-transcript-unresolved',
        ]),
      }),
    ])
  })

  it('promotes one unambiguous math-font superscript from exact source geometry', async () => {
    const formula = equationRegion(
      'exact-script-only-equation',
      'x2=y',
      box(0.4, 0.42, 0.2, 0.04),
    )
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: 'x',
        x: 0.42,
        y: 0.43,
        width: 0.01,
        height: 0.014,
        fontName: 'Synthetic-CMMI10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '2',
        x: 0.431,
        y: 0.421,
        width: 0.006,
        height: 0.007,
        fontName: 'Synthetic-CMMI8',
        fontSize: 7,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '=',
        x: 0.442,
        y: 0.43,
        width: 0.008,
        height: 0.014,
        fontName: 'Synthetic-CMSY10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'y',
        x: 0.456,
        y: 0.43,
        width: 0.01,
        height: 0.014,
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
          width: 48,
          height: 16,
          pixels: new Uint8Array(48 * 16 * 4).fill(72),
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
        status: 'matched',
        sourceRegionIds: [formula.id],
        sourceLineIds: [formula.lines[0].id],
        sourceText: '',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-geometry-script-transcript-v1',
        ]),
        equationGeometryTranscript: expect.objectContaining({
          source: 'source-geometry-script-transcript-v1',
          plainText: 'x^(2) = y',
          spokenText: 'x superscript 2 equals y',
          mathml: {
            type: 'math',
            display: 'block',
            children: [
              {
                type: 'msup',
                base: { type: 'mi', text: 'x' },
                superscript: { type: 'mn', text: '2' },
              },
              { type: 'mo', text: '=' },
              { type: 'mi', text: 'y' },
            ],
          },
        }),
      }),
    ])
    expect(result.relationships[0].evidence).not.toContain(
      'source-text-transcript-unresolved',
    )
  })

  it('preserves non-CM stacked fraction geometry without certifying numerator-denominator order', async () => {
    const formula = equationRegion(
      'generic-two-dimensional-fraction',
      'z = ab',
      box(0.4, 0.46, 0.2, 0.035),
    )
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: 'z = ',
        x: 0.42,
        y: 0.47,
        width: 0.045,
        height: 0.016,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'a',
        x: 0.47,
        y: 0.46,
        width: 0.018,
        height: 0.009,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'b',
        x: 0.47,
        y: 0.486,
        width: 0.018,
        height: 0.009,
        fontName: 'Synthetic-Math-Regular',
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
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(72),
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
        status: 'matched',
        sourceText: '',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-text-transcript-unresolved',
        ]),
      }),
    ])
  })

  it('owns a bounded parameter-list assignment exactly once inside an equation crop', async () => {
    const formula = equationRegion(
      'generic-parameterized-equation',
      'u = vw',
      box(0.3, 0.2, 0.55, 0.06),
    )
    formula.lines[0].box = {
      ...box(0.32, 0.205, 0.2, 0.03),
      method: 'pdf-text',
    }
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: 'u = ',
        x: 0.32,
        y: 0.213,
        width: 0.06,
        height: 0.014,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'v',
        x: 0.39,
        y: 0.205,
        width: 0.015,
        height: 0.008,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'w',
        x: 0.39,
        y: 0.227,
        width: 0.015,
        height: 0.008,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const parameterList = textRegion(
      'bounded-parameter-list',
      'K = [4, 8, 12, 16]',
      box(0.58, 0.235, 0.16, 0.012),
    )
    parameterList.lines[0].runs = [
      {
        ...parameterList.lines[0].box,
        text: 'K',
        width: 0.012,
        fontName: 'Synthetic-CMMI7',
        fontSize: 7,
        confidence: 1,
      },
      {
        ...parameterList.lines[0].box,
        text: ' = [4, 8, 12, 16]',
        x: 0.592,
        width: 0.148,
        fontName: 'Synthetic-CMR7',
        fontSize: 7,
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
          height: 20,
          pixels: new Uint8Array(64 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, parameterList],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(
      containsSourceBox(
        rasterizeFigure.mock.calls[0][0].sourceBox,
        parameterList.box,
      ),
    ).toBe(true)
    const relationship = result.relationships[0]
    expect(relationship).toMatchObject({
      kind: 'equation',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([formula.id, parameterList.id]),
      sourceLineIds: expect.arrayContaining([parameterList.lines[0].id]),
      sourceText: '',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(
      relationship.sourceRegionIds.filter((id) => id === parameterList.id),
    ).toHaveLength(1)
    expect(
      (relationship.sourceLineIds ?? []).filter(
        (id) => id === parameterList.lines[0].id,
      ),
    ).toHaveLength(1)
    expect(result.consumedRegionIds.has(parameterList.id)).toBe(true)
  })

  it.each([
    ['line and glyph', false],
    ['glyph', true],
  ])(
    'fails equation matching closed when one source %s is owned more than once',
    async (_ownershipKind, uniqueLineId) => {
      const primary = equationRegion(
        'duplicate-source-primary',
        'x = y',
        box(0.35, 0.52, 0.3, 0.025),
      )
      const duplicate = equationRegion(
        'duplicate-source-copy',
        'x = y',
        box(0.35, 0.52, 0.3, 0.025),
      )
      if (!uniqueLineId) {
        duplicate.lines[0].id = primary.lines[0].id
      }
      duplicate.lines[0].runs = primary.lines[0].runs.map((run) => ({
        ...run,
      }))
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
        regions: [primary, duplicate],
        rasterizeFigure,
      })

      expect(rasterizeFigure).not.toHaveBeenCalled()
      expect(result.relationships).toEqual([
        expect.objectContaining({
          kind: 'equation',
          status: 'unresolved',
          sourceRegionIds: [],
          sourceLineIds: [],
          evidence: expect.arrayContaining([
            'incomplete-equation-source-scope',
          ]),
          candidates: [
            expect.objectContaining({
              sourceRegionIds: expect.arrayContaining([
                primary.id,
                duplicate.id,
              ]),
            }),
          ],
        }),
      ])
      expect(result.consumedRegionIds.has(primary.id)).toBe(false)
      expect(result.consumedRegionIds.has(duplicate.id)).toBe(false)
    },
  )
})
