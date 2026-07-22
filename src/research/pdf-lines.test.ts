import { describe, expect, it } from 'vitest'
import {
  buildPdfLineJoinReviewContext,
  groupRunsIntoLines,
  inlineUnhyphenatedLexicon,
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

describe('PDF line joining', () => {
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
        evidence: [],
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
      'First dupli-cate token and second duplicate token.',
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
      joinPdfLineTexts([line('evidence-'), line('based methods')], {
        hardHyphenLexicon: new Set(['evidence-based']),
        decisions,
      }),
    ).toBe('evidence-based methods')
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'preserved-lexical-hyphen' }),
    ])
  })

  it('does not remove a visible hyphen from alignment alone', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    expect(
      joinPdfLineTexts([line('specific scenar-'), line('ios remain')], {
        decisions,
      }),
    ).toBe('specific scenar-ios remain')
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'unresolved' }),
    ])
  })

  it('preserves a one-off visible compound hyphen and leaves the join unresolved', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts([line('The role-'), line('playing model responds')], {
        decisions,
      }),
    ).toBe('The role-playing model responds')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
      }),
    ])
  })

  it('removes an all-caps line-break hyphen when the exact joined word occurs elsewhere', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The ZXALPHA control is source-backed.'),
    ])

    expect(
      joinPdfLineTexts([line('Compare ZX-'), line('ALPHA controls')], {
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('Compare ZXALPHA controls')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'removed-discretionary-hyphen',
        evidence: ['same-document-unhyphenated-word'],
      }),
    ])
  })

  it('preserves an acronym-to-TitleCase compound at a line boundary', () => {
    const decisions: PdfLineBoundaryDecision[] = []

    expect(
      joinPdfLineTexts([line('The API-'), line('Gateway remains stable')], {
        decisions,
      }),
    ).toBe('The API-Gateway remains stable')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'preserved-lexical-hyphen',
        evidence: ['uppercase-prefix-titlecase-compound'],
      }),
    ])
  })

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
      'Trans-port remains available',
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
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

  it('preserves an uncertain source hyphen and records the unresolved boundary', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const previous = { ...line('short-'), width: 0.2 }
    expect(
      joinPdfLineTexts([previous, line('continuation')], { decisions }),
    ).toBe('short-continuation')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'unresolved',
        evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
      }),
    ])
  })
})

describe('PDF run grouping', () => {
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
      sourceRun('B', 0.09, 0.119, 0.016, 0.018, 14),
      sourceRun('EYOND', 0.107, 0.123, 0.071, 0.014, 11),
      sourceRun('D', 0.185, 0.119, 0.017, 0.018, 14),
      sourceRun('IALOGUE', 0.203, 0.123, 0.096, 0.014, 11),
      sourceRun(': A Profile-Dialogue Study', 0.3, 0.119, 0.4, 0.018, 14),
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
      ['BEYOND DIALOGUE: A Profile-Dialogue Study'],
    )
  })
})
