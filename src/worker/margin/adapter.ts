import { z } from 'zod'
import { decodeBase64Url, encodeBase64Url, timingSafeEqual } from './base64url'
import type {
  AdapterCredential,
  AdapterFeedRepository,
  ApprovedFeedCursor,
  ApprovedFeedItem,
} from './repository'
import { splitSource } from './web-annotation'

export const ADAPTER_FEED_PATH = '/api/margin/v1/adapter/feed'
const ADAPTER_NAMESPACE = '/api/margin/v1/adapter'
export const ADAPTER_PAGE_BYTES = 4 * 1024 * 1024
export const ADAPTER_PAGE_SIZE = 50
// Accommodate the JSON/base64 expansion of every accepted 2048-unit ID.
const MAX_CURSOR_LENGTH = 32_768
const MAX_QUERY_LENGTH = 40_000
const TOKEN_PREFIX = 'margin-adapter-v1.'
const encoder = new TextEncoder()
const date = z.string().datetime({ offset: true }).max(40)
const id = z.string().min(1).max(2048)
export const adapterSiteSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    const scope = splitSource(value)
    return scope?.site === value && scope.document === '/'
  })
export const adapterIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
export function canonicalSegment(value: string, size: number): boolean {
  const bytes = decodeBase64Url(value)
  return bytes?.length === size && encodeBase64Url(bytes) === value
}
export const adapterSelectorSchema = z
  .string()
  .length(22)
  .refine((value) => canonicalSegment(value, 16))
export const approvedFeedOptionsSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(ADAPTER_PAGE_SIZE + 1),
    after: z.object({ approvedAt: date, proposalId: id }).strict().optional(),
  })
  .strict()
const cursorSchema = z
  .object({
    version: z.literal(1),
    site: adapterSiteSchema,
    adapter: adapterIdSchema,
    tokenId: adapterSelectorSchema,
    eligibility: z.literal('approved'),
    approvedAt: date,
    proposalId: id,
  })
  .strict()

/** Classification reserves aliases for refusal; only the exact route is served. */
export function isAdapterNamespace(path: string): boolean {
  // Decode for refusal classification only. An invalid suffix must not hide a
  // recognized namespace prefix and send it through human authentication.
  const normalized = path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/')
  return (
    normalized === ADAPTER_NAMESPACE.slice(1) ||
    normalized.startsWith(ADAPTER_NAMESPACE.slice(1) + '/')
  )
}
export function hasAdapterCredential(request: Request): boolean {
  return /^Bearer\s+margin-adapter-v1(?:\.|$)/i.test(
    request.headers.get('authorization') ?? '',
  )
}
export function adapterError(status: number, code: string): Response {
  return response({ error: { code } }, status)
}
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
function token(request: Request): { value: string; selector: string } | null {
  const header = request.headers.get('authorization') ?? ''
  const match =
    /^Bearer (margin-adapter-v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43}))$/i.exec(
      header,
    )
  if (
    !match ||
    !match[1].startsWith(TOKEN_PREFIX) ||
    !canonicalSegment(match[2], 16) ||
    !canonicalSegment(match[3], 32)
  )
    return null
  return { value: match[1], selector: match[2] }
}
function cursor(value: string, credential: AdapterCredential): ApprovedFeedCursor {
  if (value.length > MAX_CURSOR_LENGTH) throw new Error('cursor length')
  const bytes = decodeBase64Url(value)
  if (!bytes || encodeBase64Url(bytes) !== value) throw new Error('cursor encoding')
  const decoded = cursorSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  )
  // Re-serialization also rejects duplicate keys and noncanonical JSON forms.
  if (encodeBase64Url(encoder.encode(JSON.stringify(decoded))) !== value)
    throw new Error('cursor canonical form')
  if (
    decoded.site !== credential.site ||
    decoded.adapter !== credential.adapter ||
    decoded.tokenId !== credential.tokenId
  )
    throw new Error('cursor scope')
  return { approvedAt: decoded.approvedAt, proposalId: decoded.proposalId }
}
function nextCursor(credential: AdapterCredential, item: ApprovedFeedItem): string {
  return encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        version: 1,
        site: credential.site,
        adapter: credential.adapter,
        tokenId: credential.tokenId,
        eligibility: 'approved',
        approvedAt: item.approvedAt,
        proposalId: item.proposalId,
      }),
    ),
  )
}

/** No cookies, Principal, provider, write, or report capability is consulted here. */
export async function handleAdapterFeed(
  request: Request,
  repository: AdapterFeedRepository | null,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== ADAPTER_FEED_PATH) return adapterError(404, 'not_found')
  if (request.method !== 'GET') {
    const denied = adapterError(405, 'method_not_allowed')
    denied.headers.set('allow', 'GET')
    return denied
  }
  const supplied = token(request)
  if (!supplied) return adapterError(401, 'adapter_unauthorized')
  if (!repository) return adapterError(503, 'storage_unavailable')
  try {
    const credential = await repository.findAdapterCredential(supplied.selector)
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', encoder.encode(supplied.value)),
      ),
      (x) => x.toString(16).padStart(2, '0'),
    ).join('')
    // Both operands have fixed length, even when the selector is unknown.
    const matches = timingSafeEqual(digest, credential?.tokenSha256 ?? '0'.repeat(64))
    if (!credential || !matches) return adapterError(401, 'adapter_unauthorized')
    if (
      !credential.enabled ||
      credential.revokedAt !== null ||
      credential.capability !== 'approved_feed'
    )
      return adapterError(403, 'adapter_forbidden')
    let limit = 25,
      after: ApprovedFeedCursor | undefined
    try {
      if (url.username || url.password) throw new Error('userinfo')
      if (url.search.length > MAX_QUERY_LENGTH) throw new Error('query length')
      for (const key of url.searchParams.keys())
        if (
          !['limit', 'cursor'].includes(key) ||
          url.searchParams.getAll(key).length !== 1
        )
          throw new Error('query')
      if (url.searchParams.has('limit')) {
        const value = url.searchParams.get('limit')!
        if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) throw new Error('limit')
        limit = Number(value)
      }
      if (url.searchParams.has('cursor'))
        after = cursor(url.searchParams.get('cursor')!, credential)
    } catch {
      return adapterError(400, 'invalid_feed_query')
    }
    const page = await repository.listApprovedFeed(credential, {
      limit: limit + 1,
      ...(after ? { after } : {}),
    })
    if (!page.authorized) return adapterError(403, 'adapter_forbidden')
    const items: ApprovedFeedItem[] = []
    let next: string | null = null
    for (let i = 0; i < Math.min(limit, page.items.length); i++) {
      const item = page.items[i],
        candidate = [...items, item]
      const boundary = i + 1 < page.items.length ? nextCursor(credential, item) : null
      if (
        encoder.encode(
          JSON.stringify({
            eligibility: 'approved',
            items: candidate,
            nextCursor: boundary,
          }) + '\n',
        ).byteLength > ADAPTER_PAGE_BYTES
      ) {
        if (!items.length) throw new Error('unrepresentable feed row')
        next = nextCursor(credential, items[items.length - 1])
        break
      }
      items.push(item)
      next = boundary
    }
    return response({ eligibility: 'approved', items, nextCursor: next })
  } catch {
    return adapterError(503, 'storage_unavailable')
  }
}
