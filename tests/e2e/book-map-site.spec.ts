import { expect, test, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'

/**
 * The book's map on the published site: the same module and markup as the
 * local preview's /map (books/tools/runtime/map.mjs), coloured by the reader's
 * own progress, and linked from every book page. Cytoscape loads from its CDN.
 */
const BOOK = '/books/build-a-coding-agent/'
const MAP = `${BOOK}map/`
const KEY = 'book-progress:v1:build-a-coding-agent'

async function mount(page: Page, solved: string[] = []) {
  await installStaticRoutes(page)
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, canWrite: false, isAdmin: false }),
    }),
  )
  await page.route('**/api/margin/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }),
  )
  await page.addInitScript(
    ({ key, solved }) => {
      if (!solved.length) return
      try {
        localStorage.setItem(
          key,
          JSON.stringify({ version: 1, book: 'build-a-coding-agent', solved, solvedAt: {}, drafts: {} }),
        )
      } catch {}
    },
    { key: KEY, solved },
  )
}

test('every book page links to the map, in both looks', async ({ page }) => {
  await mount(page)
  for (const look of ['site', 'plain']) {
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('book-look', value)
      } catch {}
    }, look)
    for (const path of [BOOK, `${BOOK}ch00-the-loop/`, `${BOOK}pool-ticket-price/`]) {
      await page.goto(path)
      const link = page.locator('[data-book-map-link]')
      await expect(link, `${look} ${path}`).toBeVisible()
      await expect(link).toHaveAttribute('href', MAP)
    }
  }
  await page.locator('[data-book-map-link]').click()
  await expect(page).toHaveURL(new RegExp(`${MAP}$`))
  await expect(page.locator('#map canvas').first()).toBeVisible({ timeout: 30_000 })
})

test("the map is coloured by the reader's progress and leads to the chapters", async ({ page }) => {
  test.slow()
  await mount(page, ['sum-of-two-digits'])
  await page.goto(MAP)
  await expect(page.locator('[data-map-counts]')).toContainText('1 cleared', { timeout: 30_000 })
  const detail = page.locator('#map-detail')
  await expect(detail).toContainText('Where you are', { timeout: 30_000 })
  await expect(detail).toContainText('1 cleared')
  // "Open to you now" lists what the cleared topic unlocked.
  await detail.locator('[data-goto="values-and-variables"]').click()
  await expect(detail.locator('.detail-state')).toHaveText('Open to you now')
  const written = detail.locator('.detail-list a', { hasText: 'What the shop owes you' })
  await expect(written).toHaveAttribute('href', `${BOOK}shop-total/`)
  await written.click()
  await expect(page).toHaveURL(new RegExp(`${BOOK}shop-total/$`))
})

test('every topic can be reached from the keyboard, not only by tapping the canvas', async ({ page }) => {
  test.slow()
  await mount(page, ['sum-of-two-digits'])
  await page.goto(MAP)
  const topics = page.locator('#map-topics button[data-topic]')
  await expect(topics).toHaveCount(36, { timeout: 30_000 })
  // A locked topic, which the summary's "open now" list never links.
  const locked = page.locator('#map-topics button[data-topic="loops"]')
  await expect(locked).toContainText('locked')
  await locked.focus()
  await page.keyboard.press('Enter')
  const detail = page.locator('#map-detail')
  await expect(detail.locator('.detail-state')).toHaveText('Needs something first')
  await expect(detail).toBeFocused()
  await expect(detail.locator('.detail-title')).toHaveText('Repeating with loops')
})

test('a new search replaces the last one rather than adding to it', async ({ page }) => {
  await mount(page)
  await page.goto(MAP)
  await expect(page.locator('#map-detail')).toContainText('Where you are', { timeout: 30_000 })
  const lit = () =>
    page.evaluate(() =>
      (window as unknown as { __bookMap: { nodes(selector: string): { length: number } } }).__bookMap.nodes('.lit').length,
    )
  await page.locator('#map-search').fill('loop')
  const first = await lit()
  expect(first).toBeGreaterThan(0)
  await page.locator('#map-search').fill('zzz-no-such-topic')
  expect(await lit()).toBe(0)
})

test('with no progress, the first topic is open and nothing is cleared', async ({ page }) => {
  await mount(page)
  await page.goto(MAP)
  await expect(page.locator('[data-map-counts]')).toContainText('0 cleared', { timeout: 30_000 })
  await expect(page.locator('#map-detail [data-goto="the-loop"]')).toBeVisible({ timeout: 30_000 })
})
