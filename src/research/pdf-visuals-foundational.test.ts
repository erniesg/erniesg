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
import { createSourcePageCropAsset } from './visual-assets'
import {
  box,
  captionRegion,
  equationRegion,
  objectRegion,
  page,
  sourcePreservedSvgAsset,
  textRegion,
} from './pdf-visuals.test-fixtures'

describe('PDF visual association graph — foundational admission', () => {
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
})
