import { z } from 'zod'
import { targetProfileIdSchema } from '../research/target-schema'
import {
  resolveTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetOrientation,
  type TargetProfile,
  type TargetProfileId,
} from '../research/targets'
import {
  assertSupportedVersion,
  boundedText,
  canonicalIdSchema,
  localeTagSchema,
  PUBLICATION_LIMITS,
} from './schema'

export const COMPOSITION_CONTEXT_VERSION = '1.0.0' as const

export const SUPPORTED_COMPOSITION_CONTEXT_VERSIONS = [
  COMPOSITION_CONTEXT_VERSION,
] as const

/**
 * `src/research/targets.ts` is the single registry for dimensions, margins,
 * orientation, reader-control assumptions, and pagination authority. This module
 * only projects those facts into a medium-independent capability description and
 * adds the environment capabilities the registry does not own.
 */
export const TARGET_PROFILE_REGISTRY = 'src/research/targets.ts' as const

const MILLIMETRES_PER_INCH = 25.4

const authoritySchema = z.enum([
  'authoritative',
  'advisory',
  'reader-controlled',
])

const lengthUnitSchema = z.enum(['css-px', 'device-px', 'mm'])

const orientationSchema = z.enum(['portrait', 'landscape'])

export const compositionContextSchema = z
  .object({
    version: z.literal(COMPOSITION_CONTEXT_VERSION),
    id: canonicalIdSchema,
    label: boundedText(PUBLICATION_LIMITS.shortText),
    note: boundedText(PUBLICATION_LIMITS.shortText),
    profile: z
      .object({
        registry: z.literal(TARGET_PROFILE_REGISTRY),
        id: targetProfileIdSchema,
        version: boundedText(64),
      })
      .strict(),
    flow: z
      .object({
        mode: z.enum(['continuous', 'paged']),
        interaction: z.enum([
          'continuous-scroll',
          'page-turn',
          'print-static',
        ]),
        paginationAuthority: authoritySchema,
        columns: z
          .object({
            count: z.number().int().positive(),
            gapCssPx: z.number().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    dimensions: z
      .object({
        logical: z
          .object({
            width: z.number().positive(),
            height: z.number().positive().nullable(),
            unit: lengthUnitSchema,
          })
          .strict(),
        physical: z
          .object({
            width: z.number().positive(),
            height: z.number().positive().nullable(),
            unit: z.literal('mm'),
          })
          .strict()
          .nullable(),
        margins: z
          .object({
            top: z.number().nonnegative(),
            right: z.number().nonnegative(),
            bottom: z.number().nonnegative(),
            left: z.number().nonnegative(),
            unit: lengthUnitSchema,
          })
          .strict(),
        authority: authoritySchema,
      })
      .strict(),
    orientation: z
      .object({
        selected: orientationSchema,
        supported: z.array(orientationSchema).min(1).max(2),
        control: z.enum(['publisher-locked', 'reader-controlled']),
        authority: authoritySchema,
      })
      .strict(),
    color: z
      .object({
        capability: z.enum(['monochrome', 'grayscale', 'color']),
        bitDepth: z.number().int().positive().max(48),
      })
      .strict(),
    resolution: z
      .object({
        pixelsPerInch: z.number().positive().nullable(),
        manufacturerDisplay: z
          .object({
            diagonalInches: z.number().positive(),
            listedPixels: z
              .object({
                width: z.number().int().positive(),
                height: z.number().int().positive(),
              })
              .strict(),
            logicalOrientation: z.literal('portrait'),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    refresh: z
      .object({
        behavior: z.enum(['immediate', 'e-ink-partial', 'static-print']),
        animationSupported: z.boolean(),
      })
      .strict(),
    typography: z
      .object({
        authority: authoritySchema,
        readerAdjustable: z.boolean(),
        fontFamily: boundedText(PUBLICATION_LIMITS.shortText),
        bodySizeCssPx: z.number().positive(),
        lineHeight: z.number().positive(),
        titleSizeCssPx: z.number().positive(),
        headingSizeCssPx: z.number().positive(),
        quoteSizeCssPx: z.number().positive(),
      })
      .strict(),
    locale: z
      .object({
        language: localeTagSchema,
        script: z
          .string()
          .regex(/^[A-Z][a-z]{3}$/)
          .nullable(),
        direction: z.enum(['ltr', 'rtl']),
      })
      .strict(),
    accessibility: z
      .object({
        prefersReducedMotion: z.boolean(),
        prefersHighContrast: z.boolean(),
        minimumContrastRatio: z.number().min(1).max(21),
      })
      .strict(),
    production: z
      .object({
        duplex: z.enum([
          'not-applicable',
          'simplex',
          'duplex-long-edge',
          'duplex-short-edge',
        ]),
        binding: z.enum(['none', 'left', 'right', 'top']),
        bleedMm: z.number().nonnegative().max(20),
      })
      .strict(),
    offline: z
      .object({
        required: z.boolean(),
        embeddedAssetsOnly: z.boolean(),
      })
      .strict(),
    export: z
      .object({
        status: z.literal('generated'),
        format: z.enum(['epub', 'pdf']),
        renderer: z.enum(['local-profiled-epub', 'local-paginated-pdf']),
        pagination: authoritySchema,
        fileName: boundedText(PUBLICATION_LIMITS.shortText),
        pageProgressionDirection: z.enum(['ltr', 'rtl']),
        renditionFlow: z.enum(['paginated', 'scrolled-continuous']),
      })
      .strict(),
    simulation: z
      .object({
        previewWidthCssPx: z.number().positive(),
        previewHeightCssPx: z.number().positive().nullable(),
        continuousWindowHeightCssPx: z.number().positive().nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((context, issues) => {
    if (context.dimensions.margins.unit !== context.dimensions.logical.unit) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions', 'margins', 'unit'],
        message: 'Margins and logical dimensions must use the same unit',
      })
    }
    if (!context.orientation.supported.includes(context.orientation.selected)) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orientation', 'selected'],
        message: 'The selected orientation must be a supported orientation',
      })
    }
    const paged = context.flow.mode === 'paged'
    if (paged !== (context.dimensions.logical.height !== null)) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'mode'],
        message: 'Paged flow requires a finite logical block dimension',
      })
    }
    if (paged !== (context.simulation.previewHeightCssPx !== null)) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['simulation', 'previewHeightCssPx'],
        message: 'Only paged contexts declare a finite preview height',
      })
    }
    if (
      (context.resolution.pixelsPerInch !== null) !==
      (context.dimensions.logical.unit === 'device-px')
    ) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolution', 'pixelsPerInch'],
        message: 'Only device-pixel geometry declares pixels per inch',
      })
    }
    if (
      context.export.pagination !== context.flow.paginationAuthority ||
      (context.export.renditionFlow === 'scrolled-continuous') !==
        (context.flow.interaction === 'continuous-scroll')
    ) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['export'],
        message:
          'Export authority and flow must agree with the registry contract',
      })
    }
  })

export type CompositionContext = z.infer<typeof compositionContextSchema>

type CapabilityPreset = {
  color: CompositionContext['color']
  refresh: CompositionContext['refresh']
  locale: CompositionContext['locale']
  accessibility: CompositionContext['accessibility']
  production: CompositionContext['production']
  offline: CompositionContext['offline']
}

/**
 * Named presets are data. They carry only the reading-environment capabilities
 * a `TargetProfile` does not record; nothing here restates registry geometry.
 */
export const COMPOSITION_CAPABILITY_PRESETS: Record<
  TargetProfileId,
  CapabilityPreset
> = {
  mobile: {
    color: { capability: 'color', bitDepth: 24 },
    refresh: { behavior: 'immediate', animationSupported: true },
    locale: { language: 'en', script: null, direction: 'ltr' },
    accessibility: {
      prefersReducedMotion: false,
      prefersHighContrast: false,
      minimumContrastRatio: 4.5,
    },
    production: { duplex: 'not-applicable', binding: 'none', bleedMm: 0 },
    offline: { required: false, embeddedAssetsOnly: true },
  },
  paperProMove: {
    color: { capability: 'color', bitDepth: 12 },
    refresh: { behavior: 'e-ink-partial', animationSupported: false },
    locale: { language: 'en', script: null, direction: 'ltr' },
    accessibility: {
      prefersReducedMotion: true,
      prefersHighContrast: false,
      minimumContrastRatio: 7,
    },
    production: { duplex: 'not-applicable', binding: 'none', bleedMm: 0 },
    offline: { required: true, embeddedAssetsOnly: true },
  },
  paperPro: {
    color: { capability: 'color', bitDepth: 12 },
    refresh: { behavior: 'e-ink-partial', animationSupported: false },
    locale: { language: 'en', script: null, direction: 'ltr' },
    accessibility: {
      prefersReducedMotion: true,
      prefersHighContrast: false,
      minimumContrastRatio: 7,
    },
    production: { duplex: 'not-applicable', binding: 'none', bleedMm: 0 },
    offline: { required: true, embeddedAssetsOnly: true },
  },
  print: {
    color: { capability: 'color', bitDepth: 24 },
    refresh: { behavior: 'static-print', animationSupported: false },
    locale: { language: 'en', script: null, direction: 'ltr' },
    accessibility: {
      prefersReducedMotion: true,
      prefersHighContrast: false,
      minimumContrastRatio: 4.5,
    },
    production: { duplex: 'duplex-long-edge', binding: 'left', bleedMm: 3 },
    offline: { required: true, embeddedAssetsOnly: true },
  },
}

function millimetres(value: number) {
  return Math.round(value * 1000) / 1000
}

/** Physical size is derived from the registry, never authored a second time. */
function physicalDimensions(profile: TargetProfile) {
  const { width, height, unit } = profile.dimensions
  if (unit === 'mm') {
    return { width, height, unit: 'mm' as const }
  }
  const pixelsPerInch = profile.pixelsPerInch
  if (unit === 'device-px' && pixelsPerInch !== null) {
    return {
      width: millimetres((width / pixelsPerInch) * MILLIMETRES_PER_INCH),
      height:
        height === null
          ? null
          : millimetres((height / pixelsPerInch) * MILLIMETRES_PER_INCH),
      unit: 'mm' as const,
    }
  }
  return null
}

export function compositionContextId(
  id: TargetProfileId,
  orientation: TargetOrientation,
) {
  return `${id}-${orientation}`
}

export function toCompositionContext(
  id: TargetProfileId,
  orientation: TargetOrientation = resolveTargetProfile(id).orientation.selected,
): CompositionContext {
  const profile = resolveTargetProfile(id, orientation)
  const preset = COMPOSITION_CAPABILITY_PRESETS[id]

  return compositionContextSchema.parse({
    version: COMPOSITION_CONTEXT_VERSION,
    id: compositionContextId(id, orientation),
    label: profile.label,
    note: profile.note,
    profile: {
      registry: TARGET_PROFILE_REGISTRY,
      id: profile.id,
      version: profile.version,
    },
    flow: {
      mode: profile.finiteHeight ? 'paged' : 'continuous',
      interaction: profile.interactionMode,
      paginationAuthority: profile.truth.pagination,
      columns: profile.columns,
    },
    dimensions: {
      logical: profile.dimensions,
      physical: physicalDimensions(profile),
      margins: profile.margins,
      authority: profile.truth.geometry,
    },
    orientation: {
      selected: profile.orientation.selected,
      supported: profile.orientation.supported,
      control: profile.orientation.control,
      authority: profile.truth.orientation,
    },
    color: preset.color,
    resolution: {
      pixelsPerInch: profile.pixelsPerInch,
      manufacturerDisplay: profile.manufacturerDisplay ?? null,
    },
    refresh: preset.refresh,
    typography: {
      authority: profile.truth.typography,
      readerAdjustable: profile.truth.typography !== 'authoritative',
      ...profile.typography,
    },
    locale: preset.locale,
    accessibility: preset.accessibility,
    production: preset.production,
    offline: preset.offline,
    export: {
      status: profile.artifact.status,
      format: profile.artifact.format,
      renderer: profile.artifact.renderer,
      pagination: profile.artifact.pagination,
      fileName: profile.epub.fileName,
      pageProgressionDirection: profile.epub.pageProgressionDirection,
      renditionFlow: profile.epub.renditionFlow,
    },
    simulation: {
      previewWidthCssPx: profile.preview.widthCssPx,
      previewHeightCssPx: profile.preview.heightCssPx,
      continuousWindowHeightCssPx:
        profile.preview.continuousWindowHeightCssPx ?? null,
    },
  })
}

export const COMPOSITION_CONTEXT_PRESET_IDS = TARGET_PROFILE_IDS.flatMap((id) =>
  resolveTargetProfile(id).orientation.supported.map((orientation) =>
    compositionContextId(id, orientation),
  ),
)

/**
 * Proves the projection is lossless: a context alone can rebuild every fact the
 * registry declares for its profile and orientation.
 */
export function restoreTargetProfile(
  context: CompositionContext,
): TargetProfile {
  const artifact: TargetProfile['artifact'] =
    context.export.format === 'pdf'
      ? {
          status: 'generated',
          format: 'pdf',
          renderer: 'local-paginated-pdf',
          pagination: 'authoritative',
        }
      : {
          status: 'generated',
          format: 'epub',
          renderer: 'local-profiled-epub',
          pagination: 'reader-controlled',
        }
  if (
    artifact.renderer !== context.export.renderer ||
    artifact.pagination !== context.export.pagination
  ) {
    throw new RangeError(
      `Composition context ${context.id} declares an export contract the registry does not support`,
    )
  }

  // Authority and reader-adjustability are recorded separately on the profile;
  // the rest of the typography block maps across unchanged.
  const {
    authority: _typographyAuthority,
    readerAdjustable: _readerAdjustable,
    ...typography
  } = context.typography

  return {
    id: context.profile.id,
    version: context.profile.version as TargetProfile['version'],
    label: context.label,
    note: context.note,
    dimensions: context.dimensions.logical,
    margins: context.dimensions.margins,
    typography,
    columns: context.flow.columns,
    interactionMode: context.flow.interaction,
    finiteHeight: context.dimensions.logical.height !== null,
    pixelsPerInch: context.resolution.pixelsPerInch,
    ...(context.resolution.manufacturerDisplay
      ? { manufacturerDisplay: context.resolution.manufacturerDisplay }
      : {}),
    epub: {
      fileName: context.export.fileName,
      pageProgressionDirection: context.export.pageProgressionDirection,
      renditionFlow: context.export.renditionFlow,
    },
    truth: {
      geometry: context.dimensions.authority,
      typography: context.typography.authority,
      pagination: context.flow.paginationAuthority,
      orientation: context.orientation.authority,
    },
    orientation: {
      selected: context.orientation.selected,
      supported: [...context.orientation.supported],
      control: context.orientation.control,
    },
    artifact,
    preview: {
      widthCssPx: context.simulation.previewWidthCssPx,
      heightCssPx: context.simulation.previewHeightCssPx,
      ...(context.simulation.continuousWindowHeightCssPx === null
        ? {}
        : {
            continuousWindowHeightCssPx:
              context.simulation.continuousWindowHeightCssPx,
          }),
    },
  }
}

export function parseCompositionContext(value: unknown): CompositionContext {
  const version =
    value && typeof value === 'object' && 'version' in value
      ? (value as { version: unknown }).version
      : undefined
  assertSupportedVersion(
    'composition context',
    version,
    SUPPORTED_COMPOSITION_CONTEXT_VERSIONS,
  )
  return compositionContextSchema.parse(value)
}
