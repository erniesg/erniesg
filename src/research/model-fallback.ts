import { sha256HexSync } from './sha256-sync.ts'

/**
 * Model assistance is deliberately a small decision service, rather than an
 * alternate extractor.  A deterministic caller supplies the complete,
 * source-backed candidate set and the model can only return a reference to one
 * of those candidates.
 */
export const MODEL_FALLBACK_SCHEMA_VERSION = '1.0.0' as const
export const MODEL_ASSISTANCE_DEFAULT_ENABLED = false as const

export const MODEL_FALLBACK_DECISION_CLASSES = Object.freeze({
  captionAssociation: 'candidate-ambiguous-caption-association',
  noteMarkerMatch: 'ambiguous-note-marker-match',
  readingOrderTie: 'reading-order-tie',
})

export type ModelFallbackDecisionClass = string

export type ModelFallbackCandidate = {
  id: string
  /** Candidate metadata is deterministic evidence, not model-authored text. */
  [key: string]: unknown
}

export type ModelFallbackChoice = {
  candidateId: string
  associationId?: string
  order?: number
  label?: string
}

export type ModelFallbackDecisionPoint = {
  documentId: string
  decisionId: string
  decisionClass: ModelFallbackDecisionClass
  /** Hash of the source document. Source bytes are never put in a receipt. */
  sourceSha256?: string
  /** Inputs are the deterministic evidence that led to the open decision. */
  inputs: Record<string, unknown>
  candidates: readonly ModelFallbackCandidate[]
  /** Set by a deterministic decision point when evidence is sufficient. */
  deterministicChoice?: ModelFallbackChoice | string | null
  /** Common spellings are accepted so adapters can wrap existing diagnostics. */
  status?:
    | 'sufficient-evidence'
    | 'insufficient-evidence'
    | 'deterministic'
    | 'ambiguous'
  evidenceStatus?: 'sufficient' | 'insufficient'
  insufficientEvidence?: boolean
  reason?: string
}

export type ModelIdentity = {
  providerId?: string
  modelId?: string
  modelVersion?: string
  modelDigest?: string
  /** Short aliases are useful for recorded/stub clients in tests. */
  provider?: string
  id?: string
  version?: string
  digest?: string
}

export type NormalizedModelIdentity = {
  providerId: string
  modelId: string
  modelVersion: string
  modelDigest: string
}

export type ModelDecisionRequest = {
  schemaVersion: typeof MODEL_FALLBACK_SCHEMA_VERSION
  documentId: string
  decisionId: string
  decisionClass: ModelFallbackDecisionClass
  sourceSha256: string
  inputs: Record<string, unknown>
  candidates: readonly ModelFallbackCandidate[]
  promptHash: string
}

export type ModelDecisionProposal =
  | string
  | {
      candidateId?: string
      choice?: string | { candidateId?: string }
      associationId?: string
      association?: string | { id?: string }
      order?: number
      label?: string
    }

export type ModelDecisionResponse =
  | ModelDecisionProposal
  | {
      proposal: ModelDecisionProposal
      costUsd?: number
      latencyMs?: number
    }

export type ModelConsultationClient = {
  identity?: ModelIdentity
  consult?: (
    request: ModelDecisionRequest,
  ) => ModelDecisionResponse | Promise<ModelDecisionResponse>
  propose?: (
    request: ModelDecisionRequest,
  ) => ModelDecisionResponse | Promise<ModelDecisionResponse>
  choose?: (
    request: ModelDecisionRequest,
  ) => ModelDecisionResponse | Promise<ModelDecisionResponse>
}

export type ModelConsultationRecordStatus =
  'pending' | 'accepted' | 'rejected' | 'failed'

export type ModelConsultationRecord = {
  schemaVersion: typeof MODEL_FALLBACK_SCHEMA_VERSION
  requestId: string
  fixtureId?: string
  documentId: string
  decisionId: string
  decisionClass: ModelFallbackDecisionClass
  sourceSha256: string
  inputs: Record<string, unknown>
  inputsHash: string
  candidates: ModelFallbackCandidate[]
  candidateIds: string[]
  model: NormalizedModelIdentity
  promptHash: string
  status: ModelConsultationRecordStatus
  choice: ModelFallbackChoice | null
  costUsd: number
  latencyMs: number | null
  failureCode?: string
}

export type ModelDecisionMetricEvent = {
  documentId: string
  decisionId: string
  decisionClass: ModelFallbackDecisionClass
  outcome: 'deterministic' | 'consulted' | 'review-required'
  consulted: boolean
}

export type ModelConsultationMetric = {
  decisionCount: number
  consultationCount: number
  consultationRate: number
}

export type ModelConsultationMetrics = {
  totalDecisionCount: number
  totalConsultationCount: number
  consultationRate: number
  byDecisionClass: Record<ModelFallbackDecisionClass, ModelConsultationMetric>
}

export type ModelFallbackReceipt = {
  schemaVersion: typeof MODEL_FALLBACK_SCHEMA_VERSION
  documentId: string
  sourceSha256: string | null
  consultations: ModelConsultationRecord[]
  decisions: ModelDecisionMetricEvent[]
  metrics: ModelConsultationMetrics
}

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

const HASH = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const FORBIDDEN_MODEL_KEYS = new Set([
  'text',
  'content',
  'sourceText',
  'generatedText',
  'altText',
  'html',
  'markdown',
  'bytes',
  'assetBytes',
  'bounds',
  'assetBounds',
  'x',
  'y',
  'width',
  'height',
])

function forbiddenModelField(key: string) {
  const normalized = key
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]/gu, '')
    .toLowerCase()
  return (
    FORBIDDEN_MODEL_KEYS.has(key) ||
    new Set([
      'text',
      'content',
      'sourcetext',
      'generatedtext',
      'alttext',
      'html',
      'markdown',
      'bytes',
      'assetbytes',
      'bounds',
      'assetbounds',
      'x',
      'y',
      'width',
      'height',
    ]).has(normalized)
  )
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
  if (typeof value === 'bigint') return JSON.stringify(String(value))
  if (value instanceof Uint8Array)
    return JSON.stringify({ sha256: sha256HexSync(value) })
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array) return new Uint8Array(value) as T
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        clone(child),
      ]),
    ) as T
  }
  return value
}

function hash(value: unknown) {
  return sha256HexSync(stableJson(value))
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function normalizedIdentity(identity: ModelIdentity | undefined) {
  const providerId = identity?.providerId ?? identity?.provider ?? 'owner-local'
  const modelId = identity?.modelId ?? identity?.id ?? 'recorded-stub'
  const modelVersion = identity?.modelVersion ?? identity?.version ?? '1'
  const suppliedDigest = identity?.modelDigest ?? identity?.digest
  const modelDigest =
    suppliedDigest ?? hash({ providerId, modelId, modelVersion })
  if (
    !SAFE_ID.test(providerId) ||
    !SAFE_ID.test(modelId) ||
    !SAFE_ID.test(modelVersion) ||
    (!HASH.test(modelDigest) && !SAFE_ID.test(modelDigest))
  ) {
    throw new Error('INVALID_MODEL_IDENTITY')
  }
  return { providerId, modelId, modelVersion, modelDigest }
}

function normalizedSourceHash(point: ModelFallbackDecisionPoint) {
  const sourceSha256 = point.sourceSha256 ?? hash(point.inputs)
  return HASH.test(sourceSha256) ? sourceSha256 : hash(sourceSha256)
}

function candidateIds(candidates: readonly ModelFallbackCandidate[]) {
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => !candidate || !SAFE_ID.test(candidate.id))
  )
    throw new Error('INVALID_MODEL_CANDIDATE_SET')
  const ids = candidates.map(({ id }) => id)
  if (new Set(ids).size !== ids.length)
    throw new Error('DUPLICATE_MODEL_CANDIDATE_ID')
  return ids
}

function isOpenDecision(point: ModelFallbackDecisionPoint) {
  if (
    point.status === 'sufficient-evidence' ||
    point.status === 'deterministic'
  )
    return false
  if (point.insufficientEvidence === true) return true
  if (point.evidenceStatus === 'insufficient') return true
  if (point.status === 'insufficient-evidence' || point.status === 'ambiguous')
    return true
  return (
    point.deterministicChoice === undefined ||
    point.deterministicChoice === null
  )
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
  const candidateId = typeof value === 'string' ? value : value.candidateId
  if (!candidateId || !ids.includes(candidateId))
    return {
      status: 'rejected',
      code: 'OUT_OF_CANDIDATE_SET',
      message:
        'The selected candidate was not produced by the deterministic layer.',
    }
  const candidate = point.candidates.find(({ id }) => id === candidateId)!
  const choice: ModelFallbackChoice = {
    candidateId,
    ...(typeof value === 'string'
      ? {}
      : {
          ...(value.associationId === undefined
            ? {}
            : { associationId: value.associationId }),
          ...(value.order === undefined ? {} : { order: value.order }),
          ...(value.label === undefined ? {} : { label: value.label }),
        }),
  }
  const candidateAssociation =
    typeof candidate.associationId === 'string'
      ? candidate.associationId
      : typeof candidate.association === 'string'
        ? candidate.association
        : candidate.association &&
            typeof candidate.association === 'object' &&
            typeof (candidate.association as { id?: unknown }).id === 'string'
          ? (candidate.association as { id: string }).id
          : undefined
  if (
    choice.associationId !== undefined &&
    choice.associationId !== candidateAssociation
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
  if (choice.label !== undefined && choice.label !== candidate.label)
    return {
      status: 'rejected',
      code: 'MODEL_AUTHORED_LABEL',
      message: 'The model cannot author a label outside the candidate.',
    }
  return { status: 'accepted', choice }
}

function forbiddenKey(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = forbiddenKey(child, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenModelField(key)) return `${path}.${key}`
    const found = forbiddenKey(child, `${path}.${key}`)
    if (found) return found
  }
  return null
}

function proposalAndMetrics(response: ModelDecisionResponse) {
  if (
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    'proposal' in response
  ) {
    const wrapper = response as {
      proposal: ModelDecisionProposal
      costUsd?: unknown
      latencyMs?: unknown
    }
    const allowed = new Set(['proposal', 'costUsd', 'latencyMs'])
    const unknown = Object.keys(response).find((key) => !allowed.has(key))
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
  if (
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    ('costUsd' in response || 'latencyMs' in response)
  ) {
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
    const field = forbidden.split('.').at(-1)
    return {
      status: 'rejected',
      code:
        field === 'bytes' || field === 'assetBytes'
          ? 'MODEL_AUTHORED_ASSET_BYTES'
          : field === 'bounds' || field === 'assetBounds'
            ? 'MODEL_AUTHORED_ASSET_BOUNDS'
            : 'MODEL_AUTHORED_TEXT',
      message: `Model output contains forbidden authored field ${field}.`,
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
    'label',
  ])
  const unknown = Object.keys(proposal).find((key) => !allowed.has(key))
  if (unknown)
    return {
      status: 'rejected',
      code: 'MODEL_PROPOSAL_UNKNOWN_FIELD',
      message: `Model output field ${unknown} is not part of the candidate reference contract.`,
    }
  if (
    proposal.choice &&
    typeof proposal.choice === 'object' &&
    Object.keys(proposal.choice).some((key) => key !== 'candidateId')
  )
    return {
      status: 'rejected',
      code: 'MODEL_PROPOSAL_UNKNOWN_FIELD',
      message: 'A nested model choice may contain only candidateId.',
    }
  let candidateId = proposal.candidateId
  if (candidateId === undefined && proposal.choice !== undefined) {
    candidateId =
      typeof proposal.choice === 'string'
        ? proposal.choice
        : proposal.choice?.candidateId
  }
  if (
    proposal.candidateId !== undefined &&
    proposal.choice !== undefined &&
    typeof proposal.choice === 'string' &&
    proposal.candidateId !== proposal.choice
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
  const associationId =
    proposal.associationId ??
    (typeof proposal.association === 'string'
      ? proposal.association
      : proposal.association?.id)
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
  if (proposal.label !== undefined && typeof proposal.label !== 'string')
    return {
      status: 'rejected',
      code: 'INVALID_MODEL_PROPOSAL',
      message: 'A candidate label must be deterministic text.',
    }
  return candidateChoice(point, {
    candidateId,
    ...(associationId === undefined ? {} : { associationId }),
    ...(proposal.order === undefined ? {} : { order: proposal.order }),
    ...(proposal.label === undefined ? {} : { label: proposal.label }),
  })
}

function modelRequest(point: ModelFallbackDecisionPoint): ModelDecisionRequest {
  const sourceSha256 = normalizedSourceHash(point)
  const inputs = clone(point.inputs)
  const candidates = point.candidates.map((candidate) => clone(candidate))
  const promptHash = hash({
    schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
    documentId: point.documentId,
    decisionId: point.decisionId,
    decisionClass: point.decisionClass,
    sourceSha256,
    inputs,
    candidates,
  })
  return {
    schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
    documentId: point.documentId,
    decisionId: point.decisionId,
    decisionClass: point.decisionClass,
    sourceSha256,
    inputs,
    candidates,
    promptHash,
  }
}

function requestId(
  request: ModelDecisionRequest,
  identity: NormalizedModelIdentity,
) {
  return hash({
    sourceSha256: request.sourceSha256,
    model: identity,
    promptHash: request.promptHash,
    decisionClass: request.decisionClass,
    decisionId: request.decisionId,
  })
}

function metric(
  events: readonly ModelDecisionMetricEvent[],
  retired: (decisionClass: string) => boolean,
): ModelConsultationMetrics {
  const byDecisionClass: Record<string, ModelConsultationMetric> = {}
  for (const event of events) {
    const current = byDecisionClass[event.decisionClass] ?? {
      decisionCount: 0,
      consultationCount: 0,
      consultationRate: 0,
    }
    current.decisionCount += 1
    if (event.consulted && !retired(event.decisionClass))
      current.consultationCount += 1
    current.consultationRate =
      current.decisionCount === 0
        ? 0
        : current.consultationCount / current.decisionCount
    byDecisionClass[event.decisionClass] = current
  }
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
  private readonly rules = new Map<
    string,
    { id: string; rule: ModelFallbackDeterministicRule }
  >()

  registerFixture(point: ModelFallbackDecisionPoint): ModelFallbackFixture {
    const sourceSha256 = normalizedSourceHash(point)
    const id = `fixture-${hash({
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      sourceSha256,
      inputs: point.inputs,
      candidates: point.candidates,
    }).slice(0, 24)}`
    const existing = this.fixtures.get(id)
    if (existing) return clone(existing)
    const fixture: InternalFixture = {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      id,
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      sourceSha256,
      ambiguity: {
        reason:
          point.reason ??
          'deterministic evidence left multiple candidates open',
        inputs: clone(point.inputs),
        candidateIds: point.candidates.map(
          ({ id: candidateId }) => candidateId,
        ),
      },
      candidates: point.candidates.map((candidate) => clone(candidate)),
      modelPath: { status: 'model-consulted', choice: null },
      rejectionPath: {
        status: 'review-required',
        diagnosticCode: 'MODEL_ASSISTANCE_DISABLED',
      },
      resolution: 'model-consulted',
      point: {
        ...point,
        sourceSha256,
        inputs: clone(point.inputs),
        candidates: point.candidates.map((candidate) => clone(candidate)),
      },
    }
    this.fixtures.set(id, fixture)
    return clone(fixture)
  }

  recordModelPath(fixtureId: string, choice: ModelFallbackChoice | null) {
    const fixture = this.fixtures.get(fixtureId)
    if (!fixture) return
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
    fixture.rejectionPath = { status: 'review-required', diagnosticCode }
  }

  /**
   * Install and validate a deterministic rule against every generated
   * ambiguity fixture. A class cannot be called retired while one fixture is
   * still model-consulted.
   */
  retireClass(
    decisionClass: string,
    rule: ModelFallbackDeterministicRule,
    ruleId = `rule-${hash({ decisionClass }).slice(0, 16)}`,
  ) {
    const fixtures = [...this.fixtures.values()].filter(
      (fixture) => fixture.decisionClass === decisionClass,
    )
    if (fixtures.length === 0)
      throw new Error(`DISTILLATION_REQUIRES_FIXTURE:${decisionClass}`)
    const resolutions = new Map<string, ModelFallbackChoice>()
    for (const fixture of fixtures) {
      const resolved = rule(fixture.point)
      const result = verifyModelDecisionProposal(fixture.point, resolved)
      if (result.status !== 'accepted')
        throw new Error(
          `DISTILLATION_RULE_DOES_NOT_RESOLVE_FIXTURE:${fixture.id}:${result.code}`,
        )
      resolutions.set(fixture.id, result.choice)
    }
    this.rules.set(decisionClass, { id: ruleId, rule })
    for (const fixture of fixtures) {
      fixture.resolution = 'deterministic-decided'
      fixture.deterministicRuleId = ruleId
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

  isRetired(decisionClass: string) {
    return this.rules.has(decisionClass)
  }

  fixture(id: string) {
    const fixture = this.fixtures.get(id)
    return fixture ? clone(fixture) : null
  }

  fixturesFor(decisionClass?: string) {
    return [...this.fixtures.values()]
      .filter((fixture) =>
        decisionClass === undefined
          ? true
          : fixture.decisionClass === decisionClass,
      )
      .map((fixture) => clone(fixture))
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
      consultationCount: retired ? 0 : fixtures.length,
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
  private readonly decisions: ModelDecisionMetricEvent[] = []
  readonly distillation: DistillationLedger

  constructor(distillation = new DistillationLedger()) {
    this.distillation = distillation
  }

  recordDecision(event: ModelDecisionMetricEvent) {
    this.decisions.push(clone(event))
  }

  beginConsultation(
    request: ModelDecisionRequest,
    model: NormalizedModelIdentity,
  ) {
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
      promptHash: request.promptHash,
      status: 'pending',
      choice: null,
      costUsd: 0,
      latencyMs: null,
    }
    this.records.push(record)
    return record.requestId
  }

  completeConsultation(
    requestIdValue: string,
    patch: Pick<
      ModelConsultationRecord,
      'status' | 'choice' | 'costUsd' | 'latencyMs'
    > & { failureCode?: string },
  ) {
    const index = this.records.findLastIndex(
      ({ requestId: candidate }) => candidate === requestIdValue,
    )
    if (index < 0) throw new Error('UNKNOWN_MODEL_CONSULTATION_REQUEST')
    this.records[index] = {
      ...this.records[index]!,
      status: patch.status,
      choice: clone(patch.choice),
      costUsd: patch.costUsd,
      latencyMs: patch.latencyMs,
      ...(patch.failureCode ? { failureCode: patch.failureCode } : {}),
    }
    const record = this.records[index]!
    const fixture = record.fixtureId
      ? this.distillation.fixture(record.fixtureId)
      : this.distillation
          .fixturesFor(record.decisionClass)
          .find(
            (candidate) =>
              candidate.documentId === record.documentId &&
              candidate.decisionId === record.decisionId,
          )
    if (fixture) {
      if (patch.status === 'accepted')
        this.distillation.recordModelPath(fixture.id, patch.choice)
      else
        this.distillation.recordRejection(
          fixture.id,
          patch.failureCode ?? 'MODEL_REVIEW_REQUIRED',
        )
    }
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
    const prior = this.records.find(
      (record) => record.requestId === id && record.status === 'accepted',
    )
    return prior?.choice ? clone(prior.choice) : null
  }

  receiptFor(documentId: string): ModelFallbackReceipt {
    const consultations = this.recordsFor({ documentId })
    const decisions = this.decisionsFor({ documentId })
    const sourceSha256 =
      consultations[0]?.sourceSha256 ?? (decisions.length > 0 ? null : null)
    return {
      schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
      documentId,
      sourceSha256,
      consultations,
      decisions,
      metrics: metric(decisions, (decisionClass) =>
        this.distillation.isRetired(decisionClass),
      ),
    }
  }

  metrics(documentId?: string) {
    return metric(
      this.decisionsFor(documentId ? { documentId } : {}),
      (decisionClass) => this.distillation.isRetired(decisionClass),
    )
  }

  consultationCount(decisionClass?: string, documentId?: string) {
    const records = this.recordsFor({ documentId, decisionClass }).filter(
      ({ status }) => status === 'accepted',
    )
    return this.distillation.isRetired(decisionClass ?? '') ? 0 : records.length
  }

  retireDecisionClass(
    decisionClass: string,
    rule: ModelFallbackDeterministicRule,
    ruleId?: string,
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
  /** False is the safe default; true is explicit owner opt-in for this run. */
  enabled?: boolean
  ownerOptIn?: boolean
  model?: ModelConsultationClient
  modelIdentity?: ModelIdentity
  ledger?: ModelFallbackLedger
  distillation?: DistillationLedger
  onRequest?: (request: ModelDecisionRequest) => void
}

export class ModelConsultationGate {
  readonly enabled: boolean
  readonly ledger: ModelFallbackLedger
  private readonly model: ModelConsultationClient | undefined
  private readonly identity: NormalizedModelIdentity | undefined
  private readonly onRequest:
    ((request: ModelDecisionRequest) => void) | undefined

  constructor(options: ModelConsultationGateOptions = {}) {
    this.enabled = options.enabled === true && options.ownerOptIn !== false
    this.ledger =
      options.ledger ??
      new ModelFallbackLedger(options.distillation ?? new DistillationLedger())
    this.model = options.model
    this.identity = options.model
      ? normalizedIdentity(options.model.identity)
      : options.modelIdentity
        ? normalizedIdentity(options.modelIdentity)
        : undefined
    this.onRequest = options.onRequest
  }

  private deterministicOutcome(
    point: ModelFallbackDecisionPoint,
    choice: ModelFallbackChoice,
  ): ModelDecisionOutcome {
    this.ledger.recordDecision({
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      outcome: 'deterministic',
      consulted: false,
    })
    return {
      status: 'deterministic',
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      choice,
      provenance: null,
    }
  }

  private reviewOutcome(point: ModelFallbackDecisionPoint, diagnostic: string) {
    this.ledger.recordDecision({
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      outcome: 'review-required',
      consulted: false,
    })
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

  async decide(
    point: ModelFallbackDecisionPoint,
  ): Promise<ModelDecisionOutcome> {
    try {
      candidateIds(point.candidates)
    } catch (error) {
      return this.reviewOutcome(
        point,
        error instanceof Error ? error.message : 'INVALID_MODEL_CANDIDATE_SET',
      )
    }
    if (!isOpenDecision(point)) {
      const checked = candidateChoice(point, point.deterministicChoice)
      return checked.status === 'accepted'
        ? this.deterministicOutcome(point, checked.choice)
        : this.reviewOutcome(point, checked.code)
    }

    const distilled = this.ledger.distillation.ruleFor(point.decisionClass)
    if (distilled) {
      const checked = candidateChoice(point, distilled(point))
      if (checked.status === 'accepted')
        return this.deterministicOutcome(point, checked.choice)
      return this.reviewOutcome(point, `DISTILLED_RULE_${checked.code}`)
    }

    if (!this.enabled)
      return this.reviewOutcome(point, 'MODEL_ASSISTANCE_DISABLED')
    if (!this.model || !this.identity)
      return this.reviewOutcome(point, 'MODEL_PROVIDER_UNAVAILABLE')
    const request = modelRequest(point)
    const requestIdValue = this.ledger.beginConsultation(request, this.identity)
    // The callback and pending receipt entry happen before the provider call.
    this.onRequest?.(clone(request))
    const consult =
      this.model.consult ?? this.model.propose ?? this.model.choose
    if (!consult) {
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'failed',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'MODEL_PROVIDER_UNAVAILABLE',
      })
      this.ledger.recordDecision({
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
      return {
        status: 'review-required',
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'MODEL_PROVIDER_UNAVAILABLE',
      }
    }
    let response: ModelDecisionResponse
    try {
      response = await consult(request)
    } catch {
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'failed',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'MODEL_PROVIDER_ERROR',
      })
      this.ledger.recordDecision({
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
      return {
        status: 'review-required',
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'MODEL_PROVIDER_ERROR',
      }
    }
    const { proposal, costUsd, latencyMs, rejection } =
      proposalAndMetrics(response)
    const verified = rejection ?? verifyModelDecisionProposal(point, proposal)
    if (
      !finiteNonNegative(costUsd) ||
      (latencyMs !== null && !finiteNonNegative(latencyMs))
    ) {
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'rejected',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'INVALID_MODEL_COST',
      })
      this.ledger.recordDecision({
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
      return {
        status: 'review-required',
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'INVALID_MODEL_COST',
      }
    }
    if (verified.status !== 'accepted') {
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'rejected',
        choice: null,
        costUsd,
        latencyMs,
        failureCode: verified.code,
      })
      this.ledger.recordDecision({
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
      return {
        status: 'review-required',
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
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
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'rejected',
        choice: null,
        costUsd,
        latencyMs,
        failureCode: 'BYTE_STABILITY_MISMATCH',
      })
      this.ledger.recordDecision({
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
      return {
        status: 'review-required',
        documentId: point.documentId,
        decisionId: point.decisionId,
        decisionClass: point.decisionClass,
        choice: null,
        provenance,
        diagnostic: 'BYTE_STABILITY_MISMATCH',
      }
    }
    const provenance = this.ledger.completeConsultation(requestIdValue, {
      status: 'accepted',
      choice: verified.choice,
      costUsd,
      latencyMs,
    })
    this.ledger.recordDecision({
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      outcome: 'consulted',
      consulted: true,
    })
    return {
      status: 'consulted',
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
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
  return `${stableJson(receipt)}\n`
}

export function validateModelConsultationReceipt(
  receipt: unknown,
): receipt is ModelFallbackReceipt {
  if (!receipt || typeof receipt !== 'object') return false
  const value = receipt as Partial<ModelFallbackReceipt>
  return (
    value.schemaVersion === MODEL_FALLBACK_SCHEMA_VERSION &&
    typeof value.documentId === 'string' &&
    Array.isArray(value.consultations) &&
    Array.isArray(value.decisions) &&
    Boolean(value.metrics && typeof value.metrics === 'object')
  )
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
      inputs: { markerId: 'marker-1', token: '1' },
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

export function createReferenceDistillationLedger() {
  const ledger = new DistillationLedger()
  for (const fixture of MODEL_FALLBACK_REFERENCE_FIXTURES)
    ledger.registerFixture(fixture)
  return ledger
}

export function attachModelConsultationReceipt<T extends object>(
  receipt: T,
  ledger: ModelFallbackLedger,
  documentId: string,
) {
  return {
    ...receipt,
    modelConsultations: createModelConsultationReceipt(ledger, documentId),
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
