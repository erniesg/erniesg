import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Sync } from './epub-manifest-evidence'

describe('EPUB manifest evidence', () => {
  it('serializes nested receipt values with deterministic object key order', () => {
    expect(
      canonicalJson({
        z: 1,
        a: [3, { b: true, a: null }],
      }),
    ).toBe('{"a":[3,{"a":null,"b":true}],"z":1}')
  })

  it('hashes manifest bytes with standard SHA-256 output', () => {
    expect(sha256Sync(strToU8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
