import { z } from 'zod'
import { createHash } from 'node:crypto'

const canonicalId = z.string().min(1)

const canonicalNodeBase = z
  .object({
    id: canonicalId,
    source: z.string().min(1),
  })
  .strict()

const headingNode = canonicalNodeBase
  .extend({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(3),
    text: z.string().min(1),
  })
  .strict()

const paragraphNode = canonicalNodeBase
  .extend({
    type: z.literal('paragraph'),
    text: z.string().min(1),
  })
  .strict()

const quoteNode = canonicalNodeBase
  .extend({
    type: z.literal('quote'),
    text: z.string().min(1),
  })
  .strict()

const captionNode = canonicalNodeBase
  .extend({
    type: z.literal('caption'),
    text: z.string().min(1),
  })
  .strict()

const figureNode = canonicalNodeBase
  .extend({
    type: z.literal('figure'),
    title: z.string().min(1),
    relationships: z
      .object({
        caption: canonicalId,
      })
      .strict(),
  })
  .strict()

const researchPaperBaseSchema = z
  .object({
    id: canonicalId,
    version: z.string().min(1),
    status: z.enum(['working', 'review', 'published']),
    title: z.string().min(1),
    subtitle: z.string().min(1),
    authors: z.array(z.string().min(1)).min(1),
    updated: z.string().date(),
    abstract: z.string().min(1),
    nodes: z
      .array(z.discriminatedUnion('type', [headingNode, paragraphNode, quoteNode, captionNode, figureNode]))
      .min(1),
  })
  .strict()

export const researchPaperSchema = researchPaperBaseSchema.superRefine((paper, context) => {
  const seen = new Set<string>()
  for (const [index, node] of paper.nodes.entries()) {
    if (seen.has(node.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'id'],
        message: `Duplicate canonical node id: ${node.id}`,
      })
    }
    seen.add(node.id)
  }

  const nodeIds = new Set(paper.nodes.map((node) => node.id))
  for (const [index, node] of paper.nodes.entries()) {
    if (node.type === 'figure' && !nodeIds.has(node.relationships.caption)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'relationships', 'caption'],
        message: `Dangling caption relationship: ${node.relationships.caption}`,
      })
    }
  }
})

const omittedRenditionKeys = new Set([
  'bbox',
  'bounds',
  'computedGeometry',
  'geometry',
  'layoutCache',
  'page',
  'pages',
  'position',
  'rect',
  'rendition',
  'renditions',
  'targetGeometry',
  'targets',
  'x',
  'y',
])

function stripRenditionFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRenditionFields)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !omittedRenditionKeys.has(key))
        .map(([key, nested]) => [key, stripRenditionFields(nested)]),
    )
  }
  return value
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalContentHash(paper: ResearchPaper | unknown) {
  const canonicalJson = stableJson(stripRenditionFields(paper))
  return createHash('sha256').update(canonicalJson).digest('hex')
}

export type ResearchPaper = z.infer<typeof researchPaperSchema>
export type ResearchNode = ResearchPaper['nodes'][number]
