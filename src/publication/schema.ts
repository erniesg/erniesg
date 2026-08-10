import { createHash } from 'node:crypto'
import { z } from 'zod'

export const PUBLICATION_GRAPH_VERSION = '1.0.0' as const

export const SUPPORTED_PUBLICATION_GRAPH_VERSIONS = [
  PUBLICATION_GRAPH_VERSION,
] as const

export const PUBLICATION_NODE_TYPES = [
  'heading',
  'paragraph',
  'list',
  'quote',
  'code',
  'figure',
  'caption',
  'table',
  'equation',
  'aside',
  'note',
  'reference',
  'media',
] as const

export type PublicationNodeType = (typeof PUBLICATION_NODE_TYPES)[number]

/**
 * Every bound is declared once so codecs reject unbounded text and collections
 * instead of trusting whichever source adapter produced them.
 */
export const PUBLICATION_LIMITS = {
  idLength: 128,
  shortText: 240,
  titleText: 512,
  bodyText: 20_000,
  abstractText: 8_000,
  urlLength: 2_048,
  nodes: 5_000,
  editions: 64,
  authors: 64,
  affiliations: 64,
  inlineRuns: 2_000,
  noteReferences: 256,
  backlinks: 256,
  relationships: 64,
  assetRefs: 32,
  targetIds: 32,
  accessibilityAlternatives: 8,
  permittedTransformations: 64,
  reviewedVariants: 16,
  tableRows: 512,
  tableCells: 64,
  headerIds: 64,
} as const

const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13
const SPACE = 32
const DELETE = 127

/**
 * Written without escape literals so the rule stays readable: canonical text may
 * carry tabs and newlines, but never other C0 controls or DEL.
 */
export function hasControlCharacters(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) continue
    if (code < SPACE || code === DELETE) return true
  }
  return false
}

/**
 * Canonical content is medium independent. These keys are how page geometry
 * historically leaks into a document model, so the codec refuses them outright
 * instead of relying on every future node author remembering the rule.
 */
export const FORBIDDEN_CANONICAL_KEYS = [
  'bbox',
  'bounds',
  'box',
  'column',
  'columns',
  'coordinates',
  'geometry',
  'height',
  'layout',
  'left',
  'margins',
  'page',
  'pageIndex',
  'pageNumber',
  'pages',
  'rect',
  'rectangle',
  'rendition',
  'renditions',
  'rotation',
  'targetGeometry',
  'targets',
  'top',
  'width',
  'x',
  'y',
] as const

const LOCAL_PATH_PATTERN =
  /(?:^|\s|=|:)(?:\/(?:Users|home|var|etc|tmp|mnt|opt|private|root)\/|[A-Za-z]:\\|\\\\[A-Za-z]|file:\/\/|~\/)/

const SECRET_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b(?:api[\s_-]?key|secret|password|passwd|token|authorization)\s*[:=]\s*\S+)/i

const SAFE_URL_PROTOCOLS = new Set(['https:', 'mailto:'])

export function isSafePublicationUrl(value: string) {
  if (value.length === 0 || value.length > PUBLICATION_LIMITS.urlLength) {
    return false
  }
  if (hasControlCharacters(value)) return false
  if (value.startsWith('#')) return value.length > 1
  try {
    return SAFE_URL_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

export function isSafeSourceReference(value: string) {
  return !LOCAL_PATH_PATTERN.test(value) && !SECRET_PATTERN.test(value)
}

export function isCanonicalLocaleTag(value: string) {
  try {
    const canonical = Intl.getCanonicalLocales(value)
    return canonical.length === 1 && canonical[0] === value
  } catch {
    return false
  }
}

export function boundedText(max: number, min = 1) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !hasControlCharacters(value), {
      message: 'Bounded text must not contain control characters',
    })
}

export const canonicalIdSchema = z
  .string()
  .min(1)
  .max(PUBLICATION_LIMITS.idLength)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'Canonical ids are bounded slugs without whitespace or path separators',
  )

export const localeTagSchema = z
  .string()
  .min(1)
  .max(35)
  .refine(isCanonicalLocaleTag, {
    message: 'Locale must be a canonical BCP 47 tag (use "und" when unproven)',
  })

export const safeUrlSchema = z
  .string()
  .max(PUBLICATION_LIMITS.urlLength)
  .refine(isSafePublicationUrl, {
    message: 'Only https, mailto, and in-document fragment URLs are permitted',
  })

export const sourceReferenceSchema = boundedText(
  PUBLICATION_LIMITS.shortText,
).refine(isSafeSourceReference, {
  message: 'Source references must not carry local paths or secret material',
})

export const transformationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'Transformation ids are lowercase kebab-case')

export const publicationProvenanceSchema = z
  .object({
    source: sourceReferenceSchema,
    locator: sourceReferenceSchema.optional(),
    method: z.enum([
      'authored',
      'imported',
      'derived',
      'transcribed',
      'ocr',
      'unknown',
    ]),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()

const accessibilityAlternativeSchema = z
  .object({
    kind: z.enum([
      'short-text',
      'long-description',
      'transcript',
      'caption-track',
      'sign-language',
    ]),
    locale: localeTagSchema,
    text: boundedText(PUBLICATION_LIMITS.bodyText),
  })
  .strict()

export const accessibilitySchema = z
  .object({
    alternatives: z
      .array(accessibilityAlternativeSchema)
      .max(PUBLICATION_LIMITS.accessibilityAlternatives),
    decorative: z.boolean().optional(),
  })
  .strict()

const authoredVariantSchema = z
  .object({
    assetId: canonicalIdSchema.optional(),
    text: boundedText(PUBLICATION_LIMITS.bodyText).optional(),
    reviewed: z.boolean(),
    reviewedBy: boundedText(PUBLICATION_LIMITS.shortText).optional(),
  })
  .strict()

export const authoredVariantsSchema = z
  .object({
    compact: authoredVariantSchema.optional(),
    monochrome: authoredVariantSchema.optional(),
    static: authoredVariantSchema.optional(),
  })
  .strict()

export const reviewedVariantSchema = z
  .object({
    id: canonicalIdSchema,
    transformationId: transformationIdSchema,
    reviewedBy: boundedText(PUBLICATION_LIMITS.shortText),
    rationale: boundedText(PUBLICATION_LIMITS.shortText),
    replacementText: boundedText(PUBLICATION_LIMITS.bodyText).optional(),
  })
  .strict()

export const nodeEditionSchema = z
  .object({
    editionId: canonicalIdSchema,
    translationOfNodeId: canonicalIdSchema.optional(),
  })
  .strict()

export const relationshipSchema = z
  .object({
    role: z.enum([
      'caption',
      'see-also',
      'continues',
      'translation-source',
      'reference-target',
    ]),
    targetId: canonicalIdSchema,
  })
  .strict()

export const assetReferenceSchema = z
  .object({
    role: z.enum(['primary', 'thumbnail', 'alternative', 'transcript']),
    assetId: canonicalIdSchema,
  })
  .strict()

export const inlineRunSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    href: safeUrlSchema.optional(),
    annotationId: canonicalIdSchema.optional(),
    relationshipId: canonicalIdSchema.optional(),
    verticalAlign: z.enum(['superscript', 'subscript']).optional(),
    compactMathAtom: z.boolean().optional(),
    semanticRole: z
      .enum([
        'citation',
        'cross-reference',
        'affiliation-marker',
        'bibliography-entry',
      ])
      .optional(),
    targetIds: z
      .array(canonicalIdSchema)
      .max(PUBLICATION_LIMITS.targetIds)
      .optional(),
  })
  .strict()

export const noteReferenceSchema = z
  .object({
    id: canonicalIdSchema,
    label: boundedText(PUBLICATION_LIMITS.shortText),
    targetId: canonicalIdSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

export const listContextSchema = z
  .object({
    level: z.number().int().min(1).max(9),
    ordered: z.boolean(),
    numberingId: canonicalIdSchema,
    markerStyle: z
      .enum([
        'decimal',
        'lower-roman',
        'upper-roman',
        'lower-alpha',
        'upper-alpha',
        'disc',
      ])
      .optional(),
    ordinal: z.number().int().positive().optional(),
    markerText: boundedText(PUBLICATION_LIMITS.shortText).optional(),
    continuedFromPreviousPage: z.boolean().optional(),
  })
  .strict()

const tableCellSchema = z
  .object({
    text: z.string().max(PUBLICATION_LIMITS.bodyText),
    headerScope: z.enum(['column', 'row']).nullable(),
    columnSpan: z.number().int().positive().max(PUBLICATION_LIMITS.tableCells),
    rowSpan: z.number().int().positive().max(PUBLICATION_LIMITS.tableRows),
    id: canonicalIdSchema.optional(),
    headerIds: z
      .array(canonicalIdSchema)
      .max(PUBLICATION_LIMITS.headerIds)
      .optional(),
    inlineRuns: z
      .array(inlineRunSchema)
      .max(PUBLICATION_LIMITS.inlineRuns)
      .optional(),
    inlineMapping: z
      .object({
        expected: z.number().int().nonnegative(),
        mapped: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const tableGridSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            cells: z
              .array(tableCellSchema)
              .min(1)
              .max(PUBLICATION_LIMITS.tableCells),
          })
          .strict(),
      )
      .min(1)
      .max(PUBLICATION_LIMITS.tableRows),
  })
  .strict()

const inlineRunsField = z
  .array(inlineRunSchema)
  .max(PUBLICATION_LIMITS.inlineRuns)
  .optional()

const noteReferencesField = z
  .array(noteReferenceSchema)
  .max(PUBLICATION_LIMITS.noteReferences)
  .optional()

const nodeBase = z.object({
  id: canonicalIdSchema,
  locale: localeTagSchema,
  direction: z.enum(['ltr', 'rtl', 'auto']),
  requirement: z.enum(['required', 'optional']),
  importance: z.enum(['primary', 'supporting', 'incidental']),
  provenance: publicationProvenanceSchema,
  accessibility: accessibilitySchema,
  authoredVariants: authoredVariantsSchema,
  permittedTransformations: z
    .array(transformationIdSchema)
    .max(PUBLICATION_LIMITS.permittedTransformations),
  reviewedVariants: z
    .array(reviewedVariantSchema)
    .max(PUBLICATION_LIMITS.reviewedVariants),
  edition: nodeEditionSchema,
  relationships: z
    .array(relationshipSchema)
    .max(PUBLICATION_LIMITS.relationships),
  assetRefs: z
    .array(assetReferenceSchema)
    .max(PUBLICATION_LIMITS.assetRefs),
})

const bodyTextField = boundedText(PUBLICATION_LIMITS.bodyText)
const titleField = boundedText(PUBLICATION_LIMITS.titleText)

const headingNodeSchema = nodeBase
  .extend({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(6),
    text: bodyTextField,
    inlineRuns: inlineRunsField,
    noteReferences: noteReferencesField,
  })
  .strict()

const paragraphNodeSchema = nodeBase
  .extend({
    type: z.literal('paragraph'),
    text: bodyTextField,
    inlineRuns: inlineRunsField,
    noteReferences: noteReferencesField,
  })
  .strict()

const listNodeSchema = nodeBase
  .extend({
    type: z.literal('list'),
    text: bodyTextField,
    list: listContextSchema,
    inlineRuns: inlineRunsField,
    noteReferences: noteReferencesField,
  })
  .strict()

const quoteNodeSchema = nodeBase
  .extend({
    type: z.literal('quote'),
    text: bodyTextField,
    attribution: boundedText(PUBLICATION_LIMITS.shortText).optional(),
    inlineRuns: inlineRunsField,
    noteReferences: noteReferencesField,
  })
  .strict()

const codeNodeSchema = nodeBase
  .extend({
    type: z.literal('code'),
    text: bodyTextField,
    language: z
      .string()
      .max(40)
      .regex(/^[a-z][a-z0-9+#-]*$/)
      .optional(),
  })
  .strict()

const captionNodeSchema = nodeBase
  .extend({
    type: z.literal('caption'),
    text: bodyTextField,
    inlineRuns: inlineRunsField,
  })
  .strict()

const objectNodeFields = {
  title: titleField,
  sourceText: bodyTextField.optional(),
  declaredObjectType: z.enum(['figure', 'table', 'equation']).optional(),
  inlineRuns: inlineRunsField,
}

const figureNodeSchema = nodeBase
  .extend({ type: z.literal('figure'), ...objectNodeFields })
  .strict()

const tableNodeSchema = nodeBase
  .extend({
    type: z.literal('table'),
    ...objectNodeFields,
    table: tableGridSchema.optional(),
  })
  .strict()

const equationNodeSchema = nodeBase
  .extend({
    type: z.literal('equation'),
    ...objectNodeFields,
    notation: z.enum(['latex', 'mathml', 'text']).optional(),
  })
  .strict()

const asideNodeSchema = nodeBase
  .extend({
    type: z.literal('aside'),
    kind: z.enum(['note', 'sidebar', 'callout', 'pull-quote']),
    text: bodyTextField,
    inlineRuns: inlineRunsField,
  })
  .strict()

const noteNodeSchema = nodeBase
  .extend({
    type: z.literal('note'),
    kind: z.enum(['footnote', 'endnote']),
    label: boundedText(PUBLICATION_LIMITS.shortText),
    markerText: boundedText(PUBLICATION_LIMITS.shortText).optional(),
    text: bodyTextField,
    inlineRuns: inlineRunsField,
    backlinks: z.array(canonicalIdSchema).max(PUBLICATION_LIMITS.backlinks),
  })
  .strict()

const referenceNodeSchema = nodeBase
  .extend({
    type: z.literal('reference'),
    label: boundedText(PUBLICATION_LIMITS.shortText),
    text: bodyTextField,
    inlineRuns: inlineRunsField,
    identifiers: z
      .object({
        doi: boundedText(PUBLICATION_LIMITS.shortText).optional(),
        isbn: boundedText(64).optional(),
        url: safeUrlSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const mediaNodeSchema = nodeBase
  .extend({
    type: z.literal('media'),
    mediaKind: z.enum(['audio', 'video', 'embed']),
    title: titleField,
    sourceText: bodyTextField.optional(),
    inlineRuns: inlineRunsField,
  })
  .strict()

export const publicationNodeSchema = z.discriminatedUnion('type', [
  headingNodeSchema,
  paragraphNodeSchema,
  listNodeSchema,
  quoteNodeSchema,
  codeNodeSchema,
  captionNodeSchema,
  figureNodeSchema,
  tableNodeSchema,
  equationNodeSchema,
  asideNodeSchema,
  noteNodeSchema,
  referenceNodeSchema,
  mediaNodeSchema,
])

export const editionSchema = z
  .object({
    id: canonicalIdSchema,
    kind: z.enum(['primary', 'translation', 'locale-variant']),
    locale: localeTagSchema,
    direction: z.enum(['ltr', 'rtl', 'auto']),
    label: boundedText(PUBLICATION_LIMITS.shortText),
    translationOf: canonicalIdSchema.optional(),
  })
  .strict()

const metadataLineageSchema = z
  .object({
    status: z.enum(['proven', 'unresolved']),
    source: boundedText(PUBLICATION_LIMITS.shortText),
    evidence: z.array(boundedText(PUBLICATION_LIMITS.shortText)).min(1).max(32),
  })
  .strict()

export const publicationMetadataSchema = z
  .object({
    id: canonicalIdSchema,
    version: boundedText(64),
    status: z.enum(['working', 'review', 'published']),
    title: titleField,
    subtitle: titleField.optional(),
    authors: z
      .array(boundedText(PUBLICATION_LIMITS.shortText))
      .min(1)
      .max(PUBLICATION_LIMITS.authors),
    abstract: boundedText(PUBLICATION_LIMITS.abstractText),
    updated: z.string().date(),
    language: localeTagSchema.optional(),
    baseDirection: z.enum(['ltr', 'rtl', 'unknown']).optional(),
    publicationDate: z.string().date().optional(),
    artifactModifiedAt: z.string().datetime({ offset: true }).optional(),
    affiliations: z
      .array(boundedText(PUBLICATION_LIMITS.shortText))
      .max(PUBLICATION_LIMITS.affiliations)
      .optional(),
    authorAffiliations: z
      .array(
        z
          .object({
            author: boundedText(PUBLICATION_LIMITS.shortText),
            label: boundedText(PUBLICATION_LIMITS.shortText),
          })
          .strict(),
      )
      .max(PUBLICATION_LIMITS.affiliations)
      .optional(),
    authorNotes: z
      .array(
        z
          .object({
            id: canonicalIdSchema,
            author: boundedText(PUBLICATION_LIMITS.shortText),
            label: boundedText(PUBLICATION_LIMITS.shortText),
            targetId: canonicalIdSchema,
          })
          .strict(),
      )
      .max(PUBLICATION_LIMITS.noteReferences)
      .optional(),
    metadataLineage: z
      .object({
        language: metadataLineageSchema,
        baseDirection: metadataLineageSchema,
        publicationDate: metadataLineageSchema,
        artifactModifiedAt: metadataLineageSchema,
      })
      .strict()
      .optional(),
  })
  .strict()

export type PublicationNode = z.infer<typeof publicationNodeSchema>
export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>
export type PublicationEdition = z.infer<typeof editionSchema>
export type PublicationProvenance = z.infer<typeof publicationProvenanceSchema>
export type PublicationInlineRun = z.infer<typeof inlineRunSchema>

/** Text a node owns for offset-addressed inline runs, notes, and anchors. */
export function publicationNodeText(node: PublicationNode): string | null {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
    case 'list':
    case 'quote':
    case 'code':
    case 'caption':
    case 'aside':
    case 'note':
    case 'reference':
      return node.text
    case 'figure':
    case 'table':
    case 'equation':
    case 'media':
      return node.sourceText ?? null
  }
}

export function findForbiddenCanonicalKeys(value: unknown, path = '$') {
  const forbidden = new Set<string>(FORBIDDEN_CANONICAL_KEYS)
  const found: string[] = []
  const walk = (current: unknown, currentPath: string) => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${currentPath}[${index}]`))
      return
    }
    if (!current || typeof current !== 'object') return
    for (const [key, nested] of Object.entries(current)) {
      if (forbidden.has(key)) found.push(`${currentPath}.${key}`)
      walk(nested, `${currentPath}.${key}`)
    }
  }
  walk(value, path)
  return found
}

function validateGraph(
  graph: {
    metadata: PublicationMetadata
    editions: PublicationEdition[]
    nodes: PublicationNode[]
  },
  context: z.RefinementCtx,
) {
  for (const forbidden of findForbiddenCanonicalKeys(graph.nodes, '$.nodes')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nodes'],
      message: `Target geometry is forbidden in canonical content: ${forbidden}`,
    })
  }

  const editionIds = new Set<string>()
  let primaryEditions = 0
  for (const [index, edition] of graph.editions.entries()) {
    if (editionIds.has(edition.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['editions', index, 'id'],
        message: `Duplicate edition id: ${edition.id}`,
      })
    }
    editionIds.add(edition.id)
    if (edition.kind === 'primary') primaryEditions += 1
  }
  if (primaryEditions !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['editions'],
      message: 'A publication graph declares exactly one primary edition',
    })
  }
  for (const [index, edition] of graph.editions.entries()) {
    if (edition.translationOf && !editionIds.has(edition.translationOf)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['editions', index, 'translationOf'],
        message: `Dangling edition linkage: ${edition.translationOf}`,
      })
    }
  }

  const nodeIds = new Set<string>()
  for (const [index, node] of graph.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'id'],
        message: `Duplicate canonical node id: ${node.id}`,
      })
    }
    nodeIds.add(node.id)
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const noteReferenceTargets = new Map<string, string>()

  for (const [index, entry] of (graph.metadata.authorNotes ?? []).entries()) {
    if (noteReferenceTargets.has(entry.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadata', 'authorNotes', index, 'id'],
        message: `Duplicate note reference id: ${entry.id}`,
      })
    }
    noteReferenceTargets.set(entry.id, entry.targetId)
    if (nodeById.get(entry.targetId)?.type !== 'note') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadata', 'authorNotes', index, 'targetId'],
        message: `Dangling author-note relationship: ${entry.targetId}`,
      })
    }
    if (!graph.metadata.authors.includes(entry.author)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadata', 'authorNotes', index, 'author'],
        message: `Author note names an unknown author: ${entry.author}`,
      })
    }
  }

  for (const [index, node] of graph.nodes.entries()) {
    if (!editionIds.has(node.edition.editionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'edition', 'editionId'],
        message: `Dangling edition linkage: ${node.edition.editionId}`,
      })
    }
    if (
      node.edition.translationOfNodeId &&
      node.edition.translationOfNodeId === node.id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'edition', 'translationOfNodeId'],
        message: 'A node cannot be a translation of itself',
      })
    }

    for (const [
      relationshipIndex,
      relationship,
    ] of node.relationships.entries()) {
      const target = nodeById.get(relationship.targetId)
      if (!target) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'relationships', relationshipIndex, 'targetId'],
          message: `Dangling relationship: ${relationship.targetId}`,
        })
        continue
      }
      if (relationship.role === 'caption' && target.type !== 'caption') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'relationships', relationshipIndex, 'role'],
          message: `Caption relationship must target a caption node: ${relationship.targetId}`,
        })
      }
    }

    for (const [variantIndex, variant] of node.reviewedVariants.entries()) {
      if (!node.permittedTransformations.includes(variant.transformationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'reviewedVariants', variantIndex],
          message: `Reviewed variant ${variant.id} names a transformation the node does not permit`,
        })
      }
    }

    const text = publicationNodeText(node)
    if ('inlineRuns' in node && node.inlineRuns) {
      for (const [runIndex, run] of node.inlineRuns.entries()) {
        if (text === null || run.start >= run.end || run.end > text.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'inlineRuns', runIndex],
            message: `Invalid inline run text range: ${run.start}-${run.end}`,
          })
        }
      }
    }

    if ('noteReferences' in node && node.noteReferences) {
      for (const [referenceIndex, reference] of node.noteReferences.entries()) {
        if (noteReferenceTargets.has(reference.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'noteReferences', referenceIndex, 'id'],
            message: `Duplicate note reference id: ${reference.id}`,
          })
        }
        noteReferenceTargets.set(reference.id, reference.targetId)
        if (nodeById.get(reference.targetId)?.type !== 'note') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              'nodes',
              index,
              'noteReferences',
              referenceIndex,
              'targetId',
            ],
            message: `Dangling note relationship: ${reference.targetId}`,
          })
        }
        if (
          text === null ||
          reference.start >= reference.end ||
          reference.end > text.length
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'noteReferences', referenceIndex],
            message: `Invalid note reference text range: ${reference.start}-${reference.end}`,
          })
        }
      }
    }
  }

  for (const [index, node] of graph.nodes.entries()) {
    if (node.type !== 'note') continue
    for (const [backlinkIndex, backlink] of node.backlinks.entries()) {
      if (!noteReferenceTargets.has(backlink)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'backlinks', backlinkIndex],
          message: `Dangling note backlink: ${backlink}`,
        })
      } else if (noteReferenceTargets.get(backlink) !== node.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'backlinks', backlinkIndex],
          message: `Note backlink ${backlink} targets a different note`,
        })
      }
    }
  }

  for (const [referenceId, targetId] of noteReferenceTargets) {
    const target = nodeById.get(targetId)
    if (target?.type === 'note' && !target.backlinks.includes(referenceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Note relationship ${referenceId} is missing its backlink`,
      })
    }
  }
}

export const publicationGraphSchema = z
  .object({
    version: z.literal(PUBLICATION_GRAPH_VERSION),
    metadata: publicationMetadataSchema,
    editions: z
      .array(editionSchema)
      .min(1)
      .max(PUBLICATION_LIMITS.editions),
    nodes: z
      .array(publicationNodeSchema)
      .min(1)
      .max(PUBLICATION_LIMITS.nodes),
  })
  .strict()
  .superRefine(validateGraph)

export type PublicationGraph = z.infer<typeof publicationGraphSchema>

export class UnsupportedPublicationVersionError extends Error {
  constructor(
    readonly contract: string,
    readonly received: unknown,
    readonly supported: readonly string[],
  ) {
    super(
      `Unsupported ${contract} version ${JSON.stringify(received)}; supported: ${supported.join(', ')}`,
    )
    this.name = 'UnsupportedPublicationVersionError'
  }
}

export function assertSupportedVersion(
  contract: string,
  received: unknown,
  supported: readonly string[],
) {
  if (typeof received !== 'string' || !supported.includes(received)) {
    throw new UnsupportedPublicationVersionError(contract, received, supported)
  }
}

export function parsePublicationGraph(value: unknown): PublicationGraph {
  const version =
    value && typeof value === 'object' && 'version' in value
      ? (value as { version: unknown }).version
      : undefined
  assertSupportedVersion(
    'publication graph',
    version,
    SUPPORTED_PUBLICATION_GRAPH_VERSIONS,
  )
  return publicationGraphSchema.parse(value)
}

/** Key-sorted JSON so two equal contracts always produce identical bytes. */
export function canonicalPublicationJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPublicationJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${canonicalPublicationJson(nested)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function serializePublicationGraph(graph: PublicationGraph): string {
  return canonicalPublicationJson(graph)
}

export function publicationDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalPublicationJson(value)).digest('hex')}`
}
