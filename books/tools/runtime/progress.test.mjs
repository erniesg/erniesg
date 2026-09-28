import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MAX_DRAFT_LENGTH,
  browserStore,
  counts,
  emptyProgress,
  markSolved,
  merge,
  normalize,
  setDraft,
  storageKey,
} from './progress.mjs'

const fixtures = JSON.parse(
  readFileSync(new URL('./progress-fixtures.json', import.meta.url), 'utf8'),
)

// The fixture file stands a marker in for a draft too long to store, so the
// same case can be read by the Python mirror without a 20 KB literal.
const inflate = (value) =>
  JSON.parse(
    JSON.stringify(value).replace('"__OVERSIZED__"', JSON.stringify('x'.repeat(MAX_DRAFT_LENGTH + 1))),
  )

describe('normalize', () => {
  for (const fixture of fixtures.normalize) {
    it(fixture.name, () => {
      expect(normalize(inflate(fixture.input), fixture.book)).toEqual(fixture.output)
    })
  }
})

describe('merge', () => {
  for (const fixture of fixtures.merge) {
    it(fixture.name, () => {
      expect(merge(fixture.a, fixture.b)).toEqual(fixture.output)
    })
  }

  it('is idempotent, so syncing twice changes nothing', () => {
    const [{ a, b }] = fixtures.merge
    const once = merge(a, b)
    expect(merge(once, b)).toEqual(once)
    expect(merge(once, once)).toEqual(once)
  })
})

describe('recording progress', () => {
  const now = '2026-09-28T12:00:00.000Z'

  it('solved never goes back: a later solve keeps the first time', () => {
    const first = markSolved(emptyProgress('b'), 'ch03-last-three', now)
    const again = markSolved(first, 'ch03-last-three', '2026-09-29T00:00:00.000Z')
    expect(again.solved).toEqual(['ch03-last-three'])
    expect(again.solvedAt['ch03-last-three']).toBe(now)
  })

  it('refuses a draft too long to store and an id that is not an id', () => {
    const start = emptyProgress('b')
    expect(setDraft(start, 'ok', 'x'.repeat(MAX_DRAFT_LENGTH + 1), now)).toBe(start)
    expect(setDraft(start, 'Not Ok', 'print(1)', now)).toBe(start)
    expect(setDraft(start, 'ok', 'print(1)', now).drafts.ok).toEqual({ code: 'print(1)', updatedAt: now })
  })

  it('counts solved exercises and challenges separately', () => {
    let progress = emptyProgress('b')
    for (const id of ['e1', 'e2', 'c1', 'stray']) progress = markSolved(progress, id, now)
    expect(counts(progress, { exercises: ['e1', 'e2', 'e3'], challenges: ['c1', 'c2'] })).toEqual({
      exercises: { solved: 2, total: 3 },
      challenges: { solved: 1, total: 2 },
    })
  })
})

describe('browserStore', () => {
  function memory() {
    const map = new Map()
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      map,
    }
  }

  it('round-trips through its versioned key', () => {
    const storage = memory()
    const store = browserStore('build-a-coding-agent', storage)
    const progress = markSolved(emptyProgress('build-a-coding-agent'), 'ch03-last-three', '2026-09-28T12:00:00.000Z')
    expect(store.save(progress)).toBe(true)
    expect([...storage.map.keys()]).toEqual([storageKey('build-a-coding-agent')])
    expect(storageKey('build-a-coding-agent')).toBe('book-progress:v1:build-a-coding-agent')
    expect(store.load()).toEqual(progress)
  })

  it('works, empty and quietly, when storage is missing or throws', () => {
    const throwing = {
      getItem() { throw new Error('SecurityError') },
      setItem() { throw new Error('QuotaExceededError') },
    }
    for (const storage of [undefined, null, throwing]) {
      const store = browserStore('b', storage)
      expect(store.load()).toEqual(emptyProgress('b'))
      expect(store.save(emptyProgress('b'))).toBe(false)
    }
  })

  it('reads a corrupted value as empty progress rather than failing the page', () => {
    const storage = memory()
    storage.setItem(storageKey('b'), '{not json')
    expect(browserStore('b', storage).load()).toEqual(emptyProgress('b'))
  })
})

describe('acknowledge', () => {
  it('takes the stored time for the same code, so a clamped draft stops looking newer', async () => {
    const { acknowledge } = await import('./progress.mjs')
    const future = '2099-01-01T00:00:00.000Z'
    const clamped = '2026-09-28T12:00:00.000Z'
    const mine = setDraft(emptyProgress('b'), 'x', 'same', future)
    const stored = setDraft(emptyProgress('b'), 'x', 'same', clamped)
    expect(acknowledge(mine, stored).drafts.x).toEqual({ code: 'same', updatedAt: clamped })
    // Different code is a real competing edit: the ordinary merge decides.
    const other = setDraft(emptyProgress('b'), 'x', 'theirs', clamped)
    expect(acknowledge(mine, other).drafts.x.code).toBe('same')
  })
})
