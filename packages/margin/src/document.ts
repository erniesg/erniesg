/**
 * Placing an anchor in a whole document, and refusing to lose it.
 *
 * `resolveTextAnchor` works inside one node. This layer runs it over the
 * document, adds the one thing a single-node resolver cannot do — find a quote
 * that has been moved into a different block — and, above all, gives every
 * annotation an outcome. An annotation that cannot be placed comes back
 * `orphaned`, carrying its quote, so the rail can still show it. Nothing here
 * ever drops one.
 */
import {
  DOCUMENT_SCOPE_NODE_ID,
  quoteCandidates,
  resolveTextAnchor,
  type AnchorMatchedBy,
  type AnchorableNode,
  type SemanticTextAnchor,
  type TextAnnotation,
} from './anchor.js'

export type OrphanReason =
  'ambiguous' | 'missing-node' | 'non-text-node' | 'quote-not-found'

export type AnchorPlacement =
  | {
      status: 'anchored'
      nodeId: string
      start: number
      end: number
      matchedBy: AnchorMatchedBy
      /** Set when the quote was found in a block other than the stored one. */
      movedFromNodeId?: string
    }
  | {
      status: 'orphaned'
      /** The node the anchor was stored against, so the rail can say where. */
      nodeId: string
      reason: OrphanReason
      /** Always readable, because an orphan the reader cannot read is a loss. */
      quote: string
      detail: string
    }

export type AnnotationPlacement = {
  annotation: TextAnnotation
  placement: AnchorPlacement
}

/**
 * The document-wide relocation pass.
 *
 * Deliberately conservative. It will move an anchor to another block only when
 * exactly one occurrence in the whole document is identified — by its stored
 * context if any occurrence still has it, and otherwise by being the only
 * occurrence there is. Two equally good candidates orphan rather than guess,
 * because a note attached to the wrong sentence is worse than a note the
 * reader is told has come loose.
 */
function relocate(
  anchor: SemanticTextAnchor,
  nodes: readonly AnchorableNode[],
): { nodeId: string; start: number; end: number } | 'ambiguous' | 'not-found' {
  const found: {
    nodeId: string
    start: number
    end: number
    contextual: boolean
  }[] = []
  for (const node of nodes) {
    if (node.type === 'figure' || typeof node.text !== 'string') continue
    for (const candidate of quoteCandidates(anchor, node.text)) {
      found.push({
        nodeId: node.id,
        start: candidate.start,
        end: candidate.end,
        // Both sides, matching the in-node resolver. Either-side made a
        // one-sided coincidence count as context, so a quote that appears more
        // than once across blocks could be relocated onto a weak candidate, or
        // called ambiguous when exactly one occurrence matched the whole stored
        // neighbourhood. Cross-block relocation is the weakest rung of the
        // ladder; it should not be the most permissive.
        contextual: candidate.prefixMatches && candidate.suffixMatches,
      })
    }
  }
  if (found.length === 0) return 'not-found'

  const contextual = found.filter((entry) => entry.contextual)
  const shortlist = contextual.length > 0 ? contextual : found
  if (shortlist.length !== 1) return 'ambiguous'
  const [only] = shortlist
  return { nodeId: only.nodeId, start: only.start, end: only.end }
}

export function resolveAnchorInDocument(
  anchor: SemanticTextAnchor,
  nodes: readonly AnchorableNode[],
): AnchorPlacement {
  const resolution = resolveTextAnchor(anchor, nodes)
  if (resolution.status === 'resolved') {
    // `unique-quote` means "the only occurrence in this block", and nothing
    // more — the stored prefix and suffix were not confirmed. If the original
    // moved to another block and a duplicate happens to remain here, returning
    // straight away attaches the annotation to the duplicate and never looks at
    // the occurrence whose whole neighbourhood still matches. Every stronger
    // rung already carries that confirmation, so only this one has to ask.
    if (resolution.matchedBy !== 'unique-quote') {
      return {
        status: 'anchored',
        nodeId: resolution.nodeId,
        start: resolution.start,
        end: resolution.end,
        matchedBy: resolution.matchedBy,
      }
    }

    const elsewhere = relocate(anchor, nodes)
    // A document-wide match is only preferred when it is contextual *and* in a
    // different block: `relocate` requires both sides of the context, so a
    // result from another node has evidence this one does not.
    if (
      elsewhere !== 'ambiguous' &&
      elsewhere !== 'not-found' &&
      elsewhere.nodeId !== resolution.nodeId
    ) {
      return {
        status: 'anchored',
        nodeId: elsewhere.nodeId,
        start: elsewhere.start,
        end: elsewhere.end,
        matchedBy: 'relocated-quote',
        movedFromNodeId: anchor.nodeId,
      }
    }

    return {
      status: 'anchored',
      nodeId: resolution.nodeId,
      start: resolution.start,
      end: resolution.end,
      matchedBy: resolution.matchedBy,
    }
  }

  if (resolution.status === 'ambiguous') {
    // Ambiguity inside the old block is not ambiguity across the document.
    // Both local duplicates may have lost their neighbourhood while the
    // original occurrence moved, with both stored context sides intact.
    //
    // A `@document`-scoped anchor is the exception: its ambiguity already
    // came from `resolveDocumentAnchor` weighing the *whole* document text,
    // context spanning block boundaries included. `relocate` only checks
    // context inside one block at a time, so it can drop a candidate whose
    // prefix crosses a boundary and "resolve" what was correctly ambiguous —
    // and since no real node id ever equals the `@document` sentinel, the
    // `moved.nodeId !== anchor.nodeId` check below would always let it
    // through. Skip relocation for this anchor entirely; the duplicate stays
    // orphaned rather than being attached arbitrarily.
    const moved =
      anchor.nodeId === DOCUMENT_SCOPE_NODE_ID
        ? ('ambiguous' as const)
        : relocate(anchor, nodes)
    if (
      moved !== 'ambiguous' &&
      moved !== 'not-found' &&
      moved.nodeId !== anchor.nodeId
    ) {
      return {
        status: 'anchored',
        nodeId: moved.nodeId,
        start: moved.start,
        end: moved.end,
        matchedBy: 'relocated-quote',
        movedFromNodeId: anchor.nodeId,
      }
    }
    return {
      status: 'orphaned',
      nodeId: resolution.nodeId,
      reason: 'ambiguous',
      quote: anchor.quote.exact,
      detail: resolution.reason,
    }
  }

  // The block is gone, became non-text, or no longer holds the quote. The
  // words themselves may still be in the document, one block over.
  const moved = relocate(anchor, nodes)
  if (moved === 'ambiguous') {
    return {
      status: 'orphaned',
      nodeId: resolution.nodeId,
      reason: 'ambiguous',
      quote: anchor.quote.exact,
      detail:
        'The quote appears in more than one block and the stored context does not identify one safely.',
    }
  }
  if (moved === 'not-found') {
    return {
      status: 'orphaned',
      nodeId: resolution.nodeId,
      reason: resolution.reason,
      quote: anchor.quote.exact,
      detail:
        resolution.reason === 'missing-node'
          ? `Node ${resolution.nodeId} is no longer in the document and its quote is not elsewhere in it.`
          : resolution.reason === 'non-text-node'
            ? `Node ${resolution.nodeId} no longer carries text and its quote is not elsewhere in the document.`
            : `The quote is no longer anywhere in the document.`,
    }
  }

  return {
    status: 'anchored',
    nodeId: moved.nodeId,
    start: moved.start,
    end: moved.end,
    matchedBy: 'relocated-quote',
    movedFromNodeId: anchor.nodeId,
  }
}

/**
 * Place every annotation. The result is the same length as the input, in the
 * same order: an annotation that failed to re-anchor is marked, not removed.
 */
export function placeAnnotations(
  annotations: readonly TextAnnotation[],
  nodes: readonly AnchorableNode[],
): AnnotationPlacement[] {
  return annotations.map((annotation) => ({
    annotation,
    placement: resolveAnchorInDocument(annotation.target, nodes),
  }))
}

export function orphanedPlacements(
  placements: readonly AnnotationPlacement[],
): AnnotationPlacement[] {
  return placements.filter(({ placement }) => placement.status === 'orphaned')
}
