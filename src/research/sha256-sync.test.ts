import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256-sync'

const VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    '你好, 🌍',
    '9325c9ce3c402322c241a9eb4abd9ea64b557db848e60d458e67d26e6cac3ded',
  ],
] as const

describe('browser-safe synchronous SHA-256', () => {
  it.each(VECTORS)('matches the fixed vector for %j', (input, expected) => {
    expect(sha256HexSync(input)).toBe(expected)
    expect(sha256HexSync(new TextEncoder().encode(input))).toBe(expected)
  })

  it.each(VECTORS)(
    'matches node:crypto for the same UTF-8 bytes (%j)',
    (input) => {
      expect(sha256HexSync(input)).toBe(
        createHash('sha256').update(input, 'utf8').digest('hex'),
      )
    },
  )
})
