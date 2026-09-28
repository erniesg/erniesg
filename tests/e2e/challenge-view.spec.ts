import { expect, test, type Page } from '@playwright/test'
import { expectIndependentPanes } from './split-panes'
import { installStaticRoutes } from './static-build'

/**
 * A challenge side by side: the question in the left pane, the work (the
 * starter, the hints, the worked solution) in the right. The choice is
 * `data-challenge-view` on <html>, remembered in localStorage
 * (`book-challenge-view`) and set by `Head.astro` before first paint. The
 * toggle and its behaviour come from `books/tools/render.py`, shared with the
 * local preview (`challenge-view-preview.spec.ts`).
 */

const CHALLENGE = '/books/build-a-coding-agent/pool-ticket-price/'
const TOGGLE = '[data-challenge-view-toggle]'

type Box = { x: number; y: number; width: number; height: number }

async function panes(page: Page) {
  const question = (await page.locator('.split-question').boundingBox()) as Box
  const work = (await page.locator('.split-work').boundingBox()) as Box
  return { question, work }
}

function sideBySide({ question, work }: { question: Box; work: Box }) {
  return work.x >= question.x + question.width - 1 && Math.abs(work.y - question.y) < 40
}

async function remember(page: Page, entries: Record<string, string>) {
  await page.addInitScript((stored) => {
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value)
  }, entries)
}

test.beforeEach(async ({ page }) => {
  await installStaticRoutes(page)
  // No margin service here; a 404 reads as an absent service.
  await page.route('**/api/margin/v1/**', (route) => route.fulfill({ status: 404, json: {} }))
})

test.describe('the challenge side-by-side view', () => {
  test('the toggle puts the question and the work side by side, and it is remembered', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(CHALLENGE)
    const toggle = page.locator(TOGGLE)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(sideBySide(await panes(page))).toBe(false)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(sideBySide(await panes(page))).toBe(true)

    await page.reload()
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true')
    expect(sideBySide(await panes(page))).toBe(true)

    await page.locator(TOGGLE).click()
    await page.reload()
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false')
    expect(sideBySide(await panes(page))).toBe(false)
  })

  for (const bookLook of ['site', 'plain']) {
    test(`split panes scroll independently and the page does not (${bookLook} look)`, async ({
      page,
    }) => {
      await remember(page, { 'book-look': bookLook, 'book-challenge-view': 'split' })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(CHALLENGE)
      await expect(page.locator('html')).toHaveAttribute('data-book-look', bookLook)
      await expectIndependentPanes(page)
    })
  }

  test('what split covers leaves the tab order, and stacked gives it back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(CHALLENGE)
    const inert = (selector: string) =>
      page.locator(selector).first().evaluate((element) => !!element.closest('[inert]'))
    const READING_ORDER = 'nav[aria-label="Reading order"]'
    await page.locator(TOGGLE).click()
    expect(await inert('[data-book-look-choice="plain"]')).toBe(true)
    expect(await inert(READING_ORDER)).toBe(true)
    expect(await inert('#reading-navigation')).toBe(true)
    expect(await inert(TOGGLE)).toBe(false)
    expect(await inert('body > div > header')).toBe(false)
    expect(await inert('.split-work .desk, .split-work')).toBe(false)

    // Tabbing forward from the toggle stays in the view.
    await page.locator(TOGGLE).focus()
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      const covered = await page.evaluate(() => {
        const active = document.activeElement
        return !!active && !active.closest('[data-challenge-split]') && !active.closest('header')
          && !active.closest('.reading-margin')
      })
      expect(covered).toBe(false)
    }

    await page.locator(TOGGLE).click()
    expect(await inert(READING_ORDER)).toBe(false)
    expect(await inert('[data-book-look-choice="plain"]')).toBe(false)
    expect(await page.locator('[data-split-inert]').count()).toBe(0)
  })

  test('in the plain look the bar stays usable while split', async ({ page }) => {
    await remember(page, { 'book-look': 'plain', 'book-challenge-view': 'split' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(CHALLENGE)
    const inert = (selector: string) =>
      page.locator(selector).first().evaluate((element) => !!element.closest('[inert]'))
    expect(await inert('[data-book-bar]')).toBe(false)
    expect(await inert('[data-book-contents-toggle]')).toBe(false)
    expect(await inert('nav[aria-label="Reading order"]')).toBe(true)
  })

  test('printing a split page prints the whole challenge in normal flow', async ({ page }) => {
    await remember(page, { 'book-challenge-view': 'split' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(CHALLENGE)
    await page.emulateMedia({ media: 'print' })
    const layout = await page.evaluate(() => {
      const view = document.querySelector('.challenge-view') as HTMLElement
      const work = document.querySelector('.split-work') as HTMLElement
      return {
        position: getComputedStyle(view).position,
        overflow: getComputedStyle(work).overflowY,
        clipped: work.scrollHeight > work.clientHeight + 1,
      }
    })
    expect(layout).toEqual({ position: 'static', overflow: 'visible', clipped: false })
  })

  test('below 1000px it is stacked, and the toggle says why it is off', async ({ page }) => {
    await remember(page, { 'book-challenge-view': 'split' })
    await page.setViewportSize({ width: 900, height: 900 })
    await page.goto(CHALLENGE)
    const toggle = page.locator(TOGGLE)
    await expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await expect(toggle).toHaveAttribute('title', /wider window/)
    const { question, work } = await panes(page)
    expect(work.y).toBeGreaterThanOrEqual(question.y + question.height - 1)

    // Assistive tech reads it as disabled; a forced press still does nothing,
    // and the stored choice survives for a wider window.
    await toggle.click({ force: true })
    expect(
      await page.evaluate(() => localStorage.getItem('book-challenge-view')),
    ).toBe('split')

    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(toggle).toHaveAttribute('aria-disabled', 'false')
    expect(sideBySide(await panes(page))).toBe(true)
  })

  test('the margin folds into its overlay while split, and comes back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(CHALLENGE)
    const rail = page.locator('margin-rail')
    await expect(rail).toHaveAttribute('collapse-below', '1280')
    await page.locator(TOGGLE).click()
    await expect(rail).toHaveAttribute('collapse-below', '100000')
    await page.locator(TOGGLE).click()
    await expect(rail).toHaveAttribute('collapse-below', '1280')
  })

  test('the plain look splits too', async ({ page }) => {
    await remember(page, { 'book-look': 'plain', 'book-challenge-view': 'split' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(CHALLENGE)
    await expect(page.locator('html')).toHaveAttribute('data-book-look', 'plain')
    expect(sideBySide(await panes(page))).toBe(true)
  })

  test('a chapter page has no toggle and keeps its margin column', async ({ page }) => {
    await remember(page, { 'book-challenge-view': 'split' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/books/build-a-coding-agent/ch07-strings/')
    await expect(page.locator(TOGGLE)).toHaveCount(0)
    await expect(page.locator('margin-rail')).toHaveAttribute('collapse-below', '1280')
  })

  test('the remembered view is set before first paint', async ({ page }) => {
    await page.goto(CHALLENGE)
    const html = await page.evaluate(async (path) => (await fetch(path)).text(), CHALLENGE)
    const setter = html.indexOf("setAttribute('data-challenge-view'")
    expect(setter).toBeGreaterThan(-1)
    expect(setter).toBeLessThan(html.search(/<body[\s>]/))

    await page.addInitScript(() => {
      localStorage.setItem('book-challenge-view', 'split')
      new MutationObserver((_, observer) => {
        if (!document.body) return
        ;(window as unknown as { firstBodyView: string | null }).firstBodyView =
          document.documentElement.getAttribute('data-challenge-view')
        observer.disconnect()
      }).observe(document, { childList: true, subtree: true })
    })
    await page.goto(CHALLENGE)
    expect(
      await page.evaluate(
        () => (window as unknown as { firstBodyView: string | null }).firstBodyView,
      ),
    ).toBe('split')
  })
})
