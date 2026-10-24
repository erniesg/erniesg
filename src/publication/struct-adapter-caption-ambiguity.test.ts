import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  StructBlock,
  StructDocument,
  StructRelationship,
} from '../struct/types'
import { buildStructDocument } from '../struct-adapters'
import { adaptStructDocument } from './struct-adapter'
import { loadAdapterCase } from '../../tests/fixtures/struct-adapter-parity/cases'

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

function relationship(
  value: Partial<StructRelationship> &
    Pick<StructRelationship, 'id' | 'kind' | 'from' | 'to'>,
): StructRelationship {
  return {
    status: 'matched',
    confidence: 1,
    evidence,
    ...value,
  }
}

function document(
  blocks: StructBlock[],
  relationships: StructRelationship[],
): StructDocument {
  return {
    schemaVersion: '0.2.0',
    documentId: 'struct-caption-ambiguity',
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
      abstract: 'A caption ownership fixture.',
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
        sourceObjectIds: [],
        evidence,
        fallback: 'asset',
      },
    ],
    relationships,
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
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: '',
      summary: '',
      issues: [],
    },
    receipt: {
      schemaVersion: '0.2.0',
      documentId: 'struct-caption-ambiguity',
      sourceSha256: 'a'.repeat(64),
      blockCount: blocks.length,
      assetCount: 1,
      relationshipCount: relationships.length,
      diagnosticCount: 0,
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
        sourceRelationshipCount: relationships.length,
        accountedSourceRelationshipCount: relationships.length,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: blocks.reduce(
          (sum, item) => sum + item.text.length,
          0,
        ),
        structBlockCount: blocks.length,
        structAssetCount: 1,
        structRelationshipCount: relationships.length,
        structDiagnosticCount: 0,
        structTextCharacterCount: blocks.reduce(
          (sum, item) => sum + item.text.length,
          0,
        ),
      },
      generatedSha256: 'b'.repeat(64),
    },
  }
}

const captionCodes = (result: ReturnType<typeof adaptStructDocument>) =>
  result.diagnostics
    .map(({ code }) => code)
    .filter(
      (code) =>
        code === 'invalid-caption-relationship' ||
        code === 'unresolved-relationship-target',
    )

const captionNodes = (result: ReturnType<typeof adaptStructDocument>) =>
  result.graph.nodes.filter((node) => node.type === 'caption')

describe('STRUCT publication caption ownership', () => {
  // The reconstruction ingress declares BOTH forms for the same caption link:
  // the explicit `caption` relationship and the typed visual relationship whose
  // `to` array carries the asset id and the caption block id.  Two claims for
  // the SAME (parentId, captionId) pair are ONE claim, not an ambiguity.
  it.each([
    {
      label: 'the explicit relationship is declared first',
      relationships: [
        relationship({
          id: 'explicit-caption',
          kind: 'caption',
          from: 'figure',
          to: ['figure-caption'],
        }),
        relationship({
          id: 'typed-visual',
          kind: 'figure',
          from: 'figure',
          to: ['figure-asset', 'figure-caption'],
        }),
      ],
    },
    {
      label: 'the typed visual relationship is declared first',
      relationships: [
        relationship({
          id: 'typed-visual',
          kind: 'figure',
          from: 'figure',
          to: ['figure-asset', 'figure-caption'],
        }),
        relationship({
          id: 'explicit-caption',
          kind: 'caption',
          from: 'figure',
          to: ['figure-caption'],
        }),
      ],
    },
  ])(
    'projects one caption link without an ambiguity warning when $label',
    ({ relationships }) => {
      const input = document(
        [
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
        ],
        relationships,
      )

      const result = adaptStructDocument(input)

      expect(captionCodes(result)).toEqual([])
      expect(captionNodes(result)).toHaveLength(1)
      expect(result.graph.nodes.find((node) => node.id === 'figure')).toMatchObject(
        {
          type: 'figure',
          captionId: 'figure-caption',
          assetIds: ['figure-asset'],
        },
      )
      expect(
        result.graph.nodes.find((node) => node.id === 'figure-caption'),
      ).toMatchObject({
        type: 'caption',
        parentId: 'figure',
        text: 'Figure caption',
      })
    },
  )

  it('treats two explicit declarations of the same pair as one claim', () => {
    const input = document(
      [
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
      ],
      [
        relationship({
          id: 'first-explicit-caption',
          kind: 'caption',
          from: 'figure',
          to: ['figure-caption'],
        }),
        relationship({
          id: 'second-explicit-caption',
          kind: 'caption',
          from: 'figure',
          to: ['figure-caption'],
        }),
      ],
    )

    const result = adaptStructDocument(input)

    expect(captionCodes(result)).toEqual([])
    expect(captionNodes(result)).toHaveLength(1)
    expect(
      result.graph.nodes.find((node) => node.id === 'figure'),
    ).toMatchObject({ captionId: 'figure-caption' })
  })

  it.each([
    {
      label: 'both claims are explicit',
      second: relationship({
        id: 'second-caption-relationship',
        kind: 'caption',
        from: 'figure',
        to: ['second-caption'],
      }),
    },
    {
      label: 'the second claim is a typed visual relationship',
      second: relationship({
        id: 'second-caption-relationship',
        kind: 'figure',
        from: 'figure',
        to: ['figure-asset', 'second-caption'],
      }),
    },
  ])(
    'refuses a parent that claims two different captions when $label',
    ({ second }) => {
      const input = document(
        [
          block({
            id: 'figure',
            kind: 'figure',
            text: 'Figure source',
            label: 'A figure',
            order: 0,
          }),
          block({
            id: 'first-caption',
            kind: 'caption',
            text: 'First caption',
            order: 1,
          }),
          block({
            id: 'second-caption',
            kind: 'caption',
            text: 'Second caption',
            order: 2,
          }),
        ],
        [
          relationship({
            id: 'first-caption-relationship',
            kind: 'caption',
            from: 'figure',
            to: ['first-caption'],
          }),
          second,
        ],
      )

      const result = adaptStructDocument(input)

      expect(
        result.diagnostics.filter(
          ({ code }) => code === 'invalid-caption-relationship',
        ),
      ).toEqual([
        expect.objectContaining({
          severity: 'warning',
          message:
            'Caption relationship second-caption-relationship would create an ambiguous caption owner and was omitted.',
          nodeId: 'figure',
        }),
      ])
      expect(captionNodes(result)).toHaveLength(1)
      expect(
        result.graph.nodes.find((node) => node.id === 'first-caption'),
      ).toMatchObject({ type: 'caption', parentId: 'figure' })
      expect(
        result.graph.nodes.some((node) => node.id === 'second-caption'),
      ).toBe(false)
      expect(
        result.graph.nodes.find((node) => node.id === 'figure'),
      ).toMatchObject({ captionId: 'first-caption' })
    },
  )

  it.each([
    {
      label: 'the explicit relationship claims it first',
      relationships: [
        relationship({
          id: 'explicit-caption',
          kind: 'caption',
          from: 'first-figure',
          to: ['shared-caption'],
        }),
        relationship({
          id: 'typed-visual',
          kind: 'figure',
          from: 'second-figure',
          to: ['figure-asset', 'shared-caption'],
        }),
      ],
      owner: 'first-figure',
      refused: 'second-figure',
    },
    {
      label: 'the typed visual relationship claims it first',
      relationships: [
        relationship({
          id: 'typed-visual',
          kind: 'figure',
          from: 'first-figure',
          to: ['figure-asset', 'shared-caption'],
        }),
        relationship({
          id: 'explicit-caption',
          kind: 'caption',
          from: 'second-figure',
          to: ['shared-caption'],
        }),
      ],
      owner: 'first-figure',
      refused: 'second-figure',
    },
  ])(
    'refuses a caption that two different parents claim when $label',
    ({ relationships, owner, refused }) => {
      const input = document(
        [
          block({
            id: 'first-figure',
            kind: 'figure',
            text: 'First figure',
            label: 'A figure',
            order: 0,
          }),
          block({
            id: 'second-figure',
            kind: 'figure',
            text: 'Second figure',
            label: 'Another figure',
            order: 1,
          }),
          block({
            id: 'shared-caption',
            kind: 'caption',
            text: 'Shared caption',
            order: 2,
          }),
        ],
        relationships,
      )

      const result = adaptStructDocument(input)

      expect(
        result.diagnostics.filter(
          ({ code }) => code === 'invalid-caption-relationship',
        ),
      ).toHaveLength(1)
      expect(
        result.diagnostics.find(
          ({ code }) => code === 'invalid-caption-relationship',
        )?.message,
      ).toContain('would create an ambiguous caption owner and was omitted')
      expect(captionNodes(result)).toHaveLength(1)
      expect(
        result.graph.nodes.find((node) => node.id === 'shared-caption'),
      ).toMatchObject({ type: 'caption', parentId: owner })
      expect(
        result.graph.nodes.find((node) => node.id === owner),
      ).toMatchObject({ captionId: 'shared-caption' })
      expect(
        result.graph.nodes.find((node) => node.id === refused),
      ).not.toHaveProperty('captionId')
    },
  )

  it('keeps the projected ids, asset ids and relationship accounting unchanged', async () => {
    const source = await loadAdapterCase('structured-docx')
    const input = buildStructDocument(source)
    const result = adaptStructDocument(input)
    const nodes = result.graph.nodes

    // The emitted ids and the asset ids of the caption-bearing nodes are the
    // ones the projection emitted before the ambiguity rule was repaired.
    expect(
      nodes
        .filter(
          (node) =>
            node.type === 'figure' ||
            node.type === 'table' ||
            node.type === 'caption',
        )
        .map((node) => ({
          id: node.id,
          type: node.type,
          captionId: 'captionId' in node ? node.captionId : undefined,
          parentId: 'parentId' in node ? node.parentId : undefined,
          assetIds: 'assetIds' in node ? node.assetIds : undefined,
        })),
    ).toEqual([
      {
        id: 'struct-block-f31da5afacbbf5e60d9b2a08',
        type: 'figure',
        captionId: 'struct-block-e213d0ed98ad637bba9f2b28',
        parentId: undefined,
        assetIds: ['struct-asset-b0412fd7e5e0a8b6964ba576'],
      },
      {
        id: 'struct-block-e213d0ed98ad637bba9f2b28',
        type: 'caption',
        captionId: undefined,
        parentId: 'struct-block-f31da5afacbbf5e60d9b2a08',
        assetIds: undefined,
      },
      {
        id: 'struct-block-c31da067a297485f0a52c6a8',
        type: 'table',
        captionId: 'struct-block-d92e9239ac89d05c560ddf3d',
        parentId: undefined,
        assetIds: undefined,
      },
      {
        id: 'struct-block-d92e9239ac89d05c560ddf3d',
        type: 'caption',
        captionId: undefined,
        parentId: 'struct-block-c31da067a297485f0a52c6a8',
        assetIds: undefined,
      },
    ])

    // Every caption of the document is owned exactly once, and the caption
    // links are reciprocal.
    expect(captionNodes(result)).toHaveLength(2)
    for (const caption of captionNodes(result)) {
      expect(
        nodes.find(
          (node) =>
            'captionId' in node && node.captionId === caption.id,
        ),
      ).toBeDefined()
    }

    // The relationship accounting stays consistent: the source count, the
    // accounted count, the receipt count and the published relationships are
    // the same number, and no relationship is dropped from the accounting.
    const conservation = input.receipt.conservation
    expect(input.relationships).toHaveLength(7)
    expect(conservation.sourceRelationshipCount).toBe(7)
    expect(conservation.accountedSourceRelationshipCount).toBe(7)
    expect(conservation.structRelationshipCount).toBe(7)
    expect(input.receipt.relationshipCount).toBe(7)
    expect(
      input.relationships.filter(({ status }) => status === 'matched'),
    ).toHaveLength(6)
    expect(
      input.relationships.filter(
        ({ status }) => status !== 'matched',
      ),
    ).toHaveLength(1)

    // The two claims of the same pair are one claim: no ambiguity warning and
    // no dropped endpoint.
    expect(captionCodes(result)).toEqual([])
  })
})
