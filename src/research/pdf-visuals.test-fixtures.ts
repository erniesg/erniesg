import { vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualAsset,
} from './import-types'
import type { PdfFigureRasterizer } from './pdf-visuals'
import {
  createSourcePageCropAsset,
  createVectorSvgAsset,
} from './visual-assets'
import { renderPdfPageCrop } from './pdf-page-crop'
import {
  pdfTextLedgerSha256,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
} from './pdf-text-paint'

export function box(x: number, y: number, width = 0.2, height = 0.1, page = 1) {
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

export function containsSourceBox(
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

export function objectRegion(
  id: string,
  objectId: string,
  sourceBox: NormalizedSourceBox,
) {
  return {
    id,
    page: sourceBox.page,
    kind: 'figure',
    column: 'single',
    text: '',
    confidence: 0.98,
    box: sourceBox,
    lines: [],
    nativeObjectIds: [objectId],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

export function captionRegion(
  text: string,
  sourceBox = box(0.2, 0.32, 0.5, 0.02),
) {
  return {
    id: 'caption-region',
    page: sourceBox.page,
    kind: 'caption',
    column: 'single',
    text,
    confidence: 0.94,
    box: { ...sourceBox, method: 'pdf-text' as const },
    lines: [],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

export function equationRegion(
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

export function textRegion(
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

export function page(
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

export async function attestedTextOperationCrop(
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

export function postExhaustionOperationFixture({
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

export function sourcePreservedSvgAsset(
  sourceObjectId: string,
  sourceBox: NormalizedSourceBox,
): PdfVisualAsset {
  return {
    id: `asset-${sourceObjectId}`,
    href: `assets/asset-${sourceObjectId}.svg`,
    mediaType: 'image/svg+xml',
    kind: 'vector',
    rendition: 'source-preserved',
    sha256: 'a'.repeat(64),
    bytes: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><path d="M0 0L40 0L20 30Z" fill="#c30" /></svg>',
    ),
    width: 40,
    height: 30,
    resolutionDpi: null,
    sourceObjectIds: [sourceObjectId],
    sourceBoxes: [sourceBox],
  }
}

export async function solidRectangleFallbackAsset(
  sourceObjectId: string,
  sourceBox: NormalizedSourceBox,
) {
  return await createVectorSvgAsset({
    sourceObjectId,
    sourceBox,
    path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    paint: 'fill',
  })
}
