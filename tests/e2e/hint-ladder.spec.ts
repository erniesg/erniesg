import { expect, test } from '@playwright/test'

// Spec 066: one ladder that shows what it costs and what was already read.
const GUIDED = '/max-pairwise-product' // four hints
const OTHER_GUIDED = '/overdraft-fees' // three hints

test('a guided challenge shows one ladder at 0 of 4 and no support paragraph', async ({ page }) => {
  await page.goto(GUIDED)
  await expect(page.locator('.ladder')).toHaveCount(1)
  await expect(page.locator('.ladder-count')).toHaveText('0 of 4 hints')
  await expect(page.locator('.support')).toHaveCount(0)
})

test('opening rungs spends them, persists, and is per challenge', async ({ page }) => {
  await page.goto(GUIDED)
  await page.locator('.ladder > summary').click()
  await page.locator('.rung > summary').nth(0).click()
  await page.locator('.rung > summary').nth(1).click()
  await expect(page.locator('.ladder-count')).toHaveText('2 of 4 hints')
  await page.locator('.rung > summary').nth(0).click() // collapse: count must not fall
  await expect(page.locator('.ladder-count')).toHaveText('2 of 4 hints')
  await expect(page.locator('.rung.spent')).toHaveCount(2)

  await page.reload()
  await expect(page.locator('.ladder-count')).toHaveText('2 of 4 hints')
  await expect(page.locator('.rung.spent')).toHaveCount(2)
  await expect(page.locator('.rung[data-rung="1"]')).toHaveClass(/spent/)
  await expect(page.locator('.rung[data-rung="3"]')).not.toHaveClass(/spent/)

  await page.goto(OTHER_GUIDED)
  await expect(page.locator('.ladder-count')).toHaveText('0 of 3 hints')
  await expect(page.locator('.rung.spent')).toHaveCount(0)
  await page.goto(GUIDED)
  await expect(page.locator('.ladder-count')).toHaveText('2 of 4 hints')
})

test('the worked solution ends the ladder instead of continuing it', async ({ page }) => {
  await page.goto(GUIDED)
  await expect(page.locator('.ladder .solution')).toHaveCount(0)
  const solution = page.locator('details.solution')
  await expect(solution).toHaveCount(1)
  expect(await solution.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('2px')
})

test('a worked challenge has no support paragraph either', async ({ page }) => {
  await page.goto('/pool-ticket-price')
  await expect(page.locator('.support')).toHaveCount(0)
  await expect(page.locator('.ladder')).toHaveCount(1)
})

test('an unaided challenge has no ladder and explains the lock', async ({ page }) => {
  await page.goto('/bad-row-report')
  await expect(page.locator('.ladder, .rung')).toHaveCount(0)
  await expect(page.locator('.locked-solution')).toContainText('unlocks')
})

test('a contract challenge prints no note that repeats the page', async ({ page }) => {
  await page.goto('/buy-low-sell-later')
  await expect(page.locator('.support')).toHaveCount(0)
})

test('print keeps every hint as a section with no ladder', async ({ page }) => {
  const html = await (await page.request.get('/print')).text()
  expect(html).not.toContain('class="ladder"')
  expect(html).toContain('<p class="hint-title">Hint 1</p>')
})
