import { describe, expect, it } from 'vitest'
import { path as epubCheckJarPath } from 'epubcheck-static'
import { sha256HexSync } from '../struct/sha256'
import { hashTraceValue } from './reconstruction-attempt-trace'
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
          canonicalStructSha256: materialized.receipt.canonicalStruct.sha256,
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
    expect(() =>
      compareGroundedProfiledEpub({
        materialization: materialized,
        sourceContract,
        build: builds[0]!,
        render: spanTamper,
        epubCheck: epubChecks[0]!,
      }),
    ).toThrow('ACTUAL_RENDER_SOURCE_OBSERVATION_MISMATCH')

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
})
