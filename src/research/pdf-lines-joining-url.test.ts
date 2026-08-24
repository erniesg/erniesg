import { describe, expect, it } from 'vitest'
import { groupRunsIntoLines, joinPdfLineTexts } from './pdf-lines'
import type {
  PdfPageAnalysis,
  PdfSourceRun,
  PdfLineBoundaryDecision,
} from './import-types'
import {
  line,
  sourceOwnershipRun,
  wrappedLines,
} from './pdf-lines-test-fixtures'

describe('PDF line joining — bibliography and URL boundaries', () => {
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
