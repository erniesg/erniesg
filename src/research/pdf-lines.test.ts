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

  it('keeps Cur-/rent ambiguous even in source-proved bibliography-like context', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previousText = '[7] Example Author, Ada Cur-'
    const nextText = 'rent, Bob Example. 2024.'
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
      ...line(nextText),
      y: 0.222,
      runs: [
        sourceOwnershipRun({
          text: nextText,
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
    ).toBe('[7] Example Author, Ada Cur-rent, Bob Example. 2024.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'ambiguous',
        evidence: expect.arrayContaining([
          'hard-hyphen-form-valid:pinned-fragment-pair',
          'ambiguous-joined-and-hard-hyphen-forms',
        ]),
      }),
    ])
  })

  it('does not infer source-sequence lexical proof across a non-adjacent source interval', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previousText = 'The amount was bor-'
    const nextText = 'rowed by users.'
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
      ...line(nextText),
      y: 0.222,
      runs: [
        sourceOwnershipRun({
          text: nextText,
          x: 0.1,
          y: 0.222,
          width: 0.7,
          sourceSequenceIndex: 103,
          paint: false,
        }),
      ],
    }

    expect(
      joinPdfLineTexts([previous, next], {
        language: 'en',
        decisions,
      }),
    ).toBe('The amount was bor-rowed by users.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.not.arrayContaining([
          'source-sequence-attested-wrapped-line-boundary',
        ]),
      }),
    ])
  })

  it('preserves an already compound token across another printed hyphen boundary', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts(
        wrappedLines('Two lexical-similarity-', 'based metrics remain.'),
        { decisions },
      ),
    ).toBe('Two lexical-similarity-based metrics remain.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'compound-token-boundary',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('preserves a visible boundary that continues a multi-part hyphen chain', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts(
        wrappedLines('The machine-', 'learning-as-a-service market expanded.'),
        { decisions },
      ),
    ).toBe('The machine-learning-as-a-service market expanded.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'compound-token-boundary',
          'source-form-preserved',
        ]),
      }),
    ])
  })

  it('does not insert a space before continuation punctuation', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    expect(
      joinPdfLineTexts([line('First claim'), line(', then proof.')], {
        decisions,
      }),
    ).toBe('First claim, then proof.')
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'no-space' }),
    ])
  })

  it('rejoins a URL whose top-level domain begins on the next source line', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts(
        [
          line('The implementation is at https://github.'),
          line('com/Qianyue-Wang/DOME'),
        ],
        { decisions },
      ),
    ).toBe('The implementation is at https://github.com/Qianyue-Wang/DOME')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'no-space',
        evidence: ['wrapped-url-continuation'],
      }),
    ])

    const pathDecisions: PdfLineBoundaryDecision[] = []
    expect(
      joinPdfLineTexts(
        [
          line('The datasets are at https://github.com/'),
          line('Qianyue-Wang/DOME_dataset'),
        ],
        { decisions: pathDecisions },
      ),
    ).toBe('The datasets are at https://github.com/Qianyue-Wang/DOME_dataset')
    expect(pathDecisions).toEqual([
      expect.objectContaining({
        outcome: 'no-space',
        evidence: ['wrapped-url-continuation'],
      }),
    ])
  })

  it('does not append an unannotated prose token after a URL path boundary', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts(
        [
          line('The archive is at https://example.test/'),
          line('state-of-the-art'),
          line('methods remain under review.'),
        ],
        { decisions },
      ),
    ).toBe(
      'The archive is at https://example.test/ state-of-the-art methods remain under review.',
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'space',
        evidence: ['ordinary-wrap'],
      }),
      expect.objectContaining({
        outcome: 'space',
        evidence: ['ordinary-wrap'],
      }),
    ])
  })

  it('rejoins geometry-backed same-target URL fragments without invented wrap whitespace', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
    ): PdfSourceRun => ({
      page: 23,
      text,
      x,
      y,
      width,
      height: 0.0126,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 9.96,
      confidence: 1,
    })
    const prefix = sourceRun('Yes,', 0.744, 0.2363, 0.0283)
    const scheme = sourceRun('https:', 0.7765, 0.2363, 0.0513)
    const authority = sourceRun('//leandojo.org', 0.1895, 0.2501, 0.1196)
    const period = sourceRun('.', 0.3091, 0.2501, 0.0041)
    const page: PdfPageAnalysis = {
      page: 23,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 26,
      imageCount: 0,
      runs: [prefix, scheme, authority, period],
      links: [
        {
          id: 'pdf-link-p023-a0001',
          page: 23,
          status: 'external',
          url: 'https://leandojo.org',
          box: { ...scheme, method: 'pdf-link' },
        },
        {
          id: 'pdf-link-p023-a0002',
          page: 23,
          status: 'external',
          url: 'https://leandojo.org/',
          box: { ...authority, method: 'pdf-link' },
        },
      ],
    }
    const decisions: PdfLineBoundaryDecision[] = []

    expect(joinPdfLineTexts(groupRunsIntoLines(page), { decisions })).toBe(
      'Yes, https://leandojo.org.',
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'no-space',
        evidence: [
          'same-normalized-link-target',
          'source-link-geometry',
          'url-round-trip',
        ],
      }),
    ])
  })

  it('rejoins a link-backed URL when its final source line also contains bibliography prose', () => {
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
      height: 0.0126,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 9.96,
      confidence: 1,
    })
    const target =
      'https://www.lesswrong.com/posts/AcKRB8wDpdaN6v6ru/interpreting-gpt-the-logit-lens'
    const host = sourceRun('https://www.lesswrong.', 0.67, 0.2, 0.215)
    const path = sourceRun('com/posts/AcKRB8wDpdaN6v6ru/', 0.52, 0.215, 0.273)
    const tail = sourceRun(
      'interpreting-gpt-the-logit-lens, 2020.',
      0.52,
      0.23,
      0.368,
    )
    const accessed = sourceRun('[Accessed 14-01-2025].', 0.52, 0.245, 0.2)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters:
        host.text.length +
        path.text.length +
        tail.text.length +
        accessed.text.length,
      imageCount: 0,
      objects: [],
      runs: [host, path, tail, accessed],
      links: [host, path, tail].map((source, index) => ({
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'external' as const,
        url: target,
        box: {
          ...source,
          ...(source === tail ? { height: 0.028 } : {}),
          method: 'pdf-link' as const,
        },
      })),
    }
    const decisions: PdfLineBoundaryDecision[] = []

    expect(joinPdfLineTexts(groupRunsIntoLines(page), { decisions })).toBe(
      `${target}, 2020. [Accessed 14-01-2025].`,
    )
    expect(decisions).toHaveLength(3)
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'no-space',
          evidence: [
            'same-normalized-link-target',
            'source-link-geometry',
            'visible-url-target-prefix',
          ],
        }),
      ]),
    )
  })

  it('rejoins same-column URL fragments when the raw page order interleaves another column', () => {
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
    const scheme = sourceRun('https://proc', 0.78, 0.2, 0.105)
    const interleavedLeftColumn = sourceRun(
      'Unrelated left-column prose',
      0.1,
      0.206,
      0.3,
    )
    const continuation = sourceRun(
      'eedings.neurips.cc/example',
      0.52,
      0.212,
      0.36,
    )
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 65,
      imageCount: 0,
      runs: [scheme, interleavedLeftColumn, continuation],
      links: [
        {
          id: 'pdf-link-p001-a0001',
          page: 1,
          status: 'external',
          url: 'https://proceedings.neurips.cc/example',
          box: { ...scheme, method: 'pdf-link' },
        },
        {
          id: 'pdf-link-p001-a0002',
          page: 1,
          status: 'external',
          url: 'https://proceedings.neurips.cc/example',
          box: { ...continuation, method: 'pdf-link' },
        },
      ],
    }
    const rightColumnLines = groupRunsIntoLines(page).filter(
      (candidate) => candidate.x > 0.5,
    )
    const decisions: PdfLineBoundaryDecision[] = []

    expect(joinPdfLineTexts(rightColumnLines, { decisions })).toBe(
      'https://proceedings.neurips.cc/example',
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'no-space',
        evidence: [
          'same-normalized-link-target',
          'source-link-geometry',
          'url-round-trip',
        ],
      }),
    ])
  })

  it('preserves source spacing and records a link obligation when URL fragments do not round-trip', () => {
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
      height: 0.014,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    })
    const scheme = sourceRun('https:', 0.7, 0.2, 0.06)
    const authoredSpace = sourceRun('//example.org/a b', 0.1, 0.22, 0.2)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 23,
      imageCount: 0,
      runs: [scheme, authoredSpace],
      links: [
        {
          id: 'pdf-link-p001-a0001',
          page: 1,
          status: 'external',
          url: 'https://example.org/a%20b',
          box: { ...scheme, method: 'pdf-link' },
        },
        {
          id: 'pdf-link-p001-a0002',
          page: 1,
          status: 'external',
          url: 'https://example.org/a%20b',
          box: { ...authoredSpace, method: 'pdf-link' },
        },
      ],
    }
    const decisions: PdfLineBoundaryDecision[] = []

    expect(joinPdfLineTexts(groupRunsIntoLines(page), { decisions })).toBe(
      'https: //example.org/a b',
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'space',
        evidence: [
          'ordinary-wrap',
          'unresolved-linked-token-continuity',
          'url-round-trip-failed',
        ],
      }),
    ])
  })

  it('does not let an unrelated failed link round trip insert whitespace inside a source hyphen boundary', () => {
    const sourceRun = (
      text: string,
      y: number,
      width: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x: 0.52,
      y,
      width,
      height: 0.013,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    })
    const first = sourceRun(
      'A title investigating language mod-',
      0.7846,
      0.3688,
    )
    const second = sourceRun('els on math methods.', 0.7997, 0.24)
    const target = 'https://example.test/unrelated-target'
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: first.text.length + second.text.length,
      imageCount: 0,
      runs: [first, second],
      links: [first, second].map((source, index) => ({
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'external' as const,
        url: target,
        box: { ...source, method: 'pdf-link' as const },
      })),
    }
    const decisions: PdfLineBoundaryDecision[] = []
    const lines = groupRunsIntoLines(page)

    expect(
      joinPdfLineTexts(lines, {
        language: 'en',
        unhyphenatedLexicon: new Set(['models']),
        decisions,
      }),
    ).toBe('A title investigating language models on math methods.')
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

  it('preserves an uncertain source hyphen and records the unresolved boundary', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = { ...line('short-'), width: 0.2 }
    expect(
      joinPdfLineTexts([previous, line('continuation')], { decisions }),
    ).toBe('short- continuation')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: expect.arrayContaining([
          'source-line-separator-preserved',
          'source-form-preserved',
        ]),
      }),
    ])
  })
})

describe('PDF run grouping', () => {
  it('restores a source-contiguous delimiter and script cluster to its adjacent formula host', () => {
    const bodyY = 0.2
    const formulaY = 0.217
    const raisedY = 0.2055
    const scriptY = 0.2165
    const script = {
      height: 0.0095,
      fontSize: 8,
      fontName: 'Synthetic-CMMI8',
    }
    const runs = [
      sourceOwnershipRun({
        text: 'Let',
        x: 0.1,
        y: bodyY,
        width: 0.03,
        sourceSequenceIndex: 0,
      }),
      sourceOwnershipRun({
        text: 'νij,t(dzi, dzj) be a time-varying co-jump measure on R2',
        x: 0.135,
        y: bodyY,
        width: 0.745,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 0,
      }),
      sourceOwnershipRun({
        text: 'Writing Δ',
        x: 0.1,
        y: formulaY,
        width: 0.25,
        sourceSequenceIndex: 1,
      }),
      sourceOwnershipRun({
        text: 'p',
        x: 0.35,
        y: formulaY,
        width: 0.01,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 2,
      }),
      sourceOwnershipRun({
        text: 'k',
        x: 0.36,
        y: scriptY,
        width: 0.007,
        ...script,
        sourceSequenceIndex: 3,
      }),
      sourceOwnershipRun({
        text: ':=',
        x: 0.371,
        y: formulaY,
        width: 0.02,
        sourceSequenceIndex: 4,
      }),
      sourceOwnershipRun({
        text: 'S',
        x: 0.397,
        y: formulaY,
        width: 0.012,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 5,
      }),
      sourceOwnershipRun({
        text: '(',
        x: 0.409,
        y: raisedY,
        width: 0.009,
        fontName: 'Synthetic-CMEX10',
        sourceSequenceIndex: 6,
      }),
      sourceOwnershipRun({
        text: 'x',
        x: 0.418,
        y: formulaY,
        width: 0.011,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 7,
      }),
      sourceOwnershipRun({
        text: 'k',
        x: 0.429,
        y: scriptY,
        width: 0.007,
        ...script,
        sourceSequenceIndex: 8,
      }),
      sourceOwnershipRun({
        text: 't−',
        x: 0.429,
        y: 0.222,
        width: 0.017,
        ...script,
        sourceSequenceIndex: 9,
      }),
      sourceOwnershipRun({
        text: '+z',
        x: 0.451,
        y: formulaY,
        width: 0.028,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 10,
      }),
      sourceOwnershipRun({
        text: 'k',
        x: 0.479,
        y: 0.224,
        width: 0.007,
        ...script,
        sourceSequenceIndex: 11,
      }),
      sourceOwnershipRun({
        text: ')',
        x: 0.487,
        y: raisedY,
        width: 0.009,
        fontName: 'Synthetic-CMEX10',
        sourceSequenceIndex: 12,
      }),
      sourceOwnershipRun({
        text: '(',
        x: 0.496,
        y: raisedY,
        width: 0.004,
        fontName: 'Synthetic-CMEX10',
        sourceSequenceIndex: 13,
        paint: false,
      }),
      sourceOwnershipRun({
        text: '−S',
        x: 0.5,
        y: formulaY,
        width: 0.029,
        fontName: 'Synthetic-CMSY10',
        sourceSequenceIndex: 14,
      }),
      sourceOwnershipRun({
        text: '(',
        x: 0.529,
        y: raisedY,
        width: 0.009,
        fontName: 'Synthetic-CMEX10',
        sourceSequenceIndex: 15,
      }),
      sourceOwnershipRun({
        text: 'x',
        x: 0.538,
        y: formulaY,
        width: 0.011,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 16,
      }),
      sourceOwnershipRun({
        text: 'k',
        x: 0.549,
        y: scriptY,
        width: 0.007,
        ...script,
        sourceSequenceIndex: 17,
      }),
      sourceOwnershipRun({
        text: 't−',
        x: 0.549,
        y: 0.222,
        width: 0.017,
        ...script,
        sourceSequenceIndex: 18,
      }),
      sourceOwnershipRun({
        text: ')',
        x: 0.566,
        y: raisedY,
        width: 0.009,
        fontName: 'Synthetic-CMEX10',
        sourceSequenceIndex: 19,
      }),
      sourceOwnershipRun({
        text: ', a short-maturity expansion follows.',
        x: 0.575,
        y: formulaY,
        width: 0.305,
        sourceSequenceIndex: 20,
      }),
    ]
    // The narrow text atom between the adjacent close/open delimiters is not
    // independently inventoried, but its two paint-proved brackets share the
    // exact same text and operator ledgers.

    const grouped = groupRunsIntoLines(sourceOwnershipPage(runs))
    const formula = grouped.find((candidate) =>
      candidate.text.includes('Writing Δ'),
    )
    const upper = grouped.find((candidate) =>
      candidate.text.includes('co-jump measure'),
    )
    const restoredOrders = new Set([3, 6, 8, 12, 13, 15, 17, 19])

    expect(formula?.runs.map((run) => run.sourceSequenceIndex)).toEqual(
      runs.slice(2).map((run) => run.sourceSequenceIndex),
    )
    expect(
      formula?.runs
        .filter((run) => restoredOrders.has(run.sourceSequenceIndex!))
        .map((run) => run.text),
    ).toEqual(['k', '(', 'k', ')', '(', '(', 'k', ')'])
    expect(
      upper?.runs.some((run) => restoredOrders.has(run.sourceSequenceIndex!)),
    ).toBe(false)
    expect(grouped.flatMap((candidate) => candidate.runs)).toHaveLength(
      runs.length,
    )
  })

  it.each([
    {
      failure: 'a conflicting operator paint ledger',
      mutate(runs: PdfSourceRun[]) {
        runs[4] = {
          ...runs[4],
          sourceTextPaint: {
            ...runs[4].sourceTextPaint!,
            operatorLedgerSha256: 'c'.repeat(64),
          },
        }
      },
    },
    {
      failure: 'a cross-page atom',
      mutate(runs: PdfSourceRun[]) {
        runs[4] = { ...runs[4], page: 2 }
      },
    },
    {
      failure: 'a cross-layer extraction method',
      mutate(runs: PdfSourceRun[]) {
        runs[4] = { ...runs[4], method: 'ocr' }
      },
    },
    {
      failure: 'an endpoint with missing paint provenance',
      mutate(runs: PdfSourceRun[]) {
        delete runs[3].sourceTextPaint
      },
    },
    {
      failure: 'multiple atoms with missing paint provenance',
      mutate(runs: PdfSourceRun[]) {
        delete runs[4].sourceTextPaint
        delete runs[5].sourceTextPaint
      },
    },
  ])('fails closed for $failure', ({ mutate }) => {
    const runs = singleSourceOwnershipCluster()
    mutate(runs)

    const grouped = groupRunsIntoLines(sourceOwnershipPage(runs))
    const ownerOf = (run: PdfSourceRun) =>
      grouped.find((candidate) => candidate.runs.includes(run))

    expect(ownerOf(runs[4])).toBe(ownerOf(runs[0]))
    expect(ownerOf(runs[4])).not.toBe(ownerOf(runs[3]))
  })

  it('fails closed when the two immediate source neighbors have different owners', () => {
    const runs = singleSourceOwnershipCluster()
    runs[5] = { ...runs[5], y: 0.24 }

    const grouped = groupRunsIntoLines(sourceOwnershipPage(runs))
    const ownerOf = (run: PdfSourceRun) =>
      grouped.find((candidate) => candidate.runs.includes(run))

    expect(ownerOf(runs[3])).not.toBe(ownerOf(runs[5]))
    expect(ownerOf(runs[4])).toBe(ownerOf(runs[0]))
    expect(ownerOf(runs[4])).not.toBe(ownerOf(runs[3]))
  })

  it('fails closed when a nonadjacent prose source atom interrupts the formula host', () => {
    const runs = singleSourceOwnershipCluster()
    const interruption = sourceOwnershipRun({
      text: 'aside',
      x: 0.78,
      y: 0.2,
      width: 0.06,
      sourceSequenceIndex: 40,
    })
    runs.splice(5, 0, interruption)

    const grouped = groupRunsIntoLines(sourceOwnershipPage(runs))
    const ownerOf = (run: PdfSourceRun) =>
      grouped.find((candidate) => candidate.runs.includes(run))

    expect(ownerOf(interruption)).toBe(ownerOf(runs[0]))
    expect(ownerOf(runs[4])).toBe(ownerOf(runs[0]))
    expect(ownerOf(runs[4])).not.toBe(ownerOf(runs[3]))
  })

  it('fails closed when the neighboring owner is prose-only', () => {
    const runs = singleSourceOwnershipCluster()
    const prose = [
      ['Writing a', 'Synthetic-CMR12'],
      ['word', 'Synthetic-CMR12'],
      ['next', 'Synthetic-CMR12'],
      ['phrase', 'Synthetic-CMR12'],
      [') and a short-maturity expansion follows.', 'Synthetic-CMR12'],
    ] as const
    for (const [index, [text, fontName]] of [2, 3, 5, 6, 7].map(
      (runIndex, proseIndex) => [runIndex, prose[proseIndex]] as const,
    )) {
      runs[index] = { ...runs[index], text, fontName }
    }

    const grouped = groupRunsIntoLines(sourceOwnershipPage(runs))
    const ownerOf = (run: PdfSourceRun) =>
      grouped.find((candidate) => candidate.runs.includes(run))

    expect(ownerOf(runs[4])).toBe(ownerOf(runs[0]))
    expect(ownerOf(runs[4])).not.toBe(ownerOf(runs[3]))
  })

  it('fails closed when an equally plausible adjacent formula host competes geometrically', () => {
    const runs = singleSourceOwnershipCluster()
    runs.push(
      sourceOwnershipRun({
        text: 'q+',
        x: 0.34,
        y: 0.1905,
        width: 0.03,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 8,
      }),
      sourceOwnershipRun({
        text: 'r',
        x: 0.374,
        y: 0.1905,
        width: 0.03,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 9,
      }),
    )

    const grouped = groupRunsIntoLines(sourceOwnershipPage(runs))
    const ownerOf = (run: PdfSourceRun) =>
      grouped.find((candidate) => candidate.runs.includes(run))

    expect(ownerOf(runs[8])).toBe(ownerOf(runs[9]))
    expect(ownerOf(runs[8])).not.toBe(ownerOf(runs[0]))
    expect(ownerOf(runs[8])).not.toBe(ownerOf(runs[3]))
    expect(ownerOf(runs[4])).toBe(ownerOf(runs[0]))
    expect(ownerOf(runs[4])).not.toBe(ownerOf(runs[3]))
  })

  it('preserves genuine same-line large delimiters', () => {
    const runs = [
      sourceOwnershipRun({
        text: 'F',
        x: 0.3,
        y: 0.2,
        width: 0.02,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 0,
      }),
      sourceOwnershipRun({
        text: '(',
        x: 0.32,
        y: 0.194,
        width: 0.012,
        height: 0.026,
        fontSize: 18,
        fontName: 'Synthetic-CMEX10',
        sourceSequenceIndex: 1,
      }),
      sourceOwnershipRun({
        text: 'x+z',
        x: 0.332,
        y: 0.2,
        width: 0.05,
        fontName: 'Synthetic-CMMI12',
        sourceSequenceIndex: 2,
      }),
      sourceOwnershipRun({
        text: ')',
        x: 0.382,
        y: 0.194,
        width: 0.012,
        height: 0.026,
        fontSize: 18,
        fontName: 'Synthetic-CMEX10',
        sourceSequenceIndex: 3,
      }),
      sourceOwnershipRun({
        text: '=0',
        x: 0.394,
        y: 0.2,
        width: 0.035,
        sourceSequenceIndex: 4,
      }),
    ]

    const grouped = groupRunsIntoLines(sourceOwnershipPage(runs))

    expect(grouped).toHaveLength(1)
    expect(grouped[0].runs).toEqual(runs)
  })

  it('orders vertically stacked equal-x math atoms independently of input order', () => {
    const numerator = sourceOwnershipRun({
      text: '1',
      x: 0.3,
      y: 0.2,
      width: 0.008,
      height: 0.008,
      fontSize: 7,
      fontName: 'Synthetic-CMMI7',
      sourceSequenceIndex: 0,
    })
    const denominator = sourceOwnershipRun({
      text: '2',
      x: 0.3,
      y: 0.204,
      width: 0.008,
      height: 0.008,
      fontSize: 7,
      fontName: 'Synthetic-CMMI7',
      sourceSequenceIndex: 1,
    })
    const textFor = (runs: PdfSourceRun[]) =>
      groupRunsIntoLines(sourceOwnershipPage(runs))
        .map((candidate) => candidate.text)
        .join('')

    expect(textFor([numerator, denominator])).toBe('12')
    expect(textFor([denominator, numerator])).toBe('12')
  })

  it('honors explicit PDF text-item whitespace across a sub-threshold run gap', () => {
    const sourceRun = (
      text: string,
      x: number,
      width: number,
      sourceSequenceIndex: number,
      sourceWhitespacePredecessorIndex?: number,
    ): PdfSourceRun => {
      const base = {
        page: 34,
        text,
        x,
        y: 0.2,
        width,
        height: 0.0044,
        fontSize: 3.5,
        fontName: 'Body',
        rotation: 0,
        method: 'pdf-text' as const,
        confidence: 1,
        sourceSequenceIndex,
      }
      return sourceWhitespacePredecessorIndex === undefined
        ? base
        : {
            ...base,
            sourceWhitespaceBefore: 'pdf-text-item' as const,
            sourceWhitespacePredecessorIndex,
          }
    }
    const page: PdfPageAnalysis = {
      page: 34,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 17,
      imageCount: 0,
      runs: [
        sourceRun('And', 0.1, 0.01, 0),
        sourceRun('Seraphi', 0.111, 0.02, 1, 0),
        sourceRun('held', 0.132, 0.012, 2, 1),
      ],
    }

    expect(groupRunsIntoLines(page)[0].text).toBe('And Seraphi held')
  })

  it('does not invent whitespace between a mathematical operator and its opening delimiter', () => {
    const runs = [
      sourceOwnershipRun({
        text: '𝐸',
        x: 0.80741,
        y: 0.2,
        width: 0.01046,
        fontName: 'Synthetic-Math-Italic',
        sourceSequenceIndex: 0,
      }),
      sourceOwnershipRun({
        text: '√',
        x: 0.66472,
        y: 0.2,
        width: 0.01549,
        fontName: 'Synthetic-Math-Operator',
        sourceSequenceIndex: 1,
      }),
      sourceOwnershipRun({
        text: '(',
        x: 0.69349,
        y: 0.2,
        width: 0.00863,
        fontName: 'Synthetic-Math-Regular',
        sourceSequenceIndex: 2,
      }),
      sourceOwnershipRun({
        text: ')',
        x: 0.77774,
        y: 0.2,
        width: 0.00891,
        fontName: 'Synthetic-Math-Regular',
        sourceSequenceIndex: 3,
      }),
    ]

    expect(mergePdfRunText(runs)).toBe('𝐸√()')
    expect(
      mergePdfRunText([
        ...runs.slice(0, 2),
        {
          ...runs[2],
          sourceWhitespaceBefore: 'pdf-text-item',
          sourceWhitespacePredecessorIndex: 1,
        },
        runs[3],
      ]),
    ).toBe('𝐸√ ()')

    expect(
      mergePdfRunText([
        sourceOwnershipRun({
          text: '√',
          x: 0.391877451,
          y: 0.3973931818,
          width: 0.01927404967,
          fontName: 'Synthetic-Math-Operator',
          sourceSequenceIndex: 112,
        }),
        sourceOwnershipRun({
          text: '√',
          x: 0.391877451,
          y: 0.4040409091,
          width: 0.01927404967,
          fontName: 'Synthetic-Math-Operator',
          sourceSequenceIndex: 113,
        }),
        sourceOwnershipRun({
          text: '(',
          x: 0.4131062092,
          y: 0.4024689394,
          width: 0.007618458824,
          fontName: 'Synthetic-Math-Regular',
          sourceSequenceIndex: 116,
        }),
      ]),
    ).toBe('√√ (')
  })

  it('retains repeated lexical and numeric word boundaries from PDF text items', () => {
    const tokens = ['happiness', '3', 'sadness', '7', 'disgust', '0']
    const runs = tokens.map<PdfSourceRun>((text, index) => {
      const base = {
        page: 34,
        text,
        x: 0.1 + index * 0.012,
        y: 0.2,
        width: 0.011,
        height: 0.0044,
        fontSize: 3.5,
        fontName: 'Body',
        rotation: 0,
        method: 'pdf-text' as const,
        confidence: 1,
        sourceSequenceIndex: index,
      }
      return index > 0
        ? {
            ...base,
            sourceWhitespaceBefore: 'pdf-text-item' as const,
            sourceWhitespacePredecessorIndex: index - 1,
          }
        : base
    })
    const page: PdfPageAnalysis = {
      page: 34,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: tokens.join('').length,
      imageCount: 0,
      runs,
    }

    expect(groupRunsIntoLines(page)[0].text).toBe(
      'happiness 3 sadness 7 disgust 0',
    )
  })

  it('ignores whitespace transferred from a nonadjacent PDF source item after spatial sorting', () => {
    const sourceRun = (
      text: string,
      x: number,
      sourceSequenceIndex: number,
      sourceWhitespacePredecessorIndex?: number,
    ): PdfSourceRun => {
      const base = {
        page: 1,
        text,
        x,
        y: 0.2,
        width: 0.01,
        height: 0.01,
        fontSize: 8,
        fontName: 'Body',
        rotation: 0,
        method: 'pdf-text' as const,
        confidence: 1,
        sourceSequenceIndex,
      }
      return sourceWhitespacePredecessorIndex === undefined
        ? base
        : {
            ...base,
            sourceWhitespaceBefore: 'pdf-text-item' as const,
            sourceWhitespacePredecessorIndex,
          }
    }
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 3,
      imageCount: 0,
      // Content-stream order says A, whitespace, B, C. Geometry says CBA.
      // The A→B boundary must not become a false C→B boundary after x-sort.
      runs: [
        sourceRun('A', 0.12, 0),
        sourceRun('B', 0.11, 1, 0),
        sourceRun('C', 0.1, 2),
      ],
    }

    expect(groupRunsIntoLines(page)[0].text).toBe('CBA')
  })

  it('does not let explicit whitespace override punctuation attachment', () => {
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 14,
      imageCount: 0,
      runs: [
        {
          page: 1,
          text: 'Result',
          x: 0.1,
          y: 0.2,
          width: 0.05,
          height: 0.01,
          fontSize: 8,
          fontName: 'Body',
          rotation: 0,
          method: 'pdf-text',
          confidence: 1,
          sourceSequenceIndex: 0,
        },
        {
          page: 1,
          text: ',',
          x: 0.151,
          y: 0.2,
          width: 0.004,
          height: 0.01,
          fontSize: 8,
          fontName: 'Body',
          rotation: 0,
          method: 'pdf-text',
          confidence: 1,
          sourceSequenceIndex: 1,
          sourceWhitespaceBefore: 'pdf-text-item',
          sourceWhitespacePredecessorIndex: 0,
        },
        {
          page: 1,
          text: 'confirmed',
          x: 0.156,
          y: 0.2,
          width: 0.06,
          height: 0.01,
          fontSize: 8,
          fontName: 'Body',
          rotation: 0,
          method: 'pdf-text',
          confidence: 1,
          sourceSequenceIndex: 2,
          sourceWhitespaceBefore: 'pdf-text-item',
          sourceWhitespacePredecessorIndex: 1,
        },
      ],
    }

    expect(groupRunsIntoLines(page)[0].text).toBe('Result, confirmed')
  })

  it('restores a missing sentence space after a single-letter source token', () => {
    const sourceRun = (
      text: string,
      x: number,
      width: number,
      fontName = 'Body',
    ): PdfSourceRun => ({
      page: 4,
      text,
      x,
      y: 0.713,
      width,
      height: 0.013,
      fontSize: 10.9,
      fontName,
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const page: PdfPageAnalysis = {
      page: 4,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 50,
      imageCount: 0,
      runs: [
        sourceRun('D', 0.5143, 0.0152, 'CMMI10'),
        sourceRun(
          '.Previous works have used higher-level attributes',
          0.53,
          0.351,
        ),
      ],
    }

    expect(groupRunsIntoLines(page)[0].text).toBe(
      'D. Previous works have used higher-level attributes',
    )
  })

  it('restores the same bounded sentence space inside one source run without changing dotted identifiers', () => {
    const sourceRun = (text: string, y: number): PdfSourceRun => ({
      page: 6,
      text,
      x: 0.1,
      y,
      width: 0.7,
      height: 0.013,
      fontSize: 10.9,
      fontName: 'Body',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const page: PdfPageAnalysis = {
      page: 6,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 76,
      imageCount: 0,
      runs: [
        sourceRun('The details are in Appendix A.We use Qwen1.5.', 0.2),
        sourceRun('The torch.nn.Module identifier stays intact.', 0.24),
      ],
    }

    expect(groupRunsIntoLines(page).map((line) => line.text)).toEqual([
      'The details are in Appendix A. We use Qwen1.5.',
      'The torch.nn.Module identifier stays intact.',
    ])
  })

  it('restores collapsed prose sentence boundaries before unambiguous sentence starters', () => {
    const sourceRun = (text: string): PdfSourceRun => ({
      page: 1,
      text,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.013,
      fontSize: 10.9,
      fontName: 'Body',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 150,
      imageCount: 0,
      runs: [
        sourceRun(
          'This can cause conflicts.Other works agree. Recent works differ.The first category is deterministic.',
        ),
      ],
    }

    expect(groupRunsIntoLines(page)[0].text).toBe(
      'This can cause conflicts. Other works agree. Recent works differ. The first category is deterministic.',
    )
  })

  it('places a source-adjacent positioned accent on the first glyph of its peer run', () => {
    const sourceRun = (
      text: string,
      x: number,
      width: number,
      y = 0.6103856,
    ): PdfSourceRun => ({
      page: 7,
      text,
      x,
      y,
      width,
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Synthetic-CMR10',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const prefix = sourceRun('Prior work cites Kram', 0.09, 0.24281)
    const accent = sourceRun('´', 0.33371, 0.00542, 0.6103225)
    const peer = sourceRun('ar et al. (2024)). We', 0.33281, 0.14014)
    const continuation = sourceRun(
      'find the result useful.',
      0.09,
      0.16,
      0.6254803,
    )
    const page: PdfPageAnalysis = {
      page: 7,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: [prefix, accent, peer, continuation].reduce(
        (total, run) => total + run.text.length,
        0,
      ),
      imageCount: 0,
      runs: [prefix, accent, peer, continuation],
    }

    const grouped = groupRunsIntoLines(page)

    expect(grouped.map((line) => line.text)).toEqual([
      'Prior work cites Kramár et al. (2024)). We',
      'find the result useful.',
    ])
    expect(grouped[0].runs).toEqual([prefix, accent, peer])
    expect(grouped[0].runs[1]).toMatchObject({
      text: '´',
      x: 0.33371,
      y: 0.6103225,
      width: 0.00542,
      height: 0.012579,
    })
  })

  it('keeps prose on both sides of an inline Computer Modern accent', () => {
    const sourceRun = (
      text: string,
      x: number,
      width: number,
      fontName = 'Synthetic-CMR12',
      y = 0.4,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height: 0.0142,
      fontSize: 12,
      fontName,
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 68,
      imageCount: 0,
      runs: [
        sourceRun('that boost', 0.12, 0.09),
        sourceRun('λ', 0.219, 0.011, 'Synthetic-CMMI12'),
        sourceRun('̂', 0.2192, 0.011, 'Synthetic-CMEX10', 0.396),
        sourceRun('ex-ante; the boost is capped at the smoothed', 0.239, 0.5),
        sourceRun('λ', 0.747, 0.011, 'Synthetic-CMMI12'),
        sourceRun('̂', 0.7472, 0.011, 'Synthetic-CMEX10', 0.396),
        sourceRun('to', 0.766, 0.018),
      ],
    }

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      ['that boost λ̂ ex-ante; the boost is capped at the smoothed λ̂ to'],
    )
  })

  it('keeps a displaced math-extension delimiter with formula runs instead of nearby prose', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height: 0.0142,
      fontSize: 11,
      fontName,
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const runs = [
      sourceRun(
        'Writing a possibly time-varying co-jump measure',
        0.1,
        0.37798,
        0.2,
        'SyntheticBody',
      ),
      sourceRun('(', 0.312, 0.37798, 0.012, 'Synthetic-CMEX10'),
      sourceRun(')', 0.512, 0.37798, 0.012, 'Synthetic-CMEX10'),
      sourceRun('S', 0.291, 0.38948, 0.02, 'Synthetic-CMMI10'),
      sourceRun('x + z', 0.326, 0.38948, 0.18, 'Synthetic-CMMI10'),
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

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      ['Writing a possibly time-varying co-jump measure', 'S(x + z)'],
    )
  })

  it.each(['where', '(see)'])(
    'does not treat short prose as formula context for a CMEX delimiter: %s',
    (bodyText) => {
      const sourceRun = (
        text: string,
        x: number,
        y: number,
        width: number,
        fontName: string,
      ): PdfSourceRun => ({
        page: 1,
        text,
        x,
        y,
        width,
        height: 0.0142,
        fontSize: 11,
        fontName,
        rotation: 0,
        method: 'pdf-text',
        confidence: 1,
      })
      const runs = [
        sourceRun(bodyText, 0.1, 0.37798, 0.2, 'SyntheticBody'),
        sourceRun('(', 0.312, 0.37798, 0.012, 'Synthetic-CMEX10'),
        sourceRun(')', 0.512, 0.37798, 0.012, 'Synthetic-CMEX10'),
        sourceRun('S', 0.291, 0.38948, 0.02, 'Synthetic-CMMI10'),
        sourceRun('x + z', 0.326, 0.38948, 0.18, 'Synthetic-CMMI10'),
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

      expect(
        groupRunsIntoLines(page).map((candidate) => candidate.text),
      ).toEqual([bodyText, 'S(x + z)'])
    },
  )

  it('keeps a raised CMEX operator with the source-adjacent formula baseline instead of overlapping prose', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontSize: number,
      fontName: string,
    ): PdfSourceRun => ({
      page: 3,
      text,
      x,
      y,
      width,
      height,
      fontSize,
      fontName,
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const bodyHeight = 0.012579040404040405
    const bodySize = 9.9626
    const summation = sourceRun(
      '∑',
      0.55668954248366,
      0.4738287878787878,
      0.017183857124183008,
      bodyHeight,
      bodySize,
      'FGHMGO+CMEX10',
    )
    // These normalized boxes and their content-stream order reproduce page 3
    // of 2503.13992v1. The large operator is painted after the next prose
    // baseline's leading runs even though its raised box sorts above them.
    const runs = [
      sourceRun(
        'former (Radford et al., 2018))',
        0.17647058823529402,
        0.46942601010101,
        0.19646833235294128,
        bodyHeight,
        bodySize,
        'NFNFBN+NimbusRomNo9L-Regu',
      ),
      sourceRun(
        'p',
        0.3775359477124182,
        0.46942601010101,
        0.008189843235294118,
        bodyHeight,
        bodySize,
        'PWJDEN+CMMI10',
      ),
      sourceRun(
        '(xi|x<i)',
        0.3857254901960784,
        0.46942601010101,
        0.05681666666666667,
        bodyHeight,
        bodySize,
        'BXDUJX+CMR10',
      ),
      sourceRun(
        ', one can use the arithmetic coding algorithm to compress',
        0.44253104575163393,
        0.46942601010101,
        0.3810043349673206,
        bodyHeight,
        bodySize,
        'NFNFBN+NimbusRomNo9L-Regu',
      ),
      sourceRun(
        'a particular sequence',
        0.17647058823529402,
        0.4832631313131312,
        0.14033917418300654,
        bodyHeight,
        bodySize,
        'NFNFBN+NimbusRomNo9L-Regu',
      ),
      sourceRun(
        'x',
        0.32234803921568617,
        0.4832631313131312,
        0.009303310294117647,
        bodyHeight,
        bodySize,
        'PWJDEN+CMMI10',
      ),
      sourceRun(
        'to a bitstream of length about',
        0.3371879084967319,
        0.4832631313131312,
        0.19858457091503287,
        bodyHeight,
        bodySize,
        'NFNFBN+NimbusRomNo9L-Regu',
      ),
      sourceRun(
        '−',
        0.5413153594771241,
        0.4832631313131312,
        0.012661618104575162,
        bodyHeight,
        bodySize,
        'CXZODH+CMSY10',
      ),
      summation,
      sourceRun(
        'i',
        0.5738725490196077,
        0.49081085858585854,
        0.00460589862745098,
        0.00880530303030303,
        6.9738,
        'HMJELQ+CMMI7',
      ),
      sourceRun(
        'log',
        0.5820049019607841,
        0.4832631313131313,
        0.020800997189542487,
        bodyHeight,
        bodySize,
        'BXDUJX+CMR10',
      ),
      sourceRun(
        '2',
        0.603032679738562,
        0.49011262626262625,
        0.006489508333333333,
        0.00880530303030303,
        6.9738,
        'RCUBZU+CMR7',
      ),
      sourceRun(
        'p(xi|x<i)',
        0.613047385620915,
        0.4832631313131313,
        0.06499584248366012,
        bodyHeight,
        bodySize,
        'PWJDEN+CMMI10',
      ),
      sourceRun(
        'bits (Rissanen, 1976;',
        0.6835784313725489,
        0.4832631313131313,
        0.1399484839869282,
        bodyHeight,
        bodySize,
        'NFNFBN+NimbusRomNo9L-Regu',
      ),
    ]
    const page: PdfPageAnalysis = {
      page: 3,
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
    const prose = grouped.find((line) => line.text.includes('to compress'))
    const formula = grouped.find((line) => line.text.includes('length about'))

    expect(prose?.runs).not.toContain(summation)
    expect(prose?.text).not.toContain('∑')
    expect(formula?.runs).toContain(summation)
    expect(formula?.text).toMatch(/−\s*∑i log/u)
    expect(grouped.flatMap((line) => line.runs)).toEqual(
      expect.arrayContaining(runs),
    )
    expect(grouped.flatMap((line) => line.runs)).toHaveLength(runs.length)
  })

  it('uses the full vertical union when a raised run joins a baseline line', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontSize: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height,
      fontSize,
      fontName: 'SyntheticMath',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 9,
      imageCount: 0,
      objects: [],
      runs: [
        sourceRun('1', 0.1, 0.195, 0.01, 0.012, 7),
        sourceRun('Baseline', 0.11, 0.2, 0.12, 0.02, 10),
      ],
    }

    const grouped = groupRunsIntoLines(page)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].y).toBeCloseTo(0.195)
    expect(grouped[0].height).toBeCloseTo(0.025)
    expect(grouped[0].y + grouped[0].height).toBeCloseTo(0.22)
  })

  it('does not let vertically chained diagram labels absorb caption and prose rows', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontSize: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height,
      fontSize,
      fontName: 'SyntheticDiagram',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const denseDiagramLabels = Array.from({ length: 20 }, (_, index) =>
      sourceRun(
        `d${index}`,
        0.1 + (index % 4) * 0.02,
        0.1 + index * 0.004,
        0.018,
        0.006,
        5,
      ),
    )
    const runs = [
      ...denseDiagramLabels,
      sourceRun('Figure 1:', 0.1, 0.183, 0.08, 0.012, 10),
      sourceRun('Caption prose.', 0.1, 0.197, 0.6, 0.012, 10),
      sourceRun('Body prose.', 0.1, 0.225, 0.6, 0.012, 10),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 1,
      objects: [],
      runs,
    }

    const grouped = groupRunsIntoLines(page)

    expect(grouped.map((candidate) => candidate.text)).toEqual(
      expect.arrayContaining(['Figure 1:', 'Caption prose.', 'Body prose.']),
    )
    expect(
      Math.max(...grouped.map((candidate) => candidate.height)),
    ).toBeLessThan(0.04)
  })

  it('keeps a later caption text layer separate from overprinted diagram labels', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontSize: number,
      fontName: string,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height,
      fontSize,
      fontName,
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const diagram = [
      sourceRun(
        'unfold gcd, }',
        0.215,
        0.2427,
        0.055,
        0.0054,
        4.3,
        'DiagramMono',
      ),
      sourceRun('theorem', 0.207, 0.2007, 0.026, 0.0054, 4.3, 'DiagramMono'),
      sourceRun('gcd_self', 0.237, 0.2007, 0.03, 0.0054, 4.3, 'DiagramMono'),
      sourceRun(
        '(n : nat): gcd n n = n',
        0.27,
        0.2007,
        0.12,
        0.0054,
        4.3,
        'DiagramMono',
      ),
      sourceRun('begin', 0.207, 0.2072, 0.019, 0.0054, 4.3, 'DiagramMono'),
      sourceRun('cases n', 0.215, 0.214, 0.03, 0.0054, 4.3, 'DiagramMono'),
      sourceRun('unfold gcd', 0.222, 0.2205, 0.04, 0.0054, 4.3, 'DiagramMono'),
      sourceRun(
        'rewrite mod_self',
        0.215,
        0.227,
        0.06,
        0.0054,
        4.3,
        'DiagramMono',
      ),
      sourceRun(
        'apply gcd_zero_left',
        0.215,
        0.2335,
        0.07,
        0.0054,
        4.3,
        'DiagramMono',
      ),
      sourceRun('end', 0.207, 0.24, 0.012, 0.0054, 4.3, 'DiagramMono'),
      sourceRun('nat', 0.222, 0.24, 0.012, 0.0054, 4.3, 'DiagramMono'),
      sourceRun(
        'diagram filler 1',
        0.5,
        0.12,
        0.08,
        0.0054,
        4.3,
        'DiagramMono',
      ),
      sourceRun(
        'diagram filler 2',
        0.5,
        0.13,
        0.08,
        0.0054,
        4.3,
        'DiagramMono',
      ),
    ]
    const caption = [
      sourceRun('Figure 1:', 0.176, 0.2, 0.062, 0.0126, 10, 'CaptionRoman'),
      sourceRun(
        'Top right: A model extracts proofs into datasets for training.',
        0.248,
        0.2,
        0.5,
        0.0126,
        10,
        'CaptionRoman',
      ),
      sourceRun(
        'The proof tree is shown with tactics and premises.',
        0.176,
        0.214,
        0.57,
        0.0126,
        10,
        'CaptionRoman',
      ),
      sourceRun(
        'Bottom: The next tactic is generated.',
        0.176,
        0.228,
        0.45,
        0.0126,
        10,
        'CaptionRoman',
      ),
      sourceRun(
        'environment.',
        0.176,
        0.2435,
        0.078,
        0.0126,
        10,
        'CaptionRoman',
      ),
      sourceRun('Top left', 0.267, 0.2435, 0.054, 0.0126, 10, 'CaptionRoman'),
      sourceRun(
        ': The proof tree continues on this baseline.',
        0.321,
        0.2435,
        0.41,
        0.0126,
        10,
        'CaptionRoman',
      ),
    ]
    const runs = [...diagram, ...caption]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 1,
      objects: [],
      runs,
    }

    const grouped = groupRunsIntoLines(page)
    const captionLines = grouped.filter((line) => line.fontSize === 10)

    expect(captionLines.map((line) => line.text)).toEqual([
      'Figure 1: Top right: A model extracts proofs into datasets for training.',
      'The proof tree is shown with tactics and premises.',
      'Bottom: The next tactic is generated.',
      'environment. Top left: The proof tree continues on this baseline.',
    ])
    expect(
      captionLines.every((line) =>
        line.runs.every((run) => run.fontSize === 10),
      ),
    ).toBe(true)
    expect(grouped.flatMap((line) => line.runs).length).toBe(runs.length)
  })

  it('keeps staggered two-column runs separate regardless of merge direction', () => {
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
      height: 0.013,
      fontSize: 10,
      fontName: 'SyntheticBody',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 595,
      height: 842,
      rotation: 0,
      textCharacters: 71,
      imageCount: 0,
      objects: [],
      runs: [
        sourceRun('Earlier left column.', 0.119, 0.7, 0.37),
        sourceRun('Earlier right column.', 0.514, 0.7, 0.37),
        sourceRun('Second left column.', 0.119, 0.75, 0.37),
        sourceRun('Second right column.', 0.514, 0.75, 0.37),
        sourceRun('Left column begins', 0.119, 0.8134, 0.212),
        sourceRun('and continues.', 0.343, 0.8134, 0.146),
        sourceRun('Right column remains separate.', 0.514, 0.8063, 0.37),
      ],
    }

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      [
        'Earlier left column.',
        'Earlier right column.',
        'Second left column.',
        'Second right column.',
        'Right column remains separate.',
        'Left column begins and continues.',
      ],
    )
  })

  it('separates same-font overprinted column layers using distant source-order ownership', () => {
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
      height: 0.0126,
      fontSize: 10,
      fontName: 'SyntheticBody',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const leftColumn = [
      sourceRun('First left-column evidence.', 0.09, 0.12, 0.38),
      sourceRun('Second left-column evidence.', 0.09, 0.16, 0.38),
      sourceRun('Third left-column evidence.', 0.09, 0.2, 0.38),
      sourceRun('left-source-url-tail-with-overprint', 0.11, 0.784, 0.57),
      sourceRun('.', 0.68, 0.784, 0.004),
    ]
    const rightColumn = [
      sourceRun('First right-column evidence.', 0.52, 0.12, 0.37),
      sourceRun('Second right-column evidence.', 0.52, 0.16, 0.37),
      sourceRun('Third right-column evidence.', 0.52, 0.2, 0.37),
      sourceRun('Fourth right-column evidence.', 0.52, 0.24, 0.37),
      sourceRun('Fifth right-column evidence.', 0.52, 0.28, 0.37),
      sourceRun('Sixth right-column evidence.', 0.52, 0.32, 0.37),
      sourceRun('Seventh right-column evidence.', 0.52, 0.36, 0.37),
      sourceRun('Eighth right-column evidence.', 0.52, 0.4, 0.37),
      sourceRun('right entry continuation', 0.52, 0.781, 0.17),
      sourceRun('with independent words.', 0.7, 0.781, 0.19),
    ]
    const runs = [...leftColumn, ...rightColumn]
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

    expect(grouped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'left-source-url-tail-with-overprint.',
          sourceOwnedColumn: 'left',
        }),
        expect.objectContaining({
          text: 'right entry continuation with independent words.',
          sourceOwnedColumn: 'right',
        }),
      ]),
    )
    expect(
      grouped.some(
        (candidate) =>
          candidate.text.includes('left-source-url-tail') &&
          candidate.text.includes('right entry continuation'),
      ),
    ).toBe(false)
  })

  it('does not split distant same-font source layers without a proven column gutter', () => {
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
      height: 0.0126,
      fontSize: 10,
      fontName: 'SyntheticBody',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const runs = [
      sourceRun('left source layer', 0.11, 0.2, 0.57),
      sourceRun('.', 0.68, 0.2, 0.004),
      ...Array.from({ length: 8 }, (_, index) =>
        sourceRun(`unrelated line ${index + 1}`, 0.1, 0.3 + index * 0.03, 0.3),
      ),
      sourceRun('overlapping source layer', 0.52, 0.197, 0.2),
      sourceRun('continues here.', 0.73, 0.197, 0.16),
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

    const overlapping = groupRunsIntoLines(page).filter(
      (candidate) =>
        candidate.text.includes('left source layer') ||
        candidate.text.includes('overlapping source layer'),
    )

    expect(overlapping).toHaveLength(1)
    expect(overlapping[0].text).toContain('left source layer')
    expect(overlapping[0].text).toContain('overlapping source layer')
  })

  it('keeps unrelated same-baseline runs apart when their boxes cross a central gutter', () => {
    const sourceRun = (
      text: string,
      x: number,
      width: number,
      y = 0.4,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height: 0.013,
      fontSize: 10,
      fontName: 'Synthetic-Regular',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const runs = [
      sourceRun('Horizontal axis label (n=19)', 0.08, 0.31),
      sourceRun('continuation begins here.', 0.56, 0.34),
      sourceRun('Small-print footer fragment.', 0.08, 0.31, 0.5),
      sourceRun('another column begins here.', 0.56, 0.34, 0.5),
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

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      [
        'Horizontal axis label (n=19)',
        'continuation begins here.',
        'Small-print footer fragment.',
        'another column begins here.',
      ],
    )
  })

  it('honors a proven page gutter when opposite-column prose aligns with a bold heading', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height: 0.013,
      fontSize: 10,
      fontName,
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 200,
      imageCount: 0,
      objects: [],
      runs: [
        sourceRun(
          'First left-column evidence.',
          0.119,
          0.12,
          0.37,
          'Synthetic-Regular',
        ),
        sourceRun(
          'First right-column evidence.',
          0.514,
          0.12,
          0.37,
          'Synthetic-Regular',
        ),
        sourceRun(
          'Second left-column evidence.',
          0.119,
          0.16,
          0.37,
          'Synthetic-Regular',
        ),
        sourceRun(
          'Second right-column evidence.',
          0.514,
          0.16,
          0.37,
          'Synthetic-Regular',
        ),
        sourceRun(
          'Third left-column evidence.',
          0.119,
          0.2,
          0.37,
          'Synthetic-Regular',
        ),
        sourceRun(
          'Third right-column evidence.',
          0.514,
          0.2,
          0.37,
          'Synthetic-Regular',
        ),
        sourceRun(
          'output in conjunction with our planning and revi-',
          0.119,
          0.3,
          0.3697,
          'Synthetic-Regular',
        ),
        sourceRun('3.2 Draft Module', 0.514, 0.3029, 0.149, 'Synthetic-Medi'),
        sourceRun(
          'Percentage of tasks solved (total=19)',
          0.119,
          0.35,
          0.37,
          'Synthetic-Regular',
        ),
        sourceRun(
          'they measured representational similarity.',
          0.504,
          0.35,
          0.37,
          'Synthetic-Regular',
        ),
      ],
    }

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      expect.arrayContaining([
        'output in conjunction with our planning and revi-',
        '3.2 Draft Module',
        'Percentage of tasks solved (total=19)',
        'they measured representational similarity.',
      ]),
    )
    expect(
      groupRunsIntoLines(page).some((candidate) =>
        candidate.text.includes('revi- 3.2'),
      ),
    ).toBe(false)
  })

  it('does not infer a page gutter from repeated bold run-in headings', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height: 0.0126,
      fontSize: 10,
      fontName,
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const rows = [
      ['Linear representations of concepts.', 'Many authors continue here.'],
      ['Unexpected generalization.', 'Our work begins on this baseline.'],
      ['Automated evaluation.', 'We use a judge for this analysis.'],
    ]
    const runs = rows.flatMap(([heading, prose], index) => [
      sourceRun(heading, 0.176, 0.2 + index * 0.04, 0.26, 'Synthetic-Medi'),
      sourceRun(prose, 0.452, 0.2 + index * 0.04, 0.37, 'Synthetic-Regular'),
    ])
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

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      rows.map(([heading, prose]) => `${heading} ${prose}`),
    )
  })

  it('does not infer a page gutter from repeated full-width table cell gaps', () => {
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
      fontSize: 10,
      fontName: 'SyntheticTable',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const rows = [
      ['Model', 'Method', 'An.', 'CF.', 'IS.', 'WQ.'],
      ['gpt-4o-mini', 'direct', '75.3', '84.1', '95.6', '91.2'],
      ['qwen2.5-72B', 'vs HW', '62.3', '52.2', '69.6', '73.9'],
    ]
    const x = [0.1, 0.24, 0.38, 0.52, 0.66, 0.8]
    const runs = rows.flatMap((row, rowIndex) =>
      row.map((text, columnIndex) =>
        sourceRun(text, x[columnIndex], 0.2 + rowIndex * 0.025, 0.12),
      ),
    )
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 595,
      height: 842,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 0,
      objects: [],
      runs,
    }

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      [
        'Model Method An. CF. IS. WQ.',
        'gpt-4o-mini direct 75.3 84.1 95.6 91.2',
        'qwen2.5-72B vs HW 62.3 52.2 69.6 73.9',
      ],
    )
  })

  it('attaches staggered small-cap fragments to the nearest baseline line', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontSize: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width,
      height,
      fontSize,
      fontName: 'SyntheticSmallCaps',
      rotation: 0,
      method: 'pdf-text',
      confidence: 1,
    })
    const runs = [
      sourceRun('S', 0.09, 0.119, 0.016, 0.018, 14),
      sourceRun('YNTHETIC', 0.107, 0.123, 0.071, 0.014, 11),
      sourceRun('P', 0.185, 0.119, 0.017, 0.018, 14),
      sourceRun('ROFILE', 0.203, 0.123, 0.096, 0.014, 11),
      sourceRun(': A Typesetting Study', 0.3, 0.119, 0.4, 0.018, 14),
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

    expect(groupRunsIntoLines(page).map((candidate) => candidate.text)).toEqual(
      ['SYNTHETIC PROFILE: A Typesetting Study'],
    )
  })
})
