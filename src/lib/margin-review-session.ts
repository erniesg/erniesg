/** Save-only client state. Server authentication/site authorization decides every
 * request. Identity probes isolate observed responses, not cookie transactions.
 */
import { z } from 'zod'
import {
  reportInteger,
  reportCommit,
  reportDetail,
  reportURL,
  type ReviewExecution,
} from '../worker/margin/repository'
import {
  isFullCommitId,
  parseHunks,
  acceptAll,
  rejectAll,
} from '../annotations/criticmarkup'

export type ReviewTarget = { id: string; source: string }
export type SavedReview = {
  decision: string
  comments: string
  revision: number
  reviewer: string
  at: string
}
export type ReviewObservation = ReviewTarget & {
  body: string
  revision?: number
  baseCommit?: string
  sourcePath?: string
  state: string
  approvedRevision?: number
  withdrawnAt?: string
  savedReview: SavedReview | null
}
export type ReviewProgressObservation = ReviewObservation & {
  execution: ReviewExecution | null
}
export type SaveAttempt = {
  revision: number
  decision: string
  comments: string
  body?: string
}
export type SessionStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'reconciling'
  | 'unauthenticated'
  | 'forbidden'
  | 'missing'
  | 'unavailable'
  | 'malformed'
  | 'session-changed'
export type ReviewSessionState = {
  status: SessionStatus
  outcome: 'none' | 'acknowledged' | 'uncertain' | 'conflict' | 'rejected'
  observed?: ReviewProgressObservation
  attempt?: SaveAttempt
}
export class ReviewRequestError extends Error {
  constructor(
    readonly kind: SessionStatus,
    readonly identityFailure = false,
  ) {
    super(kind)
  }
}
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const date = z.string().datetime({ offset: true })
const states = [
  'approved',
  'pr_open',
  'conflict',
  'merged',
  'closed',
  'apply_failed',
] as const
const principalPrefix = 'urn:margin:principal:'
function storedPrincipal(value: string): boolean {
  try {
    if (!value.startsWith(principalPrefix)) return false
    const parts = value
      .slice(principalPrefix.length)
      .split(':')
      .map(decodeURIComponent)
    return (
      parts.length === 3 &&
      parts.every(Boolean) &&
      principalPrefix + parts.map(encodeURIComponent).join(':') === value
    )
  } catch {
    return false
  }
}
const savedSchema = z
  .object({
    decision: z
      .string()
      .min(1)
      .max(200)
      .refine((x) => x === x.trim()),
    comments: z.string().max(8000),
    revision,
    reviewer: z.string().max(8192).refine(storedPrincipal),
    at: date,
  })
  .strict()
const annotationSchema = z.object({
  id: z.string().max(2048),
  type: z.literal('Annotation'),
  motivation: z.literal('editing'),
  target: z.object({ source: z.string().max(8192) }),
  body: z.object({
    type: z.literal('TextualBody'),
    format: z.literal('text/plain'),
    value: z.string().min(1).max(64_000),
  }),
  'margin:revision': revision.optional(),
  'margin:baseCommit': z.string().refine(isFullCommitId).optional(),
  'margin:sourcePath': z
    .string()
    .min(1)
    .max(512)
    .refine(
      (x) =>
        !x.startsWith('/') &&
        !/[\\\0]/.test(x) &&
        x.split('/').every((p) => p && p !== '.' && p !== '..'),
    )
    .optional(),
  'margin:proposalState': z.enum(states).optional(),
  'margin:approvedRevision': revision.optional(),
  'margin:withdrawnAt': date.optional(),
})
export function reviewRoute(target: ReviewTarget, site: string): string {
  const prefix = 'urn:margin:annotation:'
  if (!target.id.startsWith(prefix) || target.id.length > 2048)
    throw new ReviewRequestError('malformed')
  const id = target.id.slice(prefix.length)
  let source: URL
  try {
    source = new URL(target.source)
  } catch {
    throw new ReviewRequestError('malformed')
  }
  if (
    !id ||
    /[\x00-\x20\x7f/\\?#]/.test(id) ||
    target.source.length > 8192 ||
    source.href !== target.source ||
    source.origin !== site ||
    source.username ||
    source.password ||
    !/^https?:$/.test(source.protocol)
  )
    throw new ReviewRequestError('malformed')
  return (
    '/api/margin/v1/proposals/' +
    encodeURIComponent(id) +
    '/review?' +
    new URLSearchParams({ source: target.source })
  )
}
function currentAnnotation(
  raw: unknown,
  target: ReviewTarget,
  site: string,
): Omit<ReviewObservation, 'savedReview'> {
  reviewRoute(target, site)
  const wire = annotationSchema.parse(raw)
  const rev = wire['margin:revision'],
    base = wire['margin:baseCommit'],
    path = wire['margin:sourcePath']
  const stamp = [rev, base, path],
    approved = wire['margin:approvedRevision'],
    state = wire['margin:proposalState'],
    withdrawn = wire['margin:withdrawnAt']
  if (
    wire.id !== target.id ||
    wire.target.source !== target.source ||
    !(
      stamp.every((x) => x === undefined) || stamp.every((x) => x !== undefined)
    ) ||
    (approved === undefined) !== (state === undefined) ||
    (approved !== undefined &&
      (rev === undefined || approved > rev || withdrawn !== undefined))
  )
    throw new ReviewRequestError('malformed')
  if (rev !== undefined) {
    try {
      if (parseHunks(wire.body.value).length > 1000)
        throw new Error('hunk bound')
    } catch {
      throw new ReviewRequestError('malformed')
    }
  }
  return {
    ...target,
    body: wire.body.value,
    revision: rev,
    baseCommit: base,
    sourcePath: path,
    state: state ?? 'pending',
    approvedRevision: approved,
    withdrawnAt: withdrawn,
  }
}
export function parseReviewReadback(
  raw: unknown,
  target: ReviewTarget,
  site: string,
): ReviewObservation {
  const envelope = z
    .object({ annotation: z.unknown(), savedReview: savedSchema.nullable() })
    .strict()
    .parse(raw)
  const current = currentAnnotation(envelope.annotation, target, site),
    saved = envelope.savedReview
  if (
    saved &&
    (current.revision === undefined ||
      saved.revision > current.revision ||
      (current.approvedRevision !== undefined &&
        saved.revision > current.approvedRevision))
  )
    throw new ReviewRequestError('malformed')
  return { ...current, savedReview: saved }
}
/** Opt-in private projection. The default readback decoder remains closed to
 * this field; a missing execution value is never interpreted as legacy null.
 * Reuse wire primitives, without importing the server's stored private tuple.
 */
const executionSchema = z
  .object({
    approvedRevision: reportInteger.positive(),
    state: z.enum(states),
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
    updatedAt: date.max(40),
  })
  .strict()
export function progressReviewRoute(
  target: ReviewTarget,
  site: string,
): string {
  return reviewRoute(target, site) + '&include=execution'
}
export function parseReviewProgressReadback(
  raw: unknown,
  target: ReviewTarget,
  site: string,
): ReviewProgressObservation {
  const envelope = z
    .object({
      annotation: z.unknown(),
      savedReview: savedSchema.nullable(),
      execution: executionSchema.nullable(),
    })
    .strict()
    .parse(raw)
  const current = parseReviewReadback(
    { annotation: envelope.annotation, savedReview: envelope.savedReview },
    target,
    site,
  )
  const e = envelope.execution
  if (e) {
    const hasPR = e.pr !== null
    const valid =
      e.state === 'approved'
        ? e.stateVersion === 0 &&
          !hasPR &&
          e.checks === null &&
          e.detail === null &&
          e.mergeCommit === null
        : e.state === 'pr_open'
          ? hasPR && e.checks !== null && e.mergeCommit === null
          : e.state === 'merged'
            ? hasPR &&
              e.mergeCommit !== null &&
              e.checks === null &&
              e.detail === null
            : e.state === 'closed'
              ? hasPR &&
                e.mergeCommit === null &&
                e.checks === null &&
                e.detail === null
              : e.state === 'conflict'
                ? e.detail !== null &&
                  e.mergeCommit === null &&
                  (hasPR ? e.checks === 'not_evaluated' : e.checks === null)
                : !hasPR &&
                  e.failedApplyCount > 0 &&
                  e.detail !== null &&
                  e.checks === null &&
                  e.mergeCommit === null
    if (
      !valid ||
      e.failedApplyCount > e.stateVersion ||
      (e.state !== 'approved' && e.stateVersion === 0) ||
      e.state !== current.state ||
      e.approvedRevision !== current.approvedRevision
    )
      throw new ReviewRequestError('malformed')
  }
  return { ...current, execution: e }
}

function editable(row?: ReviewObservation): boolean {
  return (
    !!row &&
    row.state === 'pending' &&
    row.withdrawnAt === undefined &&
    row.revision !== undefined &&
    row.revision < Number.MAX_SAFE_INTEGER &&
    row.baseCommit !== undefined &&
    row.sourcePath !== undefined
  )
}

/** One bounded request, including body consumption. An abort never proves a
 * write did not commit. Per-request timers do not poison reconciliation reads.
 */
async function requestJSON(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  body?: SaveAttempt,
): Promise<{ status: number; value?: unknown }> {
  const abort = new AbortController(),
    relay = () => abort.abort()
  signal.addEventListener('abort', relay, { once: true })
  if (signal.aborted) abort.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    return await Promise.race([
      (async () => {
        if (abort.signal.aborted) throw new ReviewRequestError('unavailable')
        const response = await fetcher(url, {
          method: body ? 'POST' : 'GET',
          credentials: 'same-origin',
          mode: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal: abort.signal,
          headers: {
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {})
          return { status: response.status }
        }
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get('content-type') ?? '',
          )
        )
          throw new ReviewRequestError('malformed')
        const reader = response.body?.getReader()
        if (!reader) throw new ReviewRequestError('malformed')
        activeReader = reader
        let count = 0,
          text = ''
        const decoder = new TextDecoder('utf-8', { fatal: true })
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            count += chunk.value.byteLength
            if (count > 1_048_576) throw new ReviewRequestError('malformed')
            text += decoder.decode(chunk.value, { stream: true })
          }
          text += decoder.decode()
          return { status: 200, value: JSON.parse(text) as unknown }
        } catch (error) {
          if (error instanceof SyntaxError || error instanceof TypeError)
            throw new ReviewRequestError('malformed')
          throw error
        } finally {
          void reader.cancel().catch(() => {})
          reader.releaseLock()
          activeReader = undefined
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort()
          reject(new ReviewRequestError('unavailable'))
        }, 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', relay)
    void activeReader?.cancel().catch(() => {})
  }
}
function responseError(status: number): ReviewRequestError {
  return new ReviewRequestError(
    status === 401
      ? 'unauthenticated'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'missing'
          : 'unavailable',
  )
}
/** Display isolation only. Existing /auth/me may renew/recover sign-in; its role
 * flags never authorize this client or replace the privileged service read.
 */
export async function readReviewIdentity(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await requestJSON(fetcher, '/auth/me', signal)
    if (result.status !== 200) throw responseError(result.status)
    const value = z
      .object({ authenticated: z.boolean(), principal: z.unknown().optional() })
      .parse(result.value)
    if (
      value.authenticated === false &&
      (value.principal === undefined || value.principal === null)
    )
      throw new ReviewRequestError('unauthenticated')
    if (!value.authenticated) throw new ReviewRequestError('malformed')
    const p = z
      .object({
        provider: z.string().min(1).max(2048),
        issuer: z.string().min(1).max(2048),
        subject: z.string().min(1).max(2048),
      })
      .parse(value.principal)
    if (signal.aborted) throw new ReviewRequestError('unavailable')
    return JSON.stringify([p.provider, p.issuer, p.subject])
  } catch (error) {
    throw new ReviewRequestError(
      error instanceof ReviewRequestError
        ? error.kind
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 'malformed'
          : 'unavailable',
      true,
    )
  }
}

export class ReviewSession {
  state: ReviewSessionState = { status: 'idle', outcome: 'none' }
  #generation = 0
  #abort?: AbortController
  #target?: ReviewTarget
  #identity?: string
  constructor(
    private site: string,
    private fetcher: typeof fetch,
    private changed: (state: ReviewSessionState) => void,
    private privacyChanged: () => void = () => {},
  ) {
    if (new URL(site).origin !== site || !/^https?:\/\//.test(site))
      throw new Error('configured site required')
  }
  get canSave(): boolean {
    return (
      this.state.status === 'ready' &&
      ['none', 'acknowledged'].includes(this.state.outcome) &&
      editable(this.state.observed)
    )
  }
  #show(state: ReviewSessionState) {
    this.state = state
    this.changed(state)
  }
  close(): void {
    this.#generation++
    this.#abort?.abort()
    this.#target = undefined
    this.#identity = undefined
    this.#show({ status: 'idle', outcome: 'none' })
  }
  async #checkIdentity(signal: AbortSignal, expected: string): Promise<void> {
    if ((await readReviewIdentity(this.fetcher, signal)) !== expected)
      throw new ReviewRequestError('session-changed', true)
  }
  async #read(
    target: ReviewTarget,
    signal: AbortSignal,
    identity: string,
  ): Promise<ReviewProgressObservation> {
    let observed: ReviewProgressObservation | undefined, failure: unknown
    try {
      const reply = await requestJSON(
        this.fetcher,
        progressReviewRoute(target, this.site),
        signal,
      )
      if (reply.status !== 200) throw responseError(reply.status)
      observed = parseReviewProgressReadback(reply.value, target, this.site)
    } catch (error) {
      failure = error
    }
    // A failed read can coincide with an account change too. Do not preserve
    // an old private attempt merely because its metadata refresh failed.
    await this.#checkIdentity(signal, identity)
    if (failure !== undefined) throw failure
    return observed!
  }
  #failure(
    error: unknown,
    outcome: ReviewSessionState['outcome'] = 'none',
    attempt?: SaveAttempt,
  ): void {
    const reason =
      error instanceof ReviewRequestError
        ? error.kind
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 'malformed'
          : 'unavailable'
    if (
      (error instanceof ReviewRequestError && error.identityFailure) ||
      ['unauthenticated', 'forbidden', 'session-changed'].includes(reason)
    ) {
      this.close()
      this.#show({ status: reason, outcome: 'none' })
      this.privacyChanged()
      return
    }
    this.#show({ status: reason, outcome, ...(attempt ? { attempt } : {}) })
  }
  async open(target: ReviewTarget, expectedIdentity?: string): Promise<void> {
    this.close()
    const generation = this.#generation,
      abort = (this.#abort = new AbortController())
    this.#show({ status: 'loading', outcome: 'none' })
    try {
      reviewRoute(target, this.site)
      const identity = await readReviewIdentity(this.fetcher, abort.signal)
      if (expectedIdentity !== undefined && identity !== expectedIdentity)
        throw new ReviewRequestError('session-changed', true)
      const observed = await this.#read(target, abort.signal, identity)
      if (generation !== this.#generation) return
      this.#target = { ...target }
      this.#identity = identity
      this.#show({ status: 'ready', outcome: 'none', observed })
    } catch (error) {
      if (generation === this.#generation) this.#failure(error)
    }
  }
  async save(decision: string, comments: string, body?: string): Promise<void> {
    if (!this.canSave || !this.#target || !this.#identity) return
    const original = this.state.observed!
    // Editing changes proposed text only. The original hunk ranges/base text,
    // base commit and source remain the readback's immutable attempt inputs.
    if (body !== undefined) {
      try {
        if (typeof body !== 'string' || body.length > 64_000) return
        const before = parseHunks(original.body),
          after = parseHunks(body)
        if (after.length > 1000 || after.length !== before.length) return
        let changed = false
        for (let i = 0; i < before.length; i++) {
          if (
            before[i].baseStartLine !== after[i].baseStartLine ||
            before[i].baseEndLine !== after[i].baseEndLine ||
            rejectAll(before[i].criticMarkup) !==
              rejectAll(after[i].criticMarkup)
          )
            return
          changed ||=
            acceptAll(before[i].criticMarkup) !==
            acceptAll(after[i].criticMarkup)
          // Always parse every proposed segment, even after an earlier change.
          acceptAll(after[i].criticMarkup)
        }
        if (!changed) body = undefined
      } catch {
        return
      }
    }
    const attempt: SaveAttempt = {
      revision: original.revision!,
      decision: decision.trim(),
      comments,
      ...(body === undefined ? {} : { body }),
    }
    if (
      !attempt.decision ||
      attempt.decision.length > 200 ||
      comments.length > 8000
    )
      return
    const generation = this.#generation,
      target = this.#target,
      identity = this.#identity
    const abort = (this.#abort = new AbortController())
    this.#show({ ...this.state, status: 'saving', attempt }) // before first await: one POST at most
    let outcome: ReviewSessionState['outcome'] = 'none'
    try {
      await this.#checkIdentity(abort.signal, identity)
      if (generation !== this.#generation) return
      try {
        const reply = await requestJSON(
          this.fetcher,
          reviewRoute(target, this.site),
          abort.signal,
          attempt,
        )
        if (reply.status === 401 || reply.status === 403)
          throw responseError(reply.status)
        if (reply.status === 409) outcome = 'conflict'
        else if (
          reply.status === 400 ||
          reply.status === 413 ||
          reply.status === 404
        )
          outcome = 'rejected'
        else if (reply.status === 200) {
          const current = currentAnnotation(reply.value, target, this.site)
          if (
            current.revision !==
              attempt.revision + Number(attempt.body !== undefined) ||
            current.body !== (attempt.body ?? original.body) ||
            current.baseCommit !== original.baseCommit ||
            current.sourcePath !== original.sourcePath ||
            current.state !== 'pending' ||
            current.withdrawnAt !== undefined
          )
            throw new ReviewRequestError('malformed')
          outcome = 'acknowledged'
        } else outcome = 'uncertain'
      } catch (error) {
        if (
          error instanceof ReviewRequestError &&
          ['unauthenticated', 'forbidden'].includes(error.kind)
        )
          throw error
        outcome = 'uncertain'
      }
      if (generation !== this.#generation) return
      await this.#checkIdentity(abort.signal, identity)
      if (generation !== this.#generation) return
      this.#show({ status: 'reconciling', outcome, attempt })
      // One observation only, never another POST. Local abort and a missing or
      // matching result cannot establish the identity/absence of a write.
      const observed = await this.#read(target, abort.signal, identity)
      if (generation === this.#generation)
        this.#show({ status: 'ready', outcome, attempt, observed })
    } catch (error) {
      if (generation === this.#generation)
        this.#failure(error, outcome, outcome === 'none' ? undefined : attempt)
    }
  }
}
