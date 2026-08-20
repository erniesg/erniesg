import { z } from 'zod'
import { sha256HexSync } from '../struct/sha256'
import {
  RECONSTRUCTION_ATTEMPT_DEFAULT_BUDGET,
  canonicalTraceJson,
  hashTraceValue,
  parseCanonicalObservationPayloadBytes,
  parseStructEvidencePatch,
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  structEvidencePatchOperationSchema,
  parseReconstructionAttemptTrace,
  parseReconstructionAttemptTraceLineage,
  toRefinementTraceBinding,
  validateReconstructionAttemptRefinementTraceBindingLineage,
  type HashedArtifact,
  type RenderedActualObservationSet,
  type ReconstructionAttemptBudget,
  type ReconstructionAttemptRefinementTraceBinding,
  type ReconstructionAttemptTrace,
  type StructEvidencePatch,
  type StructEvidencePatchOperation,
  type SourceExpectedObservationSet,
} from './reconstruction-attempt-trace'
import { compareSourceToRenderedEpub } from './source-epub-comparator'

export const RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION = '1.0.0' as const
export const STRUCT_EVIDENCE_PATCH_SCHEMA_VERSION = '1.0.0' as const

export const DEFAULT_RECONSTRUCTION_REFINEMENT_BUDGET =
  RECONSTRUCTION_ATTEMPT_DEFAULT_BUDGET

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,191}$/u
const PLACEHOLDER_IDENTITY_PATTERN =
  /(?:^|[._:@/+\-])(demo|dummy|fake|fixture|mock|placeholder|recorded-stub|sample|stub|synthetic|test|unknown)(?:$|[._:@/+\-])/iu

export type ReconstructionRefinementBudget =
  ReconstructionAttemptBudget['policy']

export type StructRepairTargetKind = 'block' | 'asset' | 'relationship'

export type StructRepairScope = {
  targetKind: StructRepairTargetKind
  targetId: string
  candidateReferenceSha256s: string[]
}

export type ReconstructionCandidateContract = {
  schemaVersion: typeof RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION
  runId: string
  documentId: string
  sourcePdfSha256: string
  sourceEvidenceGraph: {
    schemaVersion: string
    sha256: string
  }
  authorities: {
    codex: {
      identity: OwnerLocalCodexIdentity
      identitySha256: string
    }
    groundedVerifier: {
      identity: GroundedVerifierIdentity
      identitySha256: string
    }
    artifactResolver: {
      identity: OwnerLocalArtifactResolverIdentity
      identitySha256: string
    }
    sourceEvidenceVerifier: {
      identity: GroundedVerifierIdentity
      identitySha256: string
    }
    renderObservationExtractor: {
      identity: GroundedVerifierIdentity
      identitySha256: string
    }
  }
  budget: ReconstructionRefinementBudget
  repairScope: StructRepairScope[]
  contractSha256: string
}

export type { StructEvidencePatch, StructEvidencePatchOperation }

export type ReconstructionCandidateBinding = {
  schemaVersion: typeof RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION
  sourcePdfSha256: string
  sourceEvidenceGraphSha256: string
  canonicalStruct: HashedArtifact
  selections: StructEvidencePatchOperation[]
  bindingSha256: string
}

export type ReconstructionCandidate = {
  binding: ReconstructionCandidateBinding
  canonicalStructBytes: Uint8Array
}

export type GroundedVerifierIdentity = {
  id: string
  version: string
  configurationSha256: string
  executableSha256: string
}

export type OwnerLocalArtifactResolverIdentity = {
  id: string
  version: string
  configurationSha256: string
}

export type OwnerLocalArtifactKind =
  | 'epub-download'
  | 'dom-snapshot'
  | 'screenshot'

export type OwnerLocalArtifactResolutionRequest = {
  schemaVersion: '1.0.0'
  runId: string
  attemptTraceSha256: string
  kind: OwnerLocalArtifactKind
  logicalId: string
  artifact: HashedArtifact
}

export type OwnerLocalArtifactVerificationReceipt = {
  schemaVersion: '1.0.0'
  resolverIdentity: OwnerLocalArtifactResolverIdentity
  resolverIdentitySha256: string
  requestSha256: string
  artifact: HashedArtifact
  bytes: Uint8Array
  status: 'succeeded'
  receiptSha256: string
}

export type OwnerLocalArtifactResolver = {
  identity: OwnerLocalArtifactResolverIdentity
  resolve: (request: OwnerLocalArtifactResolutionRequest) => unknown
}

type VerifiedObservationSet<
  TSet extends SourceExpectedObservationSet | RenderedActualObservationSet,
> = TSet & { payloadBytes: Uint8Array }

export type SourceEvidenceVerificationRequest = {
  schemaVersion: '1.0.0'
  sourcePdfSha256: string
  evidenceGraph: HashedArtifact
  sourceObligationsSha256: string
}

export type SourceEvidenceVerificationReceipt = {
  schemaVersion: '1.0.0'
  verifierIdentity: GroundedVerifierIdentity
  verifierIdentitySha256: string
  requestSha256: string
  evidenceGraph: HashedArtifact
  evidenceGraphBytes: Uint8Array
  expectedObservationSets: Array<
    VerifiedObservationSet<SourceExpectedObservationSet>
  >
  status: 'succeeded'
  receiptSha256: string
}

export type EvidenceCandidateResolutionRequest = {
  schemaVersion: '1.0.0'
  sourceEvidenceGraphSha256: string
  referenceSha256: string
  bindingSha256: string
}

export type EvidenceCandidateResolutionReceipt = {
  schemaVersion: '1.0.0'
  verifierIdentity: GroundedVerifierIdentity
  verifierIdentitySha256: string
  requestSha256: string
  referenceSha256: string
  bindingSha256: string
  payload: HashedArtifact
  payloadBytes: Uint8Array
  status: 'succeeded'
  receiptSha256: string
}

export type SourceEvidenceVerifier = {
  identity: GroundedVerifierIdentity
  verifyExpected: (request: SourceEvidenceVerificationRequest) => unknown
  resolveCandidate: (request: EvidenceCandidateResolutionRequest) => unknown
}

export type SelectedGroundingVerificationRequest = {
  schemaVersion: '1.0.0'
  sourceEvidenceGraphSha256: string
  proposalSha256: string
  operations: StructEvidencePatchOperation[]
  beforeCanonicalStruct: HashedArtifact
  beforeCanonicalStructBytes: Uint8Array
  resultingCanonicalStruct: HashedArtifact
  resultingCanonicalStructBytes: Uint8Array
  beforeSelectedProjection: HashedArtifact
  beforeSelectedProjectionBytes: Uint8Array
  resultingSelectedProjection: HashedArtifact
  resultingSelectedProjectionBytes: Uint8Array
  candidatePayloads: EvidenceCandidateResolutionReceipt[]
}

export type SelectedGroundingVerifier = {
  identity: GroundedVerifierIdentity
  verifySelected: (request: SelectedGroundingVerificationRequest) => unknown
}

export type MaterializationVerificationAuthorities = {
  sourceEvidenceVerifier: SourceEvidenceVerifier
  groundedVerifier: SelectedGroundingVerifier
  evidenceCandidates: Array<{
    referenceSha256: string
    bindingSha256: string
  }>
}

export type ResolvedRenderArtifact = OwnerLocalArtifactResolutionRequest & {
  bytes: Uint8Array
  verificationReceiptSha256: string
}

export type RenderObservationExtractionRequest = {
  schemaVersion: '1.0.0'
  runId: string
  attemptTraceSha256: string
  renderedEpubReceiptSha256: string
  artifacts: ResolvedRenderArtifact[]
}

export type RenderObservationExtractionReceipt = {
  schemaVersion: '1.0.0'
  extractorIdentity: GroundedVerifierIdentity
  extractorIdentitySha256: string
  requestSha256: string
  anchorInventorySha256: string
  actualObservationSets: Array<
    VerifiedObservationSet<RenderedActualObservationSet>
  >
  status: 'succeeded'
  receiptSha256: string
}

export type RenderObservationExtractor = {
  identity: GroundedVerifierIdentity
  extract: (request: RenderObservationExtractionRequest) => unknown
}

export type PrivateReplayAuthorities = {
  artifactResolver: OwnerLocalArtifactResolver
  sourceEvidenceVerifier: SourceEvidenceVerifier
  renderObservationExtractor: RenderObservationExtractor
  groundedVerifier: SelectedGroundingVerifier
}

export type GroundedVerifierReceipt = {
  schemaVersion: '1.0.0'
  verifierIdentity: GroundedVerifierIdentity
  verifierIdentitySha256: string
  sourceEvidenceGraphSha256: string
  proposalSha256: string
  operationTargetSetSha256: string
  candidateReferenceSetSha256: string
  candidatePayloadSetSha256: string
  beforeStructSha256: string
  resultingStructSha256: string
  beforeSelectedProjectionSha256: string
  beforeUnselectedProjectionSha256: string
  resultingSelectedProjectionSha256: string
  resultingUnselectedProjectionSha256: string
  inputSha256: string
  outputSha256: string
  status: 'succeeded'
  receiptSha256: string
}

export type UnchangedUnselectedProof = {
  schemaVersion: '1.0.0'
  beforeSha256: string
  afterSha256: string
  receiptSha256: string
}

export type MaterializedRepairApplicationReceipt = {
  schemaVersion: '1.0.0'
  proposalSha256: string
  operations: StructEvidencePatchOperation[]
  beforeCanonicalStruct: HashedArtifact
  beforeCanonicalStructBytes: Uint8Array
  beforeSelectedProjection: HashedArtifact
  beforeUnselectedProjection: HashedArtifact
  resultingCanonicalStruct: HashedArtifact
  resultingCanonicalStructBytes: Uint8Array
  resultingSelectedProjection: HashedArtifact
  resultingUnselectedProjection: HashedArtifact
  groundedVerifier: GroundedVerifierReceipt
  unchangedUnselected: UnchangedUnselectedProof
  receiptSha256: string
}

export type OwnerLocalCodexIdentity = {
  server: {
    id: string
    version: string
    transport: string
    executableSha256: string
  }
  model: {
    id: string
    version: string
    sha256: string
  }
  prompt: {
    id: string
    version: string
    sha256: string
  }
  tool: {
    id: 'codex'
    version: string
  }
}

export type RefinementTraceBinding =
  ReconstructionAttemptRefinementTraceBinding

export type RefinementTask = {
  taskIdSha256: string
  documentId: string
  runId: string
  fresh: true
  parentTaskId: null
  contextPolicy: 'immutable-prior-trace-only'
  acceptedTraceSha256: string
  identity: OwnerLocalCodexIdentity
}

export type RefinementUsage = {
  inputTokens: number
  outputTokens: number
  elapsedMs: number
}

export type CoordinatorStageLease = {
  runId: string
  generationSha256: string
  stageSha256: string
  tryCommit: () => boolean
  acknowledgeAbort: () => boolean
}

export type RefinementEvent = {
  sequence: number
  kind:
    | 'server-verified'
    | 'rendered-and-compared'
    | 'fresh-task-created'
    | 'repair-proposed'
    | 'repair-verified'
    | 'repair-applied'
    | 'publication-ready'
    | 'failed'
  attemptIndex: number
  traceSha256?: string
  firstCauseCode?: string
  taskIdentitySha256?: string
  proposalSha256?: string
  failureCode?: RefinementFailureCode
}

export type RefinementFailureCode =
  | 'invalid-candidate-contract'
  | 'codex-server-unavailable'
  | 'codex-identity-mismatch'
  | 'concurrent-run'
  | 'codex-probe-timeout'
  | 'evaluation-timeout'
  | 'fresh-task-timeout'
  | 'repair-proposal-timeout'
  | 'repair-application-timeout'
  | 'evaluation-failed'
  | 'stale-trace'
  | 'missing-first-cause'
  | 'fresh-task-budget-exhausted'
  | 'fresh-task-invalid'
  | 'task-timeout'
  | 'token-budget-exhausted'
  | 'invalid-repair-proposal'
  | 'repair-application-failed'
  | 'refinement-budget-exhausted'
  | 'interrupted'

const REFINEMENT_FAILURE_CODES: readonly RefinementFailureCode[] = [
  'invalid-candidate-contract',
  'codex-server-unavailable',
  'codex-identity-mismatch',
  'concurrent-run',
  'codex-probe-timeout',
  'evaluation-timeout',
  'fresh-task-timeout',
  'repair-proposal-timeout',
  'repair-application-timeout',
  'evaluation-failed',
  'stale-trace',
  'missing-first-cause',
  'fresh-task-budget-exhausted',
  'fresh-task-invalid',
  'task-timeout',
  'token-budget-exhausted',
  'invalid-repair-proposal',
  'repair-application-failed',
  'refinement-budget-exhausted',
  'interrupted',
]

export type RefinementRunReceipt = {
  schemaVersion: typeof RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION
  authority: 'diagnostic-only'
  promotionAllowed: false
  contractSha256: string
  status: 'publication-ready' | 'failed'
  failureCode: RefinementFailureCode | null
  attempts: ReconstructionAttemptRefinementTraceBinding[]
  proposalSha256s: string[]
  freshTaskCount: number
  refinementCount: number
  usage: RefinementUsage
  events: RefinementEvent[]
  receiptSha256: string
}

export type RefinementCodexClient = {
  identity: OwnerLocalCodexIdentity
  probe: (
    signal: AbortSignal,
    lease: CoordinatorStageLease,
  ) => Promise<{ available: boolean }>
  createFreshTask: (
    request: {
      documentId: string
      runId: string
      immutablePriorTrace: Readonly<ReconstructionAttemptTrace>
      priorTraceSha256: string
      firstCause: NonNullable<RefinementTraceBinding['firstCause']>
      budget: ReconstructionRefinementBudget
    },
    signal: AbortSignal,
    lease: CoordinatorStageLease,
  ) => Promise<unknown>
  proposeRepair: (
    request: {
      task: RefinementTask
      immutablePriorTrace: Readonly<ReconstructionAttemptTrace>
      priorTraceSha256: string
      firstCause: NonNullable<RefinementTraceBinding['firstCause']>
      remainingTokens: number
      remainingTimeMs: number
    },
    signal: AbortSignal,
    lease: CoordinatorStageLease,
  ) => Promise<unknown>
}

export type ReconstructionRefinementDependencies = {
  evaluate: (
    candidate: ReconstructionCandidate,
    context: {
      attemptIndex: number
      parentTraceSha256: string | null
      usage: Readonly<RefinementTraceBinding['usage']>
      signal: AbortSignal
      lease: CoordinatorStageLease
    },
  ) => Promise<ReconstructionAttemptTrace>
  materializeRepair: (
    candidate: Readonly<ReconstructionCandidate>,
    proposal: StructEvidencePatch,
    signal: AbortSignal,
    lease: CoordinatorStageLease,
  ) => Promise<unknown>
  codex?: RefinementCodexClient
  materializationVerification?: Omit<
    MaterializationVerificationAuthorities,
    'evidenceCandidates'
  >
}

export type PrivateRefinementRunEvidence = {
  initialCandidate: ReconstructionCandidate
  traces: ReconstructionAttemptTrace[]
  applications: MaterializedRepairApplicationReceipt[]
}

export type ReconstructionRefinementRunResult = {
  publicReceipt: RefinementRunReceipt
  privateEvidence: PrivateRefinementRunEvidence
}

export function reconstructionRefinementHash(value: unknown) {
  return hashTraceValue(value)
}

const sha256ValueSchema = z.string().regex(SHA256_PATTERN)
const hashedArtifactValueSchema = z
  .object({
    sha256: sha256ValueSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict()
const refinementUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    elapsedMs: z.number().finite().nonnegative(),
  })
  .strict()
const refinementTaskSchema = z
  .object({
    taskIdSha256: sha256ValueSchema,
    documentId: z.string().regex(SAFE_ID_PATTERN),
    runId: z.string().regex(SAFE_ID_PATTERN),
    fresh: z.literal(true),
    parentTaskId: z.null(),
    contextPolicy: z.literal('immutable-prior-trace-only'),
    acceptedTraceSha256: sha256ValueSchema,
    identity: z.unknown(),
  })
  .strict()
const groundedVerifierReceiptSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    verifierIdentity: z
      .object({
        id: z.string().regex(SAFE_ID_PATTERN),
        version: z.string().regex(SAFE_ID_PATTERN),
        configurationSha256: sha256ValueSchema,
        executableSha256: sha256ValueSchema,
      })
      .strict(),
    verifierIdentitySha256: sha256ValueSchema,
    sourceEvidenceGraphSha256: sha256ValueSchema,
    proposalSha256: sha256ValueSchema,
    operationTargetSetSha256: sha256ValueSchema,
    candidateReferenceSetSha256: sha256ValueSchema,
    candidatePayloadSetSha256: sha256ValueSchema,
    beforeStructSha256: sha256ValueSchema,
    resultingStructSha256: sha256ValueSchema,
    beforeSelectedProjectionSha256: sha256ValueSchema,
    beforeUnselectedProjectionSha256: sha256ValueSchema,
    resultingSelectedProjectionSha256: sha256ValueSchema,
    resultingUnselectedProjectionSha256: sha256ValueSchema,
    inputSha256: sha256ValueSchema,
    outputSha256: sha256ValueSchema,
    status: z.literal('succeeded'),
    receiptSha256: sha256ValueSchema,
  })
  .strict()
const unchangedUnselectedProofSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    beforeSha256: sha256ValueSchema,
    afterSha256: sha256ValueSchema,
    receiptSha256: sha256ValueSchema,
  })
  .strict()
const materializedRepairApplicationReceiptSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    proposalSha256: sha256ValueSchema,
    operations: z.array(structEvidencePatchOperationSchema).min(1),
    beforeCanonicalStruct: hashedArtifactValueSchema,
    beforeCanonicalStructBytes: z.instanceof(Uint8Array),
    beforeSelectedProjection: hashedArtifactValueSchema,
    beforeUnselectedProjection: hashedArtifactValueSchema,
    resultingCanonicalStruct: hashedArtifactValueSchema,
    resultingCanonicalStructBytes: z.instanceof(Uint8Array),
    resultingSelectedProjection: hashedArtifactValueSchema,
    resultingUnselectedProjection: hashedArtifactValueSchema,
    groundedVerifier: groundedVerifierReceiptSchema,
    unchangedUnselected: unchangedUnselectedProofSchema,
    receiptSha256: sha256ValueSchema,
  })
  .strict()
const ownerLocalArtifactVerificationReceiptSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    resolverIdentity: z
      .object({
        id: z.string().regex(SAFE_ID_PATTERN),
        version: z.string().regex(SAFE_ID_PATTERN),
        configurationSha256: sha256ValueSchema,
      })
      .strict(),
    resolverIdentitySha256: sha256ValueSchema,
    requestSha256: sha256ValueSchema,
    artifact: hashedArtifactValueSchema,
    bytes: z.instanceof(Uint8Array),
    status: z.literal('succeeded'),
    receiptSha256: sha256ValueSchema,
  })
  .strict()
const frozenExecutionIdentitySchema = z
  .object({
    id: z.string().regex(SAFE_ID_PATTERN),
    version: z.string().regex(SAFE_ID_PATTERN),
    configurationSha256: sha256ValueSchema,
    executableSha256: sha256ValueSchema,
  })
  .strict()
const verifiedExpectedObservationSetSchema = z
  .object({
    check: z.enum(SOURCE_EPUB_OBSERVATION_CHECK_IDS),
    setSha256: sha256ValueSchema,
    itemCount: z.number().int().nonnegative(),
    payload: hashedArtifactValueSchema,
    sourceRegionIds: z.array(z.string().regex(SAFE_ID_PATTERN)),
    receiptSha256: sha256ValueSchema,
    payloadBytes: z.instanceof(Uint8Array),
  })
  .strict()
const verifiedActualObservationSetSchema = z
  .object({
    check: z.enum(SOURCE_EPUB_OBSERVATION_CHECK_IDS),
    setSha256: sha256ValueSchema,
    itemCount: z.number().int().nonnegative(),
    payload: hashedArtifactValueSchema,
    receiptSha256: sha256ValueSchema,
    payloadBytes: z.instanceof(Uint8Array),
  })
  .strict()
const sourceEvidenceVerificationReceiptSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    verifierIdentity: frozenExecutionIdentitySchema,
    verifierIdentitySha256: sha256ValueSchema,
    requestSha256: sha256ValueSchema,
    evidenceGraph: hashedArtifactValueSchema,
    evidenceGraphBytes: z.instanceof(Uint8Array),
    expectedObservationSets: z
      .array(verifiedExpectedObservationSetSchema)
      .length(SOURCE_EPUB_OBSERVATION_CHECK_IDS.length),
    status: z.literal('succeeded'),
    receiptSha256: sha256ValueSchema,
  })
  .strict()
const evidenceCandidateResolutionReceiptSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    verifierIdentity: frozenExecutionIdentitySchema,
    verifierIdentitySha256: sha256ValueSchema,
    requestSha256: sha256ValueSchema,
    referenceSha256: sha256ValueSchema,
    bindingSha256: sha256ValueSchema,
    payload: hashedArtifactValueSchema,
    payloadBytes: z.instanceof(Uint8Array),
    status: z.literal('succeeded'),
    receiptSha256: sha256ValueSchema,
  })
  .strict()
const renderObservationExtractionReceiptSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    extractorIdentity: frozenExecutionIdentitySchema,
    extractorIdentitySha256: sha256ValueSchema,
    requestSha256: sha256ValueSchema,
    anchorInventorySha256: sha256ValueSchema,
    actualObservationSets: z
      .array(verifiedActualObservationSetSchema)
      .length(SOURCE_EPUB_OBSERVATION_CHECK_IDS.length),
    status: z.literal('succeeded'),
    receiptSha256: sha256ValueSchema,
  })
  .strict()
const codexProposalResponseSchema = z
  .object({ proposal: z.unknown(), usage: refinementUsageSchema })
  .strict()
const refinementEventEnvelopeSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    kind: z.enum([
      'server-verified',
      'rendered-and-compared',
      'fresh-task-created',
      'repair-proposed',
      'repair-verified',
      'repair-applied',
      'publication-ready',
      'failed',
    ]),
    attemptIndex: z.number().int().nonnegative(),
    traceSha256: sha256ValueSchema.optional(),
    firstCauseCode: z.string().regex(SAFE_ID_PATTERN).optional(),
    taskIdentitySha256: sha256ValueSchema.optional(),
    proposalSha256: sha256ValueSchema.optional(),
    failureCode: z.enum(REFINEMENT_FAILURE_CODES as [
      RefinementFailureCode,
      ...RefinementFailureCode[],
    ]).optional(),
  })
  .strict()
const refinementRunReceiptEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION),
    authority: z.literal('diagnostic-only'),
    promotionAllowed: z.literal(false),
    contractSha256: sha256ValueSchema,
    status: z.enum(['publication-ready', 'failed']),
    failureCode: z
      .enum(REFINEMENT_FAILURE_CODES as [
        RefinementFailureCode,
        ...RefinementFailureCode[],
      ])
      .nullable(),
    attempts: z.array(z.unknown()),
    proposalSha256s: z.array(sha256ValueSchema),
    freshTaskCount: z.number().int().nonnegative(),
    refinementCount: z.number().int().nonnegative(),
    usage: refinementUsageSchema,
    events: z.array(refinementEventEnvelopeSchema),
    receiptSha256: sha256ValueSchema,
  })
  .strict()

function exactKeys(value: unknown, keys: readonly string[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value)
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

export function validateReconstructionRefinementBudget(
  input: unknown,
) {
  if (!exactKeys(input, [
    'maxRefinements',
    'maxFreshTasks',
    'maxTokens',
    'maxDurationMs',
    'repairPolicySha256',
  ])) return false
  const value = input as ReconstructionRefinementBudget
  return (
    nonNegativeInteger(value.maxRefinements) &&
    positiveInteger(value.maxFreshTasks) &&
    positiveInteger(value.maxTokens) &&
    positiveInteger(value.maxDurationMs) &&
    sha256(value.repairPolicySha256)
  )
}

function candidateContractProjection(
  value: Omit<ReconstructionCandidateContract, 'contractSha256'>,
) {
  return value
}

export function createReconstructionCandidateContract(
  input: Omit<ReconstructionCandidateContract, 'contractSha256'>,
): ReconstructionCandidateContract {
  const contract = {
    ...structuredClone(input),
    contractSha256: reconstructionRefinementHash(
      candidateContractProjection(input),
    ),
  }
  if (!validateReconstructionCandidateContract(contract)) {
    throw new Error('INVALID_RECONSTRUCTION_CANDIDATE_CONTRACT')
  }
  return contract
}

export function validateReconstructionCandidateContract(
  input: unknown,
) {
  if (!exactKeys(input, [
    'schemaVersion',
    'runId',
    'documentId',
    'sourcePdfSha256',
    'sourceEvidenceGraph',
    'authorities',
    'budget',
    'repairScope',
    'contractSha256',
  ])) return false
  const value = input as ReconstructionCandidateContract
  if (
    value.schemaVersion !== RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION ||
    !safeId(value.runId) ||
    !safeId(value.documentId) ||
    !sha256(value.sourcePdfSha256) ||
    !exactKeys(value.sourceEvidenceGraph, ['schemaVersion', 'sha256']) ||
    !safeId(value.sourceEvidenceGraph.schemaVersion) ||
    !sha256(value.sourceEvidenceGraph.sha256) ||
    !exactKeys(value.authorities, [
      'codex',
      'groundedVerifier',
      'artifactResolver',
      'sourceEvidenceVerifier',
      'renderObservationExtractor',
    ]) ||
    !exactKeys(value.authorities.codex, ['identity', 'identitySha256']) ||
    !validateOwnerLocalCodexIdentity(value.authorities.codex.identity) ||
    value.authorities.codex.identitySha256 !==
      reconstructionRefinementHash(value.authorities.codex.identity) ||
    !validGroundedVerifierAuthority(value.authorities.groundedVerifier) ||
    !validArtifactResolverAuthority(value.authorities.artifactResolver) ||
    !validGroundedVerifierAuthority(
      value.authorities.sourceEvidenceVerifier,
    ) ||
    !validGroundedVerifierAuthority(
      value.authorities.renderObservationExtractor,
    ) ||
    !validateReconstructionRefinementBudget(value.budget) ||
    !Array.isArray(value.repairScope) ||
    !sha256(value.contractSha256)
  ) {
    return false
  }
  const targets = new Set<string>()
  for (const scope of value.repairScope) {
    if (
      !exactKeys(scope, [
        'targetKind',
        'targetId',
        'candidateReferenceSha256s',
      ]) ||
      !['block', 'asset', 'relationship'].includes(scope.targetKind) ||
      !safeId(scope.targetId) ||
      !Array.isArray(scope.candidateReferenceSha256s) ||
      scope.candidateReferenceSha256s.length < 1 ||
      scope.candidateReferenceSha256s.some((candidate) => !sha256(candidate)) ||
      new Set(scope.candidateReferenceSha256s).size !==
        scope.candidateReferenceSha256s.length
    ) {
      return false
    }
    const target = `${scope.targetKind}:${scope.targetId}`
    if (targets.has(target)) return false
    targets.add(target)
  }
  const { contractSha256, ...projection } = value
  return contractSha256 === reconstructionRefinementHash(projection)
}

function selectionKey(value: StructEvidencePatchOperation) {
  return `${value.targetKind}:${value.targetId}`
}

function compareSelections(
  left: StructEvidencePatchOperation,
  right: StructEvidencePatchOperation,
) {
  const leftKey = `${selectionKey(left)}:${left.candidateReferenceSha256}`
  const rightKey = `${selectionKey(right)}:${right.candidateReferenceSha256}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

export function createReconstructionCandidateBinding(
  input: Omit<ReconstructionCandidateBinding, 'bindingSha256'>,
): ReconstructionCandidateBinding {
  const projection = structuredClone(input)
  projection.selections.sort(compareSelections)
  return {
    ...projection,
    bindingSha256: reconstructionRefinementHash(projection),
  }
}

export function validateReconstructionCandidateBinding(
  value: ReconstructionCandidateBinding,
  contract: ReconstructionCandidateContract,
) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'sourcePdfSha256',
      'sourceEvidenceGraphSha256',
      'canonicalStruct',
      'selections',
      'bindingSha256',
    ]) ||
    value.schemaVersion !== RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION ||
    value.sourcePdfSha256 !== contract.sourcePdfSha256 ||
    value.sourceEvidenceGraphSha256 !==
      contract.sourceEvidenceGraph.sha256 ||
    !hashedArtifactValueSchema.safeParse(value.canonicalStruct).success ||
    !sha256(value.bindingSha256) ||
    !Array.isArray(value.selections)
  ) {
    return false
  }
  const keys = new Set<string>()
  for (const selection of value.selections) {
    if (
      !structEvidencePatchOperationSchema.safeParse(selection).success
    ) {
      return false
    }
    const scope = contract.repairScope.find(
      (candidate) =>
        candidate.targetKind === selection.targetKind &&
        candidate.targetId === selection.targetId,
    )
    const key = selectionKey(selection)
    if (
      !scope?.candidateReferenceSha256s.includes(
        selection.candidateReferenceSha256,
      ) ||
      keys.has(key)
    ) {
      return false
    }
    keys.add(key)
  }
  const { bindingSha256, ...projection } = value
  return (
    value.selections.every(
      (selection, index) =>
        index === 0 ||
        compareSelections(value.selections[index - 1]!, selection) < 0,
    ) &&
    bindingSha256 === reconstructionRefinementHash(projection)
  )
}

export function validateReconstructionCandidate(
  value: ReconstructionCandidate,
  contract: ReconstructionCandidateContract,
) {
  return (
    exactKeys(value, ['binding', 'canonicalStructBytes']) &&
    value.canonicalStructBytes instanceof Uint8Array &&
    validateReconstructionCandidateBinding(value.binding, contract) &&
    value.binding.canonicalStruct.byteLength ===
      value.canonicalStructBytes.byteLength &&
    value.binding.canonicalStruct.sha256 ===
      sha256HexSync(value.canonicalStructBytes)
  )
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  )
}

function projectionArtifact(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalTraceJson(value))
  return {
    artifact: { sha256: sha256HexSync(bytes), byteLength: bytes.byteLength },
    bytes,
  }
}

function parseCanonicalStructBytes(bytes: Uint8Array) {
  let text: string
  let value: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(text)
  } catch {
    throw new TypeError('INVALID_CANONICAL_STRUCT_BYTES')
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    canonicalTraceJson(value) !== text
  ) {
    throw new TypeError('INVALID_CANONICAL_STRUCT_BYTES')
  }
  return value as Record<string, unknown>
}

/** #200 may use this exact projection algorithm when materializing a patch. */
export function deriveStructRepairProjections(
  bytes: Uint8Array,
  operations: readonly StructEvidencePatchOperation[],
) {
  const value = parseCanonicalStructBytes(bytes)
  const unselected = structuredClone(value)
  const selected: Array<{
    targetKind: StructRepairTargetKind
    targetId: string
    value: unknown
  }> = []
  const collectionNames: Record<StructRepairTargetKind, string> = {
    block: 'blocks',
    asset: 'assets',
    relationship: 'relationships',
  }
  for (const operation of [...operations].sort(compareSelections)) {
    const collectionName = collectionNames[operation.targetKind]
    const collection = value[collectionName]
    const unselectedCollection = unselected[collectionName]
    if (!Array.isArray(collection) || !Array.isArray(unselectedCollection)) {
      throw new TypeError('INVALID_CANONICAL_STRUCT_TARGET_COLLECTION')
    }
    const matches = collection.flatMap((candidate, index) =>
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === operation.targetId
        ? [index]
        : [],
    )
    if (matches.length !== 1) {
      throw new TypeError('INVALID_CANONICAL_STRUCT_TARGET')
    }
    const index = matches[0]!
    selected.push({
      targetKind: operation.targetKind,
      targetId: operation.targetId,
      value: collection[index],
    })
    unselectedCollection[index] = {
      __selectedRepairTarget__: `${operation.targetKind}:${operation.targetId}`,
    }
  }
  const selectedProjection = projectionArtifact(selected)
  const unselectedProjection = projectionArtifact(unselected)
  return {
    selected: selectedProjection.artifact,
    selectedBytes: selectedProjection.bytes,
    unselected: unselectedProjection.artifact,
    unselectedBytes: unselectedProjection.bytes,
  }
}

function applicationReceiptProjection(
  receipt: MaterializedRepairApplicationReceipt,
) {
  return {
    schemaVersion: receipt.schemaVersion,
    proposalSha256: receipt.proposalSha256,
    operations: receipt.operations,
    beforeCanonicalStruct: receipt.beforeCanonicalStruct,
    beforeSelectedProjection: receipt.beforeSelectedProjection,
    beforeUnselectedProjection: receipt.beforeUnselectedProjection,
    resultingCanonicalStruct: receipt.resultingCanonicalStruct,
    resultingSelectedProjection: receipt.resultingSelectedProjection,
    resultingUnselectedProjection: receipt.resultingUnselectedProjection,
    groundedVerifier: receipt.groundedVerifier,
    unchangedUnselected: receipt.unchangedUnselected,
  }
}

function evidenceCandidateResolutionProjection(
  receipt: EvidenceCandidateResolutionReceipt,
) {
  const {
    payloadBytes: _payloadBytes,
    receiptSha256: _receiptSha256,
    ...projection
  } = receipt
  return projection
}

function evidenceCandidateResolutionBinding(
  receipt: EvidenceCandidateResolutionReceipt,
) {
  const { payloadBytes: _payloadBytes, ...binding } = receipt
  return binding
}

function resolveEvidenceCandidatePayloads(
  contract: ReconstructionCandidateContract,
  proposal: StructEvidencePatch,
  authorities: MaterializationVerificationAuthorities,
) {
  const expectedIdentitySha256 =
    contract.authorities.sourceEvidenceVerifier.identitySha256
  if (
    !validGroundedVerifierIdentity(authorities.sourceEvidenceVerifier.identity) ||
    hashTraceValue(authorities.sourceEvidenceVerifier.identity) !==
      expectedIdentitySha256
  ) {
    throw new TypeError('INVALID_MATERIALIZED_REPAIR_APPLICATION_RECEIPT')
  }
  const references = [
    ...new Set(
      proposal.operations.map(
        ({ candidateReferenceSha256 }) => candidateReferenceSha256,
      ),
    ),
  ].sort()
  return references.map((referenceSha256) => {
    const bindings = authorities.evidenceCandidates.filter(
      (candidate) => candidate.referenceSha256 === referenceSha256,
    )
    if (bindings.length !== 1) {
      throw new TypeError('INVALID_MATERIALIZED_REPAIR_APPLICATION_RECEIPT')
    }
    const request: EvidenceCandidateResolutionRequest = {
      schemaVersion: '1.0.0',
      sourceEvidenceGraphSha256: contract.sourceEvidenceGraph.sha256,
      referenceSha256,
      bindingSha256: bindings[0]!.bindingSha256,
    }
    const receipt = evidenceCandidateResolutionReceiptSchema.parse(
      authorities.sourceEvidenceVerifier.resolveCandidate(
        structuredClone(request),
      ),
    ) as EvidenceCandidateResolutionReceipt
    if (
      hashTraceValue(receipt.verifierIdentity) !== expectedIdentitySha256 ||
      receipt.verifierIdentitySha256 !== expectedIdentitySha256 ||
      receipt.requestSha256 !== hashTraceValue(request) ||
      receipt.referenceSha256 !== request.referenceSha256 ||
      receipt.bindingSha256 !== request.bindingSha256 ||
      receipt.payload.byteLength !== receipt.payloadBytes.byteLength ||
      receipt.payload.sha256 !== sha256HexSync(receipt.payloadBytes) ||
      receipt.receiptSha256 !==
        hashTraceValue(evidenceCandidateResolutionProjection(receipt))
    ) {
      throw new TypeError('INVALID_MATERIALIZED_REPAIR_APPLICATION_RECEIPT')
    }
    return receipt
  })
}

function selectedGroundingRequestProjection(
  request: SelectedGroundingVerificationRequest,
) {
  return {
    schemaVersion: request.schemaVersion,
    sourceEvidenceGraphSha256: request.sourceEvidenceGraphSha256,
    proposalSha256: request.proposalSha256,
    operations: request.operations,
    beforeCanonicalStruct: request.beforeCanonicalStruct,
    resultingCanonicalStruct: request.resultingCanonicalStruct,
    beforeSelectedProjection: request.beforeSelectedProjection,
    resultingSelectedProjection: request.resultingSelectedProjection,
    candidatePayloads: request.candidatePayloads.map(
      evidenceCandidateResolutionBinding,
    ),
  }
}

export function parseMaterializedRepairApplicationReceipt(
  input: unknown,
  before: ReconstructionCandidate,
  proposal: StructEvidencePatch,
  contract: ReconstructionCandidateContract,
  authorities: MaterializationVerificationAuthorities,
) {
  const receipt = materializedRepairApplicationReceiptSchema.parse(
    input,
  ) as MaterializedRepairApplicationReceipt
  let beforeProjections: ReturnType<typeof deriveStructRepairProjections>
  let resultingProjections: ReturnType<typeof deriveStructRepairProjections>
  try {
    beforeProjections = deriveStructRepairProjections(
      before.canonicalStructBytes,
      proposal.operations,
    )
    resultingProjections = deriveStructRepairProjections(
      receipt.resultingCanonicalStructBytes,
      proposal.operations,
    )
  } catch {
    throw new TypeError('INVALID_MATERIALIZED_REPAIR_APPLICATION_RECEIPT')
  }
  const operationTargetSetSha256 = hashTraceValue(
    proposal.operations
      .map(({ targetKind, targetId }) => ({ targetKind, targetId }))
      .sort((left, right) =>
        left.targetKind === right.targetKind
          ? left.targetId.localeCompare(right.targetId)
          : left.targetKind.localeCompare(right.targetKind),
      ),
  )
  const candidateReferenceSetSha256 = hashTraceValue(
    proposal.operations
      .map(({ candidateReferenceSha256 }) => candidateReferenceSha256)
      .sort(),
  )
  const candidatePayloads = resolveEvidenceCandidatePayloads(
    contract,
    proposal,
    authorities,
  )
  const candidatePayloadSetSha256 = hashTraceValue(
    candidatePayloads.map(evidenceCandidateResolutionBinding),
  )
  const groundingRequest: SelectedGroundingVerificationRequest = {
    schemaVersion: '1.0.0',
    sourceEvidenceGraphSha256: contract.sourceEvidenceGraph.sha256,
    proposalSha256: proposal.proposalSha256,
    operations: proposal.operations,
    beforeCanonicalStruct: before.binding.canonicalStruct,
    beforeCanonicalStructBytes: before.canonicalStructBytes,
    resultingCanonicalStruct: receipt.resultingCanonicalStruct,
    resultingCanonicalStructBytes: receipt.resultingCanonicalStructBytes,
    beforeSelectedProjection: beforeProjections.selected,
    beforeSelectedProjectionBytes: beforeProjections.selectedBytes,
    resultingSelectedProjection: resultingProjections.selected,
    resultingSelectedProjectionBytes: resultingProjections.selectedBytes,
    candidatePayloads,
  }
  const groundedInputSha256 = hashTraceValue(
    selectedGroundingRequestProjection(groundingRequest),
  )
  const groundedOutputSha256 = hashTraceValue({
    resultingStructSha256: receipt.resultingCanonicalStruct.sha256,
    resultingSelectedProjectionSha256: resultingProjections.selected.sha256,
    resultingUnselectedProjectionSha256:
      resultingProjections.unselected.sha256,
  })
  const executedGrounding = groundedVerifierReceiptSchema.parse(
    authorities.groundedVerifier.verifySelected(
      structuredClone(groundingRequest),
    ),
  ) as GroundedVerifierReceipt
  const { receiptSha256: groundedReceiptSha256, ...groundedProjection } =
    receipt.groundedVerifier
  const {
    receiptSha256: unchangedReceiptSha256,
    ...unchangedProjection
  } = receipt.unchangedUnselected
  if (
    receipt.proposalSha256 !== proposal.proposalSha256 ||
    hashTraceValue(receipt.operations) !== hashTraceValue(proposal.operations) ||
    hashTraceValue(receipt.beforeCanonicalStruct) !==
      hashTraceValue(before.binding.canonicalStruct) ||
    !sameBytes(before.canonicalStructBytes, receipt.beforeCanonicalStructBytes) ||
    receipt.beforeCanonicalStructBytes.byteLength !==
      receipt.beforeCanonicalStruct.byteLength ||
    sha256HexSync(receipt.beforeCanonicalStructBytes) !==
      receipt.beforeCanonicalStruct.sha256 ||
    receipt.resultingCanonicalStructBytes.byteLength !==
      receipt.resultingCanonicalStruct.byteLength ||
    sha256HexSync(receipt.resultingCanonicalStructBytes) !==
      receipt.resultingCanonicalStruct.sha256 ||
    receipt.resultingCanonicalStruct.sha256 ===
      receipt.beforeCanonicalStruct.sha256 ||
    hashTraceValue(receipt.beforeSelectedProjection) !==
      hashTraceValue(beforeProjections.selected) ||
    hashTraceValue(receipt.beforeUnselectedProjection) !==
      hashTraceValue(beforeProjections.unselected) ||
    hashTraceValue(receipt.resultingSelectedProjection) !==
      hashTraceValue(resultingProjections.selected) ||
    hashTraceValue(receipt.resultingUnselectedProjection) !==
      hashTraceValue(resultingProjections.unselected) ||
    receipt.beforeUnselectedProjection.sha256 !==
      receipt.resultingUnselectedProjection.sha256 ||
    receipt.beforeUnselectedProjection.byteLength !==
      receipt.resultingUnselectedProjection.byteLength ||
    hashTraceValue(receipt.groundedVerifier.verifierIdentity) !==
      hashTraceValue(contract.authorities.groundedVerifier.identity) ||
    receipt.groundedVerifier.verifierIdentitySha256 !==
      contract.authorities.groundedVerifier.identitySha256 ||
    receipt.groundedVerifier.sourceEvidenceGraphSha256 !==
      contract.sourceEvidenceGraph.sha256 ||
    receipt.groundedVerifier.proposalSha256 !== proposal.proposalSha256 ||
    receipt.groundedVerifier.operationTargetSetSha256 !==
      operationTargetSetSha256 ||
    receipt.groundedVerifier.candidateReferenceSetSha256 !==
      candidateReferenceSetSha256 ||
    receipt.groundedVerifier.candidatePayloadSetSha256 !==
      candidatePayloadSetSha256 ||
    receipt.groundedVerifier.beforeStructSha256 !==
      before.binding.canonicalStruct.sha256 ||
    receipt.groundedVerifier.resultingStructSha256 !==
      receipt.resultingCanonicalStruct.sha256 ||
    receipt.groundedVerifier.beforeSelectedProjectionSha256 !==
      beforeProjections.selected.sha256 ||
    receipt.groundedVerifier.beforeUnselectedProjectionSha256 !==
      beforeProjections.unselected.sha256 ||
    receipt.groundedVerifier.resultingSelectedProjectionSha256 !==
      resultingProjections.selected.sha256 ||
    receipt.groundedVerifier.resultingUnselectedProjectionSha256 !==
      resultingProjections.unselected.sha256 ||
    receipt.groundedVerifier.inputSha256 !== groundedInputSha256 ||
    receipt.groundedVerifier.outputSha256 !== groundedOutputSha256 ||
    hashTraceValue(authorities.groundedVerifier.identity) !==
      contract.authorities.groundedVerifier.identitySha256 ||
    hashTraceValue(executedGrounding) !==
      hashTraceValue(receipt.groundedVerifier) ||
    groundedReceiptSha256 !== hashTraceValue(groundedProjection) ||
    receipt.unchangedUnselected.beforeSha256 !==
      beforeProjections.unselected.sha256 ||
    receipt.unchangedUnselected.afterSha256 !==
      resultingProjections.unselected.sha256 ||
    unchangedReceiptSha256 !== hashTraceValue(unchangedProjection) ||
    receipt.receiptSha256 !== hashTraceValue(applicationReceiptProjection(receipt))
  ) {
    throw new TypeError('INVALID_MATERIALIZED_REPAIR_APPLICATION_RECEIPT')
  }
  return receipt
}

function candidateAfterApplication(
  before: ReconstructionCandidate,
  receipt: MaterializedRepairApplicationReceipt,
  proposal: StructEvidencePatch,
) {
  const patchedTargets = new Set(proposal.operations.map(selectionKey))
  return {
    binding: createReconstructionCandidateBinding({
      schemaVersion: RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION,
      sourcePdfSha256: before.binding.sourcePdfSha256,
      sourceEvidenceGraphSha256: before.binding.sourceEvidenceGraphSha256,
      canonicalStruct: receipt.resultingCanonicalStruct,
      selections: [
        ...before.binding.selections.filter(
          (selection) => !patchedTargets.has(selectionKey(selection)),
        ),
        ...proposal.operations,
      ],
    }),
    canonicalStructBytes: receipt.resultingCanonicalStructBytes,
  } satisfies ReconstructionCandidate
}

function validLoopbackTransport(transport: string) {
  if (transport.startsWith('unix://')) {
    const path = transport.slice('unix://'.length)
    return (
      path.startsWith('/') &&
      !path.includes('\0') &&
      !path.split('/').includes('..')
    )
  }
  try {
    const url = new URL(transport)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

function nonPlaceholderIdentity(value: string) {
  return safeId(value) && !PLACEHOLDER_IDENTITY_PATTERN.test(value)
}

export function validateOwnerLocalCodexIdentity(
  value: OwnerLocalCodexIdentity,
) {
  return (
    exactKeys(value, ['server', 'model', 'prompt', 'tool']) &&
    exactKeys(value.server, [
      'id',
      'version',
      'transport',
      'executableSha256',
    ]) &&
    nonPlaceholderIdentity(value.server.id) &&
    nonPlaceholderIdentity(value.server.version) &&
    validLoopbackTransport(value.server.transport) &&
    sha256(value.server.executableSha256) &&
    exactKeys(value.model, ['id', 'version', 'sha256']) &&
    nonPlaceholderIdentity(value.model.id) &&
    nonPlaceholderIdentity(value.model.version) &&
    sha256(value.model.sha256) &&
    exactKeys(value.prompt, ['id', 'version', 'sha256']) &&
    nonPlaceholderIdentity(value.prompt.id) &&
    nonPlaceholderIdentity(value.prompt.version) &&
    sha256(value.prompt.sha256) &&
    exactKeys(value.tool, ['id', 'version']) &&
    value.tool.id === 'codex' &&
    nonPlaceholderIdentity(value.tool.version)
  )
}

export function hashOwnerLocalCodexIdentity(value: OwnerLocalCodexIdentity) {
  return reconstructionRefinementHash(value)
}

function validGroundedVerifierIdentity(
  value: GroundedVerifierIdentity,
) {
  return (
    exactKeys(value, [
      'id',
      'version',
      'configurationSha256',
      'executableSha256',
    ]) &&
    nonPlaceholderIdentity(value.id) &&
    nonPlaceholderIdentity(value.version) &&
    sha256(value.configurationSha256) &&
    sha256(value.executableSha256)
  )
}

function validGroundedVerifierAuthority(
  value: ReconstructionCandidateContract['authorities']['groundedVerifier'],
) {
  return (
    exactKeys(value, ['identity', 'identitySha256']) &&
    validGroundedVerifierIdentity(value.identity) &&
    value.identitySha256 === reconstructionRefinementHash(value.identity)
  )
}

function validArtifactResolverIdentity(
  value: OwnerLocalArtifactResolverIdentity,
) {
  return (
    exactKeys(value, ['id', 'version', 'configurationSha256']) &&
    nonPlaceholderIdentity(value.id) &&
    nonPlaceholderIdentity(value.version) &&
    sha256(value.configurationSha256)
  )
}

function validArtifactResolverAuthority(
  value: ReconstructionCandidateContract['authorities']['artifactResolver'],
) {
  return (
    exactKeys(value, ['identity', 'identitySha256']) &&
    validArtifactResolverIdentity(value.identity) &&
    value.identitySha256 === reconstructionRefinementHash(value.identity)
  )
}

function artifactVerificationProjection(
  receipt: OwnerLocalArtifactVerificationReceipt,
) {
  return {
    schemaVersion: receipt.schemaVersion,
    resolverIdentity: receipt.resolverIdentity,
    resolverIdentitySha256: receipt.resolverIdentitySha256,
    requestSha256: receipt.requestSha256,
    artifact: receipt.artifact,
    status: receipt.status,
  }
}

function verifyOwnerLocalArtifact(
  contract: ReconstructionCandidateContract,
  resolver: OwnerLocalArtifactResolver,
  request: OwnerLocalArtifactResolutionRequest,
) {
  const receipt = ownerLocalArtifactVerificationReceiptSchema.parse(
    resolver.resolve(structuredClone(request)),
  ) as OwnerLocalArtifactVerificationReceipt
  return (
    hashTraceValue(resolver.identity) ===
      contract.authorities.artifactResolver.identitySha256 &&
    hashTraceValue(receipt.resolverIdentity) ===
      contract.authorities.artifactResolver.identitySha256 &&
    receipt.resolverIdentitySha256 ===
      contract.authorities.artifactResolver.identitySha256 &&
    receipt.requestSha256 === hashTraceValue(request) &&
    hashTraceValue(receipt.artifact) === hashTraceValue(request.artifact) &&
    receipt.bytes.byteLength === request.artifact.byteLength &&
    sha256HexSync(receipt.bytes) === request.artifact.sha256 &&
    receipt.receiptSha256 ===
      hashTraceValue(artifactVerificationProjection(receipt))
  )
    ? receipt
    : null
}

function verifyTraceArtifacts(
  contract: ReconstructionCandidateContract,
  resolver: OwnerLocalArtifactResolver,
  trace: ReconstructionAttemptTrace,
) {
  if (
    !validArtifactResolverIdentity(resolver.identity) ||
    hashTraceValue(resolver.identity) !==
      contract.authorities.artifactResolver.identitySha256
  ) {
    return false
  }
  const requests: OwnerLocalArtifactResolutionRequest[] = [
    {
      schemaVersion: '1.0.0',
      runId: contract.runId,
      attemptTraceSha256: trace.traceSha256,
      kind: 'epub-download',
      logicalId: 'epub-download',
      artifact: trace.renderedEpub.download.artifact,
    },
    ...trace.renderedEpub.domSnapshots.map(({ spineHref, dom }, index) => ({
      schemaVersion: '1.0.0' as const,
      runId: contract.runId,
      attemptTraceSha256: trace.traceSha256,
      kind: 'dom-snapshot' as const,
      logicalId: `dom-snapshot:${index}:${spineHref}`,
      artifact: dom,
    })),
    ...trace.renderedEpub.screenshots.map(({ id, image }) => ({
      schemaVersion: '1.0.0' as const,
      runId: contract.runId,
      attemptTraceSha256: trace.traceSha256,
      kind: 'screenshot' as const,
      logicalId: `screenshot:${id}`,
      artifact: image,
    })),
  ]
  const resolved = requests.map((request) => {
    const receipt = verifyOwnerLocalArtifact(contract, resolver, request)
    return receipt
      ? {
          ...request,
          bytes: receipt.bytes,
          verificationReceiptSha256: receipt.receiptSha256,
        }
      : null
  })
  return resolved.every(
    (artifact): artifact is ResolvedRenderArtifact => artifact !== null,
  )
    ? resolved
    : null
}

function observationSetWithoutBytes<
  TSet extends SourceExpectedObservationSet | RenderedActualObservationSet,
>({ payloadBytes: _payloadBytes, ...set }: VerifiedObservationSet<TSet>) {
  return set
}

function validVerifiedObservationSet(
  value: VerifiedObservationSet<
    SourceExpectedObservationSet | RenderedActualObservationSet
  >,
) {
  const payload = parseCanonicalObservationPayloadBytes(value.payloadBytes)
  return (
    payload.check === value.check &&
    payload.items.length === value.itemCount &&
    value.payload.byteLength === value.payloadBytes.byteLength &&
    value.payload.sha256 === sha256HexSync(value.payloadBytes) &&
    value.setSha256 === value.payload.sha256
  )
}

function sourceEvidenceVerificationProjection(
  receipt: SourceEvidenceVerificationReceipt,
) {
  return {
    schemaVersion: receipt.schemaVersion,
    verifierIdentity: receipt.verifierIdentity,
    verifierIdentitySha256: receipt.verifierIdentitySha256,
    requestSha256: receipt.requestSha256,
    evidenceGraph: receipt.evidenceGraph,
    expectedObservationSets: receipt.expectedObservationSets.map(
      observationSetWithoutBytes,
    ),
    status: receipt.status,
  }
}

function verifySourceEvidenceAuthority(
  contract: ReconstructionCandidateContract,
  verifier: SourceEvidenceVerifier,
  trace: ReconstructionAttemptTrace,
) {
  const request: SourceEvidenceVerificationRequest = {
    schemaVersion: '1.0.0',
    sourcePdfSha256: trace.sourcePdf.artifact.sha256,
    evidenceGraph: trace.evidenceGraph.artifact,
    sourceObligationsSha256:
      trace.sourceEvidence.sourceObligations.obligationsSha256,
  }
  const receipt = sourceEvidenceVerificationReceiptSchema.parse(
    verifier.verifyExpected(structuredClone(request)),
  ) as SourceEvidenceVerificationReceipt
  const expectedIdentitySha256 =
    contract.authorities.sourceEvidenceVerifier.identitySha256
  return (
    validGroundedVerifierIdentity(verifier.identity) &&
    hashTraceValue(verifier.identity) === expectedIdentitySha256 &&
    hashTraceValue(receipt.verifierIdentity) === expectedIdentitySha256 &&
    receipt.verifierIdentitySha256 === expectedIdentitySha256 &&
    receipt.requestSha256 === hashTraceValue(request) &&
    hashTraceValue(receipt.evidenceGraph) ===
      hashTraceValue(trace.evidenceGraph.artifact) &&
    receipt.evidenceGraphBytes.byteLength ===
      trace.evidenceGraph.artifact.byteLength &&
    sha256HexSync(receipt.evidenceGraphBytes) ===
      trace.evidenceGraph.artifact.sha256 &&
    receipt.expectedObservationSets.every(
      (set, index) =>
        set.check === SOURCE_EPUB_OBSERVATION_CHECK_IDS[index] &&
        validVerifiedObservationSet(set) &&
        hashTraceValue(observationSetWithoutBytes(set)) ===
          hashTraceValue(trace.sourceEvidence.expectedObservationSets[index]),
    ) &&
    receipt.receiptSha256 ===
      hashTraceValue(sourceEvidenceVerificationProjection(receipt))
  )
}

function renderExtractionRequestProjection(
  request: RenderObservationExtractionRequest,
) {
  return {
    schemaVersion: request.schemaVersion,
    runId: request.runId,
    attemptTraceSha256: request.attemptTraceSha256,
    renderedEpubReceiptSha256: request.renderedEpubReceiptSha256,
    artifacts: request.artifacts.map(
      ({ bytes: _bytes, ...artifact }) => artifact,
    ),
  }
}

function renderObservationExtractionProjection(
  receipt: RenderObservationExtractionReceipt,
) {
  return {
    schemaVersion: receipt.schemaVersion,
    extractorIdentity: receipt.extractorIdentity,
    extractorIdentitySha256: receipt.extractorIdentitySha256,
    requestSha256: receipt.requestSha256,
    anchorInventorySha256: receipt.anchorInventorySha256,
    actualObservationSets: receipt.actualObservationSets.map(
      observationSetWithoutBytes,
    ),
    status: receipt.status,
  }
}

function verifyRenderObservationAuthority(
  contract: ReconstructionCandidateContract,
  extractor: RenderObservationExtractor,
  trace: ReconstructionAttemptTrace,
  artifacts: ResolvedRenderArtifact[],
) {
  const request: RenderObservationExtractionRequest = {
    schemaVersion: '1.0.0',
    runId: contract.runId,
    attemptTraceSha256: trace.traceSha256,
    renderedEpubReceiptSha256: trace.renderedEpub.receiptSha256,
    artifacts,
  }
  const receipt = renderObservationExtractionReceiptSchema.parse(
    extractor.extract(structuredClone(request)),
  ) as RenderObservationExtractionReceipt
  const expectedIdentitySha256 =
    contract.authorities.renderObservationExtractor.identitySha256
  const anchorInventorySha256 = hashTraceValue(
    trace.renderedEpub.domSnapshots
      .map(({ spineHref, anchors }) => ({
        spineHref,
        anchors: [...anchors].sort(),
      }))
      .sort((left, right) => left.spineHref.localeCompare(right.spineHref)),
  )
  const renderedAnchorIds = new Set(
    trace.renderedEpub.domSnapshots.flatMap(({ anchors }) => anchors),
  )
  return (
    validGroundedVerifierIdentity(extractor.identity) &&
    hashTraceValue(extractor.identity) === expectedIdentitySha256 &&
    hashTraceValue(receipt.extractorIdentity) === expectedIdentitySha256 &&
    receipt.extractorIdentitySha256 === expectedIdentitySha256 &&
    receipt.requestSha256 === hashTraceValue(renderExtractionRequestProjection(request)) &&
    receipt.anchorInventorySha256 === anchorInventorySha256 &&
    receipt.actualObservationSets.every(
      (set, index) =>
        set.check === SOURCE_EPUB_OBSERVATION_CHECK_IDS[index] &&
        validVerifiedObservationSet(set) &&
        parseCanonicalObservationPayloadBytes(set.payloadBytes).items.every(
          ({ anchorIds }) =>
            anchorIds.every((anchorId) => renderedAnchorIds.has(anchorId)),
        ) &&
        hashTraceValue(observationSetWithoutBytes(set)) ===
          hashTraceValue(trace.renderedEpub.actualObservationSets[index]),
    ) &&
    receipt.receiptSha256 ===
      hashTraceValue(renderObservationExtractionProjection(receipt))
  )
}

function patchProjection(value: Omit<StructEvidencePatch, 'proposalSha256'>) {
  return value
}

export function createStructEvidencePatch(
  input: Omit<StructEvidencePatch, 'proposalSha256'>,
) {
  return parseStructEvidencePatch({
    ...structuredClone(input),
    proposalSha256: reconstructionRefinementHash(patchProjection(input)),
  })
}

export function validateStructEvidencePatch(
  proposal: StructEvidencePatch,
  contract: ReconstructionCandidateContract,
  trace: RefinementTraceBinding,
  task: RefinementTask,
) {
  try {
    proposal = parseStructEvidencePatch(proposal)
  } catch {
    return false
  }
  if (
    proposal.schemaVersion !== STRUCT_EVIDENCE_PATCH_SCHEMA_VERSION ||
    proposal.documentId !== contract.documentId ||
    proposal.sourcePdfSha256 !== contract.sourcePdfSha256 ||
    proposal.sourceEvidenceGraphSha256 !==
      contract.sourceEvidenceGraph.sha256 ||
    proposal.baseStructSha256 !== trace.canonicalStructSha256 ||
    proposal.priorTraceSha256 !== trace.traceSha256 ||
    proposal.taskIdSha256 !== task.taskIdSha256
  ) {
    return false
  }
  const traceCandidates = new Set(trace.evidenceCandidateReferences)
  const operationKeys = new Set<string>()
  for (const operation of proposal.operations) {
    if (
      !structEvidencePatchOperationSchema.safeParse(operation).success ||
      !traceCandidates.has(operation.candidateReferenceSha256)
    ) {
      return false
    }
    const scope = contract.repairScope.find(
      (candidate) =>
        candidate.targetKind === operation.targetKind &&
        candidate.targetId === operation.targetId,
    )
    if (
      !scope?.candidateReferenceSha256s.includes(
        operation.candidateReferenceSha256,
      )
    ) {
      return false
    }
    const key = `${operation.targetKind}:${operation.targetId}`
    if (operationKeys.has(key)) return false
    operationKeys.add(key)
  }
  return true
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested)
    }
  }
  return value
}

function immutableClone<T>(value: T) {
  return deepFreeze(structuredClone(value))
}

function zeroUsage(): RefinementUsage {
  return { inputTokens: 0, outputTokens: 0, elapsedMs: 0 }
}

function validUsage(value: RefinementUsage) {
  return (
    exactKeys(value, ['inputTokens', 'outputTokens', 'elapsedMs']) &&
    nonNegativeInteger(value.inputTokens) &&
    nonNegativeInteger(value.outputTokens) &&
    Number.isFinite(value.elapsedMs) &&
    value.elapsedMs >= 0
  )
}

function combinedTokens(usage: RefinementUsage) {
  return usage.inputTokens + usage.outputTokens
}

function aborted(signal: AbortSignal) {
  if (!signal.aborted) return
  const error = new Error('INTERRUPTED')
  error.name = 'AbortError'
  throw error
}

function linkedAbortController(signal: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  return {
    controller,
    dispose: () => signal.removeEventListener('abort', abort),
  }
}

type ActiveRefinementRun = {
  runId: string
  generationSha256: string
  nextStageIndex: number
  pendingStages: Set<symbol>
  finished: boolean
}

const activeRefinementRuns = new Map<string, ActiveRefinementRun>()
const refinementRunGenerations = new Map<string, number>()

function releaseRefinementRunWhenSettled(run: ActiveRefinementRun) {
  if (
    run.finished &&
    run.pendingStages.size === 0 &&
    activeRefinementRuns.get(run.runId) === run
  ) {
    activeRefinementRuns.delete(run.runId)
  }
}

type GuardedStageResult<T> = {
  value: T
  accept: <TResult>(commit: () => TResult) => TResult
  discard: () => void
}

async function withTaskDeadline<T>(
  operation: (
    signal: AbortSignal,
    lease: CoordinatorStageLease,
  ) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  run: ActiveRefinementRun,
  stage: string,
): Promise<GuardedStageResult<T>> {
  aborted(signal)
  const { controller, dispose } = linkedAbortController(signal)
  const pendingStage = Symbol(stage)
  const stageIndex = run.nextStageIndex
  run.nextStageIndex += 1
  let active = true
  let abortAcknowledged = false
  const current = () =>
    active &&
    !controller.signal.aborted &&
    activeRefinementRuns.get(run.runId) === run
  const settle = () => {
    run.pendingStages.delete(pendingStage)
    releaseRefinementRunWhenSettled(run)
  }
  const lease: CoordinatorStageLease = Object.freeze({
    runId: run.runId,
    generationSha256: run.generationSha256,
    stageSha256: hashTraceValue({
      generationSha256: run.generationSha256,
      stage,
      stageIndex,
    }),
    tryCommit: () => current(),
    acknowledgeAbort: () => {
      if (!controller.signal.aborted || abortAcknowledged) return false
      abortAcknowledged = true
      settle()
      return true
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        active = false
        const error = new Error('INTERRUPTED')
        error.name = 'AbortError'
        reject(error)
      },
      { once: true },
    )
  })
  try {
    run.pendingStages.add(pendingStage)
    const operationPromise = Promise.resolve().then(() =>
      operation(controller.signal, lease),
    )
    void operationPromise.then(settle, settle)
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          active = false
          reject(new Error('TASK_TIMEOUT'))
          controller.abort()
        },
        Math.max(1, timeoutMs),
      )
    })
    const value = await Promise.race([
      operationPromise,
      timeout,
      interrupted,
    ])
    return {
      value,
      accept: (commit) => {
        if (!current()) throw new Error('STALE_RUN_GENERATION')
        try {
          return commit()
        } finally {
          active = false
        }
      },
      discard: () => {
        active = false
      },
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    dispose()
  }
}

function validateTraceBinding(
  value: RefinementTraceBinding,
  contract: ReconstructionCandidateContract,
  attemptIndex: number,
  parentTraceSha256: string | null,
  expectedUsage: RefinementTraceBinding['usage'],
) {
  return (
    exactKeys(value, [
      'traceSha256',
      'sourcePdfSha256',
      'sourceEvidenceGraphSha256',
      'canonicalStructSha256',
      'attemptIndex',
      'parentTraceSha256',
      'terminalStatus',
      'firstCause',
      'evidenceCandidateReferences',
      'policy',
      'usage',
    ]) &&
    sha256(value.traceSha256) &&
    value.sourcePdfSha256 === contract.sourcePdfSha256 &&
    value.sourceEvidenceGraphSha256 === contract.sourceEvidenceGraph.sha256 &&
    sha256(value.canonicalStructSha256) &&
    value.attemptIndex === attemptIndex &&
    value.parentTraceSha256 === parentTraceSha256 &&
    ['publication-ready', 'failed'].includes(value.terminalStatus) &&
    (value.firstCause === null ||
      (exactKeys(value.firstCause, ['failureReferenceSha256', 'code']) &&
        sha256(value.firstCause.failureReferenceSha256) &&
        safeId(value.firstCause.code))) &&
    Array.isArray(value.evidenceCandidateReferences) &&
    value.evidenceCandidateReferences.length > 0 &&
    value.evidenceCandidateReferences.every(sha256) &&
    new Set(value.evidenceCandidateReferences).size ===
      value.evidenceCandidateReferences.length &&
    exactKeys(value.policy, [
      'repairPolicySha256',
      'maxRefinements',
      'maxFreshTasks',
      'maxTokens',
      'maxDurationMs',
    ]) &&
    value.policy.repairPolicySha256 === contract.budget.repairPolicySha256 &&
    value.policy.maxRefinements === contract.budget.maxRefinements &&
    value.policy.maxFreshTasks === contract.budget.maxFreshTasks &&
    value.policy.maxTokens === contract.budget.maxTokens &&
    value.policy.maxDurationMs === contract.budget.maxDurationMs &&
    exactKeys(value.usage, [
      'refinements',
      'freshTasks',
      'tokens',
      'durationMs',
    ]) &&
    value.usage.refinements === expectedUsage.refinements &&
    value.usage.freshTasks === expectedUsage.freshTasks &&
    value.usage.tokens === expectedUsage.tokens &&
    value.usage.durationMs === expectedUsage.durationMs
  )
}

function validTask(
  task: RefinementTask,
  contract: ReconstructionCandidateContract,
  trace: RefinementTraceBinding,
  expectedIdentity: OwnerLocalCodexIdentity,
) {
  return (
    refinementTaskSchema.safeParse(task).success &&
    task.documentId === contract.documentId &&
    task.runId === contract.runId &&
    task.fresh === true &&
    task.parentTaskId === null &&
    task.contextPolicy === 'immutable-prior-trace-only' &&
    task.acceptedTraceSha256 === trace.traceSha256 &&
    reconstructionRefinementHash(task.identity) ===
      reconstructionRefinementHash(expectedIdentity)
  )
}

function traceMatchesCodexAuthority(
  trace: ReconstructionAttemptTrace,
  contract: ReconstructionCandidateContract,
) {
  const expected = contract.authorities.codex.identitySha256
  const reconciliation = trace.providerReceipts.find(
    ({ role }) => role === 'owner-local-codex-reconciliation',
  )
  const repair = trace.providerReceipts.find(
    ({ role }) => role === 'owner-local-codex-repair',
  )
  return (
    reconciliation?.identitySha256 === expected &&
    (!repair || repair.identitySha256 === expected)
  )
}

function receiptProjection(
  value: Omit<RefinementRunReceipt, 'receiptSha256'>,
) {
  return value
}

function finalizeReceipt(
  input: Omit<RefinementRunReceipt, 'receiptSha256'>,
): RefinementRunReceipt {
  const projection = structuredClone(input)
  return {
    ...projection,
    receiptSha256: reconstructionRefinementHash(receiptProjection(projection)),
  }
}

function validRefinementEvent(value: RefinementEvent) {
  if (
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Number.isSafeInteger(value.attemptIndex) ||
    value.attemptIndex < 0
  ) {
    return false
  }
  const base = ['sequence', 'kind', 'attemptIndex']
  switch (value.kind) {
    case 'server-verified':
      return (
        exactKeys(value, [...base, 'taskIdentitySha256']) &&
        sha256(value.taskIdentitySha256)
      )
    case 'rendered-and-compared':
      return (
        exactKeys(value, [
          ...base,
          'traceSha256',
          ...(value.firstCauseCode === undefined ? [] : ['firstCauseCode']),
        ]) &&
        sha256(value.traceSha256) &&
        (value.firstCauseCode === undefined || safeId(value.firstCauseCode))
      )
    case 'fresh-task-created':
      return (
        exactKeys(value, [
          ...base,
          'traceSha256',
          'taskIdentitySha256',
        ]) &&
        sha256(value.traceSha256) &&
        sha256(value.taskIdentitySha256)
      )
    case 'repair-proposed':
    case 'repair-verified':
    case 'repair-applied':
      return (
        exactKeys(value, [...base, 'traceSha256', 'proposalSha256']) &&
        sha256(value.traceSha256) &&
        sha256(value.proposalSha256)
      )
    case 'publication-ready':
      return (
        exactKeys(value, [...base, 'traceSha256']) &&
        sha256(value.traceSha256)
      )
    case 'failed':
      return (
        exactKeys(value, [...base, 'failureCode']) &&
        REFINEMENT_FAILURE_CODES.includes(value.failureCode!)
      )
  }
}

function validatePublicRefinementReceipt(input: unknown) {
  const parsed = refinementRunReceiptEnvelopeSchema.safeParse(input)
  if (!parsed.success) return false
  const receipt = parsed.data as unknown as RefinementRunReceipt
  const { receiptSha256, ...projection } = receipt
  const freshTaskEvents = receipt.events.filter(
    (event) => event.kind === 'fresh-task-created',
  )
  const verifiedRepairEvents = receipt.events.filter(
    (event) => event.kind === 'repair-verified',
  )
  const appliedRepairEvents = receipt.events.filter(
    (event) => event.kind === 'repair-applied',
  )
  const renderedEvents = receipt.events.filter(
    (event) => event.kind === 'rendered-and-compared',
  )
  const terminalEvents = receipt.events.filter(
    (event) => event.kind === 'publication-ready' || event.kind === 'failed',
  )
  if (
    !exactKeys(receipt, [
      'schemaVersion',
      'authority',
      'promotionAllowed',
      'contractSha256',
      'status',
      'failureCode',
      'attempts',
      'proposalSha256s',
      'freshTaskCount',
      'refinementCount',
      'usage',
      'events',
      'receiptSha256',
    ]) ||
    receipt.schemaVersion !== RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION ||
    receipt.authority !== 'diagnostic-only' ||
    receipt.promotionAllowed !== false ||
    !['publication-ready', 'failed'].includes(receipt.status) ||
    !sha256(receipt.contractSha256) ||
    !sha256(receiptSha256) ||
    receiptSha256 !== reconstructionRefinementHash(projection) ||
    !Array.isArray(receipt.attempts) ||
    !Array.isArray(receipt.proposalSha256s) ||
    !Array.isArray(receipt.events) ||
    !nonNegativeInteger(receipt.freshTaskCount) ||
    !nonNegativeInteger(receipt.refinementCount) ||
    !validUsage(receipt.usage) ||
    receipt.events.some((event) => !validRefinementEvent(event)) ||
    receipt.events.some((event, index) => event.sequence !== index) ||
    receipt.events.some(
      (event, index) =>
        event.attemptIndex < 0 ||
        !Number.isSafeInteger(event.attemptIndex) ||
        (index > 0 &&
          event.attemptIndex < receipt.events[index - 1]!.attemptIndex),
    ) ||
    (receipt.attempts.length > 0 &&
      !validateReconstructionAttemptRefinementTraceBindingLineage(
        receipt.attempts,
      )) ||
    receipt.proposalSha256s.some((proposalSha256) => !sha256(proposalSha256)) ||
    renderedEvents.length !== receipt.attempts.length ||
    renderedEvents.some((event, index) => {
      const attempt = receipt.attempts[index]
      return (
        event.traceSha256 !== attempt?.traceSha256 ||
        event.attemptIndex !== attempt?.attemptIndex ||
        event.firstCauseCode !== (attempt?.firstCause?.code ?? undefined)
      )
    }) ||
    receipt.proposalSha256s.length !== verifiedRepairEvents.length ||
    receipt.proposalSha256s.some(
      (proposalSha256, index) =>
        verifiedRepairEvents[index]?.proposalSha256 !== proposalSha256,
    ) ||
    receipt.refinementCount !== appliedRepairEvents.length ||
    appliedRepairEvents.length > verifiedRepairEvents.length ||
    appliedRepairEvents.some(
      (event, index) =>
        event.proposalSha256 !== verifiedRepairEvents[index]?.proposalSha256,
    ) ||
    receipt.freshTaskCount !== freshTaskEvents.length ||
    terminalEvents.length !== 1 ||
    terminalEvents[0] !== receipt.events.at(-1) ||
    (receipt.status === 'publication-ready' && receipt.attempts.length === 0) ||
    (receipt.status === 'publication-ready' &&
      terminalEvents[0]?.kind !== 'publication-ready') ||
    (receipt.status === 'failed' && terminalEvents[0]?.kind !== 'failed') ||
    (receipt.status === 'publication-ready' && receipt.failureCode !== null) ||
    (receipt.status === 'failed' && receipt.failureCode === null) ||
    (receipt.status === 'publication-ready' &&
      appliedRepairEvents.length !== verifiedRepairEvents.length)
  ) {
    return false
  }
  const finalAttempt = receipt.attempts.at(-1)
  if (
    receipt.status === 'publication-ready' &&
    (finalAttempt?.terminalStatus !== 'publication-ready' ||
      terminalEvents[0]?.traceSha256 !== finalAttempt.traceSha256)
  ) {
    return false
  }
  return true
}

/** Public diagnostics are never sufficient evidence for promotion. */
export function replayRefinementRun(receipt: unknown) {
  return (
    validatePublicRefinementReceipt(receipt) &&
    (receipt as RefinementRunReceipt).status === 'failed'
  )
}

/**
 * Promotion replay is private and authoritative: it requires the complete
 * owner-local trace and application chain, never the public projection alone.
 */
export function replayPrivateRefinementRun(
  contract: ReconstructionCandidateContract,
  result: ReconstructionRefinementRunResult,
  authorities: PrivateReplayAuthorities,
) {
  try {
    const { publicReceipt, privateEvidence } = result
    if (
      !validateReconstructionCandidateContract(contract) ||
      !validatePublicRefinementReceipt(publicReceipt) ||
      publicReceipt.status !== 'publication-ready' ||
      publicReceipt.contractSha256 !== contract.contractSha256 ||
      !validateReconstructionCandidate(
        privateEvidence.initialCandidate,
        contract,
      )
    ) {
      return false
    }

    const traces = parseReconstructionAttemptTraceLineage(
      privateEvidence.traces,
    )
    if (
      traces.length !== publicReceipt.attempts.length ||
      privateEvidence.applications.length !== traces.length - 1 ||
      publicReceipt.refinementCount !== privateEvidence.applications.length ||
      traces[0]?.structure.artifact.sha256 !==
        privateEvidence.initialCandidate.binding.canonicalStruct.sha256
    ) {
      return false
    }

    for (const [index, trace] of traces.entries()) {
      const resolvedRenderArtifacts = verifyTraceArtifacts(
        contract,
        authorities.artifactResolver,
        trace,
      )
      if (
        !resolvedRenderArtifacts ||
        !verifySourceEvidenceAuthority(
          contract,
          authorities.sourceEvidenceVerifier,
          trace,
        ) ||
        !verifyRenderObservationAuthority(
          contract,
          authorities.renderObservationExtractor,
          trace,
          resolvedRenderArtifacts,
        ) ||
        hashTraceValue(toRefinementTraceBinding(trace)) !==
          hashTraceValue(publicReceipt.attempts[index]) ||
        hashTraceValue(
          compareSourceToRenderedEpub({
            sourcePdfSha256: trace.sourcePdf.artifact.sha256,
            sourceEvidence: trace.sourceEvidence,
            structure: trace.structure,
            epub: trace.epub,
            renderedEpub: trace.renderedEpub,
            sourceRegions: trace.comparisonEvidence.sourceRegions,
            mappings: trace.mappings,
            observations: trace.comparisonEvidence.observations,
          }),
        ) !== hashTraceValue(trace.comparator)
      ) {
        return false
      }
    }

    let candidate = structuredClone(privateEvidence.initialCandidate)
    const replayedProposalSha256s: string[] = []
    for (const [index, application] of privateEvidence.applications.entries()) {
      const child = traces[index + 1]
      const proposal = child?.critiqueRepair?.proposal
      if (!child || !proposal) return false
      const verifiedApplication = parseMaterializedRepairApplicationReceipt(
        application,
        candidate,
        proposal,
        contract,
        {
          sourceEvidenceVerifier: authorities.sourceEvidenceVerifier,
          groundedVerifier: authorities.groundedVerifier,
          evidenceCandidates: traces[0]!.evidenceCandidates,
        },
      )
      candidate = candidateAfterApplication(
        candidate,
        verifiedApplication,
        proposal,
      )
      replayedProposalSha256s.push(proposal.proposalSha256)
      if (
        candidate.binding.canonicalStruct.sha256 !==
          child.structure.artifact.sha256 ||
        child.lineage.appliedRepair?.applicationReceiptSha256 !==
          verifiedApplication.receiptSha256 ||
        child.lineage.appliedRepair?.groundedVerifierReceiptSha256 !==
          verifiedApplication.groundedVerifier.receiptSha256
      ) {
        return false
      }
    }

    const finalTrace = traces.at(-1)
    return (
      finalTrace?.terminalState === 'publication-ready' &&
      publicReceipt.proposalSha256s.length ===
        replayedProposalSha256s.length &&
      publicReceipt.proposalSha256s.every(
        (proposalSha256, index) =>
          proposalSha256 === replayedProposalSha256s[index],
      ) &&
      publicReceipt.freshTaskCount === (traces.length > 1 ? 1 : 0) &&
      publicReceipt.usage.inputTokens + publicReceipt.usage.outputTokens ===
        finalTrace.budget.usage.tokens &&
      Math.ceil(publicReceipt.usage.elapsedMs) >=
        finalTrace.budget.usage.durationMs
    )
  } catch {
    return false
  }
}

function invalidContractRunResult(
  initialCandidate: ReconstructionCandidate,
): ReconstructionRefinementRunResult {
  const publicReceipt = finalizeReceipt({
    schemaVersion: RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION,
    authority: 'diagnostic-only',
    promotionAllowed: false,
    contractSha256: reconstructionRefinementHash({
      kind: 'invalid-runtime-contract',
    }),
    status: 'failed',
    failureCode: 'invalid-candidate-contract',
    attempts: [],
    proposalSha256s: [],
    freshTaskCount: 0,
    refinementCount: 0,
    usage: zeroUsage(),
    events: [
      {
        sequence: 0,
        kind: 'failed',
        attemptIndex: 0,
        failureCode: 'invalid-candidate-contract',
      },
    ],
  })
  return {
    publicReceipt,
    privateEvidence: {
      initialCandidate: structuredClone(initialCandidate),
      traces: [],
      applications: [],
    },
  }
}

function concurrentRunResult(
  contract: ReconstructionCandidateContract,
  initialCandidate: ReconstructionCandidate,
): ReconstructionRefinementRunResult {
  const publicReceipt = finalizeReceipt({
    schemaVersion: RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION,
    authority: 'diagnostic-only',
    promotionAllowed: false,
    contractSha256: contract.contractSha256,
    status: 'failed',
    failureCode: 'concurrent-run',
    attempts: [],
    proposalSha256s: [],
    freshTaskCount: 0,
    refinementCount: 0,
    usage: zeroUsage(),
    events: [
      {
        sequence: 0,
        kind: 'failed',
        attemptIndex: 0,
        failureCode: 'concurrent-run',
      },
    ],
  })
  return {
    publicReceipt,
    privateEvidence: {
      initialCandidate: structuredClone(initialCandidate),
      traces: [],
      applications: [],
    },
  }
}

type ReconstructionRefinementRunInput = {
  contract: ReconstructionCandidateContract
  initialCandidate: ReconstructionCandidate
  dependencies: ReconstructionRefinementDependencies
  signal?: AbortSignal
}

async function runReconstructionRefinementExclusive(
  {
    contract,
    initialCandidate,
    dependencies,
    signal = new AbortController().signal,
  }: ReconstructionRefinementRunInput,
  runLease: ActiveRefinementRun,
): Promise<ReconstructionRefinementRunResult> {
  if (!validateReconstructionCandidateContract(contract)) {
    return invalidContractRunResult(initialCandidate)
  }
  const privateTraces: ReconstructionAttemptTrace[] = []
  const applications: MaterializedRepairApplicationReceipt[] = []
  const frozenInitialCandidate = structuredClone(initialCandidate)
  const attempts: ReconstructionAttemptRefinementTraceBinding[] = []
  const proposalSha256s: string[] = []
  const events: RefinementEvent[] = []
  let usage = zeroUsage()
  let freshTaskCount = 0
  let refinementCount = 0
  let candidate = initialCandidate
  let task: RefinementTask | undefined
  let parentTraceSha256: string | null = null
  const startedAt = Date.now()
  const deadlineAt = startedAt + contract.budget.maxDurationMs
  const measuredElapsedMs = () => Math.max(0, Date.now() - startedAt)
  const remainingTimeMs = () => Math.max(0, deadlineAt - Date.now())
  const refreshElapsedUsage = () => {
    usage = { ...usage, elapsedMs: measuredElapsedMs() }
  }

  const event = (value: Omit<RefinementEvent, 'sequence'>): RefinementEvent => {
    const recorded = { sequence: events.length, ...value }
    events.push(recorded)
    return recorded
  }
  const finish = (
    status: RefinementRunReceipt['status'],
    failureCode: RefinementFailureCode | null,
  ) => {
    refreshElapsedUsage()
    const publicReceipt = finalizeReceipt({
      schemaVersion: RECONSTRUCTION_REFINEMENT_SCHEMA_VERSION,
      authority: 'diagnostic-only',
      promotionAllowed: false,
      contractSha256: contract.contractSha256,
      status,
      failureCode,
      attempts,
      proposalSha256s,
      freshTaskCount,
      refinementCount,
      usage,
      events,
    })
    return {
      publicReceipt,
      privateEvidence: {
        initialCandidate: frozenInitialCandidate,
        traces: structuredClone(privateTraces),
        applications: structuredClone(applications),
      },
    }
  }
  const fail = (code: RefinementFailureCode, attemptIndex: number) => {
    refreshElapsedUsage()
    event({ kind: 'failed', attemptIndex, failureCode: code })
    return finish('failed', code)
  }

  if (
    !validateReconstructionCandidate(initialCandidate, contract)
  ) {
    return fail('invalid-candidate-contract', 0)
  }
  const codex = dependencies.codex
  if (!codex) {
    return fail('codex-server-unavailable', 0)
  }
  if (
    !validateOwnerLocalCodexIdentity(codex.identity) ||
    hashOwnerLocalCodexIdentity(codex.identity) !==
      contract.authorities.codex.identitySha256
  ) {
    return fail('codex-identity-mismatch', 0)
  }
  try {
    const remaining = remainingTimeMs()
    if (remaining < 1) return fail('codex-probe-timeout', 0)
    const guardedProbe = await withTaskDeadline(
      (taskSignal, lease) => codex.probe(taskSignal, lease),
      remaining,
      signal,
      runLease,
      'codex-probe',
    )
    if (!guardedProbe.value.available) {
      guardedProbe.discard()
      return fail('codex-server-unavailable', 0)
    }
    guardedProbe.accept(() =>
      event({
        kind: 'server-verified',
        attemptIndex: 0,
        taskIdentitySha256: reconstructionRefinementHash(codex.identity),
      }),
    )
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return fail('interrupted', 0)
    }
    if (error instanceof Error && error.message === 'TASK_TIMEOUT') {
      return fail('codex-probe-timeout', 0)
    }
    return fail('codex-server-unavailable', 0)
  }
  for (
    let attemptIndex = 0;
    attemptIndex <= contract.budget.maxRefinements;
    attemptIndex += 1
  ) {
    let trace: ReconstructionAttemptTrace
    let binding: RefinementTraceBinding
    let guardedEvaluation: GuardedStageResult<ReconstructionAttemptTrace> | undefined
    try {
      aborted(signal)
      refreshElapsedUsage()
      const remaining = remainingTimeMs()
      if (remaining < 1) return fail('evaluation-timeout', attemptIndex)
      guardedEvaluation = await withTaskDeadline(
        (taskSignal, lease) =>
          dependencies.evaluate(candidate, {
            attemptIndex,
            parentTraceSha256,
            usage: {
              refinements: refinementCount,
              freshTasks: freshTaskCount,
              tokens: combinedTokens(usage),
              durationMs: Math.ceil(usage.elapsedMs),
            },
            signal: taskSignal,
            lease,
          }),
        remaining,
        signal,
        runLease,
        `evaluate:${attemptIndex}`,
      )
      trace = parseReconstructionAttemptTrace(guardedEvaluation.value)
      if (!traceMatchesCodexAuthority(trace, contract)) {
        guardedEvaluation.discard()
        return fail('codex-identity-mismatch', attemptIndex)
      }
      binding = toRefinementTraceBinding(trace)
    } catch (error) {
      guardedEvaluation?.discard()
      if (
        signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return fail('interrupted', attemptIndex)
      }
      if (error instanceof Error && error.message === 'TASK_TIMEOUT') {
        return fail('evaluation-timeout', attemptIndex)
      }
      return fail('evaluation-failed', attemptIndex)
    }
    if (
      !validateTraceBinding(
        binding,
        contract,
        attemptIndex,
        parentTraceSha256,
        {
          refinements: refinementCount,
          freshTasks: freshTaskCount,
          tokens: combinedTokens(usage),
          durationMs: Math.ceil(usage.elapsedMs),
        },
      ) ||
      binding.canonicalStructSha256 !==
        candidate.binding.canonicalStruct.sha256
    ) {
      guardedEvaluation.discard()
      return fail('stale-trace', attemptIndex)
    }
    if (
      (binding.terminalStatus === 'publication-ready' &&
        binding.firstCause !== null) ||
      (binding.terminalStatus === 'failed' && binding.firstCause === null)
    ) {
      guardedEvaluation.discard()
      return fail('missing-first-cause', attemptIndex)
    }
    const priorApplication = applications[attemptIndex - 1]
    if (
      attemptIndex > 0 &&
      (!priorApplication ||
        trace.lineage.appliedRepair?.applicationReceiptSha256 !==
          priorApplication.receiptSha256 ||
        trace.lineage.appliedRepair?.groundedVerifierReceiptSha256 !==
          priorApplication.groundedVerifier.receiptSha256 ||
        trace.lineage.appliedRepair?.resultingStructSha256 !==
          priorApplication.resultingCanonicalStruct.sha256)
    ) {
      guardedEvaluation.discard()
      return fail('stale-trace', attemptIndex)
    }
    try {
      parseReconstructionAttemptTraceLineage([...privateTraces, trace])
    } catch {
      guardedEvaluation.discard()
      return fail('stale-trace', attemptIndex)
    }
    try {
      guardedEvaluation.accept(() => {
        privateTraces.push(trace)
        attempts.push(binding)
        event({
          kind: 'rendered-and-compared',
          attemptIndex,
          traceSha256: binding.traceSha256,
          ...(binding.firstCause
            ? { firstCauseCode: binding.firstCause.code }
            : {}),
        })
        if (binding.terminalStatus === 'publication-ready') {
          event({
            kind: 'publication-ready',
            attemptIndex,
            traceSha256: binding.traceSha256,
          })
        }
      })
    } catch {
      return fail('interrupted', attemptIndex)
    }
    if (binding.terminalStatus === 'publication-ready') {
      return finish('publication-ready', null)
    }
    if (!binding.firstCause) return fail('missing-first-cause', attemptIndex)
    if (attemptIndex >= contract.budget.maxRefinements) {
      return fail('refinement-budget-exhausted', attemptIndex)
    }

    const immutablePriorTrace = immutableClone(trace)
    if (!task) {
      if (freshTaskCount >= contract.budget.maxFreshTasks) {
        return fail('fresh-task-budget-exhausted', attemptIndex)
      }
      const remaining = remainingTimeMs()
      if (remaining < 1) return fail('fresh-task-timeout', attemptIndex)
      let guardedTask: GuardedStageResult<unknown> | undefined
      let parsedTask: RefinementTask
      try {
        guardedTask = await withTaskDeadline(
          (taskSignal, lease) =>
              codex.createFreshTask(
                {
                  documentId: contract.documentId,
                  runId: contract.runId,
                  immutablePriorTrace,
                  priorTraceSha256: binding.traceSha256,
                  firstCause: binding.firstCause!,
                  budget: { ...contract.budget },
                },
                taskSignal,
                lease,
              ),
          remaining,
          signal,
          runLease,
          `create-fresh-task:${attemptIndex}`,
        )
        parsedTask = refinementTaskSchema.parse(
          guardedTask.value,
        ) as RefinementTask
      } catch (error) {
        guardedTask?.discard()
        if (
          signal.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          return fail('interrupted', attemptIndex)
        }
        if (error instanceof Error && error.message === 'TASK_TIMEOUT') {
          return fail('fresh-task-timeout', attemptIndex)
        }
        return fail('fresh-task-invalid', attemptIndex)
      }
      if (!validTask(parsedTask, contract, binding, codex.identity)) {
        guardedTask.discard()
        return fail('fresh-task-invalid', attemptIndex)
      }
      try {
        guardedTask.accept(() => {
          task = parsedTask
          freshTaskCount += 1
          event({
            kind: 'fresh-task-created',
            attemptIndex,
            traceSha256: binding.traceSha256,
            taskIdentitySha256: reconstructionRefinementHash(task.identity),
          })
        })
      } catch {
        return fail('interrupted', attemptIndex)
      }
    }

    const remainingTokens = contract.budget.maxTokens - combinedTokens(usage)
    const remaining = remainingTimeMs()
    if (remainingTokens < 1) {
      return fail('token-budget-exhausted', attemptIndex)
    }
    if (remaining < 1) return fail('repair-proposal-timeout', attemptIndex)
    let proposed: { proposal: StructEvidencePatch; usage: RefinementUsage }
    let guardedProposal: GuardedStageResult<unknown> | undefined
    try {
      guardedProposal = await withTaskDeadline(
        (taskSignal, lease) =>
          codex.proposeRepair(
            {
              task: structuredClone(task!),
              immutablePriorTrace,
              priorTraceSha256: binding.traceSha256,
              firstCause: binding.firstCause!,
              remainingTokens,
              remainingTimeMs: remaining,
            },
            taskSignal,
            lease,
          ),
        remaining,
        signal,
        runLease,
        `propose-repair:${attemptIndex}`,
      )
      const parsedResponse = codexProposalResponseSchema.parse(
        guardedProposal.value,
      )
      proposed = {
        proposal: parseStructEvidencePatch(parsedResponse.proposal),
        usage: parsedResponse.usage as RefinementUsage,
      }
    } catch (error) {
      guardedProposal?.discard()
      if (
        signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return fail('interrupted', attemptIndex)
      }
      if (error instanceof Error && error.message === 'TASK_TIMEOUT') {
        return fail('repair-proposal-timeout', attemptIndex)
      }
      return fail('invalid-repair-proposal', attemptIndex)
    }
    if (!validUsage(proposed.usage)) {
      guardedProposal.discard()
      return fail('invalid-repair-proposal', attemptIndex)
    }
    const nextUsage = {
      inputTokens: usage.inputTokens + proposed.usage.inputTokens,
      outputTokens: usage.outputTokens + proposed.usage.outputTokens,
      elapsedMs: measuredElapsedMs(),
    }
    if (combinedTokens(nextUsage) > contract.budget.maxTokens) {
      guardedProposal.discard()
      return fail('token-budget-exhausted', attemptIndex)
    }
    if (nextUsage.elapsedMs > contract.budget.maxDurationMs) {
      guardedProposal.discard()
      return fail('repair-proposal-timeout', attemptIndex)
    }
    if (
      !validateStructEvidencePatch(proposed.proposal, contract, binding, task!)
    ) {
      guardedProposal.discard()
      return fail('invalid-repair-proposal', attemptIndex)
    }
    try {
      guardedProposal.accept(() => {
        usage = nextUsage
        proposalSha256s.push(proposed.proposal.proposalSha256)
        event({
          kind: 'repair-proposed',
          attemptIndex,
          traceSha256: binding.traceSha256,
          proposalSha256: proposed.proposal.proposalSha256,
        })
        event({
          kind: 'repair-verified',
          attemptIndex,
          traceSha256: binding.traceSha256,
          proposalSha256: proposed.proposal.proposalSha256,
        })
      })
    } catch {
      return fail('interrupted', attemptIndex)
    }
    const before = candidate
    let guardedApplication: GuardedStageResult<unknown> | undefined
    try {
      aborted(signal)
      const remaining = remainingTimeMs()
      if (remaining < 1) return fail('repair-application-timeout', attemptIndex)
      guardedApplication = await withTaskDeadline(
        (taskSignal, lease) =>
            dependencies.materializeRepair(
              before,
              structuredClone(proposed.proposal),
              taskSignal,
              lease,
            ),
        remaining,
        signal,
        runLease,
        `materialize-repair:${attemptIndex}`,
      )
      const application: MaterializedRepairApplicationReceipt =
        parseMaterializedRepairApplicationReceipt(
        guardedApplication.value,
        before,
        proposed.proposal,
        contract,
        {
          ...dependencies.materializationVerification!,
          evidenceCandidates: trace.evidenceCandidates,
        },
      )
      const resultingCandidate = candidateAfterApplication(
        before,
        application,
        proposed.proposal,
      )
      guardedApplication.accept(() => {
        applications.push(application)
        candidate = resultingCandidate
        refinementCount += 1
        event({
          kind: 'repair-applied',
          attemptIndex,
          traceSha256: binding.traceSha256,
          proposalSha256: proposed.proposal.proposalSha256,
        })
        parentTraceSha256 = binding.traceSha256
      })
    } catch (error) {
      guardedApplication?.discard()
      if (
        signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return fail('interrupted', attemptIndex)
      }
      if (error instanceof Error && error.message === 'TASK_TIMEOUT') {
        return fail('repair-application-timeout', attemptIndex)
      }
      return fail('repair-application-failed', attemptIndex)
    }
  }

  return fail('refinement-budget-exhausted', contract.budget.maxRefinements)
}

export async function runReconstructionRefinement(
  input: ReconstructionRefinementRunInput,
): Promise<ReconstructionRefinementRunResult> {
  if (!validateReconstructionCandidateContract(input.contract)) {
    return invalidContractRunResult(input.initialCandidate)
  }
  const runId = input.contract.runId
  if (activeRefinementRuns.has(runId)) {
    return concurrentRunResult(input.contract, input.initialCandidate)
  }
  const generation = (refinementRunGenerations.get(runId) ?? 0) + 1
  refinementRunGenerations.set(runId, generation)
  const runLease: ActiveRefinementRun = {
    runId,
    generationSha256: hashTraceValue({
      runId,
      contractSha256: input.contract.contractSha256,
      generation,
    }),
    nextStageIndex: 0,
    pendingStages: new Set(),
    finished: false,
  }
  activeRefinementRuns.set(runId, runLease)
  try {
    return await runReconstructionRefinementExclusive(input, runLease)
  } finally {
    runLease.finished = true
    releaseRefinementRunWhenSettled(runLease)
  }
}
