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

export const semanticTextAnchorSchema = z
  .object({
    nodeId: z.string().min(1),
    // Repository-created anchors use JavaScript UTF-16 offsets. W3C wire
    // anchors retain their code-point offsets so a resolver with the document
    // text can translate them without losing the original selector.
    positionUnit: z.enum(['utf16', 'codepoint']).optional(),
    position: textPositionSelectorSchema,
    quote: textQuoteSelectorSchema,
  })
  .strict()
  .refine(
    /**
     * The span has to match the quote. It does not have to say which unit it
     * was counted in, because nothing here can tell.
     *
     * W3C `TextPositionSelector` counts characters; every producer in this file
     * derives offsets from `indexOf` and `.slice`, which count UTF-16 units.
     * The two differ only over non-BMP text — an emoji is one character and two
     * units — and this schema validates annotations from both: the ones this
     * file builds, and the ones the Worker receives over a Web Annotation wire.
     *
     * Requiring UTF-16 rejected a conformant client; requiring characters made
     * `createSemanticTextAnchor` throw on its own output. Accepting a span
     * consistent with either catches the error that matters — a span that
     * describes different text than the quote — and leaves the choice of
     * coordinate system to the reader that has the document, which is the only
     * place it can be resolved. See #336 and the note on #312.
     */
    (anchor) => {
      const span = anchor.position.end - anchor.position.start
      const quoteLength =
        anchor.positionUnit === 'codepoint'
          ? [...anchor.quote.exact].length
          : anchor.quote.exact.length
      return span === quoteLength
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
  nodeId?: string
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

function utf16OffsetForCodePointOffset(
  text: string,
  offset: number,
): number | null {
  const codePoints = [...text]
  return offset <= codePoints.length
    ? codePoints.slice(0, offset).join('').length
    : null
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

function documentPositionCandidate(
  anchor: SemanticTextAnchor,
  nodes: readonly ResearchNode[],
): { nodeId: string; start: number; end: number } | null {
  const documentText = nodes.map((node) => textForNode(node) ?? '').join('')
  let documentOffset = 0
  let documentUtf16Offset = 0

  for (const node of nodes) {
    const text = textForNode(node)
    if (text === null) continue

    const textLength =
      anchor.positionUnit === 'codepoint' ? [...text].length : text.length
    const localStart = anchor.position.start - documentOffset
    const localEnd = anchor.position.end - documentOffset

    if (localStart >= 0 && localEnd <= textLength) {
      const start =
        anchor.positionUnit === 'codepoint'
          ? utf16OffsetForCodePointOffset(text, localStart)
          : localStart
      const end =
        anchor.positionUnit === 'codepoint'
          ? utf16OffsetForCodePointOffset(text, localEnd)
          : localEnd

      if (
        start !== null &&
        end !== null &&
        text.slice(start, end) === anchor.quote.exact
      ) {
        const context = contextMatches(
          documentText,
          documentUtf16Offset + start,
          documentUtf16Offset + end,
          anchor,
        )
        if (context.prefixMatches && context.suffixMatches) {
          return { nodeId: node.id, start, end }
        }
      }
    }

    documentOffset += textLength
    documentUtf16Offset += text.length
  }

  return null
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
  if (anchor.nodeId === '@document') {
    const positionMatch = documentPositionCandidate(anchor, nodes)
    if (positionMatch) {
      return {
        status: 'resolved',
        ...positionMatch,
        matchedBy: 'position-and-context',
      }
    }

    const documentText = nodes.map((node) => textForNode(node) ?? '').join('')
    let documentOffset = 0
    const candidates: ResolutionCandidate[] = nodes.flatMap((node) => {
      const text = textForNode(node)
      if (text === null) return []
      const matchesInNode: ResolutionCandidate[] = []
      let searchFrom = 0
      while (searchFrom <= text.length - anchor.quote.exact.length) {
        const start = text.indexOf(anchor.quote.exact, searchFrom)
        if (start < 0) break
        const end = start + anchor.quote.exact.length
        matchesInNode.push({
          nodeId: node.id,
          start,
          end,
          ...contextMatches(
            documentText,
            documentOffset + start,
            documentOffset + end,
            anchor,
          ),
        })
        searchFrom = start + 1
      }
      documentOffset += text.length
      return matchesInNode
    })
    if (candidates.length === 0) {
      return {
        status: 'unresolved',
        nodeId: anchor.nodeId,
        reason: 'quote-not-found',
      }
    }

    const contextualCandidates = candidates.filter(
      (candidate) => candidate.prefixMatches && candidate.suffixMatches,
    )
    const match =
      contextualCandidates.length === 1
        ? contextualCandidates[0]
        : candidates.length === 1
          ? candidates[0]
          : null
    if (match && match.nodeId) {
      return {
        status: 'resolved',
        nodeId: match.nodeId,
        start: match.start,
        end: match.end,
        matchedBy:
          contextualCandidates.length === 1
            ? 'quote-and-context'
            : 'unique-quote',
      }
    }

    return {
      status: 'ambiguous',
      nodeId: anchor.nodeId,
      reason:
        contextualCandidates.length > 1
          ? 'Multiple exact quotes also match the stored context.'
          : 'Multiple exact quotes remain and the stored context does not identify one safely.',
      candidates,
    }
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

  const candidates: ResolutionCandidate[] = []
  let searchFrom = 0
  while (searchFrom <= text.length - anchor.quote.exact.length) {
    const start = text.indexOf(anchor.quote.exact, searchFrom)
    if (start < 0) break
    const end = start + anchor.quote.exact.length
    candidates.push({ start, end, ...contextMatches(text, start, end, anchor) })
    searchFrom = start + 1
  }

  if (candidates.length === 0) {
    return {
      status: 'unresolved',
      nodeId: anchor.nodeId,
      reason: 'quote-not-found',
    }
  }

  const positionStart =
    anchor.positionUnit === 'codepoint'
      ? utf16OffsetForCodePointOffset(text, anchor.position.start)
      : anchor.position.start
  const positionEnd =
    anchor.positionUnit === 'codepoint'
      ? utf16OffsetForCodePointOffset(text, anchor.position.end)
      : anchor.position.end
  const positionCandidate = candidates.find(
    (candidate) =>
      candidate.start === positionStart &&
      candidate.end === positionEnd &&
      candidate.prefixMatches &&
      candidate.suffixMatches,
  )
  if (positionCandidate) {
    return {
      status: 'resolved',
      nodeId: anchor.nodeId,
      start: positionCandidate.start,
      end: positionCandidate.end,
      matchedBy: 'position-and-context',
    }
  }

  const contextualCandidates = candidates.filter(
    (candidate) => candidate.prefixMatches && candidate.suffixMatches,
  )
  if (contextualCandidates.length === 1) {
    return {
      status: 'resolved',
      nodeId: anchor.nodeId,
      start: contextualCandidates[0].start,
      end: contextualCandidates[0].end,
      matchedBy: 'quote-and-context',
    }
  }

  if (candidates.length === 1) {
    return {
      status: 'resolved',
      nodeId: anchor.nodeId,
      start: candidates[0].start,
      end: candidates[0].end,
      matchedBy: 'unique-quote',
    }
  }

  return {
    status: 'ambiguous',
    nodeId: anchor.nodeId,
    reason:
      contextualCandidates.length > 1
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
