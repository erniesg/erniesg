import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { path as epubCheckJarPath } from 'epubcheck-static'
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { executePinnedEpubCheck } from './actual-profiled-epub'
import {
  GROUNDED_MATERIALIZATION_PILOT_CASES,
  verifyGroundedMaterializationPilotMineruExecution,
  type GroundedMaterializationPilotCase,
  type GroundedMaterializationPilotDocument,
} from './grounded-materialization-pilot'
import {
  materializeGroundedStruct,
  type GroundedStructCandidateSelection,
} from './grounded-struct-materializer'
import { createClosedThreeProfileReconstructionReceipt } from './reconstruction-materialization'
import { evaluateGroundedThreeProfileAttempt } from './grounded-reconstruction-refinement'
import {
  RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
  createReconstructionAttemptTrace,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashTraceValue,
  type ReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import { sha256HexSync } from './sha256-sync'
import { createSourceEvidenceContract } from './source-evidence-contract'
import { compareSourceToRenderedEpub } from './source-epub-comparator'
import {
  createLocalCodexReconciliationClient,
  createOwnerLocalUnixSocketTransport,
  type LocalCodexRenderEvidence,
} from './local-codex-reconciliation'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  type PdfEvidenceBundle,
  type PdfEvidenceCandidate,
  type PdfEvidenceObligation,
  type PdfEvidenceSource,
  readSourceEvidenceGraph,
} from './source-evidence-graph'
import type {
  StructuredExtractionContext,
  StructuredExtractionProposal,
} from './structured-extraction'

const digest = (value: string | Uint8Array) => sha256HexSync(value)
const verifierIdentity = {
  id: 'pilot-source-evidence-verifier',
  version: '1.0.0',
  configurationSha256: digest('pilot-source-verifier-config'),
  executableSha256: digest('pilot-source-verifier-executable'),
}
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
const imageBytes = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
)

const titleBox = {
  page: 1,
  x: 0.1,
  y: 0.08,
  width: 0.8,
  height: 0.05,
  rotation: 0,
  method: 'pdf-text' as const,
}
const contentBox = {
  page: 1,
  x: 0.1,
  y: 0.2,
  width: 0.8,
  height: 0.2,
  rotation: 0,
  method: 'pdf-text' as const,
}

async function publicPdf(label: string) {
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText(`Rucksack public pilot: ${label}`, {
    x: 72,
    y: 720,
    size: 18,
    font,
  })
  return new Uint8Array(await document.save({ useObjectStreams: false }))
}

type PilotFixture = {
  graph: ReturnType<typeof buildSourceEvidenceGraph>
  context: StructuredExtractionContext
  proposal: StructuredExtractionProposal
  selections: GroundedStructCandidateSelection[]
  assetBytes?: Record<string, Uint8Array>
}

function pilotFixture(
  caseId: GroundedMaterializationPilotCase,
  sourcePdfBytes: Uint8Array,
  visualCrop?: 'table' | 'equation',
): PilotFixture {
  const source = {
    documentId: `pilot-${caseId}`,
    sha256: digest(sourcePdfBytes),
    byteLength: sourcePdfBytes.byteLength,
    pageCount: 1,
  }
  const title = `Pilot ${caseId}`
  const sources: PdfEvidenceSource[] = [
    {
      id: 'title-source',
      providerId: 'pdfjs-provider',
      kind: 'title',
      page: 1,
      box: titleBox,
      payload: { text: title },
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
      payload: { family: 'Helvetica' },
    },
  ]
  const candidates: PdfEvidenceCandidate[] = [
    {
      id: 'title-candidate',
      providerId: 'pdfjs-provider',
      kind: 'title',
      page: 1,
      boxes: [titleBox],
      sourceIds: ['title-source'],
      payload: { text: title },
    },
  ]
  const obligations: PdfEvidenceObligation[] = [
    {
      id: 'title-obligation',
      kind: 'title',
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
  ]
  const sourceRuns: StructuredExtractionContext['sourceRuns'] = [
    {
      id: 'title-run',
      text: title,
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
  ]
  const nodes: StructuredExtractionProposal['nodes'] = [
    { id: 'title-node', type: 'title', sourceRunIds: ['title-run'] },
  ]
  const selectionTargets: Array<{
    targetKind: 'block' | 'asset' | 'relationship'
    targetId: string
    candidateId: string
  }> = [
    {
      targetKind: 'block',
      targetId: 'title-node',
      candidateId: 'title-candidate',
    },
  ]
  const sourceAssets: StructuredExtractionContext['sourceAssets'] = []
  const provenArtifacts: NonNullable<
    StructuredExtractionContext['provenArtifacts']
  > = []
  let sourceLinks: StructuredExtractionContext['sourceLinks']
  let proposalLinks: StructuredExtractionProposal['links']
  let proposalAssetIds: string[] | undefined
  const content =
    caseId === 'prose-hierarchy'
      ? 'Verified hierarchy'
      : caseId === 'formula-text'
        ? 'E = mc²'
        : caseId === 'source-backed-figure'
          ? 'System architecture'
          : caseId === 'link-destinations'
            ? 'Open the public reference'
            : 'Header Body'
  sources.push({
    id: 'content-source',
    providerId: 'pdfjs-provider',
    kind: caseId,
    page: 1,
    box: contentBox,
    payload:
      caseId === 'semantic-table-spans'
        ? {
            sourceText: content,
            semanticTable: {
              rows: [
                {
                  cells: [
                    {
                      text: 'Header',
                      rowSpan: 1,
                      columnSpan: 2,
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
            },
          }
        : {
            text: content,
            ...(caseId === 'prose-hierarchy' ? { level: 2 } : {}),
          },
  })
  candidates.push({
    id: 'content-candidate',
    providerId: 'pdfjs-provider',
    kind: caseId,
    page: 1,
    boxes: [contentBox],
    sourceIds: ['content-source'],
    ...(caseId === 'source-backed-figure' || visualCrop
      ? {
          artifactIds: [
            caseId === 'source-backed-figure'
              ? 'diagram-artifact'
              : 'visual-artifact',
          ],
        }
      : {}),
    payload: sources.at(-1)!.payload,
  })
  sourceRuns.push({
    id: 'content-run',
    text: content,
    page: 1,
    order: 1,
    regionId: 'content-region',
    bounds: {
      x: contentBox.x,
      y: contentBox.y,
      width: contentBox.width,
      height: contentBox.height,
    },
  })
  const categories: PdfEvidenceObligation['observationCategories'] =
    caseId === 'semantic-table-spans'
      ? [
          'object-counts',
          'table-cells',
          'table-spans',
          'table-headers',
          'clipping',
          'overflow',
        ]
      : caseId === 'formula-text'
        ? ['text-exactness', 'formulas', 'clipping', 'overflow']
        : caseId === 'source-backed-figure'
          ? [
              'figures',
              'diagrams',
              'captions',
              'asset-bytes',
              'clipping',
              'overflow',
            ]
          : caseId === 'link-destinations'
            ? [
                'text-exactness',
                'links',
                'dangling-targets',
                'clipping',
                'overflow',
              ]
            : [
                'text-exactness',
                'reading-order',
                'hierarchy',
                'clipping',
                'overflow',
              ]
  obligations.push({
    id: 'content-obligation',
    kind: caseId,
    page: 1,
    sourceIds: ['content-source'],
    artifactIds:
      caseId === 'source-backed-figure'
        ? ['diagram-artifact']
        : visualCrop
          ? ['visual-artifact']
          : [],
    candidateIds: ['content-candidate'],
    observationCategories: categories,
    required: true,
    semantic: true,
  })
  if (caseId === 'semantic-table-spans') {
    sourceRuns[1]!.text = 'Header'
    sourceRuns[1]!.bounds = {
      x: contentBox.x,
      y: contentBox.y,
      width: contentBox.width,
      height: contentBox.height / 2,
    }
    sourceRuns.push({
      id: 'body-run',
      text: 'Body',
      page: 1,
      order: 2,
      regionId: 'content-region',
      bounds: {
        x: contentBox.x,
        y: contentBox.y + contentBox.height / 2,
        width: contentBox.width,
        height: contentBox.height / 2,
      },
    })
    provenArtifacts.push({
      id: 'table-scope',
      kind: 'table-scope',
      sourceRunIds: ['content-run', 'body-run'],
      tableRows: [
        {
          cells: [
            {
              sourceRunIds: ['content-run'],
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
    })
    nodes.push({
      id: 'content-node',
      type: 'table',
      sourceRunIds: ['content-run', 'body-run'],
      table: {
        rows: [
          {
            cells: [
              {
                sourceRunIds: ['content-run'],
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
    })
  } else {
    nodes.push({
      id: 'content-node',
      type:
        caseId === 'prose-hierarchy'
          ? 'heading'
          : caseId === 'formula-text'
            ? 'equation'
            : caseId === 'source-backed-figure'
              ? 'figure'
              : 'paragraph',
      sourceRunIds: ['content-run'],
      ...(caseId === 'prose-hierarchy' ? { level: 2 } : {}),
      ...(caseId === 'source-backed-figure'
        ? {
            assetId: 'diagram-asset',
            captionNodeId: 'caption-node',
            altText: 'Source-backed system diagram',
            altTextSource: 'caption' as const,
          }
        : {}),
    })
  }
  selectionTargets.push({
    targetKind: 'block',
    targetId: 'content-node',
    candidateId: 'content-candidate',
  })
  if (visualCrop) {
    const contentNode = nodes.find(({ id }) => id === 'content-node')!
    contentNode.assetId = 'visual-asset'
    sourceAssets.push({
      id: 'visual-asset',
      kind: visualCrop,
      page: 1,
      bounds: {
        x: contentBox.x,
        y: contentBox.y,
        width: contentBox.width,
        height: contentBox.height,
      },
      bytesSha256: digest(imageBytes),
      sourceObjectIds: ['content-source'],
      required: true,
    })
    proposalAssetIds = ['visual-asset']
    selectionTargets.push({
      targetKind: 'asset',
      targetId: 'visual-asset',
      candidateId: 'content-candidate',
    })
  }
  if (caseId === 'source-backed-figure') {
    const captionBox = {
      ...contentBox,
      y: contentBox.y + contentBox.height,
      height: 0.04,
    }
    sources.push({
      id: 'caption-source',
      providerId: 'pdfjs-provider',
      kind: 'caption',
      page: 1,
      box: captionBox,
      payload: { text: 'Source-backed system diagram' },
    })
    candidates.push({
      id: 'caption-candidate',
      providerId: 'pdfjs-provider',
      kind: 'caption',
      page: 1,
      boxes: [captionBox],
      sourceIds: ['caption-source'],
      payload: { text: 'Source-backed system diagram' },
    })
    sourceRuns.push({
      id: 'caption-run',
      text: 'Source-backed system diagram',
      page: 1,
      order: 2,
      regionId: 'caption-region',
      bounds: {
        x: captionBox.x,
        y: captionBox.y,
        width: captionBox.width,
        height: captionBox.height,
      },
    })
    nodes.push({
      id: 'caption-node',
      type: 'paragraph',
      sourceRunIds: ['caption-run'],
    })
    obligations.push({
      id: 'caption-obligation',
      kind: 'caption',
      page: 1,
      sourceIds: ['caption-source'],
      artifactIds: [],
      candidateIds: ['caption-candidate'],
      observationCategories: ['text-exactness'],
      required: true,
      semantic: true,
    })
    selectionTargets.push({
      targetKind: 'block',
      targetId: 'caption-node',
      candidateId: 'caption-candidate',
    })
    sourceAssets.push({
      id: 'diagram-asset',
      kind: 'diagram',
      page: 1,
      bounds: {
        x: contentBox.x,
        y: contentBox.y,
        width: contentBox.width,
        height: contentBox.height,
      },
      bytesSha256: digest(imageBytes),
      sourceObjectIds: ['content-source'],
      captionRunIds: ['caption-run'],
      required: true,
    })
    proposalAssetIds = ['diagram-asset']
    selectionTargets.push({
      targetKind: 'asset',
      targetId: 'diagram-asset',
      candidateId: 'content-candidate',
    })
  }
  if (caseId === 'link-destinations') {
    sourceLinks = [
      {
        id: 'public-link',
        page: 1,
        sourceRunIds: ['content-run'],
        box: {
          x: contentBox.x,
          y: contentBox.y,
          width: contentBox.width,
          height: contentBox.height,
        },
        destination: { kind: 'external', url: 'https://example.test/public' },
      },
    ]
    proposalLinks = [
      { sourceLinkId: 'public-link', sourceNodeId: 'content-node' },
    ]
    sources.push({
      id: 'link-source',
      providerId: 'pdfjs-provider',
      kind: 'link',
      page: 1,
      box: contentBox,
      payload: { url: 'https://example.test/public' },
    })
    candidates.push({
      id: 'link-candidate',
      providerId: 'pdfjs-provider',
      kind: 'link',
      page: 1,
      boxes: [contentBox],
      sourceIds: ['link-source'],
      payload: { url: 'https://example.test/public' },
    })
    obligations.push({
      id: 'link-obligation',
      kind: 'link',
      page: 1,
      sourceIds: ['link-source'],
      artifactIds: [],
      candidateIds: ['link-candidate'],
      observationCategories: ['links', 'dangling-targets'],
      required: true,
      semantic: true,
    })
    selectionTargets.push({
      targetKind: 'relationship',
      targetId: 'public-link',
      candidateId: 'link-candidate',
    })
  }
  provenArtifacts.push({
    id: 'source-run-provenance',
    kind: 'source-run-provenance',
    sourceRunIds: sourceRuns.map(({ id }) => id),
  })
  obligations.push(
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
  )
  const deterministicBundle: PdfEvidenceBundle = {
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
        sha256: digest(imageBytes),
        byteLength: imageBytes.byteLength,
        page: 1,
        box: { ...titleBox, x: 0, y: 0, width: 1, height: 1 },
        sourceIds: ['title-source'],
      },
      ...(caseId === 'source-backed-figure'
        ? [
            {
              id: 'diagram-artifact',
              providerId: 'pdfjs-provider',
              kind: 'diagram',
              mediaType: 'image/png',
              sha256: digest(imageBytes),
              byteLength: imageBytes.byteLength,
              page: 1,
              box: contentBox,
              sourceIds: ['content-source'],
            },
          ]
        : visualCrop
          ? [
              {
                id: 'visual-artifact',
                providerId: 'pdfjs-provider',
                kind: visualCrop,
                mediaType: 'image/png',
                sha256: digest(imageBytes),
                byteLength: imageBytes.byteLength,
                page: 1,
                box: contentBox,
                sourceIds: ['content-source'],
              },
            ]
          : []),
    ],
    sources,
    candidates,
  }
  const mineruBundle: PdfEvidenceBundle = {
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
        sha256: digest('mineru-artifact'),
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
        payload: { text: 'Wrong title' },
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
        payload: { text: 'Wrong title' },
      },
    ],
  }
  const graph = buildSourceEvidenceGraph({
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source,
    deterministicContext:
      deterministicContextReceiptForBundle(deterministicBundle),
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
    bundles: [deterministicBundle, mineruBundle],
    obligations,
    disagreements: [],
  })
  const contract = createSourceEvidenceContract(graph, verifierIdentity)
  const selections = selectionTargets.map(
    ({ targetKind, targetId, candidateId }) => {
      const reference = contract.candidateReferences.find(
        (candidate) => candidate.candidateId === candidateId,
      )!
      return {
        op: 'select-evidence-candidate' as const,
        targetKind,
        targetId,
        candidateReferenceSha256: reference.referenceSha256,
        bindingSha256: reference.bindingSha256,
      }
    },
  )
  return {
    graph,
    context: {
      documentId: source.documentId,
      sourceSha256: source.sha256,
      split: 'development',
      layout: 'one-column',
      sourceRuns,
      sourceAssets,
      ...(sourceLinks ? { sourceLinks } : {}),
      provenArtifacts,
    },
    proposal: {
      schemaVersion: '1.0.0',
      nodes,
      ...(proposalAssetIds ? { assetIds: proposalAssetIds } : {}),
      ...(proposalLinks ? { links: proposalLinks } : {}),
    },
    selections,
    ...(caseId === 'source-backed-figure' || visualCrop
      ? {
          assetBytes: {
            [caseId === 'source-backed-figure'
              ? 'diagram-asset'
              : 'visual-asset']: imageBytes,
          },
        }
      : {}),
  }
}

function failedPriorTrace(
  finalTrace: ReconstructionAttemptTrace,
): ReconstructionAttemptTrace {
  const { traceSha256: _traceSha256, ...prior } = structuredClone(finalTrace)
  const actual = prior.renderedEpub.actualObservationSets.find(
    ({ check }) => check === 'text-exactness',
  )!
  actual.setSha256 = digest(`prior-failed-${finalTrace.attemptId}`)
  actual.payload.sha256 = actual.setSha256
  actual.receiptSha256 = hashRenderedActualObservationSet(actual)
  prior.renderedEpub.receiptSha256 = hashRenderedEpubEvidence(
    prior.renderedEpub,
  )
  const observation = prior.comparisonEvidence.observations.find(
    ({ check }) => check === 'text-exactness',
  )!
  observation.actualSetReceiptSha256 = actual.receiptSha256
  const { receiptSha256: _observationReceipt, ...observationCore } = observation
  observation.receiptSha256 = hashTraceValue(observationCore)
  prior.comparator = compareSourceToRenderedEpub({
    sourcePdfSha256: prior.sourcePdf.artifact.sha256,
    sourceEvidence: prior.sourceEvidence,
    structure: prior.structure,
    epub: prior.epub,
    renderedEpub: prior.renderedEpub,
    sourceRegions: prior.comparisonEvidence.sourceRegions,
    mappings: prior.mappings,
    observations: prior.comparisonEvidence.observations,
  })
  const renderProvider = prior.providerReceipts.find(
    ({ role }) => role === 'actual-render',
  )!
  renderProvider.outputSha256 = prior.renderedEpub.receiptSha256
  const codexProvider = prior.providerReceipts.find(
    ({ role }) => role === 'owner-local-codex-reconciliation',
  )!
  codexProvider.inputSha256 = hashTraceValue({
    sourcePdfSha256: prior.sourcePdf.artifact.sha256,
    evidenceGraphSha256: prior.evidenceGraph.artifact.sha256,
    candidateSetSha256: prior.sourceEvidence.candidateSetSha256,
    structSha256: prior.structure.artifact.sha256,
    epubSha256: prior.epub.bytes.sha256,
    renderObservationReceiptSha256: prior.renderedEpub.receiptSha256,
  })
  codexProvider.outputSha256 = hashTraceValue(prior.comparator)
  prior.attemptId = `${finalTrace.attemptId}-prior`
  prior.terminalState = 'failed'
  return createReconstructionAttemptTrace({
    ...prior,
    schemaVersion: RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
  })
}

async function cropImage(
  bytes: Uint8Array,
  dimensions: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
) {
  const left = Math.floor(box.x * dimensions.width + 1e-9)
  const top = Math.floor(box.y * dimensions.height + 1e-9)
  const right = Math.ceil((box.x + box.width) * dimensions.width - 1e-9)
  const bottom = Math.ceil((box.y + box.height) * dimensions.height - 1e-9)
  return new Uint8Array(
    await sharp(bytes)
      .extract({
        left,
        top,
        width: right - left,
        height: bottom - top,
      })
      .png()
      .toBuffer(),
  )
}

async function actualLocalCodexResult(input: {
  endpoint: string
  materialization: ReturnType<typeof materializeGroundedStruct>
  sourceContract: ReturnType<typeof createSourceEvidenceContract>
  priorTrace: ReconstructionAttemptTrace
  sourcePageBytes: Uint8Array
  screenshotBytes: Uint8Array
}) {
  const {
    endpoint,
    materialization,
    sourceContract,
    priorTrace,
    sourcePageBytes,
    screenshotBytes,
  } = input
  const candidateByReference = new Map(
    sourceContract.candidateReferences.map((reference) => [
      reference.referenceSha256,
      reference.candidateId,
    ]),
  )
  const decisions = materialization.receipt.obligationBindings.map(
    (binding) => ({
      decisionId: binding.obligationId,
      candidateIds: [
        ...new Set(
          binding.candidateReferenceSha256.map((reference) =>
            candidateByReference.get(reference)!,
          ),
        ),
      ],
    }),
  )
  const candidateIds = [
    ...new Set(decisions.flatMap(({ candidateIds }) => candidateIds)),
  ]
  const failure = priorTrace.comparator.failures.find(
    ({ check }) => check === 'text-exactness',
  )!
  const sourceBox = failure.source!.boxes[0]!
  const output = failure.output[0]!
  const locator = output.rendered!
  const epubBox = {
    x: locator.rect.x / locator.viewport.width,
    y: locator.rect.y / locator.viewport.height,
    width: locator.rect.width / locator.viewport.width,
    height: locator.rect.height / locator.viewport.height,
  }
  const sourceCrop = await cropImage(
    sourcePageBytes,
    {
      width: priorTrace.sourcePdf.pageRenders[0]!.width,
      height: priorTrace.sourcePdf.pageRenders[0]!.height,
    },
    sourceBox,
  )
  const screenshot = priorTrace.renderedEpub.screenshots.find(
    ({ id }) => id === locator.screenshotId,
  )!
  const epubCrop = await cropImage(
    screenshotBytes,
    { width: screenshot.width, height: screenshot.height },
    epubBox,
  )
  const renders: LocalCodexRenderEvidence[] = [
    {
      id: 'source-first-cause',
      mimeType: 'image/png',
      dataBase64: Buffer.from(sourceCrop).toString('base64'),
      sha256: digest(sourceCrop),
      page: sourceBox.page,
      box: {
        x: sourceBox.x,
        y: sourceBox.y,
        width: sourceBox.width,
        height: sourceBox.height,
      },
      candidateIds,
      provenance: {
        kind: 'source-pdf',
        sourcePdfSha256: priorTrace.sourcePdf.artifact.sha256,
        sourcePageRenderSha256:
          priorTrace.sourcePdf.pageRenders[0]!.image.sha256,
        failureId: failure.id,
      },
    },
    {
      id: 'epub-first-cause',
      mimeType: 'image/png',
      dataBase64: Buffer.from(epubCrop).toString('base64'),
      sha256: digest(epubCrop),
      page: sourceBox.page,
      box: epubBox,
      candidateIds,
      provenance: {
        kind: 'rendered-epub',
        epubSha256: priorTrace.epub.bytes.sha256,
        renderReceiptSha256: priorTrace.renderedEpub.receiptSha256,
        spineHref: output.spineHref,
        anchorId: output.anchorId,
        domSha256: screenshot.domSha256,
        screenshotSha256: screenshot.image.sha256,
        screenshotId: screenshot.id,
        failureId: failure.id,
      },
    },
  ]
  const executablePath =
    process.env.RUCKSACK_CODEX_EXECUTABLE ?? '/Users/erniesg/.codex/bin/codex'
  if (!endpoint.startsWith('unix:///')) {
    throw new Error('PILOT_OWNER_LOCAL_UNIX_SOCKET_REQUIRED')
  }
  const client = createLocalCodexReconciliationClient({
    endpoint,
    transportFactory: createOwnerLocalUnixSocketTransport,
    timeoutMs: 5 * 60_000,
    interruptTimeoutMs: 2_000,
    toolIdentity: {
      id: 'codex-cli',
      version: '0.147.0',
      executableSha256: digest(await readFile(executablePath)),
    },
    modelIdentity: {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      modelVersion: '2026-08-18',
      reasoningEffort: 'high',
    },
    promptIdentity: {
      id: 'source-grounded-reconciliation',
      version: '1.0.0',
      instructions:
        'Select the supplied candidate for every closed candidate-grounded decision. Abstain if any candidate lacks source evidence.',
    },
    renderArtifactResolver: {
      identity: {
        id: 'pilot-owner-local-render-resolver',
        version: '1.0.0',
        configurationSha256: hashTraceValue({
          source: priorTrace.sourcePdf.pageRenders[0]!.image,
          screenshot: screenshot.image,
        }),
      },
      resolve: ({ artifact }) => {
        if (
          artifact.sha256 === priorTrace.sourcePdf.pageRenders[0]!.image.sha256
        ) {
          return sourcePageBytes.slice()
        }
        if (artifact.sha256 === screenshot.image.sha256) {
          return screenshotBytes.slice()
        }
        throw new Error('UNEXPECTED_PILOT_RENDER_ARTIFACT')
      },
    },
  })
  return client.reconcile({
    documentId: materialization.receipt.documentId,
    attemptId: priorTrace.attemptId,
    evidenceGraph: sourceContract.graph,
    graphSha256: sourceContract.graph.graphSha256,
    candidateSetSha256: readSourceEvidenceGraph(
      sourceContract.graph,
    ).candidateSetSha256(candidateIds),
    decisions,
    comparisonEvidence: priorTrace,
    renders,
  })
}

async function pilotDocument(
  caseId: GroundedMaterializationPilotCase,
  providers: { endpoint: string; javaPath: string },
): Promise<
  Omit<GroundedMaterializationPilotDocument, 'sourceExecution' | 'refinement'>
> {
  const sourcePdfBytes = await publicPdf(caseId)
  const sourcePageBytes = new Uint8Array(
    await sharp({
      create: {
        width: 612,
        height: 792,
        channels: 3,
        background: { r: 250, g: 250, b: 248 },
      },
    })
      .png()
      .toBuffer(),
  )
  const fixture = pilotFixture(caseId, sourcePdfBytes)
  const materialization = materializeGroundedStruct({
    graph: fixture.graph,
    context: fixture.context,
    proposal: fixture.proposal,
    verifierIdentity,
    selections: fixture.selections,
    sourceFileName: `${caseId}.pdf`,
    assetBytes: fixture.assetBytes,
  })
  const sourceContract = createSourceEvidenceContract(
    fixture.graph,
    verifierIdentity,
  )
  const evaluation = await evaluateGroundedThreeProfileAttempt({
    attemptId: `${caseId}-0`,
    sourcePdf: {
      artifact: {
        sha256: digest(sourcePdfBytes),
        byteLength: sourcePdfBytes.byteLength,
      },
      pageCount: 1,
      pageRenders: [
        {
          page: 1,
          sourcePdfSha256: digest(sourcePdfBytes),
          image: {
            sha256: digest(sourcePageBytes),
            byteLength: sourcePageBytes.byteLength,
          },
          mediaType: 'image/png',
          width: 612,
          height: 792,
        },
      ],
    },
    materialization,
    sourceContract,
    codexIdentity,
    codexReceiptSha256: digest(`codex-${caseId}`),
    executeEpubCheck: (epubBytes) =>
      executePinnedEpubCheck({
        epubBytes,
        javaPath: providers.javaPath,
        epubCheckJarPath,
        toolVersion: '5.3.0',
      }),
  })
  const profiles = evaluation.profiles
  const outerReceipt = createClosedThreeProfileReconstructionReceipt({
    attempts: [evaluation.attempt],
  })
  const priorTrace = failedPriorTrace(profiles[0]!.trace)
  const localCodexResult = await actualLocalCodexResult({
    endpoint: providers.endpoint,
    materialization,
    sourceContract,
    priorTrace,
    sourcePageBytes,
    screenshotBytes: profiles[0]!.render.screenshotBytes,
  })
  return {
    caseId,
    sourcePdfBytes,
    materialization,
    sourceContract,
    priorTrace,
    localCodexResult,
    profiles,
    outerReceipt,
  }
}

describe('public synthetic grounded materialization provider smoke', () => {
  it('requires a retained owner-local MinerU execution before pilot acceptance', async () => {
    await expect(
      verifyGroundedMaterializationPilotMineruExecution({
        sourceExecution: undefined as never,
        sourcePdfSha256: digest('missing-source-execution'),
        sourceContract: undefined as never,
      }),
    ).rejects.toThrow(
      'GROUNDED_MATERIALIZATION_PILOT_MINERU_EXECUTION_REQUIRED',
    )
  })

  it.each([
    ['table', 'table-visual-crop'],
    ['equation', 'formula-visual-crop'],
  ] as const)(
    'keeps a source %s visual crop review-required',
    async (kind, reason) => {
      const sourcePdfBytes = await publicPdf(`${kind}-visual-crop`)
      const fixture = pilotFixture(
        kind === 'table' ? 'semantic-table-spans' : 'formula-text',
        sourcePdfBytes,
        kind,
      )
      const materialization = materializeGroundedStruct({
        graph: fixture.graph,
        context: fixture.context,
        proposal: fixture.proposal,
        verifierIdentity,
        selections: fixture.selections,
        sourceFileName: `${kind}-visual-crop.pdf`,
        assetBytes: fixture.assetBytes,
      })
      expect(materialization.receipt).toMatchObject({
        status: 'review-required',
        reviewReasons: [reason],
      })
    },
  )

  const ownerLocalEndpoint = process.env.RUCKSACK_CODEX_APP_SOCKET
  const epubCheckJava = process.env.RUCKSACK_EPUBCHECK_JAVA
  it.skipIf(!ownerLocalEndpoint || !epubCheckJava)(
    'exercises five synthetic cases over real local providers without claiming pilot acceptance',
    async () => {
      expect(() =>
        buildSourceEvidenceGraph({
          schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
        } as never),
      ).toThrow('Invalid source evidence graph')
      const documents = []
      for (const caseId of GROUNDED_MATERIALIZATION_PILOT_CASES) {
        documents.push(
          await pilotDocument(caseId, {
            endpoint: ownerLocalEndpoint!,
            javaPath: epubCheckJava!,
          }),
        )
      }
      expect(documents).toHaveLength(5)
      expect(documents.flatMap(({ profiles }) => profiles)).toHaveLength(15)
      expect(
        documents.every(
          ({ outerReceipt }) => outerReceipt.status === 'publication-ready',
        ),
      ).toBe(true)
    },
    30 * 60_000,
  )
})
