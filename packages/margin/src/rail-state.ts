/** Service rows and small, DOM-free rail view decisions. */
import {
  annotationBody,
  DOCUMENT_SCOPE_NODE_ID,
  textAnnotationSchema,
  type TextAnnotation,
} from './anchor.js'
import type { AnchorPlacement } from './document.js'
import { STRUCT_SELECTOR_TYPE } from './transport.js'

export type Visibility = 'private' | 'public'
export type RailEntry = {
  annotation: TextAnnotation
  visibility: Visibility
  creator?: string
}

/** Refresh from an authoritative API page set while preserving writes in flight. */
export function reconcileEntries(
  server: readonly RailEntry[],
  current: readonly RailEntry[],
  pendingLocal: ReadonlySet<string>,
  pendingMutation: ReadonlySet<string>,
  pendingDelete: ReadonlySet<string>,
): RailEntry[] {
  const oldById = new Map(current.map((entry) => [entry.annotation.id, entry]))
  const serverIds = new Set(server.map((entry) => entry.annotation.id))
  return [
    ...server
      .filter((entry) => !pendingDelete.has(entry.annotation.id))
      .map((entry) =>
        pendingMutation.has(entry.annotation.id)
          ? (oldById.get(entry.annotation.id) ?? entry)
          : entry,
      ),
    ...current.filter(
      (entry) =>
        pendingLocal.has(entry.annotation.id) &&
        !serverIds.has(entry.annotation.id),
    ),
  ]
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Web Annotation object')
  }
  return value as Record<string, unknown>
}

/** Decode the service's W3C result into the package's one anchor model. */
export function decodeWebAnnotation(value: unknown): RailEntry {
  const wire = object(value)
  const targetValue = Array.isArray(wire.target) ? wire.target[0] : wire.target
  const target = object(targetValue)
  const selectors = Array.isArray(target.selector)
    ? target.selector.map(object)
    : [object(target.selector)]
  const quote = selectors.find((one) => one.type === 'TextQuoteSelector')
  const position = selectors.find((one) => one.type === 'TextPositionSelector')
  const struct = selectors.find((one) => one.type === STRUCT_SELECTOR_TYPE)
  if (!quote || !position)
    throw new Error('Web Annotation selectors are incomplete')
  const kind =
    wire.motivation === 'highlighting'
      ? 'highlight'
      : wire.motivation === 'commenting'
        ? 'note'
        : wire.motivation === 'editing'
          ? 'proposal'
          : null
  if (!kind) throw new Error('Unsupported Web Annotation motivation')
  const body =
    typeof wire.body === 'string'
      ? wire.body
      : wire.body
        ? object(wire.body).value
        : undefined
  const annotation = textAnnotationSchema.parse({
    id: wire.id,
    kind,
    target: {
      nodeId: struct?.['margin:nodeId'] ?? DOCUMENT_SCOPE_NODE_ID,
      positionUnit: 'codepoint',
      position: { start: position.start, end: position.end },
      quote: {
        exact: quote.exact,
        prefix: quote.prefix ?? '',
        suffix: quote.suffix ?? '',
      },
    },
    ...(kind === 'highlight'
      ? { appearance: { color: wire['margin:color'] ?? 'yellow' } }
      : { body }),
    geometryCache: [],
  })
  const visibility = wire['margin:visibility']
  if (visibility !== 'private' && visibility !== 'public') {
    throw new Error('Web Annotation visibility is missing')
  }
  return {
    annotation,
    visibility,
    ...(typeof wire.creator === 'string' ? { creator: wire.creator } : {}),
  }
}

/** Display order follows placements, with stable input order for ties. */
export function orderAndFilterEntries(
  entries: readonly RailEntry[],
  placements: readonly AnchorPlacement[],
  nodeOrder: readonly string[],
  query: string,
): RailEntry[] {
  const rank = new Map(nodeOrder.map((id, index) => [id, index]))
  const needle = query.trim().toLocaleLowerCase()
  return entries
    .map((entry, index) => ({ entry, index, placement: placements[index] }))
    .filter(
      ({ entry }) =>
        !needle ||
        `${entry.annotation.target.quote.exact} ${annotationBody(entry.annotation) ?? ''}`
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort((left, right) => {
      const leftNode =
        left.placement?.status === 'anchored'
          ? left.placement.nodeId
          : left.entry.annotation.target.nodeId
      const rightNode =
        right.placement?.status === 'anchored'
          ? right.placement.nodeId
          : right.entry.annotation.target.nodeId
      return (
        (rank.get(leftNode) ?? Infinity) - (rank.get(rightNode) ?? Infinity) ||
        (left.placement?.status === 'anchored'
          ? left.placement.start
          : Infinity) -
          (right.placement?.status === 'anchored'
            ? right.placement.start
            : Infinity) ||
        left.index - right.index
      )
    })
    .map(({ entry }) => entry)
}
