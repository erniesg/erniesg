/**
 * What a reader has finished in a book, and the code they left in each editor.
 *
 * One shape everywhere: the local preview's `books/workspace/progress.json`,
 * the published site's browser storage, the margin service's copy for a
 * signed-in reader, and the file "Export progress" downloads. So a file from
 * one imports into any other.
 *
 *   {
 *     "version": 1,
 *     "book": "build-a-coding-agent",
 *     "solved": ["ch03-last-three", "sum-of-two-digits"],
 *     "solvedAt": { "ch03-last-three": "2026-09-28T09:00:00.000Z" },
 *     "drafts": { "ch03-one-copy": { "code": "...", "updatedAt": "..." } }
 *   }
 *
 * `solved` stays a list of ids because that is what the preview has always
 * written; a file with nothing but `{"solved": [...]}` is still valid.
 *
 * Merging two copies never loses a solve and never picks a draft by accident:
 * solved is the union with the earliest known time, and a draft is the one
 * written last. Two drafts with the same time are ordered by their code, by
 * code point, so every copy and the service pick the same one whatever order
 * they meet in. `books/tools/progress.py`
 * mirrors these rules and `progress-fixtures.json` holds both to them.
 *
 * Plain JavaScript with no imports, because two very different hosts load it:
 * the preview serves it as a module file, and the site bundles it.
 */

export const PROGRESS_VERSION = 1

/** Long enough for any solution in the book, short enough to keep storage bounded. */
export const MAX_DRAFT_LENGTH = 20000

/** A node or exercise id as the book writes them: `ch03-last-three`, `sum-of-two-digits`. */
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/

const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

export function isItemId(value) {
  return typeof value === 'string' && ID.test(value)
}

function isTimestamp(value) {
  return typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function emptyProgress(book) {
  return { version: PROGRESS_VERSION, book, solved: [], solvedAt: {}, drafts: {} }
}

function sortedKeys(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]))
}

/**
 * Anything, read as progress for `book`.
 *
 * Invalid pieces are dropped rather than repaired, and a value that is not
 * progress at all is empty progress: a corrupted file or storage entry must
 * never stop the page from loading.
 */
export function normalize(raw, book) {
  const progress = emptyProgress(book)
  if (!isRecord(raw)) return progress
  const solved = new Set(Array.isArray(raw.solved) ? raw.solved.filter(isItemId) : [])
  progress.solved = [...solved].sort()
  const solvedAt = isRecord(raw.solvedAt) ? raw.solvedAt : {}
  for (const id of progress.solved) {
    if (isTimestamp(solvedAt[id])) progress.solvedAt[id] = solvedAt[id]
  }
  const drafts = isRecord(raw.drafts) ? raw.drafts : {}
  for (const [id, draft] of Object.entries(drafts)) {
    if (!isItemId(id) || !isRecord(draft)) continue
    if (typeof draft.code !== 'string' || draft.code.length > MAX_DRAFT_LENGTH) continue
    if (!isTimestamp(draft.updatedAt)) continue
    progress.drafts[id] = { code: draft.code, updatedAt: draft.updatedAt }
  }
  progress.solvedAt = sortedKeys(progress.solvedAt)
  progress.drafts = sortedKeys(progress.drafts)
  return progress
}

function earlier(left, right) {
  if (!left) return right
  if (!right) return left
  return Date.parse(right) < Date.parse(left) ? right : left
}

/** Code-point order, the order SQLite and Python compare text in. */
function compareCode(a, b) {
  const left = [...a]
  const right = [...b]
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index].codePointAt(0) - right[index].codePointAt(0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

/** Positive when `a` should win over `b`: later, or the same time and the larger code. */
export function compareDrafts(a, b) {
  const time = Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
  return time !== 0 ? time : compareCode(a.code, b.code)
}

/** Both copies, combined. The book is `a`'s. */
export function merge(a, b) {
  const left = normalize(a, isRecord(a) && typeof a.book === 'string' ? a.book : '')
  const right = normalize(b, left.book)
  const merged = emptyProgress(left.book)
  merged.solved = [...new Set([...left.solved, ...right.solved])].sort()
  for (const id of merged.solved) {
    const at = earlier(left.solvedAt[id], right.solvedAt[id])
    if (at) merged.solvedAt[id] = at
  }
  const ids = new Set([...Object.keys(left.drafts), ...Object.keys(right.drafts)])
  for (const id of [...ids].sort()) {
    const mine = left.drafts[id]
    const theirs = right.drafts[id]
    merged.drafts[id] =
      mine && (!theirs || compareDrafts(mine, theirs) >= 0)
        ? mine
        : theirs
  }
  return merged
}

/**
 * `mine`, after a store has confirmed it: where the store holds the same code
 * for a draft, its time is the one that counts. A store clamps a time from a
 * clock running ahead, and keeping the unclamped time would make the same
 * draft look newer than the store forever, resent and re-clamped each save.
 */
export function acknowledge(mine, stored) {
  const drafts = { ...mine.drafts }
  for (const [id, draft] of Object.entries(stored.drafts || {})) {
    if (drafts[id] && drafts[id].code === draft.code) drafts[id] = draft
  }
  return merge({ ...mine, drafts }, stored)
}

/** Solved is monotonic: a second solve keeps the first time. */
export function markSolved(progress, id, now) {
  if (!isItemId(id)) return progress
  if (progress.solved.includes(id)) return progress
  return {
    ...progress,
    solved: [...progress.solved, id].sort(),
    solvedAt: sortedKeys({ ...progress.solvedAt, [id]: now }),
  }
}

/** The editor's latest code. A draft too long to store is refused, not cut. */
export function setDraft(progress, id, code, now) {
  if (!isItemId(id) || typeof code !== 'string' || code.length > MAX_DRAFT_LENGTH) return progress
  return {
    ...progress,
    drafts: sortedKeys({ ...progress.drafts, [id]: { code, updatedAt: now } }),
  }
}

export function isSolved(progress, id) {
  return progress.solved.includes(id)
}

/** How far through the book, counting only ids the book actually has. */
export function counts(progress, { exercises = [], challenges = [] }) {
  const solved = new Set(progress.solved)
  const tally = (ids) => ({ solved: ids.filter((id) => solved.has(id)).length, total: ids.length })
  return { exercises: tally(exercises), challenges: tally(challenges) }
}

/** Whether two copies say the same thing, so a sync that changes nothing sends nothing. */
export function sameProgress(a, b) {
  return JSON.stringify(normalize(a, '')) === JSON.stringify(normalize(b, ''))
}

export function storageKey(book) {
  return `book-progress:v${PROGRESS_VERSION}:${book}`
}

/**
 * Browser storage for one book. Every access is guarded: private windows,
 * blocked site data and full quotas all throw, and the page has to work
 * anyway, so a failed read is empty progress and a failed write is `false`.
 */
export function browserStore(book, storage) {
  const key = storageKey(book)
  return {
    load() {
      try {
        const text = storage?.getItem(key)
        return text ? normalize(JSON.parse(text), book) : emptyProgress(book)
      } catch {
        return emptyProgress(book)
      }
    },
    save(progress) {
      try {
        if (!storage) return false
        storage.setItem(key, JSON.stringify(normalize(progress, book)))
        return true
      } catch {
        return false
      }
    },
  }
}
