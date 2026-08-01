import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { canonicalContentHash } from './canonical-hash'
import { researchPaperSchema, type ResearchPaper } from './schema'

type RawFigureNode = (typeof rawPaper.nodes)[number] & {
  type: 'figure'
  relationships: { caption: string }
}

type RawHeadingNode = (typeof rawPaper.nodes)[number] & {
  type: 'heading'
  level: number
}

function clonePaper() {
  return structuredClone(rawPaper)
}

function scopedTablePaper() {
  const paper = researchPaperSchema.parse(rawPaper)
  return {
    ...paper,
    nodes: [
      {
        id: 'table-node',
        type: 'figure' as const,
        title: 'Scoped table',
        objectType: 'table' as const,
        table: {
          rows: [
            {
              cells: [
                {
                  text: 'Group',
                  headerScope: 'column' as const,
                  columnSpan: 1,
                  rowSpan: 1,
                },
                {
                  text: 'Score',
                  headerScope: 'column' as const,
                  columnSpan: 1,
                  rowSpan: 1,
                },
              ],
            },
            {
              cells: [
                {
                  text: 'Control',
                  headerScope: 'row' as const,
                  columnSpan: 1,
                  rowSpan: 1,
                },
                {
                  text: '10',
                  headerScope: null,
                  columnSpan: 1,
                  rowSpan: 1,
                },
              ],
            },
          ],
        },
        relationships: { caption: 'table-caption' },
        source: 'test',
      },
      {
        id: 'table-caption',
        type: 'caption' as const,
        text: 'Table 1. Scoped table.',
        source: 'test',
      },
    ],
  } satisfies ResearchPaper
}

describe('SRT canonical graph schema', () => {
  it('accepts typed canonical publication language, direction, dates, and source lineage', () => {
    const candidate = {
      ...clonePaper(),
      language: 'ar',
      baseDirection: 'rtl',
      publicationDate: '2024-08-19',
      artifactModifiedAt: '2026-07-23T00:42:00Z',
      metadataLineage: {
        language: {
          status: 'proven',
          source: 'pdf-ocr-explicit',
          evidence: ['ocr-language:ara->ar'],
        },
        baseDirection: {
          status: 'proven',
          source: 'publication-language',
          evidence: ['language:ar'],
        },
        publicationDate: {
          status: 'unresolved',
          source: 'pdf-xmp-not-extracted',
          evidence: ['pdf-xmp-metadata-not-extracted'],
        },
        artifactModifiedAt: {
          status: 'proven',
          source: 'pdf-info-mod-date',
          evidence: ['pdf-info:ModDate'],
        },
      },
    }

    expect(researchPaperSchema.safeParse(candidate).success).toBe(true)
  })

  it('accepts bounded PDF text language inference lineage', () => {
    const candidate = {
      ...clonePaper(),
      language: 'en',
      baseDirection: 'ltr',
      metadataLineage: {
        language: {
          status: 'proven',
          source: 'pdf-text-language-inference',
          evidence: [
            'pdf-text-language:en:words=450:markers=92:density=0.20444:latin=1:competitor=0',
          ],
        },
        baseDirection: {
          status: 'proven',
          source: 'publication-language',
          evidence: ['language:en'],
        },
        publicationDate: {
          status: 'unresolved',
          source: 'pdf-xmp-not-extracted',
          evidence: ['pdf-xmp-metadata-not-extracted'],
        },
        artifactModifiedAt: {
          status: 'unresolved',
          source: 'unproven',
          evidence: ['no-authoritative-artifact-modified-at'],
        },
      },
    }

    expect(researchPaperSchema.safeParse(candidate).success).toBe(true)
  })

  it.each([
    ['non-BCP47 OCR code', { language: 'chi_sim' }],
    ['noncanonical language casing', { language: 'EN-us' }],
    ['invalid base direction', { baseDirection: 'auto' }],
    ['non-date publication date', { publicationDate: 'August 19, 2024' }],
    ['date-only artifact timestamp', { artifactModifiedAt: '2026-07-23' }],
  ])('rejects %s in canonical publication metadata', (_label, override) => {
    expect(
      researchPaperSchema.safeParse({ ...clonePaper(), ...override }).success,
    ).toBe(false)
  })

  it('validates the golden paper fixture and freezes stable node ids', () => {
    const paper = researchPaperSchema.parse(rawPaper)

    expect(paper.nodes.map((node) => node.id)).toEqual([
      'sec-proposition',
      'p-proposition-1',
      'q-core',
      'sec-model',
      'p-model-1',
      'fig-pipeline',
      'cap-pipeline',
      'sec-gap',
      'p-gap-1',
      'sec-method',
      'p-method-1',
    ])
    expect(canonicalContentHash(paper)).toBe(
      'ccc381d2455fb3c2551f02b1cb62fede7f867872328f51fa57bf212ca5e2dd35',
    )
  })

  it('requires every relationship target to exist', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const ids = new Set(paper.nodes.map((node) => node.id))

    for (const node of paper.nodes) {
      if (node.type === 'figure') {
        expect(ids.has(node.relationships.caption)).toBe(true)
      }
    }
  })

  it('rejects duplicate node ids', () => {
    const paper = clonePaper()
    paper.nodes[1].id = paper.nodes[0].id

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('rejects dangling relationships', () => {
    const paper = clonePaper()
    const figure = paper.nodes.find(
      (node): node is RawFigureNode => node.type === 'figure',
    )
    if (!figure) throw new Error('Fixture lost its figure node')

    figure.relationships.caption = 'missing-caption'

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('validates note targets, stable reference ids, and backlinks', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const withNote = {
      ...paper,
      nodes: [
        {
          id: 'p-note-source',
          type: 'paragraph' as const,
          text: 'A claim1',
          noteReferences: [
            {
              id: 'noteref-1',
              label: '1',
              target: 'fn-1',
              start: 7,
              end: 8,
              confidence: 0.95,
            },
          ],
          source: 'test',
        },
        {
          id: 'fn-1',
          type: 'footnote' as const,
          kind: 'footnote' as const,
          label: '1',
          text: 'A linked note.',
          relationships: { backlinks: ['noteref-1'] },
          source: 'test',
        },
      ],
    }

    expect(researchPaperSchema.safeParse(withNote).success).toBe(true)
    const withAuthorNote = {
      ...withNote,
      authorNotes: [
        {
          id: 'author-noteref-1',
          author: withNote.authors[0],
          label: '*',
          target: 'fn-1',
        },
      ],
      nodes: [
        withNote.nodes[0],
        {
          ...withNote.nodes[1],
          relationships: {
            backlinks: ['noteref-1', 'author-noteref-1'],
          },
        },
      ],
    }
    expect(researchPaperSchema.safeParse(withAuthorNote).success).toBe(true)
    expect(
      researchPaperSchema.safeParse({
        ...withAuthorNote,
        authorNotes: [
          { ...withAuthorNote.authorNotes[0], author: 'Unknown Author' },
        ],
      }).success,
    ).toBe(false)
    expect(
      researchPaperSchema.safeParse({
        ...withNote,
        nodes: [
          {
            ...withNote.nodes[0],
            noteReferences: [
              { ...withNote.nodes[0].noteReferences![0], target: 'missing' },
            ],
          },
          withNote.nodes[1],
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects invalid heading levels', () => {
    const paper = clonePaper()
    const heading = paper.nodes.find(
      (node): node is RawHeadingNode => node.type === 'heading',
    )
    if (!heading) throw new Error('Fixture lost its heading node')

    heading.level = 0

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('rejects target coordinates in canonical content', () => {
    const paper = clonePaper()

    expect(
      researchPaperSchema.safeParse({
        ...paper,
        targetGeometry: { width: 390 },
      }).success,
    ).toBe(false)
    expect(
      researchPaperSchema.safeParse({
        ...paper,
        nodes: [{ ...paper.nodes[0], x: 10, y: 20 }, ...paper.nodes.slice(1)],
      }).success,
    ).toBe(false)
  })

  it('accepts an explicit row-header scope in a canonical table body', () => {
    const paper = scopedTablePaper()

    expect(researchPaperSchema.safeParse(paper).success).toBe(true)
  })
  it('accepts a source-verified empty continuation cell', () => {
    const paper = scopedTablePaper()
    const table = paper.nodes[0].table
    if (!table) throw new Error('Scoped table fixture lost its table data')
    Object.assign(table.rows[1].cells[1], {
      text: '',
      sourceRuns: [],
      inlineMapping: { expected: 0, mapped: 0 },
    })

    expect(researchPaperSchema.safeParse(paper).success).toBe(true)
  })

  it('rejects a column-header rowspan that crosses into the table body', () => {
    const paper = scopedTablePaper()
    const table = paper.nodes[0].table
    if (!table) throw new Error('Scoped table fixture lost its table data')
    table.rows[0].cells[0].rowSpan = 2
    table.rows[1].cells.splice(0, 1)

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('rejects nonrectangular canonical table span topology', () => {
    const paper = scopedTablePaper()
    const table = paper.nodes[0].table
    if (!table) throw new Error('Scoped table fixture lost its table data')
    table.rows[1].cells[1].columnSpan = 2

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('computes a deterministic hash that ignores rendition geometry', () => {
    const paper = researchPaperSchema.parse(rawPaper)

    expect(
      canonicalContentHash({
        ...paper,
        targetGeometry: { width: 390, height: 720 },
        nodes: [{ ...paper.nodes[0], x: 12, y: 24 }, ...paper.nodes.slice(1)],
      }),
    ).toBe(canonicalContentHash(paper))
  })
})
