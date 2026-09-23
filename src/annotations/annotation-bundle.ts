import { z } from 'zod'
import {
  DOCUMENT_SCOPE_NODE_ID,
  semanticTextAnchorSchema,
  textAnnotationSchema,
  type SemanticTextAnchor,
  type TextAnnotation,
} from './annotations'
import type { PublicationGraph } from '../publication/schema'

export const ANNOTATION_BUNDLE_VERSION = '1.1.0' as const

export const annotationBundleSchema = z
  .object({
    version: z.enum(['1.0.0', ANNOTATION_BUNDLE_VERSION]),
    graphId: z.string().min(1).max(256),
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
    if (bundle.version === '1.0.0') {
      bundle.annotations.forEach((annotation, index) => {
        if (annotation.kind === 'proposal' || annotation.target.positionUnit) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['annotations', index],
            message: 'Annotation requires bundle version 1.1.0',
          })
        }
      })
      bundle.anchors.forEach((entry, index) => {
        if (entry.anchor.positionUnit) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['anchors', index],
            message: 'Codepoint position requires bundle version 1.1.0',
          })
        }
      })
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

export function createAnnotationBundle(
  graph: PublicationGraph,
  annotations: readonly TextAnnotation[],
  anchors: readonly {
    id: string
    anchor: SemanticTextAnchor
  }[] = annotations.map((annotation) => ({
    id: `${annotation.id}:target`,
    anchor: annotation.target,
  })),
): AnnotationBundle {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const nodeText = (node: PublicationGraph['nodes'][number]) =>
    'text' in node
      ? node.text
      : node.type === 'figure'
        ? (node.sourceText ?? '')
        : node.type === 'equation'
          ? node.source
          : node.type === 'code'
            ? node.code
            : null
  const documentSpans: { start: number; end: number }[] = []
  let documentText = ''
  for (const node of graph.nodes) {
    const text = node.type === 'figure' ? null : nodeText(node)
    if (text === null) continue
    const start = documentText.length
    documentText += text
    documentSpans.push({ start, end: documentText.length })
  }
  const utf16Offset = (
    text: string,
    offset: number,
    unit: SemanticTextAnchor['positionUnit'],
  ) =>
    unit === 'codepoint' ? [...text].slice(0, offset).join('').length : offset
  const validateAnchor = (id: string, anchor: SemanticTextAnchor) => {
    if (anchor.nodeId === DOCUMENT_SCOPE_NODE_ID) {
      const start = utf16Offset(
        documentText,
        anchor.position.start,
        anchor.positionUnit,
      )
      const end = utf16Offset(
        documentText,
        anchor.position.end,
        anchor.positionUnit,
      )
      if (
        documentText.slice(start, end) !== anchor.quote.exact ||
        !documentSpans.some((span) => start >= span.start && end <= span.end)
      ) {
        throw new Error(`Anchor ${id} does not match graph node text`)
      }
      return
    }
    const node = nodesById.get(anchor.nodeId)
    if (!node) {
      throw new Error(
        `Anchor ${id} targets missing graph node ${anchor.nodeId}`,
      )
    }
    const text = nodeText(node)
    if (
      text === null ||
      text.slice(
        utf16Offset(text, anchor.position.start, anchor.positionUnit),
        utf16Offset(text, anchor.position.end, anchor.positionUnit),
      ) !== anchor.quote.exact
    ) {
      throw new Error(`Anchor ${id} does not match graph node text`)
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
    graphId: graph.id,
    anchors,
    annotations,
  })
}

export function serializeAnnotationBundle(bundle: AnnotationBundle) {
  return JSON.stringify(annotationBundleSchema.parse(bundle))
}
