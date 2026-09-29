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
  /** While set, `GET /prefs` and `POST /annotations` wait for these. */
  holdPrefs: Promise<void> | null
  holdPosts: Promise<void> | null
  /** Held once: the next PATCH waits for this, and later ones do not. */
  holdNextPatch: Promise<void> | null
  /** While set, every list request waits for this. */
  holdLists: Promise<void> | null
  /** While set, every DELETE waits for this. */
  holdDeletes: Promise<void> | null
  /** While true, GET /prefs answers 500. */
  failPrefs: boolean
  /** While true, GET /prefs answers 404, as with no service mounted. */
  missingPrefs: boolean
  /** While true, every PATCH is refused with a 500. */
  failPatches: boolean
  setPrefs(
    principal: Principal,
    defaultVisibility: 'private' | 'public',
  ): Promise<void>
  /** Every list response the service sent, as the browser received it. */
  listed: { as: string | null; annotations: WireAnnotation[] }[]
  /** `METHOD path` of every request, in order, once its session is bound. */
  arrivals: string[]
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
    holdPrefs: null,
    holdPosts: null,
    holdNextPatch: null,
    holdLists: null,
    holdDeletes: null,
    failPrefs: false,
    missingPrefs: false,
    failPatches: false,
    async setPrefs(principal, defaultVisibility) {
      await call(
        new Request('https://ernie.sg/api/margin/v1/prefs', {
          method: 'PATCH',
          body: JSON.stringify({ defaultVisibility }),
          headers: { 'content-type': 'application/json' },
        }),
        principal,
      )
    },
    listed: [],
    arrivals: [],
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
    const path = new URL(incoming.url()).pathname
    // The session a request was sent with, not whoever is signed in by the time
    // a held request is let through.
    const as = service.as
    service.arrivals.push(`${method} ${path}`)
    if (method === 'GET' && path.endsWith('/prefs') && service.holdPrefs) {
      await service.holdPrefs
    }
    if (method === 'DELETE' && service.holdDeletes) await service.holdDeletes
    if (method === 'GET' && path.endsWith('/prefs') && service.missingPrefs) {
      await route.fulfill({ status: 404, body: 'Not Found' })
      return
    }
    if (method === 'GET' && path.endsWith('/prefs') && service.failPrefs) {
      await route.fulfill({
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: '{"error":{"code":"test_outage"}}',
      })
      return
    }
    if (
      method === 'GET' &&
      path.endsWith('/annotations') &&
      service.holdLists
    ) {
      await service.holdLists
    }
    if (method === 'PATCH' && service.failPatches) {
      if (service.holdNextPatch) {
        const hold = service.holdNextPatch
        service.holdNextPatch = null
        await hold
      }
      await route.fulfill({
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: '{"error":{"code":"test_refusal"}}',
      })
      return
    }
    if (method === 'PATCH' && service.holdNextPatch) {
      const hold = service.holdNextPatch
      service.holdNextPatch = null
      await hold
    }
    if (
      method === 'POST' &&
      path.endsWith('/annotations') &&
      service.holdPosts
    ) {
      await service.holdPosts
    }
    const response = await call(request, as)
    const text = await response.text()
    if (
      method === 'GET' &&
      new URL(incoming.url()).pathname.endsWith('/annotations') &&
      response.ok
    ) {
      service.listed.push({
        as: as ? principalKey(as) : null,
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
        .filter((block) => {
          // A runnable cell renders inside a prose block, but its code is an
          // editor, not text a reader selects: only the prose around it counts.
          const text = Array.from(block.childNodes)
            .filter((child) => !(child instanceof Element && child.matches('.cell-run')))
            .map((child) => child.textContent ?? '')
            .join('')
          return text.length > minimum
        })
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
        // Prose only: a runnable cell's code is an editor, not selectable text.
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
          acceptNode: (text) =>
            text.parentElement?.closest('.cell-run')
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT,
        })
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

/** Select the start of a block and release the pointer there, as a reader does. */
async function openPopupOn(page: Page, blockId: string) {
  await selectWithin(page, blockId, 0, 24)
  await page.locator(`#${blockId}`).dispatchEvent('pointerup')
  await expect(page.locator(POPUP)).toBeVisible()
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
    // A book editor keeps Tab for indenting; Escape, then Tab, leaves it, as
    // its keyboard hint says.
    if (await page.evaluate(() => document.activeElement?.classList.contains('editor'))) {
      await page.keyboard.press('Escape')
    }
    await page.keyboard.press('Tab')
  }
  throw new Error(`Tab never reached ${key}`)
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** An annotation the page cannot anchor, so any number of them are valid. */
function orphanNote(n: number, nodeId: string) {
  const quote = `unanchored passage number ${n}`
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    motivation: 'commenting',
    body: { type: 'TextualBody', value: `note ${n}`, format: 'text/plain' },
    target: {
      source: documentUri,
      selector: [
        { type: 'TextQuoteSelector', exact: quote },
        { type: 'TextPositionSelector', start: 0, end: quote.length },
        { type: 'margin:StructSelector', 'margin:nodeId': nodeId },
      ],
    },
  }
}

test.describe('the margin rail under slow or racing requests', () => {
  test('a delete that overtakes its own create still deletes what was stored', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    const posts = gate()
    service.holdPosts = posts.promise
    await highlight(page, block, 0, 20)
    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    posts.open()
    await expect(page.locator(ENTRY)).toHaveCount(0)
    await expect.poll(async () => (await service.rows()).length).toBe(0)
    service.holdPosts = null
    await page.reload()
    await expect(page.locator(ENTRY)).toHaveCount(0)
  })

  test('an annotation made before the stored default arrives takes that default', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.setPrefs(ADA, 'public')
    const prefs = gate()
    service.holdPrefs = prefs.promise
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    prefs.open()
    await expect
      .poll(async () => (await service.rows())[0]?.['margin:visibility'])
      .toBe('public')
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'public',
    )
  })

  test('a visibility change made while the create is in flight reaches the service', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    const posts = gate()
    service.holdPosts = posts.promise
    await highlight(page, block, 0, 20)
    const entry = page.locator(ENTRY)
    await entry.locator('[data-margin-action="visibility"]').click()
    await expect(entry).toHaveAttribute('data-visibility', 'public')
    posts.open()
    await expect
      .poll(async () => (await service.rows())[0]?.['margin:visibility'])
      .toBe('public')
  })

  test('a note edited while its create is in flight keeps the edit', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    const posts = gate()
    service.holdPosts = posts.promise
    await selectWithin(page, block, 0, 20)
    await expect(
      page.locator(`${RAIL} [data-margin-action="highlight"]`),
    ).toBeEnabled()
    await page.evaluate(() => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        noteSelection(body: string): unknown[]
      }
      rail.noteSelection('first draft')
    })
    const entry = page.locator(ENTRY)
    await entry.locator('[data-margin-action="edit"]').click()
    await entry.locator('textarea').fill('second draft')
    await entry.getByRole('button', { name: 'Save' }).click()
    posts.open()
    await expect
      .poll(async () => (await service.rows())[0]?.body?.value)
      .toBe('second draft')
  })

  test('the reader’s own visibility choice survives a default arriving later', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.setPrefs(ADA, 'public')
    const prefs = gate()
    service.holdPrefs = prefs.promise
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    // Made under the private fallback; the reader flips it twice before /prefs lands.
    await page.locator(`${ENTRY} [data-margin-action="visibility"]`).click()
    await page.locator(`${ENTRY} [data-margin-action="visibility"]`).click()
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'private',
    )
    prefs.open()
    await expect
      .poll(async () => (await service.rows())[0]?.['margin:visibility'])
      .toBe('private')
  })

  test('two quick toggles land on the service in the order they were made', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const first = gate()
    service.holdNextPatch = first.promise
    const toggle = page.locator(`${ENTRY} [data-margin-action="visibility"]`)
    await toggle.click() // public — held
    await toggle.click() // private — would overtake the held one if not queued
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'private',
    )
    first.open()
    await expect
      .poll(async () => (await service.rows())[0]['margin:visibility'])
      .toBe('private')
    await page.waitForTimeout(300)
    expect((await service.rows())[0]['margin:visibility']).toBe('private')
  })

  test('a default changed while the stored one is loading is kept and saved', async ({
    page,
  }) => {
    const service = await mountService(page)
    const prefs = gate()
    service.holdPrefs = prefs.promise
    await open(page)
    await page.locator(`${RAIL} input[value="public"]`).check()
    prefs.open()
    await expect
      .poll(async () => (await service.prefs(ADA)).defaultVisibility)
      .toBe('public')
    await expect(page.locator(`${RAIL} fieldset`)).toHaveAttribute(
      'data-margin-default-visibility',
      'public',
    )
  })

  test('host-supplied annotations are not duplicated by the first load', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    expect((await service.post(orphanNote(1, block), ADA)).status).toBe(201)
    const [row] = await service.rows()
    const id = row.id.replace('urn:margin:annotation:', '')
    const prefs = gate()
    service.holdPrefs = prefs.promise
    await page.reload()
    await page.evaluate(
      ({ id, block }) => {
        const quote = 'unanchored passage number 1'
        const rail = document.querySelector('margin-rail') as HTMLElement & {
          annotations: unknown
        }
        rail.annotations = [
          {
            id,
            kind: 'note',
            target: {
              nodeId: block,
              position: { start: 0, end: quote.length },
              quote: { exact: quote, prefix: '', suffix: '' },
            },
            body: 'note 1',
            geometryCache: [],
          },
        ]
      },
      { id, block },
    )
    prefs.open()
    await expect.poll(async () => page.locator(ENTRY).count()).toBe(1)
    await page.waitForTimeout(300)
    await expect(page.locator(ENTRY)).toHaveCount(1)
  })

  test('flashes a passage even without the Custom Highlight API', async ({
    page,
  }) => {
    await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 30)
    await page.evaluate(() => {
      delete (window as unknown as { Highlight?: unknown }).Highlight
    })
    await page.locator(`${ENTRY} .quote`).click()
    await expect(
      page
        .locator(
          '[data-erniesg-margin-overlay] [data-margin-highlight="flash"]',
        )
        .first(),
    ).toBeAttached()
  })

  test('two quick default changes leave the service on the last one', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    await expect
      .poll(async () => (await service.prefs(ADA)).defaultVisibility)
      .toBe('private')
    const first = gate()
    service.holdNextPatch = first.promise
    await page.locator(`${RAIL} input[value="public"]`).check() // held
    await page.locator(`${RAIL} input[value="private"]`).check()
    first.open()
    await page.waitForTimeout(500)
    expect((await service.prefs(ADA)).defaultVisibility).toBe('private')
    await expect(page.locator(`${RAIL} fieldset`)).toHaveAttribute(
      'data-margin-default-visibility',
      'private',
    )
  })

  test('a refused run of toggles rolls back to what the service holds', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const toggle = page.locator(`${ENTRY} [data-margin-action="visibility"]`)
    await toggle.click() // public, stored
    await expect
      .poll(async () => (await service.rows())[0]['margin:visibility'])
      .toBe('public')
    service.failPatches = true
    const first = gate()
    service.holdNextPatch = first.promise
    await toggle.click() // private — held, then refused
    await toggle.click() // public — refused
    first.open()
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'public',
    )
    await page.waitForTimeout(300)
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'public',
    )
    expect((await service.rows())[0]['margin:visibility']).toBe('public')
  })

  test('a default changed after creation does not rewrite a pending annotation', async ({
    page,
  }) => {
    const service = await mountService(page)
    const prefs = gate()
    service.holdPrefs = prefs.promise
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20) // made while the rail says private
    await page.locator(`${RAIL} input[value="public"]`).check()
    prefs.open()
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    expect((await service.rows())[0]['margin:visibility']).toBe('private')
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'private',
    )
  })

  test('a change made after a reload’s snapshot survives the reload', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const lists = gate()
    service.holdLists = lists.promise
    // Reload in place: reassigning the transport starts a fresh load.
    await page.evaluate(() => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        transport: unknown
      }
      rail.transport = rail.transport
    })
    await page.waitForTimeout(200) // the list request is out, snapshot pending
    await page.locator(`${ENTRY} [data-margin-action="visibility"]`).click()
    await expect
      .poll(async () => (await service.rows())[0]['margin:visibility'])
      .toBe('public')
    service.holdLists = null
    lists.open()
    await page.waitForTimeout(300)
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'public',
    )
  })

  test('going to a passage from the compact overlay puts focus on the passage', async ({
    page,
  }) => {
    await mountService(page)
    await open(page, 1024)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await page.locator(`${RAIL} [data-margin-action="toggle-rail"]`).click()
    const quote = page.locator(`${ENTRY} .quote`)
    await quote.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(`${RAIL} [data-margin-search]`)).toBeHidden()
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(block)
  })

  test('a slow delete does not pull focus back from where the reader went', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const deletes = gate()
    service.holdDeletes = deletes.promise
    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    await page.locator(`${RAIL} [data-margin-search]`).focus()
    await page.keyboard.type('x')
    deletes.open()
    await page.locator(`${RAIL} [data-margin-search]`).fill('')
    await expect(page.locator(ENTRY)).toHaveCount(0)
    expect(await focusedKey(page)).toBe('search')
  })

  test('search waits for an IME composition to finish', async ({ page }) => {
    await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    const search = page.locator(`${RAIL} [data-margin-search]`)
    await search.focus()
    const same = await search.evaluate((input: HTMLInputElement) => {
      ;(window as unknown as { searchField: unknown }).searchField = input
      input.value = 'zh'
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          isComposing: true,
        }),
      )
      const root = input.getRootNode() as ShadowRoot
      return root.querySelector('[data-margin-search]') === input
    })
    // Mid-composition the field is the same element: nothing was rebuilt.
    expect(same).toBe(true)
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await search.evaluate((input: HTMLInputElement) => {
      input.value = 'zzz-no-match'
      input.dispatchEvent(
        new CompositionEvent('compositionend', {
          bubbles: true,
          composed: true,
        }),
      )
    })
    await expect(page.locator(ENTRY)).toHaveCount(0)
  })

  test('a second delete of the same entry is ignored, not reported as a failure', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const deletes = gate()
    service.holdDeletes = deletes.promise
    const remove = page.locator(`${ENTRY} [data-margin-action="delete"]`)
    await remove.click()
    // Now shown as unavailable; forced, because a second activation (a double
    // click, Enter held down) is exactly what must be ignored.
    await remove.click({ force: true })
    deletes.open()
    await expect(page.locator(ENTRY)).toHaveCount(0)
    await page.waitForTimeout(300)
    await expect(
      page.locator(`${RAIL} [data-margin-notice="transport"]`),
    ).toHaveCount(0)
  })

  test('a settings outage is reported, not treated as signing out', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    service.failPrefs = true
    await page.evaluate(() => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        transport: unknown
      }
      rail.transport = rail.transport
    })
    await expect(
      page.locator(`${RAIL} [data-margin-notice="transport"]`),
    ).toContainText('margin settings')
    // The reader known before the outage still owns their annotation.
    await expect(
      page.locator(`${ENTRY} [data-margin-action="delete"]`),
    ).toHaveCount(1)
  })

  test('a deleted annotation does not come back from a load that started before the delete', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const lists = gate()
    service.holdLists = lists.promise
    await page.evaluate(() => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        transport: unknown
      }
      rail.transport = rail.transport
    })
    await page.waitForTimeout(200)
    // Release the snapshot only after the delete has gone through.
    const snapshotTaken = lists
    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    await expect.poll(async () => (await service.rows()).length).toBe(0)
    service.holdLists = null
    snapshotTaken.open()
    await page.waitForTimeout(300)
    await expect(page.locator(ENTRY)).toHaveCount(0)
  })

  test('an entry being deleted accepts no other change', async ({ page }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const deletes = gate()
    service.holdDeletes = deletes.promise
    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    const toggle = page.locator(`${ENTRY} [data-margin-action="visibility"]`)
    await expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await toggle.click({ force: true })
    await expect(page.locator(ENTRY)).toHaveAttribute(
      'data-visibility',
      'private',
    )
    deletes.open()
    await expect(page.locator(ENTRY)).toHaveCount(0)
  })

  test('is not printed', async ({ page }) => {
    await mountService(page)
    await open(page, 1024)
    await expect(
      page.locator(`${RAIL} [data-margin-action="toggle-rail"]`),
    ).toBeVisible()
    await page.emulateMedia({ media: 'print' })
    await expect(
      page.locator(`${RAIL} [data-margin-action="toggle-rail"]`),
    ).toBeHidden()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.locator(`${RAIL} [data-margin-search]`)).toBeHidden()
  })

  test('loads every page of annotations, not the first few', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    // Over two of the service's default 100-row pages.
    for (let n = 0; n < 230; n += 1) {
      expect((await service.post(orphanNote(n, block), ADA)).status).toBe(201)
    }
    await page.reload()
    await expect(page.locator(ENTRY)).toHaveCount(230)
  })

  // #358 item 1
  test('a create whose follow-up toggle is refused rolls back to what the create stored', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    const posts = gate()
    service.holdPosts = posts.promise
    const sent = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && request.url().endsWith('/annotations'),
    )
    await highlight(page, block, 0, 20)
    await sent // the create left as private
    const entry = page.locator(ENTRY)
    service.failPatches = true
    await entry.locator('[data-margin-action="visibility"]').click()
    await expect(entry).toHaveAttribute('data-visibility', 'public')
    posts.open()
    await expect
      .poll(async () => (await service.rows())[0]?.['margin:visibility'])
      .toBe('private')
    await expect(entry).toHaveAttribute('data-visibility', 'private')
  })

  // #358 item 2
  test('an old connection’s late default write does not become the new one’s baseline', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              document.querySelector('margin-rail') as HTMLElement & {
                defaultVisibility: string
              }
            ).defaultVisibility,
        ),
      )
      .toBe('private')
    const first = gate()
    service.holdNextPatch = first.promise
    const patched = page.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().endsWith('/prefs'),
    )
    // Ada changes her default; the write is held on her connection.
    void page.evaluate(() => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        setDefaultVisibility(v: string): Promise<void>
      }
      void rail.setDefaultVisibility('public')
    })
    await patched
    await expect
      .poll(() => service.arrivals.some((entry) => /^PATCH .*\/prefs$/.test(entry)))
      .toBe(true)
    // The host switches to another session: Bob, whose default is private.
    service.as = BOB
    await page.evaluate(() => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        transport: { request(r: unknown): Promise<unknown> }
      }
      const previous = rail.transport
      rail.transport = { request: (r: unknown) => previous.request(r) }
    })
    await expect
      .poll(() => service.listed.filter((entry) => entry.as !== null).length)
      .toBeGreaterThan(0)
    await expect
      .poll(() => service.listed.at(-1)?.as)
      .toBe(principalKey(BOB))
    first.open()
    await expect
      .poll(async () => (await service.prefs(ADA)).defaultVisibility)
      .toBe('public')
    // Bob's own change is refused: the rail must fall back to Bob's stored
    // default, not to the value Ada's old connection wrote.
    service.failPatches = true
    const bobDefault = await page.evaluate(async () => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        setDefaultVisibility(v: string): Promise<void>
        defaultVisibility: string
      }
      await rail.setDefaultVisibility('public')
      return rail.defaultVisibility
    })
    expect(bobDefault).toBe('private')
    expect((await service.prefs(BOB)).defaultVisibility).toBe('private')
  })

  // #358 item 3
  test('a host record matched by a load rolls back to the service’s body, not the host’s', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    expect((await service.post(orphanNote(1, block), ADA)).status).toBe(201)
    const [row] = await service.rows()
    const id = row.id.replace('urn:margin:annotation:', '')
    const prefs = gate()
    service.holdPrefs = prefs.promise
    await page.reload()
    await page.evaluate(
      ({ id, block }) => {
        const quote = 'unanchored passage number 1'
        const rail = document.querySelector('margin-rail') as HTMLElement & {
          annotations: unknown
        }
        rail.annotations = [
          {
            id,
            kind: 'note',
            target: {
              nodeId: block,
              position: { start: 0, end: quote.length },
              quote: { exact: quote, prefix: '', suffix: '' },
            },
            body: 'the host copy',
            geometryCache: [],
          },
        ]
      },
      { id, block },
    )
    prefs.open()
    await expect
      .poll(() => service.listed.length)
      .toBeGreaterThan(0)
    await expect(page.locator(ENTRY)).toHaveCount(1)
    service.failPatches = true
    await page.evaluate(async (id) => {
      const rail = document.querySelector('margin-rail') as HTMLElement & {
        editNote(id: string, body: string): Promise<void>
      }
      await rail.editNote(id, 'an edit the service refuses')
    }, id)
    await expect(page.locator(ENTRY)).toContainText('note 1')
    await expect(page.locator(ENTRY)).not.toContainText('the host copy')
  })

  // #358 item 4
  test('a settings notice clears once a later load reads the settings', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const reload = () =>
      page.evaluate(() => {
        const rail = document.querySelector('margin-rail') as HTMLElement & {
          transport: unknown
        }
        rail.transport = rail.transport
      })
    service.failPrefs = true
    await reload()
    const notice = page.locator(`${RAIL} [data-margin-notice="transport"]`)
    await expect(notice).toContainText('margin settings')
    service.failPrefs = false
    await reload()
    await expect(notice).toHaveCount(0)
  })

  test('a recovered settings read clears the notice before the list arrives', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const reload = () =>
      page.evaluate(() => {
        const rail = document.querySelector('margin-rail') as HTMLElement & {
          transport: unknown
        }
        rail.transport = rail.transport
      })
    const notice = page.locator(`${RAIL} [data-margin-notice="transport"]`)
    service.failPrefs = true
    await reload()
    await expect(notice).toContainText('margin settings')
    service.failPrefs = false
    const lists = gate()
    service.holdLists = lists.promise
    await reload()
    // The list is still out; the settings already recovered.
    await expect(notice).toHaveCount(0)
    lists.open()
  })

  test('a recovered settings read shows the stored default before the list arrives', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const reload = () =>
      page.evaluate(() => {
        const rail = document.querySelector('margin-rail') as HTMLElement & {
          transport: unknown
        }
        rail.transport = rail.transport
      })
    const notice = page.locator(`${RAIL} [data-margin-notice="transport"]`)
    service.failPrefs = true
    await reload()
    await expect(notice).toContainText('margin settings')
    await service.setPrefs(ADA, 'public')
    service.failPrefs = false
    const lists = gate()
    service.holdLists = lists.promise
    await reload()
    await expect(
      page.locator(`${RAIL} [data-margin-default-visibility]`),
    ).toHaveAttribute('data-margin-default-visibility', 'public')
    lists.open()
  })

  test('a settings 404 after a settings failure clears the warning', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const reload = () =>
      page.evaluate(() => {
        const rail = document.querySelector('margin-rail') as HTMLElement & {
          transport: unknown
        }
        rail.transport = rail.transport
      })
    const notice = page.locator(`${RAIL} [data-margin-notice="transport"]`)
    service.failPrefs = true
    await reload()
    await expect(notice).toContainText('margin settings')
    service.failPrefs = false
    service.missingPrefs = true
    await reload()
    await expect(notice).toHaveCount(0)
  })

  // #358 item 6
  test('a page with no margin service behind it shows no settings warning', async ({
    page,
  }) => {
    // The dev server and static previews: every service path is a 404.
    await page.route('**/api/margin/v1/**', (route) =>
      route.fulfill({ status: 404, body: 'Not Found' }),
    )
    await open(page)
    await page.waitForTimeout(300)
    // Anything that redraws the rail shows a notice that was set quietly.
    const [block] = await proseBlocks(page)
    await selectWithin(page, block, 0, 20)
    await expect(
      page.locator(`${RAIL} [data-margin-action="highlight"]`),
    ).toBeEnabled()
    await expect(
      page.locator(`${RAIL} [data-margin-notice="transport"]`),
    ).toHaveCount(0)
  })

  // #358 item 7
  test('a new api-base forgets the previous backend at once', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await highlight(page, block, 0, 20)
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    await expect(
      page.locator(`${ENTRY} [data-margin-action="delete"]`),
    ).toHaveCount(1)
    const lists = gate()
    service.holdLists = lists.promise
    await page.evaluate(() => {
      document.querySelector('margin-rail')!.setAttribute('api-base', '/elsewhere/')
    })
    // While the new backend's list is out, nothing from the old one remains.
    await expect(page.locator(ENTRY)).toHaveCount(0)
    lists.open()
  })

  test('a host update to a known annotation renders', async ({ page }) => {
    await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    const set = (body: string) =>
      page.evaluate(
        ({ block, body }) => {
          const rail = document.querySelector('margin-rail') as HTMLElement & {
            annotations: unknown
          }
          rail.annotations = [
            {
              id: 'host-1',
              kind: 'note',
              target: {
                nodeId: block,
                position: { start: 0, end: 6 },
                quote: { exact: 'absent', prefix: '', suffix: '' },
              },
              body,
              geometryCache: [],
            },
          ]
        },
        { block, body },
      )
    await set('first body')
    await expect(page.locator(ENTRY)).toContainText('first body')
    await set('second body')
    await expect(page.locator(ENTRY)).toContainText('second body')
  })
})

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
    // Picking a role marks it and saves nothing yet.
    await expect(page.locator(POPUP)).toBeVisible()
    await expect(
      page.locator(`${POPUP} [data-margin-swatch="question"]`),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(await service.rows()).toHaveLength(0)
    await tabTo(page, 'popup-save', 20)
    await page.keyboard.press('Enter')

    await expect(page.locator(POPUP)).toHaveCount(0)
    const tabbable = () =>
      page.evaluate(
        () =>
          document.querySelectorAll('.book-content [data-block-kind][tabindex]')
            .length,
      )
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
    // Once focus has left the text, no block keeps a tabindex the margin added.
    expect(await tabbable()).toBe(0)
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
    await page.locator(`${POPUP} [data-margin-action="save"]`).click()
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await expect(page.locator(ENTRY)).toHaveAttribute('data-kind', 'note')
    await expect(page.locator(ENTRY)).toContainText('Worth rereading.')
    await expect
      .poll(async () => (await service.rows())[0]?.motivation)
      .toBe('commenting')
  })

  // #358 item 5
  test('a selection made without a pointer or Shift can still open the popup', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    // A screen reader's selection: selectionchange, no pointerup, no Shift keyup.
    await selectWithin(page, block, 0, 24)
    const annotate = page.locator(`${RAIL} [data-margin-action="annotate"]`)
    await expect(annotate).toBeEnabled()
    await annotate.click()
    await expect(page.locator(POPUP)).toBeVisible()
    await page.locator(`${POPUP} [data-margin-swatch="question"]`).click()
    await page.locator(`${POPUP} [data-margin-note]`).fill('why this order?')
    await page.locator(`${POPUP} [data-margin-action="save"]`).click()
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const [row] = await service.rows()
    expect(row.motivation).toBe('commenting')
    expect(row['margin:color']).toBe('question')
  })

  test('picking a role saves nothing until Save, and Save needs a role or a note', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await openPopupOn(page, block)
    await expect(page.locator(POPUP)).toBeVisible()

    const save = page.locator(`${POPUP} [data-margin-action="save"]`)
    await expect(save).toBeDisabled()

    const idea = page.locator(`${POPUP} [data-margin-swatch="idea"]`)
    await idea.click()
    await expect(idea).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator(POPUP)).toBeVisible()
    expect(await service.rows()).toHaveLength(0)
    await expect(save).toBeEnabled()

    // Picking it again clears it.
    await idea.click()
    await expect(idea).toHaveAttribute('aria-pressed', 'false')
    await expect(save).toBeDisabled()

    await page.locator(`${POPUP} [data-margin-swatch="revisit"]`).click()
    await save.click()
    await expect(page.locator(POPUP)).toHaveCount(0)
    await expect(page.locator(ENTRY)).toHaveAttribute('data-kind', 'highlight')
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const [row] = await service.rows()
    expect(row.motivation).toBe('highlighting')
    expect(row['margin:color']).toBe('revisit')
  })

  test('a role and a note save once, as a note tagged with that role', async ({
    page,
  }) => {
    const service = await mountService(page)
    await open(page)
    const [block] = await proseBlocks(page)
    await openPopupOn(page, block)

    await page.locator(`${POPUP} [data-margin-swatch="question"]`).click()
    const note = page.locator(`${POPUP} [data-margin-note]`)
    await note.fill('Why arrival order?')
    // Enter is a newline, not a save.
    await note.press('Enter')
    await expect(page.locator(POPUP)).toBeVisible()
    await note.pressSequentially('Surely urgency.')
    await note.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')

    await expect(page.locator(POPUP)).toHaveCount(0)
    const entry = page.locator(ENTRY)
    await expect(entry).toHaveCount(1)
    await expect(entry).toHaveAttribute('data-kind', 'note')
    await expect(entry).toContainText('Why arrival order?')
    expect(
      await entry.evaluate((element) =>
        (element as HTMLElement).style.getPropertyValue('--swatch'),
      ),
    ).toContain('question')
    await expect.poll(async () => (await service.rows()).length).toBe(1)
    const [row] = await service.rows()
    expect(row.motivation).toBe('commenting')
    expect(row['margin:color']).toBe('question')
    expect((row.body as { value?: string }).value).toBe(
      'Why arrival order?\nSurely urgency.',
    )

    // It survives a reload with its role.
    await page.reload()
    await expect(page.locator(ENTRY)).toHaveCount(1)
    expect(
      await page
        .locator(ENTRY)
        .evaluate((element) =>
          (element as HTMLElement).style.getPropertyValue('--swatch'),
        ),
    ).toContain('question')
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
