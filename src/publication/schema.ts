import { z } from 'zod'

export const PUBLICATION_GRAPH_VERSION = '1.0.0' as const
export const MAX_PUBLICATION_NODES = 10_000
export const MAX_TEXT_LENGTH = 1_000_000

const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const textSchema = z.string().max(MAX_TEXT_LENGTH)
const nonEmptyTextSchema = textSchema.min(1)
function safeSourceValue(value: string) {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return false
  }
  if (
    /^(?:file:|[A-Za-z]:[\\/]|\/|\\\\)/i.test(decoded) ||
    /(?:token|secret|password|credential|api[_-]?key)\s*[=:]/i.test(decoded)
  ) {
    return false
  }
  try {
    const url = new URL(decoded)
    return !url.username && !url.password && url.protocol !== 'file:'
  } catch {
    return true
  }
}
const safeSourceValueSchema = nonEmptyTextSchema
  .max(2_048)
  .refine(
    safeSourceValue,
    'Source values cannot contain local paths or secret material',
  )
const localeSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      return Intl.getCanonicalLocales(value)[0] === value
    } catch {
      return false
    }
  }, 'Locale must be a canonical BCP 47 language tag')
const safeUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    if (/^#[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return
    try {
      const url = new URL(value)
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol))
        throw new Error()
      if (url.username || url.password) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'URL credentials are forbidden',
        })
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Only safe internal fragments and absolute http, https, or mailto URLs are permitted',
      })
    }
  })

export const publicationInlineRunSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    inlineCode: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    hardBreak: z.boolean().optional(),
    href: safeUrlSchema.optional(),
    annotationId: idSchema.optional(),
    verticalAlign: z.enum(['superscript', 'subscript']).optional(),
    compactMathAtom: z.boolean().optional(),
    relationshipId: idSchema.optional(),
    semanticRole: z
      .enum([
        'citation',
        'cross-reference',
        'affiliation-marker',
        'bibliography-entry',
      ])
      .optional(),
    targetIds: z.array(idSchema).max(256).optional(),
  })
  .strict()

export type PublicationInlineRun = z.infer<typeof publicationInlineRunSchema>

function inlineRunProducesLink(run: PublicationInlineRun) {
  return Boolean(
    run.href ||
    ((run.semanticRole === 'citation' ||
      run.semanticRole === 'cross-reference') &&
      run.targetIds?.length),
  )
}

const provenanceSchema = z
  .object({
    adapterId: idSchema,
    sourceId: safeSourceValueSchema,
    sourceRevision: safeSourceValueSchema.pipe(z.string().max(256)).optional(),
    evidence: z.array(safeSourceValueSchema).max(256).default([]),
  })
  .strict()

const accessibilitySchema = z
  .object({
    alternativeText: textSchema.optional(),
    longDescription: textSchema.optional(),
    transcript: textSchema.optional(),
    decorative: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decorative && (value.alternativeText || value.longDescription)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Decorative content cannot also declare textual alternatives',
      })
    }
  })

const variantSchema = z
  .object({
    kind: z.enum(['compact', 'monochrome', 'static']),
    assetId: idSchema.optional(),
    text: nonEmptyTextSchema.optional(),
    reviewed: z.boolean(),
  })
  .strict()
  .refine((value) => value.assetId !== undefined || value.text !== undefined, {
    message: 'An authored variant must contain text or an asset reference',
  })

const nodeBase = z.object({
  id: idSchema,
  locale: localeSchema,
  direction: z.enum(['ltr', 'rtl', 'auto']),
  requirement: z.enum(['required', 'optional']),
  importance: z.enum(['essential', 'supporting', 'supplemental']),
  provenance: provenanceSchema,
  accessibility: accessibilitySchema,
  variants: z.array(variantSchema).max(3).default([]),
  permittedTransformationIds: z.array(idSchema).max(256),
  edition: z
    .object({
      editionId: idSchema,
      equivalentNodeId: idSchema.optional(),
      sourceLocaleKey: nonEmptyTextSchema.max(256).optional(),
    })
    .strict(),
})

const textContent = {
  text: nonEmptyTextSchema,
  inlineRuns: z.array(publicationInlineRunSchema).max(100_000).optional(),
}

const relationshipArray = z.array(idSchema).max(10_000)
const uniqueChildListRelationshipArray = relationshipArray.superRefine(
  (ids, context) => {
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Nested child-list relationships must be unique',
      })
  },
)
const uniqueListItemRelationshipArray = relationshipArray
  .min(1)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'List item relationships must be unique',
      })
  })
const headingNode = nodeBase
  .extend({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(6),
    ...textContent,
  })
  .strict()
const paragraphNode = nodeBase
  .extend({ type: z.literal('paragraph'), ...textContent })
  .strict()
const listNode = nodeBase
  .extend({
    type: z.literal('list'),
    ordered: z.boolean(),
    start: z.number().int().nonnegative().optional(),
    itemIds: uniqueListItemRelationshipArray,
  })
  .strict()
const listItemNode = nodeBase
  .extend({
    type: z.literal('list-item'),
    parentListId: idSchema,
    childListIds: uniqueChildListRelationshipArray.default([]),
    ...textContent,
  })
  .strict()
const quoteNode = nodeBase
  .extend({
    type: z.literal('quote'),
    attribution: textSchema.optional(),
    ...textContent,
  })
  .strict()
const codeNode = nodeBase
  .extend({
    type: z.literal('code'),
    code: nonEmptyTextSchema,
    language: z.string().max(128).optional(),
  })
  .strict()
const figureNode = nodeBase
  .extend({
    type: z.literal('figure'),
    title: nonEmptyTextSchema,
    assetIds: relationshipArray,
    captionId: idSchema.optional(),
    sourceText: textSchema.optional(),
    inlineRuns: z.array(publicationInlineRunSchema).max(100_000).optional(),
  })
  .strict()
const captionNode = nodeBase
  .extend({ type: z.literal('caption'), parentId: idSchema, ...textContent })
  .strict()
const tableNode = nodeBase
  .extend({
    type: z.literal('table'),
    captionId: idSchema.optional(),
    rows: z
      .array(
        z
          .object({
            cells: z
              .array(
                z
                  .object({
                    id: idSchema.optional(),
                    text: textSchema,
                    headerScope: z.enum(['column', 'row']).nullable(),
                    columnSpan: z.number().int().min(1).max(1_000),
                    rowSpan: z.number().int().min(1).max(1_000),
                    headerIds: z.array(idSchema).max(1_000).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
const equationNode = nodeBase
  .extend({
    type: z.literal('equation'),
    source: nonEmptyTextSchema,
    format: z.enum(['mathml', 'latex', 'plain-text']),
    label: textSchema.optional(),
    captionId: idSchema.optional(),
  })
  .strict()
const asideNode = nodeBase
  .extend({ type: z.literal('aside'), ...textContent })
  .strict()
const noteNode = nodeBase
  .extend({
    type: z.literal('note'),
    noteKind: z.enum(['footnote', 'endnote', 'author-note']),
    label: nonEmptyTextSchema,
    backlinkIds: relationshipArray,
    ...textContent,
  })
  .strict()
const referenceNode = nodeBase
  .extend({
    type: z.literal('reference'),
    targetIds: relationshipArray,
    href: safeUrlSchema.optional(),
    ...textContent,
  })
  .strict()
const mediaNode = nodeBase
  .extend({
    type: z.literal('media'),
    mediaKind: z.enum(['image', 'audio', 'video', 'interactive']),
    assetId: idSchema,
    captionId: idSchema.optional(),
  })
  .strict()

export const publicationNodeSchema = z.discriminatedUnion('type', [
  headingNode,
  paragraphNode,
  listNode,
  listItemNode,
  quoteNode,
  codeNode,
  figureNode,
  captionNode,
  tableNode,
  equationNode,
  asideNode,
  noteNode,
  referenceNode,
  mediaNode,
])

const metadataSchema = z
  .object({
    title: nonEmptyTextSchema,
    subtitle: textSchema.optional(),
    contributors: z.array(nonEmptyTextSchema.max(1_024)).max(1_000),
    abstract: textSchema.optional(),
    status: z.enum(['working', 'review', 'published']).optional(),
    sourceDocumentVersion: nonEmptyTextSchema.max(256).optional(),
    created: z.string().date().optional(),
    modified: z.string().date().optional(),
    artifactModifiedAt: z.string().datetime({ offset: true }).optional(),
    defaultLocale: localeSchema,
    defaultDirection: z.enum(['ltr', 'rtl', 'auto']),
    keywords: z.array(nonEmptyTextSchema.max(256)).max(1_000).default([]),
  })
  .strict()

function relationshipTargets(node: z.infer<typeof publicationNodeSchema>) {
  switch (node.type) {
    case 'list':
      return node.itemIds
    case 'list-item':
      return [node.parentListId, ...node.childListIds]
    case 'figure':
      return node.captionId ? [node.captionId] : []
    case 'caption':
      return [node.parentId]
    case 'table':
    case 'equation':
    case 'media':
      return node.captionId ? [node.captionId] : []
    case 'note':
      return node.backlinkIds
    case 'reference':
      return node.targetIds
    default:
      return []
  }
}

export const publicationGraphSchema = z
  .object({
    version: z.literal(PUBLICATION_GRAPH_VERSION),
    id: idSchema,
    metadata: metadataSchema,
    edition: z
      .object({
        id: idSchema,
        locale: localeSchema,
        direction: z.enum(['ltr', 'rtl', 'auto']),
      })
      .strict(),
    nodes: z.array(publicationNodeSchema).min(1).max(MAX_PUBLICATION_NODES),
  })
  .strict()
  .superRefine((graph, context) => {
    const ids = new Set<string>()
    const nodesById = new Map<string, z.infer<typeof publicationNodeSchema>>()
    const renderedDomIds = new Set<string>()
    const claimRenderedDomId = (
      id: string,
      path: Array<string | number>,
      duplicateMessage = `Duplicate rendered DOM id: ${id}`,
    ) => {
      if (renderedDomIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: duplicateMessage,
        })
        return
      }
      renderedDomIds.add(id)
    }
    type InlineRunReference = {
      relationshipId: string | undefined
      semanticRole: PublicationInlineRun['semanticRole']
      targetIds: string[]
      href: string | undefined
      nodeIndex: number
      runIndex: number
    }
    const inlineRunsByTargetId = new Map<string, InlineRunReference[]>()
    const inlineAnchorRunsByRelationshipId = new Map<
      string,
      InlineRunReference[]
    >()
    graph.nodes.forEach((node, index) => {
      claimRenderedDomId(
        node.id,
        ['nodes', index, 'id'],
        ids.has(node.id)
          ? `Duplicate node id: ${node.id}`
          : `Duplicate rendered DOM id: ${node.id}`,
      )
      ids.add(node.id)
      nodesById.set(node.id, node)
      if (
        node.type === 'figure' &&
        (node.sourceText ||
          node.variants.some(
            (variant) => variant.reviewed && variant.text !== undefined,
          ))
      )
        claimRenderedDomId(`${node.id}-source`, ['nodes', index, 'id'])
      if (
        node.type === 'media' &&
        !node.accessibility.decorative &&
        node.accessibility.transcript?.trim()
      )
        claimRenderedDomId(`${node.id}-transcript`, [
          'nodes',
          index,
          'accessibility',
          'transcript',
        ])
      if ('inlineRuns' in node && node.inlineRuns) {
        node.inlineRuns.forEach((run, runIndex) => {
          const reference: InlineRunReference = {
            relationshipId: run.relationshipId,
            semanticRole: run.semanticRole,
            targetIds: run.targetIds ?? [],
            href: run.href,
            nodeIndex: index,
            runIndex,
          }
          if (run.relationshipId && inlineRunProducesLink(run)) {
            const anchors =
              inlineAnchorRunsByRelationshipId.get(run.relationshipId) ?? []
            anchors.push(reference)
            inlineAnchorRunsByRelationshipId.set(run.relationshipId, anchors)
          }
          for (const targetId of new Set(run.targetIds ?? [])) {
            const references = inlineRunsByTargetId.get(targetId) ?? []
            references.push(reference)
            inlineRunsByTargetId.set(targetId, references)
          }
        })
      }
      if (node.edition.editionId !== graph.edition.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'edition', 'editionId'],
          message: 'Node edition must link to the graph edition',
        })
      }
      if ('inlineRuns' in node && node.inlineRuns) {
        const content = 'text' in node ? node.text : (node.sourceText ?? '')
        node.inlineRuns.forEach((run, runIndex) => {
          if (run.start >= run.end || run.end > content.length) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'inlineRuns', runIndex],
              message: 'Inline range lies outside node text',
            })
          }
          run.targetIds?.forEach((target, targetIndex) => {
            if (!graph.nodes.some((candidate) => candidate.id === target)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  'nodes',
                  index,
                  'inlineRuns',
                  runIndex,
                  'targetIds',
                  targetIndex,
                ],
                message: `Dangling inline target: ${target}`,
              })
            }
          })
        })
        const linkProducingRuns = node.inlineRuns
          .map((run, runIndex) => ({ run, runIndex }))
          .filter(({ run }) => inlineRunProducesLink(run))
          .sort(
            (left, right) =>
              left.run.start - right.run.start || right.run.end - left.run.end,
          )
        let activeRun: (typeof linkProducingRuns)[number] | undefined
        for (const candidate of linkProducingRuns) {
          if (activeRun && candidate.run.start < activeRun.run.end) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'inlineRuns', candidate.runIndex],
              message: 'Link-producing inline runs must not overlap',
            })
          }
          if (!activeRun || candidate.run.end > activeRun.run.end)
            activeRun = candidate
        }
      }
      if (node.type === 'table') {
        const cellIds = new Set<string>()
        node.rows.forEach((row, rowIndex) => {
          row.cells.forEach((cell, cellIndex) => {
            if (cell.id) {
              claimRenderedDomId(
                cell.id,
                ['nodes', index, 'rows', rowIndex, 'cells', cellIndex, 'id'],
                cellIds.has(cell.id)
                  ? `Duplicate table cell id: ${cell.id}`
                  : `Duplicate rendered DOM id: ${cell.id}`,
              )
              cellIds.add(cell.id)
            }
          })
        })
        node.rows.forEach((row, rowIndex) => {
          row.cells.forEach((cell, cellIndex) => {
            cell.headerIds?.forEach((headerId, headerIndex) => {
              const targetCell = node.rows
                .flatMap((candidateRow) => candidateRow.cells)
                .find((candidateCell) => candidateCell.id === headerId)
              if (!cellIds.has(headerId)) {
                context.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [
                    'nodes',
                    index,
                    'rows',
                    rowIndex,
                    'cells',
                    cellIndex,
                    'headerIds',
                    headerIndex,
                  ],
                  message: `Dangling table header relationship: ${headerId}`,
                })
              } else if (!targetCell?.headerScope) {
                context.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [
                    'nodes',
                    index,
                    'rows',
                    rowIndex,
                    'cells',
                    cellIndex,
                    'headerIds',
                    headerIndex,
                  ],
                  message:
                    'Table header relationships must target header cells',
                })
              }
            })
          })
        })
      }
    })
    for (const anchors of inlineAnchorRunsByRelationshipId.values()) {
      for (const anchor of anchors) {
        claimRenderedDomId(anchor.relationshipId!, [
          'nodes',
          anchor.nodeIndex,
          'inlineRuns',
          anchor.runIndex,
          'relationshipId',
        ])
      }
    }
    graph.nodes.forEach((node, index) => {
      relationshipTargets(node).forEach((target, relationshipIndex) => {
        if (node.type !== 'note' && !ids.has(target)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'relationships', relationshipIndex],
            message: `Dangling relationship: ${target}`,
          })
        }
      })
      if (node.type === 'list') {
        node.itemIds.forEach((id, relationshipIndex) => {
          const item = nodesById.get(id)
          if (
            item &&
            (item.type !== 'list-item' || item.parentListId !== node.id)
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'itemIds', relationshipIndex],
              message: 'List items must link reciprocally to their owning list',
            })
          }
        })
      }
      if (
        node.type === 'list-item' &&
        nodesById.get(node.parentListId)?.type !== 'list'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'parentListId'],
          message: 'List-item parent must be a list',
        })
      }
      if (node.type === 'list-item') {
        node.childListIds.forEach((childId, relationshipIndex) => {
          const child = nodesById.get(childId)
          if (child && child.type !== 'list') {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'childListIds', relationshipIndex],
              message: 'Nested list relationship must target a list',
            })
          }
        })
      }
      if (node.type === 'caption') {
        const parent = nodesById.get(node.parentId)
        if (
          parent &&
          !['figure', 'table', 'equation', 'media'].includes(parent.type)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'parentId'],
            message:
              'Caption parent must be a figure, table, equation, or media node',
          })
        }
        if (
          parent &&
          (!('captionId' in parent) || parent.captionId !== node.id)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'parentId'],
            message: 'Caption relationships must be reciprocal',
          })
        }
      }
      if ('captionId' in node && node.captionId) {
        const caption = nodesById.get(node.captionId)
        if (
          caption &&
          (caption.type !== 'caption' || caption.parentId !== node.id)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'captionId'],
            message: 'Caption relationships must be reciprocal',
          })
        }
      }
      if (node.type === 'note') {
        const references = inlineRunsByTargetId.get(node.id) ?? []
        const validReferencesByRelationshipId = new Map<
          string,
          InlineRunReference[]
        >()
        for (const reference of references) {
          if (
            reference.semanticRole !== 'cross-reference' ||
            reference.targetIds[0] !== node.id ||
            (reference.href && reference.href !== `#${node.id}`)
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                'nodes',
                reference.nodeIndex,
                'inlineRuns',
                reference.runIndex,
              ],
              message:
                'Inline note references must render cross-reference anchors targeting the note',
            })
            continue
          }
          if (!reference.relationshipId) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                'nodes',
                reference.nodeIndex,
                'inlineRuns',
                reference.runIndex,
                'relationshipId',
              ],
              message: 'Inline note references must have relationship IDs',
            })
            continue
          }
          const matchingReferences =
            validReferencesByRelationshipId.get(reference.relationshipId) ?? []
          matchingReferences.push(reference)
          validReferencesByRelationshipId.set(
            reference.relationshipId,
            matchingReferences,
          )
          if (
            (
              inlineAnchorRunsByRelationshipId.get(reference.relationshipId) ??
              []
            ).length !== 1
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                'nodes',
                reference.nodeIndex,
                'inlineRuns',
                reference.runIndex,
                'relationshipId',
              ],
              message: 'Inline anchor relationship IDs must be unique',
            })
          }
          if (!node.backlinkIds.includes(reference.relationshipId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                'nodes',
                reference.nodeIndex,
                'inlineRuns',
                reference.runIndex,
                'relationshipId',
              ],
              message:
                'Inline runs targeting notes must have reciprocal backlinks',
            })
          }
        }
        node.backlinkIds.forEach((backlinkId, backlinkIndex) => {
          if (
            node.backlinkIds.indexOf(backlinkId) === backlinkIndex &&
            (validReferencesByRelationshipId.get(backlinkId) ?? []).length ===
              1 &&
            (inlineAnchorRunsByRelationshipId.get(backlinkId) ?? []).length ===
              1
          )
            return
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'backlinkIds', backlinkIndex],
            message:
              'Note backlinks must identify one unique inline run targeting the note',
          })
        })
      }
    })

    const nestedListOwners = new Map<string, string>()
    const listEdges = new Map<string, string[]>()
    graph.nodes.forEach((node) => {
      if (node.type !== 'list-item') return
      const edges = listEdges.get(node.parentListId) ?? []
      for (const [relationshipIndex, childId] of node.childListIds.entries()) {
        const child = nodesById.get(childId)
        if (child?.type !== 'list') continue
        const owner = nestedListOwners.get(childId)
        if (owner && owner !== node.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: `Nested list ${childId} has multiple owners (${owner}, ${node.id})`,
          })
        } else {
          nestedListOwners.set(childId, node.id)
        }
        if (!edges.includes(childId)) edges.push(childId)
        if (childId === node.parentListId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: `Nested list relationship cycles through ${childId}`,
          })
        }
        void relationshipIndex
      }
      listEdges.set(node.parentListId, edges)
    })
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visitList = (listId: string) => {
      if (visiting.has(listId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes'],
          message: `Nested list relationship cycle detected at ${listId}`,
        })
        return
      }
      if (visited.has(listId)) return
      visiting.add(listId)
      for (const childId of listEdges.get(listId) ?? []) visitList(childId)
      visiting.delete(listId)
      visited.add(listId)
    }
    for (const node of graph.nodes) if (node.type === 'list') visitList(node.id)
  })

export type PublicationGraph = z.infer<typeof publicationGraphSchema>
export type PublicationNode = z.infer<typeof publicationNodeSchema>

export function parsePublicationGraph(value: unknown): PublicationGraph {
  return publicationGraphSchema.parse(value)
}

export function serializePublicationGraph(value: PublicationGraph) {
  return JSON.stringify(publicationGraphSchema.parse(value))
}
