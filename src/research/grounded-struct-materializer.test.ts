import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { path as epubCheckJarPath } from 'epubcheck-static'
import { sha256HexSync } from './sha256-sync'
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
  advanceGroundedRefinementLedger,
  assertGroundedThreeProfileEvaluationEvidence,
  evaluateGroundedThreeProfileAttempt,
  selectGroundedCoordinatorProfile,
  type GroundedThreeProfileEvaluationInput,
  verifyGroundedThreeProfileRefinementResult,
} from './grounded-reconstruction-refinement'
import {
  runRetainedOwnerLocalGroundedRefinement,
  type LoadedRetainedGroundedMaterializationPacket,
} from './retained-grounded-materialization-job'
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

/** Non-promotable unit receipt; pilot acceptance requires retained real evidence. */
function testOnlyMeasuredCodexResult(
  graphSha256: string,
  options: {
    comparisonEvidenceSha256?: string
    attemptId?: string
    selections?: Array<{ decisionId: string; candidateId: string }>
    sessionId?: string
  } = {},
) {
  const selections = options.selections ?? []
  return {
    selections,
    receipt: {
      schemaVersion: '1.0.0' as const,
      status: 'accepted' as const,
      documentIdSha256: digest('document'),
      attemptIdSha256: digest(options.attemptId ?? 'attempt'),
      isolatedSessionSha256: digest(options.sessionId ?? 'session'),
      graphSha256,
      candidateSetSha256: digest('candidate-set'),
      requestSha256: digest('request'),
      responseSha256: digest('response'),
      selectionSetSha256: hashTraceValue(selections),
      comparisonEvidenceSha256:
        options.comparisonEvidenceSha256 ?? digest('prior-comparison-evidence'),
      cropEvidenceSha256: digest('crops'),
      threadSha256: digest('thread'),
      turnSha256: digest('turn'),
      identities: {
        endpointSha256: digest('endpoint'),
        serverSha256: digest('server'),
        toolSha256: digest('tool'),
        modelSha256: digest('model'),
        promptSha256: digest('prompt'),
        renderArtifactResolverSha256: digest('resolver'),
        observedModelSha256: digest('observed-model'),
      },
      counts: {
        decisionCount: selections.length,
        candidateCount: selections.length,
        renderCount: 0,
        sourceCropCount: 0,
        epubCropCount: 0,
      },
      usage: {
        totalTokens: 2,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        durationMs: 1,
      },
    },
  }
}

async function testOnlyTableSpanEvaluation(
  input: GroundedThreeProfileEvaluationInput,
  failMobile: boolean,
) {
  const evaluation = await evaluateGroundedThreeProfileAttempt(input)
  if (!failMobile) return evaluation
  const failed = structuredClone(evaluation)
  const mobile = failed.profiles.find(
    ({ build }) => build.profileId === 'mobile',
  )!
  const cell = mobile.render.blockFacts.flatMap(({ cells }) => cells)[0]
  if (!cell) throw new Error('TEST_TABLE_CELL_REQUIRED')
  cell.columnSpan = cell.columnSpan === 1 ? 2 : 1
  const {
    domBytes: _domBytes,
    screenshotBytes: _screenshotBytes,
    receiptSha256: _receiptSha256,
    ...renderProjection
  } = mobile.render
  mobile.render.receiptSha256 = hashTraceValue(renderProjection)
  mobile.comparison = compareGroundedProfiledEpub({
    materialization: input.materialization,
    sourceContract: input.sourceContract,
    build: mobile.build,
    render: mobile.render,
    epubCheck: mobile.epubCheck,
  })
  mobile.trace = createGroundedActualReconstructionTrace({
    attemptId: `${input.attemptId}-mobile`,
    sourcePdf: input.sourcePdf,
    materialization: input.materialization,
    sourceContract: input.sourceContract,
    comparison: mobile.comparison,
    codexIdentity: input.codexIdentity,
    codexResult: input.codexResult,
    lineage: input.lineage,
    critiqueRepair: input.critiqueRepair,
    ...(input.repairProviderReceipt
      ? { repairProviderReceipt: input.repairProviderReceipt }
      : {}),
    budget: input.budget,
  })
  failed.attempt.traces.mobile = mobile.trace
  failed.vectors = failed.profiles.map(({ build, trace }) =>
    createReconstructionHardCheckVector(build.profileId, trace),
  )
  failed.coordinatorProfileId = selectGroundedCoordinatorProfile(failed.vectors)
  failed.coordinatorTrace = failed.attempt.traces[failed.coordinatorProfileId]
  failed.attempt.coordinatorProfileId = failed.coordinatorProfileId
  return failed
}

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
          authority: 'test-only-injected',
          javaExecutableSha256: null,
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
          codexResult: testOnlyMeasuredCodexResult(selected.graph.graphSha256),
          lineage: {
            attemptIndex: 0,
            parentTraceSha256: null,
            immutablePriorTraceSha256: null,
            appliedRepair: null,
          },
          critiqueRepair: null,
          budget: {
            policy: {
              maxRefinements: 3,
              maxFreshTasks: 1,
              maxTokens: 24_000,
              maxDurationMs: 30 * 60_000,
              repairPolicySha256: digest('repair-policy'),
            },
            usage: {
              refinements: 0,
              freshTasks: 0,
              tokens: 0,
              durationMs: 0,
            },
          },
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
      codexResult: testOnlyMeasuredCodexResult(selected.graph.graphSha256),
      lineage: {
        attemptIndex: 0,
        parentTraceSha256: null,
        immutablePriorTraceSha256: null,
        appliedRepair: null,
      },
      critiqueRepair: null,
      budget: {
        policy: {
          maxRefinements: 3,
          maxFreshTasks: 1,
          maxTokens: 24_000,
          maxDurationMs: 30 * 60_000,
          repairPolicySha256: digest('repair-policy'),
        },
        usage: {
          refinements: 0,
          freshTasks: 0,
          tokens: 0,
          durationMs: 0,
        },
      },
    })
    expect(failedSpanTrace).toMatchObject({
      terminalState: 'failed',
      structure: { artifact: materialized.receipt.repairCore },
      comparator: { status: 'failed' },
    })
    expect(failedSpanTrace.comparator.firstCauseFailureId).not.toBeNull()
    const zeroUsageCodexResult = testOnlyMeasuredCodexResult(
      selected.graph.graphSha256,
    )
    zeroUsageCodexResult.receipt.usage.totalTokens = 0
    zeroUsageCodexResult.receipt.usage.inputTokens = 0
    zeroUsageCodexResult.receipt.usage.outputTokens = 0
    expect(() =>
      createGroundedActualReconstructionTrace({
        attemptId: 'public-table-mobile-fabricated-codex',
        sourcePdf: failedSpanTrace.sourcePdf,
        materialization: materialized,
        sourceContract,
        comparison: failedSpanComparison,
        codexIdentity,
        codexResult: zeroUsageCodexResult,
        lineage: failedSpanTrace.lineage,
        critiqueRepair: null,
        budget: failedSpanTrace.budget,
      }),
    ).toThrow('INVALID_GROUNDED_ACTUAL_TRACE_INPUT')

    const passingVectors = builds.map((build) =>
      createReconstructionHardCheckVector(
        build.profileId,
        traces[build.profileId],
      ),
    )
    const failedVectors = [
      createReconstructionHardCheckVector('mobile', failedSpanTrace),
      ...passingVectors.filter(({ profileId }) => profileId !== 'mobile'),
    ]
    expect(selectGroundedCoordinatorProfile([...failedVectors].reverse())).toBe(
      'mobile',
    )
    expect(selectGroundedCoordinatorProfile(passingVectors)).toBe('mobile')
    const baseline = advanceGroundedRefinementLedger({
      attemptIndex: 0,
      activeBeforeCandidateBindingSha256: digest('candidate-0'),
      candidateBindingSha256: digest('candidate-0'),
      bestBeforeCandidateBindingSha256: digest('candidate-0'),
      bestVectors: null,
      candidateVectors: failedVectors,
      budgetDelta: {
        refinements: 0,
        freshTasks: 0,
        tokens: 0,
        durationMs: 0,
      },
      rejectedBudgetBefore: {
        refinements: 0,
        freshTasks: 0,
        tokens: 0,
        durationMs: 0,
      },
    })
    const rejected = advanceGroundedRefinementLedger({
      attemptIndex: 1,
      activeBeforeCandidateBindingSha256: digest('candidate-0'),
      candidateBindingSha256: digest('candidate-1'),
      bestBeforeCandidateBindingSha256:
        baseline.bestAfterCandidateBindingSha256,
      bestVectors: failedVectors,
      candidateVectors: failedVectors,
      budgetDelta: {
        refinements: 1,
        freshTasks: 1,
        tokens: 150,
        durationMs: 10,
      },
      rejectedBudgetBefore: baseline.rejectedBudgetAfter,
    })
    const promoted = advanceGroundedRefinementLedger({
      attemptIndex: 2,
      activeBeforeCandidateBindingSha256:
        rejected.activeAfterCandidateBindingSha256,
      candidateBindingSha256: digest('candidate-2'),
      bestBeforeCandidateBindingSha256:
        rejected.bestAfterCandidateBindingSha256,
      bestVectors: failedVectors,
      candidateVectors: passingVectors,
      budgetDelta: {
        refinements: 1,
        freshTasks: 0,
        tokens: 100,
        durationMs: 8,
      },
      rejectedBudgetBefore: rejected.rejectedBudgetAfter,
    })
    expect(baseline).toMatchObject({
      disposition: 'baseline',
      allThreeProfilesPassed: false,
    })
    expect(rejected).toMatchObject({
      disposition: 'rejected-exploratory',
      rejectionReason: 'first-cause-not-improved',
      activeAfterCandidateBindingSha256: digest('candidate-1'),
      bestAfterCandidateBindingSha256: digest('candidate-0'),
      rejectedBudgetAfter: {
        refinements: 1,
        freshTasks: 1,
        tokens: 150,
        durationMs: 10,
      },
    })
    expect(promoted).toMatchObject({
      disposition: 'terminal-pass',
      allThreeProfilesPassed: true,
      activeAfterCandidateBindingSha256: digest('candidate-2'),
      bestAfterCandidateBindingSha256: digest('candidate-2'),
      rejectedBudgetAfter: rejected.rejectedBudgetAfter,
    })

    await expect(
      runEpubCheckWarningsFatal(builds[0]!, async () => ({
        toolId: 'epubcheck',
        toolVersion: '5.3.0',
        authority: 'test-only-injected',
        javaExecutableSha256: null,
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
        authority: 'test-only-injected',
        javaExecutableSha256: null,
        executableSha256: digest('epubcheck-jar'),
        exitCode: 0,
        reportBytes: new TextEncoder().encode(
          '{"messages":[{"severity":"WARNING"}]}',
        ),
        errorCount: 0,
        warningCount: 1,
      })),
    ).rejects.toThrow('EPUBCHECK_WARNINGS_FATAL')
  }, 60_000)

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

  it.runIf(
    Boolean(
      process.env.RUCKSACK_EPUBCHECK_JAVA &&
      process.env.RUCKSACK_EPUBCHECK_JAVA_SHA256,
    ),
  )(
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
              expectedJavaExecutableSha256:
                process.env.RUCKSACK_EPUBCHECK_JAVA_SHA256!,
              epubCheckJarPath,
              toolVersion: '5.3.0',
            }),
          ),
        ).resolves.toMatchObject({ status: 'passed', warningCount: 0 })
      }
    },
    20_000,
  )

  it('rejects replaced Java and jar bytes before launching EPUBCheck', async () => {
    const fakeExecutablePath = fileURLToPath(
      new URL('../../package.json', import.meta.url),
    )
    await expect(
      executePinnedEpubCheck({
        epubBytes: new Uint8Array([1]),
        javaPath: fakeExecutablePath,
        expectedJavaExecutableSha256: digest('wrong-java'),
        epubCheckJarPath,
        toolVersion: '5.3.0',
      }),
    ).rejects.toThrow('EPUBCHECK_PINNED_EXECUTABLE_IDENTITY_MISMATCH')
    await expect(
      executePinnedEpubCheck({
        epubBytes: new Uint8Array([1]),
        javaPath: fakeExecutablePath,
        expectedJavaExecutableSha256: digest(
          await readFile(fakeExecutablePath),
        ),
        epubCheckJarPath: fakeExecutablePath,
        toolVersion: '5.3.0',
      }),
    ).rejects.toThrow('EPUBCHECK_PINNED_EXECUTABLE_IDENTITY_MISMATCH')
  })

  it('rejects Java executable replacement during EPUBCheck execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rucksack-fake-java-'))
    const fakeJavaPath = join(directory, 'java')
    const fakeJava = new TextEncoder().encode(
      '#!/bin/sh\nprintf \'#!/bin/sh\\nexit 0\\n\' > "$0"\nprintf \'{"messages":[]}\' > "$4"\n',
    )
    try {
      await writeFile(fakeJavaPath, fakeJava, { flag: 'wx' })
      await chmod(fakeJavaPath, 0o700)
      await expect(
        executePinnedEpubCheck({
          epubBytes: new Uint8Array([1]),
          javaPath: fakeJavaPath,
          expectedJavaExecutableSha256: digest(fakeJava),
          epubCheckJarPath,
          toolVersion: '5.3.0',
        }),
      ).rejects.toThrow('EPUBCHECK_EXECUTABLE_CHANGED_DURING_RUN')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

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

  it('continues one #199 task through a rejected sibling to terminal promotion', async () => {
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
    const repairReceipts = new Map<string, ProviderReceiptBinding>()
    const repairEvidence: Array<{
      sessionSha256: string
      proposalSha256: string
      result: ReturnType<typeof testOnlyMeasuredCodexResult>
      providerReceipt: ProviderReceiptBinding
      evidenceSha256: string
    }> = []
    const sessionSha256 = digest('one-owner-local-session')
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
        immutablePriorTrace: {
          attemptId: string
          traceSha256: string
          comparator: unknown
          structure: { artifact: { sha256: string } }
        }
      }) => {
        proposals += 1
        const selectedReference =
          proposals === 1 ? headingLevel2 : headingLevel3
        const patch = createStructEvidencePatch({
          schemaVersion: '1.0.0',
          documentId: source.documentId,
          sourcePdfSha256: source.sha256,
          sourceEvidenceGraphSha256: selected.graph.graphSha256,
          baseStructSha256:
            request.immutablePriorTrace.structure.artifact.sha256,
          priorTraceSha256: request.immutablePriorTrace.traceSha256,
          taskIdSha256: request.task.taskIdSha256,
          operations: [
            {
              op: 'select-evidence-candidate',
              targetKind: 'block',
              targetId: headingBlock.id,
              candidateReferenceSha256: selectedReference.referenceSha256,
            },
          ],
        })
        const localResult = testOnlyMeasuredCodexResult(
          selected.graph.graphSha256,
          {
            comparisonEvidenceSha256: request.immutablePriorTrace.traceSha256,
            attemptId: request.immutablePriorTrace.attemptId,
            sessionId: 'one-owner-local-session',
            selections: [
              {
                decisionId: `heading-repair-${proposals}`,
                candidateId: selectedReference.candidateId,
              },
            ],
          },
        )
        const providerProjection = {
          schemaVersion: '1.0.0',
          sessionSha256,
          localReceipt: localResult.receipt,
          proposalSha256: patch.proposalSha256,
        }
        const providerReceipt = Object.freeze({
          id: `owner-local-codex-repair-${proposals}`,
          role: 'owner-local-codex-repair' as const,
          required: true,
          enabledBeforeRun: true,
          providerId: codexIdentity.server.id,
          identitySha256: hashTraceValue(codexIdentity),
          receiptSha256: hashTraceValue(providerProjection),
          inputSha256: hashTraceValue(request.immutablePriorTrace.comparator),
          outputSha256: patch.proposalSha256,
          prompt: codexIdentity.prompt,
          tool: codexIdentity.tool,
          model: codexIdentity.model,
          server: codexIdentity.server,
          status: 'succeeded' as const,
        })
        repairReceipts.set(patch.proposalSha256, providerReceipt)
        const evidenceProjection = {
          sessionSha256,
          proposalSha256: patch.proposalSha256,
          result: localResult,
          providerReceipt,
        }
        repairEvidence.push({
          ...evidenceProjection,
          evidenceSha256: hashTraceValue(evidenceProjection),
        })
        return {
          proposal: patch,
          usage: { inputTokens: 1, outputTokens: 1, elapsedMs: 1 },
        }
      },
      repairProviderReceipt: (patch: { proposalSha256: string }) =>
        repairReceipts.get(patch.proposalSha256)!,
      repairEvidence: () => structuredClone(repairEvidence),
      close: async () => {
        closes += 1
      },
    }
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
    const epubCheckAuthority = {
      kind: 'test-only-injected' as const,
      execute: async () => ({
        toolId: 'epubcheck' as const,
        toolVersion: '5.3.0-unit',
        executableSha256: digest('unit-epubcheck'),
        exitCode: 0,
        reportBytes: new TextEncoder().encode('{"messages":[]}'),
        errorCount: 0,
        warningCount: 0,
      }),
    }
    const seedCodexResult = testOnlyMeasuredCodexResult(
      selected.graph.graphSha256,
    )
    const priorEvaluation = await testOnlyTableSpanEvaluation(
      {
        attemptId: 'observed-pre-codex-baseline',
        sourcePdf,
        materialization: initialMaterialization,
        sourceContract,
        codexIdentity,
        codexResult: seedCodexResult,
        lineage: {
          attemptIndex: 0,
          parentTraceSha256: null,
          immutablePriorTraceSha256: null,
          appliedRepair: null,
        },
        critiqueRepair: null,
        budget: {
          policy: {
            maxRefinements: 3,
            maxFreshTasks: 1,
            maxTokens: 24_000,
            maxDurationMs: 30 * 60_000,
            repairPolicySha256: digest('repair-policy'),
          },
          usage: {
            refinements: 0,
            freshTasks: 0,
            tokens: 0,
            durationMs: 0,
          },
        },
        epubCheckAuthority,
      },
      true,
    )
    const initialCodexResult = testOnlyMeasuredCodexResult(
      selected.graph.graphSha256,
      {
        comparisonEvidenceSha256: priorEvaluation.coordinatorTrace.traceSha256,
        attemptId: priorEvaluation.coordinatorTrace.attemptId,
        selections: [
          {
            decisionId: 'initial-heading-selection',
            candidateId: headingLevel3.candidateId,
          },
        ],
      },
    )
    assertGroundedThreeProfileEvaluationEvidence({
      evaluation: priorEvaluation,
      sourcePdf,
      sourceContract,
      codexIdentity,
    })
    const packet = {
      caseId: 'prose-hierarchy' as const,
      sourcePdfBytes: new Uint8Array(source.byteLength),
      sourceExecution: {
        kind: 'retained-real-provider-packet' as const,
        artifactRoot: '/test-only/retained',
        manifestBytes: new Uint8Array([1]),
        sourceEvidenceGraphBytes: sourceContract.graphBytes,
        sourceEvidenceContractBytes: new Uint8Array([1]),
        expectedObservationPayloads: sourceContract.expectedObservationSets.map(
          ({ check, payloadBytes }) => ({ check, payloadBytes }),
        ),
      },
      sourceContract,
      receipt: {
        schemaVersion: '1.0.0' as const,
        caseId: 'prose-hierarchy' as const,
        sourcePdfSha256: source.sha256,
        sourceGraphSha256: sourceContract.graphArtifact.sha256,
        retainedContractSha256: digest('test-retained-contract'),
        manifestSha256: digest('test-manifest'),
        producerReceiptSha256: digest('test-producer'),
        artifactSetSha256: digest('test-artifact-set'),
        observationSetSha256: digest('test-observations'),
        receiptSha256: digest('test-packet-receipt'),
      },
    } satisfies LoadedRetainedGroundedMaterializationPacket
    let evaluatedAttempts = 0
    const jobInput = {
      contract,
      initialCandidate,
      initialMaterialization,
      initialMaterializationInput: materializationInput,
      sourcePdf,
      codexIdentity,
      codexClient: undefined as never,
      materializationVerification: {
        sourceEvidenceVerifier: sourceContract.verifier,
        evidenceCandidates: sourceContract.evidenceCandidates,
        groundedVerifier,
      },
      epubCheckAuthority,
      retainedPacket: {
        caseId: 'prose-hierarchy',
        sourcePdfPath: '/test-only/source.pdf',
        artifactRoot: '/test-only/retained',
        packetDirectory: '/test-only/packet',
      },
      observedPriorEvaluation: priorEvaluation,
      buildInitialReconciliationRequest: () => {
        throw new Error('TEST_ONLY_REQUEST_BUILDER_MUST_NOT_RUN')
      },
      resolveResultingProposal: ({ patch }) => {
        const resultingProposal = proposal()
        resultingProposal.nodes.find(({ id }) => id === 'heading-node')!.level =
          patch.operations[0]!.candidateReferenceSha256 ===
          headingLevel2.referenceSha256
            ? 2
            : 3
        return resultingProposal
      },
      testOnly: {
        packet,
        initialCodexResult,
        codex,
        evaluateAttempt: async (evaluationInput) => {
          evaluatedAttempts += 1
          return testOnlyTableSpanEvaluation(
            evaluationInput,
            evaluatedAttempts < 4,
          )
        },
      },
    } satisfies Parameters<typeof runRetainedOwnerLocalGroundedRefinement>[0]
    const forgedInitialCodexResult = structuredClone(initialCodexResult)
    forgedInitialCodexResult.receipt.counts.decisionCount = 9
    forgedInitialCodexResult.receipt.selectionSetSha256 = digest(
      'forged-positive-selection-digest',
    )
    await expect(
      runRetainedOwnerLocalGroundedRefinement({
        ...jobInput,
        testOnly: {
          ...jobInput.testOnly,
          initialCodexResult: forgedInitialCodexResult,
        },
      }),
    ).rejects.toThrow('RETAINED_GROUNDED_TEST_RECEIPT_FORGED')
    const alreadyValid = await runRetainedOwnerLocalGroundedRefinement({
      ...jobInput,
      testOnly: {
        ...jobInput.testOnly,
        evaluateAttempt: (evaluationInput) =>
          testOnlyTableSpanEvaluation(evaluationInput, false),
      },
    })
    expect(alreadyValid.status).toBe('already-valid')
    expect('result' in alreadyValid).toBe(false)
    const execution = await runRetainedOwnerLocalGroundedRefinement(jobInput)
    expect(execution.status).toBe('refined')
    if (execution.status !== 'refined') throw new Error('EXPECTED_REFINEMENT')
    const { result } = execution

    expect(createdTasks).toBe(1)
    expect(proposals).toBe(2)
    expect(closes).toBe(1)
    expect(result.evaluations).toHaveLength(3)
    expect(
      result.evaluations[0]!.profiles.map(({ build }) => build.profileId),
    ).toEqual(['mobile', 'paperProMove', 'paperPro'])
    expect(result.evaluations[0]!.coordinatorProfileId).toBe('mobile')
    expect(
      new Set(
        result.evaluations[0]!.profiles.map(({ trace }) => trace.traceSha256),
      ).size,
    ).toBe(3)
    expect(
      result.evaluations[0]!.profiles.every(
        ({ trace }) =>
          trace.providerReceipts.find(
            ({ role }) => role === 'owner-local-codex-reconciliation',
          )?.receiptSha256 === hashTraceValue(initialCodexResult.receipt),
      ),
    ).toBe(true)
    expect(result.evaluations[0]!.coordinatorTrace.terminalState).toBe('failed')
    expect(
      result.receipt.attempts.map(({ disposition }) => disposition),
    ).toEqual(['baseline', 'rejected-exploratory', 'terminal-pass'])
    expect(result.receipt.attempts[0]).toMatchObject({
      parentCandidateBindingSha256: null,
      activeBeforeCandidateBindingSha256:
        initialCandidate.binding.bindingSha256,
      activeAfterCandidateBindingSha256: initialCandidate.binding.bindingSha256,
      bestBeforeCandidateBindingSha256: initialCandidate.binding.bindingSha256,
      bestAfterCandidateBindingSha256: initialCandidate.binding.bindingSha256,
      allThreeProfilesPassed: false,
      rejectedBudgetAfter: {
        refinements: 0,
        freshTasks: 0,
        tokens: 0,
        durationMs: 0,
      },
    })
    expect(result.receipt).toMatchObject({
      activeCandidateBindingSha256:
        result.receipt.attempts[2]!.candidateBindingSha256,
      bestCandidateBindingSha256:
        result.receipt.attempts[2]!.candidateBindingSha256,
      rejectedBudget: result.receipt.attempts[1]!.rejectedBudgetAfter,
    })
    expect(result.receipt.rejectedBudget).toMatchObject({
      refinements: 1,
      freshTasks: 1,
      tokens: 2,
    })
    expect(result.receipt.rejectedBudget.durationMs).toBeGreaterThan(0)
    expect(result.receipt.attempts[1]).toMatchObject({
      activeBeforeCandidateBindingSha256:
        result.receipt.attempts[0]!.candidateBindingSha256,
      activeAfterCandidateBindingSha256:
        result.receipt.attempts[1]!.candidateBindingSha256,
      bestAfterCandidateBindingSha256:
        result.receipt.attempts[0]!.candidateBindingSha256,
      disposition: 'rejected-exploratory',
      rejectionReason: 'hard-gate-regression',
    })
    expect(result.receipt.attempts[2]).toMatchObject({
      activeBeforeCandidateBindingSha256:
        result.receipt.attempts[1]!.candidateBindingSha256,
      bestAfterCandidateBindingSha256:
        result.receipt.attempts[2]!.candidateBindingSha256,
      disposition: 'terminal-pass',
      allThreeProfilesPassed: true,
    })
    expect(result.refinement.publicReceipt.failureCode).toBe(null)
    expect(result.receipt.status).toBe('failed')
    expect(result.closedReceipt).toBeNull()
    const replayInput = {
      result,
      sourcePdf,
      sourceContract,
      codexIdentity,
      expectedJavaExecutableSha256: digest('test-java-policy'),
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
    const multipleThreads = structuredClone(result)
    const crossThreadEvidence = multipleThreads.codexRepairEvidence[0]!
    Object.assign(crossThreadEvidence.result.receipt, {
      threadSha256: digest('different-owner-local-thread'),
    })
    crossThreadEvidence.providerReceipt.receiptSha256 = hashTraceValue({
      schemaVersion: '1.0.0',
      sessionSha256: crossThreadEvidence.sessionSha256,
      localReceipt: crossThreadEvidence.result.receipt,
      proposalSha256: crossThreadEvidence.proposalSha256,
    })
    const { evidenceSha256: _crossThreadSha256, ...crossThreadProjection } =
      crossThreadEvidence
    crossThreadEvidence.evidenceSha256 = hashTraceValue(crossThreadProjection)
    expect(
      verifyGroundedThreeProfileRefinementResult({
        ...replayInput,
        result: multipleThreads,
      }),
    ).toBe(false)
    const selfRehashedLedger = structuredClone(result)
    selfRehashedLedger.receipt.attempts[0]!.disposition = 'accepted-best'
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
  }, 300_000)
})
