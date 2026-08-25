import { describe, expect, it } from 'vitest'
import { groupRunsIntoLines } from './pdf-lines'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'

describe('PDF run grouping — layout boundaries', () => {
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
