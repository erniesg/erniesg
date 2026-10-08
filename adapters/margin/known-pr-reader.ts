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
const inputSchema = z.object({ number: reportInteger.positive() }).strict()
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
      let number: number
      try {
        number = inputSchema.parse(input).number
      } catch {
        return Promise.resolve(
          performance.now() >= deadline
            ? fail('timeout')
            : fail('input', 'refused'),
        )
      }
      if (performance.now() >= deadline) return Promise.resolve(fail('timeout'))
      // Host accessors may have reentered or disposed during validation.
      if (disposed) return Promise.resolve(fail('closed', 'refused'))
      if (active) return Promise.resolve(fail('busy'))
      const api = `https://api.github.com/repos/${repository}/pulls/${number}`
      let settle!: (value: KnownPRReadResult) => void
      const result = new Promise<KnownPRReadResult>((resolve) => {
        settle = resolve
      })
      let retired = false,
        settled = false,
        ended = false
      let response: Response | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cancellation: Promise<boolean> | undefined
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
      const op: Operation = {
        retire(reason) {
          retired = true
          controller.abort()
          if (reader || response) void cancel()
          finish(fail(reason))
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
      void (async () => {
        let phase: 'transport' | 'response' | 'body' = 'transport'
        try {
          check()
          response = await transport(api, {
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
          if (response.redirected || (response.url && response.url !== api))
            throw Error('redirect')
          const status = response.status
          if (!Number.isInteger(status) || status < 100 || status > 599)
            throw Error('status')
          if (status !== 200) {
            finish({
              status: [401, 403].includes(status) ? 'refused' : 'not_evaluated',
              reason: [401, 403].includes(status)
                ? 'provider_refused'
                : status === 404
                  ? 'not_found_or_hidden'
                  : 'response_status',
              httpStatus: status,
            })
            return
          }
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
            (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_BYTES)
          )
            throw Error('length')
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
              // Rejected read is terminal stream failure, not pending cancellation.
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
              chunk.value.byteLength > MAX_BYTES - size
            )
              throw Error('bytes')
            bytes.set(chunk.value, size)
            size += chunk.value.byteLength
          }
          phase = 'response'
          const value = decode(bytes.subarray(0, size), number, api, check)
          check()
          finish(value)
        } catch {
          if (!retired && !disposed) {
            if (performance.now() >= deadline) op.retire('timeout')
            else finish(fail(phase))
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
        finish(fail('transport'))
      })
      return result
    },
    dispose() {
      disposed = true
      active?.retire('aborted')
    },
  }
}
