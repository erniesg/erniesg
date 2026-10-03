import { describe, expect, it } from 'vitest'

import { prefixByCodePoints } from './text.js'

describe('prefixByCodePoints', () => {
  it('never splits a character made of two UTF-16 units', () => {
    const text = `${'a'.repeat(159)}😀 and more`
    const prefix = prefixByCodePoints(text, 160)
    expect(prefix).toBe(`${'a'.repeat(159)}😀`)
    expect(prefix.isWellFormed()).toBe(true)
    // A UTF-16 slice at the same length leaves a lone surrogate.
    expect(text.slice(0, 160).isWellFormed()).toBe(false)
  })

  it('returns short text whole', () => {
    expect(prefixByCodePoints('short', 160)).toBe('short')
  })
})
