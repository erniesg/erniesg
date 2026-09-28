import { expect, test } from '@playwright/test'

/**
 * Reading order and chapter progress on the local preview
 * (`books/tools/preview.py`): the same markup and the same runtime as the
 * site, with full page loads instead of a client router. A solved challenge
 * ticked from `progress.json` is covered by `books/tools/test_preview_navigation.py`,
 * which never touches the reader's real progress file.
 */

const INDICATOR = 'header.top [data-chapter-progress]'
const STATUS = `${INDICATOR} [data-cp-status]`

test('] goes to the next node and [ comes back', async ({ page }) => {
  await page.goto('/ch02-conditionals')
  await page.keyboard.press(']')
  await expect(page).toHaveURL(/\/pool-ticket-price$/)
  await expect(page.locator(STATUS)).toHaveText('Practice 1 of 2 · 0/2 solved')
  await page.keyboard.press('[')
  await expect(page).toHaveURL(/\/ch02-conditionals$/)
})

test('shortcuts wait while the reader types in the editor', async ({ page }) => {
  await page.goto('/pool-ticket-price')
  const editor = page.locator('.desk textarea').first()
  await editor.click()
  await page.keyboard.type('x = [1]')
  await page.keyboard.press(']')
  await expect(editor).toHaveValue(/x = \[1\]\]/)
  await expect(page).toHaveURL(/\/pool-ticket-price$/)
})

test('the indicator counts sections and follows the one in view', async ({ page }) => {
  await page.goto('/ch02-conditionals')
  const headings = page.locator('main article h2[id]')
  const total = await headings.count()
  await expect(page.locator(`${INDICATOR} [data-cp-section]`)).toHaveCount(total)
  await expect(page.locator(STATUS)).toHaveText(`Section 1 of ${total} · practice 0/2 solved`)
  await headings.nth(3).evaluate((heading) => heading.scrollIntoView({ block: 'start' }))
  await expect(page.locator(STATUS)).toHaveText(`Section 4 of ${total} · practice 0/2 solved`)
})

test('a solved challenge is ticked and counted as it happens', async ({ page }) => {
  await page.goto('/fridge-alarm')
  const before = await page.locator(STATUS).textContent()
  const solvedAtLoad = /(\d)\/2 solved/.exec(before ?? '')![1]
  await page
    .locator(`${INDICATOR} [data-progress-items="pool-ticket-price"]`)
    .evaluate((segment) => segment.setAttribute('data-progress-done', ''))
  await page
    .locator(`${INDICATOR} [data-progress-items="fridge-alarm"]`)
    .evaluate((segment) => segment.setAttribute('data-progress-done', ''))
  await expect(page.locator(STATUS)).toHaveText('Practice 2 of 2 · 2/2 solved')
  expect(Number(solvedAtLoad)).toBeLessThanOrEqual(2)
})

test('a green grade ticks the challenge without a reload', async ({ page }) => {
  // The grader's answer, stubbed: no real run, and progress.json untouched.
  await page.route('**/api/grade', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, tiers: [], output: '' }),
    }),
  )
  await page.goto('/pool-ticket-price')
  const segment = page.locator(`${INDICATOR} [data-cp-practice="pool-ticket-price"]`)
  const before = await segment.getAttribute('data-progress-done')
  await page.locator('.desk-actions button.run').first().click()
  await expect(segment).toHaveAttribute('data-progress-done', '')
  expect(before === null || before === '').toBe(true)
})

test('the indicator stays in view after scrolling 2000px', async ({ page }) => {
  await page.goto('/ch02-conditionals')
  await page.mouse.wheel(0, 2000)
  await page.waitForTimeout(300)
  await expect(page.locator(INDICATOR)).toBeInViewport()
  const box = await page.locator(INDICATOR).boundingBox()
  expect(box!.y).toBeLessThan(60)
})

test('in split view the indicator stays above the panes and live', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('book-challenge-view', 'split')
    } catch {
      // Without storage the view stays stacked, which the test notices.
    }
  })
  await page.goto('/pool-ticket-price')
  expect(
    await page.evaluate(() => document.documentElement.getAttribute('data-challenge-view')),
  ).toBe('split')
  const layout = await page.evaluate(() => {
    const cp = document.querySelector('header.top [data-chapter-progress]')!
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
  await expect(page).toHaveURL(/\/fridge-alarm$/)
})

test('j moves to the next heading and ? lists the shortcuts', async ({ page }) => {
  await page.goto('/ch02-conditionals')
  const headings = page.locator('main article h2[id]')
  await page.keyboard.press('j')
  await expect(headings.first()).toBeFocused()
  await page.keyboard.press('j')
  await expect(headings.nth(1)).toBeFocused()
  await expect(page.locator(STATUS)).toContainText('Section 2 of')
  await page.keyboard.press('?')
  await expect(page.locator('[data-book-keys]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-book-keys]')).toBeHidden()
})
