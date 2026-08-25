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

  it('reclaims reading-order labels only when coextensive native layers prove a caption-bounded figure', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.32)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.318)
    const firstLayer = sourcePreservedSvgAsset(
      'vector-p001-caption-scaffold-001',
      firstLayerBox,
    )
    const secondLayer = sourcePreservedSvgAsset(
      'vector-p001-caption-scaffold-002',
      secondLayerBox,
    )
    const internalLabels = textRegion(
      'ordered-internal-diagram-labels',
      'Input profile   Dialogue response   Aligned output',
      box(0.2, 0.18, 0.5, 0.035),
    )
    const internalOutcomes = textRegion(
      'ordered-internal-diagram-outcomes',
      'Local evidence   Owner checks   Final graph',
      box(0.2, 0.3, 0.5, 0.035),
    )
    const followingProse = textRegion(
      'following-prose-region',
      'Canonical prose after the figure remains in reading order.',
      box(0.12, 0.5, 0.76, 0.03),
    )
    const objects = [
      {
        id: 'vector-p001-caption-scaffold-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: firstLayer.id,
      },
      {
        id: 'vector-p001-caption-scaffold-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: secondLayer.id,
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 20,
          height: 10,
          pixels: new Uint8Array(20 * 10 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [firstLayer, secondLayer])],
      regions: [
        objectRegion(
          'caption-scaffold-region-001',
          objects[0].id,
          firstLayerBox,
        ),
        objectRegion(
          'caption-scaffold-region-002',
          objects[1].id,
          secondLayerBox,
        ),
        internalLabels,
        internalOutcomes,
        captionRegion(
          'Figure 1. A source-native layered framework diagram.',
          box(0.12, 0.44, 0.76, 0.025),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-caption-scaffold-001',
        'vector-p001-caption-scaffold-002',
        'text-overlay:ordered-internal-diagram-labels',
        'text-overlay:ordered-internal-diagram-outcomes',
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(internalLabels.id)).toBe(true)
    expect(result.consumedRegionIds.has(internalOutcomes.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('expands a proven layered panel to its caption lane before owning wide internal text', async () => {
    const firstLayerBox = box(0.2, 0.1, 0.25, 0.3)
    const secondLayerBox = box(0.201, 0.101, 0.248, 0.298)
    const objects = [
      {
        id: 'vector-p001-narrow-panel-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-narrow-panel-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const panelTitle = textRegion(
      'ordered-wide-panel-title',
      'Five stages writing theory',
      box(0.32, 0.14, 0.35, 0.025),
    )
    const panelText = textRegion(
      'ordered-wide-panel-text',
      'The complete panel explanation extends beyond the narrow native bounds.',
      box(0.14, 0.2, 0.7, 0.05),
    )
    const followingProse = textRegion(
      'wide-panel-following-prose',
      'Following article prose remains outside the figure.',
      box(0.12, 0.5, 0.76, 0.03),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('narrow-panel-region-001', objects[0].id, firstLayerBox),
        objectRegion('narrow-panel-region-002', objects[1].id, secondLayerBox),
        panelTitle,
        panelText,
        captionRegion(
          'Figure 1. A wide textual panel with narrow native bounds.',
          box(0.18, 0.42, 0.62, 0.025),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([panelTitle.id, panelText.id]),
    })
    expect(result.consumedRegionIds.has(panelTitle.id)).toBe(true)
    expect(result.consumedRegionIds.has(panelText.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('owns a large text block inside a proven layered prompt panel', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.32)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.318)
    const objects = [
      {
        id: 'vector-p001-large-prompt-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-large-prompt-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const promptHeading = textRegion(
      'ordered-large-prompt-heading',
      'Output',
      box(0.16, 0.14, 0.12, 0.025),
    )
    const promptBody = textRegion(
      'ordered-large-prompt-body',
      'A long source prompt occupies most of this boxed panel and must remain owned by its figure rather than leaking into article prose.',
      box(0.15, 0.18, 0.7, 0.2),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('large-prompt-region-001', objects[0].id, firstLayerBox),
        objectRegion('large-prompt-region-002', objects[1].id, secondLayerBox),
        promptHeading,
        promptBody,
        captionRegion(
          'Figure 1. A complete source prompt.',
          box(0.12, 0.44, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        promptHeading.id,
        promptBody.id,
      ]),
    })
    expect(result.consumedRegionIds.has(promptHeading.id)).toBe(true)
    expect(result.consumedRegionIds.has(promptBody.id)).toBe(true)
  })

  it('owns an arithmetic example inside a proven caption-bounded prompt panel', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.3)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.298)
    const firstLayer = sourcePreservedSvgAsset(
      'vector-p001-prompt-panel-001',
      firstLayerBox,
    )
    const secondLayer = sourcePreservedSvgAsset(
      'vector-p001-prompt-panel-002',
      secondLayerBox,
    )
    const promptHeading = textRegion(
      'ordered-prompt-heading',
      'Scoring example',
      box(0.2, 0.16, 0.22, 0.025),
    )
    const promptInstruction = textRegion(
      'ordered-prompt-instruction',
      'Count each accepted item in the bounded panel.',
      box(0.2, 0.21, 0.46, 0.025),
    )
    const arithmeticExample = textRegion(
      'ordered-arithmetic-example',
      '1 + 1 + 0 = 2',
      box(0.24, 0.27, 0.18, 0.025),
      'equation',
    )
    const objects = [
      {
        id: 'vector-p001-prompt-panel-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: firstLayer.id,
      },
      {
        id: 'vector-p001-prompt-panel-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: secondLayer.id,
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: input.kind === 'equation' ? 'equation' : 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [firstLayer, secondLayer])],
      regions: [
        objectRegion('prompt-panel-region-001', objects[0].id, firstLayerBox),
        objectRegion('prompt-panel-region-002', objects[1].id, secondLayerBox),
        promptHeading,
        promptInstruction,
        arithmeticExample,
        captionRegion(
          'Figure 11. A bounded scoring prompt and its worked example.',
          box(0.12, 0.42, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'figure',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        promptHeading.id,
        promptInstruction.id,
        arithmeticExample.id,
      ]),
      sourceObjectIds: expect.arrayContaining([
        `text-overlay:${arithmeticExample.id}`,
      ]),
    })
    expect(result.consumedRegionIds.has(arithmeticExample.id)).toBe(true)
  })

  it('keeps a numbered section heading out of caption-bounded visual ownership', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.3)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.298)
    const objects = [
      {
        id: 'vector-p001-chart-panel-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-chart-panel-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const chartLabel = textRegion(
      'bounded-chart-label',
      'Evil projection',
      box(0.25, 0.18, 0.16, 0.012),
      'chart-label',
    )
    const sectionHeading = textRegion(
      'following-section-heading',
      '6.2 SAMPLE-LEVEL DETECTION OF PROBLEMATIC DATA',
      box(0.12, 0.35, 0.5, 0.01),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('chart-panel-region-001', objects[0].id, firstLayerBox),
        objectRegion('chart-panel-region-002', objects[1].id, secondLayerBox),
        chartLabel,
        sectionHeading,
        captionRegion(
          'Figure 9. A caption-bounded chart above the next section.',
          box(0.12, 0.42, 0.76, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'figure',
      status: 'unresolved',
      candidates: [
        expect.objectContaining({
          sourceRegionIds: expect.arrayContaining([chartLabel.id]),
        }),
      ],
    })
    expect(result.relationships[0].candidates[0].sourceRegionIds).not.toContain(
      sectionHeading.id,
    )
    expect(result.consumedRegionIds.has(sectionHeading.id)).toBe(false)
  })

  it('reclaims chart text when one bounded scaffold contains four native layers', async () => {
    const scaffold = box(0.5, 0.08, 0.38, 0.14)
    const fragments = [
      box(0.57, 0.11, 0.27, 0.06),
      box(0.58, 0.115, 0.25, 0.012),
      box(0.58, 0.115, 0.25, 0.05),
      box(0.67, 0.13, 0.17, 0.025),
    ]
    const objects = [scaffold, ...fragments].map((sourceBox, index) => ({
      id: `vector-p001-contained-layer-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const title = textRegion(
      'ordered-chart-title',
      'Performance by threshold',
      box(0.61, 0.09, 0.2, 0.012),
    )
    const ticks = textRegion(
      'ordered-chart-ticks',
      '0 25 50 75 100',
      box(0.57, 0.18, 0.29, 0.012),
    )
    const axis = textRegion(
      'ordered-chart-axis',
      'Answer threshold',
      box(0.66, 0.2, 0.1, 0.01),
    )
    const followingProse = textRegion(
      'prose-after-contained-chart',
      'Canonical prose after the chart remains independent.',
      box(0.5, 0.34, 0.38, 0.025),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `contained-layer-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        title,
        ticks,
        axis,
        captionRegion(
          'Figure 1. A source-native chart with extracted labels.',
          box(0.5, 0.24, 0.38, 0.04),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        `text-overlay:${title.id}`,
        `text-overlay:${ticks.id}`,
        `text-overlay:${axis.id}`,
      ]),
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(title.id)).toBe(true)
    expect(result.consumedRegionIds.has(ticks.id)).toBe(true)
    expect(result.consumedRegionIds.has(axis.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('reclaims one short legend line when a dense caption-bounded chart proves its ownership', async () => {
    const scaffoldBox = box(0.12, 0.1, 0.34, 0.12)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.16 + (index % 4) * 0.07,
        0.12 + Math.floor(index / 4) * 0.055,
        0.035,
        0.025,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-chart-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffoldBox,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-chart-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const legend = textRegion(
      'ordered-single-line-chart-legend',
      'helix(a+b)',
      box(0.36, 0.135, 0.07, 0.012),
    )
    const seriesLabel = textRegion(
      'non-flow-chart-series-label',
      'DE',
      box(0.36, 0.16, 0.02, 0.01),
      'chart-label',
    )
    const followingProse = textRegion(
      'prose-after-chart-caption',
      'Canonical prose after the chart remains in reading order.',
      box(0.12, 0.31, 0.34, 0.025),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `chart-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        legend,
        seriesLabel,
        captionRegion(
          'Figure 7. Two source-native chart series.',
          box(0.12, 0.24, 0.34, 0.04),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        'text-overlay:ordered-single-line-chart-legend',
        'text-overlay:non-flow-chart-series-label',
      ]),
      evidence: expect.arrayContaining([
        'single-line-chart-overlay-source-owned',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-native-envelope-incomplete',
    )
    expect(result.consumedRegionIds.has(legend.id)).toBe(true)
    expect(result.consumedRegionIds.has(seriesLabel.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('forms the caption-bounded float envelope before trimming a prose-overlapping scaffold', async () => {
    const scaffold = box(0.1, 0.08, 0.8, 0.4)
    const fragmentBoxes = Array.from({ length: 4 }, (_, index) =>
      box(0.22 + index * 0.15, 0.24, 0.08, 0.1),
    )
    const objects = [
      {
        id: 'vector-p001-float-envelope-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-float-envelope-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const instructions = textRegion(
      'ordered-multiline-figure-instructions',
      'Step 1: translate arrows. Step 2: read the result.',
      box(0.22, 0.12, 0.56, 0.05),
    )
    instructions.lines = [
      {
        ...instructions.lines[0],
        id: 'ordered-multiline-figure-instructions-line-1',
        text: 'Step 1: translate arrows.',
        box: { ...instructions.lines[0].box, height: 0.02 },
      },
      {
        ...instructions.lines[0],
        id: 'ordered-multiline-figure-instructions-line-2',
        text: 'Step 2: read the result.',
        box: { ...instructions.lines[0].box, y: 0.145, height: 0.02 },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`float-envelope-region-${index}`, object.id, object.box),
        ),
        textRegion(
          'prose-crossing-scaffold',
          'Author names and affiliation remain prose.',
          box(0.02, 0.085, 0.52, 0.025),
        ),
        instructions,
        captionRegion(
          'Figure 1. Complete instructions and diagram.',
          box(0.16, 0.5, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0]![0].sourceBox.y).toBeLessThan(0.12)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...objects.slice(1).map((object) => object.id),
        'text-overlay:ordered-multiline-figure-instructions',
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-scaffold-trimmed-reading-order-overlap',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(instructions.id)).toBe(true)
  })

  it('fails closed when prose trimming would omit native material inside the float envelope', async () => {
    const scaffold = box(0.1, 0.1, 0.8, 0.38)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.22 + (index % 4) * 0.14,
        0.22 + Math.floor(index / 4) * 0.12,
        0.08,
        0.08,
      ),
    )
    const omittedGlyph = box(0.31, 0.27, 0.025, 0.025)
    const objects = [
      {
        id: 'vector-p001-incomplete-envelope-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-incomplete-envelope-glyph',
        page: 1,
        kind: 'vector' as const,
        box: omittedGlyph,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-incomplete-envelope-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 12,
          pixels: new Uint8Array(24 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `incomplete-envelope-region-${index}`,
            object.id,
            object.box,
          ),
        ),
        textRegion(
          'canonical-prose-crossing-native-glyph',
          'Canonical prose crossing one source glyph remains in reading order.',
          box(0.02, 0.26, 0.32, 0.045),
        ),
        captionRegion(
          'Figure 1. Native material must not disappear during trimming.',
          box(0.16, 0.5, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'source-native-envelope-incomplete',
        'source-rendition-unavailable',
      ]),
    })
  })

  it('groups adjacent aligned display lines and their printed equation number into one crop', async () => {
    const first = equationRegion(
      'aligned-equation-line-1',
      'h_i^l = h_i^(l-1) + a_i^l + m_i^l',
      box(0.2, 0.2, 0.5, 0.025),
    )
    const second = equationRegion(
      'aligned-equation-line-2',
      'a_i^l = Attention(h_i^(l-1))',
      box(0.24, 0.235, 0.42, 0.025),
    )
    const third = equationRegion(
      'aligned-equation-line-3',
      'm_i^l = MLP(a_i^l + h_i^(l-1))',
      box(0.22, 0.27, 0.46, 0.025),
    )
    const printedNumber = {
      ...textRegion(
        'aligned-equation-number',
        '(1)',
        box(0.82, 0.235, 0.03, 0.02),
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
          width: 30,
          height: 12,
          pixels: new Uint8Array(30 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, second, third, printedNumber],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0]![0].sourceBox).toEqual(
      expect.objectContaining({
        y: expect.any(Number),
        height: expect.any(Number),
      }),
    )
    expect(
      rasterizeFigure.mock.calls[0]![0].sourceBox.y +
        rasterizeFigure.mock.calls[0]![0].sourceBox.height,
    ).toBeGreaterThan(third.box.y + third.box.height)
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'matched',
      sourceRegionIds: [first.id, second.id, printedNumber.id, third.id],
      sourceText: expect.stringContaining('Attention'),
    })

    const unresolved = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, second, third, printedNumber],
    })
    expect(unresolved.relationships).toHaveLength(1)
    expect(unresolved.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'unresolved',
    })
  })

  it.each([
    { printedLabel: '(1.22)', equationLabel: 'Equation 1.22' },
    { printedLabel: '(2.3.1b)', equationLabel: 'Equation 2.3.1b' },
  ])(
    'groups an argmin display with its detached sum, loss, subscript, and printed number $printedLabel',
    async ({ printedLabel, equationLabel }) => {
      const proseBox = {
        ...box(0.169, 0.845, 0.526, 0.013),
        method: 'pdf-text' as const,
      }
      const sumBox = {
        ...box(0.492, 0.865, 0.024, 0.012),
        method: 'pdf-text' as const,
      }
      const proseAndSum: PdfPageRegion = {
        ...textRegion(
          'argmin-prose-and-sum',
          'Then fine-tune the model by ∑',
          box(0.169, 0.845, 0.526, 0.032),
        ),
        lines: [
          {
            id: 'argmin-prose-line',
            text: 'Then fine-tune the model by',
            fontSize: 11,
            box: proseBox,
            runs: [
              {
                ...proseBox,
                text: 'Then fine-tune the model by',
                fontName: 'Synthetic-Roman',
                fontSize: 11,
                confidence: 1,
              },
            ],
          },
          {
            id: 'argmin-sum-line',
            text: '∑',
            fontSize: 10,
            box: sumBox,
            runs: [
              {
                ...sumBox,
                text: '∑',
                fontName: 'Synthetic-CMEX10',
                fontSize: 10,
                confidence: 1,
              },
            ],
          },
        ],
      }
      const argmin = equationRegion(
        'argmin-display-head',
        '(ω, θ) = arg min',
        box(0.312, 0.872, 0.151, 0.016),
      )
      argmin.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
      const loss = equationRegion(
        'argmin-loss-term',
        'Loss(yω,θ+, ygold)',
        box(0.545, 0.876, 0.138, 0.018),
      )
      loss.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
      const printedNumber = textRegion(
        'argmin-printed-number',
        printedLabel,
        box(0.81, 0.876, 0.044, 0.013),
      )
      const subscript = textRegion(
        'argmin-subscript',
        'ω,θ+ (x,ygold)∈D',
        box(0.417, 0.89, 0.125, 0.015),
      )
      subscript.lines[0].runs[0].fontName = 'Synthetic-CMMI8'
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
        regions: [proseAndSum, argmin, loss, printedNumber, subscript],
        rasterizeFigure,
      })

      expect(result.relationships).toHaveLength(1)
      expect(result.relationships[0]).toMatchObject({
        label: equationLabel,
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([
          proseAndSum.id,
          argmin.id,
          loss.id,
          printedNumber.id,
          subscript.id,
        ]),
        sourceLineIds: expect.arrayContaining([
          'argmin-sum-line',
          argmin.lines[0].id,
          loss.lines[0].id,
          printedNumber.lines[0].id,
          subscript.lines[0].id,
        ]),
      })
      expect(result.relationships[0].sourceLineIds).not.toContain(
        'argmin-prose-line',
      )
      expect(rasterizeFigure).toHaveBeenCalledOnce()
      const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
      for (const sourceBox of [
        sumBox,
        argmin.box,
        loss.box,
        printedNumber.box,
        subscript.box,
      ]) {
        expect(containsSourceBox(crop, sourceBox)).toBe(true)
      }
      expect(containsSourceBox(crop, proseBox)).toBe(false)
    },
  )

  it('groups a numbered summation with detached Latin Modern scripts and its lower bound', async () => {
    const formula = equationRegion(
      'latin-modern-summation',
      'Loss = − 1 ∑m log p(tag)',
      box(0.403, 0.397, 0.235, 0.025),
    )
    formula.lines[0].runs = [
      {
        ...formula.lines[0].box,
        text: 'Loss = 1 log p(tag)',
        width: 0.18,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 11,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '−',
        x: 0.486,
        width: 0.014,
        fontName: 'Synthetic-LMMathSymbols10-Regular',
        fontSize: 11,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: '∑',
        x: 0.523,
        width: 0.024,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...formula.lines[0].box,
        text: 'm',
        x: 0.529,
        y: 0.397,
        width: 0.013,
        height: 0.009,
        fontName: 'Synthetic-LMMathItalic8-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const printedNumber = textRegion(
      'latin-modern-summation-number',
      '(1.23)',
      box(0.81, 0.408, 0.044, 0.013),
    )
    const firstDetachedScript = textRegion(
      'latin-modern-detached-script-first',
      'i',
      box(0.586, 0.414, 0.005, 0.009),
    )
    firstDetachedScript.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic8-Regular'
    const secondDetachedScript = textRegion(
      'latin-modern-detached-script-second',
      'i',
      box(0.625, 0.415, 0.005, 0.009),
    )
    secondDetachedScript.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic8-Regular'
    const lowerBound = equationRegion(
      'latin-modern-summation-lower-bound',
      'm i=1',
      box(0.502, 0.417, 0.045, 0.019),
    )
    lowerBound.lines[0].runs[0].fontName = 'Synthetic-LMMathItalic10-Regular'
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
        firstDetachedScript,
        secondDetachedScript,
        lowerBound,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1.23',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        formula.id,
        printedNumber.id,
        firstDetachedScript.id,
        secondDetachedScript.id,
        lowerBound.id,
      ]),
      sourceLineIds: expect.arrayContaining([
        formula.lines[0].id,
        printedNumber.lines[0].id,
        firstDetachedScript.lines[0].id,
        secondDetachedScript.lines[0].id,
        lowerBound.lines[0].id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const source of [
      formula,
      printedNumber,
      firstDetachedScript,
      secondDetachedScript,
      lowerBound,
    ]) {
      expect(containsSourceBox(crop, source.box)).toBe(true)
    }
  })

  it.each(['Regular', 'Bold'])(
    'does not promote Latin Modern Roman %s prose as a math fragment',
    async (style) => {
      const prose = textRegion(
        `latin-modern-roman-${style.toLowerCase()}-prose`,
        'A Latin Modern paragraph remains ordinary prose.',
        box(0.15, 0.3, 0.7, 0.02),
      )
      prose.lines[0].runs[0].fontName = `Synthetic-LMRoman10-${style}`

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [prose],
      })

      expect(result.relationships).toEqual([])
      expect(result.consumedRegionIds.has(prose.id)).toBe(false)
      expect(result.consumedLineIds.has(prose.lines[0].id)).toBe(false)
    },
  )

  it('keeps Latin Modern Roman letters and prose outside adjacent display equations', async () => {
    const first = equationRegion(
      'latin-modern-roman-boundary-first',
      'x = y',
      box(0.2, 0.2, 0.2, 0.02),
    )
    const detachedRomanLetter = textRegion(
      'latin-modern-detached-roman-letter',
      'i',
      box(0.41, 0.202, 0.008, 0.012),
    )
    detachedRomanLetter.lines[0].runs[0].fontName = 'Synthetic-LMRoman8-Regular'
    const prose = textRegion(
      'latin-modern-interstitial-prose',
      'where the estimate remains ordinary prose',
      box(0.2, 0.228, 0.32, 0.016),
    )
    prose.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
    const second = equationRegion(
      'latin-modern-roman-boundary-second',
      'u = v',
      box(0.2, 0.252, 0.2, 0.02),
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
      regions: [first, detachedRomanLetter, prose, second],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.flatMap(
        (relationship) => relationship.sourceRegionIds,
      ),
    ).not.toContain(detachedRomanLetter.id)
    expect(
      result.relationships.flatMap(
        (relationship) => relationship.sourceRegionIds,
      ),
    ).not.toContain(prose.id)
    expect(result.consumedLineIds.has(detachedRomanLetter.lines[0].id)).toBe(
      false,
    )
    expect(result.consumedLineIds.has(prose.lines[0].id)).toBe(false)
  })

  it('groups an aligned upright derivation continuation with its cross-column equation number', async () => {
    const first = equationRegion(
      'upright-derivation-first-line',
      'θ = arg max ∑ log Prθ(x)',
      box(0.319, 0.408, 0.235, 0.026),
    )
    first.column = 'left'
    const sumBridge = textRegion(
      'upright-derivation-sum-bridge',
      '∑',
      box(0.445, 0.451, 0.054, 0.013),
    )
    sumBridge.column = 'left'
    sumBridge.lines[0].runs[0].fontName = 'Synthetic-LMMathExtension10-Regular'
    const uprightContinuation = equationRegion(
      'upright-derivation-operator-continuation',
      '= arg max',
      box(0.345, 0.463, 0.094, 0.013),
    )
    uprightContinuation.column = 'left'
    uprightContinuation.lines[0].runs[0].fontName =
      'Synthetic-LMRoman10-Regular'
    const formulaContinuation = equationRegion(
      'upright-derivation-formula-continuation',
      'log Prθ(x_i+1|x_0,...,x_i)',
      box(0.502, 0.463, 0.174, 0.015),
    )
    formulaContinuation.column = 'left'
    formulaContinuation.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic10-Regular'
    const lowerScope = textRegion(
      'upright-derivation-lower-scope',
      'x∈D i=0',
      box(0.442, 0.48, 0.056, 0.01),
    )
    lowerScope.column = 'left'
    lowerScope.lines[0].runs[0].fontName = 'Synthetic-LMMathSymbols8-Regular'
    const printedNumber = textRegion(
      'upright-derivation-cross-column-number',
      '(1.7)',
      box(0.819, 0.463, 0.035, 0.013),
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
          height: 24,
          pixels: new Uint8Array(96 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        first,
        sumBridge,
        uprightContinuation,
        formulaContinuation,
        lowerScope,
        printedNumber,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1.7',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        first.id,
        sumBridge.id,
        uprightContinuation.id,
        formulaContinuation.id,
        lowerScope.id,
        printedNumber.id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
  })

  it('groups an argmax derivation when the upright continuation is the lower display row', async () => {
    const top = equationRegion(
      'endpoint-upright-derivation-top',
      'yˆ = arg max log Pr(y|x)',
      box(0.29929, 0.32662, 0.21325, 0.01296),
    )
    top.lines[0].runs = [
      {
        ...top.lines[0].box,
        text: 'y',
        width: 0.01113,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'ˆ',
        x: 0.3003,
        width: 0.00917,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: '=',
        x: 0.32733,
        width: 0.01426,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'arg max',
        x: 0.35819,
        width: 0.06292,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'log Pr(',
        x: 0.42454,
        width: 0.05354,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'y',
        x: 0.47798,
        width: 0.01113,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: '|',
        x: 0.48907,
        width: 0.0051,
        fontName: 'Synthetic-LMMathSymbols10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: 'x',
        x: 0.49412,
        width: 0.01113,
        fontName: 'Synthetic-LMRoman10-Bold',
        fontSize: 10.9091,
        confidence: 1,
      },
      {
        ...top.lines[0].box,
        text: ')',
        x: 0.50541,
        width: 0.00713,
        fontName: 'Synthetic-LMRoman10-Regular',
        fontSize: 10.9091,
        confidence: 1,
      },
    ]
    expect(isProbableDisplayEquation(top)).toBe(true)
    const upperScript = textRegion(
      'endpoint-upright-derivation-upper-script',
      'y',
      box(0.38561, 0.33966, 0.00867, 0.00947),
    )
    upperScript.lines[0].runs[0].fontName = 'Synthetic-LMRoman8-Bold'
    upperScript.lines[0].runs[0].fontSize = 8
    const sumBridge = textRegion(
      'endpoint-upright-derivation-sum',
      '∑n',
      box(0.42454, 0.35263, 0.02418, 0.01303),
    )
    sumBridge.lines[0].runs = [
      {
        ...sumBridge.lines[0].box,
        text: '∑',
        width: 0.014,
        fontName: 'Synthetic-LMMathExtension10-Regular',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...sumBridge.lines[0].box,
        text: 'n',
        x: 0.439,
        width: 0.01,
        fontName: 'Synthetic-LMMathItalic8-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const lower = equationRegion(
      'endpoint-upright-derivation-lower',
      '= arg max',
      box(0.32733, 0.36424, 0.09379, 0.01296),
    )
    lower.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
    const formulaContinuation = equationRegion(
      'endpoint-upright-derivation-formula',
      'log Pr(yi|x0,...,xm,y1,...,yi−1)',
      box(0.452, 0.364, 0.244, 0.015),
    )
    formulaContinuation.lines[0].runs[0].fontName =
      'Synthetic-LMMathItalic10-Regular'
    const printedNumber = textRegion(
      'endpoint-upright-derivation-number',
      '(2.15)',
      box(0.81, 0.364, 0.044, 0.013),
    )
    const lowerScript = textRegion(
      'endpoint-upright-derivation-lower-script',
      'y',
      box(0.386, 0.377, 0.009, 0.009),
    )
    lowerScript.lines[0].runs[0].fontName = 'Synthetic-LMMathItalic8-Regular'
    const lowerBound = textRegion(
      'endpoint-upright-derivation-lower-bound',
      'i=1',
      box(0.425, 0.382, 0.023, 0.009),
      'side',
    )
    lowerBound.lines[0].runs[0].fontName = 'Synthetic-LMMathItalic8-Regular'
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
        upperScript,
        sumBridge,
        lower,
        formulaContinuation,
        printedNumber,
        lowerScript,
        lowerBound,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 2.15',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        top.id,
        upperScript.id,
        sumBridge.id,
        lower.id,
        formulaContinuation.id,
        printedNumber.id,
        lowerScript.id,
        lowerBound.id,
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
  })

  it.each(['math bridge', 'printed number'])(
    'does not join endpoint argmax rows without a unique %s',
    async (missingEvidence) => {
      const top = equationRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-top`,
        'yˆ = arg max log Pr(y|x)',
        box(0.299, 0.327, 0.213, 0.013),
      )
      top.lines[0].runs = [
        {
          ...top.lines[0].box,
          text: 'yˆ = arg max log Pr(y',
          width: 0.17,
          fontName: 'Synthetic-LMRoman10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...top.lines[0].box,
          text: '|',
          x: 0.469,
          width: 0.008,
          fontName: 'Synthetic-LMMathSymbols10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...top.lines[0].box,
          text: 'x)',
          x: 0.477,
          width: 0.035,
          fontName: 'Synthetic-LMRoman10-Regular',
          fontSize: 10,
          confidence: 1,
        },
      ]
      const bridge = textRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-bridge`,
        '∑n',
        box(0.425, 0.353, 0.024, 0.013),
      )
      bridge.lines[0].runs = [
        {
          ...bridge.lines[0].box,
          text: '∑',
          width: 0.014,
          fontName: 'Synthetic-LMMathExtension10-Regular',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...bridge.lines[0].box,
          text: 'n',
          x: 0.439,
          width: 0.01,
          fontName: 'Synthetic-LMMathItalic8-Regular',
          fontSize: 8,
          confidence: 1,
        },
      ]
      const lower = equationRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-lower`,
        '= arg max',
        box(0.327, 0.364, 0.094, 0.013),
      )
      lower.lines[0].runs[0].fontName = 'Synthetic-LMRoman10-Regular'
      const continuation = equationRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-continuation`,
        'log Pr(yi|x)',
        box(0.432, 0.364, 0.16, 0.015),
      )
      continuation.lines[0].runs[0].fontName =
        'Synthetic-LMMathItalic10-Regular'
      const printedNumber = textRegion(
        `endpoint-upright-missing-${missingEvidence.replaceAll(' ', '-')}-number`,
        '(2.15)',
        box(0.81, 0.364, 0.044, 0.013),
      )
      const regions = [
        top,
        ...(missingEvidence === 'math bridge' ? [] : [bridge]),
        lower,
        continuation,
        ...(missingEvidence === 'printed number' ? [] : [printedNumber]),
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
        regions,
        rasterizeFigure,
      })

      expect(
        result.relationships.some(
          (relationship) =>
            relationship.sourceRegionIds.includes(top.id) &&
            relationship.sourceRegionIds.includes(lower.id),
        ),
      ).toBe(false)
    },
  )

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

  it('does not split disjoint overlay text across candidates sharing native sources', async () => {
    const panelBoxes = [box(0.2, 0.08, 0.5, 0.12), box(0.2, 0.4, 0.5, 0.12)]
    const sharedSourceObjectId = 'vector-p001-shared-native-layer'
    const objectGroups = panelBoxes.map((panelBox, panelIndex) =>
      Array.from({ length: 3 }, (_, layerIndex) => {
        const inset = layerIndex * 0.005
        return {
          id:
            layerIndex === 0
              ? sharedSourceObjectId
              : `vector-p001-shared-native-panel-${panelIndex + 1}-layer-${layerIndex + 1}`,
          page: 1,
          kind: 'vector' as const,
          box: box(
            panelBox.x + inset,
            panelBox.y + inset,
            panelBox.width - inset * 2,
            panelBox.height - inset * 2,
          ),
          confidence: 0.99,
          assetId: null,
        }
      }),
    )
    const panelOverlays = panelBoxes.map((panelBox, panelIndex) =>
      ['alpha', 'beta', 'gamma', 'delta'].map((text, lineIndex) =>
        textRegion(
          `shared-native-panel-${panelIndex + 1}-overlay-${lineIndex + 1}`,
          `${text} ${panelIndex + 1}`,
          box(
            0.27 + (lineIndex % 2) * 0.2,
            panelBox.y + 0.025 + Math.floor(lineIndex / 2) * 0.045,
            0.12,
            0.012,
          ),
          'chart-label',
        ),
      ),
    )
    const captions = [
      {
        ...captionRegion(
          'Figure 1. First shared-source panel.',
          box(0.2, 0.24, 0.5, 0.02),
        ),
        id: 'shared-native-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Second shared-source panel.',
          box(0.2, 0.56, 0.5, 0.02),
        ),
        id: 'shared-native-caption-b',
      },
    ]
    const regionObjects = objectGroups.flat()
    const pageObjects = [
      ...new Map(regionObjects.map((object) => [object.id, object])).values(),
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(pageObjects)],
      regions: [
        ...regionObjects.map((object, index) =>
          objectRegion(
            `shared-native-vector-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelOverlays.flat(),
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    const firstNativeIds =
      result.relationships[0].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    const secondNativeIds =
      result.relationships[1].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    expect(firstNativeIds).toContain(sharedSourceObjectId)
    expect(secondNativeIds).toContain(sharedSourceObjectId)
    expect(panelOverlays[0].map((region) => region.lines[0].id)).not.toEqual(
      panelOverlays[1].map((region) => region.lines[0].id),
    )
    for (const relationship of result.relationships) {
      expect(relationship).toMatchObject({
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
      })
    }
    expect(
      panelOverlays
        .flat()
        .every(
          (region) =>
            !result.consumedRegionIds.has(region.id) &&
            !result.consumedLineIds.has(region.lines[0].id),
        ),
    ).toBe(true)
  })

  it('treats a shared overlay line as contested across different region aliases', async () => {
    const panelBoxes = [box(0.2, 0.08, 0.5, 0.12), box(0.2, 0.4, 0.5, 0.12)]
    const objectGroups = panelBoxes.map((panelBox, panelIndex) =>
      Array.from({ length: 3 }, (_, layerIndex) => {
        const inset = layerIndex * 0.005
        return {
          id: `vector-p001-aliased-line-panel-${panelIndex + 1}-layer-${layerIndex + 1}`,
          page: 1,
          kind: 'vector' as const,
          box: box(
            panelBox.x + inset,
            panelBox.y + inset,
            panelBox.width - inset * 2,
            panelBox.height - inset * 2,
          ),
          confidence: 0.99,
          assetId: null,
        }
      }),
    )
    const panelOverlays = panelBoxes.map((panelBox, panelIndex) =>
      ['alpha', 'beta', 'gamma', 'delta'].map((text, lineIndex) => {
        const region = textRegion(
          `aliased-line-panel-${panelIndex + 1}-overlay-${lineIndex + 1}`,
          `${text} ${panelIndex + 1}`,
          box(
            0.27 + (lineIndex % 2) * 0.2,
            panelBox.y + 0.025 + Math.floor(lineIndex / 2) * 0.045,
            0.12,
            0.012,
          ),
          'chart-label',
        )
        region.lines[0].id = `shared-aliased-overlay-line-${lineIndex + 1}`
        return region
      }),
    )
    const captions = [
      {
        ...captionRegion(
          'Figure 1. First independent layered panel.',
          box(0.2, 0.24, 0.5, 0.02),
        ),
        id: 'aliased-line-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Second independent layered panel.',
          box(0.2, 0.56, 0.5, 0.02),
        ),
        id: 'aliased-line-caption-b',
      },
    ]
    const objects = objectGroups.flat()

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `aliased-line-vector-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelOverlays.flat(),
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    const firstNativeIds =
      result.relationships[0].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    const secondNativeIds =
      result.relationships[1].candidates[0].sourceObjectIds.filter(
        (sourceObjectId) => !sourceObjectId.startsWith('text-overlay:'),
      )
    expect(
      firstNativeIds.some((sourceObjectId) =>
        secondNativeIds.includes(sourceObjectId),
      ),
    ).toBe(false)
    expect(panelOverlays[0].map((region) => region.lines[0].id)).toEqual(
      panelOverlays[1].map((region) => region.lines[0].id),
    )
    for (const relationship of result.relationships) {
      expect(relationship).toMatchObject({
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
      })
    }
    expect(
      panelOverlays
        .flat()
        .every(
          (region) =>
            !result.consumedRegionIds.has(region.id) &&
            !result.consumedLineIds.has(region.lines[0].id),
        ),
    ).toBe(true)
  })

  it('reserves uniquely owned figure overlay lines before resolving an earlier table', async () => {
    const tableCaption = {
      ...captionRegion(
        'Table 1. Bounded metric records.',
        box(0.12, 0.1, 0.68, 0.02),
      ),
      id: 'reserved-overlay-table-caption',
    }
    const tableRows = [0.124, 0.142, 0.16, 0.178, 0.196, 0.214, 0.232].map(
      (y, index) => {
        const region = textRegion(
          `reserved-overlay-table-row-${index + 1}`,
          `Metric ${index + 1}: source bounded value`,
          box(0.12, y, 0.68, 0.012),
        )
        region.lines[0].fontSize = 8
        region.lines[0].runs[0] = {
          ...region.lines[0].runs[0],
          fontName: 'TableSerif-Bold',
          fontSize: 8,
        }
        if (index >= 5) {
          region.kind = 'chart-label'
          region.includedInReadingOrder = false
        }
        return region
      },
    )
    const figureBox = box(0.12, 0.25, 0.68, 0.08)
    const figureObjectIds = [
      'vector-p001-reserved-overlay-a',
      'vector-p001-reserved-overlay-b',
    ]
    const figureAssets = figureObjectIds.map((id) =>
      sourcePreservedSvgAsset(id, figureBox),
    )
    const figureObjects = figureObjectIds.map((id, index) => ({
      id,
      page: 1,
      kind: 'vector' as const,
      box: figureBox,
      confidence: 0.99,
      assetId: figureAssets[index].id,
    }))
    const figureRegions = figureObjects.map((object, index) =>
      objectRegion(
        `reserved-overlay-figure-region-${index + 1}`,
        object.id,
        figureBox,
      ),
    )
    const plotOverlays = [0.262, 0.28, 0.298].map((y, index) => {
      const region = textRegion(
        `reserved-plot-overlay-${index + 1}`,
        `series ${index + 1}`,
        box(0.2 + index * 0.14, y, 0.1, 0.012),
        'chart-label',
      )
      region.lines[0].fontSize = 8
      region.lines[0].runs[0] = {
        ...region.lines[0].runs[0],
        fontName: 'TableSerif-Bold',
        fontSize: 8,
      }
      return region
    })
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Multi-panel metric plot.',
        box(0.12, 0.35, 0.68, 0.02),
      ),
      id: 'reserved-overlay-figure-caption',
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind:
            input.kind === 'table'
              ? 'table'
              : input.kind === 'equation'
                ? 'equation'
                : 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 120,
          height: 80,
          pixels: new Uint8Array(120 * 80 * 4).fill(96),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(figureObjects, 1, figureAssets)],
      regions: [
        tableCaption,
        ...tableRows,
        ...figureRegions,
        ...plotOverlays,
        figureCaption,
      ],
      rasterizeFigure,
    })

    const tableRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'table',
    )
    const figureRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'figure',
    )
    expect(tableRelationship).toMatchObject({
      status: 'matched',
      sourceRegionIds: tableRows.map((region) => region.id),
      sourceLineIds: tableRows.map((region) => region.lines[0].id),
      sourceText: tableRows.map((region) => region.text).join(' '),
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(tableRelationship?.sourceRegionIds).not.toEqual(
      expect.arrayContaining(plotOverlays.map((region) => region.id)),
    )
    expect(tableRelationship?.sourceLineIds).not.toEqual(
      expect.arrayContaining(plotOverlays.map((region) => region.lines[0].id)),
    )
    expect(
      tableRelationship!.sourceBoxes
        .slice(1)
        .every(
          (sourceBox) =>
            sourceBox.y + sourceBox.height <= figureBox.y + 0.00001,
        ),
    ).toBe(true)
    expect(figureRelationship).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        ...figureRegions.map((region) => region.id),
        ...plotOverlays.map((region) => region.id),
      ]),
      sourceLineIds: plotOverlays.map((region) => region.lines[0].id),
      sourceText: plotOverlays.map((region) => region.text).join(' '),
      assetIds: [expect.stringMatching(/^asset-/)],
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining([
            ...figureObjectIds,
            ...plotOverlays.map((region) => `text-overlay:${region.id}`),
          ]),
          evidence: expect.arrayContaining(['connected-native-scaffold']),
        }),
      ],
    })
    expect(figureRelationship?.candidates[0].evidence).not.toContain(
      'caption-bounded-native-scaffold',
    )
    expect(figureRelationship?.sourceRegionIds).not.toEqual(
      expect.arrayContaining(tableRows.map((region) => region.id)),
    )
    expect(
      tableRelationship?.assetIds[0] === figureRelationship?.assetIds[0],
    ).toBe(false)
    expect(rasterizeFigure.mock.calls.map(([input]) => input.kind)).toEqual(
      expect.arrayContaining(['table', 'figure']),
    )
  })

  it('keeps adjacent panel-label prose inside its uniquely captioned multi-panel figure', async () => {
    const panelBoxes = [
      box(0.176, 0.103, 0.291, 0.169),
      box(0.532, 0.103, 0.291, 0.169),
    ]
    const sourceAssets = await Promise.all(
      panelBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-labelled-panel-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(72 + index * 64),
        }),
      ),
    )
    const objects = panelBoxes.map((sourceBox, index) => ({
      id: `image-p001-labelled-panel-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const leftPanelLabel = textRegion(
      'left-panel-label',
      '(a) Accuracy as a function of program length.',
      box(0.176, 0.277, 0.291, 0.024),
    )
    const rightPanelLabel = textRegion(
      'right-panel-label',
      '(b) Accuracy as a function of sequence length.',
      box(0.532, 0.277, 0.291, 0.024),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `labelled-panel-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        leftPanelLabel,
        rightPanelLabel,
        captionRegion(
          'Figure 1. Accuracy by program and sequence length.',
          box(0.182, 0.315, 0.635, 0.013),
        ),
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        leftPanelLabel.id,
        rightPanelLabel.id,
      ]),
      evidence: expect.arrayContaining([
        'source-text-overlay',
        'panel-label-source-owned',
      ]),
    })
    expect(result.consumedRegionIds.has(leftPanelLabel.id)).toBe(true)
    expect(result.consumedRegionIds.has(rightPanelLabel.id)).toBe(true)
  })

  it('prefers a conventional above-caption figure before using caption-above fallback', async () => {
    const above = box(0.12, 0.18, 0.76, 0.18)
    const below = box(0.12, 0.42, 0.76, 0.18)
    const sourceAssets = await Promise.all(
      [above, below].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 4,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 2 * 4).fill(80 + index * 40),
        }),
      ),
    )
    const objects = [above, below].map((sourceBox, index) => ({
      id: `image-p001-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        objectRegion('above-region', objects[0].id, above),
        objectRegion('below-region', objects[1].id, below),
        captionRegion(
          'Figure IV. Directionally bounded source figure.',
          box(0.12, 0.38, 0.76, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[0].id],
      assetIds: [sourceAssets[0].id],
      evidence: expect.arrayContaining(['object-above-caption']),
    })
  })

  it('does not let a thin aligned vector sliver tie a caption-width figure', async () => {
    const figureBox = box(0.2, 0.2, 0.45, 0.18)
    const sliverBox = box(0.82, 0.2, 0.015, 0.18)
    const figureAsset = sourcePreservedSvgAsset(
      'vector-p001-caption-width-figure',
      figureBox,
    )
    const sliverAsset = sourcePreservedSvgAsset(
      'vector-p001-caption-sliver',
      sliverBox,
    )
    const objects = [
      {
        id: 'vector-p001-caption-width-figure',
        page: 1,
        kind: 'vector' as const,
        box: figureBox,
        confidence: 0.99,
        assetId: figureAsset.id,
      },
      {
        id: 'vector-p001-caption-sliver',
        page: 1,
        kind: 'vector' as const,
        box: sliverBox,
        confidence: 0.99,
        assetId: sliverAsset.id,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset, sliverAsset])],
      regions: [
        objectRegion('caption-width-figure-region', objects[0].id, figureBox),
        objectRegion('caption-sliver-region', objects[1].id, sliverBox),
        captionRegion(
          'Figure IV. Caption-width figure with a decorative sliver.',
          box(0.2, 0.4, 0.65, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-caption-width-figure'],
      assetIds: [figureAsset.id],
    })
    expect(result.relationships[0].candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceObjectIds: ['vector-p001-caption-width-figure'],
          evidence: expect.arrayContaining(['horizontal-alignment']),
        }),
        expect.objectContaining({
          sourceObjectIds: ['vector-p001-caption-sliver'],
          evidence: expect.not.arrayContaining(['horizontal-alignment']),
        }),
      ]),
    )
  })

  it('retains equally scored Roman-label candidates instead of guessing', async () => {
    const left = box(0.05, 0.2)
    const right = box(0.7, 0.2)
    const rasterizeFigure = vi.fn(async () => null)
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: left,
        confidence: 0.98,
        assetId: 'asset-left',
      },
      {
        id: 'image-p001-002',
        page: 1,
        kind: 'image' as const,
        box: right,
        confidence: 0.98,
        assetId: 'asset-right',
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('left-region', objects[0].id, left),
        objectRegion('right-region', objects[1].id, right),
        captionRegion(
          'Figure I. Competing candidates.',
          box(0.05, 0.32, 0.85, 0.02),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'ambiguous',
      candidates: [
        expect.objectContaining({ score: expect.any(Number) }),
        expect.objectContaining({ score: expect.any(Number) }),
      ],
    })
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
