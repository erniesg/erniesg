import { describe, expect, it } from 'vitest'

import { encodeSketch, SKETCH_PREFIX } from '../../packages/margin/src/sketch'
import { formatHunks } from '../annotations/criticmarkup'
import {
  buildOverview,
  fetchMine,
  matchesFilter,
  type OverviewPage,
  type WireAnnotation,
} from './annotations-overview'

const SITE = 'https://ernie.sg'
const BOOK = '/books/b/'
const PAGES: OverviewPage[] = [
  { id: 'book', title: 'The book', path: BOOK },
  { id: 'ch00-loop', title: 'The loop', path: `${BOOK}ch00-loop/` },
  { id: 'sum', title: 'Sum', path: `${BOOK}sum/` },
  { id: 'ch01-values', title: 'Values', path: `${BOOK}ch01-values/` },
  { id: 'map', title: 'The map', path: `${BOOK}map/` },
]

let clock = 0
function wire(
  path: string,
  id: string,
  motivation: string,
  extra: Partial<WireAnnotation> & { body?: string } = {},
): WireAnnotation {
  const { body, ...rest } = extra
  clock += 1
  return {
    id: `urn:margin:annotation:${id}`,
    motivation,
    ...(body === undefined ? {} : { body: { value: body } }),
    target: {
      source: `${SITE}${path}`,
      selector: [{ type: 'TextQuoteSelector', exact: `quote of ${id}` }],
    },
    created: new Date(Date.UTC(2026, 9, 3, 0, 0, clock)).toISOString(),
    'margin:visibility': 'private',
    ...rest,
  }
}

const SKETCH = encodeSketch({
  version: 1,
  note: 'circled',
  anchor: { blockId: 'b', quote: 'q' },
  region: { x: 0, y: 0, width: 10, height: 10 },
  strokes: [[[0, 0], [1, 1]]],
})

describe('buildOverview', () => {
  it('groups by page in the book’s order, not the service’s', () => {
    // The service's order: by document path.
    const groups = buildOverview(
      [
        wire(`${BOOK}ch00-loop/`, 'p', 'editing', { body: 'hunks' }),
        wire(`${BOOK}ch01-values/`, 'n', 'commenting', { body: 'a note' }),
        wire(`${BOOK}map/`, 'm', 'highlighting'),
        wire(`${BOOK}sum/`, 'h', 'highlighting', { 'margin:color': 'question' }),
      ],
      PAGES,
    )
    expect(groups.map((group) => group.page.id)).toEqual(['ch00-loop', 'sum', 'ch01-values', 'map'])
    expect(groups[1].entries[0]).toMatchObject({
      id: 'h',
      kind: 'highlight',
      quote: 'quote of h',
      body: '',
      color: { role: 'question', label: 'Question' },
      href: `${BOOK}sum/?annotation=h`,
    })
  })

  it('tells a sketch from a note by whether it decodes, as the rail does', () => {
    const malformed = `${SKETCH_PREFIX}{"version":1,"note":"broken"`
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 's', 'commenting', { body: SKETCH }),
        wire(`${BOOK}sum/`, 'x', 'commenting', { body: malformed }),
        wire(`${BOOK}sum/`, 'n', 'commenting', { body: 'plain', 'margin:color': 'idea' }),
      ],
      PAGES,
    )
    expect(group.entries.map((entry) => [entry.id, entry.kind])).toEqual([
      ['s', 'sketch'],
      ['x', 'note'],
      ['n', 'note'],
    ])
    expect(group.entries[0].body).toBe('circled')
    expect(group.entries[0].sketch?.strokes).toHaveLength(1)
    expect(group.entries[1].body).toBe(malformed)
    expect(group.entries[1].sketch).toBeNull()
    expect(group.entries[0].color).toBeNull()
    expect(group.entries[2].color?.label).toBe('Idea')
  })

  it('says where a proposal stands', () => {
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'a', 'editing', { body: 'h' }),
        wire(`${BOOK}sum/`, 'b', 'editing', { body: 'h', 'margin:withdrawnAt': '2026-10-03T01:00:00.000Z' }),
        wire(`${BOOK}sum/`, 'c', 'editing', { body: 'h', 'margin:appliedAt': '2026-10-03T02:00:00.000Z' }),
      ],
      PAGES,
    )
    expect(group.entries.map((entry) => entry.proposalState)).toEqual(['pending', 'withdrawn', 'applied'])
    expect(group.entries.every((entry) => entry.color === null)).toBe(true)
  })

  it("shows a proposal's change as CriticMarkup, not its stored hunks", () => {
    const hunks = formatHunks([
      { baseStartLine: 1, baseEndLine: 1, criticMarkup: 'Every {~~challenge~>exercise~~}.' },
      { baseStartLine: 4, baseEndLine: 4, criticMarkup: 'Then {++test++} it.' },
    ])
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'p', 'editing', { body: hunks }),
        wire(`${BOOK}sum/`, 'old', 'editing', { body: 'free text from before hunks' }),
      ],
      PAGES,
    )
    expect(group.entries[0].body).toBe('Every {~~challenge~>exercise~~}.\n\nThen {++test++} it.')
    expect(group.entries[1].body).toBe('free text from before hunks')
  })

  it('puts replies under their parent, a reply to a reply included', () => {
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'root', 'commenting', { body: 'root' }),
        wire(`${BOOK}sum/`, 'r1', 'commenting', { body: 'first', 'margin:parentId': 'root' }),
        wire(`${BOOK}sum/`, 'r2', 'commenting', { body: 'second', 'margin:parentId': 'urn:margin:annotation:r1' }),
        wire(`${BOOK}sum/`, 'gone', 'commenting', { 'margin:parentId': 'root', 'margin:deleted': true }),
      ],
      PAGES,
    )
    expect(group.entries.map((entry) => entry.id)).toEqual(['root'])
    expect(group.entries[0].replies.map((reply) => [reply.id, reply.body])).toEqual([
      ['r1', 'first'],
      ['r2', 'second'],
      ['gone', 'This reply was deleted.'],
    ])
  })

  it("keeps a reply to someone else's note, as an entry of its own", () => {
    const [group] = buildOverview(
      [wire(`${BOOK}sum/`, 'r', 'commenting', { body: 'mine', 'margin:parentId': 'theirs' })],
      PAGES,
    )
    expect(group.entries).toHaveLength(1)
    expect(group.entries[0]).toMatchObject({ id: 'r', kind: 'note', isReply: true })
  })

  it('never drops a row on a page the book no longer has', () => {
    const groups = buildOverview(
      [
        wire(`${BOOK}retired/`, 'old', 'commenting', { body: 'kept' }),
        wire(`${BOOK}sum/`, 'h', 'highlighting'),
      ],
      PAGES,
    )
    expect(groups.map((group) => group.page.path)).toEqual([`${BOOK}sum/`, `${BOOK}retired/`])
  })

  it('shows a deleted note without its text', () => {
    const [group] = buildOverview(
      [wire(`${BOOK}sum/`, 'd', 'commenting', { 'margin:deleted': true })],
      PAGES,
    )
    expect(group.entries[0]).toMatchObject({ deleted: true, body: 'This note was deleted.' })
  })
})

describe('matchesFilter', () => {
  it('filters by kind and by page', () => {
    const groups = buildOverview(
      [
        wire(`${BOOK}sum/`, 'h', 'highlighting'),
        wire(`${BOOK}ch01-values/`, 's', 'commenting', { body: SKETCH }),
      ],
      PAGES,
    )
    const all = groups.flatMap((group) => group.entries.map((entry) => ({ entry, page: group.page })))
    const ids = (filter: Parameters<typeof matchesFilter>[2]) =>
      all.filter(({ entry, page }) => matchesFilter(entry, page, filter)).map(({ entry }) => entry.id)
    expect(ids({ kind: 'all', page: 'all' })).toEqual(['h', 's'])
    expect(ids({ kind: 'sketch', page: 'all' })).toEqual(['s'])
    expect(ids({ kind: 'all', page: 'sum' })).toEqual(['h'])
    expect(ids({ kind: 'sketch', page: 'sum' })).toEqual([])
  })
})

describe('fetchMine', () => {
  function respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status })
  }

  it('follows every page and stops on a repeated cursor', async () => {
    const asked: string[] = []
    const pages = [
      { annotations: [{ id: 'a' }], nextCursor: 'c1' },
      { annotations: [{ id: 'b' }], nextCursor: 'c2' },
      { annotations: [{ id: 'c' }], nextCursor: 'c1' },
    ]
    const result = await fetchMine(SITE, BOOK, async (input) => {
      asked.push(String(input))
      return respond(200, pages[asked.length - 1])
    })
    expect(result).toEqual({ status: 'ok', annotations: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    expect(asked[0]).toBe(`/api/margin/v1/mine?site=${encodeURIComponent(SITE)}&prefix=${encodeURIComponent(BOOK)}&limit=200`)
    expect(asked[1]).toContain('cursor=c1')
  })

  it('reads a 401 as signed out and anything else as a failure', async () => {
    expect(await fetchMine(SITE, BOOK, async () => respond(401, {}))).toEqual({ status: 'signed-out' })
    expect(await fetchMine(SITE, BOOK, async () => respond(404, {}))).toEqual({ status: 'failed' })
    expect(
      await fetchMine(SITE, BOOK, async () => {
        throw new TypeError('offline')
      }),
    ).toEqual({ status: 'failed' })
  })
})
