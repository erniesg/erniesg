import {
  verifyActualProfiledEpubRender,
  verifyEpubCheckReceipt,
  type ActualProfiledEpubRender,
  type EpubCheckReceipt,
} from './actual-profiled-epub'
import {
  compareGroundedProfiledEpub,
  type GroundedProfiledEpubComparison,
} from './grounded-epub-comparison'
import {
  verifyGroundedCoreMaterializationBinding,
  type GroundedStructMaterialization,
} from './grounded-struct-materializer'
import {
  CLOSED_RECONSTRUCTION_PROFILE_IDS,
  createClosedThreeProfileReconstructionReceipt,
  type ClosedThreeProfileReconstructionReceipt,
  type ProfiledStructEpubArtifact,
} from './reconstruction-materialization'
import {
  canonicalTraceJson,
  hashTraceValue,
  parseReconstructionAttemptTrace,
  type ReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import { sha256HexSync } from './sha256-sync'
import type { SourceEvidenceContract } from './source-evidence-contract'
import type { LocalCodexReconciliationResult } from './local-codex-reconciliation'
import {
  verifyGroundedThreeProfileRefinementResult,
  type GroundedThreeProfileRefinementResult,
} from './grounded-reconstruction-refinement'
import { readSourceEvidenceGraph } from './source-evidence-graph'
import {
  inspectMineruSourceEvidence,
  type MineruArtifactManifest,
} from './mineru-source-evidence'

export const GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION = '1.0.0' as const
const SHA256 = /^[a-f0-9]{64}$/u

export const GROUNDED_MATERIALIZATION_PILOT_CASES = [
  'prose-hierarchy',
  'semantic-table-spans',
  'formula-text',
  'source-backed-figure',
  'link-destinations',
] as const

export type GroundedMaterializationPilotCase =
  (typeof GROUNDED_MATERIALIZATION_PILOT_CASES)[number]

export type GroundedMaterializationPilotProfile = {
  build: ProfiledStructEpubArtifact
  render: ActualProfiledEpubRender
  epubCheck: EpubCheckReceipt
  comparison: GroundedProfiledEpubComparison
  trace: ReconstructionAttemptTrace
}

export type GroundedMaterializationPilotDocument = {
  caseId: GroundedMaterializationPilotCase
  sourcePdfBytes: Uint8Array
  sourceExecution: {
    artifactRoot: string
    manifestBytes: Uint8Array
  }
  materialization: GroundedStructMaterialization
  sourceContract: SourceEvidenceContract
  priorTrace: ReconstructionAttemptTrace
  localCodexResult: LocalCodexReconciliationResult
  refinement: GroundedThreeProfileRefinementResult
  profiles: GroundedMaterializationPilotProfile[]
  outerReceipt: ClosedThreeProfileReconstructionReceipt
}

export type GroundedMaterializationPilotPacket = {
  schemaVersion: typeof GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION
  documents: GroundedMaterializationPilotDocument[]
  negativeControls: Array<{
    id: 'malformed-source-evidence'
    status: 'rejected'
    reason: string
  }>
}

export type GroundedMaterializationPilotReceipt = {
  schemaVersion: typeof GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION
  caseIds: typeof GROUNDED_MATERIALIZATION_PILOT_CASES
  documentCount: 5
  profileCount: 15
  documents: Array<{
    caseId: GroundedMaterializationPilotCase
    sourcePdfSha256: string
    mineruManifestSha256: string
    mineruProducerReceiptSha256: string
    mineruArtifactSetSha256: string
    materializationReceiptSha256: string
    outerReceiptSha256: string
    localCodexReceiptSha256: string
    refinementReceiptSha256: string
    codexRepairEvidenceSha256s: string[]
    profiles: Array<{
      profileId: ProfiledStructEpubArtifact['profileId']
      epubSha256: string
      renderReceiptSha256: string
      epubCheckReceiptSha256: string
      comparisonReceiptSha256: string
      traceSha256: string
    }>
  }>
  negativeControlReceiptSha256: string
  status: 'passed'
  receiptSha256: string
}

function invalid(code: string): never {
  throw new Error(code)
}

function assertCaseSemantics(document: GroundedMaterializationPilotDocument) {
  const { blocks, assets, relationships } = document.materialization.document
  switch (document.caseId) {
    case 'prose-hierarchy':
      if (blocks.filter(({ kind }) => kind === 'heading').length < 2)
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      return
    case 'semantic-table-spans':
      if (
        !blocks.some(
          ({ kind, table }) =>
            kind === 'table' &&
            table?.semantic === 'verified' &&
            table.cells.some(
              ({ rowSpan, columnSpan }) => rowSpan > 1 || columnSpan > 1,
            ),
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'formula-text':
      if (
        !blocks.some(
          ({ kind, text }) => kind === 'equation' && text.trim().length > 0,
        ) ||
        document.materialization.receipt.reviewReasons.includes(
          'formula-visual-crop',
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'source-backed-figure':
      if (
        !blocks.some(
          ({ kind, fallbackAssetIds }) =>
            kind === 'figure' &&
            (fallbackAssetIds ?? []).some((id) =>
              assets.some(
                (asset) =>
                  asset.id === id &&
                  (asset.kind === 'figure' || asset.kind === 'diagram') &&
                  asset.fallback === 'asset',
              ),
            ),
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'link-destinations':
      if (
        !relationships.some(
          ({ kind, status, to }) =>
            kind === 'hyperlink' && status === 'matched' && to.length === 1,
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
  }
}

export async function verifyGroundedMaterializationPilotMineruExecution(input: {
  sourceExecution: GroundedMaterializationPilotDocument['sourceExecution']
  sourcePdfSha256: string
  sourceContract: SourceEvidenceContract
}) {
  if (
    !input.sourceExecution ||
    typeof input.sourceExecution.artifactRoot !== 'string' ||
    input.sourceExecution.artifactRoot.length === 0 ||
    !(input.sourceExecution.manifestBytes instanceof Uint8Array)
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_MINERU_EXECUTION_REQUIRED')
  }
  let manifest: MineruArtifactManifest
  try {
    manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        input.sourceExecution.manifestBytes,
      ),
    ) as MineruArtifactManifest
  } catch {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_MINERU_MANIFEST')
  }
  const inspected = await inspectMineruSourceEvidence({
    artifactRoot: input.sourceExecution.artifactRoot,
    manifest,
  })
  const retained = input.sourceContract.graph.bundles.filter(
    ({ armId }) => armId === 'mineru',
  )
  if (
    retained.length !== 1 ||
    manifest.document.sha256 !== input.sourcePdfSha256 ||
    hashTraceValue(retained[0]) !== hashTraceValue(inspected)
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_MINERU_GRAPH_MISMATCH')
  }
  return {
    manifestSha256: sha256HexSync(input.sourceExecution.manifestBytes),
    producerReceiptSha256: manifest.producerReceipt.receiptSha256,
    artifactSetSha256: manifest.producerReceipt.artifactSetSha256,
  }
}

async function verifyDocument(document: GroundedMaterializationPilotDocument) {
  if (
    document.materialization.document.schemaVersion !== '0.2.0' ||
    document.materialization.receipt.status !== 'publication-ready' ||
    document.materialization.receipt.reviewReasons.length !== 0 ||
    new TextDecoder().decode(document.sourcePdfBytes.slice(0, 5)) !== '%PDF-' ||
    sha256HexSync(document.sourcePdfBytes) !==
      document.materialization.receipt.sourcePdfSha256 ||
    document.sourceContract.graphArtifact.sha256 !==
      document.materialization.receipt.sourceEvidenceGraphSha256 ||
    document.profiles.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length
  ) {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_DOCUMENT')
  }
  verifyGroundedCoreMaterializationBinding(document.materialization)
  const mineru = await verifyGroundedMaterializationPilotMineruExecution({
    sourceExecution: document.sourceExecution,
    sourcePdfSha256: document.materialization.receipt.sourcePdfSha256,
    sourceContract: document.sourceContract,
  })
  assertCaseSemantics(document)
  const priorTrace = parseReconstructionAttemptTrace(document.priorTrace)
  const selectedCandidateIdByReference = new Map(
    document.sourceContract.candidateReferences.map((reference) => [
      reference.referenceSha256,
      reference.candidateId,
    ]),
  )
  const expectedDecisions =
    document.materialization.receipt.obligationBindings.map((binding) => ({
      decisionId: binding.obligationId,
      candidateIds: [
        ...new Set(
          binding.candidateReferenceSha256.map((reference) => {
            const candidateId = selectedCandidateIdByReference.get(reference)
            if (!candidateId) invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
            return candidateId
          }),
        ),
      ].sort(),
    }))
  const candidateIds = [
    ...new Set(expectedDecisions.flatMap(({ candidateIds: ids }) => ids)),
  ]
  const localReceipt = document.localCodexResult.receipt
  const graphReader = readSourceEvidenceGraph(document.sourceContract.graph)
  const selectionByDecision = new Map<string, string>()
  for (const selection of document.localCodexResult.selections) {
    if (
      !('candidateId' in selection) ||
      selectionByDecision.has(selection.decisionId)
    ) {
      invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
    }
    selectionByDecision.set(selection.decisionId, selection.candidateId)
  }
  const receiptHashes = [
    localReceipt.isolatedSessionSha256,
    localReceipt.requestSha256,
    localReceipt.responseSha256,
    localReceipt.cropEvidenceSha256,
    localReceipt.threadSha256,
    localReceipt.turnSha256,
    ...Object.values(localReceipt.identities),
  ]
  if (
    priorTrace.terminalState !== 'failed' ||
    priorTrace.comparator.status !== 'failed' ||
    localReceipt.status !== 'accepted' ||
    localReceipt.documentIdSha256 !==
      sha256HexSync(document.materialization.receipt.documentId) ||
    localReceipt.attemptIdSha256 !== sha256HexSync(priorTrace.attemptId) ||
    localReceipt.graphSha256 !== document.sourceContract.graph.graphSha256 ||
    localReceipt.candidateSetSha256 !==
      graphReader.candidateSetSha256(candidateIds) ||
    localReceipt.comparisonEvidenceSha256 !== priorTrace.traceSha256 ||
    localReceipt.selectionSetSha256 !==
      hashTraceValue(document.localCodexResult.selections) ||
    localReceipt.counts.decisionCount !== expectedDecisions.length ||
    localReceipt.counts.candidateCount !== candidateIds.length ||
    localReceipt.counts.renderCount !==
      localReceipt.counts.sourceCropCount + localReceipt.counts.epubCropCount ||
    localReceipt.counts.sourceCropCount < 1 ||
    localReceipt.counts.epubCropCount < 1 ||
    localReceipt.usage.totalTokens < 1 ||
    localReceipt.usage.inputTokens < 1 ||
    localReceipt.usage.outputTokens < 1 ||
    localReceipt.usage.durationMs < 1 ||
    receiptHashes.some((value) => !SHA256.test(value)) ||
    document.localCodexResult.selections.length !== expectedDecisions.length ||
    expectedDecisions.some(({ decisionId, candidateIds: allowed }) => {
      const selected = selectionByDecision.get(decisionId)
      return selected === undefined || !allowed.includes(selected)
    })
  ) {
    invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
  }
  const repairEvidence = document.refinement?.codexRepairEvidence
  const lastRepair = repairEvidence?.at(-1)
  const repairParent = repairEvidence
    ? document.refinement.refinement.privateEvidence.traces[
        repairEvidence.length - 1
      ]
    : undefined
  const finalEvaluation = document.refinement?.evaluations.at(-1)
  const traceCodexProvider =
    finalEvaluation?.coordinatorTrace.providerReceipts.find(
      ({ role }) => role === 'owner-local-codex-reconciliation',
    )
  if (
    document.refinement?.receipt.status !== 'publication-ready' ||
    !document.refinement.closedReceipt ||
    !repairEvidence ||
    repairEvidence.length < 1 ||
    !lastRepair ||
    !repairParent ||
    !finalEvaluation ||
    !traceCodexProvider ||
    !traceCodexProvider.server ||
    !traceCodexProvider.model ||
    !traceCodexProvider.prompt ||
    !traceCodexProvider.tool
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REFINEMENT_MISMATCH')
  }
  if (
    canonicalTraceJson(lastRepair.result) !==
      canonicalTraceJson(document.localCodexResult) ||
    canonicalTraceJson(repairParent) !== canonicalTraceJson(priorTrace) ||
    finalEvaluation.materialization.receipt.receiptSha256 !==
      document.materialization.receipt.receiptSha256 ||
    canonicalTraceJson(document.refinement.closedReceipt) !==
      canonicalTraceJson(document.outerReceipt) ||
    !verifyGroundedThreeProfileRefinementResult({
      result: document.refinement,
      sourcePdf: finalEvaluation.coordinatorTrace.sourcePdf,
      sourceContract: document.sourceContract,
      codexIdentity: {
        server: traceCodexProvider.server,
        model: traceCodexProvider.model,
        prompt: traceCodexProvider.prompt,
        tool: traceCodexProvider.tool,
      },
      codexReconciliationReceiptSha256: traceCodexProvider.receiptSha256,
    })
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REFINEMENT_MISMATCH')
  }
  const operationCandidateIds = new Set(
    document.refinement.refinement.privateEvidence.traces
      .slice(1)
      .flatMap((trace) => trace.critiqueRepair?.proposal.operations ?? [])
      .map(({ candidateReferenceSha256 }) => {
        const candidate = document.sourceContract.candidateReferences.find(
          ({ referenceSha256 }) => referenceSha256 === candidateReferenceSha256,
        )
        if (!candidate) invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
        return candidate.candidateId
      }),
  )
  const selectedRepairCandidateIds = new Set(
    repairEvidence.flatMap(({ result }) =>
      result.selections.flatMap((selection) =>
        'candidateId' in selection ? [selection.candidateId] : [],
      ),
    ),
  )
  if (
    operationCandidateIds.size !== selectedRepairCandidateIds.size ||
    [...operationCandidateIds].some(
      (candidateId) => !selectedRepairCandidateIds.has(candidateId),
    )
  ) {
    invalid('PILOT_LOCAL_CODEX_REPAIR_APPLICATION_MISMATCH')
  }
  const byProfile = new Map(
    document.profiles.map((profile) => [profile.build.profileId, profile]),
  )
  if (
    byProfile.size !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    CLOSED_RECONSTRUCTION_PROFILE_IDS.some((id) => !byProfile.has(id))
  ) {
    invalid('INCOMPLETE_GROUNDED_MATERIALIZATION_PILOT_PROFILE_SET')
  }
  for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
    const profile = byProfile.get(profileId)!
    verifyActualProfiledEpubRender(profile.render)
    verifyEpubCheckReceipt(profile.epubCheck)
    const replayed = compareGroundedProfiledEpub({
      materialization: document.materialization,
      sourceContract: document.sourceContract,
      build: profile.build,
      render: profile.render,
      epubCheck: profile.epubCheck,
    })
    const trace = parseReconstructionAttemptTrace(profile.trace)
    if (
      replayed.receiptSha256 !== profile.comparison.receiptSha256 ||
      trace.comparator.status !== 'publication-ready' ||
      trace.comparator.failed !== 0 ||
      trace.epub.bytes.sha256 !== profile.build.epub.sha256 ||
      hashTraceValue(trace.comparator) !==
        hashTraceValue(profile.comparison.comparator)
    ) {
      invalid('GROUNDED_MATERIALIZATION_PILOT_REPLAY_MISMATCH')
    }
  }
  const traces = Object.fromEntries(
    CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => [
      profileId,
      byProfile.get(profileId)!.trace,
    ]),
  ) as Record<
    ProfiledStructEpubArtifact['profileId'],
    ReconstructionAttemptTrace
  >
  const builds = CLOSED_RECONSTRUCTION_PROFILE_IDS.map(
    (profileId) => byProfile.get(profileId)!.build,
  )
  const reopenedOuter = createClosedThreeProfileReconstructionReceipt({
    attempts: [
      {
        coordinatorProfileId: 'mobile',
        canonicalStructSha256:
          document.materialization.receipt.repairCore.sha256,
        materializationReceipt: document.materialization.receipt,
        traces,
        builds,
      },
    ],
  })
  if (
    canonicalTraceJson(reopenedOuter) !==
    canonicalTraceJson(document.outerReceipt)
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_OUTER_RECEIPT_MISMATCH')
  }
  return { byProfile, builds, mineru }
}

export async function verifyGroundedMaterializationPilotPacket(
  packet: GroundedMaterializationPilotPacket,
): Promise<GroundedMaterializationPilotReceipt> {
  if (
    packet.schemaVersion !== GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION ||
    packet.documents.length !== GROUNDED_MATERIALIZATION_PILOT_CASES.length ||
    packet.negativeControls.length !== 1 ||
    packet.negativeControls[0]?.id !== 'malformed-source-evidence' ||
    packet.negativeControls[0].status !== 'rejected' ||
    packet.negativeControls[0].reason.trim().length === 0
  ) {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_PACKET')
  }
  const byCase = new Map(
    packet.documents.map((document) => [document.caseId, document]),
  )
  if (
    byCase.size !== GROUNDED_MATERIALIZATION_PILOT_CASES.length ||
    GROUNDED_MATERIALIZATION_PILOT_CASES.some((id) => !byCase.has(id)) ||
    new Set(
      packet.documents.map(
        ({ materialization }) => materialization.receipt.sourcePdfSha256,
      ),
    ).size !== GROUNDED_MATERIALIZATION_PILOT_CASES.length
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REQUIRES_FIVE_UNIQUE_SUCCESSES')
  }
  const documents = [] as GroundedMaterializationPilotReceipt['documents']
  for (const caseId of GROUNDED_MATERIALIZATION_PILOT_CASES) {
    const document = byCase.get(caseId)!
    const { byProfile, mineru } = await verifyDocument(document)
    documents.push({
      caseId,
      sourcePdfSha256: document.materialization.receipt.sourcePdfSha256,
      mineruManifestSha256: mineru.manifestSha256,
      mineruProducerReceiptSha256: mineru.producerReceiptSha256,
      mineruArtifactSetSha256: mineru.artifactSetSha256,
      materializationReceiptSha256:
        document.materialization.receipt.receiptSha256,
      outerReceiptSha256: document.outerReceipt.receiptSha256,
      localCodexReceiptSha256: hashTraceValue(
        document.localCodexResult.receipt,
      ),
      refinementReceiptSha256: document.refinement.receipt.receiptSha256,
      codexRepairEvidenceSha256s: document.refinement.codexRepairEvidence.map(
        ({ evidenceSha256 }) => evidenceSha256,
      ),
      profiles: CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
        const profile = byProfile.get(profileId)!
        return {
          profileId,
          epubSha256: profile.build.epub.sha256,
          renderReceiptSha256: profile.render.receiptSha256,
          epubCheckReceiptSha256: profile.epubCheck.receiptSha256,
          comparisonReceiptSha256: profile.comparison.receiptSha256,
          traceSha256: profile.trace.traceSha256,
        }
      }),
    })
  }
  const projection = {
    schemaVersion: GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION,
    caseIds: GROUNDED_MATERIALIZATION_PILOT_CASES,
    documentCount: 5 as const,
    profileCount: 15 as const,
    documents,
    negativeControlReceiptSha256: hashTraceValue(packet.negativeControls[0]),
    status: 'passed' as const,
  }
  return { ...projection, receiptSha256: hashTraceValue(projection) }
}
