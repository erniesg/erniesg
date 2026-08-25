import {
  array,
  copyRecord,
  dataEntries,
  fail,
  finiteNumber,
  isStructCodecError,
} from './primitives'
import { validateStructConsultationReceipt } from '../consultation-receipt'

const MAX_CANONICAL_DEPTH = 128
const MAX_CANONICAL_NODES = 100_000

type CopyState = {
  active: WeakSet<object>
  nodes: number
}

/**
 * Snapshot the open JSON portions of a consultation receipt before validation. This
 * rejects accessors/proxies, detects cycles, and bounds recursive input while
 * preserving the adapter-owned receipt contents as intentionally closed JSON.
 */
export function copyCanonicalJson(
  value: unknown,
  path: string,
  state: CopyState = { active: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): unknown {
  if (depth > MAX_CANONICAL_DEPTH)
    fail('MODEL_RECEIPT', path, 'canonical JSON nesting is too deep')
  state.nodes += 1
  if (state.nodes > MAX_CANONICAL_NODES)
    fail('MODEL_RECEIPT', path, 'canonical JSON exceeds the node bound')
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number') return finiteNumber(value, path)
  if (typeof value !== 'object')
    fail('TYPE', path, 'consultation receipt must contain canonical JSON values')
  if (state.active.has(value))
    fail('MODEL_RECEIPT', path, 'cycles are not permitted in consultation receipts')
  state.active.add(value)
  try {
    let isArray = false
    try {
      isArray = Array.isArray(value)
    } catch {
      fail(
        'MODEL_RECEIPT',
        path,
        'model receipt object cannot be inspected safely',
      )
    }
    if (isArray) {
      let prototype: object | null
      try {
        prototype = Object.getPrototypeOf(value)
      } catch {
        fail(
          'MODEL_RECEIPT',
          path,
          'model receipt array cannot be inspected safely',
        )
      }
      if (prototype !== Array.prototype)
        fail(
          'MODEL_RECEIPT',
          path,
          'model receipt arrays must use the canonical Array.prototype',
        )
      return array(value, path).map((entry, index) =>
        copyCanonicalJson(entry, `${path}[${index}]`, state, depth + 1),
      )
    }
    const entries = dataEntries(value, path).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return copyRecord(
      entries.map(([key, entry]) => [
        key,
        copyCanonicalJson(entry, `${path}.${key}`, state, depth + 1),
      ]),
    )
  } finally {
    state.active.delete(value)
  }
}

export function validateConsultationReceipt(value: unknown, path: string) {
  try {
    if (!validateStructConsultationReceipt(value))
      fail('MODEL_RECEIPT', path, 'invalid closed consultation receipt')
  } catch (error) {
    if (isStructCodecError(error)) throw error
    fail('MODEL_RECEIPT', path, 'invalid model consultation receipt')
  }
}
