/**
 * The site's view of the annotation model.
 *
 * The model itself now lives in `packages/margin/`, because the browser half
 * has to ship it to a reader and a published package cannot import this
 * repository. Only the generic core moved: the schemas, anchor construction
 * and `resolveTextAnchor`. What is left here is what is specific to this
 * site's own documents — the research demo annotations and the layout version
 * string, both of which know about papers and target profiles.
 *
 * There is one implementation. This file re-exports it rather than keeping a
 * second copy, and the path is relative because `packages/margin/` is a
 * publishable package rather than an installed dependency of this app.
 */
import {
  createSemanticTextAnchor,
  createSemanticTextAnchorFromRange,
  textAnnotationSchema,
} from '../../packages/margin/src/anchor'
import type { ResearchPaper } from '../research/schema'
import type { TargetProfileId } from '../research/targets'

export * from '../../packages/margin/src/anchor'
export * from '../../packages/margin/src/document'

const DEMO_ANCHOR_QUOTE =
  'Once meaning becomes coordinates, every new screen or sheet becomes a repair job.'

export function createDemoAnnotations(paper: ResearchPaper) {
  const preferredNode = paper.nodes.find(
    (candidate) =>
      candidate.id === 'p-proposition-1' &&
      candidate.type === 'paragraph' &&
      candidate.text.includes(DEMO_ANCHOR_QUOTE),
  )
  const fallbackNode = paper.nodes.find(
    (candidate) =>
      candidate.type !== 'figure' && candidate.text.trim().length > 0,
  )
  const node = preferredNode ?? fallbackNode
  if (!node || node.type === 'figure') return []

  const target = preferredNode
    ? createSemanticTextAnchor(node.id, node.text, DEMO_ANCHOR_QUOTE)
    : (() => {
        const start = node.text.search(/\S/u)
        const exact = Array.from(node.text.slice(start))
          .slice(0, 160)
          .join('')
          .trimEnd()
        return createSemanticTextAnchorFromRange(
          node.id,
          node.text,
          start,
          start + exact.length,
        )
      })()

  return [
    textAnnotationSchema.parse({
      id: 'highlight-reading-position',
      kind: 'highlight',
      target,
      appearance: { color: 'amber' },
      geometryCache: [],
    }),
    textAnnotationSchema.parse({
      id: 'note-reading-position',
      kind: 'note',
      target,
      body: 'Geometry may change; this note remains attached to the semantic sentence.',
      geometryCache: [],
    }),
  ]
}

export function createLayoutVersion(input: {
  documentId: string
  documentVersion: string
  target: TargetProfileId
  widthCssPx: number
  heightCssPx: number | null
  fontScale: number
  compositionPolicyVersion: string
  paginationPolicyVersion: string
  overrideDigest?: string
}) {
  return [
    `document=${encodeURIComponent(input.documentId)}@${encodeURIComponent(input.documentVersion)}`,
    `target=${input.target}`,
    `width=${input.widthCssPx}`,
    `height=${input.heightCssPx ?? 'continuous'}`,
    `font=${input.fontScale}`,
    `composition=${input.compositionPolicyVersion}`,
    `pagination=${input.paginationPolicyVersion}`,
    ...(input.overrideDigest ? [`override=${input.overrideDigest}`] : []),
  ].join(';')
}
