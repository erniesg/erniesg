import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { targetProfileSchema } from '../research/target-schema'
import {
  resolveTargetProfile,
  TARGET_PROFILES,
  TARGET_PROFILE_IDS,
} from '../research/targets'
import {
  COMPOSITION_CAPABILITY_PRESETS,
  COMPOSITION_CONTEXT_PRESET_IDS,
  COMPOSITION_CONTEXT_VERSION,
  compositionContextSchema,
  parseCompositionContext,
  restoreTargetProfile,
  TARGET_PROFILE_REGISTRY,
  toCompositionContext,
} from './profiles'
import { UnsupportedPublicationVersionError } from './schema'

/** Geometry authored once in `src/research/targets.ts`. */
const REGISTRY_GEOMETRY_LITERALS = [
  390, 844, 954, 1696, 1620, 2160, 210, 297, 264, 229, 540, 720, 276, 490, 794,
  1123, 108, 145, 130, 7.3, 11.8,
]

describe('composition context', () => {
  it('describes every capability the compiler needs, for every profile', () => {
    for (const id of TARGET_PROFILE_IDS) {
      const context = toCompositionContext(id)

      expect(compositionContextSchema.parse(context)).toEqual(context)
      expect(context.version).toBe(COMPOSITION_CONTEXT_VERSION)
      expect(context.profile.registry).toBe(TARGET_PROFILE_REGISTRY)
      expect(context.flow.mode).toBe(
        TARGET_PROFILES[id].finiteHeight ? 'paged' : 'continuous',
      )
      expect(context.dimensions.logical).toEqual(TARGET_PROFILES[id].dimensions)
      expect(context.dimensions.margins).toEqual(TARGET_PROFILES[id].margins)
      expect(context.orientation.supported).toContain(
        context.orientation.selected,
      )
      expect(context.color.capability).toBeTruthy()
      expect(context.refresh.behavior).toBeTruthy()
      expect(context.locale.language).toBe('en')
      expect(context.accessibility.minimumContrastRatio).toBeGreaterThanOrEqual(1)
      expect(context.production.binding).toBeTruthy()
      expect(context.production.bleedMm).toBeGreaterThanOrEqual(0)
      expect(typeof context.offline.required).toBe('boolean')
      expect(context.typography.readerAdjustable).toBe(
        TARGET_PROFILES[id].truth.typography !== 'authoritative',
      )
    }
  })

  it('derives physical size from the registry instead of restating it', () => {
    expect(toCompositionContext('print').dimensions.physical).toEqual({
      width: 210,
      height: 297,
      unit: 'mm',
    })
    expect(toCompositionContext('paperPro').dimensions.physical).toEqual({
      width: Math.round((1620 / 229) * 25.4 * 1000) / 1000,
      height: Math.round((2160 / 229) * 25.4 * 1000) / 1000,
      unit: 'mm',
    })
    expect(toCompositionContext('mobile').dimensions.physical).toBeNull()
  })

  it('maps the profile and its issue-026 export authority losslessly', () => {
    for (const id of COMPOSITION_CONTEXT_PRESET_IDS) {
      const [profileId, orientation] = [
        id.slice(0, id.lastIndexOf('-')),
        id.slice(id.lastIndexOf('-') + 1),
      ] as [(typeof TARGET_PROFILE_IDS)[number], 'portrait' | 'landscape']
      const expected = resolveTargetProfile(profileId, orientation)
      const restored = restoreTargetProfile(
        toCompositionContext(profileId, orientation),
      )

      expect(restored).toEqual(expected)
      expect(targetProfileSchema.parse(restored)).toEqual(expected)
    }
  })

  it('carries orientation, pagination, and reader-control authority', () => {
    const print = toCompositionContext('print')
    expect(print.orientation.control).toBe('publisher-locked')
    expect(print.orientation.authority).toBe('authoritative')
    expect(print.flow.paginationAuthority).toBe('authoritative')
    expect(print.export).toMatchObject({
      format: 'pdf',
      renderer: 'local-paginated-pdf',
      pagination: 'authoritative',
      renditionFlow: 'paginated',
    })

    const mobile = toCompositionContext('mobile')
    expect(mobile.flow.paginationAuthority).toBe('reader-controlled')
    expect(mobile.export).toMatchObject({
      format: 'epub',
      renderer: 'local-profiled-epub',
      pagination: 'reader-controlled',
      renditionFlow: 'scrolled-continuous',
    })
    expect(mobile.simulation.continuousWindowHeightCssPx).toBe(844)

    const landscape = toCompositionContext('paperPro', 'landscape')
    expect(landscape.dimensions.logical.width).toBe(2160)
    expect(landscape.dimensions.logical.height).toBe(1620)
  })

  it('keeps presets as data, not branches, and never as a second registry', () => {
    expect(Object.keys(COMPOSITION_CAPABILITY_PRESETS)).toEqual([
      ...TARGET_PROFILE_IDS,
    ])

    const source = readFileSync(new URL('./profiles.ts', import.meta.url), 'utf8')
    for (const literal of REGISTRY_GEOMETRY_LITERALS) {
      expect(
        new RegExp(`(?<![\\w.])${String(literal).replace('.', '\\.')}(?![\\w.])`).test(
          source,
        ),
      ).toBe(false)
    }
    expect(source).toContain("from '../research/targets'")
  })

  it('rejects unknown versions, mismatched units, and impossible flow', () => {
    const context = toCompositionContext('print')

    expect(() => parseCompositionContext({ ...context, version: '2.0.0' })).toThrow(
      UnsupportedPublicationVersionError,
    )
    expect(parseCompositionContext(context)).toEqual(context)
    expect(() =>
      compositionContextSchema.parse({ ...context, bleed: 3 }),
    ).toThrow()
    expect(() =>
      compositionContextSchema.parse({
        ...context,
        dimensions: {
          ...context.dimensions,
          margins: { ...context.dimensions.margins, unit: 'css-px' },
        },
      }),
    ).toThrow(/same unit/)
    expect(() =>
      compositionContextSchema.parse({
        ...context,
        flow: { ...context.flow, mode: 'continuous' },
      }),
    ).toThrow(/finite logical block dimension/)
    const mobile = toCompositionContext('mobile')
    expect(() =>
      compositionContextSchema.parse({
        ...mobile,
        orientation: { ...mobile.orientation, selected: 'landscape' },
      }),
    ).toThrow(/supported orientation/)
    expect(() => toCompositionContext('mobile', 'landscape')).toThrow(RangeError)
  })
})
