import { beforeEach, describe, expect, it } from 'vitest'
import { ADA, BOB, createHarness, type MarginHarness } from './fixtures'
import {
  MAX_PROGRESS_DRAFT_LENGTH,
  MAX_PROGRESS_ITEMS_PER_BOOK,
  MAX_PROGRESS_ITEMS_PER_REQUEST,
} from './progress'

/**
 * A signed-in reader's progress in a book: what they solved and the code they
 * left in each editor. Private to its owner, merged rather than overwritten,
 * and the same JSON shape as the local preview's progress file.
 */

let harness: MarginHarness

beforeEach(() => {
  harness = createHarness()
})

const SCOPE = '?site=https%3A%2F%2Fernie.sg&book=build-a-coding-agent'
// The harness clock starts at 2026-09-22T00:00:01Z; these are all before it.
const EARLY = '2026-09-20T09:00:00.000Z'
const LATER = '2026-09-21T09:00:00.000Z'

type Progress = {
  version: number
  book: string
  solved: string[]
  solvedAt: Record<string, string>
  drafts: Record<string, { code: string; updatedAt: string }>
}

async function read(as: typeof ADA | null = ADA, scope = SCOPE) {
  return harness.request('GET', `/progress${scope}`, { as })
}

async function patch(body: unknown, as: typeof ADA | null = ADA, scope = SCOPE) {
  return harness.request('PATCH', `/progress${scope}`, { as, body })
}

function progress(parts: Partial<Progress>): Progress {
  return {
    version: 1,
    book: 'build-a-coding-agent',
    solved: [],
    solvedAt: {},
    drafts: {},
    ...parts,
  }
}

describe('GET and PATCH /progress', () => {
  it('starts empty and answers in the shared shape', async () => {
    const response = await read()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(progress({}))
  })

  it('round-trips a solve and a draft', async () => {
    const sent = progress({
      solved: ['ch03-last-three'],
      solvedAt: { 'ch03-last-three': EARLY },
      drafts: { 'ch03-one-copy': { code: 'print(1)', updatedAt: EARLY } },
    })
    const written = await patch(sent)
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual(sent)
    expect(await (await read()).json()).toEqual(sent)
  })

  it('merges: solved is a union with the earliest time, a draft is the latest', async () => {
    await patch(
      progress({
        solved: ['ch03-last-three'],
        solvedAt: { 'ch03-last-three': LATER },
        drafts: { 'ch03-one-copy': { code: 'newer', updatedAt: LATER } },
      }),
    )
    const response = await patch(
      progress({
        solved: ['ch03-last-three', 'sum-of-two-digits'],
        solvedAt: { 'ch03-last-three': EARLY },
        drafts: { 'ch03-one-copy': { code: 'older', updatedAt: EARLY } },
      }),
    )
    expect(await response.json()).toEqual(
      progress({
        solved: ['ch03-last-three', 'sum-of-two-digits'],
        solvedAt: { 'ch03-last-three': EARLY },
        drafts: { 'ch03-one-copy': { code: 'newer', updatedAt: LATER } },
      }),
    )
  })

  it('never un-solves: a PATCH that knows less removes nothing', async () => {
    await patch(progress({ solved: ['ch03-last-three'] }))
    const response = await patch(progress({}))
    expect((await response.json()).solved).toEqual(['ch03-last-three'])
  })

  it('accepts the legacy local file, which is only a list of solved ids', async () => {
    const response = await patch({ solved: ['sum-of-two-digits'] })
    expect(response.status).toBe(200)
    expect((await response.json()).solved).toEqual(['sum-of-two-digits'])
  })

  it('clamps a time from the future to now, so a skewed clock cannot win every merge', async () => {
    const future = '2099-01-01T00:00:00.000Z'
    const response = await patch(
      progress({
        solved: ['x'],
        solvedAt: { x: future },
        drafts: { x: { code: 'from the future', updatedAt: future } },
      }),
    )
    const body = (await response.json()) as Progress
    expect(body.solvedAt.x < future).toBe(true)
    expect(body.drafts.x.updatedAt < future).toBe(true)
  })
})

describe('who can see and write progress', () => {
  it('is private to its owner', async () => {
    await patch(progress({ solved: ['ch03-last-three'] }), ADA)
    expect((await (await read(BOB)).json()).solved).toEqual([])
    expect((await (await read(ADA)).json()).solved).toEqual(['ch03-last-three'])
  })

  it('is separate per book and per site', async () => {
    await patch(progress({ solved: ['ch03-last-three'] }))
    const otherBook = '?site=https%3A%2F%2Fernie.sg&book=another-book'
    const otherSite = '?site=https%3A%2F%2Fberlayar.ai&book=build-a-coding-agent'
    expect((await (await read(ADA, otherBook)).json()).solved).toEqual([])
    expect((await (await read(ADA, otherSite)).json()).solved).toEqual([])
  })

  it('needs a signed-in caller to read or write', async () => {
    expect((await read(null)).status).toBe(401)
    expect((await patch(progress({ solved: ['x'] }), null)).status).toBe(401)
  })
})

describe('what is refused', () => {
  it('refuses a missing or malformed scope', async () => {
    for (const scope of [
      '',
      '?book=build-a-coding-agent',
      '?site=https%3A%2F%2Fernie.sg',
      '?site=not-a-url&book=build-a-coding-agent',
      '?site=https%3A%2F%2Fernie.sg%2Fbooks%2F&book=build-a-coding-agent',
      '?site=https%3A%2F%2Fernie.sg&book=Not%20A%20Slug',
    ]) {
      expect((await read(ADA, scope)).status, scope).toBe(400)
    }
  })

  it('refuses a draft too long to store, and stores nothing from that request', async () => {
    const response = await patch(
      progress({
        solved: ['ch03-last-three'],
        drafts: { x: { code: 'x'.repeat(MAX_PROGRESS_DRAFT_LENGTH + 1), updatedAt: EARLY } },
      }),
    )
    expect(response.status).toBe(413)
    expect((await (await read()).json()).solved).toEqual([])
  })

  it('refuses ids that are not ids and bodies that are not progress', async () => {
    for (const body of [
      progress({ solved: ['Not An Id'] }),
      progress({ drafts: { x: { code: 'print(1)', updatedAt: 'yesterday' } } }),
      [1, 2],
      'progress',
    ]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('bounds how much one request and one book can hold', async () => {
    const ids = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => `${prefix}-${index}`)
    expect((await patch(progress({ solved: ids(MAX_PROGRESS_ITEMS_PER_REQUEST + 1, 'a') }))).status).toBe(413)

    for (let batch = 0; batch * MAX_PROGRESS_ITEMS_PER_REQUEST < MAX_PROGRESS_ITEMS_PER_BOOK; batch += 1) {
      const response = await patch(progress({ solved: ids(MAX_PROGRESS_ITEMS_PER_REQUEST, `b${batch}`) }))
      expect(response.status).toBe(200)
    }
    const overflow = await patch(progress({ solved: ['one-more'] }))
    expect(overflow.status).toBe(413)
    // An item the book already holds can still change.
    expect((await patch(progress({ solved: ['b0-0'] }))).status).toBe(200)
  })
})

describe('one shape, one set of limits', () => {
  it('holds a draft to the same bound as the page code and the column', async () => {
    const { MAX_DRAFT_LENGTH } = await import('../../../books/tools/runtime/progress.mjs')
    expect(MAX_PROGRESS_DRAFT_LENGTH).toBe(MAX_DRAFT_LENGTH)
    const { readFileSync } = await import('node:fs')
    const migration = readFileSync('migrations/0002_margin_progress.sql', 'utf8')
    expect(migration).toContain(`length(draft) <= ${MAX_PROGRESS_DRAFT_LENGTH}`)
  })
})
