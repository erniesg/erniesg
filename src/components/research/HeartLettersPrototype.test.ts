import { describe, expect, it } from 'vitest'
import { mappedTempo } from './HeartLettersPrototype'

describe('heart-letter tempo mapping', () => {
  it('maps the documented heart-rate range to the documented sound range', () => {
    expect(mappedTempo(60)).toBe(65)
    expect(mappedTempo(90)).toBe(80)
    expect(mappedTempo(120)).toBe(95)
  })

  it('clamps live sensor readings outside the documented range', () => {
    expect(mappedTempo(35)).toBe(65)
    expect(mappedTempo(220)).toBe(95)
  })
})
