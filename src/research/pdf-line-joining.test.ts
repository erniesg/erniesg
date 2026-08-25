import { describe, expect, it } from 'vitest'
import {
  buildPdfLineJoinReviewContext,
  groupRunsIntoLines,
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  mergePdfRunText,
  joinPdfLineTexts,
  replayPdfRegionLineRanges,
  replayPdfRegionLineText,
  type PdfTextLine,
} from './pdf-lines'
import type {
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import type { PdfLineBoundaryDecision } from './import-types'

function line(text: string): PdfTextLine {
  return {
    page: 1,
    text,
    x: 0.1,
    y: 0.2,
    width: 0.7,
    height: 0.02,
    fontSize: 10,
    runs: [],
    column: 'single',
  }
}

function wrappedLines(before: string, after: string) {
  return [
    { ...line(before), y: 0.2 },
    { ...line(after), y: 0.222 },
  ]
}

const SOURCE_OWNERSHIP_TEXT_LEDGER = 'a'.repeat(64)
const SOURCE_OWNERSHIP_OPERATOR_LEDGER = 'b'.repeat(64)

function sourceOwnershipRun({
  text,
  x,
  y,
  width,
  height = 0.0142,
  fontSize = 12,
  fontName = 'Synthetic-CMR12',
  sourceSequenceIndex,
  paint = true,
  page = 1,
  method = 'pdf-text',
  operatorLedgerSha256 = SOURCE_OWNERSHIP_OPERATOR_LEDGER,
}: {
  text: string
  x: number
  y: number
  width: number
  height?: number
  fontSize?: number
  fontName?: string
  sourceSequenceIndex: number
  paint?: boolean
  page?: number
  method?: PdfSourceRun['method']
  operatorLedgerSha256?: string
}): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
    fontSize,
    fontName,
    rotation: 0,
    method,
    confidence: 1,
    sourceSequenceIndex,
    ...(paint
      ? {
          sourceTextPaint: {
            algorithm: 'pdfjs-text-paint-run-v1',
            textLedgerSha256: SOURCE_OWNERSHIP_TEXT_LEDGER,
            normalizedTextStart: sourceSequenceIndex,
            normalizedTextEnd: sourceSequenceIndex + text.length,
            operatorLedgerSha256,
            operationIndexes: [sourceSequenceIndex],
            filterableOperationIndexes: [sourceSequenceIndex],
          } as const,
        }
      : {}),
  }
}

function sourceOwnershipPage(runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    objects: [],
    runs,
  }
}

function singleSourceOwnershipCluster() {
  return [
    sourceOwnershipRun({
      text: 'Let',
      x: 0.1,
      y: 0.2,
      width: 0.03,
      sourceSequenceIndex: 0,
    }),
    sourceOwnershipRun({
      text: 'νij,t describes the time-varying co-jump measure on R2',
      x: 0.135,
      y: 0.2,
      width: 0.745,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 1,
    }),
    sourceOwnershipRun({
      text: 'Writing Δ',
      x: 0.1,
      y: 0.217,
      width: 0.25,
      sourceSequenceIndex: 2,
    }),
    sourceOwnershipRun({
      text: 'S',
      x: 0.35,
      y: 0.217,
      width: 0.012,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 3,
    }),
    sourceOwnershipRun({
      text: '(',
      x: 0.362,
      y: 0.2055,
      width: 0.009,
      fontName: 'Synthetic-CMEX10',
      sourceSequenceIndex: 4,
    }),
    sourceOwnershipRun({
      text: 'x',
      x: 0.371,
      y: 0.217,
      width: 0.011,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 5,
    }),
    sourceOwnershipRun({
      text: '+z',
      x: 0.384,
      y: 0.217,
      width: 0.027,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 6,
    }),
    sourceOwnershipRun({
      text: ') and a short-maturity expansion follows.',
      x: 0.414,
      y: 0.217,
      width: 0.36,
      sourceSequenceIndex: 7,
    }),
  ]
}

describe('PDF line joining', () => {
  it('splits source-proved local caption lanes without splitting one spanning caption', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height: 0.012,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 9,
      confidence: 1,
    })
    const layoutRuns = [0.1, 0.14, 0.18].flatMap((y, index) => [
      sourceRun(`Left column prose row ${index + 1}.`, 0.09, y, 0.37),
      sourceRun(`Right column prose row ${index + 1}.`, 0.54, y, 0.37),
    ])
    const leftCaption = [
      sourceRun('Table', 0.09, 0.4, 0.04),
      sourceRun('2.', 0.135, 0.4, 0.018),
      sourceRun('Left benchmark results.', 0.158, 0.4, 0.395),
    ]
    const rightCaption = [
      sourceRun('Table', 0.562, 0.4, 0.04),
      sourceRun('3.', 0.607, 0.4, 0.018),
      sourceRun('Right ablation results.', 0.63, 0.4, 0.251),
    ]
    const spanningLeft = sourceRun(
      'Table 4. One complete caption',
      0.09,
      0.46,
      0.463,
    )
    const spanningRight = sourceRun(
      'continues across the full page.',
      0.562,
      0.46,
      0.319,
    )
    const ambiguousCaptions = [
      sourceRun('Table 5. Left.', 0.3, 0.52, 0.21),
      sourceRun('Table 6. Middle.', 0.52, 0.52, 0.03),
      sourceRun('Table 7. Right.', 0.56, 0.52, 0.19),
    ]
    const runs = [
      ...layoutRuns,
      ...leftCaption,
      ...rightCaption,
      spanningLeft,
      spanningRight,
      ...ambiguousCaptions,
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 0,
      objects: [],
      runs,
    }

    const grouped = groupRunsIntoLines(page)

    expect(
      grouped
        .filter((candidate) => /^Table [23]\./u.test(candidate.text))
        .map(
          ({
            text,
            sourceOwnedColumn,
            sourceCaptionLaneBoundary,
            sourceCaptionLaneSide,
          }) => ({
            text,
            sourceOwnedColumn,
            sourceCaptionLaneBoundary,
            sourceCaptionLaneSide,
          }),
        ),
    ).toEqual([
      {
        text: 'Table 2. Left benchmark results.',
        sourceOwnedColumn: undefined,
        sourceCaptionLaneBoundary: expect.closeTo(0.5575, 4),
        sourceCaptionLaneSide: 'left',
      },
      {
        text: 'Table 3. Right ablation results.',
        sourceOwnedColumn: undefined,
        sourceCaptionLaneBoundary: expect.closeTo(0.5575, 4),
        sourceCaptionLaneSide: 'right',
      },
    ])
    const spanningCaption = grouped.find((candidate) =>
      candidate.text.startsWith('Table 4.'),
    )
    expect(spanningCaption).toMatchObject({
      text: 'Table 4. One complete caption continues across the full page.',
    })
    expect(spanningCaption?.sourceOwnedColumn).toBeUndefined()
    expect(
      grouped.find((candidate) => candidate.text.startsWith('Table 5.')),
    ).toMatchObject({
      text: 'Table 5. Left. Table 6. Middle. Table 7. Right.',
    })
    expect(grouped.flatMap((candidate) => candidate.runs)).toEqual(
      expect.arrayContaining(runs),
    )
    expect(grouped.flatMap((candidate) => candidate.runs)).toHaveLength(
      runs.length,
    )
  })

  it('fails closed when duplicate line ids make source ranges ambiguous', () => {
    const region: PdfPageRegion = {
      id: 'page-001-region-duplicate-lines',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Alpha Beta Gamma',
      confidence: 0.9,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.06,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: ['Alpha', 'Beta', 'Gamma'].map((text, index) => ({
        id: index < 2 ? 'duplicate-line' : 'line-3',
        text,
        fontSize: 10,
        box: {
          page: 1,
          x: 0.1,
          y: 0.2 + index * 0.02,
          width: 0.7,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text' as const,
        },
        runs: [],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const decisions: PdfLineBoundaryDecision[] = [
      {
        id: 'boundary-1',
        page: 1,
        regionId: region.id,
        fromLineId: 'duplicate-line',
        toLineId: 'duplicate-line',
        outcome: 'space',
        evidence: ['ordinary-wrap'],
      },
      {
        id: 'boundary-2',
        page: 1,
        regionId: region.id,
        fromLineId: 'duplicate-line',
        toLineId: 'line-3',
        outcome: 'space',
        evidence: ['ordinary-wrap'],
      },
    ]

    expect(replayPdfRegionLineRanges(region, decisions)).toBeNull()
  })

  it('replays exact per-line ranges across a removed discretionary hyphen', () => {
    const region: PdfPageRegion = {
      id: 'page-001-region-001',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Prompt hyphenated result [1] tail',
      confidence: 0.9,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.06,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: ['Prompt hyphen-', 'ated result [1]', 'tail'].map(
        (text, index) => ({
          id: `line-${index + 1}`,
          text,
          fontSize: 10,
          box: {
            page: 1,
            x: 0.1,
            y: 0.2 + index * 0.02,
            width: 0.7,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text' as const,
          },
          runs: [],
        }),
      ),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const decisions: PdfLineBoundaryDecision[] = [
      {
        id: 'boundary-1',
        page: 1,
        regionId: region.id,
        fromLineId: 'line-1',
        toLineId: 'line-2',
        outcome: 'removed-discretionary-hyphen',
        evidence: ['same-document-unhyphenated-word'],
      },
      {
        id: 'boundary-2',
        page: 1,
        regionId: region.id,
        fromLineId: 'line-2',
        toLineId: 'line-3',
        outcome: 'space',
        evidence: ['ordinary-wrap'],
      },
    ]

    const replay = replayPdfRegionLineRanges(region, decisions)

    expect(replay?.text).toBe(region.text)
    expect(replay?.ranges).toEqual(
      new Map([
        ['line-1', { start: 0, end: 13 }],
        ['line-2', { start: 13, end: 28 }],
        ['line-3', { start: 29, end: 33 }],
      ]),
    )
  })

  it('replays the exact duplicate boundary occurrence by transition identity', () => {
    const region: PdfPageRegion = {
      id: 'page-001-region-001',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'First dupli-cate token and second dupli-cate token.',
      confidence: 0.9,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.06,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [
        'First dupli-',
        'cate token and second dupli-',
        'cate token.',
      ].map((text, index) => ({
        id: `line-${index + 1}`,
        text,
        fontSize: 10,
        box: {
          page: 1,
          x: 0.1,
          y: 0.2 + index * 0.02,
          width: 0.7,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text' as const,
        },
        runs: [],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const decisions: PdfLineBoundaryDecision[] = [
      {
        id: 'boundary-1',
        page: 1,
        regionId: region.id,
        fromLineId: 'line-1',
        toLineId: 'line-2',
        outcome: 'unresolved',
        evidence: ['source-line-separator-preserved'],
      },
      {
        id: 'boundary-2',
        page: 1,
        regionId: region.id,
        fromLineId: 'line-2',
        toLineId: 'line-3',
        outcome: 'removed-discretionary-hyphen',
        evidence: [],
      },
    ]

    expect(replayPdfRegionLineText(region, decisions)).toBe(
      'First dupli- cate token and second duplicate token.',
    )
  })

  it('builds bounded source-backed context for one exact transition', () => {
    const longPrefix = 'context '.repeat(80)
    const region: PdfPageRegion = {
      id: 'page-001-region-001',
      page: 1,
      kind: 'body',
      column: 'single',
      text: `${longPrefix}scenar-io continues`,
      confidence: 0.9,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.06,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [
        {
          id: 'page-001-line-0001',
          text: `${longPrefix}scenar-`,
          fontSize: 10,
          box: {
            page: 1,
            x: 0.1,
            y: 0.2,
            width: 0.7,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text',
          },
          runs: [
            {
              page: 1,
              text: longPrefix,
              x: 0.1,
              y: 0.2,
              width: 0.7,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 10,
              confidence: 1,
            },
          ],
        },
        {
          id: 'page-001-line-0002',
          text: 'io continues',
          fontSize: 10,
          box: {
            page: 1,
            x: 0.1,
            y: 0.22,
            width: 0.7,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text',
          },
          runs: [],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const transition: PdfLineBoundaryDecision = {
      id: 'line-boundary-001',
      page: 1,
      regionId: region.id,
      fromLineId: region.lines[0].id,
      toLineId: region.lines[1].id,
      outcome: 'unresolved',
      evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
    }

    const context = buildPdfLineJoinReviewContext(region, transition)

    expect(context).toMatchObject({
      identity: {
        transitionId: transition.id,
        regionId: region.id,
        fromLineId: region.lines[0].id,
        toLineId: region.lines[1].id,
      },
      page: 1,
      from: {
        id: region.lines[0].id,
        text: expect.stringMatching(/scenar-$/u),
        truncated: true,
      },
      to: {
        id: region.lines[1].id,
        text: 'io continues',
        truncated: false,
      },
    })
    expect(context!.from.text.length).toBeLessThanOrEqual(241)
    expect(context!.to.text.length).toBeLessThanOrEqual(241)
    expect(JSON.stringify(context)).not.toContain(longPrefix)

    expect(
      buildPdfLineJoinReviewContext(region, {
        ...transition,
        id: 'line-boundary-ambiguous-001',
        outcome: 'ambiguous',
      }),
    ).toMatchObject({
      identity: {
        transitionId: 'line-boundary-ambiguous-001',
        regionId: region.id,
        fromLineId: region.lines[0].id,
        toLineId: region.lines[1].id,
      },
    })
  })

  it('rejects non-adjacent or mismatched line-transition context', () => {
    const region: PdfPageRegion = {
      id: 'page-001-region-001',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'first second third',
      confidence: 0.9,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.06,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: ['first', 'second', 'third'].map((text, index) => ({
        id: `line-${index + 1}`,
        text,
        fontSize: 10,
        box: {
          page: 1,
          x: 0.1,
          y: 0.2 + index * 0.02,
          width: 0.7,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text' as const,
        },
        runs: [],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }

    expect(
      buildPdfLineJoinReviewContext(region, {
        id: 'line-boundary-001',
        page: 1,
        regionId: region.id,
        fromLineId: 'line-1',
        toLineId: 'line-3',
        outcome: 'unresolved',
        evidence: [],
      }),
    ).toBeNull()
  })

  it('joins ordinary wrapped lines with one space', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    expect(
      joinPdfLineTexts([line('A natural reading'), line('flow.')], {
        decisions,
      }),
    ).toBe('A natural reading flow.')
    expect(decisions).toEqual([expect.objectContaining({ outcome: 'space' })])
  })

  it('accounts exactly for removed, ambiguous, and protected hyphen boundaries', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const lines = [
      'Common scenar-',
      'ios and re-',
      'form remain at 20-',
      '24 years.',
    ].map((text, index) => ({
      ...line(text),
      id: `ledger-line-${index + 1}`,
      y: 0.2 + index * 0.022,
    }))

    expect(
      joinPdfLineTexts(lines, {
        language: 'en',
        regionId: 'ledger-region',
        hardHyphenLexicon: new Set(['re-form']),
        unhyphenatedLexicon: new Set(['scenarios', 'reform']),
        decisions,
      }),
    ).toBe('Common scenarios and re-form remain at 20-24 years.')
    expect(
      decisions.map(({ fromLineId, toLineId, outcome }) => ({
        fromLineId,
        toLineId,
        outcome,
      })),
    ).toEqual([
      {
        fromLineId: 'ledger-line-1',
        toLineId: 'ledger-line-2',
        outcome: 'removed-discretionary-hyphen',
      },
      {
        fromLineId: 'ledger-line-2',
        toLineId: 'ledger-line-3',
        outcome: 'ambiguous',
      },
      {
        fromLineId: 'ledger-line-3',
        toLineId: 'ledger-line-4',
        outcome: 'preserved-lexical-hyphen',
      },
    ])
    expect(
      decisions.filter((decision) => decision.outcome === 'ambiguous'),
    ).toHaveLength(1)
    expect(decisions[1].evidence).toEqual(
      expect.arrayContaining([
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
        'hard-hyphen-form-valid:same-document',
        'ambiguous-joined-and-hard-hyphen-forms',
        'source-form-preserved',
      ]),
    )
    for (const decision of decisions.filter(
      ({ outcome }) => outcome === 'removed-discretionary-hyphen',
    )) {
      expect(decision.evidence).toEqual(
        expect.arrayContaining([
          'source-proven-wrapped-line-boundary',
          'joined-form-valid:pinned-lexicon',
          'split-point-valid:pinned-hyphenation-pattern',
          'same-document-unhyphenated-word',
          'hard-hyphen-form-not-proved',
        ]),
      )
    }
  })

  it('removes an explicit discretionary soft hyphen', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    expect(
      joinPdfLineTexts([line('inter\u00ad'), line('national')], { decisions }),
    ).toBe('international')
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'removed-discretionary-hyphen' }),
    ])
  })

  it('preserves a visible lexical hyphen without inserting a space', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    expect(
      joinPdfLineTexts(wrappedLines('evidence-', 'based methods'), {
        language: 'en',
        hardHyphenLexicon: new Set(['evidence-based']),
        decisions,
      }),
    ).toBe('evidence-based methods')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'preserved-lexical-hyphen',
        evidence: expect.arrayContaining([
          'hard-hyphen-form-valid:same-document',
        ]),
      }),
    ])
  })

  it('preserves a source separator when wrap geometry is not proven', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    expect(
      joinPdfLineTexts([line('specific scenar-'), line('ios remain')], {
        decisions,
      }),
    ).toBe('specific scenar- ios remain')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'unproven-wrapped-line-boundary',
          'source-line-separator-preserved',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('keeps a right-edge hyphen and left-reset line injectively separated', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('Qwen2.5-'),
      id: 'right-edge-line',
      x: 0.512,
      y: 0.2,
      width: 0.07,
      height: 0.013,
      column: 'right' as const,
    }
    const next = {
      ...line('Gemini 2.0 Flash Thinking Experimental'),
      id: 'left-reset-line',
      x: 0.091,
      y: 0.216,
      width: 0.38,
      height: 0.013,
      column: 'left' as const,
    }
    const text = joinPdfLineTexts([previous, next], {
      regionId: 'cross-column-region',
      decisions,
    })
    const region: PdfPageRegion = {
      id: 'cross-column-region',
      page: 1,
      kind: 'body',
      column: 'span',
      text,
      confidence: 1,
      box: {
        page: 1,
        x: next.x,
        y: previous.y,
        width: previous.x + previous.width - next.x,
        height: next.y + next.height - previous.y,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [previous, next].map((item) => ({
        id: item.id,
        text: item.text,
        fontSize: item.fontSize,
        box: {
          page: item.page,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          rotation: 0,
          method: 'pdf-text' as const,
        },
        runs: [],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }

    expect(text).toBe('Qwen2.5- Gemini 2.0 Flash Thinking Experimental')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'unproven-wrapped-line-boundary',
          'source-line-separator-preserved',
          'source-form-preserved',
        ]),
      }),
    ])
    expect(replayPdfRegionLineRanges(region, decisions)).toEqual({
      text,
      ranges: new Map([
        ['right-edge-line', { start: 0, end: 'Qwen2.5-'.length }],
        [
          'left-reset-line',
          {
            start: 'Qwen2.5- '.length,
            end: text.length,
          },
        ],
      ]),
    })
    expect(
      decisions.filter(
        ({ outcome }) => outcome === 'unresolved' || outcome === 'ambiguous',
      ),
    ).toHaveLength(1)
  })

  it('keeps one seeded cross-gutter heading continuation joined', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('3.3 Multi-Event Dependence: Diffusive Correlation and Co-'),
      id: 'heading-right-line',
      x: 0.1,
      y: 0.2,
      width: 0.78,
      column: 'right' as const,
      headingContinuationSeedId: 'heading-seed-line',
    }
    const next = {
      ...line('Jumps'),
      id: 'heading-left-continuation',
      x: 0.135,
      y: 0.222,
      width: 0.08,
      column: 'left' as const,
      headingContinuationSeedId: 'heading-seed-line',
    }

    expect(joinPdfLineTexts([previous, next], { decisions })).toBe(
      '3.3 Multi-Event Dependence: Diffusive Correlation and Co-Jumps',
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'source-proven-wrapped-line-boundary',
          'source-proven-heading-continuation',
          'source-form-preserved',
        ]),
      }),
    ])
    expect(decisions[0].evidence).not.toContain(
      'source-line-separator-preserved',
    )
  })

  it('preserves a source-proven one-off compound hyphen and leaves the join unresolved', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts(wrappedLines('The role-', 'playing model responds'), {
        decisions,
      }),
    ).toBe('The role-playing model responds')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining(['source-form-preserved']),
      }),
    ])
  })

  it('does not treat same-document recurrence as proof for an unmodeled acronym', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The ZXALPHA control is source-backed.'),
    ])

    expect(
      joinPdfLineTexts(wrappedLines('Compare ZX-', 'ALPHA controls'), {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('Compare ZX-ALPHA controls')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'joined-form-not-proved',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('requires an exact same-document occurrence alongside the pinned affix model', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The study will discover a stable representation.'),
      line('The system is discovering stable representations.'),
    ])

    expect(
      joinPdfLineTexts(wrappedLines('We dis-', 'cover a pattern'), {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('We discover a pattern')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'removed-discretionary-hyphen',
        evidence: expect.arrayContaining([
          'joined-form-valid:pinned-lexicon',
          'split-point-valid:pinned-hyphenation-pattern',
        ]),
      }),
    ])
  })

  it('requires the exact same-document nominalized form', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The models subtract integers.'),
      line('The subtraction task is bounded.'),
    ])

    expect(
      joinPdfLineTexts(wrappedLines('addition and subtrac-', 'tion tasks'), {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('addition and subtraction tasks')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: expect.arrayContaining([
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
      ]),
    })
  })

  it('requires the exact same-document inflected form', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The study discovered the same pattern.'),
      line('The later section is discovering another pattern.'),
    ])

    expect(
      joinPdfLineTexts(wrappedLines('The study dis-', 'covered a pattern'), {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('The study discovered a pattern')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: expect.arrayContaining([
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
      ]),
    })
  })

  it('requires the exact same-document y-inflected form', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The independent analysis classified each response.'),
      line('The model is classifying each response.'),
    ])

    expect(
      joinPdfLineTexts(
        wrappedLines('The result is classi-', 'fying evidence'),
        {
          language: 'en',
          unhyphenatedLexicon,
          decisions,
        },
      ),
    ).toBe('The result is classifying evidence')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: expect.arrayContaining([
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
      ]),
    })
  })

  it('requires the exact same-document derived form', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The later section measures selectivity directly.'),
      line('The selective method is stable.'),
    ])

    expect(
      joinPdfLineTexts(wrappedLines('The method is selec-', 'tive by design'), {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('The method is selective by design')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: expect.arrayContaining([
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
      ]),
    })
  })

  it('preserves a TitleCase proper-name compound only with same-document lexical evidence', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const hardHyphenLexicon = inlineHardHyphenLexicon([
      line('The Euler-Lagrange identity appears elsewhere in full.'),
    ])

    expect(
      joinPdfLineTexts(
        wrappedLines('We use the Euler-', 'Lagrange formulation.'),
        { decisions, hardHyphenLexicon, language: 'en' },
      ),
    ).toBe('We use the Euler-Lagrange formulation.')
    expect(decisions[0]).toMatchObject({
      outcome: 'preserved-lexical-hyphen',
      evidence: expect.arrayContaining([
        'hard-hyphen-form-valid:same-document',
      ]),
    })
  })

  it('pins joined and hard-hyphen lexicon normalization to en-US casing', () => {
    expect(inlineUnhyphenatedLexicon([line('ISTANBUL INDEX')])).toEqual(
      new Set(['istanbul', 'index']),
    )
    expect(inlineHardHyphenLexicon([line('ISTANBUL-INDEX')])).toEqual(
      new Set(['istanbul-index']),
    )
  })

  it('preserves a literal hyphen in a source-adjacent wrapped URL', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts(
        [
          line('See https://example.test/in-context-'),
          line('learning/index.html.'),
        ],
        { decisions },
      ),
    ).toBe('See https://example.test/in-context-learning/index.html.')
    expect(decisions[0]).toMatchObject({
      outcome: 'preserved-lexical-hyphen',
      evidence: ['url-literal-hyphen'],
    })
  })

  it.each([
    ['The API-', 'Gateway remains stable', 'The API-Gateway remains stable'],
    [
      'A Neural-',
      'Network model remains stable',
      'A Neural-Network model remains stable',
    ],
  ])(
    'keeps an unsupported proper-name-looking boundary visible but unresolved',
    (before, after, expected) => {
      const decisions: PdfLineBoundaryDecision[] = []

      expect(
        joinPdfLineTexts(wrappedLines(before, after), {
          language: 'en',
          decisions,
        }),
      ).toBe(expected)
      expect(decisions).toEqual([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: expect.arrayContaining(['source-form-preserved']),
        }),
      ])
    },
  )

  it('preserves a numeric range hyphen at a line boundary', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts([line('Ages 20-'), line('24 were included')], {
        decisions,
      }),
    ).toBe('Ages 20-24 were included')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'preserved-lexical-hyphen',
        evidence: ['numeric-hyphen-boundary'],
      }),
    ])
  })

  it('does not remove a visible hyphen from column-edge geometry alone', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('Trans-'),
      x: 0.432,
      y: 0.2,
      width: 0.046,
      height: 0.013,
    }
    const next = {
      ...line('port remains available'),
      x: 0.088,
      y: 0.214,
      width: 0.39,
      height: 0.013,
    }

    expect(joinPdfLineTexts([previous, next], { decisions })).toBe(
      'Trans- port remains available',
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'unproven-wrapped-line-boundary',
          'source-line-separator-preserved',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('fails closed on a geometry-backed rare compound without lexical proof', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = { ...line('The covariate-'), y: 0.2 }
    const next = { ...line('adjusted estimate is stable.'), y: 0.22 }
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The unrelated document lexicon is nonempty.'),
      previous,
      next,
    ])

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('The covariate-adjusted estimate is stable.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'joined-form-not-proved',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('removes a numbered-list wrap only with geometry and pinned lexical proof', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('3. Surprise: Which plot created more sus-'),
      x: 0.53,
      y: 0.2,
      width: 0.35,
      height: 0.013,
    }
    const next = {
      ...line('pense and surprise?'),
      x: 0.571,
      y: 0.216,
      width: 0.15,
      height: 0.013,
    }
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The scene creates suspense.'),
      line('The plot creates a surprising response.'),
      previous,
      next,
    ])

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('3. Surprise: Which plot created more suspense and surprise?')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: expect.arrayContaining([
        'source-proven-wrapped-line-boundary',
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
      ]),
    })
  })

  it('removes a bibliography wrap only with geometry and pinned lexical proof', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('[26] Regulation affects state regu-'),
      x: 0.121,
      y: 0.2,
      width: 0.758,
      height: 0.014,
    }
    const next = {
      ...line('lators and prediction markets.'),
      x: 0.162,
      y: 0.217,
      width: 0.4,
      height: 0.014,
    }
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('State regulators enforce the policy.'),
      line('Prediction markets require oversight.'),
      previous,
      next,
    ])

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('[26] Regulation affects state regulators and prediction markets.')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: expect.arrayContaining([
        'source-proven-wrapped-line-boundary',
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
      ]),
    })
  })

  it('removes a first-line-indent wrap when its continuation dedents within the bounded tolerance', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('The model supports gen-'),
      x: 0.12844,
      y: 0.2,
      width: 0.672,
    }
    const next = {
      ...line('eral use.'),
      x: 0.1,
      y: 0.222,
      width: 0.7,
    }

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        unhyphenatedLexicon: new Set(['general']),
        decisions,
      }),
    ).toBe('The model supports general use.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'removed-discretionary-hyphen',
        evidence: expect.arrayContaining([
          'source-proven-wrapped-line-boundary',
          'joined-form-valid:pinned-lexicon',
          'split-point-valid:pinned-hyphenation-pattern',
          'same-document-unhyphenated-word',
          'hard-hyphen-form-not-proved',
        ]),
      }),
    ])
  })

  it('removes a source-proved wrap after an inline-formula prose suffix', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previousText = '). The first stage yields a com-'
    const nextText = 'mon factor used below.'
    const previousRun = sourceOwnershipRun({
      text: previousText,
      x: 0.27,
      y: 0.2,
      width: 0.61,
      sourceSequenceIndex: 100,
    })
    const nextRun = sourceOwnershipRun({
      text: nextText,
      x: 0.12,
      y: 0.217,
      width: 0.76,
      sourceSequenceIndex: 101,
    })
    previousRun.sourceTextPaint = {
      ...previousRun.sourceTextPaint!,
      normalizedTextStart: 0,
      normalizedTextEnd: previousText.length,
    }
    nextRun.sourceTextPaint = {
      ...nextRun.sourceTextPaint!,
      normalizedTextStart: previousText.length,
      normalizedTextEnd: previousText.length + nextText.length,
    }
    const previous = {
      ...line(previousText),
      id: 'page-001-inline-stacked-0003-after',
      x: previousRun.x,
      y: previousRun.y,
      width: previousRun.width,
      height: previousRun.height,
      runs: [previousRun],
    }
    const next = {
      ...line(nextText),
      id: 'page-001-line-0004',
      x: nextRun.x,
      y: nextRun.y,
      width: nextRun.width,
      height: nextRun.height,
      runs: [nextRun],
    }

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        unhyphenatedLexicon: new Set(['common']),
        decisions,
      }),
    ).toBe('). The first stage yields a common factor used below.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'removed-discretionary-hyphen',
        evidence: expect.arrayContaining([
          'source-proven-wrapped-line-boundary',
          'joined-form-valid:pinned-lexicon',
          'split-point-valid:pinned-hyphenation-pattern',
          'same-document-unhyphenated-word',
          'hard-hyphen-form-not-proved',
        ]),
      }),
    ])
  })

  it('preserves a proved hard hyphen after an inline-formula prose suffix', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previousText = '). The first stage applies a re-'
    const nextText = 'form step below.'
    const previousRun = sourceOwnershipRun({
      text: previousText,
      x: 0.27,
      y: 0.2,
      width: 0.61,
      sourceSequenceIndex: 100,
    })
    const nextRun = sourceOwnershipRun({
      text: nextText,
      x: 0.12,
      y: 0.217,
      width: 0.76,
      sourceSequenceIndex: 101,
    })
    previousRun.sourceTextPaint = {
      ...previousRun.sourceTextPaint!,
      normalizedTextStart: 0,
      normalizedTextEnd: previousText.length,
    }
    nextRun.sourceTextPaint = {
      ...nextRun.sourceTextPaint!,
      normalizedTextStart: previousText.length,
      normalizedTextEnd: previousText.length + nextText.length,
    }
    const previous = {
      ...line(previousText),
      id: 'page-001-inline-stacked-0003-after',
      x: previousRun.x,
      y: previousRun.y,
      width: previousRun.width,
      height: previousRun.height,
      runs: [previousRun],
    }
    const next = {
      ...line(nextText),
      id: 'page-001-line-0004',
      x: nextRun.x,
      y: nextRun.y,
      width: nextRun.width,
      height: nextRun.height,
      runs: [nextRun],
    }

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        hardHyphenLexicon: new Set(['re-form']),
        unhyphenatedLexicon: new Set(['reform']),
        decisions,
      }),
    ).toBe('). The first stage applies a re-form step below.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'ambiguous',
        evidence: expect.arrayContaining([
          'source-proven-wrapped-line-boundary',
          'hard-hyphen-form-valid:same-document',
          'ambiguous-joined-and-hard-hyphen-forms',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('fails closed when an inline-formula suffix crosses paint ledgers', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previousText = '). The first stage yields a com-'
    const nextText = 'mon factor used below.'
    const previousRun = sourceOwnershipRun({
      text: previousText,
      x: 0.27,
      y: 0.2,
      width: 0.61,
      sourceSequenceIndex: 100,
    })
    const nextRun = sourceOwnershipRun({
      text: nextText,
      x: 0.12,
      y: 0.217,
      width: 0.76,
      sourceSequenceIndex: 101,
      operatorLedgerSha256: 'c'.repeat(64),
    })
    previousRun.sourceTextPaint = {
      ...previousRun.sourceTextPaint!,
      normalizedTextStart: 0,
      normalizedTextEnd: previousText.length,
    }
    nextRun.sourceTextPaint = {
      ...nextRun.sourceTextPaint!,
      normalizedTextStart: previousText.length,
      normalizedTextEnd: previousText.length + nextText.length,
    }
    const previous = {
      ...line(previousText),
      id: 'page-001-inline-stacked-0003-after',
      x: previousRun.x,
      y: previousRun.y,
      width: previousRun.width,
      height: previousRun.height,
      runs: [previousRun],
    }
    const next = {
      ...line(nextText),
      id: 'page-001-line-0004',
      x: nextRun.x,
      y: nextRun.y,
      width: nextRun.width,
      height: nextRun.height,
      runs: [nextRun],
    }

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        unhyphenatedLexicon: new Set(['common']),
        decisions,
      }),
    ).toBe('). The first stage yields a com- mon factor used below.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'unproven-wrapped-line-boundary',
          'source-line-separator-preserved',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('does not treat a later lateral transition as a first-line-indent wrap', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const lines = [
      { ...line('Context line.'), x: 0.1, y: 0.178, width: 0.7 },
      { ...line('The model supports gen-'), x: 0.12844, y: 0.2, width: 0.672 },
      { ...line('eral use.'), x: 0.1, y: 0.222, width: 0.7 },
    ]

    expect(
      joinPdfLineTexts(lines, {
        language: 'en',
        unhyphenatedLexicon: new Set(['general']),
        decisions,
      }),
    ).toBe('Context line. The model supports gen- eral use.')
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'space' }),
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'unproven-wrapped-line-boundary',
          'source-line-separator-preserved',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('keeps a large first-boundary lateral jump unresolved', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('Specifi-'),
      x: 0.74296,
      y: 0.2,
      width: 0.0525,
    }
    const next = {
      ...line('cation remains available.'),
      x: 0.1,
      y: 0.222,
      width: 0.7,
    }

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        unhyphenatedLexicon: new Set(['specification']),
        decisions,
      }),
    ).toBe('Specifi- cation remains available.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'unproven-wrapped-line-boundary',
          'source-line-separator-preserved',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('keeps a bounded first-line dedent unresolved without exact same-document proof', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = {
      ...line('The model supports gen-'),
      x: 0.12844,
      y: 0.2,
      width: 0.672,
    }
    const next = {
      ...line('eral use.'),
      x: 0.1,
      y: 0.222,
      width: 0.7,
    }

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        decisions,
      }),
    ).toBe('The model supports gen-eral use.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'source-proven-wrapped-line-boundary',
          'joined-form-valid:pinned-lexicon',
          'split-point-valid:pinned-hyphenation-pattern',
          'source-form-preserved',
        ]),
      }),
    ])
    expect(decisions[0].evidence).not.toContain(
      'same-document-unhyphenated-word',
    )
  })

  it.each([
    {
      name: 'pinned joined word',
      before: 'The amount was bor-',
      after: 'rowed by users.',
      lexicon: undefined,
      expectedText: 'The amount was borrowed by users.',
      outcome: 'removed-discretionary-hyphen',
      evidence: 'source-sequence-attested-wrapped-line-boundary',
    },
    {
      name: 'pinned fragment pair',
      before: 'The result crossed the mark-',
      after: 'huge gains followed.',
      lexicon: undefined,
      expectedText: 'The result crossed the mark-huge gains followed.',
      outcome: 'preserved-lexical-hyphen',
      evidence: 'hard-hyphen-form-valid:pinned-fragment-pair',
    },
    {
      name: 'ambiguous joined and fragment forms',
      before: 'The Cur-',
      after: 'rent estimate remains.',
      lexicon: undefined,
      expectedText: 'The Cur-rent estimate remains.',
      outcome: 'ambiguous',
      evidence: 'ambiguous-joined-and-hard-hyphen-forms',
    },
    {
      name: 'same-document TitleCase token',
      before: 'The Nor-',
      after: 'wegian article continues.',
      lexicon: new Set(['norwegian']),
      expectedText: 'The Norwegian article continues.',
      outcome: 'removed-discretionary-hyphen',
      evidence: 'same-document-unhyphenated-word',
    },
  ])(
    'uses an adjacent source text sequence to resolve a $name boundary',
    ({ before, after, lexicon, expectedText, outcome, evidence }) => {
      const decisions: PdfLineBoundaryDecision[] = []
      const previous = {
        ...line(before),
        y: 0.2,
        runs: [
          sourceOwnershipRun({
            text: before,
            x: 0.1,
            y: 0.2,
            width: 0.7,
            sourceSequenceIndex: 100,
            paint: false,
          }),
        ],
      }
      const next = {
        ...line(after),
        y: 0.222,
        runs: [
          sourceOwnershipRun({
            text: after,
            x: 0.1,
            y: 0.222,
            width: 0.7,
            sourceSequenceIndex: 101,
            paint: false,
          }),
        ],
      }

      expect(
        joinPdfLineTexts([previous, next], {
          language: 'en',
          ...(lexicon ? { unhyphenatedLexicon: lexicon } : {}),
          decisions,
        }),
      ).toBe(expectedText)
      expect(decisions).toEqual([
        expect.objectContaining({
          outcome,
          evidence: expect.arrayContaining([evidence]),
        }),
      ])
    },
  )

  it.each([
    {
      marker: 9,
      before: 'Naeemul Hassan, Aaditya Kulka-',
      after: 'rni, Anil Kumar Nayak. 2017.',
      expected: 'Naeemul Hassan, Aaditya Kulkarni, Anil Kumar Nayak. 2017.',
    },
    {
      marker: 15,
      before: 'James Thorne, Andreas Vlachos, and Arpit Mit-',
      after: 'tal. 2018. FEVER.',
      expected: 'James Thorne, Andreas Vlachos, and Arpit Mittal. 2018. FEVER.',
    },
  ])(
    'removes a source-proved bibliography surname wrap in reference [$marker]',
    ({ marker, before, after, expected }) => {
      const decisions: PdfLineBoundaryDecision[] = []
      const previousText = `[${marker}] ${before}`
      const previous = {
        ...line(previousText),
        y: 0.2,
        runs: [
          sourceOwnershipRun({
            text: previousText,
            x: 0.1,
            y: 0.2,
            width: 0.7,
            sourceSequenceIndex: 100,
            paint: false,
          }),
        ],
      }
      const next = {
        ...line(after),
        y: 0.222,
        runs: [
          sourceOwnershipRun({
            text: after,
            x: 0.1,
            y: 0.222,
            width: 0.7,
            sourceSequenceIndex: 101,
            paint: false,
          }),
        ],
      }

      expect(
        joinPdfLineTexts([previous, next], {
          language: 'en',
          decisions,
        }),
      ).toBe(`[${marker}] ${expected}`)
      expect(decisions).toEqual([
        expect.objectContaining({
          outcome: 'removed-discretionary-hyphen',
          evidence: expect.arrayContaining([
            'source-sequence-attested-wrapped-line-boundary',
            'bibliography-surname-context:source-reference-entry',
            'joined-form-valid:source-proved-bibliography-surname',
            'split-point-valid:pinned-hyphenation-pattern',
          ]),
        }),
      ])
    },
  )

  it.each([
    {
      name: 'no source reference marker',
      before: 'Naeemul Hassan, Aaditya Kulka-',
      after: 'rni, Anil Kumar Nayak. 2017.',
      previousSequence: 100,
      nextSequence: 101,
    },
    {
      name: 'no prior author-list separator',
      before: '[9] Aaditya Kulka-',
      after: 'rni, Anil Kumar Nayak. 2017.',
      previousSequence: 100,
      nextSequence: 101,
    },
    {
      name: 'no immediate given-name token',
      before: '[9] Example Author, a stray Kulka-',
      after: 'rni, remains visible.',
      previousSequence: 100,
      nextSequence: 101,
    },
    {
      name: 'no surname terminator',
      before: '[9] Naeemul Hassan, Aaditya Kulka-',
      after: 'rni methods remain visible.',
      previousSequence: 100,
      nextSequence: 101,
    },
    {
      name: 'non-adjacent source sequence',
      before: '[9] Naeemul Hassan, Aaditya Kulka-',
      after: 'rni, Anil Kumar Nayak. 2017.',
      previousSequence: 100,
      nextSequence: 104,
    },
  ])(
    'keeps a rare TitleCase wrap unresolved with $name',
    ({ before, after, previousSequence, nextSequence }) => {
      const decisions: PdfLineBoundaryDecision[] = []
      const previous = {
        ...line(before),
        y: 0.2,
        runs: [
          sourceOwnershipRun({
            text: before,
            x: 0.1,
            y: 0.2,
            width: 0.7,
            sourceSequenceIndex: previousSequence,
            paint: false,
          }),
        ],
      }
      const next = {
        ...line(after),
        y: 0.222,
        runs: [
          sourceOwnershipRun({
            text: after,
            x: 0.1,
            y: 0.222,
            width: 0.7,
            sourceSequenceIndex: nextSequence,
            paint: false,
          }),
        ],
      }

      expect(
        joinPdfLineTexts([previous, next], {
          language: 'en',
          decisions,
        }),
      ).toBe(`${before}${after}`)
      expect(decisions).toEqual([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: expect.arrayContaining([
            'joined-form-not-proved',
            'source-form-preserved',
          ]),
        }),
      ])
      expect(decisions[0].evidence).not.toContain(
        'bibliography-surname-context:source-reference-entry',
      )
    },
  )
})
