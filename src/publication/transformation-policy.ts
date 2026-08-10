import { z } from 'zod'
import {
  assertSupportedVersion,
  boundedText,
  canonicalIdSchema,
  transformationIdSchema,
  type PublicationGraph,
  type PublicationNode,
  PUBLICATION_LIMITS,
} from './schema'

export const TRANSFORMATION_POLICY_VERSION = '1.0.0' as const

export const SUPPORTED_TRANSFORMATION_POLICY_VERSIONS = [
  TRANSFORMATION_POLICY_VERSION,
] as const

export const TRANSFORMATION_IDS = [
  'reflow-line-breaks',
  'repaginate',
  'change-column-count',
  'hyphenate',
  'rescale-figure',
  'recolor-to-grayscale',
  'substitute-compact-variant',
  'substitute-monochrome-variant',
  'substitute-static-variant',
  'omit-node',
  'summarize-node',
  'reorder-reading-sequence',
  'crop-figure-to-detail',
] as const

export type TransformationId = (typeof TRANSFORMATION_IDS)[number]

/**
 * `meaning-changing` is the class the compiler refuses by default. Everything
 * else can be decided by a renderer; omission, summarisation, reading-order
 * changes, and detail crops need a human on the record.
 */
export const PRESERVATION_CLASSES = [
  'identity',
  'presentation-only',
  'representation-substituting',
  'meaning-changing',
] as const

const constraintSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    description: boundedText(PUBLICATION_LIMITS.shortText),
  })
  .strict()

export const transformationRuleSchema = z
  .object({
    id: transformationIdSchema,
    label: boundedText(PUBLICATION_LIMITS.shortText),
    representationChange: boundedText(PUBLICATION_LIMITS.shortText),
    preservationClass: z.enum(PRESERVATION_CLASSES),
    legality: z.enum([
      'always-legal',
      'requires-authored-variant',
      'requires-reviewed-variant',
    ]),
    requiredAuthoredAlternative: z
      .enum(['compact', 'monochrome', 'static'])
      .nullable(),
    constraints: z
      .object({
        hard: z.array(constraintSchema).max(16),
        soft: z.array(constraintSchema).max(16),
      })
      .strict(),
  })
  .strict()
  .superRefine((rule, context) => {
    const needsAlternative = rule.legality === 'requires-authored-variant'
    if (needsAlternative !== (rule.requiredAuthoredAlternative !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredAuthoredAlternative'],
        message:
          'Only variant-substituting transformations name a required authored alternative',
      })
    }
    if (
      (rule.preservationClass === 'meaning-changing') !==
      (rule.legality === 'requires-reviewed-variant')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['legality'],
        message:
          'Meaning-changing transformations are legal only with an explicit reviewed variant',
      })
    }
  })

export type TransformationRule = z.infer<typeof transformationRuleSchema>

export const transformationPolicySchema = z
  .object({
    version: z.literal(TRANSFORMATION_POLICY_VERSION),
    id: canonicalIdSchema,
    label: boundedText(PUBLICATION_LIMITS.shortText),
    rules: z.array(transformationRuleSchema).min(1).max(64),
  })
  .strict()
  .superRefine((policy, context) => {
    const seen = new Set<string>()
    for (const [index, rule] of policy.rules.entries()) {
      if (seen.has(rule.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'id'],
          message: `Duplicate transformation rule id: ${rule.id}`,
        })
      }
      seen.add(rule.id)
    }
  })

export type TransformationPolicy = z.infer<typeof transformationPolicySchema>

const KEEP_READING_ORDER = {
  code: 'preserve-reading-order',
  description: 'The rendered sequence must equal the canonical node order.',
}
const KEEP_ALL_REQUIRED = {
  code: 'preserve-required-nodes',
  description: 'Every required node must appear in the rendition.',
}
const KEEP_RELATIONSHIPS = {
  code: 'preserve-relationships',
  description:
    'Figure, caption, note, and reference relationships must survive the change.',
}
const AVOID_ORPHANS = {
  code: 'avoid-orphans',
  description: 'Prefer keeping a heading with at least two following lines.',
}
const PREFER_AUTHORED_VARIANT = {
  code: 'prefer-authored-variant',
  description: 'Prefer an authored variant over a mechanically derived one.',
}

export const DEFAULT_TRANSFORMATION_POLICY: TransformationPolicy =
  transformationPolicySchema.parse({
    version: TRANSFORMATION_POLICY_VERSION,
    id: 'default-publication-policy',
    label: 'Default publication transformation policy',
    rules: [
      {
        id: 'reflow-line-breaks',
        label: 'Reflow line breaks',
        representationChange: 'Recompute line breaking for the target measure.',
        preservationClass: 'identity',
        legality: 'always-legal',
        requiredAuthoredAlternative: null,
        constraints: { hard: [KEEP_READING_ORDER], soft: [AVOID_ORPHANS] },
      },
      {
        id: 'repaginate',
        label: 'Repaginate',
        representationChange: 'Assign content to a different set of sheets.',
        preservationClass: 'identity',
        legality: 'always-legal',
        requiredAuthoredAlternative: null,
        constraints: {
          hard: [KEEP_READING_ORDER, KEEP_ALL_REQUIRED],
          soft: [AVOID_ORPHANS],
        },
      },
      {
        id: 'change-column-count',
        label: 'Change column count',
        representationChange: 'Render the same flow across a different measure.',
        preservationClass: 'presentation-only',
        legality: 'always-legal',
        requiredAuthoredAlternative: null,
        constraints: { hard: [KEEP_READING_ORDER], soft: [AVOID_ORPHANS] },
      },
      {
        id: 'hyphenate',
        label: 'Hyphenate',
        representationChange: 'Break words at locale-legal hyphenation points.',
        preservationClass: 'presentation-only',
        legality: 'always-legal',
        requiredAuthoredAlternative: null,
        constraints: {
          hard: [
            {
              code: 'locale-hyphenation-available',
              description:
                'Hyphenation requires a hyphenation dictionary for the node locale.',
            },
          ],
          soft: [],
        },
      },
      {
        id: 'rescale-figure',
        label: 'Rescale figure',
        representationChange:
          'Render the same figure content at a different scale.',
        preservationClass: 'presentation-only',
        legality: 'always-legal',
        requiredAuthoredAlternative: null,
        constraints: {
          hard: [KEEP_RELATIONSHIPS],
          soft: [
            {
              code: 'legible-minimum-size',
              description: 'Prefer scales that keep embedded labels legible.',
            },
          ],
        },
      },
      {
        id: 'recolor-to-grayscale',
        label: 'Recolour to grayscale',
        representationChange:
          'Map colour to luminance for a monochrome surface.',
        preservationClass: 'presentation-only',
        legality: 'always-legal',
        requiredAuthoredAlternative: null,
        constraints: {
          hard: [
            {
              code: 'no-colour-only-meaning',
              description:
                'Content whose meaning is carried only by colour needs an authored monochrome variant.',
            },
          ],
          soft: [PREFER_AUTHORED_VARIANT],
        },
      },
      {
        id: 'substitute-compact-variant',
        label: 'Substitute the authored compact variant',
        representationChange:
          'Replace the node with its authored compact rendition.',
        preservationClass: 'representation-substituting',
        legality: 'requires-authored-variant',
        requiredAuthoredAlternative: 'compact',
        constraints: { hard: [KEEP_RELATIONSHIPS], soft: [] },
      },
      {
        id: 'substitute-monochrome-variant',
        label: 'Substitute the authored monochrome variant',
        representationChange:
          'Replace the node with its authored monochrome rendition.',
        preservationClass: 'representation-substituting',
        legality: 'requires-authored-variant',
        requiredAuthoredAlternative: 'monochrome',
        constraints: { hard: [KEEP_RELATIONSHIPS], soft: [] },
      },
      {
        id: 'substitute-static-variant',
        label: 'Substitute the authored static variant',
        representationChange:
          'Replace animated or interactive media with its authored still.',
        preservationClass: 'representation-substituting',
        legality: 'requires-authored-variant',
        requiredAuthoredAlternative: 'static',
        constraints: {
          hard: [
            KEEP_RELATIONSHIPS,
            {
              code: 'accessible-alternative-present',
              description:
                'A static substitute must keep an accessible alternative for the removed motion.',
            },
          ],
          soft: [],
        },
      },
      {
        id: 'omit-node',
        label: 'Omit a node',
        representationChange: 'Remove content from the rendition entirely.',
        preservationClass: 'meaning-changing',
        legality: 'requires-reviewed-variant',
        requiredAuthoredAlternative: null,
        constraints: { hard: [KEEP_ALL_REQUIRED], soft: [] },
      },
      {
        id: 'summarize-node',
        label: 'Summarise a node',
        representationChange: 'Replace authored text with a shorter paraphrase.',
        preservationClass: 'meaning-changing',
        legality: 'requires-reviewed-variant',
        requiredAuthoredAlternative: null,
        constraints: {
          hard: [
            {
              code: 'reviewed-replacement-text',
              description:
                'A summary must ship the exact reviewed replacement text.',
            },
          ],
          soft: [],
        },
      },
      {
        id: 'reorder-reading-sequence',
        label: 'Reorder the reading sequence',
        representationChange:
          'Render nodes in an order other than the canonical one.',
        preservationClass: 'meaning-changing',
        legality: 'requires-reviewed-variant',
        requiredAuthoredAlternative: null,
        constraints: { hard: [KEEP_READING_ORDER], soft: [] },
      },
      {
        id: 'crop-figure-to-detail',
        label: 'Crop a figure to a detail',
        representationChange:
          'Show part of a figure in place of the authored whole.',
        preservationClass: 'meaning-changing',
        legality: 'requires-reviewed-variant',
        requiredAuthoredAlternative: null,
        constraints: { hard: [KEEP_RELATIONSHIPS], soft: [] },
      },
    ],
  })

export function parseTransformationPolicy(
  value: unknown,
): TransformationPolicy {
  const version =
    value && typeof value === 'object' && 'version' in value
      ? (value as { version: unknown }).version
      : undefined
  assertSupportedVersion(
    'transformation policy',
    version,
    SUPPORTED_TRANSFORMATION_POLICY_VERSIONS,
  )
  return transformationPolicySchema.parse(value)
}

export function findTransformationRule(
  policy: TransformationPolicy,
  transformationId: string,
) {
  return policy.rules.find((rule) => rule.id === transformationId)
}

export type TransformationDecision = {
  transformationId: string
  status: 'permitted' | 'rejected'
  preservationClass: TransformationRule['preservationClass'] | null
  reason:
    | 'permitted-by-policy'
    | 'permitted-by-authored-variant'
    | 'permitted-by-reviewed-variant'
    | 'unknown-transformation'
    | 'not-permitted-by-node'
    | 'missing-authored-alternative'
    | 'unreviewed-authored-alternative'
    | 'no-reviewed-variant'
  detail: string
}

/**
 * A transformation is legal only when the policy allows the class *and* the node
 * itself carries the evidence that class demands.
 */
export function evaluateTransformation(
  policy: TransformationPolicy,
  transformationId: string,
  node: PublicationNode,
): TransformationDecision {
  const rule = findTransformationRule(policy, transformationId)
  if (!rule) {
    return {
      transformationId,
      status: 'rejected',
      preservationClass: null,
      reason: 'unknown-transformation',
      detail: `${policy.id} declares no rule for ${transformationId}`,
    }
  }
  if (!node.permittedTransformations.includes(rule.id)) {
    return {
      transformationId,
      status: 'rejected',
      preservationClass: rule.preservationClass,
      reason: 'not-permitted-by-node',
      detail: `Node ${node.id} does not permit ${rule.id}`,
    }
  }

  if (rule.legality === 'requires-authored-variant') {
    const alternative = rule.requiredAuthoredAlternative
    const variant = alternative ? node.authoredVariants[alternative] : undefined
    if (!variant) {
      return {
        transformationId,
        status: 'rejected',
        preservationClass: rule.preservationClass,
        reason: 'missing-authored-alternative',
        detail: `Node ${node.id} has no authored ${alternative} variant`,
      }
    }
    if (!variant.reviewed) {
      return {
        transformationId,
        status: 'rejected',
        preservationClass: rule.preservationClass,
        reason: 'unreviewed-authored-alternative',
        detail: `The authored ${alternative} variant on ${node.id} is not reviewed`,
      }
    }
    return {
      transformationId,
      status: 'permitted',
      preservationClass: rule.preservationClass,
      reason: 'permitted-by-authored-variant',
      detail: `Node ${node.id} ships a reviewed ${alternative} variant`,
    }
  }

  if (rule.legality === 'requires-reviewed-variant') {
    const reviewed = node.reviewedVariants.find(
      (variant) => variant.transformationId === rule.id,
    )
    if (!reviewed) {
      return {
        transformationId,
        status: 'rejected',
        preservationClass: rule.preservationClass,
        reason: 'no-reviewed-variant',
        detail: `${rule.id} changes meaning and node ${node.id} carries no reviewed variant permitting it`,
      }
    }
    return {
      transformationId,
      status: 'permitted',
      preservationClass: rule.preservationClass,
      reason: 'permitted-by-reviewed-variant',
      detail: `Reviewed variant ${reviewed.id} permits ${rule.id} on ${node.id}`,
    }
  }

  return {
    transformationId,
    status: 'permitted',
    preservationClass: rule.preservationClass,
    reason: 'permitted-by-policy',
    detail: `${rule.id} preserves meaning and needs no authored alternative`,
  }
}

/** Every transformation id a graph names must exist in the policy. */
export function findUnknownTransformationIds(
  graph: PublicationGraph,
  policy: TransformationPolicy = DEFAULT_TRANSFORMATION_POLICY,
) {
  const known = new Set(policy.rules.map((rule) => rule.id))
  const unknown = new Set<string>()
  for (const node of graph.nodes) {
    for (const id of node.permittedTransformations) {
      if (!known.has(id)) unknown.add(`${node.id}:${id}`)
    }
    for (const variant of node.reviewedVariants) {
      if (!known.has(variant.transformationId)) {
        unknown.add(`${node.id}:${variant.transformationId}`)
      }
    }
  }
  return [...unknown].sort()
}
