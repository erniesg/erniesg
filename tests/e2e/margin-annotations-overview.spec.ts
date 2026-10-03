import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { encodeSketch } from '../../packages/margin/src/sketch'
import { formatHunks } from '../../src/annotations/criticmarkup'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'

/**
 * The per-book Annotations page (issue 073). `/api/margin/v1/*` is answered in
 * this process by the production router over a fresh SQLite database built
 * from every migration, and `/auth/me` says who is signed in, as in
 * `margin-edit-mode.spec.ts`. The pages are the dev server's own.
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

const SCREENSHOTS = path.resolve(process.env.AGENT_EVIDENCE_DIR ?? '.agent/evidence', 'screenshots')

const OWNER: Principal = { provider: 'dev', issuer: 'urn:margin:dev', subject: 'owner' }
const OTHER: Principal = { provider: 'dev', issuer: 'urn:margin:dev', subject: 'other' }

type Wire = { id: string }

type Service = {
  signedIn: boolean
  as: Principal
  post(body: unknown, as?: Principal): Promise<Wire>
}

async function mountService(page: Page): Promise<Service> {
  const database = SqliteD1Database.inMemory()
  const repository = new D1MarginRepository(database)
  let clock = 0
  let sequence = 0
  const call = (request: Request, as: Principal | null) =>
    handleMarginRequest(request, {
      repository,
      principal: as,
      now: () => new Date(Date.UTC(2026, 9, 3, 0, 0, 0, (clock += 1))).toISOString(),
      newId: () => `overview-${String((sequence += 1)).padStart(3, '0')}`,
    })
  const service: Service = {
    signedIn: true,
    as: OWNER,
    async post(body, as = OWNER) {
      const response = await call(
        new Request(`${SITE}/api/margin/v1/annotations`, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
        as,
      )
      expect(response.status).toBe(201)
      return (await response.json()) as Wire
    },
  }
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: service.signedIn ? 200 : 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        service.signedIn
          ? { authenticated: true, principal: service.as, canWrite: true, isAdmin: false }
          : { error: 'unauthenticated' },
      ),
    }),
  )
  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    const url = new URL(incoming.url())
    const response = await call(
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
async function anchorIn(page: Page, path: string, nodeId: string, words: number): Promise<Anchor> {
  const text = await page.evaluate(
    async ({ path, nodeId }) => {
      const html = await (await fetch(path)).text()
      const doc = new DOMParser().parseFromString(html, 'text/html')
      return doc.getElementById(nodeId)?.textContent ?? ''
    },
    { path, nodeId },
  )
  const quote = text.trim().split(/\s+/).slice(0, words).join(' ')
  expect(quote.length).toBeGreaterThan(10)
  return { path, nodeId, quote, start: text.indexOf(quote) }
}

function annotation(
  anchor: Anchor,
  options: {
    motivation: 'highlighting' | 'commenting' | 'editing'
    body?: string
    color?: string
    parentId?: string
    visibility?: 'public' | 'private'
  },
) {
  return {
    '@context': ['http://www.w3.org/ns/anno.jsonld', { margin: 'urn:margin:' }],
    type: 'Annotation',
    motivation: options.motivation,
    ...(options.body === undefined ? {} : { body: { type: 'TextualBody', value: options.body } }),
    ...(options.color ? { 'margin:color': options.color } : {}),
    ...(options.motivation === 'editing'
      ? { 'margin:baseCommit': 'a'.repeat(40), 'margin:sourcePath': 'books/chapters/ch00-the-loop.md' }
      : {}),
    ...(options.parentId ? { 'margin:parentId': options.parentId } : {}),
    'margin:visibility': options.visibility ?? 'private',
    target: {
      source: `${SITE}${anchor.path}`,
      selector: [
        { type: 'TextQuoteSelector', exact: anchor.quote, prefix: '', suffix: '' },
        { type: 'TextPositionSelector', start: anchor.start, end: anchor.start + [...anchor.quote].length },
        { type: 'margin:StructSelector', 'margin:nodeId': anchor.nodeId },
      ],
    },
  }
}

function bare(wire: Wire): string {
  return wire.id.replace('urn:margin:annotation:', '')
}

type Seeded = {
  proposal: string
  highlight: string
  note: string
  reply: string
  sketch: string
  changed: string
}

/** The four kinds, a reply, one whose text changed, and someone else's note. */
async function seed(page: Page, service: Service): Promise<Seeded> {
  // Any page of the site, so `fetch` in `anchorIn` has an origin.
  await page.goto(BOOK)
  const loop = await anchorIn(page, LOOP, 'block-ch00-the-loop-prose-1', 6)
  const sum = await anchorIn(page, SUM, 'block-sum-of-two-digits-card-1', 5)
  const values = await anchorIn(page, VALUES, 'block-ch01-values-prose-1', 8)

  // Written in neither book nor URL order.
  const highlight = await service.post(annotation(sum, { motivation: 'highlighting', color: 'question' }))
  const note = await service.post(
    annotation(values, { motivation: 'commenting', body: 'Text plus text joins.', color: 'idea' }),
  )
  const proposal = await service.post(
    annotation(loop, {
      motivation: 'editing',
      body: formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: 'Every {~~challenge~>exercise~~}.' }]),
    }),
  )
  const sketch = await service.post(
    annotation(values, {
      motivation: 'commenting',
      body: encodeSketch({
        version: 1,
        note: 'Circled the total',
        anchor: { blockId: values.nodeId, quote: values.quote },
        region: { x: 0, y: 0, width: 40, height: 20 },
        strokes: [[[0.1, 0.1], [0.5, 0.9], [0.9, 0.2]]],
      }),
    }),
  )
  const reply = await service.post(
    annotation(values, { motivation: 'commenting', body: 'And numbers add.', parentId: bare(note) }),
  )
  const changed = await service.post(
    annotation(
      { ...values, quote: 'a sentence this chapter no longer has in it', start: 0 },
      { motivation: 'commenting', body: 'Was about a sentence that went away.' },
    ),
  )
  // Somebody else's public note on the same chapter: never on this page.
  await service.post(
    annotation(values, { motivation: 'commenting', body: 'Not yours to list.', visibility: 'public' }),
    OTHER,
  )
  return {
    proposal: bare(proposal),
    highlight: bare(highlight),
    note: bare(note),
    reply: bare(reply),
    sketch: bare(sketch),
    changed: bare(changed),
  }
}

function entry(page: Page, id: string): Locator {
  return page.locator(`[data-annotation-entry="${id}"]`)
}

/** The rail's entry for an annotation, inside its shadow root. */
function railEntry(page: Page, id: string): Locator {
  return page.locator('margin-rail').locator(`li[data-margin-annotation="${id}"]`)
}

test.describe('the Annotations page', () => {
  test('lists every kind under its chapter, in book order, with replies under their parent', async ({ page }) => {
    const service = await mountService(page)
    const ids = await seed(page, service)
    await page.goto(OVERVIEW)

    const chapters = page.locator('[data-annotations-chapter]')
    await expect(chapters).toHaveCount(3)
    expect(await chapters.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-annotations-chapter')))).toEqual([
      'ch00-the-loop',
      'sum-of-two-digits',
      'ch01-values',
    ])
    // Chapter titles come from the book, not the API.
    await expect(chapters.nth(2).locator('h2')).toContainText('Values, names, and types')

    const loop = page.locator('[data-annotations-chapter="ch00-the-loop"]')
    const sum = page.locator('[data-annotations-chapter="sum-of-two-digits"]')
    const values = page.locator('[data-annotations-chapter="ch01-values"]')
    await expect(loop.locator(`[data-annotation-entry="${ids.proposal}"]`)).toHaveAttribute('data-kind', 'proposal')
    await expect(sum.locator(`[data-annotation-entry="${ids.highlight}"]`)).toHaveAttribute('data-kind', 'highlight')
    await expect(values.locator(`[data-annotation-entry="${ids.note}"]`)).toHaveAttribute('data-kind', 'note')
    await expect(values.locator(`[data-annotation-entry="${ids.sketch}"]`)).toHaveAttribute('data-kind', 'sketch')

    // Kind, quote, body, colour and date.
    const highlight = entry(page, ids.highlight)
    await expect(highlight.locator('[data-entry-kind]')).toHaveText('Highlight')
    await expect(highlight.locator('[data-entry-color]')).toHaveText('Question')
    await expect(highlight.locator('time')).toHaveAttribute('datetime', /^2026-10-03T/)
    await expect(highlight.locator('blockquote')).not.toBeEmpty()
    const note = entry(page, ids.note)
    await expect(note.locator('[data-entry-body]')).toHaveText('Text plus text joins.')
    await expect(note.locator('[data-entry-color]')).toHaveText('Idea')
    // A sketch is drawn, read-only, and its note is its text.
    const sketch = entry(page, ids.sketch)
    await expect(sketch.locator('svg path')).toHaveCount(1)
    await expect(sketch.locator('[data-entry-body]')).toHaveText('Circled the total')
    // A proposal says where it stands.
    await expect(entry(page, ids.proposal).locator('[data-proposal-state]')).toHaveText('Pending')

    // The reply is under its note, not an entry of its own.
    await expect(entry(page, ids.reply)).toHaveCount(0)
    await expect(note.locator('[data-entry-replies] li')).toHaveText(['And numbers add.'])

    // Nobody else's annotation, whatever its visibility.
    await expect(page.getByText('Not yours to list.')).toHaveCount(0)
    await expect(page.locator('[data-annotation-entry]')).toHaveCount(5)
  })

  test('filters by kind and by chapter, without asking the service again', async ({ page }) => {
    const service = await mountService(page)
    const ids = await seed(page, service)
    await page.goto(OVERVIEW)
    await expect(page.locator('[data-annotation-entry]')).toHaveCount(5)

    let requests = 0
    page.on('request', (request) => {
      if (request.url().includes('/api/margin/')) requests += 1
    })
    await page.getByLabel('Kind').selectOption('sketch')
    await expect(page.locator('[data-annotation-entry]:visible')).toHaveCount(1)
    await expect(entry(page, ids.sketch)).toBeVisible()

    await page.getByLabel('Kind').selectOption('all')
    await page.getByLabel('Chapter').selectOption('ch01-values')
    await expect(page.locator('[data-annotation-entry]:visible')).toHaveCount(3)
    await expect(page.locator('[data-annotations-chapter="ch00-the-loop"]')).toBeHidden()

    await page.getByLabel('Kind').selectOption('highlight')
    await expect(page.locator('[data-annotation-entry]:visible')).toHaveCount(0)
    await expect(page.locator('[data-annotations-filter-empty]')).toBeVisible()
    expect(requests).toBe(0)
  })

  test('an entry links to its exact spot: the chapter opens with it focused in the rail', async ({ page }) => {
    const service = await mountService(page)
    const ids = await seed(page, service)
    await page.goto(OVERVIEW)

    const link = entry(page, ids.note).locator('a[data-annotation-link]')
    await expect(link).toHaveAttribute('href', `${VALUES}?annotation=${ids.note}`)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${VALUES}\\?annotation=${ids.note}$`))

    const target = railEntry(page, ids.note)
    await expect(target).toHaveAttribute('data-margin-target', '')
    await expect.poll(() =>
      target.evaluate((node) => node.contains((node.getRootNode() as ShadowRoot).activeElement)),
    ).toBe(true)
    await expect(target).toBeInViewport()
    // Its passage is flashed in the text.
    await expect(page.locator('margin-rail')).toHaveAttribute('data-flashing', '')
  })

  test('on a phone the link opens the rail overlay on its entry, and a reply lands on the reply', async ({ page }) => {
    const service = await mountService(page)
    const ids = await seed(page, service)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto(`${VALUES}?annotation=${ids.sketch}`)
    const target = railEntry(page, ids.sketch)
    await expect(target).toHaveAttribute('data-margin-target', '')
    await expect(target).toBeVisible()
    await expect.poll(() =>
      target.evaluate((node) => node.contains((node.getRootNode() as ShadowRoot).activeElement)),
    ).toBe(true)

    await page.goto(`${VALUES}?annotation=${ids.reply}`)
    const reply = page.locator('margin-rail').locator(`#margin-reply-${ids.reply}`)
    await expect(reply).toBeVisible()
    await expect.poll(() =>
      reply.evaluate((node) => (node.getRootNode() as ShadowRoot).activeElement === node),
    ).toBe(true)
  })

  test('an annotation whose text changed says so on the page and in the rail', async ({ page }) => {
    const service = await mountService(page)
    const ids = await seed(page, service)
    await page.goto(OVERVIEW)

    const changed = entry(page, ids.changed)
    await expect(changed.locator('[data-text-changed]')).toHaveText(/text changed/i)
    await expect(entry(page, ids.note).locator('[data-text-changed]')).toHaveCount(0)

    await changed.locator('a[data-annotation-link]').click()
    const target = railEntry(page, ids.changed)
    await expect(target).toHaveAttribute('data-margin-target', '')
    await expect(target).toHaveAttribute('data-orphaned', /.+/)
    await expect(page.locator('margin-rail').locator('[data-margin-target-notice]')).toHaveText(/text changed/i)
    await expect.poll(() =>
      target.evaluate((node) => node.contains((node.getRootNode() as ShadowRoot).activeElement)),
    ).toBe(true)
    // Still shown, still readable.
    await expect(target).toContainText('Was about a sentence that went away.')
  })

  test('fits a 390px phone without sideways scrolling, and a 1280px window', async ({ page }) => {
    const service = await mountService(page)
    const ids = await seed(page, service)
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(OVERVIEW)
      await expect(page.locator('[data-annotation-entry]')).toHaveCount(5)
      await expect(entry(page, ids.changed).locator('[data-text-changed]')).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `${width}px scrolls sideways`).toBeLessThanOrEqual(0)
      await page.screenshot({
        path: path.join(SCREENSHOTS, `annotations-overview-${width}.png`),
        fullPage: true,
      })
    }
  })

  test('signed in with nothing yet, it says so and points to the first chapter', async ({ page }) => {
    await mountService(page)
    await page.goto(OVERVIEW)
    const status = page.locator('[data-annotations-status]')
    await expect(status).toContainText(/no annotations/i)
    await expect(status.getByRole('link')).toHaveAttribute('href', `${BOOK}front-matter/`)
  })

  test('signed out, it shows the sign-in prompt', async ({ page }) => {
    const service = await mountService(page)
    service.signedIn = false
    await page.goto(OVERVIEW)
    const status = page.locator('[data-annotations-status]')
    await expect(status).toContainText(/sign in/i)
    await expect(status.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      `/auth/login?return_to=${encodeURIComponent(OVERVIEW)}`,
    )
    await expect(page.locator('[data-annotation-entry]')).toHaveCount(0)
  })
})

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
      await expect(link).toHaveText('Annotations')
      await expect(link).toHaveAttribute('href', OVERVIEW)
      // Beside Map.
      expect(
        await link.evaluate(
          (node) => node.previousElementSibling?.hasAttribute('data-book-map-link') ?? false,
        ),
      ).toBe(true)

      service.signedIn = false
      await page.reload()
      await expect(page.locator('[data-book-map-link]')).toBeVisible()
      await expect(link).toBeHidden()
    })
  }
})
