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
})
