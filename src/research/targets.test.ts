import { describe, expect, it } from 'vitest'
import {
  getPreviewMetrics,
  TARGET_PROFILES,
  TARGET_PROFILE_IDS,
} from './targets'
import { targetProfileSchema } from './target-schema'

describe('SRT target profiles', () => {
  it('defines the four target classes with complete, validated constraints', () => {
    expect(Object.keys(TARGET_PROFILES)).toEqual(TARGET_PROFILE_IDS)

    for (const id of TARGET_PROFILE_IDS) {
      const profile = TARGET_PROFILES[id]
      expect(targetProfileSchema.parse(profile)).toEqual(profile)
      expect(profile.dimensions.width).toBeGreaterThan(0)
      expect(profile.margins).toMatchObject({ unit: profile.dimensions.unit })
      expect(profile.typography.bodySizeCssPx).toBeGreaterThan(0)
      expect(profile.columns.count).toBeGreaterThan(0)
      expect(profile.interactionMode).toBeTruthy()
      expect(profile.finiteHeight).toBe(profile.dimensions.height !== null)
    }
  })

  it('keeps native device and A4 dimensions separate from scaled studio previews', () => {
    expect(TARGET_PROFILES.paperPro.dimensions).toEqual({
      width: 1620,
      height: 2160,
      unit: 'device-px',
    })
    expect(TARGET_PROFILES.paperProMove.dimensions).toEqual({
      width: 954,
      height: 1696,
      unit: 'device-px',
    })
    expect(TARGET_PROFILES.print.dimensions).toEqual({
      width: 210,
      height: 297,
      unit: 'mm',
    })
    expect(TARGET_PROFILES.mobile.dimensions).toEqual({
      width: 390,
      height: null,
      unit: 'css-px',
    })

    expect(getPreviewMetrics(TARGET_PROFILES.paperPro)).toMatchObject({
      widthCssPx: 540,
      minHeightCssPx: 720,
    })
  })

  it('rejects profiles whose finite-height capability contradicts their dimensions', () => {
    const invalid = structuredClone(TARGET_PROFILES.mobile)
    invalid.finiteHeight = true

    expect(targetProfileSchema.safeParse(invalid).success).toBe(false)
  })

  it('keeps every preview in one semantic flow until pagination is implemented', () => {
    for (const id of TARGET_PROFILE_IDS) {
      expect(
        TARGET_PROFILES[id].columns.count,
        `${id} must not use browser column flow as fake pagination`,
      ).toBe(1)
    }
  })
})
