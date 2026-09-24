import { strFromU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualAsset,
} from './import-types'
import {
  equationSourceRunOwnershipKey,
  isProbableDisplayEquation,
  pdfVisualMatchCandidateId,
  pdfVisualOwnershipExtentSha256,
  repeatedRectangleFallbackObjectIds,
  reconstructPdfVisuals,
  type PdfFigureRasterizer,
} from './pdf-visuals'
import {
  createCompositePngAsset,
  createPngAsset,
  createSourcePageCropAsset,
  createVectorSvgAsset,
} from './visual-assets'
import { renderPdfPageCrop } from './pdf-page-crop'
import {
  pdfTextLedgerSha256,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
} from './pdf-text-paint'

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

function objectRegion(
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

function captionRegion(text: string, sourceBox = box(0.2, 0.32, 0.5, 0.02)) {
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

function sourcePreservedSvgAsset(
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

async function solidRectangleFallbackAsset(
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

describe('PDF visual association graph', () => {
  it('binds exact raw-run and text-paint provenance into equation ownership', () => {
    const ownershipRegion = textRegion(
      'exact-equation-run-identity',
      '√x = y',
      box(0.2, 0.2, 0.2, 0.02),
      'equation',
    )
    const base = ownershipRegion.lines[0].runs[0]
    const proved = {
      ...base,
      sourceSequenceIndex: 17,
      sourceTextPaint: {
        algorithm: 'pdfjs-text-paint-run-v1' as const,
        textLedgerSha256: 'b'.repeat(64),
        normalizedTextStart: 0,
        normalizedTextEnd: 4,
        operatorLedgerSha256: 'a'.repeat(64),
        operationIndexes: [41, 44],
        filterableOperationIndexes: [41, 44],
      },
    }
    const identity = equationSourceRunOwnershipKey(proved)
    ownershipRegion.lines[0].runs[0] = proved
    const ownershipExtentSha256 = pdfVisualOwnershipExtentSha256(
      [ownershipRegion],
      [ownershipRegion.id],
      [ownershipRegion.lines[0].id],
    )

    expect(
      equationSourceRunOwnershipKey({
        ...proved,
        sourceSequenceIndex: 18,
      }),
    ).not.toBe(identity)
    proved.sourceTextPaint.normalizedTextStart = 1
    expect(
      pdfVisualOwnershipExtentSha256(
        [ownershipRegion],
        [ownershipRegion.id],
        [ownershipRegion.lines[0].id],
      ),
    ).not.toBe(ownershipExtentSha256)
    proved.sourceTextPaint.normalizedTextStart = 0
    const secondRun = {
      ...proved,
      text: 'z',
      x: proved.x + 0.05,
      sourceSequenceIndex: 18,
      sourceTextPaint: {
        ...proved.sourceTextPaint,
        normalizedTextStart: 4,
        normalizedTextEnd: 5,
        operationIndexes: [45],
        filterableOperationIndexes: [45],
      },
    }
    ownershipRegion.lines.push({
      ...ownershipRegion.lines[0],
      id: `${ownershipRegion.lines[0].id}-second`,
      text: secondRun.text,
      runs: [secondRun],
    })
    const pairedLineOwnership = pdfVisualOwnershipExtentSha256(
      [ownershipRegion],
      [ownershipRegion.id],
      ownershipRegion.lines.map((line) => line.id),
    )
    const firstLineRun = ownershipRegion.lines[0].runs[0]
    ownershipRegion.lines[0].runs[0] = secondRun
    ownershipRegion.lines[1].runs[0] = firstLineRun
    expect(
      pdfVisualOwnershipExtentSha256(
        [ownershipRegion],
        [ownershipRegion.id],
        ownershipRegion.lines.map((line) => line.id),
      ),
    ).not.toBe(pairedLineOwnership)
    expect(
      equationSourceRunOwnershipKey({
        ...proved,
        method: 'ocr',
      }),
    ).not.toBe(identity)
    expect(
      equationSourceRunOwnershipKey({
        ...proved,
        x: proved.x + 0.000001,
      }),
    ).not.toBe(identity)
    expect(
      equationSourceRunOwnershipKey({
        ...proved,
        sourceTextPaint: {
          ...proved.sourceTextPaint,
          operationIndexes: [41, 45],
          filterableOperationIndexes: [41, 45],
        },
      }),
    ).not.toBe(identity)
  })

  it('keeps candidate-local ownership stable across page-global operator ledger attestations', () => {
    const ownershipRegion = textRegion(
      'stable-local-ownership',
      'x = y',
      box(0.2, 0.2, 0.2, 0.02),
      'equation',
    )
    const run = ownershipRegion.lines[0].runs[0] as PdfSourceRun
    run.sourceTextPaint = {
      algorithm: 'pdfjs-text-paint-run-v1',
      textLedgerSha256: 'b'.repeat(64),
      normalizedTextStart: 0,
      normalizedTextEnd: 3,
      operatorLedgerSha256: 'a'.repeat(64),
      operationIndexes: [41, 44],
      filterableOperationIndexes: [41, 44],
    }
    const ownershipExtentSha256 = pdfVisualOwnershipExtentSha256(
      [ownershipRegion],
      [ownershipRegion.id],
      [ownershipRegion.lines[0].id],
    )

    run.sourceTextPaint.operatorLedgerSha256 = 'c'.repeat(64)

    expect(
      pdfVisualOwnershipExtentSha256(
        [ownershipRegion],
        [ownershipRegion.id],
        [ownershipRegion.lines[0].id],
      ),
    ).toBe(ownershipExtentSha256)
  })

  it('keeps the event loop cooperative while classifying a vector-heavy figure set', async () => {
    const count = 130
    const objects = Array.from({ length: count }, (_, index) => {
      const sourceBox = box(
        (index % 13) * 0.075,
        Math.floor(index / 13) * 0.075,
        0.01,
        0.01,
      )
      return {
        id: `cooperative-vector-${index}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 1,
        assetId: null,
      }
    })
    const regions = objects.map((object, index) =>
      objectRegion(`cooperative-region-${index}`, object.id, object.box),
    )
    let timerScheduled = false
    let timerFired = false
    let observedTimerAfterInternalYield = false

    await reconstructPdfVisuals({
      pages: [page(objects)],
      regions,
      onProgress(progress) {
        if (progress.checkpoint !== 'figure-heading-classification') return
        if (!timerScheduled) {
          timerScheduled = true
          globalThis.setTimeout(() => {
            timerFired = true
          }, 0)
          return
        }
        observedTimerAfterInternalYield ||= timerFired
      },
    })

    expect(timerScheduled).toBe(true)
    expect(timerFired).toBe(true)
    expect(observedTimerAfterInternalYield).toBe(true)
  })

  it('keeps the event loop cooperative while discovering display equations across many pages', async () => {
    const pageCount = 24
    const equationsPerPage = 12
    const pages = Array.from({ length: pageCount }, (_, pageIndex) =>
      page([], pageIndex + 1),
    )
    const regions = pages.flatMap((sourcePage) =>
      Array.from({ length: equationsPerPage }, (_, equationIndex) => {
        const id = `cooperative-equation-${sourcePage.page}-${equationIndex}`
        return {
          ...equationRegion(
            id,
            `x${equationIndex} = y${equationIndex}`,
            box(0.2, 0.08 + equationIndex * 0.07, 0.3, 0.015, sourcePage.page),
          ),
          page: sourcePage.page,
        }
      }),
    )
    let timerScheduled = false
    let timerFired = false
    let observedTimerAfterInternalYield = false

    await reconstructPdfVisuals({
      pages,
      regions,
      onProgress(progress) {
        if (progress.checkpoint !== 'equation-component-discovery') return
        if (!timerScheduled) {
          timerScheduled = true
          globalThis.setTimeout(() => {
            timerFired = true
          }, 0)
          return
        }
        observedTimerAfterInternalYield ||= timerFired
      },
    })

    expect(timerScheduled).toBe(true)
    expect(timerFired).toBe(true)
    expect(observedTimerAfterInternalYield).toBe(true)
  })

  it('yields between caption-bounded semantic envelope candidates', async () => {
    const captions = [
      {
        ...captionRegion(
          'Figure 1. First semantic envelope.',
          box(0.2, 0.35, 0.5, 0.02),
        ),
        id: 'semantic-envelope-caption-1',
      },
      {
        ...captionRegion(
          'Figure 2. Second semantic envelope.',
          box(0.2, 0.7, 0.5, 0.02),
        ),
        id: 'semantic-envelope-caption-2',
      },
    ]
    let timerScheduled = false
    let timerFired = false
    let observedTimerAfterInternalYield = false

    await reconstructPdfVisuals({
      pages: [page([])],
      regions: captions,
      onProgress(progress) {
        if (progress.checkpoint !== 'figure-grouping-envelopes') return
        if (!timerScheduled) {
          timerScheduled = true
          globalThis.setTimeout(() => {
            timerFired = true
          }, 0)
          return
        }
        observedTimerAfterInternalYield ||= timerFired
      },
    })

    expect(timerScheduled).toBe(true)
    expect(timerFired).toBe(true)
    expect(observedTimerAfterInternalYield).toBe(true)
  })

  it('indexes vector-heavy non-overlapping rectangle fallbacks with bounded comparisons', () => {
    const count = 1_000
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 0L1 1L0 1Z" fill="#000" stroke="none"/></svg>',
    )
    const assets = Array.from({ length: count }, (_, index) => {
      const sourceObjectId = `vector-${index}`
      const sourceBox = box(
        (index % 40) * 0.024,
        Math.floor(index / 40) * 0.024,
        0.006,
        0.006,
      )
      return {
        id: `asset-${index}`,
        href: `assets/asset-${index}.svg`,
        mediaType: 'image/svg+xml',
        kind: 'vector',
        rendition: 'bounded-svg-fallback',
        sha256: index.toString(16).padStart(64, '0'),
        bytes: svg,
        width: 1,
        height: 1,
        resolutionDpi: null,
        sourceObjectIds: [sourceObjectId],
        sourceBoxes: [sourceBox],
      } satisfies PdfVisualAsset
    })
    const objects = assets.map((asset) => ({
      id: asset.sourceObjectIds[0],
      page: 1,
      kind: 'vector' as const,
      box: asset.sourceBoxes[0],
      confidence: 1,
      assetId: asset.id,
    }))
    const evidence = { candidateComparisons: 0 }

    expect(
      repeatedRectangleFallbackObjectIds([page(objects, 1, assets)], evidence),
    ).toEqual(new Set())
    expect(evidence.candidateComparisons).toBeLessThan(count * 100)
  })

  it('derives candidate identity from stable relationship content, not UI order', () => {
    const candidate = {
      sourceRegionIds: ['region-b', 'region-a'],
      sourceLineIds: ['line-b', 'line-a'],
      sourceObjectIds: ['object-b', 'object-a'],
      assetIds: ['asset-b', 'asset-a'],
      sourceBoxes: [box(0.3, 0.2, 0.1, 0.04), box(0.1, 0.2, 0.1, 0.04)],
      sourceText: 'alpha beta',
      ownershipExtentSha256: 'a'.repeat(64),
    }
    const reordered = {
      ...candidate,
      sourceRegionIds: [...candidate.sourceRegionIds].reverse(),
      sourceLineIds: [...candidate.sourceLineIds].reverse(),
      sourceObjectIds: [...candidate.sourceObjectIds].reverse(),
      assetIds: [...candidate.assetIds].reverse(),
      sourceBoxes: [...candidate.sourceBoxes].reverse(),
    }
    const candidateId = pdfVisualMatchCandidateId(
      'visual-relationship-0001',
      candidate,
    )
    expect(candidateId).toBe(
      pdfVisualMatchCandidateId('visual-relationship-0001', reordered),
    )
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0002', candidate),
    ).not.toBe(candidateId)
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', {
        ...candidate,
        sourceLineIds: ['line-a'],
      }),
    ).not.toBe(candidateId)
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', {
        ...candidate,
        sourceBoxes: [candidate.sourceBoxes[0]],
      }),
    ).not.toBe(candidateId)
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', {
        ...candidate,
        sourceBoxes: [...candidate.sourceBoxes].reverse(),
      }),
    ).not.toBe(candidateId)
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', {
        ...candidate,
        ownershipExtentSha256: 'b'.repeat(64),
      }),
    ).not.toBe(candidateId)
    const staleCandidate = { ...candidate, ownershipExtentSha256: undefined }
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', staleCandidate),
    ).not.toBe(candidateId)
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', {
        ...candidate,
        sourceText: 'alpha gamma',
      }),
    ).not.toBe(candidateId)
    const renderOnlyOwnership = {
      algorithm: 'equation-bracketed-render-only-extension-glyph-v1' as const,
      page: 1,
      sourceLineId: 'line-a',
      sourceSequenceIndex: 14,
      precedingSourceSequenceIndex: 13,
      followingSourceSequenceIndex: 15,
      sourceRunSha256: '1'.repeat(64),
      precedingSourceRunSha256: '2'.repeat(64),
      followingSourceRunSha256: '3'.repeat(64),
    }
    const renderOwnedCandidateId = pdfVisualMatchCandidateId(
      'visual-relationship-0001',
      {
        ...candidate,
        renderOnlySourceRunOwnerships: [renderOnlyOwnership],
      },
    )
    expect(renderOwnedCandidateId).not.toBe(candidateId)
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', {
        ...candidate,
        renderOnlySourceRunOwnerships: [
          {
            ...renderOnlyOwnership,
            sourceRunSha256: '4'.repeat(64),
          },
        ],
      }),
    ).not.toBe(renderOwnedCandidateId)
    const withoutLines = { ...candidate, sourceLineIds: undefined }
    expect(
      pdfVisualMatchCandidateId('visual-relationship-0001', {
        ...withoutLines,
        sourceBoxes: [box(0.31, 0.2, 0.1, 0.04)],
      }),
    ).not.toBe(
      pdfVisualMatchCandidateId('visual-relationship-0001', withoutLines),
    )
  })
  it('matches a source-backed figure with a compound scholarly label', async () => {
    const sourceBox = box(0.2, 0.08, 0.6, 0.2)
    const sourceObjectId = 'compound-label-source'
    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 1,
              assetId: `asset-${sourceObjectId}`,
              role: 'semantic',
            },
          ],
          1,
          [sourcePreservedSvgAsset(sourceObjectId, sourceBox)],
        ),
      ],
      regions: [
        objectRegion('compound-label-object', sourceObjectId, sourceBox),
        captionRegion(
          'Figure A.1. Compound source-backed figure.',
          box(0.2, 0.32, 0.6, 0.03),
        ),
      ],
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        label: 'Figure A.1',
        status: 'matched',
        sourceObjectIds: [sourceObjectId],
      }),
    ])
  })

  it('promotes a dedicated bold figure label misclassified as body text', async () => {
    const sourceBox = box(0.2, 0.08, 0.6, 0.2)
    const sourceObjectId = 'body-caption-source'
    const caption: PdfPageRegion = textRegion(
      'body-caption',
      'Fig. 2 System Architecture for AI-Driven Risk Management',
      box(0.2, 0.32, 0.6, 0.03),
    )
    caption.lines[0].runs[0].bold = true

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 1,
              assetId: `asset-${sourceObjectId}`,
              role: 'semantic',
            },
          ],
          1,
          [sourcePreservedSvgAsset(sourceObjectId, sourceBox)],
        ),
      ],
      regions: [
        objectRegion('body-caption-object', sourceObjectId, sourceBox),
        caption,
      ],
    })

    expect(caption.kind).toBe('caption')
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        label: 'Figure 2',
        status: 'matched',
        captionRegionId: caption.id,
        sourceObjectIds: [sourceObjectId],
      }),
    ])
  })

  it('surfaces an unresolved relationship for an explicit caption with an unparseable label', async () => {
    const sourceBox = box(0.2, 0.08, 0.6, 0.2)
    const sourceObjectId = 'unparseable-label-source'
    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 1,
              assetId: `asset-${sourceObjectId}`,
              role: 'semantic',
            },
          ],
          1,
          [sourcePreservedSvgAsset(sourceObjectId, sourceBox)],
        ),
      ],
      regions: [
        objectRegion('unparseable-label-object', sourceObjectId, sourceBox),
        captionRegion(
          'Figure: Explicit caption with source geometry.',
          box(0.2, 0.32, 0.6, 0.03),
        ),
      ],
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        label: 'Figure ?',
        status: 'unresolved',
        evidence: expect.arrayContaining(['unparseable-scholarly-label']),
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
        }),
      ]),
    )
  })

  it('does not emit a duplicate table relationship for an unstyled prose cross-reference misclassified as a caption', async () => {
    const falseCaptionBox = {
      ...box(0.52, 0.18, 0.36, 0.08),
      method: 'pdf-text' as const,
    }
    const falseCaption = {
      id: 'prose-table-six-reference',
      page: 1,
      kind: 'caption' as const,
      column: 'right' as const,
      text: 'Table 6. Thus if a name already appears in the premise, it can be copied.',
      confidence: 0.99,
      box: falseCaptionBox,
      lines: [
        {
          id: 'prose-table-six-reference-line',
          text: 'Table 6. Thus if a name already appears in the premise, it can be copied.',
          fontSize: 11,
          box: falseCaptionBox,
          runs: [
            {
              ...falseCaptionBox,
              text: 'Table 6. Thus if a name already appears in the premise, it can be copied.',
              fontName: 'BodySerif-Regular',
              fontSize: 11,
              confidence: 0.99,
            },
          ],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const trueCaptionBox = {
      ...box(0.52, 0.5, 0.35, 0.03),
      method: 'pdf-text' as const,
    }
    const trueCaption = {
      id: 'true-table-six-caption',
      page: 1,
      kind: 'caption' as const,
      column: 'right' as const,
      text: 'Table 6: An example source prompt.',
      confidence: 0.99,
      box: trueCaptionBox,
      lines: [
        {
          id: 'true-table-six-caption-line',
          text: 'Table 6: An example source prompt.',
          fontSize: 9,
          box: trueCaptionBox,
          runs: [
            {
              ...trueCaptionBox,
              width: 0.08,
              text: 'Table 6:',
              fontName: 'CaptionSerif-Medium',
              fontSize: 9,
              confidence: 0.99,
            },
            {
              ...trueCaptionBox,
              x: 0.61,
              width: 0.26,
              text: 'An example source prompt.',
              fontName: 'CaptionSerif-Regular',
              fontSize: 9,
              confidence: 0.99,
            },
          ],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const result = await reconstructPdfVisuals({
      pages: [page([], 1)],
      regions: [falseCaption, trueCaption],
    })

    expect(
      result.relationships.map((relationship) => ({
        label: relationship.label,
        captionRegionId: relationship.captionRegionId,
      })),
    ).toEqual([
      {
        label: 'Table 6',
        captionRegionId: trueCaption.id,
      },
    ])
  })

  it.each([
    'https://example.test/search?paper=123',
    'A. Performance of all models on a+b=',
    'activating a+b example.',
    'B(a) = 0. For each value of k,',
    'id=p4PckNQR8k.',
    'forum?id=O9YTt26r2P.',
    'd=kRxCDDFNpp.',
    'um?id=N8N0hgNDRt.',
    '=',
    '(a) CKNNA (k = 10)',
    '(b) Cycle k-NN (k = 10)',
    '(c) Edit-distance k-NN (k = 10)',
    '(d) Longest-Common-Subsequence k-NN (k = 10)',
    'a = 361 because 360 has more integer divisors, allowing',
    'namely MLP(x) = σ(xWup) Wdown, where σ(x) is',
    '1. a − 23 for a ∈ [23,99]',
    '(4) where N is the number of samples.',
    '• A kernel, K: X × X → R, characterizes how a represen-',
    '• A kernel-alignment metric, m: K × K → R, measures',
    'Belief variance swap on probability p = S(x). A short-maturity, frozen-state ap-',
    'Grid and seeds. N=6000 steps at 1 Hz; random seeds are fixed. KF. Process noise uses',
    'r = 0.635',
    '80 r = 0.784',
    '80 r = 0.540 p = 0.007',
  ])(
    'does not classify prose or URL text as a display equation: %s',
    (text) => {
      expect(
        isProbableDisplayEquation(
          equationRegion(
            'false-equation-region',
            text,
            box(0.2, 0.2, 0.6, 0.03),
          ),
        ),
      ).toBe(false)
    },
  )

  it.each([
    'q = r',
    'a + b',
    'min E(s,a) − log π(a|s) = 0',
    'halili == attnhli−1l + hli−1',
  ])('retains compact mathematical display detection: %s', (text) => {
    expect(
      isProbableDisplayEquation(
        equationRegion('true-equation-region', text, box(0.2, 0.2, 0.6, 0.03)),
      ),
    ).toBe(true)
  })

  it('recognizes decoded CMEX display fragments from real math font provenance', () => {
    const summation = equationRegion(
      'decoded-cmex-summation',
      'Nnl (a, b) = ∑ ctt+',
      box(0.5, 0.1, 0.18, 0.03),
    )
    summation.lines[0].runs[0].fontName = 'ABCDEF+CMEX10'
    const continuation = equationRegion(
      'decoded-cmex-continuation',
      'cT t cos ((2Tπ (t − dT t))',
      box(0.7, 0.1, 0.2, 0.04),
    )
    continuation.lines[0].runs[0].fontName = 'ABCDEF+CMEX10'

    expect(isProbableDisplayEquation(summation)).toBe(true)
    expect(isProbableDisplayEquation(continuation)).toBe(true)
  })

  it('source-crops a resolved CMEX integral without a lexical relation cue', async () => {
    const integral = equationRegion(
      'resolved-cmex-integral',
      '∫(∆pi∆pj νij,t(dzi, dzj)',
      box(0.35, 0.56, 0.22, 0.03),
    )
    integral.lines[0].runs = [
      {
        ...integral.lines[0].box,
        text: '∫',
        width: 0.012,
        fontName: 'Synthetic-CMEX10',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integral.lines[0].box,
        text: '(',
        x: 0.362,
        width: 0.008,
        fontName: 'Synthetic-CMEX10',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integral.lines[0].box,
        text: '∆pi∆pj νij,t(dzi, dzj)',
        x: 0.37,
        width: 0.2,
        fontName: 'Synthetic-CMMI12',
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
          width: 40,
          height: 12,
          pixels: new Uint8Array(40 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [integral],
      rasterizeFigure,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        status: 'matched',
        canonicalNodeId:
          'visual-equation-p001-display-equation-p001-00-equation-source-p001-001-visual-relationship-0001',
        sourceRegionIds: [integral.id],
        sourceText: '',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-text-transcript-unresolved',
        ]),
      }),
    ])
  })

  it.each([
    {
      name: 'ordinary-font held-out prose',
      prefix: 'Sensitivity analysis demonstrates robustness',
      suffix: 'across conditions.',
      fontName: 'Synthetic-Serif',
    },
    {
      name: 'math-font-mislabeled held-out prose',
      prefix: 'Sensitivity analysis demonstrates robustness',
      suffix: 'across conditions.',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'lexically obvious prose',
      prefix: 'where N(a,b)',
      suffix: 'cdefghijklmnop',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'short-word math-font-mislabeled prose',
      prefix: 'Ask us if x is in y',
      suffix: 'now.',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'punctuation-attached math-font-mislabeled prose',
      prefix: 'Go, do; it.',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'em-dash-joined math-font-mislabeled prose',
      prefix: 'Go—do—it.',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'parenthesized math-font-mislabeled prose with a digit',
      prefix: '(Read) (this) (now) 1',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'square-bracketed math-font-mislabeled prose with an operator',
      prefix: '[Read] [this] [now] +',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'brace-wrapped math-font-mislabeled prose with Greek text',
      prefix: '{Read} {this} {now} α',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'angle-bracketed math-font-mislabeled prose with a summation',
      prefix: '⟨Read⟩ ⟨this⟩ ⟨now⟩ ∑',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'guillemet-delimited math-font-mislabeled prose with a digit',
      prefix: '«Read» «this» «now» 1',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'fullwidth-bracketed math-font-mislabeled prose with internal digits',
      prefix: '（Read1） （this1） （now1）',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'parenthesized math-font-mislabeled prose with internal operators',
      prefix: '(Read+) (this+) (now+)',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'one parenthesized prose segment with internal digits',
      prefix: '(Read1 this2 now)',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'one black-bracketed prose segment with internal operators',
      prefix: '【Read+ this+ now】',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'nested bracketed prose with internal digits',
      prefix: '(Read1 [this2] now)',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'guillemet-delimited short prose with internal operators',
      prefix: '«Can+ we+ go»',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'black-bracketed short prose with internal operators',
      prefix: '【Ask+ us+ now】',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'separately delimited short prose with suffix operators',
      prefix: '«Can+» «we+» «go»',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'separately delimited short prose with prefix operators',
      prefix: '【+Ask】 【+us】 【now】',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
    {
      name: 'one punctuated prose token inside parentheses',
      prefix: '(Read!) 1',
      suffix: '',
      fontName: 'Synthetic-CMMI10',
    },
  ])(
    'does not let an unresolved CMEX glyph promote $name',
    async ({ prefix, suffix, fontName }) => {
      const equation = equationRegion(
        'unresolved-cmex-equation',
        `${prefix} \ufffd ${suffix}`,
        box(0.15, 0.37798, 0.7, 0.0257),
      )
      equation.lines[0].runs = [
        {
          ...equation.lines[0].box,
          text: prefix,
          x: 0.15,
          y: 0.38948,
          width: 0.39,
          height: 0.0142,
          fontName,
          fontSize: 11,
          confidence: 1,
        },
        {
          ...equation.lines[0].box,
          text: '\ufffd',
          x: 0.55,
          y: 0.37798,
          width: 0.012,
          height: 0.0142,
          fontName: 'Synthetic-CMEX99',
          fontSize: 11,
          confidence: 1,
        },
        {
          ...equation.lines[0].box,
          text: suffix,
          x: 0.57,
          y: 0.38948,
          width: 0.18,
          height: 0.0142,
          fontName,
          fontSize: 11,
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
            width: 32,
            height: 8,
            pixels: new Uint8Array(32 * 8 * 4).fill(72),
          }),
      )

      expect(isProbableDisplayEquation(equation)).toBe(false)
      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [equation],
        rasterizeFigure,
      })

      expect(rasterizeFigure).not.toHaveBeenCalled()
      expect(result.relationships).toEqual([])
      expect(result.consumedRegionIds.has(equation.id)).toBe(false)
    },
  )

  it('source-crops CMEX assembly pieces under a generic equation label', async () => {
    const equation = equationRegion(
      'assembled-cmex-equation',
      '⎛ x + y = z',
      box(0.25, 0.28, 0.24, 0.04),
    )
    equation.lines[0].runs[0].fontName = 'ABCDEF+CMEX10'
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 32,
          height: 12,
          pixels: new Uint8Array(32 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [equation],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const genericLabel = 'Display equation p001-001'
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        label: genericLabel,
        status: 'matched',
        sourceText: '',
        altText: genericLabel,
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-text-transcript-unresolved',
        ]),
      }),
    ])
  })

  it('checks reconstructed equation text before creating an equation object', async () => {
    const leakedProse = equationRegion(
      'equation-region-with-prose-line',
      'a = 361',
      box(0.2, 0.2, 0.6, 0.03),
    )
    leakedProse.lines[0].text =
      'a = 361 because 360 has more integer divisors, allowing'
    leakedProse.lines[0].runs[0].text = leakedProse.lines[0].text

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [leakedProse],
    })

    expect(result.relationships).toEqual([])
    expect(result.assets.some((asset) => asset.kind === 'equation')).toBe(false)
  })

  it('keeps a text-SVG display equation review-required without source glyph truth', async () => {
    const formula = equationRegion(
      'equation-region',
      'min E(s,a) − log π(a|s) = 0',
      box(0.24, 0.22, 0.5, 0.025),
    )
    const loweredPi = {
      ...equationRegion(
        'lowered-pi-region',
        'π',
        box(0.25, 0.242, 0.012, 0.01),
      ),
      kind: 'side' as const,
    }
    const falsePositive = equationRegion(
      'prose-region',
      'The model trained with aligned data (+RPA & CC) showed gains.',
      box(0.1, 0.32, 0.8, 0.025),
    )
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, loweredPi, falsePositive],
    })
    const repeated = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, loweredPi, falsePositive],
    })

    expect(result.relationships).toHaveLength(1)
    expect(repeated.relationships).toEqual(result.relationships)
    expect(repeated.assets).toEqual(result.assets)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      captionRegionId: formula.id,
      sourceRegionIds: [formula.id, loweredPi.id],
      sourceLineIds: [formula.lines[0].id, loweredPi.lines[0].id],
      sourceObjectIds: [],
      assetIds: [],
      sourceText: `${formula.text} π`,
      altText: `${formula.text} π`,
      altTextSource: 'source-text',
      evidence: expect.arrayContaining([
        'source-proved-atomic-equation-component',
        'readable-text-svg-approximation',
        'source-rendition-unavailable',
      ]),
      candidates: [
        expect.objectContaining({
          sourceRegionIds: [formula.id, loweredPi.id],
          sourceLineIds: [formula.lines[0].id, loweredPi.lines[0].id],
          sourceText: `${formula.text} π`,
        }),
      ],
    })
    expect(result.consumedRegionIds.has(formula.id)).toBe(false)
    expect(result.consumedRegionIds.has(loweredPi.id)).toBe(false)
    expect(result.relationships[0].evidence).not.toContain(
      'unresolved-visual-text-owned',
    )
    const asset = result.assets.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(asset).toMatchObject({
      kind: 'equation',
      mediaType: 'image/svg+xml',
      rendition: 'bounded-svg-fallback',
      sourceObjectIds: ['equation-source-p001-001'],
      sourceBoxes: [expect.objectContaining({ page: 1 })],
    })
    const svg = strFromU8(asset.bytes)
    expect(svg).toContain('min E(s,a) − log π(a|s) = 0')
    expect(svg).toContain('>π</text>')
    expect(svg).not.toMatch(/<math\b|mathml|latex/i)

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    )
    const cropped = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, loweredPi, falsePositive],
      rasterizeFigure,
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(cropped.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      captionRegionId: formula.id,
      sourceRegionIds: [formula.id, loweredPi.id],
      sourceObjectIds: ['equation-source-p001-001'],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(cropped.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rendition: 'source-page-crop' }),
      ]),
    )
  })

  it('source-preserves an equation when semantic ownership is incomplete', async () => {
    const formula = equationRegion(
      'incomplete-equation-scope',
      'x = y + 1',
      box(0.25, 0.24, 0.24, 0.025),
    )
    // The source line is uniquely owned, but its detached-math provenance is
    // malformed. Semantic scope must fail closed while the exact source box
    // remains safe to preserve.
    formula.lines[0].id = 'incomplete-equation-detached-math-1-host-ambiguous'
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(91),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      sourceRegionIds: [formula.id],
      sourceLineIds: [formula.lines[0].id],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining([
        'source-preserved-equation-fallback',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(formula.id)).toBe(false)
    expect(result.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'equation',
          rendition: 'source-page-crop',
        }),
      ]),
    )
  })

  it('does not publish styled script glyphs from a hardcoded serif text SVG', async () => {
    const formula = equationRegion(
      'equation-region',
      'E 1 = m c 2',
      box(0.4, 0.38, 0.11, 0.02),
    )
    formula.lines[0].runs = [
      {
        ...box(0.4, 0.38, 0.016, 0.019),
        method: 'pdf-text',
        text: 'E',
        fontName: 'EquationFont',
        fontSize: 15,
        confidence: 0.98,
      },
      {
        ...box(0.418, 0.394, 0.007, 0.01),
        method: 'pdf-text',
        text: '1',
        fontName: 'EquationFont',
        fontSize: 8,
        confidence: 0.98,
      },
      {
        ...box(0.434, 0.38, 0.061, 0.019),
        method: 'pdf-text',
        text: '= m c',
        fontName: 'EquationFont',
        fontSize: 15,
        confidence: 0.98,
      },
      {
        ...box(0.502, 0.377, 0.007, 0.01),
        method: 'pdf-text',
        text: '2',
        fontName: 'EquationFont',
        fontSize: 8,
        confidence: 0.98,
      },
    ]
    const printedNumber = {
      ...equationRegion('(1)-region', '(1)', box(0.82, 0.385, 0.022, 0.014)),
      kind: 'body' as const,
    }
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        captionRegion(
          'Equation 1. Source-backed display equation.',
          box(0.09, 0.32, 0.53, 0.02),
        ),
        formula,
        printedNumber,
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'unresolved',
      sourceRegionIds: [],
      sourceLineIds: [],
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({
          sourceRegionIds: [formula.id, printedNumber.id],
          sourceLineIds: [formula.lines[0].id, printedNumber.lines[0].id],
          sourceText: 'E1 = m c2 (1)',
          assetIds: [expect.stringMatching(/^asset-/)],
          evidence: expect.arrayContaining(['readable-text-svg-approximation']),
        }),
      ],
    })
    expect(result.consumedRegionIds.has(formula.id)).toBe(false)
    expect(result.consumedRegionIds.has(printedNumber.id)).toBe(false)
  })

  it('matches a styled equation only when a bounded source raster carries its glyphs', async () => {
    const imageBox = box(0.32, 0.37, 0.36, 0.07)
    const formula = equationRegion(
      'equation-text-region',
      'E1 = m c2 (1)',
      box(0.4, 0.38, 0.2, 0.025),
    )
    formula.lines[0].runs[0].fontName = 'Math-Italic'
    const equationAsset = await createPngAsset({
      sourceObjectId: 'image-p001-equation',
      sourceBox: imageBox,
      width: 12,
      height: 4,
      colorSpace: 'rgba',
      pixels: new Uint8Array(12 * 4 * 4).fill(96),
    })
    const rasterRegion = objectRegion(
      'equation-raster-region',
      'image-p001-equation',
      imageBox,
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'image-p001-equation',
              page: 1,
              kind: 'image',
              box: imageBox,
              confidence: 0.99,
              assetId: equationAsset.id,
            },
          ],
          1,
          [equationAsset],
        ),
      ],
      regions: [
        captionRegion(
          'Equation 1. A bounded source glyph raster.',
          box(0.2, 0.32, 0.5, 0.025),
        ),
        formula,
        rasterRegion,
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'matched',
      sourceRegionIds: [formula.id, rasterRegion.id],
      sourceObjectIds: ['image-p001-equation'],
      assetIds: [equationAsset.id],
      sourceText: formula.text,
      evidence: expect.arrayContaining([
        'source-glyph-raster',
        'accessible-source-text',
      ]),
    })
    expect(result.assets).toEqual([equationAsset])
    expect(result.consumedRegionIds).toEqual(
      new Set([formula.id, rasterRegion.id]),
    )
  })

  it('does not bind a nearby source-preserved logo to separate equation text', async () => {
    const logoBox = box(0.3, 0.22, 0.08, 0.04)
    const formula = equationRegion(
      'equation-text-region',
      'q = r',
      box(0.42, 0.3, 0.18, 0.025),
    )
    const logo = await createPngAsset({
      sourceObjectId: 'image-p001-logo',
      sourceBox: logoBox,
      width: 4,
      height: 4,
      colorSpace: 'rgba',
      pixels: new Uint8Array(4 * 4 * 4).fill(96),
    })

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'image-p001-logo',
              page: 1,
              kind: 'image',
              box: logoBox,
              confidence: 0.99,
              assetId: logo.id,
            },
          ],
          1,
          [logo],
        ),
      ],
      regions: [
        captionRegion(
          'Equation 1. A source-backed display equation.',
          box(0.2, 0.18, 0.5, 0.02),
        ),
        objectRegion('logo-region', 'image-p001-logo', logoBox),
        formula,
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(result.relationships[0].candidates[0]).toMatchObject({
      sourceRegionIds: [formula.id],
      sourceObjectIds: ['equation-p001-001'],
      evidence: expect.arrayContaining(['readable-text-svg-approximation']),
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [logoBox],
        }),
      ]),
    )
  })

  it('does not promote prose cross-references into visual captions', async () => {
    const crossReference = {
      ...captionRegion('Table 16 shows the comparison in the appendix.'),
      kind: 'body' as const,
    }
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [crossReference],
    })

    expect(result.relationships).toEqual([])
    expect(result.assets).toEqual([])
  })

  it('restores a proved visual caption to canonical reading order', async () => {
    const caption = {
      ...captionRegion('Figure 1. A complete source visual.'),
      includedInReadingOrder: false,
    }

    await reconstructPdfVisuals({
      pages: [page([])],
      regions: [caption],
    })

    expect(caption).toMatchObject({
      kind: 'caption',
      includedInReadingOrder: true,
    })
  })

  it('rejects prose beneath a table caption instead of synthesizing a table', async () => {
    const prose = {
      ...captionRegion(
        'The results remain statistically significant.',
        box(0.2, 0.38, 0.5, 0.04),
      ),
      id: 'prose-region',
      kind: 'body' as const,
      lines: [
        {
          id: 'prose-line',
          text: 'The results remain statistically significant.',
          fontSize: 10,
          box: { ...box(0.2, 0.38, 0.5, 0.04), method: 'pdf-text' as const },
          runs: [],
        },
      ],
    }
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [captionRegion('Table 5. Comparison results.'), prose],
    })

    expect(result.relationships[0]).toMatchObject({
      label: 'Table 5',
      status: 'unresolved',
      assetIds: [],
    })
    expect(result.assets).toEqual([])
  })

  it('does not claim a match when the source object has no safe rendition', async () => {
    const sourceBox = box(0.3, 0.2)
    const result = await reconstructPdfVisuals({
      pages: [
        page([
          {
            id: 'image-p001-001',
            page: 1,
            kind: 'image',
            box: sourceBox,
            confidence: 0.98,
            assetId: null,
          },
        ]),
      ],
      regions: [
        objectRegion('object-region', 'image-p001-001', sourceBox),
        captionRegion('Figure 1. Source object without a safe payload.'),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      assetIds: [],
      sourceObjectIds: [],
      candidates: [expect.objectContaining({ assetIds: [] })],
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
        }),
      ]),
    )
  })

  it('does not match a dangling asset id that is absent from the asset store', async () => {
    const sourceBox = box(0.3, 0.2)
    const result = await reconstructPdfVisuals({
      pages: [
        page([
          {
            id: 'image-p001-dangling',
            page: 1,
            kind: 'image',
            box: sourceBox,
            confidence: 0.98,
            assetId: 'asset-not-in-store',
          },
        ]),
      ],
      regions: [
        objectRegion('object-region', 'image-p001-dangling', sourceBox),
        captionRegion('Figure 1. Dangling source asset.'),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(result.relationships[0].candidates[0]).toMatchObject({
      sourceObjectIds: ['image-p001-dangling'],
      assetIds: ['asset-not-in-store'],
    })
  })

  it('keeps an exact native image when conservative grouping emits no figure region', async () => {
    const sourceObjectId = 'image-p001-parent'
    const sourceBox = box(0.3, 0.1, 0.4, 0.15)
    const sourceAsset = sourcePreservedSvgAsset(sourceObjectId, sourceBox)
    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAsset.id,
            },
          ],
          1,
          [sourceAsset],
        ),
      ],
      // No native object region is supplied: this models a conservative
      // region classifier filtering a complete source image as furniture.
      regions: [captionRegion('Figure 1. A source-backed map.')],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [sourceObjectId],
      assetIds: [sourceAsset.id],
      evidence: expect.arrayContaining([
        'source-preserved-figure-fallback',
        'native-object-direct-rendition',
      ]),
    })
  })

  it('keeps a losing matched-relationship candidate as an unreferenced source obligation', async () => {
    const selectedBox = box(0.2, 0.44, 0.6, 0.16)
    const losingBox = box(0.2, 0.25, 0.6, 0.12)
    const objects = [
      {
        id: 'vector-p001-near-caption',
        page: 1,
        kind: 'vector' as const,
        box: selectedBox,
        confidence: 1,
        assetId: 'asset-vector-p001-near-caption',
        role: 'semantic' as const,
      },
      {
        id: 'vector-p001-losing-real-vector',
        page: 1,
        kind: 'vector' as const,
        box: losingBox,
        confidence: 1,
        assetId: 'asset-vector-p001-losing-real-vector',
        role: 'semantic' as const,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [
        page(objects, 1, [
          sourcePreservedSvgAsset(objects[0].id, selectedBox),
          sourcePreservedSvgAsset(objects[1].id, losingBox),
        ]),
      ],
      regions: [
        objectRegion('near-caption-region', objects[0].id, selectedBox),
        objectRegion('losing-image-region', objects[1].id, losingBox),
        captionRegion(
          'Figure 1. The nearest complete source image is selected.',
          box(0.08, 0.65, 0.84, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[0].id],
    })
    expect(
      result.relationships[0].candidates.some((candidate) =>
        candidate.sourceObjectIds.includes(objects[1].id),
      ),
    ).toBe(true)
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(objects[1].id),
      ),
    ).toBe(true)
  })

  it.each([
    {
      name: 'empty payload',
      asset: (sourceBox: NormalizedSourceBox) =>
        ({
          id: 'asset-empty',
          href: 'assets/asset-empty.png',
          mediaType: 'image/png',
          kind: 'raster',
          rendition: 'source-preserved',
          sha256: '0'.repeat(64),
          bytes: new Uint8Array(),
          width: 1,
          height: 1,
          resolutionDpi: null,
          sourceObjectIds: ['image-p001-invalid'],
          sourceBoxes: [sourceBox],
        }) satisfies PdfVisualAsset,
    },
    {
      name: 'foreign lineage',
      asset: (sourceBox: NormalizedSourceBox) =>
        ({
          id: 'asset-foreign-lineage',
          href: 'assets/asset-foreign-lineage.png',
          mediaType: 'image/png',
          kind: 'raster',
          rendition: 'source-preserved',
          sha256: '1'.repeat(64),
          bytes: new Uint8Array([1, 2, 3]),
          width: 1,
          height: 1,
          resolutionDpi: null,
          sourceObjectIds: ['image-p001-other'],
          sourceBoxes: [sourceBox],
        }) satisfies PdfVisualAsset,
    },
  ])('does not match a stored asset with $name', async ({ asset }) => {
    const sourceBox = box(0.3, 0.2)
    const visualAsset = asset(sourceBox)
    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'image-p001-invalid',
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 0.98,
              assetId: visualAsset.id,
            },
          ],
          1,
          [visualAsset],
        ),
      ],
      regions: [
        objectRegion('object-region', 'image-p001-invalid', sourceBox),
        captionRegion('Figure 1. Invalid source asset.'),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
  })

  it('requires every bounded text overlay in a vector figure to reach the raster lineage', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.18)
    const labelBox = {
      ...box(0.34, 0.23, 0.12, 0.025),
      method: 'pdf-text' as const,
    }
    const vector = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-colored',
      sourceBox,
      path: 'M 0 0 L 40 0 L 20 30 Z',
      viewBox: { x: 0, y: 0, width: 40, height: 30 },
      paint: 'fill-stroke',
    })
    const textOverlay = textRegion(
      'chart-label-region',
      'State B',
      labelBox,
      'chart-label',
    )
    const outsideOverlay = textRegion(
      'outside-prose-region',
      'Paragraph prose overlaps the diagram edge.',
      box(0.17, 0.25, 0.03, 0.025),
    )
    const largeOverlay = textRegion(
      'large-prose-region',
      'A large non-flow label inside a loose object boundary stays separate.',
      box(0.25, 0.2, 0.4, 0.12),
      'side',
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
    })

    expect(vector.rendition).toBe('bounded-svg-fallback')
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({
          sourceObjectIds: [
            'vector-p001-colored',
            'text-overlay:chart-label-region',
          ],
          sourceBoxes: expect.arrayContaining([sourceBox, labelBox]),
        }),
      ],
    })
    expect(result.consumedRegionIds.has(textOverlay.id)).toBe(false)
    expect(result.consumedRegionIds.has(outsideOverlay.id)).toBe(false)
    expect(result.consumedRegionIds.has(largeOverlay.id)).toBe(false)

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )
    const cropped = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })
    expect(cropped.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-colored',
        'text-overlay:chart-label-region',
      ],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(cropped.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rendition: 'source-page-crop',
          sourceObjectIds: [
            'vector-p001-colored',
            'text-overlay:chart-label-region',
          ],
        }),
      ]),
    )
    expect(cropped.consumedRegionIds.has(textOverlay.id)).toBe(true)
    expect(cropped.consumedRegionIds.has(outsideOverlay.id)).toBe(false)
    expect(cropped.consumedRegionIds.has(largeOverlay.id)).toBe(false)

    const missingOverlayLineage = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: [input.sourceObjectIds[0]],
          sourceBoxes: [input.sourceBoxes[0]],
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    })
    expect(missingOverlayLineage.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(missingOverlayLineage.consumedRegionIds.has(textOverlay.id)).toBe(
      false,
    )

    const blankCrop = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure: async (input) => {
        const blank = await createCompositePngAsset({
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(255),
        })
        return {
          ...blank,
          rendition: 'source-page-crop' as const,
          sourceCropBox: input.sourceBox,
        }
      },
    })
    expect(blankCrop.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(blankCrop.consumedRegionIds.has(textOverlay.id)).toBe(false)
  })

  it('never promotes reading-order text into figure overlay lineage', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-reading-order-label',
      sourceBox,
    )
    const orderedLabel = {
      ...textRegion(
        'ordered-chart-label-region',
        'Ordered label',
        box(0.24, 0.22, 0.16, 0.025),
        'chart-label',
      ),
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-reading-order-label',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion(
          'reading-order-vector-region',
          'vector-p001-reading-order-label',
          sourceBox,
        ),
        orderedLabel,
        captionRegion(
          'Figure 1. Diagram with an ordered text fragment.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-reading-order-label'],
      assetIds: [vector.id],
    })
    expect(result.relationships[0].candidates[0].sourceObjectIds).toEqual([
      'vector-p001-reading-order-label',
    ])
    expect(result.consumedRegionIds.has(orderedLabel.id)).toBe(false)
  })

  it('groups a source-verified display equation wider than sixty percent', async () => {
    const right = equationRegion(
      'equation-wide-right',
      'S(x + z) − S(x) = q',
      box(0.485, 0.31, 0.312, 0.018),
    )
    const middle = equationRegion(
      'equation-wide-middle',
      'a + b =',
      box(0.31, 0.311, 0.143, 0.02),
    )
    const left = equationRegion(
      'equation-wide-left',
      'μ(t, x) = −',
      box(0.195, 0.33, 0.107, 0.014),
    )
    const printedNumber = textRegion(
      'equation-wide-number',
      '(3)',
      box(0.854, 0.33, 0.025, 0.014),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 18,
          pixels: new Uint8Array(96 * 18 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [right, middle, left, printedNumber],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 3',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        left.id,
        middle.id,
        right.id,
        printedNumber.id,
      ]),
    })
  })

  it('owns a complete cross-column equation scope instead of leaking its tail as prose', async () => {
    const opening: PdfPageRegion = equationRegion(
      'equation-two-opening',
      '∫ (',
      box(0.4861, 0.21707, 0.03031, 0.01777),
    )
    opening.column = 'span'
    opening.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const left: PdfPageRegion = equationRegion(
      'equation-two-left',
      '0 = S′(x) μ(t, x) + 1 S′′(x) σb²(t, x) +',
      box(0.1382, 0.22679, 0.33786, 0.02732),
    )
    left.column = 'left'
    const right: PdfPageRegion = equationRegion(
      'equation-two-right',
      'S(x + z) − S(x) − S′(x) χ(z) νt(dz), (2)',
      box(0.51641, 0.23527, 0.36264, 0.01746),
    )
    right.column = 'right'
    const closing = textRegion(
      'equation-two-closing',
      ')',
      box(0.76464, 0.22064, 0.01199, 0.0142),
    )
    closing.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const coefficient = textRegion(
      'equation-two-coefficient',
      '2',
      box(0.32501, 0.24614, 0.00983, 0.0142),
    )
    coefficient.lines[0].runs[0].fontName = 'Synthetic-CMR12'
    const domain = textRegion(
      'equation-two-domain',
      'R',
      box(0.49725, 0.25395, 0.00967, 0.00947),
    )
    domain.lines[0].runs[0].fontName = 'Synthetic-MSBM10'
    const followingProse = textRegion(
      'equation-two-following-prose',
      'and thus the drift is pinned down by',
      box(0.12095, 0.27447, 0.3165, 0.0142),
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

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        opening,
        closing,
        left,
        right,
        coefficient,
        domain,
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const fragment of [
      opening,
      closing,
      left,
      right,
      coefficient,
      domain,
    ]) {
      expect(
        containsSourceBox(crop, fragment.box),
        `crop should contain ${fragment.id}; sources=${result.relationships[0]?.sourceRegionIds.join(',')}`,
      ).toBe(true)
    }
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 2',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        opening.id,
        closing.id,
        left.id,
        right.id,
        coefficient.id,
        domain.id,
      ]),
      sourceText: '',
      altText: 'Equation 2',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    for (const fragment of [closing, right, coefficient, domain]) {
      expect(
        result.consumedRegionIds.has(fragment.id),
        `${fragment.id} should not survive as canonical prose`,
      ).toBe(true)
    }
    expect(result.relationships[0].captionRegionId).toBe(opening.id)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('captures a source-bounded algorithm panel as one exact visual owner instead of flattening its numbered lines into prose', async () => {
    const algorithmCaption = {
      ...textRegion(
        'algorithm-caption',
        'Algorithm 1 Inference Pipeline',
        box(0.52, 0.25, 0.34, 0.02),
      ),
      column: 'right' as const,
    }
    const algorithmRegions = [
      {
        ...textRegion(
          'algorithm-require',
          'Require: model M and input I',
          box(0.52, 0.28, 0.35, 0.02),
        ),
        column: 'right' as const,
      },
      {
        ...textRegion(
          'algorithm-line-1',
          '1: Initialize state.',
          box(0.53, 0.31, 0.25, 0.018),
        ),
        column: 'right' as const,
      },
      {
        ...textRegion(
          'algorithm-line-2',
          '2: for item in input do',
          box(0.53, 0.335, 0.28, 0.018),
        ),
        column: 'right' as const,
      },
      {
        ...textRegion(
          'algorithm-line-3',
          '3: Update state.',
          box(0.55, 0.36, 0.22, 0.018),
        ),
        column: 'right' as const,
      },
      {
        ...textRegion(
          'algorithm-line-4',
          '4: return state.',
          box(0.53, 0.385, 0.2, 0.018),
        ),
        column: 'right' as const,
      },
    ]
    const followingProse = {
      ...textRegion(
        'following-prose',
        'The algorithm is then evaluated on held-out data.',
        box(0.52, 0.45, 0.35, 0.05),
      ),
      column: 'right' as const,
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 48,
          pixels: new Uint8Array(80 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      // Deliberately scramble extraction order. Ownership must come from the
      // proved panel geometry and contiguous source line markers.
      regions: [
        algorithmRegions[3],
        followingProse,
        algorithmCaption,
        algorithmRegions[1],
        algorithmRegions[0],
        algorithmRegions[4],
        algorithmRegions[2],
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0]).toMatchObject({
      kind: 'figure',
      page: 1,
      sourceObjectIds: ['code-source-p001-001-001'],
    })
    expect(
      containsSourceBox(
        rasterizeFigure.mock.calls[0][0].sourceBox,
        algorithmRegions[4].box,
      ),
    ).toBe(true)
    expect(
      rasterizeFigure.mock.calls[0][0].sourceBox.y +
        rasterizeFigure.mock.calls[0][0].sourceBox.height,
    ).toBeGreaterThanOrEqual(
      algorithmRegions[4].box.y + algorithmRegions[4].box.height + 0.009,
    )
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        semanticKind: 'algorithm',
        label: 'Algorithm 1',
        captionRegionId: algorithmCaption.id,
        sourceRegionIds: algorithmRegions.map((region) => region.id),
        sourceLineIds: algorithmRegions.flatMap((region) =>
          region.lines.map((line) => line.id),
        ),
        sourceText: algorithmRegions.map((region) => region.text).join('\n'),
        status: 'matched',
        preformatted: expect.objectContaining({ status: 'proved' }),
        evidence: expect.arrayContaining([
          'source-preformatted-block',
          'source-indentation-and-ragged-measure',
          'source-page-crop',
          'source-line-breaks-preserved',
        ]),
      }),
    ])
    expect(algorithmCaption.kind).toBe('caption')
    expect(
      algorithmRegions.every((region) =>
        result.consumedRegionIds.has(region.id),
      ),
    ).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
    expect(result.diagnostics).toEqual([])
  })

  it('captures a fully numbered algorithm whose input and terminal control line carry markers', async () => {
    const algorithmCaption = {
      ...textRegion(
        'numbered-algorithm-caption',
        'Algorithm 3 Ranked Reweighting',
        box(0.12, 0.12, 0.7, 0.02),
      ),
      column: 'left' as const,
    }
    const texts = Array.from({ length: 33 }, (_, index) => {
      const marker = index + 1
      if (marker === 1) return '1: Input: ranked candidates'
      if (marker === 2) return '2: while candidates remain do'
      if (marker === 12) return '12: end if'
      if (marker === 22) return '22: weights ← 2−ranks'
      if (marker === 33) return '33: end while'
      return `${marker}: update candidate state`
    })
    const algorithmRegions = texts.map((text, index) => ({
      ...textRegion(
        `numbered-algorithm-line-${index + 1}`,
        text,
        box(0.13, 0.15 + index * 0.012, 0.6, 0.01),
      ),
      column: 'left' as const,
    }))
    const followingProse = {
      ...textRegion(
        'numbered-algorithm-following-prose',
        'The resulting weights are evaluated separately.',
        box(0.12, 0.58, 0.7, 0.04),
      ),
      column: 'left' as const,
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 160,
          pixels: new Uint8Array(80 * 160 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        followingProse,
        ...algorithmRegions.toReversed(),
        algorithmCaption,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        semanticKind: 'algorithm',
        label: 'Algorithm 3',
        status: 'matched',
        sourceRegionIds: algorithmRegions.map((region) => region.id),
        sourceLineIds: algorithmRegions.flatMap((region) =>
          region.lines.map((line) => line.id),
        ),
      }),
    ])
    expect(
      algorithmRegions.every((region) =>
        result.consumedRegionIds.has(region.id),
      ),
    ).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('fails a proved algorithm block closed while preserving its numbered lines when the exact crop is unavailable', async () => {
    const algorithmCaption = {
      ...textRegion(
        'unrendered-algorithm-caption',
        'Algorithm 2: Deterministic Search',
        box(0.12, 0.2, 0.36, 0.02),
      ),
      column: 'left' as const,
    }
    const algorithmRegions = [
      {
        ...textRegion(
          'unrendered-algorithm-require',
          'Require: graph G',
          box(0.12, 0.23, 0.34, 0.018),
        ),
        column: 'left' as const,
      },
      {
        ...textRegion(
          'unrendered-algorithm-lines',
          '1: Initialize queue. 2: Visit node. 3: return result.',
          box(0.13, 0.255, 0.33, 0.07),
        ),
        column: 'left' as const,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [algorithmCaption, ...algorithmRegions],
      rasterizeFigure: async () => null,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        semanticKind: 'algorithm',
        status: 'unresolved',
        sourceRegionIds: algorithmRegions.map((region) => region.id),
        sourceText: algorithmRegions.map((region) => region.text).join('\n'),
        evidence: expect.arrayContaining([
          'unresolved-visual-text-owned',
          'source-rendition-unavailable',
        ]),
      }),
    ])
    expect(
      algorithmRegions.every(
        (region) => !result.consumedRegionIds.has(region.id),
      ),
    ).toBe(true)
    expect(
      algorithmRegions.every((region) =>
        region.lines.every((line) => !result.consumedLineIds.has(line.id)),
      ),
    ).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_ALGORITHM_BLOCK',
          severity: 'error',
        }),
      ]),
    )
  })

  it('does not promote an ordinary prose reference to Algorithm 1 without a bounded numbered panel', async () => {
    const prose = textRegion(
      'algorithm-prose-reference',
      'Algorithm 1 improves generation quality on this benchmark.',
      box(0.12, 0.2, 0.36, 0.04),
    )
    const following = textRegion(
      'algorithm-prose-following',
      'The detailed process is discussed in the appendix.',
      box(0.12, 0.25, 0.36, 0.04),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [prose, following],
    })

    expect(result.relationships).toEqual([])
    expect(prose.kind).toBe('body')
    expect(result.consumedRegionIds.size).toBe(0)
    expect(result.diagnostics).toEqual([])
  })
})
