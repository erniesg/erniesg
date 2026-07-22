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
      expect(profile.version).toBe('1.1.0')
      expect(profile.epub.fileName).toMatch(/^publication-[a-z]+\.epub$/)
      expect(profile.truth).toEqual({
        geometry: 'authoritative',
        typography: 'advisory',
        pagination: 'reader-controlled',
        orientation: 'reader-controlled',
      })
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
    expect(TARGET_PROFILES.paperPro).toMatchObject({
      pixelsPerInch: 229,
      manufacturerDisplay: {
        diagonalInches: 11.8,
        listedPixels: { width: 2160, height: 1620 },
        logicalOrientation: 'portrait',
      },
      epub: {
        fileName: 'publication-paperpro.epub',
        pageProgressionDirection: 'ltr',
        renditionFlow: 'paginated',
      },
    })
    expect(TARGET_PROFILES.paperProMove).toMatchObject({
      label: 'Paper Pro Move',
      pixelsPerInch: 264,
      manufacturerDisplay: {
        diagonalInches: 7.3,
        listedPixels: { width: 1696, height: 954 },
        logicalOrientation: 'portrait',
      },
      epub: { fileName: 'publication-papermove.epub' },
    })
    expect(TARGET_PROFILES.mobile.preview).toMatchObject({
      heightCssPx: null,
      continuousWindowHeightCssPx: 844,
    })
  })

  it('shows both e-ink screens at one relative physical preview scale', () => {
    const move = TARGET_PROFILES.paperProMove
    const pro = TARGET_PROFILES.paperPro
    const cssPixelsPerPhysicalInch = (profile: typeof move) =>
      (profile.preview.widthCssPx / profile.dimensions.width) *
      profile.pixelsPerInch!

    expect(cssPixelsPerPhysicalInch(move)).toBeCloseTo(
      cssPixelsPerPhysicalInch(pro),
      0,
    )
    expect(move.preview).toEqual({ widthCssPx: 276, heightCssPx: 490 })
    expect(pro.preview).toEqual({ widthCssPx: 540, heightCssPx: 720 })
    expect(move.preview.widthCssPx).toBeLessThan(pro.preview.widthCssPx)
    expect(move.preview.heightCssPx!).toBeLessThan(pro.preview.heightCssPx!)
  })

  it('rejects manufacturer pixels that do not transpose to logical device geometry', () => {
    const invalid = structuredClone(TARGET_PROFILES.paperProMove)
    invalid.manufacturerDisplay!.listedPixels.width += 1

    expect(targetProfileSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects a landscape logical viewport for a portrait manufacturer profile', () => {
    const invalid = structuredClone(TARGET_PROFILES.paperProMove)
    const portraitWidth = invalid.dimensions.width
    invalid.dimensions.width = invalid.dimensions.height!
    invalid.dimensions.height = portraitWidth

    expect(targetProfileSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects a scaled preview whose aspect ratio drifts from device geometry', () => {
    const invalid = structuredClone(TARGET_PROFILES.paperPro)
    invalid.preview.heightCssPx! += 24

    expect(targetProfileSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects profiles whose finite-height capability contradicts their dimensions', () => {
    const invalid = structuredClone(TARGET_PROFILES.mobile)
    invalid.finiteHeight = true

    expect(targetProfileSchema.safeParse(invalid).success).toBe(false)
  })
})
