import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { reconstructPageRegions } from './pdf-regions'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
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
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: objects.length,
    objects,
    runs,
  }
}

async function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('keeps repeated margins, page numbers, chart labels, and notes out of body prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Journal running header', 0.1, 0.02, 0.4, 8),
        run(1, 'Page one body.', 0.1, 0.24, 0.72),
        run(1, '50%', 0.82, 0.5, 0.06, 7),
        run(1, 'Sidebar context', 0.82, 0.58, 0.12, 7),
        run(1, 'Footnote 1: Separated note.', 0.1, 0.82, 0.72, 7),
        run(1, 'Journal running footer', 0.1, 0.93, 0.4, 8),
        run(1, '1', 0.48, 0.96, 0.02, 8),
      ]),
      page(2, [
        run(2, 'Journal running header', 0.1, 0.02, 0.4, 8),
        run(2, 'Page two body.', 0.1, 0.24, 0.72),
        run(2, 'Journal running footer', 0.1, 0.93, 0.4, 8),
        run(2, '2', 0.48, 0.96, 0.02, 8),
      ]),
    ])

    expect(result.regions.map((region) => region.kind)).toEqual(
      expect.arrayContaining([
        'header',
        'footer',
        'page-number',
        'chart-label',
        'side',
        'footnote',
      ]),
    )
    const body = result.paper.nodes
      .filter((node) => node.type === 'paragraph')
      .map((node) => node.text)
      .join(' ')
    expect(body).not.toContain('running header')
    expect(body).not.toContain('running footer')
    expect(body).not.toContain('50%')
    expect(body).not.toContain('Sidebar context')
  })

  it('keeps standalone Unicode note markers with adjacent compact bodies out of page furniture', () => {
    const markers = ['1', '٢', '³']
    const result = reconstructPageRegions(
      markers.map((marker, index) => {
        const pageNumber = index + 1
        return page(pageNumber, [
          run(
            pageNumber,
            `Canonical body prose on page ${pageNumber}.`,
            0.12,
            0.24,
            0.72,
            10,
          ),
          run(pageNumber, marker, 0.12, 0.93, 0.02, 7, 0.008),
          run(
            pageNumber,
            `Detached footnote body for marker ${pageNumber}.`,
            0.12,
            0.941,
            0.5,
            7,
            0.012,
          ),
        ])
      }),
    )

    const notes = result.regions.filter((region) => region.kind === 'footnote')
    expect(notes).toHaveLength(3)
    expect(
      notes.map((region) => ({
        includedInReadingOrder: region.includedInReadingOrder,
        sourceText: region.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      })),
    ).toEqual(
      markers.map((marker, index) => ({
        includedInReadingOrder: true,
        sourceText: [marker, `Detached footnote body for marker ${index + 1}.`],
      })),
    )
    expect(notes.every((region) => region.furniture === undefined)).toBe(true)
    expect(
      result.regions.some(
        (region) =>
          region.kind === 'page-number' && markers.includes(region.text),
      ),
    ).toBe(false)
  })

  it('classifies repeated source-run margins before a colliding diagram title is joined', () => {
    const runningAuthor =
      'Paul Pu Liang, Amir Zadeh, and Louis-Philippe Morency'
    const runningTitle = 'Foundations & Trends in Multimodal Machine Learning'
    const result = reconstructPageRegions([
      page(2, [
        run(2, '1:2', 0.094, 0.083, 0.019, 8, 0.011),
        run(2, runningAuthor, 0.525, 0.083, 0.381, 8, 0.011),
        run(2, 'Page-two prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(3, [
        run(3, runningTitle, 0.094, 0.083, 0.377, 8, 0.011),
        run(3, '1:3', 0.887, 0.083, 0.019, 8, 0.011),
        run(3, 'Page-three prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(4, [
        run(4, '1:4', 0.094, 0.083, 0.019, 8, 0.011),
        run(4, runningAuthor, 0.525, 0.083, 0.381, 8, 0.011),
        run(4, 'Dimensions of Heterogeneity', 0.176, 0.075, 0.386, 13.5, 0.019),
        run(4, 'Page-four prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(5, [
        run(5, runningTitle, 0.094, 0.083, 0.377, 8, 0.011),
        run(5, '1:5', 0.887, 0.083, 0.019, 8, 0.011),
        run(5, 'Page-five prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
    ])

    const furniture = result.regions.filter(
      (region) =>
        region.text === runningAuthor ||
        region.text === runningTitle ||
        /^1:\d+$/u.test(region.text),
    )
    expect(furniture).toHaveLength(8)
    expect(
      furniture.every(
        (region) =>
          ['header', 'page-number'].includes(region.kind) &&
          region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    expect(
      result.regions.find(
        (region) => region.text === 'Dimensions of Heterogeneity',
      ),
    ).toMatchObject({
      includedInReadingOrder: true,
    })
    expect(
      result.regions
        .filter((region) => region.includedInReadingOrder)
        .map((region) => region.text),
    ).toEqual([
      'Page-two prose remains canonical.',
      'Page-three prose remains canonical.',
      'Dimensions of Heterogeneity',
      'Page-four prose remains canonical.',
      'Page-five prose remains canonical.',
    ])
  })

  it('does not treat normalized numeric repetitions on one page as margins', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, '3. MLPs 14-18 fit the b token', 0.1, 0.18, 0.55),
        run(1, 'and retain the ordinary step explanation.', 0.12, 0.205, 0.68),
        run(1, '4. MLPs 19-27 fit the a token', 0.1, 0.34, 0.55),
        run(
          1,
          'and retain the next ordinary step explanation.',
          0.12,
          0.365,
          0.7,
        ),
      ]),
    ])

    expect(
      result.regions.map((region) => ({
        kind: region.kind,
        includedInReadingOrder: region.includedInReadingOrder,
        text: region.text,
      })),
    ).toEqual([
      {
        kind: 'body',
        includedInReadingOrder: true,
        text: '3. MLPs 14-18 fit the b token and retain the ordinary step explanation.',
      },
      {
        kind: 'body',
        includedInReadingOrder: true,
        text: '4. MLPs 19-27 fit the a token and retain the next ordinary step explanation.',
      },
    ])
  })

  it('owns explicit first-page address and legal bands as source-preserved paratext', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(
            1,
            'The introduction begins as continuous prose and reaches this',
            0.094,
            0.706,
            0.81,
            10,
            0.014,
          ),
          run(
            1,
            'Authors’ address: Ada Example, ada@example.edu;',
            0.094,
            0.75,
            0.5,
            8,
            0.011,
          ),
          run(
            1,
            'Example Institute, 500 Research Avenue.',
            0.094,
            0.764,
            0.38,
            8,
            0.011,
          ),
          run(
            1,
            'Permission to make digital or hard copies of this work is granted without fee',
            0.094,
            0.816,
            0.81,
            8,
            0.011,
          ),
          run(
            1,
            'provided that copies bear this notice and the full citation.',
            0.094,
            0.83,
            0.64,
            8,
            0.011,
          ),
          run(
            1,
            '© 2022 Copyright held by the owner/author(s).',
            0.094,
            0.873,
            0.31,
            8,
            0.011,
          ),
          run(1, '0360-0300/2022/10-ART1', 0.094, 0.887, 0.17, 8, 0.011),
          run(
            1,
            'https://doi.org/10.0000/example',
            0.094,
            0.901,
            0.26,
            8,
            0.011,
          ),
          run(
            1,
            'Preprint, Vol. 1, No. 1. Publication date: October 2022.',
            0.48,
            0.934,
            0.43,
            8,
            0.011,
          ),
        ].map((sourceRun, sourceSequenceIndex) => ({
          ...sourceRun,
          sourceSequenceIndex,
        })),
      ),
      page(2, [
        {
          ...run(
            2,
            'vibrant research continues without intervening page furniture.',
            0.094,
            0.14,
            0.72,
          ),
          sourceSequenceIndex: 0,
        },
      ]),
    ])

    const paratext = result.regions.filter((region) =>
      /(?:Authors.? address|Permission to make|Copyright held|0360-0300|doi\.org|Preprint, Vol\.)/iu.test(
        region.text,
      ),
    )
    expect(paratext.length).toBeGreaterThanOrEqual(4)
    expect(
      paratext.every(
        (region) =>
          region.kind === 'footer' && region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    const canonicalText = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .filter(Boolean)
    expect(canonicalText).toEqual([
      'The introduction begins as continuous prose and reaches this vibrant research continues without intervening page furniture.',
    ])
  })

  it('keeps near-bottom first-page body text in canonical prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Earlier body prose establishes the primary type size.',
          0.18,
          0.5,
          0.64,
          11,
        ),
        run(
          1,
          'A second ordinary body line continues the discussion.',
          0.18,
          0.53,
          0.64,
          11,
        ),
        run(
          1,
          'The paragraph reaches the lower page while producing',
          0.18,
          0.755,
          0.64,
          10,
        ),
        run(
          1,
          'the complete result and retains all enumerated benefits,',
          0.18,
          0.772,
          0.64,
          10,
        ),
        run(
          1,
          'including the final source-backed contribution.',
          0.18,
          0.789,
          0.64,
          10,
        ),
      ]),
    ])

    const lowerBody = result.regions.filter((region) =>
      /(?:lower page|enumerated benefits|final source-backed)/u.test(
        region.text,
      ),
    )
    expect(lowerBody.length).toBeGreaterThan(0)
    expect(
      lowerBody.every(
        (region) =>
          region.kind === 'body' && region.includedInReadingOrder === true,
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('retains all enumerated benefits')
  })

  it('excludes geometrically isolated first-page small print from two-column prose flow', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'systems support a large range of tasks, including robotics (Driess et al., 2023; Brohan',
          0.08,
          0.6,
          0.4,
          10,
        ),
        run(
          1,
          'et al., 2023), bioinformatics and health-care.',
          0.54,
          0.14,
          0.38,
          10,
        ),
        run(
          1,
          'Workshop publication metadata and venue details',
          0.08,
          0.82,
          0.58,
          8,
          0.011,
        ),
        run(
          1,
          'Right-column prose continues independently.',
          0.7,
          0.827,
          0.22,
          10,
        ),
        run(
          1,
          'Volume information, publication date, and rights statement.',
          0.16,
          0.836,
          0.62,
          8,
          0.011,
        ),
        run(1, 'Another right-column line follows.', 0.7, 0.845, 0.22, 10),
      ]),
    ])

    const imprintRegions = result.regions.filter((region) =>
      /(?:publication metadata|Volume information)/u.test(region.text),
    )
    expect(imprintRegions.length).toBeGreaterThan(0)
    expect(
      imprintRegions.every(
        (region) =>
          region.kind === 'footer' && region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).not.toContain('Workshop publication metadata')
  })

  it('keeps a complete chart-axis label out of neighboring prose', async () => {
    const result = await reconstruct([
      page(
        2,
        [
          run(2, 'Horizontal measure (sample=19)', 0.08, 0.54, 0.34, 8),
          run(
            2,
            'neighboring prose continues in the other column.',
            0.54,
            0.54,
            0.38,
            10,
          ),
        ],
        [
          {
            id: 'vector-chart',
            page: 2,
            kind: 'vector',
            box: {
              page: 2,
              x: 0.06,
              y: 0.2,
              width: 0.4,
              height: 0.38,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
            role: 'semantic',
          },
        ],
      ),
    ])

    expect(
      result.regions.some(
        (region) =>
          region.kind === 'chart-label' &&
          region.text === 'Horizontal measure (sample=19)',
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('neighboring prose continues in the other column.')
  })

  it('separates publication status while retaining notes, captions, and bottom prose', () => {
    const result = reconstructPageRegions([
      page(1, [
        ...Array.from({ length: 5 }, (_, index) =>
          run(
            1,
            `Earlier body line ${index + 1} establishes page typography.`,
            0.176,
            0.2 + index * 0.08,
            0.65,
            10,
            0.013,
          ),
        ),
        run(
          1,
          'Ordinary body prose remains canonical near the bottom of the page.',
          0.176,
          0.88,
          0.65,
          10,
          0.013,
        ),
        run(1, '∗ Equal contribution.', 0.176, 0.905, 0.15, 8, 0.011),
        run(
          1,
          'Figure 7. A genuine bottom-band caption.',
          0.48,
          0.923,
          0.35,
          8,
          0.011,
        ),
        run(1, 'Preprint. Under review.', 0.176, 0.946, 0.14, 9, 0.011),
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.text.includes('Ordinary body prose'),
      ),
    ).toMatchObject({ kind: 'body', includedInReadingOrder: true })
    expect(
      result.regions.find((region) => region.text === '∗ Equal contribution.'),
    ).toMatchObject({ kind: 'footnote', includedInReadingOrder: true })
    expect(
      result.regions.find((region) => region.text.startsWith('Figure 7.')),
    ).toMatchObject({ kind: 'caption', includedInReadingOrder: true })
    expect(
      result.regions.find(
        (region) => region.text === 'Preprint. Under review.',
      ),
    ).toMatchObject({ kind: 'footer', includedInReadingOrder: false })
  })

  it('keeps repeated URL notes when dense chart labels skew page font statistics', async () => {
    const chartLabels = Array.from({ length: 48 }, (_, index) =>
      run(
        1,
        String(index),
        0.12 + (index % 8) * 0.09,
        0.38 + Math.floor(index / 8) * 0.045,
        0.03,
        3.5,
        0.006,
      ),
    )
    const note = (pageNumber: number, label: string) => {
      const marker = run(pageNumber, label, 0.197, 0.909, 0.005, 6, 0.0075)
      const url = run(
        pageNumber,
        'https://github.com/example/repeated-source',
        0.203,
        0.91,
        0.42,
        9,
        0.0113,
      )
      url.fontName = 'SyntheticMono'
      return [marker, url]
    }
    const prose = (pageNumber: number) => [
      run(
        pageNumber,
        'Ordinary scholarly prose establishes the actual body font.',
        0.176,
        0.18,
        0.64,
      ),
      run(
        pageNumber,
        'A second continuous sentence supplies stable prose evidence.',
        0.176,
        0.21,
        0.64,
      ),
      run(
        pageNumber,
        'A third continuous sentence supplies stable prose evidence.',
        0.176,
        0.24,
        0.64,
      ),
    ]
    const result = await reconstruct([
      page(1, [...prose(1), ...chartLabels, ...note(1, '8')]),
      page(2, [...prose(2), ...note(2, '9')]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'footnote')
        .map((region) => region.text),
    ).toEqual([
      '8 https://github.com/example/repeated-source',
      '9 https://github.com/example/repeated-source',
    ])
  })

  it('does not classify repeated table-cell symbols as page margins', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Table heading', 0.1, 0.06, 0.3, 10),
        run(1, '✓', 0.45, 0.083, 0.03, 8),
        run(1, 'First table row', 0.1, 0.083, 0.25, 8),
      ]),
      page(2, [
        run(2, 'Another table heading', 0.1, 0.06, 0.3, 10),
        run(2, '✓', 0.45, 0.083, 0.03, 8),
        run(2, 'Second table row', 0.1, 0.083, 0.25, 8),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.text === '✓')
        .every(
          (region) => region.kind !== 'header' && region.kind !== 'footer',
        ),
    ).toBe(true)
  })
})
