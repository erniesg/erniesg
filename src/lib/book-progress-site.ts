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
  browserStore,
  merge,
  normalize,
  type Progress,
  type StorageLike,
} from '../../books/tools/runtime/progress.mjs'

const PROGRESS_ROUTE = '/api/margin/v1/progress'
const AUTH_ME = '/auth/me'
/** The service refuses larger requests; split rather than fail. */
const ITEMS_PER_REQUEST = 200

type Mode = 'browser' | 'account' | 'account-unreachable'

/**
 * What `next` knows that `base` does not: new solves and newer drafts. `null`
 * when there is nothing to send.
 */
export function changesSince(next: Progress, base: Progress): Progress | null {
  const solved = next.solved.filter((id) => !base.solved.includes(id))
  const drafts: Progress['drafts'] = {}
  for (const [id, draft] of Object.entries(next.drafts)) {
    const known = base.drafts[id]
    if (!known || Date.parse(draft.updatedAt) > Date.parse(known.updatedAt)) drafts[id] = draft
  }
  if (solved.length === 0 && Object.keys(drafts).length === 0) return null
  const solvedAt: Progress['solvedAt'] = {}
  for (const id of solved) if (next.solvedAt[id]) solvedAt[id] = next.solvedAt[id]
  return { version: 1, book: next.book, solved, solvedAt, drafts }
}

/** Split a change into requests the service accepts. */
function chunks(change: Progress): Progress[] {
  const ids = [...new Set([...change.solved, ...Object.keys(change.drafts)])].sort()
  const out: Progress[] = []
  for (let start = 0; start < ids.length; start += ITEMS_PER_REQUEST) {
    const slice = new Set(ids.slice(start, start + ITEMS_PER_REQUEST))
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
      const local = store.load()
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
        const merged = merge(local, account)
        store.save(merged)
        await send(changesSince(merged, account))
        return merged
      } catch {
        if (account) mode = 'account-unreachable'
        return local
      }
    },

    async save(progress: Progress): Promise<Progress | null> {
      store.save(progress)
      if (!account) return null
      try {
        const stored = await send(changesSince(progress, account))
        mode = 'account'
        return stored
      } catch {
        mode = 'account-unreachable'
        return null
      }
    },

    describe(): string {
      if (mode === 'account') return 'Saved in this browser and to your account.'
      if (mode === 'account-unreachable') {
        return 'Saved in this browser. Your account could not be reached; it will catch up next time.'
      }
      return 'Saved in this browser.'
    },
  }
}
