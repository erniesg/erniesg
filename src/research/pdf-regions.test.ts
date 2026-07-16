import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { evaluateReadingOrder } from './pdf-regions'

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

function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('segments one-column flow without inventing a column boundary', () => {
    const result = reconstruct([
      page(1, [
        run(1, 'One column title', 0.1, 0.12, 0.72, 18),
        run(1, 'First body line.', 0.1, 0.24, 0.72),
        run(1, 'Second body line.', 0.1, 0.28, 0.72),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.includedInReadingOrder)
        .every((region) => region.column === 'single'),
    ).toBe(true)
    expect(result.readingOrder).toMatchObject({ acyclic: true })
    expect(result.readingOrder.evaluation).toMatchObject({
      mode: 'deterministic-only',
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      reviewRequired: false,
    })
  })

  it('keeps repeated margins, page numbers, chart labels, and notes out of body prose', () => {
    const result = reconstruct([
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

  it('orders both column bands around a spanning block and links notes under each column', () => {
    const result = reconstruct([
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

  it('matches a page-wide symbolic footnote and emits EPUB note semantics and backlinks', async () => {
    const result = reconstruct(
      [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Left two.', 0.08, 0.24, 0.32),
          run(1, 'Left marker', 0.08, 0.28, 0.24),
          run(1, '*', 0.325, 0.283, 0.008, 6, 0.009),
          run(1, 'Right one.', 0.56, 0.2, 0.32),
          run(1, 'Right two.', 0.56, 0.24, 0.32),
          run(1, 'Right three.', 0.56, 0.28, 0.32),
          run(
            1,
            '*. A note spanning the full page width.',
            0.08,
            0.82,
            0.84,
            7,
          ),
        ]),
      ],
      '8',
    )

    expect(result.noteRelationships).toEqual([
      expect.objectContaining({
        label: '*',
        status: 'matched',
        evidence: expect.arrayContaining(['page-wide-note-region']),
      }),
    ])
    expect(result.readiness.ready).toBe(true)
    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('epub:type="noteref"')
    expect(content).toContain('epub:type="footnote"')
    expect(content).toContain('class="note-backlink"')
  })

  it('retains unresolved and equally plausible note candidates as explicit diagnostics', () => {
    const unresolved = reconstruct([
      page(1, [run(1, 'A claim with an unavailable note[3].', 0.1, 0.2, 0.72)]),
    ])
    expect(unresolved.noteRelationships).toEqual([
      expect.objectContaining({
        label: '3',
        status: 'unresolved',
        targetNoteId: null,
        candidates: [],
      }),
    ])
    expect(unresolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_NOTE_REFERENCE' }),
      ]),
    )

    const ambiguous = reconstruct([
      page(1, [
        run(1, 'Left one.', 0.08, 0.2, 0.32),
        run(1, 'Left two.', 0.08, 0.24, 0.32),
        run(1, 'Left three.', 0.08, 0.28, 0.32),
        run(1, 'Right one.', 0.56, 0.2, 0.32),
        run(1, 'Right two.', 0.56, 0.24, 0.32),
        run(1, 'Right three.', 0.56, 0.28, 0.32),
        run(1, 'A spanning claim has note reference 1.', 0.1, 0.42, 0.8),
        run(1, '1. Left candidate.', 0.08, 0.82, 0.32, 7),
        run(1, '1. Right candidate.', 0.56, 0.82, 0.32, 7),
      ]),
    ])
    expect(ambiguous.noteRelationships).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        targetNoteId: null,
        candidates: [
          expect.objectContaining({ score: 0.85 }),
          expect.objectContaining({ score: 0.85 }),
        ],
      }),
    ])
    expect(ambiguous.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_NOTE_MATCH' }),
      ]),
    )
  })

  it('resolves multi-page endnotes and exposes machine-readable order accuracy', () => {
    const result = reconstruct(
      [
        page(1, [
          run(1, 'The first claim has note reference 1.', 0.1, 0.2, 0.72),
          run(1, 'The second claim has note reference 2.', 0.1, 0.25, 0.72),
        ]),
        page(2, [
          run(2, 'Endnotes', 0.1, 0.12, 0.3, 18),
          run(2, '1. First endnote on page two.', 0.1, 0.22, 0.72),
        ]),
        page(3, [run(3, '2. Second endnote on page three.', 0.1, 0.18, 0.72)]),
      ],
      '9',
    )

    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([
      expect.objectContaining({ kind: 'endnote', label: '1' }),
      expect.objectContaining({ kind: 'endnote', label: '2' }),
    ])
    expect(
      result.noteRelationships.every((note) => note.status === 'matched'),
    ).toBe(true)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 2,
      relationshipCoverage: 1,
    })
    expect(
      evaluateReadingOrder(result.readingOrder, result.readingOrder.order),
    ).toMatchObject({ orderAccuracy: 1, cycleRate: 0 })
  })
})
