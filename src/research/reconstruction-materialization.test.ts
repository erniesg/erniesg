import { describe, expect, it } from 'vitest'
import { structDigest } from '../struct/ids'
import { sha256HexSync } from '../struct/sha256'
import type { StructDocument } from '../struct/types'
import {
  GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION,
  type GroundedStructMaterializationReceipt,
} from './grounded-struct-materializer'
import {
  RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
  DETERMINISTIC_CHECK_IDS,
  canonicalTraceJson,
  createReconstructionAttemptTrace,
  encodeCanonicalObservationPayload,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashSourceExpectedObservationSet,
  hashTraceValue,
  type ReconstructionAttemptTrace,
  type RenderedEpubEvidence,
} from './reconstruction-attempt-trace'
import {
  CLOSED_RECONSTRUCTION_PROFILE_IDS,
  RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION,
  acceptMonotonicReconstructionTransition,
  buildExactThreeProfileStructEpubs,
  createClosedThreeProfileReconstructionReceipt,
  type ClosedReconstructionProfileId,
  type ProfiledStructEpubArtifact,
  type ReconstructionHardCheckVector,
} from './reconstruction-materialization'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
} from './source-epub-comparator'

const digest = (value: string | Uint8Array) => sha256HexSync(value)
const sourcePdfSha256 = digest('public-synthetic-source-pdf')
const sourceEvidenceGraphSha256 = digest('public-synthetic-evidence-graph')
const candidateReferenceSha256 = digest('public-synthetic-candidate')
const source = {
  page: 1,
  boxes: [{ page: 1, x: 10, y: 20, width: 100, height: 40, rotation: 0 }],
  sourceRegionIds: ['public-region-1'],
}
const sourceRegions = [{ id: 'public-region-1', source }]
const viewport = { width: 800, height: 1_000, deviceScaleFactor: 1 }
const mappings = [
  {
    id: 'mapping-1',
    obligationId: 'public-region-1',
    source,
    output: [
      {
        spineHref: 'EPUB/content.xhtml',
        anchorId: 'public-paragraph',
        rendered: {
          screenshotId: 'screenshot-1',
          viewport,
          rect: { x: 10, y: 20, width: 100, height: 40 },
        },
      },
    ],
    status: 'mapped' as const,
  },
]

function refreshReceipt(document: StructDocument) {
  const { receipt, ...withoutReceipt } = document
  receipt.generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  return document
}

function publicDocument(): StructDocument {
  const evidence = {
    confidence: 1,
    pages: [1],
    boxes: source.boxes,
    sourceIds: source.sourceRegionIds,
  }
  return refreshReceipt({
    schemaVersion: '0.2.0',
    documentId: 'public-synthetic-document',
    source: {
      format: 'pdf',
      fileName: 'public-synthetic.pdf',
      sha256: sourcePdfSha256,
      byteLength: 1_000,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'Public synthetic reconstruction',
      subtitle: '',
      authors: ['Rucksack'],
      abstract: '',
      updated: '1970-01-01',
    },
    blocks: [
      {
        id: 'public-paragraph',
        kind: 'paragraph',
        text: 'Public synthetic reconstruction.',
        page: 1,
        order: 0,
        column: 'single',
        inline: [],
        evidence,
      },
    ],
    assets: [],
    relationships: [],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ['public-paragraph'],
        columns: [
          { id: 'page-1', side: 'single', blockIds: ['public-paragraph'] },
        ],
      },
    ],
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'Ready',
      issues: [],
    },
    receipt: {
      schemaVersion: '0.2.0',
      documentId: 'public-synthetic-document',
      sourceSha256: sourcePdfSha256,
      blockCount: 1,
      assetCount: 0,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount: 32,
      conservation: {
        sourceNodeCount: 1,
        accountedSourceNodeCount: 1,
        sourceRegionCount: 1,
        accountedSourceRegionCount: 1,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceAssetCount: 0,
        accountedSourceAssetCount: 0,
        sourceRelationshipCount: 0,
        accountedSourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: 32,
        structBlockCount: 1,
        structAssetCount: 0,
        structRelationshipCount: 0,
        structDiagnosticCount: 0,
        structTextCharacterCount: 32,
      },
      generatedSha256: digest('pending-struct'),
    },
  })
}

function observationPayload(
  check: (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
) {
  const bytes = encodeCanonicalObservationPayload({
    schemaVersion: '1.0.0',
    check,
    items: [
      {
        idSha256: digest(`item-${check}`),
        valueSha256: digest(`value-${check}`),
        anchorIds: ['public-paragraph'],
      },
    ],
  })
  return { sha256: digest(bytes), byteLength: bytes.byteLength }
}

function renderedEpub(
  profileId: ClosedReconstructionProfileId,
  epub: ProfiledStructEpubArtifact['epub'],
  actualObservationSets: RenderedEpubEvidence['actualObservationSets'],
) {
  const obligationProjection = {
    sourcePdfSha256,
    obligationsSha256: hashTraceValue(sourceRegions),
    obligationCount: sourceRegions.length,
  }
  const evidence: RenderedEpubEvidence = {
    epubSha256: epub.sha256,
    download: {
      artifact: epub,
      verificationReceiptSha256: digest(`download-${profileId}`),
    },
    sourceObligations: {
      ...obligationProjection,
      receiptSha256: hashTraceValue(obligationProjection),
    },
    actualObservationSets,
    renderer: {
      id: 'owner-local-chromium',
      version: '1.0.0',
      executableSha256: digest('chromium'),
      configurationSha256: digest(`render-${profileId}`),
    },
    domSnapshots: [
      {
        spineHref: 'EPUB/content.xhtml',
        dom: { sha256: digest(`dom-${profileId}`), byteLength: 3 },
        anchors: ['public-paragraph'],
      },
    ],
    screenshots: [
      {
        id: 'screenshot-1',
        spineHref: 'EPUB/content.xhtml',
        domSha256: digest(`dom-${profileId}`),
        image: { sha256: digest(`screenshot-${profileId}`), byteLength: 10 },
        mediaType: 'image/png',
        width: viewport.width,
        height: viewport.height,
        viewport,
        fullPage: true,
      },
    ],
    receiptSha256: digest('pending-render'),
  }
  evidence.receiptSha256 = hashRenderedEpubEvidence(evidence)
  return evidence
}

function passingTrace(
  profileId: ClosedReconstructionProfileId,
  build: ProfiledStructEpubArtifact,
  document: StructDocument,
): ReconstructionAttemptTrace {
  const expectedObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const payload = observationPayload(check)
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount: 1,
        payload,
        sourceRegionIds: ['public-region-1'],
      }
      return {
        ...projection,
        receiptSha256: hashSourceExpectedObservationSet({
          ...projection,
          receiptSha256: digest('pending-expected'),
        }),
      }
    },
  )
  const actualObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const payload = observationPayload(check)
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount: 1,
        payload,
      }
      return {
        ...projection,
        receiptSha256: hashRenderedActualObservationSet({
          ...projection,
          receiptSha256: digest('pending-actual'),
        }),
      }
    },
  )
  const obligationProjection = {
    sourcePdfSha256,
    obligationsSha256: hashTraceValue(sourceRegions),
    obligationCount: sourceRegions.length,
  }
  const candidateBindingSha256 = digest('candidate-binding')
  const sourceEvidenceWithoutReceipt = {
    schemaVersion: '1.0.0' as const,
    sourcePdfSha256,
    evidenceGraphSha256: sourceEvidenceGraphSha256,
    candidateSetSha256: hashTraceValue([
      {
        referenceSha256: candidateReferenceSha256,
        bindingSha256: candidateBindingSha256,
      },
    ]),
    sourceObligations: {
      obligationsSha256: obligationProjection.obligationsSha256,
      obligationCount: obligationProjection.obligationCount,
      receiptSha256: hashTraceValue(obligationProjection),
    },
    expectedObservationSets,
  }
  const sourceEvidence = {
    ...sourceEvidenceWithoutReceipt,
    receiptSha256: hashTraceValue(sourceEvidenceWithoutReceipt),
  }
  const render = renderedEpub(profileId, build.epub, actualObservationSets)
  const observations = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map((check) =>
    createDeterministicObservationReceipt({
      idSha256: digest(`observation-${check}`),
      check,
      source,
      mappingIds: ['mapping-1'],
      expectedSetReceiptSha256: expectedObservationSets.find(
        (set) => set.check === check,
      )!.receiptSha256,
      actualSetReceiptSha256: actualObservationSets.find(
        (set) => set.check === check,
      )!.receiptSha256,
    }),
  )
  const structure = {
    schemaVersion: '0.2.0' as const,
    documentId: document.documentId!,
    sourcePdfSha256,
    artifact: build.canonicalStruct,
    generatedSha256: document.receipt.generatedSha256,
    assets: [],
  }
  const epub = {
    bytes: build.epub,
    mediaType: 'application/epub+zip' as const,
    structSha256: structure.artifact.sha256,
    epubCheck: {
      toolId: 'epubcheck',
      toolVersion: '5.3.0',
      reportSha256: digest(`epubcheck-${profileId}`),
      status: 'passed' as const,
      errorCount: 0,
      warningCount: 0,
    },
  }
  const comparator = compareSourceToRenderedEpub({
    sourcePdfSha256,
    sourceEvidence,
    structure,
    epub,
    renderedEpub: render,
    sourceRegions,
    mappings,
    observations,
  })
  const identity = {
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
      id: 'closed-three-profile-reconstruction',
      version: '1.0.0',
      sha256: digest('prompt'),
    },
    tool: { id: 'codex', version: '0.99.0' },
  }
  const reconciliationInputSha256 = hashTraceValue({
    sourcePdfSha256,
    evidenceGraphSha256: sourceEvidenceGraphSha256,
    candidateSetSha256: sourceEvidence.candidateSetSha256,
    structSha256: structure.artifact.sha256,
    epubSha256: build.epub.sha256,
    renderObservationReceiptSha256: render.receiptSha256,
  })
  return createReconstructionAttemptTrace({
    schemaVersion: RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
    attemptId: `public-document-${profileId}-0`,
    lineage: {
      attemptIndex: 0,
      parentTraceSha256: null,
      immutablePriorTraceSha256: null,
      appliedRepair: null,
    },
    sourcePdf: {
      artifact: { sha256: sourcePdfSha256, byteLength: 1_000 },
      pageCount: 1,
      pageRenders: [
        {
          page: 1,
          sourcePdfSha256,
          image: { sha256: digest('source-page-1'), byteLength: 500 },
          mediaType: 'image/png',
          width: 600,
          height: 800,
        },
      ],
    },
    evidenceGraph: {
      schemaVersion: '1.0.0',
      artifact: {
        sha256: sourceEvidenceGraphSha256,
        byteLength: new TextEncoder().encode('public-synthetic-evidence-graph')
          .byteLength,
      },
      sourcePdfSha256,
    },
    sourceEvidence,
    evidenceCandidates: [
      {
        referenceSha256: candidateReferenceSha256,
        bindingSha256: candidateBindingSha256,
      },
    ],
    structure,
    epub,
    renderedEpub: render,
    mappings,
    comparisonEvidence: { sourceRegions, observations },
    providerReceipts: [
      {
        id: 'provider-source-evidence',
        role: 'source-evidence',
        required: true,
        enabledBeforeRun: true,
        providerId: 'provider-neutral-evidence-adapter',
        receiptSha256: digest(`provider-source-${profileId}`),
        inputSha256: sourcePdfSha256,
        outputSha256: sourceEvidence.receiptSha256,
        status: 'succeeded',
      },
      {
        id: 'provider-actual-render',
        role: 'actual-render',
        required: true,
        enabledBeforeRun: true,
        providerId: 'owner-local-chromium',
        receiptSha256: digest(`provider-render-${profileId}`),
        inputSha256: build.epub.sha256,
        outputSha256: render.receiptSha256,
        status: 'succeeded',
      },
      {
        id: 'provider-codex-reconciliation',
        role: 'owner-local-codex-reconciliation',
        required: true,
        enabledBeforeRun: true,
        providerId: identity.server.id,
        identitySha256: hashTraceValue(identity),
        receiptSha256: digest(`provider-codex-${profileId}`),
        inputSha256: reconciliationInputSha256,
        outputSha256: hashTraceValue(comparator),
        prompt: identity.prompt,
        tool: identity.tool,
        model: identity.model,
        server: identity.server,
        status: 'succeeded',
      },
    ],
    comparator,
    critiqueRepair: null,
    budget: {
      policy: {
        maxRefinements: 3,
        maxFreshTasks: 1,
        maxTokens: 24_000,
        maxDurationMs: 30 * 60 * 1_000,
        repairPolicySha256: digest('repair-policy'),
      },
      usage: { refinements: 0, freshTasks: 1, tokens: 100, durationMs: 100 },
    },
    terminalState: 'publication-ready',
  })
}

function hardCheckVector(
  profileId: ClosedReconstructionProfileId,
  failed: readonly (typeof DETERMINISTIC_CHECK_IDS)[number][] = [],
  stage = 'baseline',
): ReconstructionHardCheckVector {
  const checks = DETERMINISTIC_CHECK_IDS.map((check) => ({
    check,
    status: failed.includes(check) ? ('failed' as const) : ('passed' as const),
    expectedSha256: digest(`expected-${check}`),
    actualSha256: digest(`actual-${stage}-${profileId}-${check}`),
  }))
  const firstFailed = checks.find(({ status }) => status === 'failed')
  const projection = {
    schemaVersion: RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION,
    profileId,
    traceSha256: digest(`trace-${stage}-${profileId}`),
    sourcePdfSha256,
    sourceEvidenceGraphSha256,
    canonicalStructSha256: digest(`struct-${stage}`),
    epubSha256: digest(`epub-${stage}-${profileId}`),
    comparatorSha256: digest(`comparator-${stage}-${profileId}`),
    checks,
    passedCount: checks.filter(({ status }) => status === 'passed').length,
    failedCount: checks.filter(({ status }) => status === 'failed').length,
    firstCause: firstFailed
      ? {
          failureId: `failure-${profileId}-${firstFailed.check}`,
          check: firstFailed.check,
        }
      : null,
  }
  return { ...projection, vectorSha256: hashTraceValue(projection) }
}

function syntheticMaterializationReceipt(
  canonicalStruct: ProfiledStructEpubArtifact['canonicalStruct'],
): GroundedStructMaterializationReceipt {
  const selections = [
    {
      targetKind: 'block' as const,
      targetId: 'public-paragraph',
      candidateReferenceSha256,
      bindingSha256: digest('candidate-binding'),
      resolutionReceiptSha256: digest('candidate-resolution'),
    },
  ]
  const projection = {
    schemaVersion: GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION,
    documentId: 'public-synthetic-document',
    sourcePdfSha256,
    sourceEvidenceGraphSha256,
    structuredContextSha256: digest('structured-context'),
    structuredProposalSha256: digest('structured-proposal'),
    verifiedExtractionSha256: digest('verified-extraction'),
    selectionSetSha256: hashTraceValue(selections),
    selections,
    obligationBindings: [
      {
        obligationId: 'public-paragraph-obligation',
        outputBlockId: 'public-paragraph',
        sourceAnchorIds: ['public-paragraph-source'],
        observationCategories: ['text-exactness'],
        candidateReferenceSha256: [candidateReferenceSha256],
      },
    ],
    repairCore: {
      sha256: digest('synthetic-repair-core'),
      byteLength: 64,
    },
    canonicalStruct,
    coreToDocumentBindingSha256: digest('synthetic-core-binding'),
    status: 'publication-ready' as const,
    reviewReasons: [] as [],
  }
  return { ...projection, receiptSha256: hashTraceValue(projection) }
}

describe('closed three-profile reconstruction materialization', () => {
  it('builds and reopens three distinct EPUBs and closes valid #199 traces', async () => {
    const document = publicDocument()
    const canonicalStructBytes = new TextEncoder().encode(
      canonicalTraceJson(document),
    )
    const builds = await buildExactThreeProfileStructEpubs(
      document,
      canonicalStructBytes,
    )
    const traces = Object.fromEntries(
      CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
        const build = builds.find(
          (candidate) => candidate.profileId === profileId,
        )!
        return [profileId, passingTrace(profileId, build, document)]
      }),
    ) as Record<ClosedReconstructionProfileId, ReconstructionAttemptTrace>

    expect(builds.map(({ profileId }) => profileId)).toEqual(
      CLOSED_RECONSTRUCTION_PROFILE_IDS,
    )
    expect(new Set(builds.map(({ epub }) => epub.sha256))).toHaveLength(3)
    expect(
      createClosedThreeProfileReconstructionReceipt({
        attempts: [
          {
            canonicalStructSha256: builds[0]!.canonicalStruct.sha256,
            materializationReceipt: syntheticMaterializationReceipt(
              builds[0]!.canonicalStruct,
            ),
            builds,
            traces,
          },
        ],
      }),
    ).toMatchObject({
      profileIds: CLOSED_RECONSTRUCTION_PROFILE_IDS,
      finalProfiles: CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => ({
        profileId,
      })),
      transitions: [],
      status: 'publication-ready',
    })
  })

  it('accepts first-cause improvement only when every prior pass stays green', () => {
    const baseline = CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) =>
      hardCheckVector(profileId, profileId === 'mobile' ? ['table-spans'] : []),
    )
    const resulting = CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) =>
      hardCheckVector(profileId, [], 'resulting'),
    )

    expect(
      acceptMonotonicReconstructionTransition(baseline, resulting),
    ).toMatchObject({
      declaredFirstCause: {
        profileId: 'mobile',
        check: 'table-spans',
      },
      metric: { id: 'passed-hard-check-count', before: 65, after: 66 },
      status: 'accepted',
    })
  })

  it('rejects a new hard-check failure even when the declared first cause improves', () => {
    const baseline = CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) =>
      hardCheckVector(profileId, profileId === 'mobile' ? ['table-spans'] : []),
    )
    const resulting = CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) =>
      hardCheckVector(
        profileId,
        profileId === 'paperPro' ? ['figures'] : [],
        'regressed',
      ),
    )

    expect(() =>
      acceptMonotonicReconstructionTransition(baseline, resulting),
    ).toThrow('RECONSTRUCTION_HARD_GATE_REGRESSION')
  })
})
