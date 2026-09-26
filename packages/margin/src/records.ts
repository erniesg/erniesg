/**
 * What the rail holds for each annotation, and how a service response becomes
 * one.
 *
 * An annotation alone is not enough to draw a rail entry: the entry also needs
 * its visibility (to show and toggle it), whose it is (only the owner gets the
 * controls — the service would refuse anyone else anyway), and the id the
 * service knows it by (which is not the id the client made up before saving).
 */
import {
  DOCUMENT_SCOPE_NODE_ID,
  textAnnotationSchema,
  type TextAnnotation,
} from './anchor.js'
import { STRUCT_SELECTOR_TYPE } from './transport.js'

export type MarginVisibility = 'private' | 'public'
export const VISIBILITIES: readonly MarginVisibility[] = ['private', 'public']

/** `private`, for the same reason the service defaults to it. */
export const DEFAULT_VISIBILITY: MarginVisibility = 'private'

export type RailRecord = {
  annotation: TextAnnotation
  visibility: MarginVisibility
  /** Whether the reader may change or delete it. */
  mine: boolean
  /** The service's id, once the service has one. */
  serverId: string | null
}

const ANNOTATION_IRI_PREFIX = 'urn:margin:annotation:'

const KIND_BY_MOTIVATION: Record<string, TextAnnotation['kind'] | undefined> = {
  highlighting: 'highlight',
  commenting: 'note',
  editing: 'proposal',
}

type Selector = Record<string, unknown> & { type?: unknown }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The bare id from either spelling the service uses. */
export function serverIdFromIri(value: string): string {
  return value.startsWith(ANNOTATION_IRI_PREFIX)
    ? value.slice(ANNOTATION_IRI_PREFIX.length)
    : value
}

/**
 * One Web Annotation from the service, as a rail record — or `null` when it is
 * not one the rail draws.
 *
 * Replies (`margin:parentId`) are threaded comments, which are 058's; drawing
 * them here as free-standing entries would list every reply twice once the
 * thread view lands. Anything malformed is skipped rather than thrown on: one
 * bad row must not blank a reader's whole margin.
 *
 * Positions arrive in code points, as the W3C model counts them, and are kept
 * that way (`positionUnit: 'codepoint'`) — the resolver converts, so nothing
 * here does arithmetic on offsets.
 */
export function recordFromWebAnnotation(
  wire: unknown,
  viewer: string | null,
): RailRecord | null {
  const annotation = asRecord(wire)
  if (!annotation || annotation['margin:parentId']) return null
  const id =
    typeof annotation.id === 'string' ? serverIdFromIri(annotation.id) : null
  const kind = KIND_BY_MOTIVATION[String(annotation.motivation)]
  const target = asRecord(annotation.target)
  if (!id || !kind || !target || !Array.isArray(target.selector)) return null

  const selectors = target.selector as Selector[]
  const quote = selectors.find((entry) => entry?.type === 'TextQuoteSelector')
  const position = selectors.find(
    (entry) => entry?.type === 'TextPositionSelector',
  )
  const struct = selectors.find((entry) => entry?.type === STRUCT_SELECTOR_TYPE)
  if (!quote || !position) return null

  const body = asRecord(annotation.body)
  const visibility =
    annotation['margin:visibility'] === 'public' ? 'public' : 'private'
  const parsed = textAnnotationSchema.safeParse({
    id,
    kind,
    target: {
      nodeId:
        typeof struct?.['margin:nodeId'] === 'string'
          ? struct['margin:nodeId']
          : DOCUMENT_SCOPE_NODE_ID,
      ...(typeof struct?.['margin:structId'] === 'string'
        ? { struct: { id: struct['margin:structId'] } }
        : {}),
      positionUnit: 'codepoint',
      position: { start: position.start, end: position.end },
      quote: {
        exact: quote.exact,
        prefix: typeof quote.prefix === 'string' ? quote.prefix : '',
        suffix: typeof quote.suffix === 'string' ? quote.suffix : '',
      },
    },
    ...(kind === 'highlight'
      ? {
          appearance: {
            color:
              typeof annotation['margin:color'] === 'string'
                ? annotation['margin:color']
                : 'key',
          },
        }
      : { body: typeof body?.value === 'string' ? body.value : '' }),
    geometryCache: [],
  })
  if (!parsed.success) return null
  return {
    annotation: parsed.data,
    visibility,
    mine: viewer !== null && annotation.creator === viewer,
    serverId: id,
  }
}
