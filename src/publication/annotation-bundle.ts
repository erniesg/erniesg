import { z } from 'zod'
import {
  resolveTextAnchor,
  semanticTextAnchorSchema,
  textAnnotationSchema,
  type SemanticTextAnchor,
  type TextAnchorResolution,
  type TextAnnotation,
} from '../research/annotations'
import type { ResearchNode } from '../research/schema'
import {
  assertSupportedVersion,
  boundedText,
  canonicalIdSchema,
  canonicalPublicationJson,
  publicationNodeText,
  type PublicationGraph,
  PUBLICATION_LIMITS,
} from './schema'

export const ANNOTATION_BUNDLE_VERSION = '1.0.0' as const

export const SUPPORTED_ANNOTATION_BUNDLE_VERSIONS = [
  ANNOTATION_BUNDLE_VERSION,
] as const

export const ANNOTATION_BUNDLE_LIMITS = {
  anchors: 256,
  annotations: 1_000,
} as const

export const readingAnchorSchema = z
  .object({
    id: canonicalIdSchema,
    kind: z.enum(['reading-position', 'bookmark']),
    label: boundedText(PUBLICATION_LIMITS.shortText).optional(),
    target: semanticTextAnchorSchema,
  })
  .strict()

export type ReadingAnchor = z.infer<typeof readingAnchorSchema>

/**
 * Anchors and annotations travel *beside* the graph, never inside it. They are
 * reader state with their own lifecycle, and `ResearchPaper` has no field for
 * them, so this bundle does not pretend otherwise.
 */
export const annotationBundleSchema = z
  .object({
    version: z.literal(ANNOTATION_BUNDLE_VERSION),
    graphId: canonicalIdSchema,
    graphVersion: boundedText(64),
    anchors: z
      .array(readingAnchorSchema)
      .max(ANNOTATION_BUNDLE_LIMITS.anchors),
    annotations: z
      .array(textAnnotationSchema)
      .max(ANNOTATION_BUNDLE_LIMITS.annotations),
  })
  .strict()
  .superRefine((bundle, context) => {
    const seen = new Set<string>()
    for (const [index, anchor] of bundle.anchors.entries()) {
      if (seen.has(anchor.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['anchors', index, 'id'],
          message: `Duplicate anchor id: ${anchor.id}`,
        })
      }
      seen.add(anchor.id)
    }
    for (const [index, annotation] of bundle.annotations.entries()) {
      if (seen.has(annotation.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['annotations', index, 'id'],
          message: `Duplicate annotation id: ${annotation.id}`,
        })
      }
      seen.add(annotation.id)
    }
  })

export type AnnotationBundle = z.infer<typeof annotationBundleSchema>

export function createAnnotationBundle(input: {
  graph: PublicationGraph
  anchors?: readonly ReadingAnchor[]
  annotations?: readonly TextAnnotation[]
}): AnnotationBundle {
  return annotationBundleSchema.parse({
    version: ANNOTATION_BUNDLE_VERSION,
    graphId: input.graph.metadata.id,
    graphVersion: input.graph.metadata.version,
    anchors: [...(input.anchors ?? [])],
    annotations: [...(input.annotations ?? [])],
  })
}

export function parseAnnotationBundle(value: unknown): AnnotationBundle {
  const version =
    value && typeof value === 'object' && 'version' in value
      ? (value as { version: unknown }).version
      : undefined
  assertSupportedVersion(
    'annotation bundle',
    version,
    SUPPORTED_ANNOTATION_BUNDLE_VERSIONS,
  )
  return annotationBundleSchema.parse(value)
}

export function serializeAnnotationBundle(bundle: AnnotationBundle) {
  return canonicalPublicationJson(bundle)
}

/**
 * Resolution stays owned by `src/research/annotations.ts`; this only projects
 * graph text into the shape that resolver already proves.
 */
export function resolveGraphTextAnchor(
  anchor: SemanticTextAnchor,
  graph: PublicationGraph,
): TextAnchorResolution {
  const node = graph.nodes.find((candidate) => candidate.id === anchor.nodeId)
  if (!node) {
    return { status: 'unresolved', nodeId: anchor.nodeId, reason: 'missing-node' }
  }
  const text = publicationNodeText(node)
  if (text === null) {
    return {
      status: 'unresolved',
      nodeId: anchor.nodeId,
      reason: 'non-text-node',
    }
  }
  const shim: ResearchNode = {
    id: node.id,
    type: 'paragraph',
    text,
    source: 'publication-graph',
  }
  return resolveTextAnchor(anchor, [shim])
}

export type AnnotationBundleResolution = {
  id: string
  kind: 'reading-position' | 'bookmark' | TextAnnotation['kind']
  resolution: TextAnchorResolution
}

export function resolveAnnotationBundle(
  bundle: AnnotationBundle,
  graph: PublicationGraph,
): AnnotationBundleResolution[] {
  return [
    ...bundle.anchors.map((anchor) => ({
      id: anchor.id,
      kind: anchor.kind,
      resolution: resolveGraphTextAnchor(anchor.target, graph),
    })),
    ...bundle.annotations.map((annotation) => ({
      id: annotation.id,
      kind: annotation.kind,
      resolution: resolveGraphTextAnchor(annotation.target, graph),
    })),
  ]
}

export function annotationBundleMatchesGraph(
  bundle: AnnotationBundle,
  graph: PublicationGraph,
) {
  return (
    bundle.graphId === graph.metadata.id &&
    bundle.graphVersion === graph.metadata.version
  )
}
