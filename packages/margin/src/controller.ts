/**
 * The plain JS API: blocks in, placements and paint out.
 *
 * This is the whole package without any UI. The web component in `element.ts`
 * and the React wrapper in `react.tsx` both drive this and add nothing of
 * their own, so a host that wants neither can use this directly.
 */
import {
  textAnnotationSchema,
  type SemanticTextAnchor,
  type TextAnnotation,
} from './anchor.js'
import { NOTE_PAINT_KEY } from './palette.js'
import { placeAnnotations, type AnnotationPlacement } from './document.js'
import {
  readAnchorableBlocks,
  type AnchorableBlock,
  type BlockOptions,
} from './dom/blocks.js'
import {
  paintHighlights,
  type PaintOptions,
  type PaintTarget,
} from './dom/paint.js'
import {
  anchorsFromSelection,
  watchSelection,
  DEFAULT_CONTEXT_LENGTH,
  type SelectionCapture,
} from './dom/selection.js'

export type MarginControllerOptions = BlockOptions &
  PaintOptions & {
    /** The element the document's text is rendered into. */
    root: Element
    contextLength?: number
    onSelection?: (capture: SelectionCapture) => void
  }

export type MarginController = {
  blocks(): readonly AnchorableBlock[]
  refresh(): readonly AnchorableBlock[]
  capture(): SelectionCapture
  place(annotations: readonly TextAnnotation[]): AnnotationPlacement[]
  /** Place, then paint the highlights among them. Orphans are returned, not lost. */
  render(annotations: readonly TextAnnotation[]): AnnotationPlacement[]
  clear(): void
  start(): void
  stop(): void
}

export function paintTargetsFor(
  placements: readonly AnnotationPlacement[],
): PaintTarget[] {
  // A note paints as well as a highlight: the passage it is about has to be
  // visible, and clickable, or the note is attached to nothing the reader can
  // see. Proposals are 060's and paint as their own diff, not here.
  return placements.flatMap(({ annotation, placement }) =>
    placement.status === 'anchored' && annotation.kind !== 'proposal'
      ? [
          {
            id: annotation.id,
            color:
              annotation.kind === 'highlight'
                ? annotation.appearance.color
                : NOTE_PAINT_KEY,
            nodeId: placement.nodeId,
            start: placement.start,
            end: placement.end,
          },
        ]
      : [],
  )
}

export function createMarginController(
  options: MarginControllerOptions,
): MarginController {
  const contextLength = options.contextLength ?? DEFAULT_CONTEXT_LENGTH
  let blocks = readAnchorableBlocks(options.root, options)
  let unpaint: (() => void) | null = null
  let unwatch: (() => void) | null = null

  const controller: MarginController = {
    blocks: () => blocks,
    refresh() {
      blocks = readAnchorableBlocks(options.root, options)
      return blocks
    },
    capture: () =>
      anchorsFromSelection(
        options.root.ownerDocument?.getSelection() ?? null,
        blocks,
        contextLength,
      ),
    place: (annotations) => placeAnnotations(annotations, blocks),
    render(annotations) {
      const placements = placeAnnotations(annotations, blocks)
      controller.clear()
      unpaint = paintHighlights(blocks, paintTargetsFor(placements), options)
      return placements
    },
    clear() {
      unpaint?.()
      unpaint = null
    },
    start() {
      if (unwatch || !options.onSelection) return
      unwatch = watchSelection(() => blocks, {
        document: options.root.ownerDocument ?? undefined,
        contextLength,
        onSelection: options.onSelection,
      })
    },
    stop() {
      unwatch?.()
      unwatch = null
      controller.clear()
    },
  }

  return controller
}

/**
 * The annotations a capture becomes.
 *
 * A selection crossing three blocks is three anchors, so it is three
 * annotations sharing one group id rather than one annotation with a target it
 * cannot express. The rail groups them back together for display.
 */
export function annotationsFromAnchors(
  anchors: readonly SemanticTextAnchor[],
  input:
    | { kind: 'highlight'; color: string; id?: string }
    | { kind: 'note' | 'proposal'; body: string; id?: string },
): TextAnnotation[] {
  const groupId = input.id ?? newAnnotationId()
  return anchors.map((target, position) =>
    textAnnotationSchema.parse(
      input.kind === 'highlight'
        ? {
            id: anchors.length === 1 ? groupId : `${groupId}:${position}`,
            kind: 'highlight',
            target,
            appearance: { color: input.color },
            geometryCache: [],
          }
        : {
            id: anchors.length === 1 ? groupId : `${groupId}:${position}`,
            kind: input.kind,
            target,
            body: input.body,
            geometryCache: [],
          },
    ),
  )
}

export function newAnnotationId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  // Only reached in environments without WebCrypto. Ids are namespaced by the
  // service anyway, so uniqueness within a session is all this has to carry.
  return `margin-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}
