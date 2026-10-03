import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADA,
  ADA_KEY,
  BOB,
  createHarness,
  webAnnotation,
  type MarginHarness,
} from './fixtures'
import { listOwnAnnotationsQuery } from './queries'
import { MAX_PAGE_SIZE } from './repository'
import { applyMigrations } from './sqlite-database'
import { SKETCH_PREFIX } from '../../../packages/margin/src/sketch'

/**
 * `GET /mine` (issue 073): the signed-in reader's own annotations under one
 * path prefix of one site, across every document there, for the per-book
 * Annotations page. Against the real router over SQLite built from every
 * migration.
 */

const SITE = 'https://ernie.sg'
const BOOK = '/books/build-a-coding-agent/'
const CH1 = `${SITE}${BOOK}ch01-values/`
const CH2 = `${SITE}${BOOK}ch02-names/`
const CH3 = `${SITE}${BOOK}ch03-lists/`

type Wire = {
  id: string
  motivation: string
  body?: { value: string }
  creator: string
  target: { source: string }
  'margin:visibility': string
  'margin:parentId'?: string
  'margin:withdrawnAt'?: string | null
}

type Page = { annotations: Wire[]; nextCursor?: string }

let harness: MarginHarness

beforeEach(() => {
  harness = createHarness()
})

async function post(
  options: Parameters<typeof webAnnotation>[0],
  as: typeof ADA = ADA,
): Promise<Wire> {
  const response = await harness.request('POST', '/annotations', {
    as,
    body: webAnnotation(options),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as Wire
}

function mineQuery(params: Record<string, string>): string {
  return `/mine?${new URLSearchParams(params)}`
}

async function mine(
  params: Record<string, string> = { site: SITE, prefix: BOOK },
  as: typeof ADA | null = ADA,
): Promise<Page> {
  const response = await harness.request('GET', mineQuery(params), { as })
  expect(response.status).toBe(200)
  return (await response.json()) as Page
}

/** Every page, following `nextCursor`, as a client does. */
async function allPages(limit: number): Promise<{ pages: Page[]; rows: Wire[] }> {
  const pages: Page[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await mine({
      site: SITE,
      prefix: BOOK,
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    })
    pages.push(page)
    cursor = page.nextCursor
    if (!cursor) break
  }
  return { pages, rows: pages.flatMap((page) => page.annotations) }
}

describe('GET /mine', () => {
  it("returns only the viewer's own rows across the book's documents, every motivation and visibility, in (document, created, id) order", async () => {
    // Written out of document order, so the response order is the query's.
    const c3 = await post({ source: CH3, visibility: 'public', body: 'ada ch3 public' })
    const c1note = await post({ source: CH1, visibility: 'private', body: 'ada ch1 note' })
    const c1hl = await post({ source: CH1, motivation: 'highlighting', visibility: 'private' })
    const c2 = await post({ source: CH2, motivation: 'editing', visibility: 'public' })
    const sketch = await post({
      source: CH2,
      visibility: 'private',
      body: `${SKETCH_PREFIX}${JSON.stringify({ version: 1, note: 'a drawing', anchor: { blockId: 'p-1', quote: 'x' }, region: { x: 0, y: 0, width: 10, height: 10 }, strokes: [[[0, 0], [1, 1]]] })}`,
    })
    // Bob's, public and private, on the same documents: never Ada's to list.
    await post({ source: CH1, visibility: 'public', body: 'bob public' }, BOB)
    await post({ source: CH2, visibility: 'private', body: 'bob private' }, BOB)
    // A reply of Ada's to her own note is hers too.
    const reply = await post({
      source: CH1,
      visibility: 'private',
      body: 'ada reply',
      parentId: c1note.id.replace('urn:margin:annotation:', ''),
    })

    const { annotations, nextCursor } = await mine()
    expect(nextCursor).toBeUndefined()
    expect(annotations.map((row) => row.id)).toEqual([
      c1note.id,
      c1hl.id,
      reply.id,
      c2.id,
      sketch.id,
      c3.id,
    ])
    expect(new Set(annotations.map((row) => row.creator)).size).toBe(1)
    expect(annotations.map((row) => row.motivation)).toEqual([
      'commenting',
      'highlighting',
      'commenting',
      'editing',
      'commenting',
      'commenting',
    ])
    // The existing `present()` shape: the reply still names its parent.
    expect(annotations[2]['margin:parentId']).toBeDefined()
    expect(annotations.map((row) => row['margin:visibility'])).toContain('public')
    expect(annotations.map((row) => row['margin:visibility'])).toContain('private')
  })

  it("never returns another creator's row, public or private", async () => {
    await post({ source: CH1, visibility: 'public', body: 'bob public' }, BOB)
    await post({ source: CH1, visibility: 'private', body: 'bob private' }, BOB)
    await post({ source: CH2, motivation: 'editing', visibility: 'public' }, BOB)

    expect((await mine()).annotations).toEqual([])
    // Bob sees his own three, and none of them is anyone else's.
    const forBob = await mine(undefined, BOB)
    expect(forBob.annotations).toHaveLength(3)
  })

  it("does not read another creator's rows at all, below the HTTP surface", async () => {
    await post({ source: CH1, visibility: 'public', body: 'bob public' }, BOB)
    await post({ source: CH1, visibility: 'private', body: 'bob private' }, BOB)
    await post({ source: CH1, visibility: 'private', body: 'ada private' })

    const query = listOwnAnnotationsQuery(SITE, BOOK, ADA_KEY, { limit: 10 })
    const rows = harness.database.query(query.sql, query.params)
    expect(rows).toHaveLength(1)
    expect(rows.every((row) => row.creator === ADA_KEY)).toBe(true)
  })

  it('excludes rows on another site, and rows outside the prefix', async () => {
    const inside = await post({ source: CH1, body: 'inside' })
    await post({ source: `https://berlayar.ai${BOOK}ch01-values/`, body: 'other site' })
    // A sibling book whose slug starts with this one's.
    await post({ source: `${SITE}/books/build-a-coding-agent-2/ch01/`, body: 'sibling book' })
    // The book path without its trailing slash is not under the prefix.
    await post({ source: `${SITE}/books/build-a-coding-agent`, body: 'no slash' })
    await post({ source: `${SITE}/challenges/chapter-1`, body: 'elsewhere' })

    const { annotations } = await mine()
    expect(annotations.map((row) => row.id)).toEqual([inside.id])
  })

  it('pages with the existing cursor and page cap, without skipping or repeating a row', async () => {
    const written: string[] = []
    for (const source of [CH2, CH1, CH3, CH1, CH2, CH3, CH1]) {
      written.push((await post({ source, body: `note on ${source}` })).id)
    }
    const { pages, rows } = await allPages(3)
    expect(pages.map((page) => page.annotations.length)).toEqual([3, 3, 1])
    expect(new Set(rows.map((row) => row.id)).size).toBe(7)
    expect(rows.map((row) => row.target.source)).toEqual([CH1, CH1, CH1, CH2, CH2, CH3, CH3])
    expect([...rows.map((row) => row.id)].sort()).toEqual([...written].sort())

    const capped = await harness.request(
      'GET',
      mineQuery({ site: SITE, prefix: BOOK, limit: String(MAX_PAGE_SIZE + 1) }),
    )
    expect(capped.status).toBe(400)
    const badCursor = await harness.request(
      'GET',
      mineQuery({ site: SITE, prefix: BOOK, cursor: 'nonsense' }),
    )
    expect(badCursor.status).toBe(400)
  })

  it('is 401 when signed out', async () => {
    await post({ source: CH1, visibility: 'public', body: 'public' })
    const response = await harness.request('GET', mineQuery({ site: SITE, prefix: BOOK }), {
      as: null,
    })
    expect(response.status).toBe(401)
  })

  it.each([
    ['missing', null],
    ['empty', ''],
    ['relative', 'books/build-a-coding-agent/'],
    ['without a trailing slash', '/books/build-a-coding-agent'],
    ['a protocol-relative URL', '//evil.example/'],
    ['carrying a query', '/books/x/?a=/'],
    ['carrying a fragment', '/books/x/#/'],
    ['absolute URL', 'https://ernie.sg/books/x/'],
  ])('is 400 on a bad prefix: %s', async (_name, prefix) => {
    const params: Record<string, string> = { site: SITE }
    if (prefix !== null) params.prefix = prefix
    const response = await harness.request('GET', mineQuery(params))
    expect(response.status).toBe(400)
  })

  it('is 400 on a missing or non-origin site', async () => {
    for (const site of [null, 'ernie.sg', 'https://ernie.sg/books/', 'ftp://ernie.sg']) {
      const params: Record<string, string> = { prefix: BOOK }
      if (site !== null) params.site = site
      const response = await harness.request('GET', mineQuery(params))
      expect(response.status).toBe(400)
    }
  })

  it('answers GET and HEAD only', async () => {
    const response = await harness.request('POST', mineQuery({ site: SITE, prefix: BOOK }), {
      body: {},
    })
    expect(response.status).toBe(405)
  })
})

describe('the /mine query', () => {
  function planFor(after?: { document: string; created: string; id: string }) {
    const database = new DatabaseSync(':memory:')
    applyMigrations(database)
    const query = listOwnAnnotationsQuery(SITE, BOOK, ADA_KEY, {
      limit: 101,
      ...(after ? { after } : {}),
    })
    return (
      database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(
        ...(query.params as never[]),
      ) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join('\n')
  }

  it('is served by the existing owner index, as a range over document', () => {
    for (const plan of [
      planFor(),
      planFor({ document: `${BOOK}ch01/`, created: '2026-09-22T00:00:00.000Z', id: 'a' }),
    ]) {
      expect(plan).toContain('margin_annotations_owner')
      expect(plan).toContain('USING INDEX margin_annotations_owner (creator=? AND site=? AND document>? AND document<?)')
    }
  })

  it("bounds the range by the prefix's successor", () => {
    const query = listOwnAnnotationsQuery(SITE, BOOK, ADA_KEY, { limit: 5 })
    expect(query.params).toContain(BOOK)
    expect(query.params).toContain('/books/build-a-coding-agent0')
  })
})
