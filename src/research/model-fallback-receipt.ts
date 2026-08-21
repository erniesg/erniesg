import { sha256HexSync } from './sha256-sync'
import * as Struct from '@erniesg/struct'

/**
 * Application-owned model consultation policy for PDF reconstruction receipts.
 * The source-neutral closed receipt envelope lives in STRUCT core; this module
 * adds provider identity, candidate taxonomies, and PDF evidence validation.
 */

export const MODEL_FALLBACK_SCHEMA_VERSION = '1.0.0' as const
export const MODEL_ASSISTANCE_DEFAULT_ENABLED = false as const
/** SHA-256 of `erniesg:model-fallback-structured-decision-protocol:v1`. */
export const MODEL_FALLBACK_PROMPT_TEMPLATE_SHA256 =
  '7a407e0fd700f6b9312677011493ed299dbac5962058b0cedd2f9b0b6890eb76' as const
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
    context?: { signal?: AbortSignal },
  ) => ModelDecisionResponse | Promise<ModelDecisionResponse>
  propose?: (
    request: ModelDecisionRequest,
    context?: { signal?: AbortSignal },
  ) => ModelDecisionResponse | Promise<ModelDecisionResponse>
  choose?: (
    request: ModelDecisionRequest,
    context?: { signal?: AbortSignal },
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

export const HASH = /^[a-f0-9]{64}$/u
export const MAX_RECEIPT_HISTORY_ITEMS = 100_000
export const SAFE_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
export const CREDENTIAL_SHAPED_ID_PATTERNS = [
  /^sk-(?:proj-)?[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:AKIA|ASIA)[A-Z0-9]{12,}$/u,
  /^bearer[.:-][A-Za-z0-9._:-]{8,}$/iu,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/u,
  /^(?:-----)?BEGIN[.:-]?(?:(?:RSA|EC|OPENSSH)[.:-]?)?PRIVATE[.:-]?KEY/iu,
  /^xox[baprs]-[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:gh[pousr]|github_pat)_/iu,
] as const

export function credentialShapedValue(value: string) {
  return CREDENTIAL_SHAPED_ID_PATTERNS.some((pattern) => pattern.test(value))
}

export const SAFE_ID = {
  test(value: string) {
    return SAFE_ID_FORMAT.test(value) && !credentialShapedValue(value)
  },
}
export const FORBIDDEN_MODEL_KEYS = new Set([
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
export const FORBIDDEN_MODEL_KEYS_NORMALIZED = new Set([
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
export const FORBIDDEN_EVIDENCE_KEYS_NORMALIZED = new Set([
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
export const FORBIDDEN_EVIDENCE_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'credential',
  'passphrase',
  'password',
  'privatekey',
  'secret',
]

export function normalizedFieldKey(key: string) {
  return key
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]/gu, '')
    .toLowerCase()
}

export function forbiddenModelField(key: string) {
  return (
    FORBIDDEN_MODEL_KEYS.has(key) ||
    FORBIDDEN_MODEL_KEYS_NORMALIZED.has(normalizedFieldKey(key))
  )
}

export function forbiddenEvidenceKey(key: string) {
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

export function stableJson(value: unknown): string {
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

export function clone<T>(value: T): T {
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

export function hash(value: unknown) {
  return sha256HexSync(stableJson(value))
}

export function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function boundedId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

export function ownDataKeys(value: object): string[] | null {
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

export function isCanonicalJsonValue(
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

export function forbiddenEvidenceField(
  value: unknown,
  path = '',
): string | null {
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

export function normalizedIdentity(identity: ModelIdentity | undefined) {
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

export function normalizedSourceHash(point: ModelFallbackDecisionPoint) {
  if (point.sourceSha256 === undefined)
    throw new Error('SOURCE_SHA256_REQUIRED')
  if (typeof point.sourceSha256 !== 'string' || !HASH.test(point.sourceSha256))
    throw new Error('INVALID_SOURCE_SHA256')
  return point.sourceSha256
}

export function candidateIds(candidates: readonly ModelFallbackCandidate[]) {
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

export const MAX_MODEL_CANDIDATES = 64
export const MAX_MODEL_ID_LIST = 256
export const MAX_MODEL_EVIDENCE_CODES = 64
export const PDF_VISUAL_KINDS = new Set(['figure', 'table', 'equation'])
export const PDF_REGION_KINDS = new Set([
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
export const PDF_REGION_COLUMNS = new Set(['single', 'left', 'right', 'span'])
export const READING_ORDER_AMBIGUITY_CLASSES = new Set([
  'two-column-with-spanning-float',
  'single-column-with-margin-notes',
  'mixed-single-two-column',
  'dense-reference-section',
  'footnote-band',
  'sparse-column-gutter',
  'fragmented-inline-cluster',
  'unspecified',
])

export function exactDataObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = ownDataKeys(value)
  return (
    actual !== null &&
    actual.length === keys.length &&
    keys.every((key) => actual.includes(key))
  )
}

export function unitInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

export function boundedInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  )
}

export function normalizedIdList(value: unknown, allowEmpty = false) {
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

export function normalizedEvidenceCodeList(
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

export type NormalizedConsultationEvidence = {
  inputs: Record<string, unknown>
  candidates: ModelFallbackCandidate[]
}

/**
 * Positive wire codecs are the privacy boundary. Only these freshly projected
 * fields may reach a provider or a durable receipt.
 */
export function normalizeConsultationEvidence(
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

export function normalizedFixturePoint(
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

export function candidateAssociation(candidate: ModelFallbackCandidate) {
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

export function validConsultationCandidates(
  candidates: readonly ModelFallbackCandidate[],
) {
  return (
    isCanonicalJsonValue(candidates) &&
    candidates.every((candidate) => candidateAssociation(candidate).valid)
  )
}

export function modelPromptHash(
  request: Omit<ModelDecisionRequest, 'promptHash'>,
) {
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

export function requestId(
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

export function receiptRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function exactReceiptKeys(
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

export function receiptId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

export function receiptHash(value: unknown) {
  return typeof value === 'string' && HASH.test(value)
}

export function validReceiptChoice(value: unknown) {
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

export function validReceiptModel(value: unknown) {
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

export function validReceiptConsultation(value: unknown) {
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

export function validReceiptDecision(value: unknown) {
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

export function validReceiptMetric(value: unknown) {
  if (!receiptRecord(value)) return false
  if (
    !exactReceiptKeys(value, [
      'decisionCount',
      'consultationCount',
      'consultationRate',
    ]) ||
    !Number.isInteger(value.decisionCount) ||
    (value.decisionCount as number) < 0 ||
    (value.decisionCount as number) > MAX_RECEIPT_HISTORY_ITEMS ||
    !Number.isInteger(value.consultationCount) ||
    (value.consultationCount as number) < 0 ||
    (value.consultationCount as number) > MAX_RECEIPT_HISTORY_ITEMS ||
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
  // Struct owns the source-neutral receipt envelope. Keep the app validator
  // as the policy extension, but make generic acceptance the first gate so
  // the two validators cannot silently drift apart at their boundary.
  if (!Struct.validateModelConsultationReceipt(receipt)) return false
  if (!receiptRecord(receipt)) return false
  if (
    !Array.isArray(receipt.consultations) ||
    receipt.consultations.length > MAX_RECEIPT_HISTORY_ITEMS ||
    !Array.isArray(receipt.decisions) ||
    receipt.decisions.length > MAX_RECEIPT_HISTORY_ITEMS ||
    !isCanonicalJsonValue(receipt)
  )
    return false
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
    !receipt.consultations.every(validReceiptConsultation) ||
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
    (metrics.totalDecisionCount as number) > MAX_RECEIPT_HISTORY_ITEMS ||
    !Number.isInteger(metrics.totalConsultationCount) ||
    (metrics.totalConsultationCount as number) < 0 ||
    (metrics.totalConsultationCount as number) > MAX_RECEIPT_HISTORY_ITEMS ||
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
