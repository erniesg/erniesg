import { describe, expect, it } from 'vitest'
import { orderCanonicalVisualPairs as legacyOrderCanonicalVisualPairs } from './pdf-layout'
import { orderCanonicalVisualPairs } from './pdf-visual-order'

describe('pdf-layout compatibility exports', () => {
  it('preserves the canonical visual ordering function binding', () => {
    expect(legacyOrderCanonicalVisualPairs).toBe(orderCanonicalVisualPairs)
  })
})
