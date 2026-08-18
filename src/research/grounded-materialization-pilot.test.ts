import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { path as epubCheckJarPath } from 'epubcheck-static'
import {
  executePinnedEpubCheck,
  renderExactThreeProfileEpubs,
  runEpubCheckWarningsFatal,
} from './actual-profiled-epub'
import {
  compareGroundedProfiledEpub,
  createGroundedActualReconstructionTrace,
} from './grounded-epub-comparison'
import {
  GROUNDED_MATERIALIZATION_PILOT_CASES,
  GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION,
  verifyGroundedMaterializationPilotPacket,
  type GroundedMaterializationPilotCase,
  type GroundedMaterializationPilotDocument,
} from './grounded-materialization-pilot'
import {
  materializeGroundedStruct,
  type GroundedStructCandidateSelection,
} from './grounded-struct-materializer'
import {
  buildExactThreeProfileStructEpubs,
  createClosedThreeProfileReconstructionReceipt,
} from './reconstruction-materialization'
import { hashTraceValue } from './reconstruction-attempt-trace'
import { sha256HexSync } from './sha256-sync'
import { createSourceEvidenceContract } from './source-evidence-contract'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  type PdfEvidenceBundle,
  type PdfEvidenceCandidate,
  type PdfEvidenceObligation,
  type PdfEvidenceSource,
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

async function pilotDocument(
  caseId: GroundedMaterializationPilotCase,
): Promise<GroundedMaterializationPilotDocument> {
  const sourcePdfBytes = await publicPdf(caseId)
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
  const builds = await buildExactThreeProfileStructEpubs(
    materialization.document,
    materialization.canonicalStructBytes,
  )
  const renders = await renderExactThreeProfileEpubs(builds)
  const epubChecks = await Promise.all(
    builds.map((build) =>
      runEpubCheckWarningsFatal(build, (epubBytes) =>
        process.env.RUCKSACK_EPUBCHECK_JAVA
          ? executePinnedEpubCheck({
              epubBytes,
              javaPath: process.env.RUCKSACK_EPUBCHECK_JAVA,
              epubCheckJarPath,
              toolVersion: '5.3.0',
            })
          : Promise.resolve({
              toolId: 'epubcheck' as const,
              toolVersion: '5.3.0',
              executableSha256: digest('epubcheck-jar'),
              exitCode: 0,
              reportBytes: new TextEncoder().encode('{"messages":[]}'),
              errorCount: 0,
              warningCount: 0,
            }),
      ),
    ),
  )
  const profiles = builds.map((build, index) => {
    const comparison = compareGroundedProfiledEpub({
      materialization,
      sourceContract,
      build,
      render: renders[index]!,
      epubCheck: epubChecks[index]!,
    })
    const trace = createGroundedActualReconstructionTrace({
      attemptId: `${caseId}-${build.profileId}-0`,
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
              sha256: digest(imageBytes),
              byteLength: imageBytes.byteLength,
            },
            mediaType: 'image/png',
            width: 612,
            height: 792,
          },
        ],
      },
      materialization,
      sourceContract,
      comparison,
      codexIdentity,
      codexReceiptSha256: digest(`codex-${caseId}-${build.profileId}`),
    })
    return {
      build,
      render: renders[index]!,
      epubCheck: epubChecks[index]!,
      comparison,
      trace,
    }
  })
  const traces = Object.fromEntries(
    profiles.map(({ build, trace }) => [build.profileId, trace]),
  ) as Record<
    (typeof builds)[number]['profileId'],
    (typeof profiles)[number]['trace']
  >
  const outerReceipt = createClosedThreeProfileReconstructionReceipt({
    attempts: [
      {
        canonicalStructSha256: materialization.receipt.canonicalStruct.sha256,
        materializationReceipt: materialization.receipt,
        traces,
        builds,
      },
    ],
  })
  return {
    caseId,
    sourcePdfBytes,
    materialization,
    sourceContract,
    profiles,
    outerReceipt,
  }
}

describe('current-schema five-success grounded materialization pilot', () => {
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

  it('reopens fifteen actual EPUBs and keeps malformed evidence outside the five successes', async () => {
    expect(() =>
      buildSourceEvidenceGraph({
        schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
      } as never),
    ).toThrow('Invalid source evidence graph')
    const documents = []
    for (const caseId of GROUNDED_MATERIALIZATION_PILOT_CASES) {
      documents.push(await pilotDocument(caseId))
    }
    const receipt = verifyGroundedMaterializationPilotPacket({
      schemaVersion: GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION,
      documents,
      negativeControls: [
        {
          id: 'malformed-source-evidence',
          status: 'rejected',
          reason:
            'The malformed #198 graph is rejected before materialization.',
        },
      ],
    })
    expect(receipt).toMatchObject({
      status: 'passed',
      documentCount: 5,
      profileCount: 15,
    })
    expect(receipt.documents).toHaveLength(5)
  }, 60_000)
})
