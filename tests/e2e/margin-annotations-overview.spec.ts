import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { highlightRegistryName } from '../../packages/margin/src/dom/paint'
import { DEFAULT_HIGHLIGHT_ROLE, highlightRole } from '../../packages/margin/src/palette'
import { encodeSketch, SKETCH_PREFIX } from '../../packages/margin/src/sketch'
import { flattenThread, replyFromWebAnnotation } from '../../packages/margin/src/threads'
import { formatHunks, proposeHunks } from '../../src/annotations/criticmarkup'
import { PROPOSAL_STATE_LABELS, PROPOSAL_STATES } from '../../src/lib/annotations-overview'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { MAX_PAGE_SIZE } from '../../src/worker/margin/repository'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * The per-book Annotations page (issue 073), one case per clause of spec
 * 073's success criteria. `/api/margin/v1/*` is answered in this process by
 * the production router over a fresh SQLite database built from every
 * migration, and `/auth/me` says who is signed in, as in
 * `margin-edit-mode.spec.ts`. The pages are the static build's
 * (`SRT_STATIC_BUILD_DIR=dist`, served by `installStaticRoutes` as in
 * `book-look.spec.ts`); without it, the dev server's.
 *
 * The chapters are picked so that URL order and book order differ:
 * `ch00-the-loop`, `sum-of-two-digits`, `ch01-values` in the book, but
 * `ch00…`, `ch01…`, `sum…` by path. The page must follow the book.
 */

const SITE = 'https://ernie.sg'
const BOOK = '/books/build-a-coding-agent/'
const OVERVIEW = `${BOOK}annotations/`
const LOOP = `${BOOK}ch00-the-loop/`
const SUM = `${BOOK}sum-of-two-digits/`
const VALUES = `${BOOK}ch01-values/`
const MAP = `${BOOK}map/`
const FIRST_NODE = `${BOOK}front-matter/`

const SCREENSHOTS = path.resolve(process.env.AGENT_EVIDENCE_DIR ?? '.agent/evidence', 'screenshots')

const OWNER: Principal = { provider: 'dev', issuer: 'urn:margin:dev', subject: 'owner' }
const OTHER: Principal = { provider: 'dev', issuer: 'urn:margin:dev', subject: 'other' }

type Wire = {
  id: string
  created: string
  creator: string
  target: { source: string }
  [key: string]: unknown
}

type Answer = { status: number; body: unknown }

type Service = {
  signedIn: boolean
  /** Make `/auth/me` fail instead of answering: an error, a timeout, or a body that is not JSON. */
  authFailure: 'error' | 'timeout' | 'malformed' | null
  as: Principal
  post(body: unknown, as?: Principal): Promise<Wire>
  call(method: string, pathAndQuery: string, as?: Principal, body?: unknown): Promise<Response>
  /** Every margin API request the page made, as `METHOD /path?query`. */
  requests: string[]
  /** Answer a request differently: a failure, or a stubbed body. */
  override: ((url: URL, method: string) => Answer | null) | null
}

async function mountService(page: Page): Promise<Service> {
  // First, so the routes below are asked before the static files are.
  await installStaticRoutes(page)
  const database = SqliteD1Database.inMemory()
  const repository = new D1MarginRepository(database)
  let clock = 0
  let sequence = 0
  const handle = (request: Request, as: Principal | null) =>
    handleMarginRequest(request, {
      repository,
      principal: as,
      now: () => new Date(Date.UTC(2026, 9, 3, 0, 0, 0, (clock += 1))).toISOString(),
      newId: () => `overview-${String((sequence += 1)).padStart(4, '0')}`,
    })
  const service: Service = {
    signedIn: true,
    authFailure: null,
    as: OWNER,
    requests: [],
    override: null,
    async post(body, as = OWNER) {
      const response = await service.call('POST', '/api/margin/v1/annotations', as, body)
      expect(response.status, await response.clone().text()).toBe(201)
      return (await response.json()) as Wire
    },
    call: (method, pathAndQuery, as = OWNER, body) =>
      handle(
        new Request(`${SITE}${pathAndQuery}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        as,
      ),
  }
  // As the Worker answers: signed out is a 200 naming nobody (auth-routes.ts).
  await page.route('**/auth/me', (route) => {
    if (service.authFailure === 'timeout') return route.abort('timedout')
    if (service.authFailure === 'error') {
      return route.fulfill({ status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"down"}' })
    }
    if (service.authFailure === 'malformed') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>a proxy page</html>' })
    }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        service.signedIn
          ? { authenticated: true, principal: service.as, canWrite: true, isAdmin: false }
          : { authenticated: false, canWrite: false, isAdmin: false },
      ),
    })
  })
  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    const url = new URL(incoming.url())
    service.requests.push(`${method} ${url.pathname}${url.search}`)
    const stubbed = service.override?.(url, method)
    if (stubbed) {
      await route.fulfill({
        status: stubbed.status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(stubbed.body),
      })
      return
    }
    const response = await handle(
      new Request(`${SITE}${url.pathname}${url.search}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: incoming.postData() ?? undefined }),
      }),
      service.signedIn ? service.as : null,
    )
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json' },
      body: await response.text(),
    })
  })
  return service
}

type Anchor = { path: string; nodeId: string; quote: string; start: number }

/** A quote that really is in the chapter: read off the built page's block. */
async function anchorIn(page: Page, at: string, nodeId: string, words: number): Promise<Anchor> {
  const text = await page.evaluate(
    async ({ at, nodeId }) => {
      const html = await (await fetch(at)).text()
      const doc = new DOMParser().parseFromString(html, 'text/html')
      return doc.getElementById(nodeId)?.textContent ?? ''
    },
    { at, nodeId },
  )
  const quote = text.trim().split(/\s+/).slice(0, words).join(' ')
  expect(quote.length).toBeGreaterThan(10)
  return { path: at, nodeId, quote, start: text.indexOf(quote) }
}

type Anchors = { loop: Anchor; sum: Anchor; values: Anchor }

/** The three chapters' anchors; any page of the site gives `fetch` its origin. */
async function anchors(page: Page): Promise<Anchors> {
  await page.goto(BOOK)
  return {
    loop: await anchorIn(page, LOOP, 'block-ch00-the-loop-prose-1', 6),
    sum: await anchorIn(page, SUM, 'block-sum-of-two-digits-card-1', 5),
    values: await anchorIn(page, VALUES, 'block-ch01-values-prose-1', 8),
  }
}

/** A page with no anchorable blocks (the front page, the map): a quote only. */
function pageAnchor(at: string, quote: string): Anchor {
  return { path: at, nodeId: 'block-none', quote, start: 0 }
}

const hunks = (...markup: string[]) =>
  formatHunks(markup.map((criticMarkup, index) => ({ baseStartLine: index + 1, baseEndLine: index + 1, criticMarkup })))

const sketchBody = (anchor: Anchor, note: string, region = { x: 0, y: 0, width: 0.8, height: 0.4 }) =>
  encodeSketch({
    version: 1,
    note,
    anchor: { blockId: anchor.nodeId, quote: anchor.quote },
    region,
    strokes: [[[0.1, 0.1], [0.5, 0.9], [0.9, 0.2]]],
  })

function annotation(
  anchor: Anchor,
  options: {
    motivation: 'highlighting' | 'commenting' | 'editing'
    body?: string
    color?: string
    parentId?: string
    visibility?: 'public' | 'private'
    /** The stored source, when it is not the anchor's page as is. */
    source?: string
    baseCommit?: string
    sourcePath?: string
  },
) {
  return {
    '@context': ['http://www.w3.org/ns/anno.jsonld', { margin: 'urn:margin:' }],
    type: 'Annotation',
    motivation: options.motivation,
    ...(options.body === undefined ? {} : { body: { type: 'TextualBody', value: options.body } }),
    ...(options.color ? { 'margin:color': options.color } : {}),
    ...(options.motivation === 'editing'
      ? {
          'margin:baseCommit': options.baseCommit ?? 'a'.repeat(40),
          'margin:sourcePath': options.sourcePath ?? 'books/chapters/ch00-the-loop.md',
        }
      : {}),
    ...(options.parentId ? { 'margin:parentId': options.parentId } : {}),
    'margin:visibility': options.visibility ?? 'private',
    target: {
      source: options.source ?? `${SITE}${anchor.path}`,
      selector: [
        { type: 'TextQuoteSelector', exact: anchor.quote, prefix: '', suffix: '' },
        { type: 'TextPositionSelector', start: anchor.start, end: anchor.start + [...anchor.quote].length },
        { type: 'margin:StructSelector', 'margin:nodeId': anchor.nodeId },
      ],
    },
  }
}

function bare(wire: Wire | string): string {
  return (typeof wire === 'string' ? wire : wire.id).replace('urn:margin:annotation:', '')
}

function entry(page: Page, id: Wire | string): Locator {
  return page.locator(`[data-annotation-entry="${bare(id)}"]`)
}

function groupIds(page: Page): Promise<(string | null)[]> {
  return page
    .locator('[data-annotations-chapter]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-annotations-chapter')))
}

/** The rail's entry for an annotation, inside its shadow root. */
function railEntry(page: Page, id: string): Locator {
  return page.locator('margin-rail').locator(`li[data-margin-annotation="${id}"]`)
}

async function focusedInRail(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => {
    const active = (node.getRootNode() as ShadowRoot).activeElement
    return node === active || node.contains(active)
  })
}

/** The text the rail's landing flash paints, from the Custom Highlight registry. */
async function flashedText(page: Page): Promise<string[]> {
  // The painter's own name for the `flash` colour, before any namespace suffix.
  return page.evaluate((prefix) => {
    const registry = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights
    return [...registry.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .flatMap(([, highlight]) => [...highlight].map((range) => range.toString()))
  }, highlightRegistryName('flash'))
}

async function openOverview(page: Page): Promise<void> {
  await page.goto(OVERVIEW)
  await expect(page.locator('[data-annotations-overview]')).toHaveAttribute('data-annotations-state', /complete|incomplete/)
}

/* ------------------------------------------------------------------------ */
/* Criterion 2: the page                                                     */
/* ------------------------------------------------------------------------ */

test.describe('the Annotations page lists', () => {
  test('the four kinds under their chapters in book order, each with its quote, date and only its own fields', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    // Written in neither book nor URL order.
    const highlight = await service.post(annotation(at.sum, { motivation: 'highlighting', color: 'question' }))
    const plain = await service.post(annotation(at.sum, { motivation: 'highlighting' }))
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Text plus text joins.', color: 'idea' }))
    const proposal = await service.post(
      annotation(at.loop, { motivation: 'editing', body: hunks('Every {~~challenge~>exercise~~} in this book.') }),
    )
    const sketch = await service.post(annotation(at.values, { motivation: 'commenting', body: sketchBody(at.values, 'Circled the total') }))
    await openOverview(page)

    expect(await groupIds(page)).toEqual(['ch00-the-loop', 'sum-of-two-digits', 'ch01-values'])
    // Group titles come from the manifest, not the API.
    await expect(page.locator('[data-annotations-chapter="ch01-values"] h2')).toHaveText('Values, names, and types')
    for (const [wire, group, kind, quote] of [
      [proposal, 'ch00-the-loop', 'proposal', at.loop.quote],
      [highlight, 'sum-of-two-digits', 'highlight', at.sum.quote],
      [plain, 'sum-of-two-digits', 'highlight', at.sum.quote],
      [note, 'ch01-values', 'note', at.values.quote],
      [sketch, 'ch01-values', 'sketch', at.values.quote],
    ] as const) {
      const item = page.locator(`[data-annotations-chapter="${group}"] [data-annotation-entry="${bare(wire)}"]`)
      await expect(item).toHaveAttribute('data-kind', kind)
      // Its seeded quote and date, every kind.
      await expect(item.locator('[data-entry-quote]')).toHaveText(quote)
      await expect(item.locator('time')).toHaveAttribute('datetime', wire.created)
    }

    // A highlight: its colour, no body. Saved without one: the rail's default.
    await expect(entry(page, highlight).locator('[data-entry-kind]')).toHaveText('Highlight')
    await expect(entry(page, highlight).locator('[data-entry-color]')).toHaveText('Question')
    await expect(entry(page, highlight).locator('[data-entry-body]')).toHaveCount(0)
    await expect(entry(page, plain).locator('[data-entry-color]')).toHaveAttribute('data-role', DEFAULT_HIGHLIGHT_ROLE)
    // A note: its body and its colour.
    await expect(entry(page, note).locator('[data-entry-body]')).toHaveText('Text plus text joins.')
    await expect(entry(page, note).locator('[data-entry-color]')).toHaveText('Idea')
    // A sketch: its note text and its preview, no colour.
    await expect(entry(page, sketch).locator('svg path')).toHaveCount(1)
    await expect(entry(page, sketch).locator('[data-entry-body]')).toHaveText('Circled the total')
    await expect(entry(page, sketch).locator('[data-entry-color]')).toHaveCount(0)
    // A proposal: the text it inserts and its state, no colour, no body.
    await expect(entry(page, proposal).locator('[data-proposal-summary]')).toHaveText('exercise')
    await expect(entry(page, proposal).locator('[data-proposal-state]')).toHaveText('Pending')
    await expect(entry(page, proposal).locator('[data-entry-color]')).toHaveCount(0)
    await expect(entry(page, proposal).locator('[data-entry-body]')).toHaveCount(0)
  })

  test('the book front page first, other pages last, and the chapters in manifest order between', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const map = await service.post(annotation(pageAnchor(MAP, 'The map'), { motivation: 'commenting', body: 'A note on the map.' }))
    await service.post(annotation(at.values, { motivation: 'highlighting' }))
    const front = await service.post(
      annotation(pageAnchor(BOOK, 'Build a Coding Agent'), { motivation: 'commenting', body: 'A note on the front page.' }),
    )
    await service.post(annotation(at.loop, { motivation: 'highlighting' }))
    await openOverview(page)

    expect(await groupIds(page)).toEqual(['book', 'ch00-the-loop', 'ch01-values', 'other'])
    const groups = page.locator('[data-annotations-chapter]')
    await expect(groups.first().locator('h2')).toHaveText('Book front page')
    await expect(groups.last().locator('h2')).toHaveText('Other pages')
    await expect(groups.first().locator(`[data-annotation-entry="${bare(front)}"] [data-entry-body]`)).toHaveText(
      'A note on the front page.',
    )
    await expect(groups.last().locator(`[data-annotation-entry="${bare(map)}"] [data-entry-page]`)).toHaveText(MAP)
  })

  test("the reader's own replies nested under their note, three deep, in the rail's order", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const root = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Root note.' }))
    const r1 = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Level one.', parentId: bare(root) }))
    const side = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Beside level one.', parentId: bare(root) }))
    const r2 = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Level two.', parentId: bare(r1) }))
    const r3 = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Level three.', parentId: bare(r2) }))
    await openOverview(page)

    // Replies are under the note, not entries of their own.
    for (const reply of [r1, side, r2, r3]) await expect(entry(page, reply)).toHaveCount(0)
    const order = flattenThread(
      bare(root),
      [r1, side, r2, r3].map((wire) => replyFromWebAnnotation(wire, null)!),
    ).map(({ reply }) => reply.serverId)
    expect(order).toEqual([bare(r1), bare(r2), bare(r3), bare(side)])
    const replies = entry(page, root).locator('[data-entry-replies] li')
    expect(await replies.evaluateAll((items) => items.map((item) => item.getAttribute('data-reply')))).toEqual(order)
    await expect(replies.locator('[data-reply-body]')).toHaveText(['Level one.', 'Level two.', 'Level three.', 'Beside level one.'])
    expect(await replies.evaluateAll((items) => items.map((item) => item.getAttribute('data-depth')))).toEqual(['1', '2', '3', '1'])
  })

  test("a reply to someone else's note under that note, fetched with the reply's own source", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const theirs = await service.post(
      annotation(at.values, { motivation: 'commenting', body: 'Their public note.', visibility: 'public' }),
      OTHER,
    )
    const mine = await service.post(annotation(at.values, { motivation: 'commenting', body: 'My reply to it.', parentId: bare(theirs) }))
    // Somebody else's public reply, and the reader's reply to that.
    const theirRoot = await service.post(
      annotation(at.sum, { motivation: 'commenting', body: 'Their public note on sum.', visibility: 'public' }),
      OTHER,
    )
    const theirReply = await service.post(
      annotation(at.sum, { motivation: 'commenting', body: 'Their public reply.', visibility: 'public', parentId: bare(theirRoot) }),
      OTHER,
    )
    const mineToReply = await service.post(
      annotation(at.sum, { motivation: 'commenting', body: 'My reply to their reply.', parentId: bare(theirReply) }),
    )
    await openOverview(page)

    const parent = entry(page, theirs)
    await expect(parent).toHaveAttribute('data-foreign-parent', 'visible')
    await expect(parent.locator('[data-someone-elses]')).toContainText('note, not yours')
    await expect(parent.locator('[data-entry-body]')).toHaveText('Their public note.')
    await expect(parent.locator('[data-entry-replies] [data-reply-body]')).toHaveText(['My reply to it.'])
    await expect(parent.locator('a[data-annotation-link]')).toHaveAttribute('href', `${VALUES}?annotation=${bare(mine)}`)
    expect(service.requests).toContain(
      `GET /api/margin/v1/annotations/${bare(theirs)}?source=${encodeURIComponent(`${SITE}${VALUES}`)}`,
    )

    // Only the one parent reply, and a link to its whole thread at its spot.
    const parentReply = entry(page, theirReply)
    await expect(parentReply).toHaveAttribute('data-foreign-parent', 'visible')
    await expect(parentReply.locator('[data-someone-elses]')).toContainText('reply, not yours')
    await expect(parentReply.locator('[data-entry-body]')).toHaveText('Their public reply.')
    await expect(parentReply.locator('a[data-thread-link]')).toHaveAttribute('href', `${SUM}?annotation=${bare(theirReply)}`)
    await expect(parentReply.locator('[data-entry-replies] [data-reply-body]')).toHaveText(['My reply to their reply.'])
    await expect(page.getByText('Their public note on sum.')).toHaveCount(0)
    await expect(entry(page, mineToReply)).toHaveCount(0)
  })

  test("two replies to one foreign parent: one request, the parent once, both replies under it", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const theirs = await service.post(
      annotation(at.values, { motivation: 'commenting', body: 'Their note, answered twice.', visibility: 'public' }),
      OTHER,
    )
    await service.post(annotation(at.values, { motivation: 'commenting', body: 'First reply.', parentId: bare(theirs) }))
    await service.post(annotation(at.values, { motivation: 'commenting', body: 'Second reply.', parentId: bare(theirs) }))
    await openOverview(page)

    await expect(entry(page, theirs)).toHaveCount(1)
    await expect(entry(page, theirs)).toHaveAttribute('data-foreign-parent', 'visible')
    await expect(page.getByText('Their note, answered twice.')).toHaveCount(1)
    await expect(entry(page, theirs).locator('[data-reply-body]')).toHaveText(['First reply.', 'Second reply.'])
    expect(service.requests.filter((request) => request.startsWith(`GET /api/margin/v1/annotations/${bare(theirs)}?`))).toHaveLength(1)
  })

  test('a reply on its own, with its link, when the parent lookup fails', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const theirs = await service.post(
      annotation(at.values, { motivation: 'commenting', body: 'Their public note.', visibility: 'public' }),
      OTHER,
    )
    const mine = await service.post(annotation(at.values, { motivation: 'commenting', body: 'My reply.', parentId: bare(theirs) }))
    service.override = (url, method) =>
      method === 'GET' && url.pathname === `/api/margin/v1/annotations/${bare(theirs)}`
        ? { status: 500, body: { error: { code: 'unavailable', message: 'down' } } }
        : null
    await openOverview(page)

    const alone = entry(page, theirs)
    await expect(alone).toHaveAttribute('data-foreign-parent', 'failed')
    await expect(alone.locator('[data-entry-replies] [data-reply-body]')).toHaveText(['My reply.'])
    await expect(alone.locator('a[data-annotation-link]')).toHaveAttribute('href', `${VALUES}?annotation=${bare(mine)}`)
    await expect(alone.locator('[data-someone-elses]')).toHaveCount(0)
    await expect(page.getByText('Their public note.')).toHaveCount(0)
  })

  test("a foreign parent's markup as text, never as HTML", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const payload = '<img src=x onerror="window.__xss=1">'
    const theirs = await service.post(
      annotation(at.values, { motivation: 'commenting', body: payload, visibility: 'public' }),
      OTHER,
    )
    await service.post(annotation(at.values, { motivation: 'commenting', body: payload, parentId: bare(theirs) }))
    await service.post(annotation(at.sum, { motivation: 'commenting', body: payload }))
    await openOverview(page)

    const parent = entry(page, theirs)
    await expect(parent).toHaveAttribute('data-foreign-parent', 'visible')
    await expect(parent.locator('[data-entry-body]')).toHaveText(payload)
    await expect(parent.locator('[data-reply-body]')).toHaveText(payload)
    await expect(page.locator('[data-annotations-overview] img')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined()
  })

  test("colours as the rail's highlightRole() gives them: legacy, unknown, and on a note", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const amber = await service.post(annotation(at.sum, { motivation: 'highlighting', color: 'amber' }))
    const unknown = await service.post(annotation(at.sum, { motivation: 'highlighting', color: 'chartreuse' }))
    const legacyNote = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Blue, once.', color: 'blue' }))
    await openOverview(page)

    await expect(entry(page, amber).locator('[data-entry-color]')).toHaveAttribute('data-role', highlightRole('amber'))
    await expect(entry(page, unknown).locator('[data-entry-color]')).toHaveAttribute('data-role', highlightRole('chartreuse'))
    await expect(entry(page, legacyNote).locator('[data-entry-color]')).toHaveAttribute('data-role', highlightRole('blue'))
    await expect(entry(page, legacyNote).locator('[data-entry-color]')).toHaveText('Question')
  })

  test('proposal summaries: a deletion, and markup that cannot be parsed, with the rest of the page intact', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const deletion = await service.post(
      annotation(at.loop, { motivation: 'editing', body: hunks('Every challenge {--in this book--} takes five steps.') }),
    )
    // Accepted by the service (the hunk envelope is valid), unreadable as CriticMarkup.
    const malformed = await service.post(annotation(at.loop, { motivation: 'editing', body: hunks('An {++unclosed insertion.') }))
    const after = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Still rendered.' }))
    await openOverview(page)

    await expect(entry(page, deletion).locator('[data-proposal-summary]')).toHaveText('Deletes: in this book')
    await expect(entry(page, malformed).locator('[data-proposal-summary]')).toHaveText('Proposed change')
    await expect(entry(page, malformed).locator('[data-proposal-state]')).toHaveText('Pending')
    await expect(entry(page, after).locator('[data-entry-body]')).toHaveText('Still rendered.')
  })

  test('a malformed sketch as a plain note, and a valid one with its preview', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const broken = `${SKETCH_PREFIX}{"version":1,"note":"half a sketch"`
    const malformed = await service.post(annotation(at.values, { motivation: 'commenting', body: broken }))
    const valid = await service.post(annotation(at.values, { motivation: 'commenting', body: sketchBody(at.values, 'A real drawing') }))
    await openOverview(page)

    await expect(entry(page, malformed)).toHaveAttribute('data-kind', 'note')
    await expect(entry(page, malformed).locator('[data-entry-body]')).toHaveText(broken)
    await expect(entry(page, malformed).locator('svg')).toHaveCount(0)
    await expect(entry(page, valid)).toHaveAttribute('data-kind', 'sketch')
    await expect(entry(page, valid).locator('svg.annotations-sketch')).toBeVisible()
  })

  test('proposal states: pending and withdrawn for real', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const pending = await service.post(annotation(at.loop, { motivation: 'editing', body: hunks('A {++kept++} one.') }))
    const withdrawn = await service.post(annotation(at.loop, { motivation: 'editing', body: hunks('A {++dropped++} one.') }))
    const response = await service.call(
      'POST',
      `/api/margin/v1/proposals/${bare(withdrawn)}/withdraw?source=${encodeURIComponent(`${SITE}${LOOP}`)}`,
    )
    expect(response.status).toBe(200)
    await openOverview(page)

    await expect(entry(page, pending).locator('[data-proposal-state]')).toHaveText('Pending')
    await expect(entry(page, withdrawn).locator('[data-proposal-state]')).toHaveText('Withdrawn')
  })

  test("proposal states: every one of issue 060's, from a stubbed /mine", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const template = await service.post(annotation(at.loop, { motivation: 'editing', body: hunks('A {++change++}.') }))
    // 060 produces these rows for real; here /mine is stubbed to carry them.
    const rows = PROPOSAL_STATES.map((state, index) => ({
      ...template,
      id: `urn:margin:annotation:state-${state}`,
      created: `2026-10-03T00:00:0${index}.000Z`,
      'margin:proposalState': state,
    }))
    service.override = (url) => (url.pathname === '/api/margin/v1/mine' ? { status: 200, body: { annotations: rows } } : null)
    await openOverview(page)

    for (const state of PROPOSAL_STATES) {
      await expect(entry(page, `state-${state}`).locator('[data-proposal-state]')).toHaveText(PROPOSAL_STATE_LABELS[state])
    }
    expect(new Set(Object.values(PROPOSAL_STATE_LABELS))).toEqual(
      new Set(['Pending', 'Withdrawn', 'Being applied', 'Applied', 'Needs attention', 'Closed']),
    )
  })

  test('a deleted note as "Deleted note", its reply still nested under it', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Soon gone.' }))
    await service.post(annotation(at.values, { motivation: 'commenting', body: 'The reply that keeps it.', parentId: bare(note) }))
    const deleted = await service.call('DELETE', `/api/margin/v1/annotations/${bare(note)}?source=${encodeURIComponent(`${SITE}${VALUES}`)}`)
    expect(deleted.status).toBe(200)
    await openOverview(page)

    await expect(entry(page, note).locator('[data-entry-kind]')).toHaveText('Deleted note')
    await expect(entry(page, note).locator('[data-entry-body]')).toHaveCount(0)
    await expect(page.getByText('Soon gone.')).toHaveCount(0)
    await expect(entry(page, note).locator('[data-entry-replies] [data-reply-body]')).toHaveText(['The reply that keeps it.'])
  })
})

/* ------------------------------------------------------------------------ */
/* Criterion 3: back to the spot                                             */
/* ------------------------------------------------------------------------ */

test.describe('an entry links back to its spot', () => {
  test('on its own stored document: a /map/ note links there and lands focused in its rail', async ({ page }) => {
    const service = await mountService(page)
    await anchors(page)
    const onMap = await service.post(annotation(pageAnchor(MAP, 'The map'), { motivation: 'commenting', body: 'On the map.' }))
    await openOverview(page)

    const link = entry(page, onMap).locator('a[data-annotation-link]')
    await expect(link).toHaveAttribute('href', `${MAP}?annotation=${bare(onMap)}`)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${MAP}\\?annotation=${bare(onMap)}$`))
    const target = railEntry(page, bare(onMap))
    await expect(target).toHaveAttribute('data-margin-target', '')
    await expect.poll(() => focusedInRail(target)).toBe(true)
  })

  test('a note: its anchor scrolled into view and painted, the note focused in the rail', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Land here.' }))
    await openOverview(page)

    await entry(page, note).locator('a[data-annotation-link]').click()
    await expect(page).toHaveURL(new RegExp(`${VALUES}\\?annotation=${bare(note)}$`))
    const target = railEntry(page, bare(note))
    await expect(target).toHaveAttribute('data-margin-target', '')
    await expect.poll(() => focusedInRail(target)).toBe(true)
    await expect(page.locator(`#${at.values.nodeId}`)).toBeInViewport()
    await expect(page.locator('margin-rail')).toHaveAttribute('data-flashing', '')
    await expect.poll(() => flashedText(page)).toEqual([at.values.quote])
  })

  test('a sketch: its drawing in view and its entry focused, no text painted', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const sketch = await service.post(
      annotation(at.values, {
        motivation: 'commenting',
        body: sketchBody(at.values, 'Look at this drawing', { x: 0.1, y: 0.1, width: 0.5, height: 0.3 }),
      }),
    )
    await openOverview(page)

    await entry(page, sketch).locator('a[data-annotation-link]').click()
    const target = railEntry(page, bare(sketch))
    await expect(target).toHaveAttribute('data-margin-target', '')
    await expect.poll(() => focusedInRail(target)).toBe(true)
    const overlay = page.locator(`[data-sketch-saved="${bare(sketch)}"]`)
    await expect(overlay).toHaveAttribute('data-sketch-target', '')
    await expect(overlay).toBeInViewport()
    await expect(page.locator('margin-rail')).not.toHaveAttribute('data-flashing', '')
    expect(await flashedText(page)).toEqual([])
  })

  test('a proposal: its diff open in edit mode, for its author', async ({ page }) => {
    const service = await mountService(page)
    await anchors(page)
    const stamp = await page.evaluate(async (at) => {
      const html = await (await fetch(at)).text()
      const doc = new DOMParser().parseFromString(html, 'text/html')
      return JSON.parse(doc.querySelector('script[data-book-source]')?.textContent ?? 'null') as {
        path: string
        commit: string
        text: string
      } | null
    }, VALUES)
    expect(stamp, 'the build stamps book pages with their source (a strict build)').not.toBeNull()
    expect(stamp!.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(stamp!.text).toContain('coach')
    const edited = stamp!.text.replace('coach', 'XYZZYQ')
    const proposal = await service.post(
      annotation(
        { path: VALUES, nodeId: 'block-ch01-values-prose-1', quote: 'coach', start: 0 },
        {
          motivation: 'editing',
          body: formatHunks(proposeHunks(stamp!.text, edited)),
          baseCommit: stamp!.commit,
          sourcePath: stamp!.path,
        },
      ),
    )
    await openOverview(page)
    await expect(entry(page, proposal).locator('[data-proposal-summary]')).toHaveText('XYZZYQ')

    await entry(page, proposal).locator('a[data-annotation-link]').click()
    await expect(page.locator('html')).toHaveAttribute('data-book-editing', '')
    await expect(page.locator('[data-edit-surface]')).toBeVisible()
    await expect(page.locator('[data-edit-surface]')).toContainText('XYZZYQ')
    await expect(railEntry(page, bare(proposal))).toHaveAttribute('data-margin-target', '')
    expect(await flashedText(page)).toEqual([])
  })

  test("the reader's own reply: focused in its thread", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'A note.' }))
    const reply = await service.post(annotation(at.values, { motivation: 'commenting', body: 'My reply.', parentId: bare(note) }))
    await openOverview(page)

    const link = entry(page, note).locator(`[data-reply="${bare(reply)}"] a[data-reply-link]`)
    await expect(link).toHaveAttribute('href', `${VALUES}?annotation=${bare(reply)}`)
    await link.click()
    const target = page.locator('margin-rail').locator(`#margin-reply-${bare(reply)}`)
    await expect(target).toBeVisible()
    await expect.poll(() => target.evaluate((node) => (node.getRootNode() as ShadowRoot).activeElement === node)).toBe(true)
  })

  test('one whose text changed: the rail says so on landing', async ({ page }) => {
    const service = await mountService(page)
    await anchors(page)
    const changed = await service.post(
      annotation(
        { path: VALUES, nodeId: 'block-ch01-values-prose-1', quote: 'a sentence this chapter no longer has in it', start: 0 },
        { motivation: 'commenting', body: 'Was about a sentence that went away.' },
      ),
    )
    await openOverview(page)
    // The overview does not try to tell: it has no placements.
    await expect(entry(page, changed).getByText(/text changed/i)).toHaveCount(0)

    await entry(page, changed).locator('a[data-annotation-link]').click()
    const target = railEntry(page, bare(changed))
    await expect(target).toHaveAttribute('data-orphaned', /.+/)
    await expect(page.locator('margin-rail').locator('[data-margin-target-notice]')).toHaveText(/text changed/i)
    await expect.poll(() => focusedInRail(target)).toBe(true)
    await expect(target).toContainText('Was about a sentence that went away.')
  })

  test("past the destination rail's first page: still focused once the rail has paged to it", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    // The rail asks for 100 a page; the one clicked is the 106th.
    for (let index = 0; index < 105; index += 1) {
      await service.post(annotation(at.values, { motivation: 'highlighting' }))
    }
    const last = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Far down the list.' }))
    await openOverview(page)

    await entry(page, last).locator('a[data-annotation-link]').click()
    const target = railEntry(page, bare(last))
    await expect(target).toHaveAttribute('data-margin-target', '')
    await expect.poll(() => focusedInRail(target)).toBe(true)
    expect(service.requests.filter((request) => request.startsWith('GET /api/margin/v1/annotations?') && request.includes('cursor='))).not.toHaveLength(0)
  })

  test('on a phone: the rail overlay opens on the entry', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'On a phone.' }))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${VALUES}?annotation=${bare(note)}`)
    const target = railEntry(page, bare(note))
    await expect(target).toBeVisible()
    await expect.poll(() => focusedInRail(target)).toBe(true)
  })
})

/* ------------------------------------------------------------------------ */
/* Criteria 1, 5, 6, 7: loading, failure, empty, signed out, filters          */
/* ------------------------------------------------------------------------ */

test.describe('loading the list', () => {
  test("follows nextCursor past the endpoint's page cap", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const total = MAX_PAGE_SIZE + 5
    for (let index = 0; index < total; index += 1) {
      await service.post(annotation(index % 2 ? at.sum : at.values, { motivation: 'highlighting' }))
    }
    await openOverview(page)
    await expect(page.locator('[data-annotation-entry]')).toHaveCount(total)
    expect(service.requests.filter((request) => request.startsWith('GET /api/margin/v1/mine')).length).toBeGreaterThan(1)
  })

  test("asks for exactly this book's prefix: an owned row in another book never appears", async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const here = await service.post(annotation(at.values, { motivation: 'commenting', body: 'In this book.' }))
    const elsewhere = await service.post(
      annotation(pageAnchor('/books/another-book/ch01/', 'Another book'), { motivation: 'commenting', body: 'In another book.' }),
    )
    await openOverview(page)

    await expect(entry(page, here)).toBeVisible()
    await expect(entry(page, elsewhere)).toHaveCount(0)
    await expect(page.getByText('In another book.')).toHaveCount(0)
    const mine = service.requests.filter((request) => request.startsWith('GET /api/margin/v1/mine?'))
    expect(mine).toHaveLength(1)
    const query = new URLSearchParams(mine[0].slice(mine[0].indexOf('?') + 1))
    expect(query.getAll('prefix')).toEqual([BOOK])
    expect(query.get('site')).toBe(SITE)
  })

  for (const failure of ['error', 'timeout', 'malformed'] as const) {
    test(`a failed /auth/me (${failure}) is a retryable load error, not the sign-in prompt`, async ({ page }) => {
      const service = await mountService(page)
      const at = await anchors(page)
      const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Mine all along.' }))
      service.authFailure = failure
      await page.goto(OVERVIEW)

      const problem = page.locator('[data-annotations-problem]')
      await expect(page.locator('[data-annotations-overview]')).toHaveAttribute('data-annotations-state', 'failed')
      await expect(problem).toContainText('Could not load your annotations')
      await expect(page.getByRole('link', { name: /sign in/i })).toHaveCount(0)
      await expect(page.getByText(/no annotations in this book/i)).toHaveCount(0)
      expect(service.requests.filter((request) => request.startsWith('GET /api/margin/v1/mine'))).toHaveLength(0)

      service.authFailure = null
      await problem.getByRole('button', { name: 'Retry' }).click()
      await expect(entry(page, note)).toBeVisible()
      await expect(problem).toBeHidden()
    })
  }

  test('a first failure says so, with Retry, and never shows the empty state', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'There all along.' }))
    let failing = true
    service.override = (url) =>
      failing && url.pathname === '/api/margin/v1/mine' ? { status: 500, body: { error: { code: 'down' } } } : null
    await page.goto(OVERVIEW)

    const problem = page.locator('[data-annotations-problem]')
    await expect(problem).toBeVisible()
    await expect(problem).toContainText('Could not load your annotations')
    await expect(page.locator('[data-annotations-overview]')).toHaveAttribute('data-annotations-state', 'failed')
    await expect(page.getByText(/no annotations in this book/i)).toHaveCount(0)

    failing = false
    await problem.getByRole('button', { name: 'Retry' }).click()
    await expect(entry(page, note)).toBeVisible()
    await expect(problem).toBeHidden()
  })

  test('a failure on page two keeps page one, marked incomplete, and Retry completes it', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const total = MAX_PAGE_SIZE + 3
    for (let index = 0; index < total; index += 1) {
      await service.post(annotation(at.values, { motivation: 'highlighting' }))
    }
    let failing = true
    service.override = (url) =>
      failing && url.pathname === '/api/margin/v1/mine' && url.searchParams.has('cursor')
        ? { status: 503, body: { error: { code: 'down' } } }
        : null
    await page.goto(OVERVIEW)

    const overview = page.locator('[data-annotations-overview]')
    await expect(overview).toHaveAttribute('data-annotations-state', 'incomplete')
    await expect(page.locator('[data-annotation-entry]')).toHaveCount(MAX_PAGE_SIZE)
    await expect(page.locator('[data-annotations-problem]')).toContainText('incomplete')

    failing = false
    const before = service.requests.length
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(overview).toHaveAttribute('data-annotations-state', 'complete')
    await expect(page.locator('[data-annotation-entry]')).toHaveCount(total)
    // It went on from the failed cursor, not from the start.
    const resumed = service.requests.slice(before).filter((request) => request.startsWith('GET /api/margin/v1/mine'))
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toContain('cursor=')
  })

  test('signed in with nothing yet: it says so and points to the first chapter', async ({ page }) => {
    await mountService(page)
    await page.goto(OVERVIEW)
    const status = page.locator('[data-annotations-status]')
    await expect(status).toContainText(/no annotations in this book/i)
    await expect(status.getByRole('link')).toHaveAttribute('href', FIRST_NODE)
  })

  test('signed out: the sign-in prompt, linking back to this page', async ({ page }) => {
    const service = await mountService(page)
    service.signedIn = false
    await page.goto(OVERVIEW)
    const link = page.locator('[data-annotations-status]').getByRole('link', { name: 'Sign in to see your annotations' })
    await expect(link).toHaveAttribute('href', `/auth/login?return_to=${encodeURIComponent(OVERVIEW)}`)
    await expect(page.locator('[data-annotation-entry]')).toHaveCount(0)
  })

  test('the kind filter, the chapter filter, and clearing both, without asking the service again', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    const highlight = await service.post(annotation(at.sum, { motivation: 'highlighting' }))
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'A note.' }))
    const sketch = await service.post(annotation(at.values, { motivation: 'commenting', body: sketchBody(at.values, 'Drawn') }))
    const proposal = await service.post(annotation(at.loop, { motivation: 'editing', body: hunks('A {++b++}.') }))
    await openOverview(page)
    const visible = page.locator('[data-annotation-entry]:visible')
    await expect(visible).toHaveCount(4)
    const before = service.requests.length

    await page.getByLabel('Kind').selectOption('sketch')
    await expect(visible).toHaveCount(1)
    await expect(entry(page, sketch)).toBeVisible()

    await page.getByLabel('Kind').selectOption('all')
    await page.getByLabel('Chapter').selectOption('ch01-values')
    await expect(visible).toHaveCount(2)
    await expect(page.locator('[data-annotations-chapter]:visible')).toHaveCount(1)
    await expect(entry(page, note)).toBeVisible()

    await page.getByLabel('Kind').selectOption('proposal')
    await expect(visible).toHaveCount(0)
    await expect(page.locator('[data-annotations-filter-empty]')).toBeVisible()

    await page.getByLabel('Kind').selectOption('all')
    await page.getByLabel('Chapter').selectOption('all')
    await expect(visible).toHaveCount(4)
    for (const wire of [highlight, note, sketch, proposal]) await expect(entry(page, wire)).toBeVisible()
    expect(service.requests.length).toBe(before)
  })

  test('fits a 390px phone without sideways scrolling, and a 1280px window', async ({ page }) => {
    const service = await mountService(page)
    const at = await anchors(page)
    await service.post(annotation(at.loop, { motivation: 'editing', body: hunks('Every {~~challenge~>exercise~~} in this book.') }))
    await service.post(annotation(at.sum, { motivation: 'highlighting', color: 'question' }))
    const note = await service.post(annotation(at.values, { motivation: 'commenting', body: 'Text plus text joins.', color: 'idea' }))
    await service.post(annotation(at.values, { motivation: 'commenting', body: 'And numbers add.', parentId: bare(note) }))
    await service.post(annotation(at.values, { motivation: 'commenting', body: sketchBody(at.values, 'Circled the total') }))
    const theirs = await service.post(
      annotation(at.values, { motivation: 'commenting', body: 'Their public note.', visibility: 'public' }),
      OTHER,
    )
    await service.post(annotation(at.values, { motivation: 'commenting', body: 'My reply to theirs.', parentId: bare(theirs) }))
    await service.post(annotation(pageAnchor(MAP, 'The map'), { motivation: 'commenting', body: 'A note on the map.' }))
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await openOverview(page)
      await expect(page.locator('[data-annotation-entry]')).toHaveCount(6)
      await expect(entry(page, theirs)).toHaveAttribute('data-foreign-parent', 'visible')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `${width}px scrolls sideways`).toBeLessThanOrEqual(0)
      await page.screenshot({ path: path.join(SCREENSHOTS, `annotations-overview-${width}.png`), fullPage: true })
    }
  })
})

/* ------------------------------------------------------------------------ */
/* Criterion 4: the book bar                                                 */
/* ------------------------------------------------------------------------ */

test.describe('the book bar', () => {
  test('the plain bar keeps every control in view on a 320px phone, signed in', async ({ page }) => {
    await mountService(page)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('book-look', 'plain')
      } catch {
        // No storage: the default look, and the test below says so.
      }
    })
    await page.setViewportSize({ width: 320, height: 640 })
    for (const at of [BOOK, OVERVIEW, VALUES]) {
      await page.goto(at)
      await expect(page.locator('html')).toHaveAttribute('data-book-look', 'plain')
      await expect(page.locator('[data-book-annotations-link]')).toBeVisible()
      const bar = page.locator('[data-book-bar]')
      expect(await bar.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${at} bar overflows`).toBe(true)
      for (const control of [
        '[data-book-map-link]',
        '[data-book-annotations-link]',
        '[data-book-look-choice="site"]',
        '[data-book-theme-toggle]',
      ]) {
        const box = await page.locator(control).boundingBox()
        expect(box, `${at} ${control}`).not.toBeNull()
        expect(box!.x + box!.width, `${at} ${control} is clipped`).toBeLessThanOrEqual(320)
      }
    }
  })

  for (const look of ['site', 'plain'] as const) {
    test(`links to Annotations next to Map in the ${look} look, signed in only`, async ({ page }) => {
      const service = await mountService(page)
      await page.addInitScript((value) => {
        try {
          localStorage.setItem('book-look', value)
        } catch {
          // A test with no storage simply gets the default look.
        }
      }, look)
      await page.goto(VALUES)
      await expect(page.locator('html')).toHaveAttribute('data-book-look', look)
      const link = page.locator('[data-book-annotations-link]')
      await expect(link).toBeVisible()
      await expect(link).toHaveAccessibleName('Annotations')
      await expect(link).toHaveAttribute('href', OVERVIEW)
      expect(
        await link.evaluate((node) => node.previousElementSibling?.hasAttribute('data-book-map-link') ?? false),
      ).toBe(true)

      service.signedIn = false
      await page.reload()
      await expect(page.locator('[data-book-map-link]')).toBeVisible()
      await expect(link).toBeHidden()
    })
  }
})
