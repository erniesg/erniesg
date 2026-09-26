/**
 * How the package talks to a margin service.
 *
 * There is no default origin anywhere in this file. A host passes a base URL
 * or passes its own transport; this is the seam that lets the same package sit
 * on another site, or on a stub in a test, without a source change. The path
 * prefix is fixed because it is the service's contract, not its address.
 */
import {
  codePointOffsetForUtf16Offset,
  DOCUMENT_SCOPE_NODE_ID,
  type SemanticTextAnchor,
  type TextAnnotation,
} from './anchor.js'

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
  proposal: 'editing',
} as const satisfies Record<TextAnnotation['kind'], string>

export type WebAnnotationBody = {
  type: 'TextualBody'
  value: string
  format: typeof BODY_FORMAT
}

type AnnotationKindInput =
  | { kind: 'highlight'; body?: never; color?: string }
  | { kind: 'note'; body: string; color?: never }
  | { kind: 'proposal'; body: string; color?: never }

type AnnotationRequestCommon = {
  documentUri: string
  visibility?: 'private' | 'public'
  parentId?: string
  context?: unknown
}

function requireNoteBody(input: AnnotationKindInput): void {
  if (
    input.kind !== 'highlight' &&
    (typeof input.body !== 'string' || !input.body.trim())
  ) {
    throw new Error(`${input.kind} body must be non-empty`)
  }
}

/** One anchor, as the three selectors 054 reads. */
export function webAnnotationTarget(
  source: string,
  anchor: SemanticTextAnchor,
  /** Complete ordered text for @document, or complete text of this node. */
  text?: string,
): Record<string, unknown> {
  let position = anchor.position
  if (anchor.positionUnit !== 'codepoint') {
    if (text === undefined)
      throw new Error(
        'full node or document text is required to serialize UTF-16 positions',
      )
    if (text.slice(position.start, position.end) !== anchor.quote.exact) {
      throw new Error('anchor position does not match the supplied full text')
    }
    if (
      !text.slice(0, position.start).endsWith(anchor.quote.prefix) ||
      !text.slice(position.end).startsWith(anchor.quote.suffix)
    ) {
      throw new Error('anchor context does not match the supplied full text')
    }
    const start = codePointOffsetForUtf16Offset(text, position.start)
    const end = codePointOffsetForUtf16Offset(text, position.end)
    if (start === null || end === null)
      throw new Error('anchor position splits a Unicode character')
    position = { start, end }
  }
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
        start: position.start,
        end: position.end,
      },
      ...(anchor.nodeId === DOCUMENT_SCOPE_NODE_ID
        ? []
        : [
            {
              type: STRUCT_SELECTOR_TYPE,
              'margin:nodeId': anchor.nodeId,
              // `margin:nodeId` is the node; `margin:structId` is struct's own id for
              // the block, which is a different thing and only sometimes present. The
              // digest does not travel: 054 stores it against the block in the
              // manifest, not against the annotation.
              ...(anchor.struct?.id
                ? { 'margin:structId': anchor.struct.id }
                : {}),
            },
          ]),
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
export function toWebAnnotation(
  input: AnnotationRequestCommon &
    AnnotationKindInput & {
      target: SemanticTextAnchor
      targetText?: string
    },
): Record<string, unknown> {
  requireNoteBody(input)
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
            value: input.body,
            format: BODY_FORMAT,
          },
        }),
    target: webAnnotationTarget(
      input.documentUri,
      input.target,
      input.targetText,
    ),
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
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
  createAnnotations(
    input: AnnotationRequestCommon &
      AnnotationKindInput & {
        targets: readonly SemanticTextAnchor[]
        /** Full text for each target, in the same order; required for UTF-16 anchors. */
        targetTexts?: readonly string[]
      },
  ): Promise<MarginResponse[]>
  /**
   * Owner-scoped. `documentUri` is required because the service scopes every
   * annotation route by `?source=`: a delete without it answers
   * `missing_scope`, so the old one-argument form could never succeed.
   */
  deleteAnnotation(id: string, documentUri: string): Promise<MarginResponse>
  /** Owner-scoped: visibility, colour or a note's body, never the target. */
  updateAnnotation(
    id: string,
    documentUri: string,
    patch: AnnotationPatch,
  ): Promise<MarginResponse>
  /** A later page of `listAnnotations`, from the `nextCursor` it returned. */
  listAnnotationsAfter(
    documentUri: string,
    cursor: string,
  ): Promise<MarginResponse>
  readPrefs(): Promise<MarginResponse>
  /** Affects only annotations created afterwards; the service rewrites none. */
  writePrefs(defaultVisibility: 'private' | 'public'): Promise<MarginResponse>
}

export type AnnotationPatch = {
  visibility?: 'private' | 'public'
  color?: string
  body?: string
}

function annotationPath(id: string, documentUri: string) {
  return `${MARGIN_API_PREFIX}/annotations/${encodeURIComponent(id)}?source=${encodeURIComponent(documentUri)}`
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
      requireNoteBody(input)
      const responses: MarginResponse[] = []
      // Build every request before sending one, so missing text cannot leave a
      // multi-block selection half persisted.
      const bodies = input.targets.map((target, index) =>
        toWebAnnotation({
          ...input,
          target,
          targetText: input.targetTexts?.[index],
        }),
      )
      for (const body of bodies) {
        responses.push(
          await transport.request({
            path: `${MARGIN_API_PREFIX}/annotations`,
            method: 'POST',
            body,
          }),
        )
      }
      return responses
    },
    deleteAnnotation: (id, documentUri) =>
      transport.request({
        path: annotationPath(id, documentUri),
        method: 'DELETE',
      }),
    updateAnnotation: (id, documentUri, patch) => {
      const body: Record<string, string> = {}
      if (patch.visibility) body['margin:visibility'] = patch.visibility
      if (patch.color) body['margin:color'] = patch.color
      if (patch.body !== undefined) body.body = patch.body
      if (Object.keys(body).length === 0) {
        throw new Error('an annotation patch must change something')
      }
      return transport.request({
        path: annotationPath(id, documentUri),
        method: 'PATCH',
        body,
      })
    },
    listAnnotationsAfter: (documentUri, cursor) =>
      transport.request({
        path: `${MARGIN_API_PREFIX}/annotations?source=${encodeURIComponent(documentUri)}&cursor=${encodeURIComponent(cursor)}`,
      }),
    readPrefs: () => transport.request({ path: `${MARGIN_API_PREFIX}/prefs` }),
    writePrefs: (defaultVisibility) =>
      transport.request({
        path: `${MARGIN_API_PREFIX}/prefs`,
        method: 'PATCH',
        body: { defaultVisibility },
      }),
  }
}
