import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { renderPdfPageCrop } from './pdf-page-crop'
import {
  pdfTextLedgerSha256,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
} from './pdf-text-paint'
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

async function attestedTextOperationCrop(
  input: Parameters<PdfFigureRasterizer>[0],
  excludedText: string,
  ownedText: string,
) {
  const glyphs = (text: string) => [[...text].map((unicode) => ({ unicode }))]
  let resolveDisplay!: (value: unknown) => void
  let rejectDisplay!: (reason: unknown) => void
  const displayPromise = new Promise<unknown>((resolve, reject) => {
    resolveDisplay = resolve
    rejectDisplay = reject
  })
  resolveDisplay(false)
  const displayIntentState = Object.assign(Object.create(null), {
    displayReadyCapability: {
      promise: displayPromise,
      resolve: resolveDisplay,
      reject: rejectDisplay,
    },
    operatorList: {
      fnArray: [31, 44, 40, 44, 32],
      argsArray: [[], glyphs(excludedText), [0, 10], glyphs(ownedText), []],
      lastChunk: true,
      separateAnnots: null,
    },
    renderTasks: new Set(),
    streamReader: null,
  })
  const raster = await renderPdfPageCrop({
    page: {
      pageNumber: input.page,
      _intentStates: new Map([['2__', displayIntentState]]),
      getViewport: ({ scale }) => ({
        width: 1000 * scale,
        height: 1000 * scale,
        rotation: 0,
      }),
      render: (options) => {
        const context =
          options.canvasContext as typeof options.canvasContext & {
            pixels: Uint8ClampedArray
            width: number
            height: number
          }
        const paint = (source: NormalizedSourceBox) => {
          const x = Math.max(
            2,
            Math.min(
              context.width - 3,
              Math.floor(
                ((source.x + source.width / 2 - input.sourceBox.x) /
                  input.sourceBox.width) *
                  context.width,
              ),
            ),
          )
          const y = Math.max(
            2,
            Math.min(
              context.height - 3,
              Math.floor(
                ((source.y + source.height / 2 - input.sourceBox.y) /
                  input.sourceBox.height) *
                  context.height,
              ),
            ),
          )
          for (let offsetY = 0; offsetY < 2; offsetY += 1) {
            for (let offsetX = 0; offsetX < 2; offsetX += 1) {
              context.pixels[
                ((y + offsetY) * context.width + x + offsetX) * 4
              ] = 0
            }
          }
        }
        paint(input.sourceTextOperationFilter!.ownedSourceBoxes[0])
        if (!options.operationsFilter) {
          paint(input.sourceTextOperationFilter!.excludedSourceBoxes[0])
        } else {
          const decisions = [0, 1, 1, 2, 3, 4].map((index) =>
            options.operationsFilter!(index),
          )
          if (decisions[1]) {
            paint(input.sourceTextOperationFilter!.excludedSourceBoxes[0])
          }
        }
        return { promise: Promise.resolve() }
      },
    },
    canvasFactory: {
      create: (width, height) => {
        const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
        return {
          canvas: { width, height },
          context: {
            pixels,
            width,
            height,
            fillStyle: '',
            fillRect: vi.fn(),
            getImageData: vi.fn(() => ({ data: pixels })),
          },
        }
      },
      destroy: vi.fn(),
    },
    sourceBox: input.sourceBox,
    sourceTextOperationFilter: {
      ...input.sourceTextOperationFilter!,
      pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
      pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
    },
    maximumPixels: 32_000,
  })
  return createSourcePageCropAsset(
    {
      kind: 'equation',
      cropBox: raster.sourceBox,
      sourceObjectIds: input.sourceObjectIds,
      sourceBoxes: input.sourceBoxes,
      width: raster.width,
      height: raster.height,
      pixels: raster.pixels,
      resolutionDpi: raster.resolutionDpi,
      sourceExclusionMask: raster.sourceExclusionMask,
    },
    raster,
  )
}

describe('PDF visual association graph', () => {
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

  it.each([
    'The estimate (1.22) remains within the scalar parameter range.',
    'The scalar parameter remains within the estimate (1.22)',
  ])(
    'does not promote a parenthesized decimal in prose as an equation number: %s',
    async (text) => {
      const prose = textRegion(
        'inline-parenthesized-decimal-prose',
        text,
        box(0.15, 0.3, 0.7, 0.02),
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [prose],
      })

      expect(result.relationships).toEqual([])
      expect(result.consumedRegionIds.has(prose.id)).toBe(false)
      expect(result.consumedLineIds.has(prose.lines[0].id)).toBe(false)
    },
  )

  it.each(['Multiply by 2:', 'Hence:', 'or:'])(
    'does not merge adjacent display equations across the interstitial prose cue %s',
    async (cueText) => {
      const first = equationRegion(
        'derivation-equation-before-cue',
        '(1-t)/(2 cos θ) + √3t/(2 sin θ) = 1',
        box(0.09, 0.2, 0.3, 0.025),
      )
      const cue: PdfPageRegion = textRegion(
        'derivation-prose-cue',
        cueText,
        box(0.09, 0.225, 0.1, 0.018),
      )
      const second = equationRegion(
        'derivation-equation-after-cue',
        '(1-t) sin θ + √3t cos θ = 2 sin θ cos θ',
        box(0.09, 0.245, 0.4, 0.025),
      )
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) =>
          createSourcePageCropAsset({
            kind: 'equation',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 80,
            height: 20,
            pixels: new Uint8Array(80 * 20 * 4).fill(72),
          }),
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [first, cue, second],
        rasterizeFigure,
      })

      expect(rasterizeFigure.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(result.relationships).toHaveLength(2)
      expect(
        result.relationships.map((relationship) => relationship.sourceLineIds),
      ).toEqual([[first.lines[0].id], [second.lines[0].id]])
      expect(
        result.relationships.every(
          (relationship) => !relationship.sourceRegionIds.includes(cue.id),
        ),
      ).toBe(true)
    },
  )

  it('splits a source-proved answer cue from its interleaved multiline equation without lending the relation to a preceding display', async () => {
    const textLedgerSha256 = pdfTextLedgerSha256('FinalAnswer:q=x+12.√')
    const paint = (
      normalizedTextStart: number,
      normalizedTextEnd: number,
      operationIndex: number,
    ) => ({
      algorithm: 'pdfjs-text-paint-run-v1' as const,
      textLedgerSha256,
      normalizedTextStart,
      normalizedTextEnd,
      operatorLedgerSha256: 'a'.repeat(64),
      operationIndexes: [operationIndex],
      filterableOperationIndexes: [operationIndex],
    })
    const preceding = equationRegion(
      'display-before-interleaved-answer',
      'r = s',
      box(0.3, 0.27, 0.25, 0.02),
    )
    const mixedCue = textRegion(
      'interleaved-answer-cue',
      'Final√ Answer: q',
      box(0.1, 0.3, 0.51, 0.025),
    )
    const cueRun = {
      ...mixedCue.lines[0].runs[0],
      text: 'Final',
      x: 0.1,
      y: 0.3,
      width: 0.06,
      height: 0.012,
      sourceSequenceIndex: 1,
      sourceTextPaint: paint(0, 5, 7),
    } satisfies PdfSourceRun
    const answerRun = {
      ...cueRun,
      text: 'Answer:',
      x: 0.18,
      width: 0.08,
      sourceSequenceIndex: 2,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 1,
      sourceTextPaint: paint(5, 12, 7),
    } satisfies PdfSourceRun
    const variableRun = {
      ...cueRun,
      text: 'q',
      x: 0.5,
      width: 0.012,
      fontName: 'Synthetic-STIXMath-Italic',
      sourceSequenceIndex: 3,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 2,
      sourceTextPaint: paint(12, 13, 9),
    } satisfies PdfSourceRun
    const detachedRootRun = {
      ...cueRun,
      text: '√',
      x: 0.14,
      y: 0.303,
      width: 0.018,
      fontName: 'Synthetic-STIXMathExtensions-Regular',
      sourceSequenceIndex: 10,
      sourceWhitespaceBefore: undefined,
      sourceWhitespacePredecessorIndex: undefined,
      sourceTextPaint: paint(19, 20, 9),
    } satisfies PdfSourceRun
    // Match the real failure mode: geometry order puts a detached radical
    // inside the prose cue while source sequence still proves the cue prefix.
    mixedCue.lines[0].runs = [cueRun, detachedRootRun, answerRun, variableRun]

    const relation = equationRegion(
      'interleaved-answer-relation',
      '=',
      box(0.52, 0.3, 0.012, 0.012),
    )
    relation.lines[0].runs[0] = {
      ...relation.lines[0].runs[0],
      fontName: 'Synthetic-STIXMath-Regular',
      sourceSequenceIndex: 4,
      sourceWhitespaceBefore: 'pdf-text-item',
      sourceWhitespacePredecessorIndex: 3,
      sourceTextPaint: paint(13, 14, 9),
    }
    const continuation = textRegion(
      'interleaved-answer-continuation',
      'x + 12.',
      // Inline stacked formulas can span beyond the conservative generic
      // fragment-width limit while remaining source-proved math.
      box(0.16, 0.311, 0.38, 0.02),
    )
    const inlineBaseId = 'page-001-inline-stacked-0007'
    continuation.lines[0].id = `${inlineBaseId}-formula`
    const continuationBase = continuation.lines[0].runs[0]
    continuation.lines[0].runs = [
      {
        ...continuationBase,
        text: 'x',
        x: 0.16,
        width: 0.02,
        fontName: 'Synthetic-STIXMath-Italic',
        sourceSequenceIndex: 5,
        sourceWhitespaceBefore: 'pdf-text-item',
        sourceWhitespacePredecessorIndex: 4,
        sourceTextPaint: paint(14, 15, 9),
      },
      {
        ...continuationBase,
        text: '+',
        x: 0.2,
        width: 0.02,
        fontName: 'Synthetic-STIXMath-Regular',
        sourceSequenceIndex: 6,
        sourceWhitespaceBefore: 'pdf-text-item',
        sourceWhitespacePredecessorIndex: 5,
        sourceTextPaint: paint(15, 16, 9),
      },
      {
        ...continuationBase,
        text: '1',
        x: 0.24,
        width: 0.02,
        fontName: 'Synthetic-STIXMath-Regular',
        sourceSequenceIndex: 7,
        sourceWhitespaceBefore: 'pdf-text-item',
        sourceWhitespacePredecessorIndex: 6,
        sourceTextPaint: paint(16, 17, 9),
      },
      {
        ...continuationBase,
        text: '2',
        x: 0.24,
        y: 0.322,
        width: 0.02,
        height: 0.007,
        fontName: 'Synthetic-STIXMath-Regular',
        fontSize: 6,
        sourceSequenceIndex: 8,
        sourceTextPaint: paint(17, 18, 9),
      },
      {
        ...continuationBase,
        text: '.',
        x: 0.28,
        width: 0.01,
        fontName: 'Synthetic-STIXGeneral-Regular',
        sourceSequenceIndex: 9,
        sourceTextPaint: paint(18, 19, 9),
      },
    ]
    continuation.lines[0].runs[2].y = 0.311
    continuation.lines[0].runs[2].height = 0.007
    continuation.lines[0].runs[2].fontSize = 6
    const inlineProseSibling = textRegion(
      'interleaved-answer-inline-prose',
      'where',
      box(0.05, 0.35, 0.06, 0.012),
    )
    inlineProseSibling.lines[0].id = `${inlineBaseId}-before`
    const sourcePage = page([])
    sourcePage.renderVisibleTextRuns = [
      cueRun,
      answerRun,
      variableRun,
      relation.lines[0].runs[0],
      ...continuation.lines[0].runs,
      detachedRootRun,
    ].map((run) => ({ ...run }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        input.sourceTextOperationFilter
          ? attestedTextOperationCrop(input, 'FinalAnswer:', 'q=x+12.√')
          : createSourcePageCropAsset({
              kind: 'equation',
              cropBox: input.sourceBox,
              sourceObjectIds: input.sourceObjectIds,
              sourceBoxes: input.sourceBoxes,
              width: 80,
              height: 20,
              pixels: new Uint8Array(80 * 20 * 4).fill(72),
            }),
    )

    const result = await reconstructPdfVisuals({
      pages: [sourcePage],
      regions: [
        preceding,
        mixedCue,
        relation,
        continuation,
        inlineProseSibling,
      ],
      rasterizeFigure,
    })

    expect(mixedCue.text).toBe('Final Answer:')
    expect(mixedCue.lines[0].text).toBe('Final Answer:')
    expect(mixedCue.lines[0].runs.map((run) => run.text)).toEqual([
      'Final',
      'Answer:',
    ])
    expect(result.consumedRegionIds.has(mixedCue.id)).toBe(false)
    expect(result.consumedLineIds.has(mixedCue.lines[0].id)).toBe(false)
    expect(result.relationships).toHaveLength(2)
    const answerEquation = result.relationships.find((relationship) =>
      relationship.sourceRegionIds.includes(continuation.id),
    )
    expect(answerEquation).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([relation.id, continuation.id]),
      evidence: expect.arrayContaining([
        'source-proved-atomic-equation-component',
        'source-page-crop-text-operation-filter-attested',
        'source-page-crop',
      ]),
    })
    expect(answerEquation?.sourceRegionIds).not.toContain(mixedCue.id)
    expect(
      result.relationships.find((relationship) =>
        relationship.sourceRegionIds.includes(preceding.id),
      )?.sourceRegionIds,
    ).toEqual([preceding.id])
  })

  it('does not let a math-font display bypass an interstitial prose boundary through fragment recovery', async () => {
    const first = equationRegion(
      'math-fragment-bypass-before-cue',
      '(1-t)/(2 cos θ) + √3t/(2 sin θ) = 1',
      box(0.09, 0.2, 0.3, 0.05),
    )
    const cue = textRegion(
      'math-fragment-bypass-cue',
      'Multiply by 2:',
      box(0.09, 0.247, 0.1, 0.018),
    )
    const second = equationRegion(
      'math-fragment-bypass-after-cue',
      '(1-t) sin θ + √3t cos θ = 2 sin θ cos θ',
      box(0.09, 0.263, 0.3, 0.02),
    )
    second.lines[0].runs[0].fontName = 'Synthetic-STIXMath-Regular'

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, cue, second],
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.map((relationship) => relationship.sourceLineIds),
    ).toEqual([[first.lines[0].id], [second.lines[0].id]])
    expect(
      result.relationships.every(
        (relationship) => !relationship.sourceRegionIds.includes(cue.id),
      ),
    ).toBe(true)
  })
})
