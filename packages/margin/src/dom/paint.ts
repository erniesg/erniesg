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
import type { AnchorableBlock } from './blocks'
import { rangeForOffsets } from './text-index'

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
}

export const DEFAULT_PALETTE: Record<string, string> = {
  default: 'rgba(250, 204, 21, 0.35)',
  amber: 'rgba(250, 204, 21, 0.35)',
  blue: 'rgba(56, 189, 248, 0.32)',
  green: 'rgba(74, 222, 128, 0.32)',
  pink: 'rgba(244, 114, 182, 0.32)',
}

const REGISTRY_PREFIX = 'erniesg-margin-'
const STYLE_ATTRIBUTE = 'data-erniesg-margin-highlights'
const OVERLAY_ATTRIBUTE = 'data-erniesg-margin-overlay'

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
    const range = rangeForOffsets(block.index, target.start, target.end)
    return range ? [{ target, ranges: [range] }] : []
  })
}

/**
 * Only the highlight pseudo-elements this package registers, and nothing else.
 *
 * `::highlight()` can only match a name in the document's own registry, so
 * these rules cannot reach any element the host owns. That is why this is the
 * one stylesheet the package puts in the host page.
 */
function ensureStyles(
  doc: Document,
  palette: Record<string, string>,
  colors: readonly string[],
) {
  const existing = doc.head.querySelector(`style[${STYLE_ATTRIBUTE}]`)
  const style = existing ?? doc.createElement('style')
  if (!existing) {
    style.setAttribute(STYLE_ATTRIBUTE, '')
    doc.head.append(style)
  }
  style.textContent = colors
    .map(
      (color) =>
        `::highlight(${REGISTRY_PREFIX}${color}) { background-color: ${
          palette[color] ?? palette.default ?? DEFAULT_PALETTE.default
        }; color: inherit; }`,
    )
    .join('\n')
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
  const scrollX = view?.scrollX ?? 0
  const scrollY = view?.scrollY ?? 0
  for (const { target, ranges } of painted) {
    for (const range of ranges) {
      for (const rect of Array.from(range.getClientRects())) {
        const box = doc.createElement('div')
        box.dataset.marginHighlight = target.id
        box.style.cssText = [
          'position:absolute',
          `left:${rect.left + scrollX}px`,
          `top:${rect.top + scrollY}px`,
          `width:${rect.width}px`,
          `height:${rect.height}px`,
          `background-color:${palette[target.color] ?? palette.default ?? DEFAULT_PALETTE.default}`,
          'pointer-events:none',
        ].join(';')
        overlay.append(box)
      }
    }
  }

  return () => overlay.remove()
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

  const Highlight = (doc.defaultView as unknown as {
    Highlight: HighlightConstructor
  }).Highlight
  const byColor = new Map<string, Range[]>()
  for (const { target, ranges } of painted) {
    const color = palette[target.color] ? target.color : 'default'
    byColor.set(color, [...(byColor.get(color) ?? []), ...ranges])
  }

  ensureStyles(doc, palette, Array.from(byColor.keys()))
  for (const [color, ranges] of byColor) {
    registry.set(`${REGISTRY_PREFIX}${color}`, new Highlight(...ranges))
  }

  return () => {
    for (const color of byColor.keys()) {
      registry.delete(`${REGISTRY_PREFIX}${color}`)
    }
  }
}

export const HIGHLIGHT_REGISTRY_PREFIX = REGISTRY_PREFIX
