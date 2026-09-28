import { expect, test, type Page } from '@playwright/test'

/**
 * The local preview's challenge side by side: the question on the left, the
 * live desk (editor, Run all tiers, hints) on the right, sticky. Same toggle,
 * key and attribute as the site (`challenge-view.spec.ts`); here the desk
 * actually runs, so the grading path is exercised in the split layout too.
 */

const CHALLENGE = '/pool-ticket-price'
const TOGGLE = '[data-challenge-view-toggle]'

type Box = { x: number; y: number; width: number; height: number }

async function panes(page: Page) {
  const question = (await page.locator('.split-question').boundingBox()) as Box
  const work = (await page.locator('.split-work').boundingBox()) as Box
  return { question, work }
}

test('the question and the live desk sit side by side, remembered across a reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(CHALLENGE)
  await page.locator(TOGGLE).click()
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true')

  const { question, work } = await panes(page)
  expect(work.x).toBeGreaterThanOrEqual(question.x + question.width - 1)
  await expect(page.locator('.split-work .desk .editor')).toBeInViewport()
  await expect(page.locator('.split-work .desk .run')).toBeInViewport()

  // The question scrolls; the desk does not leave the screen.
  await page.mouse.wheel(0, 900)
  await expect
    .poll(async () => (await panes(page)).question.y)
    .toBeLessThan(question.y - 300)
  await expect(page.locator('.split-work .desk .run')).toBeInViewport()

  await page.reload()
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true')
  const again = await panes(page)
  expect(again.work.x).toBeGreaterThanOrEqual(again.question.x + again.question.width - 1)
})

test('Run all tiers grades from the split desk', async ({ page }) => {
  await page.route('**/api/grade', (route) =>
    route.fulfill({
      json: {
        ok: false,
        tiers: [{ tier: 'public', outcome: 'fail' }],
        stopped_at: 'public',
        output: 'Traceback: not written yet',
        summary: 'not written yet',
      },
    }),
  )
  await page.addInitScript(() => localStorage.setItem('book-challenge-view', 'split'))
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(CHALLENGE)
  const desk = page.locator('.split-work .desk')
  await desk.locator('.run').click()
  await expect(desk.locator('.desk-verdict')).toBeVisible()
  await expect(desk.locator('.desk-verdict')).toBeInViewport()
  await expect(desk.locator('.tiers')).not.toBeEmpty()
})

test('narrow windows stay stacked and the toggle says why', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('book-challenge-view', 'split'))
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto(CHALLENGE)
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-disabled', 'true')
  await expect(page.locator(TOGGLE)).toHaveAttribute('title', /wider window/)
  const { question, work } = await panes(page)
  expect(work.y).toBeGreaterThanOrEqual(question.y + question.height - 1)
})
