import { z } from 'zod'
import {
  semanticTextAnchorSchema,
  textAnnotationSchema,
  type SemanticTextAnchor,
  type TextAnnotation,
} from './annotations'
import {
  DOCUMENT_SCOPE_NODE_ID,
  resolveTextAnchor,
  utf16OffsetForCodePointOffset,
} from '../../packages/margin/src/anchor'

export const ANNOTATION_BUNDLE_VERSION = '1.2.0' as const
export const LEGACY_ANNOTATION_BUNDLE_VERSION = '1.0.0' as const
export const LEGACY_GRAPH_ANNOTATION_BUNDLE_VERSION = '1.1.0' as const

/**
 * The canonical anchor source: Struct block ids and their text.
 *
 * The graph used to name a block. The Struct document names it now, and this
 * source is how a caller says which document it is anchoring into and which
 * blocks of it an anchor may address.
 */
export type AnnotationAnchorSource = {
  /** The canonical source id (the Struct document id). */
  id: string
  /** The anchorable nodes: the Struct block id, its kind, and its text. */
  nodes: readonly { id: string; type: string; text?: string }[]
}

/**
 * A legacy graph node, as the 1.0.0 and 1.1.0 bundles addressed it.
 *
 * A graph node carried its text in whichever field matched its kind, and the
 * rollback path has to read a legacy node the way the writer that produced
 * the legacy bundle did.
 */
export type LegacyAnnotationAnchorNode = {
  id: string
  type: string
  text?: string
  code?: string
  source?: string
  sourceText?: string
}

/**
 * Marks a source that only resolves legacy anchors.
 *
 * The legacy map is read-only: it exists so a rollback to the 1.0.0 and
 * 1.1.0 bundles still resolves the anchors they carry, and it must never
 * write a bundle of its own. The marker is how the writer refuses it.
 */
const LEGACY_ANCHOR_SOURCE: unique symbol = Symbol(
  'legacy-annotation-anchor-source',
)

export const annotationBundleSchema = z
  .object({
    version: z.enum([
      LEGACY_ANNOTATION_BUNDLE_VERSION,
      LEGACY_GRAPH_ANNOTATION_BUNDLE_VERSION,
      ANNOTATION_BUNDLE_VERSION,
    ]),
    sourceId: z.string().min(1).max(256).optional(),
    graphId: z.string().min(1).max(256).optional(),
    anchors: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            anchor: semanticTextAnchorSchema,
          })
          .strict(),
      )
      .max(100_000),
    annotations: z.array(textAnnotationSchema).max(100_000),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.version === ANNOTATION_BUNDLE_VERSION) {
      if (bundle.sourceId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceId'],
          message:
            'A 1.2.0 annotation bundle requires its sourceId: the Struct source is the anchor authority',
        })
      }
      if (bundle.graphId !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['graphId'],
          message:
            'A 1.2.0 annotation bundle must not carry a graphId: the graph is no longer the anchor authority',
        })
      }
    } else {
      if (bundle.graphId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['graphId'],
          message: `A ${bundle.version} annotation bundle requires its graphId`,
        })
      }
      if (bundle.sourceId !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceId'],
          message: `A ${bundle.version} annotation bundle must not carry a sourceId`,
        })
      }
    }
    const anchorIds = new Set<string>()
    bundle.anchors.forEach((entry, index) => {
      if (anchorIds.has(entry.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['anchors', index, 'id'],
          message: `Duplicate anchor id: ${entry.id}`,
        })
      }
      anchorIds.add(entry.id)
    })
    const annotationIds = new Set<string>()
    bundle.annotations.forEach((annotation, index) => {
      if (annotationIds.has(annotation.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['annotations', index, 'id'],
          message: `Duplicate annotation id: ${annotation.id}`,
        })
      }
      annotationIds.add(annotation.id)
    })
  })

export type AnnotationBundle = z.infer<typeof annotationBundleSchema>

function isLegacyAnchorSource(source: AnnotationAnchorSource): boolean {
  return LEGACY_ANCHOR_SOURCE in source
}

/**
 * Write an annotation bundle against a Struct-derived anchor source.
 *
 * The source carries the Struct block ids and their text, and the anchors
 * are resolved against them with the same selector chain the margin package
 * uses. The bundle records the source id and never a graph id.
 */
export function createAnnotationBundle(
  source: AnnotationAnchorSource,
  annotations: readonly TextAnnotation[],
  anchors: readonly {
    id: string
    anchor: SemanticTextAnchor
  }[] = annotations.map((annotation) => ({
    id: `${annotation.id}:target`,
    anchor: annotation.target,
  })),
): AnnotationBundle {
  if (isLegacyAnchorSource(source)) {
    throw new Error(
      'A legacy annotation anchor map is read-only: it cannot write an annotation bundle',
    )
  }
  const nodesById = new Map(source.nodes.map((node) => [node.id, node]))
  const validateAnchor = (id: string, anchor: SemanticTextAnchor) => {
    if (anchor.nodeId === DOCUMENT_SCOPE_NODE_ID) {
      // The source's own nodes are the ordered text the document-scoped
      // selector chain reads, exactly as the graph's nodes used to be.
      if (resolveTextAnchor(anchor, source.nodes).status !== 'resolved') {
        throw new Error(`Anchor ${id} does not resolve to one source node`)
      }
      return
    }
    const node = nodesById.get(anchor.nodeId)
    if (!node) {
      throw new Error(
        `Anchor ${id} targets missing source node ${anchor.nodeId}`,
      )
    }
    const text = node.text ?? null
    const start =
      text !== null && anchor.positionUnit === 'codepoint'
        ? utf16OffsetForCodePointOffset(text, anchor.position.start)
        : anchor.position.start
    const end =
      text !== null && anchor.positionUnit === 'codepoint'
        ? utf16OffsetForCodePointOffset(text, anchor.position.end)
        : anchor.position.end
    if (
      text === null ||
      start === null ||
      end === null ||
      text.slice(start, end) !== anchor.quote.exact
    ) {
      throw new Error(`Anchor ${id} does not match source node text`)
    }
  }
  for (const entry of anchors) {
    validateAnchor(entry.id, entry.anchor)
  }
  for (const annotation of annotations) {
    validateAnchor(annotation.id, annotation.target)
  }
  return annotationBundleSchema.parse({
    version: ANNOTATION_BUNDLE_VERSION,
    sourceId: source.id,
    anchors,
    annotations,
  })
}

/**
 * Read the anchors of a legacy 1.0.0 or 1.1.0 bundle.
 *
 * Those bundles address graph node ids, so a rollback resolves them through
 * this map. It is read-only in both directions: it never writes a bundle,
 * and the writer refuses a source that came from here, because a bundle
 * written against graph node ids would make the graph the anchor authority
 * again.
 */
export function createLegacyAnnotationAnchorMap(legacyGraph: {
  id: string
  nodes: readonly LegacyAnnotationAnchorNode[]
}): AnnotationAnchorSource {
  const source: AnnotationAnchorSource = {
    id: legacyGraph.id,
    nodes: legacyGraph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      text: legacyNodeText(node),
    })),
  }
  Object.defineProperty(source, LEGACY_ANCHOR_SOURCE, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return source
}

/** The text a legacy graph node carried, read the way its writer read it. */
function legacyNodeText(node: LegacyAnnotationAnchorNode): string | undefined {
  if (node.text !== undefined) return node.text
  if (node.type === 'code') return node.code
  if (node.type === 'equation') return node.source
  if (node.type === 'figure') return node.sourceText
  return undefined
}

export function serializeAnnotationBundle(bundle: AnnotationBundle) {
  return JSON.stringify(annotationBundleSchema.parse(bundle))
}
