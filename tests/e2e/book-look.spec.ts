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

  test('the remembered look is set before first paint', async ({ page }) => {
    // A parser-blocking inline script in <head> runs before <body> is
    // parsed, so nothing can paint in the wrong look first. Fetched from the
    // page, so a static-build run's routes answer it too.
    await page.goto(CHAPTER)
    const html = await page.evaluate(async (path) => {
      const response = await fetch(path)
      return response.text()
    }, CHAPTER)
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

  test('the plain theme button follows a theme change made elsewhere', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.goto(CHAPTER)
    const button = page.locator('[data-book-theme-toggle]')
    await expect(button).toHaveAttribute('aria-label', 'Switch to dark theme')
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await expect(button).toHaveAttribute('aria-label', 'Switch to light theme')
  })

  test('printing hides the open contents drawer', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.goto(CHAPTER)
    await page.locator('[data-book-contents-toggle]').click()
    await expect(page.locator('#reading-navigation')).toBeVisible()
    await page.emulateMedia({ media: 'print' })
    await expect(page.locator('#reading-navigation')).toBeHidden()
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

/**
 * Plain is the preview's reader: the chapter rail beside the text ("In this
 * chapter", "Connected"), Map and Print in the bar, the counter "n/46 · m/30
 * solved", and the margin as its small button. The front page carries a bar
 * of its own in both looks.
 */
const BOOK = '/books/build-a-coding-agent/'
const RAIL = '[data-reading-companion] [data-book-rail]'

test.describe('Plain matches the preview', () => {
  test('the column beside the text is the chapter rail, and the margin is its button', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${BOOK}ch03-lists/`)

    const rail = page.locator(RAIL)
    await expect(rail).toBeVisible()
    await expect(rail.getByText('In this chapter')).toBeVisible()
    await expect(rail.getByText('Connected')).toBeVisible()
    await expect(rail.getByRole('link', { name: /Open the map/ })).toHaveAttribute(
      'href',
      `${BOOK}map/`,
    )
    await expect(rail.locator('[data-rail-section]').first()).toHaveAttribute(
      'aria-current',
      'location',
    )
    // The annotation panel is not in that column: the margin is collapsed.
    await expect(page.locator('margin-rail')).toHaveAttribute('collapsed', '')
    await expect(
      page.locator('margin-rail [data-margin-action="keyboard-select"]'),
    ).toBeHidden()

    // Back in Site, the margin column returns and the rail steps aside.
    await page.locator('[data-book-look-choice="site"]').click()
    await expect(rail).toBeHidden()
    await expect(page.locator('margin-rail')).not.toHaveAttribute('collapsed', '')
  })

  test('the bar has Map, Print and the solved count', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.goto(`${BOOK}ch03-lists/`)
    const bar = page.locator(PLAIN_BAR)
    await expect(bar.getByRole('link', { name: 'Map' })).toHaveAttribute('href', `${BOOK}map/`)
    await expect(bar.getByRole('link', { name: 'Print' })).toHaveAttribute(
      'href',
      `${BOOK}print/#print-ch03-lists`,
    )
    await expect(bar.locator('.book-bar-progress-text')).toHaveText(/^\s*\d+\/46\s*·\s*0\/30 solved\s*$/)
  })

  test('the map and the print edition are pages of the book', async ({ page }) => {
    await page.goto(`${BOOK}map/`)
    // Counted by the map's own script, before the graph library draws.
    await expect(page.locator('[data-map-counts]')).toHaveText(
      /^\d+ topics · \d+ cleared · \d+ with content written$/,
    )
    await page.goto(`${BOOK}print/`)
    await expect(page.locator('[data-book-print] .print-page')).toHaveCount(46)
    await expect(page.locator('#print-ch03-lists')).toBeAttached()
  })

  for (const choice of ['site', 'plain'] as const) {
    test(`in ${choice}, the map and the print edition get a full reading width`, async ({
      page,
    }) => {
      await page.addInitScript((value) => localStorage.setItem('book-look', value), choice)
      await page.setViewportSize({ width: 1440, height: 1000 })
      const width = (css: string) =>
        page.evaluate((selector) => document.querySelector(selector)!.getBoundingClientRect().width, css)
      await page.goto(`${BOOK}print/`)
      expect(await width('[data-book-print]')).toBeGreaterThan(550)
      await page.goto(`${BOOK}map/`)
      expect(await width('[data-book-map]')).toBeGreaterThan(900)
    })
  }

  test('the edit toolbar waits for Edit in the plain bar', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    await page.goto(`${BOOK}ch03-lists/`)
    const proxy = page.locator('[data-book-edit]')
    // Nobody may write yet, so there is no Edit at all.
    await expect(proxy).toBeHidden()

    // A writer gets the page's edit mode; in Plain only the bar's button shows.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-edit-mode]')!.hidden = false
    })
    await expect(proxy).toBeVisible()
    await expect(page.locator('.edit-bar')).toBeHidden()

    // While editing, the toolbar is there, and the button says so.
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-book-editing', '')
      document.querySelector('[data-edit-toggle]')!.setAttribute('aria-pressed', 'true')
    })
    await expect(page.locator('.edit-bar')).toBeVisible()
    await expect(proxy).toHaveAttribute('aria-pressed', 'true')

    // In Site the toolbar shows as it always has.
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-book-editing')
      document.querySelector('[data-edit-toggle]')!.setAttribute('aria-pressed', 'false')
    })
    await page.locator('[data-book-look-choice="site"]').click()
    await expect(page.locator('.edit-bar')).toBeVisible()
  })

  test('p switches the look, but not while typing', async ({ page }) => {
    await page.goto(`${BOOK}ch03-lists/`)
    expect(await look(page)).toBe('site')
    await page.locator('body').press('p')
    expect(await look(page)).toBe('plain')
    await page.locator('body').press('p')
    expect(await look(page)).toBe('site')

    await page.locator('.book-content textarea.editor').first().click()
    await page.keyboard.press('p')
    expect(await look(page)).toBe('site')

    await page.locator('[data-book-keys-toggle]').first().click()
    await expect(page.locator('[data-book-keys]')).toContainText('Switch between the Site and Plain looks')
  })

  test('the switch sits beside the theme button in both looks', async ({ page }) => {
    await page.goto(`${BOOK}ch03-lists/`)
    const near = async () =>
      page.evaluate(() => {
        const look = document.querySelector('.book-look')!.getBoundingClientRect()
        const theme = document.querySelector('[data-book-theme-toggle]')!.getBoundingClientRect()
        return theme.width > 0 && Math.abs(theme.left - look.right) < 40 && Math.abs(theme.top - look.top) < 20
      })
    expect(await near()).toBe(true)
    await page.locator('[data-book-look-choice="plain"]').click()
    expect(await near()).toBe(true)
  })
})

test.describe('the front page', () => {
  for (const choice of ['site', 'plain'] as const) {
    test(`in ${choice}, a bar says Contents and how much is solved, and › starts the book`, async ({
      page,
    }) => {
      await page.addInitScript((value) => localStorage.setItem('book-look', value), choice)
      await page.goto(BOOK)
      const bar = page.locator('[data-chapter-progress][data-kind="front"]')
      await expect(bar).toBeVisible()
      await expect(bar.locator('.cp-chapter')).toHaveText('Contents')
      await expect(bar.locator('[data-progress-solved]')).toHaveText('0/30 solved')
      await expect(bar.locator('a[rel="next"]')).toHaveAttribute('href', `${BOOK}front-matter/`)
      if (choice === 'plain') {
        await expect(page.locator('.book-bar-progress-text')).toHaveText(/^\s*0\/46\s*·\s*0\/30 solved\s*$/)
      }
      await page.locator('body').press(']')
      await expect(page).toHaveURL(new RegExp(`${BOOK}front-matter/$`))
    })

    test(`in ${choice}, its contents read like the contents column`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('book-look', value), choice)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(BOOK)
      const colour = (selector: string) =>
        page.evaluate(
          (css) => getComputedStyle(document.querySelector(css)!).color,
          selector,
        )
      const front = '[data-book-front-contents] a[href$="/ch03-lists/"]'
      const column = '#reading-navigation a[href$="/ch03-lists/"]'
      await expect(page.locator(front)).toBeVisible()
      expect(await colour(front)).toBe(await colour(column))
      const underline = await page.evaluate(
        (css) => getComputedStyle(document.querySelector(css)!).textDecorationLine,
        front,
      )
      expect(underline).toBe('none')
    })
  }
})
