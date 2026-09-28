import { expect, test, type Page } from '@playwright/test'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * Reading order and chapter progress on the published book, in both looks.
 *
 * `[` and `]` follow the page's own rel=prev / rel=next links, so the client
 * router does the navigation. Assertions read the document title and the
 * indicator rather than the URL: on book pages the router currently swaps the
 * content without updating the URL (#382), which is not this feature's to fix.
 */

const BOOK = '/books/build-a-coding-agent/'
const CHAPTER = `${BOOK}ch02-conditionals/`
const INDICATOR = '[data-chapter-progress]'
const STATUS = `${INDICATOR} [data-cp-status]`

const READER: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'reader',
}

async function mountMargin(page: Page) {
  const repository = new D1MarginRepository(SqliteD1Database.inMemory())
  let sequence = 0
  const now = () => new Date(Date.UTC(2026, 8, 28)).toISOString()
  const newId = () => `annotation-${(sequence += 1)}`
  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    const response = await handleMarginRequest(
      new Request(incoming.url(), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { body: incoming.postData() ?? undefined }),
      }),
      { repository, principal: READER, now, newId },
    )
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json' },
      body: await response.text(),
    })
  })
}

async function sections(page: Page) {
  return page.locator(`${INDICATOR} [data-cp-section]`).count()
}

for (const look of ['site', 'plain'] as const) {
  test.describe(`reading order and chapter progress (${look})`, () => {
    test.beforeEach(async ({ page }) => {
      await installStaticRoutes(page)
      await mountMargin(page)
      await page.addInitScript((value) => {
        try {
          localStorage.setItem('book-look', value)
        } catch {
          // A refused store leaves the default look, which the test notices.
        }
      }, look)
    })

    test('] goes to the next node and [ comes back', async ({ page }) => {
      await page.goto(CHAPTER)
      await expect(page).toHaveTitle(/^Choosing with if/)
      await page.keyboard.press(']')
      await expect(page).toHaveTitle(/^The price on the door/)
      await expect(page.locator(STATUS)).toHaveText('Practice 1 of 2 · 0/2 solved')
      await page.keyboard.press('[')
      await expect(page).toHaveTitle(/^Choosing with if/)
      await expect(page.locator(STATUS)).toContainText('Section 1 of')
    })

    test('the pager names both neighbours with rel links', async ({ page }) => {
      await page.goto(`${BOOK}pool-ticket-price/`)
      const pager = page.locator('.book-pager')
      await expect(pager.locator('a[rel="prev"]')).toHaveAttribute(
        'href',
        `${BOOK}ch02-conditionals/`,
      )
      await expect(pager.locator('a[rel="prev"]')).toContainText('Choosing with if')
      await expect(pager.locator('a[rel="next"]')).toContainText(
        'The fridge that holds the medicine',
      )
    })

    test('shortcuts wait while the reader types in the editor', async ({ page }) => {
      await page.goto(`${BOOK}ch07-strings/`)
      const editor = page.locator('.book-content textarea').first()
      await editor.click()
      await page.keyboard.type('x = [1]')
      await page.keyboard.press(']')
      // The bracket went into the code, and the page stayed.
      await expect(editor).toHaveValue(/x = \[1\]\]/)
      await expect(page).toHaveTitle(/^Strings and text/)
    })

    test('shortcuts wait while the margin selects with the keyboard', async ({
      page,
    }) => {
      await page.goto(CHAPTER)
      await page.locator('margin-rail [data-margin-action="keyboard-select"]').click()
      await expect(page.locator('[data-margin-keyboard-cursor]')).toHaveCount(1)
      await page.keyboard.press(']')
      await page.waitForTimeout(400)
      await expect(page).toHaveTitle(/^Choosing with if/)
    })

    test('the indicator counts sections and follows the one in view', async ({
      page,
    }) => {
      await page.goto(CHAPTER)
      const total = await sections(page)
      expect(total).toBe(
        await page.locator('.book-content h2[id]').count(),
      )
      await expect(page.locator(STATUS)).toHaveText(
        `Section 1 of ${total} · practice 0/2 solved`,
      )
      await page.locator('.book-content h2[id]').nth(3).evaluate((heading) =>
        heading.scrollIntoView({ block: 'start' }),
      )
      await expect(page.locator(STATUS)).toHaveText(
        `Section 4 of ${total} · practice 0/2 solved`,
      )
      const current = page.locator(`${INDICATOR} [data-cp-section][aria-current]`)
      await expect(current).toHaveCount(1)
      await expect(current).toHaveAttribute(
        'data-cp-section',
        (await page.locator('.book-content h2[id]').nth(3).getAttribute('id'))!,
      )
    })

    test('j and k step through the headings', async ({ page }) => {
      await page.goto(CHAPTER)
      const headings = page.locator('.book-content h2[id]')
      // From the chapter's opening prose, j lands on the first heading.
      await page.keyboard.press('j')
      await expect(headings.first()).toBeFocused()
      await expect(page.locator(STATUS)).toContainText('Section 1 of')
      await page.keyboard.press('j')
      await expect(headings.nth(1)).toBeFocused()
      await expect(page.locator(STATUS)).toContainText('Section 2 of')
      await page.keyboard.press('j')
      await expect(page.locator(STATUS)).toContainText('Section 3 of')
      await page.keyboard.press('k')
      await expect(headings.nth(1)).toBeFocused()
      await expect(page.locator(STATUS)).toContainText('Section 2 of')
    })

    test('a solved challenge is ticked and counted', async ({ page }) => {
      await page.goto(`${BOOK}fridge-alarm/`)
      await expect(page.locator(STATUS)).toHaveText('Practice 2 of 2 · 0/2 solved')
      // What the progress runtime (#375) does when a challenge is solved.
      await page
        .locator(`${INDICATOR} [data-progress-items="pool-ticket-price"]`)
        .evaluate((segment) => segment.setAttribute('data-progress-done', ''))
      await expect(page.locator(STATUS)).toHaveText('Practice 2 of 2 · 1/2 solved')
      await expect(
        page.locator(`${INDICATOR} [data-cp-practice="pool-ticket-price"]`),
      ).toContainText('(solved)')
    })

    test('the indicator stays in view after scrolling 2000px', async ({ page }) => {
      await page.goto(CHAPTER)
      await page.mouse.wheel(0, 2000)
      await page.waitForTimeout(300)
      const box = await page.locator(INDICATOR).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThan(200)
      await expect(page.locator(INDICATOR)).toBeInViewport()
    })

    test('? opens the shortcut list and Escape closes it', async ({ page }) => {
      await page.goto(CHAPTER)
      await page.keyboard.press('?')
      const sheet = page.locator('[data-book-keys]')
      await expect(sheet).toBeVisible()
      await expect(sheet).toContainText('Next page')
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
    })

    test('the shortcut list keeps focus inside and the page behind inert', async ({
      page,
    }) => {
      await page.goto(CHAPTER)
      await page.keyboard.press('?')
      const close = page.locator('[data-book-keys-close]')
      await expect(close).toBeFocused()
      for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
        await page.keyboard.press(key)
        await expect(close).toBeFocused()
      }
      expect(
        await page.locator('.book-content').evaluate((element) => !!element.closest('[inert]')),
      ).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-book-keys-inert]')).toHaveCount(0)
    })

    test('the shortcuts stand down on a page that is not the book', async ({
      page,
    }) => {
      await page.goto(CHAPTER)
      // What a client-router swap to another page leaves: the listener, and
      // no chapter indicator.
      await page.evaluate(() => document.querySelector('[data-chapter-progress]')?.remove())
      await page.keyboard.press('?')
      await expect(page.locator('[data-book-keys]:not([hidden])')).toHaveCount(0)
      await page.keyboard.press(']')
      await page.waitForTimeout(400)
      await expect(page).toHaveTitle(/^Choosing with if/)
    })

    test('in split view the indicator stays above the panes and live', async ({
      page,
    }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('book-challenge-view', 'split')
        } catch {
          // Without storage the view stays stacked, which the test notices.
        }
      })
      await page.goto(`${BOOK}pool-ticket-price/`)
      expect(
        await page.evaluate(() => document.documentElement.getAttribute('data-challenge-view')),
      ).toBe('split')
      const indicator = page.locator(INDICATOR)
      await expect(indicator).toBeInViewport()
      const layout = await page.evaluate(() => {
        const cp = document.querySelector('[data-chapter-progress]')!
        const box = cp.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + 20, box.top + box.height / 2)
        const panes = [...document.querySelectorAll('[data-challenge-split] .split-pane')]
        return {
          covered: !(hit && cp.contains(hit)),
          inert: Boolean(cp.closest('[inert]')),
          bottom: box.bottom,
          paneTop: Math.min(...panes.map((pane) => pane.getBoundingClientRect().top)),
        }
      })
      expect(layout.covered).toBe(false)
      expect(layout.inert).toBe(false)
      expect(layout.paneTop).toBeGreaterThanOrEqual(layout.bottom)
      await page.keyboard.press(']')
      await expect(page).toHaveTitle(/^The fridge that holds the medicine/)
      await expect(page.locator(STATUS)).toHaveText('Practice 2 of 2 · 0/2 solved')
    })

    test('a section segment jumps to its heading', async ({ page }) => {
      await page.goto(CHAPTER)
      const segment = page.locator(`${INDICATOR} [data-cp-section]`).nth(2)
      const anchor = (await segment.getAttribute('data-cp-section'))!
      await segment.click()
      await expect(page.locator(`[id="${anchor}"]`)).toBeInViewport()
      await expect(page.locator(STATUS)).toContainText('Section 3 of')
    })
  })
}
