/**
 * base64url helpers shared by the sealed session and the JWT verifier.
 *
 * Both run in the Worker runtime and under Vitest, so this sticks to
 * `atob`/`btoa` and `Uint8Array` rather than `Buffer`. Every decoder returns
 * `null` on malformed input instead of throwing: callers are validating
 * attacker-supplied strings and must fail closed, not crash.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null
  const padded = value
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

export function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Decodes a base64url JSON segment. Returns `null` for anything malformed. */
export function decodeJsonSegment(segment: string): unknown {
  const bytes = decodeBase64Url(segment)
  if (!bytes) return null
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown
  } catch {
    return null
  }
}

/** Length-independent-ish equality for short opaque strings such as `state`. */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = encodeUtf8(left)
  const b = encodeUtf8(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}
