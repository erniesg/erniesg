import { describe, expect, it } from 'vitest'
import { path as epubCheckJarPath } from 'epubcheck-static'
import { sha256HexSync } from '../struct/sha256'
import {
  hashTraceValue,
  type ProviderReceiptBinding,
} from './reconstruction-attempt-trace'
import {
  renderExactThreeProfileEpubs,
  executePinnedEpubCheck,
  runEpubCheckWarningsFatal,
} from './actual-profiled-epub'
import {
  createReconstructionCandidateBinding,
  createReconstructionCandidateContract,
  createStructEvidencePatch,
  deriveStructRepairProjections,
  type GroundedVerifierIdentity,
  type OwnerLocalCodexIdentity,
  type SelectedGroundingVerificationRequest,
} from './reconstruction-refinement'
import {
  buildExactThreeProfileStructEpubs,
  createClosedThreeProfileReconstructionReceipt,
  createReconstructionHardCheckVector,
} from './reconstruction-materialization'
import {
  compareGroundedProfiledEpub,
  createGroundedActualReconstructionTrace,
} from './grounded-epub-comparison'
import {
  runGroundedThreeProfileRefinement,
  verifyGroundedThreeProfileRefinementResult,
} from './grounded-reconstruction-refinement'
import { createSourceEvidenceContract } from './source-evidence-contract'
import { applyGroundedStructRepair } from './grounded-struct-repair-applicator'
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
  verifyGroundedCoreMaterializationBinding,
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
const digest = (value: string | Uint8Array) => sha256HexSync(value)

function groundedVerifierReceipt(
  identity: GroundedVerifierIdentity,
  request: SelectedGroundingVerificationRequest,
) {
  const before = deriveStructRepairProjections(
    request.beforeCanonicalStructBytes,
    request.operations,
  )
  const resulting = deriveStructRepairProjections(
    request.resultingCanonicalStructBytes,
    request.operations,
  )
  const candidatePayloads = request.candidatePayloads.map(
    ({ payloadBytes: _payloadBytes, ...binding }) => binding,
  )
  const requestProjection = {
    schemaVersion: request.schemaVersion,
    sourceEvidenceGraphSha256: request.sourceEvidenceGraphSha256,
    proposalSha256: request.proposalSha256,
    operations: request.operations,
    beforeCanonicalStruct: request.beforeCanonicalStruct,
    resultingCanonicalStruct: request.resultingCanonicalStruct,
    beforeSelectedProjection: request.beforeSelectedProjection,
    resultingSelectedProjection: request.resultingSelectedProjection,
    candidatePayloads,
  }
  const projection = {
    schemaVersion: '1.0.0' as const,
    verifierIdentity: structuredClone(identity),
    verifierIdentitySha256: hashTraceValue(identity),
    sourceEvidenceGraphSha256: request.sourceEvidenceGraphSha256,
    proposalSha256: request.proposalSha256,
    operationTargetSetSha256: hashTraceValue(
      request.operations
        .map(({ targetKind, targetId }) => ({ targetKind, targetId }))
        .sort((left, right) =>
          left.targetKind === right.targetKind
            ? left.targetId.localeCompare(right.targetId)
            : left.targetKind.localeCompare(right.targetKind),
        ),
    ),
    candidateReferenceSetSha256: hashTraceValue(
      request.operations
        .map(({ candidateReferenceSha256 }) => candidateReferenceSha256)
        .sort(),
    ),
    candidatePayloadSetSha256: hashTraceValue(candidatePayloads),
    beforeStructSha256: request.beforeCanonicalStruct.sha256,
    resultingStructSha256: request.resultingCanonicalStruct.sha256,
    beforeSelectedProjectionSha256: request.beforeSelectedProjection.sha256,
    beforeUnselectedProjectionSha256: before.unselected.sha256,
    resultingSelectedProjectionSha256:
      request.resultingSelectedProjection.sha256,
    resultingUnselectedProjectionSha256: resulting.unselected.sha256,
    inputSha256: hashTraceValue(requestProjection),
    outputSha256: hashTraceValue({
      resultingStructSha256: request.resultingCanonicalStruct.sha256,
      resultingSelectedProjectionSha256:
        request.resultingSelectedProjection.sha256,
      resultingUnselectedProjectionSha256: resulting.unselected.sha256,
    }),
    status: 'succeeded' as const,
  }
  return { ...projection, receiptSha256: hashTraceValue(projection) }
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
const headingBox = {
  page: 1,
  x: 0.1,
  y: 0.16,
  width: 0.7,
  height: 0.03,
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
          id: 'heading-source',
          providerId: 'pdfjs-provider',
          kind: 'heading',
          page: 1,
          box: headingBox,
          payload: { text: 'Methods' },
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
          id: 'heading-level-2-candidate',
          providerId: 'pdfjs-provider',
          kind: 'heading',
          page: 1,
          boxes: [headingBox],
          sourceIds: ['heading-source'],
          payload: { text: 'Methods', level: 2 },
        },
        {
          id: 'heading-level-3-candidate',
          providerId: 'pdfjs-provider',
          kind: 'heading',
          page: 1,
          boxes: [headingBox],
          sourceIds: ['heading-source'],
          payload: { text: 'Methods', level: 3 },
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
        id: 'heading-obligation',
        kind: 'hierarchy',
        page: 1,
        sourceIds: ['heading-source'],
        artifactIds: [],
        candidateIds: [
          'heading-level-2-candidate',
          'heading-level-3-candidate',
        ],
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
        id: 'heading-run',
        text: 'Methods',
        page: 1,
        order: 1,
        regionId: 'heading-region',
        bounds: {
          x: headingBox.x,
          y: headingBox.y,
          width: headingBox.width,
          height: headingBox.height,
        },
      },
      {
        id: 'header-run',
        text: 'Header',
        page: 1,
        order: 2,
        regionId: 'table-region',
        bounds: { x: 0.1, y: 0.2, width: 0.7, height: 0.08 },
      },
      {
        id: 'body-run',
        text: 'Body',
        page: 1,
        order: 3,
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
        sourceRunIds: ['title-run', 'heading-run', 'header-run', 'body-run'],
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
        id: 'heading-node',
        type: 'heading',
        sourceRunIds: ['heading-run'],
        level: 2,
      },
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
  headingCandidateId = 'heading-level-2-candidate',
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
      selected('heading-node', headingCandidateId),
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
    expect(materialized.receipt.obligationBindings).toHaveLength(3)
    expect(
      materialized.document.blocks.find(({ kind }) => kind === 'table')?.table
        ?.cells[0],
    ).toMatchObject({
      text: 'Header',
      rowSpan: 1,
      columnSpan: 2,
      headerScope: 'column',
    })
    expect(() =>
      verifyGroundedCoreMaterializationBinding(materialized),
    ).not.toThrow()
    const builds = await buildExactThreeProfileStructEpubs(
      materialized.document,
      materialized.canonicalStructBytes,
    )
    const renders = await renderExactThreeProfileEpubs(builds)
    expect(builds).toHaveLength(3)
    expect(renders.map(({ profileId }) => profileId)).toEqual([
      'mobile',
      'paperProMove',
      'paperPro',
    ])
    expect(
      renders.every(({ anchors }) =>
        anchors.includes(materialized.document.blocks[0]!.id),
      ),
    ).toBe(true)
    const expectedAnchorIds = [
      ...new Set(
        materialized.receipt.obligationBindings.flatMap(
          ({ sourceAnchorIds }) => sourceAnchorIds,
        ),
      ),
    ]
    expect(
      renders.every(({ anchors }) =>
        expectedAnchorIds.every((anchorId) => anchors.includes(anchorId)),
      ),
    ).toBe(true)
    expect(renders.every(({ metrics }) => !metrics.horizontalOverflow)).toBe(
      true,
    )
    expect(
      renders.every(({ domBytes }) =>
        new TextDecoder().decode(domBytes).includes('scope="col"'),
      ),
    ).toBe(true)

    const sourceContract = createSourceEvidenceContract(
      selected.graph,
      verifierIdentity,
    )
    const epubChecks = await Promise.all(
      builds.map((build) =>
        runEpubCheckWarningsFatal(build, async () => ({
          toolId: 'epubcheck',
          toolVersion: '5.3.0',
          executableSha256: digest('epubcheck-jar'),
          exitCode: 0,
          reportBytes: new TextEncoder().encode('{"messages":[]}'),
          errorCount: 0,
          warningCount: 0,
        })),
      ),
    )
    const comparisons = builds.map((build, index) =>
      compareGroundedProfiledEpub({
        materialization: materialized,
        sourceContract,
        build,
        render: renders[index]!,
        epubCheck: epubChecks[index]!,
      }),
    )
    expect(
      comparisons.every(
        ({ comparator }) =>
          comparator.status === 'publication-ready' && comparator.failed === 0,
      ),
    ).toBe(true)
    const codexIdentity = {
      server: {
        id: 'owner-local-codex-server',
        version: '2026.08.1',
        transport: 'http://127.0.0.1:4500/v1',
        executableSha256: digest('codex-server'),
      },
      model: {
        id: 'gpt-5.6-sol',
        version: '2026-08-01',
        sha256: digest('codex-model'),
      },
      prompt: {
        id: 'closed-grounded-reconstruction',
        version: '1.0.0',
        sha256: digest('codex-prompt'),
      },
      tool: { id: 'codex', version: '0.99.0' },
    }
    const traces = Object.fromEntries(
      comparisons.map((comparison) => [
        comparison.profileId,
        createGroundedActualReconstructionTrace({
          attemptId: `public-table-${comparison.profileId}-0`,
          sourcePdf: {
            artifact: {
              sha256: source.sha256,
              byteLength: source.byteLength,
            },
            pageCount: 1,
            pageRenders: [
              {
                page: 1,
                sourcePdfSha256: source.sha256,
                image: { sha256: digest('source-page-1'), byteLength: 128 },
                mediaType: 'image/png',
                width: 612,
                height: 792,
              },
            ],
          },
          materialization: materialized,
          sourceContract,
          comparison,
          codexIdentity,
          codexReceiptSha256: digest(`codex-receipt-${comparison.profileId}`),
        }),
      ]),
    ) as Record<
      (typeof builds)[number]['profileId'],
      ReturnType<typeof createGroundedActualReconstructionTrace>
    >
    const outerReceipt = createClosedThreeProfileReconstructionReceipt({
      attempts: [
        {
          coordinatorProfileId: 'mobile',
          canonicalStructSha256: materialized.receipt.repairCore.sha256,
          materializationReceipt: materialized.receipt,
          traces,
          builds,
        },
      ],
    })
    expect(outerReceipt.status).toBe('publication-ready')
    expect(
      Object.entries(traces).every(([profileId, trace]) =>
        createReconstructionHardCheckVector(
          profileId as (typeof builds)[number]['profileId'],
          trace,
        ).checks.every(({ status }) => status === 'passed'),
      ),
    ).toBe(true)
    const spanTamper = structuredClone(renders[0]!)
    spanTamper.blockFacts
      .flatMap(({ cells }) => cells)
      .find(({ text }) => text === 'Header')!.columnSpan = 1
    const {
      domBytes: _tamperedDomBytes,
      screenshotBytes: _tamperedScreenshotBytes,
      receiptSha256: _tamperedReceiptSha256,
      ...tamperedRenderProjection
    } = spanTamper
    spanTamper.receiptSha256 = hashTraceValue(tamperedRenderProjection)
    const failedSpanComparison = compareGroundedProfiledEpub({
      materialization: materialized,
      sourceContract,
      build: builds[0]!,
      render: spanTamper,
      epubCheck: epubChecks[0]!,
    })
    expect(failedSpanComparison.comparator.status).toBe('failed')
    expect(failedSpanComparison.mappings).toContainEqual(
      expect.objectContaining({ status: 'missing' }),
    )
    const failedSpanTrace = createGroundedActualReconstructionTrace({
      attemptId: 'public-table-mobile-failed-span',
      sourcePdf: {
        artifact: { sha256: source.sha256, byteLength: source.byteLength },
        pageCount: 1,
        pageRenders: [
          {
            page: 1,
            sourcePdfSha256: source.sha256,
            image: { sha256: digest('source-page-1'), byteLength: 128 },
            mediaType: 'image/png',
            width: 612,
            height: 792,
          },
        ],
      },
      materialization: materialized,
      sourceContract,
      comparison: failedSpanComparison,
      codexIdentity,
      codexReceiptSha256: digest('codex-failed-span'),
    })
    expect(failedSpanTrace).toMatchObject({
      terminalState: 'failed',
      structure: { artifact: materialized.receipt.repairCore },
      comparator: { status: 'failed' },
    })
    expect(failedSpanTrace.comparator.firstCauseFailureId).not.toBeNull()

    await expect(
      runEpubCheckWarningsFatal(builds[0]!, async () => ({
        toolId: 'epubcheck',
        toolVersion: '5.3.0',
        executableSha256: digest('epubcheck-jar'),
        exitCode: 0,
        reportBytes: new TextEncoder().encode('{"messages":[]}'),
        errorCount: 0,
        warningCount: 0,
      })),
    ).resolves.toMatchObject({ status: 'passed', warningCount: 0 })
    await expect(
      runEpubCheckWarningsFatal(builds[0]!, async () => ({
        toolId: 'epubcheck',
        toolVersion: '5.3.0',
        executableSha256: digest('epubcheck-jar'),
        exitCode: 0,
        reportBytes: new TextEncoder().encode(
          '{"messages":[{"severity":"WARNING"}]}',
        ),
        errorCount: 0,
        warningCount: 1,
      })),
    ).rejects.toThrow('EPUBCHECK_WARNINGS_FATAL')
  })

  it('rejects unselected core and derived receipt tampering at the bridge', () => {
    const selected = selections()
    const materialized = materializeGroundedStruct({
      graph: selected.graph,
      context: context(),
      proposal: proposal(),
      verifierIdentity,
      selections: selected.values,
      sourceFileName: 'public-table-pilot.pdf',
    })
    const coreTamper = structuredClone(materialized)
    coreTamper.document.blocks[0]!.text = 'Invented title'
    expect(() => verifyGroundedCoreMaterializationBinding(coreTamper)).toThrow(
      'INVALID_GROUNDED_CORE_MATERIALIZATION_BINDING',
    )

    const receiptTamper = structuredClone(materialized)
    receiptTamper.document.receipt.generatedSha256 = 'f'.repeat(64)
    expect(() =>
      verifyGroundedCoreMaterializationBinding(receiptTamper),
    ).toThrow('INVALID_GROUNDED_CORE_MATERIALIZATION_BINDING')
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

  it.runIf(Boolean(process.env.RUCKSACK_EPUBCHECK_JAVA))(
    'executes the pinned EPUBCheck jar with warnings fatal for all profiles',
    async () => {
      const selected = selections()
      const materialized = materializeGroundedStruct({
        graph: selected.graph,
        context: context(),
        proposal: proposal(),
        verifierIdentity,
        selections: selected.values,
        sourceFileName: 'public-table-pilot.pdf',
      })
      const builds = await buildExactThreeProfileStructEpubs(
        materialized.document,
        materialized.canonicalStructBytes,
      )
      for (const build of builds) {
        await expect(
          runEpubCheckWarningsFatal(build, (epubBytes) =>
            executePinnedEpubCheck({
              epubBytes,
              javaPath: process.env.RUCKSACK_EPUBCHECK_JAVA!,
              epubCheckJarPath,
              toolVersion: '5.3.0',
            }),
          ),
        ).resolves.toMatchObject({ status: 'passed', warningCount: 0 })
      }
    },
    20_000,
  )

  it('applies a selected full-schema repair through the receipt-free core bridge', () => {
    const selected = selections()
    const materializationInput = {
      graph: selected.graph,
      context: context(),
      proposal: proposal(),
      verifierIdentity,
      selections: selected.values,
      sourceFileName: 'public-table-pilot.pdf',
    }
    const beforeMaterialization =
      materializeGroundedStruct(materializationInput)
    const headingBlock = beforeMaterialization.document.blocks.find(
      ({ text }) => text === 'Methods',
    )!
    const sourceContract = createSourceEvidenceContract(
      selected.graph,
      verifierIdentity,
    )
    const headingLevel2 = sourceContract.candidateReferences.find(
      ({ candidateId }) => candidateId === 'heading-level-2-candidate',
    )!
    const headingLevel3 = sourceContract.candidateReferences.find(
      ({ candidateId }) => candidateId === 'heading-level-3-candidate',
    )!
    const codexIdentity: OwnerLocalCodexIdentity = {
      server: {
        id: 'owner-local-codex-server',
        version: '2026.08.1',
        transport: 'http://127.0.0.1:4500/v1',
        executableSha256: digest('codex-server'),
      },
      model: {
        id: 'gpt-5.6-sol',
        version: '2026-08-01',
        sha256: digest('codex-model'),
      },
      prompt: {
        id: 'grounded-struct-repair',
        version: '1.0.0',
        sha256: digest('prompt'),
      },
      tool: { id: 'codex', version: '0.99.0' },
    }
    const groundedVerifierIdentity = {
      id: 'selected-grounding-verifier',
      version: '1.0.0',
      configurationSha256: digest('selected-grounding-configuration'),
      executableSha256: digest('selected-grounding-executable'),
    }
    const artifactResolverIdentity = {
      id: 'owner-local-artifact-resolver',
      version: '1.0.0',
      configurationSha256: digest('artifact-resolver-configuration'),
    }
    const renderExtractorIdentity = {
      id: 'render-observation-extractor',
      version: '1.0.0',
      configurationSha256: digest('render-extractor-configuration'),
      executableSha256: digest('render-extractor-executable'),
    }
    const contract = createReconstructionCandidateContract({
      schemaVersion: '1.0.0',
      runId: 'public-table-pilot-run',
      documentId: source.documentId,
      sourcePdfSha256: source.sha256,
      sourceEvidenceGraph: {
        schemaVersion: '1.0.0',
        sha256: selected.graph.graphSha256,
      },
      authorities: {
        codex: {
          identity: codexIdentity,
          identitySha256: hashTraceValue(codexIdentity),
        },
        groundedVerifier: {
          identity: groundedVerifierIdentity,
          identitySha256: hashTraceValue(groundedVerifierIdentity),
        },
        artifactResolver: {
          identity: artifactResolverIdentity,
          identitySha256: hashTraceValue(artifactResolverIdentity),
        },
        sourceEvidenceVerifier: {
          identity: verifierIdentity,
          identitySha256: hashTraceValue(verifierIdentity),
        },
        renderObservationExtractor: {
          identity: renderExtractorIdentity,
          identitySha256: hashTraceValue(renderExtractorIdentity),
        },
      },
      budget: {
        maxRefinements: 3,
        maxFreshTasks: 1,
        maxTokens: 24_000,
        maxDurationMs: 30 * 60 * 1_000,
        repairPolicySha256: digest('repair-policy'),
      },
      repairScope: [
        {
          targetKind: 'block',
          targetId: headingBlock.id,
          candidateReferenceSha256s: [
            headingLevel2.referenceSha256,
            headingLevel3.referenceSha256,
          ],
        },
      ],
    })
    const beforeCandidate = {
      binding: createReconstructionCandidateBinding({
        schemaVersion: '1.0.0',
        sourcePdfSha256: source.sha256,
        sourceEvidenceGraphSha256: selected.graph.graphSha256,
        canonicalStruct: beforeMaterialization.receipt.repairCore,
        selections: [
          {
            op: 'select-evidence-candidate' as const,
            targetKind: 'block' as const,
            targetId: headingBlock.id,
            candidateReferenceSha256: headingLevel2.referenceSha256,
          },
        ],
      }),
      canonicalStructBytes: beforeMaterialization.repairCoreBytes,
    }
    const patch = createStructEvidencePatch({
      schemaVersion: '1.0.0',
      documentId: source.documentId,
      sourcePdfSha256: source.sha256,
      sourceEvidenceGraphSha256: selected.graph.graphSha256,
      baseStructSha256: beforeMaterialization.receipt.repairCore.sha256,
      priorTraceSha256: digest('prior-trace'),
      taskIdSha256: digest('fresh-task'),
      operations: [
        {
          op: 'select-evidence-candidate',
          targetKind: 'block',
          targetId: headingBlock.id,
          candidateReferenceSha256: headingLevel3.referenceSha256,
        },
      ],
    })
    const resultingProposal = proposal()
    resultingProposal.nodes.find(({ id }) => id === 'heading-node')!.level = 3
    const groundedVerifier = {
      identity: groundedVerifierIdentity,
      verifySelected: (request: SelectedGroundingVerificationRequest) =>
        groundedVerifierReceipt(groundedVerifierIdentity, request),
    }
    const result = applyGroundedStructRepair({
      contract,
      beforeCandidate,
      beforeMaterialization,
      materializationInput,
      patch,
      resultingProposal,
      authorities: {
        sourceEvidenceVerifier: sourceContract.verifier,
        evidenceCandidates: sourceContract.evidenceCandidates,
        groundedVerifier,
      },
    })

    expect(result.applicationReceipt.unchangedUnselected).toMatchObject({
      beforeSha256:
        result.applicationReceipt.resultingUnselectedProjection.sha256,
      afterSha256:
        result.applicationReceipt.resultingUnselectedProjection.sha256,
    })
    expect(
      result.materialization.document.blocks.find(
        ({ text }) => text === 'Methods',
      )?.attributes,
    ).toEqual({ level: 3 })
    expect(result.materialization.document.receipt.generatedSha256).not.toBe(
      beforeMaterialization.document.receipt.generatedSha256,
    )
    expect(() =>
      verifyGroundedCoreMaterializationBinding(result.materialization),
    ).not.toThrow()

    const forgedVerifier = {
      ...groundedVerifier,
      verifySelected: (request: SelectedGroundingVerificationRequest) => ({
        ...groundedVerifierReceipt(groundedVerifierIdentity, request),
        outputSha256: digest('forged-output'),
      }),
    }
    expect(() =>
      applyGroundedStructRepair({
        contract,
        beforeCandidate,
        beforeMaterialization,
        materializationInput,
        patch,
        resultingProposal,
        authorities: {
          sourceEvidenceVerifier: sourceContract.verifier,
          evidenceCandidates: sourceContract.evidenceCandidates,
          groundedVerifier: forgedVerifier,
        },
      }),
    ).toThrow('INVALID_MATERIALIZED_REPAIR_APPLICATION_RECEIPT')
  })

  it('closes one actual three-profile attempt without opening a repair task', async () => {
    const selected = selections(
      undefined,
      'title-candidate',
      'heading-level-3-candidate',
    )
    const initialProposal = proposal()
    initialProposal.nodes.find(({ id }) => id === 'heading-node')!.level = 3
    const materializationInput = {
      graph: selected.graph,
      context: context(),
      proposal: initialProposal,
      verifierIdentity,
      selections: selected.values,
      sourceFileName: 'public-table-pilot.pdf',
    }
    const initialMaterialization =
      materializeGroundedStruct(materializationInput)
    const headingBlock = initialMaterialization.document.blocks.find(
      ({ text }) => text === 'Methods',
    )!
    const sourceContract = createSourceEvidenceContract(
      selected.graph,
      verifierIdentity,
    )
    const headingLevel2 = sourceContract.candidateReferences.find(
      ({ candidateId }) => candidateId === 'heading-level-2-candidate',
    )!
    const headingLevel3 = sourceContract.candidateReferences.find(
      ({ candidateId }) => candidateId === 'heading-level-3-candidate',
    )!
    const codexIdentity: OwnerLocalCodexIdentity = {
      server: {
        id: 'owner-local-codex-server',
        version: '2026.08.1',
        transport: 'unix:///private/tmp/codex-app-server.sock',
        executableSha256: digest('codex-server'),
      },
      model: {
        id: 'gpt-5.6-sol',
        version: '2026-08-01',
        sha256: digest('codex-model'),
      },
      prompt: {
        id: 'grounded-struct-repair',
        version: '1.0.0',
        sha256: digest('prompt'),
      },
      tool: { id: 'codex', version: '0.99.0' },
    }
    const groundedVerifierIdentity = {
      id: 'selected-grounding-verifier',
      version: '1.0.0',
      configurationSha256: digest('selected-grounding-configuration'),
      executableSha256: digest('selected-grounding-executable'),
    }
    const artifactResolverIdentity = {
      id: 'owner-local-artifact-resolver',
      version: '1.0.0',
      configurationSha256: digest('artifact-resolver-configuration'),
    }
    const renderExtractorIdentity = {
      id: 'render-observation-extractor',
      version: '1.0.0',
      configurationSha256: digest('render-extractor-configuration'),
      executableSha256: digest('render-extractor-executable'),
    }
    const contract = createReconstructionCandidateContract({
      schemaVersion: '1.0.0',
      runId: 'public-table-refinement-run',
      documentId: source.documentId,
      sourcePdfSha256: source.sha256,
      sourceEvidenceGraph: {
        schemaVersion: '1.0.0',
        sha256: selected.graph.graphSha256,
      },
      authorities: {
        codex: {
          identity: codexIdentity,
          identitySha256: hashTraceValue(codexIdentity),
        },
        groundedVerifier: {
          identity: groundedVerifierIdentity,
          identitySha256: hashTraceValue(groundedVerifierIdentity),
        },
        artifactResolver: {
          identity: artifactResolverIdentity,
          identitySha256: hashTraceValue(artifactResolverIdentity),
        },
        sourceEvidenceVerifier: {
          identity: verifierIdentity,
          identitySha256: hashTraceValue(verifierIdentity),
        },
        renderObservationExtractor: {
          identity: renderExtractorIdentity,
          identitySha256: hashTraceValue(renderExtractorIdentity),
        },
      },
      budget: {
        maxRefinements: 3,
        maxFreshTasks: 1,
        maxTokens: 24_000,
        maxDurationMs: 30 * 60 * 1_000,
        repairPolicySha256: digest('repair-policy'),
      },
      repairScope: [
        {
          targetKind: 'block',
          targetId: headingBlock.id,
          candidateReferenceSha256s: [
            headingLevel2.referenceSha256,
            headingLevel3.referenceSha256,
          ],
        },
      ],
    })
    const initialCandidate = {
      binding: createReconstructionCandidateBinding({
        schemaVersion: '1.0.0',
        sourcePdfSha256: source.sha256,
        sourceEvidenceGraphSha256: selected.graph.graphSha256,
        canonicalStruct: initialMaterialization.receipt.repairCore,
        selections: [
          {
            op: 'select-evidence-candidate' as const,
            targetKind: 'block' as const,
            targetId: headingBlock.id,
            candidateReferenceSha256: headingLevel3.referenceSha256,
          },
        ],
      }),
      canonicalStructBytes: initialMaterialization.repairCoreBytes,
    }
    const groundedVerifier = {
      identity: groundedVerifierIdentity,
      verifySelected: (request: SelectedGroundingVerificationRequest) =>
        groundedVerifierReceipt(groundedVerifierIdentity, request),
    }
    let createdTasks = 0
    let proposals = 0
    let closes = 0
    let repairReceipt: ProviderReceiptBinding | undefined
    const codex = {
      identity: codexIdentity,
      probe: async () => ({ available: true }),
      createFreshTask: async (request: {
        documentId: string
        runId: string
        priorTraceSha256: string
      }) => {
        createdTasks += 1
        return {
          taskIdSha256: digest('one-owner-local-task'),
          documentId: request.documentId,
          runId: request.runId,
          fresh: true as const,
          parentTaskId: null,
          contextPolicy: 'immutable-prior-trace-only' as const,
          acceptedTraceSha256: request.priorTraceSha256,
          identity: codexIdentity,
        }
      },
      proposeRepair: async (request: {
        task: { taskIdSha256: string }
        immutablePriorTrace: { traceSha256: string; comparator: unknown }
      }) => {
        proposals += 1
        const patch = createStructEvidencePatch({
          schemaVersion: '1.0.0',
          documentId: source.documentId,
          sourcePdfSha256: source.sha256,
          sourceEvidenceGraphSha256: selected.graph.graphSha256,
          baseStructSha256: initialMaterialization.receipt.repairCore.sha256,
          priorTraceSha256: request.immutablePriorTrace.traceSha256,
          taskIdSha256: request.task.taskIdSha256,
          operations: [
            {
              op: 'select-evidence-candidate',
              targetKind: 'block',
              targetId: headingBlock.id,
              candidateReferenceSha256: headingLevel2.referenceSha256,
            },
          ],
        })
        repairReceipt = Object.freeze({
          id: 'owner-local-codex-repair-1',
          role: 'owner-local-codex-repair' as const,
          required: true,
          enabledBeforeRun: true,
          providerId: codexIdentity.server.id,
          identitySha256: hashTraceValue(codexIdentity),
          receiptSha256: digest('owner-local-codex-repair-receipt'),
          inputSha256: hashTraceValue(request.immutablePriorTrace.comparator),
          outputSha256: patch.proposalSha256,
          prompt: codexIdentity.prompt,
          tool: codexIdentity.tool,
          model: codexIdentity.model,
          server: codexIdentity.server,
          status: 'succeeded' as const,
        })
        return {
          proposal: patch,
          usage: { inputTokens: 120, outputTokens: 30, elapsedMs: 10 },
        }
      },
      repairProviderReceipt: () => repairReceipt!,
      repairEvidence: () => [],
      close: async () => {
        closes += 1
      },
    }
    const repairedProposal = proposal()
    const sourcePdf = {
      artifact: { sha256: source.sha256, byteLength: source.byteLength },
      pageCount: 1,
      pageRenders: [
        {
          page: 1,
          sourcePdfSha256: source.sha256,
          image: { sha256: digest('source-page-1'), byteLength: 128 },
          mediaType: 'image/png' as const,
          width: 612,
          height: 792,
        },
      ],
    }
    const codexReconciliationReceiptSha256 = digest('codex-reconciliation')
    const result = await runGroundedThreeProfileRefinement({
      contract,
      initialCandidate,
      initialMaterialization,
      initialMaterializationInput: materializationInput,
      sourcePdf,
      sourceContract,
      codexIdentity,
      codexReconciliationReceiptSha256,
      codex,
      materializationVerification: {
        sourceEvidenceVerifier: sourceContract.verifier,
        evidenceCandidates: sourceContract.evidenceCandidates,
        groundedVerifier,
      },
      executeEpubCheck: async () => ({
        toolId: 'epubcheck',
        toolVersion: '5.3.0-unit',
        executableSha256: digest('unit-epubcheck'),
        exitCode: 0,
        reportBytes: new TextEncoder().encode('{"messages":[]}'),
        errorCount: 0,
        warningCount: 0,
      }),
      resolveResultingProposal: () => repairedProposal,
    })

    expect(createdTasks).toBe(0)
    expect(proposals).toBe(0)
    expect(closes).toBe(1)
    expect(result.evaluations).toHaveLength(1)
    expect(result.evaluations[0]!.coordinatorTrace.terminalState).toBe(
      'publication-ready',
    )
    expect(
      result.receipt.attempts.map(({ disposition }) => disposition),
    ).toEqual(['terminal-pass'])
    expect(result.refinement.publicReceipt.failureCode).toBe(null)
    expect(result.receipt.status).toBe('publication-ready')
    expect(result.closedReceipt?.status).toBe('publication-ready')
    const replayInput = {
      result,
      sourcePdf,
      sourceContract,
      codexIdentity,
      codexReconciliationReceiptSha256,
    }
    expect(verifyGroundedThreeProfileRefinementResult(replayInput)).toBe(true)
    const tampered = structuredClone(result)
    tampered.evaluations[0]!.profiles[0]!.render.screenshotBytes[0] ^= 1
    expect(
      verifyGroundedThreeProfileRefinementResult({
        ...replayInput,
        result: tampered,
      }),
    ).toBe(false)
    const selfRehashedLedger = structuredClone(result)
    selfRehashedLedger.receipt.attempts[0]!.disposition = 'baseline'
    const { entrySha256: _entrySha256, ...entryProjection } =
      selfRehashedLedger.receipt.attempts[0]!
    selfRehashedLedger.receipt.attempts[0]!.entrySha256 =
      hashTraceValue(entryProjection)
    const { receiptSha256: _receiptSha256, ...receiptProjection } =
      selfRehashedLedger.receipt
    selfRehashedLedger.receipt.receiptSha256 = hashTraceValue(receiptProjection)
    expect(
      verifyGroundedThreeProfileRefinementResult({
        ...replayInput,
        result: selfRehashedLedger,
      }),
    ).toBe(false)
  }, 30_000)
})
