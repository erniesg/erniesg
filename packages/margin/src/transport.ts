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
  createAnnotation(input: {
    documentUri: string
    kind: TextAnnotation['kind']
    targets: readonly SemanticTextAnchor[]
    body?: string
    color?: string
  }): Promise<MarginResponse>
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
    listAnnotations: (documentUri) =>
      transport.request({
        path: `${MARGIN_API_PREFIX}/annotations?document=${encodeURIComponent(documentUri)}`,
      }),
    createAnnotation: (input) =>
      transport.request({
        path: `${MARGIN_API_PREFIX}/annotations`,
        method: 'POST',
        body: input,
      }),
    deleteAnnotation: (id) =>
      transport.request({
        path: `${MARGIN_API_PREFIX}/annotations/${encodeURIComponent(id)}`,
        method: 'DELETE',
      }),
  }
}
