import { sha256HexSync } from './sha256.js'
import { dataEntries, fail, finiteNumber } from './codec/primitives.js'

export const MODEL_CONSULTATION_SCHEMA_VERSION = '1.0.0' as const
export const MODEL_FALLBACK_SCHEMA_VERSION = MODEL_CONSULTATION_SCHEMA_VERSION

export type ModelFallbackDecisionClass = string
export type ModelFallbackCandidate = { id: string; [key: string]: unknown }
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
  decisionClass: string
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
  decisionClass: string
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
  byDecisionClass: Record<string, ModelConsultationMetric>
}
export type ModelFallbackReceipt = {
  schemaVersion: typeof MODEL_CONSULTATION_SCHEMA_VERSION
  documentId: string
  sourceSha256: string | null
  consultations: ModelConsultationRecord[]
  decisions: ModelDecisionMetricEvent[]
  metrics: ModelConsultationMetrics
  semanticStateSha256?: string
}

const HASH = /^[a-f0-9]{64}$/u
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
const MAX_RECEIPT_HISTORY_ITEMS = 100_000
const forbiddenKeys = new Set([
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
const forbiddenFragments = [
  'apikey',
  'authorization',
  'credential',
  'passphrase',
  'password',
  'privatekey',
  'secret',
]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function ownKeys(value: object) {
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) return null
    if (
      (keys as string[]).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      })
    )
      return null
    return keys as string[]
  } catch {
    return null
  }
}

function canonical(value: unknown, ancestors = new Set<object>()): boolean {
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
              canonical(value[Number(key)], ancestors)),
        )
      )
    }
    const keys = ownKeys(value)
    if (!keys) return false
    return keys.every((key) =>
      canonical((value as Record<string, unknown>)[key], ancestors),
    )
  } finally {
    ancestors.delete(value)
  }
}

export function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
  if (value instanceof Uint8Array)
    return JSON.stringify({ sha256: sha256HexSync(value) })
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value)
}

export function hash(value: unknown) {
  return sha256HexSync(stableJson(value))
}

function id(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value)
}
function exact(
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
function forbidden(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = forbidden(child)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const keys = ownKeys(value)
  if (!keys) return '$'
  for (const key of keys) {
    const normalized = key
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9]/gu, '')
      .toLowerCase()
    if (
      forbiddenKeys.has(key) ||
      forbiddenFragments.some((fragment) => normalized.includes(fragment))
    )
      return key
    const found = forbidden((value as Record<string, unknown>)[key])
    if (found) return found
  }
  return null
}

export function copyCanonicalJson(
  value: unknown,
  path: string,
  active = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth > 128)
    fail('MODEL_RECEIPT', path, 'canonical JSON nesting is too deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number') return finiteNumber(value, path)
  if (!value || typeof value !== 'object')
    fail('TYPE', path, 'model receipt must contain canonical JSON values')
  if (active.has(value))
    fail('MODEL_RECEIPT', path, 'cycles are not permitted in model receipts')
  active.add(value)
  try {
    if (Array.isArray(value))
      return value.map((entry, index) =>
        copyCanonicalJson(entry, `${path}[${index}]`, active, depth + 1),
      )
    return Object.fromEntries(
      dataEntries(value, path)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [
          key,
          copyCanonicalJson(entry, `${path}.${key}`, active, depth + 1),
        ]),
    )
  } finally {
    active.delete(value)
  }
}
function validChoice(value: unknown): value is ModelFallbackChoice {
  return (
    record(value) &&
    exact(value, ['candidateId'], ['associationId', 'order']) &&
    id(value.candidateId) &&
    (!Object.hasOwn(value, 'associationId') || id(value.associationId)) &&
    (!Object.hasOwn(value, 'order') ||
      (typeof value.order === 'number' && Number.isFinite(value.order)))
  )
}
function validModel(value: unknown) {
  return (
    record(value) &&
    exact(value, ['providerId', 'modelId', 'modelVersion', 'modelDigest']) &&
    id(value.providerId) &&
    id(value.modelId) &&
    id(value.modelVersion) &&
    (digest(value.modelDigest) || id(value.modelDigest))
  )
}
function validConsultation(value: unknown): value is ModelConsultationRecord {
  if (!record(value)) return false
  if (
    !exact(
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
    !digest(value.requestId) ||
    !id(value.fixtureId) ||
    !id(value.documentId) ||
    !id(value.decisionId) ||
    !id(value.decisionClass) ||
    !digest(value.sourceSha256) ||
    !record(value.inputs) ||
    !canonical(value.inputs) ||
    forbidden(value.inputs) !== null ||
    !digest(value.inputsHash) ||
    !validModel(value.model) ||
    !digest(value.promptTemplateSha256) ||
    !digest(value.promptHash) ||
    !['pending', 'accepted', 'rejected', 'failed'].includes(
      String(value.status),
    ) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length === 0 ||
    !value.candidates.every(
      (candidate) =>
        record(candidate) &&
        id(candidate.id) &&
        canonical(candidate) &&
        forbidden(candidate) === null,
    ) ||
    !Array.isArray(value.candidateIds) ||
    value.candidateIds.length !== (value.candidates as unknown[]).length ||
    value.candidateIds.some((candidateId) => !id(candidateId)) ||
    value.candidateIds.some(
      (candidateId, index) =>
        candidateId !==
        (value.candidates as ModelFallbackCandidate[])[index]!.id,
    ) ||
    new Set(value.candidateIds).size !== value.candidateIds.length ||
    (value.choice !== null && !validChoice(value.choice)) ||
    typeof value.costUsd !== 'number' ||
    !Number.isFinite(value.costUsd) ||
    (value.latencyMs !== null &&
      (typeof value.latencyMs !== 'number' ||
        !Number.isFinite(value.latencyMs))) ||
    (Object.hasOwn(value, 'failureCode') && !id(value.failureCode))
  )
    return false
  const promptInput = {
    schemaVersion: MODEL_CONSULTATION_SCHEMA_VERSION,
    documentId: value.documentId,
    decisionId: value.decisionId,
    decisionClass: value.decisionClass,
    sourceSha256: value.sourceSha256,
    inputs: value.inputs,
    candidates: value.candidates,
    promptTemplateSha256: value.promptTemplateSha256,
  }
  return (
    value.inputsHash === hash(value.inputs) &&
    value.promptHash === hash(promptInput) &&
    value.fixtureId ===
      `fixture-${hash({
        documentId: value.documentId,
        decisionId: value.decisionId,
        decisionClass: value.decisionClass,
        sourceSha256: value.sourceSha256,
        inputs: value.inputs,
        candidates: value.candidates,
      }).slice(0, 24)}` &&
    value.requestId ===
      hash({
        sourceSha256: value.sourceSha256,
        model: value.model,
        promptHash: value.promptHash,
        decisionClass: value.decisionClass,
        decisionId: value.decisionId,
      }) &&
    (value.status === 'accepted'
      ? validChoice(value.choice) &&
        value.candidates.some(
          ({ id: candidateId }) =>
            (value.choice as ModelFallbackChoice).candidateId === candidateId,
        ) &&
        !Object.hasOwn(value, 'failureCode')
      : value.status === 'pending'
        ? value.choice === null && !Object.hasOwn(value, 'failureCode')
        : value.choice === null &&
          Object.hasOwn(value, 'failureCode') &&
          id(value.failureCode))
  )
}
function validDecision(value: unknown): value is ModelDecisionMetricEvent {
  if (!record(value)) return false
  if (
    !id(value.documentId) ||
    !id(value.decisionId) ||
    !id(value.decisionClass) ||
    typeof value.consulted !== 'boolean'
  )
    return false
  const base = [
    'documentId',
    'decisionId',
    'decisionClass',
    'outcome',
    'consulted',
  ]
  if (value.outcome === 'deterministic')
    return (
      exact(value, [...base, 'choice', 'deterministicRuleId']) &&
      !value.consulted &&
      record(value.choice) &&
      exact(value.choice, ['candidateId']) &&
      id(value.choice.candidateId) &&
      id(value.deterministicRuleId)
    )
  return (
    exact(value, base) &&
    ((value.outcome === 'consulted' && value.consulted) ||
      (value.outcome === 'review-required' && !value.consulted))
  )
}
function validMetric(value: unknown): value is ModelConsultationMetric {
  if (!record(value)) return false
  if (
    !exact(value, ['decisionCount', 'consultationCount', 'consultationRate']) ||
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

export function validateModelConsultationReceipt(
  receipt: unknown,
): receipt is ModelFallbackReceipt {
  if (
    !record(receipt) ||
    !Array.isArray(receipt.consultations) ||
    receipt.consultations.length > MAX_RECEIPT_HISTORY_ITEMS ||
    !Array.isArray(receipt.decisions) ||
    receipt.decisions.length > MAX_RECEIPT_HISTORY_ITEMS ||
    !canonical(receipt) ||
    !exact(
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
    !id(receipt.documentId) ||
    (receipt.sourceSha256 !== null && !digest(receipt.sourceSha256)) ||
    !receipt.consultations.every(validConsultation) ||
    !receipt.decisions.every(validDecision) ||
    (receipt.semanticStateSha256 !== undefined &&
      !digest(receipt.semanticStateSha256)) ||
    !record(receipt.metrics) ||
    !exact(receipt.metrics, [
      'totalDecisionCount',
      'totalConsultationCount',
      'consultationRate',
      'byDecisionClass',
    ]) ||
    !record(receipt.metrics.byDecisionClass)
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
  if (
    [
      ...new Set([...consultationCounts.keys(), ...consultedCounts.keys()]),
    ].some((key) => consultationCounts.get(key) !== consultedCounts.get(key))
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
  return (
    validMetric({
      decisionCount: receipt.metrics.totalDecisionCount,
      consultationCount: receipt.metrics.totalConsultationCount,
      consultationRate: receipt.metrics.consultationRate,
    }) &&
    receipt.metrics.totalDecisionCount === decisionTotal &&
    receipt.metrics.totalDecisionCount === receipt.decisions.length &&
    receipt.metrics.totalConsultationCount === consultationTotal
  )
}

export { HASH, SAFE_ID }
