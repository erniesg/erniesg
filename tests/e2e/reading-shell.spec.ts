import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { installStaticRoutes } from './static-build'

/**
 * The three-column reading shell, in a browser.
 *
 * The margin column reserved its width before it held anything, so that
 * mounting the annotation layer into it moved the text by nothing.
 */

// A no-op unless `SRT_STATIC_BUILD_DIR` is set, in which case these run
// against the built site rather than a dev server.
test.beforeEach(async ({ page }) => {
  await installStaticRoutes(page)
})

const BOOK = '/books/build-a-coding-agent/'
const CHAPTER = '/books/build-a-coding-agent/ch12-hash-maps/'
const DIRECTORY = '/books/'
const LIBRARY = '/library/'
const PAPER = '/papers/semantic-responsive-typesetting/'
const POST = '/blog/a-i-art-and-anti-discrimination'
const OVERFLOW_EPSILON_CSS_PX = 1

/**
 * The production release gate withholds `/papers` from the build it deploys,
 * so a static run against that build has no paper to open. Every other run
 * has one.
 */
const PAPERS_WITHHELD = Boolean(
  process.env.SRT_STATIC_BUILD_DIR &&
    !existsSync(path.resolve(process.env.SRT_STATIC_BUILD_DIR, 'papers')),
)

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

  test('holds the annotation layer in the width it reserved', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(CHAPTER)

    const margin = page.locator('[data-margin-mount]')
    const box = await margin.boundingBox()

    expect(box?.width ?? 0).toBeGreaterThan(100)
    // The column was reserved for exactly this. Its only child is the margin
    // element, which draws inside a shadow root, so the shell's own markup is
    // as bare as it was when the column was empty.
    await expect(margin.locator('margin-rail')).toHaveCount(1)
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

  test('opens a post on its title on a phone, with the contents folded', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(POST)

    const contents = page.locator('#reading-navigation details.reading-contents')
    await expect(contents).not.toHaveAttribute('open', '')
    await expect(page.locator('h1').first()).toBeInViewport()

    // Widening turns the folded disclosure back into the rail. A post's
    // margin stays collapsed, so there is no margin column.
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(contents).toHaveAttribute('open', '')
    expect(await visibleColumns(page)).toEqual(['navigation', 'text'])

    // And narrowing again folds it, so the text still leads.
    await page.setViewportSize({ width: 390, height: 800 })
    await expect(contents).not.toHaveAttribute('open', '')
  })

  test('prints the text alone, without the shell chrome', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(POST)
    await page.emulateMedia({ media: 'print' })

    await expect(page.locator('#reading-navigation')).toBeHidden()
    expect(
      await page
        .locator('[data-reading-shell]')
        .evaluate((shell) => getComputedStyle(shell).display),
    ).toBe('block')
  })

  test('starts a post with the margin collapsed at 1440, and a chapter with the column', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(POST)

    const toggle = page.locator('margin-rail [data-margin-action="toggle-rail"]')
    const panel = page.locator('margin-rail .panel')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeHidden()
    // The text takes the freed width: no column is reserved for the margin.
    const margin = await page
      .locator('[data-reading-column="margin"]')
      .boundingBox()
    expect(margin?.width ?? 0).toBe(0)
    const text = await page.locator('[data-reading-column="text"]').boundingBox()
    expect(text!.width).toBeGreaterThan(700)
    expect(text!.width).toBeLessThanOrEqual(768)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    // Selecting prose still offers the popup while the rail is collapsed.
    const block = page.locator('[data-post-content] p[id]').first()
    const id = await block.getAttribute('id')
    await page.evaluate((blockId) => {
      const node = document.getElementById(blockId)!.firstChild!
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(24, node.textContent!.length))
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    }, id!)
    await block.dispatchEvent('pointerup')
    await expect(page.locator('margin-rail [data-margin-popup]')).toBeVisible()

    // A book page keeps the full margin column.
    await page.goto(CHAPTER)
    expect(await visibleColumns(page)).toEqual(['navigation', 'text', 'margin'])
    await expect(
      page.locator('margin-rail [data-margin-action="toggle-rail"]'),
    ).toHaveCount(0)
  })

  test('keeps a chapter contents list open on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(CHAPTER)

    await expect(
      page.locator('#reading-navigation details.reading-contents'),
    ).toHaveAttribute('open', '')
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

async function textBlockIds(page: Page): Promise<string[]> {
  return page.$$eval(
    '[data-reading-column="text"] [data-block-kind]',
    (blocks) => blocks.map((block) => block.id),
  )
}

test.describe('the four reading surfaces of ADR 010', () => {
  const SURFACES = [
    ['the library', LIBRARY],
    ['a book', BOOK],
    ['a paper', PAPER],
    ['a blog entry', POST],
  ] as const

  for (const [name, route] of SURFACES) {
    test(`renders ${name} through the shell, with a margin mount`, async ({
      page,
    }) => {
      test.skip(
        route === PAPER && PAPERS_WITHHELD,
        'The production release gate withholds /papers from this build.',
      )
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(route)

      await expect(page.locator('[data-reading-shell]')).toHaveCount(1)
      // A post starts with its margin collapsed to a toggle (the owner's call
      // on #390); every other surface reserves the column.
      expect(await visibleColumns(page)).toEqual(
        route === POST ? ['navigation', 'text'] : ['navigation', 'text', 'margin'],
      )
      await expect(
        page.locator('[data-margin-mount] margin-rail'),
      ).toHaveCount(1)
      await expect(
        page.locator('[data-reading-column="text"]'),
      ).toHaveAttribute('data-document-uri', /^https:\/\/ernie\.sg\//u)
    })
  }

  test('gives a blog entry stable, unique block ids', async ({ page }) => {
    await page.goto(POST)
    const ids = await textBlockIds(page)

    expect(ids.length).toBeGreaterThan(3)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(ids.some((id) => /^block-p-[0-9a-f]{12}$/u.test(id))).toBe(true)

    await page.reload()
    expect(await textBlockIds(page)).toEqual(ids)
  })

  test('gives a paper its authored node ids as block ids', async ({ page }) => {
    test.skip(
      PAPERS_WITHHELD,
      'The production release gate withholds /papers from this build.',
    )
    await page.goto(PAPER)
    const ids = await textBlockIds(page)

    expect(ids).toContain('p-proposition-1')
    expect(new Set(ids).size).toBe(ids.length)

    await page.reload()
    expect(await textBlockIds(page)).toEqual(ids)
  })

  test('does not scroll a blog entry sideways at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(POST)

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(
      OVERFLOW_EPSILON_CSS_PX,
    )
  })
})
