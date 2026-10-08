/** Offline-injectable reader for immutable approved work. No default transport or writes. */
import { z } from 'zod'
import {
  ADAPTER_WORK_PATH,
  ADAPTER_PAGE_BYTES,
  ADAPTER_PAGE_SIZE,
  adapterSiteSchema,
} from '../../src/worker/margin/adapter'
import {
  adapterSelectorSchema,
  canonicalSegment,
  reportInteger,
  reportId,
  reportCommit,
  reportDetail,
  reportURL,
  validReportTuple,
} from '../../src/worker/margin/repository'
import {
  splitSource,
  joinSource,
  isRepoRelativePath,
  maxBodyLength,
} from '../../src/worker/margin/web-annotation'
import { isFullCommitId, parseHunks } from '../../src/annotations/criticmarkup'

const DEADLINE_MS = 10_000
const cursor = z
  .string()
  .min(1)
  .max(32_768)
  .regex(/^[A-Za-z0-9_-]+$/)
const date = z.string().datetime({ offset: true }).max(40)
const optionsSchema = z
  .object({
    limit: z.number().int().min(1).max(ADAPTER_PAGE_SIZE).optional(),
    cursor: cursor.nullable().optional(),
  })
  .strict()
const configSchema = z
  .object({
    origin: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const u = new URL(value)
          return (
            u.protocol === 'https:' &&
            u.origin === value &&
            !u.username &&
            !u.password
          )
        } catch {
          return false
        }
      }),
    token: z
      .string()
      .max(100)
      .refine((value) => {
        const parts = value.split('.')
        return (
          parts.length === 3 &&
          parts[0] === 'margin-adapter-v1' &&
          canonicalSegment(parts[1], 16) &&
          canonicalSegment(parts[2], 32)
        )
      }),
  })
  .strict()
const executionSchema = z
  .object({
    state: z.enum(['approved', 'pr_open', 'conflict', 'apply_failed']),
    stateVersion: reportInteger,
    failedApplyCount: reportInteger.max(3),
    pr: z
      .object({
        number: reportInteger.positive(),
        url: reportURL,
        head: reportCommit,
      })
      .strict()
      .nullable(),
    checks: z.enum(['pending', 'passed', 'failed', 'not_evaluated']).nullable(),
    detail: reportDetail.nullable(),
    mergeCommit: reportCommit.nullable(),
    lastEvent: adapterSelectorSchema.nullable(),
    updatedAt: date,
  })
  .strict()
const itemSchema = z
  .object({
    proposalId: reportId,
    site: adapterSiteSchema,
    document: z.string().min(1).max(2048),
    source: z.string().max(4096),
    approvedRevision: reportInteger.positive(),
    body: z.string().min(1).max(maxBodyLength('editing')),
    baseCommit: z.string().refine(isFullCommitId),
    sourcePath: z.string().min(1).max(512).refine(isRepoRelativePath),
    visibility: z.enum(['public', 'private']),
    approvedAt: date,
    execution: executionSchema,
    work: z.enum(['apply', 'refresh_pr', 'reconcile_only']),
  })
  .strict()
const count = reportInteger.max(ADAPTER_PAGE_SIZE)
const pageSchema = z
  .object({
    eligibility: z.literal('known_execution'),
    items: z.array(itemSchema).max(ADAPTER_PAGE_SIZE),
    nextCursor: cursor.nullable(),
    scanned: count,
    notEvaluated: z.object({ unknownExecution: count }).strict(),
    excluded: z
      .object({ exhaustedFailures: count, otherAdapter: count })
      .strict(),
  })
  .strict()
export type ApprovedWorkPage = z.infer<typeof pageSchema>
export type WorkReadResult =
  | { status: 'ready'; page: ApprovedWorkPage }
  | {
      status: 'refused' | 'not_evaluated'
      reason:
        | 'config'
        | 'options'
        | 'closed'
        | 'busy'
        | 'timeout'
        | 'aborted'
        | 'service_refused'
        | 'service_unavailable'
        | 'transport'
        | 'response'
        | 'body'
    }
export type WorkTransport = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>
const encoder = new TextEncoder()
function binaryCompare(a: string, b: string): number {
  const left = encoder.encode(a),
    right = encoder.encode(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] - right[i]
  return left.length - right.length
}
/** Syntax/resource preflight only. JSON.parse and raw canonical equality remain authoritative. */
function checkNesting(text: string) {
  let depth = 0,
    quoted = false,
    escaped = false
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{' || char === '[') {
      if (++depth > 16) throw Error('nesting')
    } else if (char === '}' || char === ']') depth--
  }
}
function decodePage(
  bytes: Uint8Array,
  limit: number,
  check: () => void,
): ApprovedWorkPage {
  check()
  // ignoreBOM=true retains U+FEFF, so canonical equality rejects it.
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes)
  checkNesting(text)
  const raw: unknown = JSON.parse(text)
  if (JSON.stringify(raw) + '\n' !== text) throw Error('canonical JSON')
  check()
  const page = pageSchema.parse(raw)
  if (
    page.scanned > limit ||
    page.items.length +
      page.notEvaluated.unknownExecution +
      page.excluded.exhaustedFailures +
      page.excluded.otherAdapter !==
      page.scanned ||
    (page.nextCursor !== null && page.scanned !== limit)
  )
    throw Error('page counters')
  const ids = new Set<string>()
  let previous: ApprovedWorkPage['items'][number] | undefined
  for (const item of page.items) {
    check()
    const scope = splitSource(item.source)
    if (
      !scope ||
      scope.site !== item.site ||
      scope.document !== item.document ||
      joinSource(item.site, item.document) !== item.source ||
      (previous && item.site !== previous.site)
    )
      throw Error('source binding')
    if (
      ids.has(item.proposalId) ||
      (previous &&
        (binaryCompare(previous.approvedAt, item.approvedAt) > 0 ||
          (previous.approvedAt === item.approvedAt &&
            binaryCompare(previous.proposalId, item.proposalId) >= 0)))
    )
      throw Error('order')
    ids.add(item.proposalId)
    previous = item
    parseHunks(item.body)
    const e = item.execution
    validReportTuple(
      {
        state_version: e.stateVersion,
        failed_apply_count: e.failedApplyCount,
        pr_number: e.pr?.number ?? null,
        pr_url: e.pr?.url ?? null,
        pr_head: e.pr?.head ?? null,
        checks: e.checks,
        detail: e.detail,
        merge_commit: e.mergeCommit,
      },
      e.state,
    )
    if (
      e.stateVersion === 0
        ? e.failedApplyCount !== 0 ||
          e.lastEvent !== null ||
          e.updatedAt !== item.approvedAt
        : e.lastEvent === null
    )
      throw Error('execution stamp')
    if (e.state === 'apply_failed' && e.failedApplyCount === 3)
      throw Error('excluded failure')
    if (
      item.work !==
      (e.pr !== null
        ? 'refresh_pr'
        : e.failedApplyCount === 3
          ? 'reconcile_only'
          : 'apply')
    )
      throw Error('work classification')
  }
  check()
  return page
}

type Operation = {
  controller: AbortController
  retire: (reason: 'timeout' | 'aborted') => void
}
/** Config and transport are trusted host inputs, not proof of live service authority. */
export function createApprovedWorkClient(
  config: { origin: string; token: string },
  transport: WorkTransport,
) {
  const parsed = configSchema.safeParse(config)
  let disposed = false,
    active: Operation | undefined
  return {
    readPage(
      options: { limit?: number; cursor?: string | null } = {},
    ): Promise<WorkReadResult> {
      if (disposed)
        return Promise.resolve({ status: 'refused', reason: 'closed' })
      if (!parsed.success || typeof transport !== 'function')
        return Promise.resolve({ status: 'refused', reason: 'config' })
      const query = optionsSchema.safeParse(options)
      if (!query.success)
        return Promise.resolve({ status: 'refused', reason: 'options' })
      if (active)
        return Promise.resolve({ status: 'not_evaluated', reason: 'busy' })
      const limit = query.data.limit ?? 25,
        url = new URL(parsed.data.origin + ADAPTER_WORK_PATH)
      url.searchParams.set('limit', String(limit))
      if (query.data.cursor != null)
        url.searchParams.set('cursor', query.data.cursor)
      const deadline = performance.now() + DEADLINE_MS
      let settle!: (result: WorkReadResult) => void
      const result = new Promise<WorkReadResult>((resolve) => {
        settle = resolve
      })
      let retired = false,
        settled = false,
        response: Response | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        ended = false
      let cancellation: Promise<boolean> | undefined
      const cancel = (): Promise<boolean> => {
        if (cancellation) return cancellation
        if (ended || (!reader && !response?.body)) return Promise.resolve(true)
        // Rejection is not a cancellation acknowledgement. Preserve occupancy.
        cancellation = Promise.resolve()
          .then(() => (reader ? reader.cancel() : response!.body!.cancel()))
          .then(
            () => true,
            () => false,
          )
        return cancellation
      }
      const finish = (value: WorkReadResult) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          settle(value)
        }
      }
      const op: Operation = {
        controller: new AbortController(),
        retire(reason) {
          retired = true
          op.controller.abort()
          if (reader || response) void cancel()
          finish({ status: 'not_evaluated', reason })
        },
      }
      active = op
      const timer = setTimeout(() => op.retire('timeout'), DEADLINE_MS)
      const check = () => {
        if (performance.now() >= deadline && !retired) op.retire('timeout')
        if (retired || disposed) throw Error('retired')
      }
      void (async () => {
        let phase: 'transport' | 'response' | 'body' = 'transport'
        try {
          check()
          response = await transport(url.href, {
            method: 'GET',
            headers: {
              authorization: 'Bearer ' + parsed.data.token,
              accept: 'application/json',
            },
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: op.controller.signal,
          })
          check()
          phase = 'response'
          if (
            response.redirected ||
            (response.url && response.url !== url.href)
          )
            throw Error('redirect')
          if (response.status !== 200) {
            finish({
              status: [400, 401, 403, 404, 405].includes(response.status)
                ? 'refused'
                : 'not_evaluated',
              reason: [400, 401, 403, 404, 405].includes(response.status)
                ? 'service_refused'
                : 'service_unavailable',
            })
            return
          }
          if (
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get('content-type') ?? '',
            ) ||
            !response.body
          )
            throw Error('response')
          const length = response.headers.get('content-length')
          if (
            length !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(length) ||
              Number(length) > ADAPTER_PAGE_BYTES)
          )
            throw Error('length')
          phase = 'body'
          reader = response.body.getReader()
          let size = 0
          const bytes = new Uint8Array(ADAPTER_PAGE_BYTES)
          while (true) {
            check()
            let chunk: ReadableStreamReadResult<Uint8Array>
            try {
              chunk = await reader.read()
            } catch {
              // An owned reader rejection is terminal stream failure, not
              // an unacknowledged cancellation. The partial page stays refused.
              ended = true
              throw Error('reader failed')
            }
            check()
            if (chunk.done) {
              ended = true
              break
            }
            if (
              !(chunk.value instanceof Uint8Array) ||
              chunk.value.byteLength > ADAPTER_PAGE_BYTES - size
            )
              throw Error('bytes')
            bytes.set(chunk.value, size)
            size += chunk.value.byteLength
          }
          const page = decodePage(bytes.subarray(0, size), limit, check)
          check()
          finish({ status: 'ready', page })
        } catch {
          if (!retired && !disposed) {
            checkDeadline()
            finish({ status: 'not_evaluated', reason: phase })
          }
        } finally {
          const acknowledged = cancellation
            ? await cancellation
            : ended || !response?.body
              ? true
              : await cancel()
          if (acknowledged) {
            reader?.releaseLock()
            if (active === op) active = undefined
          }
        }
      })().catch(() => {
        // No exception or private response escapes. Uncertain cleanup retains the slot.
        finish({ status: 'not_evaluated', reason: 'transport' })
      })
      function checkDeadline() {
        if (performance.now() >= deadline) op.retire('timeout')
      }
      return result
    },
    dispose() {
      disposed = true
      active?.retire('aborted')
    },
  }
}
