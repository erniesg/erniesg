import { describe, expect, it, vi } from 'vitest'
import { sha256HexSync } from './sha256-sync'
import {
  RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
  createReconstructionAttemptTrace,
  encodeCanonicalObservationPayload,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashSourceEvidenceReceipt,
  hashSourceExpectedObservationSet,
  hashTraceValue,
  type ReconstructionAttemptTraceCore,
  type ReconstructionAttemptTrace,
  type RenderedEpubEvidence,
} from './reconstruction-attempt-trace'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
} from './source-epub-comparator'
import {
  createReconstructionCandidateBinding,
  createReconstructionCandidateContract,
  createStructEvidencePatch,
  deriveStructRepairProjections,
  parseMaterializedRepairApplicationReceipt,
  reconstructionRefinementHash,
  replayPrivateRefinementRun,
  replayRefinementRun,
  runReconstructionRefinement,
  type MaterializedRepairApplicationReceipt,
  type MaterializationVerificationAuthorities,
  type OwnerLocalCodexIdentity,
  type OwnerLocalArtifactResolutionRequest,
  type OwnerLocalArtifactResolver,
  type PrivateReplayAuthorities,
  type ReconstructionCandidate,
  type ReconstructionCandidateContract,
  type RefinementRunReceipt,
  type StructEvidencePatch,
} from './reconstruction-refinement'

const digest = (value: string | Uint8Array) => sha256HexSync(value)
const sourcePdfSha256 = digest('source-pdf')
const sourceEvidenceGraphSha256 = digest('source-evidence-graph')
const candidateReferenceSha256 = digest('provider-neutral-candidate-reference')
const source = {
  page: 1,
  boxes: [{ page: 1, x: 10, y: 20, width: 100, height: 80, rotation: 0 }],
  sourceRegionIds: ['region-1'],
}
const sourceRegions = [{ id: 'region-1', source }]
const viewport = { width: 800, height: 1_000, deviceScaleFactor: 1 }
const mappings = [
  {
    id: 'mapping-1',
    obligationId: 'obligation-1',
    source,
    output: [
      {
        spineHref: 'EPUB/content.xhtml',
        anchorId: 'struct-paragraph-1',
        rendered: {
          screenshotId: 'screenshot-1',
          viewport,
          rect: { x: 10, y: 20, width: 100, height: 80 },
        },
      },
    ],
    status: 'mapped' as const,
  },
]

function observationPayloadBytes(
  check: (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
  labels: string[],
) {
  return encodeCanonicalObservationPayload({
    schemaVersion: '1.0.0',
    check,
    items: labels.map((label) => ({
      idSha256: digest(`item-${check}-${label}`),
      valueSha256: digest(`value-${check}-${label}`),
      anchorIds: ['struct-paragraph-1'],
    })),
  })
}

function observationPayload(
  check: (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
  labels: string[],
) {
  const bytes = observationPayloadBytes(check, labels)
  return { sha256: digest(bytes), byteLength: bytes.byteLength }
}

const identity: OwnerLocalCodexIdentity = {
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
    id: 'reconstruction-first-cause-repair',
    version: '1.0.0',
    sha256: digest('prompt'),
  },
  tool: { id: 'codex', version: '0.99.0' },
}
const verifierIdentity = {
  id: 'owner-local-grounded-verifier',
  version: '2026.08.1',
  configurationSha256: digest('verifier-configuration'),
  executableSha256: digest('verifier-executable'),
}
const artifactResolverIdentity = {
  id: 'owner-local-artifact-resolver',
  version: '2026.08.1',
  configurationSha256: digest('artifact-resolver-configuration'),
}
const sourceEvidenceVerifierIdentity = {
  id: 'source-evidence-verifier',
  version: '198.1.0',
  configurationSha256: digest('source-evidence-verifier-configuration'),
  executableSha256: digest('source-evidence-verifier-executable'),
}
const renderObservationExtractorIdentity = {
  id: 'render-observation-extractor',
  version: '1.0.0',
  configurationSha256: digest('render-observation-configuration'),
  executableSha256: digest('render-observation-executable'),
}

function contract(
  budget: Partial<ReconstructionCandidateContract['budget']> = {},
) {
  return createReconstructionCandidateContract({
    schemaVersion: '1.0.0',
    runId: 'run-document-a',
    documentId: 'document-a',
    sourcePdfSha256,
    sourceEvidenceGraph: {
      schemaVersion: '1.0.0',
      sha256: sourceEvidenceGraphSha256,
    },
    authorities: {
      codex: {
        identity,
        identitySha256: hashTraceValue(identity),
      },
      groundedVerifier: {
        identity: verifierIdentity,
        identitySha256: hashTraceValue(verifierIdentity),
      },
      artifactResolver: {
        identity: artifactResolverIdentity,
        identitySha256: hashTraceValue(artifactResolverIdentity),
      },
      sourceEvidenceVerifier: {
        identity: sourceEvidenceVerifierIdentity,
        identitySha256: hashTraceValue(sourceEvidenceVerifierIdentity),
      },
      renderObservationExtractor: {
        identity: renderObservationExtractorIdentity,
        identitySha256: hashTraceValue(renderObservationExtractorIdentity),
      },
    },
    budget: {
      maxRefinements: 1,
      maxFreshTasks: 1,
      maxTokens: 1_000,
      maxDurationMs: 10_000,
      repairPolicySha256: digest('repair-policy'),
      ...budget,
    },
    repairScope: [
      {
        targetKind: 'relationship',
        targetId: 'figure-relationship-1',
        candidateReferenceSha256s: [candidateReferenceSha256],
      },
    ],
  })
}

function initialCandidate(): ReconstructionCandidate {
  const canonicalStructBytes = new TextEncoder().encode(
    '{"assets":[],"blocks":[],"relationships":[{"id":"figure-relationship-1","status":"unresolved"}]}',
  )
  return {
    binding: createReconstructionCandidateBinding({
      schemaVersion: '1.0.0',
      sourcePdfSha256,
      sourceEvidenceGraphSha256,
      canonicalStruct: {
        sha256: digest(canonicalStructBytes),
        byteLength: canonicalStructBytes.byteLength,
      },
      selections: [],
    }),
    canonicalStructBytes,
  }
}

function renderer(
  epubSha256: string,
  actualObservationSets: RenderedEpubEvidence['actualObservationSets'],
): RenderedEpubEvidence {
  const obligationProjection = {
    sourcePdfSha256,
    obligationsSha256: hashTraceValue(sourceRegions),
    obligationCount: sourceRegions.length,
  }
  const evidence: RenderedEpubEvidence = {
    epubSha256,
    download: {
      artifact: { sha256: epubSha256, byteLength: 4 },
      verificationReceiptSha256: digest('download-verification'),
    },
    sourceObligations: {
      ...obligationProjection,
      receiptSha256: hashTraceValue(obligationProjection),
    },
    actualObservationSets,
    renderer: {
      id: 'chromium',
      version: '1.0.0',
      executableSha256: digest('chromium'),
      configurationSha256: digest('render-configuration'),
    },
    domSnapshots: [
      {
        spineHref: 'EPUB/content.xhtml',
        dom: { sha256: digest('dom'), byteLength: 3 },
        anchors: ['struct-paragraph-1'],
      },
    ],
    screenshots: [
      {
        id: 'screenshot-1',
        spineHref: 'EPUB/content.xhtml',
        domSha256: digest('dom'),
        image: { sha256: digest('screenshot'), byteLength: 10 },
        mediaType: 'image/png',
        width: 800,
        height: 1_000,
        viewport,
        fullPage: true,
      },
    ],
    receiptSha256: digest('pending-render-receipt'),
  }
  evidence.receiptSha256 = hashRenderedEpubEvidence(evidence)
  return evidence
}

function attemptTrace(
  candidateContract: ReconstructionCandidateContract,
  candidate: ReconstructionCandidate,
  usage: ReconstructionAttemptTraceCore['budget']['usage'],
  terminalState: 'failed' | 'publication-ready' = 'failed',
) {
  const epubSha256 = digest('epub')
  const expectedObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const labels =
        check === 'figures' ? ['source-figure'] : [`value-${check}`]
      const payload = observationPayload(check, labels)
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount: 1,
        payload,
        sourceRegionIds: ['region-1'],
      }
      return {
        ...projection,
        receiptSha256: hashSourceExpectedObservationSet({
          ...projection,
          receiptSha256: digest('pending-expected-set'),
        }),
      }
    },
  )
  const actualObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const labels =
        check === 'figures'
          ? terminalState === 'failed'
            ? []
            : ['source-figure']
          : [`value-${check}`]
      const payload = observationPayload(check, labels)
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount:
          terminalState === 'failed' && check === 'figures' ? 0 : 1,
        payload,
      }
      return {
        ...projection,
        receiptSha256: hashRenderedActualObservationSet({
          ...projection,
          receiptSha256: digest('pending-actual-set'),
        }),
      }
    },
  )
  const obligationProjection = {
    sourcePdfSha256,
    obligationsSha256: hashTraceValue(sourceRegions),
    obligationCount: sourceRegions.length,
  }
  const sourceEvidenceWithoutReceipt = {
    schemaVersion: '1.0.0',
    sourcePdfSha256,
    evidenceGraphSha256: sourceEvidenceGraphSha256,
    candidateSetSha256: hashTraceValue([
      {
        referenceSha256: candidateReferenceSha256,
        bindingSha256: digest('candidate-binding'),
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
  const renderedEpub = renderer(epubSha256, actualObservationSets)
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
    schemaVersion: '0.2.0',
    documentId: candidateContract.documentId,
    sourcePdfSha256,
    artifact: candidate.binding.canonicalStruct,
    generatedSha256: digest('generated-struct'),
    assets: [],
  }
  const epub = {
    bytes: { sha256: epubSha256, byteLength: 4 },
    mediaType: 'application/epub+zip' as const,
    structSha256: structure.artifact.sha256,
    epubCheck: {
      toolId: 'epubcheck',
      toolVersion: '5.3.0',
      reportSha256: digest('epubcheck-report'),
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
    renderedEpub,
    sourceRegions,
    mappings,
    observations,
  })
  const evidenceCandidates = [
    {
      referenceSha256: candidateReferenceSha256,
      bindingSha256: digest('candidate-binding'),
    },
  ]
  const reconciliationInputSha256 = hashTraceValue({
    sourcePdfSha256,
    evidenceGraphSha256: sourceEvidenceGraphSha256,
    candidateSetSha256: sourceEvidence.candidateSetSha256,
    structSha256: structure.artifact.sha256,
    epubSha256,
    renderObservationReceiptSha256: renderedEpub.receiptSha256,
  })
  return createReconstructionAttemptTrace({
    schemaVersion: RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
    attemptId: 'attempt-document-a-0',
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
        byteLength: new TextEncoder().encode('source-evidence-graph').byteLength,
      },
      sourcePdfSha256,
    },
    sourceEvidence,
    evidenceCandidates,
    structure,
    epub,
    renderedEpub,
    mappings,
    comparisonEvidence: { sourceRegions, observations },
    providerReceipts: [
      {
        id: 'provider-source-evidence',
        role: 'source-evidence',
        required: true,
        enabledBeforeRun: true,
        providerId: 'provider-neutral-evidence-adapter',
        receiptSha256: digest('provider-source-receipt'),
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
        receiptSha256: digest('provider-render-receipt'),
        inputSha256: epubSha256,
        outputSha256: renderedEpub.receiptSha256,
        status: 'succeeded',
      },
      {
        id: 'provider-codex-reconciliation',
        role: 'owner-local-codex-reconciliation',
        required: true,
        enabledBeforeRun: true,
        providerId: identity.server.id,
        identitySha256: hashTraceValue(identity),
        receiptSha256: digest('provider-codex-reconciliation-receipt'),
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
    budget: { policy: candidateContract.budget, usage },
    terminalState,
  })
}

function patchFor(
  candidateContract: ReconstructionCandidateContract,
  candidate: ReconstructionCandidate,
): StructEvidencePatch {
  return createStructEvidencePatch({
    schemaVersion: '1.0.0',
    documentId: candidateContract.documentId,
    sourcePdfSha256,
    sourceEvidenceGraphSha256,
    baseStructSha256: candidate.binding.canonicalStruct.sha256,
    priorTraceSha256: digest('prior-trace'),
    taskIdSha256: digest('fresh-task'),
    operations: [
      {
        op: 'select-evidence-candidate',
        targetKind: 'relationship',
        targetId: 'figure-relationship-1',
        candidateReferenceSha256,
      },
    ],
  })
}

function applicationFor(
  candidateContract: ReconstructionCandidateContract,
  candidate: ReconstructionCandidate,
  proposal: StructEvidencePatch,
  resultingStructJson =
    '{"assets":[],"blocks":[],"relationships":[{"id":"figure-relationship-1","status":"resolved"}]}',
) {
  const resultingCanonicalStructBytes = new TextEncoder().encode(
    resultingStructJson,
  )
  const resultingCanonicalStruct = {
    sha256: digest(resultingCanonicalStructBytes),
    byteLength: resultingCanonicalStructBytes.byteLength,
  }
  const beforeProjections = deriveStructRepairProjections(
    candidate.canonicalStructBytes,
    proposal.operations,
  )
  const resultingProjections = deriveStructRepairProjections(
    resultingCanonicalStructBytes,
    proposal.operations,
  )
  const operationTargetSetSha256 = hashTraceValue(
    proposal.operations.map(({ targetKind, targetId }) => ({
      targetKind,
      targetId,
    })),
  )
  const candidateReferenceSetSha256 = hashTraceValue(
    proposal.operations.map(({ candidateReferenceSha256: reference }) =>
      reference,
    ),
  )
  const candidateBindingSha256 = digest('candidate-binding')
  const candidatePayloadBytes = new TextEncoder().encode(
    '{"selectedStatus":"resolved"}',
  )
  const candidatePayload = {
    sha256: digest(candidatePayloadBytes),
    byteLength: candidatePayloadBytes.byteLength,
  }
  const candidateRequest = {
    schemaVersion: '1.0.0' as const,
    sourceEvidenceGraphSha256: candidateContract.sourceEvidenceGraph.sha256,
    referenceSha256: candidateReferenceSha256,
    bindingSha256: candidateBindingSha256,
  }
  const candidateResolutionProjection = {
    schemaVersion: '1.0.0' as const,
    verifierIdentity: sourceEvidenceVerifierIdentity,
    verifierIdentitySha256: hashTraceValue(sourceEvidenceVerifierIdentity),
    requestSha256: hashTraceValue(candidateRequest),
    referenceSha256: candidateReferenceSha256,
    bindingSha256: candidateBindingSha256,
    payload: candidatePayload,
    status: 'succeeded' as const,
  }
  const candidateResolution = {
    ...candidateResolutionProjection,
    payloadBytes: candidatePayloadBytes,
    receiptSha256: hashTraceValue(candidateResolutionProjection),
  }
  const candidatePayloadSetSha256 = hashTraceValue([
    {
      ...candidateResolution,
      payloadBytes: undefined,
    },
  ].map(({ payloadBytes: _payloadBytes, ...value }) => value))
  const groundingRequestProjection = {
    schemaVersion: '1.0.0' as const,
    sourceEvidenceGraphSha256: candidateContract.sourceEvidenceGraph.sha256,
    proposalSha256: proposal.proposalSha256,
    operations: proposal.operations,
    beforeCanonicalStruct: candidate.binding.canonicalStruct,
    resultingCanonicalStruct,
    beforeSelectedProjection: beforeProjections.selected,
    resultingSelectedProjection: resultingProjections.selected,
    candidatePayloads: [candidateResolution].map(
      ({ payloadBytes: _payloadBytes, ...value }) => value,
    ),
  }
  const groundedProjection = {
    schemaVersion: '1.0.0' as const,
    verifierIdentity,
    verifierIdentitySha256:
      candidateContract.authorities.groundedVerifier.identitySha256,
    sourceEvidenceGraphSha256: candidateContract.sourceEvidenceGraph.sha256,
    proposalSha256: proposal.proposalSha256,
    operationTargetSetSha256,
    candidateReferenceSetSha256,
    candidatePayloadSetSha256,
    beforeStructSha256: candidate.binding.canonicalStruct.sha256,
    resultingStructSha256: resultingCanonicalStruct.sha256,
    beforeSelectedProjectionSha256: beforeProjections.selected.sha256,
    beforeUnselectedProjectionSha256: beforeProjections.unselected.sha256,
    resultingSelectedProjectionSha256: resultingProjections.selected.sha256,
    resultingUnselectedProjectionSha256:
      resultingProjections.unselected.sha256,
    inputSha256: hashTraceValue(groundingRequestProjection),
    outputSha256: hashTraceValue({
      resultingStructSha256: resultingCanonicalStruct.sha256,
      resultingSelectedProjectionSha256: resultingProjections.selected.sha256,
      resultingUnselectedProjectionSha256:
        resultingProjections.unselected.sha256,
    }),
    status: 'succeeded' as const,
  }
  const unchangedProjection = {
    schemaVersion: '1.0.0' as const,
    beforeSha256: beforeProjections.unselected.sha256,
    afterSha256: resultingProjections.unselected.sha256,
  }
  const groundedVerifier = {
    ...groundedProjection,
    receiptSha256: hashTraceValue(groundedProjection),
  }
  const unchangedUnselected = {
    ...unchangedProjection,
    receiptSha256: hashTraceValue(unchangedProjection),
  }
  const projection = {
    schemaVersion: '1.0.0' as const,
    proposalSha256: proposal.proposalSha256,
    operations: proposal.operations,
    beforeCanonicalStruct: candidate.binding.canonicalStruct,
    beforeSelectedProjection: beforeProjections.selected,
    beforeUnselectedProjection: beforeProjections.unselected,
    resultingCanonicalStruct,
    resultingSelectedProjection: resultingProjections.selected,
    resultingUnselectedProjection: resultingProjections.unselected,
    groundedVerifier,
    unchangedUnselected,
  }
  const application: MaterializedRepairApplicationReceipt = {
    ...projection,
    beforeCanonicalStructBytes: candidate.canonicalStructBytes,
    resultingCanonicalStructBytes,
    receiptSha256: hashTraceValue(projection),
  }
  const authorities: MaterializationVerificationAuthorities = {
    evidenceCandidates: [
      {
        referenceSha256: candidateReferenceSha256,
        bindingSha256: candidateBindingSha256,
      },
    ],
    sourceEvidenceVerifier: {
      identity: sourceEvidenceVerifierIdentity,
      verifyExpected: () => {
        throw new Error('expected-source verification is not used here')
      },
      resolveCandidate: () => candidateResolution,
    },
    groundedVerifier: {
      identity: verifierIdentity,
      verifySelected: () => groundedVerifier,
    },
  }
  return { application, authorities }
}

function artifactResolver(
  mutate?: (
    request: OwnerLocalArtifactResolutionRequest,
    bytes: Uint8Array,
  ) => Uint8Array | null,
): OwnerLocalArtifactResolver {
  return {
    identity: artifactResolverIdentity,
    resolve: (request) => {
      const source =
        request.kind === 'epub-download'
          ? 'epub'
          : request.kind === 'dom-snapshot'
            ? 'dom'
            : 'screenshot'
      const originalBytes = new TextEncoder().encode(source)
      const bytes = mutate ? mutate(request, originalBytes) : originalBytes
      if (bytes === null) return null
      const projection = {
        schemaVersion: '1.0.0' as const,
        resolverIdentity: artifactResolverIdentity,
        resolverIdentitySha256: hashTraceValue(artifactResolverIdentity),
        requestSha256: hashTraceValue(request),
        artifact: request.artifact,
        status: 'succeeded' as const,
      }
      return {
        ...projection,
        bytes,
        receiptSha256: hashTraceValue(projection),
      }
    },
  }
}

function privateReplayAuthorities(
  trace: ReconstructionAttemptTrace,
  mode?: 'lying-source-count' | 'lying-render-count' | 'unrelated-render',
  resolvedArtifacts = artifactResolver(),
): PrivateReplayAuthorities {
  return {
    artifactResolver: resolvedArtifacts,
    sourceEvidenceVerifier: {
      identity: sourceEvidenceVerifierIdentity,
      verifyExpected: (request) => {
        const expectedObservationSets =
          trace.sourceEvidence.expectedObservationSets.map((set, index) => {
            const labels =
              set.check === 'figures'
                ? ['source-figure']
                : [`value-${set.check}`]
            let payloadBytes = observationPayloadBytes(set.check, labels)
            let verifiedSet = { ...set, payloadBytes }
            if (mode === 'lying-source-count' && index === 0) {
              payloadBytes = observationPayloadBytes(set.check, [])
              const payload = {
                sha256: digest(payloadBytes),
                byteLength: payloadBytes.byteLength,
              }
              verifiedSet = {
                ...set,
                setSha256: payload.sha256,
                itemCount: 1,
                payload,
                payloadBytes,
              }
              verifiedSet.receiptSha256 =
                hashSourceExpectedObservationSet(verifiedSet)
            }
            return verifiedSet
          })
        const projection = {
          schemaVersion: '1.0.0' as const,
          verifierIdentity: sourceEvidenceVerifierIdentity,
          verifierIdentitySha256: hashTraceValue(
            sourceEvidenceVerifierIdentity,
          ),
          requestSha256: hashTraceValue(request),
          evidenceGraph: trace.evidenceGraph.artifact,
          expectedObservationSets: expectedObservationSets.map(
            ({ payloadBytes: _payloadBytes, ...set }) => set,
          ),
          status: 'succeeded' as const,
        }
        return {
          ...projection,
          evidenceGraphBytes: new TextEncoder().encode(
            'source-evidence-graph',
          ),
          expectedObservationSets,
          receiptSha256: hashTraceValue(projection),
        }
      },
      resolveCandidate: () => {
        throw new Error('candidate resolution is not used by this replay')
      },
    },
    renderObservationExtractor: {
      identity: renderObservationExtractorIdentity,
      extract: (request) => {
        const actualObservationSets =
          trace.renderedEpub.actualObservationSets.map((set, index) => {
            const labels =
              set.itemCount === 0
                ? []
                : set.check === 'figures'
                  ? ['source-figure']
                  : [`value-${set.check}`]
            let payloadBytes = observationPayloadBytes(set.check, labels)
            let verifiedSet = { ...set, payloadBytes }
            if (mode === 'lying-render-count' && index === 0) {
              payloadBytes = observationPayloadBytes(set.check, [])
              const payload = {
                sha256: digest(payloadBytes),
                byteLength: payloadBytes.byteLength,
              }
              verifiedSet = {
                ...set,
                setSha256: payload.sha256,
                itemCount: 1,
                payload,
                payloadBytes,
              }
              verifiedSet.receiptSha256 =
                hashRenderedActualObservationSet(verifiedSet)
            } else if (mode === 'unrelated-render' && index === 0) {
              payloadBytes = observationPayloadBytes(set.check, [])
              const payload = {
                sha256: digest(payloadBytes),
                byteLength: payloadBytes.byteLength,
              }
              verifiedSet = {
                ...set,
                setSha256: payload.sha256,
                itemCount: 0,
                payload,
                payloadBytes,
              }
              verifiedSet.receiptSha256 =
                hashRenderedActualObservationSet(verifiedSet)
            }
            return verifiedSet
          })
        const requestProjection = {
          ...request,
          artifacts: request.artifacts.map(
            ({ bytes: _bytes, ...artifact }) => artifact,
          ),
        }
        const anchorInventorySha256 = hashTraceValue(
          trace.renderedEpub.domSnapshots
            .map(({ spineHref, anchors }) => ({
              spineHref,
              anchors: [...anchors].sort(),
            }))
            .sort((left, right) =>
              left.spineHref.localeCompare(right.spineHref),
            ),
        )
        const projection = {
          schemaVersion: '1.0.0' as const,
          extractorIdentity: renderObservationExtractorIdentity,
          extractorIdentitySha256: hashTraceValue(
            renderObservationExtractorIdentity,
          ),
          requestSha256: hashTraceValue(requestProjection),
          anchorInventorySha256,
          actualObservationSets: actualObservationSets.map(
            ({ payloadBytes: _payloadBytes, ...set }) => set,
          ),
          status: 'succeeded' as const,
        }
        return {
          ...projection,
          actualObservationSets,
          receiptSha256: hashTraceValue(projection),
        }
      },
    },
    groundedVerifier: {
      identity: verifierIdentity,
      verifySelected: () => {
        throw new Error('selected grounding is not used without applications')
      },
    },
  }
}

describe('bounded reconstruction refinement', () => {
  it('rejects a malformed runtime contract before budget access', async () => {
    const result = await runReconstructionRefinement({
      contract: { budget: null } as unknown as ReconstructionCandidateContract,
      initialCandidate: initialCandidate(),
      dependencies: {} as never,
    })

    expect(result.publicReceipt).toMatchObject({
      status: 'failed',
      failureCode: 'invalid-candidate-contract',
    })
  })

  it('rejects public garbage without inspecting events', () => {
    expect(replayRefinementRun(null)).toBe(false)
    expect(replayRefinementRun({ events: null })).toBe(false)
    expect(replayRefinementRun({ events: 'private-source-text' })).toBe(false)
  })

  it('rejects a coordinator client identity mismatch before evaluation', async () => {
    const candidateContract = contract()
    const evaluate = vi.fn(async () => {
      throw new Error('must not evaluate with a drifted Codex client')
    })
    const result = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: initialCandidate(),
      dependencies: {
        evaluate,
        materializeRepair: async () => {
          throw new Error('must not materialize')
        },
        codex: {
          identity: {
            ...identity,
            model: { ...identity.model, version: '2026-08-02' },
          },
          probe: async () => ({ available: true }),
          createFreshTask: async () => null,
          proposeRepair: async () => null,
        },
      },
    })

    expect(result.publicReceipt.failureCode).toBe('codex-identity-mismatch')
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('maps malformed unknown Codex output to a failed receipt without materialization', async () => {
    const candidateContract = contract()
    const candidate = initialCandidate()
    const materializeRepair = vi.fn(async () => {
      throw new Error('must not materialize malformed output')
    })
    const result = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: candidate,
      dependencies: {
        evaluate: async (_candidate, context) =>
          attemptTrace(candidateContract, candidate, context.usage),
        materializeRepair,
        codex: {
          identity,
          probe: async () => ({ available: true }),
          createFreshTask: async (request) => ({
            taskIdSha256: digest('fresh-task'),
            documentId: candidateContract.documentId,
            runId: candidateContract.runId,
            fresh: true,
            parentTaskId: null,
            contextPolicy: 'immutable-prior-trace-only',
            acceptedTraceSha256: request.priorTraceSha256,
            identity,
          }),
          proposeRepair: async () => ({ proposal: null, usage: 'not-usage' }),
        },
      },
    })

    expect(result.publicReceipt).toMatchObject({
      authority: 'diagnostic-only',
      promotionAllowed: false,
      status: 'failed',
      failureCode: 'invalid-repair-proposal',
    })
    expect(materializeRepair).not.toHaveBeenCalled()
  })

  it('rejects an internally consistent invented public success receipt', () => {
    const candidateContract = contract()
    const traceSha256 = digest('invented-trace')
    const projection: Omit<RefinementRunReceipt, 'receiptSha256'> = {
      schemaVersion: '1.0.0',
      authority: 'diagnostic-only',
      promotionAllowed: false,
      contractSha256: candidateContract.contractSha256,
      status: 'publication-ready',
      failureCode: null,
      attempts: [
        {
          traceSha256,
          sourcePdfSha256,
          sourceEvidenceGraphSha256,
          canonicalStructSha256: digest('invented-struct'),
          attemptIndex: 0,
          parentTraceSha256: null,
          terminalStatus: 'publication-ready',
          firstCause: null,
          evidenceCandidateReferences: [candidateReferenceSha256],
          policy: candidateContract.budget,
          usage: {
            refinements: 0,
            freshTasks: 0,
            tokens: 0,
            durationMs: 0,
          },
        },
      ],
      proposalSha256s: [],
      freshTaskCount: 0,
      refinementCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, elapsedMs: 0 },
      events: [
        {
          sequence: 0,
          kind: 'server-verified',
          attemptIndex: 0,
          taskIdentitySha256: digest('invented-codex-identity'),
        },
        {
          sequence: 1,
          kind: 'rendered-and-compared',
          attemptIndex: 0,
          traceSha256,
        },
        {
          sequence: 2,
          kind: 'publication-ready',
          attemptIndex: 0,
          traceSha256,
        },
      ],
    }
    const receipt: RefinementRunReceipt = {
      ...projection,
      receiptSha256: reconstructionRefinementHash(projection),
    }

    expect(replayRefinementRun(receipt)).toBe(false)
  })

  it('accepts a closed grounded materialization receipt and rejects a fully rehashed whole-document replacement', () => {
    const candidateContract = contract()
    const candidate = initialCandidate()
    const proposal = patchFor(candidateContract, candidate)
    const { application, authorities } = applicationFor(
      candidateContract,
      candidate,
      proposal,
    )

    expect(
      parseMaterializedRepairApplicationReceipt(
        application,
        candidate,
        proposal,
        candidateContract,
        authorities,
      ),
    ).toEqual(application)

    const tamperedFixture = applicationFor(
      candidateContract,
      candidate,
      proposal,
      '{"assets":[],"blocks":[{"id":"unselected-replacement"}],"relationships":[{"id":"figure-relationship-1","status":"resolved"}]}',
    )
    const tampered = tamperedFixture.application
    const unchangedProjection = {
      schemaVersion: '1.0.0' as const,
      beforeSha256: tampered.beforeUnselectedProjection.sha256,
      afterSha256: tampered.beforeUnselectedProjection.sha256,
    }
    tampered.unchangedUnselected = {
      ...unchangedProjection,
      receiptSha256: hashTraceValue(unchangedProjection),
    }
    const { receiptSha256: _receiptSha256, ...tamperedProjection } = tampered
    delete (tamperedProjection as Partial<typeof tamperedProjection>)
      .beforeCanonicalStructBytes
    delete (tamperedProjection as Partial<typeof tamperedProjection>)
      .resultingCanonicalStructBytes
    tampered.receiptSha256 = hashTraceValue(tamperedProjection)

    expect(() =>
      parseMaterializedRepairApplicationReceipt(
        tampered,
        candidate,
        proposal,
        candidateContract,
        tamperedFixture.authorities,
      ),
    ).toThrow(/INVALID_MATERIALIZED/iu)
  })

  it('rejects self-hashed copied verifier identity over hallucinated selected JSON', () => {
    const candidateContract = contract()
    const candidate = initialCandidate()
    const proposal = patchFor(candidateContract, candidate)
    const trusted = applicationFor(candidateContract, candidate, proposal)
    const hallucinated = applicationFor(
      candidateContract,
      candidate,
      proposal,
      '{"assets":[],"blocks":[],"relationships":[{"id":"figure-relationship-1","status":"hallucinated"}]}',
    )

    expect(() =>
      parseMaterializedRepairApplicationReceipt(
        hallucinated.application,
        candidate,
        proposal,
        candidateContract,
        trusted.authorities,
      ),
    ).toThrow(/INVALID_MATERIALIZED/iu)
  })

  it('reopens and rehashes private EPUB, DOM, and screenshot artifacts before replay', async () => {
    const candidateContract = contract()
    const candidate = initialCandidate()
    const result = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: candidate,
      dependencies: {
        evaluate: async (_candidate, context) =>
          attemptTrace(
            candidateContract,
            candidate,
            context.usage,
            'publication-ready',
          ),
        materializeRepair: async () => {
          throw new Error('publication-ready must not materialize')
        },
        codex: {
          identity,
          probe: async () => ({ available: true }),
          createFreshTask: async () => null,
          proposeRepair: async () => null,
        },
      },
    })

    expect(result.publicReceipt).toMatchObject({
      status: 'publication-ready',
      failureCode: null,
    })
    expect(
      replayPrivateRefinementRun(
        candidateContract,
        result,
        privateReplayAuthorities(result.privateEvidence.traces[0]!),
      ),
    ).toBe(true)

    for (const kind of [
      'epub-download',
      'dom-snapshot',
      'screenshot',
    ] as const) {
      expect(
        replayPrivateRefinementRun(
          candidateContract,
          result,
          privateReplayAuthorities(
            result.privateEvidence.traces[0]!,
            undefined,
            artifactResolver((request) =>
              request.kind === kind
                ? new TextEncoder().encode(`tampered-${kind}`)
                : new TextEncoder().encode(
                    request.kind === 'epub-download'
                      ? 'epub'
                      : request.kind === 'dom-snapshot'
                        ? 'dom'
                        : 'screenshot',
                  ),
            ),
          ),
        ),
      ).toBe(false)
    }
    expect(
      replayPrivateRefinementRun(
        candidateContract,
        result,
        privateReplayAuthorities(
          result.privateEvidence.traces[0]!,
          undefined,
          artifactResolver((request, bytes) =>
            request.kind === 'epub-download' ? null : bytes,
          ),
        ),
      ),
    ).toBe(false)
  })

  it('rejects lying source or render counts and observations derived from unrelated DOM', async () => {
    const candidateContract = contract()
    const candidate = initialCandidate()
    const result = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: candidate,
      dependencies: {
        evaluate: async (_candidate, context) =>
          attemptTrace(
            candidateContract,
            candidate,
            context.usage,
            'publication-ready',
          ),
        materializeRepair: async () => {
          throw new Error('publication-ready must not materialize')
        },
        codex: {
          identity,
          probe: async () => ({ available: true }),
          createFreshTask: async () => null,
          proposeRepair: async () => null,
        },
      },
    })
    const trace = result.privateEvidence.traces[0]!

    for (const mode of [
      'lying-source-count',
      'lying-render-count',
      'unrelated-render',
    ] as const) {
      expect(
        replayPrivateRefinementRun(
          candidateContract,
          result,
          privateReplayAuthorities(trace, mode),
        ),
      ).toBe(false)
    }
  })

  it('enforces the coordinator deadline across the initial Codex probe', async () => {
    const candidateContract = contract({ maxDurationMs: 5 })
    const result = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: initialCandidate(),
      dependencies: {
        evaluate: async () => {
          throw new Error('must not evaluate after a timed-out probe')
        },
        materializeRepair: async () => {
          throw new Error('must not materialize after a timed-out probe')
        },
        codex: {
          identity,
          probe: async (signal, lease) =>
            new Promise(() => {
              signal.addEventListener(
                'abort',
                () => lease.acknowledgeAbort(),
                { once: true },
              )
            }),
          createFreshTask: async () => {
            throw new Error('must not create a task after a timed-out probe')
          },
          proposeRepair: async () => {
            throw new Error('must not propose after a timed-out probe')
          },
        },
      },
    })

    expect(result.publicReceipt.failureCode).toBe('codex-probe-timeout')
  })

  it('fences a concurrent duplicate run without invoking a second coordinator', async () => {
    const candidateContract = contract()
    const candidate = initialCandidate()
    const firstController = new AbortController()
    let blockedLease: import('./reconstruction-refinement').CoordinatorStageLease | undefined
    let releaseProbe: (() => void) | undefined
    const evaluate = vi.fn(async () => {
      throw new Error('a blocked probe must not evaluate')
    })
    const first = runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: candidate,
      signal: firstController.signal,
      dependencies: {
        evaluate,
        materializeRepair: async () => null,
        codex: {
          identity,
          probe: async (_signal, lease) =>
            new Promise((resolve) => {
              blockedLease = lease
              releaseProbe = () => resolve({ available: true })
            }),
          createFreshTask: async () => null,
          proposeRepair: async () => null,
        },
      },
    })

    const duplicate = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: candidate,
      dependencies: {
        evaluate,
        materializeRepair: async () => null,
        codex: {
          identity,
          probe: async () => ({ available: true }),
          createFreshTask: async () => null,
          proposeRepair: async () => null,
        },
      },
    })

    expect(duplicate.publicReceipt.failureCode).toBe('concurrent-run')
    expect(duplicate.privateEvidence.traces).toEqual([])
    expect(evaluate).not.toHaveBeenCalled()
    firstController.abort()
    expect((await first).publicReceipt.failureCode).toBe('interrupted')
    expect(blockedLease!.tryCommit()).toBe(false)

    const stillFenced = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: candidate,
      dependencies: {
        evaluate,
        materializeRepair: async () => null,
        codex: {
          identity,
          probe: async () => ({ available: false }),
          createFreshTask: async () => null,
          proposeRepair: async () => null,
        },
      },
    })
    expect(stillFenced.publicReceipt.failureCode).toBe('concurrent-run')

    const priorGenerationSha256 = blockedLease!.generationSha256
    releaseProbe!()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    let retryGenerationSha256: string | undefined
    const retry = await runReconstructionRefinement({
      contract: candidateContract,
      initialCandidate: candidate,
      dependencies: {
        evaluate,
        materializeRepair: async () => null,
        codex: {
          identity,
          probe: async (_signal, lease) => {
            retryGenerationSha256 = lease.generationSha256
            return { available: false }
          },
          createFreshTask: async () => null,
          proposeRepair: async () => null,
        },
      },
    })
    expect(retry.publicReceipt.failureCode).toBe('codex-server-unavailable')
    expect(retryGenerationSha256).not.toBe(priorGenerationSha256)
  })

  it.each([
    ['evaluate', 'evaluation-timeout'],
    ['createFreshTask', 'fresh-task-timeout'],
    ['proposeRepair', 'repair-proposal-timeout'],
    ['materialize', 'repair-application-timeout'],
  ] as const)(
    'uses the cumulative deadline for %s and ignores its late result',
    async (stage, expectedFailureCode) => {
      vi.useFakeTimers()
      try {
        const candidateContract = contract({ maxDurationMs: 50 })
        const candidate = initialCandidate()
        let lateLease: import('./reconstruction-refinement').CoordinatorStageLease | undefined
        let releaseLateResult: (() => void) | undefined
        const lateResult = new Promise<unknown>((resolve) => {
          releaseLateResult = () => resolve(null)
        })
        const run = runReconstructionRefinement({
          contract: candidateContract,
          initialCandidate: candidate,
          dependencies: {
            evaluate: async (_candidate, context) => {
              if (stage === 'evaluate') {
                lateLease = context.lease
                return lateResult as Promise<ReconstructionAttemptTrace>
              }
              return attemptTrace(candidateContract, candidate, context.usage)
            },
            materializeRepair: async (_candidate, _proposal, _signal, lease) => {
              if (stage === 'materialize') {
                lateLease = lease
                return lateResult
              }
              return null
            },
            codex: {
              identity,
              probe: async () => ({ available: true }),
              createFreshTask: async (request, _signal, lease) => {
                if (stage === 'createFreshTask') {
                  lateLease = lease
                  return lateResult
                }
                return {
                      taskIdSha256: digest('fresh-task'),
                      documentId: candidateContract.documentId,
                      runId: candidateContract.runId,
                      fresh: true,
                      parentTaskId: null,
                      contextPolicy: 'immutable-prior-trace-only',
                      acceptedTraceSha256: request.priorTraceSha256,
                      identity,
                    }
              },
              proposeRepair: async (request, _signal, lease) => {
                if (stage === 'proposeRepair') {
                  lateLease = lease
                  return lateResult
                }
                return {
                      proposal: createStructEvidencePatch({
                        schemaVersion: '1.0.0',
                        documentId: candidateContract.documentId,
                        sourcePdfSha256,
                        sourceEvidenceGraphSha256,
                        baseStructSha256:
                          candidate.binding.canonicalStruct.sha256,
                        priorTraceSha256: request.priorTraceSha256,
                        taskIdSha256: request.task.taskIdSha256,
                        operations: [
                          {
                            op: 'select-evidence-candidate',
                            targetKind: 'relationship',
                            targetId: 'figure-relationship-1',
                            candidateReferenceSha256,
                          },
                        ],
                      }),
                      usage: {
                        inputTokens: 1,
                        outputTokens: 1,
                        elapsedMs: 1,
                      },
                    }
              },
            },
          },
        })

        await vi.advanceTimersByTimeAsync(51)
        const result = await run
        expect(result.publicReceipt.failureCode).toBe(expectedFailureCode)
        const frozenResultSha256 = hashTraceValue(result.publicReceipt)
        expect(lateLease!.tryCommit()).toBe(false)

        const duplicate = await runReconstructionRefinement({
          contract: candidateContract,
          initialCandidate: candidate,
          dependencies: {
            evaluate: async () => {
              throw new Error('fenced duplicate must not evaluate')
            },
            materializeRepair: async () => null,
            codex: {
              identity,
              probe: async () => ({ available: false }),
              createFreshTask: async () => null,
              proposeRepair: async () => null,
            },
          },
        })
        expect(duplicate.publicReceipt.failureCode).toBe('concurrent-run')

        const expiredGenerationSha256 = lateLease!.generationSha256
        releaseLateResult!()
        await vi.runAllTimersAsync()
        expect(hashTraceValue(result.publicReceipt)).toBe(frozenResultSha256)
        expect(result.privateEvidence.applications).toEqual([])
        if (stage === 'evaluate') {
          expect(result.privateEvidence.traces).toEqual([])
        } else if (stage === 'createFreshTask') {
          expect(result.publicReceipt.freshTaskCount).toBe(0)
        } else if (stage === 'proposeRepair') {
          expect(result.publicReceipt.proposalSha256s).toEqual([])
        } else {
          expect(result.publicReceipt.refinementCount).toBe(0)
        }

        let retryGenerationSha256: string | undefined
        const retry = await runReconstructionRefinement({
          contract: candidateContract,
          initialCandidate: candidate,
          dependencies: {
            evaluate: async () => {
              throw new Error('unavailable retry must not evaluate')
            },
            materializeRepair: async () => null,
            codex: {
              identity,
              probe: async (_signal, lease) => {
                retryGenerationSha256 = lease.generationSha256
                return { available: false }
              },
              createFreshTask: async () => null,
              proposeRepair: async () => null,
            },
          },
        })
        expect(retry.publicReceipt.failureCode).toBe(
          'codex-server-unavailable',
        )
        expect(retryGenerationSha256).not.toBe(expiredGenerationSha256)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('keeps candidate references provider-neutral and opaque', () => {
    const candidateContract = contract()
    const candidate = initialCandidate()
    const proposal = patchFor(candidateContract, candidate)

    expect(candidateContract.repairScope[0]!.candidateReferenceSha256s).toEqual(
      [candidateReferenceSha256],
    )
    expect(proposal.operations[0]!.candidateReferenceSha256).toBe(
      candidateReferenceSha256,
    )
    expect(JSON.stringify({ candidateContract, proposal })).not.toMatch(
      /mineru|candidateId|privateSource/iu,
    )
  })
})
