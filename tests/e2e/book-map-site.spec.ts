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

test('the topic list follows the book, part by part', async ({ page }) => {
  await mount(page)
  await page.goto(MAP)
  const headings = page.locator('#map-topics .map-topics-part')
  await expect(headings.first()).toBeVisible({ timeout: 30_000 })
  const parts = (await headings.allInnerTexts()).map((text) => Number(/Part (\d+)/i.exec(text)?.[1]))
  expect(parts).toEqual([...parts].sort((a, b) => a - b))
})

test('in a dark theme the text around the map stays readable', async ({ page }) => {
  await mount(page)
  for (const look of ['site', 'plain']) {
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('theme', 'dark')
        localStorage.setItem('book-look', value)
      } catch {}
    }, look)
    await page.goto(MAP)
    await expect(page.locator('#map-topics .map-topic-state').first()).toBeVisible({ timeout: 30_000 })
    for (const selector of ['.map-lede', '.map-counts', '.legend-item', '.map-topics-part', '.map-topic-state']) {
      const ratio = await page.locator(selector).first().evaluate((element) => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
        const luminance = ([r, g, b]: number[]) => {
          const channel = (c: number) => {
            const s = c / 255
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }
        let background = [0, 0, 0, 0]
        for (let node: Element | null = element; node; node = node.parentElement) {
          const value = rgb(getComputedStyle(node).backgroundColor)
          if (value.length === 3 || (value[3] ?? 0) > 0.9) { background = value; break }
        }
        const fore = luminance(rgb(getComputedStyle(element).color))
        const back = luminance(background)
        return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05)
      })
      expect(ratio, `${look} ${selector}`).toBeGreaterThanOrEqual(4.5)
    }
  }
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

test('the plain bar keeps every control in view on a 320px phone', async ({ page }) => {
  await mount(page)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('book-look', 'plain')
    } catch {}
  })
  await page.setViewportSize({ width: 320, height: 640 })
  for (const path of [BOOK, MAP, `${BOOK}ch06-dicts-sets/`]) {
    await page.goto(path)
    const bar = page.locator('[data-book-bar]')
    const fits = await bar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    expect(fits, `${path} bar overflows`).toBe(true)
    for (const control of ['[data-book-map-link]', '[data-book-look-choice="site"]', '[data-book-theme-toggle]']) {
      const box = await page.locator(control).boundingBox()
      expect(box, `${path} ${control}`).not.toBeNull()
      expect(box!.x + box!.width, `${path} ${control} is clipped`).toBeLessThanOrEqual(320)
    }
  }
})

test('the front page, the map and a chapter share one bar, and [ ] walk between them', async ({ page }) => {
  await mount(page)
  for (const look of ['site', 'plain']) {
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('book-look', value)
      } catch {}
    }, look)
    for (const [path, name] of [
      [BOOK, 'Contents'],
      [MAP, 'The map'],
      [`${BOOK}ch06-dicts-sets/`, 'Ch 6'],
    ]) {
      await page.goto(path)
      const bar = page.locator('[data-book-bar] [data-chapter-progress]')
      await expect(bar, `${look} ${path}`).toBeVisible()
      await expect(bar.locator('.cp-chapter')).toContainText(name)
      await expect(bar.locator('a.cp-step[rel="next"]')).toBeVisible()
      await expect(bar.locator('.cp-keys')).toBeVisible()
    }
  }
  // The keys follow the arrows on the book's own pages too.
  await page.goto(BOOK)
  await page.keyboard.press(']')
  await expect(page).toHaveURL(/\/books\/build-a-coding-agent\/front-matter\/$/)
  await page.goto(MAP)
  await page.keyboard.press('[')
  await expect(page).toHaveURL(new RegExp(`${BOOK}$`))
})

test('in dark mode, inline code on the page is a dark chip, not a bright one', async ({ page }) => {
  await mount(page)
  for (const look of ['site', 'plain']) {
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('theme', 'dark')
        localStorage.setItem('book-look', value)
      } catch {}
    }, look)
    await page.goto(`${BOOK}pool-ticket-price/`)
    const chip = page.locator('.book-content .io-row code').first()
    await expect(chip).toBeVisible()
    const [background, color] = await chip.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.backgroundColor, style.color]
    })
    const level = (value: string) => {
      const [r, g, b] = (value.match(/[\d.]+/g) ?? []).map(Number)
      return (r + g + b) / 3
    }
    expect(level(background), `${look} chip background ${background}`).toBeLessThan(90)
    expect(level(color), `${look} chip text ${color}`).toBeGreaterThan(180)
  }
})

test('with no progress, the first topic is open and nothing is cleared', async ({ page }) => {
  await mount(page)
  await page.goto(MAP)
  await expect(page.locator('[data-map-counts]')).toContainText('0 cleared', { timeout: 30_000 })
  await expect(page.locator('#map-detail [data-goto="the-loop"]')).toBeVisible({ timeout: 30_000 })
})
