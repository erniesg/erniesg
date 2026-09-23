/**
 * The anchor model, and the selector chain that re-attaches an anchor to a
 * document that has changed underneath it.
 *
 * This file is the one implementation. It moved here out of `src/annotations/`
 * so the browser package and the site can share it; `src/annotations/` now
 * re-exports it rather than keeping a second copy. Nothing in here knows about
 * books, papers, research or any other surface — a node is an id and a string.
 *
 * Resolution runs four selectors, in this order:
 *
 *   1. `struct-id`            — the block's stable id, gated on its digest
 *   2. `position-and-context` — the stored offsets, with prefix/suffix agreeing
 *   3. `quote-and-context`    — the quote moved, but its neighbourhood did not
 *   4. `unique-quote`         — the quote occurs exactly once, context lost
 *
 * The last three predate this package and keep their meaning exactly. Struct
 * ids are additive: an anchor without one resolves precisely as it did before.
 */
import { z } from 'zod'

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

/**
 * The block the anchor was made in, as struct names it.
 *
 * `id` is structural and survives rewording. `digest` is what tells a resolver
 * whether the block still holds what it held: same id and same digest is the
 * same block, same id and a different digest is drift to confirm rather than
 * to follow, so the digest gate is what keeps the first selector honest.
 */
const structSelectorSchema = z
  .object({
    id: z.string().min(1),
    digest: z.string().min(1).optional(),
  })
  .strict()

export const semanticTextAnchorSchema = z
  .object({
    nodeId: z.string().min(1),
    struct: structSelectorSchema.optional(),
    /** Omitted repository anchors use UTF-16; W3C wire anchors use code points. */
    positionUnit: z.enum(['utf16', 'codepoint']).optional(),
    position: textPositionSelectorSchema,
    quote: textQuoteSelectorSchema,
  })
  .strict()
  .refine(
    (anchor) =>
      anchor.position.end - anchor.position.start ===
      (anchor.positionUnit === 'codepoint'
        ? [...anchor.quote.exact].length
        : anchor.quote.exact.length),
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

const proposalAnnotationSchema = annotationBase
  .extend({ kind: z.literal('proposal'), body: z.string().min(1) })
  .strict()

export const textAnnotationSchema = z.discriminatedUnion('kind', [
  highlightAnnotationSchema,
  noteAnnotationSchema,
  proposalAnnotationSchema,
])

export type StructSelector = z.infer<typeof structSelectorSchema>
export type SemanticTextAnchor = z.infer<typeof semanticTextAnchorSchema>
export type TextAnnotation = z.infer<typeof textAnnotationSchema>
export const DOCUMENT_SCOPE_NODE_ID = '@document'

export function annotationBody(annotation: TextAnnotation): string | null {
  return annotation.kind === 'highlight' ? null : annotation.body
}
export type AnnotationGeometryRectangle = z.infer<
  typeof geometryRectangleSchema
>

/**
 * What a resolver needs of a node, and nothing more.
 *
 * Structural rather than nominal so that a research paper node, a publication
 * graph node and a DOM block all satisfy it without this package importing any
 * of them. `structId` defaults to `id` when a surface has only one notion of
 * identity.
 */
export type AnchorableNode = {
  readonly id: string
  readonly type?: string
  readonly text?: string
  readonly structId?: string
  readonly structDigest?: string
}

type ResolutionCandidate = {
  start: number
  end: number
  prefixMatches: boolean
  suffixMatches: boolean
}

/**
 * How a resolved anchor was matched.
 *
 * `relocated-quote` is never returned by `resolveTextAnchor`, which resolves
 * within one node. It belongs to the document-wide pass in `document.ts`,
 * which is allowed to find the quote in a block it did not start in.
 */
export type AnchorMatchedBy =
  | 'struct-id'
  | 'position-and-context'
  | 'quote-and-context'
  | 'unique-quote'
  | 'relocated-quote'

export type TextAnchorResolution =
  | {
      status: 'resolved'
      nodeId: string
      start: number
      end: number
      matchedBy: AnchorMatchedBy
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

function textForNode(node: AnchorableNode) {
  if (node.type === 'figure') return null
  return typeof node.text === 'string' ? node.text : null
}

function structIdOf(node: AnchorableNode) {
  return node.structId ?? node.id
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

export function utf16OffsetForCodePointOffset(
  text: string,
  offset: number,
): number | null {
  if (offset < 0 || !Number.isInteger(offset)) return null
  let codePoints = 0
  let utf16 = 0
  for (const character of text) {
    if (codePoints === offset) return utf16
    codePoints += 1
    utf16 += character.length
  }
  return codePoints === offset ? utf16 : null
}

export function codePointOffsetForUtf16Offset(
  text: string,
  offset: number,
): number | null {
  if (offset < 0 || !Number.isInteger(offset)) return null
  let codePoints = 0
  let utf16 = 0
  for (const character of text) {
    if (utf16 === offset) return codePoints
    codePoints += 1
    utf16 += character.length
  }
  return utf16 === offset ? codePoints : null
}

/** The ordered text stream used by document-scoped W3C selectors. */
export function orderedTextNodes(nodes: readonly AnchorableNode[]) {
  return nodes.flatMap((node) => {
    const text = textForNode(node)
    return text === null ? [] : [{ id: node.id, text }]
  })
}

function resolveDocumentAnchor(
  anchor: SemanticTextAnchor,
  nodes: readonly AnchorableNode[],
): TextAnchorResolution {
  const stream = orderedTextNodes(nodes)
  const documentText = stream.map((node) => node.text).join('')
  let absoluteUtf16 = 0
  let absoluteUnit = 0
  const candidates: (ResolutionCandidate & {
    nodeId: string
    atPosition: boolean
  })[] = []
  for (const node of stream) {
    const unitLength =
      anchor.positionUnit === 'codepoint'
        ? [...node.text].length
        : node.text.length
    for (const candidate of quoteCandidates(anchor, node.text)) {
      const context = contextMatches(
        documentText,
        absoluteUtf16 + candidate.start,
        absoluteUtf16 + candidate.end,
        anchor,
      )
      const startUnit =
        anchor.positionUnit === 'codepoint'
          ? codePointOffsetForUtf16Offset(node.text, candidate.start)
          : candidate.start
      const endUnit =
        anchor.positionUnit === 'codepoint'
          ? codePointOffsetForUtf16Offset(node.text, candidate.end)
          : candidate.end
      candidates.push({
        ...candidate,
        ...context,
        nodeId: node.id,
        atPosition:
          startUnit !== null &&
          endUnit !== null &&
          absoluteUnit + startUnit === anchor.position.start &&
          absoluteUnit + endUnit === anchor.position.end,
      })
    }
    absoluteUtf16 += node.text.length
    absoluteUnit += unitLength
  }
  if (!candidates.length)
    return {
      status: 'unresolved',
      nodeId: anchor.nodeId,
      reason: 'quote-not-found',
    }
  const positioned = candidates.find(
    (candidate) =>
      candidate.atPosition &&
      candidate.prefixMatches &&
      candidate.suffixMatches,
  )
  const contextual = candidates.filter(
    (candidate) => candidate.prefixMatches && candidate.suffixMatches,
  )
  const match =
    positioned ??
    (contextual.length === 1
      ? contextual[0]
      : candidates.length === 1
        ? candidates[0]
        : null)
  if (match)
    return {
      status: 'resolved',
      nodeId: match.nodeId,
      start: match.start,
      end: match.end,
      matchedBy: positioned
        ? 'position-and-context'
        : contextual.length === 1
          ? 'quote-and-context'
          : 'unique-quote',
    }
  return {
    status: 'ambiguous',
    nodeId: anchor.nodeId,
    reason:
      contextual.length > 1
        ? 'Multiple exact quotes also match the stored context.'
        : 'Multiple exact quotes remain and the stored context does not identify one safely.',
    candidates,
  }
}

/** Every occurrence of the stored quote in `text`, with its context verdict. */
export function quoteCandidates(
  anchor: SemanticTextAnchor,
  text: string,
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

/**
 * Attach a struct selector to an anchor built from offsets.
 *
 * Kept separate from the constructors above so that their signatures — and the
 * anchors every existing caller produces — are untouched by this addition.
 */
export function withStructSelector(
  anchor: SemanticTextAnchor,
  struct: StructSelector,
): SemanticTextAnchor {
  return semanticTextAnchorSchema.parse({
    ...anchor,
    struct: structSelectorSchema.parse(struct),
  })
}

export function resolveTextAnchor(
  anchor: SemanticTextAnchor,
  nodes: readonly AnchorableNode[],
): TextAnchorResolution {
  if (anchor.nodeId === DOCUMENT_SCOPE_NODE_ID)
    return resolveDocumentAnchor(anchor, nodes)
  // The struct id, when the anchor carries one, decides which node we are even
  // looking at. That is the whole point of it being ahead of the chain: a node
  // may have been renamed in a surface's own id space and still be the same
  // block of the same document.
  const structId = anchor.struct?.id
  const structNode = structId
    ? nodes.find((candidate) => structIdOf(candidate) === structId)
    : undefined
  const node =
    structNode ?? nodes.find((candidate) => candidate.id === anchor.nodeId)
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
      nodeId: node.id,
      reason: 'non-text-node',
    }
  }

  const candidates = quoteCandidates(anchor, text)
  const positionStart =
    anchor.positionUnit === 'codepoint'
      ? utf16OffsetForCodePointOffset(text, anchor.position.start)
      : anchor.position.start
  const positionEnd =
    anchor.positionUnit === 'codepoint'
      ? utf16OffsetForCodePointOffset(text, anchor.position.end)
      : anchor.position.end

  if (candidates.length === 0) {
    return {
      status: 'unresolved',
      nodeId: node.id,
      reason: 'quote-not-found',
    }
  }

  // Selector 1. An unchanged digest means the block is byte-identical to the one
  // the anchor was taken from, so the stored offsets cannot have drifted and the
  // quote at those offsets is the same quote.
  //
  // That reasoning needs a digest on both sides. Treating an *absent* digest as
  // "unchanged" made this a bare offset match: an edit that leaves a duplicate
  // of the quote at the old offsets while the original moves elsewhere with its
  // context intact would attach here, ahead of the context selectors that exist
  // to tell those two apart. A host that emits stable struct ids without digests
  // is supported, and it falls through to those selectors instead — slower, and
  // right.
  if (structNode && anchor.struct) {
    const digestMatches =
      anchor.struct.digest !== undefined &&
      structNode.structDigest !== undefined &&
      structNode.structDigest === anchor.struct.digest
    const atStoredPosition = candidates.find(
      (candidate) =>
        candidate.start === positionStart && candidate.end === positionEnd,
    )
    if (digestMatches && atStoredPosition) {
      return {
        status: 'resolved',
        nodeId: node.id,
        start: atStoredPosition.start,
        end: atStoredPosition.end,
        matchedBy: 'struct-id',
      }
    }
  }

  // Selector 2.
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
      nodeId: node.id,
      start: positionCandidate.start,
      end: positionCandidate.end,
      matchedBy: 'position-and-context',
    }
  }

  // Selector 3.
  const contextualCandidates = candidates.filter(
    (candidate) => candidate.prefixMatches && candidate.suffixMatches,
  )
  if (contextualCandidates.length === 1) {
    return {
      status: 'resolved',
      nodeId: node.id,
      start: contextualCandidates[0].start,
      end: contextualCandidates[0].end,
      matchedBy: 'quote-and-context',
    }
  }

  // Selector 4.
  if (candidates.length === 1) {
    return {
      status: 'resolved',
      nodeId: node.id,
      start: candidates[0].start,
      end: candidates[0].end,
      matchedBy: 'unique-quote',
    }
  }

  return {
    status: 'ambiguous',
    nodeId: node.id,
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
