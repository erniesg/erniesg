import { describe, expect, it } from 'vitest'
import {
  modelInputForStructuredExtraction,
  verifyStructuredExtraction,
  type StructuredExtractionContext,
  type StructuredExtractionProposal,
} from './structured-extraction'

const sourceSha256 = '1'.repeat(64)
const assetSha256 = '2'.repeat(64)

function context(): StructuredExtractionContext {
  return {
    documentId: 'fixture-paper',
    sourceSha256,
    split: 'held-out',
    layout: 'two-column',
    sourceRuns: [
      { id: 'title-run', text: 'A source-backed title', page: 1, order: 1 },
      { id: 'caption-run', text: 'Figure 1. A caption', page: 1, order: 2 },
      { id: 'figure-run', text: 'Figure 1', page: 1, order: 3 },
      { id: 'body-run', text: 'A continuous paragraph.', page: 1, order: 4 },
      { id: 'table-head', text: 'Measure', page: 2, order: 5 },
      { id: 'table-value', text: '42', page: 2, order: 6 },
      { id: 'running-head', text: 'Journal title', page: 1, order: 7 },
    ],
    sourceAssets: [
      {
        id: 'figure-asset',
        kind: 'figure',
        page: 1,
        bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        bytesSha256: assetSha256,
        sourceObjectIds: ['native-figure'],
        captionRunIds: ['caption-run'],
      },
    ],
    provenArtifacts: [
      { id: 'lane-1', kind: 'region-lane', sourceRunIds: ['body-run'] },
    ],
    boilerplateRunIds: ['running-head'],
  }
}

function validProposal(): StructuredExtractionProposal {
  return {
    schemaVersion: '1.0.0',
    nodes: [
      {
        id: 'title',
        type: 'title',
        sourceRunIds: ['title-run'],
        text: 'A source-backed title',
      },
      {
        id: 'caption',
        type: 'paragraph',
        sourceRunIds: ['caption-run'],
        text: 'Figure 1. A caption',
      },
      {
        id: 'figure',
        type: 'figure',
        sourceRunIds: ['figure-run'],
        assetId: 'figure-asset',
        captionNodeId: 'caption',
        altText: 'Figure 1. A caption',
        altTextSource: 'caption',
      },
      {
        id: 'body',
        type: 'paragraph',
        sourceRunIds: ['body-run'],
        text: 'A continuous paragraph.',
      },
    ],
    assetIds: ['figure-asset'],
    excludedBoilerplateRunIds: ['running-head'],
  }
}

describe('source-backed structured extraction verifier', () => {
  it('materializes text and alt text from source runs rather than proposal text', () => {
    const proposal = validProposal()
    proposal.nodes[0]!.text = 'A source-backed title'
    const result = verifyStructuredExtraction(context(), proposal)

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(result.output.nodes[0]!.text).toBe('A source-backed title')
      expect(result.output.nodes[2]!.altText).toBe('Figure 1. A caption')
      expect(result.output.nodes[2]!.altTextSource).toBe('caption')
      expect(result.output.nodes[2]!).not.toHaveProperty('bytes')
      expect(result.output.nodes[2]!).not.toHaveProperty('bounds')
    }
  })

  it('fails closed for an unverified or model-authored span', () => {
    const proposal = validProposal()
    proposal.nodes[3]!.text = 'Invented paragraph.'
    const result = verifyStructuredExtraction(context(), proposal)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'source-text-mismatch',
      )
      expect(result.output).toBeNull()
    }
  })

  it('rejects an empty candidate instead of treating it as a publishable output', () => {
    const result = verifyStructuredExtraction(context(), {
      schemaVersion: '1.0.0',
      nodes: [],
    })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('invalid-output')
    }
  })

  it('rejects model-authored alt text even when an asset is otherwise valid', () => {
    const proposal = validProposal()
    proposal.nodes[2]!.altText = 'A detailed description invented from pixels'
    const result = verifyStructuredExtraction(context(), proposal)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'model-authored-alt-text',
      )
    }
  })

  it('requires boilerplate to be explicitly accounted for and excludes it from body flow', () => {
    const proposal = validProposal()
    proposal.excludedBoilerplateRunIds = []
    const result = verifyStructuredExtraction(context(), proposal)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'boilerplate-not-accounted',
      )
    }
  })

  it('keeps table cell provenance source-backed', () => {
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'table',
      type: 'table',
      sourceRunIds: ['table-head', 'table-value'],
      table: {
        rows: [
          { cells: [{ sourceRunIds: ['table-head'], headerScope: 'column' }] },
          { cells: [{ sourceRunIds: ['table-value'], headerScope: 'none' }] },
        ],
      },
    })
    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(
        result.output.nodes.at(-1)?.table?.rows[0]?.cells[0],
      ).toMatchObject({
        text: 'Measure',
        sourceRunIds: ['table-head'],
        headerScope: 'column',
      })
    }
  })

  it('rejects table cells that reuse a source run from another table', () => {
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'table-one',
        type: 'table',
        sourceRunIds: ['table-head'],
        table: {
          rows: [{ cells: [{ sourceRunIds: ['table-head'] }] }],
        },
      },
      {
        id: 'table-two',
        type: 'table',
        sourceRunIds: ['table-head'],
        table: {
          rows: [{ cells: [{ sourceRunIds: ['table-head'] }] }],
        },
      },
    )

    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'duplicate-source-run',
            sourceRunId: 'table-head',
          }),
        ]),
      )
    }
  })

  it('rejects boilerplate hidden inside table cells', () => {
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'table',
      type: 'table',
      sourceRunIds: ['table-head'],
      table: {
        rows: [{ cells: [{ sourceRunIds: ['running-head'] }] }],
      },
    })

    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'boilerplate-in-body',
      )
    }
  })

  it('unions explicit and node-referenced deterministic assets', () => {
    const candidate = validProposal()
    candidate.assetIds = []
    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(result.output.assetIds).toEqual(['figure-asset'])
    }
  })

  it('shares page evidence without leaking deterministic labels to the authored arm', () => {
    const inputContext = context()
    inputContext.pageRenditions = [
      {
        page: 1,
        mediaType: 'image/png',
        width: 1200,
        height: 1600,
        bytesSha256: '3'.repeat(64),
        reference: 'owner-local-page-1',
      },
    ]
    const input = modelInputForStructuredExtraction(
      inputContext,
      'llm-grounded',
    )
    expect(input.provenArtifacts).toHaveLength(1)
    expect(input).not.toHaveProperty('groundTruth')
    expect(input.pageRenditions).toEqual(inputContext.pageRenditions)
    const authored = modelInputForStructuredExtraction(
      inputContext,
      'llm-authored',
    )
    expect(authored.pageRenditions).toEqual(inputContext.pageRenditions)
    expect(authored).not.toHaveProperty('boilerplateRunIds')
    expect(input).toHaveProperty('boilerplateRunIds', ['running-head'])
  })

  it('stays byte-stable for repeated verified output', () => {
    const first = verifyStructuredExtraction(context(), validProposal())
    const second = verifyStructuredExtraction(
      context(),
      structuredClone(validProposal()),
    )
    expect(first).toEqual(second)
  })

  it('preserves the preformatted structure of a source-backed code listing', () => {
    // Prose normalization collapses every run of whitespace to one space. A
    // code listing that survives that has lost the indentation and line breaks
    // that make it a listing, so the verified document no longer preserves the
    // source.
    const listing = 'function main() {\n  return 42\n}'
    const base = context()
    base.sourceRuns.push({ id: 'code-run', text: listing, page: 2, order: 8 })
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'listing',
      type: 'code',
      sourceRunIds: ['code-run'],
      text: listing,
    })

    const result = verifyStructuredExtraction(base, candidate)

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      const code = result.output.nodes.find(({ id }) => id === 'listing')!
      expect(code.text).toBe(listing)
    }
  })

  it('does not invent line breaks between code fragments on the same source line', () => {
    const base = context()
    base.sourceRuns.push(
      {
        id: 'code-fragment-a',
        text: '  const value = ',
        page: 2,
        order: 8,
        lineId: 'code-line-1',
      } as never,
      {
        id: 'code-fragment-b',
        text: '42',
        page: 2,
        order: 9,
        lineId: 'code-line-1',
      } as never,
    )
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'fragmented-listing',
      type: 'code',
      sourceRunIds: ['code-fragment-a', 'code-fragment-b'],
      text: '  const value = 42',
    })

    const result = verifyStructuredExtraction(base, candidate)

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(result.output.nodes.at(-1)?.text).toBe('  const value = 42')
    }
  })

  it('rejects a table node that carries no semantic cells', () => {
    // `verifyNodeTable` returns early when `table` is absent, so a candidate
    // can label a source span a table, score as one, and publish a table with
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'table',
      type: 'table',
      sourceRunIds: ['table-head', 'table-value'],
    })

    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('invalid-table')
      expect(result.output).toBeNull()
    }
  })

  it('rejects a figure that references no deterministic asset', () => {
    // `verifyAsset` returns immediately without an `assetId`, so every
    // figure-specific check — bounded asset, caption, caption-derived alt text
    // — is skipped for a figure that simply omits one.
    const candidate = validProposal()
    delete candidate.nodes[2]!.assetId
    delete candidate.nodes[2]!.captionNodeId
    delete candidate.nodes[2]!.altText
    delete candidate.nodes[2]!.altTextSource
    candidate.assetIds = []

    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('unknown-asset')
      expect(result.output).toBeNull()
    }
  })

  it('rejects model-authored alt text on a node that is not a figure', () => {
    // The alt-text checks are figure-only, but the verified node is built with
    // an unconditional `altText` copy, so a paragraph can carry invented text
    // into the supposedly source-backed document.
    const candidate = validProposal()
    candidate.nodes[3]!.altText = 'invented'
    candidate.nodes[3]!.altTextSource = 'model'

    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'model-authored-alt-text',
      )
      expect(result.output).toBeNull()
    }
  })

  it('rejects nodes emitted out of source order relative to one another', () => {
    // Each node's own run IDs stay sorted, so the per-node order check passes
    // while the document reads back to front.
    const candidate = validProposal()
    const [title, caption, figure, body] = candidate.nodes
    candidate.nodes = [body!, title!, caption!, figure!]

    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('unverified-span')
      expect(result.output).toBeNull()
    }
  })

  it('includes table-cell provenance when enforcing order across nodes', () => {
    const input = context()
    input.sourceRuns.find(({ id }) => id === 'table-value')!.order = 9
    input.sourceRuns.push({
      id: 'after-table',
      text: 'After the table.',
      page: 2,
      order: 8,
    })
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'late-table',
        type: 'table',
        sourceRunIds: ['table-head'],
        table: {
          rows: [
            {
              cells: [{ sourceRunIds: ['table-value'], headerScope: 'none' }],
            },
          ],
        },
      },
      {
        id: 'after-table',
        type: 'paragraph',
        sourceRunIds: ['after-table'],
      },
    )

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('unverified-span')
    }
  })

  it('preserves note and citation targets with reciprocal backlinks', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'note-marker', text: '1', page: 2, order: 8 },
      { id: 'note-body', text: 'A note.', page: 2, order: 9 },
      { id: 'citation-marker', text: '[1]', page: 2, order: 10 },
      { id: 'reference', text: 'A reference.', page: 2, order: 11 },
    )
    input.provenArtifacts!.push(
      {
        id: 'note-link',
        kind: 'note-relationship',
        sourceRunIds: ['note-marker'],
        targetSourceRunIds: ['note-body'],
      },
      {
        id: 'citation-link',
        kind: 'citation-relationship',
        sourceRunIds: ['citation-marker'],
        targetSourceRunIds: ['reference'],
      },
    )
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'note-marker',
        type: 'paragraph',
        sourceRunIds: ['note-marker'],
        relationships: { noteTargetNodeIds: ['note-body'] },
      },
      {
        id: 'note-body',
        type: 'footnote',
        sourceRunIds: ['note-body'],
        relationships: { backlinks: ['note-marker'] },
      },
      {
        id: 'citation-marker',
        type: 'paragraph',
        sourceRunIds: ['citation-marker'],
        relationships: { citationTargetNodeIds: ['reference'] },
      },
      {
        id: 'reference',
        type: 'reference',
        sourceRunIds: ['reference'],
        relationships: { backlinks: ['citation-marker'] },
      },
    )

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(result.output.nodes.at(-1)?.relationships?.backlinks).toEqual([
        'citation-marker',
      ])
    }
  })

  it('rejects a reciprocal note link to the wrong proven source target', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'note-marker', text: '1', page: 2, order: 8 },
      { id: 'right-note', text: 'Right note.', page: 2, order: 9 },
      { id: 'wrong-note', text: 'Wrong note.', page: 2, order: 10 },
    )
    input.provenArtifacts!.push({
      id: 'note-link-1',
      kind: 'note-relationship',
      sourceRunIds: ['note-marker'],
      targetSourceRunIds: ['right-note'],
    } as never)
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'note-marker',
        type: 'paragraph',
        sourceRunIds: ['note-marker'],
        relationships: { noteTargetNodeIds: ['wrong-note'] },
      },
      {
        id: 'right-note',
        type: 'footnote',
        sourceRunIds: ['right-note'],
      },
      {
        id: 'wrong-note',
        type: 'footnote',
        sourceRunIds: ['wrong-note'],
        relationships: { backlinks: ['note-marker'] },
      },
    )

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'invalid-relationship',
      )
    }
  })

  it('rejects a relationship without a reciprocal backlink', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'note-marker', text: '1', page: 2, order: 8 },
      { id: 'note-body', text: 'A note.', page: 2, order: 9 },
    )
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'note-marker',
        type: 'paragraph',
        sourceRunIds: ['note-marker'],
        relationships: { noteTargetNodeIds: ['note-body'] },
      },
      {
        id: 'note-body',
        type: 'footnote',
        sourceRunIds: ['note-body'],
      },
    )

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'invalid-relationship',
      )
    }
  })
})
