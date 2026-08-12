import { sha256HexSync } from './sha256-sync.ts'

/**
 * Model assistance is deliberately a small decision service, rather than an
 * alternate extractor.  A deterministic caller supplies the complete,
 * source-backed candidate set and the model can only return a reference to one
 * of those candidates.
 */
export const MODEL_FALLBACK_SCHEMA_VERSION = '1.0.0' as const
export const MODEL_ASSISTANCE_DEFAULT_ENABLED = false as const
/** SHA-256 of `erniesg:model-fallback-structured-decision-protocol:v1`. */
export const MODEL_FALLBACK_PROMPT_TEMPLATE_SHA256 =
  '7a407e0fd700f6b9312677011493ed299dbac5962058b0cedd2f9b0b6890eb76' as const
const EMBEDDED_DETERMINISTIC_RULE_ID =
  'embedded-deterministic-choice-v1' as const

export const MODEL_FALLBACK_DECISION_CLASSES = Object.freeze({
  captionAssociation: 'candidate-ambiguous-caption-association',
  noteMarkerMatch: 'ambiguous-note-marker-match',
  readingOrderTie: 'reading-order-tie',
})

export const MODEL_FALLBACK_EVIDENCE_CODES = Object.freeze({
  captionAssociation: Object.freeze([
    'bounded-distance',
    'caption-bounded-envelope-proof',
    'caption-typography',
    'column-scope',
    'horizontal-alignment',
    'label-sequence',
    'label-sequence-mismatch',
    'object-above-caption',
    'object-below-caption',
    'same-page-scope',
    'source-cross-reference',
  ]),
  noteMarkerMatch: Object.freeze([
    'label-exact',
    'later-endnote-section-scope',
    'note-follows-reference',
    'numbering-sequence-next-adjacency',
    'numbering-sequence-previous-adjacency',
    'numbering-sequence-start',
    'page-wide-note-region',
    'same-column-geometry',
    'same-page-scope',
    'typography-explicit-note-marker',
    'typography-raised-marker',
    'typography-superscript-glyph',
  ]),
  readingOrderTie: Object.freeze([
    'ambiguous-column-flow',
    'block-adjacency',
    'caption-proximity',
    'column-flow',
    'column-gutter',
    'font-metrics',
    'footnote-band',
    'indentation-continuity',
    'margin-note-exclusion',
    'note-after-body',
    'page-sequence',
    'spanning-boundary',
    'vertical-flow',
  ]),
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
  promptTemplateSha256: string
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
  fixtureId: string
  documentId: string
  decisionId: string
  decisionClass: ModelFallbackDecisionClass
  sourceSha256: string
  inputs: Record<string, unknown>
  inputsHash: string
  candidates: ModelFallbackCandidate[]
  candidateIds: string[]
  model: NormalizedModelIdentity
  promptTemplateSha256: string
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
  /** Present only for deterministic outcomes. */
  choice?: ModelFallbackChoice
  /** Versioned deterministic rule; present only for deterministic outcomes. */
  deterministicRuleId?: string
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
  /** PDF adapters bind the receipt to the exact materialized semantic state. */
  semanticStateSha256?: string
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
const SAFE_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const CREDENTIAL_SHAPED_ID_PATTERNS = [
  /^sk-(?:proj-)?[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:AKIA|ASIA)[A-Z0-9]{12,}$/u,
  /^bearer[.:-][A-Za-z0-9._:-]{8,}$/iu,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/u,
  /^(?:-----)?BEGIN[.:-]?(?:(?:RSA|EC|OPENSSH)[.:-]?)?PRIVATE[.:-]?KEY/iu,
  /^xox[baprs]-[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:ghp|github_pat)_/iu,
] as const

function credentialShapedValue(value: string) {
  return CREDENTIAL_SHAPED_ID_PATTERNS.some((pattern) => pattern.test(value))
}

const SAFE_ID = {
  test(value: string) {
    return SAFE_ID_FORMAT.test(value) && !credentialShapedValue(value)
  },
}
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
const FORBIDDEN_MODEL_KEYS_NORMALIZED = new Set([
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
])
const FORBIDDEN_EVIDENCE_KEYS_NORMALIZED = new Set([
  'text',
  'content',
  'sourcetext',
  'rawtext',
  'rawcontent',
  'generatedtext',
  'alttext',
  'html',
  'markdown',
  'bytes',
  'assetbytes',
  'pdfbytes',
  'apikey',
  'authorization',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'password',
  'secret',
  'credential',
  'credentials',
  'clientsecret',
  'privatekey',
])
const FORBIDDEN_EVIDENCE_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'credential',
  'passphrase',
  'password',
  'privatekey',
  'secret',
]

function normalizedFieldKey(key: string) {
  return key
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]/gu, '')
    .toLowerCase()
}

function forbiddenModelField(key: string) {
  return (
    FORBIDDEN_MODEL_KEYS.has(key) ||
    FORBIDDEN_MODEL_KEYS_NORMALIZED.has(normalizedFieldKey(key))
  )
}

function forbiddenEvidenceKey(key: string) {
  const normalized = normalizedFieldKey(key)
  return (
    !SAFE_ID.test(key) ||
    FORBIDDEN_EVIDENCE_KEYS_NORMALIZED.has(normalized) ||
    normalized.includes('token') ||
    FORBIDDEN_EVIDENCE_KEY_FRAGMENTS.some((fragment) =>
      normalized.includes(fragment),
    )
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

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function ownDataKeys(value: object): string[] | null {
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) return null
    const stringKeys = keys as string[]
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        return null
    }
    return stringKeys
  } catch {
    return null
  }
}

function isCanonicalJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (
        keys.length !== value.length + 1 ||
        keys.some((key) => typeof key !== 'string') ||
        !keys.includes('length')
      )
        return false
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          !isCanonicalJsonValue(descriptor.value, ancestors)
        )
          return false
      }
      return true
    }

    const keys = ownDataKeys(value)
    if (!keys) return false
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return (
        descriptor !== undefined &&
        Object.hasOwn(descriptor, 'value') &&
        isCanonicalJsonValue(descriptor.value, ancestors)
      )
    })
  } catch {
    return false
  } finally {
    ancestors.delete(value)
  }
}

function forbiddenEvidenceField(value: unknown, path = ''): string | null {
  if (typeof value === 'string' && credentialShapedValue(value))
    return path || '$'
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = forbiddenEvidenceField(child, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const keys = ownDataKeys(value)
  if (!keys) return null
  for (const key of keys) {
    if (forbiddenEvidenceKey(key)) return `${path}.${key}`
    const child = Object.getOwnPropertyDescriptor(value, key)?.value
    const found = forbiddenEvidenceField(child, `${path}.${key}`)
    if (found) return found
  }
  return null
}

function normalizedIdentity(identity: ModelIdentity | undefined) {
  if (
    (identity?.providerId !== undefined &&
      identity.provider !== undefined &&
      identity.providerId !== identity.provider) ||
    (identity?.modelId !== undefined &&
      identity.id !== undefined &&
      identity.modelId !== identity.id) ||
    (identity?.modelVersion !== undefined &&
      identity.version !== undefined &&
      identity.modelVersion !== identity.version) ||
    (identity?.modelDigest !== undefined &&
      identity.digest !== undefined &&
      identity.modelDigest !== identity.digest)
  )
    throw new Error('CONFLICTING_MODEL_IDENTITY')
  const providerId = identity?.providerId ?? identity?.provider
  const modelId = identity?.modelId ?? identity?.id
  const modelVersion = identity?.modelVersion ?? identity?.version
  const modelDigest = identity?.modelDigest ?? identity?.digest
  if (!providerId || !modelId || !modelVersion || !modelDigest) return undefined
  if (
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    typeof modelVersion !== 'string' ||
    typeof modelDigest !== 'string' ||
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
  if (point.sourceSha256 === undefined)
    throw new Error('SOURCE_SHA256_REQUIRED')
  if (typeof point.sourceSha256 !== 'string' || !HASH.test(point.sourceSha256))
    throw new Error('INVALID_SOURCE_SHA256')
  return point.sourceSha256
}

function candidateIds(candidates: readonly ModelFallbackCandidate[]) {
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    Array.from(
      { length: candidates.length },
      (_, index) => !Object.hasOwn(candidates, index),
    ).some(Boolean) ||
    candidates.some(
      (candidate) =>
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        typeof candidate.id !== 'string' ||
        !SAFE_ID.test(candidate.id),
    )
  )
    throw new Error('INVALID_MODEL_CANDIDATE_SET')
  const ids = candidates.map(({ id }) => id)
  if (new Set(ids).size !== ids.length)
    throw new Error('DUPLICATE_MODEL_CANDIDATE_ID')
  return ids
}

const MAX_MODEL_CANDIDATES = 64
const MAX_MODEL_ID_LIST = 256
const MAX_MODEL_EVIDENCE_CODES = 64
const PDF_VISUAL_KINDS = new Set(['figure', 'table', 'equation'])
const PDF_REGION_KINDS = new Set([
  'body',
  'spanning',
  'header',
  'footer',
  'page-number',
  'side',
  'chart-label',
  'figure',
  'equation',
  'caption',
  'footnote',
  'endnote',
])
const PDF_REGION_COLUMNS = new Set(['single', 'left', 'right', 'span'])
const READING_ORDER_AMBIGUITY_CLASSES = new Set([
  'two-column-with-spanning-float',
  'single-column-with-margin-notes',
  'mixed-single-two-column',
  'dense-reference-section',
  'footnote-band',
  'sparse-column-gutter',
  'fragmented-inline-cluster',
  'unspecified',
])

function exactDataObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = ownDataKeys(value)
  return (
    actual !== null &&
    actual.length === keys.length &&
    keys.every((key) => actual.includes(key))
  )
}

function unitInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function boundedInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  )
}

function normalizedIdList(value: unknown, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    !isCanonicalJsonValue(value) ||
    value.length > MAX_MODEL_ID_LIST ||
    (!allowEmpty && value.length === 0) ||
    !value.every((entry) => typeof entry === 'string' && SAFE_ID.test(entry)) ||
    new Set(value).size !== value.length
  )
    return null
  return [...value] as string[]
}

function normalizedEvidenceCodeList(
  value: unknown,
  allowedValues: readonly string[],
) {
  if (
    !Array.isArray(value) ||
    !isCanonicalJsonValue(value) ||
    value.length > MAX_MODEL_EVIDENCE_CODES ||
    !value.every((entry) => typeof entry === 'string')
  )
    return null
  const codes = value as string[]
  const allowed = new Set(allowedValues)
  if (
    codes.some((code) => !allowed.has(code)) ||
    new Set(codes).size !== codes.length ||
    codes.some((code, index) => index > 0 && codes[index - 1]! >= code)
  )
    return null
  return [...codes]
}

type NormalizedConsultationEvidence = {
  inputs: Record<string, unknown>
  candidates: ModelFallbackCandidate[]
}

/**
 * Positive wire codecs are the privacy boundary. Only these freshly projected
 * fields may reach a provider or a durable receipt.
 */
function normalizeConsultationEvidence(
  point: Pick<
    ModelFallbackDecisionPoint,
    'decisionClass' | 'inputs' | 'candidates'
  >,
): NormalizedConsultationEvidence | null {
  if (
    !Array.isArray(point.candidates) ||
    point.candidates.length === 0 ||
    point.candidates.length > MAX_MODEL_CANDIDATES ||
    !isCanonicalJsonValue(point.inputs) ||
    !isCanonicalJsonValue(point.candidates)
  )
    return null

  if (
    point.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation
  ) {
    if (exactDataObject(point.inputs, ['figureId', 'captionRegion'])) {
      if (
        typeof point.inputs.figureId !== 'string' ||
        !SAFE_ID.test(point.inputs.figureId) ||
        typeof point.inputs.captionRegion !== 'string' ||
        !SAFE_ID.test(point.inputs.captionRegion)
      )
        return null
      const candidates: ModelFallbackCandidate[] = []
      for (const candidate of point.candidates) {
        if (exactDataObject(candidate, ['id', 'associationId'])) {
          if (
            typeof candidate.id !== 'string' ||
            !SAFE_ID.test(candidate.id) ||
            typeof candidate.associationId !== 'string' ||
            !SAFE_ID.test(candidate.associationId)
          )
            return null
          candidates.push({
            id: candidate.id,
            associationId: candidate.associationId,
          })
          continue
        }
        const association = candidate.association as
          Record<string, unknown> | undefined
        if (
          !exactDataObject(candidate, ['id', 'association']) ||
          typeof candidate.id !== 'string' ||
          !SAFE_ID.test(candidate.id) ||
          !exactDataObject(association, ['id']) ||
          typeof association?.id !== 'string' ||
          !SAFE_ID.test(association.id)
        )
          return null
        candidates.push({
          id: candidate.id,
          association: { id: association.id },
        })
      }
      return {
        inputs: {
          figureId: point.inputs.figureId,
          captionRegion: point.inputs.captionRegion,
        },
        candidates,
      }
    }

    if (
      !exactDataObject(point.inputs, [
        'diagnostic_code',
        'relationship_id',
        'caption_region_id',
        'kind',
        'confidence',
        'candidate_count',
      ]) ||
      point.inputs.diagnostic_code !== 'AMBIGUOUS_VISUAL_MATCH' ||
      typeof point.inputs.relationship_id !== 'string' ||
      !SAFE_ID.test(point.inputs.relationship_id) ||
      typeof point.inputs.caption_region_id !== 'string' ||
      !SAFE_ID.test(point.inputs.caption_region_id) ||
      typeof point.inputs.kind !== 'string' ||
      !PDF_VISUAL_KINDS.has(point.inputs.kind) ||
      !unitInterval(point.inputs.confidence) ||
      !boundedInteger(point.inputs.candidate_count) ||
      point.inputs.candidate_count !== point.candidates.length
    )
      return null
    const candidates: ModelFallbackCandidate[] = []
    for (const candidate of point.candidates) {
      if (
        !exactDataObject(candidate, [
          'id',
          'score',
          'kind',
          'region_ids',
          'line_ids',
          'object_ids',
          'asset_ids',
          'evidence_codes',
        ]) ||
        typeof candidate.id !== 'string' ||
        !SAFE_ID.test(candidate.id) ||
        !unitInterval(candidate.score) ||
        candidate.kind !== point.inputs.kind
      )
        return null
      const regionIds = normalizedIdList(candidate.region_ids)
      const lineIds = normalizedIdList(candidate.line_ids, true)
      const objectIds = normalizedIdList(candidate.object_ids)
      const assetIds = normalizedIdList(candidate.asset_ids)
      const evidenceCodes = normalizedEvidenceCodeList(
        candidate.evidence_codes,
        MODEL_FALLBACK_EVIDENCE_CODES.captionAssociation,
      )
      if (!regionIds || !lineIds || !objectIds || !assetIds || !evidenceCodes)
        return null
      candidates.push({
        id: candidate.id,
        score: candidate.score,
        kind: candidate.kind,
        region_ids: regionIds,
        line_ids: lineIds,
        object_ids: objectIds,
        asset_ids: assetIds,
        evidence_codes: evidenceCodes,
      })
    }
    return { inputs: clone(point.inputs), candidates }
  }

  if (point.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch) {
    if (exactDataObject(point.inputs, ['markerId', 'markerOrdinal'])) {
      if (
        typeof point.inputs.markerId !== 'string' ||
        !SAFE_ID.test(point.inputs.markerId) ||
        typeof point.inputs.markerOrdinal !== 'string' ||
        !/^[1-9][0-9]{0,5}$/u.test(point.inputs.markerOrdinal)
      )
        return null
      const candidates: ModelFallbackCandidate[] = []
      for (const candidate of point.candidates) {
        if (
          !exactDataObject(candidate, ['id', 'targetId']) ||
          typeof candidate.id !== 'string' ||
          !SAFE_ID.test(candidate.id) ||
          typeof candidate.targetId !== 'string' ||
          !SAFE_ID.test(candidate.targetId)
        )
          return null
        candidates.push({ id: candidate.id, targetId: candidate.targetId })
      }
      return { inputs: clone(point.inputs), candidates }
    }

    if (
      !exactDataObject(point.inputs, [
        'diagnostic_code',
        'relationship_id',
        'reference_region_id',
        'confidence',
        'threshold',
        'candidate_count',
      ]) ||
      point.inputs.diagnostic_code !== 'AMBIGUOUS_NOTE_MATCH' ||
      typeof point.inputs.relationship_id !== 'string' ||
      !SAFE_ID.test(point.inputs.relationship_id) ||
      typeof point.inputs.reference_region_id !== 'string' ||
      !SAFE_ID.test(point.inputs.reference_region_id) ||
      !unitInterval(point.inputs.confidence) ||
      !unitInterval(point.inputs.threshold) ||
      !boundedInteger(point.inputs.candidate_count) ||
      point.inputs.candidate_count !== point.candidates.length
    )
      return null
    const candidates: ModelFallbackCandidate[] = []
    for (const candidate of point.candidates) {
      if (
        !exactDataObject(candidate, [
          'id',
          'associationId',
          'note_id',
          'region_id',
          'score',
          'evidence_codes',
        ]) ||
        typeof candidate.id !== 'string' ||
        !SAFE_ID.test(candidate.id) ||
        typeof candidate.associationId !== 'string' ||
        !SAFE_ID.test(candidate.associationId) ||
        candidate.associationId !== candidate.note_id ||
        typeof candidate.note_id !== 'string' ||
        !SAFE_ID.test(candidate.note_id) ||
        typeof candidate.region_id !== 'string' ||
        !SAFE_ID.test(candidate.region_id) ||
        !unitInterval(candidate.score)
      )
        return null
      const evidenceCodes = normalizedEvidenceCodeList(
        candidate.evidence_codes,
        MODEL_FALLBACK_EVIDENCE_CODES.noteMarkerMatch,
      )
      if (!evidenceCodes) return null
      candidates.push({
        id: candidate.id,
        associationId: candidate.associationId,
        note_id: candidate.note_id,
        region_id: candidate.region_id,
        score: candidate.score,
        evidence_codes: evidenceCodes,
      })
    }
    return { inputs: clone(point.inputs), candidates }
  }

  if (point.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie) {
    if (exactDataObject(point.inputs, ['regionIds'])) {
      const regionIds = normalizedIdList(point.inputs.regionIds)
      if (!regionIds) return null
      const candidates: ModelFallbackCandidate[] = []
      for (const candidate of point.candidates) {
        if (
          !exactDataObject(candidate, ['id', 'order']) ||
          typeof candidate.id !== 'string' ||
          !SAFE_ID.test(candidate.id) ||
          !boundedInteger(candidate.order) ||
          candidate.order > 63
        )
          return null
        candidates.push({ id: candidate.id, order: candidate.order })
      }
      return { inputs: { regionIds }, candidates }
    }

    if (
      !exactDataObject(point.inputs, [
        'diagnostic_code',
        'page',
        'ambiguity_class',
        'confidence',
        'threshold',
        'candidate_count',
      ]) ||
      point.inputs.diagnostic_code !== 'AMBIGUOUS_READING_ORDER' ||
      !boundedInteger(point.inputs.page) ||
      typeof point.inputs.ambiguity_class !== 'string' ||
      !READING_ORDER_AMBIGUITY_CLASSES.has(point.inputs.ambiguity_class) ||
      !unitInterval(point.inputs.confidence) ||
      !unitInterval(point.inputs.threshold) ||
      !boundedInteger(point.inputs.candidate_count) ||
      point.inputs.candidate_count !== point.candidates.length
    )
      return null
    const candidates: ModelFallbackCandidate[] = []
    for (const candidate of point.candidates) {
      if (
        !exactDataObject(candidate, [
          'id',
          'region_ids',
          'regions',
          'evidence_codes',
        ]) ||
        typeof candidate.id !== 'string' ||
        !SAFE_ID.test(candidate.id)
      )
        return null
      const regionIds = normalizedIdList(candidate.region_ids)
      if (
        !Array.isArray(candidate.regions) ||
        !isCanonicalJsonValue(candidate.regions) ||
        candidate.regions.length !== regionIds?.length
      )
        return null
      const regions: Array<{
        id: string
        kind: string
        column: string
        page: number
      }> = []
      for (const [index, region] of candidate.regions.entries()) {
        const regionRecord = region as Record<string, unknown>
        if (
          !exactDataObject(regionRecord, ['id', 'kind', 'column', 'page']) ||
          typeof regionRecord.id !== 'string' ||
          !SAFE_ID.test(regionRecord.id) ||
          regionRecord.id !== regionIds?.[index] ||
          typeof regionRecord.kind !== 'string' ||
          !PDF_REGION_KINDS.has(regionRecord.kind) ||
          typeof regionRecord.column !== 'string' ||
          !PDF_REGION_COLUMNS.has(regionRecord.column) ||
          !boundedInteger(regionRecord.page)
        )
          return null
        regions.push({
          id: regionRecord.id,
          kind: regionRecord.kind,
          column: regionRecord.column,
          page: regionRecord.page,
        })
      }
      const evidenceCodes = normalizedEvidenceCodeList(
        candidate.evidence_codes,
        MODEL_FALLBACK_EVIDENCE_CODES.readingOrderTie,
      )
      if (!regionIds || !evidenceCodes) return null
      candidates.push({
        id: candidate.id,
        region_ids: regionIds,
        regions,
        evidence_codes: evidenceCodes,
      })
    }
    return { inputs: clone(point.inputs), candidates }
  }

  return null
}

function normalizedFixturePoint(
  point: ModelFallbackDecisionPoint,
): ModelFallbackDecisionPoint {
  const evidence = normalizeConsultationEvidence(point)
  if (
    !point ||
    typeof point !== 'object' ||
    Array.isArray(point) ||
    !ownDataKeys(point) ||
    !boundedId(point.documentId) ||
    !boundedId(point.decisionId) ||
    !boundedId(point.decisionClass) ||
    !evidence
  )
    throw new Error('INVALID_DISTILLATION_FIXTURE')
  try {
    candidateIds(evidence.candidates)
  } catch {
    throw new Error('INVALID_DISTILLATION_FIXTURE')
  }
  let sourceSha256: string
  try {
    sourceSha256 = normalizedSourceHash(point)
  } catch {
    throw new Error('INVALID_DISTILLATION_FIXTURE')
  }
  return {
    documentId: point.documentId,
    decisionId: point.decisionId,
    decisionClass: point.decisionClass,
    sourceSha256,
    inputs: clone(evidence.inputs),
    candidates: evidence.candidates.map((candidate) => clone(candidate)),
  }
}

function candidateAssociation(candidate: ModelFallbackCandidate) {
  try {
    const associationId = candidate.associationId
    const association = candidate.association
    const nestedAssociationId =
      typeof association === 'string'
        ? association
        : association !== null &&
            typeof association === 'object' &&
            !Array.isArray(association)
          ? (association as { id?: unknown }).id
          : undefined
    if (associationId !== undefined && !boundedId(associationId))
      return { valid: false as const }
    if (association !== undefined && !boundedId(nestedAssociationId))
      return { valid: false as const }
    if (
      associationId !== undefined &&
      nestedAssociationId !== undefined &&
      associationId !== nestedAssociationId
    )
      return { valid: false as const }
    return {
      valid: true as const,
      id: (associationId ?? nestedAssociationId) as string | undefined,
    }
  } catch {
    return { valid: false as const }
  }
}

function validConsultationCandidates(
  candidates: readonly ModelFallbackCandidate[],
) {
  return (
    isCanonicalJsonValue(candidates) &&
    candidates.every((candidate) => candidateAssociation(candidate).valid)
  )
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

function modelPromptHash(request: Omit<ModelDecisionRequest, 'promptHash'>) {
  return hash({
    schemaVersion: request.schemaVersion,
    documentId: request.documentId,
    decisionId: request.decisionId,
    decisionClass: request.decisionClass,
    sourceSha256: request.sourceSha256,
    inputs: request.inputs,
    candidates: request.candidates,
    promptTemplateSha256: request.promptTemplateSha256,
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
  private readonly decisions: ModelDecisionMetricEvent[] = []
  private readonly documentSources = new Map<string, string>()
  private readonly stableChoices = new Map<string, ModelFallbackChoice>()
  readonly distillation: DistillationLedger

  constructor(distillation = new DistillationLedger()) {
    this.distillation = distillation
  }

  recordDecision(event: ModelDecisionMetricEvent) {
    if (!validReceiptDecision(event))
      throw new Error('INVALID_MODEL_DECISION_METRIC')
    this.decisions.push(clone(event))
  }

  bindDocumentSource(documentId: string, sourceSha256: unknown) {
    if (!boundedId(documentId)) return false
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
    for (const consultation of receipt.consultations) {
      if (consultation.status !== 'accepted' || !consultation.choice) continue
      const existing = this.stableChoices.get(consultation.requestId)
      if (existing && stableJson(existing) !== stableJson(consultation.choice))
        throw new Error('INVALID_PRIOR_MODEL_CONSULTATION_RECEIPT')
      this.stableChoices.set(consultation.requestId, clone(consultation.choice))
    }
  }

  beginConsultation(
    request: ModelDecisionRequest,
    model: NormalizedModelIdentity,
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
    return record.requestId
  }

  completeConsultation(
    requestIdValue: string,
    patch: Pick<
      ModelConsultationRecord,
      'status' | 'choice' | 'costUsd' | 'latencyMs'
    > & { failureCode?: string },
  ) {
    const index = this.records.findIndex(
      ({ requestId: candidate, status }) =>
        candidate === requestIdValue && status === 'pending',
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

  receiptFor(documentId: string): ModelFallbackReceipt {
    if (!boundedId(documentId)) throw new Error('INVALID_MODEL_DOCUMENT_ID')
    const consultations = this.recordsFor({ documentId })
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
  onRequest?: (request: ModelDecisionRequest) => void
}

export class ModelConsultationGate {
  readonly enabled: boolean
  readonly ledger: ModelFallbackLedger
  private readonly model: ModelConsultationClient | undefined
  private readonly identity: NormalizedModelIdentity | undefined
  private readonly promptTemplateSha256: string
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
    this.onRequest = options.onRequest
  }

  private deterministicOutcome(
    point: ModelFallbackDecisionPoint,
    choice: ModelFallbackChoice,
    deterministicRuleId: string,
  ): ModelDecisionOutcome {
    this.ledger.recordDecision({
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      outcome: 'deterministic',
      consulted: false,
      choice: { candidateId: choice.candidateId },
      deterministicRuleId,
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

  private reviewOutcome(
    point: ModelFallbackDecisionPoint,
    diagnostic: string,
    record = true,
  ) {
    if (record)
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
    if (
      !boundedId(point.documentId) ||
      !boundedId(point.decisionId) ||
      !boundedId(point.decisionClass)
    )
      return this.reviewOutcome(point, 'INVALID_MODEL_DECISION_POINT', false)
    if (!this.ledger.bindDocumentSource(point.documentId, point.sourceSha256))
      return this.reviewOutcome(point, 'DOCUMENT_SOURCE_HASH_MISMATCH', false)
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
        ? this.deterministicOutcome(
            point,
            checked.choice,
            EMBEDDED_DETERMINISTIC_RULE_ID,
          )
        : this.reviewOutcome(point, checked.code)
    }

    const distilled = this.ledger.distillation.ruleFor(point.decisionClass)
    if (distilled) {
      if (!receiptRecord(point.inputs) || !isCanonicalJsonValue(point.inputs))
        return this.reviewOutcome(point, 'INVALID_MODEL_DECISION_INPUTS')
      if (!validConsultationCandidates(point.candidates))
        return this.reviewOutcome(point, 'INVALID_MODEL_CANDIDATE_SET')
      if (
        forbiddenEvidenceField(point.inputs) !== null ||
        forbiddenEvidenceField(point.candidates) !== null
      )
        return this.reviewOutcome(point, 'UNSAFE_MODEL_DECISION_EVIDENCE')
      const evidence = normalizeConsultationEvidence(point)
      if (!evidence)
        return this.reviewOutcome(point, 'UNSAFE_MODEL_DECISION_EVIDENCE')
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
        return this.reviewOutcome(point, 'DISTILLATION_RULE_ERROR')
      }
      const checked = candidateChoice(distilledPoint, distilledChoice)
      if (checked.status === 'accepted')
        return this.deterministicOutcome(
          point,
          checked.choice,
          this.ledger.distillation.ruleIdFor(point.decisionClass)!,
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
      return this.reviewOutcome(point, diagnostic)
    }

    if (!this.enabled)
      return this.reviewOutcome(point, 'MODEL_ASSISTANCE_DISABLED')
    if (!this.model)
      return this.reviewOutcome(point, 'MODEL_PROVIDER_UNAVAILABLE')
    if (!this.identity)
      return this.reviewOutcome(point, 'MODEL_IDENTITY_REQUIRED')
    if (!receiptRecord(point.inputs) || !isCanonicalJsonValue(point.inputs))
      return this.reviewOutcome(point, 'INVALID_MODEL_DECISION_INPUTS')
    if (!validConsultationCandidates(point.candidates))
      return this.reviewOutcome(point, 'INVALID_MODEL_CANDIDATE_SET')
    if (
      forbiddenEvidenceField(point.inputs) !== null ||
      forbiddenEvidenceField(point.candidates) !== null
    )
      return this.reviewOutcome(point, 'UNSAFE_MODEL_DECISION_EVIDENCE')
    const evidence = normalizeConsultationEvidence(point)
    if (!evidence)
      return this.reviewOutcome(point, 'UNSAFE_MODEL_DECISION_EVIDENCE')
    const consultationPoint = {
      ...point,
      inputs: evidence.inputs,
      candidates: evidence.candidates,
    }
    try {
      normalizedSourceHash(consultationPoint)
    } catch (error) {
      return this.reviewOutcome(
        point,
        error instanceof Error ? error.message : 'INVALID_SOURCE_SHA256',
      )
    }
    const request = modelRequest(consultationPoint, this.promptTemplateSha256)
    const requestPoint = decisionPointFromRequest(request)
    let requestIdValue: string
    try {
      requestIdValue = this.ledger.beginConsultation(request, this.identity)
    } catch (error) {
      return this.reviewOutcome(
        point,
        error instanceof Error
          ? error.message
          : 'MODEL_CONSULTATION_RECORD_ERROR',
      )
    }
    let consult: ModelConsultationClient['consult']
    try {
      // The callback and pending receipt entry happen before the provider call.
      this.onRequest?.(clone(request))
      consult = this.model.consult ?? this.model.propose ?? this.model.choose
    } catch {
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'failed',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'MODEL_PROVIDER_ERROR',
      })
      this.ledger.recordDecision({
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
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
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'failed',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'MODEL_PROVIDER_UNAVAILABLE',
      })
      this.ledger.recordDecision({
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
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
      const response = await consult.call(this.model, clone(request))
      processed = proposalAndMetrics(response)
      verified =
        processed.rejection ??
        verifyModelDecisionProposal(requestPoint, processed.proposal)
    } catch {
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'failed',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'MODEL_PROVIDER_ERROR',
      })
      this.ledger.recordDecision({
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
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
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'rejected',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: 'INVALID_MODEL_COST',
      })
      this.ledger.recordDecision({
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
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
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'rejected',
        choice: null,
        costUsd,
        latencyMs,
        failureCode: verified.code,
      })
      this.ledger.recordDecision({
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
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
      const provenance = this.ledger.completeConsultation(requestIdValue, {
        status: 'rejected',
        choice: null,
        costUsd,
        latencyMs,
        failureCode: 'BYTE_STABILITY_MISMATCH',
      })
      this.ledger.recordDecision({
        documentId: requestPoint.documentId,
        decisionId: requestPoint.decisionId,
        decisionClass: requestPoint.decisionClass,
        outcome: 'consulted',
        consulted: true,
      })
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
    const provenance = this.ledger.completeConsultation(requestIdValue, {
      status: 'accepted',
      choice: verified.choice,
      costUsd,
      latencyMs,
    })
    this.ledger.recordDecision({
      documentId: requestPoint.documentId,
      decisionId: requestPoint.decisionId,
      decisionClass: requestPoint.decisionClass,
      outcome: 'consulted',
      consulted: true,
    })
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

function receiptRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exactReceiptKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function receiptId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function receiptHash(value: unknown) {
  return typeof value === 'string' && HASH.test(value)
}

function validReceiptChoice(value: unknown) {
  if (!receiptRecord(value)) return false
  if (
    !exactReceiptKeys(value, ['candidateId'], ['associationId', 'order']) ||
    !receiptId(value.candidateId)
  )
    return false
  if (Object.hasOwn(value, 'associationId') && !receiptId(value.associationId))
    return false
  if (
    Object.hasOwn(value, 'order') &&
    (typeof value.order !== 'number' || !Number.isFinite(value.order))
  )
    return false
  return true
}

function validReceiptModel(value: unknown) {
  if (!receiptRecord(value)) return false
  if (
    !exactReceiptKeys(value, [
      'providerId',
      'modelId',
      'modelVersion',
      'modelDigest',
    ])
  )
    return false
  return (
    typeof value.providerId === 'string' &&
    SAFE_ID.test(value.providerId) &&
    typeof value.modelId === 'string' &&
    SAFE_ID.test(value.modelId) &&
    typeof value.modelVersion === 'string' &&
    SAFE_ID.test(value.modelVersion) &&
    typeof value.modelDigest === 'string' &&
    (HASH.test(value.modelDigest) || SAFE_ID.test(value.modelDigest))
  )
}

function validReceiptConsultation(value: unknown) {
  if (!receiptRecord(value)) return false
  if (
    !exactReceiptKeys(
      value,
      [
        'schemaVersion',
        'requestId',
        'fixtureId',
        'documentId',
        'decisionId',
        'decisionClass',
        'sourceSha256',
        'inputs',
        'inputsHash',
        'candidates',
        'candidateIds',
        'model',
        'promptTemplateSha256',
        'promptHash',
        'status',
        'choice',
        'costUsd',
        'latencyMs',
      ],
      ['failureCode'],
    )
  )
    return false
  if (
    value.schemaVersion !== MODEL_FALLBACK_SCHEMA_VERSION ||
    !receiptHash(value.requestId) ||
    !receiptId(value.fixtureId) ||
    !receiptId(value.documentId) ||
    !receiptId(value.decisionId) ||
    !receiptId(value.decisionClass) ||
    !receiptHash(value.sourceSha256) ||
    !receiptRecord(value.inputs) ||
    !isCanonicalJsonValue(value.inputs) ||
    forbiddenEvidenceField(value.inputs) !== null ||
    !receiptHash(value.inputsHash) ||
    !validReceiptModel(value.model) ||
    !receiptHash(value.promptTemplateSha256) ||
    !receiptHash(value.promptHash) ||
    !finiteNonNegative(value.costUsd) ||
    (value.latencyMs !== null && !finiteNonNegative(value.latencyMs))
  )
    return false

  if (!Array.isArray(value.candidates) || value.candidates.length === 0)
    return false
  const normalizedEvidence = normalizeConsultationEvidence({
    decisionClass: value.decisionClass as string,
    inputs: value.inputs,
    candidates: value.candidates as ModelFallbackCandidate[],
  })
  if (
    !normalizedEvidence ||
    stableJson(normalizedEvidence.inputs) !== stableJson(value.inputs) ||
    stableJson(normalizedEvidence.candidates) !== stableJson(value.candidates)
  )
    return false
  const candidateIdsFromCandidates: string[] = []
  for (const candidate of value.candidates) {
    if (
      !receiptRecord(candidate) ||
      !receiptId(candidate.id) ||
      !isCanonicalJsonValue(candidate)
    )
      return false
    candidateIdsFromCandidates.push(candidate.id)
  }
  if (
    !validConsultationCandidates(
      value.candidates as ModelFallbackCandidate[],
    ) ||
    forbiddenEvidenceField(value.candidates) !== null
  )
    return false
  if (!Array.isArray(value.candidateIds)) return false
  const recordedCandidateIds = value.candidateIds
  if (
    recordedCandidateIds.length === 0 ||
    !recordedCandidateIds.every(receiptId) ||
    new Set(recordedCandidateIds).size !== recordedCandidateIds.length ||
    candidateIdsFromCandidates.length !== recordedCandidateIds.length ||
    candidateIdsFromCandidates.some(
      (candidateId, index) => candidateId !== recordedCandidateIds[index],
    )
  )
    return false

  const request: ModelDecisionRequest = {
    schemaVersion: MODEL_FALLBACK_SCHEMA_VERSION,
    documentId: value.documentId as string,
    decisionId: value.decisionId as string,
    decisionClass: value.decisionClass as string,
    sourceSha256: value.sourceSha256 as string,
    inputs: value.inputs,
    candidates: value.candidates as ModelFallbackCandidate[],
    promptTemplateSha256: value.promptTemplateSha256 as string,
    promptHash: value.promptHash as string,
  }
  const expectedPromptHash = modelPromptHash({
    schemaVersion: request.schemaVersion,
    documentId: request.documentId,
    decisionId: request.decisionId,
    decisionClass: request.decisionClass,
    sourceSha256: request.sourceSha256,
    inputs: request.inputs,
    candidates: request.candidates,
    promptTemplateSha256: request.promptTemplateSha256,
  })
  const expectedFixtureId = `fixture-${hash({
    documentId: request.documentId,
    decisionId: request.decisionId,
    decisionClass: request.decisionClass,
    sourceSha256: request.sourceSha256,
    inputs: request.inputs,
    candidates: request.candidates,
  }).slice(0, 24)}`
  if (
    value.inputsHash !== hash(request.inputs) ||
    value.promptHash !== expectedPromptHash ||
    value.requestId !==
      requestId(request, value.model as NormalizedModelIdentity) ||
    value.fixtureId !== expectedFixtureId
  )
    return false

  const hasFailure = Object.hasOwn(value, 'failureCode')
  if (value.status === 'accepted') {
    if (hasFailure || !validReceiptChoice(value.choice)) return false
    const choice = value.choice as Record<string, unknown>
    const candidate = value.candidates.find(
      (item) => (item as Record<string, unknown>).id === choice.candidateId,
    ) as Record<string, unknown> | undefined
    if (!candidate) return false
    for (const key of ['associationId', 'order']) {
      if (!Object.hasOwn(choice, key)) continue
      const candidateValue =
        key === 'associationId'
          ? (candidate.associationId ??
            (typeof candidate.association === 'string'
              ? candidate.association
              : receiptRecord(candidate.association)
                ? candidate.association.id
                : undefined))
          : candidate[key]
      if (choice[key] !== candidateValue) return false
    }
    return true
  }
  if (value.status === 'pending') return value.choice === null && !hasFailure
  if (value.status === 'rejected' || value.status === 'failed')
    return value.choice === null && hasFailure && receiptId(value.failureCode)
  return false
}

function validReceiptDecision(value: unknown) {
  if (!receiptRecord(value)) return false
  const baseKeys = [
    'documentId',
    'decisionId',
    'decisionClass',
    'outcome',
    'consulted',
  ] as const
  if (
    !receiptId(value.documentId) ||
    !receiptId(value.decisionId) ||
    !receiptId(value.decisionClass) ||
    typeof value.consulted !== 'boolean'
  )
    return false

  if (value.outcome === 'deterministic')
    return (
      exactReceiptKeys(value, [...baseKeys, 'choice', 'deterministicRuleId']) &&
      !value.consulted &&
      receiptRecord(value.choice) &&
      exactReceiptKeys(value.choice, ['candidateId']) &&
      receiptId(value.choice.candidateId) &&
      receiptId(value.deterministicRuleId)
    )
  if (!exactReceiptKeys(value, baseKeys)) return false
  if (value.outcome === 'consulted') return value.consulted
  return value.outcome === 'review-required' && !value.consulted
}

function validReceiptMetric(value: unknown) {
  if (!receiptRecord(value)) return false
  if (
    !exactReceiptKeys(value, [
      'decisionCount',
      'consultationCount',
      'consultationRate',
    ]) ||
    !Number.isInteger(value.decisionCount) ||
    (value.decisionCount as number) < 0 ||
    !Number.isInteger(value.consultationCount) ||
    (value.consultationCount as number) < 0 ||
    (value.consultationCount as number) > (value.decisionCount as number) ||
    typeof value.consultationRate !== 'number' ||
    !Number.isFinite(value.consultationRate)
  )
    return false
  const expectedRate =
    value.decisionCount === 0
      ? 0
      : (value.consultationCount as number) / (value.decisionCount as number)
  return value.consultationRate === expectedRate
}

export function validateModelConsultationReceipt(
  receipt: unknown,
): receipt is ModelFallbackReceipt {
  if (!receiptRecord(receipt) || !isCanonicalJsonValue(receipt)) return false
  if (
    !exactReceiptKeys(
      receipt,
      [
        'schemaVersion',
        'documentId',
        'sourceSha256',
        'consultations',
        'decisions',
        'metrics',
      ],
      ['semanticStateSha256'],
    ) ||
    receipt.schemaVersion !== MODEL_FALLBACK_SCHEMA_VERSION ||
    !receiptId(receipt.documentId) ||
    (receipt.sourceSha256 !== null && !receiptHash(receipt.sourceSha256)) ||
    !Array.isArray(receipt.consultations) ||
    !receipt.consultations.every(validReceiptConsultation) ||
    !Array.isArray(receipt.decisions) ||
    !receipt.decisions.every(validReceiptDecision) ||
    (receipt.semanticStateSha256 !== undefined &&
      !receiptHash(receipt.semanticStateSha256)) ||
    !receiptRecord(receipt.metrics)
  )
    return false

  if (
    receipt.consultations.some(
      (consultation) =>
        consultation.documentId !== receipt.documentId ||
        consultation.sourceSha256 !== receipt.sourceSha256,
    ) ||
    receipt.decisions.some(
      (decision) => decision.documentId !== receipt.documentId,
    ) ||
    (receipt.consultations.length > 0 && receipt.sourceSha256 === null)
  )
    return false

  const acceptedChoiceByRequestId = new Map<string, string>()
  for (const consultation of receipt.consultations) {
    if (consultation.status !== 'accepted') continue
    const serializedChoice = stableJson(consultation.choice)
    const priorChoice = acceptedChoiceByRequestId.get(consultation.requestId)
    if (priorChoice !== undefined && priorChoice !== serializedChoice)
      return false
    acceptedChoiceByRequestId.set(consultation.requestId, serializedChoice)
  }

  const decisionKey = (value: {
    documentId: string
    decisionId: string
    decisionClass: string
  }) => stableJson([value.documentId, value.decisionId, value.decisionClass])
  const consultationCounts = new Map<string, number>()
  for (const consultation of receipt.consultations) {
    if (consultation.status === 'pending') continue
    const key = decisionKey(consultation)
    consultationCounts.set(key, (consultationCounts.get(key) ?? 0) + 1)
  }
  const consultedDecisionCounts = new Map<string, number>()
  for (const decision of receipt.decisions) {
    if (!decision.consulted) continue
    const key = decisionKey(decision)
    consultedDecisionCounts.set(
      key,
      (consultedDecisionCounts.get(key) ?? 0) + 1,
    )
  }
  const consultationKeys = [
    ...new Set([
      ...consultationCounts.keys(),
      ...consultedDecisionCounts.keys(),
    ]),
  ]
  if (
    consultationKeys.some(
      (key) => consultationCounts.get(key) !== consultedDecisionCounts.get(key),
    )
  )
    return false

  const metrics = receipt.metrics
  if (
    !exactReceiptKeys(metrics, [
      'totalDecisionCount',
      'totalConsultationCount',
      'consultationRate',
      'byDecisionClass',
    ]) ||
    !Number.isInteger(metrics.totalDecisionCount) ||
    (metrics.totalDecisionCount as number) < 0 ||
    !Number.isInteger(metrics.totalConsultationCount) ||
    (metrics.totalConsultationCount as number) < 0 ||
    typeof metrics.consultationRate !== 'number' ||
    !Number.isFinite(metrics.consultationRate) ||
    !receiptRecord(metrics.byDecisionClass)
  )
    return false

  const decisionsByClass = new Map<string, ModelDecisionMetricEvent[]>()
  for (const decision of receipt.decisions as ModelDecisionMetricEvent[]) {
    const events = decisionsByClass.get(decision.decisionClass) ?? []
    events.push(decision)
    decisionsByClass.set(decision.decisionClass, events)
  }
  const classNames = [...decisionsByClass.keys()].sort()
  if (
    JSON.stringify(Object.keys(metrics.byDecisionClass).sort()) !==
    JSON.stringify(classNames)
  )
    return false

  let decisionTotal = 0
  let consultationTotal = 0
  for (const decisionClass of classNames) {
    const classMetric = metrics.byDecisionClass[decisionClass]
    if (!validReceiptMetric(classMetric)) return false
    const typedMetric = classMetric as ModelConsultationMetric
    const events = decisionsByClass.get(decisionClass) ?? []
    if (
      typedMetric.decisionCount !== events.length ||
      typedMetric.consultationCount !==
        events.filter(({ consulted }) => consulted).length
    )
      return false
    decisionTotal += typedMetric.decisionCount
    consultationTotal += typedMetric.consultationCount
  }

  const expectedRate =
    decisionTotal === 0 ? 0 : consultationTotal / decisionTotal
  return (
    metrics.totalDecisionCount === decisionTotal &&
    metrics.totalDecisionCount === receipt.decisions.length &&
    metrics.totalConsultationCount === consultationTotal &&
    metrics.consultationRate === expectedRate
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
