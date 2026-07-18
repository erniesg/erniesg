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
    epub: z
      .object({
        fileName: z.string().regex(/^publication-[a-z]+\.epub$/),
        pageProgressionDirection: z.enum(['ltr', 'rtl']),
        renditionFlow: z.enum(['paginated', 'scrolled-continuous']),
      })
      .strict(),
    preview: z
      .object({
        widthCssPx: z.number().positive(),
        heightCssPx: z.number().positive().nullable(),
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
