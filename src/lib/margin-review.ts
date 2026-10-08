/** Site-admin review reader. Only the server establishes authority.
 * Rows contain CURRENT proposals, never an immutable approved snapshot.
 */
import { z } from 'zod'
import {
  ReviewSession,
  ReviewRequestError,
  readReviewIdentity,
  type ReviewTarget,
  type SessionStatus,
} from './margin-review-session'
import {
  acceptAll,
  rejectAll,
  criticMarkupFor,
  formatHunks,
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

/** One selected hunk is edited as text. No source reads or rendering authority. */
export class ReviewDraft {
  readonly original: string
  #body: string
  #index?: number
  #text = ''
  #openedText = ''
  #error = ''
  constructor(body: string) {
    markupTokens(body) // same body/hunk/markup limits as the marked reader
    this.original = this.#body = body
  }
  get body(): string {
    return this.#body
  }
  get changed(): boolean {
    return this.#body !== this.original
  }
  get error(): string {
    return this.#error
  }
  get editor(): { index: number; text: string } | undefined {
    return this.#index === undefined
      ? undefined
      : { index: this.#index, text: this.#text }
  }
  get pending(): boolean {
    return (
      this.#index !== undefined &&
      this.#text !== acceptAll(parseHunks(this.#body)[this.#index].criticMarkup)
    )
  }
  open(index: number): void {
    const hunks = parseHunks(this.#body)
    if (!Number.isInteger(index) || index < 0 || index >= hunks.length)
      throw new Error('invalid hunk')
    // Opening another hunk must not silently discard unmaterialized edits.
    if (this.pending) throw new Error('update or cancel the current text first')
    this.#index = index
    this.#text = this.#openedText = acceptAll(hunks[index].criticMarkup)
    this.#error = ''
  }
  stage(text: string, fromTextarea = false): void {
    if (this.#index === undefined) return
    this.#text = text
    this.#error = ''
    if (fromTextarea) {
      // The textarea value API normalizes CRLF and CR. Reconstruct only the
      // opened hunk's known homogeneous style; never normalize stored text.
      const normalized = text.replace(/\r\n?/g, '\n')
      if (normalized === this.#openedText.replace(/\r\n?/g, '\n')) {
        this.#text = this.#openedText
        return
      }
      const endings = new Set(this.#openedText.match(/\r\n|\r|\n/g) ?? [])
      if (endings.size > 1) {
        this.#error =
          'This hunk has mixed line endings and cannot be edited here. Cancel this edit to preserve its text and save review metadata only.'
        return
      }
      const newline = endings.values().next().value ?? '\n'
      this.#text = normalized.replace(/\n/g, newline)
    }
  }
  cancel(): void {
    this.#index = undefined
    this.#text = ''
    this.#openedText = ''
    this.#error = ''
  }
  discard(): void {
    this.#body = this.original
    this.cancel()
  }
  update(): boolean {
    if (this.#index === undefined || this.#error) return false
    try {
      if (
        this.#text.length > 64_000 ||
        new TextDecoder('utf-8', { ignoreBOM: true }).decode(
          new TextEncoder().encode(this.#text),
        ) !== this.#text
      )
        throw new Error('edited text is too large or not well-formed Unicode')
      const index = this.#index,
        current = parseHunks(this.#body),
        original = parseHunks(this.original)[index]
      const base = rejectAll(original.criticMarkup)
      // Exactly one bounded converter invocation per deliberate Update action;
      // unchanged text (including undo) retains the original markup bytes.
      const markup =
        this.#text === acceptAll(original.criticMarkup)
          ? original.criticMarkup
          : criticMarkupFor(base, this.#text)
      if (rejectAll(markup) !== base || acceptAll(markup) !== this.#text)
        throw new Error('ambiguous text')
      current[index] = { ...original, criticMarkup: markup }
      const body = formatHunks(current)
      markupTokens(body) // includes final serialized body size, not just input
      this.#body = body
      this.cancel()
      return true
    } catch {
      this.#error =
        'These edits cannot be represented within the proposal limits. Shorten or change the text, or cancel this edit.'
      return false
    }
  }
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

/** Fixed same-origin queue and Save controls; no HTML injection or persistence. */
export function mountReviewReader(root: HTMLElement): () => void {
  const doc = root.ownerDocument,
    win = doc.defaultView
  const form = root.querySelector<HTMLFormElement>('form')!
  const status = root.querySelector<HTMLElement>('[data-review-status]')!
  const list = root.querySelector<HTMLElement>('[data-review-rows]')!
  const more = root.querySelector<HTMLButtonElement>('[data-review-more]')!
  const retry = root.querySelector<HTMLButtonElement>('[data-review-retry]')!
  const signIn = root.querySelector<HTMLElement>('[data-review-sign-in]')!
  const panel = root.querySelector<HTMLElement>('[data-review-session]')!
  const panelStatus = root.querySelector<HTMLElement>(
    '[data-review-session-status]',
  )!
  const content = root.querySelector<HTMLElement>(
    '[data-review-session-content]',
  )!
  const saveForm = root.querySelector<HTMLFormElement>(
    '[data-review-save-form]',
  )!
  const decision = saveForm.elements.namedItem('decision') as HTMLInputElement
  const comments = saveForm.elements.namedItem(
    'comments',
  ) as HTMLTextAreaElement
  const saveButton =
    root.querySelector<HTMLButtonElement>('[data-review-save]')!
  const refresh = root.querySelector<HTMLButtonElement>(
    '[data-review-refresh]',
  )!
  const close = root.querySelector<HTMLButtonElement>('[data-review-close]')!
  const draftPanel = root.querySelector<HTMLElement>('[data-review-draft]')!
  const draftStatus = root.querySelector<HTMLElement>(
    '[data-review-draft-status]',
  )!
  const draftDiff = root.querySelector<HTMLElement>('[data-review-draft-diff]')!
  const editor = root.querySelector<HTMLElement>('[data-review-hunk-editor]')!
  const editorLabel = root.querySelector<HTMLElement>(
    '[data-review-hunk-label]',
  )!
  const proposedText = root.querySelector<HTMLTextAreaElement>(
    '[data-review-proposed-text]',
  )!
  const update = root.querySelector<HTMLButtonElement>('[data-review-update]')!
  const cancelEdit = root.querySelector<HTMLButtonElement>(
    '[data-review-cancel-edit]',
  )!
  const discard = root.querySelector<HTMLButtonElement>(
    '[data-review-discard]',
  )!
  let draft: ReviewDraft | undefined
  const site = root.dataset.reviewSite!
  const fetcher: typeof fetch = (input, init) => fetch(input, init)
  let epoch = 0,
    principal: string | undefined,
    selected: ReviewTarget | undefined
  let queue: ReviewQueue
  const element = (tag: string, text: string) => {
    const node = doc.createElement(tag)
    node.textContent = text
    return node
  }
  const renderHunks = (
    into: HTMLElement,
    hunks: ReviewRow['hunks'],
    editable = false,
  ) => {
    for (const [index, hunk] of hunks.entries()) {
      into.append(element('h3', `Base lines ${hunk.start}–${hunk.end}`))
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
      into.append(pre)
      if (editable) {
        const edit = element(
          'button',
          `Edit proposed text · base lines ${hunk.start}–${hunk.end}`,
        ) as HTMLButtonElement
        edit.type = 'button'
        edit.disabled = !session.canSave || Boolean(draft?.pending)
        edit.addEventListener('click', () => {
          if (!session.canSave || !draft || draft.pending) return
          draft.open(index)
          renderDraft()
          proposedText.focus()
        })
        into.append(edit)
      }
    }
  }
  const updateSave = () => {
    saveButton.disabled =
      !session.canSave ||
      Boolean(draft?.pending || draft?.error) ||
      !decision.value.trim() ||
      decision.value.trim().length > 200 ||
      comments.value.length > 8000
  }
  const renderDraft = () => {
    draftPanel.hidden = !draft
    draftDiff.replaceChildren()
    draftStatus.textContent = draft
      ? draft.error ||
        (draft.changed
          ? 'Unsaved proposed changes. Save review to store them; the proposal stays pending.'
          : 'Stored proposed changes.')
      : ''
    discard.disabled =
      !draft || !session.canSave || (!draft.changed && !draft.editor)
    if (draft) renderHunks(draftDiff, markupTokens(draft.body), true)
    const active = draft?.editor
    editor.hidden = !active
    proposedText.value = active?.text ?? ''
    proposedText.disabled = !active || !session.canSave
    update.disabled =
      !active || !session.canSave || !draft?.pending || Boolean(draft?.error)
    if (active) {
      const hunk = parseHunks(draft!.body)[active.index]
      editorLabel.textContent = `Proposed text · base lines ${hunk.baseStartLine}–${hunk.baseEndLine}`
    } else editorLabel.textContent = 'Proposed text'
    updateSave()
  }
  const session = new ReviewSession(
    site,
    fetcher,
    (view) => {
      panel.hidden = view.status === 'idle'
      content.replaceChildren()
      const busy = ['loading', 'saving', 'reconciling'].includes(view.status)
      panel.setAttribute('aria-busy', String(busy))
      refresh.disabled = busy
      decision.disabled = comments.disabled = !session.canSave
      if (view.status === 'idle' || (!view.observed && !view.attempt)) {
        decision.value = ''
        comments.value = ''
      }
      if (view.observed && !view.attempt) {
        decision.value = view.observed.savedReview?.decision ?? ''
        comments.value = view.observed.savedReview?.comments ?? ''
      }
      const messages: Record<SessionStatus, string> = {
        idle: '',
        loading: 'Loading selected review…',
        ready: 'Showing the current proposal and saved review.',
        saving: 'Saving review…',
        reconciling: 'Reading the current saved review…',
        unauthenticated: 'Sign in to request review access.',
        forbidden: 'This account does not have site-admin review access.',
        missing: 'This proposal is unavailable.',
        unavailable: 'The review service is unavailable.',
        malformed: 'The review response could not be read safely.',
        'session-changed':
          'The account changed. Private review data was cleared.',
      }
      let message = messages[view.status]
      if (view.outcome === 'acknowledged')
        message = view.observed
          ? 'Save acknowledged. Showing the currently stored review.'
          : 'Save acknowledged; saved review could not be refreshed. No repeat Save was sent.'
      if (view.outcome === 'uncertain')
        message =
          'Save outcome is uncertain. No repeat Save was sent. ' +
          (view.observed
            ? 'These are the currently stored values; matching values do not identify the earlier request. Refresh deliberately before another Save.'
            : 'Current saved review could not be established. Refresh deliberately before another Save.')
      if (view.outcome === 'conflict')
        message =
          'The proposal changed or is no longer editable. Showing refreshed state when available; refresh deliberately before another Save.'
      if (view.outcome === 'rejected')
        message = 'Save was refused. Refresh the review before another action.'
      panelStatus.textContent = message
      const row = view.observed
      draft = row && session.canSave ? new ReviewDraft(row.body) : undefined
      if (row) {
        content.append(
          element(
            'p',
            `Current revision ${row.revision ?? 'unavailable'} · ${row.state}`,
          ),
        )
        if (row.approvedRevision !== undefined)
          content.append(
            element(
              'p',
              `Approved revision ${row.approvedRevision}. Showing current content, not the approved snapshot.`,
            ),
          )
        if (row.revision === undefined) {
          content.append(
            element(
              'p',
              'Legacy proposal: recorded source is unavailable. This review is read-only.',
            ),
            element('pre', row.body),
          )
        } else if (!draft) renderHunks(content, markupTokens(row.body))
        if (row.withdrawnAt)
          content.append(
            element('p', 'This proposal was withdrawn and is read-only.'),
          )
        if (row.savedReview) {
          content.append(
            element(
              'p',
              `Saved review for revision ${row.savedReview.revision} at ${row.savedReview.at}${row.savedReview.revision !== row.revision ? ' · Predates current content' : ''}`,
            ),
            element('p', `Decision: ${row.savedReview.decision}`),
            element('pre', row.savedReview.comments),
            element('p', `Reviewer: ${row.savedReview.reviewer}`),
          )
        } else content.append(element('p', 'No saved review.'))
      }
      renderDraft()
    },
    () => {
      epoch++
      principal = undefined
      selected = undefined
      queue.dispose()
      decision.value = ''
      comments.value = ''
      status.textContent =
        'Review access changed or could not be established. Reload the queue.'
    },
  )
  const clearPrivate = () => {
    epoch++
    principal = undefined
    selected = undefined
    session.close()
    queue.dispose()
  }
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
  queue = new ReviewQueue(
    site,
    async (input, init) => {
      const generation = epoch,
        signal = init?.signal ?? new AbortController().signal
      try {
        const before = await readReviewIdentity(fetcher, signal)
        if (principal !== undefined && before !== principal)
          throw new ReviewRequestError('session-changed', true)
        const response = await fetcher(input, init)
        const after = await readReviewIdentity(fetcher, signal)
        if (generation !== epoch || signal.aborted)
          throw new ReviewRequestError('unavailable')
        if (before !== after)
          throw new ReviewRequestError('session-changed', true)
        principal = before
        return response
      } catch (error) {
        if (generation === epoch && !signal.aborted) {
          clearPrivate()
          const kind =
            error instanceof ReviewRequestError ? error.kind : 'unavailable'
          status.textContent =
            kind === 'unauthenticated'
              ? messages.unauthenticated
              : kind === 'session-changed'
                ? 'The account changed. Private review data was cleared. Reload the queue.'
                : 'Review identity could not be established. Try again.'
          signIn.hidden = kind !== 'unauthenticated'
          retry.hidden = false
        }
        throw error
      }
    },
    (view) => {
      status.textContent = messages[view.status]
      root.setAttribute('aria-busy', String(view.status === 'loading'))
      more.hidden = !view.more
      more.disabled = view.status === 'loading'
      retry.hidden = !['unavailable', 'malformed', 'forbidden'].includes(
        view.status,
      )
      signIn.hidden = view.status !== 'unauthenticated'
      if (
        ['unauthenticated', 'forbidden', 'unavailable', 'malformed'].includes(
          view.status,
        )
      ) {
        selected = undefined
        session.close()
      }
      list.replaceChildren()
      for (const row of view.rows) {
        const article = doc.createElement('article')
        article.dataset.proposalId = row.id
        const source = new URL(row.source)
        article.append(
          element('h2', source.pathname + source.search + source.hash),
          element('p', `${row.state} · ${revisionLabel(row)}`),
          element('p', `Created ${row.created}`),
        )
        renderHunks(article, row.hunks)
        const open = doc.createElement('button')
        open.type = 'button'
        open.textContent = 'Open review'
        open.addEventListener('click', () => {
          selected = { id: row.id, source: row.source }
          void session.open(selected, principal)
        })
        article.append(open)
        list.append(article)
      }
    },
  )
  const reset = () => {
    clearPrivate()
    return queue.reset({
      state: (form.elements.namedItem('state') as HTMLSelectElement)
        .value as ReviewState,
      document: (
        form.elements.namedItem('document') as HTMLInputElement
      ).value.trim(),
    })
  }
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
  const save = (event: Event) => {
    event.preventDefault()
    if (!session.canSave || draft?.pending || draft?.error) return
    void session.save(
      decision.value,
      comments.value,
      draft?.changed ? draft.body : undefined,
    )
  }
  const refreshSelected = () => {
    if (selected) void session.open(selected, principal)
  }
  const closeSelected = () => {
    selected = undefined
    session.close()
  }
  const stageText = () => {
    if (!session.canSave || !draft) return
    draft.stage(proposedText.value, true)
    // No conversion or complete DOM rerender on input.
    draftStatus.textContent =
      draft.error ||
      (draft.pending
        ? 'Unreviewed text edits. Update marked changes before saving.'
        : draft.changed
          ? 'Unsaved proposed changes.'
          : 'Stored proposed changes.')
    update.disabled = !draft.pending || Boolean(draft.error)
    for (const button of draftDiff.querySelectorAll<HTMLButtonElement>(
      'button',
    ))
      button.disabled = draft.pending
    updateSave()
  }
  const updateText = () => {
    if (!session.canSave || !draft) return
    draft.update()
    renderDraft()
    if (draft.editor) proposedText.focus()
    else saveButton.focus()
  }
  const cancelText = () => {
    draft?.cancel()
    renderDraft()
  }
  const discardText = () => {
    draft?.discard()
    renderDraft()
  }
  const visibility = () => {
    if (doc.visibilityState === 'hidden') clearPrivate()
    else void reset()
  }
  const focus = () => {
    void reset()
  }
  form.addEventListener('submit', submit)
  more.addEventListener('click', loadMore)
  retry.addEventListener('click', reload)
  saveForm.addEventListener('submit', save)
  decision.addEventListener('input', updateSave)
  comments.addEventListener('input', updateSave)
  proposedText.addEventListener('input', stageText)
  update.addEventListener('click', updateText)
  cancelEdit.addEventListener('click', cancelText)
  discard.addEventListener('click', discardText)
  refresh.addEventListener('click', refreshSelected)
  close.addEventListener('click', closeSelected)
  doc.addEventListener('visibilitychange', visibility)
  win?.addEventListener('focus', focus)
  void reset()
  return () => {
    clearPrivate()
    form.removeEventListener('submit', submit)
    more.removeEventListener('click', loadMore)
    retry.removeEventListener('click', reload)
    saveForm.removeEventListener('submit', save)
    decision.removeEventListener('input', updateSave)
    comments.removeEventListener('input', updateSave)
    proposedText.removeEventListener('input', stageText)
    update.removeEventListener('click', updateText)
    cancelEdit.removeEventListener('click', cancelText)
    discard.removeEventListener('click', discardText)
    refresh.removeEventListener('click', refreshSelected)
    close.removeEventListener('click', closeSelected)
    doc.removeEventListener('visibilitychange', visibility)
    win?.removeEventListener('focus', focus)
  }
}
