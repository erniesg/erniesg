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
// Has a figure (with a caption and a definition list), inline code and exercises.
const FIGURE_CHAPTER = '/books/build-a-coding-agent/ch05-functions/'
// Has a cost chart: an SVG drawn with fixed colours.
const CHART_CHAPTER = '/books/build-a-coding-agent/ch06-dicts-sets/'
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

  for (const choice of ['site', 'plain'] as const) {
    test(`in the dark theme, ${choice} paints the book's panels dark and legible`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('theme', 'dark')
        localStorage.setItem('book-look', value)
      }, choice)
      await page.goto(FIGURE_CHAPTER)
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)

      const samples = await page.evaluate(() => {
        // The colour actually behind an element: the first opaque background up
        // its ancestors, so a transparent element is judged against its panel.
        const parse = (value: string) => {
          const match = value.match(/rgba?\(([^)]+)\)/)
          if (!match) return null
          const [r, g, b, a = 1] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number)
          return { r, g, b, a }
        }
        const behind = (element: Element) => {
          for (let node: Element | null = element; node; node = node.parentElement) {
            const colour = parse(getComputedStyle(node).backgroundColor)
            if (colour && colour.a > 0.5) return colour
          }
          return parse(getComputedStyle(document.body).backgroundColor)!
        }
        const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
          const channel = (value: number) => {
            const v = value / 255
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }
        const contrast = (a: number, b: number) =>
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        const sample = (name: string, selector: string) => {
          const element = document.querySelector(selector)
          if (!element) return { name, missing: true }
          const background = luminance(behind(element))
          const ink = luminance(parse(getComputedStyle(element).color)!)
          return { name, background, contrast: contrast(background, ink) }
        }
        return [
          sample('figure', '.book-content .figure'),
          sample('figure title', '.book-content .figure-title'),
          sample('figure caption', '.book-content figcaption'),
          sample('figure definition', '.book-content .pairs dd'),
          sample('figure term', '.book-content .pairs dt'),
          sample('inline code', '.book-content p > code'),
          sample('exercise', '.book-content .exercise'),
        ]
      })

      for (const entry of samples) {
        expect(entry, `${entry.name} is on the page`).not.toHaveProperty('missing')
        // Dark: no white card or chip on the dark page.
        expect(entry.background, `${entry.name} background`).toBeLessThan(0.1)
        expect(entry.contrast, `${entry.name} contrast`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  for (const choice of ['site', 'plain'] as const) {
    test(`in the dark theme, ${choice} redraws a chart's labels and lines for the dark card`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('theme', 'dark')
        localStorage.setItem('book-look', value)
      }, choice)
      await page.goto(CHART_CHAPTER)
      const result = await page.evaluate(() => {
        const parse = (value: string) => {
          const match = value.match(/rgba?\(([^)]+)\)/)
          if (!match) return null
          const [r, g, b] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number)
          return { r, g, b }
        }
        const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
          const channel = (value: number) => {
            const v = value / 255
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }
        const contrast = (a: number, b: number) =>
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        const chart = document.querySelector('.book-content svg.cost')
        if (!chart) return null
        const card = luminance(parse(getComputedStyle(chart.closest('.figure')!).backgroundColor)!)
        const against = (value: string) => contrast(card, luminance(parse(value)!))
        return {
          labels: [...chart.querySelectorAll('text')].map((t) => against(getComputedStyle(t).fill)),
          lines: [...chart.querySelectorAll('polyline')].map((l) => against(getComputedStyle(l).stroke)),
        }
      })
      expect(result, 'a cost chart is on the page').not.toBeNull()
      expect(result!.labels.length).toBeGreaterThan(0)
      expect(result!.lines.length).toBeGreaterThan(0)
      for (const value of result!.labels) expect(value, 'tick label contrast').toBeGreaterThanOrEqual(4.5)
      // Lines are graphics, not text: 3:1 is the bar for those.
      for (const value of result!.lines) expect(value, 'series line contrast').toBeGreaterThanOrEqual(3)
    })
  }
})

