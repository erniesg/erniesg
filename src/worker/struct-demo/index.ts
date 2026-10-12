import { isD1Database, type D1Database } from '../margin/d1'
import { timeoutSignal } from '../margin/deadline'

export const MAX_BYTES = 10 * 1024 * 1024
export const MAX_EPUB_BYTES = 32 * 1024 * 1024
const SAMPLE_PATH = '/samples/attention-is-all-you-need'
const SAMPLE_URL = 'https://arxiv.org/pdf/1706.03762v7'
export const DAILY_LIMIT = 3
export const GLOBAL_DAILY_LIMIT = 20
const RETENTION_MS = 72 * 60 * 60 * 1000
const LEASE_MS = 120_000
const MAX_INFLIGHT = 2
const PREFIX = '/api/struct-demo'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PRIVATE_ID = /^[0-9a-f]{32}$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.epub$/

export type StructDemoEnv = {
  MARGIN_DB?: D1Database
  MARGIN_ENVIRONMENT?: string
  STRUCT_DEMO_ORIGIN?: string
  STRUCT_DEMO_TOKEN?: string
}
export type StructDemoDependencies = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => Date
}
type Config = {
  db: D1Database
  origin: string
  token: string
  environment: string
}
type Job = { backend_id: string | null }

function config(env: StructDemoEnv): Config | null {
  if (
    !isD1Database(env.MARGIN_DB) ||
    !env.STRUCT_DEMO_TOKEN?.trim() ||
    !['staging', 'production', 'development'].includes(
      env.MARGIN_ENVIRONMENT ?? '',
    )
  )
    return null
  try {
    const url = new URL(env.STRUCT_DEMO_ORIGIN ?? '')
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return null
    // Header values must not contain newlines, including from misconfigured secrets.
    if (/[\r\n]/.test(env.STRUCT_DEMO_TOKEN)) return null
    return {
      db: env.MARGIN_DB,
      origin: url.origin,
      token: env.STRUCT_DEMO_TOKEN,
      environment: env.MARGIN_ENVIRONMENT!,
    }
  } catch {
    return null
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  })
}
function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status)
}
function unavailable(): Response {
  return error(
    'unavailable',
    'The demo is temporarily unavailable. Please try again later.',
    503,
  )
}
function missing(): Response {
  return error('not_found', 'This conversion or file is unavailable.', 404)
}

/** Only Cloudflare's provider-populated connecting-IP is used, never forwarding headers. */
function network(ip: string): { client: string; quota: string } | null {
  if (ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) return null
  if (!ip.includes(':')) {
    const parts = ip.split('.')
    if (
      parts.length !== 4 ||
      parts.some(
        (part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255,
      )
    )
      return null
    const client = 'v4:' + parts.join('.')
    return { client, quota: client }
  }
  try {
    // WHATWG URL performs strict IPv6 parsing, including dotted mapped IPv4.
    const canonical = new URL(`https://[${ip}]/`).hostname.slice(1, -1)
    const halves = canonical.split('::')
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
    const words =
      halves.length === 2
        ? [
            ...left,
            ...Array(8 - left.length - right.length).fill('0'),
            ...right,
          ]
        : left
    if (words.length !== 8) return null
    const numbers = words.map((word) => Number.parseInt(word, 16))
    if (numbers.slice(0, 5).every((n) => n === 0) && numbers[5] === 65535) {
      const client = `v4:${numbers[6] >>> 8}.${numbers[6] & 255}.${numbers[7] >>> 8}.${numbers[7] & 255}`
      return { client, quota: client }
    }
    const wordsCanonical = numbers.map((n) => n.toString(16).padStart(4, '0'))
    return {
      client: 'v6:' + wordsCanonical.join(':'),
      quota: 'v6:' + wordsCanonical.slice(0, 4).join(':') + '/64',
    }
  } catch {
    return null
  }
}
async function owner(
  request: Request,
  cfg: Config,
): Promise<{ ownerHash: string; networkHash: string } | null> {
  const ip = request.headers.get('CF-Connecting-IP')
  const subnet = ip ? network(ip) : null
  if (!subnet) return null
  const hash = async (domain: string, value: string) => {
    const bytes = new TextEncoder().encode(
      `${domain}\0${cfg.environment}\0${cfg.token}\0${value}`,
    )
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
  }
  return {
    ownerHash: await hash('struct-demo-owner-v1', subnet.client),
    networkHash: await hash('struct-demo-quota-v1', subnet.quota),
  }
}

class BodyError extends Error {
  constructor(readonly status: number) {
    super('Invalid upload')
  }
}
function cancelBody(response: Request | Response): void {
  void response.body?.cancel().catch(() => {})
}
function validLength(response: Request | Response, max: number): boolean {
  const length = response.headers.get('Content-Length')
  return (
    length === null ||
    (/^\d+$/.test(length) &&
      Number.isSafeInteger(Number(length)) &&
      Number(length) <= max)
  )
}
/** A bounded proxy stream never forwards more than the output cap, even without length. */
function boundedDownload(
  response: Response,
): ReadableStream<Uint8Array> | null {
  if (!response.body || !validLength(response, MAX_EPUB_BYTES)) {
    cancelBody(response)
    return null
  }
  const reader = response.body.getReader()
  const declared = response.headers.get('Content-Length')
  const expected = declared === null ? null : Number(declared)
  let bytes = 0
  let timer: ReturnType<typeof setTimeout>
  let stopped = false
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        timer = setTimeout(() => {
          if (!stopped) {
            stop()
            controller.error(new Error('Download unavailable'))
          }
        }, 30_000)
      },
      async pull(controller) {
        try {
          const { value, done } = await reader.read()
          if (stopped) return
          if (done) {
            stopped = true
            clearTimeout(timer)
            if (expected !== null && bytes !== expected)
              controller.error(new Error('Download unavailable'))
            else controller.close()
            return
          }
          bytes += value.byteLength
          if (bytes > MAX_EPUB_BYTES || (expected !== null && bytes > expected))
            throw new Error('Download unavailable')
          controller.enqueue(value)
        } catch {
          if (!stopped) {
            stop()
            controller.error(new Error('Download unavailable'))
          }
        }
      },
      cancel() {
        stop()
      },
    },
    { highWaterMark: 0 },
  )
}

/** Bound bytes while streaming; tiny fragmented chunks cannot grow metadata. */
async function readBounded(
  response: Request | Response,
  max: number,
  pdf = false,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new BodyError(400)
  const buffer = new Uint8Array(max)
  let size = 0
  let complete = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const consume = async () => {
    const header: number[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > max) throw new BodyError(413)
      if (pdf && header.length < 5) {
        for (const byte of value) {
          if (header.length === 5) break
          header.push(byte)
        }
        if (header.length === 5 && String.fromCharCode(...header) !== '%PDF-')
          throw new BodyError(400)
      }
      buffer.set(value, size)
      size += value.byteLength
    }
    if (pdf && size < 5) throw new BodyError(400)
    complete = true
    return buffer.subarray(0, size)
  }
  try {
    return await Promise.race([
      consume(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BodyError(408)), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (!complete) void reader.cancel().catch(() => {})
  }
}
async function upstreamJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(await readBounded(response, 256 * 1024)),
  )
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid state')
  return parsed as Record<string, unknown>
}
function filename(request: Request): string {
  let decoded = 'document.pdf'
  try {
    decoded = decodeURIComponent(
      request.headers.get('X-Filename') ?? 'document.pdf',
    )
  } catch {
    /* Use the fixed default for malformed encodings. */
  }
  const supplied = decoded.split(/[\\/]/).pop() ?? ''
  const stem = supplied
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80)
  return `${stem || 'document'}.pdf`
}
function files(state: Record<string, unknown>): { name: string }[] {
  if (!Array.isArray(state.files)) return []
  const safe = state.files.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return []
    const name = (entry as Record<string, unknown>).name
    return typeof name === 'string' && FILE.test(name) && !name.includes('..')
      ? [{ name }]
      : []
  })
  return safe.slice(0, 2)
}
/** Explicit numeric/boolean allowlist; no source text, criteria titles, errors, or paths. */
function summary(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const input = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of [
    'pageCount',
    'textCoverage',
    'furnitureLeaks',
    'epubcheckErrors',
    'seconds',
  ]) {
    const item = input[key]
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0)
      result[key] = item
  }
  for (const key of ['figures', 'tables', 'links', 'notes']) {
    const item = input[key]
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      item.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    )
      result[key] = item
  }
  if (typeof input.epubcheckAvailable === 'boolean')
    result.epubcheckAvailable = input.epubcheckAvailable
  return Object.keys(result).length ? result : undefined
}
function providerFailure(status: number, submission = false): Response {
  if (status === 404) return missing()
  if (status === 409)
    return error(
      'not_finished',
      'Wait for this conversion to finish before deleting it.',
      409,
    )
  if (submission && status === 400)
    return error(
      'invalid_pdf',
      'This PDF could not be opened. Try another PDF.',
      400,
    )
  if (submission && status === 413)
    return error(
      'pdf_limit',
      'This PDF exceeds the conversion service limits.',
      413,
    )
  if (status === 429)
    return error('busy', 'The converter is busy. Please try again later.', 429)
  return unavailable()
}

export async function handleStructDemoRequest(
  request: Request,
  env: StructDemoEnv,
  deps: StructDemoDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/'))
    return null
  const path = url.pathname.slice(PREFIX.length)
  const jobMatch = /^\/jobs\/([^/]+)(?:\/files\/([^/]+))?$/.exec(path)
  const isSample = path === SAMPLE_PATH
  if (path !== '/limits' && path !== '/jobs' && !isSample && !jobMatch)
    return missing()
  if (
    (path === '/limits' && request.method !== 'GET') ||
    ((path === '/jobs' || isSample) && request.method !== 'POST') ||
    (jobMatch &&
      (jobMatch[2]
        ? request.method !== 'GET'
        : !['GET', 'DELETE'].includes(request.method)))
  ) {
    return error(
      'method_not_allowed',
      'This request method is unavailable.',
      405,
    )
  }
  const origin = request.headers.get('Origin')
  if (
    (origin && origin !== url.origin) ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site' ||
    (['POST', 'DELETE'].includes(request.method) && origin !== url.origin)
  )
    return error('forbidden', 'Use the demo on this website.', 403)
  const cfg = config(env)
  if (!cfg) return unavailable()
  try {
    const identity = await owner(request, cfg)
    if (!identity) return unavailable()
    const { ownerHash, networkHash } = identity
    const now = (deps.now?.() ?? new Date()).getTime()
    const day = new Date(now).toISOString().slice(0, 10)
    const resetsAt = new Date(
      Date.parse(day + 'T00:00:00Z') + 86400000,
    ).toISOString()
    const swept = await cfg.db
      .prepare('DELETE FROM struct_demo_jobs WHERE expires_at <= ?')
      .bind(now)
      .run()
    if (!swept.success) return unavailable()
    const call = (endpoint: string, init: RequestInit = {}) =>
      (deps.fetch ?? fetch)(cfg.origin + endpoint, {
        ...init,
        headers: { Authorization: `Bearer ${cfg.token}` },
        redirect: 'error',
        signal: timeoutSignal(30_000),
      })
    if (path === '/limits') {
      const counts = await cfg.db
        .prepare(
          'SELECT COUNT(*) AS global_count, COALESCE(SUM(CASE WHEN network_hash = ? THEN 1 ELSE 0 END), 0) AS owner_count FROM struct_demo_jobs WHERE quota_day = ?',
        )
        .bind(networkHash, day)
        .first<{ global_count: number; owner_count: number }>()
      if (!counts) return unavailable()
      const remaining = Math.max(0, DAILY_LIMIT - counts.owner_count)
      const globalRemaining = Math.max(
        0,
        GLOBAL_DAILY_LIMIT - counts.global_count,
      )
      return json({
        available: remaining > 0 && globalRemaining > 0,
        dailyLimit: DAILY_LIMIT,
        remaining,
        resetsAt,
        maxBytes: MAX_BYTES,
        globalRemaining,
      })
    }
    if (path === '/jobs' || isSample) {
      if (!isSample) {
        if (
          request.headers
            .get('Content-Type')
            ?.split(';')[0]
            .trim()
            .toLowerCase() !== 'application/pdf'
        ) {
          cancelBody(request)
          return error('pdf_required', 'Choose a PDF file.', 415)
        }
        if (!validLength(request, MAX_BYTES)) {
          cancelBody(request)
          return error('too_large', 'Choose a PDF no larger than 10 MiB.', 413)
        }
      }
      const publicId = crypto.randomUUID()
      // One statement atomically checks both quotas and the shared Worker memory budget.
      // Never decrement on provider errors or deletion: these are attempt limits.
      const reserved = await cfg.db
        .prepare(
          `INSERT INTO struct_demo_jobs (public_id, owner_hash, network_hash, quota_day, created_at, expires_at, lease_expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM struct_demo_jobs WHERE network_hash = ? AND quota_day = ?) < ?
          AND (SELECT COUNT(*) FROM struct_demo_jobs WHERE quota_day = ?) < ?
          AND (SELECT COUNT(*) FROM struct_demo_jobs WHERE lease_expires_at > ?) < ?`,
        )
        .bind(
          publicId,
          ownerHash,
          networkHash,
          day,
          now,
          now + RETENTION_MS,
          now + LEASE_MS,
          networkHash,
          day,
          DAILY_LIMIT,
          day,
          GLOBAL_DAILY_LIMIT,
          now,
          MAX_INFLIGHT,
        )
        .run()
      if (!reserved.success || reserved.meta?.changes === undefined)
        return unavailable()
      if (reserved.meta.changes !== 1) {
        cancelBody(request)
        const counts = await cfg.db
          .prepare(
            'SELECT COUNT(*) AS global_count, COALESCE(SUM(CASE WHEN network_hash = ? THEN 1 ELSE 0 END), 0) AS owner_count FROM struct_demo_jobs WHERE quota_day = ?',
          )
          .bind(networkHash, day)
          .first<{ global_count: number; owner_count: number }>()
        if (!counts) return unavailable()
        if (
          counts.owner_count < DAILY_LIMIT &&
          counts.global_count < GLOBAL_DAILY_LIMIT
        )
          return error(
            'busy',
            'The demo is busy. Please try again shortly.',
            429,
          )
        return error(
          'daily_limit',
          'The daily demo limit has been reached. Try again after the next UTC reset.',
          429,
        )
      }
      try {
        let bytes: Uint8Array
        if (isSample) {
          cancelBody(request)
          const source = await (deps.fetch ?? fetch)(SAMPLE_URL, {
            credentials: 'omit',
            redirect: 'error',
            signal: timeoutSignal(30_000),
          })
          if (source.status !== 200 || !validLength(source, MAX_BYTES)) {
            cancelBody(source)
            return unavailable()
          }
          try {
            bytes = await readBounded(source, MAX_BYTES, true)
          } catch {
            return unavailable()
          }
        } else {
          try {
            bytes = await readBounded(request, MAX_BYTES, true)
          } catch (cause) {
            if (cause instanceof BodyError)
              return error(
                cause.status === 413 ? 'too_large' : 'invalid_pdf',
                cause.status === 413
                  ? 'Choose a PDF no larger than 10 MiB.'
                  : 'The PDF upload could not be read.',
                cause.status,
              )
            return error(
              'invalid_pdf',
              'The PDF upload could not be read.',
              400,
            )
          }
        }
        const form = new FormData()
        form.set(
          'file',
          new Blob([bytes as Uint8Array<ArrayBuffer>], {
            type: 'application/pdf',
          }),
          isSample ? 'attention-is-all-you-need.pdf' : filename(request),
        )
        form.set('profiles', 'paperPro,paperProMove')
        const upstream = await call('/api/jobs', { method: 'POST', body: form })
        if (upstream.status !== 202)
          return providerFailure(upstream.status, true)
        const submitted = await upstreamJson(upstream)
        if (typeof submitted.id !== 'string' || !PRIVATE_ID.test(submitted.id))
          return unavailable()
        const mapped = await cfg.db
          .prepare(
            'UPDATE struct_demo_jobs SET backend_id = ? WHERE public_id = ? AND owner_hash = ?',
          )
          .bind(submitted.id, publicId, ownerHash)
          .run()
        if (!mapped.success || mapped.meta?.changes !== 1) return unavailable()
        return json({ id: publicId, status: 'queued' }, 202)
      } finally {
        // A crashed invocation recovers by expiry. Release failures retain the lease
        // conservatively rather than widening concurrency or refunding an attempt.
        try {
          await cfg.db
            .prepare(
              'UPDATE struct_demo_jobs SET lease_expires_at = 0 WHERE public_id = ? AND owner_hash = ?',
            )
            .bind(publicId, ownerHash)
            .run()
        } catch {
          /* Expiry is the fallback. */
        }
      }
    }
    if (!jobMatch || !UUID.test(jobMatch[1])) return missing()
    const publicId = jobMatch[1]
    const job = await cfg.db
      .prepare(
        'SELECT backend_id FROM struct_demo_jobs WHERE public_id = ? AND owner_hash = ? AND expires_at > ? AND deleted = 0',
      )
      .bind(publicId, ownerHash, now)
      .first<Job>()
    if (!job?.backend_id || !PRIVATE_ID.test(job.backend_id)) return missing()
    const endpoint = `/api/jobs/${job.backend_id}`
    if (request.method === 'DELETE') {
      const upstream = await call(endpoint, { method: 'DELETE' })
      if (!upstream.ok && upstream.status !== 404)
        return providerFailure(upstream.status)
      const deleted = await cfg.db
        .prepare(
          'UPDATE struct_demo_jobs SET deleted = 1, backend_id = NULL WHERE public_id = ? AND owner_hash = ?',
        )
        .bind(publicId, ownerHash)
        .run()
      if (!deleted.success || deleted.meta?.changes !== 1) return unavailable()
      return json({ deleted: publicId })
    }
    const upstream = await call(endpoint)
    if (!upstream.ok) return providerFailure(upstream.status)
    const state = await upstreamJson(upstream)
    if (
      typeof state.status !== 'string' ||
      !['queued', 'running', 'done', 'failed'].includes(state.status)
    )
      return unavailable()
    const allowed = state.status === 'done' ? files(state) : []
    if (jobMatch[2]) {
      let name: string
      try {
        name = decodeURIComponent(jobMatch[2])
      } catch {
        return missing()
      }
      if (!FILE.test(name) || !allowed.some((file) => file.name === name))
        return missing()
      const download = await call(
        `${endpoint}/file/${encodeURIComponent(name)}`,
      )
      if (!download.ok) return providerFailure(download.status)
      if (
        download.headers
          .get('Content-Type')
          ?.split(';')[0]
          .trim()
          .toLowerCase() !== 'application/epub+zip'
      ) {
        void download.body?.cancel()
        return unavailable()
      }
      const stream = boundedDownload(download)
      if (!stream) return unavailable()
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/epub+zip',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      })
    }
    return json({
      id: publicId,
      status: state.status,
      files: allowed,
      ...(state.status === 'failed'
        ? { message: 'This PDF could not be converted. Try another PDF.' }
        : {}),
      ...(state.status === 'done' && summary(state.summary)
        ? { summary: summary(state.summary) }
        : {}),
    })
  } catch {
    return unavailable()
  }
}
