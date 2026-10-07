/**
 * The per-book Annotations page (issue 073), minus the DOM.
 *
 * The page fetches the reader's own annotations under the book's path from
 * `GET /api/margin/v1/mine`, which knows nothing about books and answers in
 * `(document, created, id)` order. This module turns those rows into what the
 * page draws: the book's front page first, then one group per manifest node in
 * the book's own order, then everything else under the prefix in one "Other
 * pages" group, so no row is dropped.
 *
 * Anything the rail already derives is derived here with the rail's own
 * functions, so the two never disagree: colours through `highlightRole()`,
 * sketches through `decodeSketch()`, threads through `replyFromWebAnnotation`
 * and `indexThreads`. Each entry carries only the fields its kind has on the
 * wire; nothing is invented for a missing one.
 *
 * A reply to somebody else's note is the reader's, but its parent is not, and
 * `/mine` never returns it. Such replies are gathered per parent into a
 * `foreign` entry; the page asks for the parent through the visibility-scoped
 * `GET /annotations/:id?source=<the reply's source>` and records the answer
 * with `resolveForeignParent`.
 */
import { parseCriticMarkup, parseHunks } from '../annotations/criticmarkup'
import {
  HIGHLIGHT_ROLE_LABELS,
  highlightRole,
  type HighlightRole,
} from '../../packages/margin/src/palette'
import {
  PROPOSAL_STATE_LABELS,
  PROPOSAL_STATES,
  proposalStateOf,
  serverIdFromIri,
  type ProposalState,
} from '../../packages/margin/src/records'
import { decodeSketch, noteText, type Sketch } from '../../packages/margin/src/sketch'
import { prefixByCodePoints } from '../../packages/margin/src/text'
import {
  indexThreads,
  replyFromWebAnnotation,
  UNNAMED_PARTICIPANT,
  type ThreadEntry,
  type ThreadReply,
} from '../../packages/margin/src/threads'

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

export const DELETED_NOTE_LABEL = 'Deleted note'
export const UNPARSED_PROPOSAL = 'Proposed change'
export const SUMMARY_LENGTH = 120

// Proposal states and their labels are the rail's (`records.ts`), so the
// two never disagree about where a proposal stands.
export { PROPOSAL_STATE_LABELS, PROPOSAL_STATES, proposalStateOf, type ProposalState }

/**
 * What a proposal changes, in a line: the text it inserts (`{++…++}` and the
 * new side of `{~~old~>new~~}`); for one that only deletes, "Deletes:" and
 * what it deletes. Cut to `SUMMARY_LENGTH` code points. `null` when the markup
 * cannot be parsed, which the page shows as "Proposed change".
 */
export function proposalSummary(body: string): string | null {
  const inserted: string[] = []
  const deleted: string[] = []
  try {
    for (const hunk of parseHunks(body)) {
      for (const segment of parseCriticMarkup(hunk.criticMarkup)) {
        if (segment.kind === 'insert') inserted.push(segment.text)
        else if (segment.kind === 'delete') deleted.push(segment.text)
        else if (segment.kind === 'substitute') {
          inserted.push(segment.new)
          deleted.push(segment.old)
        }
      }
    }
  } catch {
    return null
  }
  const squash = (parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim()
  const insertedText = squash(inserted)
  if (insertedText) return prefixByCodePoints(insertedText, SUMMARY_LENGTH)
  const deletedText = squash(deleted)
  if (deletedText) return `Deletes: ${prefixByCodePoints(deletedText, SUMMARY_LENGTH)}`
  return null
}

export type OverviewColor = { role: HighlightRole; label: string }

function colorFor(stored: unknown): OverviewColor {
  const role = highlightRole(typeof stored === 'string' ? stored : null)
  return { role, label: HIGHLIGHT_ROLE_LABELS[role] }
}

/** Fields by kind: each kind has exactly what the wire gives it. */
export type OverviewFields =
  | { kind: 'highlight'; color: OverviewColor }
  | { kind: 'note'; body: string; color: OverviewColor | null; deleted: false }
  | { kind: 'note'; deleted: true }
  | { kind: 'sketch'; note: string; sketch: Sketch }
  | { kind: 'proposal'; summary: string | null; state: ProposalState }

/**
 * Somebody else's annotation the reader replied to. `pending` until the page
 * has asked; `visible` with what the service returned; `failed` when it could
 * not be read (offline, an error), and the reader's replies stand on their own.
 */
export type ForeignParent =
  | { id: string; state: 'pending' | 'failed' }
  | {
      id: string
      state: 'visible'
      creatorName: string
      quote: string
      body: string | null
      deleted: boolean
      /** Set when the parent is itself a reply: its thread lives at `threadHref`. */
      isReply: boolean
      threadHref: string
    }

export type OverviewEntry = {
  /** The bare server id: the reader's annotation, or for a foreign thread its parent's. */
  id: string
  kind: OverviewKind
  quote: string
  created: string
  /** Absent on a foreign entry: the reader's rows are its replies. */
  fields: OverviewFields | null
  foreign: ForeignParent | null
  /** The reader's replies under it, in the rail's flattened order. */
  thread: ThreadEntry[]
  /** The stored document's path. */
  path: string
  /** Its stored document with `annotation=<id>` of the reader's own row. */
  href: string
  /** The reader's row this entry links to, as the service sent it. */
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
  'margin:proposalState'?: unknown
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

/**
 * The stored document with `annotation=<id>` added, as a same-site link: an
 * existing query and fragment survive. `/mine` is scoped to this site, so the
 * origin is this page's.
 */
export function linkTo(source: string, id: string): string {
  const url = new URL(source)
  url.searchParams.set('annotation', id)
  return `${url.pathname}${url.search}${url.hash}`
}

function fieldsFor(wire: WireAnnotation): OverviewFields | null {
  const motivation = text(wire.motivation)
  if (motivation === 'highlighting') {
    return { kind: 'highlight', color: colorFor(wire['margin:color']) }
  }
  if (motivation === 'editing') {
    return {
      kind: 'proposal',
      summary: proposalSummary(text(wire.body?.value)),
      state: proposalStateOf(wire),
    }
  }
  if (motivation !== 'commenting') return null
  if (wire['margin:deleted'] === true) return { kind: 'note', deleted: true }
  const raw = text(wire.body?.value)
  const sketch = decodeSketch(raw)
  if (sketch) return { kind: 'sketch', note: sketch.note, sketch }
  return {
    kind: 'note',
    body: noteText(raw),
    color: wire['margin:color'] === undefined ? null : colorFor(wire['margin:color']),
    deleted: false,
  }
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

  const roots = new Map<string, OverviewEntry>()
  const replies: { reply: ThreadReply; wire: WireAnnotation; path: string }[] = []

  for (const wire of wires) {
    const id = serverIdFromIri(text(wire.id))
    const path = documentPath(wire)
    if (!id || !path) continue
    // The rail's own reading of a reply.
    const reply = replyFromWebAnnotation(wire, null)
    if (reply) {
      replies.push({ reply, wire, path })
      continue
    }
    // A row that names a parent but that the rail cannot read as a reply is
    // still the reader's: it stands as an entry of its own, never dropped.
    const fields = fieldsFor(wire)
    if (!fields) continue
    const entry: OverviewEntry = {
      id,
      kind: fields.kind,
      quote: quoteOf(wire),
      created: text(wire.created),
      fields,
      foreign: null,
      thread: [],
      path,
      href: linkTo(text(wire.target?.source), id),
      wire,
    }
    roots.set(id, entry)
    groupFor(path).entries.push(entry)
  }

  // The rail's index over every reply of the reader's. A reply chain that
  // reaches one of the reader's own roots is that root's thread; one that
  // leaves the reader's rows ends at somebody else's annotation, and one
  // foreign entry per such annotation holds the reader's replies under it.
  const index = indexThreads(replies.map(({ reply }) => reply))
  const parentOf = new Map(replies.map(({ reply }) => [reply.serverId, reply.parentId]))
  const foreign = new Map<string, OverviewEntry>()
  for (const { reply, wire, path } of replies) {
    let rootId = reply.parentId
    const seen = new Set<string>()
    while (!roots.has(rootId) && parentOf.has(rootId) && !seen.has(rootId)) {
      seen.add(rootId)
      rootId = parentOf.get(rootId)!
    }
    if (roots.has(rootId) || foreign.has(rootId)) continue
    const thread: OverviewEntry = {
      id: rootId,
      kind: 'note',
      quote: quoteOf(wire),
      created: text(wire.created),
      fields: null,
      foreign: { id: rootId, state: 'pending' },
      thread: [],
      path,
      href: linkTo(text(wire.target?.source), reply.serverId),
      wire,
    }
    foreign.set(rootId, thread)
    groupFor(path).entries.push(thread)
  }
  for (const entry of [...roots.values(), ...foreign.values()]) {
    entry.thread = index.flatten(entry.id)
  }

  const groups = [front, ...nodes, other]
  for (const group of groups) group.entries.sort(byCreated)
  return groups.filter((group) => group.entries.length > 0)
}

function byCreated(a: { created: string; id: string }, b: { created: string; id: string }) {
  return a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The visibility-scoped read of a foreign parent. The item route needs a
 * scope; the parent is on the same document as the reader's reply, so the
 * reply's own source is it.
 */
export function parentRequestUrl(entry: OverviewEntry): string {
  return `${MARGIN_ROUTE}/annotations/${encodeURIComponent(entry.foreign?.id ?? entry.id)}?source=${encodeURIComponent(text(entry.wire.target?.source))}`
}

/** What the service said about a foreign parent. */
export function resolveForeignParent(
  entry: OverviewEntry,
  response: { status: number; body: unknown } | null,
): void {
  if (!entry.foreign) return
  const id = entry.foreign.id
  if (!response || response.status < 200 || response.status > 299) {
    entry.foreign = { id, state: 'failed' }
    return
  }
  const wire = (response.body ?? {}) as WireAnnotation
  const deleted = wire['margin:deleted'] === true
  const source = text(wire.target?.source) || text(entry.wire.target?.source)
  entry.foreign = {
    id,
    state: 'visible',
    creatorName: text(wire['margin:creatorName']) || UNNAMED_PARTICIPANT,
    quote: quoteOf(wire),
    body: deleted ? null : noteText(text(wire.body?.value)),
    deleted,
    isReply: Boolean(text(wire['margin:parentId'])),
    threadHref: linkTo(source, id),
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

export type OverviewReader =
  | { status: 'signed-in'; identity: string }
  | { status: 'signed-out' }
  | { status: 'failed' }

/** Interpret `/auth/me` for display only; the service still authorizes every read. */
export function readOverviewReader(value: unknown): OverviewReader {
  if (!isObject(value)) return { status: 'failed' }
  const { authenticated, principal } = value
  if (authenticated === false && (principal === undefined || principal === null)) {
    return { status: 'signed-out' }
  }
  if (authenticated !== true || !isObject(principal)) return { status: 'failed' }
  const identity = [principal.provider, principal.issuer, principal.subject]
  if (!identity.every((part) => typeof part === 'string' && part.length > 0)) {
    return { status: 'failed' }
  }
  return { status: 'signed-in', identity: JSON.stringify(identity) }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Minimum row shape that the overview can display, including its actual source. */
function readableRow(value: unknown, site: string, prefix: string): value is WireAnnotation {
  if (!isObject(value) || typeof value.id !== 'string' || !serverIdFromIri(value.id)) return false
  if (typeof value.motivation !== 'string' || !['highlighting', 'commenting', 'editing'].includes(value.motivation)) return false
  if (!isObject(value.target) || typeof value.target.source !== 'string') return false
  try {
    const source = new URL(value.target.source)
    return source.origin === site && source.pathname.startsWith(prefix)
  } catch {
    return false
  }
}

export type MineResult =
  | { status: 'ok'; annotations: WireAnnotation[] }
  /** The first request failed: nothing is known, which is not "nothing". */
  | { status: 'failed' }
  /** Resume the uncommitted page; remember completed cursors across retries. */
  | { status: 'partial'; annotations: WireAnnotation[]; cursor: string; completedCursors: string[] }

/**
 * Read whole valid pages only. A malformed or looping page remains uncommitted,
 * so Retry can fetch it again without duplicating rows already on screen.
 * API errors are load errors; only `/auth/me` establishes the sign-in prompt.
 */
export async function fetchMine(
  site: string,
  prefix: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  from?: string,
  completedCursors: readonly string[] = [],
): Promise<MineResult> {
  const annotations: WireAnnotation[] = []
  const completed = new Set(completedCursors)
  let cursor = from
  for (;;) {
    const query = new URLSearchParams({ site, prefix, limit: '200', ...(cursor ? { cursor } : {}) })
    const failed = (): MineResult =>
      cursor
        ? { status: 'partial', annotations, cursor, completedCursors: [...completed] }
        : { status: 'failed' }
    let body: unknown
    try {
      const response = await fetchImpl(`${MINE_ROUTE}?${query}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return failed()
      body = await response.json()
    } catch {
      return failed()
    }
    if (!isObject(body) || !Array.isArray(body.annotations) ||
      !body.annotations.every((row) => readableRow(row, site, prefix))) return failed()
    const next = body.nextCursor
    if (next !== undefined && (typeof next !== 'string' || next.length === 0)) return failed()
    if (typeof next === 'string' && (next === cursor || completed.has(next))) return failed()
    annotations.push(...body.annotations)
    if (cursor) completed.add(cursor)
    if (next === undefined) return { status: 'ok', annotations }
    cursor = next
  }
}
