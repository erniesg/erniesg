import {
  createLocalCodexRefinementSession,
  type LocalCodexRefinementSession,
} from './local-codex-refinement-session'
import type {
  LocalCodexReconciliationClientConfig,
  LocalCodexReconciliationRequest,
  LocalCodexReconciliationResult,
} from './local-codex-reconciliation'
import {
  hashTraceValue,
  parseReconstructionAttemptTrace,
  parseStructEvidencePatch,
  type ProviderReceiptBinding,
  type ReconstructionAttemptTrace,
  type StructEvidencePatch,
} from './reconstruction-attempt-trace'
import type {
  CoordinatorStageLease,
  OwnerLocalCodexIdentity,
  RefinementCodexClient,
  RefinementTask,
} from './reconstruction-refinement'
import {
  runGroundedThreeProfileRefinement,
  type GroundedCodexRepairEvidence,
  type GroundedRefinementCodexClient,
  type GroundedThreeProfileRefinementInput,
} from './grounded-reconstruction-refinement'

export const GROUNDED_REFINEMENT_CODEX_CLIENT_SCHEMA_VERSION = '1.0.0' as const

type CreateTaskRequest = Parameters<RefinementCodexClient['createFreshTask']>[0]
type ProposeRepairRequest = Parameters<
  RefinementCodexClient['proposeRepair']
>[0]

export type GroundedRefinementCodexClientInput = {
  documentId: string
  runId: string
  identity: OwnerLocalCodexIdentity
  config: LocalCodexReconciliationClientConfig
  buildReconciliationRequest: (input: {
    task: RefinementTask
    immutablePriorTrace: Readonly<ReconstructionAttemptTrace>
    priorTraceSha256: string
    firstCause: ProposeRepairRequest['firstCause']
    remainingTokens: number
    remainingTimeMs: number
  }) =>
    LocalCodexReconciliationRequest | Promise<LocalCodexReconciliationRequest>
  buildPatch: (input: {
    task: RefinementTask
    immutablePriorTrace: Readonly<ReconstructionAttemptTrace>
    firstCause: ProposeRepairRequest['firstCause']
    request: LocalCodexReconciliationRequest
    result: LocalCodexReconciliationResult
  }) => StructEvidencePatch | Promise<StructEvidencePatch>
}

export type OwnerLocalGroundedRefinementInput = Omit<
  GroundedThreeProfileRefinementInput,
  'codex' | 'testOnlyEvaluateAttempt'
> & {
  codexClient: GroundedRefinementCodexClientInput
}

function invalid(code: string): never {
  throw new Error(code)
}

function abortError(code: string) {
  const error = new Error(code)
  error.name = 'AbortError'
  return error
}

function assertIdentity(input: GroundedRefinementCodexClientInput) {
  const { identity, config } = input
  if (
    identity.server.transport !== config.endpoint ||
    identity.server.executableSha256 !== config.toolIdentity.executableSha256 ||
    identity.tool.id !== 'codex' ||
    identity.tool.version !== config.toolIdentity.version ||
    identity.model.id !== config.modelIdentity.modelId ||
    identity.model.version !== config.modelIdentity.modelVersion ||
    config.modelIdentity.modelDigest === undefined ||
    identity.model.sha256 !== config.modelIdentity.modelDigest ||
    identity.prompt.id !== config.promptIdentity.id ||
    identity.prompt.version !== config.promptIdentity.version ||
    identity.prompt.sha256 !== hashTraceValue(config.promptIdentity)
  ) {
    invalid('GROUNDED_REFINEMENT_CODEX_IDENTITY_MISMATCH')
  }
}

function immutable<T>(value: T): Readonly<T> {
  const clone = structuredClone(value)
  const freeze = (item: unknown) => {
    if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item)
      for (const nested of Object.values(item)) freeze(nested)
    }
  }
  freeze(clone)
  return clone
}

/**
 * Adapt the strict owner-local reconciliation client to one #199 fresh task.
 * The model selects only source-grounded candidate IDs; callers translate
 * those selections into a typed patch at the separate materializer boundary.
 */
export function createGroundedRefinementCodexClient(
  input: GroundedRefinementCodexClientInput,
  existingSession?: LocalCodexRefinementSession,
): GroundedRefinementCodexClient {
  assertIdentity(input)
  let session: LocalCodexRefinementSession | undefined = existingSession
  let opening: Promise<LocalCodexRefinementSession> | undefined
  let task: Readonly<RefinementTask> | undefined
  let closed = false
  const receipts = new Map<string, ProviderReceiptBinding>()
  const evidence = new Map<string, GroundedCodexRepairEvidence>()

  const open = async (signal: AbortSignal, lease: CoordinatorStageLease) => {
    if (closed) invalid('GROUNDED_REFINEMENT_CODEX_CLIENT_CLOSED')
    if (session) return session
    opening ??= createLocalCodexRefinementSession({
      config: input.config,
      documentId: input.documentId,
      runId: input.runId,
      maxTurns: 3,
    })
    const resolved = await opening
    if (signal.aborted || !lease.tryCommit()) {
      await resolved.close()
      lease.acknowledgeAbort()
      throw abortError('GROUNDED_REFINEMENT_CODEX_OPEN_ABORTED')
    }
    session = resolved
    return resolved
  }

  const client: GroundedRefinementCodexClient = {
    identity: immutable(input.identity) as OwnerLocalCodexIdentity,
    probe: async (signal, lease) => {
      await open(signal, lease)
      return { available: true }
    },
    createFreshTask: async (request: CreateTaskRequest, signal, lease) => {
      if (
        request.documentId !== input.documentId ||
        request.runId !== input.runId ||
        request.priorTraceSha256 !== request.immutablePriorTrace.traceSha256
      ) {
        invalid('GROUNDED_REFINEMENT_CODEX_TASK_MISMATCH')
      }
      parseReconstructionAttemptTrace(request.immutablePriorTrace)
      const activeSession = await open(signal, lease)
      const nextTask: RefinementTask = {
        taskIdSha256: hashTraceValue({
          schemaVersion: GROUNDED_REFINEMENT_CODEX_CLIENT_SCHEMA_VERSION,
          sessionSha256: activeSession.sessionSha256,
          documentId: input.documentId,
          runId: input.runId,
          acceptedTraceSha256: request.priorTraceSha256,
        }),
        documentId: input.documentId,
        runId: input.runId,
        fresh: true,
        parentTaskId: null,
        contextPolicy: 'immutable-prior-trace-only',
        acceptedTraceSha256: request.priorTraceSha256,
        identity: immutable(input.identity) as OwnerLocalCodexIdentity,
      }
      if (task) {
        if (hashTraceValue(task) !== hashTraceValue(nextTask)) {
          invalid('GROUNDED_REFINEMENT_CODEX_TASK_CONFLICT')
        }
        return task
      }
      if (signal.aborted || !lease.tryCommit()) {
        lease.acknowledgeAbort()
        throw abortError('GROUNDED_REFINEMENT_CODEX_TASK_ABORTED')
      }
      task = immutable(nextTask) as Readonly<RefinementTask>
      return task
    },
    proposeRepair: async (request, signal, lease) => {
      if (
        !task ||
        hashTraceValue(request.task) !== hashTraceValue(task) ||
        request.priorTraceSha256 !== request.immutablePriorTrace.traceSha256
      ) {
        invalid('GROUNDED_REFINEMENT_CODEX_PROPOSAL_TASK_MISMATCH')
      }
      const activeSession = await open(signal, lease)
      const reconciliationRequest = await input.buildReconciliationRequest({
        task: request.task,
        immutablePriorTrace: request.immutablePriorTrace,
        priorTraceSha256: request.priorTraceSha256,
        firstCause: request.firstCause,
        remainingTokens: request.remainingTokens,
        remainingTimeMs: request.remainingTimeMs,
      })
      if (
        reconciliationRequest.documentId !== input.documentId ||
        reconciliationRequest.comparisonEvidence.traceSha256 !==
          request.priorTraceSha256
      ) {
        invalid('GROUNDED_REFINEMENT_CODEX_REQUEST_MISMATCH')
      }
      const result = await activeSession.reconcile(reconciliationRequest, {
        signal,
      })
      const proposal = parseStructEvidencePatch(
        await input.buildPatch({
          task: request.task,
          immutablePriorTrace: request.immutablePriorTrace,
          firstCause: request.firstCause,
          request: reconciliationRequest,
          result,
        }),
      )
      if (
        proposal.documentId !== input.documentId ||
        proposal.priorTraceSha256 !== request.priorTraceSha256 ||
        proposal.taskIdSha256 !== request.task.taskIdSha256
      ) {
        invalid('GROUNDED_REFINEMENT_CODEX_PATCH_MISMATCH')
      }
      const receiptProjection = {
        schemaVersion: GROUNDED_REFINEMENT_CODEX_CLIENT_SCHEMA_VERSION,
        sessionSha256: activeSession.sessionSha256,
        localReceipt: result.receipt,
        proposalSha256: proposal.proposalSha256,
      }
      const providerReceipt: ProviderReceiptBinding = {
        id: `owner-local-codex-repair-${proposal.proposalSha256.slice(0, 16)}`,
        role: 'owner-local-codex-repair',
        required: true,
        enabledBeforeRun: true,
        providerId: input.identity.server.id,
        identitySha256: hashTraceValue(input.identity),
        receiptSha256: hashTraceValue(receiptProjection),
        inputSha256: hashTraceValue(request.immutablePriorTrace.comparator),
        outputSha256: proposal.proposalSha256,
        prompt: structuredClone(input.identity.prompt),
        tool: structuredClone(input.identity.tool),
        model: structuredClone(input.identity.model),
        server: structuredClone(input.identity.server),
        status: 'succeeded',
      }
      if (signal.aborted || !lease.tryCommit()) {
        lease.acknowledgeAbort()
        throw abortError('GROUNDED_REFINEMENT_CODEX_PROPOSAL_ABORTED')
      }
      receipts.set(proposal.proposalSha256, immutable(providerReceipt))
      const evidenceProjection = {
        sessionSha256: activeSession.sessionSha256,
        proposalSha256: proposal.proposalSha256,
        result: structuredClone(result),
        providerReceipt: structuredClone(providerReceipt),
      }
      evidence.set(
        proposal.proposalSha256,
        immutable({
          ...evidenceProjection,
          evidenceSha256: hashTraceValue(evidenceProjection),
        }) as GroundedCodexRepairEvidence,
      )
      return {
        proposal,
        usage: {
          inputTokens: result.receipt.usage.inputTokens,
          outputTokens: result.receipt.usage.outputTokens,
          elapsedMs: result.receipt.usage.durationMs,
        },
      }
    },
    repairProviderReceipt: (proposal) => {
      const receipt = receipts.get(proposal.proposalSha256)
      if (!receipt) invalid('MISSING_GROUNDED_REPAIR_PROVIDER_RECEIPT')
      return structuredClone(receipt)
    },
    repairEvidence: () =>
      [...evidence.values()].map((item) => structuredClone(item)),
    close: async () => {
      if (closed) return
      closed = true
      const active = session ?? (opening ? await opening : undefined)
      await active?.close()
    },
  }
  return client
}

/** Production composition boundary for one owner-local #200 document run. */
export async function runOwnerLocalGroundedRefinement(
  input: OwnerLocalGroundedRefinementInput,
  existingSession?: LocalCodexRefinementSession,
) {
  if (
    input.codexClient.documentId !== input.contract.documentId ||
    input.codexClient.runId !== input.contract.runId ||
    hashTraceValue(input.codexClient.identity) !==
      input.contract.authorities.codex.identitySha256
  ) {
    invalid('OWNER_LOCAL_GROUNDED_REFINEMENT_JOB_MISMATCH')
  }
  const { codexClient, ...refinement } = input
  return runGroundedThreeProfileRefinement({
    ...refinement,
    codex: createGroundedRefinementCodexClient(codexClient, existingSession),
  })
}
