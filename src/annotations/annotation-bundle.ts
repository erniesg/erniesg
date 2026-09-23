import { z } from 'zod'
import {
  semanticTextAnchorSchema,
  textAnnotationSchema,
  type SemanticTextAnchor,
  type TextAnnotation,
} from './annotations'
import type { PublicationGraph } from '../publication/schema'

export const ANNOTATION_BUNDLE_VERSION = '1.1.0' as const

export const annotationBundleSchema = z
  .object({
    version: z.literal(ANNOTATION_BUNDLE_VERSION),
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
  const textForNode = (node: PublicationGraph['nodes'][number]) =>
    'text' in node
      ? node.text
      : node.type === 'figure'
        ? (node.sourceText ?? '')
        : node.type === 'equation'
          ? node.source
          : node.type === 'code'
            ? node.code
            : null
  const utf16Offset = (text: string, offset: number) => {
    const codePoints = [...text]
    return offset <= codePoints.length
      ? codePoints.slice(0, offset).join('').length
      : null
  }
  const matches = (text: string, anchor: SemanticTextAnchor) => {
    const start =
      anchor.positionUnit === 'codepoint'
        ? utf16Offset(text, anchor.position.start)
        : anchor.position.start
    const end =
      anchor.positionUnit === 'codepoint'
        ? utf16Offset(text, anchor.position.end)
        : anchor.position.end
    return (
      start !== null &&
      end !== null &&
      text.slice(start, end) === anchor.quote.exact
    )
  }
  const validateAnchor = (id: string, anchor: SemanticTextAnchor) => {
    if (anchor.nodeId === '@document') {
      const candidates = graph.nodes.filter((node) => {
        const text = textForNode(node)
        if (text === null) return false
        const start = text.indexOf(anchor.quote.exact)
        if (start < 0) return false
        const end = start + anchor.quote.exact.length
        return (
          text.slice(0, start).endsWith(anchor.quote.prefix) &&
          text.slice(end).startsWith(anchor.quote.suffix)
        )
      })
      if (candidates.length !== 1) {
        throw new Error(`Anchor ${id} does not resolve to one graph node`)
      }
      return
    }
    const node = graph.nodes.find((candidate) => candidate.id === anchor.nodeId)
    if (!node) {
      throw new Error(
        `Anchor ${id} targets missing graph node ${anchor.nodeId}`,
      )
    }
    const text = textForNode(node)
    if (text === null || !matches(text, anchor)) {
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
