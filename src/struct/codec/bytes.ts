import {
  array,
  fail,
  integer,
  stringValue,
  StructCodecError,
} from './primitives'

function isCanonicalUint8Array(value: unknown): value is Uint8Array {
  if (
    !ArrayBuffer.isView(value) ||
    Object.prototype.toString.call(value) !== '[object Uint8Array]'
  )
    return false
  const bytes = value as Uint8Array
  const prototype = Object.getPrototypeOf(bytes)
  if (prototype === null) return false
  const prototypeKeys = Reflect.ownKeys(prototype)
  if (
    prototypeKeys.length !== 2 ||
    !prototypeKeys.includes('constructor') ||
    !prototypeKeys.includes('BYTES_PER_ELEMENT')
  )
    return false
  const constructor = Object.getOwnPropertyDescriptor(
    prototype,
    'constructor',
  )?.value
  if (
    typeof constructor !== 'function' ||
    constructor.prototype !== prototype ||
    Object.getOwnPropertyDescriptor(prototype, 'BYTES_PER_ELEMENT')?.value !== 1
  )
    return false
  if (
    Function.prototype.toString.call(constructor) !==
    Function.prototype.toString.call(Uint8Array)
  )
    return false
  const ownKeys = Reflect.ownKeys(bytes)
  if (ownKeys.length !== bytes.length) return false
  return ownKeys.every(
    (key) =>
      typeof key === 'string' &&
      /^(?:0|[1-9]\d*)$/u.test(key) &&
      Number(key) < bytes.length,
  )
}

export function parseBytes(value: unknown, path: string): Uint8Array {
  try {
    if (ArrayBuffer.isView(value)) {
      if (!isCanonicalUint8Array(value))
        fail('BYTES', path, 'bytes must be a canonical Uint8Array')
      return new Uint8Array(value)
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
