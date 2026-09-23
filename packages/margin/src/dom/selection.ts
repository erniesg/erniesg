/**
 * A browser selection, turned into anchors.
 *
 * Everything here works from a `Range`. That is the whole reason keyboard
 * selection is a first-class path rather than a fallback: shift+arrow, a
 * screen reader's own selection and a mouse drag all leave the same `Range`
 * behind, so all three arrive here identical and leave here identical. There
 * is no mouse-specific branch to keep in step.
 *
 * A selection that crosses block boundaries yields one anchor per block, in
 * document order, rather than failing.
 */
import {
  createSemanticTextAnchorFromRange,
  withStructSelector,
  type SemanticTextAnchor,
} from '../anchor.js'
import type { AnchorableBlock } from './blocks.js'
import { offsetForPoint } from './text-index.js'

export const DEFAULT_CONTEXT_LENGTH = 32

export type SelectionCapture =
  | { status: 'captured'; anchors: SemanticTextAnchor[]; range: Range }
  /** No selection, or a collapsed one. */
  | { status: 'empty' }
  /**
   * The reader selected something real, but all of it sits in a region with no
   * durable text to anchor to — a generated figure, say. The UI marks that
   * region rather than storing an anchor that will orphan on the next build.
   */
  | { status: 'non-annotatable' }

function trimmedSlice(text: string, start: number, end: number) {
  let from = Math.max(0, Math.min(start, text.length))
  let to = Math.max(from, Math.min(end, text.length))
  while (from < to && /\s/u.test(text[from])) from += 1
  while (to > from && /\s/u.test(text[to - 1])) to -= 1
  return { from, to }
}

export function anchorsFromRange(
  range: Range,
  blocks: readonly AnchorableBlock[],
  contextLength = DEFAULT_CONTEXT_LENGTH,
): SelectionCapture {
  if (range.collapsed) return { status: 'empty' }

  const touched = blocks.filter((block) => {
    try {
      return range.intersectsNode(block.element)
    } catch {
      return false
    }
  })
  if (touched.length === 0) return { status: 'empty' }

  const anchors: SemanticTextAnchor[] = []
  // Whether any touched block had indexed (annotatable) text under the raw,
  // untrimmed span. A whitespace-only selection reaches zero anchors the same
  // way a selection entirely inside a generated figure does, but only the
  // second one is actually non-annotatable.
  let hadAnnotatableSpan = false
  for (const block of touched) {
    const { index } = block
    if (index.segments.length === 0) continue

    const startsHere = block.element.contains(range.startContainer)
    const endsHere = block.element.contains(range.endContainer)
    const rawStart = startsHere
      ? offsetForPoint(index, range.startContainer, range.startOffset)
      : 0
    const rawEnd = endsHere
      ? offsetForPoint(index, range.endContainer, range.endOffset)
      : index.text.length

    if (rawEnd > rawStart) hadAnnotatableSpan = true

    const { from, to } = trimmedSlice(index.text, rawStart, rawEnd)
    if (to <= from) continue

    anchors.push(
      withStructSelector(
        createSemanticTextAnchorFromRange(
          block.id,
          index.text,
          from,
          to,
          contextLength,
        ),
        block.structDigest
          ? { id: block.structId, digest: block.structDigest }
          : { id: block.structId },
      ),
    )
  }

  if (anchors.length === 0) {
    return { status: hadAnnotatableSpan ? 'empty' : 'non-annotatable' }
  }
  return { status: 'captured', anchors, range }
}

export function anchorsFromSelection(
  selection: Selection | null,
  blocks: readonly AnchorableBlock[],
  contextLength = DEFAULT_CONTEXT_LENGTH,
): SelectionCapture {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { status: 'empty' }
  }
  return anchorsFromRange(selection.getRangeAt(0), blocks, contextLength)
}

export type SelectionWatcherOptions = {
  /** Defaults to the root's owning document. */
  document?: Document
  onSelection: (capture: SelectionCapture) => void
  contextLength?: number
}

/**
 * Watch for selection changes and report anchors.
 *
 * It listens to `selectionchange` and nothing else. `mouseup` would miss every
 * keyboard and assistive-technology selection; `keyup` would miss the mouse.
 * `selectionchange` is the one event all of them raise, so the keyboard path
 * is not a second implementation that can rot.
 */
export function watchSelection(
  blocks: () => readonly AnchorableBlock[],
  options: SelectionWatcherOptions,
): () => void {
  const doc = options.document
  if (!doc) return () => {}
  let scheduled = 0

  const report = () => {
    scheduled = 0
    options.onSelection(
      anchorsFromSelection(
        doc.getSelection(),
        blocks(),
        options.contextLength ?? DEFAULT_CONTEXT_LENGTH,
      ),
    )
  }

  const onChange = () => {
    // A shift+arrow held down fires this per keystroke. Coalescing to one
    // frame keeps a long keyboard selection as cheap as a mouse drag.
    const view = doc.defaultView
    if (!view) {
      report()
      return
    }
    if (scheduled) view.cancelAnimationFrame(scheduled)
    scheduled = view.requestAnimationFrame(report)
  }

  doc.addEventListener('selectionchange', onChange)
  return () => {
    const view = doc.defaultView
    if (scheduled && view) view.cancelAnimationFrame(scheduled)
    doc.removeEventListener('selectionchange', onChange)
  }
}
