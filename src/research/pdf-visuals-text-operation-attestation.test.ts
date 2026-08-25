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

function postExhaustionOperationFixture({
  ownedRunCount,
  excludedRunCount,
  excludedProof = 'current-v2',
}: {
  ownedRunCount: number
  excludedRunCount: number
  excludedProof?: 'current-v2' | 'stale-ledger' | 'v1-only' | 'runless' | 'none'
}) {
  const equation = equationRegion(
    `post-exhaustion-equation-${ownedRunCount}-${excludedRunCount}-${excludedProof}`,
    'x + y = z',
    box(0.2, 0.3, 0.4, 0.1),
  )
  const cue = textRegion(
    `post-exhaustion-cue-${ownedRunCount}-${excludedRunCount}-${excludedProof}`,
    excludedProof === 'none' ? ' ' : 'p'.repeat(Math.max(1, excludedRunCount)),
    box(0.2, 0.289, 0.4, 0.009),
  )
  const ownedCharacters = Array.from(
    { length: ownedRunCount },
    (_unused, index) =>
      index === 1 ? '=' : index % 32 === 1 || index % 2 === 0 ? '1' : '+',
  )
  const ledgerText = 'p'.repeat(excludedRunCount) + ownedCharacters.join('')
  const textLedgerSha256 = pdfTextLedgerSha256(ledgerText)
  const paint = (
    start: number,
    end: number,
    operationIndex: number,
    ledgerSha256 = textLedgerSha256,
  ) => ({
    algorithm: 'pdfjs-text-paint-run-v1' as const,
    textLedgerSha256: ledgerSha256,
    normalizedTextStart: start,
    normalizedTextEnd: end,
    operatorLedgerSha256: 'a'.repeat(64),
    operationIndexes: [operationIndex],
    filterableOperationIndexes: [operationIndex],
  })
  const ownedRuns = Array.from({ length: ownedRunCount }, (_unused, index) => ({
    ...equation.lines[0].runs[0],
    text: ownedCharacters[index],
    x: 0.205 + (index % 32) * 0.011,
    y: 0.305 + Math.floor(index / 32) * 0.009,
    width: 0.007,
    height: 0.006,
    fontName:
      ownedRunCount > 256 && index >= 3
        ? 'Synthetic-CMEX10'
        : equation.lines[0].runs[0].fontName,
    sourceSequenceIndex: excludedRunCount + index,
    sourceTextPaint: paint(
      excludedRunCount + index,
      excludedRunCount + index + 1,
      3,
    ),
  }))
  const excludedRuns =
    excludedProof === 'runless' || excludedProof === 'none'
      ? []
      : Array.from({ length: excludedRunCount }, (_unused, index) => ({
          ...cue.lines[0].runs[0],
          text: 'p',
          x: 0.205 + index * 0.01,
          y: 0.294,
          width: 0.007,
          height: 0.003,
          sourceSequenceIndex: index,
          sourceTextPaint:
            excludedProof === 'v1-only'
              ? undefined
              : paint(
                  index,
                  index + 1,
                  1,
                  excludedProof === 'stale-ledger'
                    ? 'b'.repeat(64)
                    : textLedgerSha256,
                ),
        }))
  equation.lines[0].runs = ownedRuns
  equation.lines[0].text = ownedRuns.map((run) => run.text).join('')
  equation.text = 'x + y = z'
  cue.lines[0].runs = excludedRuns
  if (excludedProof === 'runless') {
    cue.lines[0].text = 'adjacent prose'
    cue.text = 'adjacent prose'
  }
  const sourcePage = page([])
  sourcePage.renderVisibleTextRuns = [
    ...excludedRuns.map((run) => ({ ...run })),
    ...ownedRuns.map((run) => ({ ...run })),
  ]
  return {
    cue,
    equation,
    sourcePage,
    excludedText: 'p'.repeat(excludedRunCount),
    ownedText: ownedCharacters.join(''),
  }
}

describe('PDF visual association graph', () => {
  it('uses an attested text-operation filter across flow/DISPLAY box drift and whitespace inventory items', async () => {
    const textLedgerSha256 = pdfTextLedgerSha256('Multiplyby2:√x=y')
    const cue: PdfPageRegion = textRegion(
      'sub-threshold-overlap-cue',
      'Multiply by 2:',
      box(0.1, 0.195, 0.08, 0.014),
    )
    const equation: PdfPageRegion = textRegion(
      'sub-threshold-overlap-equation',
      '√x = y',
      box(0.13, 0.205, 0.27, 0.02),
      'equation',
    )
    const sourcePaint = (
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
    const cueEarly = {
      ...cue.lines[0].runs[0],
      text: 'Multiply',
      x: 0.1,
      width: 0.045,
      sourceSequenceIndex: 1,
      sourceTextPaint: sourcePaint(0, 8, 7),
    }
    const cueLate = {
      ...cue.lines[0].runs[0],
      text: 'by 2:',
      x: 0.145,
      width: 0.035,
      sourceSequenceIndex: 2,
      sourceTextPaint: sourcePaint(8, 12, 7),
    }
    const equationEarly = {
      ...equation.lines[0].runs[0],
      text: '√x',
      x: 0.13,
      width: 0.06,
      sourceSequenceIndex: 3,
      sourceTextPaint: sourcePaint(12, 14, 9),
    }
    const equationLate = {
      ...equation.lines[0].runs[0],
      text: ' = y',
      x: 0.19,
      width: 0.06,
      sourceSequenceIndex: 4,
      sourceTextPaint: sourcePaint(14, 16, 9),
    }
    // Region and DISPLAY inventory order are independently shuffled. The
    // operation-filter contract is a canonical source-ledger set, not an
    // incidental reconstruction traversal order.
    cue.lines[0].runs = [cueLate, cueEarly]
    equation.lines[0].runs = [equationLate, equationEarly]
    const sourcePage = page([])
    sourcePage.renderVisibleTextRuns = [
      {
        ...cueLate,
        width: cueLate.width + 1e-15,
      },
      {
        ...cueEarly,
        height: cueEarly.height + 1e-15,
      },
      {
        ...equationLate,
        width: equationLate.width + 1e-15,
      },
      {
        ...equationEarly,
        height: equationEarly.height + 1e-15,
      },
      {
        ...equationEarly,
        text: ' ',
        sourceSequenceIndex: 5,
        sourceTextPaint: undefined,
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        expect(input.sourceTextOperationFilter).toMatchObject({
          excludedTextLedgerSpans: [
            { start: 0, end: 8 },
            { start: 8, end: 12 },
          ],
          ownedTextLedgerSpans: [
            { start: 12, end: 14 },
            { start: 14, end: 16 },
          ],
        })
        return attestedTextOperationCrop(input, 'Multiplyby2:', '√x=y')
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [sourcePage],
      regions: [cue, equation],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls[0]?.[0].sourceTextOperationFilter,
    ).toMatchObject({
      excludedTextLedgerSpans: [
        { start: 0, end: 8 },
        { start: 8, end: 12 },
      ],
      ownedTextLedgerSpans: [
        { start: 12, end: 14 },
        { start: 14, end: 16 },
      ],
    })
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: [equation.id],
    })
    expect(result.relationships[0].evidence).toContain(
      'source-page-crop-text-operation-filter-attested',
    )
    expect(result.relationships[0].sourceRegionIds).not.toContain(cue.id)
  })

  it('retries an edge-touching equation crop when a V2 text-operation filter proves overlapping prose ownership', async () => {
    const textLedgerSha256 = pdfTextLedgerSha256('Cueq=r')
    const cue = textRegion(
      'operation-filter-retry-cue',
      'Cue',
      box(0.1, 0.195, 0.08, 0.014),
    )
    const equation = equationRegion(
      'operation-filter-retry-equation',
      'q = r',
      box(0.13, 0.205, 0.27, 0.02),
    )
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
    const cueRun = {
      ...cue.lines[0].runs[0],
      method: 'pdf-text' as const,
      sourceSequenceIndex: 1,
      sourceTextPaint: paint(0, 3, 7),
    } satisfies PdfSourceRun
    const equationRun = {
      ...equation.lines[0].runs[0],
      method: 'pdf-text' as const,
      sourceSequenceIndex: 2,
      sourceTextPaint: paint(3, 6, 9),
    } satisfies PdfSourceRun
    cue.lines[0].runs[0] = cueRun
    equation.lines[0].runs[0] = equationRun
    const sourcePage = page([])
    sourcePage.renderVisibleTextRuns = [{ ...cueRun }, { ...equationRun }]
    let attempt = 0
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        expect(input.sourceTextOperationFilter).toMatchObject({
          excludedTextLedgerSpans: [{ start: 0, end: 3 }],
          ownedTextLedgerSpans: [{ start: 3, end: 6 }],
        })
        attempt += 1
        if (attempt === 1) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return attestedTextOperationCrop(input, 'Cue', 'q=r')
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [sourcePage],
      regions: [cue, equation],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[1][0].sourceBox).not.toEqual(
      rasterizeFigure.mock.calls[0][0].sourceBox,
    )
    expect(result.relationships).toEqual([
      expect.objectContaining({
        status: 'matched',
        sourceRegionIds: [equation.id],
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-page-crop-adaptive-padding',
          'source-page-crop-text-operation-filter-attested',
        ]),
      }),
    ])
    expect(result.relationships[0].sourceRegionIds).not.toContain(cue.id)
  })

  it('uses an attested V2 retry after an unowned-text veto when owned glyphs extend beyond the nominal line box', async () => {
    const textLedgerSha256 = pdfTextLedgerSha256('STAMPx=y')
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
    const contaminant = textRegion(
      'post-veto-contaminant',
      'STAMP',
      box(0.28, 0.297, 0.06, 0.004),
    )
    const equation = equationRegion(
      'post-veto-equation',
      'x = y',
      box(0.2, 0.3, 0.4, 0.1),
    )
    const contaminantRun = {
      ...contaminant.lines[0].runs[0],
      text: 'STAMP',
      x: 0.28,
      y: 0.297,
      width: 0.06,
      height: 0.004,
      method: 'pdf-text' as const,
      sourceSequenceIndex: 0,
      sourceTextPaint: paint(0, 5, 7),
    } satisfies PdfSourceRun
    const equationRun = {
      ...equation.lines[0].runs[0],
      text: 'x=y',
      x: 0.25,
      y: 0.2925,
      width: 0.1,
      height: 0.0025,
      method: 'pdf-text' as const,
      sourceSequenceIndex: 1,
      sourceTextPaint: paint(5, 8, 9),
    } satisfies PdfSourceRun
    contaminant.lines[0].runs = [contaminantRun]
    equation.lines[0].runs = [equationRun]
    const sourcePage = page([])
    sourcePage.renderVisibleTextRuns = [
      { ...contaminantRun },
      { ...equationRun },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        attestedTextOperationCrop(input, 'STAMP', 'x=y'),
    )

    const result = await reconstructPdfVisuals({
      pages: [sourcePage],
      regions: [contaminant, equation],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0]).toMatchObject({
      sourceBox: expect.objectContaining({ y: 0.292 }),
      sourceTextOperationFilter: expect.objectContaining({
        algorithm: 'pdfjs-display-text-operation-filter-v2',
        excludedTextLedgerSpans: [{ start: 0, end: 5 }],
        ownedTextLedgerSpans: [{ start: 5, end: 8 }],
      }),
    })
    expect(result.relationships).toEqual([
      expect.objectContaining({
        status: 'matched',
        sourceRegionIds: [equation.id],
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-page-crop-post-exhaustion-v2',
          'source-page-crop-text-operation-filter-attested',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(contaminant.id)).toBe(false)
  })

  it.each([
    { ownedRunCount: 71, excludedRunCount: 9 },
    { ownedRunCount: 24, excludedRunCount: 1 },
  ])(
    'uses only an attested V2 crop beyond exhausted neighbor bounds for a $ownedRunCount/$excludedRunCount operation scope',
    async ({ ownedRunCount, excludedRunCount }) => {
      const fixture = postExhaustionOperationFixture({
        ownedRunCount,
        excludedRunCount,
      })
      const acceptedAssets: PdfVisualAsset[] = []
      let rasterizationError: unknown = null
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) => {
          if (!input.sourceTextOperationFilter) {
            throw new Error('PDF page crop has source ink touching its edge')
          }
          expect(input.ownedSourceBoxes).toBeUndefined()
          expect(input.excludedSourceBoxes).toBeUndefined()
          expect(input.sourceTextOperationFilter).toMatchObject({
            algorithm: 'pdfjs-display-text-operation-filter-v2',
            expansionPixels: 0,
            ownedTextLedgerSpans: expect.arrayContaining([
              { start: excludedRunCount, end: excludedRunCount + 1 },
            ]),
            excludedTextLedgerSpans: expect.arrayContaining([
              { start: 0, end: 1 },
            ]),
          })
          expect(
            input.sourceTextOperationFilter.ownedTextLedgerSpans,
          ).toHaveLength(ownedRunCount)
          expect(
            input.sourceTextOperationFilter.excludedTextLedgerSpans,
          ).toHaveLength(excludedRunCount)
          try {
            const acceptedAsset = await attestedTextOperationCrop(
              input,
              fixture.excludedText,
              fixture.ownedText,
            )
            acceptedAssets.push(acceptedAsset)
            return acceptedAsset
          } catch (error) {
            rasterizationError = error
            throw error
          }
        },
      )

      const result = await reconstructPdfVisuals({
        pages: [fixture.sourcePage],
        regions: [fixture.cue, fixture.equation],
        rasterizeFigure,
      })

      const filterCallIndex = rasterizeFigure.mock.calls.findIndex(
        ([input]) => input.sourceTextOperationFilter !== undefined,
      )
      expect(filterCallIndex).toBe(11)
      expect(rasterizationError).toBeNull()
      expect(
        rasterizeFigure.mock.calls
          .slice(0, filterCallIndex)
          .every(([input]) => input.sourceBox.y >= 0.298),
      ).toBe(true)
      expect(
        rasterizeFigure.mock.calls[filterCallIndex][0].sourceBox.y,
      ).toBeLessThan(0.295)
      expect(result.relationships).toEqual([
        expect.objectContaining({
          status: 'matched',
          sourceRegionIds: [fixture.equation.id],
          evidence: expect.arrayContaining([
            'source-page-crop',
            'source-page-crop-post-exhaustion-v2',
            'source-page-crop-text-operation-filter-attested',
          ]),
        }),
      ])
      expect(result.consumedRegionIds.has(fixture.cue.id)).toBe(false)
      expect(acceptedAssets).toHaveLength(1)
      const acceptedAsset = acceptedAssets[0]
      if (!acceptedAsset) {
        throw new Error('expected one accepted post-exhaustion V2 asset')
      }
      const acceptedMask = acceptedAsset.sourceExclusionMask
      expect(acceptedMask).toMatchObject({
        algorithm: 'pdfjs-display-text-operation-filter-v2',
      })
      if (
        !acceptedMask ||
        acceptedMask.algorithm !== 'pdfjs-display-text-operation-filter-v2'
      ) {
        throw new Error('expected an attested V2 source-exclusion mask')
      }
      expect(acceptedMask.baselineRgbaSha256).not.toBe(
        acceptedMask.filteredRgbaSha256,
      )
      expect(acceptedMask.ownedOnlyRgbaSha256).toBe(
        acceptedMask.filteredRgbaSha256,
      )
    },
  )

  it('does not let earlier edge contact override a later bounded attestation failure', async () => {
    const fixture = postExhaustionOperationFixture({
      ownedRunCount: 24,
      excludedRunCount: 1,
    })
    let attempt = 0
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (input.sourceBox.y < 0.295) {
          throw new Error('unsafe post-exhaustion crop was attempted')
        }
        attempt += 1
        if (attempt === 1) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        throw new Error(
          'PDF page crop contains unowned DISPLAY text paint outside the selected exclusion filter',
        )
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [fixture.sourcePage],
      regions: [fixture.cue, fixture.equation],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(result.relationships).toEqual([
      expect.objectContaining({
        status: 'unresolved',
        evidence: expect.not.arrayContaining([
          'source-page-crop-post-exhaustion-v2',
        ]),
      }),
    ])
  })

  it.each([
    {
      label: 'absent',
      ownedRunCount: 24,
      excludedRunCount: 0,
      excludedProof: 'none' as const,
    },
    {
      label: 'stale-ledger',
      ownedRunCount: 24,
      excludedRunCount: 1,
      excludedProof: 'stale-ledger' as const,
    },
    {
      label: 'V1-only',
      ownedRunCount: 24,
      excludedRunCount: 1,
      excludedProof: 'v1-only' as const,
    },
    {
      label: 'runless',
      ownedRunCount: 24,
      excludedRunCount: 1,
      excludedProof: 'runless' as const,
    },
    {
      label: 'over-owned-cap',
      ownedRunCount: 257,
      excludedRunCount: 1,
      excludedProof: 'current-v2' as const,
    },
    {
      label: 'over-excluded-cap',
      ownedRunCount: 24,
      excludedRunCount: 33,
      excludedProof: 'current-v2' as const,
    },
  ])(
    'does not cross exhausted neighbor bounds with a $label operation plan',
    async ({ ownedRunCount, excludedRunCount, excludedProof }) => {
      const fixture = postExhaustionOperationFixture({
        ownedRunCount,
        excludedRunCount,
        excludedProof,
      })
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) => {
          if (input.sourceBox.y < 0.295) {
            throw new Error('unsafe post-exhaustion crop was attempted')
          }
          throw new Error('PDF page crop has source ink touching its edge')
        },
      )

      const result = await reconstructPdfVisuals({
        pages: [fixture.sourcePage],
        regions: [fixture.cue, fixture.equation],
        rasterizeFigure,
      })

      expect(
        rasterizeFigure.mock.calls.every(
          ([input]) => input.sourceBox.y >= 0.298,
        ),
      ).toBe(true)
      expect(rasterizeFigure.mock.calls.length).toBeGreaterThan(0)
      expect(
        rasterizeFigure.mock.calls.every(
          ([input]) => input.sourceTextOperationFilter === undefined,
        ),
      ).toBe(true)
      expect(
        result.relationships.some(
          (relationship) =>
            relationship.status === 'matched' ||
            relationship.evidence.includes(
              'source-page-crop-post-exhaustion-v2',
            ),
        ),
      ).toBe(false)
    },
  )
})
