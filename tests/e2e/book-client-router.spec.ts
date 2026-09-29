import { expect, test, type Page } from '@playwright/test'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * #382: a client-routed link on a book page must move the whole page, URL
 * included. The header was `transition:persist` and so were three islands
 * inside it; Astro moves every persisted element on its own, so the islands
 * were moved into the new header's discarded copy. Chromium's `moveBefore`
 * refuses that with a HierarchyRequestError, the swap aborts before history
 * is written, and the address bar keeps the old page.
 */

const BOOK = '/books/build-a-coding-agent/'
const FROM = `${BOOK}ch02-conditionals/`
const TO = `${BOOK}ch03-lists/`

const READER: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'reader',
}

async function mountMargin(page: Page) {
  const repository = new D1MarginRepository(SqliteD1Database.inMemory())
  let sequence = 0
  const now = () => new Date(Date.UTC(2026, 8, 29)).toISOString()
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

/** Every page error and console error, so a swap that throws fails the test. */
function collectErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

async function expectOn(page: Page, path: string, title: RegExp, chapter: RegExp) {
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`))
  await expect(page).toHaveTitle(title)
  await expect(page.locator('[data-chapter-progress] .cp-chapter')).toHaveText(chapter)
  await expect(
    page.locator(`#reading-navigation a[aria-current="page"][href="${path}"]`),
  ).toHaveCount(1)
  await expect(page.locator('margin-rail')).toHaveAttribute(
    'document-uri',
    new RegExp(`${path.replace(/\//g, '\\/')}$`),
  )
}

for (const look of ['site', 'plain'] as const) {
  test.describe(`client-routed navigation moves the URL (${look})`, () => {
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

    test('contents link, ], Back and Forward all land on the right page', async ({
      page,
    }) => {
      const errors = collectErrors(page)
      await page.goto(FROM)
      await expectOn(page, FROM, /^Choosing with if/, /^Ch 2 ·/)

      // The contents entry for the next chapter. In Plain it lives in a drawer.
      if (look === 'plain') await page.locator('[data-book-contents-toggle]').click()
      await page.locator(`#reading-navigation a[href="${TO}"]`).click()
      await expectOn(page, TO, /^Lists and how to use them/, /^Ch 3 ·/)

      // ] follows the page's own rel=next link; the URL must follow it too.
      const next = await page.locator('.book-pager a[rel="next"]').getAttribute('href')
      expect(next).toBeTruthy()
      await page.keyboard.press(']')
      await expect(page).toHaveURL(new RegExp(`${next!.replace(/\//g, '\\/')}$`))
      await expect(page.locator('margin-rail')).toHaveAttribute(
        'document-uri',
        new RegExp(`${next!.replace(/\//g, '\\/')}$`),
      )

      await page.goBack()
      await expectOn(page, TO, /^Lists and how to use them/, /^Ch 3 ·/)
      await page.goBack()
      await expectOn(page, FROM, /^Choosing with if/, /^Ch 2 ·/)
      await page.goForward()
      await expectOn(page, TO, /^Lists and how to use them/, /^Ch 3 ·/)

      // The header's islands survive every swap, still mounted and still one each.
      await expect(
        page.locator('header').getByRole('button', { name: 'Toggle theme', includeHidden: true }),
      ).toHaveCount(1)
      await expect(
        page.locator('header').getByRole('button', { name: /change language/i, includeHidden: true }),
      ).toHaveCount(1)

      expect(errors).toEqual([])
    })
  })
}
