/**
 * The bridge between a block's text and the DOM that renders it.
 *
 * An anchor is offsets into a string. Painting one, or reading one out of a
 * selection, needs the mapping back to the text nodes those offsets fall in.
 * That mapping is built once per block and used in both directions, so a
 * selection and the highlight painted from it cannot disagree about where
 * character 41 is.
 *
 * Text inside a non-annotatable subtree is excluded from the string entirely.
 * A generated figure has no durable text to anchor to — it is redrawn on the
 * next build — so the honest thing is for it not to exist in the coordinate
 * space at all, rather than to store an anchor that will orphan.
 */

/** The default subtrees a reader cannot durably anchor into. */
export const NON_ANNOTATABLE_SELECTOR =
  'figure, svg, img, canvas, video, audio, button, input, textarea, select, [data-margin-annotatable="false"]'

export type TextSegment = { node: Text; start: number; end: number }

export type BlockTextIndex = {
  element: Element
  text: string
  segments: TextSegment[]
}

export type IndexOptions = {
  /** Subtrees whose text is not part of the anchorable string. */
  nonAnnotatableSelector?: string
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

export function indexBlockText(
  element: Element,
  options: IndexOptions = {},
): BlockTextIndex {
  const skip = options.nonAnnotatableSelector ?? NON_ANNOTATABLE_SELECTOR
  const segments: TextSegment[] = []
  let length = 0

  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      const text = node as Text
      if (text.data.length === 0) return
      segments.push({
        node: text,
        start: length,
        end: length + text.data.length,
      })
      length += text.data.length
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    if (skip && (node as Element).matches(skip)) return
    for (const child of Array.from(node.childNodes)) visit(child)
  }

  // The root is tested too. Starting at its children meant a block that is itself
  // non-annotatable — a `<figure data-block-kind="figure">`, or anything marked
  // `data-margin-annotatable="false"` — had its caption or fallback text indexed
  // as durable content, so a selection could anchor to text the block says is not
  // anchorable.
  const annotatable = !skip || !element.matches(skip)
  if (annotatable) {
    for (const child of Array.from(element.childNodes)) visit(child)
  }

  return {
    element,
    text: segments.map((segment) => segment.node.data).join(''),
    segments,
  }
}

/**
 * The text offset a DOM point falls at.
 *
 * A point can land anywhere: in one of the block's text nodes, on an element
 * boundary between them, or inside a subtree this index skipped. The fast path
 * covers the first; `comparePoint` covers the rest by asking the document
 * itself which segment the point precedes.
 */
export function offsetForPoint(
  index: BlockTextIndex,
  container: Node,
  offset: number,
): number {
  const direct = index.segments.find((segment) => segment.node === container)
  if (direct) {
    return direct.start + Math.min(Math.max(offset, 0), direct.node.data.length)
  }

  const doc = index.element.ownerDocument
  if (!doc) return index.text.length
  for (const segment of index.segments) {
    const probe = doc.createRange()
    probe.setStart(segment.node, 0)
    probe.setEnd(segment.node, segment.node.data.length)
    let comparison: number
    try {
      comparison = probe.comparePoint(container, offset)
    } catch {
      continue
    }
    if (comparison <= 0) return segment.start
  }
  return index.text.length
}

function pointAt(index: BlockTextIndex, offset: number, side: 'start' | 'end') {
  const { segments } = index
  if (segments.length === 0) return { node: index.element as Node, offset: 0 }
  for (const segment of segments) {
    const reached = side === 'start' ? offset < segment.end : offset <= segment.end
    if (!reached) continue
    if (offset < segment.start) return { node: segment.node as Node, offset: 0 }
    return { node: segment.node as Node, offset: offset - segment.start }
  }
  const last = segments[segments.length - 1]
  return { node: last.node as Node, offset: last.node.data.length }
}

/** A live `Range` over `[start, end)` of the block's anchorable text. */
export function rangeForOffsets(
  index: BlockTextIndex,
  start: number,
  end: number,
): Range | null {
  const doc = index.element.ownerDocument
  if (!doc || end <= start) return null
  const from = pointAt(index, Math.max(0, start), 'start')
  const to = pointAt(index, Math.min(index.text.length, end), 'end')
  const range = doc.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range.collapsed ? null : range
}
