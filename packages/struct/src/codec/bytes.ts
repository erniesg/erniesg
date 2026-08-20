import {
  array,
  fail,
  integer,
  stringValue,
  StructCodecError,
} from './primitives.js'

const uint8ArrayPrototype = Uint8Array.prototype
const typedArrayPrototype = Object.getPrototypeOf(uint8ArrayPrototype)
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'length',
)?.get

function copyCanonicalUint8Array(value: unknown): Uint8Array | undefined {
  if (!ArrayBuffer.isView(value)) return undefined
  const bytes = value as Uint8Array
  if (
    typedArrayTagGetter === undefined ||
    Reflect.apply(typedArrayTagGetter, bytes, []) !== 'Uint8Array' ||
    typedArrayLengthGetter === undefined
  )
    return undefined
  const length = Reflect.apply(typedArrayLengthGetter, bytes, [])
  const ownKeys = Reflect.ownKeys(bytes)
  if (ownKeys.length !== length) return undefined
  if (
    !ownKeys.every(
      (key) =>
        typeof key === 'string' &&
        /^(?:0|[1-9]\d*)$/u.test(key) &&
        Number(key) < length,
    )
  )
    return undefined
  for (const key of ownKeys)
    if (Object.getOwnPropertyDescriptor(bytes, key) === undefined)
      return undefined
  let snapshot: Uint8Array
  try {
    snapshot = new Uint8Array(bytes)
  } catch {
    return undefined
  }
  if (Object.getPrototypeOf(bytes) !== uint8ArrayPrototype) return undefined
  const finalKeys = Reflect.ownKeys(bytes)
  if (
    finalKeys.length !== ownKeys.length ||
    finalKeys.some((key, index) => key !== ownKeys[index])
  )
    return undefined
  for (let index = 0; index < length; index += 1)
    if (snapshot[index] !== bytes[index]) return undefined
  return snapshot
}

export function parseBytes(value: unknown, path: string): Uint8Array {
  try {
    if (ArrayBuffer.isView(value)) {
      const bytes = copyCanonicalUint8Array(value)
      if (bytes === undefined)
        fail('BYTES', path, 'bytes must be a canonical Uint8Array')
      return bytes
    }
    if (Array.isArray(value)) {
      const bytes = array(value, path).map((entry, index) => {
        const byte = integer(entry, `${path}[${index}]`, 0)
        if (byte > 255)
          fail('BYTES', `${path}[${index}]`, 'byte must be between 0 and 255')
        return byte
      })
      return new Uint8Array(bytes)
    }
    const encoded = stringValue(value, path)
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded,
      )
    )
      fail('BYTES', path, 'bytes must use canonical base64')
    if (encoded.length === 0) return new Uint8Array()
    const output = new Uint8Array(
      (encoded.length / 4) * 3 -
        (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0),
    )
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let offset = 0
    for (let index = 0; index < encoded.length; index += 4) {
      const first = alphabet.indexOf(encoded[index]!)
      const second = alphabet.indexOf(encoded[index + 1]!)
      const third =
        encoded[index + 2] === '=' ? 0 : alphabet.indexOf(encoded[index + 2]!)
      const fourth =
        encoded[index + 3] === '=' ? 0 : alphabet.indexOf(encoded[index + 3]!)
      if (first < 0 || second < 0 || third < 0 || fourth < 0)
        fail('BYTES', path, 'bytes must use canonical base64')
      if (
        (encoded[index + 2] === '=' && (second & 0x0f) !== 0) ||
        (encoded[index + 3] === '=' &&
          encoded[index + 2] !== '=' &&
          (third & 0x03) !== 0)
      )
        fail('BYTES', path, 'bytes must use canonical base64')
      const word = (first << 18) | (second << 12) | (third << 6) | fourth
      if (offset < output.length) output[offset++] = (word >> 16) & 0xff
      if (offset < output.length) output[offset++] = (word >> 8) & 0xff
      if (offset < output.length) output[offset++] = word & 0xff
    }
    return output
  } catch (error) {
    if (error instanceof StructCodecError) throw error
    fail('BYTES', path, 'bytes cannot be inspected safely')
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = index + 1 < bytes.length ? bytes[index + 1]! : 0
    const third = index + 2 < bytes.length ? bytes[index + 2]! : 0
    const word = (first << 16) | (second << 8) | third
    encoded += alphabet[(word >> 18) & 0x3f]
    encoded += alphabet[(word >> 12) & 0x3f]
    encoded += index + 1 < bytes.length ? alphabet[(word >> 6) & 0x3f] : '='
    encoded += index + 2 < bytes.length ? alphabet[word & 0x3f] : '='
  }
  return encoded
}
