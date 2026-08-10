import { describe, expect, it } from 'vitest'
import { canonicalContentHash } from '../research/canonical-hash'
import { papers } from '../research/papers'
import { researchPaperSchema } from '../research/schema'
import {
  publicationGraphToResearchPaper,
  researchPaperSourceAdapter,
  researchPaperToPublicationGraph,
  ResearchPaperAdapterError,
  RESEARCH_PAPER_ADAPTER_VERSION,
  UNSUPPORTED_RESEARCH_PAPER_FEATURES,
} from './research-paper-adapter'
import {
  canonicalPublicationJson,
  findForbiddenCanonicalKeys,
  parsePublicationGraph,
  serializePublicationGraph,
} from './schema'

describe('research paper compatibility adapter', () => {
  it('round trips every golden paper without loss', () => {
    for (const paper of papers) {
      const { graph } = researchPaperToPublicationGraph(paper)
      const restored = publicationGraphToResearchPaper(graph)

      expect(restored).toEqual(paper)
      expect(canonicalPublicationJson(restored)).toBe(canonicalPublicationJson(paper))
      expect(canonicalContentHash(restored)).toBe(canonicalContentHash(paper))
      expect(researchPaperSchema.parse(restored)).toEqual(paper)
    }
  })

  it('preserves canonical ids, text, relationships, and asset references', () => {
    const paper = papers[1]
    const { graph } = researchPaperToPublicationGraph(paper)

    expect(graph.nodes.map((node) => node.id)).toEqual(
      paper.nodes.map((node) => node.id),
    )
    const figure = paper.nodes.find((node) => node.type === 'figure')
    const graphFigure = graph.nodes.find((node) => node.type === 'figure')
    expect(figure && graphFigure).toBeTruthy()
    if (figure?.type !== 'figure' || graphFigure?.type !== 'figure') {
      throw new Error('The golden paper must contain a figure node')
    }
    expect(graphFigure.title).toBe(figure.title)
    expect(graphFigure.relationships).toEqual([
      { role: 'caption', targetId: figure.relationships.caption },
    ])
    expect(graphFigure.assetRefs).toEqual([])
    expect(graphFigure.provenance.source).toBe(figure.source)

    const sourceQuote = paper.nodes.find((node) => node.type === 'quote')
    const graphQuote = graph.nodes.find((node) => node.type === 'quote')
    if (sourceQuote?.type !== 'quote' || graphQuote?.type !== 'quote') {
      throw new Error('The golden paper must contain a quote node')
    }
    expect(graphQuote.text).toBe(sourceQuote.text)
  })

  it('records the medium-independent facts the graph requires of every node', () => {
    const paper = papers[0]
    const { graph } = researchPaperToPublicationGraph(paper)

    expect(graph.editions).toEqual([
      {
        id: `${paper.id}.${paper.version}`,
        kind: 'primary',
        locale: 'en',
        direction: 'ltr',
        label: paper.title,
      },
    ])
    for (const node of graph.nodes) {
      expect(node.locale).toBe(paper.language)
      expect(node.direction).toBe(paper.baseDirection)
      expect(node.requirement).toBe('required')
      expect(node.edition.editionId).toBe(`${paper.id}.${paper.version}`)
      expect(node.accessibility).toEqual({ alternatives: [] })
      expect(node.authoredVariants).toEqual({})
      expect(node.reviewedVariants).toEqual([])
    }
    expect(graph.nodes.find((node) => node.type === 'quote')?.importance).toBe(
      'primary',
    )
    expect(findForbiddenCanonicalKeys(graph.nodes)).toEqual([])
  })

  it('maps list, note, and object nodes through their own graph types', () => {
    const paper = researchPaperSchema.parse({
      ...papers[1],
      id: 'adapter-coverage',
      nodes: [
        {
          id: 'li-1',
          type: 'paragraph',
          text: 'First item',
          source: 'Fixture',
          list: { level: 1, ordered: true, numberingId: 'num-1', ordinal: 1 },
        },
        {
          id: 'p-1',
          type: 'paragraph',
          text: 'Body text with a note.',
          source: 'Fixture',
          noteReferences: [
            {
              id: 'ref-1',
              label: '1',
              target: 'fn-1',
              start: 0,
              end: 4,
              confidence: 1,
            },
          ],
        },
        {
          id: 'fn-1',
          type: 'footnote',
          kind: 'footnote',
          label: '1',
          text: 'The note body.',
          source: 'Fixture',
          relationships: { backlinks: ['ref-1'] },
        },
        {
          id: 'tab-1',
          type: 'figure',
          title: 'Results',
          objectType: 'table',
          source: 'Fixture',
          table: {
            rows: [
              {
                cells: [
                  { text: 'Target', headerScope: 'column', columnSpan: 1, rowSpan: 1 },
                ],
              },
              {
                cells: [
                  { text: 'A4', headerScope: null, columnSpan: 1, rowSpan: 1 },
                ],
              },
            ],
          },
          relationships: { caption: 'cap-1', assets: ['asset-1'] },
        },
        { id: 'cap-1', type: 'caption', text: 'Table caption.', source: 'Fixture' },
        {
          id: 'eq-1',
          type: 'figure',
          title: 'Mass energy equivalence',
          objectType: 'equation',
          source: 'Fixture',
          relationships: { caption: 'cap-2' },
        },
        { id: 'cap-2', type: 'caption', text: 'Equation caption.', source: 'Fixture' },
      ],
    })

    const { graph } = researchPaperToPublicationGraph(paper)
    expect(graph.nodes.map((node) => node.type)).toEqual([
      'list',
      'paragraph',
      'note',
      'table',
      'caption',
      'equation',
      'caption',
    ])
    const table = graph.nodes[3]
    expect(table.type === 'table' && table.table?.rows).toHaveLength(2)
    expect(table.assetRefs).toEqual([{ role: 'primary', assetId: 'asset-1' }])
    expect(publicationGraphToResearchPaper(graph)).toEqual(paper)
  })

  it('refuses to invent a ResearchPaper for nodes it does not support', () => {
    const { graph } = researchPaperToPublicationGraph(papers[1])
    const withCode = parsePublicationGraph({
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          ...graph.nodes[1],
          id: 'code-1',
          type: 'code',
          text: 'const a = 1',
          language: 'ts',
        },
      ],
    })

    expect(() => publicationGraphToResearchPaper(withCode)).toThrow(
      ResearchPaperAdapterError,
    )
    expect(UNSUPPORTED_RESEARCH_PAPER_FEATURES).toContain(
      'figure.table.rows[].cells[].sourceRuns',
    )
  })

  it('diagnoses source geometry instead of smuggling it into canonical content', () => {
    const paper = researchPaperSchema.parse({
      ...papers[1],
      id: 'adapter-geometry',
      nodes: [
        {
          id: 'tab-1',
          type: 'figure',
          title: 'Results',
          objectType: 'table',
          source: 'Fixture',
          table: {
            rows: [
              {
                cells: [
                  {
                    text: 'Target',
                    headerScope: 'column',
                    columnSpan: 1,
                    rowSpan: 1,
                    sourceRuns: [
                      {
                        regionId: 'r-1',
                        lineId: 'l-1',
                        runIndex: 0,
                        text: 'Target',
                        box: {
                          page: 1,
                          x: 1,
                          y: 2,
                          width: 3,
                          height: 4,
                          rotation: 0,
                          method: 'pdf-text',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          relationships: { caption: 'cap-1' },
        },
        { id: 'cap-1', type: 'caption', text: 'Table caption.', source: 'Fixture' },
      ],
    })

    const { graph, diagnostics } = researchPaperToPublicationGraph(paper)
    expect(diagnostics).toContainEqual({
      code: 'dropped-source-geometry',
      severity: 'warning',
      message:
        'Table cell sourceRuns carry page coordinates and cannot enter canonical content.',
      nodeId: 'tab-1',
    })
    expect(findForbiddenCanonicalKeys(graph.nodes)).toEqual([])
    expect(serializePublicationGraph(graph)).not.toContain('sourceRuns')
  })

  it('binds a deterministic receipt to the adapter and schema versions', () => {
    const first = researchPaperSourceAdapter.read({ paper: papers[1] })
    const second = researchPaperSourceAdapter.read({ paper: papers[1] })

    expect(RESEARCH_PAPER_ADAPTER_VERSION).toBe('1.0.0')
    expect(first.provenance).toEqual(second.provenance)
    expect(first.provenance.adapterVersion).toBe(RESEARCH_PAPER_ADAPTER_VERSION)
    expect(first.provenance.capturedAt).toBe(papers[1].artifactModifiedAt)
    expect(serializePublicationGraph(first.graph)).toBe(
      serializePublicationGraph(second.graph),
    )
  })
})
