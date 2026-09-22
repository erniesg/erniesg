import { expect, test } from '@playwright/test'

/**
 * The shell the book is read in: three columns when there is room, two when
 * there is not, and a margin that cannot move the text when 056-060 fill it.
 */

const NODE = '/challenges/ch12-hash-maps/'

const trackCount = async (selector: string, page: import('@playwright/test').Page) =>
  page.$eval(
    selector,
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  )

test('three columns above 1280px, two below, and no sideways scroll on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto(NODE)

  await expect(page.locator('.book-shell')).toBeVisible()
  expect(await trackCount('.book-shell', page)).toBe(3)
  await expect(page.locator('[data-margin-mount]')).toBeVisible()

  await page.setViewportSize({ width: 1100, height: 900 })
  await expect(page.locator('[data-margin-mount]')).toBeHidden()
  expect(await trackCount('.book-shell', page)).toBe(2)

  await page.setViewportSize({ width: 375, height: 800 })
  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    return root.scrollWidth - root.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(1)
})

test('the margin is an empty landmark with a stable mount point', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto(NODE)

  const margin = page.locator('#book-margin')
  await expect(margin).toHaveAttribute('aria-label', 'Margin')
  await expect(margin.locator('[data-margin-notes]')).toHaveCount(1)
  expect(await margin.locator('[data-margin-notes]').innerHTML()).toBe('')

  const before = await page.locator('.book-text').boundingBox()
  await page.evaluate(() => {
    const mount = document.querySelector('[data-margin-notes]')
    if (!mount) throw new Error('no margin mount point')
    mount.innerHTML =
      '<p>a note long enough to wrap in the margin, twice over, so a width ' +
      'that depended on its content would show up here</p>'.repeat(4)
  })
  const after = await page.locator('.book-text').boundingBox()
  expect(after?.x).toBe(before?.x)
  expect(after?.width).toBe(before?.width)
})

test('the page carries a stable document URI and per-block anchors', async ({
  page,
}) => {
  await page.goto(NODE)

  const article = page.locator('.book-text')
  await expect(article).toHaveAttribute(
    'data-document-uri',
    /\/challenges\/ch12-hash-maps\/$/,
  )
  await expect(article).toHaveAttribute('data-node-id', 'ch12-hash-maps')

  const ids = await page.$$eval('[data-block-id]', (elements) =>
    elements.map((element) => element.getAttribute('data-block-id')),
  )
  expect(ids.length).toBeGreaterThan(0)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(id?.startsWith('ch12-hash-maps--')).toBe(true)
})
