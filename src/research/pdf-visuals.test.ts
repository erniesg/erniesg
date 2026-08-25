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

  it.each(['body', 'equation'] as const)(
    'groups a six-row stacked-radical display into one atomic source-cropped equation when its denominator row is classified as %s',
    async (denominatorKind) => {
      // Mirrors arXiv:2501.19393v2 page 29: T = ⁴√(R⊙u/3σ) = … ≈ 50000 K is
      // painted as six interleaved text rows (an unmatched `√√ (` opener
      // column, a detached outer radical, the numerator, the T = ⁴√ row, the
      // result row, and the 3σ denominator). The whole band must resolve as
      // ONE atomic display-equation component with a source-crop rendition —
      // never as garbled reading-order prose.
      const italic = 'Synthetic-STIXMath-Italic'
      const regular = 'Synthetic-STIXMath-Regular'
      const extension = 'Synthetic-STIXMathExtensions-Regular'
      const serif = 'Synthetic-STIXGeneral-Regular'
      const run = (
        text: string,
        x: number,
        y: number,
        width: number,
        height: number,
        fontName: string,
        fontSize: number,
        sourceSequenceIndex: number,
        sourceWhitespacePredecessorIndex?: number,
      ): PdfSourceRun => {
        const base = {
          page: 1,
          x,
          y,
          width,
          height,
          rotation: 0,
          method: 'pdf-text' as const,
          text,
          fontName,
          fontSize,
          confidence: 1,
          sourceSequenceIndex,
        }
        return sourceWhitespacePredecessorIndex === undefined
          ? base
          : {
              ...base,
              sourceWhitespaceBefore: 'pdf-text-item',
              sourceWhitespacePredecessorIndex,
            }
      }
      const bandRegion = (
        id: string,
        kind: PdfPageRegion['kind'],
        text: string,
        runs: PdfSourceRun[],
      ): PdfPageRegion => {
        const x = Math.min(...runs.map((item) => item.x))
        const y = Math.min(...runs.map((item) => item.y))
        const lineBox = {
          page: 1,
          x,
          y,
          width: Math.max(...runs.map((item) => item.x + item.width)) - x,
          height: Math.max(...runs.map((item) => item.y + item.height)) - y,
          rotation: 0,
          method: 'pdf-text' as const,
        }
        return {
          id,
          page: 1,
          kind,
          column: 'single',
          text,
          confidence: 0.9,
          box: lineBox,
          lines: [
            { id: `${id}-line`, text, fontSize: 9.9626, box: lineBox, runs },
          ],
          nativeObjectIds: [],
          includedInReadingOrder: true,
        }
      }
      const precedingDisplay = bandRegion(
        'stacked-radical-preceding-display',
        'equation',
        '𝑃 = 𝜎𝐴𝑇 4 = 4𝜋𝜎𝑅2⊙𝑇 4',
        [
          run('𝑃', 0.40743, 0.35674, 0.00967, 0.01258, italic, 9.9626, 70),
          run('=', 0.42406, 0.35674, 0.01115, 0.01258, regular, 9.9626, 72, 70),
          run(
            '𝜎𝐴𝑇',
            0.43974,
            0.35674,
            0.03018,
            0.01258,
            italic,
            9.9626,
            74,
            72,
          ),
          run('4', 0.47252, 0.35485, 0.0061, 0.00943, regular, 7.472, 76, 74),
          run(
            '= 4',
            0.48396,
            0.35674,
            0.02382,
            0.01258,
            regular,
            9.9626,
            78,
            76,
          ),
          run('𝜋𝜎𝑅', 0.50777, 0.35674, 0.0315, 0.01258, italic, 9.9626, 79),
          run('2', 0.53927, 0.35485, 0.0061, 0.00943, regular, 7.472, 80),
          run('⊙', 0.53927, 0.36429, 0.0093, 0.00943, italic, 7.472, 82),
          run('𝑇', 0.54939, 0.35674, 0.00895, 0.01258, italic, 9.9626, 83),
          run('4', 0.56095, 0.35485, 0.0061, 0.00943, regular, 7.472, 85, 83),
        ],
      )
      const leadProse = bandRegion(
        'stacked-radical-lead-prose',
        'body',
        'Solving for 𝑇, we get',
        [
          run(
            'Solving for',
            0.09059,
            0.37938,
            0.07285,
            0.01258,
            serif,
            9.9626,
            87,
          ),
          run('𝑇', 0.16751, 0.37938, 0.00895, 0.01258, italic, 9.9626, 89, 87),
          run(
            ', we get',
            0.17906,
            0.37938,
            0.0504,
            0.01258,
            serif,
            9.9626,
            91,
            89,
          ),
        ],
      )
      const opener = bandRegion(
        'stacked-radical-opener-column',
        'equation',
        '√√ (',
        [
          run('√', 0.39188, 0.39739, 0.01927, 0.01258, extension, 9.9626, 112),
          run('√', 0.39188, 0.40404, 0.01927, 0.01258, extension, 9.9626, 113),
          run('(', 0.41311, 0.40247, 0.00762, 0.01258, extension, 9.9626, 116),
        ],
      )
      const outerRadical = bandRegion(
        'stacked-radical-outer-radical',
        'equation',
        '√',
        [run('√', 0.31924, 0.40232, 0.0183, 0.01258, extension, 9.9626, 99)],
      )
      const numeratorRow = bandRegion(
        'stacked-radical-numerator-row',
        'equation',
        '𝑅 𝑢 √ 6.96 × 108) (1506)',
        [
          run('𝑅', 0.33949, 0.41329, 0.01205, 0.01258, italic, 9.9626, 101, 99),
          run('𝑢', 0.36165, 0.41329, 0.00772, 0.01258, italic, 9.9626, 103),
          run('√', 0.39188, 0.41069, 0.01927, 0.01258, extension, 9.9626, 114),
          run('6', 0.42072, 0.41253, 0.00814, 0.01258, regular, 9.9626, 117),
          run('.', 0.42886, 0.41253, 0.00407, 0.01258, italic, 9.9626, 118),
          run(
            '96 × 10',
            0.43293,
            0.41253,
            0.0502,
            0.01258,
            regular,
            9.9626,
            119,
          ),
          run('8', 0.48314, 0.41221, 0.0061, 0.00943, regular, 7.472, 120),
          run(')', 0.49006, 0.40247, 0.00762, 0.01258, extension, 9.9626, 121),
          run(
            '(1506)',
            0.50039,
            0.41253,
            0.0434,
            0.01258,
            regular,
            9.9626,
            123,
            121,
          ),
        ],
      )
      const equalsRow = bandRegion(
        'stacked-radical-equals-row',
        'equation',
        '𝑇 = 4 ⊙ = √4',
        [
          run('𝑇', 0.28712, 0.42317, 0.00895, 0.01258, italic, 9.9626, 93),
          run('=', 0.3032, 0.42317, 0.01115, 0.01258, regular, 9.9626, 95, 93),
          run('4', 0.3234, 0.42026, 0.00488, 0.00755, regular, 5.9776, 97, 95),
          run('⊙', 0.35153, 0.41958, 0.0093, 0.00943, italic, 7.472, 102),
          run(
            '=',
            0.37584,
            0.42317,
            0.01115,
            0.01258,
            regular,
            9.9626,
            108,
            106,
          ),
          run('√', 0.39188, 0.41798, 0.01927, 0.01258, extension, 9.9626, 115),
          run(
            '4',
            0.39604,
            0.42209,
            0.00488,
            0.00755,
            regular,
            5.9776,
            110,
            108,
          ),
        ],
      )
      const resultRow = bandRegion(
        'stacked-radical-result-row',
        'equation',
        '3 (5.67 × 10−8) = 49823 ≈ 50000 K.',
        [
          run('3', 0.42655, 0.43382, 0.00814, 0.01258, regular, 9.9626, 124),
          run(
            '(',
            0.43741,
            0.42377,
            0.00762,
            0.01258,
            extension,
            9.9626,
            126,
            124,
          ),
          run('5', 0.44502, 0.43382, 0.00814, 0.01258, regular, 9.9626, 127),
          run('.', 0.45317, 0.43382, 0.00407, 0.01258, italic, 9.9626, 128),
          run(
            '67 × 10',
            0.45723,
            0.43382,
            0.0502,
            0.01258,
            regular,
            9.9626,
            129,
          ),
          run('−8', 0.50744, 0.43351, 0.01447, 0.00943, regular, 7.472, 130),
          run(')', 0.52273, 0.42377, 0.00762, 0.01258, extension, 9.9626, 131),
          run(
            '= 49823 ≈ 50000 K',
            0.55027,
            0.42317,
            0.13308,
            0.01258,
            regular,
            9.9626,
            133,
            131,
          ),
          run('.', 0.6841, 0.42317, 0.00407, 0.01258, italic, 9.9626, 134),
        ],
      )
      const denominatorRow = bandRegion(
        'stacked-radical-denominator-row',
        denominatorKind,
        '3𝜎',
        [
          run('3', 0.34558, 0.43198, 0.00814, 0.01258, regular, 9.9626, 105),
          run('𝜎', 0.35372, 0.43198, 0.00874, 0.01258, italic, 9.9626, 106),
        ],
      )
      const bandRegions = [
        opener,
        outerRadical,
        numeratorRow,
        equalsRow,
        resultRow,
        denominatorRow,
      ]
      const bandLineIds = bandRegions.map((region) => region.lines[0].id)
      const bandRegionIds = bandRegions.map((region) => region.id)
      const allRegions = [precedingDisplay, leadProse, ...bandRegions]
      const whitespaceRun = (
        x: number,
        width: number,
        y: number,
        fontName: string,
        fontSize: number,
        sourceSequenceIndex: number,
        height = 0.01258,
      ): PdfSourceRun =>
        run(' ', x, y, width, height, fontName, fontSize, sourceSequenceIndex)
      const sourcePage = page([])
      sourcePage.renderVisibleTextRuns = [
        ...allRegions.flatMap((region) =>
          region.lines.flatMap((line) =>
            line.runs.map((item) => ({ ...item })),
          ),
        ),
        whitespaceRun(0.4171, 0.00696, 0.35674, italic, 9.9626, 71),
        whitespaceRun(0.43521, 0.00452, 0.35674, regular, 9.9626, 73),
        whitespaceRun(0.46992, 0.00261, 0.35674, italic, 9.9626, 75),
        whitespaceRun(0.47863, 0.00533, 0.35485, regular, 7.472, 77, 0.00943),
        whitespaceRun(0.55834, 0.0026, 0.35674, italic, 9.9626, 84),
        whitespaceRun(0.16344, 0.00407, 0.37938, serif, 9.9626, 88),
        whitespaceRun(0.17646, 0.0026, 0.37938, italic, 9.9626, 90),
        whitespaceRun(0.29608, 0.00713, 0.42317, italic, 9.9626, 94),
        whitespaceRun(0.31435, 0.00904, 0.42317, regular, 9.9626, 96),
        whitespaceRun(0.33753, 0.00195, 0.40232, extension, 9.9626, 100),
        whitespaceRun(0.36246, 0.01338, 0.43198, italic, 9.9626, 107),
        whitespaceRun(0.38699, 0.00904, 0.42317, regular, 9.9626, 109),
        whitespaceRun(0.49768, 0.00271, 0.40247, extension, 9.9626, 122),
        whitespaceRun(0.43469, 0.00271, 0.43382, regular, 9.9626, 125),
        whitespaceRun(0.53035, 0.01992, 0.42377, extension, 9.9626, 132),
      ]
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
        pages: [sourcePage],
        regions: allRegions,
        rasterizeFigure,
      })

      const bandRelationships = result.relationships.filter((relationship) =>
        relationship.candidates.some((candidate) =>
          candidate.sourceRegionIds.some((regionId) =>
            bandRegionIds.includes(regionId),
          ),
        ),
      )
      // The six rows must be proved as ONE atomic display-equation component…
      expect(bandRelationships).toHaveLength(1)
      const bandRelationship = bandRelationships[0]!
      expect(bandRelationship).toMatchObject({
        kind: 'equation',
        status: 'matched',
      })
      expect([...(bandRelationship.sourceLineIds ?? [])].sort()).toEqual(
        [...bandLineIds].sort(),
      )
      expect(bandRelationship.evidence).toEqual(
        expect.arrayContaining([
          'source-proved-atomic-equation-component',
          'source-page-crop',
        ]),
      )
      // …with a source-crop rendition…
      expect(bandRelationship.assetIds).toHaveLength(1)
      // …and no band row may leak back into reading-order prose.
      for (const region of bandRegions) {
        if (region.id === bandRelationship.captionRegionId) continue
        expect(
          result.consumedRegionIds.has(region.id) ||
            result.consumedLineIds.has(region.lines[0].id),
        ).toBe(true)
      }
      // The preceding display and the prose cue stay outside the component.
      expect(bandRelationship.sourceRegionIds).not.toContain(
        precedingDisplay.id,
      )
      expect(bandRelationship.sourceRegionIds).not.toContain(leadProse.id)
      expect(result.consumedRegionIds.has(leadProse.id)).toBe(false)
      expect(
        result.relationships.find((relationship) =>
          relationship.candidates.some((candidate) =>
            candidate.sourceRegionIds.includes(precedingDisplay.id),
          ),
        )?.sourceRegionIds,
      ).toEqual([precedingDisplay.id])
    },
  )

  it('does not partially attach a source-sequence owner cluster whose aggregate envelope is out of bounds', async () => {
    const source = equationRegion(
      'owner-cluster-envelope-source',
      's = 1',
      box(0.4, 0.2, 0.2, 0.02),
    )
    const candidate = equationRegion(
      'owner-cluster-envelope-candidate',
      'a = b',
      box(0, 0.201, 0.3, 0.018),
    )
    const owner = equationRegion(
      'owner-cluster-envelope-owner',
      'c = d',
      box(0.7, 0.201, 0.3, 0.018),
    )
    candidate.lines[0].runs[0].sourceSequenceIndex = 10
    owner.lines[0].runs[0].sourceSequenceIndex = 12
    owner.lines[0].runs[0].sourceWhitespaceBefore = 'pdf-text-item'
    owner.lines[0].runs[0].sourceWhitespacePredecessorIndex = 10
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
      regions: [source, candidate, owner],
      rasterizeFigure,
    })

    expect(
      result.relationships.find(
        (relationship) => relationship.captionRegionId === source.id,
      )?.sourceRegionIds,
    ).toEqual([source.id])
    expect(result.consumedRegionIds.has(candidate.id)).toBe(false)
  })

  it('keeps a legitimate multi-line display joined when body text is outside its corridor', async () => {
    const first = equationRegion(
      'aligned-equation-with-side-body-first',
      'a + b = c',
      box(0.09, 0.2, 0.3, 0.025),
    )
    const second = equationRegion(
      'aligned-equation-with-side-body-second',
      'd + e = f',
      box(0.09, 0.235, 0.3, 0.025),
    )
    const sideBody = textRegion(
      'body-outside-equation-corridor',
      'Hence:',
      box(0.75, 0.225, 0.08, 0.018),
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
      regions: [first, sideBody, second],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: [first.id, second.id],
    })
    expect(result.relationships[0].sourceRegionIds).not.toContain(sideBody.id)
  })

  it('attaches a detached math-extension run only to its source-proved host line', async () => {
    const host = equationRegion(
      'source-proved-detached-host',
      '(1-t)/(2 cos θ) + √3t/(2 sin θ) = 1',
      box(0.09, 0.22, 0.3, 0.025),
    )
    host.lines[0].id = 'page-001-inline-stacked-0042-formula'
    const detached = textRegion(
      'source-proved-detached-root',
      '√',
      box(0.15, 0.205, 0.012, 0.009),
      'equation',
    )
    detached.lines[0].id = `page-001-source-line-0041-detached-math-001-host-${encodeURIComponent(host.lines[0].id)}`
    detached.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    detached.lines[0].runs[0].fontSize = 7
    const cue = textRegion(
      'source-proved-detached-cue',
      'Hence:',
      box(0.09, 0.18, 0.06, 0.014),
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
      regions: [cue, detached, host],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      captionRegionId: host.id,
    })
    expect(new Set(result.relationships[0].sourceRegionIds)).toEqual(
      new Set([host.id, detached.id]),
    )
    expect(new Set(result.relationships[0].sourceLineIds)).toEqual(
      new Set([host.lines[0].id, detached.lines[0].id]),
    )
    expect(result.relationships[0].sourceRegionIds).not.toContain(cue.id)
  })

  it('allows a display region whose detached math-extension host is internal to the same region', async () => {
    const display = equationRegion(
      'self-contained-detached-display',
      '√ x = y',
      box(0.09, 0.22, 0.3, 0.035),
    )
    const hostLine = display.lines[0]
    hostLine.id = 'page-001-source-line-0042'
    hostLine.text = 'x = y'
    hostLine.box = {
      ...hostLine.box,
      x: 0.11,
      y: 0.235,
      width: 0.12,
      height: 0.015,
    }
    hostLine.runs[0] = {
      ...hostLine.runs[0],
      ...hostLine.box,
      text: 'x = y',
      fontName: 'Synthetic-STIXMath-Regular',
    }
    const detachedLine = {
      id: `page-001-source-line-0041-detached-math-001-host-${encodeURIComponent(hostLine.id)}`,
      text: '√',
      fontSize: 8,
      box: {
        ...hostLine.box,
        x: 0.095,
        y: 0.22,
        width: 0.012,
        height: 0.01,
      },
      runs: [
        {
          ...hostLine.runs[0],
          x: 0.095,
          y: 0.22,
          width: 0.012,
          height: 0.01,
          text: '√',
          fontName: 'Synthetic-STIXMathExtensions-Regular',
          fontSize: 8,
        },
      ],
    }
    display.lines = [detachedLine, hostLine]

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [display],
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      captionRegionId: display.id,
      sourceRegionIds: [display.id],
      sourceLineIds: [detachedLine.id, hostLine.id],
    })
  })

  it('does not seed a display when its detached math-extension host is external', async () => {
    const display = equationRegion(
      'external-detached-display',
      '√ x = y',
      box(0.09, 0.22, 0.3, 0.035),
    )
    const hostLine = display.lines[0]
    hostLine.id = 'page-001-source-line-0042'
    hostLine.text = 'x = y'
    hostLine.runs[0].text = 'x = y'
    hostLine.runs[0].fontName = 'Synthetic-STIXMath-Regular'
    const detachedLine = {
      id: `page-001-source-line-0041-detached-math-001-host-${encodeURIComponent('page-001-source-line-9999')}`,
      text: '√',
      fontSize: 8,
      box: {
        ...hostLine.box,
        x: 0.095,
        y: 0.22,
        width: 0.012,
        height: 0.01,
      },
      runs: [
        {
          ...hostLine.runs[0],
          x: 0.095,
          y: 0.22,
          width: 0.012,
          height: 0.01,
          text: '√',
          fontName: 'Synthetic-STIXMathExtensions-Regular',
          fontSize: 8,
        },
      ],
    }
    display.lines = [detachedLine, hostLine]

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [display],
    })

    expect(result.relationships).toHaveLength(0)
  })

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

  it('absorbs a bare Computer Modern numeric fraction part into the display crop scope', async () => {
    const formula = equationRegion(
      'fraction-with-detached-denominator',
      'p t = 1.58 t (p c + p r + p g )',
      box(0.599, 0.6137, 0.284, 0.0238),
    )
    formula.lines[0].runs[0].fontName = 'CJMJKD+CMMI10'
    // The denominator reaches line assembly as the first line of the body
    // paragraph that follows the display equation, so only line-level
    // absorption can reclaim it for the crop scope.
    const denominatorBox = {
      ...box(0.7012, 0.634, 0.0364, 0.013),
      method: 'pdf-text' as const,
    }
    const proseBox = {
      ...box(0.599, 0.655, 0.284, 0.013),
      method: 'pdf-text' as const,
    }
    const followingParagraph = {
      ...textRegion(
        'fraction-following-paragraph',
        '1000 where p c is the average power draw',
        box(0.599, 0.634, 0.284, 0.034),
      ),
      lines: [
        {
          id: 'fraction-following-paragraph-denominator-line',
          text: '1000',
          fontSize: 9,
          box: denominatorBox,
          runs: [
            {
              ...denominatorBox,
              text: '1000',
              fontName: 'CJMJKD+CMR10',
              fontSize: 9,
              confidence: 0.99,
            },
          ],
        },
        {
          id: 'fraction-following-paragraph-prose-line',
          text: 'where p c is the average power draw',
          fontSize: 9,
          box: proseBox,
          runs: [
            {
              ...proseBox,
              text: 'where p c is the average power draw',
              fontName: 'NimbusRomanNo9L',
              fontSize: 9,
              confidence: 0.99,
            },
          ],
        },
      ],
    }
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
      regions: [formula, followingParagraph],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(result.relationships[0].sourceLineIds).toContain(
      'fraction-following-paragraph-denominator-line',
    )
    expect(result.relationships[0].sourceLineIds).not.toContain(
      'fraction-following-paragraph-prose-line',
    )
  })

  it('never absorbs Computer Modern prose beside a display equation into its crop scope', async () => {
    const formula = equationRegion(
      'fraction-beside-prose',
      'p t = 1.58 t (p c + p r + p g )',
      box(0.599, 0.6137, 0.284, 0.0238),
    )
    formula.lines[0].runs[0].fontName = 'CJMJKD+CMMI10'
    const prose = textRegion(
      'fraction-neighboring-prose',
      'the market makers utility function',
      box(0.6, 0.634, 0.28, 0.013),
    )
    prose.lines[0].runs[0].fontName = 'CJMJKD+CMR10'
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
      regions: [formula, prose],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].sourceRegionIds).not.toContain(prose.id)
    expect(result.relationships[0].sourceLineIds).not.toContain(
      prose.lines[0].id,
    )
  })

  it('does not treat punctuation-only mixed Computer Modern prose as a detached integrand', async () => {
    const formula = equationRegion(
      'short-prose-neighbor-formula',
      'f(x) = x',
      box(0.42, 0.42, 0.18, 0.018),
    )
    formula.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
    const prose = textRegion(
      'short-prose-neighbor',
      'if x is y,',
      box(0.605, 0.42, 0.075, 0.014),
    )
    prose.lines[0].runs = [
      {
        ...prose.lines[0].box,
        text: 'if ',
        width: 0.018,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: 'x',
        x: 0.623,
        width: 0.008,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: ' is ',
        x: 0.631,
        width: 0.024,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: 'y',
        x: 0.655,
        width: 0.008,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...prose.lines[0].box,
        text: ',',
        x: 0.663,
        width: 0.004,
        fontName: 'Synthetic-CMR12',
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
          width: 96,
          height: 20,
          pixels: new Uint8Array(96 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, prose],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].sourceRegionIds).not.toContain(prose.id)
    expect(result.relationships[0].sourceLineIds).not.toContain(
      prose.lines[0].id,
    )
    expect(result.consumedRegionIds.has(prose.id)).toBe(false)
  })

  it.each([
    {
      name: 'one upright prose run with an equals sign',
      text: 'if x=y',
      segments: [
        { text: 'if ', width: 0.018, fontName: 'Synthetic-CMR12' },
        { text: 'x', width: 0.008, fontName: 'Synthetic-CMMI12' },
        { text: '=', width: 0.008, fontName: 'Synthetic-CMR12' },
        { text: 'y', width: 0.008, fontName: 'Synthetic-CMMI12' },
      ],
    },
    {
      name: 'one upright prose run with parentheses',
      text: 'if (x)',
      segments: [
        { text: 'if (', width: 0.026, fontName: 'Synthetic-CMR12' },
        { text: 'x', width: 0.008, fontName: 'Synthetic-CMMI12' },
        { text: ')', width: 0.006, fontName: 'Synthetic-CMR12' },
      ],
    },
    {
      name: 'an upright prose word split across source runs',
      text: 'if x=y',
      segments: [
        { text: 'i', width: 0.008, fontName: 'Synthetic-CMR12' },
        { text: 'f ', width: 0.01, fontName: 'Synthetic-CMR12' },
        { text: 'x', width: 0.008, fontName: 'Synthetic-CMMI12' },
        { text: '=', width: 0.008, fontName: 'Synthetic-CMR12' },
        { text: 'y', width: 0.008, fontName: 'Synthetic-CMMI12' },
      ],
    },
  ])(
    'rejects short Computer Modern prose with structural math punctuation: $name',
    async ({ name, text, segments }) => {
      const formula = equationRegion(
        `short-structural-prose-formula-${name}`,
        'f(x) = x',
        box(0.42, 0.47, 0.18, 0.018),
      )
      formula.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
      const prose = textRegion(
        `short-structural-prose-${name}`,
        text,
        box(0.605, 0.47, 0.075, 0.014),
      )
      let runX = prose.box.x
      prose.lines[0].runs = segments.map((segment) => {
        const run = {
          ...prose.lines[0].box,
          text: segment.text,
          x: runX,
          width: segment.width,
          fontName: segment.fontName,
          fontSize: 12,
          confidence: 1,
        }
        runX += segment.width
        return run
      })
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
        regions: [formula, prose],
        rasterizeFigure,
      })

      expect(result.relationships).toHaveLength(1)
      expect(result.relationships[0].sourceRegionIds).not.toContain(prose.id)
      expect(result.relationships[0].sourceLineIds).not.toContain(
        prose.lines[0].id,
      )
      expect(result.consumedRegionIds.has(prose.id)).toBe(false)
    },
  )

  it('owns a detached Computer Modern integrand beside its large operator', async () => {
    const integral = equationRegion(
      'jump-integral-large-operator',
      '∫',
      box(0.59889, 0.8615, 0.01116, 0.0142),
    )
    integral.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const formula = equationRegion(
      'jump-integral-formula',
      'dxt = μ(t, xt) dt + σb(t, xt) dWt +',
      box(0.27774, 0.88083, 0.3111, 0.01633),
    )
    formula.lines[0].runs[0].fontName = 'Synthetic-CMMI12'
    const integrand = textRegion(
      'jump-integral-integrand',
      'z N˜ (dt, dz),',
      box(0.6239, 0.87724, 0.09837, 0.01779),
    )
    integrand.lines[0].runs = [
      {
        ...integrand.lines[0].box,
        text: 'z N',
        width: 0.02912,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integrand.lines[0].box,
        text: '˜ (',
        x: 0.65302,
        width: 0.01774,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integrand.lines[0].box,
        text: 'dt, dz',
        x: 0.67076,
        width: 0.04549,
        fontName: 'Synthetic-CMMI12',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...integrand.lines[0].box,
        text: '),',
        x: 0.71625,
        width: 0.00602,
        fontName: 'Synthetic-CMR12',
        fontSize: 12,
        confidence: 1,
      },
    ]
    const domain = textRegion(
      'jump-integral-domain',
      'R',
      box(0.61004, 0.89838, 0.00967, 0.00947),
    )
    domain.lines[0].runs[0].fontName = 'Synthetic-MSBM10'
    const printedNumber = textRegion(
      'jump-integral-number',
      '(1)',
      box(0.85391, 0.88083, 0.02513, 0.0142),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 120,
          height: 24,
          pixels: new Uint8Array(120 * 24 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [integral, integrand, formula, printedNumber, domain],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      label: 'Equation 1',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        integral.id,
        integrand.id,
        formula.id,
        domain.id,
        printedNumber.id,
      ]),
      sourceText: '',
      altText: 'Equation 1',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    const crop = rasterizeFigure.mock.calls[0]![0].sourceBox
    for (const source of [
      integral,
      integrand,
      formula,
      domain,
      printedNumber,
    ]) {
      expect(containsSourceBox(crop, source.box)).toBe(true)
    }
    expect(result.consumedRegionIds.has(integrand.id)).toBe(true)
    expect(result.consumedRegionIds.has(domain.id)).toBe(true)
    expect(result.consumedRegionIds.has(printedNumber.id)).toBe(true)
  })

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

  it('keeps two close numbered equation components separate', async () => {
    const firstBase = equationRegion(
      'close-component-first-base',
      'a =',
      box(0.3, 0.4, 0.08, 0.018),
    )
    const firstTerm = textRegion(
      'close-component-first-term',
      'x',
      box(0.385, 0.4, 0.012, 0.014),
    )
    firstTerm.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const firstNumber = textRegion(
      'close-component-first-number',
      '(1)',
      box(0.86, 0.4, 0.025, 0.014),
    )
    const secondBase = equationRegion(
      'close-component-second-base',
      'b =',
      box(0.3, 0.436, 0.08, 0.018),
    )
    const secondTerm = textRegion(
      'close-component-second-term',
      'y',
      box(0.385, 0.436, 0.012, 0.014),
    )
    secondTerm.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const secondNumber = textRegion(
      'close-component-second-number',
      '(2)',
      box(0.86, 0.436, 0.025, 0.014),
    )
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
      regions: [
        secondNumber,
        firstTerm,
        secondBase,
        firstNumber,
        secondTerm,
        firstBase,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        label: 'Equation 1',
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([
          firstBase.id,
          firstTerm.id,
          firstNumber.id,
        ]),
      }),
      expect.objectContaining({
        label: 'Equation 2',
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([
          secondBase.id,
          secondTerm.id,
          secondNumber.id,
        ]),
      }),
    ])
    expect(result.relationships[0].sourceRegionIds).not.toContain(secondTerm.id)
    expect(result.relationships[1].sourceRegionIds).not.toContain(firstTerm.id)
  })

  it('suppresses singleton math fragments and inline math without display evidence', async () => {
    const singletonOperator = textRegion(
      'singleton-math-operator',
      '∑',
      box(0.3, 0.2, 0.018, 0.02),
    )
    singletonOperator.lines[0].runs[0].fontName =
      'Synthetic-STIXGeneral-Regular'
    const inlineMath = textRegion(
      'inline-math-prose',
      'The value x = 2 remains bounded.',
      box(0.2, 0.3, 0.4, 0.018),
    )
    inlineMath.lines[0].runs = [
      {
        ...inlineMath.lines[0].box,
        text: 'The value ',
        width: 0.08,
        fontName: 'Synthetic-CMR10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...inlineMath.lines[0].box,
        x: 0.28,
        width: 0.04,
        text: 'x = 2',
        fontName: 'Synthetic-CMMI10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...inlineMath.lines[0].box,
        x: 0.32,
        width: 0.14,
        text: ' remains bounded.',
        fontName: 'Synthetic-CMR10',
        fontSize: 10,
        confidence: 1,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [inlineMath, singletonOperator],
    })

    expect(result.relationships).toEqual([])
  })

  it('fails closed when prose is inseparable from an owned equation component', async () => {
    const display = equationRegion(
      'inseparable-component-display',
      'h = x + y',
      box(0.3, 0.5, 0.2, 0.02),
    )
    const overlappingProse = textRegion(
      'inseparable-component-prose',
      'where the bound holds',
      box(0.38, 0.5, 0.16, 0.018),
    )
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
      regions: [overlappingProse, display],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        status: 'unresolved',
        sourceRegionIds: [display.id],
        sourceLineIds: [display.lines[0].id],
        evidence: expect.arrayContaining([
          'source-proved-atomic-equation-component',
          'overlapping-unowned-source-text',
          'source-rendition-unavailable',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(overlappingProse.id)).toBe(false)
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

  it('fails equation matching closed when an inline stacked formula omits its sibling text fragments', async () => {
    const fragmentBaseId = 'page-001-inline-stacked-0001'
    const before = textRegion(
      'inline-stacked-before',
      'Caption text before',
      box(0.2, 0.52, 0.16, 0.018),
      'caption',
    )
    before.lines[0].id = `${fragmentBaseId}-before`
    const formula = equationRegion(
      'inline-stacked-formula',
      'h=x',
      box(0.37, 0.52, 0.05, 0.018),
    )
    formula.lines[0].id = `${fragmentBaseId}-formula`
    const after = textRegion(
      'inline-stacked-after',
      'and after',
      box(0.43, 0.52, 0.09, 0.018),
      'caption',
    )
    after.lines[0].id = `${fragmentBaseId}-after`
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
      regions: [before, formula, after],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        status: 'unresolved',
        sourceRegionIds: [],
        evidence: expect.arrayContaining(['incomplete-equation-source-scope']),
      }),
    ])
  })

  it.each(['added', 'dropped', 'mutated'] as const)(
    'rejects %s exclusion-mask metadata from an inline equation crop',
    async (maskDrift) => {
      const fragmentBaseId = 'page-001-inline-stacked-0002'
      const before = textRegion(
        'mask-bound-inline-before',
        'Before',
        box(0.2, 0.52, 0.169, 0.018),
      )
      before.lines[0].id = `${fragmentBaseId}-before`
      const formula = equationRegion(
        'mask-bound-inline-formula',
        'a/b = c',
        box(0.37, 0.52, 0.05, 0.018),
      )
      formula.lines[0].id = `${fragmentBaseId}-formula`
      formula.lines[0].runs = [
        {
          ...formula.lines[0].box,
          text: 'a',
          x: 0.37,
          y: 0.518,
          width: 0.012,
          height: 0.008,
          fontName: 'Synthetic-CMMI8',
          fontSize: 8,
          confidence: 1,
        },
        {
          ...formula.lines[0].box,
          text: 'b',
          x: 0.37,
          y: 0.53,
          width: 0.012,
          height: 0.008,
          fontName: 'Synthetic-CMMI8',
          fontSize: 8,
          confidence: 1,
        },
        {
          ...formula.lines[0].box,
          text: '= c',
          x: 0.389,
          y: 0.523,
          width: 0.031,
          height: 0.012,
          fontName: 'Synthetic-CMMI12',
          fontSize: 12,
          confidence: 1,
        },
      ]
      const after = textRegion(
        'mask-bound-inline-after',
        'after',
        box(0.421, 0.52, 0.08, 0.018),
      )
      after.lines[0].id = `${fragmentBaseId}-after`
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) => {
          if (maskDrift === 'dropped' && !input.excludedSourceBoxes?.length) {
            throw new Error('PDF page crop has source ink touching its edge')
          }
          expect(input.ownedSourceBoxes?.length).toBeGreaterThan(0)
          expect(input.excludedSourceBoxes).toHaveLength(2)
          const ownedSourceBoxes = input.ownedSourceBoxes!.map((sourceBox) => ({
            ...sourceBox,
          }))
          const excludedSourceBoxes = input.excludedSourceBoxes!.map(
            (sourceBox) => ({ ...sourceBox }),
          )
          if (maskDrift === 'mutated') {
            excludedSourceBoxes[0].x += Number.EPSILON
          } else if (maskDrift === 'added') {
            excludedSourceBoxes.push({
              page: 1,
              x: 0.1,
              y: 0.1,
              width: 0.01,
              height: 0.004,
              rotation: 0,
              method: 'pdf-text',
            })
          }
          return createSourcePageCropAsset({
            kind: 'equation',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 48,
            height: 14,
            pixels: new Uint8Array(48 * 14 * 4).fill(72),
            ...(maskDrift === 'dropped'
              ? {}
              : {
                  sourceExclusionMask: {
                    algorithm: 'nearest-source-box-v1',
                    expansionPixels: 2,
                    ownedSourceBoxes,
                    excludedSourceBoxes,
                  },
                }),
          })
        },
      )

      const result = await reconstructPdfVisuals({
        pages: [page([])],
        regions: [before, formula, after],
        rasterizeFigure,
      })

      if (maskDrift === 'dropped') {
        expect(rasterizeFigure.mock.calls.length).toBeGreaterThan(1)
        expect(
          rasterizeFigure.mock.calls.some(
            ([input]) => !input.excludedSourceBoxes?.length,
          ),
        ).toBe(true)
      } else {
        expect(rasterizeFigure).toHaveBeenCalledOnce()
      }
      expect(result.relationships).toEqual([
        expect.objectContaining({
          kind: 'equation',
          status: 'unresolved',
          assetIds: [],
          evidence: expect.arrayContaining(['source-rendition-unavailable']),
        }),
      ])
    },
  )

  it('does not let transitive math fragments bridge distinct numbered equations', async () => {
    const equationTwo = equationRegion(
      'transitive-equation-two',
      'Control = Σ',
      box(0.55, 0.31, 0.18, 0.02),
    )
    const equationTwoNumber = textRegion(
      'transitive-equation-two-number',
      '(2)',
      box(0.86, 0.33, 0.025, 0.014),
    )
    const bridge = textRegion(
      'transitive-equation-math-bridge',
      '∫₀¹ f(x) dx / |A|',
      box(0.7, 0.35, 0.06, 0.014),
    )
    bridge.lines[0].runs[0].fontName = 'Synthetic-CMMI10'
    const equationThree = equationRegion(
      'transitive-equation-three',
      'Loss = ∫₀∞ q(x) dx',
      box(0.55, 0.39, 0.18, 0.02),
    )
    const equationThreeNumber = textRegion(
      'transitive-equation-three-number',
      '(3)',
      box(0.86, 0.4, 0.025, 0.014),
    )
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
      regions: [
        equationTwo,
        equationTwoNumber,
        bridge,
        equationThree,
        equationThreeNumber,
      ],
      rasterizeFigure,
    })

    expect(
      result.relationships.map((relationship) => relationship.label),
    ).toEqual(['Equation 2', 'Equation 3'])
    expect(
      result.relationships.map((relationship) =>
        relationship.sourceRegionIds.includes(bridge.id),
      ),
    ).toEqual([true, false])
    expect(result.relationships).toEqual([
      expect.objectContaining({
        label: 'Equation 2',
        status: 'matched',
        assetIds: [expect.any(String)],
        sourceRegionIds: expect.arrayContaining([
          equationTwo.id,
          equationTwoNumber.id,
          bridge.id,
        ]),
      }),
      expect.objectContaining({
        label: 'Equation 3',
        status: 'matched',
        assetIds: [expect.any(String)],
        sourceRegionIds: expect.arrayContaining([
          equationThree.id,
          equationThreeNumber.id,
        ]),
      }),
    ])
    const cropInputs = rasterizeFigure.mock.calls.map(([input]) => input)
    expect(cropInputs).toHaveLength(2)
    expect(containsSourceBox(cropInputs[0].sourceBox, equationTwo.box)).toBe(
      true,
    )
    expect(
      containsSourceBox(cropInputs[0].sourceBox, equationTwoNumber.box),
    ).toBe(true)
    expect(containsSourceBox(cropInputs[0].sourceBox, bridge.box)).toBe(true)
    expect(containsSourceBox(cropInputs[0].sourceBox, equationThree.box)).toBe(
      false,
    )
    expect(containsSourceBox(cropInputs[1].sourceBox, equationThree.box)).toBe(
      true,
    )
    expect(
      containsSourceBox(cropInputs[1].sourceBox, equationThreeNumber.box),
    ).toBe(true)
    expect(containsSourceBox(cropInputs[1].sourceBox, bridge.box)).toBe(false)
    expect(result.consumedRegionIds.has(bridge.id)).toBe(true)
  })

  it('keeps an equation unresolved when an adjacent math fragment has ambiguous ownership', async () => {
    const first = equationRegion(
      'ambiguous-scope-first',
      'a = b',
      box(0.2, 0.1, 0.24, 0.014),
    )
    const second = equationRegion(
      'ambiguous-scope-second',
      'c = d',
      box(0.2, 0.14, 0.24, 0.014),
    )
    const ambiguousDomain = textRegion(
      'ambiguous-scope-domain',
      'R',
      box(0.3, 0.123, 0.012, 0.008),
    )
    ambiguousDomain.lines[0].runs[0].fontName = 'Synthetic-MSBM10'
    const whereBody = textRegion(
      'ambiguous-scope-where-body',
      'where t is the observation time',
      box(0.47, 0.123, 0.24, 0.012),
    )
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
      regions: [first, ambiguousDomain, whereBody, second],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.every(
        (relationship) => relationship.status === 'unresolved',
      ),
    ).toBe(true)
    expect(result.consumedRegionIds.has(ambiguousDomain.id)).toBe(false)
    expect(result.consumedRegionIds.has(whereBody.id)).toBe(false)
    expect(
      result.relationships.every(
        (relationship) =>
          !relationship.sourceRegionIds.includes(ambiguousDomain.id) &&
          !relationship.sourceRegionIds.includes(whereBody.id),
      ),
    ).toBe(true)
  })

  it('keeps aligned equations in opposite columns as separate displays', async () => {
    const left: PdfPageRegion = equationRegion(
      'equation-left-column',
      'a = b',
      box(0.1, 0.31, 0.3, 0.02),
    )
    left.column = 'left'
    const right: PdfPageRegion = equationRegion(
      'equation-right-column',
      'c = d',
      box(0.52, 0.31, 0.3, 0.02),
    )
    right.column = 'right'
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
      regions: [left, right],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.map(({ sourceRegionIds }) => sourceRegionIds),
    ).toEqual([[left.id], [right.id]])
  })

  it('retries an edge-touching equation crop inside neighboring prose', async () => {
    const precedingProse = textRegion(
      'equation-preceding-prose',
      'The variable backs off to the baseline when the program errs:',
      box(0.17647, 0.2489, 0.64706, 0.01258),
    )
    const equation = equationRegion(
      'equation-piecewise-value',
      'y = \u001aρx',
      box(0.41481, 0.26492, 0.05178, 0.03879),
    )
    equation.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const condition = equationRegion(
      'equation-piecewise-condition',
      'if [ρ] = x,',
      box(0.49826, 0.27453, 0.06746, 0.01258),
    )
    const followingProse = textRegion(
      'equation-following-prose',
      'We define the following metrics:',
      box(0.17647, 0.31599, 0.2126, 0.01258),
    )
    const previousBottom = precedingProse.box.y + precedingProse.box.height
    const followingTop = followingProse.box.y
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        if (
          input.sourceBox.y < previousBottom ||
          cropBottom > followingTop ||
          input.sourceBox.x > 0.403 ||
          cropRight < 0.577
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 14,
          pixels: new Uint8Array(48 * 14 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, equation, condition, followingProse],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.map(([input]) =>
        Math.round((equation.box.x - input.sourceBox.x) * 1_000),
      ),
    ).toEqual([4, 6, 8, 10, 12])
    const retry = rasterizeFigure.mock.calls.at(-1)![0].sourceBox
    expect(retry.y).toBeGreaterThanOrEqual(previousBottom)
    expect(retry.y + retry.height).toBeLessThanOrEqual(followingTop)
    expect(retry.x).toBeLessThanOrEqual(0.403)
    expect(retry.x + retry.width).toBeGreaterThanOrEqual(0.577)
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      sourceRegionIds: [equation.id, condition.id],
      sourceText: '',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
        'source-text-transcript-unresolved',
      ]),
    })
  })

  it('fails an adaptive equation crop closed before it encloses overlapping following prose', async () => {
    const equation = equationRegion(
      'equation-with-overlapping-neighbor',
      'z = ab',
      box(0.3, 0.4, 0.2, 0.02),
    )
    equation.lines[0].runs = [
      {
        ...equation.lines[0].box,
        text: 'z = ',
        x: 0.32,
        y: 0.405,
        width: 0.06,
        height: 0.012,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 12,
        confidence: 1,
      },
      {
        ...equation.lines[0].box,
        text: 'a',
        x: 0.39,
        y: 0.4,
        width: 0.014,
        height: 0.007,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
      {
        ...equation.lines[0].box,
        text: 'b',
        x: 0.39,
        y: 0.413,
        width: 0.014,
        height: 0.007,
        fontName: 'Synthetic-Math-Regular',
        fontSize: 8,
        confidence: 1,
      },
    ]
    const followingProse = textRegion(
      'overlapping-equation-following-prose',
      'The next sentence remains canonical prose.',
      box(0.1, 0.4195, 0.7, 0.015),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const padding = equation.box.x - input.sourceBox.x
        if (padding < 0.012) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 18,
          pixels: new Uint8Array(64 * 18 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [equation, followingProse],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      assetIds: [],
      sourceText: '',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-unowned-text',
        'source-rendition-unavailable',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('bounds the initial equation crop away from adjacent canonical prose', async () => {
    const equation = equationRegion(
      'equation-near-following-prose',
      'q = r',
      box(0.2, 0.4, 0.5, 0.02),
    )
    const followingProse = textRegion(
      'equation-immediate-following-prose',
      'This prose begins two thousandths below the display.',
      box(0.1, 0.422, 0.7, 0.02),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 12,
          pixels: new Uint8Array(64 * 12 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [equation, followingProse],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const attempted = rasterizeFigure.mock.calls[0][0].sourceBox
    expect(attempted.y + attempted.height).toBeLessThanOrEqual(
      followingProse.box.y,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining(['source-page-crop-neighbor-bounded']),
    })
  })

  it('uses the smallest deterministic equation padding that clears source ink', async () => {
    const equation = equationRegion(
      'equation-wide-overhang',
      'q = r',
      box(0.17647, 0.67613, 0.51265, 0.01258),
    )
    const followingProse = textRegion(
      'equation-wide-following-prose',
      'The next paragraph must remain outside the equation crop.',
      box(0.17647, 0.70367, 0.51265, 0.01258),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const padding = equation.box.x - input.sourceBox.x
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        if (padding < 0.0135 || cropBottom > followingProse.box.y) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 12,
          pixels: new Uint8Array(96 * 12 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [equation, followingProse],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.map(([input]) =>
        Math.round((equation.box.x - input.sourceBox.x) * 1_000),
      ),
    ).toEqual([4, 6, 8, 10, 12, 14])
    expect(
      rasterizeFigure.mock.calls.at(-1)![0].sourceBox.y +
        rasterizeFigure.mock.calls.at(-1)![0].sourceBox.height,
    ).toBeLessThanOrEqual(followingProse.box.y)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-adaptive-padding',
      ]),
    })
  })

  it('uses more safe interline whitespace when a dense equation crop still touches ink', async () => {
    const precedingProse = textRegion(
      'dense-equation-preceding-prose',
      'The dense line immediately above remains canonical prose.',
      box(0.1, 0.63, 0.7, 0.018),
    )
    const equation = equationRegion(
      'dense-equation-with-raised-script',
      'cos(k/2(a + b)) to cos(k(a + b)).',
      box(0.1, 0.65, 0.32, 0.024),
    )
    equation.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const followingProse = textRegion(
      'dense-equation-following-prose',
      'The dense line immediately below also remains canonical prose.',
      box(0.1, 0.68, 0.7, 0.018),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (input.sourceBox.y > 0.649) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 16,
          pixels: new Uint8Array(96 * 16 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, equation, followingProse],
      rasterizeFigure,
    })

    const retained = rasterizeFigure.mock.calls.at(-1)![0].sourceBox
    expect(rasterizeFigure).toHaveBeenCalledTimes(9)
    expect(retained.y).toBe(0.649)
    expect(retained.y).toBeGreaterThan(
      precedingProse.box.y + precedingProse.box.height,
    )
    expect(retained.y + retained.height).toBeLessThan(followingProse.box.y)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-adaptive-padding',
        'source-page-crop-neighbor-bounded',
      ]),
    })
  })

  it('does not clear one neighbor by crossing the opposite prose edge', async () => {
    const precedingProse = textRegion(
      'equation-shifted-preceding',
      'Preceding prose.',
      box(0.1, 0.38, 0.6, 0.015),
    )
    const equation = equationRegion(
      'equation-shifted-source',
      'S\u0000x\u0001 = y',
      box(0.2, 0.4, 0.5, 0.03),
    )
    equation.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    const followingProse = textRegion(
      'equation-shifted-following',
      'Following prose.',
      box(0.1, 0.434, 0.6, 0.015),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const bottom = input.sourceBox.y + input.sourceBox.height
        if (input.sourceBox.y < 0.397 || bottom < 0.435) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 14,
          pixels: new Uint8Array(64 * 14 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, equation, followingProse],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      assetIds: [],
      evidence: expect.arrayContaining(['source-rendition-unavailable']),
    })
    expect(rasterizeFigure.mock.calls.length).toBeLessThanOrEqual(11)
    for (const [input] of rasterizeFigure.mock.calls.slice(1)) {
      expect(input.sourceBox.y).toBeGreaterThanOrEqual(
        precedingProse.box.y + precedingProse.box.height,
      )
      expect(input.sourceBox.y + input.sourceBox.height).toBeLessThanOrEqual(
        followingProse.box.y,
      )
    }
  })

  it('uses one exact native asset while vetoing a crop across canonical prose', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-loose-prose-scope',
      sourceBox,
    )
    const orderedProse = textRegion(
      'ordered-prose-region',
      'A small canonical paragraph fragment remains in reading order.',
      box(0.2, 0.24, 0.22, 0.025),
    )
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

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-loose-prose-scope',
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
          'loose-prose-vector-region',
          'vector-p001-loose-prose-scope',
          sourceBox,
        ),
        orderedProse,
        captionRegion(
          'Figure 1. Loose native scope around canonical prose.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-loose-prose-scope'],
      assetIds: [vector.id],
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
        'native-only-exact-rendition',
      ]),
    })
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
  })

  it('uses a native-only headless composite while vetoing ordered page text', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAssets = await Promise.all(
      boxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-safe-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(index === 0 ? 64 : 192),
        }),
      ),
    )
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-safe-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const orderedProse = textRegion(
      'ordered-composite-prose-region',
      'Canonical prose inside a loose composite scope stays in flow.',
      box(0.24, 0.2, 0.16, 0.02),
    )
    const nonFlowLabel = textRegion(
      'non-flow-composite-label-region',
      'State D',
      box(0.28, 0.24, 0.08, 0.015),
      'chart-label',
    )
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

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`safe-fragment-${index + 1}`, object.id, object.box),
        ),
        orderedProse,
        nonFlowLabel,
        captionRegion(
          'Figure 1. Native-only composite near canonical prose.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: ['safe-fragment-1', 'safe-fragment-2'],
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
        'headless-composite-raster',
      ]),
      candidates: [
        expect.objectContaining({
          sourceObjectIds: [
            ...objects.map((object) => object.id),
            'text-overlay:non-flow-composite-label-region',
          ],
        }),
      ],
    })
    const composite = result.assets.find(
      (asset) => asset.id === result.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      rendition: 'browser-composite-raster',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    expect(
      composite.sourceObjectIds.some((id) => id.startsWith('text-overlay:')),
    ).toBe(false)
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
    expect(result.consumedRegionIds.has(nonFlowLabel.id)).toBe(false)
  })

  it('keeps an incomplete native fragment set unresolved without page crop', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAsset = await createPngAsset({
      sourceObjectId: 'image-p001-incomplete-001',
      sourceBox: boxes[0],
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(64),
    })
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-incomplete-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: index === 0 ? sourceAsset.id : null,
    }))
    const orderedProse = textRegion(
      'ordered-incomplete-prose-region',
      'Canonical prose cannot authorize a missing native fragment.',
      box(0.24, 0.2, 0.16, 0.02),
    )
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

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [sourceAsset])],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `incomplete-fragment-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        orderedProse,
        captionRegion(
          'Figure 1. Incomplete native fragment set.',
          box(0.2, 0.32, 0.25, 0.025),
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
        'source-page-crop-vetoed-reading-order-text',
        'source-rendition-unavailable',
      ]),
    })
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
  })

  it('still matches and consumes safe non-flow diagram labels', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-non-flow-label',
      sourceBox,
    )
    const nonFlowLabel = {
      ...textRegion(
        'non-flow-chart-label-region',
        'State C',
        box(0.24, 0.22, 0.16, 0.025),
        'chart-label',
      ),
      includedInReadingOrder: false,
    } satisfies PdfPageRegion
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

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-non-flow-label',
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
          'non-flow-label-vector-region',
          'vector-p001-non-flow-label',
          sourceBox,
        ),
        nonFlowLabel,
        captionRegion(
          'Figure 1. Diagram with a non-flow label.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-non-flow-label',
        'text-overlay:non-flow-chart-label-region',
      ],
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(result.consumedRegionIds.has(nonFlowLabel.id)).toBe(true)
  })

  it('clips loose source-object lineage at the caption boundary before an exact crop', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.23)
    const subprecisionCaptionOverlap = box(0.3, 0.379997, 0.1, 0.01)
    const vector = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-caption-overlap',
      sourceBox,
      path: 'M 0 0 L 40 0 L 20 30 Z',
      viewBox: { x: 0, y: 0, width: 40, height: 30 },
      paint: 'fill-stroke',
    })
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

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-caption-overlap',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
            {
              id: 'vector-p001-subprecision-overlap',
              page: 1,
              kind: 'vector',
              box: subprecisionCaptionOverlap,
              confidence: 0.98,
              assetId: null,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-caption-overlap', sourceBox),
        objectRegion(
          'subprecision-vector-region',
          'vector-p001-subprecision-overlap',
          subprecisionCaptionOverlap,
        ),
        captionRegion(
          'Figure 1. Caption overlaps the loose source-object box.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: ['vector-region'],
      sourceObjectIds: ['vector-p001-caption-overlap'],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining([
        'source-lineage-clipped-to-render-scope',
        'source-page-crop',
      ]),
      candidates: [
        expect.objectContaining({
          sourceRegionIds: ['vector-region', 'subprecision-vector-region'],
          sourceObjectIds: [
            'vector-p001-caption-overlap',
            'vector-p001-subprecision-overlap',
          ],
        }),
      ],
    })
    const cropInput = rasterizeFigure.mock.calls[0]![0]
    expect(
      cropInput.sourceBox.y + cropInput.sourceBox.height,
    ).toBeLessThanOrEqual(result.relationships[0].sourceBoxes[0].y)
    expect(cropInput.sourceBoxes).toEqual([
      expect.objectContaining({
        x: sourceBox.x,
        y: sourceBox.y,
        width: sourceBox.width,
        height: expect.any(Number),
      }),
    ])
    expect(
      cropInput.sourceBoxes[0].y + cropInput.sourceBoxes[0].height,
    ).toBeLessThanOrEqual(cropInput.sourceBox.y + cropInput.sourceBox.height)
    expect(
      cropInput.sourceBoxes.every(
        (source) => source.width > 0 && source.height > 0,
      ),
    ).toBe(true)
  })

  it('records a bounded safe reason when source crop rasterization fails', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const sourceAsset = sourcePreservedSvgAsset(
      'vector-p001-raster-failure',
      sourceBox,
    )
    const sourceAssetLayer = sourcePreservedSvgAsset(
      'vector-p001-raster-failure-layer',
      sourceBox,
    )
    const distractorBox = box(0.55, 0.02, 0.08, 0.08)
    const distractorAsset = sourcePreservedSvgAsset(
      'vector-p001-raster-failure-distractor',
      distractorBox,
    )
    const rasterizeFigure = vi.fn(async () => {
      throw new Error('Source page crop contains no nontrivial source ink')
    })
    const diagramLabels = [
      textRegion('diagram-label', 'state', box(0.3, 0.205, 0.06, 0.012)),
      textRegion('diagram-label-2', 'transition', box(0.3, 0.22, 0.08, 0.012)),
      textRegion(
        'diagram-label-3',
        'instructions',
        box(0.3, 0.235, 0.09, 0.012),
      ),
    ]

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-raster-failure',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAsset.id,
            },
            {
              id: 'vector-p001-raster-failure-layer',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAssetLayer.id,
            },
            {
              id: 'vector-p001-raster-failure-distractor',
              page: 1,
              kind: 'vector',
              box: distractorBox,
              confidence: 0.98,
              assetId: distractorAsset.id,
            },
          ],
          1,
          [sourceAsset, sourceAssetLayer, distractorAsset],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-raster-failure', sourceBox),
        objectRegion(
          'vector-region-layer',
          'vector-p001-raster-failure-layer',
          sourceBox,
        ),
        objectRegion(
          'vector-region-distractor',
          'vector-p001-raster-failure-distractor',
          distractorBox,
        ),
        ...diagramLabels,
        captionRegion(
          'Figure 1. Bounded source crop failure.',
          box(0.2, 0.32, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0].candidates).toHaveLength(2)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceText: 'state transition instructions',
      evidence: expect.arrayContaining([
        'source-page-crop-payload-rejected',
        'unresolved-visual-text-owned',
        'source-rendition-unavailable',
      ]),
    })
    expect(
      diagramLabels.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
  })

  it('owns only render-contained overlays when a strong figure rendition remains unresolved', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const firstAsset = sourcePreservedSvgAsset(
      'vector-p001-contained-overlay-a',
      sourceBox,
    )
    const secondAsset = sourcePreservedSvgAsset(
      'vector-p001-contained-overlay-b',
      sourceBox,
    )
    const containedOverlays = [
      textRegion('contained-overlay-a', 'alpha', box(0.3, 0.205, 0.06, 0.012)),
      textRegion('contained-overlay-b', 'beta', box(0.3, 0.22, 0.08, 0.012)),
      textRegion('contained-overlay-c', 'gamma', box(0.3, 0.235, 0.09, 0.012)),
    ]
    const outsideRenderOverlay = textRegion(
      'outside-render-overlay',
      'neighboring table row',
      box(0.3, 0.177, 0.12, 0.012),
    )
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Contained overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'contained-overlay-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-contained-overlay-a',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: firstAsset.id,
            },
            {
              id: 'vector-p001-contained-overlay-b',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: secondAsset.id,
            },
          ],
          1,
          [firstAsset, secondAsset],
        ),
      ],
      regions: [
        objectRegion(
          'contained-overlay-vector-a',
          'vector-p001-contained-overlay-a',
          sourceBox,
        ),
        objectRegion(
          'contained-overlay-vector-b',
          'vector-p001-contained-overlay-b',
          sourceBox,
        ),
        outsideRenderOverlay,
        ...containedOverlays,
        figureCaption,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'unresolved',
        sourceRegionIds: containedOverlays.map((region) => region.id),
        sourceLineIds: containedOverlays.map((region) => region.lines[0].id),
        sourceText: 'alpha beta gamma',
        sourceBoxes: [
          figureCaption.box,
          ...containedOverlays.map((region) => region.box),
        ],
        evidence: expect.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
          'unresolved-visual-text-owned',
          'source-rendition-unavailable',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(outsideRenderOverlay.id)).toBe(false)
    expect(
      containedOverlays.every((region) =>
        result.consumedRegionIds.has(region.id),
      ),
    ).toBe(true)
  })

  it('retains only contained lines from a partially enclosed figure overlay region', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-partial-overlay-a',
      'vector-p001-partial-overlay-b',
      'vector-p001-partial-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const partialOverlay = textRegion(
      'partial-overlay-region',
      'outside label inside alpha inside beta',
      box(0.3, 0.1772, 0.12, 0.06),
    )
    const overlayLine = (
      id: string,
      text: string,
      sourceLineBox: NormalizedSourceBox,
    ) => {
      const textBox = { ...sourceLineBox, method: 'pdf-text' as const }
      return {
        id,
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
      }
    }
    const outsideLine = overlayLine(
      'partial-overlay-outside-line',
      'outside label',
      box(0.3, 0.1772, 0.12, 0.004),
    )
    const containedLines = [
      overlayLine(
        'partial-overlay-inside-line-a',
        'inside alpha',
        box(0.3, 0.205, 0.12, 0.012),
      ),
      overlayLine(
        'partial-overlay-inside-line-b',
        'inside beta',
        box(0.3, 0.225, 0.12, 0.012),
      ),
    ]
    partialOverlay.lines = [outsideLine, ...containedLines]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Partial overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'partial-overlay-caption',
    }
    const retainedOverlayBox = {
      ...box(0.3, 0.205, 0.12, 0.032),
      method: 'pdf-text' as const,
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `partial-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        partialOverlay,
        figureCaption,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'unresolved',
        sourceRegionIds: [partialOverlay.id],
        sourceLineIds: containedLines.map((line) => line.id),
        sourceText: 'inside alpha inside beta',
        sourceBoxes: [figureCaption.box, retainedOverlayBox],
        evidence: expect.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
          'unresolved-visual-text-owned',
          'source-rendition-unavailable',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(partialOverlay.id)).toBe(false)
    expect(result.consumedLineIds.has(outsideLine.id)).toBe(false)
    expect(
      containedLines.every((line) => result.consumedLineIds.has(line.id)),
    ).toBe(true)
  })

  it('consumes only retained lines from a partially enclosed matched figure overlay', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-matched-partial-overlay-a',
      'vector-p001-matched-partial-overlay-b',
      'vector-p001-matched-partial-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const partialOverlay = textRegion(
      'matched-partial-overlay-region',
      'outside label inside alpha inside beta',
      box(0.3, 0.1772, 0.12, 0.06),
    )
    const overlayLine = (
      id: string,
      text: string,
      sourceLineBox: NormalizedSourceBox,
    ) => {
      const textBox = { ...sourceLineBox, method: 'pdf-text' as const }
      return {
        id,
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
      }
    }
    const outsideLine = overlayLine(
      'matched-partial-overlay-outside-line',
      'outside label',
      box(0.3, 0.1772, 0.12, 0.004),
    )
    const containedLines = [
      overlayLine(
        'matched-partial-overlay-inside-line-a',
        'inside alpha',
        box(0.3, 0.205, 0.12, 0.012),
      ),
      overlayLine(
        'matched-partial-overlay-inside-line-b',
        'inside beta',
        box(0.3, 0.225, 0.12, 0.012),
      ),
    ]
    partialOverlay.lines = [outsideLine, ...containedLines]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Matched partial overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'matched-partial-overlay-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `matched-partial-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        partialOverlay,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        }),
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'matched',
        sourceRegionIds: expect.arrayContaining([partialOverlay.id]),
        sourceLineIds: containedLines.map((line) => line.id),
        sourceText: 'inside alpha inside beta',
        evidence: expect.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
          'source-page-crop',
        ]),
      }),
    ])
    expect(result.consumedRegionIds.has(partialOverlay.id)).toBe(false)
    expect(result.consumedLineIds.has(outsideLine.id)).toBe(false)
    expect(
      containedLines.every((line) => result.consumedLineIds.has(line.id)),
    ).toBe(true)
  })

  it('records exact line atoms when every matched figure overlay is retained', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-complete-overlay-a',
      'vector-p001-complete-overlay-b',
      'vector-p001-complete-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const overlays = [
      textRegion(
        'complete-overlay-a',
        'inside alpha',
        box(0.3, 0.205, 0.12, 0.012),
      ),
      textRegion(
        'complete-overlay-b',
        'inside beta',
        box(0.3, 0.225, 0.12, 0.012),
      ),
    ]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Complete overlay ownership.',
        box(0.2, 0.32, 0.5, 0.025),
      ),
      id: 'complete-overlay-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `complete-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        ...overlays,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        }),
    })

    const expectedLineIds = overlays.map((region) => region.lines[0].id)
    expect(result.relationships).toEqual([
      expect.objectContaining({
        kind: 'figure',
        status: 'matched',
        sourceLineIds: expectedLineIds,
        sourceText: 'inside alpha inside beta',
        evidence: expect.not.arrayContaining([
          'caption-bounded-overlay-lineage-trimmed',
        ]),
        candidates: [
          expect.objectContaining({
            sourceLineIds: expectedLineIds,
            sourceText: 'inside alpha inside beta',
          }),
        ],
      }),
    ])
    expect(
      overlays.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
  })

  it('does not give contested unresolved figure overlays to either caption', async () => {
    const sourceBox = box(0.2, 0.18, 0.36, 0.12)
    const sourceObjectIds = [
      'vector-p001-contested-overlay-a',
      'vector-p001-contested-overlay-b',
    ]
    const assets = sourceObjectIds.map((sourceObjectId) =>
      sourcePreservedSvgAsset(sourceObjectId, sourceBox),
    )
    const overlays = [
      textRegion(
        'contested-overlay-a',
        'shared alpha',
        box(0.27, 0.21, 0.09, 0.012),
      ),
      textRegion(
        'contested-overlay-b',
        'shared beta',
        box(0.39, 0.24, 0.09, 0.012),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. First possible owner.',
          box(0.2, 0.32, 0.36, 0.02),
        ),
        id: 'contested-overlay-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Second possible owner.',
          box(0.2, 0.355, 0.36, 0.02),
        ),
        id: 'contested-overlay-caption-b',
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: sourceBox,
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(`contested-overlay-vector-${index + 1}`, id, sourceBox),
        ),
        ...overlays,
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    for (const [index, relationship] of result.relationships.entries()) {
      expect(relationship).toMatchObject({
        kind: 'figure',
        captionRegionId: captions[index].id,
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
        sourceBoxes: [captions[index].box],
      })
      expect(relationship.evidence).not.toContain(
        'unresolved-visual-text-owned',
      )
    }
    expect(
      overlays.every(
        (region) =>
          !result.consumedRegionIds.has(region.id) &&
          !result.consumedLineIds.has(region.lines[0].id),
      ),
    ).toBe(true)
  })

  it('does not split duplicate overlay lineage between semantic and connected candidates', async () => {
    const layerBoxes = [
      box(0.2, 0.18, 0.5, 0.12),
      box(0.205, 0.185, 0.49, 0.11),
      box(0.21, 0.19, 0.48, 0.1),
    ]
    const sourceObjectIds = [
      'vector-p001-cross-candidate-overlay-a',
      'vector-p001-cross-candidate-overlay-b',
      'vector-p001-cross-candidate-overlay-c',
    ]
    const assets = sourceObjectIds.map((sourceObjectId, index) =>
      sourcePreservedSvgAsset(sourceObjectId, layerBoxes[index]),
    )
    const overlays = [
      textRegion(
        'cross-candidate-overlay-a',
        'shared alpha',
        box(0.26, 0.205, 0.09, 0.012),
      ),
      textRegion(
        'cross-candidate-overlay-b',
        'shared beta',
        box(0.38, 0.22, 0.09, 0.012),
      ),
      textRegion(
        'cross-candidate-overlay-c',
        'shared gamma',
        box(0.5, 0.235, 0.09, 0.012),
      ),
      textRegion(
        'cross-candidate-overlay-d',
        'shared delta',
        box(0.32, 0.255, 0.12, 0.012),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. Semantic-envelope owner.',
          box(0.2, 0.32, 0.5, 0.02),
        ),
        id: 'cross-candidate-overlay-caption-a',
      },
      {
        ...captionRegion(
          'Figure 2. Connected-scaffold owner.',
          box(0.2, 0.355, 0.5, 0.02),
        ),
        id: 'cross-candidate-overlay-caption-b',
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: layerBoxes[index],
            confidence: 0.98,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `cross-candidate-overlay-vector-${index + 1}`,
            id,
            layerBoxes[index],
          ),
        ),
        ...overlays,
        ...captions,
      ],
      rasterizeFigure: async () => {
        throw new Error('Source page crop contains no nontrivial source ink')
      },
    })

    expect(result.relationships).toHaveLength(2)
    expect(result.relationships[0].candidates[0].evidence).toContain(
      'caption-bounded-semantic-envelope',
    )
    expect(result.relationships[1].candidates[0].evidence).toContain(
      'connected-native-scaffold',
    )
    for (const [index, relationship] of result.relationships.entries()) {
      expect(relationship).toMatchObject({
        kind: 'figure',
        captionRegionId: captions[index].id,
        status: 'unresolved',
        sourceRegionIds: [],
        sourceLineIds: [],
        sourceText: '',
        sourceBoxes: [captions[index].box],
      })
      expect(relationship.evidence).not.toContain(
        'unresolved-visual-text-owned',
      )
    }
    expect(
      overlays.every(
        (region) =>
          !result.consumedRegionIds.has(region.id) &&
          !result.consumedLineIds.has(region.lines[0].id),
      ),
    ).toBe(true)
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

  it('expands a text-owned table crop through distant horizontal rules while staying between neighboring prose', async () => {
    const precedingProse = textRegion(
      'wide-rule-table-preceding-prose',
      'The preceding paragraph remains outside the table rendition.',
      box(0.1, 0.5, 0.8, 0.014),
    )
    const caption = {
      ...captionRegion(
        'Table 1. A text-owned table with rules wider than its cell text.',
        box(0.1, 0.52, 0.8, 0.025),
      ),
      id: 'wide-rule-table-caption',
    }
    const rows = Array.from({ length: 7 }, (_, index) => {
      const region = textRegion(
        `wide-rule-table-row-${index + 1}`,
        `Metric ${index + 1}  ${40 + index}.0  ${70 + index}.0`,
        box(0.2, 0.55 + index * 0.016, 0.48, 0.012),
      )
      region.lines[0].fontSize = 8
      region.lines[0].runs[0] = {
        ...region.lines[0].runs[0],
        fontName: 'TableSerif-Regular',
        fontSize: 8,
      }
      const baseRun = region.lines[0].runs[0]
      region.lines[0].runs = [
        {
          ...baseRun,
          text: `Metric ${index + 1}`,
          x: 0.2,
          width: 0.14,
        },
        {
          ...baseRun,
          text: `${40 + index}.0`,
          x: 0.45,
          width: 0.05,
        },
        {
          ...baseRun,
          text: `${70 + index}.0`,
          x: 0.6,
          width: 0.05,
        },
      ]
      return region
    })
    const followingProse = textRegion(
      'wide-rule-table-following-prose',
      'The following paragraph also remains canonical prose.',
      box(0.1, 0.72, 0.8, 0.014),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        if (input.sourceBox.x > 0.19 || cropRight < 0.78) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        if (
          input.sourceBox.y <
            precedingProse.box.y + precedingProse.box.height - 0.00001 ||
          input.sourceBox.y + input.sourceBox.height >
            followingProse.box.y + 0.00001
        ) {
          throw new Error('table crop crossed neighboring prose')
        }
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 180,
          height: 80,
          pixels: new Uint8Array(180 * 80 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, caption, ...rows, followingProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    const retainedCrop = rasterizeFigure.mock.calls.at(-1)?.[0].sourceBox
    expect(retainedCrop?.x).toBeLessThanOrEqual(0.19)
    expect(
      retainedCrop ? retainedCrop.x + retainedCrop.width : 0,
    ).toBeGreaterThanOrEqual(0.78)
    expect(retainedCrop?.y).toBeGreaterThanOrEqual(
      precedingProse.box.y + precedingProse.box.height - 0.00001,
    )
    expect(
      retainedCrop ? retainedCrop.y + retainedCrop.height : 1,
    ).toBeLessThanOrEqual(followingProse.box.y + 0.00001)
    expect(
      rasterizeFigure.mock.calls.every(([input]) => {
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        return (
          input.sourceBox.y >=
            precedingProse.box.y + precedingProse.box.height - 0.00001 &&
          cropBottom <= followingProse.box.y + 0.00001
        )
      }),
    ).toBe(true)
    expect(relationship).toMatchObject({
      status: 'matched',
      sourceRegionIds: rows.map((row) => row.id),
      sourceLineIds: rows.map((row) => row.lines[0].id),
      sourceText: rows.map((row) => row.text).join(' '),
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
    expect(result.consumedRegionIds.has(precedingProse.id)).toBe(false)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('uses a neighbor-bounded caption-text-slab envelope before accepting an initially successful crop', async () => {
    const topRuleY = 0.17
    const bottomRuleY = 0.373
    const precedingProse = textRegion(
      'initial-success-table-preceding-prose',
      'The preceding paragraph remains outside the table rendition.',
      box(0.12, 0.143, 0.324, 0.016),
    )
    const captionBox = box(0.12, 0.38, 0.68, 0.02)
    const captionText = 'Table 4. Source-authored prompt template.'
    const caption = {
      ...captionRegion(captionText, captionBox),
      id: 'initial-success-table-caption',
      lines: [
        textRegion(
          'initial-success-table-caption-line',
          captionText,
          captionBox,
        ).lines[0],
      ],
    }
    const slab = textRegion(
      'initial-success-table-slab',
      'Field 1: structured table value',
      box(0.12, 0.18, 0.68, 0.184),
    )
    const baseLine = slab.lines[0]
    slab.lines = Array.from({ length: 8 }, (_, index) => {
      const sourceBox = {
        ...box(0.12, 0.18 + index * 0.024, 0.68 - index * 0.02, 0.016),
        method: 'pdf-text' as const,
      }
      const text = `Field ${index + 1}: structured table value`
      return {
        ...baseLine,
        id: `initial-success-table-line-${index + 1}`,
        text,
        box: sourceBox,
        fontSize: 9,
        runs: [
          {
            ...baseLine.runs[0],
            ...sourceBox,
            text,
            fontName: 'PromptSerif-Bold',
            fontSize: 9,
            bold: true,
          },
        ],
      }
    })
    slab.text = slab.lines.map((line) => line.text).join(' ')
    const followingProse = textRegion(
      'initial-success-table-following-prose',
      'The following paragraph also remains canonical prose.',
      box(0.12, 0.42, 0.68, 0.016),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 180,
          height: 80,
          pixels: new Uint8Array(180 * 80 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [precedingProse, slab, caption, followingProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    const acceptedCrop = rasterizeFigure.mock.calls[0]?.[0].sourceBox
    expect(rasterizeFigure).toHaveBeenCalledTimes(1)
    expect(relationship?.sourceObjectIds[0]).toMatch(
      /^table-scope-source:pdf-table-scope:caption-bounded-text-slab:/,
    )
    expect(relationship?.candidates[0].evidence).toContain(
      'contiguous-single-anchor-slab',
    )
    expect(acceptedCrop?.y).toBeGreaterThanOrEqual(
      precedingProse.box.y + precedingProse.box.height - 0.00001,
    )
    expect(acceptedCrop?.y).toBeLessThanOrEqual(topRuleY)
    expect(
      acceptedCrop ? acceptedCrop.y + acceptedCrop.height : 1,
    ).toBeGreaterThanOrEqual(bottomRuleY)
    expect(
      acceptedCrop ? acceptedCrop.y + acceptedCrop.height : 1,
    ).toBeLessThanOrEqual(caption.box.y + 0.00001)
    expect(relationship).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
    expect(result.consumedRegionIds.has(precedingProse.id)).toBe(false)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('does not accept a tight text-only fallback after an expanded caption-text-slab crop touches an outer rule', async () => {
    const bottomRuleY = 0.525
    const captionBox = box(0.12, 0.26, 0.68, 0.02)
    const captionText = 'Table 5. Outer rules extend beyond the text slab.'
    const caption = {
      ...captionRegion(captionText, captionBox),
      id: 'expanded-edge-table-caption',
      lines: [
        textRegion('expanded-edge-table-caption-line', captionText, captionBox)
          .lines[0],
      ],
    }
    const slab = textRegion(
      'expanded-edge-table-slab',
      'Field 1: structured table value',
      box(0.12, 0.3, 0.68, 0.184),
    )
    const baseLine = slab.lines[0]
    slab.lines = Array.from({ length: 8 }, (_, index) => {
      const sourceBox = {
        ...box(0.12, 0.3 + index * 0.024, 0.68 - index * 0.02, 0.016),
        method: 'pdf-text' as const,
      }
      const text = `Field ${index + 1}: structured table value`
      return {
        ...baseLine,
        id: `expanded-edge-table-line-${index + 1}`,
        text,
        box: sourceBox,
        fontSize: 9,
        runs: [
          {
            ...baseLine.runs[0],
            ...sourceBox,
            text,
            fontName: 'PromptSerif-Bold',
            fontSize: 9,
            bold: true,
          },
        ],
      }
    })
    slab.text = slab.lines.map((line) => line.text).join(' ')
    const followingProse = textRegion(
      'expanded-edge-table-following-prose',
      'The following paragraph remains outside the table rendition.',
      box(0.12, 0.55, 0.68, 0.016),
    )
    const tightTextBox = {
      page: slab.box.page,
      x: slab.box.x,
      y: slab.box.y,
      width: slab.box.width,
      height: slab.box.height,
      rotation: slab.box.rotation,
    }
    const successfulCrops: NormalizedSourceBox[] = []
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropBottom = input.sourceBox.y + input.sourceBox.height
        const tightTextOnlyFallback =
          Math.abs(input.sourceBox.x - tightTextBox.x) < 0.00001 &&
          Math.abs(input.sourceBox.y - tightTextBox.y) < 0.00001 &&
          Math.abs(input.sourceBox.width - tightTextBox.width) < 0.00001 &&
          Math.abs(input.sourceBox.height - tightTextBox.height) < 0.00001
        if (!tightTextOnlyFallback && cropBottom < bottomRuleY) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        successfulCrops.push({ ...input.sourceBox })
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 180,
          height: 80,
          pixels: new Uint8Array(180 * 80 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [caption, slab, followingProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    expect(
      rasterizeFigure.mock.calls.some(
        ([input]) =>
          Math.abs(input.sourceBox.y - tightTextBox.y) < 0.00001 &&
          Math.abs(input.sourceBox.height - tightTextBox.height) < 0.00001,
      ),
    ).toBe(false)
    expect(successfulCrops).toHaveLength(1)
    expect(
      successfulCrops[0].y + successfulCrops[0].height,
    ).toBeGreaterThanOrEqual(bottomRuleY)
    expect(
      successfulCrops[0].y + successfulCrops[0].height,
    ).toBeLessThanOrEqual(followingProse.box.y + 0.00001)
    expect(relationship).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
    expect(relationship?.evidence).not.toContain(
      'source-page-crop-tightened-away-from-adjacent-text',
    )
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('does not clear a wide-rule table edge by crossing side prose', async () => {
    const caption = {
      ...captionRegion(
        'Table 1. A table whose unproved rule extension meets side prose.',
        box(0.1, 0.52, 0.8, 0.025),
      ),
      id: 'wide-rule-side-prose-table-caption',
    }
    const rows = Array.from({ length: 7 }, (_, index) => {
      const region = textRegion(
        `wide-rule-side-prose-table-row-${index + 1}`,
        `Metric ${index + 1}  ${40 + index}.0  ${70 + index}.0`,
        box(0.2, 0.55 + index * 0.016, 0.48, 0.012),
      )
      region.lines[0].fontSize = 8
      region.lines[0].runs[0] = {
        ...region.lines[0].runs[0],
        fontName: 'TableSerif-Regular',
        fontSize: 8,
      }
      const baseRun = region.lines[0].runs[0]
      region.lines[0].runs = [
        {
          ...baseRun,
          text: `Metric ${index + 1}`,
          x: 0.2,
          width: 0.14,
        },
        {
          ...baseRun,
          text: `${40 + index}.0`,
          x: 0.45,
          width: 0.05,
        },
        {
          ...baseRun,
          text: `${70 + index}.0`,
          x: 0.6,
          width: 0.05,
        },
      ]
      return region
    })
    const sideProse = textRegion(
      'wide-rule-table-side-prose',
      'Side prose must never be absorbed by a speculative table rule.',
      box(0.72, 0.56, 0.22, 0.085),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        if (cropRight >= sideProse.box.x) {
          throw new Error('unsafe table crop crossed side prose')
        }
        throw new Error('PDF page crop has source ink touching its edge')
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [caption, ...rows, sideProse],
      rasterizeFigure,
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.kind === 'table',
    )
    expect(relationship).toMatchObject({
      status: 'unresolved',
      assetIds: [],
      evidence: expect.arrayContaining([
        'source-page-crop-edge-contact',
        'source-rendition-unavailable',
      ]),
    })
    expect(
      rasterizeFigure.mock.calls.every(([input]) => {
        const cropRight = input.sourceBox.x + input.sourceBox.width
        return cropRight < sideProse.box.x
      }),
    ).toBe(true)
    expect(result.consumedRegionIds.has(sideProse.id)).toBe(false)
    expect(result.consumedLineIds.has(sideProse.lines[0].id)).toBe(false)
  })

  it('reserves uniquely owned native figure atoms before an earlier table', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const sourceObjectIds = [
      'image-p001-reserved-native-layer',
      'vector-p001-reserved-native-layer',
    ]
    const assets = sourceObjectIds.map((sourceObjectId) =>
      sourcePreservedSvgAsset(sourceObjectId, sourceBox),
    )
    const tableCaption = {
      ...captionRegion(
        'Table 1. Possible native raster.',
        box(0.2, 0.1, 0.5, 0.02),
      ),
      id: 'reserved-native-table-caption',
    }
    const overlays = [
      textRegion(
        'reserved-native-overlay-a',
        'series alpha',
        box(0.28, 0.21, 0.12, 0.012),
      ),
      textRegion(
        'reserved-native-overlay-b',
        'series beta',
        box(0.45, 0.24, 0.12, 0.012),
      ),
    ]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Proven layered panel.',
        box(0.2, 0.32, 0.5, 0.02),
      ),
      id: 'reserved-native-figure-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: index === 0 ? ('image' as const) : ('vector' as const),
            box: sourceBox,
            confidence: 0.99,
            assetId: assets[index].id,
          })),
          1,
          assets,
        ),
      ],
      regions: [
        tableCaption,
        ...sourceObjectIds.map((id, index) =>
          objectRegion(`reserved-native-region-${index + 1}`, id, sourceBox),
        ),
        ...overlays,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
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
          width: 100,
          height: 60,
          pixels: new Uint8Array(100 * 60 * 4).fill(96),
        }),
    })

    const tableRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'table',
    )
    const figureRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'figure',
    )
    expect(tableRelationship).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(
      tableRelationship?.candidates.every((candidate) =>
        candidate.sourceObjectIds.every(
          (sourceObjectId) => !sourceObjectIds.includes(sourceObjectId),
        ),
      ),
    ).toBe(true)
    expect(figureRelationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining(sourceObjectIds),
      sourceLineIds: overlays.map((region) => region.lines[0].id),
    })
  })

  it.each([
    ['nearer', 0.155],
    ['tied', 0.14],
  ])(
    'withholds connected figure reservation when a %s table caption contests the candidate envelope',
    async (_case, tableCaptionY) => {
      const sourceBox = box(0.2, 0.18, 0.5, 0.12)
      const sourceObjectIds = [
        'image-p001-contested-envelope-layer',
        'vector-p001-contested-envelope-layer',
      ]
      const assets = sourceObjectIds.map((sourceObjectId) =>
        sourcePreservedSvgAsset(sourceObjectId, sourceBox),
      )
      const tableCaption = {
        ...captionRegion(
          'Table 1. Contested native source.',
          box(0.2, tableCaptionY, 0.5, 0.02),
        ),
        id: `contested-envelope-${_case}-table-caption`,
      }
      const overlays = [
        textRegion(
          `contested-envelope-${_case}-overlay-a`,
          'series alpha',
          box(0.28, 0.21, 0.12, 0.012),
          'chart-label',
        ),
        textRegion(
          `contested-envelope-${_case}-overlay-b`,
          'series beta',
          box(0.45, 0.24, 0.12, 0.012),
          'chart-label',
        ),
      ]
      const figureCaption = {
        ...captionRegion(
          'Figure 1. Later connected panel.',
          box(0.2, 0.32, 0.5, 0.02),
        ),
        id: `contested-envelope-${_case}-figure-caption`,
      }

      const result = await reconstructPdfVisuals({
        pages: [
          page(
            sourceObjectIds.map((id, index) => ({
              id,
              page: 1,
              kind: index === 0 ? ('image' as const) : ('vector' as const),
              box: sourceBox,
              confidence: 0.99,
              assetId: assets[index].id,
            })),
            1,
            assets,
          ),
        ],
        regions: [
          tableCaption,
          ...sourceObjectIds.map((id, index) =>
            objectRegion(
              `contested-envelope-${_case}-region-${index + 1}`,
              id,
              sourceBox,
            ),
          ),
          ...overlays,
          figureCaption,
        ],
        rasterizeFigure: async (input) =>
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
            width: 100,
            height: 60,
            pixels: new Uint8Array(100 * 60 * 4).fill(96),
          }),
      })

      const tableRelationship = result.relationships.find(
        (relationship) => relationship.kind === 'table',
      )
      const figureRelationship = result.relationships.find(
        (relationship) => relationship.kind === 'figure',
      )
      const contestedFigureCandidate = figureRelationship?.candidates.find(
        (candidate) =>
          sourceObjectIds.every((sourceObjectId) =>
            candidate.sourceObjectIds.includes(sourceObjectId),
          ),
      )
      expect(contestedFigureCandidate?.evidence).toContain(
        'connected-native-scaffold',
      )
      expect(contestedFigureCandidate?.evidence).not.toContain(
        'caption-bounded-native-scaffold',
      )
      expect(
        tableRelationship?.candidates.some((candidate) =>
          sourceObjectIds.some((sourceObjectId) =>
            candidate.sourceObjectIds.includes(sourceObjectId),
          ),
        ),
      ).toBe(true)
      expect(tableRelationship).toMatchObject({
        status: 'matched',
        sourceObjectIds: [sourceObjectIds[0]],
      })
      expect(figureRelationship).toMatchObject({
        status: 'unresolved',
        sourceObjectIds: [],
        assetIds: [],
        evidence: expect.arrayContaining([
          'cross-type-source-lineage-conflict',
          'source-rendition-unavailable',
        ]),
      })
    },
  )

  it('fails a later figure closed when a table already owns its native atom', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const sourceObjectId = 'image-p001-cross-type-native-conflict'
    const sourceAsset = sourcePreservedSvgAsset(sourceObjectId, sourceBox)
    const tableCaption = {
      ...captionRegion(
        'Table 1. Exact native source.',
        box(0.2, 0.1, 0.5, 0.02),
      ),
      id: 'native-conflict-table-caption',
    }
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Same exact native source.',
        box(0.2, 0.32, 0.5, 0.02),
      ),
      id: 'native-conflict-figure-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 0.99,
              assetId: sourceAsset.id,
            },
          ],
          1,
          [sourceAsset],
        ),
      ],
      regions: [
        tableCaption,
        objectRegion(
          'native-conflict-source-region',
          sourceObjectId,
          sourceBox,
        ),
        figureCaption,
      ],
    })

    const tableRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'table',
    )
    const figureRelationship = result.relationships.find(
      (relationship) => relationship.kind === 'figure',
    )
    expect(tableRelationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: [sourceObjectId],
      assetIds: [sourceAsset.id],
    })
    expect(figureRelationship).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'cross-type-source-lineage-conflict',
        'source-rendition-unavailable',
      ]),
      candidates: [
        expect.objectContaining({
          sourceObjectIds: [sourceObjectId],
        }),
      ],
    })
  })

  it('retries an edge-touching padded figure crop at its proved render envelope', async () => {
    const firstBox = box(0.2, 0.18, 0.18, 0.12)
    const secondBox = box(0.38, 0.18, 0.18, 0.12)
    const objects = [firstBox, secondBox].map((sourceBox, index) => ({
      id: `vector-p001-edge-touch-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (input.sourceBox.x < firstBox.x) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`edge-touch-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. A complete crop remains available inside adjacent prose.',
          box(0.2, 0.34, 0.36, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[1]![0].sourceBox).toMatchObject({
      x: firstBox.x,
      y: firstBox.y,
      width: 0.36,
      height: firstBox.height,
    })
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
  })

  it('recovers a caption-bounded panel after page furniture corrupts one native envelope', async () => {
    const phantomBox = box(0.14, 0, 0.16, 0.12)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.16 + (index % 4) * 0.15,
        0.09 + Math.floor(index / 4) * 0.11,
        0.13,
        0.08,
      ),
    )
    const objects = [phantomBox, ...fragmentBoxes].map((sourceBox, index) => ({
      id: `vector-p001-panel-envelope-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const panelLabels = [
      textRegion(
        'panel-envelope-label-one',
        'Planning and drafting',
        box(0.18, 0.105, 0.18, 0.018),
      ),
      textRegion(
        'panel-envelope-label-two',
        'Revision and memory',
        box(0.58, 0.205, 0.18, 0.018),
      ),
    ]
    const pageFurniture = textRegion(
      'panel-envelope-page-furniture',
      'Repeated running publication header',
      box(0.14, 0.02, 0.2, 0.08),
      'header',
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 32,
          pixels: new Uint8Array(96 * 32 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `panel-envelope-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        pageFurniture,
        ...panelLabels,
        captionRegion(
          'Figure 1. Complete source panel with malformed native envelope.',
          box(0.12, 0.31, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0]).toMatchObject({
      sourceObjectIds: ['source-panel:caption-region'],
      ownedSourceBoxes: panelLabels.map((region) => region.box),
    })
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:caption-region'],
      evidence: expect.arrayContaining([
        'source-native-envelope-incomplete',
        'source-page-crop-caption-bounded-panel-recovery',
        'source-panel-synthetic-crop-lineage',
        'source-page-crop',
      ]),
    })
    expect(
      panelLabels.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
    expect(result.consumedRegionIds.has(pageFurniture.id)).toBe(false)
    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          objects
            .slice(1)
            .some((object) => diagnostic.message.includes(object.id)),
      ),
    ).toEqual([])
  })

  it('recovers a repeated page-edge clipping layer without teaching ordinary page-edge panels to discard lineage', async () => {
    const repeatedClipBox = box(0.05, 0, 0.49, 0.275)
    const repeatedClipAsset = await solidRectangleFallbackAsset(
      'vector-p001-reused-clip-1',
      repeatedClipBox,
    )
    const layerBoxes = [
      repeatedClipBox,
      box(0.14, 0, 0.72, 0.265),
      box(0.141, 0.001, 0.718, 0.263),
      box(0.16, 0.09, 0.2, 0.14),
      box(0.62, 0.09, 0.2, 0.14),
    ]
    const objects = layerBoxes.map((sourceBox, index) => ({
      id: `vector-p001-reused-clip-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: index === 0 ? repeatedClipAsset.id : null,
    }))
    const repeatedObject = {
      id: 'vector-p002-reused-clip',
      page: 2,
      kind: 'vector' as const,
      box: { ...repeatedClipBox, page: 2 },
      confidence: 0.99,
      assetId: repeatedClipAsset.id,
    }
    const repeatedPageAsset = {
      ...repeatedClipAsset,
      sourceObjectIds: [repeatedObject.id],
      sourceBoxes: [repeatedObject.box],
    }
    const panelLabels = Array.from({ length: 8 }, (_, index) =>
      textRegion(
        `reused-clip-label-${index + 1}`,
        `Panel source label ${index + 1}`,
        box(
          0.16 + (index % 2) * 0.36,
          0.09 + Math.floor(index / 2) * 0.04,
          0.28,
          0.018,
        ),
      ),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (!input.sourceObjectIds[0].startsWith('source-panel:')) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 32,
          pixels: new Uint8Array(96 * 32 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(objects, 1, [repeatedClipAsset]),
        page([repeatedObject], 2, [repeatedPageAsset]),
      ],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `reused-clip-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelLabels,
        captionRegion(
          'Figure 1. A complete source panel below a reused clipping layer.',
          box(0.12, 0.275, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(3)
    expect(rasterizeFigure.mock.calls[2][0].sourceObjectIds).toEqual([
      'source-panel:caption-region',
    ])
    expect(rasterizeFigure.mock.calls[2][0].sourceBox.y).toBeGreaterThan(0)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:caption-region'],
      evidence: expect.arrayContaining([
        'source-reused-page-edge-clipping-layer',
        'source-page-crop-caption-bounded-panel-recovery',
        'source-page-crop',
      ]),
    })
  })

  it('does not retry a page-edge panel by discarding original native lineage', async () => {
    const firstLayerBox = box(0.14, 0, 0.72, 0.27)
    const secondLayerBox = box(0.141, 0.001, 0.718, 0.268)
    const objects = [firstLayerBox, secondLayerBox].map((sourceBox, index) => ({
      id: `vector-p001-page-edge-panel-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const panelTitle = textRegion(
      'page-edge-panel-title',
      'Five stages writing theory',
      box(0.32, 0.09, 0.36, 0.024),
    )
    const panelStages = textRegion(
      'page-edge-panel-stages',
      'Planning Drafting Revising Editing Publishing',
      box(0.145, 0.14, 0.7, 0.08),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (
          objects.every((object) =>
            containsSourceBox(input.sourceBox, object.box),
          )
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('page-edge-panel-region-1', objects[0].id, firstLayerBox),
        objectRegion('page-edge-panel-region-2', objects[1].id, secondLayerBox),
        panelTitle,
        panelStages,
        captionRegion(
          'Figure 1. A layered source-native writing framework.',
          box(0.12, 0.285, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.every(([input]) =>
        objects.every((object) =>
          containsSourceBox(input.sourceBox, object.box),
        ),
      ),
    ).toBe(true)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining(
            objects.map((object) => object.id),
          ),
          sourceBoxes: expect.arrayContaining([firstLayerBox, secondLayerBox]),
        }),
      ],
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-page-crop-caption-text-bounded-edge-retry',
    )
  })

  it('does not use caption width to discard a dense diagram source extent', async () => {
    const scaffoldBox = box(0, 0, 0.47, 0.2)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(0.16 + index * 0.012, 0.01 + index * 0.012, 0.04, 0.04),
    )
    const objects = [scaffoldBox, ...fragmentBoxes].map((sourceBox, index) => ({
      id: `vector-p001-dense-page-edge-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const diagramHeading = textRegion(
      'dense-page-edge-heading',
      'Knowledge Graph',
      box(0.39, 0.08, 0.1, 0.01),
    )
    const diagramTuples = textRegion(
      'dense-page-edge-tuples',
      '<sub1, act1, obj1, idx1> <sub2, act2, obj2, idx2>',
      box(0.52, 0.1, 0.11, 0.02),
    )
    const diagramTail = textRegion(
      'dense-page-edge-tail',
      '<subn, actn, objn, idxn>',
      box(0.515, 0.14, 0.11, 0.01),
    )
    const followingProse = textRegion(
      'dense-page-edge-following-prose',
      'Canonical article prose after the caption remains in reading order.',
      box(0.12, 0.25, 0.36, 0.04),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (
          objects.every((object) =>
            containsSourceBox(input.sourceBox, object.box),
          )
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 24,
          pixels: new Uint8Array(64 * 24 * 4).fill(72),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `dense-page-edge-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        diagramHeading,
        diagramTuples,
        diagramTail,
        captionRegion(
          'Figure 1. A dense querying pipeline diagram.',
          box(0.119, 0.207, 0.762, 0.026),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.every(([input]) =>
        objects.every((object) =>
          containsSourceBox(input.sourceBox, object.box),
        ),
      ),
    ).toBe(true)
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining(
            objects.map((object) => object.id),
          ),
          sourceBoxes: expect.arrayContaining(
            objects.map((object) => object.box),
          ),
        }),
      ],
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-page-crop-caption-text-bounded-edge-retry',
    )
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('keeps a single large captioned vector as scientific content', async () => {
    const sourceBox = box(0.1, 0.14, 0.8, 0.5)
    const sourceAsset = sourcePreservedSvgAsset('vector-p001-001', sourceBox)
    const object = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAsset.id,
    }

    const result = await reconstructPdfVisuals({
      pages: [page([object], 1, [sourceAsset])],
      regions: [
        objectRegion('large-vector-region', object.id, sourceBox),
        captionRegion(
          'Figure 1. A full-width scientific vector diagram.',
          box(0.1, 0.66, 0.8, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [object.id],
      assetIds: [object.assetId],
    })
  })

  it('reports a single uncaptioned large vector instead of suppressing it by size', async () => {
    const sourceBox = box(0.1, 0.14, 0.8, 0.5)
    const object = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: 'asset-large-vector',
    }

    const result = await reconstructPdfVisuals({
      pages: [page([object])],
      regions: [],
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNREFERENCED_VISUAL_ASSET',
        sourceBoxes: [sourceBox],
      }),
    ])
  })

  it('suppresses only a repeated large solid-rectangle fallback as page furniture', async () => {
    const firstBox = box(0.05, 0.05, 0.9, 0.8, 1)
    const secondBox = box(0.05, 0.05, 0.9, 0.8, 2)
    const firstAsset = await solidRectangleFallbackAsset(
      'vector-p001-001',
      firstBox,
    )
    const first = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: firstBox,
      confidence: 0.98,
      assetId: firstAsset.id,
    }
    const second = {
      ...first,
      id: 'vector-p002-001',
      page: 2,
      box: secondBox,
      assetId: firstAsset.id,
    }
    const secondAsset = {
      ...firstAsset,
      sourceObjectIds: [second.id],
      sourceBoxes: [secondBox],
    }

    const result = await reconstructPdfVisuals({
      pages: [page([first], 1, [firstAsset]), page([second], 2, [secondAsset])],
      regions: [],
    })

    expect(result.diagnostics).toEqual([])
  })

  it('keeps a lone solid-rectangle fallback as a source obligation', async () => {
    const sourceBox = box(0.08, 0.16, 0.76, 0.42)
    const sourceObjectId = 'vector-p001-lone-data-bar'
    const sourceAsset = await solidRectangleFallbackAsset(
      sourceObjectId,
      sourceBox,
    )
    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: sourceObjectId,
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAsset.id,
            },
          ],
          1,
          [sourceAsset],
        ),
      ],
      regions: [],
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNREFERENCED_VISUAL_ASSET',
        message: expect.stringContaining(sourceObjectId),
      }),
    ])
  })

  it('does not suppress repeated large non-rectangle vectors as page furniture', async () => {
    const firstBox = box(0.05, 0.05, 0.9, 0.8, 1)
    const secondBox = box(0.05, 0.05, 0.9, 0.8, 2)
    const firstAsset = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-triangle',
      sourceBox: firstBox,
      path: 'M 0 100 L 50 0 L 100 100 Z',
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      paint: 'fill',
    })
    const objects = [
      {
        id: 'vector-p001-triangle',
        page: 1,
        kind: 'vector' as const,
        box: firstBox,
        confidence: 0.98,
        assetId: firstAsset.id,
      },
      {
        id: 'vector-p002-triangle',
        page: 2,
        kind: 'vector' as const,
        box: secondBox,
        confidence: 0.98,
        assetId: firstAsset.id,
      },
    ]
    const secondAsset = {
      ...firstAsset,
      sourceObjectIds: [objects[1].id],
      sourceBoxes: [secondBox],
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page([objects[0]], 1, [firstAsset]),
        page([objects[1]], 2, [secondAsset]),
      ],
      regions: [],
    })

    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNREFERENCED_VISUAL_ASSET',
      ),
    ).toHaveLength(2)
  })

  it('rasterizes a matched multi-object figure into one bounded asset', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 20,
          height: 10,
          pixels: new Uint8Array(20 * 10 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        sourceObjectIds: objects.map((object) => object.id),
        sourceBox: expect.objectContaining({
          x: 0.196,
          y: 0.176,
          width: 0.258,
          height: 0.128,
        }),
      }),
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(result.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rendition: 'source-page-crop',
        }),
      ]),
    )
  })

  it('credits only fully contained native components inside one exact crop lane', async () => {
    const primaryBoxes = [
      box(0.2, 0.18, 0.22, 0.12),
      box(0.42, 0.18, 0.22, 0.12),
    ]
    const primaryObjects = primaryBoxes.map((sourceBox, index) => ({
      id: `vector-p001-credit-primary-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const containedObjects = [
      {
        id: 'image-p001-credit-inset-raster',
        page: 1,
        kind: 'image' as const,
        box: box(0.25, 0.215, 0.018, 0.018),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'vector-p001-credit-inset-vector',
        page: 1,
        kind: 'vector' as const,
        box: box(0.55, 0.235, 0.012, 0.012),
        confidence: 0.99,
        assetId: null,
      },
    ]
    const partialObject = {
      id: 'image-p001-credit-partial-neighbor',
      page: 1,
      kind: 'image' as const,
      box: box(0.635, 0.215, 0.04, 0.018),
      confidence: 0.99,
      assetId: null,
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 32,
          pixels: new Uint8Array(64 * 32 * 4).fill(72),
        }),
    )
    const result = await reconstructPdfVisuals({
      pages: [page([...primaryObjects, ...containedObjects, partialObject])],
      regions: [
        ...primaryObjects.map((object, index) =>
          objectRegion(
            `credit-primary-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. One exact crop owns its inset source components.',
          box(0.2, 0.33, 0.44, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: primaryObjects.map((object) => object.id),
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-native-object-credit',
      ]),
    })
    for (const object of containedObjects) {
      expect(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
            diagnostic.message.includes(object.id),
        ),
      ).toBe(false)
    }
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(partialObject.id),
      ),
    ).toBe(true)
  })

  it('does not credit a contained native object when another caption competes for the lane', async () => {
    const primaryBoxes = [box(0.2, 0.16, 0.2, 0.1), box(0.4, 0.16, 0.2, 0.1)]
    const primaryObjects = primaryBoxes.map((sourceBox, index) => ({
      id: `vector-p001-competing-caption-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const contestedObject = {
      id: 'image-p001-competing-caption-inset',
      page: 1,
      kind: 'image' as const,
      box: box(0.3, 0.19, 0.018, 0.018),
      confidence: 0.99,
      assetId: null,
    }
    const firstCaption = captionRegion(
      'Figure 1. First candidate caption.',
      box(0.2, 0.3, 0.4, 0.02),
    )
    const secondCaption = {
      ...captionRegion(
        'Figure 2. Competing caption in the same source lane.',
        box(0.2, 0.31, 0.4, 0.02),
      ),
      id: 'competing-caption-region',
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 32,
          pixels: new Uint8Array(64 * 32 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([...primaryObjects, contestedObject])],
      regions: [
        ...primaryObjects.map((object, index) =>
          objectRegion(
            `competing-caption-object-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        firstCaption,
        secondCaption,
      ],
      rasterizeFigure,
    })

    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNREFERENCED_VISUAL_ASSET' &&
          diagnostic.message.includes(contestedObject.id),
      ),
    ).toBe(true)
  })

  it('accepts a source-rendered figure tightened to verified ink bounds', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-ink-bound-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const tightenedBox = box(0.202, 0.182, 0.242, 0.116)
    const tightenedSourceBoxes = [
      box(0.202, 0.182, 0.118, 0.116),
      box(0.33, 0.182, 0.114, 0.116),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: tightenedBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: tightenedSourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`ink-bound-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. Invisible PDF object padding is excluded.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-source-ink-tightened',
      ]),
    })
    expect(
      result.assets.find(
        (asset) => asset.id === result.relationships[0].assetIds[0],
      ),
    ).toMatchObject({
      rendition: 'source-page-crop',
      sourceCropBox: tightenedBox,
      sourceBoxes: tightenedSourceBoxes,
    })
  })

  it('retries an identical complete figure scope without tightening when tightening drops required lineage', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-complete-lineage-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const firstPanelOnly = box(0.202, 0.182, 0.116, 0.116)
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        input.tightenToSourceInk === false
          ? createSourcePageCropAsset({
              kind: 'raster',
              cropBox: input.sourceBox,
              sourceObjectIds: input.sourceObjectIds,
              sourceBoxes: input.sourceBoxes,
              width: 40,
              height: 20,
              pixels: new Uint8Array(40 * 20 * 4).fill(64),
            })
          : createSourcePageCropAsset({
              kind: 'raster',
              cropBox: firstPanelOnly,
              sourceObjectIds: [input.sourceObjectIds[0]],
              sourceBoxes: [firstPanelOnly],
              width: 20,
              height: 20,
              pixels: new Uint8Array(20 * 20 * 4).fill(64),
            }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `complete-lineage-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. Both source panels form one complete figure.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[1][0]).toMatchObject({
      sourceBox: rasterizeFigure.mock.calls[0][0].sourceBox,
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
      tightenToSourceInk: false,
    })
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining([
        'source-page-crop-complete-lineage-preserved',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-page-crop-source-ink-tightened',
    )
    expect(
      result.assets.find(
        (asset) => asset.id === result.relationships[0].assetIds[0],
      ),
    ).toMatchObject({
      rendition: 'source-page-crop',
      sourceCropBox: rasterizeFigure.mock.calls[0][0].sourceBox,
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
  })

  it('rejects a tightened source crop that drops an expected figure object', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-required-panel-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const firstPanelOnly = box(0.202, 0.182, 0.116, 0.116)
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: firstPanelOnly,
          sourceObjectIds: [input.sourceObjectIds[0]],
          sourceBoxes: [firstPanelOnly],
          width: 20,
          height: 20,
          pixels: new Uint8Array(20 * 20 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `required-panel-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. Both source panels are required.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[1][0]).toMatchObject({
      sourceBox: rasterizeFigure.mock.calls[0][0].sourceBox,
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
      tightenToSourceInk: false,
    })
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining(['source-page-crop-lineage-rejected']),
    })
  })

  it('keeps asset-bearing fragments unresolved in headless mode without a composite', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: `asset-fragment-${index + 1}`,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({
          sourceObjectIds: objects.map((object) => object.id),
          assetIds: objects.map((object) => object.assetId),
        }),
      ],
    })
    expect(result.relationships[0].evidence).toContain(
      'source-rendition-unavailable',
    )
  })

  it('composes source PNG fragments deterministically in headless mode', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAssets = await Promise.all(
      boxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(index === 0 ? 64 : 192),
        }),
      ),
    )
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const input = {
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source images.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    }

    const first = await reconstructPdfVisuals(input)
    const second = await reconstructPdfVisuals(input)

    expect(second.relationships).toEqual(first.relationships)
    expect(second.assets).toEqual(first.assets)
    expect(first.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining(['headless-composite-raster']),
    })
    const composite = first.assets.find(
      (asset) => asset.id === first.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'browser-composite-raster',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    expect([...composite.bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ])
  })

  it('composes mixed preserved image and vector fragments into one bounded SVG', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const raster = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: boxes[0],
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(255),
    })
    const vector = sourcePreservedSvgAsset('vector-p001-001', boxes[1])
    const sourceAssets = [raster, vector]
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: boxes[0],
        confidence: 0.98,
        assetId: raster.id,
      },
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: boxes[1],
        confidence: 0.98,
        assetId: vector.id,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. Mixed source-backed fragments.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining(['headless-composite-svg']),
    })
    const composite = result.assets.find(
      (asset) => asset.id === result.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      mediaType: 'image/svg+xml',
      kind: 'vector',
      rendition: 'source-preserved',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    const svg = strFromU8(composite.bytes)
    expect(svg).toContain('data-pdf-composite="true"')
    expect(svg).toContain('href="data:image/png;base64,')
    expect(svg).toContain('href="data:image/svg+xml;base64,')
    expect(svg).not.toContain(raster.href)
    expect(svg).not.toContain(vector.href)
  })

  it('retains a broad vector scaffold when it binds disconnected source fragments', async () => {
    const scaffold = box(0.05, 0.1, 0.9, 0.42)
    const fragmentBoxes = [
      box(0.1, 0.15, 0.05, 0.04),
      box(0.32, 0.23, 0.05, 0.04),
      box(0.58, 0.17, 0.05, 0.04),
      box(0.82, 0.36, 0.05, 0.04),
    ]
    const objects = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: 'asset-scaffold',
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `image-p001-00${index + 1}`,
        page: 1,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: `asset-fragment-${index + 1}`,
      })),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )
    const caption = captionRegion(
      'Figure 1. One bounded composite.',
      box(0.1, 0.54, 0.8, 0.02),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`composite-region-${index + 1}`, object.id, object.box),
        ),
        caption,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceObjectIds: objects.map((object) => object.id),
        sourceBox: expect.objectContaining({ page: 1 }),
      }),
    )
    const renderBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(renderBox.y + renderBox.height).toBeLessThanOrEqual(
      caption.box.y + 0.001,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_VISUAL_ASSET' }),
      ]),
    )
  })

  it('trims scaffold and glyph objects that overlap unrelated reading-order text', async () => {
    const scaffold = box(0.48, 0.12, 0.36, 0.36)
    const authorGlyph = box(0.6, 0.18, 0.04, 0.02)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.52 + (index % 4) * 0.07,
        0.26 + Math.floor(index / 4) * 0.12,
        0.05,
        0.06,
      ),
    )
    const figureIds = fragmentBoxes.map(
      (_, index) => `vector-p001-figure-${index + 1}`,
    )
    const objects = [
      {
        id: 'vector-p001-overbroad-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: null,
      },
      {
        id: 'vector-p001-author-glyph',
        page: 1,
        kind: 'vector' as const,
        box: authorGlyph,
        confidence: 0.98,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: figureIds[index],
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.98,
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
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`scaffold-region-${index + 1}`, object.id, object.box),
        ),
        textRegion(
          'author-line',
          'Author One, Author Two, University Laboratory',
          box(0.3, 0.17, 0.45, 0.035),
          'body',
        ),
        textRegion(
          'diagram-label-one',
          'Premise',
          box(0.55, 0.27, 0.08, 0.015),
          'body',
        ),
        textRegion(
          'diagram-label-two',
          'Write content',
          box(0.68, 0.39, 0.09, 0.015),
          'body',
        ),
        captionRegion(
          'Figure 1. A bounded diagram below the author block.',
          box(0.5, 0.5, 0.36, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceObjectIds: [
          ...figureIds,
          'text-overlay:diagram-label-one',
          'text-overlay:diagram-label-two',
        ],
        sourceBox: expect.objectContaining({ y: expect.any(Number) }),
      }),
    )
    const sourceBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(sourceBox.y).toBeGreaterThan(0.2)
    expect(sourceBox.x).toBeLessThanOrEqual(0.5)
    expect(sourceBox.x + sourceBox.width).toBeGreaterThanOrEqual(0.86)
    expect(sourceBox.y + sourceBox.height).toBeGreaterThanOrEqual(0.49)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...figureIds,
        'text-overlay:diagram-label-one',
        'text-overlay:diagram-label-two',
      ],
      evidence: expect.arrayContaining([
        'source-scaffold-trimmed-reading-order-overlap',
        'source-page-crop',
      ]),
    })
  })

  it('excludes a reused page-edge vector backdrop from a captioned figure crop', async () => {
    const pageBackdrop = box(0.15, 0.08, 0.68, 0.26)
    const repeatedBackdrop = box(0.19, 0.004, 0.68, 0.26, 2)
    const fragmentBoxes = [
      box(0.2, 0.12, 0.14, 0.12),
      box(0.36, 0.12, 0.14, 0.12),
      box(0.52, 0.12, 0.14, 0.12),
      box(0.68, 0.12, 0.14, 0.12),
    ]
    const firstBackdropAsset = await solidRectangleFallbackAsset(
      'vector-p001-page-backdrop',
      pageBackdrop,
    )
    const backdropObjects = [
      {
        id: 'vector-p001-page-backdrop',
        page: 1,
        kind: 'vector' as const,
        box: pageBackdrop,
        confidence: 0.99,
        assetId: firstBackdropAsset.id,
      },
      {
        id: 'vector-p002-page-backdrop',
        page: 2,
        kind: 'vector' as const,
        box: repeatedBackdrop,
        confidence: 0.99,
        assetId: firstBackdropAsset.id,
      },
    ]
    const secondBackdropAsset = {
      ...firstBackdropAsset,
      sourceObjectIds: [backdropObjects[1].id],
      sourceBoxes: [repeatedBackdrop],
    }
    const figureObjects = fragmentBoxes.map((sourceBox, index) => ({
      id: `vector-p001-scientific-fragment-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 32,
          pixels: new Uint8Array(96 * 32 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page([backdropObjects[0], ...figureObjects], 1, [firstBackdropAsset]),
        page([backdropObjects[1]], 2, [secondBackdropAsset]),
      ],
      regions: [
        objectRegion(
          'page-backdrop-region',
          backdropObjects[0].id,
          pageBackdrop,
        ),
        ...figureObjects.map((object, index) =>
          objectRegion(
            `scientific-fragment-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. A scientific panel below reusable page furniture.',
          box(0.18, 0.27, 0.64, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: figureObjects.map((object) => object.id),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0.1)
    expect(rasterizeFigure.mock.calls[0][0].sourceObjectIds).not.toContain(
      backdropObjects[0].id,
    )
  })

  it('does not reclaim repeated running-title text as a figure overlay', async () => {
    const overbroadScaffold = box(0.1, 0.08, 0.8, 0.28)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.2 + (index % 4) * 0.15,
        0.17 + Math.floor(index / 4) * 0.1,
        0.08,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-running-title-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: overbroadScaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-running-title-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const runningTitle = textRegion(
      'misclassified-running-title',
      'DECOMPOSING PERSONA VECTORS USING SPARSE AUTOENCODERS',
      box(0.18, 0.1, 0.6, 0.016),
    )
    const repeatedRunningTitle = {
      ...textRegion(
        'repeated-running-title',
        runningTitle.text,
        box(0.18, 0.03, 0.6, 0.016, 2),
        'header',
      ),
      includedInReadingOrder: false,
    }
    const firstDiagramLabel = textRegion(
      'first-diagram-label',
      'Feature direction',
      box(0.24, 0.19, 0.12, 0.014),
    )
    const secondDiagramLabel = textRegion(
      'second-diagram-label',
      'Cosine similarity',
      box(0.48, 0.28, 0.12, 0.014),
    )
    const sectionHeading = textRegion(
      'section-heading-over-scaffold',
      'M DECOMPOSING PERSONA VECTORS USING SPARSE AUTOENCODERS',
      box(0.11, 0.082, 0.18, 0.016),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 36,
          pixels: new Uint8Array(96 * 36 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects), page([], 2)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `running-title-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        sectionHeading,
        runningTitle,
        repeatedRunningTitle,
        firstDiagramLabel,
        secondDiagramLabel,
        captionRegion(
          'Figure 1. A dense panel below repeated page furniture.',
          box(0.16, 0.37, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        'text-overlay:first-diagram-label',
        'text-overlay:second-diagram-label',
      ]),
    })
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'text-overlay:misclassified-running-title',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'vector-p001-running-title-scaffold',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'text-overlay:section-heading-over-scaffold',
    )
    expect(result.consumedRegionIds.has(runningTitle.id)).toBe(false)
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0.12)
  })

  it('trims an overbroad native scaffold that overlaps repeated side-classified page furniture', async () => {
    const overbroadScaffold = box(0.1, 0.08, 0.8, 0.28)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.2 + (index % 4) * 0.15,
        0.17 + Math.floor(index / 4) * 0.1,
        0.08,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-page-furniture-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: overbroadScaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-page-furniture-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const runningHeader = {
      ...textRegion(
        'running-header-over-scaffold',
        'Paul Pu Liang, Amir Zadeh, and Louis-Philippe Morency',
        box(0.2, 0.095, 0.6, 0.016),
        'side',
      ),
      includedInReadingOrder: false,
    }
    const repeatedRunningHeaders = [2, 3].map((pageNumber) => ({
      ...textRegion(
        `repeated-running-header-page-${pageNumber}`,
        runningHeader.text,
        box(0.2, 0.095, 0.6, 0.016, pageNumber),
        'side',
      ),
      includedInReadingOrder: false,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 36,
          pixels: new Uint8Array(96 * 36 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects), page([], 2), page([], 3)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `page-furniture-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        runningHeader,
        ...repeatedRunningHeaders,
        textRegion(
          'page-furniture-diagram-label-one',
          'Continuous warping',
          box(0.26, 0.19, 0.12, 0.014),
        ),
        textRegion(
          'page-furniture-diagram-label-two',
          'Modality segmentation',
          box(0.5, 0.28, 0.14, 0.014),
        ),
        captionRegion(
          'Figure 1. A dense panel below a running header.',
          box(0.16, 0.37, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-scaffold-trimmed-page-furniture-overlap',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'vector-p001-page-furniture-scaffold',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'text-overlay:running-header-over-scaffold',
    )
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeGreaterThan(0.12)
  })

  it('excludes repeated side furniture enclosed by every coextensive figure layer', async () => {
    const sourceBox = box(0.14, 0.08, 0.72, 0.24)
    const sourceObjectIds = [
      'vector-p001-coextensive-furniture-layer-a',
      'vector-p001-coextensive-furniture-layer-b',
    ]
    const sourceAssets = sourceObjectIds.map((sourceObjectId) =>
      sourcePreservedSvgAsset(sourceObjectId, sourceBox),
    )
    const runningHeader = {
      ...textRegion(
        'coextensive-running-side-header',
        'REPEATED SOURCE-SIDE RUNNING HEADER ACROSS PAGES',
        box(0.2, 0.095, 0.6, 0.016),
        'side',
      ),
      includedInReadingOrder: false,
    }
    const repeatedHeaders = [2, 3].map((pageNumber) => ({
      ...textRegion(
        `coextensive-running-side-header-page-${pageNumber}`,
        runningHeader.text,
        box(0.2, 0.095, 0.6, 0.016, pageNumber),
        'side',
      ),
      includedInReadingOrder: false,
    }))
    const chartLabels = [
      textRegion(
        'coextensive-genuine-chart-label-a',
        'training',
        box(0.28, 0.19, 0.1, 0.014),
        'chart-label',
      ),
      textRegion(
        'coextensive-genuine-chart-label-b',
        'validation',
        box(0.5, 0.25, 0.1, 0.014),
        'chart-label',
      ),
    ]
    const figureCaption = {
      ...captionRegion(
        'Figure 1. Coextensive chart beneath repeated furniture.',
        box(0.16, 0.34, 0.68, 0.025),
      ),
      id: 'coextensive-furniture-figure-caption',
    }

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          sourceObjectIds.map((id, index) => ({
            id,
            page: 1,
            kind: 'vector' as const,
            box: sourceBox,
            confidence: 0.99,
            assetId: sourceAssets[index].id,
          })),
          1,
          sourceAssets,
        ),
        page([], 2),
        page([], 3),
      ],
      regions: [
        ...sourceObjectIds.map((id, index) =>
          objectRegion(
            `coextensive-furniture-layer-region-${index + 1}`,
            id,
            sourceBox,
          ),
        ),
        runningHeader,
        ...repeatedHeaders,
        ...chartLabels,
        figureCaption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 100,
          height: 60,
          pixels: new Uint8Array(100 * 60 * 4).fill(96),
        }),
    })

    const relationship = result.relationships.find(
      (candidate) => candidate.label === 'Figure 1',
    )
    expect(relationship).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...sourceObjectIds,
        ...chartLabels.map((region) => `text-overlay:${region.id}`),
      ]),
      sourceLineIds: chartLabels.map((region) => region.lines[0].id),
      candidates: [
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining([
            ...sourceObjectIds,
            ...chartLabels.map((region) => `text-overlay:${region.id}`),
          ]),
        }),
      ],
    })
    expect(relationship?.sourceObjectIds).not.toContain(
      `text-overlay:${runningHeader.id}`,
    )
    expect(relationship?.sourceRegionIds).not.toContain(runningHeader.id)
    expect(relationship?.sourceLineIds).not.toContain(runningHeader.lines[0].id)
    expect(
      relationship?.candidates.some((candidate) =>
        candidate.sourceObjectIds.includes(`text-overlay:${runningHeader.id}`),
      ),
    ).toBe(false)
    expect(result.consumedRegionIds.has(runningHeader.id)).toBe(false)
    expect(result.consumedLineIds.has(runningHeader.lines[0].id)).toBe(false)
  })

  it('keeps a top-of-chart numeric tick sequence inside its caption-bounded native figure', async () => {
    const scaffold = box(0.1, 0.084, 0.8, 0.19)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.16 + (index % 4) * 0.18,
        0.098 + Math.floor(index / 4) * 0.096,
        0.12,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-chart-tick-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-chart-tick-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const chartTicks = {
      ...textRegion(
        'side-classified-top-chart-ticks',
        '25 20 15',
        box(0.7, 0.092, 0.12, 0.012),
        'side',
      ),
      includedInReadingOrder: false,
    }
    chartTicks.lines = [
      {
        ...chartTicks.lines[0],
        box: chartTicks.box,
        runs: [0.7, 0.75, 0.8].map((x, index) => ({
          ...box(x, 0.092, 0.025, 0.012),
          method: 'pdf-text' as const,
          text: ['25', '20', '15'][index],
          fontName: 'ChartSans',
          fontSize: 8,
          confidence: 0.99,
        })),
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 32,
          pixels: new Uint8Array(96 * 32 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `chart-tick-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        chartTicks,
        captionRegion(
          'Figure 3. Complete source chart with internal numeric axes.',
          box(0.12, 0.285, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        `text-overlay:${chartTicks.id}`,
      ]),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-native-envelope-incomplete',
    )
    expect(result.consumedRegionIds.has(chartTicks.id)).toBe(true)
  })

  it('still excludes one isolated extreme-margin page number from an overbroad figure scaffold', async () => {
    const scaffold = box(0.1, 0.035, 0.8, 0.3)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.2 + (index % 4) * 0.15,
        0.14 + Math.floor(index / 4) * 0.1,
        0.08,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-page-number-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.99,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-page-number-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.99,
        assetId: null,
      })),
    ]
    const pageNumber = {
      ...textRegion(
        'side-classified-isolated-page-number',
        '17',
        box(0.48, 0.05, 0.025, 0.012),
        'side',
      ),
      includedInReadingOrder: false,
    }
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 32,
          pixels: new Uint8Array(96 * 32 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `page-number-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        pageNumber,
        captionRegion(
          'Figure 1. Native panel below the printed page number.',
          box(0.16, 0.36, 0.68, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-scaffold-trimmed-page-furniture-overlap',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      'vector-p001-page-number-scaffold',
    )
    expect(result.relationships[0].sourceObjectIds).not.toContain(
      `text-overlay:${pageNumber.id}`,
    )
    expect(result.consumedRegionIds.has(pageNumber.id)).toBe(false)
  })

  it('uses the caption width to complete a trimmed dense scaffold with non-flow labels', async () => {
    const scaffold = box(0.48, 0.12, 0.36, 0.36)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.52 + (index % 4) * 0.07,
        0.26 + Math.floor(index / 4) * 0.12,
        0.05,
        0.06,
      ),
    )
    const objects = [
      {
        id: 'vector-p001-non-flow-overbroad-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `vector-p001-non-flow-fragment-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.98,
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
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )
    const caption = captionRegion(
      'Figure 1. The caption and diagram share one bounded column.',
      box(0.5, 0.5, 0.36, 0.025),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `non-flow-scaffold-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        textRegion(
          'non-flow-author-line',
          'Author One, Author Two, University Laboratory',
          box(0.3, 0.17, 0.45, 0.035),
          'body',
        ),
        textRegion(
          'non-flow-diagram-label-one',
          'Premise',
          box(0.55, 0.27, 0.08, 0.015),
          'chart-label',
        ),
        textRegion(
          'non-flow-diagram-label-two',
          'Write content',
          box(0.68, 0.39, 0.09, 0.015),
          'side',
        ),
        caption,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    const sourceBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(sourceBox.x).toBeLessThanOrEqual(caption.box.x)
    expect(sourceBox.x + sourceBox.width).toBeGreaterThanOrEqual(
      caption.box.x + caption.box.width,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-scaffold-trimmed-reading-order-overlap',
        'source-page-crop',
      ]),
    })
  })

  it('claims an adjacent non-flow title above a proven caption-bounded scaffold', async () => {
    const ruleBoxes = [
      box(0.18, 0.18, 0.64, 0.002),
      box(0.18, 0.35, 0.64, 0.002),
      box(0.18, 0.18, 0.002, 0.172),
      box(0.818, 0.18, 0.002, 0.172),
    ]
    const objects = ruleBoxes.map((sourceBox, index) => ({
      id: `vector-p001-titled-rule-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.99,
      assetId: null,
    }))
    const title = textRegion(
      'caption-lane-panel-title',
      'Reasoning modules',
      box(0.28, 0.145, 0.44, 0.018),
      'chart-label',
    )
    const panelLabels = [
      textRegion(
        'titled-panel-label-one',
        'Retrieve evidence',
        box(0.24, 0.22, 0.2, 0.018),
        'chart-label',
      ),
      textRegion(
        'titled-panel-label-two',
        'Compose response',
        box(0.56, 0.22, 0.2, 0.018),
        'chart-label',
      ),
      textRegion(
        'titled-panel-label-three',
        'Verify output',
        box(0.4, 0.3, 0.2, 0.018),
        'chart-label',
      ),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 48,
          pixels: new Uint8Array(96 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `titled-rule-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        title,
        ...panelLabels,
        captionRegion(
          'Figure 1. One titled semantic panel.',
          box(0.12, 0.38, 0.76, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.y).toBeLessThanOrEqual(
      title.box.y,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: expect.arrayContaining([
        ...objects.map((object) => object.id),
        `text-overlay:${title.id}`,
      ]),
      evidence: expect.arrayContaining([
        'caption-bounded-non-flow-title',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(title.id)).toBe(true)
  })

  it('keeps a fragmented figure unresolved when no browser rasterizer exists', async () => {
    const boxes = [
      box(0.2, 0.18, 0.12, 0.12),
      box(0.33, 0.18, 0.12, 0.12),
      box(0.46, 0.18, 0.12, 0.12),
      box(0.59, 0.18, 0.12, 0.12),
    ]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(result.relationships[0].evidence).toContain(
      'source-rendition-unavailable',
    )
  })

  it('matches a narrow caption to the complete connected diagram envelope', async () => {
    const scaffold = box(0.52, 0.25, 0.36, 0.24)
    const fragments = [
      box(0.525, 0.27, 0.03, 0.03),
      box(0.57, 0.31, 0.03, 0.03),
      box(0.64, 0.35, 0.03, 0.03),
      box(0.81, 0.43, 0.03, 0.03),
    ]
    const sourceBoxes = [scaffold, ...fragments]
    const objects = sourceBoxes.map((sourceBox, index) => ({
      id: `vector-p001-narrow-caption-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 72,
          height: 48,
          pixels: new Uint8Array(72 * 48 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `narrow-caption-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 1. High-level overview.',
          box(0.58, 0.5, 0.23, 0.02),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      label: 'Figure 1',
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining(['source-page-crop']),
    })
  })

  it('ignores a thin title-page rule without hiding bounded visual objects', async () => {
    const rule = box(0.18, 0.1, 0.65, 0.005)
    const figure = box(0.2, 0.6, 0.58, 0.23)
    const figureAsset = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: figure,
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(128),
    })
    const objects = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: rule,
        confidence: 0.98,
        assetId: 'asset-rule',
      },
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: figure,
        confidence: 0.98,
        assetId: figureAsset.id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset])],
      regions: [
        objectRegion('rule-region', objects[0].id, rule),
        objectRegion('figure-region', objects[1].id, figure),
        captionRegion(
          'Figure 1. Bounded source figure.',
          box(0.18, 0.84, 0.65, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-001'],
      assetIds: [figureAsset.id],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [rule],
        }),
      ]),
    )
  })

  it('does not require an interior short hairline to have a figure caption', async () => {
    const rule = box(0.2, 0.46, 0.03, 0.00001)
    const figure = box(0.2, 0.62, 0.58, 0.23)
    const figureAsset = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: figure,
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(128),
    })
    const objects = [
      {
        id: 'vector-p001-table-rule',
        page: 1,
        kind: 'vector' as const,
        box: rule,
        confidence: 0.98,
        assetId: 'asset-table-rule',
      },
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: figure,
        confidence: 0.98,
        assetId: figureAsset.id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset])],
      regions: [
        objectRegion('rule-region', objects[0].id, rule),
        objectRegion('figure-region', objects[1].id, figure),
      ],
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [rule],
        }),
      ]),
    )
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [figure],
        }),
      ]),
    )
  })

  it('uses horizontal alignment to associate side-by-side figures', async () => {
    const left = box(0.08, 0.2, 0.38, 0.18)
    const right = box(0.54, 0.2, 0.38, 0.18)
    const sourceAssets = await Promise.all(
      [left, right].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(80 + index * 80),
        }),
      ),
    )
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: left,
        confidence: 0.98,
        assetId: sourceAssets[0].id,
      },
      {
        id: 'image-p001-002',
        page: 1,
        kind: 'image' as const,
        box: right,
        confidence: 0.98,
        assetId: sourceAssets[1].id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        objectRegion('left-region', objects[0].id, left),
        objectRegion('right-region', objects[1].id, right),
        captionRegion(
          'Figure 2. Right-hand result.',
          box(0.54, 0.4, 0.38, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-002'],
      assetIds: [sourceAssets[1].id],
    })
    expect(result.relationships[0].candidates[0].evidence).toContain(
      'horizontal-alignment',
    )
  })

  it('does not bridge a narrow caption through a taller neighbouring column', async () => {
    const figure16 = box(0.09, 0.32, 0.383, 0.136)
    const figure17 = box(0.09, 0.576, 0.383, 0.236)
    const figure18 = box(0.502, 0.269, 0.382, 0.368)
    const sourceBoxes = [figure16, figure17, figure18]
    const sourceAssets = await Promise.all(
      sourceBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-column-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(64 + index * 48),
        }),
      ),
    )
    const objects = sourceBoxes.map((sourceBox, index) => ({
      id: `image-p001-column-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`column-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 16. Left-column result.',
          box(0.09, 0.472, 0.386, 0.055),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-column-1'],
      assetIds: [sourceAssets[0].id],
    })
    expect(result.relationships[0].candidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceObjectIds: expect.arrayContaining([
            'image-p001-column-2',
            'image-p001-column-3',
          ]),
        }),
      ]),
    )
  })

  it('does not bridge a left chart to the first panel of a separately captioned right figure', async () => {
    const sourceBoxes = [
      box(0.09, 0.5, 0.383, 0.19),
      box(0.502, 0.5, 0.175, 0.15),
      box(0.702, 0.5, 0.175, 0.15),
    ]
    const sourceAssets = await Promise.all(
      sourceBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-separate-column-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(72 + index * 48),
        }),
      ),
    )
    const objects = sourceBoxes.map((sourceBox, index) => ({
      id: `image-p001-separate-column-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `separate-column-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        captionRegion(
          'Figure 13. Two right-column panels.',
          box(0.502, 0.67, 0.383, 0.03),
        ),
        captionRegion(
          'Figure 12. One left-column chart.',
          box(0.09, 0.72, 0.383, 0.03),
        ),
      ],
    })

    expect(
      result.relationships.find(
        (relationship) => relationship.label === 'Figure 13',
      ),
    ).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[1].id, objects[2].id],
    })
    expect(
      result.relationships.find(
        (relationship) => relationship.label === 'Figure 12',
      ),
    ).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[0].id],
    })
  })

  it('does not let a global figure ordinal override the immediately adjacent source object', async () => {
    const priorObjects = Array.from({ length: 15 }, (_, index) => {
      const sourceBox = box(0.12, 0.2, 0.3, 0.1, index + 1)
      return {
        id: `image-prior-${String(index + 1).padStart(2, '0')}`,
        page: sourceBox.page,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: null,
      }
    })
    const targetPage = 16
    const precedingFigure = box(
      0.090588,
      0.091268,
      0.382367,
      0.149264,
      targetPage,
    )
    const adjacentFigure = box(
      0.090588,
      0.320327,
      0.382353,
      0.136364,
      targetPage,
    )
    const sourceAssets = await Promise.all(
      [precedingFigure, adjacentFigure].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-target-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(80 + index * 48),
        }),
      ),
    )
    const targetObjects = [precedingFigure, adjacentFigure].map(
      (sourceBox, index) => ({
        id: `image-target-${index + 1}`,
        page: targetPage,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: sourceAssets[index].id,
      }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        ...priorObjects.map((object) => page([object], object.page)),
        page(targetObjects, targetPage, sourceAssets),
      ],
      regions: [
        ...priorObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        ...targetObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 16. The source object immediately above owns this caption.',
          box(0.089768, 0.47179, 0.3856, 0.0805, targetPage),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-target-2'],
      assetIds: [sourceAssets[1].id],
      evidence: expect.arrayContaining(['bounded-distance']),
    })
  })

  it('orders visual-only figure relationships by column flow before global y', async () => {
    const figureBoxes = [
      box(0.09, 0.09, 0.38, 0.15),
      box(0.09, 0.32, 0.38, 0.14),
      box(0.09, 0.58, 0.38, 0.23),
      box(0.502, 0.27, 0.38, 0.36),
    ]
    const sourceAssets = await Promise.all(
      figureBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-visual-column-${index + 1}`,
          sourceBox,
          width: 8,
          height: 8,
          colorSpace: 'rgba',
          pixels: new Uint8Array(8 * 8 * 4).fill(64 + index * 32),
        }),
      ),
    )
    const objects = figureBoxes.map((sourceBox, index) => ({
      id: `image-visual-column-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const captions = [
      captionRegion(
        'Figure 15. First left-column figure.',
        box(0.09, 0.255, 0.38, 0.03),
      ),
      captionRegion(
        'Figure 16. Second left-column figure.',
        box(0.09, 0.47, 0.38, 0.05),
      ),
      captionRegion(
        'Figure 17. Third left-column figure.',
        box(0.09, 0.827, 0.38, 0.05),
      ),
      captionRegion(
        'Figure 18. Right-column figure.',
        box(0.502, 0.652, 0.38, 0.05),
      ),
    ].map((caption, index) => ({
      ...caption,
      id: `visual-column-caption-${index + 1}`,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `visual-column-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...captions,
      ],
    })

    expect(
      result.relationships.map((relationship) => relationship.label),
    ).toEqual(['Figure 15', 'Figure 16', 'Figure 17', 'Figure 18'])
    expect(
      result.relationships.every(
        (relationship) => relationship.status === 'matched',
      ),
    ).toBe(true)
  })

  it('fails closed for similarly adjacent numeric-label candidates despite their global ordinals', async () => {
    const priorObjects = Array.from({ length: 15 }, (_, index) => {
      const sourceBox = box(0.12, 0.2, 0.3, 0.1, index + 1)
      return {
        id: `image-ambiguous-prior-${String(index + 1).padStart(2, '0')}`,
        page: sourceBox.page,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: null,
      }
    })
    const targetPage = 16
    const competingBoxes = [
      box(0.08, 0.32, 0.38, 0.14, targetPage),
      box(0.51, 0.32, 0.38, 0.14, targetPage),
    ]
    const sourceAssets = await Promise.all(
      competingBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-ambiguous-target-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(96 + index * 48),
        }),
      ),
    )
    const targetObjects = competingBoxes.map((sourceBox, index) => ({
      id: `image-ambiguous-target-${index + 1}`,
      page: targetPage,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [
        ...priorObjects.map((object) => page([object], object.page)),
        page(targetObjects, targetPage, sourceAssets),
      ],
      regions: [
        ...priorObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        ...targetObjects.map((object) =>
          objectRegion(`region-${object.id}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 16. Two equally plausible neighbouring panels.',
          box(0.08, 0.48, 0.81, 0.03, targetPage),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'ambiguous',
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({ score: expect.any(Number) }),
        expect.objectContaining({ score: expect.any(Number) }),
      ],
    })
  })

  it('keeps adjacent panels together when one wide caption owns both columns', async () => {
    const panelBoxes = [
      box(0.09, 0.28, 0.383, 0.18),
      box(0.502, 0.28, 0.382, 0.18),
    ]
    const sourceAssets = await Promise.all(
      panelBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-wide-panel-${index + 1}`,
          sourceBox,
          width: 4,
          height: 4,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 4 * 4).fill(72 + index * 64),
        }),
      ),
    )
    const objects = panelBoxes.map((sourceBox, index) => ({
      id: `image-p001-wide-panel-${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`wide-panel-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One two-column multi-panel figure.',
          box(0.09, 0.48, 0.794, 0.03),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['headless-composite-raster']),
    })
  })

  it('retains a composite visual whose native source box crosses a caption lane', async () => {
    const compositeBox = box(0.09, 0.2, 0.8, 0.18)
    const sourceAssets = await Promise.all(
      ['image-p001-cross-lane', 'vector-p001-cross-lane'].map(
        (sourceObjectId, index) =>
          createPngAsset({
            sourceObjectId,
            sourceBox: compositeBox,
            width: 4,
            height: 4,
            colorSpace: 'rgba',
            pixels: new Uint8Array(4 * 4 * 4).fill(64 + index * 32),
          }),
      ),
    )
    const objects = [
      {
        id: 'image-p001-cross-lane',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[0].id,
      },
      {
        id: 'vector-p001-cross-lane',
        page: 1,
        kind: 'vector' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[1].id,
      },
    ]
    const caption = {
      ...captionRegion(
        'Figure 1. A composite panel crossing the lane.',
        box(0.09, 0.42, 0.34, 0.03),
      ),
      id: 'cross-lane-caption',
      sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
    }

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`cross-lane-region-${index + 1}`, object.id, object.box),
        ),
        caption,
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        }),
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      evidence: expect.arrayContaining(['connected-native-scaffold']),
    })
  })

  it('gives disjoint lane-scoped crops independent composite ownership', async () => {
    const compositeBox = box(0.09, 0.2, 0.8, 0.18)
    const sourceAssets = await Promise.all(
      ['image-p001-disjoint-lanes', 'vector-p001-disjoint-lanes'].map(
        (sourceObjectId, index) =>
          createPngAsset({
            sourceObjectId,
            sourceBox: compositeBox,
            width: 4,
            height: 4,
            colorSpace: 'rgba',
            pixels: new Uint8Array(4 * 4 * 4).fill(64 + index * 32),
          }),
      ),
    )
    const objects = [
      {
        id: 'image-p001-disjoint-lanes',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[0].id,
      },
      {
        id: 'vector-p001-disjoint-lanes',
        page: 1,
        kind: 'vector' as const,
        box: compositeBox,
        confidence: 0.98,
        assetId: sourceAssets[1].id,
      },
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The left composite panel.',
          box(0.09, 0.42, 0.41, 0.03),
        ),
        id: 'left-disjoint-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The right composite panel.',
          box(0.5, 0.42, 0.39, 0.03),
        ),
        id: 'right-disjoint-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `disjoint-lane-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...captions,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(
      result.relationships.map((relationship) => relationship.status),
    ).toEqual(['matched', 'matched'])
    expect(
      result.relationships.map((relationship) => relationship.sourceObjectIds),
    ).toEqual([
      objects.map((object) => object.id),
      objects.map((object) => object.id),
    ])
    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(rasterizeFigure.mock.calls[0][0].sourceBox.width).toBeLessThan(
      compositeBox.width,
    )
    expect(rasterizeFigure.mock.calls[1][0].sourceBox.width).toBeLessThan(
      compositeBox.width,
    )
    expect(
      rasterizeFigure.mock.calls[0][0].sourceBox.x +
        rasterizeFigure.mock.calls[0][0].sourceBox.width / 2,
    ).toBeLessThan(0.5)
    expect(
      rasterizeFigure.mock.calls[1][0].sourceBox.x +
        rasterizeFigure.mock.calls[1][0].sourceBox.width / 2,
    ).toBeGreaterThanOrEqual(0.5)
    expect(
      rasterizeFigure.mock.calls[0][0].sourceBox.x +
        rasterizeFigure.mock.calls[0][0].sourceBox.width,
    ).toBeLessThanOrEqual(0.5)
    expect(rasterizeFigure.mock.calls[1][0].sourceBox.x).toBeGreaterThanOrEqual(
      0.5,
    )
  })

  it('projects every accepted composite crop to lane-local text lineage', async () => {
    const compositeBox = box(0.04, 0.08, 0.92, 0.24)
    const objects = [
      {
        id: 'image-p001-final-crop-projection-1',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.99,
        assetId: null,
      },
      {
        id: 'image-p001-final-crop-projection-2',
        page: 1,
        kind: 'image' as const,
        box: compositeBox,
        confidence: 0.99,
        assetId: null,
      },
    ]
    const leftOverlay = textRegion(
      'final-crop-left-overlay',
      'left overlay alpha',
      box(0.1, 0.13, 0.22, 0.018),
    )
    const leftSecondLine = textRegion(
      'final-crop-left-overlay-second',
      'left overlay beta',
      box(0.28, 0.24, 0.18, 0.018),
    ).lines[0]
    const straddlingLine = textRegion(
      'final-crop-boundary-straddler',
      'boundary straddler stays canonical',
      box(0.498, 0.19, 0.04, 0.018),
    ).lines[0]
    leftOverlay.lines.push(leftSecondLine, straddlingLine)
    leftOverlay.text = leftOverlay.lines.map((line) => line.text).join(' ')
    leftOverlay.box = {
      ...leftOverlay.box,
      width: 0.438,
      height: 0.128,
    }
    const rightOverlay = textRegion(
      'final-crop-right-overlay',
      'right overlay alpha',
      box(0.61, 0.13, 0.22, 0.018),
    )
    const rightSecondLine = textRegion(
      'final-crop-right-overlay-second',
      'right overlay beta',
      box(0.72, 0.24, 0.18, 0.018),
    ).lines[0]
    rightOverlay.lines.push(rightSecondLine)
    rightOverlay.text = rightOverlay.lines.map((line) => line.text).join(' ')
    rightOverlay.box = {
      ...rightOverlay.box,
      width: 0.29,
      height: 0.128,
    }
    const unrelatedBody = textRegion(
      'final-crop-unrelated-body',
      'unrelated body prose remains canonical',
      box(0.12, 0.43, 0.32, 0.018),
    )
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The accepted left crop.',
          box(0.03, 0.35, 0.47, 0.025),
        ),
        id: 'final-crop-left-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The accepted right crop.',
          box(0.5, 0.35, 0.47, 0.025),
        ),
        id: 'final-crop-right-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const requestedRight = input.sourceBox.x + input.sourceBox.width
        const leftLane = input.sourceBox.x < 0.5
        const sourceCropBox = {
          ...input.sourceBox,
          x: leftLane ? input.sourceBox.x + 0.008 : 0.5,
          y: input.sourceBox.y + 0.012,
          width: leftLane
            ? 0.5 - (input.sourceBox.x + 0.008)
            : requestedRight - 0.008 - 0.5,
          height: input.sourceBox.height - 0.024,
        }
        const sourceBoxes = input.sourceBoxes.flatMap((sourceBox) => {
          const left = Math.max(sourceCropBox.x, sourceBox.x)
          const top = Math.max(sourceCropBox.y, sourceBox.y)
          const right = Math.min(
            sourceCropBox.x + sourceCropBox.width,
            sourceBox.x + sourceBox.width,
          )
          const bottom = Math.min(
            sourceCropBox.y + sourceCropBox.height,
            sourceBox.y + sourceBox.height,
          )
          return right > left && bottom > top
            ? [
                {
                  ...sourceBox,
                  x: left,
                  y: top,
                  width: right - left,
                  height: bottom - top,
                },
              ]
            : []
        })
        expect(sourceBoxes).toHaveLength(input.sourceBoxes.length)
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: sourceCropBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `final-crop-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        leftOverlay,
        rightOverlay,
        unrelatedBody,
        ...captions,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(result.relationships).toMatchObject([
      { status: 'matched' },
      { status: 'matched' },
    ])
    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    const acceptedAssets = result.relationships.map((relationship) =>
      result.assets.find((asset) => asset.id === relationship.assetIds[0]),
    )
    expect(acceptedAssets[0]?.sourceCropBox).toMatchObject({
      x: expect.any(Number),
      width: expect.any(Number),
    })
    expect(
      acceptedAssets[0]!.sourceCropBox!.x +
        acceptedAssets[0]!.sourceCropBox!.width,
    ).toBe(0.5)
    expect(acceptedAssets[1]?.sourceCropBox?.x).toBe(0.5)
    expect(
      (acceptedAssets[0]!.sourceCropBox!.x +
        acceptedAssets[0]!.sourceCropBox!.width -
        straddlingLine.box.x) /
        straddlingLine.box.width,
    ).toBeLessThan(0.1)
    for (const [index, asset] of acceptedAssets.entries()) {
      const request = rasterizeFigure.mock.calls[index][0]
      expect(asset).toBeDefined()
      expect(containsSourceBox(request.sourceBox, asset!.sourceCropBox!)).toBe(
        true,
      )
      expect(asset!.sourceCropBox).not.toEqual(request.sourceBox)
      expect(result.relationships[index].assetIds).toEqual([asset!.id])
      expect(result.relationships[index].sourceObjectIds).toEqual(
        asset!.sourceObjectIds,
      )
      expect(result.relationships[index].sourceObjectIds).toEqual(
        expect.arrayContaining(objects.map((object) => object.id)),
      )
      expect(result.relationships[index].sourceBoxes.slice(1)).toEqual(
        asset!.sourceBoxes,
      )
      expect(
        asset!.sourceBoxes.every((sourceBox) =>
          containsSourceBox(asset!.sourceCropBox!, sourceBox),
        ),
      ).toBe(true)
      expect(
        asset!.sourceBoxes.every((sourceBox) =>
          index === 0
            ? sourceBox.x + sourceBox.width <= 0.5
            : sourceBox.x >= 0.5,
        ),
      ).toBe(true)
    }
    expect(acceptedAssets[0]!.id).not.toBe(acceptedAssets[1]!.id)
    expect(result.relationships[0].sourceRegionIds).toEqual([
      'final-crop-object-region-1',
      'final-crop-object-region-2',
      leftOverlay.id,
    ])
    expect(result.relationships[1].sourceRegionIds).toEqual([
      'final-crop-object-region-1',
      'final-crop-object-region-2',
      rightOverlay.id,
    ])
    expect(result.relationships[0].sourceLineIds).toEqual([
      leftOverlay.lines[0].id,
      leftSecondLine.id,
    ])
    expect(result.relationships[1].sourceLineIds).toEqual([
      rightOverlay.lines[0].id,
      rightSecondLine.id,
    ])
    expect(result.relationships[0].sourceText).toBe(
      'left overlay alpha left overlay beta',
    )
    expect(result.relationships[1].sourceText).toBe(
      'right overlay alpha right overlay beta',
    )
    expect(result.relationships[0].sourceText).not.toContain('right overlay')
    expect(result.relationships[1].sourceText).not.toContain('left overlay')
    for (const relationship of result.relationships) {
      expect(relationship.sourceLineIds).not.toContain(straddlingLine.id)
      expect(relationship.sourceRegionIds).not.toContain(unrelatedBody.id)
      expect(relationship.sourceText).not.toContain(unrelatedBody.text)
      expect(relationship.sourceRegionIds).not.toContain(
        captions.find((caption) => caption.id !== relationship.captionRegionId)!
          .id,
      )
    }
    expect(result.consumedLineIds).toEqual(
      new Set([leftOverlay.lines[0].id, leftSecondLine.id]),
    )
    expect(result.consumedRegionIds).toEqual(new Set([rightOverlay.id]))
    expect(result.consumedLineIds.has(straddlingLine.id)).toBe(false)
    expect(result.consumedRegionIds.has(leftOverlay.id)).toBe(false)
    expect(result.consumedRegionIds.has(unrelatedBody.id)).toBe(false)
    expect(result.consumedLineIds.has(unrelatedBody.lines[0].id)).toBe(false)
    expect(
      captions.every((caption) => !result.consumedRegionIds.has(caption.id)),
    ).toBe(true)
  })

  it('keeps edge-recovery crops and synthetic ownership inside adjacent caption lanes', async () => {
    const panelObjectSpecs = [
      ['left', 0],
      ['right', 0.5],
    ] as const
    const objects = panelObjectSpecs.flatMap(([side, offset]) => [
      {
        id: `image-p001-${side}-lane-recovery-1`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.06, 0.07, 0.38, 0.17),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `image-p001-${side}-lane-recovery-2`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.065, 0.075, 0.37, 0.16),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `vector-p001-${side}-lane-recovery-top-band`,
        page: 1,
        kind: 'vector' as const,
        box: box(offset + 0.08, 0.035, 0.34, 0.02),
        confidence: 0.99,
        assetId: null,
      },
    ])
    const panelText = [
      textRegion(
        'left-lane-recovery-label-1',
        'Left owned panel label one',
        box(0.12, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'left-lane-recovery-label-2',
        'Left owned panel label two',
        box(0.35, 0.16, 0.145, 0.018),
      ),
      textRegion(
        'right-lane-recovery-label-1',
        'Right owned panel label one',
        box(0.505, 0.08, 0.145, 0.018),
      ),
      textRegion(
        'right-lane-recovery-label-2',
        'Right owned panel label two',
        box(0.68, 0.16, 0.2, 0.018),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The left recovered panel.',
          box(0.03, 0.26, 0.47, 0.025),
        ),
        id: 'lane-recovery-left-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The right recovered panel.',
          box(0.5, 0.26, 0.47, 0.025),
        ),
        id: 'lane-recovery-right-caption',
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (!input.sourceObjectIds[0].startsWith('source-panel:')) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(96),
        })
      },
    )
    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `lane-recovery-object-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        ...captions,
      ],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(2)
    expect(result.relationships).toMatchObject([
      { status: 'matched' },
      { status: 'matched' },
    ])
    expect(
      result.relationships.map((relationship) => relationship.sourceObjectIds),
    ).toEqual([
      ['source-panel:lane-recovery-left-caption'],
      ['source-panel:lane-recovery-right-caption'],
    ])
    const recoveryInputs = rasterizeFigure.mock.calls
      .map(([input]) => input)
      .filter((input) => input.sourceObjectIds[0].startsWith('source-panel:'))
    expect(recoveryInputs).toHaveLength(2)
    expect(
      recoveryInputs.map((input) => ({
        left: input.sourceBox.x,
        right: input.sourceBox.x + input.sourceBox.width,
      })),
    ).toEqual([
      expect.objectContaining({ left: expect.any(Number), right: 0.5 }),
      expect.objectContaining({ left: 0.5, right: expect.any(Number) }),
    ])
    expect(
      result.relationships.map((relationship) => relationship.sourceBoxes[1]),
    ).toEqual(recoveryInputs.map((input) => input.sourceBox))
    expect(
      result.relationships.map((relationship) => relationship.sourceLineIds),
    ).toEqual([
      panelText.slice(0, 2).map((region) => region.lines[0].id),
      panelText.slice(2).map((region) => region.lines[0].id),
    ])
  })

  it('keeps native conflict accounting after disjoint synthetic crop recovery', async () => {
    const panelObjectSpecs = [
      ['left', 0],
      ['right', 0.5],
    ] as const
    const objects = panelObjectSpecs.flatMap(([side, offset]) => [
      {
        id: `image-p001-${side}-synthetic-scope-1`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.06, 0.07, 0.38, 0.17),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `image-p001-${side}-synthetic-scope-2`,
        page: 1,
        kind: 'image' as const,
        box: box(offset + 0.065, 0.075, 0.37, 0.16),
        confidence: 0.99,
        assetId: null,
      },
      {
        id: `vector-p001-${side}-synthetic-scope-top-band`,
        page: 1,
        kind: 'vector' as const,
        box: box(offset + 0.08, 0.035, 0.34, 0.02),
        confidence: 0.99,
        assetId: null,
      },
    ])
    const panelText = [
      textRegion(
        'synthetic-scope-left-overlay-1',
        'left recovered alpha',
        box(0.12, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'synthetic-scope-left-overlay-2',
        'left recovered beta',
        box(0.3, 0.16, 0.16, 0.018),
      ),
      textRegion(
        'synthetic-scope-right-overlay-1',
        'right recovered alpha',
        box(0.54, 0.08, 0.2, 0.018),
      ),
      textRegion(
        'synthetic-scope-right-overlay-2',
        'right recovered beta',
        box(0.7, 0.16, 0.18, 0.018),
      ),
    ]
    const captions = [
      {
        ...captionRegion(
          'Figure 1. The first recovered left crop.',
          box(0.03, 0.35, 0.47, 0.025),
        ),
        id: 'synthetic-scope-left-caption',
        column: 'left' as const,
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
      {
        ...captionRegion(
          'Figure 2. The disjoint recovered right crop.',
          box(0.5, 0.35, 0.47, 0.025),
        ),
        id: 'synthetic-scope-right-caption',
        column: 'right' as const,
        sourceCaptionLane: { boundary: 0.5, side: 'right' as const },
      },
      {
        ...captionRegion(
          'Figure 3. A later overlapping left claim.',
          box(0.04, 0.385, 0.46, 0.025),
        ),
        id: 'synthetic-scope-overlap-caption',
        column: 'single' as const,
        sourceCaptionLane: { boundary: 0.5, side: 'left' as const },
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        if (
          !input.sourceObjectIds.some((sourceObjectId) =>
            sourceObjectId.startsWith('source-panel:'),
          )
        ) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 40,
          pixels: new Uint8Array(80 * 40 * 4).fill(112),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `synthetic-scope-object-region-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        ...panelText,
        ...captions,
      ],
      rasterizeFigure,
    })

    const left = result.relationships.find(
      (relationship) =>
        relationship.captionRegionId === 'synthetic-scope-left-caption',
    )!
    const right = result.relationships.find(
      (relationship) =>
        relationship.captionRegionId === 'synthetic-scope-right-caption',
    )!
    const overlapping = result.relationships.find(
      (relationship) =>
        relationship.captionRegionId === 'synthetic-scope-overlap-caption',
    )!
    expect(left).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:synthetic-scope-left-caption'],
      sourceRegionIds: expect.arrayContaining([
        'synthetic-scope-object-region-1',
        'synthetic-scope-object-region-2',
        'synthetic-scope-object-region-3',
        panelText[0].id,
        panelText[1].id,
      ]),
      sourceLineIds: panelText.slice(0, 2).map((region) => region.lines[0].id),
      sourceText: 'left recovered alpha left recovered beta',
    })
    expect(right).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['source-panel:synthetic-scope-right-caption'],
      sourceRegionIds: expect.arrayContaining([
        'synthetic-scope-object-region-4',
        'synthetic-scope-object-region-5',
        'synthetic-scope-object-region-6',
        panelText[2].id,
        panelText[3].id,
      ]),
      sourceLineIds: panelText.slice(2).map((region) => region.lines[0].id),
      sourceText: 'right recovered alpha right recovered beta',
    })
    expect(overlapping).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'cross-type-source-lineage-conflict',
        'source-rendition-unavailable',
      ]),
    })
    expect(
      overlapping.candidates.some((candidate) =>
        objects
          .slice(0, 3)
          .every((object) => candidate.sourceObjectIds.includes(object.id)),
      ),
    ).toBe(true)
    const recoveryInputs = rasterizeFigure.mock.calls
      .map(([input]) => input)
      .filter((input) =>
        input.sourceObjectIds.some((sourceObjectId) =>
          sourceObjectId.startsWith('source-panel:'),
        ),
      )
    expect(recoveryInputs).toHaveLength(2)
    const recoveryBounds = recoveryInputs.map((input) => ({
      left: input.sourceBox.x,
      right: input.sourceBox.x + input.sourceBox.width,
    }))
    expect(recoveryBounds[0].right).toBeLessThanOrEqual(0.5)
    expect(recoveryBounds[1].left).toBeGreaterThanOrEqual(0.5)
    expect(recoveryBounds[0].right).toBeLessThanOrEqual(recoveryBounds[1].left)
    const recoveredAssets = [left, right].map((relationship) =>
      result.assets.find((asset) => asset.id === relationship.assetIds[0]),
    )
    expect(recoveredAssets[0]!.id).not.toBe(recoveredAssets[1]!.id)
    for (const [index, relationship] of [left, right].entries()) {
      expect(recoveredAssets[index]).toMatchObject({
        sourceCropBox: recoveryInputs[index].sourceBox,
        sourceObjectIds: recoveryInputs[index].sourceObjectIds,
        sourceBoxes: recoveryInputs[index].sourceBoxes,
      })
      expect(relationship.sourceBoxes.slice(1)).toEqual(
        recoveryInputs[index].sourceBoxes,
      )
    }
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
