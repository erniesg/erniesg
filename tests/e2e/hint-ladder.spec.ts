import { expect, test } from '@playwright/test'

// Spec 066, in the terminal: a bulb shows the next hint; read hints stay a click away.
const GUIDED = '/max-pairwise-product' // four hints
const OTHER_GUIDED = '/overdraft-fees' // three hints

test('a guided challenge has a hint bulb at 0/4 inside the terminal and no support paragraph', async ({ page }) => {
  await page.goto(GUIDED)
  const bulb = page.locator('.desk .desk-actions .hint-button')
  await expect(bulb).toContainText('0/4')
  await expect(page.locator('.desk .hint-panel')).toBeHidden()
  await expect(page.locator('.support, .ladder')).toHaveCount(0)
})

test('the bulb shows hint 1, Next spends another, and a read dot shows it again', async ({ page }) => {
  await page.goto(GUIDED)
  const panel = page.locator('.hint-panel')
  await page.locator('.hint-button').click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.hint-title')).toHaveText('Hint 1 · a nudge')
  await expect(page.locator('.hint-button')).toContainText('1/4')
  await panel.locator('.hint-next').click()
  await expect(panel.locator('.hint-title')).toHaveText(/^Hint 2/)
  await expect(page.locator('.hint-button')).toContainText('2/4')
  await expect(panel.locator('.hint-dot.spent')).toHaveCount(2)
  await expect(panel.locator('.hint-dot[data-rung="3"]')).toBeDisabled()

  await panel.locator('.hint-dot[data-rung="1"]').click()
  await expect(panel.locator('.hint-body[data-rung="1"]')).toBeVisible()
  await expect(page.locator('.hint-button')).toContainText('2/4') // re-reading costs nothing

  await panel.locator('.hint-close').click()
  await expect(panel).toBeHidden()
  await page.locator('.hint-button').click() // reopening does not spend
  await expect(page.locator('.hint-button')).toContainText('2/4')
})

test('spending persists across reloads and is per challenge', async ({ page }) => {
  await page.goto(GUIDED)
  await page.locator('.hint-button').click()
  await page.locator('.hint-next').click()
  await page.reload()
  await expect(page.locator('.hint-button')).toContainText('2/4')
  await page.locator('.hint-button').click()
  await expect(page.locator('.hint-dot.spent')).toHaveCount(2)

  await page.goto(OTHER_GUIDED)
  await expect(page.locator('.hint-button')).toContainText('0/3')
  await page.goto(GUIDED)
  await expect(page.locator('.hint-button')).toContainText('2/4')
})

test('the worked solution sits outside the terminal and is styled apart', async ({ page }) => {
  await page.goto(GUIDED)
  await expect(page.locator('.desk details.solution, .hint-panel .solution')).toHaveCount(0)
  const solution = page.locator('details.solution')
  await expect(solution).toHaveCount(1)
  expect(await solution.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('2px')
})

test('a worked challenge has no support paragraph either', async ({ page }) => {
  await page.goto('/pool-ticket-price')
  await expect(page.locator('.support')).toHaveCount(0)
  await expect(page.locator('.hint-button')).toHaveCount(1)
})

test('an unaided challenge has no hints and explains the lock', async ({ page }) => {
  await page.goto('/bad-row-report')
  await expect(page.locator('.hint-button, .hint-panel')).toHaveCount(0)
  await expect(page.locator('.locked-solution')).toContainText('unlocks')
})

test('a contract challenge prints no note that repeats the page', async ({ page }) => {
  await page.goto('/buy-low-sell-later')
  await expect(page.locator('.support')).toHaveCount(0)
})

test('print keeps every hint as a section with no controls', async ({ page }) => {
  const html = await (await page.request.get('/print')).text()
  expect(html).not.toContain('class="hint-button"')
  expect(html).toContain('<p class="hint-title">Hint 1</p>')
})

test('a figure explains itself above, not below', async ({ page }) => {
  await page.goto('/ch03-lists')
  const figure = page.locator('figure.figure').first()
  const lead = await figure.locator('figcaption').boundingBox()
  const body = await figure.locator('dl, .walk, svg, table').first().boundingBox()
  expect(lead!.y).toBeLessThan(body!.y)
})
