import { describe, expect, it } from 'vitest'
import {
  TARGET_PROFILE_IDS,
  getTargetProfile,
  resolveTargetProfile,
} from '../research/targets'
import {
  COMPOSITION_CONTEXT_PRESETS,
  compositionContextSchema,
  compositionContextToTargetProfile,
  targetProfileToCompositionContext,
} from './profiles'

describe('CompositionContext profiles', () => {
  it('derives every named preset from the one target-profile registry losslessly', () => {
    expect(Object.keys(COMPOSITION_CONTEXT_PRESETS)).toEqual(TARGET_PROFILE_IDS)
    for (const id of TARGET_PROFILE_IDS) {
      const profile = getTargetProfile(id)
      const context = targetProfileToCompositionContext(profile)
      expect(compositionContextSchema.parse(context)).toEqual(context)
      expect(compositionContextToTargetProfile(context)).toEqual(profile)
    }
  })

  it('round-trips orientation without a second geometry authority', () => {
    for (const id of ['paperProMove', 'paperPro', 'print'] as const) {
      const profile = resolveTargetProfile(id, 'landscape')
      expect(
        compositionContextToTargetProfile(
          targetProfileToCompositionContext(profile),
        ),
      ).toEqual(profile)
    }
  })

  it('rejects invalid units, ranges and drift from the registry', () => {
    const invalid: any = structuredClone(COMPOSITION_CONTEXT_PRESETS.print)
    invalid.logicalDimensions.width += 1
    expect(() => compositionContextToTargetProfile(invalid)).toThrow(
      /authoritative/,
    )
    invalid.logicalDimensions.unit = 'points'
    expect(compositionContextSchema.safeParse(invalid).success).toBe(false)
  })
})
