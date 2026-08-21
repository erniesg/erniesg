export type DataObject = Record<string, unknown>
export type EnumValue<T extends readonly string[]> = T[number]

const CREDENTIAL_SHAPED_ID = [
  /^sk-(?:proj-)?[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:AKIA|ASIA)[A-Z0-9]{12,}$/u,
  /^bearer[.:-][A-Za-z0-9._:-]{8,}$/iu,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/u,
  /^(?:-----)?BEGIN[.:-]?(?:(?:RSA|EC|OPENSSH)[.:-]?)?PRIVATE[.:-]?KEY/iu,
  /^xox[baprs]-[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:gh[pousr]|github_pat)_/iu,
] as const
export const SAFE_ID = {
  test(value: string) {
    return (
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) &&
      !CREDENTIAL_SHAPED_ID.some((pattern) => pattern.test(value))
    )
  },
}
const HASH = /^[a-f0-9]{64}$/u
// JSON strings may contain tabs and line breaks. Reject the remaining C0
// controls and DEL without normalizing accepted whitespace.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const URL_CONTROL = /[\u0000-\u001f\u007f]/u

export class StructCodecError extends TypeError {
  readonly code: string
  readonly path: string

  constructor(code: string, path: string, message: string) {
    super(`STRUCT_CODEC_${code} at ${path}: ${message}`)
    this.name = 'StructCodecError'
    this.code = code
    this.path = path
  }
}

export function fail(code: string, path: string, message: string): never {
  throw new StructCodecError(code, path, message)
}

type Snapshot = { keys: string[]; values: DataObject }

function snapshotObject(value: unknown, path: string): Snapshot {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('TYPE', path, 'expected an object')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      fail('OBJECT', path, 'expected a plain object')
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string'))
      fail('FIELD', path, 'symbol fields are not permitted')
    const entries: Array<[string, unknown]> = []
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        fail(
          'FIELD',
          `${path}.${key}`,
          'accessor and non-enumerable fields are not permitted',
        )
      entries.push([key, descriptor.value])
    }
    return { keys: entries.map(([key]) => key), values: copyRecord(entries) }
  } catch (error) {
    if (error instanceof StructCodecError) throw error
    fail('OBJECT', path, 'object cannot be inspected safely')
  }
}

export function dataEntries(value: unknown, path: string) {
  const snapshot = snapshotObject(value, path)
  return snapshot.keys.map(
    (key) => [key, snapshot.values[key]] as [string, unknown],
  )
}

export function object(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): DataObject {
  const snapshot = snapshotObject(value, path)
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(snapshot.values, key))
      fail('REQUIRED', `${path}.${key}`, 'field is required')
  }
  for (const key of snapshot.keys) {
    if (!allowed.has(key))
      fail('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is not declared')
  }
  return snapshot.values
}

export function array(value: unknown, path: string): unknown[] {
  try {
    if (!Array.isArray(value)) fail('TYPE', path, 'expected an array')
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    const length = lengthDescriptor?.value
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      fail('ARRAY', path, 'array length is not a safe integer')
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== length + 1 ||
      !keys.includes('length') ||
      keys.some(
        (key) =>
          typeof key !== 'string' || (key !== 'length' && !/^\d+$/u.test(key)),
      )
    )
      fail('ARRAY', path, 'array must contain only indexed values')
    const entries: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        fail('ARRAY', `${path}[${index}]`, 'array item is not a data value')
      entries.push(descriptor.value)
    }
    return entries
  } catch (error) {
    if (error instanceof StructCodecError) throw error
    fail('ARRAY', path, 'array cannot be inspected safely')
  }
}

export function has(value: DataObject, key: string) {
  return Object.hasOwn(value, key)
}

export function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('TYPE', path, 'expected a string')
  if (CONTROL.test(value))
    fail('STRING', path, 'control characters are not permitted')
  return value
}

export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number') fail('TYPE', path, 'expected a number')
  if (!Number.isFinite(value))
    fail('NON_FINITE_NUMBER', path, 'number must be finite')
  return value
}

export function integer(
  value: unknown,
  path: string,
  minimum?: number,
): number {
  const parsed = finiteNumber(value, path)
  if (!Number.isSafeInteger(parsed))
    fail('NUMBER', path, 'number must be a safe integer')
  if (minimum !== undefined && parsed < minimum)
    fail('NUMBER', path, `number must be at least ${minimum}`)
  return parsed
}

export function nonNegativeInteger(value: unknown, path: string) {
  return integer(value, path, 0)
}

export function positiveInteger(value: unknown, path: string) {
  return integer(value, path, 1)
}

export function nonNegativeNumber(value: unknown, path: string) {
  const parsed = finiteNumber(value, path)
  if (parsed < 0) fail('RANGE', path, 'number must be non-negative')
  return parsed
}

export function positiveNumber(value: unknown, path: string) {
  const parsed = finiteNumber(value, path)
  if (parsed <= 0) fail('RANGE', path, 'number must be positive')
  return parsed
}

export function rotation(value: unknown, path: string) {
  const parsed = integer(value, path, 0)
  if (parsed >= 360)
    fail('RANGE', path, 'rotation must be less than 360 degrees')
  return parsed
}

export function unitInterval(value: unknown, path: string) {
  const parsed = finiteNumber(value, path)
  if (parsed < 0 || parsed > 1)
    fail('RANGE', path, 'number must be between 0 and 1')
  return parsed
}

export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('TYPE', path, 'expected a boolean')
  return value
}

export function nullable<T>(
  value: unknown,
  path: string,
  parser: (value: unknown, path: string) => T,
) {
  return value === null ? null : parser(value, path)
}

export function enumValue<T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
): EnumValue<T> {
  const parsed = stringValue(value, path)
  if (!allowed.includes(parsed))
    fail('ENUM', path, `unexpected value ${JSON.stringify(parsed)}`)
  return parsed as EnumValue<T>
}

export function identifier(value: unknown, path: string): string {
  const parsed = stringValue(value, path)
  if (!SAFE_ID.test(parsed))
    fail('IDENTIFIER', path, 'identifier is not canonical')
  return parsed
}

export function identifierList(
  value: unknown,
  path: string,
  allowEmpty = true,
): string[] {
  const values = array(value, path).map((entry, index) =>
    identifier(entry, `${path}[${index}]`),
  )
  if (!allowEmpty && values.length === 0)
    fail('ARRAY', path, 'list cannot be empty')
  unique(values, path, 'identifier')
  return values
}

export function reference(value: unknown, path: string): string {
  const parsed = stringValue(value, path)
  if (URL_CONTROL.test(parsed))
    fail('REFERENCE', path, 'reference must not contain control characters')
  if (SAFE_ID.test(parsed)) return parsed
  if (/^#[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(parsed)) return parsed
  try {
    const url = new URL(parsed)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol))
      throw new Error()
    if (url.username || url.password) throw new Error()
    return parsed
  } catch {
    fail(
      'REFERENCE',
      path,
      'reference must be a canonical id, fragment, or safe URL',
    )
  }
}

export function referenceList(value: unknown, path: string): string[] {
  const values = array(value, path).map((entry, index) =>
    reference(entry, `${path}[${index}]`),
  )
  unique(values, path, 'reference')
  return values
}

export function hash(value: unknown, path: string): string {
  const parsed = stringValue(value, path)
  if (!HASH.test(parsed))
    fail('HASH', path, 'expected a lowercase SHA-256 digest')
  return parsed
}

export function unique(values: readonly string[], path: string, label: string) {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value))
      fail('DUPLICATE_IDENTIFIER', path, `duplicate ${label} ${value}`)
    seen.add(value)
  }
}

export function copyRecord(entries: readonly [string, unknown][]) {
  const target: DataObject = {}
  for (const [key, value] of entries) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return target
}
