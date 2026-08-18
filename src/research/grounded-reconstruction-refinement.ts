import {
  renderExactThreeProfileEpubs,
  runEpubCheckWarningsFatal,
  verifyActualProfiledEpubRender,
  verifyEpubCheckReceipt,
  type ActualProfiledEpubRender,
  type EpubCheckReceipt,
  type EpubCheckExecution,
} from './actual-profiled-epub'
import {
  compareGroundedProfiledEpub,
  createGroundedActualReconstructionTrace,
  type GroundedProfiledEpubComparison,
  type OwnerLocalCodexTraceIdentity,
} from './grounded-epub-comparison'
import type { GroundedStructMaterialization } from './grounded-struct-materializer'
import {
  verifyGroundedCoreMaterializationBinding,
  type GroundedStructCandidateSelection,
  type GroundedStructMaterializationInput,
} from './grounded-struct-materializer'
import {
  applyGroundedStructRepair,
  type GroundedStructRepairApplication,
} from './grounded-struct-repair-applicator'
import {
  CLOSED_RECONSTRUCTION_PROFILE_IDS,
  buildExactThreeProfileStructEpubs,
  classifyMonotonicReconstructionTransition,
  createClosedThreeProfileReconstructionReceipt,
  createReconstructionHardCheckVector,
  type ClosedThreeProfileReconstructionReceipt,
  type ClosedReconstructionProfileId,
  type ClosedThreeProfileAttempt,
  type ProfiledStructEpubArtifact,
  type ReconstructionHardCheckVector,
} from './reconstruction-materialization'
import type {
  ProviderReceiptBinding,
  ReconstructionAttemptTrace,
  SourcePdfBinding,
} from './reconstruction-attempt-trace'
import {
  canonicalTraceJson,
  hashAppliedRepairBinding,
  hashTraceValue,
  parseReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import {
  runReconstructionRefinement,
  type MaterializationVerificationAuthorities,
  type ReconstructionCandidate,
  type ReconstructionCandidateContract,
  type ReconstructionRefinementRunResult,
  type RefinementCodexClient,
  type StructEvidencePatch,
} from './reconstruction-refinement'
import type { SourceEvidenceContract } from './source-evidence-contract'
import type { StructuredExtractionProposal } from './structured-extraction'
import type { LocalCodexReconciliationResult } from './local-codex-reconciliation'

export const GROUNDED_RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION =
  '1.0.0' as const

export type GroundedThreeProfileEvaluation = {
  schemaVersion: typeof GROUNDED_RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION
  materialization: GroundedStructMaterialization
  attempt: ClosedThreeProfileAttempt
  profiles: Array<{
    build: ProfiledStructEpubArtifact
    render: ActualProfiledEpubRender
    epubCheck: EpubCheckReceipt
    comparison: GroundedProfiledEpubComparison
    trace: ReconstructionAttemptTrace
  }>
  vectors: ReconstructionHardCheckVector[]
  coordinatorProfileId: ClosedReconstructionProfileId
  coordinatorTrace: ReconstructionAttemptTrace
}

export type GroundedThreeProfileEvaluationInput = {
  attemptId: string
  sourcePdf: SourcePdfBinding
  materialization: GroundedStructMaterialization
  sourceContract: SourceEvidenceContract
  codexIdentity: OwnerLocalCodexTraceIdentity
  codexReceiptSha256: string
  lineage?: ReconstructionAttemptTrace['lineage']
  critiqueRepair?: ReconstructionAttemptTrace['critiqueRepair']
  repairProviderReceipt?: ProviderReceiptBinding
  budget?: ReconstructionAttemptTrace['budget']
  executeEpubCheck: (
    epubBytes: Uint8Array,
    profileId: ClosedReconstructionProfileId,
  ) => Promise<EpubCheckExecution>
}

export type GroundedRefinementCodexClient = RefinementCodexClient & {
  repairProviderReceipt: (
    proposal: StructEvidencePatch,
  ) => ProviderReceiptBinding
  repairEvidence: () => GroundedCodexRepairEvidence[]
  close: () => Promise<void>
}

export type GroundedCodexRepairEvidence = {
  sessionSha256: string
  proposalSha256: string
  result: LocalCodexReconciliationResult
  providerReceipt: ProviderReceiptBinding
  evidenceSha256: string
}

export type GroundedRefinementAttemptLedgerEntry = {
  attemptIndex: number
  candidateBindingSha256: string
  selectedTraceSha256: string
  profileTraceSha256s: Record<ClosedReconstructionProfileId, string>
  profileBuildReceiptSha256s: Record<ClosedReconstructionProfileId, string>
  bestBeforeCandidateBindingSha256: string
  bestAfterCandidateBindingSha256: string
  disposition:
    'baseline' | 'accepted-best' | 'rejected-exploratory' | 'terminal-pass'
  rejectionReason: 'hard-gate-regression' | 'first-cause-not-improved' | null
  entrySha256: string
}

export type GroundedThreeProfileRefinementReceipt = {
  schemaVersion: typeof GROUNDED_RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION
  contractSha256: string
  refinementReceiptSha256: string
  attempts: GroundedRefinementAttemptLedgerEntry[]
  codexRepairEvidenceSha256s: string[]
  bestCandidateBindingSha256: string
  finalCandidateBindingSha256: string
  closedReceiptSha256: string | null
  status: 'publication-ready' | 'failed'
  receiptSha256: string
}

export type GroundedThreeProfileRefinementResult = {
  refinement: ReconstructionRefinementRunResult
  receipt: GroundedThreeProfileRefinementReceipt
  closedReceipt: ClosedThreeProfileReconstructionReceipt | null
  evaluations: GroundedThreeProfileEvaluation[]
  codexRepairEvidence: GroundedCodexRepairEvidence[]
}

export type GroundedThreeProfileRefinementInput = {
  contract: ReconstructionCandidateContract
  initialCandidate: ReconstructionCandidate
  initialMaterialization: GroundedStructMaterialization
  initialMaterializationInput: GroundedStructMaterializationInput
  sourcePdf: SourcePdfBinding
  sourceContract: SourceEvidenceContract
  codexIdentity: OwnerLocalCodexTraceIdentity
  codexReconciliationReceiptSha256: string
  codex: GroundedRefinementCodexClient
  materializationVerification: MaterializationVerificationAuthorities
  executeEpubCheck: GroundedThreeProfileEvaluationInput['executeEpubCheck']
  resolveResultingProposal: (input: {
    before: GroundedStructMaterializationInput
    patch: StructEvidencePatch
    signal: AbortSignal
  }) => StructuredExtractionProposal | Promise<StructuredExtractionProposal>
  signal?: AbortSignal
}

type CandidateState = {
  candidate: ReconstructionCandidate
  materialization: GroundedStructMaterialization
  materializationInput: GroundedStructMaterializationInput
  application?: GroundedStructRepairApplication
  patch?: StructEvidencePatch
  parentEvaluation?: GroundedThreeProfileEvaluation
  repairProviderReceipt?: ProviderReceiptBinding
}

function coordinatorProfile(vectors: readonly ReconstructionHardCheckVector[]) {
  for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
    if (vectors.find((vector) => vector.profileId === profileId)?.firstCause) {
      return profileId
    }
  }
  return 'mobile'
}

/**
 * Execute one real reconstruction attempt. Required provider execution is
 * deliberately non-optional: callers must supply an EPUBCheck executor, while
 * this function owns the three actual builds, Chromium renders, comparisons,
 * and frozen #199 traces.
 */
export async function evaluateGroundedThreeProfileAttempt(
  input: GroundedThreeProfileEvaluationInput,
): Promise<GroundedThreeProfileEvaluation> {
  const builds = await buildExactThreeProfileStructEpubs(
    input.materialization.document,
    input.materialization.canonicalStructBytes,
  )
  const renders = await renderExactThreeProfileEpubs(builds)
  const epubChecks = await Promise.all(
    builds.map((build) =>
      runEpubCheckWarningsFatal(build, (bytes) =>
        input.executeEpubCheck(bytes, build.profileId),
      ),
    ),
  )
  const comparisons = builds.map((build, index) =>
    compareGroundedProfiledEpub({
      materialization: input.materialization,
      sourceContract: input.sourceContract,
      build,
      render: renders[index]!,
      epubCheck: epubChecks[index]!,
    }),
  )
  const traces = Object.fromEntries(
    comparisons.map((comparison) => [
      comparison.profileId,
      createGroundedActualReconstructionTrace({
        attemptId: `${input.attemptId}-${comparison.profileId}`,
        sourcePdf: input.sourcePdf,
        materialization: input.materialization,
        sourceContract: input.sourceContract,
        comparison,
        codexIdentity: input.codexIdentity,
        codexReceiptSha256: input.codexReceiptSha256,
        ...(input.lineage ? { lineage: input.lineage } : {}),
        ...(input.critiqueRepair !== undefined
          ? { critiqueRepair: input.critiqueRepair }
          : {}),
        ...(input.repairProviderReceipt
          ? { repairProviderReceipt: input.repairProviderReceipt }
          : {}),
        ...(input.budget ? { budget: input.budget } : {}),
      }),
    ]),
  ) as Record<ClosedReconstructionProfileId, ReconstructionAttemptTrace>
  const vectors = CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) =>
    createReconstructionHardCheckVector(profileId, traces[profileId]),
  )
  const coordinatorProfileId = coordinatorProfile(vectors)
  const attempt: ClosedThreeProfileAttempt = {
    coordinatorProfileId,
    canonicalStructSha256: input.materialization.receipt.repairCore.sha256,
    materializationReceipt: input.materialization.receipt,
    traces,
    builds,
  }
  const profiles = CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
    const index = builds.findIndex((build) => build.profileId === profileId)
    return {
      build: builds[index]!,
      render: renders[index]!,
      epubCheck: epubChecks[index]!,
      comparison: comparisons[index]!,
      trace: traces[profileId],
    }
  })
  return {
    schemaVersion: GROUNDED_RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION,
    materialization: structuredClone(input.materialization),
    attempt,
    profiles,
    vectors,
    coordinatorProfileId,
    coordinatorTrace: traces[coordinatorProfileId],
  }
}

/**
 * Reopen every retained build/render/comparison and reconstruct each frozen
 * #199 trace. Public refinement diagnostics alone are never promotion proof;
 * this is the #200 outer replay over the retained private artifacts.
 */
export function verifyGroundedThreeProfileRefinementResult(input: {
  result: GroundedThreeProfileRefinementResult
  sourcePdf: SourcePdfBinding
  sourceContract: SourceEvidenceContract
  codexIdentity: OwnerLocalCodexTraceIdentity
  codexReconciliationReceiptSha256: string
}) {
  try {
    const fail = (code: string): never => {
      throw new Error(code)
    }
    const { result } = input
    if (
      result.evaluations.length < 1 ||
      result.evaluations.length > 4 ||
      result.evaluations.length !== result.receipt.attempts.length ||
      result.evaluations.length !==
        result.refinement.privateEvidence.traces.length
    ) {
      fail('INVALID_GROUNDED_REFINEMENT_RESULT_COUNTS')
    }
    if (
      result.codexRepairEvidence.length !==
        result.refinement.publicReceipt.proposalSha256s.length ||
      result.refinement.privateEvidence.applications.length >
        result.codexRepairEvidence.length ||
      (result.refinement.publicReceipt.status === 'publication-ready' &&
        result.codexRepairEvidence.length !==
          result.refinement.privateEvidence.applications.length)
    ) {
      fail('INVALID_GROUNDED_REFINEMENT_CODEX_EVIDENCE_COUNT')
    }
    let measuredInputTokens = 0
    let measuredOutputTokens = 0
    for (const [index, evidence] of result.codexRepairEvidence.entries()) {
      const { evidenceSha256: _evidenceSha256, ...evidenceProjection } =
        evidence
      const parentTrace = parseReconstructionAttemptTrace(
        result.refinement.privateEvidence.traces[index],
      )
      const childTrace = result.refinement.privateEvidence.traces[index + 1]
      const childProvider = childTrace?.providerReceipts.find(
        ({ role }) => role === 'owner-local-codex-repair',
      )
      const application = result.refinement.privateEvidence.applications[index]
      const providerProjection = {
        schemaVersion: '1.0.0',
        sessionSha256: evidence.sessionSha256,
        localReceipt: evidence.result.receipt,
        proposalSha256: evidence.proposalSha256,
      }
      if (
        evidence.evidenceSha256 !== hashTraceValue(evidenceProjection) ||
        evidence.proposalSha256 !==
          result.refinement.publicReceipt.proposalSha256s[index] ||
        evidence.result.receipt.selectionSetSha256 !==
          hashTraceValue(evidence.result.selections) ||
        evidence.result.receipt.usage.totalTokens !==
          evidence.result.receipt.usage.inputTokens +
            evidence.result.receipt.usage.outputTokens ||
        evidence.result.receipt.usage.totalTokens < 1 ||
        evidence.result.receipt.usage.durationMs < 1 ||
        evidence.providerReceipt.role !== 'owner-local-codex-repair' ||
        evidence.providerReceipt.receiptSha256 !==
          hashTraceValue(providerProjection) ||
        evidence.providerReceipt.inputSha256 !==
          hashTraceValue(parentTrace.comparator) ||
        evidence.providerReceipt.outputSha256 !== evidence.proposalSha256 ||
        (application !== undefined &&
          application.proposalSha256 !== evidence.proposalSha256) ||
        (childProvider !== undefined &&
          canonicalTraceJson(childProvider) !==
            canonicalTraceJson(evidence.providerReceipt)) ||
        (result.refinement.publicReceipt.status === 'publication-ready' &&
          !childProvider)
      ) {
        fail('INVALID_GROUNDED_REFINEMENT_CODEX_EVIDENCE')
      }
      measuredInputTokens += evidence.result.receipt.usage.inputTokens
      measuredOutputTokens += evidence.result.receipt.usage.outputTokens
    }
    if (
      measuredInputTokens !==
        result.refinement.publicReceipt.usage.inputTokens ||
      measuredOutputTokens !==
        result.refinement.publicReceipt.usage.outputTokens
    ) {
      fail('GROUNDED_REFINEMENT_CODEX_USAGE_MISMATCH')
    }
    let bestIndex = 0
    for (const [attemptIndex, evaluation] of result.evaluations.entries()) {
      if (
        evaluation.schemaVersion !==
          GROUNDED_RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION ||
        evaluation.attempt.materializationReceipt.receiptSha256 !==
          evaluation.materialization.receipt.receiptSha256 ||
        evaluation.attempt.canonicalStructSha256 !==
          evaluation.materialization.receipt.repairCore.sha256 ||
        evaluation.profiles.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length
      ) {
        fail('INVALID_GROUNDED_REFINEMENT_EVALUATION_BINDING')
      }
      verifyGroundedCoreMaterializationBinding(evaluation.materialization)
      const byProfile = new Map(
        evaluation.profiles.map((profile) => [
          profile.build.profileId,
          profile,
        ]),
      )
      if (
        byProfile.size !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
        CLOSED_RECONSTRUCTION_PROFILE_IDS.some((id) => !byProfile.has(id))
      ) {
        fail('INVALID_GROUNDED_REFINEMENT_PROFILE_SET')
      }
      for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
        const profile = byProfile.get(profileId)!
        verifyActualProfiledEpubRender(profile.render)
        verifyEpubCheckReceipt(profile.epubCheck)
        const replayedComparison = compareGroundedProfiledEpub({
          materialization: evaluation.materialization,
          sourceContract: input.sourceContract,
          build: profile.build,
          render: profile.render,
          epubCheck: profile.epubCheck,
        })
        if (
          replayedComparison.receiptSha256 !== profile.comparison.receiptSha256
        ) {
          fail('GROUNDED_REFINEMENT_COMPARISON_REPLAY_MISMATCH')
        }
        const trace = parseReconstructionAttemptTrace(profile.trace)
        const repairProviders = trace.providerReceipts.filter(
          ({ role }) => role === 'owner-local-codex-repair',
        )
        if (repairProviders.length > 1) {
          fail('DUPLICATE_GROUNDED_REPAIR_PROVIDER')
        }
        const replayedTrace = createGroundedActualReconstructionTrace({
          attemptId: trace.attemptId,
          sourcePdf: input.sourcePdf,
          materialization: evaluation.materialization,
          sourceContract: input.sourceContract,
          comparison: replayedComparison,
          codexIdentity: input.codexIdentity,
          codexReceiptSha256: input.codexReconciliationReceiptSha256,
          lineage: trace.lineage,
          critiqueRepair: trace.critiqueRepair,
          ...(repairProviders[0]
            ? { repairProviderReceipt: repairProviders[0] }
            : {}),
          budget: trace.budget,
        })
        if (
          canonicalTraceJson(replayedTrace) !== canonicalTraceJson(trace) ||
          canonicalTraceJson(evaluation.attempt.traces[profileId]) !==
            canonicalTraceJson(trace)
        ) {
          fail('GROUNDED_REFINEMENT_TRACE_REPLAY_MISMATCH')
        }
      }
      const entry = result.receipt.attempts[attemptIndex]!
      const { entrySha256: _entrySha256, ...entryProjection } = entry
      const bestBeforeIndex = bestIndex
      const transition =
        attemptIndex === 0
          ? null
          : classifyMonotonicReconstructionTransition(
              result.evaluations[bestIndex]!.vectors,
              evaluation.vectors,
            )
      if (transition?.status === 'accepted') bestIndex = attemptIndex
      const terminal = evaluation.vectors.every(
        ({ failedCount }) => failedCount === 0,
      )
      const expectedDisposition =
        attemptIndex === 0
          ? terminal
            ? 'terminal-pass'
            : 'baseline'
          : transition?.status === 'accepted'
            ? terminal
              ? 'terminal-pass'
              : 'accepted-best'
            : 'rejected-exploratory'
      const expectedRejectionReason =
        transition?.status === 'rejected' ? transition.reason : null
      if (
        entry.entrySha256 !== hashTraceValue(entryProjection) ||
        entry.attemptIndex !== attemptIndex ||
        entry.candidateBindingSha256.length !== 64 ||
        entry.selectedTraceSha256 !== evaluation.coordinatorTrace.traceSha256 ||
        entry.bestBeforeCandidateBindingSha256 !==
          result.receipt.attempts[bestBeforeIndex]!.candidateBindingSha256 ||
        entry.bestAfterCandidateBindingSha256 !==
          result.receipt.attempts[bestIndex]!.candidateBindingSha256 ||
        entry.disposition !== expectedDisposition ||
        entry.rejectionReason !== expectedRejectionReason ||
        CLOSED_RECONSTRUCTION_PROFILE_IDS.some(
          (profileId) =>
            entry.profileTraceSha256s[profileId] !==
              evaluation.attempt.traces[profileId].traceSha256 ||
            entry.profileBuildReceiptSha256s[profileId] !==
              evaluation.attempt.builds.find(
                (build) => build.profileId === profileId,
              )?.receiptSha256,
        ) ||
        evaluation.coordinatorProfileId !==
          evaluation.attempt.coordinatorProfileId ||
        canonicalTraceJson(
          result.refinement.privateEvidence.traces[attemptIndex],
        ) !== canonicalTraceJson(evaluation.coordinatorTrace)
      ) {
        fail('GROUNDED_REFINEMENT_LEDGER_MISMATCH')
      }
    }
    const { receiptSha256: _receiptSha256, ...receiptProjection } =
      result.receipt
    const finalIndex = result.evaluations.length - 1
    const canPublish =
      result.refinement.publicReceipt.status === 'publication-ready' &&
      bestIndex === finalIndex &&
      result.evaluations[finalIndex]!.vectors.every(
        ({ failedCount }) => failedCount === 0,
      )
    if (
      result.receipt.receiptSha256 !== hashTraceValue(receiptProjection) ||
      result.receipt.refinementReceiptSha256 !==
        result.refinement.publicReceipt.receiptSha256 ||
      hashTraceValue(result.receipt.codexRepairEvidenceSha256s) !==
        hashTraceValue(
          result.codexRepairEvidence.map(
            ({ evidenceSha256 }) => evidenceSha256,
          ),
        ) ||
      result.receipt.bestCandidateBindingSha256 !==
        result.receipt.attempts[bestIndex]!.candidateBindingSha256 ||
      result.receipt.finalCandidateBindingSha256 !==
        result.receipt.attempts[finalIndex]!.candidateBindingSha256 ||
      result.receipt.status !== (canPublish ? 'publication-ready' : 'failed')
    ) {
      fail('GROUNDED_REFINEMENT_RECEIPT_MISMATCH')
    }
    if (result.receipt.status === 'publication-ready') {
      if (!result.closedReceipt) fail('MISSING_GROUNDED_REFINEMENT_RECEIPT')
      const replayedClosed = createClosedThreeProfileReconstructionReceipt({
        attempts: result.evaluations.map(({ attempt }) => attempt),
      })
      return (
        canonicalTraceJson(replayedClosed) ===
          canonicalTraceJson(result.closedReceipt) &&
        result.receipt.closedReceiptSha256 === replayedClosed.receiptSha256
      )
    }
    return (
      result.closedReceipt === null &&
      result.receipt.closedReceiptSha256 === null
    )
  } catch {
    return false
  }
}

function repairLineage(
  state: CandidateState,
  attemptIndex: number,
  parentTraceSha256: string | null,
) {
  if (attemptIndex === 0) {
    return {
      lineage: {
        attemptIndex: 0,
        parentTraceSha256: null,
        immutablePriorTraceSha256: null,
        appliedRepair: null,
      },
      critiqueRepair: null,
      repairProviderReceipt: undefined,
    } as const
  }
  const application = state.application
  const patch = state.patch
  const parent = state.parentEvaluation?.coordinatorTrace
  if (!application || !patch || !parent || !parentTraceSha256) {
    throw new Error('MISSING_GROUNDED_REFINEMENT_LINEAGE')
  }
  const repairProviderReceipt = state.repairProviderReceipt
  if (!repairProviderReceipt) {
    throw new Error('MISSING_GROUNDED_REPAIR_PROVIDER_RECEIPT')
  }
  const appliedRepair = {
    proposalSha256: patch.proposalSha256,
    baseStructSha256:
      application.applicationReceipt.beforeCanonicalStruct.sha256,
    resultingStructSha256:
      application.applicationReceipt.resultingCanonicalStruct.sha256,
    applicationReceiptSha256: application.applicationReceipt.receiptSha256,
    groundedVerifierReceiptSha256:
      application.applicationReceipt.groundedVerifier.receiptSha256,
    applicationSha256: '',
  }
  appliedRepair.applicationSha256 = hashAppliedRepairBinding(appliedRepair)
  return {
    lineage: {
      attemptIndex,
      parentTraceSha256,
      immutablePriorTraceSha256: parentTraceSha256,
      appliedRepair,
    },
    critiqueRepair: {
      providerReceiptId: repairProviderReceipt.id,
      priorComparatorSha256: hashTraceValue(parent.comparator),
      priorFirstCauseFailureId: parent.comparator.firstCauseFailureId!,
      critiqueSha256: repairProviderReceipt.receiptSha256,
      proposal: patch,
      disposition: 'verified' as const,
    },
    repairProviderReceipt,
  }
}

function selectionsFromReceipt(
  materialization: GroundedStructMaterialization,
): GroundedStructCandidateSelection[] {
  return materialization.receipt.selections.map(
    ({ resolutionReceiptSha256: _resolutionReceiptSha256, ...selection }) => ({
      op: 'select-evidence-candidate' as const,
      ...selection,
    }),
  )
}

function ledgerProjection(
  entry: Omit<GroundedRefinementAttemptLedgerEntry, 'entrySha256'>,
) {
  return entry
}

function codexEvidenceProjection(
  evidence: Omit<GroundedCodexRepairEvidence, 'evidenceSha256'>,
) {
  return evidence
}

/**
 * Run the #199 bounded loop exactly once while each evaluation closes all
 * three real profiles. Exploration may continue through a rejected sibling;
 * only the separate best pointer advances on monotonic improvement.
 */
export async function runGroundedThreeProfileRefinement(
  input: GroundedThreeProfileRefinementInput,
): Promise<GroundedThreeProfileRefinementResult> {
  const initialBridge = verifyGroundedCoreMaterializationBinding(
    input.initialMaterialization,
  )
  if (
    input.initialCandidate.binding.canonicalStruct.sha256 !==
      initialBridge.repairCore.sha256 ||
    input.initialCandidate.binding.bindingSha256 === '' ||
    input.contract.budget.maxRefinements !== 3 ||
    input.contract.budget.maxFreshTasks !== 1
  ) {
    throw new Error('INVALID_GROUNDED_REFINEMENT_INPUT')
  }
  const stateByBinding = new Map<string, CandidateState>()
  stateByBinding.set(input.initialCandidate.binding.bindingSha256, {
    candidate: input.initialCandidate,
    materialization: input.initialMaterialization,
    materializationInput: input.initialMaterializationInput,
  })
  const evaluations: GroundedThreeProfileEvaluation[] = []
  const entries: GroundedRefinementAttemptLedgerEntry[] = []
  let bestState = stateByBinding.get(
    input.initialCandidate.binding.bindingSha256,
  )!
  let bestEvaluation: GroundedThreeProfileEvaluation | undefined
  let finalState = bestState
  let refinement: ReconstructionRefinementRunResult
  try {
    refinement = await runReconstructionRefinement({
      contract: input.contract,
      initialCandidate: input.initialCandidate,
      ...(input.signal ? { signal: input.signal } : {}),
      dependencies: {
        codex: input.codex,
        materializationVerification: input.materializationVerification,
        evaluate: async (candidate, context) => {
          const state = stateByBinding.get(candidate.binding.bindingSha256)
          if (!state) throw new Error('UNKNOWN_GROUNDED_REFINEMENT_CANDIDATE')
          const lineage = repairLineage(
            state,
            context.attemptIndex,
            context.parentTraceSha256,
          )
          const evaluation = await evaluateGroundedThreeProfileAttempt({
            attemptId: `${input.contract.runId}-${context.attemptIndex}`,
            sourcePdf: input.sourcePdf,
            materialization: state.materialization,
            sourceContract: input.sourceContract,
            codexIdentity: input.codexIdentity,
            codexReceiptSha256: input.codexReconciliationReceiptSha256,
            lineage: lineage.lineage,
            critiqueRepair: lineage.critiqueRepair,
            ...(lineage.repairProviderReceipt
              ? { repairProviderReceipt: lineage.repairProviderReceipt }
              : {}),
            budget: {
              policy: {
                maxRefinements: input.contract.budget.maxRefinements,
                maxFreshTasks: input.contract.budget.maxFreshTasks,
                maxTokens: input.contract.budget.maxTokens,
                maxDurationMs: input.contract.budget.maxDurationMs,
                repairPolicySha256: input.contract.budget.repairPolicySha256,
              },
              usage: context.usage,
            },
            executeEpubCheck: input.executeEpubCheck,
          })
          const bestBefore = bestState.candidate.binding.bindingSha256
          let disposition: GroundedRefinementAttemptLedgerEntry['disposition']
          let rejectionReason: GroundedRefinementAttemptLedgerEntry['rejectionReason'] =
            null
          if (!bestEvaluation) {
            bestEvaluation = evaluation
            bestState = state
            disposition = evaluation.vectors.every(
              ({ failedCount }) => failedCount === 0,
            )
              ? 'terminal-pass'
              : 'baseline'
          } else {
            const decision = classifyMonotonicReconstructionTransition(
              bestEvaluation.vectors,
              evaluation.vectors,
            )
            if (decision.status === 'accepted') {
              bestEvaluation = evaluation
              bestState = state
              disposition = evaluation.vectors.every(
                ({ failedCount }) => failedCount === 0,
              )
                ? 'terminal-pass'
                : 'accepted-best'
            } else {
              disposition = 'rejected-exploratory'
              rejectionReason = decision.reason
            }
          }
          finalState = state
          evaluations.push(evaluation)
          const projection = ledgerProjection({
            attemptIndex: context.attemptIndex,
            candidateBindingSha256: candidate.binding.bindingSha256,
            selectedTraceSha256: evaluation.coordinatorTrace.traceSha256,
            profileTraceSha256s: Object.fromEntries(
              CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => [
                profileId,
                evaluation.attempt.traces[profileId].traceSha256,
              ]),
            ) as Record<ClosedReconstructionProfileId, string>,
            profileBuildReceiptSha256s: Object.fromEntries(
              evaluation.attempt.builds.map((build) => [
                build.profileId,
                build.receiptSha256,
              ]),
            ) as Record<ClosedReconstructionProfileId, string>,
            bestBeforeCandidateBindingSha256: bestBefore,
            bestAfterCandidateBindingSha256:
              bestState.candidate.binding.bindingSha256,
            disposition,
            rejectionReason,
          })
          entries.push({
            ...projection,
            entrySha256: hashTraceValue(projection),
          })
          return evaluation.coordinatorTrace
        },
        materializeRepair: async (candidate, patch, signal) => {
          const before = stateByBinding.get(candidate.binding.bindingSha256)
          if (!before) throw new Error('UNKNOWN_GROUNDED_REFINEMENT_CANDIDATE')
          const resultingProposal = await input.resolveResultingProposal({
            before: before.materializationInput,
            patch,
            signal,
          })
          const application = applyGroundedStructRepair({
            contract: input.contract,
            beforeCandidate: candidate,
            beforeMaterialization: before.materialization,
            materializationInput: before.materializationInput,
            patch,
            resultingProposal,
            authorities: input.materializationVerification,
          })
          const repairProviderReceipt = input.codex.repairProviderReceipt(patch)
          stateByBinding.set(application.candidate.binding.bindingSha256, {
            candidate: application.candidate,
            materialization: application.materialization,
            materializationInput: {
              ...before.materializationInput,
              proposal: resultingProposal,
              selections: selectionsFromReceipt(application.materialization),
            },
            application,
            patch,
            parentEvaluation: evaluations.at(-1),
            repairProviderReceipt,
          })
          return application.applicationReceipt
        },
      },
    })
  } finally {
    await input.codex.close()
  }
  const codexRepairEvidence = input.codex.repairEvidence()
  const canPublish =
    refinement.publicReceipt.status === 'publication-ready' &&
    bestState.candidate.binding.bindingSha256 ===
      finalState.candidate.binding.bindingSha256
  const closedReceipt = canPublish
    ? createClosedThreeProfileReconstructionReceipt({
        attempts: evaluations.map(({ attempt }) => attempt),
      })
    : null
  const projection = {
    schemaVersion: GROUNDED_RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION,
    contractSha256: input.contract.contractSha256,
    refinementReceiptSha256: refinement.publicReceipt.receiptSha256,
    attempts: entries,
    codexRepairEvidenceSha256s: codexRepairEvidence.map(
      ({ evidenceSha256 }) => evidenceSha256,
    ),
    bestCandidateBindingSha256: bestState.candidate.binding.bindingSha256,
    finalCandidateBindingSha256: finalState.candidate.binding.bindingSha256,
    closedReceiptSha256: closedReceipt?.receiptSha256 ?? null,
    status: canPublish ? ('publication-ready' as const) : ('failed' as const),
  }
  const result = {
    refinement,
    receipt: { ...projection, receiptSha256: hashTraceValue(projection) },
    closedReceipt,
    evaluations,
    codexRepairEvidence,
  }
  if (
    !verifyGroundedThreeProfileRefinementResult({
      result,
      sourcePdf: input.sourcePdf,
      sourceContract: input.sourceContract,
      codexIdentity: input.codexIdentity,
      codexReconciliationReceiptSha256: input.codexReconciliationReceiptSha256,
    })
  ) {
    throw new Error('GROUNDED_THREE_PROFILE_REFINEMENT_REPLAY_FAILED')
  }
  return result
}
