import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ResearchNode, ResearchPaper } from './schema'
import { targetProfileIdSchema } from './target-schema'
import type { TargetProfileId } from './targets'

export const targetOverrideSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    target: targetProfileIdSchema,
    canonicalId: z.string().min(1),
    patch: z
      .object({
        chosenVariant: z.string().min(1),
      })
      .strict(),
    provenance: z
      .object({
        source: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict(),
  })
  .strict()

export type TargetOverride = z.infer<typeof targetOverrideSchema>

export const DEFAULT_EXPORT_OVERRIDES: readonly TargetOverride[] = [
  targetOverrideSchema.parse({
    id: 'print-pipeline-emphasis',
    version: '1.0.0',
    target: 'print',
    canonicalId: 'fig-pipeline',
    patch: { chosenVariant: 'full-span-emphasized' },
    provenance: {
      source: 'docs/issues/007-srt-target-overrides-and-exports.md',
      reason: 'Exercise one inspectable print-only presentation change.',
    },
  }),
]

export function getDefaultExportOverrides(documentId: string) {
  return documentId === 'semantic-responsive-typesetting'
    ? DEFAULT_EXPORT_OVERRIDES
    : []
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function parseTargetOverrides(input: readonly unknown[]) {
  const overrides = z.array(targetOverrideSchema).parse(input)
  const ids = new Set<string>()
  const selectors = new Set<string>()

  for (const override of overrides) {
    if (ids.has(override.id)) {
      throw new Error(`Duplicate override id: ${override.id}`)
    }
    ids.add(override.id)

    const selector = `${override.target}:${override.canonicalId}`
    if (selectors.has(selector)) {
      throw new Error(`Duplicate override selector: ${selector}`)
    }
    selectors.add(selector)
  }

  return overrides
}

export function validateTargetOverrides(
  input: readonly unknown[],
  paper: ResearchPaper,
) {
  const overrides = parseTargetOverrides(input)
  const canonicalIds = new Set(paper.nodes.map((node) => node.id))

  for (const override of overrides) {
    if (!canonicalIds.has(override.canonicalId)) {
      throw new Error(
        `Override ${override.id} selects unknown canonical node ${override.canonicalId}`,
      )
    }
  }

  return overrides
}

export function overridesForTarget(
  overrides: readonly TargetOverride[],
  target: TargetProfileId,
) {
  return overrides.filter((override) => override.target === target)
}

export function targetOverrideDigest(
  overrides: readonly TargetOverride[],
  target?: TargetProfileId,
) {
  const applicable = target ? overridesForTarget(overrides, target) : overrides
  return createHash('sha256').update(stableJson(applicable)).digest('hex')
}

export function resolveTargetOverrides(
  target: TargetProfileId,
  node: ResearchNode,
  chosenVariant: string,
  overrides: readonly TargetOverride[],
) {
  const applied = overrides.filter(
    (override) =>
      override.target === target && override.canonicalId === node.id,
  )

  return {
    chosenVariant: applied[0]?.patch.chosenVariant ?? chosenVariant,
    applied,
  }
}
