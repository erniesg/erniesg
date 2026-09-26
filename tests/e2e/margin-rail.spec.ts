import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { principalKey } from '../../src/worker/margin/identity'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * The margin rail on a real book page, with the real service behind it.
 *
 * `/api/margin/v1/*` is answered in this process by the production router over
 * a real SQLite database built from the production migration — the same
 * harness the route and visibility suites use. So "the service refused it",
 * "the service never sent it" and "the row is still private" below are the
 * router and SQL deciding, not a stub agreeing with the test.
 *
 * Who is asking is the one thing the test controls: `service.as` stands in for
 * the session cookie the Worker would otherwise read.
 */

const CHAPTER = '/books/build-a-coding-agent/ch12-hash-maps/'
const RAIL = 'margin-rail'
const ENTRY = `${RAIL} li[data-margin-annotation]`
const POPUP = `${RAIL} [data-margin-popup]`

const ADA: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'ada',
}
const BOB: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'bob',
}

type WireAnnotation = {
  id: string
  creator: string
  motivation: string
  'margin:visibility': string
  'margin:color'?: string
  body?: { value: string }
  target: { source: string; selector: Record<string, unknown>[] }
}

type Service = {
  as: Principal | null
  /** Every list response the service sent, as the browser received it. */
  listed: { as: string | null; annotations: WireAnnotation[] }[]
  rows(): Promise<WireAnnotation[]>
  prefs(principal: Principal): Promise<{ defaultVisibility: string }>
  post(body: unknown, principal: Principal): Promise<Response>
}

let documentUri = ''

async function mountService(page: Page): Promise<Service> {
  const database = SqliteD1Database.inMemory()
  const repository = new D1MarginRepository(database)
  let clock = 0
  let sequence = 0
  const call = (request: Request, principal: Principal | null) =>
    handleMarginRequest(request, {
      repository,
      principal,
      now: () => {
        clock += 1
        return new Date(Date.UTC(2026, 8, 26, 0, 0, 0, clock)).toISOString()
      },
      newId: () => {
        sequence += 1
        return `annotation-${String(sequence).padStart(3, '0')}`
      },
    })

  const service: Service = {
    as: ADA,
    listed: [],
    async rows() {
      // Every row, whoever owns it: read as each owner and merge.
      const seen = new Map<string, WireAnnotation>()
      for (const principal of [ADA, BOB]) {
        const response = await call(
          new Request(
            `https://ernie.sg/api/margin/v1/annotations?source=${encodeURIComponent(documentUri)}`,
          ),
          principal,
        )
        const body = (await response.json()) as {
          annotations: WireAnnotation[]
        }
        for (const row of body.annotations) seen.set(row.id, row)
      }
      return [...seen.values()]
    },
    async prefs(principal) {
      const response = await call(
        new Request('https://ernie.sg/api/margin/v1/prefs'),
        principal,
      )
      return response.json()
    },
    post: (body, principal) =>
      call(
        new Request('https://ernie.sg/api/margin/v1/annotations', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
        principal,
      ),
  }

  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    const request = new Request(incoming.url(), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: incoming.postData() ?? undefined }),
    })
    const response = await call(request, service.as)
    const text = await response.text()
    if (
      method === 'GET' &&
      new URL(incoming.url()).pathname.endsWith('/annotations') &&
      response.ok
    ) {
      service.listed.push({
        as: service.as ? principalKey(service.as) : null,
        annotations: JSON.parse(text).annotations,
      })
    }
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json' },
      body: text,
    })
  })
  return service
}

async function open(page: Page, width = 1440) {
  await installStaticRoutes(page)
  await page.setViewportSize({ width, height: 1000 })
  await page.goto(CHAPTER)
  await expect(
    page.locator(`${RAIL} [data-margin-action="keyboard-select"]`),
  ).toBeAttached()
  documentUri = (await page
    .locator(RAIL)
    .getAttribute('document-uri')) as string
  expect(documentUri).toMatch(/^https:\/\//)
}

/** Long prose blocks, by id, in document order. */
async function proseBlocks(page: Page, minimum = 120): Promise<string[]> {
  return page.evaluate(
    (minimum) =>
      Array.from(
        document.querySelectorAll('.book-content [data-block-kind="prose"]'),
      )
        .filter((block) => (block.textContent ?? '').length > minimum)
        .map((block) => block.id),
    minimum,
  )
}

async function selectWithin(
  page: Page,
  blockId: string,
  start: number,
  end: number,
) {
  await page.evaluate(
    ({ blockId, start, end }) => {
      const block = document.getElementById(blockId)!
      const point = (offset: number) => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
        let seen = 0
        let node = walker.nextNode() as Text | null
        while (node) {
          if (offset <= seen + node.data.length)
            return { node, offset: offset - seen }
          seen += node.data.length
          node = walker.nextNode() as Text | null
        }
        throw new Error(`offset ${offset} is past the end of ${blockId}`)
      }
      const from = point(start)
      const to = point(end)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      const range = document.createRange()
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
      selection.addRange(range)
    },
    { blockId, start, end },
  )
}

/** Highlight a span through the rail's public method, with the given role. */
async function highlight(
  page: Page,
  blockId: string,
  start: number,
  end: number,
  role = 'key',
) {
  await selectWithin(page, blockId, start, end)
  await expect(
    page.locator(`${RAIL} [data-margin-action="highlight"]`),
  ).toBeEnabled()
  await page.evaluate((role) => {
    const rail = document.querySelector('margin-rail') as HTMLElement & {
      highlightSelection(color: string): unknown[]
    }
    rail.highlightSelection(role)
  }, role)
}

/** The focus key of whatever is focused, looking through the rail's shadow root. */
async function focusedKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const rail = document.querySelector('margin-rail')
    if (document.activeElement !== rail) return null
    return (
      rail?.shadowRoot?.activeElement?.getAttribute('data-focus-key') ?? null
    )
  })
}

/** Press Tab until the rail control with this focus key has focus. */
async function tabTo(page: Page, key: string, limit = 800) {
  for (let presses = 0; presses < limit; presses += 1) {
    if ((await focusedKey(page)) === key) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Tab never reached ${key}`)
}

test.describe('the margin rail', () => {
  test('keyboard only: select, annotate, find, toggle and delete', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    await page.evaluate(() => {
      ;(window as unknown as { pointerEvents: number }).pointerEvents = 0
      for (const name of [
        'mousedown',
        'mouseup',
        'pointerdown',
        'pointerup',
        'click',
      ]) {
        document.addEventListener(
          name,
          (event) => {
            if (
              (event as MouseEvent).detail > 0 ||
              event.type.startsWith('pointer')
            ) {
              ;(window as unknown as { pointerEvents: number }).pointerEvents +=
                1
            }
          },
          true,
        )
      }
    })

    await tabTo(page, 'keyboard-select')
    await page.keyboard.press('Enter')

    // Down through the blocks until the caret sits in a long prose paragraph.
    for (let step = 0; step < 60; step += 1) {
      const kind = await page.evaluate(() => {
        const cursor = document.querySelector('[data-margin-keyboard-cursor]')
        return cursor && (cursor.textContent ?? '').length > 120
          ? cursor.getAttribute('data-block-kind')
          : null
      })
      if (kind === 'prose') break
      await page.keyboard.press('ArrowDown')
    }
    for (let word = 0; word < 4; word += 1)
      await page.keyboard.press('Alt+Shift+ArrowRight')
    const selected = await page.evaluate(() =>
      String(window.getSelection()).trim(),
    )
    expect(selected.length).toBeGreaterThan(3)

    await page.keyboard.press('Enter')
    await expect(page.locator(POPUP)).toBeVisible()
    expect(await focusedKey(page)).toBe('swatch:key')

    // Focus is trapped: Shift+Tab from the first control wraps to the last.
    await page.keyboard.press('Shift+Tab')
    expect(await focusedKey(page)).toBe('popup-cancel')
    await page.keyboard.press('Tab')
    expect(await focusedKey(page)).toBe('swatch:key')
    await page.keyboard.press('Tab')
    expect(await focusedKey(page)).toBe('swatch:question')
    await page.keyboard.press('Enter')

    await expect(page.locator(POPUP)).toHaveCount(0)
    // Focus went back to the reader's place in the text, not to the page top.
    expect(
      await page.evaluate(() =>
        Boolean(
          document.activeElement?.closest('[data-reading-column="text"]'),
        ),
      ),
    ).toBe(true)

    const entry = page.locator(ENTRY)
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText(selected.split(/\s+/)[0])
    await expect(entry).toHaveAttribute('data-visibility', 'private')
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    expect((await service.rows())[0]['margin:color']).toBe('question')

    const id = await entry.getAttribute('data-margin-annotation')
    await tabTo(page, `goto:${id}`)
    await tabTo(page, `visibility:${id}`)
    await page.keyboard.press('Enter')
    await expect(entry).toHaveAttribute('data-visibility', 'public')
    await expect
      .poll(async () => (await service.rows())[0]['margin:visibility'])
      .toBe('public')
    // Focus survived the redraw.
    expect(await focusedKey(page)).toBe(`visibility:${id}`)

    await tabTo(page, `delete:${id}`)
    await page.keyboard.press('Enter')
    await expect(entry).toHaveCount(0)
    await expect.poll(async () => (await service.rows()).length).toBe(0)

    expect(
      await page.evaluate(
        () => (window as unknown as { pointerEvents: number }).pointerEvents,
      ),
    ).toBe(0)
  })

  test('a pointer selection opens the popup; dismissing it saves nothing', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    const paragraph = page.locator(`#${block}`)
    // Centred, not merely "in view": the site header is sticky, and a block
    // scrolled to the top sits underneath it, where a click selects the header.
    await paragraph.evaluate((element) =>
      element.scrollIntoView({ block: 'center' }),
    )
    const box = (await paragraph.boundingBox())!

    let opened = false
    for (const fraction of [0.3, 0.4, 0.5, 0.6]) {
      await page.mouse.dblclick(
        box.x + box.width * fraction,
        box.y + box.height / 2,
      )
      if (await page.locator(POPUP).isVisible()) {
        opened = true
        break
      }
    }
    expect(opened, 'a double-click never selected a word').toBe(true)
    await expect(page.locator(POPUP)).toHaveAttribute('role', 'dialog')

    await page.keyboard.press('Escape')
    await expect(page.locator(POPUP)).toHaveCount(0)
    await expect(page.locator(ENTRY)).toHaveCount(0)
    expect(await service.rows()).toHaveLength(0)

    // A note, this time.
    for (const fraction of [0.3, 0.4, 0.5, 0.6]) {
      await page.mouse.dblclick(
        box.x + box.width * fraction,
        box.y + box.height / 2,
      )
      if (await page.locator(POPUP).isVisible()) break
    }
    await page.locator(`${POPUP} [data-margin-note]`).fill('Worth rereading.')
    await page.locator(`${POPUP} [data-margin-action="save-note"]`).click()
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await expect(page.locator(ENTRY)).toHaveAttribute('data-kind', 'note')
    await expect(page.locator(ENTRY)).toContainText('Worth rereading.')
    await expect
      .poll(async () => (await service.rows())[0]?.motivation)
      .toBe('commenting')
  })

  test('a default change affects only annotations created afterwards', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)

    await expect(page.locator(`${RAIL} fieldset`)).toHaveAttribute(
      'data-margin-default-visibility',
      'private',
    )
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)

    await page.locator(`${RAIL} input[value="public"]`).check()
    await expect
      .poll(async () => (await service.prefs(ADA)).defaultVisibility)
      .toBe('public')

    const first = page.locator(ENTRY).first()
    await expect(first).toHaveAttribute('data-visibility', 'private')
    expect((await service.rows())[0]['margin:visibility']).toBe('private')

    await highlight(page, block, 40, 60)
    await expect.poll(async () => (await service.rows()).length).toBe(2)
    const rows = await service.rows()
    expect(rows.map((row) => row['margin:visibility']).sort()).toEqual([
      'private',
      'public',
    ])
  })

  test('a private annotation is absent from the API response for anyone else', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await highlight(page, block, 30, 50)
    await expect.poll(async () => (await service.rows()).length).toBe(2)
    const [, second] = await page
      .locator(ENTRY)
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-margin-annotation')),
      )
    await page
      .locator(
        `${RAIL} li[data-margin-annotation="${second}"] [data-margin-action="visibility"]`,
      )
      .click()
    await expect
      .poll(async () =>
        (await service.rows()).map((row) => row['margin:visibility']).sort(),
      )
      .toEqual(['private', 'public'])

    service.as = BOB
    service.listed = []
    await page.reload()
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'public',
    )
    // Someone else's annotation has no controls to offer Bob.
    await expect(page.locator(`${ENTRY} [data-margin-action]`)).toHaveCount(0)

    // Not hidden in Bob's DOM — never sent to Bob's browser.
    const bobs = service.listed.filter(
      (entry) => entry.as === principalKey(BOB),
    )
    expect(bobs.length).toBeGreaterThan(0)
    for (const response of bobs) {
      expect(
        response.annotations.map((row) => row['margin:visibility']),
      ).toEqual(['public'])
    }
  })

  test('an orphaned annotation stays readable and deletable', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    const quote = 'a sentence this chapter has never contained'
    const created = await service.post(
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        motivation: 'commenting',
        body: {
          type: 'TextualBody',
          value: 'Kept, not dropped.',
          format: 'text/plain',
        },
        target: {
          source: documentUri,
          selector: [
            { type: 'TextQuoteSelector', exact: quote },
            { type: 'TextPositionSelector', start: 0, end: quote.length },
            { type: 'margin:StructSelector', 'margin:nodeId': block },
          ],
        },
        'margin:visibility': 'private',
      },
      ADA,
    )
    expect(created.status).toBe(201)

    await page.reload()
    const orphan = page.locator(`${RAIL} li[data-orphaned]`)
    await expect(orphan).toHaveCount(1)
    await expect(orphan).toHaveAttribute('data-orphaned', 'quote-not-found')
    await expect(orphan).toContainText(quote)
    await expect(orphan).toContainText('Kept, not dropped.')

    await orphan.locator('[data-margin-action="edit"]').click()
    await orphan.locator('textarea').fill('Edited while orphaned.')
    await orphan.getByRole('button', { name: 'Save' }).click()
    await expect(orphan).toContainText('Edited while orphaned.')
    await expect
      .poll(async () => (await service.rows())[0]?.body?.value)
      .toBe('Edited while orphaned.')

    await orphan.locator('[data-margin-action="delete"]').click()
    await expect(orphan).toHaveCount(0)
    await expect.poll(async () => (await service.rows()).length).toBe(0)
  })

  test('overlapping highlights of different colours both paint and stay selectable', async ({
    page,
  }) => {
    await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 5, 45, 'key')
    await highlight(page, block, 25, 70, 'question')
    await expect(page.locator(ENTRY)).toHaveCount(2)

    const painted = await page.evaluate(() => {
      const registry = (
        CSS as unknown as { highlights: Map<string, Set<Range>> }
      ).highlights
      return Array.from(registry.entries()).map(([name, highlight]) => ({
        name,
        text: Array.from(highlight)
          .map((range) => range.toString())
          .join(''),
      }))
    })
    expect(painted).toHaveLength(2)
    expect(new Set(painted.map((entry) => entry.name)).size).toBe(2)

    // A click inside the overlap reaches one entry, and a second click the other.
    const ids = await page
      .locator(ENTRY)
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-margin-annotation')),
      )
    const point = await page.evaluate((blockId) => {
      const block = document.getElementById(blockId)!
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let seen = 0
      let node = walker.nextNode() as Text | null
      while (node && seen + node.data.length <= 35) {
        seen += node.data.length
        node = walker.nextNode() as Text | null
      }
      const range = document.createRange()
      range.setStart(node!, 35 - seen)
      range.setEnd(node!, 36 - seen)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, block)
    await page.mouse.click(point.x, point.y)
    const firstFocus = await focusedKey(page)
    await page.mouse.click(point.x, point.y)
    const secondFocus = await focusedKey(page)
    expect(new Set([firstFocus, secondFocus])).toEqual(
      new Set(ids.map((id) => `goto:${id}`)),
    )
  })

  test('lists in document order, searches, and scrolls to and flashes a passage', async ({
    page,
  }) => {
    await mountService(page)
    await open(page)
    const blocks = await proseBlocks(page)
    const last = blocks[blocks.length - 1]
    await highlight(page, last, 0, 30)
    await highlight(page, blocks[0], 0, 30)

    const quotes = await page.locator(`${ENTRY} .quote`).allTextContents()
    const expected = await page.evaluate(
      (ids) =>
        ids.map((id) =>
          (document.getElementById(id)!.textContent ?? '').slice(0, 30),
        ),
      [blocks[0], last],
    )
    expect(quotes.map((quote) => quote.trim())).toEqual(
      expected.map((quote) => quote.trim()),
    )

    await page
      .locator(`${RAIL} [data-margin-search]`)
      .fill(expected[1].trim().slice(0, 12))
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await page.locator(`${RAIL} [data-margin-search]`).fill('')
    await expect(page.locator(ENTRY)).toHaveCount(2)

    await page.evaluate(() => window.scrollTo(0, 0))
    await page.locator(`${ENTRY} .quote`).last().click()
    await expect(page.locator(RAIL)).toHaveAttribute('data-flashing', '')
    await expect(page.locator(`#${last}`)).toBeInViewport()
  })

  test('collapses below 1280px into a toggle and an overlay without moving the text', async ({
    page,
  }) => {
    await mountService(page)
    await open(page, 1024)
    const text = page.locator('[data-reading-column="text"]')
    const before = await text.boundingBox()

    const toggle = page.locator(`${RAIL} [data-margin-action="toggle-rail"]`)
    await expect(toggle).toBeVisible()
    await expect(page.locator(`${RAIL} [data-margin-search]`)).toBeHidden()
    await toggle.click()
    await expect(page.locator(`${RAIL} [data-margin-search]`)).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await text.boundingBox()).toEqual(before)
    await page.keyboard.press('Escape')
    await expect(page.locator(`${RAIL} [data-margin-search]`)).toBeHidden()
    expect(await focusedKey(page)).toBe('toggle-rail')
  })

  test('the rail is a landmark, the popup a dialog, and axe finds nothing with fifty annotations', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const blocks = await proseBlocks(page, 160)
    expect(blocks.length).toBeGreaterThan(0)
    for (let index = 0; index < 50; index += 1) {
      const block = blocks[index % blocks.length]
      const start = Math.floor(index / blocks.length) * 12
      await highlight(
        page,
        block,
        start,
        start + 10,
        ['key', 'question', 'idea', 'revisit'][index % 4],
      )
    }
    await expect.poll(async () => (await service.rows()).length).toBe(50)
    await page.reload()
    await expect(page.locator(ENTRY)).toHaveCount(50)

    await expect(
      page.getByRole('complementary', { name: 'Margin' }),
    ).toBeVisible()
    // Scoped to the margin layer. The book page itself carries three older
    // violations — contents-list number contrast, unlabelled exercise editors
    // and scrollable listings without a tab stop — all from the book renderer
    // and the contents component, none from this layer; they are tracked as
    // their own issue rather than hidden by disabling rules here.
    const margin = () =>
      new AxeBuilder({ page }).include('[data-reading-column="margin"]')
    const results = await margin().analyze()
    expect(
      results.violations.map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
      ),
    ).toEqual([])

    await selectWithin(page, blocks[0], 0, 8)
    await page.evaluate(() => {
      document
        .querySelector('[data-reading-column="text"]')!
        .dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    await expect(page.getByRole('dialog', { name: /Annotate/ })).toBeVisible()
    const withPopup = await margin().analyze()
    expect(withPopup.violations.map((violation) => violation.id)).toEqual([])
  })
})
