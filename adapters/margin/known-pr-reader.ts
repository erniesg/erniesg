/** Explicit, read-only known-PR observation. No default transport, credentials or retries. */
import { z } from 'zod'
import { reportCommit, reportInteger } from '../../src/worker/margin/repository'
import type { WorkTransport } from './service-client'

const MAX_BYTES = 1024 * 1024
const DEADLINE_MS = 10_000
const repository = 'erniesg/erniesg' as const
const configSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict()
const inputSchema = z
  .object({
    number: reportInteger.positive(),
    checks: z.literal('configured').optional(),
  })
  .strict()
// GitHub's envelope is open; only this required projection is retained.
const wireSchema = z.object({
  url: z.string().max(2048),
  html_url: z.string().max(2048),
  number: reportInteger.positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merge_commit_sha: reportCommit.nullable(),
  head: z.object({ sha: reportCommit }),
  base: z.object({ repo: z.object({ full_name: z.literal(repository) }) }),
})
export type KnownPRObservation = {
  status: 'observed'
  repository: typeof repository
  number: number
  url: string
  head: string
  state: 'open' | 'closed'
  merged: boolean
  mergeCommit: string | null
  checks?: ConfiguredChecks
}
type Reason =
  | 'config'
  | 'input'
  | 'closed'
  | 'busy'
  | 'timeout'
  | 'aborted'
  | 'transport'
  | 'response'
  | 'body'
  | 'provider_refused'
  | 'not_found_or_hidden'
  | 'response_status'
export type KnownPRReadResult =
  | { status: 'ready'; observation: KnownPRObservation }
  | { status: 'refused' | 'not_evaluated'; reason: Reason; httpStatus?: number }
const fail = (
  reason: Reason,
  status: 'refused' | 'not_evaluated' = 'not_evaluated',
): KnownPRReadResult => ({ status, reason })

/** Duplicate/depth preflight only; JSON.parse remains the syntax authority.
 * Unlike Margin's wire protocol, GitHub does not require canonical JSON bytes. */
function preflight(text: string, check: () => void) {
  const stack: (Set<string> | null)[] = []
  for (let i = 0; i < text.length; i++) {
    if (i % 1024 === 0) check()
    const c = text[i]
    if (c === '"') {
      const start = i++
      for (; i < text.length && text[i] !== '"'; i++) {
        if (i % 1024 === 0) check()
        if (text[i] === '\\') i++
      }
      if (i >= text.length) throw Error('string')
      let next = i + 1
      while (/^[\t\r\n ]$/.test(text[next] ?? '')) {
        if (next % 1024 === 0) check()
        next++
      }
      const keys = stack.at(-1)
      if (keys && text[next] === ':') {
        const key: string = JSON.parse(text.slice(start, i + 1))
        if (keys.has(key)) throw Error('duplicate')
        keys.add(key)
      }
    } else if (c === '{' || c === '[') {
      stack.push(c === '{' ? new Set() : null)
      if (stack.length > 16) throw Error('depth')
    } else if (c === '}' || c === ']') stack.pop()
  }
  check()
}
function decode(
  bytes: Uint8Array,
  number: number,
  api: string,
  check: () => void,
): KnownPRReadResult {
  check()
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes)
  preflight(text, check)
  const raw: unknown = JSON.parse(text)
  check()
  const w = wireSchema.parse(raw)
  const url = `https://github.com/${repository}/pull/${number}`
  if (
    w.url !== api ||
    w.html_url !== url ||
    w.number !== number ||
    (w.merged && (w.state !== 'closed' || w.merge_commit_sha === null))
  )
    throw Error('binding')
  check()
  return {
    status: 'ready',
    observation: {
      status: 'observed',
      repository,
      number,
      url,
      head: w.head.sha,
      state: w.state,
      merged: w.merged,
      // An unmerged PR can have a test-merge SHA. It is not a merge outcome.
      mergeCommit: w.merged ? w.merge_commit_sha : null,
    },
  }
}

// Informational snapshot of the reviewed repository configuration, not live merge
// policy. Updating this finite profile requires a reviewed source/config change.
// policy 78e0d44046351082265519a7fbc87b3bf978ea3953692300780c5870637fb0fe
// ci cf48d167a4d831c36929e446012a57f6807f68df0340d88400915073bbef51fb
// evidence 58ff392bd83d357272da7b8cc0ecd92974dbe87f115d4e85e0003b0257b1e3ad
export const CONFIGURED_CHECK_PROFILE =
  'a18da97e6446100605fc3b3accb53ffed12f1597d5a5433577aead8086a01859'
const profile = [
  { path: '.github/workflows/ci.yml', jobs: ['checks', 'secret-scan'] },
  { path: '.github/workflows/agent-evidence.yml', jobs: ['evidence'] },
] as const
const checkReason = z.enum([
  'complete',
  'failed',
  'pending',
  'provider_refused',
  'not_found_or_hidden',
  'response_status',
  'transport',
  'response',
  'body',
  'timeout',
  'aborted',
  'bounds',
  'incomplete',
  'producer',
  'conclusion',
  'run_changed',
  'head_changed',
  'final_pr_unavailable',
])
type CheckReason = z.infer<typeof checkReason>
export const configuredChecksSchema = z
  .object({
    profile: z.literal(CONFIGURED_CHECK_PROFILE),
    head: reportCommit,
    state: z.enum(['pending', 'passed', 'failed', 'not_evaluated']),
    reason: checkReason,
  })
  .strict()
  .refine(
    (v) =>
      v.state ===
      (v.reason === 'complete'
        ? 'passed'
        : v.reason === 'failed'
          ? 'failed'
          : v.reason === 'pending'
            ? 'pending'
            : 'not_evaluated'),
  )
export type ConfiguredChecks = z.infer<typeof configuredChecksSchema>
const fact = (head: string, reason: CheckReason): ConfiguredChecks => ({
  profile: CONFIGURED_CHECK_PROFILE,
  head,
  reason,
  state:
    reason === 'complete'
      ? 'passed'
      : reason === 'failed'
        ? 'failed'
        : reason === 'pending'
          ? 'pending'
          : 'not_evaluated',
})
class ReadError extends Error {
  constructor(
    readonly reason: CheckReason,
    readonly httpStatus?: number,
  ) {
    super(reason)
  }
}
const runSchema = z
  .object({
    id: reportInteger.positive(),
    run_number: reportInteger.positive(),
    run_attempt: reportInteger.positive(),
    path: z.string().min(1).max(1024),
    event: z.string().min(1).max(128),
    repository: z.object({ full_name: z.literal(repository) }),
    head_sha: reportCommit,
    html_url: z.string().max(2048),
    status: z.string().min(1).max(64),
    conclusion: z.string().min(1).max(64).nullable(),
  })
  .refine((r) =>
    r.status === 'completed'
      ? [
          'success',
          'failure',
          'timed_out',
          'cancelled',
          'action_required',
          'neutral',
          'skipped',
          'startup_failure',
          'stale',
        ].includes(r.conclusion ?? '')
      : ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(
          r.status,
        ) && r.conclusion === null,
  )
type Run = z.infer<typeof runSchema>
const jobSchema = z.object({
  id: reportInteger.positive(),
  run_id: reportInteger.positive(),
  head_sha: reportCommit,
  name: z.string().min(1).max(256),
  html_url: z.string().max(2048),
  status: z.string().min(1).max(64),
  conclusion: z.string().min(1).max(64).nullable(),
  runner_id: reportInteger.nullable().optional(),
  steps: z
    .array(
      z.object({
        number: reportInteger.positive(),
        name: z.string().max(1024),
        status: z.string().max(64),
        conclusion: z.string().max(64).nullable(),
      }),
    )
    .max(128)
    .optional(),
})
function jsonBody(bytes: Uint8Array, check: () => void): unknown {
  check()
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes)
  preflight(text, check)
  const value: unknown = JSON.parse(text)
  check()
  return value
}
function uniqueRows<T extends { id: number }>(total: number, rows: T[]): T[] {
  if (
    total !== rows.length ||
    new Set(rows.map((x) => x.id)).size !== rows.length
  )
    throw new ReadError('incomplete')
  return rows
}
function selectRuns(bytes: Uint8Array, head: string, check: () => void): Run[] {
  const page = z
    .object({
      total_count: reportInteger.max(100),
      workflow_runs: z.array(runSchema).max(100),
    })
    .parse(jsonBody(bytes, check))
  const rows = uniqueRows(page.total_count, page.workflow_runs)
  // A filtered query cannot silently contribute a different repository/head/event.
  for (const r of rows)
    if (
      r.head_sha !== head ||
      r.event !== 'pull_request' ||
      r.html_url !== `https://github.com/${repository}/actions/runs/${r.id}`
    )
      throw new ReadError('producer')
  return profile.map((p) => {
    const candidates = rows
      .filter((r) => r.path === p.path)
      .sort(
        (a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt,
      )
    const first = candidates[0]
    if (!first) throw new ReadError('incomplete')
    if (candidates.some((r, i) => i > 0 && r.run_number === first.run_number))
      throw new ReadError('producer')
    check()
    return first
  })
}
function jobStates(
  bytes: Uint8Array,
  run: Run,
  index: number,
  check: () => void,
): CheckReason[] {
  const page = z
    .object({
      total_count: reportInteger.max(100),
      jobs: z.array(jobSchema).max(100),
    })
    .parse(jsonBody(bytes, check))
  const rows = uniqueRows(page.total_count, page.jobs)
  for (const j of rows)
    if (
      j.run_id !== run.id ||
      j.head_sha !== run.head_sha ||
      j.html_url !==
        `https://github.com/${repository}/actions/runs/${run.id}/job/${j.id}`
    )
      throw new ReadError('producer')
  return profile[index].jobs.map((name) => {
    const matches = rows.filter((j) => j.name === name)
    if (matches.length !== 1) throw new ReadError('incomplete')
    const j = matches[0]
    check()
    if (j.status !== 'completed')
      return [
        'queued',
        'in_progress',
        'waiting',
        'pending',
        'requested',
      ].includes(j.status) && j.conclusion === null
        ? 'pending'
        : 'conclusion'
    // Success needs an execution witness; a bound completed failure does not.
    // This is informational association, not a trusted-base execution claim.
    if (j.conclusion === 'success')
      return j.runner_id && j.steps?.length ? 'complete' : 'producer'
    return ['failure', 'timed_out', 'cancelled', 'action_required'].includes(
      j.conclusion ?? '',
    )
      ? 'failed'
      : 'conclusion'
  })
}
function aggregate(states: CheckReason[]): CheckReason {
  return (
    states.find((s) => !['complete', 'failed', 'pending'].includes(s)) ??
    (states.includes('failed')
      ? 'failed'
      : states.includes('pending')
        ? 'pending'
        : 'complete')
  )
}
function sameRuns(a: Run[], b: Run[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) =>
      [
        'id',
        'run_number',
        'run_attempt',
        'path',
        'head_sha',
        'status',
        'conclusion',
      ].every((k) => r[k as keyof Run] === b[i][k as keyof Run]),
    )
  )
}

type Operation = { retire(reason: 'timeout' | 'aborted'): void }
export function createKnownPRReader(config: unknown, transport: WorkTransport) {
  let token: string | undefined
  try {
    token = configSchema.parse(config).token
  } catch {
    /* unavailable config */
  }
  let disposed = false,
    active: Operation | undefined
  return {
    readPR(input: unknown): Promise<KnownPRReadResult> {
      const deadline = performance.now() + DEADLINE_MS
      if (disposed) return Promise.resolve(fail('closed', 'refused'))
      if (!token || typeof transport !== 'function')
        return Promise.resolve(fail('config', 'refused'))
      if (active) return Promise.resolve(fail('busy'))
      let selected: z.infer<typeof inputSchema>
      try {
        selected = inputSchema.parse(input)
      } catch {
        return Promise.resolve(
          performance.now() >= deadline
            ? fail('timeout')
            : fail('input', 'refused'),
        )
      }
      if (performance.now() >= deadline) return Promise.resolve(fail('timeout'))
      if (disposed) return Promise.resolve(fail('closed', 'refused'))
      if (active) return Promise.resolve(fail('busy'))
      const number = selected.number,
        configured = selected.checks === 'configured'
      const api = `https://api.github.com/repos/${repository}/pulls/${number}`
      let settle!: (value: KnownPRReadResult) => void
      const result = new Promise<KnownPRReadResult>((resolve) => {
        settle = resolve
      })
      let retired = false,
        settled = false,
        ended = false,
        cleanupSafe = true
      let response: Response | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cancellation: Promise<boolean> | undefined
      let observed: KnownPRObservation | undefined
      let requests = 0,
        totalBytes = 0
      const controller = new AbortController()
      const cancel = (): Promise<boolean> => {
        if (cancellation) return cancellation
        if (ended || (!reader && !response?.body)) return Promise.resolve(true)
        cancellation = Promise.resolve()
          .then(() => (reader ? reader.cancel() : response!.body!.cancel()))
          .then(
            () => true,
            () => false,
          )
        return cancellation
      }
      const finish = (value: KnownPRReadResult) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          settle(value)
        }
      }
      const partial = (reason: CheckReason): KnownPRReadResult => {
        if (configured && observed && !disposed)
          return {
            status: 'ready',
            observation: { ...observed, checks: fact(observed.head, reason) },
          }
        return fail(reason as Reason)
      }
      const op: Operation = {
        retire(reason) {
          retired = true
          controller.abort()
          if (reader || response) void cancel()
          finish(partial(reason))
        },
      }
      active = op
      const timer = setTimeout(
        () => op.retire('timeout'),
        Math.max(0, deadline - performance.now()),
      )
      const check = () => {
        if (performance.now() >= deadline && !retired) op.retire('timeout')
        if (retired || disposed) throw Error('retired')
      }
      const defaultFailure = (e: ReadError): KnownPRReadResult => {
        const reason: Reason = [
          'transport',
          'response',
          'body',
          'timeout',
          'aborted',
          'provider_refused',
          'not_found_or_hidden',
          'response_status',
        ].includes(e.reason)
          ? (e.reason as Reason)
          : 'response'
        return e.httpStatus === undefined
          ? fail(reason)
          : {
              status: [401, 403].includes(e.httpStatus)
                ? 'refused'
                : 'not_evaluated',
              reason,
              httpStatus: e.httpStatus,
            }
      }
      // One transport lifetime for the entire observation. A new request starts only
      // after the preceding response ended or cancellation was acknowledged.
      const get = async <T>(
        url: string,
        decodeBody: (bytes: Uint8Array) => T,
        terminal = false,
      ): Promise<T> => {
        check()
        if (++requests > (configured ? 6 : 1)) throw new ReadError('bounds')
        response = undefined
        reader = undefined
        cancellation = undefined
        ended = false
        let phase: 'transport' | 'response' | 'body' = 'transport'
        try {
          response = await transport(url, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              authorization: 'Bearer ' + token,
              accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'margin-known-pr-reader',
            },
          })
          check()
          phase = 'response'
          if (response.redirected || (response.url && response.url !== url))
            throw Error('redirect')
          const status = response.status
          if (!Number.isInteger(status) || status < 100 || status > 599)
            throw Error('status')
          if (status !== 200)
            throw new ReadError(
              [401, 403].includes(status)
                ? 'provider_refused'
                : status === 404
                  ? 'not_found_or_hidden'
                  : 'response_status',
              status,
            )
          if (
            !/^application\/(?:json|vnd\.github\+json)(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get('content-type') ?? '',
            ) ||
            !response.body
          )
            throw Error('media')
          const length = response.headers.get('content-length')
          if (
            length !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(length) ||
              Number(length) > MAX_BYTES ||
              Number(length) > 6 * MAX_BYTES - totalBytes)
          )
            throw Error('length')
          if (
            configured &&
            /(?:^|,)\s*<[^>]*>\s*;[^,]*\brel\s*=\s*"?[^",]*\bnext\b/i.test(
              response.headers.get('link') ?? '',
            )
          )
            throw new ReadError('incomplete')
          phase = 'body'
          reader = response.body.getReader()
          const bytes = new Uint8Array(MAX_BYTES)
          let size = 0
          while (true) {
            check()
            let chunk: ReadableStreamReadResult<Uint8Array>
            try {
              chunk = await reader.read()
            } catch {
              ended = true
              throw Error('reader')
            }
            check()
            if (chunk.done) {
              ended = true
              break
            }
            if (
              !(chunk.value instanceof Uint8Array) ||
              chunk.value.byteLength > MAX_BYTES - size ||
              chunk.value.byteLength > 6 * MAX_BYTES - totalBytes
            )
              throw Error('bytes')
            bytes.set(chunk.value, size)
            size += chunk.value.byteLength
            totalBytes += chunk.value.byteLength
          }
          phase = 'response'
          const value = decodeBody(bytes.subarray(0, size))
          check()
          // Default one-GET semantics return before asynchronous cleanup exactly
          // as before, while the operation slot remains owned through finally.
          if (terminal) finish(value as KnownPRReadResult)
          return value
        } catch (error) {
          const failure =
            error instanceof ReadError ? error : new ReadError(phase)
          if (terminal && !retired && !disposed) finish(defaultFailure(failure))
          throw failure
        } finally {
          const acknowledged = cancellation
            ? await cancellation
            : ended || !response?.body
              ? true
              : await cancel()
          if (acknowledged) {
            reader?.releaseLock()
            if (terminal && active === op) active = undefined
          } else {
            cleanupSafe = false
            throw new ReadError('body')
          }
        }
      }
      const readPR = () =>
        get(api, (bytes) => decode(bytes, number, api, check), !configured)
      void (async () => {
        try {
          const first = await readPR()
          check()
          if (
            !configured ||
            first.status !== 'ready' ||
            first.observation.state !== 'open'
          ) {
            finish(first)
            return
          }
          observed = first.observation
          let reason: CheckReason = 'incomplete'
          try {
            const runsURL = `https://api.github.com/repos/${repository}/actions/runs?head_sha=${observed.head}&event=pull_request&per_page=100`
            const runs = await get(runsURL, (bytes) =>
              selectRuns(bytes, observed!.head, check),
            )
            const states: CheckReason[] = []
            for (let i = 0; i < runs.length; i++) {
              const r = runs[i]
              states.push(
                ...(await get(
                  `https://api.github.com/repos/${repository}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`,
                  (bytes) => jobStates(bytes, r, i, check),
                )),
              )
            }
            reason = aggregate(states)
            const finalRuns = await get(runsURL, (bytes) =>
              selectRuns(bytes, observed!.head, check),
            )
            if (!sameRuns(runs, finalRuns)) reason = 'run_changed'
          } catch (error) {
            reason = error instanceof ReadError ? error.reason : 'response'
          }
          check()
          if (!cleanupSafe) {
            finish(partial(reason))
            return
          }
          try {
            const final = await readPR()
            check()
            if (final.status !== 'ready')
              throw new ReadError('final_pr_unavailable')
            if (final.observation.state !== 'open') {
              finish(final)
              return
            }
            if (final.observation.head !== observed.head)
              reason = 'head_changed'
            observed = final.observation
          } catch {
            check()
            reason = 'final_pr_unavailable'
          }
          finish(partial(reason))
        } catch (error) {
          if (!retired && !disposed)
            finish(
              observed
                ? partial(
                    error instanceof ReadError ? error.reason : 'response',
                  )
                : defaultFailure(
                    error instanceof ReadError
                      ? error
                      : new ReadError('transport'),
                  ),
            )
        } finally {
          if (cleanupSafe && active === op) active = undefined
        }
      })().catch(() => finish(fail('transport')))
      return result
    },
    dispose() {
      disposed = true
      active?.retire('aborted')
    },
  }
}
