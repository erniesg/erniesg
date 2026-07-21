import { z } from 'zod'
import { TARGET_PROFILE_IDS, TARGET_PROFILE_VERSION } from './targets'

export const targetProfileIdSchema = z.enum(TARGET_PROFILE_IDS)

const targetLengthUnitSchema = z.enum(['css-px', 'device-px', 'mm'])

export const targetProfileSchema = z
  .object({
    id: targetProfileIdSchema,
    version: z.literal(TARGET_PROFILE_VERSION),
    label: z.string().min(1),
    note: z.string().min(1),
    dimensions: z
      .object({
        width: z.number().positive(),
        height: z.number().positive().nullable(),
        unit: targetLengthUnitSchema,
      })
      .strict(),
    margins: z
      .object({
        top: z.number().nonnegative(),
        right: z.number().nonnegative(),
        bottom: z.number().nonnegative(),
        left: z.number().nonnegative(),
        unit: targetLengthUnitSchema,
      })
      .strict(),
    typography: z
      .object({
        fontFamily: z.string().min(1),
        bodySizeCssPx: z.number().positive(),
        lineHeight: z.number().positive(),
        titleSizeCssPx: z.number().positive(),
        headingSizeCssPx: z.number().positive(),
        quoteSizeCssPx: z.number().positive(),
      })
      .strict(),
    columns: z
      .object({
        count: z.number().int().positive(),
        gapCssPx: z.number().nonnegative(),
      })
      .strict(),
    interactionMode: z.enum(['continuous-scroll', 'page-turn', 'print-static']),
    finiteHeight: z.boolean(),
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
      .optional(),
    epub: z
      .object({
        fileName: z.string().regex(/^publication-[a-z]+\.epub$/),
        pageProgressionDirection: z.enum(['ltr', 'rtl']),
        renditionFlow: z.enum(['paginated', 'scrolled-continuous']),
      })
      .strict(),
    truth: z
      .object({
        geometry: z.enum(['authoritative', 'advisory', 'reader-controlled']),
        typography: z.enum(['authoritative', 'advisory', 'reader-controlled']),
        pagination: z.enum(['authoritative', 'advisory', 'reader-controlled']),
        orientation: z.enum(['authoritative', 'advisory', 'reader-controlled']),
      })
      .strict(),
    preview: z
      .object({
        widthCssPx: z.number().positive(),
        heightCssPx: z.number().positive().nullable(),
        continuousWindowHeightCssPx: z.number().positive().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const hasFiniteDimensions = profile.dimensions.height !== null
    const hasFinitePreview = profile.preview.heightCssPx !== null

    if (profile.finiteHeight !== hasFiniteDimensions) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions', 'height'],
        message: 'Finite-height capability must match target dimensions',
      })
    }
    if (profile.finiteHeight !== hasFinitePreview) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preview', 'heightCssPx'],
        message: 'Finite-height capability must match preview dimensions',
      })
    }
    if (
      profile.finiteHeight ===
      Boolean(profile.preview.continuousWindowHeightCssPx)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preview', 'continuousWindowHeightCssPx'],
        message:
          'Only continuous profiles declare an advisory preview-window height',
      })
    }
    if (profile.margins.unit !== profile.dimensions.unit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['margins', 'unit'],
        message: 'Target margins and dimensions must use the same unit',
      })
    }
    if (
      (profile.dimensions.unit === 'device-px') !==
      (profile.pixelsPerInch !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pixelsPerInch'],
        message: 'Only device-pixel profiles declare pixels per inch',
      })
    }
    if (
      profile.dimensions.unit === 'device-px' &&
      !profile.manufacturerDisplay
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manufacturerDisplay'],
        message: 'Device-pixel profiles require manufacturer display evidence',
      })
    }
    if (profile.manufacturerDisplay) {
      const logicalPixels = [
        profile.dimensions.width,
        profile.dimensions.height ?? 0,
      ].sort((left, right) => left - right)
      const listedPixels = [
        profile.manufacturerDisplay.listedPixels.width,
        profile.manufacturerDisplay.listedPixels.height,
      ].sort((left, right) => left - right)
      if (
        profile.dimensions.unit !== 'device-px' ||
        logicalPixels[0] !== listedPixels[0] ||
        logicalPixels[1] !== listedPixels[1]
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manufacturerDisplay', 'listedPixels'],
          message:
            'Manufacturer pixels must be an orientation-only transpose of logical device geometry',
        })
      }
      if (profile.pixelsPerInch) {
        const diagonal = Math.hypot(...listedPixels) / profile.pixelsPerInch
        if (
          Math.abs(diagonal - profile.manufacturerDisplay.diagonalInches) > 0.15
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['manufacturerDisplay', 'diagonalInches'],
            message:
              'Manufacturer diagonal must agree with listed pixels and density',
          })
        }
      }
    }
    if (
      (profile.interactionMode === 'continuous-scroll') !==
      (profile.epub.renditionFlow === 'scrolled-continuous')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['epub', 'renditionFlow'],
        message: 'EPUB flow must match the target interaction mode',
      })
    }
  })
