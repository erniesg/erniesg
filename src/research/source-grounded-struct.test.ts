import { describe, expect, it } from 'vitest'
import type { StructuredExtractionContext } from './structured-extraction'
import {
  SOURCE_GROUNDED_STRUCT_SCHEMA_VERSION,
  verifySourceGroundedStructCandidate,
  type SourceGroundedStructProposal,
} from './source-grounded-struct'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  sourceEvidenceCandidateSetSha256,
  type SourceEvidenceGraph,
  type SourceEvidenceGraphInput,
} from './source-evidence-graph'

const sourceSha256 = '1'.repeat(64)
const source = {
  documentId: 'grounded-document',
  sha256: sourceSha256,
  byteLength: 4096,
  pageCount: 1,
}

function graphFixture({
  candidateKind = 'text-glyph-run',
  obligationKind = 'source-text',
  semantic = true,
  convergentMineru = false,
}: {
  candidateKind?: string
  obligationKind?: string
  semantic?: boolean
  convergentMineru?: boolean
} = {}): SourceEvidenceGraph {
  const provider = {
    id: 'pdfjs-fixture',
    kind: 'pdfjs' as const,
    name: 'pdfjs-dist',
    version: 'fixture',
  }
  const mineruProvider = {
    id: 'mineru-fixture',
    kind: 'mineru' as const,
    name: 'MinerU',
    version: '3.4.4',
  }
  const box = {
    page: 1,
    x: 0.1,
    y: 0.2,
    width: 0.2,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const candidateBox =
    candidateKind === 'full-page-render'
      ? { ...box, x: 0, y: 0, width: 1, height: 1 }
      : box
  const graphInput: Omit<
    SourceEvidenceGraphInput,
    'deterministicContext'
  > = {
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source,
    arms: [
      {
        id: 'deterministic',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: provider.id,
      },
      {
        id: 'mineru',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: mineruProvider.id,
      },
    ],
    bundles: [
      {
        schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        id: 'deterministic-bundle',
        armId: 'deterministic',
        source,
        provider,
        pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
        artifacts: [
          {
            id: 'deterministic-artifact',
            providerId: provider.id,
            kind:
              candidateKind === 'full-page-render'
                ? 'full-page-render'
                : 'source-run-evidence',
            mediaType:
              candidateKind === 'full-page-render'
                ? 'image/png'
                : 'application/json',
            sha256: '2'.repeat(64),
            byteLength: 128,
            page: 1,
            box: candidateBox,
            sourceIds: ['source-run'],
          },
        ],
        sources: [
          {
            id: 'source-run',
            providerId: provider.id,
            kind:
              obligationKind === 'source-preserved-page'
                ? 'page-geometry'
                : 'text-glyph-run',
            page: 1,
            box: candidateBox,
            artifactIds: ['deterministic-artifact'],
            payload:
              obligationKind === 'source-preserved-page'
                ? { width: 612, height: 792, rotation: 0 }
                : { text: 'Grounded text.' },
          },
        ],
        candidates: [
          {
            id: 'candidate-run',
            providerId: provider.id,
            kind: candidateKind,
            page: 1,
            boxes: [candidateBox],
            sourceIds: ['source-run'],
            artifactIds: ['deterministic-artifact'],
            payload:
              candidateKind === 'full-page-render'
                ? { completePageRaster: true }
                : { text: 'Grounded text.' },
          },
        ],
      },
      {
        schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        id: 'mineru-bundle',
        armId: 'mineru',
        source,
        provider: mineruProvider,
        pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
        artifacts: [
          {
            id: 'mineru-artifact',
            providerId: mineruProvider.id,
            kind: 'content-list-v2',
            mediaType: 'application/json',
            sha256: '3'.repeat(64),
            byteLength: 64,
            page: 1,
            box,
            sourceIds: ['mineru-source'],
          },
        ],
        sources: [
          {
            id: 'mineru-source',
            providerId: mineruProvider.id,
            kind: convergentMineru
              ? 'mineru-native-record'
              : 'provider-record',
            page: 1,
            box,
            artifactIds: ['mineru-artifact'],
            ...(convergentMineru
              ? { payload: { record: { text: 'Grounded text.' } } }
              : {}),
          },
        ],
        candidates: [
          {
            id: 'mineru-candidate',
            providerId: mineruProvider.id,
            kind: convergentMineru ? 'text-glyph-run' : 'provider-record',
            page: 1,
            boxes: [box],
            sourceIds: ['mineru-source'],
            artifactIds: ['mineru-artifact'],
            payload: convergentMineru
              ? { text: 'Grounded text.', grounded: true }
              : { grounded: false },
          },
        ],
      },
    ],
    obligations: [
      {
        id: 'obligation-run',
        kind: obligationKind,
        page: 1,
        sourceIds: [
          'source-run',
          ...(convergentMineru ? ['mineru-source'] : []),
        ],
        artifactIds: [
          'deterministic-artifact',
          ...(convergentMineru ? ['mineru-artifact'] : []),
        ],
        candidateIds: [
          'candidate-run',
          ...(convergentMineru ? ['mineru-candidate'] : []),
        ],
        observationCategories: ['text-exactness'],
        required: true,
        semantic,
      },
      ...(!convergentMineru
        ? [{
        id: 'mineru-discovery-obligation',
        kind: 'provider-source-fact',
        page: 1,
        sourceIds: ['mineru-source'],
        artifactIds: ['mineru-artifact'],
        candidateIds: ['mineru-candidate'],
        observationCategories: [
          'object-counts' as const,
          'asset-bytes' as const,
        ],
        required: false,
        semantic: false,
      }]
        : []),
    ],
    disagreements: [],
  }
  return buildSourceEvidenceGraph({
    ...graphInput,
    deterministicContext: deterministicContextReceiptForBundle(
      graphInput.bundles[0]!,
    ),
  })
}

function context(): StructuredExtractionContext {
  return {
    documentId: source.documentId,
    sourceSha256,
    split: 'held-out',
    layout: 'one-column',
    sourceRuns: [
      {
        id: 'source-run',
        text: 'Grounded text.',
        page: 1,
        order: 0,
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.02 },
      },
    ],
    sourceAssets: [],
  }
}

function proposal(graph: SourceEvidenceGraph): SourceGroundedStructProposal {
  return {
    schemaVersion: SOURCE_GROUNDED_STRUCT_SCHEMA_VERSION,
    evidenceGraphSha256: graph.graphSha256,
    candidateSetSha256: sourceEvidenceCandidateSetSha256(graph),
    selections: [
      {
        obligationId: 'obligation-run',
        candidateId: 'candidate-run',
        decision: 'preserve-source' as const,
        disposition: 'accepted' as const,
      },
    ],
    materializations: [
      {
        obligationId: 'obligation-run',
        candidateId: 'candidate-run',
        sourceIds: ['source-run'],
        targets: [{ kind: 'node' as const, id: 'paragraph' }],
      },
    ],
    structuredExtraction: {
      schemaVersion: '1.0.0' as const,
      nodes: [
        {
          id: 'paragraph',
          type: 'paragraph' as const,
          sourceRunIds: ['source-run'],
          text: 'Grounded text.',
        },
      ],
    },
  }
}

describe('source-grounded STRUCT verification', () => {
  it('emits an immutable candidate only after exact graph obligation closure', () => {
    const graph = graphFixture()
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      proposal(graph),
    )

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(result.output.readyForStruct).toBe(true)
      expect(result.output.evidenceGraphSha256).toBe(graph.graphSha256)
      expect(Object.isFrozen(result.output)).toBe(true)
      expect(result.output.structuredExtraction.nodes[0]?.text).toBe(
        'Grounded text.',
      )
    }
  })

  it('accepts convergent deterministic and MinerU sources through unique target-owner sets', () => {
    const graph = graphFixture({ convergentMineru: true })
    const candidate = proposal(graph)
    candidate.materializations[0]!.sourceIds = [
      'source-run',
      'mineru-source',
    ]
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      candidate,
    )

    expect(result.status).toBe('passed')
    if (result.status === 'passed') {
      expect(result.output.providerSourceOwnershipCrosswalks).toEqual([
        expect.objectContaining({ providerId: 'mineru-fixture', sourceCount: 1 }),
        expect.objectContaining({ providerId: 'pdfjs-fixture', sourceCount: 1 }),
      ])
      expect(
        result.output.providerSourceOwnershipCrosswalks[0]!.crosswalkSha256,
      ).not.toBe(
        result.output.providerSourceOwnershipCrosswalks[1]!.crosswalkSha256,
      )
    }
  })

  it('rejects divergent provider source ownership instead of laundering convergence', () => {
    const graph = graphFixture({ convergentMineru: true })
    const divergent = context()
    divergent.sourceRuns[0]!.text = 'Different deterministic text.'
    const candidate = proposal(graph)
    candidate.structuredExtraction.nodes[0]!.text =
      'Different deterministic text.'
    candidate.materializations[0]!.sourceIds = [
      'source-run',
      'mineru-source',
    ]
    const result = verifySourceGroundedStructCandidate(
      graph,
      divergent,
      candidate,
    )

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'invalid-source-crosswalk',
      )
    }
  })

  it('rejects stale candidate-set bindings and missing obligation closure', () => {
    const graph = graphFixture()
    const candidate = proposal(graph)
    candidate.candidateSetSha256 = '2'.repeat(64)
    candidate.selections = []
    candidate.materializations = []
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      candidate,
    )

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toEqual(
        expect.arrayContaining(['stale-candidate-set', 'missing-obligation']),
      )
    }
  })

  it('rejects obligation selection without a materialized STRUCT owner', () => {
    const graph = graphFixture()
    const candidate = proposal(graph)
    candidate.materializations = []
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      candidate,
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'missing-materialization',
      )
    }
  })

  it('rejects a materialization receipt that cites unrelated source IDs', () => {
    const graph = graphFixture()
    const candidate = proposal(graph)
    candidate.materializations[0]!.sourceIds = ['unrelated-source']
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      candidate,
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'invalid-materialization',
      )
    }
  })

  it('never accepts a full-page raster as reconstructed semantics', () => {
    const graph = graphFixture({ candidateKind: 'full-page-render' })
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      proposal(graph),
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'full-page-raster-as-semantics',
      )
    }
  })

  it('keeps a table image as a blocking semantic obligation', () => {
    const graph = graphFixture({
      candidateKind: 'table-image',
      obligationKind: 'table-structure',
    })
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      proposal(graph),
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'unresolved-table-semantics',
      )
    }
  })

  it('rejects heading-role laundering into a paragraph node', () => {
    const graph = graphFixture({ candidateKind: 'heading' })
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      proposal(graph),
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'semantic-role-mismatch',
      )
    }
  })

  it('rejects duplicate target ownership across source obligations', () => {
    const graph = graphFixture()
    const candidate = proposal(graph)
    candidate.selections.push({
      obligationId: 'mineru-discovery-obligation',
      candidateId: 'mineru-candidate',
      decision: 'preserve-source',
      disposition: 'accepted',
    })
    candidate.materializations.push({
      obligationId: 'mineru-discovery-obligation',
      candidateId: 'mineru-candidate',
      sourceIds: ['mineru-source'],
      targets: [{ kind: 'node', id: 'paragraph' }],
    })
    const result = verifySourceGroundedStructCandidate(
      graph,
      context(),
      candidate,
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'duplicate-materialization-target',
      )
    }
  })

  it('rejects two-obligation cross-swap across otherwise valid STRUCT nodes', () => {
    const frozen = graphFixture()
    const { graphSha256: _graphSha256, ...input } = structuredClone(frozen)
    const deterministic = input.bundles.find(
      ({ armId }) => armId === 'deterministic',
    )!
    deterministic.sources.push({
      id: 'source-run-2',
      providerId: deterministic.provider.id,
      kind: 'text-glyph-run',
      page: 1,
      box: {
        page: 1,
        x: 0.1,
        y: 0.3,
        width: 0.2,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
      payload: { text: 'Second grounded text.' },
    })
    deterministic.candidates.push({
      id: 'candidate-run-2',
      providerId: deterministic.provider.id,
      kind: 'text-glyph-run',
      page: 1,
      boxes: [deterministic.sources.at(-1)!.box!],
      sourceIds: ['source-run-2'],
      payload: { text: 'Second grounded text.' },
    })
    input.obligations.push({
      id: 'obligation-run-2',
      kind: 'source-text',
      page: 1,
      sourceIds: ['source-run-2'],
      artifactIds: [],
      candidateIds: ['candidate-run-2'],
      observationCategories: ['text-exactness'],
      required: true,
      semantic: true,
    })
    input.deterministicContext = deterministicContextReceiptForBundle(
      deterministic,
    )
    const graph = buildSourceEvidenceGraph(input)
    const groundedContext = context()
    groundedContext.sourceRuns.push({
      id: 'source-run-2',
      text: 'Second grounded text.',
      page: 1,
      order: 1,
      bounds: { x: 0.1, y: 0.3, width: 0.2, height: 0.02 },
    })
    const candidate = proposal(graph)
    candidate.selections.push({
      obligationId: 'obligation-run-2',
      candidateId: 'candidate-run-2',
      decision: 'preserve-source',
      disposition: 'accepted',
    })
    candidate.structuredExtraction.nodes.push({
      id: 'paragraph-2',
      type: 'paragraph',
      sourceRunIds: ['source-run-2'],
      text: 'Second grounded text.',
    })
    candidate.materializations[0]!.targets = [
      { kind: 'node', id: 'paragraph-2' },
    ]
    candidate.materializations.push({
      obligationId: 'obligation-run-2',
      candidateId: 'candidate-run-2',
      sourceIds: ['source-run-2'],
      targets: [{ kind: 'node', id: 'paragraph' }],
    })

    const result = verifySourceGroundedStructCandidate(
      graph,
      groundedContext,
      candidate,
    )
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.issues.map(({ code }) => code)).toContain(
        'invalid-source-crosswalk',
      )
    }
  })

  it('accepts a source-preserved scan only when the complete-page artifact is materialized', () => {
    const graph = graphFixture({
      candidateKind: 'full-page-render',
      obligationKind: 'source-preserved-page',
    })
    const scanContext = context()
    scanContext.sourceAssets = [
      {
        id: 'source-page-1',
        kind: 'source-fallback',
        page: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        bytesSha256: '2'.repeat(64),
        sourceObjectIds: ['source-page-render'],
      },
    ]
    const candidate = proposal(graph)
    candidate.materializations[0]!.targets = [
      { kind: 'asset', id: 'source-page-1' },
    ]
    candidate.structuredExtraction.nodes[0] = {
      id: 'source-page-node',
      type: 'source-fallback',
      sourceRunIds: ['source-run'],
      assetId: 'source-page-1',
    }
    const result = verifySourceGroundedStructCandidate(
      graph,
      scanContext,
      candidate,
    )
    expect(result.status).toBe('passed')

    scanContext.sourceAssets[0]!.bytesSha256 = '4'.repeat(64)
    const tampered = verifySourceGroundedStructCandidate(
      graph,
      scanContext,
      candidate,
    )
    expect(tampered.status).toBe('failed')
    if (tampered.status === 'failed') {
      expect(tampered.issues.map(({ code }) => code)).toContain(
        'invalid-source-fallback',
      )
    }
  })
})
