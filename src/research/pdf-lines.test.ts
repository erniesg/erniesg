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
