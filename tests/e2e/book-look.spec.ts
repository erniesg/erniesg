import { expect, test, type Page } from '@playwright/test'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * The book's two looks: the site's reading shell, and the plain reader that
 * `books/tools/preview.py` draws. One page serves both; the choice is
 * `data-book-look` on <html>, remembered in localStorage (`book-look`) and set
 * by `Head.astro` before first paint.
 */

const CHAPTER = '/books/build-a-coding-agent/ch07-strings/'
const SITE_HEADER = 'body > div > header'
const PLAIN_BAR = '[data-book-bar]'

const READER: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'reader',
}

async function look(page: Page) {
  return page.evaluate(() =>
    document.documentElement.getAttribute('data-book-look'),
  )
}

/** The margin API, answered in this process by the real router over SQLite. */
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

test.beforeEach(async ({ page }) => {
  await installStaticRoutes(page)
})

test.describe('the book look switch', () => {
  test('a first visit reads in the site look', async ({ page }) => {
    await page.goto(CHAPTER)
    expect(await look(page)).toBe('site')
    await expect(page.locator(SITE_HEADER)).toBeVisible()
    await expect(
      page.locator('[data-book-look-choice="site"]'),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('Plain is remembered across a reload, and so is going back', async ({
    page,
  }) => {
    await page.goto(CHAPTER)
    await page.locator('[data-book-look-choice="plain"]').click()

    expect(await look(page)).toBe('plain')
    await expect(page.locator(SITE_HEADER)).toBeHidden()
    await expect(page.locator('[data-book-contents-toggle]')).toBeVisible()
    await expect(
      page.locator('[data-book-look-choice="plain"]'),
    ).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    expect(await look(page)).toBe('plain')
    await expect(page.locator(SITE_HEADER)).toBeHidden()

    await page.locator('[data-book-look-choice="site"]').click()
    await page.reload()
    expect(await look(page)).toBe('site')
    await expect(page.locator(SITE_HEADER)).toBeVisible()
    await expect(page.locator('[data-book-contents-toggle]')).toBeHidden()
  })

  test('the switch is keyboard-operable', async ({ page }) => {
    await page.goto(CHAPTER)
    await page.locator('[data-book-look-choice="plain"]').focus()
    await page.keyboard.press('Enter')
    expect(await look(page)).toBe('plain')
    await page.locator('[data-book-look-choice="site"]').focus()
    await page.keyboard.press('Space')
    expect(await look(page)).toBe('site')
  })

  test('the remembered look is set before first paint', async ({
    page,
    request,
  }) => {
    // A parser-blocking inline script in <head> runs before <body> is
    // parsed, so nothing can paint in the wrong look first.
    const html = await (await request.get(CHAPTER)).text()
    const setter = html.indexOf("setAttribute('data-book-look'")
    const body = html.search(/<body[\s>]/)
    expect(setter).toBeGreaterThan(-1)
    expect(setter).toBeLessThan(body)
    expect(html.lastIndexOf('<head', setter)).toBeGreaterThan(-1)

    // And in a browser: with Plain stored, the attribute is already there
    // when the first element of <body> is parsed.
    await page.addInitScript(() => {
      localStorage.setItem('book-look', 'plain')
      new MutationObserver((_, observer) => {
        if (!document.body) return
        ;(window as unknown as { firstBodyLook: string | null }).firstBodyLook =
          document.documentElement.getAttribute('data-book-look')
        observer.disconnect()
      }).observe(document, { childList: true, subtree: true })
    })
    await page.goto(CHAPTER)
    expect(
      await page.evaluate(
        () => (window as unknown as { firstBodyLook: string | null }).firstBodyLook,
      ),
    ).toBe('plain')
  })

  test('in Plain, Contents opens a drawer that Escape closes', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.goto(CHAPTER)
    const toggle = page.locator('[data-book-contents-toggle]')
    const drawer = page.locator('#reading-navigation')

    await expect(drawer).toBeHidden()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('a[aria-current="page"]')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
  })

  test('a theme set in Plain keeps the site theme menu in step', async ({
    page,
  }) => {
    // The page's colour scheme is light, so System means light.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('theme', 'system')
        localStorage.setItem('book-look', 'plain')
        sessionStorage.setItem('seeded', '1')
      }
    })
    await page.goto(CHAPTER)
    const isDark = () =>
      page.evaluate(() => document.documentElement.classList.contains('dark'))

    await page.locator('[data-book-theme-toggle]').click()
    expect(await isDark()).toBe(true)

    await page.locator('[data-book-look-choice="site"]').click()
    await page.locator(`${SITE_HEADER} button[title]`).last().click()
    await page.getByRole('menuitem', { name: /system/i }).click()
    await expect.poll(isDark).toBe(false)
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(
      'system',
    )
  })

  test('the margin popup still opens in Plain', async ({ page }) => {
    await mountMargin(page)
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(CHAPTER)
    await expect(
      page.locator('margin-rail [data-margin-action="keyboard-select"]'),
    ).toBeAttached()
    expect(await look(page)).toBe('plain')

    const blockId = await page.evaluate(() => {
      const block = Array.from(
        document.querySelectorAll('.book-content [data-block-kind="prose"]'),
      ).find((element) => (element.textContent ?? '').length > 120)!
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode() as Text
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(24, node.data.length))
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return block.id
    })
    await page.locator(`#${blockId}`).dispatchEvent('pointerup')
    await expect(page.locator('margin-rail [data-margin-popup]')).toBeVisible()
  })

  test('Plain has no horizontal overflow on a phone', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(CHAPTER)
    await expect(page.locator(PLAIN_BAR)).toBeVisible()
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
