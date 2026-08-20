import { sha256HexSync } from './sha256'

/**
 * Source-neutral closed receipt data carried by StructReceipt.  Decision
 * classes, candidate taxonomies, and semantic binding remain app-owned; the
 * core validates only the durable envelope and its integrity relationships.
 */

export const MODEL_CONSULTATION_SCHEMA_VERSION = '1.0.0' as const
export const MODEL_FALLBACK_SCHEMA_VERSION = MODEL_CONSULTATION_SCHEMA_VERSION

export type ModelFallbackDecisionClass = string

export type ModelFallbackCandidate = {
  id: string
  [key: string]: unknown
}

export type ModelFallbackChoice = {
  candidateId: string
  associationId?: string
  order?: number
}

export type ModelConsultationRecordStatus =
  'pending' | 'accepted' | 'rejected' | 'failed'

export type ModelConsultationRecord = {
  schemaVersion: typeof MODEL_CONSULTATION_SCHEMA_VERSION
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
  model: {
    providerId: string
    modelId: string
    modelVersion: string
    modelDigest: string
  }
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
  choice?: { candidateId: string }
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
  schemaVersion: typeof MODEL_CONSULTATION_SCHEMA_VERSION
  documentId: string
  sourceSha256: string | null
  consultations: ModelConsultationRecord[]
  decisions: ModelDecisionMetricEvent[]
  metrics: ModelConsultationMetrics
  /** App adapters may bind this receipt to a semantic state digest. */
  semanticStateSha256?: string
}

const HASH = /^[a-f0-9]{64}$/u
const MAX_RECEIPT_HISTORY_ITEMS = 100_000
const SAFE_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const CREDENTIAL_SHAPED_ID = [
  /^sk-(?:proj-)?[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:AKIA|ASIA)[A-Z0-9]{12,}$/u,
  /^bearer[.:-][A-Za-z0-9._:-]{8,}$/iu,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/u,
  /^(?:-----)?BEGIN[.:-]?(?:(?:RSA|EC|OPENSSH)[.:-]?)?PRIVATE[.:-]?KEY/iu,
  /^xox[baprs]-[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:gh[pousr]|github_pat)_/iu,
] as const
const SAFE_ID = {
  test(value: string) {
    return (
      SAFE_ID_FORMAT.test(value) &&
      !CREDENTIAL_SHAPED_ID.some((pattern) => pattern.test(value))
    )
  },
}
const FORBIDDEN_KEYS = new Set([
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
  'bounds',
  'assetbounds',
  'x',
  'y',
  'width',
  'height',
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
const FORBIDDEN_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'credential',
  'passphrase',
  'password',
  'privatekey',
  'secret',
  'token',
]

function receiptRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function ownDataKeys(value: object) {
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) return null
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        return null
    }
    return keys as string[]
  } catch {
    return null
  }
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      return (
        keys.length === value.length + 1 &&
        keys.includes('length') &&
        keys.every(
          (key) =>
            key === 'length' ||
            (typeof key === 'string' &&
              /^\d+$/u.test(key) &&
              Object.hasOwn(value, key) &&
              Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
              canonicalJson(value[Number(key)], ancestors)),
        )
      )
    }
    const keys = ownDataKeys(value)
    if (!keys) return false
    return keys.every((key) =>
      canonicalJson((value as Record<string, unknown>)[key], ancestors),
    )
  } finally {
    ancestors.delete(value)
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
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

function hash(value: unknown) {
  return sha256HexSync(stableJson(value))
}

function receiptId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function receiptHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value)
}

function forbiddenField(value: unknown, path = ''): string | null {
  if (
    typeof value === 'string' &&
    CREDENTIAL_SHAPED_ID.some((pattern) => pattern.test(value))
  )
    return path || '$'
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = forbiddenField(child, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const keys = ownDataKeys(value)
  if (!keys) return `${path || '$'}`
  for (const key of keys) {
    const normalized = key
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9]/gu, '')
      .toLowerCase()
    if (
      !SAFE_ID.test(key) ||
      FORBIDDEN_KEYS.has(normalized) ||
      FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
    )
      return `${path}.${key}`
    const found = forbiddenField(
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
    )
    if (found) return found
  }
  return null
}

function exactKeys(
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

function validChoice(value: unknown): value is ModelFallbackChoice {
  if (!receiptRecord(value)) return false
  return (
    exactKeys(value, ['candidateId'], ['associationId', 'order']) &&
    receiptId(value.candidateId) &&
    (!Object.hasOwn(value, 'associationId') ||
      receiptId(value.associationId)) &&
    (!Object.hasOwn(value, 'order') ||
      (typeof value.order === 'number' && Number.isFinite(value.order)))
  )
}

function validModel(value: unknown) {
  if (!receiptRecord(value)) return false
  return (
    exactKeys(value, [
      'providerId',
      'modelId',
      'modelVersion',
      'modelDigest',
    ]) &&
    receiptId(value.providerId) &&
    receiptId(value.modelId) &&
    receiptId(value.modelVersion) &&
    (receiptHash(value.modelDigest) || receiptId(value.modelDigest))
  )
}

function validConsultation(value: unknown): value is ModelConsultationRecord {
  if (!receiptRecord(value)) return false
  if (
    !exactKeys(
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
    ) ||
    value.schemaVersion !== MODEL_CONSULTATION_SCHEMA_VERSION ||
    !receiptHash(value.requestId) ||
    !receiptId(value.fixtureId) ||
    !receiptId(value.documentId) ||
    !receiptId(value.decisionId) ||
    !receiptId(value.decisionClass) ||
    !receiptHash(value.sourceSha256) ||
    !receiptRecord(value.inputs) ||
    !canonicalJson(value.inputs) ||
    forbiddenField(value.inputs) !== null ||
    !receiptHash(value.inputsHash) ||
    !validModel(value.model) ||
    !receiptHash(value.promptTemplateSha256) ||
    !receiptHash(value.promptHash) ||
    !['pending', 'accepted', 'rejected', 'failed'].includes(
      String(value.status),
    ) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length === 0 ||
    !value.candidates.every(
      (candidate) =>
        receiptRecord(candidate) &&
        receiptId(candidate.id) &&
        canonicalJson(candidate) &&
        forbiddenField(candidate) === null,
    ) ||
    !Array.isArray(value.candidateIds) ||
    value.candidateIds.length !== value.candidates.length ||
    value.candidateIds.some((id) => !receiptId(id)) ||
    value.candidateIds.some(
      (id, index) =>
        id !== (value.candidates as ModelFallbackCandidate[])[index]!.id,
    ) ||
    new Set(value.candidateIds).size !== value.candidateIds.length ||
    (!receiptRecord(value.choice) && value.choice !== null) ||
    (value.choice !== null && !validChoice(value.choice)) ||
    typeof value.costUsd !== 'number' ||
    !Number.isFinite(value.costUsd) ||
    (value.latencyMs !== null &&
      (typeof value.latencyMs !== 'number' ||
        !Number.isFinite(value.latencyMs))) ||
    (Object.hasOwn(value, 'failureCode') && !receiptId(value.failureCode))
  )
    return false

  const request = {
    schemaVersion: MODEL_CONSULTATION_SCHEMA_VERSION,
    documentId: value.documentId,
    decisionId: value.decisionId,
    decisionClass: value.decisionClass,
    sourceSha256: value.sourceSha256,
    inputs: value.inputs,
    candidates: value.candidates,
    promptTemplateSha256: value.promptTemplateSha256,
  }
  const expectedPromptHash = hash(request)
  const expectedFixtureId = `fixture-${hash({
    documentId: value.documentId,
    decisionId: value.decisionId,
    decisionClass: value.decisionClass,
    sourceSha256: value.sourceSha256,
    inputs: value.inputs,
    candidates: value.candidates,
  }).slice(0, 24)}`
  const expectedRequestId = hash({
    sourceSha256: value.sourceSha256,
    model: value.model,
    promptHash: value.promptHash,
    decisionClass: value.decisionClass,
    decisionId: value.decisionId,
  })
  return (
    value.inputsHash === hash(value.inputs) &&
    value.promptHash === expectedPromptHash &&
    value.fixtureId === expectedFixtureId &&
    value.requestId === expectedRequestId &&
    (value.status === 'accepted'
      ? validChoice(value.choice) &&
        value.candidates.some(
          ({ id }) => id === (value.choice as ModelFallbackChoice).candidateId,
        ) &&
        !Object.hasOwn(value, 'failureCode')
      : value.status === 'pending'
        ? value.choice === null && !Object.hasOwn(value, 'failureCode')
        : value.choice === null &&
          Object.hasOwn(value, 'failureCode') &&
          receiptId(value.failureCode))
  )
}

function validDecision(value: unknown): value is ModelDecisionMetricEvent {
  if (!receiptRecord(value)) return false
  const base = [
    'documentId',
    'decisionId',
    'decisionClass',
    'outcome',
    'consulted',
  ]
  if (
    !receiptId(value.documentId) ||
    !receiptId(value.decisionId) ||
    !receiptId(value.decisionClass) ||
    typeof value.consulted !== 'boolean'
  )
    return false
  if (value.outcome === 'deterministic')
    return (
      exactKeys(value, [...base, 'choice', 'deterministicRuleId']) &&
      !value.consulted &&
      receiptRecord(value.choice) &&
      exactKeys(value.choice, ['candidateId']) &&
      receiptId(value.choice.candidateId) &&
      receiptId(value.deterministicRuleId)
    )
  return (
    exactKeys(value, base) &&
    ((value.outcome === 'consulted' && value.consulted) ||
      (value.outcome === 'review-required' && !value.consulted))
  )
}

function validMetric(value: unknown): value is ModelConsultationMetric {
  if (!receiptRecord(value)) return false
  if (
    !exactKeys(value, [
      'decisionCount',
      'consultationCount',
      'consultationRate',
    ]) ||
    !Number.isInteger(value.decisionCount) ||
    !Number.isInteger(value.consultationCount) ||
    (value.decisionCount as number) < 0 ||
    (value.consultationCount as number) < 0 ||
    (value.consultationCount as number) > (value.decisionCount as number) ||
    typeof value.consultationRate !== 'number' ||
    !Number.isFinite(value.consultationRate)
  )
    return false
  return (
    value.consultationRate ===
    ((value.decisionCount as number) === 0
      ? 0
      : (value.consultationCount as number) / (value.decisionCount as number))
  )
}

/** Strict core validation for the closed, source-neutral receipt envelope. */
export function validateModelConsultationReceipt(
  receipt: unknown,
): receipt is ModelFallbackReceipt {
  if (
    !receiptRecord(receipt) ||
    !Array.isArray(receipt.consultations) ||
    receipt.consultations.length > MAX_RECEIPT_HISTORY_ITEMS ||
    !Array.isArray(receipt.decisions) ||
    receipt.decisions.length > MAX_RECEIPT_HISTORY_ITEMS ||
    !canonicalJson(receipt) ||
    !exactKeys(
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
    receipt.schemaVersion !== MODEL_CONSULTATION_SCHEMA_VERSION ||
    !receiptId(receipt.documentId) ||
    (receipt.sourceSha256 !== null && !receiptHash(receipt.sourceSha256)) ||
    !receipt.consultations.every(validConsultation) ||
    !receipt.decisions.every(validDecision) ||
    (receipt.semanticStateSha256 !== undefined &&
      !receiptHash(receipt.semanticStateSha256)) ||
    !receiptRecord(receipt.metrics) ||
    !exactKeys(receipt.metrics, [
      'totalDecisionCount',
      'totalConsultationCount',
      'consultationRate',
      'byDecisionClass',
    ]) ||
    !receiptRecord(receipt.metrics.byDecisionClass)
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

  const consultationCounts = new Map<string, number>()
  for (const consultation of receipt.consultations) {
    if (consultation.status === 'pending') continue
    const key = stableJson([
      consultation.documentId,
      consultation.decisionId,
      consultation.decisionClass,
    ])
    consultationCounts.set(key, (consultationCounts.get(key) ?? 0) + 1)
  }
  const consultedCounts = new Map<string, number>()
  for (const decision of receipt.decisions) {
    if (!decision.consulted) continue
    const key = stableJson([
      decision.documentId,
      decision.decisionId,
      decision.decisionClass,
    ])
    consultedCounts.set(key, (consultedCounts.get(key) ?? 0) + 1)
  }
  const keys = [
    ...new Set([...consultationCounts.keys(), ...consultedCounts.keys()]),
  ]
  if (
    keys.some((key) => consultationCounts.get(key) !== consultedCounts.get(key))
  )
    return false

  const classNames = Object.keys(receipt.metrics.byDecisionClass).sort()
  const decisionClasses = [
    ...new Set(receipt.decisions.map(({ decisionClass }) => decisionClass)),
  ].sort()
  if (JSON.stringify(classNames) !== JSON.stringify(decisionClasses))
    return false
  let decisionTotal = 0
  let consultationTotal = 0
  for (const decisionClass of classNames) {
    const metric = receipt.metrics.byDecisionClass[decisionClass]
    const events = receipt.decisions.filter(
      ({ decisionClass: value }) => value === decisionClass,
    )
    if (
      !validMetric(metric) ||
      metric.decisionCount !== events.length ||
      metric.consultationCount !==
        events.filter(({ consulted }) => consulted).length
    )
      return false
    decisionTotal += metric.decisionCount
    consultationTotal += metric.consultationCount
  }
  if (
    !validMetric({
      decisionCount: receipt.metrics.totalDecisionCount,
      consultationCount: receipt.metrics.totalConsultationCount,
      consultationRate: receipt.metrics.consultationRate,
    }) ||
    receipt.metrics.totalDecisionCount !== decisionTotal ||
    receipt.metrics.totalDecisionCount !== receipt.decisions.length ||
    receipt.metrics.totalConsultationCount !== consultationTotal
  )
    return false
  return true
}

export { HASH, SAFE_ID, hash, stableJson }
