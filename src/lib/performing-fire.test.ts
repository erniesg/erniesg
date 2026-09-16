import { describe, expect, it } from 'vitest'

import { createEmberField, normalizeFragment } from './performing-fire'

describe('normalizeFragment', () => {
  it('turns a visitor contribution into a compact trace', () => {
    expect(normalizeFragment('  We choose\n\n many   futures.  ')).toBe(
      'We choose many futures.',
    )
  })

  it('preserves silence as a meaningful contribution', () => {
    expect(normalizeFragment(' \n\t ')).toBe('silence')
  })
})

describe('createEmberField', () => {
  it('maps the same fragment to the same particle field', () => {
    expect(createEmberField('uncertain futures', 8)).toEqual(
      createEmberField('uncertain futures', 8),
    )
  })

  it('keeps ember properties within renderable bounds', () => {
    const embers = createEmberField('contradiction', 32)

    expect(embers).toHaveLength(32)
    for (const ember of embers) {
      expect(ember.x).toBeGreaterThanOrEqual(0)
      expect(ember.x).toBeLessThanOrEqual(1)
      expect(ember.y).toBeGreaterThanOrEqual(0)
      expect(ember.y).toBeLessThanOrEqual(1)
      expect(ember.radius).toBeGreaterThanOrEqual(0.8)
      expect(ember.radius).toBeLessThanOrEqual(3.2)
      expect(ember.speed).toBeGreaterThanOrEqual(0.2)
      expect(ember.speed).toBeLessThanOrEqual(1.4)
      expect(ember.life).toBeGreaterThanOrEqual(0.45)
      expect(ember.life).toBeLessThanOrEqual(1)
    }
  })

  it('gives different fragments different particle fields', () => {
    expect(createEmberField('hope', 4)).not.toEqual(createEmberField('fear', 4))
  })
})
