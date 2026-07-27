import { describe, expect, it } from 'vitest'
import {
  buildPdfLineJoinReviewContext,
  groupRunsIntoLines,
  inlineHardHyphenLexicon,
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

  it('removes a line-break hyphen when an inflection of the joined word occurs elsewhere', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The system is discovering stable representations.'),
    ])

    expect(
      joinPdfLineTexts([line('We dis-'), line('cover a pattern')], {
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('We discover a pattern')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'removed-discretionary-hyphen',
        evidence: ['same-document-inflectional-word'],
      }),
    ])
  })

  it('uses a same-document verb stem to resolve a nominalized line break', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The models subtract integers.'),
    ])

    expect(
      joinPdfLineTexts([line('addition and subtrac-'), line('tion tasks')], {
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('addition and subtraction tasks')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: ['same-document-inflectional-word'],
    })
  })

  it('recognizes two inflections that share the same source-document stem', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The later section is discovering another pattern.'),
    ])

    expect(
      joinPdfLineTexts([line('The study dis-'), line('covered a pattern')], {
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('The study discovered a pattern')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: ['same-document-inflectional-word'],
    })
  })

  it('uses a same-document y-to-ied inflection to resolve a printed wrap', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The independent analysis classified each response.'),
    ])

    expect(
      joinPdfLineTexts(
        [line('The result is classi-'), line('fying evidence')],
        {
          unhyphenatedLexicon,
          decisions,
        },
      ),
    ).toBe('The result is classifying evidence')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: ['same-document-inflectional-word'],
    })
  })

  it('uses a same-document ive-to-ivity derivation to resolve a printed wrap', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const unhyphenatedLexicon = inlineUnhyphenatedLexicon([
      line('The later section measures selectivity directly.'),
    ])

    expect(
      joinPdfLineTexts([line('The method is selec-'), line('tive by design')], {
        unhyphenatedLexicon,
        decisions,
      }),
    ).toBe('The method is selective by design')
    expect(decisions[0]).toMatchObject({
      outcome: 'removed-discretionary-hyphen',
      evidence: ['same-document-inflectional-word'],
    })
  })

  it('preserves a TitleCase proper-name compound only with same-document lexical evidence', () => {
    const decisions: PdfLineBoundaryDecision[] = []
    const hardHyphenLexicon = inlineHardHyphenLexicon([
      line('The Euler-Lagrange identity appears elsewhere in full.'),
    ])

    expect(
      joinPdfLineTexts(
        [line('We use the Euler-'), line('Lagrange formulation.')],
        { decisions, hardHyphenLexicon },
      ),
    ).toBe('We use the Euler-Lagrange formulation.')
    expect(decisions[0]).toMatchObject({
      outcome: 'preserved-lexical-hyphen',
      evidence: ['same-document-lexical-hyphen'],
    })
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
        joinPdfLineTexts([line(before), line(after)], {
          decisions,
        }),
      ).toBe(expected)
      expect(decisions).toEqual([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
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
        unhyphenatedLexicon: new Set(['models']),
        decisions,
      }),
    ).toBe('A title investigating language models on math methods.')
    expect(decisions).toEqual([
      expect.objectContaining({
        outcome: 'removed-discretionary-hyphen',
        evidence: ['same-document-unhyphenated-word'],
      }),
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
