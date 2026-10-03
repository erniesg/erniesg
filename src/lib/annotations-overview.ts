/**
 * The per-book Annotations page (issue 073), minus the DOM.
 *
 * The page fetches the reader's own annotations under the book's path from
 * `GET /api/margin/v1/mine`, which knows nothing about books and answers in
 * `(document, created, id)` order. This module turns those rows into what the
 * page draws: the book's front page first, then one group per manifest node in
 * the book's own order, then everything else under the prefix in one "Other
 * pages" group, so no row is dropped. Each entry carries its kind, quote,
 * note, colour, date and a link back to its spot, with replies under their
 * parent rather than beside it.
 *
 * Kinds follow the rail: a `commenting` body that decodes as a sketch is a
 * sketch, and one that does not is a plain note, whatever it starts with.
 *
 * A reply to somebody else's note is the reader's, but its parent is not, and
 * `/mine` never returns it. Such replies are gathered per parent into a
 * `foreign` entry; the page asks for the parent through the visibility-scoped
 * `GET /annotations/:id` and records the answer with `resolveForeignParent`.
 */
import { parseHunks } from '../annotations/criticmarkup'
import {
  HIGHLIGHT_ROLE_LABELS,
  highlightRole,
  type HighlightRole,
} from '../../packages/margin/src/palette'
import { DELETED_NOTE_TEXT, serverIdFromIri } from '../../packages/margin/src/records'
import { decodeSketch, noteText, type Sketch } from '../../packages/margin/src/sketch'
import { DELETED_REPLY_TEXT, UNNAMED_PARTICIPANT } from '../../packages/margin/src/threads'

export const MARGIN_ROUTE = '/api/margin/v1'
export const MINE_ROUTE = `${MARGIN_ROUTE}/mine`

/** One page of the book an annotation can be on. */
export type OverviewPage = {
  /** The node id; `book` for the front page, `other` for the catch-all. */
  id: string
  title: string
  /** Absolute path, ending in `/`; empty for the catch-all group. */
  path: string
}

export const FRONT_PAGE_ID = 'book'
export const FRONT_PAGE_TITLE = 'Book front page'
export const OTHER_PAGES_ID = 'other'
export const OTHER_PAGES_TITLE = 'Other pages'

export const OVERVIEW_KINDS = ['highlight', 'note', 'sketch', 'proposal'] as const
export type OverviewKind = (typeof OVERVIEW_KINDS)[number]

export const KIND_LABELS: Record<OverviewKind, string> = {
  highlight: 'Highlight',
  note: 'Note',
  sketch: 'Sketch',
  proposal: 'Proposal',
}

/**
 * Only the states the service records. "Applied" waits for issue 060, which
 * is what would record it; nothing can be applied before then.
 */
export type ProposalState = 'pending' | 'withdrawn'

export const PROPOSAL_STATE_LABELS: Record<ProposalState, string> = {
  pending: 'Pending',
  withdrawn: 'Withdrawn',
}

export const HIDDEN_PARENT_TEXT = 'Reply to a note you can no longer see'

export type OverviewReply = {
  id: string
  body: string
  created: string
  deleted: boolean
}

/**
 * Somebody else's note the reader replied to. `pending` until the page has
 * asked; `visible` with the note, `hidden` when the service says it is not
 * there for this reader (gone, or not theirs to read), `unavailable` when the
 * question could not be answered.
 */
export type ForeignParent =
  | { id: string; state: 'pending' | 'hidden' | 'unavailable' }
  | {
      id: string
      state: 'visible'
      creatorName: string
      quote: string
      body: string
      deleted: boolean
    }

export type OverviewEntry = {
  /** The bare server id: the reader's annotation, or for a foreign thread its parent's. */
  id: string
  kind: OverviewKind
  quote: string
  /** The note's text, a sketch's caption, or a proposal's CriticMarkup; '' for a highlight. */
  body: string
  sketch: Sketch | null
  color: { role: HighlightRole; label: string } | null
  created: string
  visibility: 'public' | 'private'
  proposalState: ProposalState | null
  deleted: boolean
  /** Set when the entry is somebody else's note holding the reader's replies. */
  foreign: ForeignParent | null
  replies: OverviewReply[]
  /** The page the annotation is on. */
  path: string
  /** That page, with `?annotation=<id>` of the reader's own row: the rail lands on it. */
  href: string
  /** The reader's row as the service sent it, for re-anchoring and for the parent lookup. */
  wire: WireAnnotation
}

export type OverviewGroup = { page: OverviewPage; entries: OverviewEntry[] }

/** The parts of a Web Annotation this page reads. Everything is optional. */
export type WireAnnotation = {
  id?: unknown
  motivation?: unknown
  body?: { value?: unknown } | null
  target?: { source?: unknown; selector?: unknown } | null
  created?: unknown
  'margin:visibility'?: unknown
  'margin:color'?: unknown
  'margin:parentId'?: unknown
  'margin:deleted'?: unknown
  'margin:withdrawnAt'?: unknown
  'margin:creatorName'?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function quoteOf(wire: WireAnnotation): string {
  const selectors = Array.isArray(wire.target?.selector) ? wire.target.selector : []
  const quote = selectors.find(
    (selector: unknown) =>
      (selector as { type?: unknown } | null)?.type === 'TextQuoteSelector',
  ) as { exact?: unknown } | undefined
  return text(quote?.exact)
}

/** The path of the document an annotation is on, or `null` if it is not a URL. */
export function documentPath(wire: WireAnnotation): string | null {
  try {
    return new URL(text(wire.target?.source)).pathname
  } catch {
    return null
  }
}

/** A proposal's change as a reader writes it: each hunk's CriticMarkup. */
function proposalText(body: string): string {
  try {
    return parseHunks(body)
      .map((hunk) => hunk.criticMarkup)
      .join('\n\n')
  } catch {
    // A proposal from before hunks were stored is free text already.
    return body
  }
}

function replyFor(wire: WireAnnotation, id: string): OverviewReply {
  const deleted = wire['margin:deleted'] === true
  return {
    id,
    body: deleted ? DELETED_REPLY_TEXT : noteText(text(wire.body?.value)),
    created: text(wire.created),
    deleted,
  }
}

function entryFor(wire: WireAnnotation, path: string, id: string): OverviewEntry | null {
  const motivation = text(wire.motivation)
  const deleted = wire['margin:deleted'] === true
  const raw = text(wire.body?.value)
  const sketch = motivation === 'commenting' && !deleted ? decodeSketch(raw) : null
  const kind: OverviewKind | null =
    motivation === 'highlighting'
      ? 'highlight'
      : motivation === 'editing'
        ? 'proposal'
        : motivation === 'commenting'
          ? sketch
            ? 'sketch'
            : 'note'
          : null
  if (!kind) return null
  const stored = text(wire['margin:color'])
  const color =
    kind === 'highlight' || (kind !== 'proposal' && stored)
      ? { role: highlightRole(stored), label: HIGHLIGHT_ROLE_LABELS[highlightRole(stored)] }
      : null
  return {
    id,
    kind,
    quote: quoteOf(wire),
    body:
      kind === 'highlight'
        ? ''
        : deleted
          ? DELETED_NOTE_TEXT
          : kind === 'proposal'
            ? proposalText(raw)
            : noteText(raw),
    sketch,
    color,
    created: text(wire.created),
    visibility: wire['margin:visibility'] === 'public' ? 'public' : 'private',
    proposalState:
      kind === 'proposal' ? (text(wire['margin:withdrawnAt']) ? 'withdrawn' : 'pending') : null,
    deleted,
    foreign: null,
    replies: [],
    path,
    href: hrefFor(path, id),
    wire,
  }
}

function hrefFor(path: string, id: string): string {
  return `${path}?annotation=${encodeURIComponent(id)}`
}

/**
 * Group the reader's rows: the front page's first, then the manifest's nodes
 * in `nodes` order, then every other path under the prefix in one final
 * group. Groups with nothing in them are left out.
 */
export function buildOverview(
  wires: readonly WireAnnotation[],
  book: { frontPage: string; nodes: readonly OverviewPage[] },
): OverviewGroup[] {
  const front: OverviewGroup = {
    page: { id: FRONT_PAGE_ID, title: FRONT_PAGE_TITLE, path: book.frontPage },
    entries: [],
  }
  const other: OverviewGroup = {
    page: { id: OTHER_PAGES_ID, title: OTHER_PAGES_TITLE, path: '' },
    entries: [],
  }
  const byPath = new Map<string, OverviewGroup>([[book.frontPage, front]])
  const nodes = book.nodes.map((page) => ({ page, entries: [] as OverviewEntry[] }))
  for (const group of nodes) byPath.set(group.page.path, group)
  const groupFor = (path: string) => byPath.get(path) ?? other

  const byId = new Map<string, OverviewEntry>()
  const replies: { wire: WireAnnotation; id: string; parentId: string; path: string }[] = []

  for (const wire of wires) {
    const id = serverIdFromIri(text(wire.id))
    const path = documentPath(wire)
    if (!id || !path) continue
    const parent = text(wire['margin:parentId'])
    if (parent) {
      replies.push({ wire, id, parentId: serverIdFromIri(parent), path })
      continue
    }
    const entry = entryFor(wire, path, id)
    if (!entry) continue
    byId.set(id, entry)
    groupFor(path).entries.push(entry)
  }

  // A reply goes under the first of the reader's own annotations up its
  // chain, however deep the thread. A chain that leaves the reader's rows
  // ends at somebody else's note: one foreign entry per such note holds every
  // reply of the reader's under it.
  const parentOf = new Map(replies.map((reply) => [reply.id, reply.parentId]))
  const foreign = new Map<string, OverviewEntry>()
  for (const reply of replies) {
    let rootId = reply.parentId
    const seen = new Set<string>()
    while (!byId.has(rootId) && parentOf.has(rootId) && !seen.has(rootId)) {
      seen.add(rootId)
      rootId = parentOf.get(rootId)!
    }
    const own = byId.get(rootId)
    if (own) {
      own.replies.push(replyFor(reply.wire, reply.id))
      continue
    }
    let thread = foreign.get(rootId)
    if (!thread) {
      thread = {
        id: rootId,
        kind: 'note',
        quote: quoteOf(reply.wire),
        body: '',
        sketch: null,
        color: null,
        created: text(reply.wire.created),
        visibility: reply.wire['margin:visibility'] === 'public' ? 'public' : 'private',
        proposalState: null,
        deleted: false,
        foreign: { id: rootId, state: 'pending' },
        replies: [],
        path: reply.path,
        href: hrefFor(reply.path, reply.id),
        wire: reply.wire,
      }
      foreign.set(rootId, thread)
      groupFor(reply.path).entries.push(thread)
    }
    thread.replies.push(replyFor(reply.wire, reply.id))
  }

  const groups = [front, ...nodes, other]
  for (const group of groups) {
    group.entries.sort(byCreated)
    for (const entry of group.entries) entry.replies.sort(byCreated)
  }
  return groups.filter((group) => group.entries.length > 0)
}

function byCreated(a: { created: string; id: string }, b: { created: string; id: string }) {
  return a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The visibility-scoped read of one annotation: the reader's or anybody's public one. */
export function parentRequestUrl(entry: OverviewEntry): string {
  return `${MARGIN_ROUTE}/annotations/${encodeURIComponent(entry.foreign?.id ?? entry.id)}?source=${encodeURIComponent(text(entry.wire.target?.source))}`
}

/**
 * What the service said about a foreign parent. A 404 is the same answer for
 * a note that is gone and one this reader may not read, and the page says the
 * same thing for both.
 */
export function resolveForeignParent(
  entry: OverviewEntry,
  response: { status: number; body: unknown } | null,
): void {
  if (!entry.foreign) return
  const id = entry.foreign.id
  if (!response || (response.status >= 500 && response.status <= 599)) {
    entry.foreign = { id, state: 'unavailable' }
    return
  }
  if (response.status < 200 || response.status > 299) {
    entry.foreign = { id, state: 'hidden' }
    return
  }
  const wire = (response.body ?? {}) as WireAnnotation
  const deleted = wire['margin:deleted'] === true
  entry.foreign = {
    id,
    state: 'visible',
    creatorName: text(wire['margin:creatorName']) || UNNAMED_PARTICIPANT,
    quote: quoteOf(wire),
    body: deleted ? DELETED_NOTE_TEXT : noteText(text(wire.body?.value)),
    deleted,
  }
  if (entry.foreign.quote) entry.quote = entry.foreign.quote
}

export type OverviewFilter = { kind: OverviewKind | 'all'; page: string | 'all' }

export function matchesFilter(
  entry: OverviewEntry,
  page: OverviewPage,
  filter: OverviewFilter,
): boolean {
  return (
    (filter.kind === 'all' || entry.kind === filter.kind) &&
    (filter.page === 'all' || page.id === filter.page)
  )
}

/** Every row under `prefix`, following `nextCursor`, with the same loop guard as the rail. */
export async function fetchMine(
  site: string,
  prefix: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<{ status: 'ok'; annotations: WireAnnotation[] } | { status: 'signed-out' } | { status: 'failed' }> {
  const annotations: WireAnnotation[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const query = new URLSearchParams({ site, prefix, limit: '200', ...(cursor ? { cursor } : {}) })
    let response: Response
    try {
      response = await fetchImpl(`${MINE_ROUTE}?${query}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
    } catch {
      return { status: 'failed' }
    }
    if (response.status === 401 || response.status === 403) return { status: 'signed-out' }
    if (!response.ok) return { status: 'failed' }
    const body = (await response.json().catch(() => null)) as {
      annotations?: WireAnnotation[]
      nextCursor?: string
    } | null
    if (!body) return { status: 'failed' }
    annotations.push(...(body.annotations ?? []))
    if (!body.nextCursor || cursors.has(body.nextCursor)) break
    cursors.add(body.nextCursor)
    cursor = body.nextCursor
  }
  return { status: 'ok', annotations }
}
