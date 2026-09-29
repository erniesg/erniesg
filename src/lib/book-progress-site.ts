/**
 * Where a published book keeps a reader's progress.
 *
 * Always in the browser, so it works for everybody and offline. For a
 * signed-in reader the margin service may write for (`canWrite` from
 * `/auth/me`), also in their account, so it follows them to another device.
 * The account copy is merged with the browser copy on every load and written
 * back with only what changed, so neither side ever loses a solve.
 *
 * The page code itself (`books/tools/runtime/book-progress.mjs`) is the same
 * module the local preview runs; this file is only the site's `backend`.
 */
import {
  acknowledge,
  browserStore,
  compareDrafts,
  merge,
  normalize,
  type Progress,
  type StorageLike,
} from '../../books/tools/runtime/progress.mjs'

const PROGRESS_ROUTE = '/api/margin/v1/progress'
const AUTH_ME = '/auth/me'
/** The service refuses larger requests; split rather than fail. */
const ITEMS_PER_REQUEST = 200
/** Well under the service's 2 MiB body cap, leaving room for the envelope. */
const BYTES_PER_REQUEST = 1_500_000
const encoder = new TextEncoder()

type Mode = 'browser' | 'account' | 'account-unreachable'

/**
 * What `next` knows that `base` does not: new solves and newer drafts. `null`
 * when there is nothing to send.
 */
export function changesSince(next: Progress, base: Progress): Progress | null {
  // A solve the base lacks, or one this copy knows happened earlier.
  const solved = next.solved.filter(
    (id) =>
      !base.solved.includes(id) ||
      (next.solvedAt[id] !== undefined &&
        (base.solvedAt[id] === undefined ||
          Date.parse(next.solvedAt[id]) < Date.parse(base.solvedAt[id]))),
  )
  const drafts: Progress['drafts'] = {}
  for (const [id, draft] of Object.entries(next.drafts)) {
    const known = base.drafts[id]
    if (!known || compareDrafts(draft, known) > 0) drafts[id] = draft
  }
  if (solved.length === 0 && Object.keys(drafts).length === 0) return null
  const solvedAt: Progress['solvedAt'] = {}
  for (const id of solved) if (next.solvedAt[id]) solvedAt[id] = next.solvedAt[id]
  return { version: 1, book: next.book, solved, solvedAt, drafts }
}

/** What one item adds to a request body, generously. */
function itemBytes(change: Progress, id: string): number {
  const draft = change.drafts[id]
  return encoder.encode(JSON.stringify({ id, at: change.solvedAt[id], draft })).length + 64
}

/** Split a change into requests the service accepts: by item count and by size. */
export function chunks(change: Progress): Progress[] {
  const ids = [...new Set([...change.solved, ...Object.keys(change.drafts)])].sort()
  const groups: string[][] = []
  let group: string[] = []
  let bytes = 0
  for (const id of ids) {
    const cost = itemBytes(change, id)
    if (group.length > 0 && (group.length >= ITEMS_PER_REQUEST || bytes + cost > BYTES_PER_REQUEST)) {
      groups.push(group)
      group = []
      bytes = 0
    }
    group.push(id)
    bytes += cost
  }
  if (group.length > 0) groups.push(group)
  const out: Progress[] = []
  for (const members of groups) {
    const slice = new Set(members)
    out.push({
      version: 1,
      book: change.book,
      solved: change.solved.filter((id) => slice.has(id)),
      solvedAt: Object.fromEntries(Object.entries(change.solvedAt).filter(([id]) => slice.has(id))),
      drafts: Object.fromEntries(Object.entries(change.drafts).filter(([id]) => slice.has(id))),
    })
  }
  return out
}

export function siteBackend({
  book,
  site,
  storage,
  fetchImpl = (...args) => fetch(...args),
}: {
  book: string
  /** The site's origin, e.g. `https://ernie.sg`: progress is kept per site. */
  site: string
  storage: StorageLike | null | undefined
  fetchImpl?: typeof fetch
}) {
  const store = browserStore(book, storage)
  const route = `${PROGRESS_ROUTE}?${new URLSearchParams({ site, book })}`
  let mode: Mode = 'browser'
  let account: Progress | null = null
  // Whether the last write to this browser's storage took. When it did not
  // and there is no account either, progress lives only in this page.
  let browserWrites = true

  async function send(change: Progress | null): Promise<Progress | null> {
    if (!change || !account) return null
    let latest: Progress | null = null
    for (const part of chunks(change)) {
      const response = await fetchImpl(route, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(part),
      })
      if (!response.ok) throw new Error(`progress sync answered ${response.status}`)
      latest = normalize(await response.json(), book)
    }
    if (latest) account = latest
    return latest
  }

  return {
    async load(): Promise<Progress> {
      let local = store.load()
      try {
        const me = (await (await fetchImpl(AUTH_ME, { credentials: 'same-origin' })).json()) as {
          authenticated?: boolean
          canWrite?: boolean
        }
        // Only a reader the service lets write has an account copy: the same
        // allowlist that gates every margin write.
        if (!me.authenticated || !me.canWrite) return local
        const response = await fetchImpl(route, { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`progress answered ${response.status}`)
        account = normalize(await response.json(), book)
        mode = 'account'
        // Re-read: the page may have saved an edit while the account loaded.
        local = store.load()
        let merged = acknowledge(merge(local, account), account)
        const stored = await send(changesSince(merged, account))
        // Adopt what the account made of the upload (a clamped time, say)
        // before keeping it, or the browser copy would differ from it forever.
        if (stored) merged = acknowledge(merged, stored)
        browserWrites = store.save(merged)
        return merged
      } catch {
        if (account) mode = 'account-unreachable'
        return local
      }
    },

    async save(progress: Progress): Promise<Progress | null> {
      // Another tab may have saved since this one loaded: keep what it wrote.
      // The browser write happens before any await, so a save started as the
      // page unloads still lands.
      let merged = merge(progress, store.load())
      browserWrites = store.save(merged)
      if (!account) return merged
      try {
        const stored = await send(changesSince(merged, account))
        mode = 'account'
        if (stored) {
          merged = acknowledge(merge(merged, stored), stored)
          browserWrites = store.save(merged)
        }
        return merged
      } catch {
        mode = 'account-unreachable'
        return merged
      }
    },

    describe(): string {
      if (!browserWrites) {
        if (mode === 'account') return 'Saved to your account. This browser is not keeping a copy.'
        return 'Not saved: this browser is not keeping site data. Export progress to keep it.'
      }
      if (mode === 'account') return 'Saved in this browser and to your account.'
      if (mode === 'account-unreachable') {
        return 'Saved in this browser. Your account could not be reached; it will catch up next time.'
      }
      return 'Saved in this browser.'
    },
  }
}
