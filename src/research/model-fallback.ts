import {
  HASH,
  MODEL_FALLBACK_DECISION_CLASSES,
  MODEL_FALLBACK_PROMPT_TEMPLATE_SHA256,
  MODEL_FALLBACK_SCHEMA_VERSION,
  SAFE_ID,
  boundedId,
  candidateAssociation,
  candidateIds,
  clone,
  finiteNonNegative,
  forbiddenEvidenceField,
  forbiddenModelField,
  hash,
  isCanonicalJsonValue,
  modelPromptHash,
  normalizedFieldKey,
  normalizedFixturePoint,
  normalizedIdentity,
  normalizeConsultationEvidence,
  normalizedSourceHash,
  ownDataKeys,
  receiptRecord,
  requestId,
  stableJson,
  validateModelConsultationReceipt,
  validConsultationCandidates,
  validReceiptConsultation,
  validReceiptDecision,
  type ModelConsultationClient,
  type ModelConsultationMetric,
  type ModelConsultationMetrics,
  type ModelConsultationRecord,
  type ModelDecisionMetricEvent,
  type ModelDecisionProposal,
  type ModelDecisionRequest,
  type ModelDecisionResponse,
  type ModelFallbackCandidate,
  type ModelFallbackChoice,
  type ModelFallbackDecisionClass,
  type ModelFallbackDecisionPoint,
  type ModelFallbackReceipt,
  type ModelIdentity,
  type NormalizedModelIdentity,
} from '../struct/model-consultation-receipt'

export {
  MODEL_ASSISTANCE_DEFAULT_ENABLED,
  MODEL_FALLBACK_DECISION_CLASSES,
  MODEL_FALLBACK_EVIDENCE_CODES,
  MODEL_FALLBACK_PROMPT_TEMPLATE_SHA256,
  MODEL_FALLBACK_SCHEMA_VERSION,
  validateModelConsultationReceipt,
} from '../struct/model-consultation-receipt'
export type {
  ModelConsultationClient,
  ModelConsultationMetric,
  ModelConsultationMetrics,
  ModelConsultationRecord,
  ModelConsultationRecordStatus,
  ModelDecisionMetricEvent,
  ModelDecisionProposal,
  ModelDecisionRequest,
  ModelDecisionResponse,
  ModelFallbackCandidate,
  ModelFallbackChoice,
  ModelFallbackDecisionClass,
  ModelFallbackDecisionPoint,
  ModelFallbackReceipt,
  ModelIdentity,
  NormalizedModelIdentity,
} from '../struct/model-consultation-receipt'

/**
 * Model assistance is deliberately a small decision service, rather than an
 * alternate extractor. A deterministic caller supplies the complete,
 * source-backed candidate set and the model can only return a reference to one
 * of those candidates.
 */
const EMBEDDED_DETERMINISTIC_RULE_ID =
  'embedded-deterministic-choice-v1' as const
export type ModelDecisionOutcome = {
  status: 'deterministic' | 'consulted' | 'review-required'
  documentId: string
  decisionId: string
  decisionClass: ModelFallbackDecisionClass
  choice: ModelFallbackChoice | null
  provenance: ModelConsultationRecord | null
  diagnostic?: string
}

export type ModelProposalVerification =
  | { status: 'accepted'; choice: ModelFallbackChoice }
  | { status: 'rejected'; code: string; message: string }

export type ModelFallbackFixture = {
  schemaVersion: typeof MODEL_FALLBACK_SCHEMA_VERSION
  id: string
  documentId: string
  decisionId: string
  decisionClass: ModelFallbackDecisionClass
  sourceSha256: string
  ambiguity: {
    reason: string
    inputs: Record<string, unknown>
    candidateIds: string[]
  }
  candidates: ModelFallbackCandidate[]
  modelPath: {
    status: 'model-consulted'
    choice: ModelFallbackChoice | null
  }
  rejectionPath: {
    status: 'review-required'
    diagnosticCode: string
  }
  resolution: 'model-consulted' | 'deterministic-decided'
  deterministicRuleId?: string
}

export type ModelFallbackDeterministicRule = (
  point: ModelFallbackDecisionPoint,
) => ModelFallbackChoice | string | null

type InternalFixture = ModelFallbackFixture & {
  point: ModelFallbackDecisionPoint
}

function isOpenDecision(point: ModelFallbackDecisionPoint) {
  if (
    point.status === 'sufficient-evidence' ||
    point.status === 'deterministic' ||
    point.evidenceStatus === 'sufficient'
  )
    return false
  if (point.insufficientEvidence === true) return true
  if (point.evidenceStatus === 'insufficient') return true
  if (point.status === 'insufficient-evidence' || point.status === 'ambiguous')
    return true
  return false
}

function sourceHashSnapshot(point: ModelFallbackDecisionPoint) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(point, 'sourceSha256')
    if (descriptor === undefined) {
      if ('sourceSha256' in point) return { status: 'rejected' as const }
      return { status: 'accepted' as const, value: undefined }
    }
    if (!Object.hasOwn(descriptor, 'value'))
      return { status: 'rejected' as const }
    const value = descriptor.value
    if (value !== undefined && (typeof value !== 'string' || !HASH.test(value)))
      return { status: 'rejected' as const }
    return { status: 'accepted' as const, value: value as string | undefined }
  } catch {
    return { status: 'rejected' as const }
  }
}

function candidateChoice(
  point: ModelFallbackDecisionPoint,
  value: ModelFallbackChoice | string | null | undefined,
): ModelProposalVerification {
  if (value === null || value === undefined)
    return {
      status: 'rejected',
      code: 'NO_CANDIDATE_CHOICE',
      message: 'The decision has no candidate choice.',
    }
  const ids = candidateIds(point.candidates)
  if (
    !point.candidates.every(
      (candidate) => candidateAssociation(candidate).valid,
    )
  )
    return {
      status: 'rejected',
      code: 'CONFLICTING_CANDIDATE_ASSOCIATION',
      message:
        'The deterministic candidate set has contradictory associations.',
    }
  const candidateId = typeof value === 'string' ? value : value.candidateId
  if (!candidateId || !ids.includes(candidateId))
    return {
      status: 'rejected',
      code: 'OUT_OF_CANDIDATE_SET',
      message:
        'The selected candidate was not produced by the deterministic layer.',
    }
  const candidate = point.candidates.find(({ id }) => id === candidateId)!
  const association = candidateAssociation(candidate)
  if (!association.valid)
    return {
      status: 'rejected',
      code: 'CONFLICTING_CANDIDATE_ASSOCIATION',
      message: 'The deterministic candidate has contradictory associations.',
    }
  const choice: ModelFallbackChoice = {
    candidateId,
    ...(typeof value === 'string'
      ? {}
      : {
          ...(value.associationId === undefined
            ? {}
            : { associationId: value.associationId }),
          ...(value.order === undefined ? {} : { order: value.order }),
        }),
  }
  if (
    choice.associationId !== undefined &&
    choice.associationId !== association.id
  )
    return {
      status: 'rejected',
      code: 'MODEL_AUTHORED_ASSOCIATION',
      message: 'The model cannot author an association outside the candidate.',
    }
  if (choice.order !== undefined && choice.order !== candidate.order)
    return {
      status: 'rejected',
      code: 'MODEL_AUTHORED_ORDER',
      message: 'The model cannot author an order outside the candidate.',
    }
  return { status: 'accepted', choice }
}

function forbiddenKey(
  value: unknown,
  path = '',
): { key: string; path: string } | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = forbiddenKey(child, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const keys = ownDataKeys(value)
  if (!keys) return null
  for (const key of keys) {
    if (forbiddenModelField(key)) return { key, path: `${path}.${key}` }
    const child = Object.getOwnPropertyDescriptor(value, key)?.value
    const found = forbiddenKey(child, `${path}.${key}`)
    if (found) return found
  }
  return null
}

function proposalAndMetrics(response: ModelDecisionResponse) {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const responseKeys = ownDataKeys(response)
    if (!responseKeys) throw new Error('INVALID_MODEL_RESPONSE_SHAPE')
    if (!responseKeys.includes('proposal')) {
      if (
        !responseKeys.includes('costUsd') &&
        !responseKeys.includes('latencyMs')
      )
        return {
          proposal: response as ModelDecisionProposal,
          costUsd: 0,
          latencyMs: null,
        }
      const {
        costUsd = 0,
        latencyMs = null,
        ...proposal
      } = response as Record<string, unknown>
      return {
        proposal: proposal as ModelDecisionProposal,
        costUsd,
        latencyMs,
      }
    }
    const wrapper = response as {
      proposal: ModelDecisionProposal
      costUsd?: unknown
      latencyMs?: unknown
    }
    const allowed = new Set(['proposal', 'costUsd', 'latencyMs'])
    const unknown = responseKeys.find((key) => !allowed.has(key))
    if (unknown)
      return {
        proposal: null,
        costUsd: 0,
        latencyMs: null,
        rejection: {
          status: 'rejected' as const,
          code: 'MODEL_RESPONSE_UNKNOWN_FIELD',
          message: `Model response wrapper field ${unknown} is not part of the provider contract.`,
        },
      }
    return {
      proposal: wrapper.proposal,
      costUsd: wrapper.costUsd ?? 0,
      latencyMs: wrapper.latencyMs ?? null,
    }
  }
  return {
    proposal: response as ModelDecisionProposal,
    costUsd: 0,
    latencyMs: null,
  }
}

/**
 * Verify a model response without ever materialising model-authored content.
 * The only successful output is a candidate id plus metadata already present
 * on that candidate.
 */
export function verifyModelDecisionProposal(
  point: ModelFallbackDecisionPoint,
  proposal: ModelDecisionProposal | null | undefined,
): ModelProposalVerification {
  try {
    candidateIds(point.candidates)
  } catch (error) {
    return {
      status: 'rejected',
      code:
        error instanceof Error ? error.message : 'INVALID_MODEL_CANDIDATE_SET',
      message: 'The deterministic candidate set is invalid.',
    }
  }
  const forbidden = forbiddenKey(proposal)
  if (forbidden) {
    const normalizedField = normalizedFieldKey(forbidden.key)
    return {
      status: 'rejected',
      code:
        normalizedField === 'bytes' || normalizedField === 'assetbytes'
          ? 'MODEL_AUTHORED_ASSET_BYTES'
          : ['bounds', 'assetbounds', 'x', 'y', 'width', 'height'].includes(
                normalizedField,
              )
            ? 'MODEL_AUTHORED_ASSET_BOUNDS'
            : 'MODEL_AUTHORED_TEXT',
      message: `Model output contains forbidden authored field ${forbidden.path}.`,
    }
  }
  if (typeof proposal === 'string') return candidateChoice(point, proposal)
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal))
    return {
      status: 'rejected',
      code: 'INVALID_MODEL_PROPOSAL',
      message: 'Model output must identify a deterministic candidate.',
    }
  const allowed = new Set([
    'candidateId',
    'choice',
    'associationId',
    'association',
    'order',
  ])
  const proposalKeys = ownDataKeys(proposal)
  const unknown = proposalKeys?.find((key) => !allowed.has(key))
  if (!proposalKeys)
    return {
      status: 'rejected',
      code: 'MODEL_PROPOSAL_UNKNOWN_FIELD',
      message: 'Model output must contain only enumerable data fields.',
    }
  if (unknown)
    return {
      status: 'rejected',
      code: 'MODEL_PROPOSAL_UNKNOWN_FIELD',
      message: `Model output field ${unknown} is not part of the candidate reference contract.`,
    }
  if (proposal.choice !== undefined && typeof proposal.choice !== 'string') {
    if (
      !proposal.choice ||
      typeof proposal.choice !== 'object' ||
      Array.isArray(proposal.choice) ||
      ownDataKeys(proposal.choice)?.some((key) => key !== 'candidateId') !==
        false
    )
      return {
        status: 'rejected',
        code: 'MODEL_PROPOSAL_UNKNOWN_FIELD',
        message: 'A nested model choice may contain only candidateId.',
      }
    if (typeof proposal.choice.candidateId !== 'string')
      return {
        status: 'rejected',
        code: 'INVALID_MODEL_PROPOSAL',
        message: 'A nested model choice must identify a candidate id.',
      }
  }
  if (
    proposal.association !== undefined &&
    typeof proposal.association !== 'string'
  ) {
    if (
      !proposal.association ||
      typeof proposal.association !== 'object' ||
      Array.isArray(proposal.association) ||
      ownDataKeys(proposal.association)?.some((key) => key !== 'id') !== false
    )
      return {
        status: 'rejected',
        code: 'MODEL_PROPOSAL_UNKNOWN_FIELD',
        message: 'A nested model association may contain only id.',
      }
    if (typeof proposal.association.id !== 'string')
      return {
        status: 'rejected',
        code: 'INVALID_MODEL_PROPOSAL',
        message: 'A nested model association must identify an association id.',
      }
  }
  if (
    proposal.candidateId !== undefined &&
    typeof proposal.candidateId !== 'string'
  )
    return {
      status: 'rejected',
      code: 'INVALID_MODEL_PROPOSAL',
      message: 'Model output must identify a candidate id.',
    }
  let candidateId = proposal.candidateId
  const nestedCandidateId =
    typeof proposal.choice === 'string'
      ? proposal.choice
      : proposal.choice?.candidateId
  if (candidateId === undefined) candidateId = nestedCandidateId
  if (
    proposal.candidateId !== undefined &&
    nestedCandidateId !== undefined &&
    proposal.candidateId !== nestedCandidateId
  )
    return {
      status: 'rejected',
      code: 'CONFLICTING_MODEL_CHOICE',
      message: 'Model output contains two different candidate ids.',
    }
  if (!candidateId)
    return {
      status: 'rejected',
      code: 'INVALID_MODEL_PROPOSAL',
      message: 'Model output must identify a candidate id.',
    }
  const nestedAssociationId =
    typeof proposal.association === 'string'
      ? proposal.association
      : proposal.association?.id
  if (
    proposal.associationId !== undefined &&
    nestedAssociationId !== undefined &&
    proposal.associationId !== nestedAssociationId
  )
    return {
      status: 'rejected',
      code: 'CONFLICTING_MODEL_ASSOCIATION',
      message: 'Model output contains two different association ids.',
    }
  const associationId = proposal.associationId ?? nestedAssociationId
  if (associationId !== undefined && typeof associationId !== 'string')
    return {
      status: 'rejected',
      code: 'INVALID_MODEL_PROPOSAL',
      message: 'A candidate association must be a deterministic id.',
    }
  if (proposal.order !== undefined && !Number.isFinite(proposal.order))
    return {
      status: 'rejected',
      code: 'INVALID_MODEL_PROPOSAL',
      message: 'A candidate order must be finite.',
    }
  return candidateChoice(point, {
    candidateId,
    ...(associationId === undefined ? {} : { associationId }),
    ...(proposal.order === undefined ? {} : { order: proposal.order }),
  })
}

function modelRequest(
  point: ModelFallbackDecisionPoint,
  promptTemplateSha256: string,
): ModelDecisionRequest {
  const sourceSha256 = normalizedSourceHash(point)
  const evidence = normalizeConsultationEvidence(point)
  if (!evidence) throw new Error('UNSAFE_MODEL_DECISION_EVIDENCE')
  const inputs = clone(evidence.inputs)
  const candidates = evidence.candidates.map((candidate) => clone(candidate))
  const request = {
    schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
    documentId: point.documentId,
    decisionId: point.decisionId,
    decisionClass: point.decisionClass,
    sourceSha256,
    inputs,
    candidates,
    promptTemplateSha256,
  }
  return {
    ...request,
    promptHash: modelPromptHash(request),
  }
}

function decisionPointFromRequest(
  request: ModelDecisionRequest,
): ModelFallbackDecisionPoint {
  return {
    documentId: request.documentId,
    decisionId: request.decisionId,
    decisionClass: request.decisionClass,
    sourceSha256: request.sourceSha256,
    inputs: request.inputs,
    candidates: request.candidates,
    insufficientEvidence: true,
  }
}

function metric(
  events: readonly ModelDecisionMetricEvent[],
): ModelConsultationMetrics {
  const metricsByDecisionClass = new Map<string, ModelConsultationMetric>()
  for (const event of events) {
    const current = metricsByDecisionClass.get(event.decisionClass) ?? {
      decisionCount: 0,
      consultationCount: 0,
      consultationRate: 0,
    }
    current.decisionCount += 1
    if (event.consulted) current.consultationCount += 1
    current.consultationRate =
      current.decisionCount === 0
        ? 0
        : current.consultationCount / current.decisionCount
    metricsByDecisionClass.set(event.decisionClass, current)
  }
  const byDecisionClass = Object.fromEntries(metricsByDecisionClass)
  const totalDecisionCount = events.length
  const totalConsultationCount = Object.values(byDecisionClass).reduce(
    (sum, value) => sum + value.consultationCount,
    0,
  )
  return {
    totalDecisionCount,
    totalConsultationCount,
    consultationRate:
      totalDecisionCount === 0
        ? 0
        : totalConsultationCount / totalDecisionCount,
    byDecisionClass,
  }
}

/** Distillation state is intentionally separate from model provenance. */
export class DistillationLedger {
  private readonly fixtures = new Map<string, InternalFixture>()
  private readonly pendingConsultations = new Map<string, number>()
  private readonly rules = new Map<
    string,
    { id: string; rule: ModelFallbackDeterministicRule }
  >()

  private publicFixture(fixture: InternalFixture): ModelFallbackFixture {
    const { point: _point, ...publicFixture } = fixture
    return clone(publicFixture)
  }

  private reopenClass(decisionClass: string, diagnosticCode: string) {
    this.rules.delete(decisionClass)
    for (const fixture of this.fixtures.values()) {
      if (fixture.decisionClass !== decisionClass) continue
      fixture.resolution = 'model-consulted'
      delete fixture.deterministicRuleId
      fixture.rejectionPath = {
        status: 'review-required',
        diagnosticCode,
      }
    }
  }

  registerFixture(point: ModelFallbackDecisionPoint): ModelFallbackFixture {
    const fixturePoint = normalizedFixturePoint(point)
    const sourceSha256 = fixturePoint.sourceSha256!
    const id = `fixture-${hash(fixturePoint).slice(0, 24)}`
    const existing = this.fixtures.get(id)
    if (existing) return this.publicFixture(existing)
    const fixture: InternalFixture = {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      id,
      documentId: fixturePoint.documentId,
      decisionId: fixturePoint.decisionId,
      decisionClass: fixturePoint.decisionClass,
      sourceSha256,
      ambiguity: {
        reason: 'deterministic evidence left multiple candidates open',
        inputs: clone(fixturePoint.inputs),
        candidateIds: fixturePoint.candidates.map(
          ({ id: candidateId }) => candidateId,
        ),
      },
      candidates: fixturePoint.candidates.map((candidate) => clone(candidate)),
      modelPath: { status: 'model-consulted', choice: null },
      rejectionPath: {
        status: 'review-required',
        diagnosticCode: 'MODEL_ASSISTANCE_DISABLED',
      },
      resolution: 'model-consulted',
      point: fixturePoint,
    }
    const installedRule = this.rules.get(fixturePoint.decisionClass)
    if (installedRule) {
      let resolved: ModelFallbackChoice | string | null = null
      let failureCode: string | null = null
      try {
        resolved = installedRule.rule(clone(fixture.point))
      } catch {
        failureCode = 'DISTILLATION_RULE_ERROR'
      }
      const result = failureCode
        ? null
        : verifyModelDecisionProposal(fixture.point, resolved)
      if (!result || result.status !== 'accepted') {
        failureCode ??= `DISTILLATION_RULE_${result?.code ?? 'ERROR'}`
        this.reopenClass(
          fixturePoint.decisionClass,
          'DISTILLATION_RULE_REOPENED',
        )
        fixture.rejectionPath = {
          status: 'review-required',
          diagnosticCode: failureCode,
        }
      } else {
        fixture.resolution = 'deterministic-decided'
        fixture.deterministicRuleId = installedRule.id
        fixture.modelPath = {
          status: 'model-consulted',
          choice: result.choice,
        }
      }
    }
    this.fixtures.set(id, fixture)
    return this.publicFixture(fixture)
  }

  recordModelPath(fixtureId: string, choice: ModelFallbackChoice | null) {
    const fixture = this.fixtures.get(fixtureId)
    if (!fixture) return
    fixture.resolution = 'model-consulted'
    delete fixture.deterministicRuleId
    fixture.modelPath = { status: 'model-consulted', choice: clone(choice) }
    fixture.rejectionPath = {
      status: 'review-required',
      diagnosticCode: choice
        ? 'MODEL_ASSISTANCE_DISABLED'
        : 'MODEL_REVIEW_REQUIRED',
    }
  }

  recordRejection(fixtureId: string, diagnosticCode: string) {
    const fixture = this.fixtures.get(fixtureId)
    if (!fixture) return
    fixture.resolution = 'model-consulted'
    delete fixture.deterministicRuleId
    fixture.rejectionPath = { status: 'review-required', diagnosticCode }
  }

  markConsultationPending(fixtureId: string) {
    if (!this.fixtures.has(fixtureId))
      throw new Error(`UNKNOWN_DISTILLATION_FIXTURE:${fixtureId}`)
    this.pendingConsultations.set(
      fixtureId,
      (this.pendingConsultations.get(fixtureId) ?? 0) + 1,
    )
  }

  markConsultationComplete(fixtureId: string) {
    const count = this.pendingConsultations.get(fixtureId) ?? 0
    if (count <= 1) this.pendingConsultations.delete(fixtureId)
    else this.pendingConsultations.set(fixtureId, count - 1)
  }

  recordUncoveredFixture(
    point: ModelFallbackDecisionPoint,
    diagnosticCode: string,
  ) {
    normalizedFixturePoint(point)
    const installedRule = this.rules.get(point.decisionClass)
    this.rules.delete(point.decisionClass)
    try {
      const fixture = this.registerFixture(point)
      this.reopenClass(point.decisionClass, 'DISTILLATION_RULE_REOPENED')
      const stored = this.fixtures.get(fixture.id)
      if (stored) {
        stored.resolution = 'model-consulted'
        delete stored.deterministicRuleId
        stored.rejectionPath = {
          status: 'review-required',
          diagnosticCode,
        }
      }
      return stored ? this.publicFixture(stored) : fixture
    } catch (error) {
      if (installedRule) this.rules.set(point.decisionClass, installedRule)
      throw error
    }
  }

  /**
   * Install and validate a deterministic rule against every generated
   * ambiguity fixture. A class cannot be called retired while one fixture is
   * still model-consulted.
   */
  retireClass(
    decisionClass: string,
    rule: ModelFallbackDeterministicRule,
    ruleId: string,
  ) {
    if (ruleId === undefined) throw new Error('DISTILLATION_RULE_ID_REQUIRED')
    if (typeof ruleId !== 'string' || !SAFE_ID.test(ruleId))
      throw new Error('INVALID_DISTILLATION_RULE_ID')
    const fixtures = [...this.fixtures.values()].filter(
      (fixture) => fixture.decisionClass === decisionClass,
    )
    if (fixtures.length === 0)
      throw new Error(`DISTILLATION_REQUIRES_FIXTURE:${decisionClass}`)
    if (
      fixtures.some(
        (fixture) => (this.pendingConsultations.get(fixture.id) ?? 0) > 0,
      )
    )
      throw new Error(`DISTILLATION_PENDING_CONSULTATION:${decisionClass}`)
    const resolutions = new Map<string, ModelFallbackChoice>()
    for (const fixture of fixtures) {
      let resolved: ModelFallbackChoice | string | null
      try {
        resolved = rule(clone(fixture.point))
      } catch {
        throw new Error(`DISTILLATION_RULE_ERROR:${fixture.id}`)
      }
      const result = verifyModelDecisionProposal(fixture.point, resolved)
      if (result.status !== 'accepted')
        throw new Error(
          `DISTILLATION_RULE_DOES_NOT_RESOLVE_FIXTURE:${fixture.id}:${result.code}`,
        )
      if (
        fixture.modelPath.choice &&
        stableJson(fixture.modelPath.choice) !== stableJson(result.choice)
      )
        throw new Error(
          `DISTILLATION_RULE_DISAGREES_WITH_MODEL_PATH:${fixture.id}`,
        )
      resolutions.set(fixture.id, result.choice)
    }
    this.rules.set(decisionClass, { id: ruleId, rule })
    for (const fixture of fixtures) {
      fixture.resolution = 'deterministic-decided'
      fixture.deterministicRuleId = ruleId
      if (!fixture.modelPath.choice)
        fixture.modelPath = {
          status: 'model-consulted',
          choice: resolutions.get(fixture.id) ?? null,
        }
    }
    return this.entry(decisionClass)
  }

  ruleFor(decisionClass: string) {
    return this.rules.get(decisionClass)?.rule
  }

  ruleIdFor(decisionClass: string) {
    return this.rules.get(decisionClass)?.id
  }

  isRetired(decisionClass: string) {
    return this.rules.has(decisionClass)
  }

  fixture(id: string) {
    const fixture = this.fixtures.get(id)
    return fixture ? this.publicFixture(fixture) : null
  }

  fixturesFor(decisionClass?: string) {
    return [...this.fixtures.values()]
      .filter((fixture) =>
        decisionClass === undefined
          ? true
          : fixture.decisionClass === decisionClass,
      )
      .map((fixture) => this.publicFixture(fixture))
  }

  consultationCount(decisionClass?: string) {
    return this.fixturesFor(decisionClass).filter(
      (fixture) => fixture.resolution === 'model-consulted',
    ).length
  }

  entry(decisionClass: string) {
    const fixtures = this.fixturesFor(decisionClass)
    const retired = this.isRetired(decisionClass)
    return {
      decisionClass,
      fixtureIds: fixtures.map(({ id }) => id).sort(),
      fixtures,
      fixtureCount: fixtures.length,
      consultationCount: fixtures.filter(
        ({ resolution }) => resolution === 'model-consulted',
      ).length,
      retired,
      deterministicRuleId: this.rules.get(decisionClass)?.id ?? null,
    }
  }

  entries() {
    return [
      ...new Set(
        [...this.fixtures.values()].map(({ decisionClass }) => decisionClass),
      ),
    ]
      .sort()
      .map((decisionClass) => this.entry(decisionClass))
  }

  toJSON() {
    return {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      entries: this.entries(),
      fixtures: this.fixturesFor(),
    }
  }
}

export class ModelFallbackLedger {
  private readonly records: ModelConsultationRecord[] = []
  private readonly recordInvocations: (symbol | undefined)[] = []
  private readonly decisions: ModelDecisionMetricEvent[] = []
  private readonly decisionInvocations: (symbol | undefined)[] = []
  private readonly documentSources = new Map<string, string>()
  private readonly stableChoices = new Map<string, ModelFallbackChoice>()
  readonly distillation: DistillationLedger

  constructor(distillation = new DistillationLedger()) {
    this.distillation = distillation
  }

  recordDecision(event: ModelDecisionMetricEvent, invocation?: symbol) {
    if (!validReceiptDecision(event))
      throw new Error('INVALID_MODEL_DECISION_METRIC')
    this.decisions.push(clone(event))
    this.decisionInvocations.push(invocation)
  }

  bindDocumentSource(documentId: string, sourceSha256: unknown) {
    if (!boundedId(documentId)) return false
    // A null/absent source hash is a legitimate state that later checks reject
    // with SOURCE_SHA256_REQUIRED, so skip binding rather than refuse here.
    if (typeof sourceSha256 !== 'string' || !HASH.test(sourceSha256))
      return true
    const existing = this.documentSources.get(documentId)
    if (existing === undefined) {
      this.documentSources.set(documentId, sourceSha256)
      return true
    }
    return existing === sourceSha256
  }

  rememberStableChoices(receipt: ModelFallbackReceipt) {
    if (
      !validateModelConsultationReceipt(receipt) ||
      receipt.consultations.some(({ status }) => status === 'pending')
    )
      throw new Error('INVALID_PRIOR_MODEL_CONSULTATION_RECEIPT')
    if (
      receipt.sourceSha256 !== null &&
      !this.bindDocumentSource(receipt.documentId, receipt.sourceSha256)
    )
      throw new Error('DOCUMENT_SOURCE_HASH_MISMATCH')
    const importedChoices: Array<[string, ModelFallbackChoice]> = []
    for (const consultation of receipt.consultations) {
      if (consultation.status !== 'accepted' || !consultation.choice) continue
      const existing =
        this.stableChoices.get(consultation.requestId) ??
        this.records.find(
          ({ requestId, status }) =>
            requestId === consultation.requestId && status === 'accepted',
        )?.choice
      if (existing && stableJson(existing) !== stableJson(consultation.choice))
        throw new Error('INVALID_PRIOR_MODEL_CONSULTATION_RECEIPT')
      const pendingImport = importedChoices.find(
        ([requestId]) => requestId === consultation.requestId,
      )?.[1]
      if (
        pendingImport &&
        stableJson(pendingImport) !== stableJson(consultation.choice)
      )
        throw new Error('INVALID_PRIOR_MODEL_CONSULTATION_RECEIPT')
      importedChoices.push([consultation.requestId, clone(consultation.choice)])
    }
    for (const [requestId, choice] of importedChoices)
      this.stableChoices.set(requestId, choice)
  }

  beginConsultation(
    request: ModelDecisionRequest,
    model: NormalizedModelIdentity,
    invocation?: symbol,
  ) {
    const checkedModel = normalizedIdentity(model)
    if (!checkedModel || stableJson(checkedModel) !== stableJson(model))
      throw new Error('INVALID_MODEL_IDENTITY')
    model = checkedModel
    const evidence = normalizeConsultationEvidence(
      decisionPointFromRequest(request),
    )
    if (!evidence) throw new Error('UNSAFE_MODEL_DECISION_EVIDENCE')
    if (
      typeof request.promptTemplateSha256 !== 'string' ||
      !HASH.test(request.promptTemplateSha256)
    )
      throw new Error('INVALID_PROMPT_TEMPLATE_SHA256')
    request = {
      ...request,
      inputs: evidence.inputs,
      candidates: evidence.candidates,
    }
    if (
      request.promptHash !==
      modelPromptHash({
        schemaVersion: request.schemaVersion,
        documentId: request.documentId,
        decisionId: request.decisionId,
        decisionClass: request.decisionClass,
        sourceSha256: request.sourceSha256,
        inputs: request.inputs,
        candidates: request.candidates,
        promptTemplateSha256: request.promptTemplateSha256,
      })
    )
      throw new Error('INVALID_MODEL_PROMPT_COMMITMENT')
    if (this.distillation.isRetired(request.decisionClass))
      throw new Error(
        `DISTILLED_CLASS_MAY_NOT_CONSULT:${request.decisionClass}`,
      )
    if (!this.bindDocumentSource(request.documentId, request.sourceSha256))
      throw new Error('DOCUMENT_SOURCE_HASH_MISMATCH')
    const fixture = this.distillation.registerFixture({
      documentId: request.documentId,
      decisionId: request.decisionId,
      decisionClass: request.decisionClass,
      sourceSha256: request.sourceSha256,
      inputs: request.inputs,
      candidates: request.candidates,
      insufficientEvidence: true,
      status: 'insufficient-evidence',
    })
    const record: ModelConsultationRecord = {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      requestId: requestId(request, model),
      fixtureId: fixture.id,
      documentId: request.documentId,
      decisionId: request.decisionId,
      decisionClass: request.decisionClass,
      sourceSha256: request.sourceSha256,
      inputs: clone(request.inputs),
      inputsHash: hash(request.inputs),
      candidates: request.candidates.map((candidate) => clone(candidate)),
      candidateIds: request.candidates.map(({ id }) => id),
      model: clone(model),
      promptTemplateSha256: request.promptTemplateSha256,
      promptHash: request.promptHash,
      status: 'pending',
      choice: null,
      costUsd: 0,
      latencyMs: null,
    }
    this.distillation.markConsultationPending(fixture.id)
    this.records.push(record)
    this.recordInvocations.push(invocation)
    return record.requestId
  }

  completeConsultation(
    requestIdValue: string,
    patch: Pick<
      ModelConsultationRecord,
      'status' | 'choice' | 'costUsd' | 'latencyMs'
    > & { failureCode?: string },
    invocation?: symbol,
  ) {
    const index = this.records.findIndex(
      ({ requestId: candidate, status }, candidateIndex) =>
        candidate === requestIdValue &&
        status === 'pending' &&
        (invocation === undefined ||
          this.recordInvocations[candidateIndex] === invocation),
    )
    if (index < 0) throw new Error('UNKNOWN_MODEL_CONSULTATION_REQUEST')
    const completed = {
      ...this.records[index]!,
      status: patch.status,
      choice: clone(patch.choice),
      costUsd: patch.costUsd,
      latencyMs: patch.latencyMs,
      ...(patch.failureCode ? { failureCode: patch.failureCode } : {}),
    }
    if (patch.status === 'pending' || !validReceiptConsultation(completed))
      throw new Error('INVALID_MODEL_CONSULTATION_COMPLETION')
    this.records[index] = completed
    const record = completed
    const fixture = this.distillation.fixture(record.fixtureId)
    if (fixture) {
      if (patch.status === 'accepted')
        this.distillation.recordModelPath(fixture.id, patch.choice)
      else
        this.distillation.recordRejection(
          fixture.id,
          patch.failureCode ?? 'MODEL_REVIEW_REQUIRED',
        )
    }
    this.distillation.markConsultationComplete(record.fixtureId)
    return clone(record)
  }

  recordsFor(query: { documentId?: string; decisionClass?: string } = {}) {
    return this.records
      .filter(
        (record) =>
          (query.documentId === undefined ||
            record.documentId === query.documentId) &&
          (query.decisionClass === undefined ||
            record.decisionClass === query.decisionClass),
      )
      .map((record) => clone(record))
  }

  decisionsFor(query: { documentId?: string; decisionClass?: string } = {}) {
    return this.decisions
      .filter(
        (event) =>
          (query.documentId === undefined ||
            event.documentId === query.documentId) &&
          (query.decisionClass === undefined ||
            event.decisionClass === query.decisionClass),
      )
      .map((event) => clone(event))
  }

  findStableChoice(
    request: ModelDecisionRequest,
    model: NormalizedModelIdentity,
  ) {
    const id = requestId(request, model)
    const remembered = this.stableChoices.get(id)
    if (remembered) return clone(remembered)
    const prior = this.records.find(
      (record) => record.requestId === id && record.status === 'accepted',
    )
    return prior?.choice ? clone(prior.choice) : null
  }

  private static persistable(record: ModelConsultationRecord) {
    return clone(record)
  }

  receiptFor(documentId: string): ModelFallbackReceipt {
    if (!boundedId(documentId)) throw new Error('INVALID_MODEL_DOCUMENT_ID')
    const consultations = this.recordsFor({ documentId }).map((record) =>
      ModelFallbackLedger.persistable(record),
    )
    const decisions = this.decisionsFor({ documentId })
    const sourceSha256 =
      consultations[0]?.sourceSha256 ??
      this.documentSources.get(documentId) ??
      null
    return {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      documentId,
      sourceSha256,
      consultations,
      decisions,
      metrics: metric(decisions),
    }
  }

  receiptForInvocation(
    documentId: string,
    invocation: symbol,
  ): ModelFallbackReceipt {
    if (!boundedId(documentId)) throw new Error('INVALID_MODEL_DOCUMENT_ID')
    const consultations = this.records.flatMap((record, index) =>
      record.documentId === documentId &&
      this.recordInvocations[index] === invocation
        ? [ModelFallbackLedger.persistable(clone(record))]
        : [],
    )
    const decisions = this.decisions.flatMap((decision, index) =>
      decision.documentId === documentId &&
      this.decisionInvocations[index] === invocation
        ? [clone(decision)]
        : [],
    )
    return {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      documentId,
      sourceSha256:
        consultations[0]?.sourceSha256 ??
        this.documentSources.get(documentId) ??
        null,
      consultations,
      decisions,
      metrics: metric(decisions),
    }
  }

  metrics(documentId?: string) {
    return metric(this.decisionsFor(documentId ? { documentId } : {}))
  }

  consultationCount(decisionClass?: string, documentId?: string) {
    return this.recordsFor({ documentId, decisionClass }).length
  }

  retireDecisionClass(
    decisionClass: string,
    rule: ModelFallbackDeterministicRule,
    ruleId: string,
  ) {
    return this.distillation.retireClass(decisionClass, rule, ruleId)
  }

  query(query: { documentId?: string; decisionClass?: string } = {}) {
    return this.recordsFor(query)
  }

  toJSON() {
    return {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      consultations: this.records.map((record) => clone(record)),
      decisions: this.decisions.map((event) => clone(event)),
      distillation: this.distillation.toJSON(),
    }
  }
}

export type ModelConsultationGateOptions = {
  /** Both flags must be true for explicit owner opt-in on this run. */
  enabled?: boolean
  ownerOptIn?: boolean
  model?: ModelConsultationClient
  modelIdentity?: ModelIdentity
  ledger?: ModelFallbackLedger
  distillation?: DistillationLedger
  priorReceipt?: ModelFallbackReceipt
  /** Digest of the exact prompt or structured adapter protocol in use. */
  promptTemplateSha256?: string
  signal?: AbortSignal
  onRequest?: (request: ModelDecisionRequest) => void
}

function throwIfConsultationAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function raceConsultationWithAbort<T>(
  operation: PromiseLike<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(operation)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: (value: T | unknown) => void, value: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () =>
      finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    Promise.resolve(operation).then(
      (value) => finish(resolve as (value: T | unknown) => void, value),
      (error) => finish(reject, error),
    )
  })
}

export class ModelConsultationGate {
  readonly enabled: boolean
  readonly ledger: ModelFallbackLedger
  private readonly model: ModelConsultationClient | undefined
  private readonly identity: NormalizedModelIdentity | undefined
  private readonly promptTemplateSha256: string
  private readonly signal: AbortSignal | undefined
  private readonly onRequest:
    ((request: ModelDecisionRequest) => void) | undefined

  constructor(options: ModelConsultationGateOptions = {}) {
    this.enabled = options.enabled === true && options.ownerOptIn === true
    this.ledger =
      options.ledger ??
      new ModelFallbackLedger(options.distillation ?? new DistillationLedger())
    if (options.priorReceipt)
      this.ledger.rememberStableChoices(options.priorReceipt)
    this.model = options.model
    const clientIdentity = options.model?.identity
      ? normalizedIdentity(options.model.identity)
      : undefined
    const pinnedIdentity = options.modelIdentity
      ? normalizedIdentity(options.modelIdentity)
      : undefined
    if (
      options.model?.identity !== undefined &&
      options.modelIdentity !== undefined &&
      (!clientIdentity ||
        !pinnedIdentity ||
        stableJson(clientIdentity) !== stableJson(pinnedIdentity))
    ) {
      throw new Error('CONFLICTING_MODEL_IDENTITY')
    }
    this.identity = clientIdentity ?? pinnedIdentity
    this.promptTemplateSha256 =
      options.promptTemplateSha256 ?? MODEL_FALLBACK_PROMPT_TEMPLATE_SHA256
    if (!HASH.test(this.promptTemplateSha256))
      throw new Error('INVALID_PROMPT_TEMPLATE_SHA256')
    this.signal = options.signal
    this.onRequest = options.onRequest
  }

  private deterministicOutcome(
    point: ModelFallbackDecisionPoint,
    choice: ModelFallbackChoice,
    deterministicRuleId: string,
    invocation?: symbol,
  ): ModelDecisionOutcome {
    this.ledger.recordDecision(
      {
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        outcome: 'deterministic',
        consulted: false,
        choice: { candidateId: choice.candidateId },
        deterministicRuleId,
      },
      invocation,
    )
    return {
      status: 'deterministic',
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      choice,
      provenance: null,
    }
  }

  private reviewOutcome(
    point: ModelFallbackDecisionPoint,
    diagnostic: string,
    record = true,
    invocation?: symbol,
  ) {
    if (record)
      this.ledger.recordDecision(
        {
          documentId: point.documentId,
          decisionId: point.decisionId,
          decisionClass: point.decisionClass,
          outcome: 'review-required',
          consulted: false,
        },
        invocation,
      )
    return {
      status: 'review-required' as const,
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      choice: null,
      provenance: null,
      diagnostic,
    }
  }

  private closeAbortedConsultation(
    requestIdValue: string,
    point: ModelFallbackDecisionPoint,
    invocation: symbol | undefined,
    error: unknown,
  ): never {
    this.ledger.completeConsultation(
      requestIdValue,
      {
        status: 'failed',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'MODEL_CONSULTATION_ABORTED',
      },
      invocation,
    )
    this.ledger.recordDecision(
      {
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        outcome: 'consulted',
        consulted: true,
      },
      invocation,
    )
    throw error
  }

  async decide(
    point: ModelFallbackDecisionPoint,
    invocation?: symbol,
  ): Promise<ModelDecisionOutcome> {
    throwIfConsultationAborted(this.signal)
    const sourceHash = sourceHashSnapshot(point)
    if (sourceHash.status === 'rejected')
      return this.reviewOutcome(
        point,
        'INVALID_SOURCE_SHA256',
        false,
        invocation,
      )
    const sourceSha256 = sourceHash.value
    if (
      !boundedId(point.documentId) ||
      !boundedId(point.decisionId) ||
      !boundedId(point.decisionClass)
    )
      return this.reviewOutcome(
        point,
        'INVALID_MODEL_DECISION_POINT',
        false,
        invocation,
      )
    if (!this.ledger.bindDocumentSource(point.documentId, sourceSha256))
      return this.reviewOutcome(
        point,
        'DOCUMENT_SOURCE_HASH_MISMATCH',
        false,
        invocation,
      )
    try {
      candidateIds(point.candidates)
    } catch (error) {
      return this.reviewOutcome(
        point,
        error instanceof Error ? error.message : 'INVALID_MODEL_CANDIDATE_SET',
        true,
        invocation,
      )
    }
    if (!isOpenDecision(point)) {
      const checked = candidateChoice(point, point.deterministicChoice)
      return checked.status === 'accepted'
        ? this.deterministicOutcome(
            point,
            checked.choice,
            EMBEDDED_DETERMINISTIC_RULE_ID,
            invocation,
          )
        : this.reviewOutcome(point, checked.code, true, invocation)
    }

    const distilled = this.ledger.distillation.ruleFor(point.decisionClass)
    if (distilled) {
      if (!receiptRecord(point.inputs) || !isCanonicalJsonValue(point.inputs))
        return this.reviewOutcome(
          point,
          'INVALID_MODEL_DECISION_INPUTS',
          true,
          invocation,
        )
      if (!validConsultationCandidates(point.candidates))
        return this.reviewOutcome(
          point,
          'INVALID_MODEL_CANDIDATE_SET',
          true,
          invocation,
        )
      if (
        forbiddenEvidenceField(point.inputs) !== null ||
        forbiddenEvidenceField(point.candidates) !== null
      )
        return this.reviewOutcome(
          point,
          'UNSAFE_MODEL_DECISION_EVIDENCE',
          true,
          invocation,
        )
      const evidence = normalizeConsultationEvidence(point)
      if (!evidence)
        return this.reviewOutcome(
          point,
          'UNSAFE_MODEL_DECISION_EVIDENCE',
          true,
          invocation,
        )
      const distilledPoint = clone({
        ...point,
        inputs: evidence.inputs,
        candidates: evidence.candidates,
      })
      let distilledChoice: ModelFallbackChoice | string | null
      try {
        distilledChoice = distilled(clone(distilledPoint))
      } catch {
        try {
          this.ledger.distillation.recordUncoveredFixture(
            distilledPoint,
            'DISTILLATION_RULE_ERROR',
          )
        } catch {
          // The decision still fails closed if its fixture cannot be recorded.
        }
        return this.reviewOutcome(
          point,
          'DISTILLATION_RULE_ERROR',
          true,
          invocation,
        )
      }
      const checked = candidateChoice(distilledPoint, distilledChoice)
      if (checked.status === 'accepted')
        return this.deterministicOutcome(
          point,
          checked.choice,
          this.ledger.distillation.ruleIdFor(point.decisionClass)!,
          invocation,
        )
      const diagnostic = `DISTILLED_RULE_${checked.code}`
      try {
        this.ledger.distillation.recordUncoveredFixture(
          distilledPoint,
          diagnostic,
        )
      } catch {
        // The decision still fails closed if its fixture cannot be recorded.
      }
      return this.reviewOutcome(point, diagnostic, true, invocation)
    }

    if (!this.enabled)
      return this.reviewOutcome(
        point,
        'MODEL_ASSISTANCE_DISABLED',
        true,
        invocation,
      )
    if (!this.model)
      return this.reviewOutcome(
        point,
        'MODEL_PROVIDER_UNAVAILABLE',
        true,
        invocation,
      )
    if (!this.identity)
      return this.reviewOutcome(
        point,
        'MODEL_IDENTITY_REQUIRED',
        true,
        invocation,
      )
    if (!receiptRecord(point.inputs) || !isCanonicalJsonValue(point.inputs))
      return this.reviewOutcome(
        point,
        'INVALID_MODEL_DECISION_INPUTS',
        true,
        invocation,
      )
    if (!validConsultationCandidates(point.candidates))
      return this.reviewOutcome(
        point,
        'INVALID_MODEL_CANDIDATE_SET',
        true,
        invocation,
      )
    if (
      forbiddenEvidenceField(point.inputs) !== null ||
      forbiddenEvidenceField(point.candidates) !== null
    )
      return this.reviewOutcome(
        point,
        'UNSAFE_MODEL_DECISION_EVIDENCE',
        true,
        invocation,
      )
    const evidence = normalizeConsultationEvidence(point)
    if (!evidence)
      return this.reviewOutcome(
        point,
        'UNSAFE_MODEL_DECISION_EVIDENCE',
        true,
        invocation,
      )
    const consultationPoint = {
      ...point,
      sourceSha256,
      inputs: evidence.inputs,
      candidates: evidence.candidates,
    }
    try {
      normalizedSourceHash(consultationPoint)
    } catch (error) {
      return this.reviewOutcome(
        point,
        error instanceof Error ? error.message : 'INVALID_SOURCE_SHA256',
        true,
        invocation,
      )
    }
    const request = modelRequest(consultationPoint, this.promptTemplateSha256)
    const requestPoint = decisionPointFromRequest(request)
    let requestIdValue: string
    try {
      requestIdValue = this.ledger.beginConsultation(
        request,
        this.identity,
        invocation,
      )
    } catch (error) {
      return this.reviewOutcome(
        point,
        error instanceof Error
          ? error.message
          : 'MODEL_CONSULTATION_RECORD_ERROR',
        true,
        invocation,
      )
    }
    let consult: ModelConsultationClient['consult']
    try {
      // The callback and pending receipt entry happen before the provider call.
      this.onRequest?.(clone(request))
      consult = this.model.consult ?? this.model.propose ?? this.model.choose
      throwIfConsultationAborted(this.signal)
    } catch (error) {
      if (this.signal?.aborted)
        this.closeAbortedConsultation(
          requestIdValue,
          requestPoint,
          invocation,
          error,
        )
      const provenance = this.ledger.completeConsultation(
        requestIdValue,
        {
          status: 'failed',
          choice: null,
          costUsd: 0,
          latencyMs: null,
          failureCode: 'MODEL_PROVIDER_ERROR',
        },
        invocation,
      )
      this.ledger.recordDecision(
        {
          documentId: requestPoint.documentId,
          decisionId: requestPoint.decisionId,
          decisionClass: requestPoint.decisionClass,
          outcome: 'consulted',
          consulted: true,
        },
        invocation,
      )
      return {
        status: 'review-required',
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'MODEL_PROVIDER_ERROR',
      }
    }
    if (!consult) {
      const provenance = this.ledger.completeConsultation(
        requestIdValue,
        {
          status: 'failed',
          choice: null,
          costUsd: 0,
          latencyMs: null,
          failureCode: 'MODEL_PROVIDER_UNAVAILABLE',
        },
        invocation,
      )
      this.ledger.recordDecision(
        {
          documentId: requestPoint.documentId,
          decisionId: requestPoint.decisionId,
          decisionClass: requestPoint.decisionClass,
          outcome: 'consulted',
          consulted: true,
        },
        invocation,
      )
      return {
        status: 'review-required',
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'MODEL_PROVIDER_UNAVAILABLE',
      }
    }
    let processed: ReturnType<typeof proposalAndMetrics>
    let verified: ModelProposalVerification
    try {
      const response = await raceConsultationWithAbort(
        consult.call(this.model, clone(request), { signal: this.signal }),
        this.signal,
      )
      throwIfConsultationAborted(this.signal)
      processed = proposalAndMetrics(response)
      verified =
        processed.rejection ??
        verifyModelDecisionProposal(requestPoint, processed.proposal)
    } catch (error) {
      if (this.signal?.aborted)
        this.closeAbortedConsultation(
          requestIdValue,
          requestPoint,
          invocation,
          error,
        )
      const provenance = this.ledger.completeConsultation(
        requestIdValue,
        {
          status: 'failed',
          choice: null,
          costUsd: 0,
          latencyMs: null,
          failureCode: 'MODEL_PROVIDER_ERROR',
        },
        invocation,
      )
      this.ledger.recordDecision(
        {
          documentId: requestPoint.documentId,
          decisionId: requestPoint.decisionId,
          decisionClass: requestPoint.decisionClass,
          outcome: 'consulted',
          consulted: true,
        },
        invocation,
      )
      return {
        status: 'review-required',
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'MODEL_PROVIDER_ERROR',
      }
    }
    const { costUsd, latencyMs } = processed
    if (
      !finiteNonNegative(costUsd) ||
      (latencyMs !== null && !finiteNonNegative(latencyMs))
    ) {
      const provenance = this.ledger.completeConsultation(
        requestIdValue,
        {
          status: 'rejected',
          choice: null,
          costUsd: 0,
          latencyMs: null,
          failureCode: 'INVALID_MODEL_COST',
        },
        invocation,
      )
      this.ledger.recordDecision(
        {
          documentId: requestPoint.documentId,
          decisionId: requestPoint.decisionId,
          decisionClass: requestPoint.decisionClass,
          outcome: 'consulted',
          consulted: true,
        },
        invocation,
      )
      return {
        status: 'review-required',
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'INVALID_MODEL_COST',
      }
    }
    if (verified.status !== 'accepted') {
      const provenance = this.ledger.completeConsultation(
        requestIdValue,
        {
          status: 'rejected',
          choice: null,
          costUsd,
          latencyMs,
          failureCode: verified.code,
        },
        invocation,
      )
      this.ledger.recordDecision(
        {
          documentId: requestPoint.documentId,
          decisionId: requestPoint.decisionId,
          decisionClass: requestPoint.decisionClass,
          outcome: 'consulted',
          consulted: true,
        },
        invocation,
      )
      return {
        status: 'review-required',
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        choice: null,
        provenance,
        diagnostic: verified.code,
      }
    }
    const stableChoice = this.ledger.findStableChoice(request, this.identity)
    if (
      stableChoice &&
      stableJson(stableChoice) !== stableJson(verified.choice)
    ) {
      const provenance = this.ledger.completeConsultation(
        requestIdValue,
        {
          status: 'rejected',
          choice: null,
          costUsd,
          latencyMs,
          failureCode: 'BYTE_STABILITY_MISMATCH',
        },
        invocation,
      )
      this.ledger.recordDecision(
        {
          documentId: requestPoint.documentId,
          decisionId: requestPoint.decisionId,
          decisionClass: requestPoint.decisionClass,
          outcome: 'consulted',
          consulted: true,
        },
        invocation,
      )
      return {
        status: 'review-required',
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'BYTE_STABILITY_MISMATCH',
      }
    }
    const provenance = this.ledger.completeConsultation(
      requestIdValue,
      {
        status: 'accepted',
        choice: verified.choice,
        costUsd,
        latencyMs,
      },
      invocation,
    )
    this.ledger.recordDecision(
      {
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        outcome: 'consulted',
        consulted: true,
      },
      invocation,
    )
    return {
      status: 'consulted',
      documentId: requestPoint.documentId,
      decisionId: requestPoint.decisionId,
      decisionClass: requestPoint.decisionClass,
      choice: verified.choice,
      provenance,
    }
  }

  resolve(point: ModelFallbackDecisionPoint) {
    return this.decide(point)
  }

  consult(point: ModelFallbackDecisionPoint) {
    return this.decide(point)
  }

  evaluate(point: ModelFallbackDecisionPoint) {
    return this.decide(point)
  }
}

export function createModelConsultationGate(
  options: ModelConsultationGateOptions = {},
) {
  return new ModelConsultationGate(options)
}

export function consultModelDecision(
  point: ModelFallbackDecisionPoint,
  options: ModelConsultationGateOptions = {},
) {
  return createModelConsultationGate(options).decide(point)
}

export const consultModelFallback = consultModelDecision
export const resolveModelDecision = consultModelDecision
export const verifyCandidateConstrainedProposal = verifyModelDecisionProposal
export const createConsultationGate = createModelConsultationGate
export const createModelFallbackGate = createModelConsultationGate
export const createDistillationLedger = (distillation?: DistillationLedger) =>
  distillation ?? new DistillationLedger()

export function createModelConsultationReceipt(
  ledger: ModelFallbackLedger,
  documentId: string,
) {
  return ledger.receiptFor(documentId)
}

export function queryModelConsultations(
  ledger: ModelFallbackLedger,
  query: { documentId?: string; decisionClass?: string } = {},
) {
  return ledger.query(query)
}

export function buildModelConsultationMetrics(
  ledger: ModelFallbackLedger,
  documentId?: string,
) {
  return ledger.metrics(documentId)
}

export const reportModelConsultationRate = buildModelConsultationMetrics
export const getModelConsultationRate = buildModelConsultationMetrics
export const modelConsultationRate = buildModelConsultationMetrics

export function serializeModelConsultationReceipt(
  receipt: ModelFallbackReceipt,
) {
  if (!validateModelConsultationReceipt(receipt))
    throw new Error('INVALID_MODEL_CONSULTATION_RECEIPT')
  return `${stableJson(receipt)}\n`
}

/** A tiny reference corpus for the three named ambiguity classes. */
export const MODEL_FALLBACK_REFERENCE_FIXTURES: readonly ModelFallbackDecisionPoint[] =
  Object.freeze([
    {
      documentId: 'fixture-caption',
      decisionId: 'caption-1',
      decisionClass: MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
      sourceSha256: '1'.repeat(64),
      inputs: { figureId: 'figure-1', captionRegion: 'caption-1' },
      candidates: [
        { id: 'caption-figure-1', associationId: 'figure-1' },
        { id: 'caption-figure-2', associationId: 'figure-2' },
      ],
      insufficientEvidence: true,
      reason: 'caption geometry leaves two bounded figures equally plausible',
    },
    {
      documentId: 'fixture-note',
      decisionId: 'note-1',
      decisionClass: MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
      sourceSha256: '2'.repeat(64),
      inputs: { markerId: 'marker-1', markerOrdinal: '1' },
      candidates: [
        { id: 'note-body-1', targetId: 'note-1' },
        { id: 'note-body-2', targetId: 'note-2' },
      ],
      insufficientEvidence: true,
      reason: 'numbering and geometry leave two note bodies open',
    },
    {
      documentId: 'fixture-order',
      decisionId: 'order-1',
      decisionClass: MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
      sourceSha256: '3'.repeat(64),
      inputs: { regionIds: ['region-a', 'region-b'] },
      candidates: [
        { id: 'order-a-b', order: 0 },
        { id: 'order-b-a', order: 1 },
      ],
      insufficientEvidence: true,
      reason: 'the two column edges have equal deterministic score',
    },
  ])

export const MODEL_FALLBACK_REFERENCE_RULE_ID =
  'caption-association-by-figure-id-v1' as const

/**
 * Reference distillation: when exactly one caption candidate carries the
 * deterministically proven figure id, no model consultation is needed.
 */
export const resolveCaptionAssociationByFigureId: ModelFallbackDeterministicRule =
  (point) => {
    if (
      point.decisionClass !==
        MODEL_FALLBACK_DECISION_CLASSES.captionAssociation ||
      typeof point.inputs.figureId !== 'string'
    )
      return null
    const matching = point.candidates.filter((candidate) => {
      const association = candidateAssociation(candidate)
      return association.valid && association.id === point.inputs.figureId
    })
    return matching.length === 1 ? matching[0]!.id : null
  }

export function createReferenceDistillationLedger() {
  const ledger = new DistillationLedger()
  for (const fixture of MODEL_FALLBACK_REFERENCE_FIXTURES)
    ledger.registerFixture(fixture)
  ledger.retireClass(
    MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
    resolveCaptionAssociationByFigureId,
    MODEL_FALLBACK_REFERENCE_RULE_ID,
  )
  return ledger
}

export function attachModelConsultationReceipt<T extends object>(
  receipt: T,
  ledger: ModelFallbackLedger,
  documentId: string,
) {
  const modelConsultations = createModelConsultationReceipt(ledger, documentId)
  if (!validateModelConsultationReceipt(modelConsultations))
    throw new Error('INVALID_MODEL_CONSULTATION_RECEIPT')
  return {
    ...receipt,
    modelConsultations,
  }
}

// Vocabulary aliases used by callers that call this layer a resolver rather
// than a fallback. Keeping them here avoids adapters growing their own gates.
export {
  ModelFallbackLedger as ModelConsultationLedger,
  ModelConsultationGate as ConsultationGate,
  DistillationLedger as ModelDistillationLedger,
}

export type DeterministicDecisionPoint = ModelFallbackDecisionPoint
export type DeterministicCandidate = ModelFallbackCandidate
export type ConsultationProvenance = ModelConsultationRecord
export type DistillationFixture = ModelFallbackFixture
