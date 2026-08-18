import { describe, expect, it } from 'vitest'
import { buildExactThreeProfileStructEpubs } from './reconstruction-materialization'
import { createSourceEvidenceContract } from './source-evidence-contract'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  type PdfEvidenceBundle,
  type SourceEvidenceGraphInput,
} from './source-evidence-graph'
import {
  materializeGroundedStruct,
  type GroundedStructCandidateSelection,
} from './grounded-struct-materializer'
import type {
  StructuredExtractionContext,
  StructuredExtractionProposal,
} from './structured-extraction'

const source = {
  documentId: 'public-table-pilot',
  sha256: '1'.repeat(64),
  byteLength: 4_096,
  pageCount: 1,
}
const verifierIdentity = {
  id: 'source-evidence-verifier',
  version: '1.0.0',
  configurationSha256: '3'.repeat(64),
  executableSha256: '4'.repeat(64),
}
const titleBox = {
  page: 1,
  x: 0.1,
  y: 0.1,
  width: 0.7,
  height: 0.05,
  rotation: 0,
  method: 'pdf-text' as const,
}
const tableBox = {
  page: 1,
  x: 0.1,
  y: 0.2,
  width: 0.7,
  height: 0.2,
  rotation: 0,
  method: 'pdf-text' as const,
}

function graphInput(tableColumnSpan = 2): SourceEvidenceGraphInput {
  const semanticTable = {
    rows: [
      {
        cells: [
          {
            text: 'Header',
            rowSpan: 1,
            columnSpan: tableColumnSpan,
            headerScope: 'column',
          },
        ],
      },
      {
        cells: [
          {
            text: 'Body',
            rowSpan: 1,
            columnSpan: 1,
            headerScope: 'none',
          },
        ],
      },
    ],
  }
  const bundles: PdfEvidenceBundle[] = [
    {
      schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      id: 'pdfjs-bundle',
      armId: 'deterministic',
      source,
      provider: {
        id: 'pdfjs-provider',
        kind: 'pdfjs',
        name: 'pdfjs-dist',
        version: '5.4.624',
      },
      pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
      artifacts: [
        {
          id: 'page-render',
          providerId: 'pdfjs-provider',
          kind: 'full-page-render',
          mediaType: 'image/png',
          sha256: '2'.repeat(64),
          byteLength: 128,
          page: 1,
          box: { ...titleBox, x: 0, y: 0, width: 1, height: 1 },
          sourceIds: ['title-source'],
        },
      ],
      sources: [
        {
          id: 'title-source',
          providerId: 'pdfjs-provider',
          kind: 'text-run',
          page: 1,
          box: titleBox,
          payload: { text: 'Table Pilot' },
        },
        {
          id: 'table-source',
          providerId: 'pdfjs-provider',
          kind: 'table-relationship',
          page: 1,
          box: tableBox,
          payload: { sourceText: 'Header Body', semanticTable },
        },
        {
          id: 'page-geometry-source',
          providerId: 'pdfjs-provider',
          kind: 'page-geometry',
          page: 1,
          payload: { width: 612, height: 792, rotation: 0 },
        },
        {
          id: 'font-source',
          providerId: 'pdfjs-provider',
          kind: 'font',
          page: 1,
          payload: { family: 'Fixture Serif' },
        },
      ],
      candidates: [
        {
          id: 'title-candidate',
          providerId: 'pdfjs-provider',
          kind: 'text-run',
          page: 1,
          boxes: [titleBox],
          sourceIds: ['title-source'],
          payload: { text: 'Table Pilot' },
        },
        {
          id: 'table-candidate',
          providerId: 'pdfjs-provider',
          kind: 'table-relationship',
          page: 1,
          boxes: [tableBox],
          sourceIds: ['table-source'],
          payload: { sourceText: 'Header Body', semanticTable },
        },
      ],
    },
    {
      schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      id: 'mineru-bundle',
      armId: 'mineru',
      source,
      provider: {
        id: 'mineru-provider',
        kind: 'mineru',
        name: 'MinerU',
        version: '3.4.4',
      },
      pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
      artifacts: [
        {
          id: 'mineru-artifact',
          providerId: 'mineru-provider',
          kind: 'content-list-v2',
          mediaType: 'application/json',
          sha256: '5'.repeat(64),
          byteLength: 64,
          page: 1,
          box: titleBox,
          sourceIds: ['mineru-source'],
        },
      ],
      sources: [
        {
          id: 'mineru-source',
          providerId: 'mineru-provider',
          kind: 'title',
          page: 1,
          box: titleBox,
          artifactIds: ['mineru-artifact'],
          payload: { text: 'Different title' },
        },
      ],
      candidates: [
        {
          id: 'wrong-title-candidate',
          providerId: 'mineru-provider',
          kind: 'title',
          page: 1,
          boxes: [titleBox],
          sourceIds: ['mineru-source'],
          artifactIds: ['mineru-artifact'],
          payload: { text: 'Different title', grounded: true },
        },
      ],
    },
  ]
  return {
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source,
    deterministicContext: deterministicContextReceiptForBundle(bundles[0]!),
    arms: [
      {
        id: 'deterministic',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: 'pdfjs-provider',
      },
      {
        id: 'mineru',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: 'mineru-provider',
      },
    ],
    bundles,
    obligations: [
      {
        id: 'title-obligation',
        kind: 'text',
        page: 1,
        sourceIds: ['title-source', 'mineru-source'],
        artifactIds: ['page-render', 'mineru-artifact'],
        candidateIds: ['title-candidate', 'wrong-title-candidate'],
        observationCategories: [
          'text-exactness',
          'reading-order',
          'hierarchy',
          'clipping',
          'overflow',
        ],
        required: true,
        semantic: true,
      },
      {
        id: 'table-obligation',
        kind: 'table-relationship',
        page: 1,
        sourceIds: ['table-source'],
        artifactIds: [],
        candidateIds: ['table-candidate'],
        observationCategories: [
          'object-counts',
          'table-cells',
          'table-spans',
          'table-headers',
          'clipping',
          'overflow',
        ],
        required: true,
        semantic: true,
      },
      {
        id: 'page-geometry-context',
        kind: 'page-geometry',
        page: 1,
        sourceIds: ['page-geometry-source'],
        artifactIds: [],
        candidateIds: [],
        observationCategories: ['clipping', 'overflow'],
        required: true,
        semantic: false,
      },
      {
        id: 'font-context',
        kind: 'font-context',
        page: 1,
        sourceIds: ['font-source'],
        artifactIds: [],
        candidateIds: [],
        observationCategories: ['text-exactness'],
        required: true,
        semantic: false,
      },
    ],
    disagreements: [],
  }
}

function context(): StructuredExtractionContext {
  return {
    documentId: source.documentId,
    sourceSha256: source.sha256,
    split: 'development',
    layout: 'one-column',
    sourceRuns: [
      {
        id: 'title-run',
        text: 'Table Pilot',
        page: 1,
        order: 0,
        regionId: 'title-region',
        bounds: {
          x: titleBox.x,
          y: titleBox.y,
          width: titleBox.width,
          height: titleBox.height,
        },
      },
      {
        id: 'header-run',
        text: 'Header',
        page: 1,
        order: 1,
        regionId: 'table-region',
        bounds: { x: 0.1, y: 0.2, width: 0.7, height: 0.08 },
      },
      {
        id: 'body-run',
        text: 'Body',
        page: 1,
        order: 2,
        regionId: 'table-region',
        bounds: { x: 0.1, y: 0.3, width: 0.7, height: 0.08 },
      },
    ],
    sourceAssets: [],
    provenArtifacts: [
      {
        id: 'table-scope',
        kind: 'table-scope',
        sourceRunIds: ['header-run', 'body-run'],
        tableRows: [
          {
            cells: [
              {
                sourceRunIds: ['header-run'],
                rowSpan: 1,
                columnSpan: 2,
                headerScope: 'column',
              },
            ],
          },
          {
            cells: [
              {
                sourceRunIds: ['body-run'],
                rowSpan: 1,
                columnSpan: 1,
                headerScope: 'none',
              },
            ],
          },
        ],
      },
      {
        id: 'source-run-provenance',
        kind: 'source-run-provenance',
        sourceRunIds: ['title-run', 'header-run', 'body-run'],
      },
    ],
  }
}

function proposal(): StructuredExtractionProposal {
  return {
    schemaVersion: '1.0.0',
    nodes: [
      { id: 'title-node', type: 'title', sourceRunIds: ['title-run'] },
      {
        id: 'table-node',
        type: 'table',
        sourceRunIds: ['header-run', 'body-run'],
        table: {
          rows: [
            {
              cells: [
                {
                  sourceRunIds: ['header-run'],
                  rowSpan: 1,
                  columnSpan: 2,
                  headerScope: 'column',
                },
              ],
            },
            {
              cells: [
                {
                  sourceRunIds: ['body-run'],
                  rowSpan: 1,
                  columnSpan: 1,
                  headerScope: 'none',
                },
              ],
            },
          ],
        },
      },
    ],
  }
}

function selections(
  graph = buildSourceEvidenceGraph(graphInput()),
  titleCandidateId = 'title-candidate',
) {
  const contract = createSourceEvidenceContract(graph, verifierIdentity)
  const selected = (
    targetId: string,
    candidateId: string,
  ): GroundedStructCandidateSelection => {
    const reference = contract.candidateReferences.find(
      (candidate) => candidate.candidateId === candidateId,
    )!
    return {
      op: 'select-evidence-candidate',
      targetKind: 'block',
      targetId,
      candidateReferenceSha256: reference.referenceSha256,
      bindingSha256: reference.bindingSha256,
    }
  }
  return {
    graph,
    values: [
      selected('title-node', titleCandidateId),
      selected('table-node', 'table-candidate'),
    ],
  }
}

describe('candidate-grounded STRUCT materialization', () => {
  it('retains exact table spans into three reopened publication EPUBs', async () => {
    const selected = selections()
    const materialized = materializeGroundedStruct({
      graph: selected.graph,
      context: context(),
      proposal: proposal(),
      verifierIdentity,
      selections: selected.values,
      sourceFileName: 'public-table-pilot.pdf',
    })

    expect(materialized.receipt.status).toBe('publication-ready')
    expect(materialized.document.blocks[1]!.table?.cells[0]).toMatchObject({
      text: 'Header',
      rowSpan: 1,
      columnSpan: 2,
      headerScope: 'column',
    })
    await expect(
      buildExactThreeProfileStructEpubs(
        materialized.document,
        materialized.canonicalStructBytes,
      ),
    ).resolves.toHaveLength(3)
  })

  it('rejects a selected candidate that does not own the source text', () => {
    const selected = selections(undefined, 'wrong-title-candidate')
    expect(() =>
      materializeGroundedStruct({
        graph: selected.graph,
        context: context(),
        proposal: proposal(),
        verifierIdentity,
        selections: selected.values,
        sourceFileName: 'public-table-pilot.pdf',
      }),
    ).toThrow('UNGROUNDED_BLOCK_CANDIDATE')
  })

  it('rejects graph table spans that differ from verified deterministic spans', () => {
    const graph = buildSourceEvidenceGraph(graphInput(1))
    const selected = selections(graph)
    expect(() =>
      materializeGroundedStruct({
        graph,
        context: context(),
        proposal: proposal(),
        verifierIdentity,
        selections: selected.values,
        sourceFileName: 'public-table-pilot.pdf',
      }),
    ).toThrow('UNGROUNDED_SEMANTIC_TABLE_CANDIDATE')
  })
})
