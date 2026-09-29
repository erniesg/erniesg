import { z } from 'zod'

/**
 * Reading progress: the wire shape, its limits, and the rows it becomes.
 *
 * The shape is the one every edition of the book shares — the local preview's
 * `books/workspace/progress.json`, the site's browser storage and "Export
 * progress" (`books/tools/runtime/progress.mjs`):
 *
 *   { version: 1, book, solved: [id], solvedAt: { id: iso }, drafts: { id: { code, updatedAt } } }
 *
 * A browser or a file is read leniently there, dropping what it cannot use.
 * The service is strict: a request with anything invalid is refused whole, so a
 * write is either what the caller sent or nothing.
 */

/** The same bound `progress.mjs` holds a draft to, and the column's CHECK. */
export const MAX_PROGRESS_DRAFT_LENGTH = 20000
/** A book has about ninety items; a client sends only what changed. */
export const MAX_PROGRESS_ITEMS_PER_REQUEST = 200
/** Rows one reader may hold for one book. */
export const MAX_PROGRESS_ITEMS_PER_BOOK = 1000
/** Raw request bytes, checked before parsing. */
export const MAX_PROGRESS_BODY_BYTES = 2 * 1024 * 1024

const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,127}$/
const BOOK_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

const itemId = z.string().regex(ITEM_ID)
const timestamp = z
  .string()
  .regex(ISO_TIME)
  .refine((value) => !Number.isNaN(Date.parse(value)))

const draftSchema = z
  .object({ code: z.string(), updatedAt: timestamp })
  .strict()

export const progressBodySchema = z
  .object({
    version: z.literal(1).optional(),
    book: z.string().optional(),
    solved: z.array(itemId).default([]),
    solvedAt: z.record(z.string(), timestamp).default({}),
    drafts: z.record(itemId, draftSchema).default({}),
  })
  .strict()

export type ProgressScope = { site: string; book: string }

/** One item as the merge statement takes it. */
export type ProgressItem = {
  item: string
  solved: boolean
  solvedAt: string | null
  draft: string | null
  draftUpdated: string | null
}

/** One stored row, as the repository returns it. */
export type ProgressRow = ProgressItem

export type ProgressWire = {
  version: 1
  book: string
  solved: string[]
  solvedAt: Record<string, string>
  drafts: Record<string, { code: string; updatedAt: string }>
}

export type Refusal = { status: 400 | 413; code: string; message: string }

/** `?site=<origin>&book=<slug>`, or why not. The site is an origin and only that. */
export function readProgressScope(url: URL): ProgressScope | Refusal {
  const site = url.searchParams.get('site') ?? ''
  const book = url.searchParams.get('book') ?? ''
  let origin: string | null = null
  try {
    const parsed = new URL(site)
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === site) {
      origin = parsed.origin
    }
  } catch {
    origin = null
  }
  if (!origin) {
    return { status: 400, code: 'invalid_site', message: 'site must be an http(s) origin with no path' }
  }
  if (!BOOK_SLUG.test(book) || book.length > 128) {
    return { status: 400, code: 'invalid_book', message: 'book must be a url-safe slug' }
  }
  return { site: origin, book }
}

/** Every time the service stores has one spelling, so text comparison orders it. */
function canonical(value: string, now: string): string {
  const time = new Date(value).toISOString()
  // A clock ahead of the server's must not win every later merge.
  return time > now ? now : time
}

/** The request body as items to merge, or why it is refused. */
export function parseProgressBody(text: string, now: string): ProgressItem[] | Refusal {
  if (new TextEncoder().encode(text).length > MAX_PROGRESS_BODY_BYTES) {
    return { status: 413, code: 'too_large', message: 'progress is larger than any book needs' }
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { status: 400, code: 'malformed_json', message: 'the request body is not JSON' }
  }
  const parsed = progressBodySchema.safeParse(payload)
  if (!parsed.success) {
    return { status: 400, code: 'invalid_progress', message: 'the body is not progress in the shared shape' }
  }
  const { solved, solvedAt, drafts } = parsed.data
  for (const draft of Object.values(drafts)) {
    if (draft.code.length > MAX_PROGRESS_DRAFT_LENGTH) {
      return {
        status: 413,
        code: 'draft_too_large',
        message: `a draft may be at most ${MAX_PROGRESS_DRAFT_LENGTH} characters`,
      }
    }
  }
  const ids = [...new Set([...solved, ...Object.keys(drafts)])].sort()
  if (ids.length > MAX_PROGRESS_ITEMS_PER_REQUEST) {
    return {
      status: 413,
      code: 'too_many_items',
      message: `send at most ${MAX_PROGRESS_ITEMS_PER_REQUEST} items at a time`,
    }
  }
  const solvedSet = new Set(solved)
  return ids.map((item) => {
    const isSolved = solvedSet.has(item)
    const at = isSolved ? solvedAt[item] : undefined
    const draft = drafts[item]
    return {
      item,
      solved: isSolved,
      solvedAt: at ? canonical(at, now) : null,
      draft: draft ? draft.code : null,
      draftUpdated: draft ? canonical(draft.updatedAt, now) : null,
    }
  })
}

export function progressToWire(book: string, rows: ProgressRow[]): ProgressWire {
  const wire: ProgressWire = { version: 1, book, solved: [], solvedAt: {}, drafts: {} }
  for (const row of [...rows].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))) {
    if (row.solved) {
      wire.solved.push(row.item)
      if (row.solvedAt) wire.solvedAt[row.item] = row.solvedAt
    }
    if (row.draft !== null && row.draftUpdated) {
      wire.drafts[row.item] = { code: row.draft, updatedAt: row.draftUpdated }
    }
  }
  return wire
}
