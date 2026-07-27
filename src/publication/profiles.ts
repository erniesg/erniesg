import { z } from 'zod'
import {
  getTargetProfile,
  resolveTargetProfile,
  TARGET_PROFILE_IDS,
  TARGET_PROFILE_VERSION,
  type TargetOrientation,
  type TargetProfile,
  type TargetProfileId,
} from '../research/targets'

export const COMPOSITION_CONTEXT_VERSION = '1.0.0' as const

const dimensionsSchema = z
  .object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive().nullable(),
    unit: z.enum(['css-px', 'device-px', 'mm', 'in']),
  })
  .strict()

export const compositionContextSchema = z
  .object({
    version: z.literal(COMPOSITION_CONTEXT_VERSION),
    presetId: z.enum(TARGET_PROFILE_IDS),
    sourceProfileVersion: z.literal(TARGET_PROFILE_VERSION),
    flow: z.enum(['continuous', 'paged']),
    logicalDimensions: dimensionsSchema,
    physicalDimensions: dimensionsSchema.nullable(),
    margins: z
      .object({
        top: z.number().finite().nonnegative(),
        right: z.number().finite().nonnegative(),
        bottom: z.number().finite().nonnegative(),
        left: z.number().finite().nonnegative(),
        unit: z.enum(['css-px', 'device-px', 'mm']),
      })
      .strict(),
    orientation: z.enum(['portrait', 'landscape']),
    color: z.enum(['full-color', 'monochrome', 'unknown']),
    resolution: z
      .object({
        pixelsPerInch: z.number().finite().positive().nullable(),
        devicePixels: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    refresh: z.enum(['dynamic', 'page-refresh', 'static']),
    interaction: z.enum(['scroll', 'page-turn', 'none']),
    fontControl: z.enum([
      'publisher-controlled',
      'reader-controlled',
      'advisory',
    ]),
    locale: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => {
        try {
          return Intl.getCanonicalLocales(value)[0] === value
        } catch {
          return false
        }
      }, 'Locale must be a canonical BCP 47 tag'),
    script: z.string().regex(/^[A-Z][a-z]{3}$/),
    accessibility: z
      .object({
        prefersReducedMotion: z.boolean(),
        prefersHighContrast: z.boolean(),
        forcedColors: z.boolean(),
        screenReaderOptimized: z.boolean(),
      })
      .strict(),
    duplex: z.enum(['none', 'long-edge', 'short-edge', 'unspecified']),
    binding: z.enum(['none', 'left', 'right', 'top', 'unspecified']),
    bleed: z
      .object({
        top: z.number().finite().nonnegative(),
        right: z.number().finite().nonnegative(),
        bottom: z.number().finite().nonnegative(),
        left: z.number().finite().nonnegative(),
        unit: z.enum(['mm', 'in']),
      })
      .strict(),
    offline: z
      .object({
        required: z.boolean(),
        externalResourcesAllowed: z.boolean(),
      })
      .strict(),
    readerControl: z
      .object({
        orientation: z.boolean(),
        typography: z.boolean(),
        pagination: z.boolean(),
        margins: z.boolean(),
      })
      .strict(),
    paginationAuthority: z.enum([
      'authoritative',
      'advisory',
      'reader-controlled',
    ]),
  })
  .strict()
  .superRefine((context, refinement) => {
    if (
      (context.flow === 'continuous') !==
      (context.logicalDimensions.height === null)
    ) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['logicalDimensions', 'height'],
        message: 'Continuous flow requires an unbounded logical height',
      })
    }
    if (
      context.orientation === 'portrait' &&
      context.logicalDimensions.height !== null &&
      context.logicalDimensions.width >= context.logicalDimensions.height
    ) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['logicalDimensions'],
        message: 'Portrait dimensions must be taller than wide',
      })
    }
    if (
      context.orientation === 'landscape' &&
      context.logicalDimensions.height !== null &&
      context.logicalDimensions.width <= context.logicalDimensions.height
    ) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['logicalDimensions'],
        message: 'Landscape dimensions must be wider than tall',
      })
    }
  })

export type CompositionContext = z.infer<typeof compositionContextSchema>

const TARGET_COMPOSITION_CAPABILITIES = {
  mobile: {
    color: 'full-color',
    duplex: 'none',
    binding: 'none',
  },
  paperProMove: {
    color: 'monochrome',
    duplex: 'none',
    binding: 'none',
  },
  paperPro: {
    color: 'monochrome',
    duplex: 'none',
    binding: 'none',
  },
  print: {
    color: 'monochrome',
    duplex: 'long-edge',
    binding: 'left',
  },
} as const satisfies Record<
  TargetProfileId,
  Pick<CompositionContext, 'color' | 'duplex' | 'binding'>
>

function physicalDimensions(
  profile: TargetProfile,
): CompositionContext['physicalDimensions'] {
  if (profile.dimensions.height === null) return null
  if (profile.dimensions.unit === 'mm') return { ...profile.dimensions }
  if (profile.dimensions.unit === 'device-px' && profile.pixelsPerInch) {
    return {
      width: profile.dimensions.width / profile.pixelsPerInch,
      height: profile.dimensions.height / profile.pixelsPerInch,
      unit: 'in',
    }
  }
  return null
}

export function targetProfileToCompositionContext(
  profile: TargetProfile,
  locale = 'en',
  script = 'Latn',
): CompositionContext {
  const capabilities = TARGET_COMPOSITION_CAPABILITIES[profile.id]
  const value: CompositionContext = {
    version: COMPOSITION_CONTEXT_VERSION,
    presetId: profile.id,
    sourceProfileVersion: profile.version,
    flow: profile.finiteHeight ? 'paged' : 'continuous',
    logicalDimensions: { ...profile.dimensions },
    physicalDimensions: physicalDimensions(profile),
    margins: { ...profile.margins },
    orientation: profile.orientation.selected,
    color: capabilities.color,
    resolution: {
      pixelsPerInch: profile.pixelsPerInch,
      devicePixels:
        profile.dimensions.unit === 'device-px' && profile.dimensions.height
          ? {
              width: profile.dimensions.width,
              height: profile.dimensions.height,
            }
          : null,
    },
    refresh:
      profile.interactionMode === 'continuous-scroll'
        ? 'dynamic'
        : profile.interactionMode === 'page-turn'
          ? 'page-refresh'
          : 'static',
    interaction:
      profile.interactionMode === 'continuous-scroll'
        ? 'scroll'
        : profile.interactionMode === 'page-turn'
          ? 'page-turn'
          : 'none',
    fontControl:
      profile.truth.typography === 'reader-controlled'
        ? 'reader-controlled'
        : profile.truth.typography === 'authoritative'
          ? 'publisher-controlled'
          : 'advisory',
    locale,
    script,
    accessibility: {
      prefersReducedMotion: false,
      prefersHighContrast: false,
      forcedColors: false,
      screenReaderOptimized: false,
    },
    duplex: capabilities.duplex,
    binding: capabilities.binding,
    bleed: { top: 0, right: 0, bottom: 0, left: 0, unit: 'mm' },
    offline: { required: true, externalResourcesAllowed: false },
    readerControl: {
      orientation: profile.orientation.control === 'reader-controlled',
      typography: profile.truth.typography === 'reader-controlled',
      pagination: profile.truth.pagination === 'reader-controlled',
      margins: profile.artifact.format === 'epub',
    },
    paginationAuthority: profile.truth.pagination,
  }
  return compositionContextSchema.parse(value)
}

export function compositionContextToTargetProfile(
  context: CompositionContext,
): TargetProfile {
  const parsed = compositionContextSchema.parse(context)
  const profile = resolveTargetProfile(parsed.presetId, parsed.orientation)
  const expected = targetProfileToCompositionContext(
    profile,
    parsed.locale,
    parsed.script,
  )
  if (JSON.stringify(expected) !== JSON.stringify(parsed)) {
    throw new Error(
      'Composition context does not match its authoritative target-profile preset',
    )
  }
  return profile
}

export const COMPOSITION_CONTEXT_PRESETS = Object.fromEntries(
  TARGET_PROFILE_IDS.map((id) => [
    id,
    targetProfileToCompositionContext(getTargetProfile(id)),
  ]),
) as Record<TargetProfileId, CompositionContext>

export function getCompositionContextPreset(
  id: TargetProfileId,
  orientation: TargetOrientation = 'portrait',
) {
  return targetProfileToCompositionContext(
    resolveTargetProfile(id, orientation),
  )
}
