import { z } from 'zod'
import type { ResearchNode, ResearchPaper } from '../research/schema'
import type { TargetProfileId } from '../research/targets'

const textPositionSelectorSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((selector) => selector.end > selector.start, {
    message: 'A text position selector must have a positive range',
  })

const textQuoteSelectorSchema = z
  .object({
    exact: z.string().min(1),
    prefix: z.string(),
    suffix: z.string(),
  })
  .strict()

export const DOCUMENT_SCOPE_NODE_ID = '@document'

export const semanticTextAnchorSchema = z
  .object({
    nodeId: z.string().min(1),
    /** Wire selectors count code points; local authors count UTF-16 units. */
    positionUnit: z.literal('codepoint').optional(),
    position: textPositionSelectorSchema,
    quote: textQuoteSelectorSchema,
  })
  .strict()
  .refine(
    (anchor) => {
      const span = anchor.position.end - anchor.position.start
      return (
        span ===
        (anchor.positionUnit === 'codepoint'
          ? [...anchor.quote.exact].length
          : anchor.quote.exact.length)
      )
    },
    {
      message: 'Text offsets must span the stored exact quote',
      path: ['position'],
    },
  )

const geometryRectangleSchema = z
  .object({
    page: z.number().int().positive(),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict()

const geometryCacheEntrySchema = z
  .object({
    layoutVersion: z.string().min(1),
    rectangles: z.array(geometryRectangleSchema),
  })
  .strict()

const annotationBase = z.object({
  id: z.string().min(1),
  target: semanticTextAnchorSchema,
  geometryCache: z.array(geometryCacheEntrySchema),
})

const highlightAnnotationSchema = annotationBase
  .extend({
    kind: z.literal('highlight'),
    appearance: z
      .object({
        color: z.string().min(1),
      })
      .strict(),
  })
  .strict()

const noteAnnotationSchema = annotationBase
  .extend({
    kind: z.literal('note'),
    body: z.string().min(1),
  })
  .strict()

// A proposal is a note whose body is offered as a replacement for the anchored
// text rather than as a remark beside it. It is a third member of the existing
// union rather than a second annotation model: the anchor, the id and the
// geometry cache are identical, and only the reader's intent differs. It maps
// to the W3C `editing` motivation. See `src/worker/margin/web-annotation.ts`.
const proposalAnnotationSchema = annotationBase
  .extend({
    kind: z.literal('proposal'),
    body: z.string().min(1),
  })
  .strict()

export const textAnnotationSchema = z.discriminatedUnion('kind', [
  highlightAnnotationSchema,
  noteAnnotationSchema,
  proposalAnnotationSchema,
])

export type SemanticTextAnchor = z.infer<typeof semanticTextAnchorSchema>
export type TextAnnotation = z.infer<typeof textAnnotationSchema>

/**
 * The text an annotation shows a reader, or `null` when it shows none.
 *
 * Exhaustive by construction, which is the point: adding a kind to the union
 * stops this compiling until it says whether it has a body. `proposal` arrived
 * without that, and every consumer testing `kind === 'note'` silently rendered
 * nothing for it — a body a reader wrote, stored and invisible.
 */
export function annotationBody(annotation: TextAnnotation): string | null {
  switch (annotation.kind) {
    case 'highlight':
      return null
    case 'note':
    case 'proposal':
      return annotation.body
  }
}
export type AnnotationGeometryRectangle = z.infer<
  typeof geometryRectangleSchema
>

type ResolutionCandidate = {
  start: number
  end: number
  prefixMatches: boolean
  suffixMatches: boolean
}

export type TextAnchorResolution =
  | {
      status: 'resolved'
      nodeId: string
      start: number
      end: number
      matchedBy: 'position-and-context' | 'quote-and-context' | 'unique-quote'
    }
  | {
      status: 'ambiguous'
      nodeId: string
      reason: string
      candidates: ResolutionCandidate[]
    }
  | {
      status: 'unresolved'
      nodeId: string
      reason: 'missing-node' | 'non-text-node' | 'quote-not-found'
    }

export const FREEHAND_ATTACHMENT_POLICY = {
  status: 'deferred',
  resolution: 'explicit-user-choice-required',
  reason:
    'Freehand strokes do not have a safely inferred text attachment under reflow.',
} as const

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

function textForNode(node: ResearchNode) {
  return node.type === 'figure' ? null : node.text
}

function contextMatches(
  text: string,
  start: number,
  end: number,
  anchor: SemanticTextAnchor,
) {
  return {
    prefixMatches: text.slice(0, start).endsWith(anchor.quote.prefix),
    suffixMatches: text.slice(end).startsWith(anchor.quote.suffix),
  }
}

/** Convert an absolute character offset only when the full preceding text exists. */
function utf16Offset(
  text: string,
  offset: number,
  unit: SemanticTextAnchor['positionUnit'],
): number | null {
  if (unit !== 'codepoint') return offset <= text.length ? offset : null
  let characters = 0
  let units = 0
  for (const character of text) {
    if (characters === offset) return units
    characters += 1
    units += character.length
  }
  return characters === offset ? units : null
}

function candidatesInText(
  text: string,
  anchor: SemanticTextAnchor,
): ResolutionCandidate[] {
  const candidates: ResolutionCandidate[] = []
  let searchFrom = 0
  while (searchFrom <= text.length - anchor.quote.exact.length) {
    const start = text.indexOf(anchor.quote.exact, searchFrom)
    if (start < 0) break
    const end = start + anchor.quote.exact.length
    candidates.push({ start, end, ...contextMatches(text, start, end, anchor) })
    searchFrom = start + 1
  }
  return candidates
}

function selectCandidate(
  candidates: ResolutionCandidate[],
  anchor: SemanticTextAnchor,
  text: string,
): {
  candidate: ResolutionCandidate
  matchedBy: Extract<TextAnchorResolution, { status: 'resolved' }>['matchedBy']
} | null {
  const start = utf16Offset(text, anchor.position.start, anchor.positionUnit)
  const end = utf16Offset(text, anchor.position.end, anchor.positionUnit)
  const position = candidates.find(
    (candidate) =>
      candidate.start === start &&
      candidate.end === end &&
      candidate.prefixMatches &&
      candidate.suffixMatches,
  )
  if (position)
    return { candidate: position, matchedBy: 'position-and-context' }
  const contextual = candidates.filter(
    (candidate) => candidate.prefixMatches && candidate.suffixMatches,
  )
  if (contextual.length === 1) {
    return { candidate: contextual[0], matchedBy: 'quote-and-context' }
  }
  if (candidates.length === 1) {
    return { candidate: candidates[0], matchedBy: 'unique-quote' }
  }
  return null
}

function resolveDocumentAnchor(
  anchor: SemanticTextAnchor,
  nodes: readonly ResearchNode[],
): TextAnchorResolution {
  const spans: { id: string; start: number; end: number }[] = []
  let text = ''
  for (const node of nodes) {
    const content = textForNode(node)
    if (content === null) continue
    const start = text.length
    text += content
    spans.push({ id: node.id, start, end: text.length })
  }
  const candidates = candidatesInText(text, anchor).filter((candidate) =>
    spans.some(
      (span) => candidate.start >= span.start && candidate.end <= span.end,
    ),
  )
  if (candidates.length === 0) {
    return {
      status: 'unresolved',
      nodeId: anchor.nodeId,
      reason: 'quote-not-found',
    }
  }
  const selected = selectCandidate(candidates, anchor, text)
  if (!selected) {
    return {
      status: 'ambiguous',
      nodeId: anchor.nodeId,
      reason:
        'Multiple document quotes remain and the stored context does not identify one safely.',
      candidates,
    }
  }
  const span = spans.find(
    (entry) =>
      selected.candidate.start >= entry.start &&
      selected.candidate.end <= entry.end,
  )!
  return {
    status: 'resolved',
    nodeId: span.id,
    start: selected.candidate.start - span.start,
    end: selected.candidate.end - span.start,
    matchedBy: selected.matchedBy,
  }
}

export function createSemanticTextAnchor(
  nodeId: string,
  text: string,
  exact: string,
  contextLength = 32,
): SemanticTextAnchor {
  const start = text.indexOf(exact)
  if (start < 0) {
    throw new Error(`Exact quote was not found in semantic node ${nodeId}`)
  }
  if (text.indexOf(exact, start + 1) >= 0) {
    throw new Error(
      `Exact quote is ambiguous in semantic node ${nodeId}; use createSemanticTextAnchorFromRange`,
    )
  }
  const end = start + exact.length

  return createSemanticTextAnchorFromRange(
    nodeId,
    text,
    start,
    end,
    contextLength,
  )
}

export function createSemanticTextAnchorFromRange(
  nodeId: string,
  text: string,
  start: number,
  end: number,
  contextLength = 32,
): SemanticTextAnchor {
  const exact = text.slice(start, end)

  return semanticTextAnchorSchema.parse({
    nodeId,
    position: { start, end },
    quote: {
      exact,
      prefix: text.slice(Math.max(0, start - contextLength), start),
      suffix: text.slice(end, end + contextLength),
    },
  })
}

export function resolveTextAnchor(
  anchor: SemanticTextAnchor,
  nodes: readonly ResearchNode[],
): TextAnchorResolution {
  if (anchor.nodeId === DOCUMENT_SCOPE_NODE_ID) {
    return resolveDocumentAnchor(anchor, nodes)
  }
  const node = nodes.find((candidate) => candidate.id === anchor.nodeId)
  if (!node) {
    return {
      status: 'unresolved',
      nodeId: anchor.nodeId,
      reason: 'missing-node',
    }
  }

  const text = textForNode(node)
  if (text === null) {
    return {
      status: 'unresolved',
      nodeId: anchor.nodeId,
      reason: 'non-text-node',
    }
  }

  const candidates = candidatesInText(text, anchor)

  if (candidates.length === 0) {
    return {
      status: 'unresolved',
      nodeId: anchor.nodeId,
      reason: 'quote-not-found',
    }
  }

  const selected = selectCandidate(candidates, anchor, text)
  if (selected) {
    return {
      status: 'resolved',
      nodeId: anchor.nodeId,
      start: selected.candidate.start,
      end: selected.candidate.end,
      matchedBy: selected.matchedBy,
    }
  }
  return {
    status: 'ambiguous',
    nodeId: anchor.nodeId,
    reason:
      candidates.filter((candidate) =>
        candidate.prefixMatches && candidate.suffixMatches,
      ).length > 1
        ? 'Multiple exact quotes also match the stored context.'
        : 'Multiple exact quotes remain and the stored context does not identify one safely.',
    candidates,
  }
}

export function cacheAnnotationGeometry(
  annotation: TextAnnotation,
  layoutVersion: string,
  rectangles: AnnotationGeometryRectangle[],
): TextAnnotation {
  return textAnnotationSchema.parse({
    ...annotation,
    geometryCache: [
      ...annotation.geometryCache.filter(
        (entry) => entry.layoutVersion !== layoutVersion,
      ),
      { layoutVersion, rectangles },
    ],
  })
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
