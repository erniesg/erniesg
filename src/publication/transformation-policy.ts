import { z } from 'zod'

export const TRANSFORMATION_POLICY_VERSION = '1.0.0' as const

const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const representationChangeSchema = z
  .object({
    id: idSchema,
    from: z.enum([
      'text',
      'list',
      'figure',
      'table',
      'equation',
      'media',
      'interactive',
    ]),
    to: z.enum([
      'text',
      'list',
      'figure',
      'table',
      'equation',
      'media',
      'interactive',
    ]),
    operation: z.enum([
      'reformat',
      'reflow',
      'scale',
      'color-convert',
      'substitute-authored-variant',
      'omit',
      'summarize',
      'reorder-reading-order',
      'crop-meaning-changing',
    ]),
    preservationClass: z.enum([
      'identity',
      'semantic-equivalence',
      'reviewed-meaning-change',
    ]),
    requiredAuthoredAlternative: z.enum([
      'none',
      'compact',
      'monochrome',
      'static',
    ]),
    reviewedVariantId: idSchema.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    const meaningChanging = [
      'omit',
      'summarize',
      'reorder-reading-order',
      'crop-meaning-changing',
    ].includes(change.operation)
    if (
      meaningChanging &&
      (change.preservationClass !== 'reviewed-meaning-change' ||
        !change.reviewedVariantId ||
        change.requiredAuthoredAlternative === 'none')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Meaning-changing operations require an explicit reviewed authored variant',
      })
    }
    if (
      change.operation === 'substitute-authored-variant' &&
      (change.requiredAuthoredAlternative === 'none' ||
        !change.reviewedVariantId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Authored substitutions must identify the required reviewed variant',
      })
    }
  })

const constraintSchema = z
  .object({
    id: idSchema,
    strength: z.enum(['hard', 'soft']),
    subject: z.enum([
      'content',
      'reading-order',
      'accessibility',
      'dimensions',
      'color',
      'resolution',
      'offline',
    ]),
    operator: z.enum(['preserve', 'require', 'forbid', 'prefer', 'limit']),
    value: z.union([z.string().max(10_000), z.number().finite(), z.boolean()]),
    rationale: z.string().min(1).max(100_000),
  })
  .strict()

export const transformationPolicySchema = z
  .object({
    version: z.literal(TRANSFORMATION_POLICY_VERSION),
    id: idSchema,
    transformations: z.array(representationChangeSchema).max(1_000),
    constraints: z.array(constraintSchema).max(1_000),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [key, values] of [
      ['transformations', policy.transformations],
      ['constraints', policy.constraints],
    ] as const) {
      const seen = new Set<string>()
      values.forEach((value, index) => {
        if (seen.has(value.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, 'id'],
            message: `Duplicate policy id: ${value.id}`,
          })
        }
        seen.add(value.id)
      })
    }
  })

export type TransformationPolicy = z.infer<typeof transformationPolicySchema>

export function parseTransformationPolicy(
  value: unknown,
): TransformationPolicy {
  return transformationPolicySchema.parse(value)
}

export function serializeTransformationPolicy(value: TransformationPolicy) {
  return JSON.stringify(transformationPolicySchema.parse(value))
}
