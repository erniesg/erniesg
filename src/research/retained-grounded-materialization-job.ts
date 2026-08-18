import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GROUNDED_MATERIALIZATION_RETAINED_PACKETS,
  verifyGroundedMaterializationPilotMineruExecution,
  verifyGroundedMaterializationPilotRetainedSource,
  type GroundedMaterializationPilotCase,
  type GroundedMaterializationPilotDocument,
} from './grounded-materialization-pilot'
import {
  runOwnerLocalGroundedRefinement,
  type OwnerLocalGroundedRefinementInput,
} from './grounded-refinement-codex-client'
import { createLocalCodexRefinementSession } from './local-codex-refinement-session'
import type { LocalCodexReconciliationRequest } from './local-codex-reconciliation'
import {
  createGroundedInitialRefinementEvidence,
  evaluateGroundedThreeProfileAttempt,
  runGroundedThreeProfileRefinement,
  verifyGroundedThreeProfileEvaluationEvidence,
  type GroundedRefinementCodexClient,
  type GroundedThreeProfileEvaluation,
  type GroundedThreeProfileEvaluationInput,
} from './grounded-reconstruction-refinement'
import type { LocalCodexReconciliationResult } from './local-codex-reconciliation'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  hashTraceValue,
} from './reconstruction-attempt-trace'
import type { GroundedVerifierIdentity } from './reconstruction-refinement'
import {
  createSourceEvidenceContract,
  type SourceEvidenceContract,
} from './source-evidence-contract'
import { buildSourceEvidenceGraph } from './source-evidence-graph'
import { sha256HexSync } from './sha256-sync'

export const RETAINED_GROUNDED_MATERIALIZATION_JOB_SCHEMA_VERSION =
  '1.0.0' as const

export type RetainedGroundedMaterializationPacketPaths = {
  caseId: GroundedMaterializationPilotCase
  sourcePdfPath: string
  artifactRoot: string
  packetDirectory: string
}

export type LoadedRetainedGroundedMaterializationPacket = {
  caseId: GroundedMaterializationPilotCase
  sourcePdfBytes: Uint8Array
  sourceExecution: GroundedMaterializationPilotDocument['sourceExecution']
  sourceContract: SourceEvidenceContract
  receipt: {
    schemaVersion: typeof RETAINED_GROUNDED_MATERIALIZATION_JOB_SCHEMA_VERSION
    caseId: GroundedMaterializationPilotCase
    sourcePdfSha256: string
    sourceGraphSha256: string
    retainedContractSha256: string
    manifestSha256: string
    producerReceiptSha256: string
    artifactSetSha256: string
    observationSetSha256: string
    receiptSha256: string
  }
}

export type RetainedOwnerLocalGroundedRefinementInput = Omit<
  OwnerLocalGroundedRefinementInput,
  'sourceContract' | 'initialEvidence'
> & {
  retainedPacket: RetainedGroundedMaterializationPacketPaths
  observedPriorEvaluation: GroundedThreeProfileEvaluation
  buildInitialReconciliationRequest: (input: {
    packet: LoadedRetainedGroundedMaterializationPacket
    observedPriorEvaluation: GroundedThreeProfileEvaluation
  }) =>
    LocalCodexReconciliationRequest | Promise<LocalCodexReconciliationRequest>
  testOnly?: {
    packet: LoadedRetainedGroundedMaterializationPacket
    initialCodexResult: LocalCodexReconciliationResult
    codex: GroundedRefinementCodexClient
    evaluateAttempt: (
      input: GroundedThreeProfileEvaluationInput,
    ) => Promise<GroundedThreeProfileEvaluation>
  }
}

function invalid(code: string): never {
  throw new Error(code)
}

async function exactBytes(path: string) {
  return new Uint8Array(await readFile(path))
}

/**
 * Load one exact #198 retained packet and replay graph -> contract before any
 * Codex, EPUB rendering, or Java boundary can run.
 */
export async function loadRetainedGroundedMaterializationPacket(
  input: RetainedGroundedMaterializationPacketPaths,
): Promise<LoadedRetainedGroundedMaterializationPacket> {
  const retained = GROUNDED_MATERIALIZATION_RETAINED_PACKETS[input.caseId]
  const [sourcePdfBytes, manifestBytes, graphBytes, contractBytes] =
    await Promise.all([
      exactBytes(input.sourcePdfPath),
      exactBytes(join(input.artifactRoot, 'manifest.json')),
      exactBytes(join(input.packetDirectory, 'source-evidence-graph.json')),
      exactBytes(join(input.packetDirectory, 'source-evidence-contract.json')),
    ])
  const expectedObservationPayloads = await Promise.all(
    SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(async (check) => ({
      check,
      payloadBytes: await exactBytes(
        join(
          input.packetDirectory,
          retained.observationFilePrefix === '' ? 'observations' : '',
          `${retained.observationFilePrefix}${check}.json`,
        ),
      ),
    })),
  )
  let graphInput: Parameters<typeof buildSourceEvidenceGraph>[0]
  let retainedContract: { verifier?: GroundedVerifierIdentity }
  try {
    graphInput = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(graphBytes),
    )
    retainedContract = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(contractBytes),
    )
  } catch {
    invalid('INVALID_RETAINED_GROUNDED_MATERIALIZATION_PACKET_JSON')
  }
  if (!retainedContract.verifier) {
    invalid('INVALID_RETAINED_GROUNDED_MATERIALIZATION_VERIFIER')
  }
  const sourceContract = createSourceEvidenceContract(
    buildSourceEvidenceGraph(graphInput),
    retainedContract.verifier,
  )
  verifyGroundedMaterializationPilotRetainedSource(input.caseId, {
    sha256: sha256HexSync(sourcePdfBytes),
    byteLength: sourcePdfBytes.byteLength,
    pageCount: sourceContract.graph.source.pageCount,
  })
  const sourceExecution = {
    kind: 'retained-real-provider-packet' as const,
    artifactRoot: input.artifactRoot,
    manifestBytes,
    sourceEvidenceGraphBytes: graphBytes,
    sourceEvidenceContractBytes: contractBytes,
    expectedObservationPayloads,
  }
  const verified = await verifyGroundedMaterializationPilotMineruExecution({
    caseId: input.caseId,
    sourceExecution,
    sourcePdfSha256: sha256HexSync(sourcePdfBytes),
    sourceContract,
  })
  const projection = {
    schemaVersion: RETAINED_GROUNDED_MATERIALIZATION_JOB_SCHEMA_VERSION,
    caseId: input.caseId,
    sourcePdfSha256: sha256HexSync(sourcePdfBytes),
    sourceGraphSha256: verified.sourceGraphSha256,
    retainedContractSha256: verified.contractSha256,
    manifestSha256: verified.manifestSha256,
    producerReceiptSha256: verified.producerReceiptSha256,
    artifactSetSha256: verified.artifactSetSha256,
    observationSetSha256: verified.observationSetSha256,
  }
  return {
    caseId: input.caseId,
    sourcePdfBytes,
    sourceExecution,
    sourceContract,
    receipt: { ...projection, receiptSha256: hashTraceValue(projection) },
  }
}

/** Production #200 job composition over an exact retained packet. */
export async function runRetainedOwnerLocalGroundedRefinement(
  input: RetainedOwnerLocalGroundedRefinementInput,
) {
  const {
    retainedPacket,
    observedPriorEvaluation,
    buildInitialReconciliationRequest,
    testOnly,
    ...refinement
  } = input
  const packet =
    testOnly?.packet ??
    (await loadRetainedGroundedMaterializationPacket(retainedPacket))
  if (
    refinement.sourcePdf.artifact.sha256 !== packet.receipt.sourcePdfSha256 ||
    refinement.sourcePdf.artifact.byteLength !==
      packet.sourcePdfBytes.byteLength ||
    refinement.sourcePdf.pageCount !==
      packet.sourceContract.graph.source.pageCount ||
    refinement.contract.sourcePdfSha256 !== packet.receipt.sourcePdfSha256 ||
    refinement.contract.sourceEvidenceGraph.sha256 !==
      packet.sourceContract.graphArtifact.sha256 ||
    refinement.contract.budget.maxRefinements !== 3 ||
    refinement.contract.budget.maxFreshTasks !== 1 ||
    refinement.initialMaterialization.receipt.sourcePdfSha256 !==
      packet.receipt.sourcePdfSha256 ||
    refinement.initialMaterialization.receipt.sourceEvidenceGraphSha256 !==
      packet.sourceContract.graphArtifact.sha256 ||
    refinement.initialCandidate.binding.canonicalStruct.sha256 !==
      refinement.initialMaterialization.receipt.repairCore.sha256 ||
    refinement.initialCandidate.binding.sourcePdfSha256 !==
      packet.receipt.sourcePdfSha256 ||
    refinement.initialCandidate.binding.sourceEvidenceGraphSha256 !==
      packet.sourceContract.graphArtifact.sha256 ||
    observedPriorEvaluation.materialization.receipt.receiptSha256 !==
      refinement.initialMaterialization.receipt.receiptSha256 ||
    observedPriorEvaluation.coordinatorTrace.terminalState !== 'failed' ||
    !verifyGroundedThreeProfileEvaluationEvidence({
      evaluation: observedPriorEvaluation,
      sourcePdf: refinement.sourcePdf,
      sourceContract: packet.sourceContract,
      codexIdentity: refinement.codexIdentity,
    })
  ) {
    invalid('RETAINED_GROUNDED_MATERIALIZATION_JOB_INPUT_MISMATCH')
  }
  if (testOnly) {
    if (
      testOnly.initialCodexResult.receipt.comparisonEvidenceSha256 !==
        observedPriorEvaluation.coordinatorTrace.traceSha256 ||
      testOnly.initialCodexResult.receipt.attemptIdSha256 !==
        sha256HexSync(observedPriorEvaluation.coordinatorTrace.attemptId) ||
      testOnly.initialCodexResult.receipt.graphSha256 !==
        packet.sourceContract.graph.graphSha256 ||
      testOnly.initialCodexResult.receipt.selectionSetSha256 !==
        hashTraceValue(testOnly.initialCodexResult.selections) ||
      testOnly.initialCodexResult.receipt.counts.decisionCount !==
        testOnly.initialCodexResult.selections.length ||
      testOnly.initialCodexResult.receipt.usage.totalTokens !==
        testOnly.initialCodexResult.receipt.usage.inputTokens +
          testOnly.initialCodexResult.receipt.usage.outputTokens ||
      testOnly.initialCodexResult.receipt.usage.inputTokens < 1 ||
      testOnly.initialCodexResult.receipt.usage.outputTokens < 1 ||
      testOnly.initialCodexResult.receipt.usage.durationMs < 1 ||
      [
        testOnly.initialCodexResult.receipt.requestSha256,
        testOnly.initialCodexResult.receipt.responseSha256,
        testOnly.initialCodexResult.receipt.cropEvidenceSha256,
        testOnly.initialCodexResult.receipt.threadSha256,
        testOnly.initialCodexResult.receipt.turnSha256,
        ...Object.values(testOnly.initialCodexResult.receipt.identities),
      ].some((value) => !/^[a-f0-9]{64}$/u.test(value))
    ) {
      invalid('RETAINED_GROUNDED_TEST_RECEIPT_FORGED')
    }
    const failedEvaluation = await testOnly.evaluateAttempt({
      attemptId: `${refinement.contract.runId}-owned-baseline`,
      sourcePdf: refinement.sourcePdf,
      materialization: refinement.initialMaterialization,
      sourceContract: packet.sourceContract,
      codexIdentity: refinement.codexIdentity,
      codexResult: testOnly.initialCodexResult,
      lineage: {
        attemptIndex: 0,
        parentTraceSha256: null,
        immutablePriorTraceSha256: null,
        appliedRepair: null,
      },
      critiqueRepair: null,
      budget: {
        policy: {
          ...refinement.contract.budget,
        },
        usage: {
          refinements: 0,
          freshTasks: 0,
          tokens: 0,
          durationMs: 0,
        },
      },
      epubCheckAuthority: refinement.epubCheckAuthority,
    })
    if (failedEvaluation.coordinatorTrace.terminalState !== 'failed') {
      return {
        status: 'already-valid' as const,
        packet,
        baselineEvaluation: failedEvaluation,
      }
    }
    const { codexClient: _codexClient, ...rawRefinement } = refinement
    const result = await runGroundedThreeProfileRefinement({
      ...rawRefinement,
      sourceContract: packet.sourceContract,
      initialEvidence: createGroundedInitialRefinementEvidence({
        priorEvaluation: observedPriorEvaluation,
        failedEvaluation,
        codexResult: testOnly.initialCodexResult,
      }),
      codex: testOnly.codex,
      testOnlyEvaluateAttempt: testOnly.evaluateAttempt,
    })
    return { status: 'refined' as const, packet, result }
  }
  const session = await createLocalCodexRefinementSession({
    config: refinement.codexClient.config,
    documentId: refinement.contract.documentId,
    runId: refinement.contract.runId,
    maxTurns: 1 + refinement.contract.budget.maxRefinements,
  })
  try {
    const initialRequest = await buildInitialReconciliationRequest({
      packet,
      observedPriorEvaluation: structuredClone(observedPriorEvaluation),
    })
    if (
      initialRequest.documentId !== refinement.contract.documentId ||
      initialRequest.graphSha256 !== packet.sourceContract.graph.graphSha256 ||
      initialRequest.comparisonEvidence.traceSha256 !==
        observedPriorEvaluation.coordinatorTrace.traceSha256
    ) {
      invalid('RETAINED_GROUNDED_INITIAL_RECONCILIATION_MISMATCH')
    }
    const initialCodexResult = await session.reconcile(initialRequest, {
      ...(refinement.signal ? { signal: refinement.signal } : {}),
    })
    const failedEvaluation = await evaluateGroundedThreeProfileAttempt({
      attemptId: `${refinement.contract.runId}-owned-baseline`,
      sourcePdf: refinement.sourcePdf,
      materialization: refinement.initialMaterialization,
      sourceContract: packet.sourceContract,
      codexIdentity: refinement.codexIdentity,
      codexResult: initialCodexResult,
      lineage: {
        attemptIndex: 0,
        parentTraceSha256: null,
        immutablePriorTraceSha256: null,
        appliedRepair: null,
      },
      critiqueRepair: null,
      budget: {
        policy: {
          maxRefinements: refinement.contract.budget.maxRefinements,
          maxFreshTasks: refinement.contract.budget.maxFreshTasks,
          maxTokens: refinement.contract.budget.maxTokens,
          maxDurationMs: refinement.contract.budget.maxDurationMs,
          repairPolicySha256: refinement.contract.budget.repairPolicySha256,
        },
        usage: {
          refinements: 0,
          freshTasks: 0,
          tokens: 0,
          durationMs: 0,
        },
      },
      epubCheckAuthority: refinement.epubCheckAuthority,
    })
    if (failedEvaluation.coordinatorTrace.terminalState !== 'failed') {
      return {
        status: 'already-valid' as const,
        packet,
        baselineEvaluation: failedEvaluation,
      }
    }
    const initialEvidence = createGroundedInitialRefinementEvidence({
      priorEvaluation: observedPriorEvaluation,
      failedEvaluation,
      codexResult: initialCodexResult,
    })
    const result = await runOwnerLocalGroundedRefinement(
      {
        ...refinement,
        sourceContract: packet.sourceContract,
        initialEvidence,
      },
      session,
    )
    return { status: 'refined' as const, packet, result }
  } finally {
    await session.close()
  }
}
