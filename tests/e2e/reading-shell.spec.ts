import { expect, test, type Page } from '@playwright/test'

/**
 * The three-column reading shell, in a browser.
 *
 * The margin column is empty on purpose: it reserves its width now so that
 * mounting the annotation layer later moves the text by nothing.
 */

const BOOK = '/books/build-a-coding-agent/'
const CHAPTER = '/books/build-a-coding-agent/ch12-hash-maps/'
const DIRECTORY = '/books/'
const OVERFLOW_EPSILON_CSS_PX = 1

async function visibleColumns(page: Page): Promise<string[]> {
  return page.$$eval('[data-reading-column]', (elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => element.getAttribute('data-reading-column') ?? ''),
  )
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement
    return root.scrollWidth - root.clientWidth
  })
}

test.describe('the reading shell', () => {
  test('shows three columns above 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(CHAPTER)

    expect(await visibleColumns(page)).toEqual(['navigation', 'text', 'margin'])
    await expect(page.locator('[data-margin-mount]')).toBeVisible()
  })

  test('collapses the margin below 1280px, leaving two', async ({ page }) => {
    await page.setViewportSize({ width: 1279, height: 1000 })
    await page.goto(CHAPTER)

    expect(await visibleColumns(page)).toEqual(['navigation', 'text'])
    await expect(page.locator('[data-margin-mount]')).toBeHidden()
  })

  test('reserves the margin width without holding content', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(CHAPTER)

    const margin = page.locator('[data-margin-mount]')
    const box = await margin.boundingBox()

    expect(box?.width ?? 0).toBeGreaterThan(100)
    expect((await margin.innerHTML()).trim()).toBe('')
  })

  test('does not scroll sideways at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })

    for (const route of [DIRECTORY, BOOK, CHAPTER]) {
      await page.goto(route)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(
        OVERFLOW_EPSILON_CSS_PX,
      )
    }
  })

  test('is the same shell on a page that is not a book', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.goto(DIRECTORY)
    const directory = await visibleColumns(page)
    await page.goto(CHAPTER)

    expect(directory).toEqual(['navigation', 'text', 'margin'])
    expect(await visibleColumns(page)).toEqual(directory)
  })

  test('anchors the chapter to a stable document URI and stable blocks', async ({
    page,
  }) => {
    await page.goto(CHAPTER)

    await expect(page.locator('[data-reading-column="text"]')).toHaveAttribute(
      'data-document-uri',
      `https://ernie.sg${CHAPTER}`,
    )
    const ids = await page.$$eval('.book-content [data-block-kind]', (blocks) =>
      blocks.map((block) => block.id),
    )

    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => id.startsWith('block-ch12-hash-maps-'))).toBe(true)
  })
})
