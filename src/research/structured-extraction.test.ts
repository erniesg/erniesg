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

  it('only exposes proved artifacts to the grounded arm and stays byte-stable', () => {
    const input = modelInputForStructuredExtraction(context(), 'llm-grounded')
    expect(input.provenArtifacts).toHaveLength(1)
    expect(input).not.toHaveProperty('groundTruth')
    const first = verifyStructuredExtraction(context(), validProposal())
    const second = verifyStructuredExtraction(
      context(),
      structuredClone(validProposal()),
    )
    expect(first).toEqual(second)
  })
})
