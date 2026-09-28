import { describe, expect, it } from 'vitest'
import {
  emptyProgress,
  markSolved,
  setDraft,
  storageKey,
  type Progress,
} from '../../books/tools/runtime/progress.mjs'
import { changesSince, chunks, siteBackend } from './book-progress-site'

const BOOK = 'build-a-coding-agent'
const SITE = 'https://ernie.sg'
const T1 = '2026-09-28T10:00:00.000Z'
const T2 = '2026-09-28T11:00:00.000Z'

function memory() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  }
}

type Call = { method: string; url: string; body?: unknown }

/** A stand-in for the site: /auth/me and the margin progress routes. */
function fakeSite(options: { me?: unknown; server?: unknown; fail?: boolean } = {}) {
  const calls: Call[] = []
  let server = (options.server ?? emptyProgress(BOOK)) as Progress
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    if (options.fail) throw new Error('offline')
    if (url.endsWith('/auth/me')) {
      return new Response(JSON.stringify(options.me ?? { authenticated: false }), { status: 200 })
    }
    if (url.startsWith('/api/margin/v1/progress')) {
      if (method === 'PATCH') {
        const { merge } = await import('../../books/tools/runtime/progress.mjs')
        server = merge(server, body)
      }
      return new Response(JSON.stringify(server), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return { calls, fetchImpl: fetchImpl as typeof fetch, server: () => server }
}

describe('changesSince', () => {
  it('sends an earlier time for a solve the account already has', () => {
    const base = markSolved(emptyProgress(BOOK), 'a', T2)
    const next = markSolved(emptyProgress(BOOK), 'a', T1)
    expect(changesSince(next, base)?.solvedAt).toEqual({ a: T1 })
    expect(changesSince(base, next)).toBeNull()
  })

  it('sends only new solves and newer drafts, and nothing when nothing changed', () => {
    const base = setDraft(markSolved(emptyProgress(BOOK), 'a', T1), 'b', 'old', T1)
    expect(changesSince(base, base)).toBeNull()
    const next = setDraft(markSolved(base, 'c', T2), 'b', 'new', T2)
    expect(changesSince(next, base)).toEqual({
      version: 1,
      book: BOOK,
      solved: ['c'],
      solvedAt: { c: T2 },
      drafts: { b: { code: 'new', updatedAt: T2 } },
    })
  })
})

describe('siteBackend', () => {
  it('keeps progress in the browser for a reader who is not signed in', async () => {
    const storage = memory()
    const site = fakeSite()
    const backend = siteBackend({ book: BOOK, site: SITE, storage, fetchImpl: site.fetchImpl })
    expect(await backend.load()).toEqual(emptyProgress(BOOK))
    const solved = markSolved(emptyProgress(BOOK), 'a', T1)
    expect(await backend.save(solved)).toBeNull()
    expect(JSON.parse(storage.map.get(storageKey(BOOK))!).solved).toEqual(['a'])
    expect(site.calls.filter((c) => c.url.includes('/progress'))).toEqual([])
    expect(backend.describe()).toBe('Saved in this browser.')
  })

  it('merges browser and account on load, then writes back what the account lacks', async () => {
    const storage = memory()
    storage.setItem(storageKey(BOOK), JSON.stringify(markSolved(emptyProgress(BOOK), 'local-only', T1)))
    const site = fakeSite({
      me: { authenticated: true, canWrite: true },
      server: markSolved(emptyProgress(BOOK), 'server-only', T1),
    })
    const backend = siteBackend({ book: BOOK, site: SITE, storage, fetchImpl: site.fetchImpl })
    const loaded = (await backend.load()) as { solved: string[] }
    expect(loaded.solved).toEqual(['local-only', 'server-only'])
    expect(site.server().solved).toEqual(['local-only', 'server-only'])
    const patch = site.calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toBe(
      '/api/margin/v1/progress?site=https%3A%2F%2Fernie.sg&book=build-a-coding-agent',
    )
    expect((patch.body as { solved: string[] }).solved).toEqual(['local-only'])
    expect(backend.describe()).toBe('Saved in this browser and to your account.')
  })

  it('does not call the account for a signed-in reader who may not write', async () => {
    const site = fakeSite({ me: { authenticated: true, canWrite: false } })
    const backend = siteBackend({ book: BOOK, site: SITE, storage: memory(), fetchImpl: site.fetchImpl })
    await backend.load()
    expect(site.calls.filter((c) => c.url.includes('/progress'))).toEqual([])
  })

  it('falls back to the browser, and says so, when the account cannot be reached', async () => {
    const storage = memory()
    const site = fakeSite({ fail: true })
    const backend = siteBackend({ book: BOOK, site: SITE, storage, fetchImpl: site.fetchImpl })
    expect(await backend.load()).toEqual(emptyProgress(BOOK))
    expect(await backend.save(markSolved(emptyProgress(BOOK), 'a', T1))).toBeNull()
    expect(JSON.parse(storage.map.get(storageKey(BOOK))!).solved).toEqual(['a'])
  })

  it('works with no browser storage at all, and says progress is not being kept', async () => {
    const site = fakeSite()
    const backend = siteBackend({ book: BOOK, site: SITE, storage: undefined, fetchImpl: site.fetchImpl })
    expect(await backend.load()).toEqual(emptyProgress(BOOK))
    expect(await backend.save(markSolved(emptyProgress(BOOK), 'a', T1))).toBeNull()
    expect(backend.describe()).toBe(
      'Not saved: this browser is not keeping site data. Export progress to keep it.',
    )
  })

  it('keeps an edit saved while the account was loading', async () => {
    const storage = memory()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const site = fakeSite({ me: { authenticated: true, canWrite: true } })
    const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/margin/v1/progress') && (init?.method ?? 'GET') === 'GET') await gate
      return site.fetchImpl(input, init)
    }) as typeof fetch
    const backend = siteBackend({ book: BOOK, site: SITE, storage, fetchImpl: slowFetch })
    const loading = backend.load()
    // The page saves a draft while the account read is still out.
    await backend.save(setDraft(emptyProgress(BOOK), 'a', 'typed meanwhile', T2))
    release()
    const loaded = (await loading) as Progress
    expect(loaded.drafts.a?.code).toBe('typed meanwhile')
    expect(JSON.parse(storage.map.get(storageKey(BOOK))!).drafts.a.code).toBe('typed meanwhile')
  })

  it('adopts the account time for a draft it clamped, so it is not resent forever', async () => {
    const future = '2099-01-01T00:00:00.000Z'
    const clamped = '2026-09-28T12:00:00.000Z'
    const storage = memory()
    storage.setItem(storageKey(BOOK), JSON.stringify(setDraft(emptyProgress(BOOK), 'a', 'same', future)))
    const site = fakeSite({
      me: { authenticated: true, canWrite: true },
      server: setDraft(emptyProgress(BOOK), 'a', 'same', clamped),
    })
    const backend = siteBackend({ book: BOOK, site: SITE, storage, fetchImpl: site.fetchImpl })
    const loaded = (await backend.load()) as Progress
    expect(loaded.drafts.a.updatedAt).toBe(clamped)
    expect(site.calls.filter((c) => c.method === 'PATCH')).toEqual([])
  })
})

describe('chunks', () => {
  it('splits by size as well as by count, so every request fits the service', () => {
    let change = emptyProgress(BOOK)
    for (let index = 0; index < 150; index += 1) {
      change = setDraft(change, `d-${index}`, 'x'.repeat(19_000), T1)
    }
    const parts = chunks(change)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(new TextEncoder().encode(JSON.stringify(part)).length).toBeLessThan(2 * 1024 * 1024)
      expect(Object.keys(part.drafts).length).toBeLessThanOrEqual(200)
    }
    expect(parts.flatMap((part) => Object.keys(part.drafts)).sort()).toEqual(Object.keys(change.drafts).sort())
  })
})
