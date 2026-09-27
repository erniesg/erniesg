/**
 * Painting highlights without touching the document.
 *
 * The host's markup is whatever its renderer produced, and the block digests
 * an anchor resolves through are taken over exactly that markup. Wrapping
 * selected text in `<span>`s would change it, invalidate the digests, and make
 * two overlapping highlights fight over who gets to nest inside whom.
 *
 * So nothing here writes into the text. The first choice is the CSS Custom
 * Highlight API, which paints ranges the browser holds outside the DOM and
 * therefore handles overlap and multi-block ranges for free. Where that is
 * missing, the fallback draws absolutely positioned rectangles behind the text
 * from `getClientRects()`. Both leave `innerHTML` byte-identical.
 */
import type { AnchorableBlock } from './blocks.js'
import { NOTE_PAINT, NOTE_PAINT_KEY, ROLE_PALETTE } from '../palette.js'
import { rangesForOffsets } from './text-index.js'

export type PaintTarget = {
  id: string
  /** A palette key, not a CSS value: the host decides what amber looks like. */
  color: string
  nodeId: string
  start: number
  end: number
}

export type PaintOptions = {
  /** CSS colour per palette key. Anything unlisted falls back to `default`. */
  palette?: Record<string, string>
  /** Where the fallback overlay is appended. Defaults to the document body. */
  overlayHost?: Element
  /**
   * A suffix for this painter's entries in the document-global highlight
   * registry.
   *
   * `CSS.highlights` is per document, so two rails on one page — two embedded
   * documents, or a rail beside a preview — wrote the same
   * `erniesg-margin-amber` key: rendering the second replaced the first's
   * ranges, and clearing either deleted the other's highlight. An instance
   * suffix keeps them apart.
   */
  registryNamespace?: string
}

export const DEFAULT_PALETTE: Record<string, string> = {
  default: 'rgba(250, 204, 21, 0.35)',
  amber: 'rgba(250, 204, 21, 0.35)',
  blue: 'rgba(56, 189, 248, 0.32)',
  green: 'rgba(74, 222, 128, 0.32)',
  pink: 'rgba(244, 114, 182, 0.32)',
  ...ROLE_PALETTE,
  [NOTE_PAINT_KEY]: NOTE_PAINT,
}

const REGISTRY_PREFIX = 'erniesg-margin-'
const STYLE_ATTRIBUTE = 'data-erniesg-margin-highlights'
const OVERLAY_ATTRIBUTE = 'data-erniesg-margin-overlay'
const OVERLAY_SELECTOR = `[${OVERLAY_ATTRIBUTE}]`

type HighlightRegistry = {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

type HighlightConstructor = new (...ranges: Range[]) => unknown

function highlightRegistry(view: Window | null): HighlightRegistry | null {
  const css = (view as unknown as { CSS?: { highlights?: HighlightRegistry } })
    ?.CSS
  const registry = css?.highlights
  const constructor = (view as unknown as { Highlight?: HighlightConstructor })
    ?.Highlight
  return registry && typeof constructor === 'function' ? registry : null
}

/** The live ranges a set of resolved placements covers, grouped by target. */
export function rangesForTargets(
  blocks: readonly AnchorableBlock[],
  targets: readonly PaintTarget[],
): { target: PaintTarget; ranges: Range[] }[] {
  const byId = new Map(blocks.map((block) => [block.id, block]))
  return targets.flatMap((target) => {
    const block = byId.get(target.nodeId)
    if (!block) return []
    const ranges = rangesForOffsets(block.index, target.start, target.end)
    return ranges.length ? [{ target, ranges }] : []
  })
}

/**
 * Only the highlight pseudo-elements this package registers, and nothing else.
 *
 * `::highlight()` can only match a name in the document's own registry, so
 * these rules cannot reach any element the host owns. That is why this is the
 * one stylesheet the package puts in the host page.
 */
/**
 * The `::highlight()` rules for one painter.
 *
 * One `<style>` per namespace, not one per document: the element's contents are
 * replaced wholesale, so a shared element meant the second rail's palette wiped
 * the first rail's rules along with its registry entries.
 */
function ensureStyles(
  doc: Document,
  palette: Record<string, string>,
  colors: readonly string[],
  suffix: string,
) {
  const selector = `style[${STYLE_ATTRIBUTE}="${suffix}"]`
  const existing = doc.head.querySelector(selector)
  const style = existing ?? doc.createElement('style')
  if (!existing) {
    style.setAttribute(STYLE_ATTRIBUTE, suffix)
    doc.head.append(style)
  }
  style.textContent = colors
    .map(
      (color) =>
        `::highlight(${REGISTRY_PREFIX}c${encodeNamePart(color)}${suffix}) { background-color: ${
          palette[color] ?? palette.default ?? DEFAULT_PALETTE.default
        }; color: inherit; }`,
    )
    .join('\n')
}

/**
 * The document position of the overlay's own containing block.
 *
 * The overlay is `position: absolute` inside the host, so it is placed relative
 * to the nearest positioned ancestor. Measuring the overlay itself rather than
 * the host is deliberate: it is already in the tree at its zero offset, so its
 * own rectangle *is* that containing block's origin, whatever produced it —
 * `position: relative`, a transform, or a containing-block-establishing filter.
 */
function overlayOrigin(
  overlay: Element,
  scrollX: number,
  scrollY: number,
): { x: number; y: number } {
  // The overlay's own rectangle, and nothing added to it. It sits at content
  // coordinate zero inside the host, so if the host is scrolled the overlay moves
  // with the content and its rectangle already carries that — adding the host's
  // `scrollLeft`/`scrollTop` back subtracted the scroll twice and put every box
  // out by the scroll offset. The whole point of measuring the overlay rather
  // than the host is that it needs no corrections.
  const box = overlay.getBoundingClientRect()
  return { x: box.left + scrollX, y: box.top + scrollY }
}

/** Ignore overlay writes from every Margin painter, even another package copy. */
function inMarginOverlay(node: Node): boolean {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  return Boolean(element?.closest(OVERLAY_SELECTOR))
}

function isMarginOverlayMutation(record: MutationRecord): boolean {
  if (inMarginOverlay(record.target)) return true
  if (record.type !== 'childList') return false
  // Insertion/removal targets the host, not the overlay. Ignore that record
  // only when every changed node is a Margin overlay; mixed host edits redraw.
  const changed = [...record.addedNodes, ...record.removedNodes]
  return changed.length > 0 && changed.every(inMarginOverlay)
}

function paintWithOverlay(
  doc: Document,
  host: Element,
  painted: { target: PaintTarget; ranges: Range[] }[],
  palette: Record<string, string>,
): () => void {
  const overlay = doc.createElement('div')
  overlay.setAttribute(OVERLAY_ATTRIBUTE, '')
  overlay.style.cssText =
    'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:0;'
  host.append(overlay)

  const view = doc.defaultView
  const draw = () => {
    const scrollX = view?.scrollX ?? 0
    const scrollY = view?.scrollY ?? 0
    const origin = overlayOrigin(overlay, scrollX, scrollY)
    const boxes: Element[] = []
    for (const { target, ranges } of painted) {
      for (const range of ranges) {
        for (const rect of Array.from(range.getClientRects())) {
          const box = doc.createElement('div')
          box.dataset.marginHighlight = target.id
          box.style.cssText = [
            'position:absolute',
            `left:${rect.left + scrollX - origin.x}px`,
            `top:${rect.top + scrollY - origin.y}px`,
            `width:${rect.width}px`,
            `height:${rect.height}px`,
            `background-color:${palette[target.color] ?? palette.default ?? DEFAULT_PALETTE.default}`,
            'pointer-events:none',
          ].join(';')
          boxes.push(box)
        }
      }
    }
    overlay.replaceChildren(...boxes)
  }
  draw()

  let frame = 0
  const schedule = () => {
    if (frame || !view) return
    frame = view.requestAnimationFrame(() => {
      frame = 0
      draw()
    })
  }
  view?.addEventListener('resize', schedule)
  view?.visualViewport?.addEventListener('resize', schedule)
  doc.addEventListener('scroll', schedule, true)
  doc.fonts?.addEventListener('loadingdone', schedule)
  const Resize = view?.ResizeObserver
  const resize = Resize ? new Resize(schedule) : null
  resize?.observe(host)
  for (const { ranges } of painted) {
    for (const range of ranges) {
      const element = range.startContainer.parentElement
      if (element) resize?.observe(element)
    }
  }
  const Mutation = view?.MutationObserver
  const mutation = Mutation
    ? new Mutation((records) => {
        if (records.some((record) => !isMarginOverlayMutation(record)))
          schedule()
      })
    : null
  mutation?.observe(doc.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  })

  return () => {
    if (frame && view) view.cancelAnimationFrame(frame)
    view?.removeEventListener('resize', schedule)
    view?.visualViewport?.removeEventListener('resize', schedule)
    doc.removeEventListener('scroll', schedule, true)
    doc.fonts?.removeEventListener('loadingdone', schedule)
    resize?.disconnect()
    mutation?.disconnect()
    overlay.remove()
  }
}

/**
 * Paint `targets` and return the function that removes them again.
 *
 * Repainting is always remove-then-paint: highlight ranges hold live DOM
 * positions, so a stale one after a re-render is a wrong rectangle.
 */
export function paintHighlights(
  blocks: readonly AnchorableBlock[],
  targets: readonly PaintTarget[],
  options: PaintOptions = {},
): () => void {
  const first = blocks[0]
  const doc = first?.element.ownerDocument
  if (!doc) return () => {}

  const palette = { ...DEFAULT_PALETTE, ...(options.palette ?? {}) }
  const painted = rangesForTargets(blocks, targets)
  if (painted.length === 0) return () => {}

  const registry = highlightRegistry(doc.defaultView)
  if (!registry) {
    const host = options.overlayHost ?? doc.body
    return paintWithOverlay(doc, host, painted, palette)
  }

  const Highlight = (
    doc.defaultView as unknown as {
      Highlight: HighlightConstructor
    }
  ).Highlight
  const byColor = new Map<string, Range[]>()
  for (const { target, ranges } of painted) {
    const color = palette[target.color] ? target.color : 'default'
    byColor.set(color, [...(byColor.get(color) ?? []), ...ranges])
  }

  const suffix = registrySuffix(options.registryNamespace)
  const nameFor = (color: string) =>
    highlightRegistryName(color, options.registryNamespace)

  ensureStyles(doc, palette, Array.from(byColor.keys()), suffix)
  for (const [color, ranges] of byColor) {
    registry.set(nameFor(color), new Highlight(...ranges))
  }

  return () => {
    for (const color of byColor.keys()) {
      registry.delete(nameFor(color))
    }
    // `ensureStyles` created a namespace-specific `<style>` in `document.head`
    // that nothing else references; the registry entries above are only half
    // of what this painter added. Each `MarginRailElement` gets a
    // never-reused counter namespace and the React wrapper replaces the
    // element on a `documentUri`/`textSelector`/`apiBase` change, so leaving
    // this behind accumulates one permanent style element and its rules per
    // replacement over a long-lived reading session.
    doc.head.querySelector(`style[${STYLE_ATTRIBUTE}="${suffix}"]`)?.remove()
  }
}

/** Fixed-width code points preserve every key, including punctuation and Unicode. */
function encodeNamePart(value: string): string {
  return Array.from(value, (character) =>
    character.codePointAt(0)!.toString(16).padStart(6, '0'),
  ).join('')
}

/** A CSS-identifier-safe, collision-free suffix, or none for a single rail. */
export function registrySuffix(namespace: string | undefined): string {
  if (!namespace) return ''
  return `-n${encodeNamePart(namespace)}`
}

/**
 * The `CSS.highlights` key one painter uses for one colour.
 *
 * Exported so the naming can be asserted without a DOM: this repository has no
 * DOM test environment, and the registry collision it prevents is the kind of
 * thing that is cheap to get wrong again.
 */
export function highlightRegistryName(
  color: string,
  namespace?: string,
): string {
  return `${REGISTRY_PREFIX}c${encodeNamePart(color)}${registrySuffix(namespace)}`
}

export const HIGHLIGHT_REGISTRY_PREFIX = REGISTRY_PREFIX
