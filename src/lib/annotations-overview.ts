/**
 * The per-book Annotations page (issue 073), minus the DOM.
 *
 * The page fetches the reader's own annotations under the book's path from
 * `GET /api/margin/v1/mine`, which knows nothing about books and answers in
 * `(document, created, id)` order. This module turns those rows into what the
 * page draws: one group per page of the book, in the book's own order (the
 * manifest's, handed over by the page), each entry carrying its kind, quote,
 * note, colour, date and a link back to its spot, with replies under their
 * parent rather than beside it.
 *
 * Kinds follow the rail: a `commenting` body that decodes as a sketch is a
 * sketch, and one that does not is a plain note, whatever it starts with.
 */
import { parseHunks } from '../annotations/criticmarkup'
import {
  HIGHLIGHT_ROLE_LABELS,
  highlightRole,
  type HighlightRole,
} from '../../packages/margin/src/palette'
import { DELETED_NOTE_TEXT, serverIdFromIri } from '../../packages/margin/src/records'
import { decodeSketch, noteText, type Sketch } from '../../packages/margin/src/sketch'
import { DELETED_REPLY_TEXT } from '../../packages/margin/src/threads'

export const MINE_ROUTE = '/api/margin/v1/mine'

/** One page of the book an annotation can be on, in reading order. */
export type OverviewPage = {
  /** The node id, or `book` / `map` for the book's own pages. */
  id: string
  title: string
  /** Absolute path, ending in `/`. */
  path: string
}

export const OVERVIEW_KINDS = ['highlight', 'note', 'sketch', 'proposal'] as const
export type OverviewKind = (typeof OVERVIEW_KINDS)[number]

export const KIND_LABELS: Record<OverviewKind, string> = {
  highlight: 'Highlight',
  note: 'Note',
  sketch: 'Sketch',
  proposal: 'Proposal',
}

export type ProposalState = 'pending' | 'withdrawn' | 'applied'

export const PROPOSAL_STATE_LABELS: Record<ProposalState, string> = {
  pending: 'Pending',
  withdrawn: 'Withdrawn',
  applied: 'Applied',
}

export type OverviewReply = {
  id: string
  body: string
  created: string
  deleted: boolean
}

export type OverviewEntry = {
  /** The bare server id, as `?annotation=` takes it. */
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
  /** Set on a reply whose parent is not the reader's: it stands on its own. */
  isReply: boolean
  replies: OverviewReply[]
  /** The chapter, with `?annotation=<id>`: the rail lands on it. */
  href: string
  /** The row as the service sent it, for re-anchoring on the page. */
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
  'margin:appliedAt'?: unknown
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

function proposalState(wire: WireAnnotation): ProposalState {
  // `margin:appliedAt` is 060's; nothing sends it yet, and a proposal reads as
  // applied the day something does.
  if (text(wire['margin:appliedAt'])) return 'applied'
  if (text(wire['margin:withdrawnAt'])) return 'withdrawn'
  return 'pending'
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
    proposalState: kind === 'proposal' ? proposalState(wire) : null,
    deleted,
    isReply: false,
    replies: [],
    href: `${path}?annotation=${encodeURIComponent(id)}`,
    wire,
  }
}

/**
 * Group the reader's rows by page, in `pages` order. Rows on a path under the
 * book that no page names (a page since removed, say) still show, after the
 * book's pages, under their path: an annotation is never dropped.
 */
export function buildOverview(
  wires: readonly WireAnnotation[],
  pages: readonly OverviewPage[],
): OverviewGroup[] {
  const groups = new Map<string, OverviewGroup>()
  for (const page of pages) groups.set(page.path, { page, entries: [] })

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
    groupFor(groups, path).entries.push(entry)
  }

  // A reply goes under its parent, however deep the thread: up the chain to
  // the first entry this page has. A reply to somebody else's note has none
  // here, and stands as an entry of its own, marked as a reply.
  const parentOf = new Map(replies.map((reply) => [reply.id, reply.parentId]))
  for (const reply of replies) {
    let parentId: string | undefined = reply.parentId
    const seen = new Set<string>()
    while (parentId && !byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId)
      parentId = parentOf.get(parentId)
    }
    const parent = parentId ? byId.get(parentId) : undefined
    const deleted = reply.wire['margin:deleted'] === true
    if (parent) {
      parent.replies.push({
        id: reply.id,
        body: deleted ? DELETED_REPLY_TEXT : noteText(text(reply.wire.body?.value)),
        created: text(reply.wire.created),
        deleted,
      })
      continue
    }
    const entry = entryFor(reply.wire, reply.path, reply.id)
    if (!entry) continue
    entry.isReply = true
    groupFor(groups, reply.path).entries.push(entry)
  }

  for (const group of groups.values()) {
    group.entries.sort(byCreated)
    for (const entry of group.entries) entry.replies.sort(byCreated)
  }
  return [...groups.values()].filter((group) => group.entries.length > 0)
}

function groupFor(groups: Map<string, OverviewGroup>, path: string): OverviewGroup {
  let group = groups.get(path)
  if (!group) {
    group = { page: { id: path, title: path, path }, entries: [] }
    groups.set(path, group)
  }
  return group
}

function byCreated(a: { created: string; id: string }, b: { created: string; id: string }) {
  return a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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
