/**
 * How the package talks to a margin service.
 *
 * There is no default origin anywhere in this file. A host passes a base URL
 * or passes its own transport; this is the seam that lets the same package sit
 * on another site, or on a stub in a test, without a source change. The path
 * prefix is fixed because it is the service's contract, not its address.
 */
import type { SemanticTextAnchor, TextAnnotation } from './anchor'

export const MARGIN_API_PREFIX = '/api/margin/v1'

/**
 * The wire format, which is a W3C Web Annotation and not this package's own
 * shape.
 *
 * Spec 054 fixes the representation the service exchanges, and it is the reason
 * to have chosen the standard at all: an annotation this client writes should be
 * readable by something that never heard of `margin`. Sending
 * `{documentUri, kind, targets, …}` would have been a private protocol wearing a
 * standard's name, and it would have been rejected by 054's routes the day they
 * landed.
 *
 * These constants are duplicated from the service deliberately rather than
 * imported: this package does not depend on the site, and a shared module would
 * make it. `packages/margin/src/transport.test.ts` asserts the shape, so a drift
 * shows up here rather than as a 400 in a reader's browser.
 *
 * Note what is *not* here: the `margin:` namespace IRI. That is a site's own
 * vocabulary URL, and `packaging.test.ts` refuses any site identifier in this
 * package — correctly, since a package that names one site cannot be mounted on
 * another. The default `@context` is therefore the W3C one alone, which is
 * enough to make this a Web Annotation; a host that wants its prefix resolvable
 * in the request as well passes `context`. The service re-emits its own full
 * context on read, which is where a consumer needs it.
 */
export const WEB_ANNOTATION_CONTEXT = 'http://www.w3.org/ns/anno.jsonld'
export const STRUCT_SELECTOR_TYPE = 'margin:StructSelector'
export const BODY_FORMAT = 'text/plain'
export const ANNOTATION_TYPE = 'Annotation'

/**
 * Exhaustive by construction. When `TextAnnotation` grows `proposal` — that is
 * 060's edit mode — this stops compiling until its motivation (`editing`, which
 * 054's store already accepts) is named here, rather than serialising an
 * annotation the service will reject.
 */
const MOTIVATION_BY_KIND = {
  highlight: 'highlighting',
  note: 'commenting',
} as const satisfies Record<TextAnnotation['kind'], string>

export type WebAnnotationBody = {
  type: 'TextualBody'
  value: string
  format: typeof BODY_FORMAT
}

/** One anchor, as the three selectors 054 reads. */
export function webAnnotationTarget(
  source: string,
  anchor: SemanticTextAnchor,
): Record<string, unknown> {
  return {
    source,
    selector: [
      {
        type: 'TextQuoteSelector',
        exact: anchor.quote.exact,
        ...(anchor.quote.prefix ? { prefix: anchor.quote.prefix } : {}),
        ...(anchor.quote.suffix ? { suffix: anchor.quote.suffix } : {}),
      },
      {
        type: 'TextPositionSelector',
        start: anchor.position.start,
        end: anchor.position.end,
      },
      {
        type: STRUCT_SELECTOR_TYPE,
        'margin:nodeId': anchor.nodeId,
        // `margin:nodeId` is the node; `margin:structId` is struct's own id for
        // the block, which is a different thing and only sometimes present. The
        // digest does not travel: 054 stores it against the block in the
        // manifest, not against the annotation.
        ...(anchor.struct?.id ? { 'margin:structId': anchor.struct.id } : {}),
      },
    ],
  }
}

/**
 * One annotation, in the representation the service stores.
 *
 * One target per annotation, because that is what the service accepts: a
 * selection spanning three blocks is three annotations sharing a body, not one
 * annotation with three targets.
 */
export function toWebAnnotation(input: {
  documentUri: string
  kind: TextAnnotation['kind']
  target: SemanticTextAnchor
  body?: string
  color?: string
  visibility?: 'private' | 'public'
  parentId?: string
  /** The host's own `@context`, when its `margin:` prefix should resolve. */
  context?: unknown
}): Record<string, unknown> {
  const motivation = MOTIVATION_BY_KIND[input.kind]
  return {
    '@context': input.context ?? WEB_ANNOTATION_CONTEXT,
    type: ANNOTATION_TYPE,
    motivation,
    ...(input.kind === 'highlight'
      ? {}
      : {
          body: {
            type: 'TextualBody' as const,
            value: input.body ?? '',
            format: BODY_FORMAT,
          },
        }),
    target: webAnnotationTarget(input.documentUri, input.target),
    ...(input.visibility ? { 'margin:visibility': input.visibility } : {}),
    ...(input.kind === 'highlight' && input.color
      ? { 'margin:color': input.color }
      : {}),
    ...(input.parentId ? { 'margin:parentId': input.parentId } : {}),
  }
}

export type MarginRequest = {
  path: string
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

export type MarginResponse = {
  status: number
  body: unknown
}

export type MarginTransport = {
  request(request: MarginRequest): Promise<MarginResponse>
}

/**
 * A response the service refused.
 *
 * A transport resolves with whatever status it got — an HTTP error is a value,
 * not a throw — so a caller that only catches has no way to notice one. This is
 * what turns those statuses back into something a listener can be told about.
 */
export class MarginTransportError extends Error {
  readonly responses: readonly MarginResponse[]

  constructor(message: string, responses: readonly MarginResponse[]) {
    super(message)
    this.name = 'MarginTransportError'
    this.responses = responses
  }
}

export type HttpTransportOptions = {
  /**
   * Where the service lives. Required: a package that guesses its own origin
   * cannot be embedded anywhere but the site it was written for.
   */
  baseUrl: string
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
  credentials?: RequestCredentials
}

function joinPath(baseUrl: string, path: string) {
  if (!path.startsWith('/')) {
    throw new Error(`A margin request path must be absolute; got ${path}`)
  }
  return `${baseUrl.replace(/\/+$/u, '')}${path}`
}

export function createHttpTransport(
  options: HttpTransportOptions,
): MarginTransport {
  if (!options.baseUrl) {
    throw new Error('createHttpTransport requires an explicit baseUrl')
  }
  const doFetch = options.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new Error('createHttpTransport needs a fetch implementation')
  }

  return {
    async request({ path, method = 'GET', body, signal }) {
      const response = await doFetch(joinPath(options.baseUrl, path), {
        method,
        signal,
        credentials: options.credentials ?? 'include',
        headers: {
          accept: 'application/json',
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      let parsed: unknown = null
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      return { status: response.status, body: parsed }
    },
  }
}

export type MarginClient = {
  health(): Promise<MarginResponse>
  listAnnotations(documentUri: string): Promise<MarginResponse>
  /**
   * One annotation per target, because that is the service's unit.
   *
   * Returns one response per target, in order, so a caller can tell which of a
   * multi-block selection was stored and which was refused rather than getting
   * one status for all of them.
   */
  createAnnotations(input: {
    documentUri: string
    kind: TextAnnotation['kind']
    targets: readonly SemanticTextAnchor[]
    body?: string
    color?: string
    visibility?: 'private' | 'public'
    parentId?: string
    context?: unknown
  }): Promise<MarginResponse[]>
  deleteAnnotation(id: string): Promise<MarginResponse>
}

/**
 * The service surface 054 defines, expressed once.
 *
 * Every path is built from `MARGIN_API_PREFIX`, so a reader of this file can
 * see the whole of what the browser half asks for.
 */
export function createMarginClient(transport: MarginTransport): MarginClient {
  return {
    health: () => transport.request({ path: `${MARGIN_API_PREFIX}/health` }),
    // `?source=`, which is what 054's `readScope` reads. `?document=` alone is
    // half a scope and answers `missing_scope`.
    listAnnotations: (documentUri) =>
      transport.request({
        path: `${MARGIN_API_PREFIX}/annotations?source=${encodeURIComponent(documentUri)}`,
      }),
    createAnnotations: async (input) => {
      const responses: MarginResponse[] = []
      for (const target of input.targets) {
        responses.push(
          await transport.request({
            path: `${MARGIN_API_PREFIX}/annotations`,
            method: 'POST',
            body: toWebAnnotation({ ...input, target }),
          }),
        )
      }
      return responses
    },
    deleteAnnotation: (id) =>
      transport.request({
        path: `${MARGIN_API_PREFIX}/annotations/${encodeURIComponent(id)}`,
        method: 'DELETE',
      }),
  }
}
