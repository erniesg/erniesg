import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { digitValue, reconstructPageRegions } from './pdf-regions'

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
  it('orders both column bands around a spanning block and links notes under each column', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(1, 'Two column study', 0.08, 0.1, 0.84, 18),
          run(1, 'Left above one.', 0.08, 0.2, 0.32),
          run(1, 'Left above two.', 0.08, 0.24, 0.32),
          run(1, 'Left claim', 0.08, 0.28, 0.24),
          run(1, '1', 0.325, 0.283, 0.008, 6, 0.009),
          run(1, 'Right above one.', 0.56, 0.2, 0.32),
          run(1, 'Right above two.', 0.56, 0.24, 0.32),
          run(1, 'Right claim', 0.56, 0.28, 0.24),
          run(1, '2', 0.805, 0.283, 0.008, 6, 0.009),
          run(1, 'Spanning figure between column bands', 0.12, 0.42, 0.76, 11),
          run(1, 'Left below one.', 0.08, 0.54, 0.32),
          run(1, 'Left below two.', 0.08, 0.58, 0.32),
          run(1, 'Left below three.', 0.08, 0.62, 0.32),
          run(1, 'Right below one.', 0.56, 0.54, 0.32),
          run(1, 'Right below two.', 0.56, 0.58, 0.32),
          run(1, 'Right below three.', 0.56, 0.62, 0.32),
          run(1, '1. Left-column note.', 0.08, 0.82, 0.32, 7),
          run(1, '2. Right-column note.', 0.56, 0.82, 0.32, 7),
        ],
        [
          {
            id: 'image-p001-001',
            page: 1,
            kind: 'image',
            assetId: null,
            box: {
              page: 1,
              x: 0.2,
              y: 0.36,
              width: 0.6,
              height: 0.05,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 0.98,
          },
        ],
      ),
    ])

    const canonicalText = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(canonicalText.indexOf('Left above')).toBeLessThan(
      canonicalText.indexOf('Right above'),
    )
    expect(canonicalText.indexOf('Right above')).toBeLessThan(
      canonicalText.indexOf('Spanning figure'),
    )
    expect(canonicalText.indexOf('Spanning figure')).toBeLessThan(
      canonicalText.indexOf('Left below'),
    )
    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'spanning', column: 'span' }),
        expect.objectContaining({ kind: 'figure', column: 'span' }),
        expect.objectContaining({ kind: 'footnote', column: 'left' }),
        expect.objectContaining({ kind: 'footnote', column: 'right' }),
      ]),
    )
    const figure = result.regions.find((region) => region.kind === 'figure')!
    const above = result.regions.find((region) =>
      region.text.includes('Left above'),
    )!
    const below = result.regions.find((region) =>
      region.text.includes('Left below'),
    )!
    expect(result.readingOrder.order.indexOf(above.id)).toBeLessThan(
      result.readingOrder.order.indexOf(figure.id),
    )
    expect(result.readingOrder.order.indexOf(figure.id)).toBeLessThan(
      result.readingOrder.order.indexOf(below.id),
    )
    expect(result.noteRelationships).toHaveLength(2)
    expect(
      result.noteRelationships.every((note) => note.status === 'matched'),
    ).toBe(true)
    expect(result.noteRelationships.map((note) => note.evidence)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['same-column-geometry']),
      ]),
    )
    expect(
      result.regions.every(
        (region) => region.confidence > 0 && region.box.page === region.page,
      ),
    ).toBe(true)
    expect(
      result.readingOrder.edges.every(
        (edge) =>
          edge.confidence > 0 &&
          edge.evidence.length > 0 &&
          edge.sourceBoxes.length === 2,
      ),
    ).toBe(true)
    expect(
      result.noteRelationships.every(
        (relationship) =>
          relationship.confidence > 0 && relationship.sourceBoxes.length === 2,
      ),
    ).toBe(true)
    expect(result.completeness).toMatchObject({
      relationshipCoverage: 1,
      readingOrderDiagnostics: 0,
    })
  })

  it('orders same-row fragments by their top source line instead of a later union-box indent', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'First left-column line.', 0.09, 0.12, 0.37),
        run(1, 'First right-column line.', 0.52, 0.12, 0.37),
        run(1, 'Second left-column line.', 0.09, 0.16, 0.37),
        run(1, 'Second right-column line.', 0.52, 0.16, 0.37),
        run(1, 'Third left-column line.', 0.09, 0.2, 0.37),
        run(1, 'Third right-column line.', 0.52, 0.2, 0.37),
        run(1, 'author.', 0.502, 0.3, 0.08, 10, 0.0126),
        run(1, 'interpreting', 0.689, 0.3, 0.077, 10, 0.0126),
        run(1, 'GPT:', 0.797, 0.3, 0.036, 10, 0.0126),
        run(1, 'the', 0.864, 0.3, 0.021, 10, 0.0126),
        run(1, 'logit', 0.518, 0.315, 0.031, 10, 0.0126),
      ]),
    ])
    const textByRegionId = new Map(
      result.regions.map((region) => [region.id, region.text]),
    )
    const fragmentOrder = result.readingOrder.order
      .map((regionId) => textByRegionId.get(regionId))
      .filter((text) =>
        ['author.', 'interpreting', 'GPT:', 'the logit'].includes(text ?? ''),
      )

    expect(fragmentOrder).toEqual([
      'author.',
      'interpreting',
      'GPT:',
      'the logit',
    ])
  })

  it('keeps every included column region when a spanning object overlaps its vertical band', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(1, 'Overlapping float study', 0.08, 0.08, 0.84, 18),
          run(1, 'Left retained one.', 0.08, 0.2, 0.32),
          run(1, 'Left retained two.', 0.08, 0.24, 0.32),
          run(1, 'Left retained three.', 0.08, 0.28, 0.32),
          run(1, 'Right retained one.', 0.56, 0.2, 0.32),
          run(1, 'Right retained two.', 0.56, 0.24, 0.32),
          run(1, 'Right retained three.', 0.56, 0.28, 0.32),
        ],
        [
          {
            id: 'vector-p001-001',
            page: 1,
            kind: 'vector',
            assetId: null,
            box: {
              page: 1,
              x: 0.2,
              y: 0.15,
              width: 0.6,
              height: 0.5,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 0.98,
          },
        ],
      ),
    ])

    const included = result.regions
      .filter((region) => region.includedInReadingOrder)
      .map((region) => region.id)
    expect(new Set(result.readingOrder.order)).toEqual(new Set(included))
    expect(result.readingOrder.order).toHaveLength(included.length)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('Left retained')
  })

  it('accounts for Unicode folios, rotated stamps, and one-off margin review', () => {
    const arabic = ['١', '٢', '٣']
    const devanagari = ['१', '२', '३']
    const roman = ['I', 'II', 'III']
    const pages = [1, 2, 3].map((pageNumber, index) =>
      page(pageNumber, [
        run(pageNumber, arabic[index], 0.46, 0.95, 0.03, 8),
        run(pageNumber, devanagari[index], 0.52, 0.95, 0.03, 8),
        run(pageNumber, roman[index], 0.58, 0.95, 0.03, 8),
        {
          ...run(
            pageNumber,
            'opaque rotated archive stamp',
            0.02,
            0.35,
            0.5,
            8,
          ),
          rotation: 90,
        },
        run(
          pageNumber,
          pageNumber === 2
            ? 'A genuine sentence in the lower margin remains reviewable.'
            : `Canonical body prose on page ${pageNumber}.`,
          0.12,
          pageNumber === 2 ? 0.94 : 0.2,
          0.7,
          10,
        ),
      ]),
    )
    const first = reconstructPageRegions(pages)
    const second = reconstructPageRegions(pages)
    const furniture = first.regions.filter((region) => region.furniture)
    expect(
      furniture
        .filter((region) => region.kind === 'page-number')
        .flatMap((region) => region.text.split(/\s+/u)),
    ).toEqual(['١', '१', 'I', '٢', '२', 'II', '٣', '३', 'III'])
    expect(
      furniture.some(
        (region) =>
          region.furniture?.classification === 'rotated-margin' &&
          region.furniture.evidence.includes('quarter-turn-margin-rotation'),
      ),
    ).toBe(true)
    expect(
      first.regions.some(
        (region) =>
          region.furnitureReview?.reason === 'single-occurrence-margin' &&
          region.includedInReadingOrder,
      ),
    ).toBe(true)
    expect(first.regions).toEqual(second.regions)
  })

  it('splits a reviewable margin run from an adjacent first-page title run', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Submitted for bounded source review', 0.1, 0.03, 0.3, 8),
        run(1, 'Synthetic title block', 0.41, 0.03, 0.16, 14),
        run(
          1,
          'Canonical body prose establishes the page font.',
          0.12,
          0.2,
          0.72,
        ),
        run(
          1,
          'A second body line stabilizes the source geometry.',
          0.12,
          0.24,
          0.72,
        ),
      ]),
    ])

    expect(
      result.regions.find(
        (region) => region.text === 'Submitted for bounded source review',
      ),
    ).toMatchObject({
      furnitureReview: { reason: 'single-occurrence-margin' },
      includedInReadingOrder: true,
    })
    expect(
      result.regions.find((region) => region.text === 'Synthetic title block'),
    ).toMatchObject({ includedInReadingOrder: true })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FURNITURE_REVIEW_REQUIRED',
          severity: 'error',
        }),
      ]),
    )
  })

  it('keeps short unproven margin lines on the bounded header path', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          'Canonical body prose establishes the page font.',
          0.12,
          0.2,
          0.72,
        ),
        run(
          1,
          'A second body line stabilizes the source geometry.',
          0.12,
          0.24,
          0.72,
        ),
        run(1, 'DRAFT', 0.2, 0.03, 0.08, 8.5),
      ]),
    ])

    expect(
      result.regions.find((region) => region.text === 'DRAFT'),
    ).toMatchObject({
      kind: 'header',
      confidence: 0.78,
      includedInReadingOrder: false,
    })
  })

  it('does not attach furniture evidence to protected repeated-margin headings', () => {
    const prefixForms = [
      (ordinal: number) => `A.${ordinal}.`,
      (ordinal: number) => `A.1.${ordinal}`,
    ]

    for (const prefix of prefixForms) {
      const headingPage = (pageNumber: number, ordinal: number) =>
        page(pageNumber, [
          {
            ...run(pageNumber, prefix(ordinal), 0.1, 0.08, 0.05, 14),
            fontName: 'Synthetic-Bold',
            bold: true,
          },
          {
            ...run(
              pageNumber,
              `Repeated Section ${ordinal}`,
              0.155,
              0.08,
              0.5,
              14,
            ),
            fontName: 'Synthetic-Bold',
            bold: true,
          },
          run(
            pageNumber,
            `Canonical body prose on page ${pageNumber}.`,
            0.12,
            0.2,
            0.72,
          ),
        ])
      const result = reconstructPageRegions([
        page(1, [
          {
            ...run(1, 'A Parent Heading', 0.12, 0.04, 0.3, 14),
            fontName: 'Synthetic-Bold',
            bold: true,
          },
          run(1, 'Canonical body prose on page 1.', 0.12, 0.2, 0.72),
        ]),
        headingPage(2, 1),
        headingPage(3, 2),
        headingPage(4, 3),
      ])

      const headings = result.regions.filter((region) =>
        region.text.includes('Repeated Section'),
      )
      expect(headings).toHaveLength(3)
      expect(
        headings.every(
          (region) =>
            region.kind === 'body' &&
            region.furniture === undefined &&
            region.includedInReadingOrder,
        ),
      ).toBe(true)
    }
  })

  it('protects a narrow first-page title-block run while later repeats remain furniture', () => {
    const titlePage = (pageNumber: number) =>
      page(pageNumber, [
        run(pageNumber, 'Ada Lovelace', 0.12, 0.09, 0.22, 9),
        run(
          pageNumber,
          `Canonical body prose on page ${pageNumber}.`,
          0.12,
          0.2,
          0.72,
        ),
        run(
          pageNumber,
          `A second body line stabilizes page ${pageNumber}.`,
          0.12,
          0.24,
          0.72,
        ),
      ])
    const result = reconstructPageRegions([
      titlePage(1),
      titlePage(2),
      titlePage(3),
    ])
    const titleRegions = result.regions.filter(
      (region) => region.text === 'Ada Lovelace',
    )

    expect(titleRegions).toHaveLength(3)
    expect(titleRegions[0]).toMatchObject({
      kind: 'body',
      includedInReadingOrder: true,
    })
    expect(titleRegions[0].furniture).toBeUndefined()
    expect(
      titleRegions
        .slice(1)
        .every(
          (region) =>
            region.kind === 'header' &&
            region.includedInReadingOrder === false &&
            region.furniture?.classification === 'repeated-text',
        ),
    ).toBe(true)
  })

  it('recognizes every Unicode decimal digit supported by the runtime', () => {
    const missing: string[] = []
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const character = String.fromCodePoint(codePoint)
      if (!/^\p{Nd}$/u.test(character)) continue
      if (digitValue(character) === null) {
        missing.push(`U+${codePoint.toString(16).toUpperCase()}`)
      }
    }

    expect(missing).toEqual([])
  })

  it('classifies a newly assigned decimal digit range as incrementing folios', () => {
    const folio = (index: number) => String.fromCodePoint(0x10d40 + index)
    const result = reconstructPageRegions(
      [1, 2, 3].map((pageNumber, index) =>
        page(pageNumber, [
          run(
            pageNumber,
            `Canonical body prose on page ${pageNumber}.`,
            0.12,
            0.2,
            0.72,
          ),
          run(pageNumber, folio(index), 0.48, 0.95, 0.03, 8),
        ]),
      ),
    )

    expect(
      result.regions
        .filter((region) =>
          [folio(0), folio(1), folio(2)].includes(region.text),
        )
        .map((region) => ({
          text: region.text,
          kind: region.kind,
          classification: region.furniture?.classification,
        })),
    ).toEqual(
      [folio(0), folio(1), folio(2)].map((text) => ({
        text,
        kind: 'page-number',
        classification: 'incrementing-numeral',
      })),
    )
  })

  it('keeps raised Unicode note markers linked while margin numerals remain furniture', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Unicode note geometry', 0.12, 0.08, 0.68, 18),
        run(1, 'Ada Researcher', 0.12, 0.14, 0.3, 11),
        run(1, 'Abstract', 0.12, 0.21, 0.22, 14),
        run(
          1,
          'The abstract establishes a source-backed multilingual fixture.',
          0.12,
          0.26,
          0.72,
        ),
        run(1, 'Arabic-Indic evidence', 0.12, 0.38, 0.3, 10),
        run(1, '١', 0.425, 0.374, 0.009, 6, 0.009),
        run(1, 'Devanagari evidence', 0.12, 0.46, 0.3, 10),
        run(1, '२', 0.425, 0.454, 0.009, 6, 0.009),
        run(1, '١. Arabic-Indic note body.', 0.12, 0.82, 0.72, 7),
        run(1, '२. Devanagari note body.', 0.12, 0.86, 0.72, 7),
      ]),
    ])

    expect(
      result.noteRelationships.map((relationship) => ({
        label: relationship.label,
        status: relationship.status,
        sourceText: result.regions
          .find((region) => region.id === relationship.referenceRegionId)
          ?.text.slice(relationship.referenceStart, relationship.referenceEnd),
      })),
    ).toEqual([
      { label: '1', status: 'matched', sourceText: '١' },
      { label: '2', status: 'matched', sourceText: '२' },
    ])
  })

  it('defers overlapping repeated numeral bands to the footnote stratum', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Body prose establishes the page font.', 0.12, 0.2, 0.72, 10),
        run(
          1,
          '1. Genuine note body remains a footnote, not page furniture,',
          0.12,
          0.86,
          0.72,
          7,
        ),
        run(
          1,
          'The wrapped note continuation remains owned by the footnote.',
          0.12,
          0.884,
          0.72,
          7,
        ),
      ]),
      page(2, [
        run(
          2,
          'More body prose establishes the page font.',
          0.12,
          0.2,
          0.72,
          10,
        ),
        run(
          2,
          '2. Genuine note body remains a footnote, not page furniture,',
          0.12,
          0.86,
          0.72,
          7,
        ),
        run(
          2,
          'The wrapped note continuation remains owned by the footnote.',
          0.12,
          0.884,
          0.72,
          7,
        ),
      ]),
    ])

    const notes = result.regions.filter((region) => region.kind === 'footnote')
    expect(notes).toHaveLength(2)
    expect(notes.every((region) => region.includedInReadingOrder)).toBe(true)
    expect(notes.every((region) => region.furniture === undefined)).toBe(true)
    expect(
      notes.every((region) =>
        region.text.includes('wrapped note continuation'),
      ),
    ).toBe(true)
    expect(result.furnitureAssessment.furnitureRuns).toHaveLength(0)
  })
})
