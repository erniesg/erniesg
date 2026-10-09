import { z } from 'zod'
import { decodeBase64Url, encodeBase64Url, timingSafeEqual } from './base64url'
import type {
  AdapterCredential,
  AdapterFeedRepository,
  AdapterReportRepository,
  AdapterWorkRepository,
  AdapterWorkCandidate,
  AdapterReportResult,
  ApprovedFeedCursor,
  ApprovedFeedItem,
  PublicCorrelationRepository,
  PublicCorrelationKey,
} from './repository'
import { splitSource } from './web-annotation'
import {
  canonicalSegment,
  adapterSelectorSchema,
  adapterExecutionReportSchema,
} from './repository'
export { canonicalSegment, adapterSelectorSchema } from './repository'

export const ADAPTER_FEED_PATH = '/api/margin/v1/adapter/feed'
const ADAPTER_NAMESPACE = '/api/margin/v1/adapter'
export const ADAPTER_PAGE_BYTES = 4 * 1024 * 1024
export const ADAPTER_PAGE_SIZE = 50
export const CORRELATION_PAGE_SIZE = 10
export const publicCorrelationSchema = z
  .object({
    version: z.literal(1),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
export type AdapterDeliveryOptions = {
  publicCorrelationKey?: unknown
  publicCorrelationKeyId?: unknown
}
class CorrelationPageDeadline extends Error {}
function boundedWorkJSON(value: unknown): string {
  const text = JSON.stringify(value)
  if (encoder.encode(text).byteLength > ADAPTER_PAGE_BYTES)
    throw Error('work projection bound')
  return text
}
async function importCorrelationKey(
  options: AdapterDeliveryOptions,
): Promise<PublicCorrelationKey | null> {
  const value = options.publicCorrelationKey,
    keyId = options.publicCorrelationKeyId
  if (
    typeof value !== 'string' ||
    value.length !== 43 ||
    !canonicalSegment(value, 32) ||
    typeof keyId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(keyId)
  )
    return null
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(decodeBase64Url(value)!),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    return { key, keyId }
  } catch {
    return null
  }
}

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
    .toLowerCase()
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

/** Shared bearer verification; repository methods still recheck current scope. */
async function authenticateAdapter(
  request: Request,
  repository: AdapterFeedRepository | null,
  check?: () => void,
): Promise<{ credential: AdapterCredential } | { denied: Response }> {
  const supplied = token(request)
  if (!supplied) return { denied: adapterError(401, 'adapter_unauthorized') }
  if (!repository) return { denied: adapterError(503, 'storage_unavailable') }
  try {
    check?.()
    const credential = await repository.findAdapterCredential(supplied.selector)
    check?.()
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', encoder.encode(supplied.value)),
      ),
      (x) => x.toString(16).padStart(2, '0'),
    ).join('')
    check?.()
    const matches = timingSafeEqual(digest, credential?.tokenSha256 ?? '0'.repeat(64))
    if (!credential || !matches)
      return { denied: adapterError(401, 'adapter_unauthorized') }
    if (
      !credential.enabled ||
      credential.revokedAt !== null ||
      credential.capability !== 'approved_feed'
    )
      return { denied: adapterError(403, 'adapter_forbidden') }
    return { credential }
  } catch {
    return { denied: adapterError(503, 'storage_unavailable') }
  }
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
  const authenticated = await authenticateAdapter(request, repository)
  if ('denied' in authenticated) return authenticated.denied
  const credential = authenticated.credential
  try {
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
    const page = await repository!.listApprovedFeed(credential, {
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

export const ADAPTER_WORK_PATH = '/api/margin/v1/adapter/work'
const workCursorSchema = cursorSchema
  .omit({ eligibility: true })
  .extend({ purpose: z.literal('work') })
function workCursor(value: string, credential: AdapterCredential): ApprovedFeedCursor {
  if (value.length > MAX_CURSOR_LENGTH) throw Error('cursor length')
  const bytes = decodeBase64Url(value)
  if (!bytes || encodeBase64Url(bytes) !== value) throw Error('cursor encoding')
  const decoded = workCursorSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  )
  // Construct in the declared wire order, independently of input member order.
  if (
    nextWorkCursor(credential, decoded) !== value ||
    decoded.site !== credential.site ||
    decoded.adapter !== credential.adapter ||
    decoded.tokenId !== credential.tokenId
  )
    throw Error('cursor scope or canonical form')
  return { approvedAt: decoded.approvedAt, proposalId: decoded.proposalId }
}
function nextWorkCursor(
  credential: AdapterCredential,
  item: ApprovedFeedCursor,
): string {
  return encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        version: 1,
        purpose: 'work',
        site: credential.site,
        adapter: credential.adapter,
        tokenId: credential.tokenId,
        approvedAt: item.approvedAt,
        proposalId: item.proposalId,
      }),
    ),
  )
}
async function handleAdapterWork(
  request: Request,
  repository:
    | (AdapterFeedRepository &
        AdapterWorkRepository &
        Partial<PublicCorrelationRepository>)
    | null,
  options: AdapterDeliveryOptions = {},
): Promise<Response> {
  if (request.method !== 'GET') return methodDenied('GET')
  const url = new URL(request.url),
    include = url.searchParams.get('include') === 'publicCorrelation'
  const deadline = include ? performance.now() + 10000 : Infinity
  const material = include
    ? {
        publicCorrelationKey: options.publicCorrelationKey,
        publicCorrelationKeyId: options.publicCorrelationKeyId,
      }
    : {}
  const check = () => {
    if (include && performance.now() >= deadline)
      throw new CorrelationPageDeadline()
  }
  const authenticated = await authenticateAdapter(
    request,
    repository,
    include ? check : undefined,
  )
  if (include && performance.now() >= deadline)
    return adapterError(503, 'public_correlation_deadline')
  if ('denied' in authenticated) return authenticated.denied
  const credential = authenticated.credential
  let limit = include ? CORRELATION_PAGE_SIZE : 25,
    after: ApprovedFeedCursor | undefined
  try {
    if (url.username || url.password || url.search.length > MAX_QUERY_LENGTH)
      throw Error('query')
    for (const key of url.searchParams.keys())
      if (
        !['limit', 'cursor', 'include'].includes(key) ||
        url.searchParams.getAll(key).length !== 1
      )
        throw Error('query')
    if (url.searchParams.has('include') && !include) throw Error('include')
    if (url.searchParams.has('limit')) {
      const value = url.searchParams.get('limit')!
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) throw Error('limit')
      limit = Number(value)
      if (include && limit > CORRELATION_PAGE_SIZE) throw Error('limit')
    }
    if (url.searchParams.has('cursor'))
      after = workCursor(url.searchParams.get('cursor')!, credential)
  } catch {
    return adapterError(400, 'invalid_work_query')
  }
  const project = (candidates: AdapterWorkCandidate[]) => {
    const scanned = candidates.slice(0, limit)
    const items: (Omit<AdapterWorkCandidate, 'execution'> & {
      execution: Omit<
        NonNullable<AdapterWorkCandidate['execution']>,
        'boundAdapter'
      >
      work: 'apply' | 'refresh_pr' | 'reconcile_only'
    })[] = []
    const notEvaluated = { unknownExecution: 0 },
      excluded = { exhaustedFailures: 0, otherAdapter: 0 }
    for (const candidate of scanned) {
      const { execution, ...snapshot } = candidate
      if (execution === null) {
        notEvaluated.unknownExecution++
        continue
      }
      const { boundAdapter, ...metadata } = execution
      if (boundAdapter !== null && boundAdapter !== credential.adapter) {
        excluded.otherAdapter++
        continue
      }
      if (
        execution.state === 'apply_failed' &&
        execution.failedApplyCount === 3
      ) {
        excluded.exhaustedFailures++
        continue
      }
      const work =
        execution.pr !== null
          ? 'refresh_pr'
          : execution.failedApplyCount === 3
            ? 'reconcile_only'
            : 'apply'
      items.push({ ...snapshot, execution: metadata, work })
    }
    const body = {
      eligibility: 'known_execution',
      items,
      nextCursor:
        candidates.length > limit
          ? nextWorkCursor(credential, scanned[scanned.length - 1])
          : null,
      scanned: scanned.length,
      notEvaluated,
      excluded,
    }
    return body
  }
  try {
    check()
    const query = { limit: limit + 1, ...(after ? { after } : {}) }
    const page = await repository!.listAdapterWork(credential, query)
    check()
    if (!page.authorized) return adapterError(403, 'adapter_forbidden')
    const body = project(page.candidates)
    if (include) {
      if (typeof repository!.getOrIssuePublicCorrelation !== 'function')
        return adapterError(503, 'public_correlation_unavailable')
      const initial = boundedWorkJSON(page.candidates),
        initialBody = boundedWorkJSON(body)
      check()
      const key = body.items.length
        ? await importCorrelationKey(material)
        : null
      check()
      const correlations: z.infer<typeof publicCorrelationSchema>[] = []
      for (const item of body.items) {
        check()
        const result = await repository!.getOrIssuePublicCorrelation!(
          credential,
          {
            proposalId: item.proposalId,
            approvedRevision: item.approvedRevision,
          },
          key,
          deadline,
        )
        check()
        if (result.status === 'forbidden')
          return adapterError(403, 'adapter_forbidden')
        if (result.status === 'not_evaluated')
          return adapterError(
            503,
            result.reason === 'deadline'
              ? 'public_correlation_deadline'
              : result.reason === 'legacy_reconciliation_required'
                ? 'public_correlation_legacy_unavailable'
                : 'public_correlation_unavailable',
          )
        if (
          result.status !== 'ready' ||
          result.site !== item.site ||
          result.proposalId !== item.proposalId ||
          result.approvedRevision !== item.approvedRevision
        )
          return adapterError(503, 'public_correlation_page_changed')
        correlations.push(
          publicCorrelationSchema.parse(result.publicCorrelation),
        )
      }
      check()
      const final = await repository!.listAdapterWork(credential, query)
      check()
      if (!final.authorized) return adapterError(403, 'adapter_forbidden')
      if (
        boundedWorkJSON(final.candidates) !== initial ||
        boundedWorkJSON(project(final.candidates)) !== initialBody
      )
        return adapterError(503, 'public_correlation_page_changed')
      const enriched = {
        ...body,
        publicCorrelation: 'v1',
        items: body.items.map((item, index) => ({
          ...item,
          publicCorrelation: correlations[index],
        })),
      }
      if (
        encoder.encode(JSON.stringify(enriched) + '\n').byteLength >
        ADAPTER_PAGE_BYTES
      )
        throw Error('work page byte bound')
      check()
      const result = response(enriched)
      check()
      return result
    }
    if (
      encoder.encode(JSON.stringify(body) + '\n').byteLength >
      ADAPTER_PAGE_BYTES
    )
      throw Error('work page byte bound')
    return response(body)
  } catch (error) {
    return adapterError(
      503,
      error instanceof CorrelationPageDeadline ||
        (include && performance.now() >= deadline)
        ? 'public_correlation_deadline'
        : include
          ? 'public_correlation_unavailable'
          : 'storage_unavailable',
    )
  }
}

export const ADAPTER_REPORT_PATH = '/api/margin/v1/adapter/reports'
const RECEIPT_PREFIX = '/api/margin/v1/adapter/receipts/'
const REPORT_BYTES = 65_536
class ReportBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

/** Purpose-built JSON reader for objects/scalars only, at most three object
 * levels and16 members per object. Decoded member names are checked before
 * assignment, including differently escaped spellings of the same name. */
function reportJSON(text: string): unknown {
  let at = 0
  const fail = (): never => {
    throw new ReportBodyError(400, 'invalid_report')
  }
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? '') && at < text.length) at++
  }
  const string = (): string => {
    if (text[at] !== '"') return fail()
    const start = at++
    while (at < text.length) {
      const ch = text[at++]
      if (ch === '\\') {
        if (at >= text.length) return fail()
        at++
        continue
      }
      if (ch === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string
        } catch {
          return fail()
        }
      }
    }
    return fail()
  }
  const value = (depth: number): unknown => {
    space()
    if (text[at] === '{') return object(depth)
    if (text[at] === '"') return string()
    const match =
      /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        text.slice(at),
      )
    if (!match) return fail()
    at += match[0].length
    const result: unknown = JSON.parse(match[0])
    if (typeof result === 'number' && !Number.isFinite(result)) return fail()
    return result
  }
  const object = (depth: number): Record<string, unknown> => {
    if (depth > 3 || text[at++] !== '{') return fail()
    const result: Record<string, unknown> = Object.create(null),
      keys = new Set<string>()
    space()
    if (text[at] === '}') {
      at++
      return result
    }
    while (at < text.length) {
      space()
      const key = string()
      if (keys.has(key) || keys.size >= 16) return fail()
      keys.add(key)
      space()
      if (text[at++] !== ':') return fail()
      result[key] = value(depth + 1)
      space()
      const next = text[at++]
      if (next === '}') return result
      if (next !== ',') return fail()
    }
    return fail()
  }
  space()
  const result = object(1)
  space()
  if (at !== text.length) return fail()
  return result
}

async function readReportBody(request: Request): Promise<unknown> {
  const media = request.headers.get('content-type') ?? ''
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(media) ||
    request.headers.has('content-encoding')
  ) {
    void request.body?.cancel().catch(() => {})
    throw new ReportBodyError(415, 'unsupported_report_media')
  }
  if (!request.body) throw new ReportBodyError(400, 'invalid_report')
  const reader = request.body.getReader(),
    bytes = new Uint8Array(REPORT_BYTES)
  let length = 0,
    reads = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      if (!(item.value instanceof Uint8Array) || ++reads > REPORT_BYTES + 1)
        throw new ReportBodyError(400, 'invalid_report')
      if (length + item.value.byteLength > REPORT_BYTES)
        throw new ReportBodyError(413, 'report_too_large')
      bytes.set(item.value, length)
      length += item.value.byteLength
    }
    // Preserve a BOM so JSON grammar rejects it instead of silently stripping.
    return reportJSON(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, length),
      ),
    )
  } catch (error) {
    void reader.cancel().catch(() => {})
    if (error instanceof ReportBodyError) throw error
    throw new ReportBodyError(400, 'invalid_report')
  } finally {
    reader.releaseLock()
  }
}
function methodDenied(allow: string): Response {
  const denied = adapterError(405, 'method_not_allowed')
  denied.headers.set('allow', allow)
  return denied
}
const reportAckSchema = z
  .object({
    eventId: adapterSelectorSchema,
    proposalId: id,
    approvedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    stateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    failedApplyCount: z.number().int().min(0).max(3),
    state: z.enum(['pr_open', 'conflict', 'apply_failed', 'merged', 'closed']),
    acceptedAt: date,
  })
  .strict()
  .refine((ack) => ack.failedApplyCount <= ack.stateVersion)
function reportResponse(result: AdapterReportResult, receipt: boolean): Response {
  if (result.status === 'accepted') {
    const parsed = z
      .object({ status: z.literal('accepted'), ack: reportAckSchema })
      .strict()
      .parse(result)
    return response({ ack: parsed.ack })
  }
  z.object({ status: z.string() }).strict().parse(result)
  if (result.status === 'forbidden') return adapterError(403, 'adapter_forbidden')
  if (receipt && result.status === 'missing')
    return adapterError(404, 'receipt_not_found')
  if (!receipt && result.status === 'conflict')
    return adapterError(409, 'report_conflict')
  if (!receipt && result.status === 'not_evaluated')
    return adapterError(503, 'execution_not_evaluated')
  return adapterError(503, 'storage_unavailable')
}
async function reportRoute(
  request: Request,
  repository: (AdapterFeedRepository & AdapterReportRepository) | null,
): Promise<Response> {
  const url = new URL(request.url),
    isReport = url.pathname === ADAPTER_REPORT_PATH
  const segment = url.pathname.startsWith(RECEIPT_PREFIX)
    ? url.pathname.slice(RECEIPT_PREFIX.length)
    : null
  const isReceipt = segment !== null && /^[A-Za-z0-9_-]{22}$/.test(segment)
  if (!isReport && !isReceipt) return adapterError(404, 'not_found')
  if (isReport ? request.method !== 'POST' : !['GET', 'HEAD'].includes(request.method))
    return methodDenied(isReport ? 'POST' : 'GET, HEAD')
  const authenticated = await authenticateAdapter(request, repository)
  if ('denied' in authenticated) return authenticated.denied
  if (url.search || url.username || url.password)
    return adapterError(400, 'invalid_report_query')
  if (isReceipt) {
    if (!adapterSelectorSchema.safeParse(segment).success)
      return adapterError(400, 'invalid_receipt_id')
    try {
      return reportResponse(
        await repository!.readAdapterReportReceipt(authenticated.credential, segment!),
        true,
      )
    } catch {
      return adapterError(503, 'storage_unavailable')
    }
  }
  let command
  try {
    command = adapterExecutionReportSchema.parse(await readReportBody(request))
  } catch (error) {
    return error instanceof ReportBodyError
      ? adapterError(error.status, error.code)
      : adapterError(400, 'invalid_report')
  }
  // This catch is deliberately separate: a post-commit malformed response is
  // uncertain storage, never client400 and never an automatic mutation retry.
  try {
    return reportResponse(
      await repository!.reportProposalExecution(
        authenticated.credential,
        command,
        new Date().toISOString(),
      ),
      false,
    )
  } catch {
    return adapterError(503, 'storage_unavailable')
  }
}

/** Exact service dispatcher. Namespace aliases reach refusal here, not AuthKit. */
export async function handleAdapterRequest(
  request: Request,
  repository:
    | (AdapterFeedRepository &
        AdapterReportRepository &
        AdapterWorkRepository &
        Partial<PublicCorrelationRepository>)
    | null,
  options: AdapterDeliveryOptions = {},
): Promise<Response> {
  const result =
    new URL(request.url).pathname === ADAPTER_FEED_PATH
      ? await handleAdapterFeed(request, repository)
      : new URL(request.url).pathname === ADAPTER_WORK_PATH
        ? await handleAdapterWork(request, repository, options)
        : await reportRoute(request, repository)
  return request.method === 'HEAD'
    ? new Response(null, { status: result.status, headers: result.headers })
    : result
}

/** Service-only primitive. The result must be durably associated before disclosure. */
export async function derivePublicCorrelation(
  material: import('./repository').PublicCorrelationKey,
  site: string,
  proposalId: string,
): Promise<string> {
  adapterSiteSchema.parse(site)
  id.parse(proposalId)
  const roundtrip = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  if (roundtrip.decode(encoder.encode(proposalId)) !== proposalId)
    throw Error('invalid correlation input')
  if (!material || typeof material.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(material.keyId))
    throw Error('invalid correlation key')
  const key = material.key, algorithm = key?.algorithm as HmacKeyAlgorithm | undefined
  if (!key || key.type !== 'secret' || key.extractable !== false ||
      key.usages.length !== 1 || key.usages[0] !== 'sign' ||
      algorithm?.name !== 'HMAC' || algorithm.hash.name !== 'SHA-256' || algorithm.length !== 256)
    throw Error('invalid correlation key')
  const message = encoder.encode(JSON.stringify(['margin-public-correlation', 1, site, proposalId]))
  if (message.byteLength > 32768) throw Error('correlation input bound')
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  if (signature.byteLength !== 32) throw Error('invalid correlation output')
  return Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')
}
