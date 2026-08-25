import {
  credentialShapedValue,
  SAFE_ID,
} from './ids'

/**
 * Source-neutral, serialized consultation receipt envelope.
 *
 * The contents of consultations, decisions, and metrics belong to an
 * application adapter. STRUCT only snapshots them as closed canonical JSON
 * and binds the envelope to its enclosing document and source.
 */
export type StructConsultationReceipt = {
  schemaVersion: string
  documentId: string
  sourceSha256: string | null
  consultations: readonly Record<string, unknown>[]
  decisions: readonly Record<string, unknown>[]
  metrics: Record<string, unknown>
  semanticStateSha256?: string
}

const HASH = /^[a-f0-9]{64}$/u
const STRUCT_CONSULTATION_RECEIPT_SCHEMA_VERSION = '1.0.0'
const MAX_DEPTH = 128
const MAX_NODES = 100_000
const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'documentId',
  'sourceSha256',
  'consultations',
  'decisions',
  'metrics',
  'semanticStateSha256',
] as const
const FORBIDDEN_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'credential',
  'password',
  'privatekey',
  'secret',
  'token',
] as const

function normalizedKey(key: string) {
  return key.normalize('NFKC').replace(/[^A-Za-z0-9]/gu, '').toLowerCase()
}

function forbiddenKey(key: string) {
  const normalized = normalizedKey(key)
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  )
}

function canonicalJson(
  value: unknown,
  active: WeakSet<object>,
  state: { nodes: number },
  depth: number,
): value is Record<string, unknown> | unknown[] | string | number | boolean | null {
  if (depth > MAX_DEPTH) return false
  state.nodes += 1
  if (state.nodes > MAX_NODES) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return !credentialShapedValue(value)
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || active.has(value)) return false

  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor?.value
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_NODES - state.nodes
      )
        return false
      const keys = Reflect.ownKeys(value)
      if (
        keys.length !== length + 1 ||
        !keys.includes('length') ||
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && !/^\d+$/u.test(key)),
        )
      )
        return false
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          !canonicalJson(descriptor.value, active, state, depth + 1)
        )
          return false
      }
      return true
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_NODES - state.nodes) return false
    for (const key of keys) {
      if (typeof key !== 'string' || !SAFE_ID.test(key) || forbiddenKey(key))
        return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        !canonicalJson(descriptor.value, active, state, depth + 1)
      )
        return false
    }
    return true
  } finally {
    active.delete(value)
  }
}

function exactTopLevelKeys(value: Record<string, unknown>) {
  const keys = Object.keys(value).sort()
  const allowed = TOP_LEVEL_KEYS.filter((key) => Object.hasOwn(value, key)).sort()
  return JSON.stringify(keys) === JSON.stringify(allowed)
}

/** Validate only the generic closed receipt envelope. */
function validateStructConsultationReceiptUnsafe(
  value: unknown,
): value is StructConsultationReceipt {
  if (!canonicalJson(value, new WeakSet<object>(), { nodes: 0 }, 0)) return false
  if (!value || Array.isArray(value) || typeof value !== 'object') return false
  const receipt = value as Record<string, unknown>
  if (!exactTopLevelKeys(receipt)) return false
  if (
    typeof receipt.schemaVersion !== 'string' ||
    receipt.schemaVersion !== STRUCT_CONSULTATION_RECEIPT_SCHEMA_VERSION ||
    typeof receipt.documentId !== 'string' ||
    !SAFE_ID.test(receipt.documentId) ||
    (receipt.sourceSha256 !== null &&
      (typeof receipt.sourceSha256 !== 'string' ||
        !HASH.test(receipt.sourceSha256))) ||
    !Array.isArray(receipt.consultations) ||
    !Array.isArray(receipt.decisions) ||
    !receipt.metrics ||
    typeof receipt.metrics !== 'object' ||
    Array.isArray(receipt.metrics) ||
    (receipt.semanticStateSha256 !== undefined &&
      (typeof receipt.semanticStateSha256 !== 'string' ||
        !HASH.test(receipt.semanticStateSha256)))
  )
    return false
  for (const member of [...receipt.consultations, ...receipt.decisions]) {
    if (
      !member ||
      typeof member !== 'object' ||
      Array.isArray(member) ||
      (Object.getPrototypeOf(member) !== Object.prototype &&
        Object.getPrototypeOf(member) !== null)
    )
      return false
  }
  return true
}

export function validateStructConsultationReceipt(value: unknown): value is StructConsultationReceipt {
  try {
    return validateStructConsultationReceiptUnsafe(value)
  } catch {
    return false
  }
}
