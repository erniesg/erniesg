import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  StructDocument,
  StructBlock,
} from '../../packages/struct/src/types'
import { publicationGraphSchema } from './schema'
import { adaptStructDocument } from './struct-adapter'

const bytes = new Uint8Array([1, 2, 3])
const assetSha256 = createHash('sha256').update(bytes).digest('hex')

const evidence = {
  confidence: 1,
  pages: [1],
  boxes: [],
  sourceIds: ['source-node'],
}

function block(
  value: Partial<StructBlock> &
    Pick<StructBlock, 'id' | 'kind' | 'text' | 'order'>,
): StructBlock {
  return {
    page: 1,
    column: 'single',
    inline: [],
    evidence,
    ...value,
  }
}

function document(blocks: StructBlock[]): StructDocument {
  return {
    schemaVersion: '0.2.0',
    documentId: 'struct-fixture',
    source: {
      format: 'pdf',
      fileName: 'fixture.pdf',
      sha256: 'a'.repeat(64),
      byteLength: 3,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'STRUCT fixture',
      subtitle: 'Semantic source',
      authors: ['Ada Example'],
      abstract: 'An adapter fixture.',
      language: 'en',
      baseDirection: 'ltr',
    },
    blocks,
    assets: [
      {
        id: 'figure-asset',
        kind: 'figure',
        href: 'assets/figure.png',
        mediaType: 'image/png',
        sha256: assetSha256,
        width: 10,
        height: 20,
        bytes,
        sourceObjectIds: ['provider-object-must-not-leak'],
        evidence,
        fallback: 'asset',
      },
    ],
    relationships: [
      {
        id: 'caption-rel',
        kind: 'caption',
        from: 'figure',
        to: ['figure-caption'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
      {
        id: 'note-rel',
        kind: 'footnote',
        from: 'paragraph',
        to: ['note'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
      {
        id: 'citation-rel',
        kind: 'citation',
        from: 'paragraph',
        to: ['reference'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
      {
        id: 'unresolved-rel',
        kind: 'cross-reference',
        from: 'paragraph',
        to: ['missing-target'],
        status: 'unresolved',
        confidence: 0.2,
        evidence,
      },
    ],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: blocks.map(({ id }) => id),
        columns: [
          {
            id: 'column-1',
            side: 'single',
            blockIds: blocks.map(({ id }) => id),
          },
        ],
      },
    ],
    diagnostics: [
      {
        id: 'source-diagnostic',
        severity: 'warning',
        category: 'source',
        title: 'Source-preserved content',
        message: 'The source contains content that was not fully resolved.',
        pages: [1],
        sourceIds: ['source-node'],
      },
    ],
    recovery: {
      status: 'review-required',
      title: 'Review',
      summary: 'Recovery details must stay outside PublicationGraph.',
      issues: [],
    },
    receipt: {
      schemaVersion: '0.2.0',
      documentId: 'struct-fixture',
      sourceSha256: 'a'.repeat(64),
      blockCount: blocks.length,
      assetCount: 1,
      relationshipCount: 4,
      diagnosticCount: 1,
      textCharacterCount: blocks.reduce(
        (sum, item) => sum + item.text.length,
        0,
      ),
      conservation: {
        sourceNodeCount: blocks.length,
        accountedSourceNodeCount: blocks.length,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceAssetCount: 1,
        accountedSourceAssetCount: 1,
        sourceRelationshipCount: 4,
        accountedSourceRelationshipCount: 4,
        sourceDiagnosticCount: 1,
        accountedSourceDiagnosticCount: 1,
        sourceTextCharacterCount: blocks.reduce(
          (sum, item) => sum + item.text.length,
          0,
        ),
        structBlockCount: blocks.length,
        structAssetCount: 1,
        structRelationshipCount: 4,
        structDiagnosticCount: 1,
        structTextCharacterCount: blocks.reduce(
          (sum, item) => sum + item.text.length,
          0,
        ),
      },
      generatedSha256: 'b'.repeat(64),
    },
  }
}

describe('STRUCT publication adapter', () => {
  it('maps semantic blocks, lists, notes, backlinks, tables, equations, figures, and stable ids', async () => {
    const input = document([
      block({
        id: 'heading',
        kind: 'heading',
        text: 'Heading',
        order: 0,
        attributes: { level: 2 },
      }),
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: 'See 1 and [ref].',
        order: 1,
        inline: [
          {
            start: 4,
            end: 5,
            relationshipId: 'note-rel',
            targetIds: ['note'],
            semanticRole: 'note-reference',
          },
          {
            start: 10,
            end: 15,
            relationshipId: 'citation-rel',
            targetIds: ['reference'],
            semanticRole: 'citation',
          },
        ],
      }),
      block({
        id: 'item-a',
        kind: 'list-item',
        text: 'First',
        order: 2,
        attributes: { listLevel: 0, listOrdered: true },
      }),
      block({
        id: 'item-b',
        kind: 'list-item',
        text: 'Second',
        order: 3,
        attributes: { listLevel: 0, listOrdered: true },
      }),
      block({
        id: 'table',
        kind: 'table',
        text: 'A B',
        order: 4,
        table: {
          rows: 1,
          columns: 2,
          semantic: 'verified',
          cells: [
            {
              id: 'cell-a',
              text: 'A',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 2,
              headerScope: 'column',
              inline: [],
              evidence,
            },
            {
              id: 'cell-b',
              text: 'B',
              row: 0,
              column: 1,
              rowSpan: 2,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
          ],
        },
      }),
      block({
        id: 'equation',
        kind: 'equation',
        text: 'x^2 = 1',
        order: 5,
        attributes: { equationFormat: 'latex' },
      }),
      block({
        id: 'figure',
        kind: 'figure',
        text: 'Figure source',
        label: 'A figure',
        order: 6,
        fallbackAssetIds: ['figure-asset'],
      }),
      block({
        id: 'figure-caption',
        kind: 'caption',
        text: 'Figure caption',
        order: 7,
      }),
      block({
        id: 'note',
        kind: 'footnote',
        text: 'Footnote body',
        label: '1',
        order: 8,
      }),
      block({
        id: 'reference',
        kind: 'paragraph',
        text: 'Bibliography entry',
        order: 9,
      }),
      block({ id: 'furniture', kind: 'furniture', text: 'Page 1', order: 10 }),
      block({
        id: 'unknown',
        kind: 'unknown',
        text: 'Unknown structure',
        order: 11,
      }),
    ])

    const result = adaptStructDocument(input)
    const graph = publicationGraphSchema.parse(result.graph)
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'heading',
      'paragraph',
      'item-a-list',
      'item-a',
      'item-b',
      'table',
      'equation',
      'figure',
      'figure-caption',
      'note',
      'reference',
    ])
    expect(byId.get('heading')).toMatchObject({ type: 'heading', level: 2 })
    expect(byId.get('item-a')).toMatchObject({
      type: 'list-item',
      parentListId: 'item-a-list',
    })
    expect(byId.get('item-b')).toMatchObject({
      type: 'list-item',
      parentListId: 'item-a-list',
    })
    expect(byId.get('note')).toMatchObject({
      type: 'note',
      noteKind: 'footnote',
      backlinkIds: ['note-rel'],
    })
    expect(byId.get('paragraph')).toMatchObject({
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({
          semanticRole: 'cross-reference',
          targetIds: ['note'],
          href: '#note',
          relationshipId: 'note-rel',
        }),
        expect.objectContaining({
          semanticRole: 'citation',
          targetIds: ['reference'],
          relationshipId: 'citation-rel',
        }),
      ]),
    })
    expect(byId.get('table')).toMatchObject({
      type: 'table',
      rows: [
        {
          cells: [
            { text: 'A', rowSpan: 1, columnSpan: 2 },
            { text: 'B', rowSpan: 2, columnSpan: 1 },
          ],
        },
      ],
    })
    expect(byId.get('equation')).toMatchObject({
      type: 'equation',
      source: 'x^2 = 1',
      format: 'latex',
    })
    expect(byId.get('figure')).toMatchObject({
      type: 'figure',
      title: 'A figure',
      assetIds: ['figure-asset'],
      captionId: 'figure-caption',
      sourceText: 'Figure source',
    })
    expect(result.assetBundle.descriptor.assets.map(({ id }) => id)).toEqual([
      'figure-asset',
    ])
    expect(
      await result.assetBundle.resolveBytes(
        result.assetBundle.descriptor.assets[0]!,
      ),
    ).toEqual(bytes)
    expect(adaptStructDocument(input).graph).toEqual(result.graph)
  })

  it('maps the #212 mixed asset and caption endpoint shape without fallback assets or unresolved diagnostics', () => {
    const input = document([
      block({
        id: 'figure',
        kind: 'figure',
        text: 'Figure source',
        label: 'A figure',
        order: 0,
      }),
      block({
        id: 'figure-caption',
        kind: 'caption',
        text: 'Figure caption',
        order: 1,
      }),
    ])
    input.relationships = [
      {
        id: 'figure-relation',
        kind: 'figure',
        from: 'figure',
        to: ['figure-asset', 'figure-caption'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
    ]

    const result = adaptStructDocument(input)
    const figure = result.graph.nodes.find((node) => node.id === 'figure')
    const caption = result.graph.nodes.find(
      (node) => node.id === 'figure-caption',
    )

    expect(figure).toMatchObject({
      type: 'figure',
      assetIds: ['figure-asset'],
      captionId: 'figure-caption',
    })
    expect(caption).toMatchObject({
      type: 'caption',
      parentId: 'figure',
      text: 'Figure caption',
    })
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'unresolved-relationship-target',
    )
  })

  it.each([
    {
      kind: 'table' as const,
      parent: block({
        id: 'table',
        kind: 'table',
        text: 'Table source',
        order: 0,
        table: {
          rows: 1,
          columns: 1,
          semantic: 'verified',
          cells: [
            {
              id: 'table-cell',
              text: 'Cell',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
          ],
        },
      }),
    },
    {
      kind: 'equation' as const,
      parent: block({
        id: 'equation',
        kind: 'equation',
        text: 'x = y',
        order: 0,
      }),
    },
  ])(
    'maps the #212 mixed asset and caption endpoint shape for $kind',
    ({ kind, parent }) => {
      const captionId = `${kind}-caption`
      const input = document([
        parent,
        block({
          id: captionId,
          kind: 'caption',
          text: `${kind} caption`,
          order: 1,
        }),
      ])
      input.relationships = [
        {
          id: `${kind}-relation`,
          kind,
          from: kind,
          to: ['figure-asset', captionId],
          status: 'matched',
          confidence: 1,
          evidence,
        },
      ]

      const result = adaptStructDocument(input)

      expect(result.graph.nodes.find((node) => node.id === kind)).toMatchObject(
        {
          type: kind,
          captionId,
        },
      )
      expect(
        result.graph.nodes.find((node) => node.id === captionId),
      ).toMatchObject({
        type: 'caption',
        parentId: kind,
      })
      expect(result.diagnostics.map(({ code }) => code)).not.toContain(
        'unresolved-relationship-target',
      )
    },
  )

  it('preserves unresolved/source-preserved meaning through deterministic diagnostics and excludes recovery/page/provider data', async () => {
    const input = document([
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: 'Unresolved target',
        order: 0,
        inline: [
          {
            start: 0,
            end: 10,
            relationshipId: 'unresolved-rel',
            targetIds: ['missing-target'],
            semanticRole: 'cross-reference',
          },
        ],
      }),
      block({
        id: 'table',
        kind: 'table',
        text: 'Source table',
        order: 1,
        table: {
          rows: 1,
          columns: 1,
          semantic: 'source-preserved',
          cells: [
            {
              id: 'cell',
              text: 'Source cell',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
          ],
        },
      }),
      block({
        id: 'equation',
        kind: 'equation',
        text: 'unresolved equation',
        order: 2,
        attributes: { equationFormat: 'plain-text', sourcePreserved: true },
      }),
      block({
        id: 'furniture',
        kind: 'furniture',
        text: 'Furniture',
        order: 3,
      }),
    ])
    const result = adaptStructDocument(input)
    const serialized = JSON.stringify(result.graph)

    expect(result.graph.nodes.map((node) => node.id)).toEqual([
      'paragraph',
      'table',
      'equation',
    ])
    expect(
      result.graph.nodes.find((node) => node.id === 'paragraph'),
    ).toMatchObject({ inlineRuns: [{ start: 0, end: 10 }] })
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'struct-source',
      'unresolved-relationship-target',
      'unresolved-relationship-target',
      'unresolved-relationship-target',
      'unresolved-cross-reference',
      'source-preserved-table',
      'source-preserved-equation',
      'unsupported-furniture',
    ])
    expect(serialized).not.toContain('review-required')
    expect(serialized).not.toContain('provider-object-must-not-leak')
    expect(serialized).not.toContain('pageCount')
    expect(result.provenance).toMatchObject({
      adapterId: 'struct-document',
      sourceType: 'pdf',
      sourceId: 'fixture.pdf',
    })
  })

  it('omits table-cell inline annotations with an explicit lossy diagnostic', () => {
    const input = document([
      block({
        id: 'table',
        kind: 'table',
        text: 'A',
        order: 0,
        table: {
          rows: 1,
          columns: 1,
          semantic: 'verified',
          cells: [
            {
              id: 'cell',
              text: 'A',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [{ start: 0, end: 1, bold: true }],
              evidence,
            },
          ],
        },
      }),
    ])

    const result = adaptStructDocument(input)
    const graph = publicationGraphSchema.parse(result.graph)

    expect(graph.nodes[0]).toMatchObject({
      type: 'table',
      rows: [{ cells: [{ text: 'A' }] }],
    })
    expect(graph.nodes[0]).not.toHaveProperty('rows.0.cells.0.inlineRuns')
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'lossy-table-inline' }),
    )
  })

  it('diagnoses and omits figure assets whose bytes are unavailable', () => {
    const input = document([
      block({
        id: 'figure',
        kind: 'figure',
        text: 'Figure source',
        label: 'A figure',
        order: 0,
        fallbackAssetIds: ['figure-asset'],
      }),
    ])
    input.assets = input.assets.map((asset) => ({
      ...asset,
      bytes: undefined,
    }))

    const result = adaptStructDocument(input)
    const figure = result.graph.nodes.find((node) => node.id === 'figure')

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'asset-bytes-unavailable' }),
    )
    expect(result.assetBundle.descriptor.assets).toEqual([])
    expect(figure).toMatchObject({ type: 'figure', assetIds: [] })
  })

  it.each([
    [
      'block',
      (input: StructDocument) => {
        input.blocks.push(
          block({ id: 'duplicate', kind: 'heading', text: 'Second', order: 1 }),
        )
      },
    ],
    [
      'relationship',
      (input: StructDocument) => {
        input.relationships.push({
          ...input.relationships[0]!,
          id: 'duplicate',
        })
        input.relationships[0]!.id = 'duplicate'
      },
    ],
    [
      'asset',
      (input: StructDocument) => {
        input.assets.push({ ...input.assets[0]!, id: 'duplicate' })
        input.assets[0]!.id = 'duplicate'
      },
    ],
  ])(
    'rejects duplicate source %s ids with a deterministic adapter error',
    (kind, mutate) => {
      const input = document([
        block({ id: 'duplicate', kind: 'paragraph', text: 'First', order: 0 }),
      ])
      mutate(input)

      expect(() => adaptStructDocument(input)).toThrow(
        `STRUCT_DUPLICATE_${kind.toUpperCase()}_ID:duplicate`,
      )
    },
  )

  it('diagnoses matched relationships whose inline targets are missing', () => {
    const input = document([
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: 'A',
        order: 0,
        inline: [
          {
            start: 0,
            end: 1,
            relationshipId: 'matched-rel',
            targetIds: ['missing-target'],
            semanticRole: 'affiliation-marker',
          },
        ],
      }),
    ])
    input.relationships = [
      {
        id: 'matched-rel',
        kind: 'cross-reference',
        from: 'paragraph',
        to: ['missing-target'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
    ]

    const result = adaptStructDocument(input)
    const paragraph = result.graph.nodes.find((node) => node.id === 'paragraph')

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-relationship-target' }),
    )
    expect(paragraph).toMatchObject({
      type: 'paragraph',
      inlineRuns: [{ start: 0, end: 1, semanticRole: 'affiliation-marker' }],
    })
  })

  it('diagnoses inline references to omitted blocks without throwing the graph schema', () => {
    const input = document([
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: 'A',
        order: 0,
        inline: [
          {
            start: 0,
            end: 1,
            relationshipId: 'omitted-rel',
            targetIds: ['empty'],
            semanticRole: 'affiliation-marker',
          },
        ],
      }),
      block({ id: 'empty', kind: 'heading', text: '', order: 1 }),
    ])
    input.relationships = [
      {
        id: 'omitted-rel',
        kind: 'cross-reference',
        from: 'paragraph',
        to: ['empty'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
    ]

    const result = adaptStructDocument(input)
    expect(() => publicationGraphSchema.parse(result.graph)).not.toThrow()
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-relationship-target' }),
    )
  })

  it('assigns stable occurrence relationship ids for repeated valid inline references', () => {
    const input = document([
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: 'A B',
        order: 0,
        inline: [
          {
            start: 0,
            end: 1,
            relationshipId: 'shared-rel',
            targetIds: ['target'],
            semanticRole: 'cross-reference',
          },
          {
            start: 2,
            end: 3,
            relationshipId: 'shared-rel',
            targetIds: ['target'],
            semanticRole: 'cross-reference',
          },
        ],
      }),
      block({ id: 'target', kind: 'paragraph', text: 'Target', order: 1 }),
    ])
    input.relationships = [
      {
        id: 'shared-rel',
        kind: 'cross-reference',
        from: 'paragraph',
        to: ['target'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
    ]

    const result = adaptStructDocument(input)
    const graph = publicationGraphSchema.parse(result.graph)
    const paragraph = graph.nodes.find((node) => node.id === 'paragraph')
    const runs =
      paragraph && 'inlineRuns' in paragraph ? paragraph.inlineRuns : undefined

    expect(runs?.map((run) => run.relationshipId)).toEqual([
      'shared-rel',
      'shared-rel-occurrence-2',
    ])
    expect(runs?.every((run) => run.targetIds?.[0] === 'target')).toBe(true)
  })

  it('keeps repeated note occurrences reciprocal with stable backlink ids', () => {
    const input = document([
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: '1 2',
        order: 0,
        inline: [
          {
            start: 0,
            end: 1,
            relationshipId: 'note-rel',
            targetIds: ['note'],
            semanticRole: 'note-reference',
          },
          {
            start: 2,
            end: 3,
            relationshipId: 'note-rel',
            targetIds: ['note'],
            semanticRole: 'note-reference',
          },
        ],
      }),
      block({ id: 'note', kind: 'footnote', text: 'Note', order: 1 }),
    ])
    input.relationships = [
      {
        id: 'note-rel',
        kind: 'footnote',
        from: 'paragraph',
        to: ['note'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
    ]

    const result = adaptStructDocument(input)
    const graph = publicationGraphSchema.parse(result.graph)
    const note = graph.nodes.find((node) => node.id === 'note')

    expect(note).toMatchObject({
      type: 'note',
      backlinkIds: ['note-rel', 'note-rel-occurrence-2'],
    })
  })

  it('diagnoses matched non-inline relationships with missing endpoints', () => {
    const input = document([
      block({ id: 'paragraph', kind: 'paragraph', text: 'A', order: 0 }),
    ])
    input.relationships = [
      {
        id: 'reading-order-rel',
        kind: 'reading-order',
        from: 'paragraph',
        to: ['missing-target'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
    ]

    const result = adaptStructDocument(input)
    expect(() => publicationGraphSchema.parse(result.graph)).not.toThrow()
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-relationship-target' }),
    )
  })

  it('preserves and diagnoses generic inline relationships whose status is unresolved', () => {
    const input = document([
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: 'A',
        order: 0,
        inline: [
          {
            start: 0,
            end: 1,
            relationshipId: 'affiliation-rel',
            targetIds: ['target'],
            semanticRole: 'affiliation-marker',
          },
        ],
      }),
      block({ id: 'target', kind: 'paragraph', text: 'Target', order: 1 }),
    ])
    input.relationships = [
      {
        id: 'affiliation-rel',
        kind: 'cross-reference',
        from: 'paragraph',
        to: ['target'],
        status: 'unresolved',
        confidence: 0.2,
        evidence,
      },
    ]

    const result = adaptStructDocument(input)
    const graph = publicationGraphSchema.parse(result.graph)
    const paragraph = graph.nodes.find((node) => node.id === 'paragraph')
    const run =
      paragraph && 'inlineRuns' in paragraph
        ? paragraph.inlineRuns?.[0]
        : undefined

    expect(run).toMatchObject({
      relationshipId: 'affiliation-rel',
      targetIds: ['target'],
      semanticRole: 'affiliation-marker',
    })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-relationship-status' }),
    )
  })

  it('diagnoses sparse table row compaction rather than silently changing row meaning', () => {
    const input = document([
      block({
        id: 'table',
        kind: 'table',
        text: 'A',
        order: 0,
        table: {
          rows: 3,
          columns: 1,
          semantic: 'verified',
          cells: [
            {
              id: 'cell',
              text: 'A',
              row: 2,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
          ],
        },
      }),
    ])

    const result = adaptStructDocument(input)
    const graph = publicationGraphSchema.parse(result.graph)
    const table = graph.nodes.find((node) => node.id === 'table')

    expect(table).toMatchObject({
      type: 'table',
      rows: [{ cells: [{ text: 'A' }] }],
    })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'lossy-table-geometry' }),
    )
  })

  it('diagnoses fragment links targeting omitted blocks and removes the dangling href', () => {
    const input = document([
      block({
        id: 'paragraph',
        kind: 'paragraph',
        text: 'A',
        order: 0,
        inline: [{ start: 0, end: 1, href: '#empty' }],
      }),
      block({ id: 'empty', kind: 'heading', text: '', order: 1 }),
    ])

    const result = adaptStructDocument(input)
    const graph = publicationGraphSchema.parse(result.graph)
    const paragraph = graph.nodes.find((node) => node.id === 'paragraph')
    const run =
      paragraph && 'inlineRuns' in paragraph
        ? paragraph.inlineRuns?.[0]
        : undefined

    expect(run).not.toHaveProperty('href')
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-link' }),
    )
  })

  it('diagnoses invalid metadata dates without leaking a publication schema error', () => {
    const input = document([
      block({ id: 'paragraph', kind: 'paragraph', text: 'A', order: 0 }),
    ])
    input.relationships = []
    input.metadata.publicationDate = '2024-99-99'
    input.metadata.updated = '2024-02-30'
    input.metadata.artifactModifiedAt = '2024-99-99T00:00:00+00:00'

    const result = adaptStructDocument(input)

    expect(result.graph.metadata).not.toHaveProperty('created')
    expect(result.graph.metadata).not.toHaveProperty('modified')
    expect(result.graph.metadata).not.toHaveProperty('artifactModifiedAt')
    expect(
      result.diagnostics
        .map(({ code }) => code)
        .filter((code) => code.startsWith('invalid-')),
    ).toEqual([
      'invalid-publication-date',
      'invalid-updated-date',
      'invalid-artifact-modified-at',
    ])
    expect(() => publicationGraphSchema.parse(result.graph)).not.toThrow()
  })

  it('rejects duplicate table-cell source ids before publication schema parsing', () => {
    const input = document([
      block({
        id: 'table',
        kind: 'table',
        text: 'A B',
        order: 0,
        table: {
          rows: 1,
          columns: 2,
          semantic: 'verified',
          cells: [
            {
              id: 'duplicate-cell',
              text: 'A',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
            {
              id: 'duplicate-cell',
              text: 'B',
              row: 0,
              column: 1,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
          ],
        },
      }),
    ])

    expect(() => adaptStructDocument(input)).toThrow(
      'STRUCT_DUPLICATE_TABLE_CELL_ID:duplicate-cell',
    )
  })

  it('bounds unexpected publication schema failures behind a STRUCT adapter error', () => {
    const input = document([
      block({ id: 'paragraph', kind: 'paragraph', text: 'A', order: 0 }),
    ])
    input.relationships = []
    input.metadata.authors = ['']

    expect(() => adaptStructDocument(input)).toThrow(
      'STRUCT_PUBLICATION_SCHEMA_INVALID:',
    )
  })

  it.each([
    ['reverse caption relationship', 'caption', 'figure'],
    ['caption attached to a paragraph', 'paragraph', 'caption'],
  ])(
    'diagnoses %s without a raw schema error or semantic mislink',
    (_label, fromId, toId) => {
      const input = document([
        block({
          id: 'figure',
          kind: 'figure',
          text: 'Figure source',
          label: 'A figure',
          order: 0,
        }),
        block({
          id: 'paragraph',
          kind: 'paragraph',
          text: 'Paragraph',
          order: 1,
        }),
        block({
          id: 'caption',
          kind: 'caption',
          text: 'Caption',
          order: 2,
        }),
      ])
      input.relationships = [
        {
          id: 'invalid-caption-rel',
          kind: 'caption',
          from: fromId,
          to: [toId],
          status: 'matched',
          confidence: 1,
          evidence,
        },
      ]

      const result = adaptStructDocument(input)
      const figure = result.graph.nodes.find((node) => node.id === 'figure')

      expect(result.graph.nodes.some((node) => node.id === 'caption')).toBe(
        false,
      )
      expect(figure).not.toHaveProperty('captionId')
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'invalid-caption-relationship' }),
      )
      expect(() => publicationGraphSchema.parse(result.graph)).not.toThrow()
    },
  )
})
