import { describe, expect, it } from 'vitest'

import { DEFAULT_HIGHLIGHT_ROLE, highlightRole } from '../../packages/margin/src/palette'
import { encodeSketch, SKETCH_PREFIX } from '../../packages/margin/src/sketch'
import { formatHunks } from '../annotations/criticmarkup'
import {
  buildOverview,
  fetchMine,
  linkTo,
  matchesFilter,
  parentRequestUrl,
  PROPOSAL_STATE_LABELS,
  PROPOSAL_STATES,
  proposalSummary,
  resolveForeignParent,
  type OverviewPage,
  type WireAnnotation,
} from './annotations-overview'

const SITE = 'https://ernie.sg'
const BOOK = '/books/b/'
const NODES: OverviewPage[] = [
  { id: 'ch00-loop', title: 'The loop', path: `${BOOK}ch00-loop/` },
  { id: 'sum', title: 'Sum', path: `${BOOK}sum/` },
  { id: 'ch01-values', title: 'Values', path: `${BOOK}ch01-values/` },
]
const SHAPE = { frontPage: BOOK, nodes: NODES }

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
      selector: [
        { type: 'TextQuoteSelector', exact: `quote of ${id}` },
        // The span has to be the quote's length, or the rail rejects the row.
        { type: 'TextPositionSelector', start: 0, end: [...`quote of ${id}`].length },
        { type: 'margin:StructSelector', 'margin:nodeId': 'block-1' },
      ],
    },
    created: new Date(Date.UTC(2026, 9, 3, 0, 0, clock)).toISOString(),
    'margin:visibility': 'private',
    ...rest,
  }
}

const hunks = (...markup: string[]) =>
  formatHunks(markup.map((criticMarkup, index) => ({ baseStartLine: index + 1, baseEndLine: index + 1, criticMarkup })))

const SKETCH = encodeSketch({
  version: 1,
  note: 'circled',
  anchor: { blockId: 'b', quote: 'q' },
  region: { x: 0, y: 0, width: 1, height: 0.5 },
  strokes: [[[0, 0], [1, 1]]],
})

describe('buildOverview', () => {
  it('groups by node in the book’s order, not the service’s', () => {
    const groups = buildOverview(
      [
        wire(`${BOOK}ch00-loop/`, 'p', 'editing', { body: hunks('A {++b++}.') }),
        wire(`${BOOK}ch01-values/`, 'n', 'commenting', { body: 'a note' }),
        wire(`${BOOK}sum/`, 'h', 'highlighting', { 'margin:color': 'question' }),
      ],
      SHAPE,
    )
    expect(groups.map((group) => group.page.id)).toEqual(['ch00-loop', 'sum', 'ch01-values'])
    expect(groups[1].entries[0]).toMatchObject({
      id: 'h',
      kind: 'highlight',
      quote: 'quote of h',
      fields: { kind: 'highlight', color: { role: 'question', label: 'Question' } },
      href: `${BOOK}sum/?annotation=h`,
    })
  })

  it('puts the front page first and every other path last, dropping none', () => {
    const groups = buildOverview(
      [
        wire(`${BOOK}map/`, 'm', 'highlighting'),
        wire(`${BOOK}retired/`, 'old', 'commenting', { body: 'kept' }),
        wire(`${BOOK}sum/`, 'h', 'highlighting'),
        wire(BOOK, 'f', 'commenting', { body: 'on the front page' }),
      ],
      SHAPE,
    )
    expect(groups.map((group) => [group.page.id, group.page.title])).toEqual([
      ['book', 'Book front page'],
      ['sum', 'Sum'],
      ['other', 'Other pages'],
    ])
    expect(groups[2].entries.map((entry) => [entry.id, entry.path])).toEqual([
      ['m', `${BOOK}map/`],
      ['old', `${BOOK}retired/`],
    ])
  })

  it('carries only the fields each kind has, inventing none', () => {
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'h', 'highlighting'),
        wire(`${BOOK}sum/`, 'n', 'commenting', { body: 'plain' }),
        wire(`${BOOK}sum/`, 'c', 'commenting', { body: 'coloured', 'margin:color': 'idea' }),
        wire(`${BOOK}sum/`, 's', 'commenting', { body: SKETCH, 'margin:color': 'idea' }),
        wire(`${BOOK}sum/`, 'p', 'editing', { body: hunks('Every {~~challenge~>exercise~~}.') }),
      ],
      SHAPE,
    )
    expect(group.entries.map((entry) => entry.fields)).toEqual([
      { kind: 'highlight', color: { role: DEFAULT_HIGHLIGHT_ROLE, label: 'Key point' } },
      { kind: 'note', body: 'plain', color: null, deleted: false },
      { kind: 'note', body: 'coloured', color: { role: 'idea', label: 'Idea' }, deleted: false },
      { kind: 'sketch', note: 'circled', sketch: expect.objectContaining({ version: 1 }) },
      { kind: 'proposal', summary: 'exercise', state: 'pending' },
    ])
  })

  it('reads colours through the rail’s highlightRole(): legacy, unknown and missing alike', () => {
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'amber', 'highlighting', { 'margin:color': 'amber' }),
        wire(`${BOOK}sum/`, 'unknown', 'highlighting', { 'margin:color': 'chartreuse' }),
        wire(`${BOOK}sum/`, 'blue', 'commenting', { body: 'legacy note', 'margin:color': 'blue' }),
      ],
      SHAPE,
    )
    expect(group.entries.map((entry) => (entry.fields as { color: { role: string } }).color.role)).toEqual([
      highlightRole('amber'),
      highlightRole('chartreuse'),
      highlightRole('blue'),
    ])
    expect(highlightRole('blue')).toBe('question')
  })

  it('tells a sketch from a note by whether it decodes, as the rail does', () => {
    const malformed = `${SKETCH_PREFIX}{"version":1,"note":"broken"`
    const outOfBounds = `${SKETCH_PREFIX}${JSON.stringify({ version: 1, note: 'huge', anchor: { blockId: 'b', quote: 'q' }, region: { x: 0, y: 0, width: 40, height: 20 }, strokes: [] })}`
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 's', 'commenting', { body: SKETCH }),
        wire(`${BOOK}sum/`, 'x', 'commenting', { body: malformed }),
        wire(`${BOOK}sum/`, 'y', 'commenting', { body: outOfBounds }),
      ],
      SHAPE,
    )
    expect(group.entries.map((entry) => entry.kind)).toEqual(['sketch', 'note', 'note'])
    expect(group.entries[1].fields).toMatchObject({ kind: 'note', body: malformed })
  })

  it('nests the reader’s own replies with the rail’s thread functions, at any depth', () => {
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'root', 'commenting', { body: 'root' }),
        wire(`${BOOK}sum/`, 'r1', 'commenting', { body: 'one', 'margin:parentId': 'root' }),
        wire(`${BOOK}sum/`, 'r2', 'commenting', { body: 'two', 'margin:parentId': 'urn:margin:annotation:r1' }),
        wire(`${BOOK}sum/`, 'r3', 'commenting', { body: 'three', 'margin:parentId': 'r2' }),
        wire(`${BOOK}sum/`, 'side', 'commenting', { body: 'side', 'margin:parentId': 'root' }),
      ],
      SHAPE,
    )
    expect(group.entries.map((entry) => entry.id)).toEqual(['root'])
    expect(group.entries[0].thread.map(({ reply, depth }) => [reply.serverId, depth])).toEqual([
      ['r1', 1],
      ['r2', 2],
      ['r3', 3],
      ['side', 1],
    ])
  })

  it('shows a tombstoned note as deleted, with its replies still under it', () => {
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'd', 'commenting', { 'margin:deleted': true }),
        wire(`${BOOK}sum/`, 'r', 'commenting', { body: 'still here', 'margin:parentId': 'd' }),
      ],
      SHAPE,
    )
    expect(group.entries[0].fields).toEqual({ kind: 'note', deleted: true })
    expect(group.entries[0].thread.map(({ reply }) => reply.body)).toEqual(['still here'])
  })

  it("gathers replies to somebody else's note under one entry for that note, to be asked about", () => {
    const [group] = buildOverview(
      [
        wire(`${BOOK}sum/`, 'r1', 'commenting', { body: 'mine', 'margin:parentId': 'theirs' }),
        wire(`${BOOK}sum/`, 'r2', 'commenting', { body: 'and again', 'margin:parentId': 'r1' }),
      ],
      SHAPE,
    )
    const [entry] = group.entries
    expect(entry).toMatchObject({
      id: 'theirs',
      fields: null,
      foreign: { id: 'theirs', state: 'pending' },
      href: `${BOOK}sum/?annotation=r1`,
    })
    expect(entry.thread.map(({ reply, depth }) => [reply.body, depth])).toEqual([
      ['mine', 1],
      ['and again', 2],
    ])
    // Scoped by the reply's own source: without one the item route is a 400.
    expect(parentRequestUrl(entry)).toBe(
      `/api/margin/v1/annotations/theirs?source=${encodeURIComponent(`${SITE}${BOOK}sum/`)}`,
    )
  })
})

describe('a reply the rail cannot read', () => {
  it('stands as an entry of its own rather than being dropped', () => {
    const odd = wire(`${BOOK}sum/`, 'odd', 'commenting', { body: 'still mine', 'margin:parentId': 'p' })
    // A span that does not match its quote: the rail's parser refuses it.
    ;(odd.target!.selector as { type: string; end?: number }[])[1].end = 1
    const [group] = buildOverview([odd], SHAPE)
    expect(group.entries.map((entry) => [entry.id, entry.fields])).toEqual([
      ['odd', { kind: 'note', body: 'still mine', color: null, deleted: false }],
    ])
  })
})

describe('linkTo', () => {
  it('adds annotation=<id> to the stored source through searchParams', () => {
    expect(linkTo(`${SITE}${BOOK}map/`, 'a')).toBe(`${BOOK}map/?annotation=a`)
    expect(linkTo(`${SITE}${BOOK}`, 'a b')).toBe(`${BOOK}?annotation=a+b`)
  })
})

describe('proposal summaries', () => {
  it('are the inserted text, cut to 120 code points', () => {
    expect(proposalSummary(hunks('Every {~~challenge~>exercise~~}.'))).toBe('exercise')
    expect(proposalSummary(hunks('A {++new++} word.', 'And {++another++}.'))).toBe('new another')
    const long = '😀'.repeat(130)
    expect(proposalSummary(hunks(`{++${long}++}`))).toBe('😀'.repeat(120))
  })

  it('say "Deletes:" for a proposal that only deletes', () => {
    expect(proposalSummary(hunks('Cut {--this bit--} out.'))).toBe('Deletes: this bit')
    expect(proposalSummary(hunks(`{--${'x'.repeat(200)}--}`))).toBe(`Deletes: ${'x'.repeat(120)}`)
  })

  it('are absent when the markup changes no text, so the row falls back', () => {
    expect(proposalSummary(hunks('Equal text only, no change in it.'))).toBeNull()
    expect(proposalSummary(hunks('{++   ++}'))).toBeNull()
  })

  it('are absent when the markup cannot be parsed', () => {
    expect(proposalSummary(hunks('An {++unclosed insertion.'))).toBeNull()
    expect(proposalSummary('free text from before hunks')).toBeNull()
  })
})

describe('proposal states', () => {
  it('map every one of issue 060’s states to its label', () => {
    expect(PROPOSAL_STATE_LABELS).toEqual({
      pending: 'Pending',
      withdrawn: 'Withdrawn',
      approved: 'Being applied',
      pr_open: 'Being applied',
      merged: 'Applied',
      conflict: 'Needs attention',
      apply_failed: 'Needs attention',
      closed: 'Closed',
    })
  })

  it('come from margin:proposalState through the real data path, and fall back to margin:withdrawnAt', async () => {
    const rows = [
      ...PROPOSAL_STATES.map((state) =>
        wire(`${BOOK}sum/`, `p-${state}`, 'editing', { body: hunks('{++x++}'), 'margin:proposalState': state }),
      ),
      wire(`${BOOK}sum/`, 'legacy-pending', 'editing', { body: hunks('{++x++}') }),
      wire(`${BOOK}sum/`, 'legacy-withdrawn', 'editing', { body: hunks('{++x++}'), 'margin:withdrawnAt': '2026-10-03T00:00:00.000Z' }),
    ]
    const fetched = await fetchMine(SITE, BOOK, async () => new Response(JSON.stringify({ annotations: rows })))
    expect(fetched.status).toBe('ok')
    const [group] = buildOverview((fetched as { annotations: WireAnnotation[] }).annotations, SHAPE)
    const states = Object.fromEntries(
      group.entries.map((entry) => [entry.id, PROPOSAL_STATE_LABELS[(entry.fields as { state: keyof typeof PROPOSAL_STATE_LABELS }).state]]),
    )
    for (const state of PROPOSAL_STATES) expect(states[`p-${state}`]).toBe(PROPOSAL_STATE_LABELS[state])
    expect(states['legacy-pending']).toBe('Pending')
    expect(states['legacy-withdrawn']).toBe('Withdrawn')
  })
})

describe('resolveForeignParent', () => {
  function foreignEntry() {
    const [group] = buildOverview(
      [wire(`${BOOK}sum/`, 'r', 'commenting', { body: 'mine', 'margin:parentId': 'theirs' })],
      SHAPE,
    )
    return group.entries[0]
  }

  it('shows a visible parent as somebody else’s', () => {
    const entry = foreignEntry()
    resolveForeignParent(entry, {
      status: 200,
      body: { ...wire(`${BOOK}sum/`, 'theirs', 'commenting', { body: 'their note' }), 'margin:creatorName': 'Quiet Heron' },
    })
    expect(entry.foreign).toEqual({
      id: 'theirs',
      state: 'visible',
      creatorName: 'Quiet Heron',
      quote: 'quote of theirs',
      body: 'their note',
      deleted: false,
      isReply: false,
      threadHref: `${BOOK}sum/?annotation=theirs`,
    })
  })

  it('marks a parent that is itself a reply, with a link to its thread', () => {
    const entry = foreignEntry()
    resolveForeignParent(entry, {
      status: 200,
      body: wire(`${BOOK}sum/`, 'theirs', 'commenting', { body: 'their reply', 'margin:parentId': 'root' }),
    })
    expect(entry.foreign).toMatchObject({ state: 'visible', isReply: true, threadHref: `${BOOK}sum/?annotation=theirs` })
  })

  it('leaves the reader’s replies on their own when the lookup fails', () => {
    for (const response of [null, { status: 500, body: null }, { status: 404, body: null }]) {
      const entry = foreignEntry()
      resolveForeignParent(entry, response)
      expect(entry.foreign).toEqual({ id: 'theirs', state: 'failed' })
    }
  })
})

describe('matchesFilter', () => {
  it('filters by kind and by page', () => {
    const groups = buildOverview(
      [
        wire(`${BOOK}sum/`, 'h', 'highlighting'),
        wire(`${BOOK}ch01-values/`, 's', 'commenting', { body: SKETCH }),
        wire(BOOK, 'f', 'commenting', { body: 'front' }),
      ],
      SHAPE,
    )
    const all = groups.flatMap((group) => group.entries.map((entry) => ({ entry, page: group.page })))
    const ids = (filter: Parameters<typeof matchesFilter>[2]) =>
      all.filter(({ entry, page }) => matchesFilter(entry, page, filter)).map(({ entry }) => entry.id)
    expect(ids({ kind: 'all', page: 'all' })).toEqual(['f', 'h', 's'])
    expect(ids({ kind: 'sketch', page: 'all' })).toEqual(['s'])
    expect(ids({ kind: 'all', page: 'sum' })).toEqual(['h'])
    expect(ids({ kind: 'all', page: 'book' })).toEqual(['f'])
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

  it('reads a first-page 401 as signed out and any other first-page failure as a failure, never as empty', async () => {
    expect(await fetchMine(SITE, BOOK, async () => respond(401, {}))).toEqual({ status: 'signed-out' })
    expect(await fetchMine(SITE, BOOK, async () => respond(500, {}))).toEqual({ status: 'failed' })
    expect(
      await fetchMine(SITE, BOOK, async () => {
        throw new TypeError('offline')
      }),
    ).toEqual({ status: 'failed' })
  })

  it('keeps what loaded when a later page fails, and resumes from the failed cursor', async () => {
    const partial = await fetchMine(SITE, BOOK, async (input) =>
      String(input).includes('cursor=') ? respond(503, {}) : respond(200, { annotations: [{ id: 'a' }], nextCursor: 'c1' }),
    )
    expect(partial).toEqual({ status: 'partial', annotations: [{ id: 'a' }], cursor: 'c1' })

    const asked: string[] = []
    const resumed = await fetchMine(
      SITE,
      BOOK,
      async (input) => {
        asked.push(String(input))
        return respond(200, { annotations: [{ id: 'b' }] })
      },
      'c1',
    )
    expect(resumed).toEqual({ status: 'ok', annotations: [{ id: 'b' }] })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('cursor=c1')
  })
})
