import {
  HISTORY_ASSET_BYTES,
  parseMarginHistoryAsset,
  type MarginHistoryAsset,
  type MarginHistoryResponse,
} from '../../lib/margin-history-data'
import type { AssetFetcher } from '../env'
import { splitSource } from './web-annotation'

export type HistoryRegistration = {
  site: string
  adapter: string
  enabled: 0 | 1
  createdAt: string
  historyLocation: string | null
}
export interface HistoryRegistrationRepository {
  historyRegistration(site: string): Promise<HistoryRegistration | null>
}
export type HistoryContext = {
  repository: HistoryRegistrationRepository
  /** Trusted deployment binding, never inferred from a request or registration. */
  site?: string
  assets?: AssetFetcher
}
const encoder = new TextEncoder()
const DEADLINE_MS = 5000
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) + '\n', {
    status,
    headers: JSON_HEADERS,
  })
}
function problem(status: number, code: string): Response {
  return response(
    { error: { code, message: code.replaceAll('_', ' ') } },
    status,
  )
}
function siteOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const scope = splitSource(value)
  return scope?.site === value && scope.document === '/'
}
function pathSafe(path: string): boolean {
  if (
    /[\\\x00-\x20\x7f?#]/.test(path) ||
    /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)
  )
    return false
  try {
    return !/[\x00-\x1f\x7f\\]/.test(decodeURIComponent(path))
  } catch {
    return false
  }
}
function locator(template: string, site: string, pathname: string): string {
  if (
    encoder.encode(template).length > 1024 ||
    !template.startsWith(site) ||
    template.split('{documentPath}').length !== 2 ||
    /[{}]/.test(template.replace('{documentPath}', ''))
  )
    throw Error('invalid locator')
  // Test both the static spelling and final expansion; URL normalization must
  // not hide dot segments, a different authority or delimiter ambiguity.
  for (const path of ['/__history_document__/', pathname]) {
    const expanded = template.replace('{documentPath}', path)
    const url = new URL(expanded)
    if (
      url.origin !== site ||
      url.href !== expanded ||
      url.username ||
      url.password ||
      !pathSafe(url.pathname) ||
      url.search ||
      url.hash ||
      /[?#]/.test(expanded)
    )
      throw Error('invalid locator')
  }
  const value = template.replace('{documentPath}', pathname)
  if (encoder.encode(value).length > 4096) throw Error('invalid locator')
  return value
}

class MissingHistoryAsset extends Error {}
/** Best-effort cancellation does not hold the logical deadline open. */
function cancel(
  body:
    ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null,
): void {
  if (body) void body.cancel().catch(() => {})
}
async function readAsset(
  assets: AssetFetcher,
  location: string,
  site: string,
  document: string,
): Promise<MarginHistoryAsset> {
  const controller = new AbortController()
  const until = performance.now() + DEADLINE_MS
  let expired = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      controller.abort()
      if (reader) cancel(reader)
      reject(Error('history deadline'))
    }, DEADLINE_MS)
  })
  const operation = (async () => {
    // This is exclusively the co-deployed binding, never global fetch. A late
    // response remains ours to cancel even if the binding ignored abort.
    const result = await assets.fetch(
      new Request(location, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      }),
    )
    if (expired || performance.now() >= until) {
      cancel(result.body)
      throw Error('late history response')
    }
    if (
      result.status !== 200 ||
      result.redirected ||
      !/^application\/json(?:\s*;|$)/i.test(
        result.headers.get('content-type') ?? '',
      )
    ) {
      cancel(result.body)
      if (result.status === 404 && !result.redirected)
        throw new MissingHistoryAsset()
      throw Error('history response unavailable')
    }
    const length = result.headers.get('content-length')
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > HISTORY_ASSET_BYTES)
    ) {
      cancel(result.body)
      throw Error('history size bound')
    }
    if (!result.body) throw Error('missing history body')
    reader = result.body.getReader()
    // A fixed byte buffer also bounds memory for adversarial tiny/empty chunks.
    const bytes = new Uint8Array(HISTORY_ASSET_BYTES)
    let total = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (expired || performance.now() >= until)
          throw Error('late history body')
        if (next.done) break
        if (
          !(next.value instanceof Uint8Array) ||
          total + next.value.byteLength > HISTORY_ASSET_BYTES
        )
          throw Error('history size bound')
        bytes.set(next.value, total)
        total += next.value.byteLength
      }
      const asset = parseMarginHistoryAsset(
        bytes.subarray(0, total),
        site,
        document,
      )
      if (performance.now() >= until) throw Error('history decode deadline')
      return asset
    } catch (error) {
      cancel(reader)
      throw error
    } finally {
      reader.releaseLock()
      reader = undefined
    }
  })()
  try {
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export async function readHistory(
  document: string,
  url: URL,
  context?: HistoryContext,
): Promise<Response> {
  const scope = splitSource(document)
  if (
    !scope ||
    /[\\\x00-\x20\x7f?#]/.test(document) ||
    !pathSafe(new URL(document).pathname) ||
    url.search
  )
    return problem(400, 'invalid_history_document')
  const fullDocument = scope.site + scope.document
  if (!context || typeof context.repository?.historyRegistration !== 'function')
    return problem(503, 'history_registration_unavailable')
  if (context.site !== undefined && !siteOrigin(context.site))
    return problem(503, 'history_configuration_unavailable')
  let registration: HistoryRegistration | null
  let location: string
  try {
    registration = await context.repository.historyRegistration(scope.site)
    if (registration === null) return problem(404, 'history_unavailable')
    if (
      registration.site !== scope.site ||
      !siteOrigin(registration.site) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(registration.adapter) ||
      (registration.enabled !== 0 && registration.enabled !== 1) ||
      typeof registration.createdAt !== 'string' ||
      !registration.createdAt ||
      (registration.historyLocation !== null &&
        typeof registration.historyLocation !== 'string')
    )
      throw Error('invalid registration')
    if (registration.enabled === 0 || registration.historyLocation === null)
      return problem(404, 'history_unavailable')
    location = locator(
      registration.historyLocation,
      scope.site,
      new URL(fullDocument).pathname,
    )
  } catch {
    return problem(503, 'history_registration_unavailable')
  }
  const base = {
    schemaVersion: 1 as const,
    site: scope.site,
    document: fullDocument,
    historyLocation: location,
  }
  if (context.site !== scope.site)
    return response({
      ...base,
      kind: 'locator',
    } satisfies MarginHistoryResponse)
  if (!context.assets || typeof context.assets.fetch !== 'function')
    return problem(503, 'history_asset_unavailable')
  try {
    const history = await readAsset(
      context.assets,
      location,
      scope.site,
      fullDocument,
    )
    return response({
      ...base,
      kind: 'asset',
      history,
    } satisfies MarginHistoryResponse)
  } catch (error) {
    return error instanceof MissingHistoryAsset
      ? problem(404, 'history_unavailable')
      : problem(503, 'history_asset_unavailable')
  }
}
