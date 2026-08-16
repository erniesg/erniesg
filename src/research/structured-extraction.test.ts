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
    const input = context()
    input.provenArtifacts!.push({
      id: 'table-scope',
      kind: 'table-scope',
      sourceRunIds: ['table-head', 'table-value'],
    })
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
    const result = verifyStructuredExtraction(input, candidate)

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

  it('does not freeze or alias caller-owned relationship provenance', () => {
    const inputContext = context()
    const targetSourceRunIds = ['body-run']
    const targetSourceRunIdGroup = ['body-run']
    inputContext.provenArtifacts!.push({
      id: 'note-link',
      kind: 'note-relationship',
      sourceRunIds: ['title-run'],
      targetSourceRunIds,
      targetSourceRunIdGroups: [targetSourceRunIdGroup],
    })

    const input = modelInputForStructuredExtraction(
      inputContext,
      'llm-grounded',
    )

    expect(input.provenArtifacts?.at(-1)?.targetSourceRunIds).toEqual([
      'body-run',
    ])
    expect(input.provenArtifacts?.at(-1)?.targetSourceRunIds).not.toBe(
      targetSourceRunIds,
    )
    expect(
      input.provenArtifacts?.at(-1)?.targetSourceRunIdGroups?.[0],
    ).not.toBe(targetSourceRunIdGroup)
    expect(Object.isFrozen(targetSourceRunIds)).toBe(false)
    expect(Object.isFrozen(targetSourceRunIdGroup)).toBe(false)
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
      },
      {
        id: 'code-fragment-b',
        text: '42',
        page: 2,
        order: 9,
        lineId: 'code-line-1',
      },
    )
    base.sourceLines = [
      {
        id: 'code-line-1',
        text: '  const value = 42',
        sourceRunIds: ['code-fragment-a', 'code-fragment-b'],
      },
    ]
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

  it('uses canonical line spacing between code fragments', () => {
    const base = context()
    base.sourceRuns.push(
      {
        id: 'spaced-code-a',
        text: 'const',
        page: 2,
        order: 8,
        lineId: 'spaced-code-line',
      },
      {
        id: 'spaced-code-b',
        text: 'value = 42',
        page: 2,
        order: 9,
        lineId: 'spaced-code-line',
      },
    )
    base.sourceLines = [
      {
        id: 'spaced-code-line',
        text: 'const value = 42',
        sourceRunIds: ['spaced-code-a', 'spaced-code-b'],
      },
    ]
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'spaced-listing',
      type: 'code',
      sourceRunIds: ['spaced-code-a', 'spaced-code-b'],
    })

    const result = verifyStructuredExtraction(base, candidate)

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(result.output.nodes.at(-1)?.text).toBe('const value = 42')
    }
  })

  it('rejects ambiguous multi-run code without deterministic line ownership', () => {
    const base = context()
    base.sourceRuns.push(
      {
        id: 'legacy-code-line-a',
        text: 'const value = 42',
        page: 2,
        order: 8,
      },
      {
        id: 'legacy-code-line-b',
        text: 'return value',
        page: 2,
        order: 9,
      },
    )
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'legacy-listing',
      type: 'code',
      sourceRunIds: ['legacy-code-line-a', 'legacy-code-line-b'],
    })

    const result = verifyStructuredExtraction(base, candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('unverified-span')
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

  it('rejects source runs reversed inside a table cell', () => {
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'reversed-table',
      type: 'table',
      sourceRunIds: ['table-head'],
      table: {
        rows: [
          {
            cells: [
              {
                sourceRunIds: ['table-value', 'table-head'],
                headerScope: 'none',
              },
            ],
          },
        ],
      },
    })

    const result = verifyStructuredExtraction(context(), candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('unverified-span')
    }
  })

  it('rejects a semantic table whose cells omit deterministic scope provenance', () => {
    const input = context()
    input.provenArtifacts!.push({
      id: 'incomplete-table-scope',
      kind: 'table-scope',
      sourceRunIds: ['table-head', 'table-value'],
    })
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'incomplete-table',
      type: 'table',
      sourceRunIds: ['table-head', 'table-value'],
      table: {
        rows: [
          {
            cells: [{ sourceRunIds: ['table-head'], headerScope: 'column' }],
          },
        ],
      },
    })

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('invalid-table')
    }
  })

  it('rejects a semantic table with ambiguous deterministic scope ownership', () => {
    const input = context()
    input.provenArtifacts!.push(
      {
        id: 'ambiguous-table-scope-a',
        kind: 'table-scope',
        sourceRunIds: ['table-head', 'table-value'],
      },
      {
        id: 'ambiguous-table-scope-b',
        kind: 'table-scope',
        sourceRunIds: ['table-head', 'table-value'],
      },
    )
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'ambiguous-table',
      type: 'table',
      sourceRunIds: ['table-head', 'table-value'],
      table: {
        rows: [
          { cells: [{ sourceRunIds: ['table-head'] }] },
          { cells: [{ sourceRunIds: ['table-value'] }] },
        ],
      },
    })

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain('invalid-table')
    }
  })

  it('rejects table cells emitted out of flattened source order', () => {
    const input = context()
    input.provenArtifacts!.push({
      id: 'reversed-table-scope',
      kind: 'table-scope',
      sourceRunIds: ['table-head', 'table-value'],
    })
    const candidate = validProposal()
    candidate.nodes.push({
      id: 'reversed-rows',
      type: 'table',
      sourceRunIds: ['table-head', 'table-value'],
      table: {
        rows: [
          {
            cells: [{ sourceRunIds: ['table-value'], headerScope: 'none' }],
          },
          {
            cells: [{ sourceRunIds: ['table-head'], headerScope: 'column' }],
          },
        ],
      },
    })

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

  it('rejects a proven note target contaminated with unrelated source runs', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'note-marker', text: '1', page: 2, order: 8 },
      { id: 'right-note', text: 'Right note.', page: 2, order: 9 },
      { id: 'wrong-note', text: 'Unrelated wrong note.', page: 2, order: 10 },
    )
    input.provenArtifacts!.push({
      id: 'note-link-1',
      kind: 'note-relationship',
      sourceRunIds: ['note-marker'],
      targetSourceRunIds: ['right-note'],
    })
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'note-marker',
        type: 'paragraph',
        sourceRunIds: ['note-marker'],
        relationships: { noteTargetNodeIds: ['merged-note'] },
      },
      {
        id: 'merged-note',
        type: 'footnote',
        sourceRunIds: ['right-note', 'wrong-note'],
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

  it('rejects a proven note target missing part of its exact provenance', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'partial-marker', text: '1', page: 2, order: 8 },
      { id: 'note-part-a', text: 'First half.', page: 2, order: 9 },
      { id: 'note-part-b', text: 'Second half.', page: 2, order: 10 },
    )
    input.provenArtifacts!.push({
      id: 'partial-note-link',
      kind: 'note-relationship',
      sourceRunIds: ['partial-marker'],
      targetSourceRunIdGroups: [['note-part-a', 'note-part-b']],
    })
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'partial-marker',
        type: 'paragraph',
        sourceRunIds: ['partial-marker'],
        relationships: { noteTargetNodeIds: ['partial-note'] },
      },
      {
        id: 'partial-note',
        type: 'footnote',
        sourceRunIds: ['note-part-a'],
        relationships: { backlinks: ['partial-marker'] },
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

  it('matches each citation target against its own provenance group', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'grouped-marker', text: '[1, 2]', page: 2, order: 8 },
      { id: 'grouped-reference-a', text: 'Reference A.', page: 2, order: 9 },
      { id: 'grouped-reference-b', text: 'Reference B.', page: 2, order: 10 },
    )
    input.provenArtifacts!.push({
      id: 'grouped-citation-link',
      kind: 'citation-relationship',
      sourceRunIds: ['grouped-marker'],
      targetSourceRunIdGroups: [
        ['grouped-reference-a'],
        ['grouped-reference-b'],
      ],
    })
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'grouped-marker',
        type: 'paragraph',
        sourceRunIds: ['grouped-marker'],
        relationships: {
          citationTargetNodeIds: ['grouped-reference-a', 'grouped-reference-b'],
        },
      },
      {
        id: 'grouped-reference-a',
        type: 'reference',
        sourceRunIds: ['grouped-reference-a'],
        relationships: { backlinks: ['grouped-marker'] },
      },
      {
        id: 'grouped-reference-b',
        type: 'reference',
        sourceRunIds: ['grouped-reference-b'],
        relationships: { backlinks: ['grouped-marker'] },
      },
    )

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('passed')
  })

  it('rejects omitted relationships for deterministic note provenance', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'omitted-marker', text: '1', page: 2, order: 8 },
      { id: 'omitted-note', text: 'A note.', page: 2, order: 9 },
    )
    input.provenArtifacts!.push({
      id: 'omitted-note-link',
      kind: 'note-relationship',
      sourceRunIds: ['omitted-marker'],
      targetSourceRunIdGroups: [['omitted-note']],
    })
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'omitted-marker',
        type: 'paragraph',
        sourceRunIds: ['omitted-marker'],
      },
      {
        id: 'omitted-note',
        type: 'footnote',
        sourceRunIds: ['omitted-note'],
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

  it('requires every deterministic citation target group in the proposal', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'partial-citation-marker', text: '[1, 2]', page: 2, order: 8 },
      { id: 'partial-reference-a', text: 'Reference A.', page: 2, order: 9 },
      { id: 'partial-reference-b', text: 'Reference B.', page: 2, order: 10 },
    )
    input.provenArtifacts!.push({
      id: 'partial-citation-link',
      kind: 'citation-relationship',
      sourceRunIds: ['partial-citation-marker'],
      targetSourceRunIdGroups: [
        ['partial-reference-a'],
        ['partial-reference-b'],
      ],
    })
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'partial-citation-marker',
        type: 'paragraph',
        sourceRunIds: ['partial-citation-marker'],
        relationships: {
          citationTargetNodeIds: ['partial-reference-a'],
        },
      },
      {
        id: 'partial-reference-a',
        type: 'reference',
        sourceRunIds: ['partial-reference-a'],
        relationships: { backlinks: ['partial-citation-marker'] },
      },
      {
        id: 'partial-reference-b',
        type: 'reference',
        sourceRunIds: ['partial-reference-b'],
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

  it('rejects relationship provenance hidden in cells on a non-table target', () => {
    const input = context()
    input.sourceRuns.push(
      { id: 'smuggled-marker', text: '1', page: 2, order: 8 },
      { id: 'smuggled-note-a', text: 'First half.', page: 2, order: 9 },
      { id: 'smuggled-note-b', text: 'Second half.', page: 2, order: 10 },
    )
    input.provenArtifacts!.push({
      id: 'smuggled-note-link',
      kind: 'note-relationship',
      sourceRunIds: ['smuggled-marker'],
      targetSourceRunIdGroups: [['smuggled-note-a', 'smuggled-note-b']],
    })
    const candidate = validProposal()
    candidate.nodes.push(
      {
        id: 'smuggled-marker',
        type: 'paragraph',
        sourceRunIds: ['smuggled-marker'],
        relationships: { noteTargetNodeIds: ['smuggled-note'] },
      },
      {
        id: 'smuggled-note',
        type: 'footnote',
        sourceRunIds: ['smuggled-note-a'],
        relationships: { backlinks: ['smuggled-marker'] },
        table: {
          rows: [{ cells: [{ sourceRunIds: ['smuggled-note-b'] }] }],
        },
      },
    )

    const result = verifyStructuredExtraction(input, candidate)

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toEqual(
        expect.arrayContaining(['invalid-table', 'invalid-relationship']),
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
