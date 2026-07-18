import { z } from 'zod'
import { createHash } from 'node:crypto'

const canonicalId = z.string().min(1)

const canonicalNodeBase = z
  .object({
    id: canonicalId,
    source: z.string().min(1),
  })
  .strict()

const noteReference = z
  .object({
    id: canonicalId,
    label: z.string().min(1),
    target: canonicalId,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

const inlineRun = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    href: z.string().min(1).optional(),
    relationshipId: canonicalId.optional(),
  })
  .strict()

const listContext = z
  .object({
    level: z.number().int().min(1).max(9),
    ordered: z.boolean(),
    numberingId: canonicalId,
  })
  .strict()

const headingNode = canonicalNodeBase
  .extend({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(3),
    text: z.string().min(1),
    noteReferences: z.array(noteReference).optional(),
    inlineRuns: z.array(inlineRun).optional(),
  })
  .strict()

const paragraphNode = canonicalNodeBase
  .extend({
    type: z.literal('paragraph'),
    text: z.string().min(1),
    noteReferences: z.array(noteReference).optional(),
    inlineRuns: z.array(inlineRun).optional(),
    list: listContext.optional(),
  })
  .strict()

const quoteNode = canonicalNodeBase
  .extend({
    type: z.literal('quote'),
    text: z.string().min(1),
    noteReferences: z.array(noteReference).optional(),
    inlineRuns: z.array(inlineRun).optional(),
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
    objectType: z.enum(['figure', 'table', 'equation']).optional(),
    table: z
      .object({
        rows: z
          .array(
            z
              .object({
                cells: z
                  .array(
                    z
                      .object({
                        text: z.string(),
                        header: z.boolean(),
                        columnSpan: z.number().int().positive(),
                        rowSpan: z.number().int().positive(),
                      })
                      .strict(),
                  )
                  .min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .optional(),
    relationships: z
      .object({
        caption: canonicalId,
        assets: z.array(canonicalId).min(1).optional(),
      })
      .strict(),
  })
  .strict()

const footnoteNode = canonicalNodeBase
  .extend({
    type: z.literal('footnote'),
    kind: z.enum(['footnote', 'endnote']),
    label: z.string().min(1),
    text: z.string().min(1),
    relationships: z
      .object({
        backlinks: z.array(canonicalId),
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
      .array(
        z.discriminatedUnion('type', [
          headingNode,
          paragraphNode,
          quoteNode,
          captionNode,
          figureNode,
          footnoteNode,
        ]),
      )
      .min(1),
  })
  .strict()

export const researchPaperSchema = researchPaperBaseSchema.superRefine(
  (paper, context) => {
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
    const noteReferenceIds = new Set<string>()
    const noteReferenceTargets = new Map<string, string>()
    for (const [index, node] of paper.nodes.entries()) {
      if (node.type === 'figure' && !nodeIds.has(node.relationships.caption)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'relationships', 'caption'],
          message: `Dangling caption relationship: ${node.relationships.caption}`,
        })
      }
      if ('noteReferences' in node && node.noteReferences) {
        for (const [
          referenceIndex,
          reference,
        ] of node.noteReferences.entries()) {
          if (noteReferenceIds.has(reference.id)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'noteReferences', referenceIndex, 'id'],
              message: `Duplicate note reference id: ${reference.id}`,
            })
          }
          noteReferenceIds.add(reference.id)
          noteReferenceTargets.set(reference.id, reference.target)
          const target = paper.nodes.find(
            (candidate) => candidate.id === reference.target,
          )
          if (!target || target.type !== 'footnote') {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                'nodes',
                index,
                'noteReferences',
                referenceIndex,
                'target',
              ],
              message: `Dangling note relationship: ${reference.target}`,
            })
          }
          if (
            reference.end > node.text.length ||
            reference.start >= reference.end
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'noteReferences', referenceIndex],
              message: `Invalid note reference text range: ${reference.start}-${reference.end}`,
            })
          }
        }
      }
      if ('inlineRuns' in node && node.inlineRuns) {
        for (const [runIndex, run] of node.inlineRuns.entries()) {
          if (run.end > node.text.length || run.start >= run.end) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'inlineRuns', runIndex],
              message: `Invalid inline run text range: ${run.start}-${run.end}`,
            })
          }
        }
      }
      if (
        node.type === 'figure' &&
        ((node.objectType === 'table' && !node.table) ||
          (node.objectType !== 'table' && node.table))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'table'],
          message: 'Structured table data must accompany only table figures',
        })
      }
    }
    for (const [index, node] of paper.nodes.entries()) {
      if (node.type !== 'footnote') continue
      for (const [
        backlinkIndex,
        backlink,
      ] of node.relationships.backlinks.entries()) {
        if (!noteReferenceIds.has(backlink)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'relationships', 'backlinks', backlinkIndex],
            message: `Dangling footnote backlink: ${backlink}`,
          })
        } else if (noteReferenceTargets.get(backlink) !== node.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'relationships', 'backlinks', backlinkIndex],
            message: `Footnote backlink ${backlink} targets a different note`,
          })
        }
      }
    }
    for (const [referenceId, targetId] of noteReferenceTargets) {
      const target = paper.nodes.find(
        (candidate) =>
          candidate.id === targetId && candidate.type === 'footnote',
      )
      if (
        target?.type === 'footnote' &&
        !target.relationships.backlinks.includes(referenceId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Note relationship ${referenceId} is missing its backlink`,
        })
      }
    }
  },
)

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
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalContentHash(paper: ResearchPaper | unknown) {
  return canonicalValueHash(paper)
}

export function canonicalNodeContentHash(node: ResearchNode | unknown) {
  return canonicalValueHash(node)
}

function canonicalValueHash(value: unknown) {
  const canonicalJson = stableJson(stripRenditionFields(value))
  return createHash('sha256').update(canonicalJson).digest('hex')
}

export type ResearchPaper = z.infer<typeof researchPaperSchema>
export type ResearchNode = ResearchPaper['nodes'][number]
