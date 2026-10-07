/** Read-only site-admin review reader. Only the server establishes authority.
 * Rows contain CURRENT proposals, never an immutable approved snapshot.
 */
import { z } from 'zod'
import {
  isFullCommitId,
  parseCriticMarkup,
  parseHunks,
} from '../annotations/criticmarkup'

export const REVIEW_STATES = [
  'pending',
  'approved',
  'pr_open',
  'conflict',
  'merged',
  'closed',
  'apply_failed',
] as const
export type ReviewState = (typeof REVIEW_STATES)[number]
export type ReviewFilters = { state: ReviewState; document: string }
export type DiffToken = { kind: 'equal' | 'delete' | 'insert'; text: string }
export type ReviewRow = {
  id: string
  source: string
  created: string
  state: ReviewState
  revision?: number
  approvedRevision?: number
  hunks: { start: number; end: number; tokens: DiffToken[] }[]
}
export type QueueStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'unauthenticated'
  | 'forbidden'
  | 'unavailable'
  | 'malformed'
  | 'invalid-filter'
  | 'limited'
export type QueueView = {
  status: QueueStatus
  rows: ReviewRow[]
  more: boolean
}
const PAGE_SIZE = 25
const MAX_PAGES = 10
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const rowSchema = z.object({
  id: z.string().min(1).max(2048),
  type: z.literal('Annotation'),
  motivation: z.literal('editing'),
  body: z.object({
    type: z.literal('TextualBody'),
    format: z.literal('text/plain'),
    value: z.string().min(1).max(64_000),
  }),
  target: z.object({ source: z.string().min(1).max(8192) }),
  created: z.string().datetime({ offset: true }),
  'margin:revision': revision.optional(),
  'margin:approvedRevision': revision.optional(),
  'margin:baseCommit': z.string().refine(isFullCommitId).optional(),
  'margin:proposalState': z.enum(REVIEW_STATES).optional(),
  'margin:withdrawnAt': z.never().optional(),
})

export function markupTokens(body: string): ReviewRow['hunks'] {
  if (body.length > 64_000) throw new Error('proposal too large')
  const hunks = parseHunks(body)
  if (hunks.length > 1000) throw new Error('too many hunks')
  return hunks.map((hunk) => ({
    start: hunk.baseStartLine,
    end: hunk.baseEndLine,
    tokens: parseCriticMarkup(hunk.criticMarkup).flatMap(
      (segment): DiffToken[] =>
        segment.kind === 'substitute'
          ? [
              { kind: 'delete', text: segment.old },
              { kind: 'insert', text: segment.new },
            ]
          : [segment],
    ),
  }))
}

export function parseReviewPage(
  value: unknown,
  site: string,
  state: ReviewState,
  document = '',
): { rows: ReviewRow[]; cursor?: string } {
  const page = z
    .object({
      annotations: z.array(rowSchema).max(PAGE_SIZE),
      nextCursor: z.string().min(1).max(16_384).optional(),
    })
    .strict()
    .parse(value)
  const ids = new Set<string>()
  const rows = page.annotations.map((wire) => {
    const source = new URL(wire.target.source)
    const actualState = wire['margin:proposalState'] ?? 'pending'
    const approvedRevision = wire['margin:approvedRevision']
    if (
      source.origin !== site ||
      source.username ||
      source.password ||
      (document &&
        source.pathname + source.search + source.hash !== document) ||
      actualState !== state ||
      ids.has(wire.id) ||
      (actualState === 'pending'
        ? approvedRevision !== undefined
        : approvedRevision === undefined) ||
      (approvedRevision !== undefined &&
        (wire['margin:revision'] === undefined ||
          approvedRevision > wire['margin:revision']))
    ) {
      throw new Error('inconsistent review page')
    }
    ids.add(wire.id)
    return {
      id: wire.id,
      source: source.href,
      created: wire.created,
      state: actualState,
      revision: wire['margin:revision'],
      approvedRevision,
      hunks: markupTokens(wire.body.value),
    }
  })
  if (page.nextCursor && !rows.length)
    throw new Error('empty page with continuation')
  return { rows, cursor: page.nextCursor }
}

export function revisionLabel(row: ReviewRow): string {
  return (
    `Current revision ${row.revision ?? 'unavailable'}` +
    (row.approvedRevision === undefined
      ? ' · Pending'
      : ` · Approved revision ${row.approvedRevision} · Showing current content, not the approved snapshot`)
  )
}

class MalformedResponse extends Error {}
async function readPage(response: Response): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  )
    throw new MalformedResponse()
  const reader = response.body?.getReader()
  if (!reader) throw new MalformedResponse()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0,
    text = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new MalformedResponse()
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new MalformedResponse()
    throw error
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class ReviewQueue {
  state: QueueView = { status: 'idle', rows: [], more: false }
  #filters: ReviewFilters = { state: 'pending', document: '' }
  #generation = 0
  #abort?: AbortController
  #cursor?: string
  #seen = new Set<string>()
  #pages = 0
  constructor(
    private site: string,
    private fetcher: typeof fetch,
    private changed: (state: QueueView) => void,
  ) {
    if (new URL(site).origin !== site || !/^https?:\/\//.test(site))
      throw new Error('site must be a configured origin')
  }
  #show(status: QueueStatus, rows: ReviewRow[] = [], more = false) {
    this.state = { status, rows, more }
    this.changed(this.state)
  }
  async reset(filters: Partial<ReviewFilters> = {}): Promise<void> {
    this.#generation++
    this.#abort?.abort()
    this.#cursor = undefined
    this.#seen.clear()
    this.#pages = 0
    const state = filters.state ?? 'pending',
      document = filters.document ?? ''
    if (
      !REVIEW_STATES.includes(state) ||
      document.length > 8192 ||
      (document &&
        (!document.startsWith('/') ||
          document.startsWith('//') ||
          document.includes('\\') ||
          /[\x00-\x20]/.test(document) ||
          new URL(this.site + document).pathname +
            new URL(this.site + document).search +
            new URL(this.site + document).hash !==
            document))
    ) {
      this.#show('invalid-filter')
      return
    }
    this.#filters = { state, document }
    this.#show('idle')
    await this.#load()
  }
  async more(): Promise<void> {
    if (!this.state.more || this.state.status !== 'ready') return
    await this.#load()
  }
  dispose(): void {
    this.#generation++
    this.#abort?.abort()
    this.#cursor = undefined
    this.#seen.clear()
    this.#show('idle')
  }
  async #load(): Promise<void> {
    const generation = this.#generation,
      previous = this.state.rows,
      cursor = this.#cursor
    const abort = (this.#abort = new AbortController())
    const params = new URLSearchParams({
      scope: 'review',
      site: this.site,
      state: this.#filters.state,
      limit: String(PAGE_SIZE),
    })
    if (this.#filters.document) params.set('document', this.#filters.document)
    if (cursor) params.set('cursor', cursor)
    this.#show('loading', previous)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        (async () => {
          const response = await this.fetcher(
            '/api/margin/v1/proposals?' + params,
            {
              method: 'GET',
              credentials: 'same-origin',
              mode: 'same-origin',
              cache: 'no-store',
              redirect: 'error',
              headers: { Accept: 'application/json' },
              signal: abort.signal,
            },
          )
          if (response.status === 401) return 'unauthenticated' as const
          if (response.status === 403) return 'forbidden' as const
          if (!response.ok) return 'unavailable' as const
          const raw = await readPage(response)
          try {
            return parseReviewPage(
              raw,
              this.site,
              this.#filters.state,
              this.#filters.document,
            )
          } catch {
            throw new MalformedResponse()
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort()
            reject(new Error('timeout'))
          }, 10_000)
        }),
      ])
      if (generation !== this.#generation) return
      if (typeof result === 'string') {
        this.#show(result)
        return
      }
      if (
        result.rows.some((row) => previous.some((old) => old.id === row.id)) ||
        (result.cursor &&
          (result.cursor === cursor || this.#seen.has(result.cursor)))
      )
        throw new MalformedResponse()
      if (cursor) this.#seen.add(cursor)
      this.#cursor = result.cursor
      this.#pages++
      const rows = [...previous, ...result.rows]
      this.#show(
        !rows.length
          ? 'empty'
          : result.cursor && this.#pages >= MAX_PAGES
            ? 'limited'
            : 'ready',
        rows,
        Boolean(result.cursor) && this.#pages < MAX_PAGES,
      )
    } catch (error) {
      if (generation === this.#generation)
        this.#show(
          error instanceof MalformedResponse ? 'malformed' : 'unavailable',
        )
    } finally {
      clearTimeout(timer)
    }
  }
}

/** No innerHTML, storage, writer controls, document fetches or auth bypass. */
export function mountReviewReader(root: HTMLElement): () => void {
  const doc = root.ownerDocument
  const form = root.querySelector<HTMLFormElement>('form')!
  const status = root.querySelector<HTMLElement>('[data-review-status]')!
  const list = root.querySelector<HTMLElement>('[data-review-rows]')!
  const more = root.querySelector<HTMLButtonElement>('[data-review-more]')!
  const retry = root.querySelector<HTMLButtonElement>('[data-review-retry]')!
  const signIn = root.querySelector<HTMLElement>('[data-review-sign-in]')!
  const messages: Record<QueueStatus, string> = {
    idle: '',
    loading: 'Loading proposals…',
    ready: 'Showing current proposals.',
    empty: 'No proposals match these filters.',
    unauthenticated: 'Sign in to request admin review access.',
    forbidden: 'This account does not have site-admin review access.',
    unavailable: 'The review service is unavailable. Try again.',
    malformed: 'The review response could not be read safely. Try again.',
    'invalid-filter':
      'Enter a document path beginning with a single /, without spaces.',
    limited:
      'Page limit reached (up to 250 proposals). Narrow the document or state filter to continue.',
  }
  const element = (tag: string, text: string) => {
    const node = doc.createElement(tag)
    node.textContent = text
    return node
  }
  const queue = new ReviewQueue(
    root.dataset.reviewSite!,
    (input, init) => fetch(input, init),
    (view) => {
      status.textContent = messages[view.status]
      root.setAttribute('aria-busy', String(view.status === 'loading'))
      more.hidden = !view.more
      more.disabled = view.status === 'loading'
      retry.hidden = !['unavailable', 'malformed', 'forbidden'].includes(
        view.status,
      )
      signIn.hidden = view.status !== 'unauthenticated'
      list.replaceChildren()
      for (const row of view.rows) {
        const article = doc.createElement('article')
        article.dataset.proposalId = row.id
        article.append(
          element(
            'h2',
            new URL(row.source).pathname +
              new URL(row.source).search +
              new URL(row.source).hash,
          ),
          element('p', `${row.state} · ${revisionLabel(row)}`),
          element('p', `Created ${row.created}`),
        )
        for (const hunk of row.hunks) {
          article.append(element('h3', `Base lines ${hunk.start}–${hunk.end}`))
          const pre = doc.createElement('pre')
          for (const token of hunk.tokens)
            pre.append(
              element(
                token.kind === 'insert'
                  ? 'ins'
                  : token.kind === 'delete'
                    ? 'del'
                    : 'span',
                token.text,
              ),
            )
          article.append(pre)
        }
        list.append(article)
      }
    },
  )
  const reset = () =>
    queue.reset({
      state: (form.elements.namedItem('state') as HTMLSelectElement)
        .value as ReviewState,
      document: (
        form.elements.namedItem('document') as HTMLInputElement
      ).value.trim(),
    })
  const submit = (event: Event) => {
    event.preventDefault()
    void reset()
  }
  const loadMore = () => {
    void queue.more()
  }
  const reload = () => {
    void reset()
  }
  form.addEventListener('submit', submit)
  more.addEventListener('click', loadMore)
  retry.addEventListener('click', reload)
  void reset()
  return () => {
    queue.dispose()
    form.removeEventListener('submit', submit)
    more.removeEventListener('click', loadMore)
    retry.removeEventListener('click', reload)
  }
}
