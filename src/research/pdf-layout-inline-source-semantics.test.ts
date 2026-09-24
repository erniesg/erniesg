import { describe, expect, it } from 'vitest'
import { renderPublicationXhtml } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import {
  reconstructPageAnalyses,
  retainUniqueMonotoneSourceRunAssignment,
  retainUniqueSourceRunAssignmentWithAliases,
} from './pdf-layout'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
): PdfPageAnalysis {
  return {
    page: number,
    kind,
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: kind === 'born-digital' ? 0 : 1,
    runs,
  }
}

describe('PDF semantic reconstruction', () => {
  it('maps only explicit academic font-style conventions', async () => {
    const syntheticRuns = [
      {
        text: 'A Nimbus medium face remains bold.',
        y: 0.16,
        fontName: 'ABCDEF+NimbusRomNo9L-Medi',
      },
      {
        text: 'A Nimbus regular face remains plain.',
        y: 0.18,
        fontName: 'ABCDEF+NimbusRomNo9L-Regu',
      },
      {
        text: 'A Helvetica medium face remains plain.',
        y: 0.185,
        fontName: 'ABCDEF+HelveticaNeue-Medium',
      },
      {
        text: 'A Styrene medium italic face is italic but not bold.',
        y: 0.19,
        fontName: 'ABCDEF+StyreneBLC-MediumItalic',
      },
      {
        text: 'A conventional math-italic family remains emphasized.',
        y: 0.2,
        fontName: 'ABCDEF+CMMI12',
      },
      {
        text: 'A second math-italic convention remains emphasized.',
        y: 0.24,
        fontName: 'ABCDEF+MTMI',
      },
      {
        text: 'A PostScript italic suffix remains emphasized.',
        y: 0.28,
        fontName: 'ABCDEF+ScholarlySerif-ReguItal',
      },
      {
        text: 'A merely similar family name remains plain.',
        y: 0.32,
        fontName: 'ABCDEF+SyntheticObliqueness',
      },
    ].map(({ text, y, fontName }) => ({
      ...run(1, text, 0.1, y, 0.75),
      fontName,
    }))
    const result = await reconstructPageAnalyses({
      pages: [page(1, syntheticRuns)],
      sourceHash: 'f'.repeat(64),
      fileName: 'synthetic-inline-fonts.pdf',
      byteLength: 2048,
    })
    const textNodes = result.paper.nodes.filter(
      (node) => 'text' in node && 'inlineRuns' in node,
    )
    const styleFor = (expected: string) => {
      const node = textNodes.find(
        (candidate) => 'text' in candidate && candidate.text.includes(expected),
      )
      if (!node || !('text' in node) || !('inlineRuns' in node))
        return undefined
      const start = node.text.indexOf(expected)
      return node.inlineRuns?.find(
        (candidate) =>
          candidate.start <= start && candidate.end >= start + expected.length,
      )
    }

    expect(styleFor('A Nimbus medium face remains bold.')?.bold).toBe(true)
    expect(styleFor('A Nimbus regular face remains plain.')?.bold).not.toBe(
      true,
    )
    expect(styleFor('A Helvetica medium face remains plain.')?.bold).not.toBe(
      true,
    )
    expect(
      styleFor('A Styrene medium italic face is italic but not bold.')?.bold,
    ).not.toBe(true)
    expect(
      styleFor('A Styrene medium italic face is italic but not bold.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A conventional math-italic family remains emphasized.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A second math-italic convention remains emphasized.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A PostScript italic suffix remains emphasized.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A merely similar family name remains plain.')?.italic,
    ).not.toBe(true)
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 5,
      mappedInlineSpanCount: 5,
      inlineSpanCoverage: 1,
    })
  })

  it('maps repeated styled source atoms only through their unique monotone line order', async () => {
    const repeatedAtoms = [
      {
        ...run(1, 'x', 0.2, 0.4, 0.02),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, ' + ', 0.221, 0.4, 0.03),
      {
        ...run(1, 'x', 0.252, 0.4, 0.02),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, ' = ', 0.273, 0.4, 0.03),
      {
        ...run(1, 'x', 0.304, 0.4, 0.02),
        fontName: 'ABCDEF+CMMI10',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Repeated source atom study', 0.2, 0.08, 0.5, 18),
          run(
            1,
            'Ordinary prose establishes the document body typography.',
            0.1,
            0.24,
            0.72,
          ),
          ...repeatedAtoms,
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'repeated-styled-source-atoms.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) => 'text' in candidate && candidate.text === 'x+x=x',
    )
    if (!node || !('text' in node) || !('inlineRuns' in node)) {
      throw new Error('missing canonical repeated-atom node')
    }
    const italicTexts = (node.inlineRuns ?? [])
      .filter((candidate) => candidate.italic)
      .map((candidate) => node.text.slice(candidate.start, candidate.end))

    expect(italicTexts).toEqual(['x', 'x', 'x'])
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 3,
      mappedInlineSpanCount: 3,
      inlineSpanCoverage: 1,
    })
  })

  it('keeps a whole repeated-run sequence fail-closed when two complete monotone assignments exist', () => {
    const firstRun = run(1, 'x', 0.1, 0.2, 0.02)
    const fixedRun = run(1, 'y', 0.2, 0.2, 0.02)
    const candidates = [
      {
        run: firstRun,
        text: 'x',
        occurrences: [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
      },
      {
        run: fixedRun,
        text: 'y',
        occurrences: [{ start: 4, end: 5 }],
      },
    ]

    expect(retainUniqueMonotoneSourceRunAssignment(candidates)).toBe(false)
    expect(candidates.map((candidate) => candidate.occurrences)).toEqual([
      [],
      [],
    ])
  })

  it('keeps an accent alias and its whole line fail-closed when repeated assignments remain', () => {
    const accent = run(1, '´', 0.1, 0.2, 0.01)
    const target = run(1, 'a', 0.11, 0.2, 0.02)
    const fixed = run(1, 'y', 0.2, 0.2, 0.02)
    const repeatedAccentOccurrences = [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]
    const candidates = [
      {
        run: accent,
        text: 'á',
        occurrences: [...repeatedAccentOccurrences],
      },
      {
        run: target,
        text: 'á',
        occurrences: [...repeatedAccentOccurrences],
      },
      {
        run: fixed,
        text: 'y',
        occurrences: [{ start: 4, end: 5 }],
      },
    ]

    expect(
      retainUniqueSourceRunAssignmentWithAliases(
        candidates,
        new Map([
          [accent, target],
          [target, accent],
        ]),
      ),
    ).toBe(false)
    expect(candidates.map((candidate) => candidate.occurrences)).toEqual([
      [],
      [],
      [],
    ])
  })

  it('keeps overlapping singleton accent and prose intervals fail-closed', () => {
    const accent = run(1, '´', 0.1, 0.2, 0.01)
    const target = run(1, 'ar method', 0.11, 0.2, 0.08)
    const overlapping = run(1, 'method', 0.2, 0.2, 0.05)
    const candidates = [
      {
        run: accent,
        text: 'ár method',
        occurrences: [{ start: 0, end: 9 }],
      },
      {
        run: target,
        text: 'ár method',
        occurrences: [{ start: 0, end: 9 }],
      },
      {
        run: overlapping,
        text: 'method',
        occurrences: [{ start: 3, end: 9 }],
      },
    ]

    expect(
      retainUniqueSourceRunAssignmentWithAliases(
        candidates,
        new Map([
          [accent, target],
          [target, accent],
        ]),
      ),
    ).toBe(false)
    expect(candidates.map((candidate) => candidate.occurrences)).toEqual([
      [],
      [],
      [],
    ])
  })

  it('marks only source-atomic academic math runs for lexical compaction', async () => {
    const mathRuns = [
      run(1, 'C', 0.1, 0.4, 0.02, 12),
      {
        ...run(1, 'P lot', 0.121, 0.396, 0.05, 6),
        height: 0.009,
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, ' → R', 0.172, 0.4, 0.05, 12),
      {
        ...run(1, 'Inf o.', 0.223, 0.396, 0.06, 6),
        height: 0.009,
        fontName: 'ABCDEF+CMSY10',
      },
      run(1, '; ', 0.284, 0.4, 0.015, 12),
      {
        ...run(1, 'W T', 0.3, 0.4, 0.035, 12),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, '; ', 0.336, 0.4, 0.015, 12),
      {
        ...run(1, 'see note', 0.352, 0.396, 0.07, 6),
        height: 0.009,
        fontName: 'Synthetic-Regular',
      },
      run(1, '; ', 0.423, 0.4, 0.015, 12),
      {
        ...run(1, 'DInf o.', 0.439, 0.4, 0.065, 12),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, '; ', 0.505, 0.4, 0.015, 12),
      {
        ...run(1, 'ordinary italic prose', 0.521, 0.4, 0.16, 12),
        fontName: 'ABCDEF+NimbusRomNo9L-ReguItal',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Compact math semantics', 0.2, 0.08, 0.4, 18),
          run(1, 'Ada Example', 0.4, 0.16, 0.2, 11),
          run(1, 'Abstract', 0.1, 0.24, 0.2, 14),
          run(
            1,
            'This source establishes a complete ordinary prose baseline.',
            0.1,
            0.3,
            0.72,
          ),
          ...mathRuns,
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'source-backed-compact-math.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) =>
        'text' in candidate &&
        candidate.text.includes('P lot') &&
        candidate.text.includes('Inf o.'),
    )

    expect(node && 'text' in node ? node.text : '').toContain('CP lot')
    expect(node && 'text' in node ? node.text : '').toContain('RInf o.')
    if (!node || !('text' in node) || !('inlineRuns' in node)) {
      throw new Error('missing canonical compact-math node')
    }
    const styleFor = (value: string) => {
      const start = node.text.indexOf(value)
      return node.inlineRuns?.find(
        (candidate) =>
          candidate.start <= start && candidate.end >= start + value.length,
      )
    }

    expect(styleFor('P lot')).toMatchObject({
      italic: true,
      verticalAlign: 'superscript',
      compactMathAtom: true,
    })
    expect(styleFor('Inf o.')).toMatchObject({
      verticalAlign: 'superscript',
      compactMathAtom: true,
    })
    expect(styleFor('W T')).toMatchObject({ italic: true })
    expect(styleFor('W T')?.verticalAlign).toBeUndefined()
    expect(styleFor('W T')?.compactMathAtom).toBe(true)
    expect(styleFor('see note')).toMatchObject({
      verticalAlign: 'superscript',
    })
    expect(styleFor('see note')?.compactMathAtom).toBeUndefined()
    expect(styleFor('DInf o.')).toMatchObject({
      italic: true,
      compactMathAtom: true,
    })
    expect(styleFor('DInf o.')?.verticalAlign).toBeUndefined()
    expect(styleFor('ordinary italic prose')).toMatchObject({
      italic: true,
    })
    expect(styleFor('ordinary italic prose')?.compactMathAtom).toBeUndefined()
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 11,
      mappedInlineSpanCount: 11,
      inlineSpanCoverage: 1,
    })

    const content = renderPublicationXhtml(result.paper, {
      reconstruction: result,
    })
    expect(content).toContain('C<sup><em>Plot</em></sup>')
    expect(content).toContain('R<sup>Info.</sup>')
    expect(content).toContain('<em>WT</em>')
    expect(content).toContain('<sup>see note</sup>')
    expect(content).toContain('<em>DInfo.</em>')
    expect(content).toContain('<em>ordinary italic prose</em>')
  })

  it('retains raised caption glyphs as canonical caption inline semantics', async () => {
    const captionRuns = [
      {
        ...run(1, 'Figure 1. Score R', 0.1, 0.65, 0.25, 9),
        fontName: 'Caption',
      },
      {
        ...run(1, '2', 0.351, 0.646, 0.012, 6),
        height: 0.009,
        fontName: 'Caption',
      },
      {
        ...run(1, ' remains stable.', 0.372, 0.65, 0.16, 9),
        fontName: 'Caption',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [page(1, captionRuns)],
      sourceHash: '7'.repeat(64),
      fileName: 'synthetic-caption-inline.pdf',
      byteLength: 2048,
    })
    const caption = result.paper.nodes.find(
      (node) => node.type === 'caption' && node.text.includes('Score'),
    )

    expect(caption?.type).toBe('caption')
    if (caption?.type !== 'caption') throw new Error('missing caption')
    expect(caption.text).toBe('Figure 1. Score R2 remains stable.')
    const superscriptStart = caption.text.indexOf('2')
    expect(caption.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: superscriptStart,
          end: superscriptStart + 1,
          verticalAlign: 'superscript',
        }),
      ]),
    )
  })

  it('retains source-backed scripts in the canonical publication title and footnote', async () => {
    const titleRuns = [
      run(1, 'Re', 0.2, 0.08, 0.045, 18),
      {
        ...run(1, '3', 0.246, 0.076, 0.012, 7),
        height: 0.009,
        fontName: 'Synthetic-Regular',
      },
      run(1, ': Source-backed title', 0.26, 0.08, 0.34, 18),
    ]
    const noteRuns = [
      run(1, '5 Footnote preserves Re', 0.1, 0.88, 0.27, 8),
      {
        ...run(1, '3', 0.371, 0.876, 0.01, 5),
        height: 0.008,
        fontName: 'Synthetic-Regular',
      },
      run(1, ' semantics.', 0.383, 0.88, 0.12, 8),
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          ...titleRuns,
          run(1, 'Ada Example', 0.4, 0.17, 0.2, 11),
          run(1, 'Abstract', 0.1, 0.26, 0.2, 14),
          run(
            1,
            'The source abstract establishes ordinary body typography.',
            0.1,
            0.32,
            0.72,
          ),
          ...noteRuns,
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'source-backed-title-note-scripts.pdf',
      byteLength: 2048,
    })
    const title = result.paper.nodes.find(
      (node) => node.type === 'heading' && node.text === result.paper.title,
    )
    const note = result.paper.nodes.find(
      (node) =>
        node.type === 'footnote' &&
        node.text === 'Footnote preserves Re3 semantics.',
    )

    expect(title?.type).toBe('heading')
    expect(note?.type).toBe('footnote')
    if (title?.type !== 'heading' || note?.type !== 'footnote') {
      throw new Error('missing canonical scripted title or footnote')
    }
    const titleScript = title.text.indexOf('3')
    const noteScript = note.text.indexOf('3')
    expect(title.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: titleScript,
          end: titleScript + 1,
          verticalAlign: 'superscript',
        }),
      ]),
    )
    expect(note.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: noteScript,
          end: noteScript + 1,
          verticalAlign: 'superscript',
        }),
      ]),
    )
    expect(result.provenance[title.id]).toMatchObject({
      pages: [1],
      boxes: expect.arrayContaining([
        expect.objectContaining({ text: '3', fontSize: 7 }),
      ]),
    })
    expect(result.provenance[note.id]).toMatchObject({
      pages: [1],
      boxes: expect.arrayContaining([
        expect.objectContaining({ text: '3', fontSize: 5 }),
      ]),
    })
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 2,
      mappedInlineSpanCount: 2,
      inlineSpanCoverage: 1,
    })

    const content = renderPublicationXhtml(result.paper, {
      reconstruction: result,
    })
    expect(content).toContain(
      '<h1 id="' +
        title.id +
        '" data-canonical-id="' +
        title.id +
        '">Re<sup>3</sup>: Source-backed title</h1>',
    )
    expect(content).toContain('Footnote preserves Re<sup>3</sup> semantics.')
  })
})
