import { expect, test, type Page } from '@playwright/test'

type DOMRectLike = { x: number; y: number; width: number; height: number }

test.use({
  contextOptions: { reducedMotion: 'reduce' },
  viewport: { width: 1000, height: 1100 },
  launchOptions: {
    args: [
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
    ],
  },
})

async function openAtlas(page: Page) {
  await page.goto('/atlas')
  await expect(page.locator('[data-atlas-stage]')).toHaveAttribute(
    'data-state',
    'ready',
    { timeout: 90_000 },
  )
}

test('lists every visited place without needing the globe', async ({
  page,
}) => {
  await page.goto('/atlas')
  await expect(page.locator('[data-atlas-place]')).toHaveCount(26)
  await expect(page.locator('.atlas-count')).toHaveText('25/195')
})

test('selecting from the list fills the card, and clearing resets it', async ({
  page,
}) => {
  await openAtlas(page)
  await page.locator('[data-atlas-place="Italy"]').click()
  await expect(page.locator('[data-atlas-name]')).toHaveText('Italy')
  await expect(page.locator('[data-atlas-places]')).toContainText('Bologna')
  await expect(page.locator('[data-atlas-place="Italy"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.locator('[data-atlas-clear]').click()
  await expect(page.locator('[data-atlas-detail]')).toBeHidden()
  await expect(page.locator('[data-atlas-empty]')).toBeVisible()
})

test('marks Singapore as home and Hong Kong as uncounted', async ({ page }) => {
  await openAtlas(page)
  await page.locator('[data-atlas-place="Singapore"]').click()
  await expect(page.locator('[data-atlas-status="home"]')).toBeVisible()
  await page.locator('[data-atlas-place="Hong Kong"]').click()
  await expect(page.locator('[data-atlas-flag-note="territory"]')).toBeVisible()
})

async function canvasBox(page: Page) {
  await page.waitForTimeout(1500)
  const box = await page.locator('[data-atlas-canvas]').boundingBox()
  if (!box) throw new Error('No canvas box')
  return box
}

test('clicking the globe picks the country under the pointer', async ({
  page,
}) => {
  await openAtlas(page)
  // Home has no route, so Singapore is centred.
  await page.locator('[data-atlas-place="Singapore"]').click()
  const box = await canvasBox(page)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('[data-atlas-name]')).toHaveText('Singapore')
})

test('an unvisited country shows its passport category and flag', async ({
  page,
}) => {
  await openAtlas(page)
  const box = await canvasBox(page)
  // The resting view centres on the Arabian Sea, with Iran and Afghanistan to its north.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.36)
  await expect(page.locator('[data-atlas-detail]')).toBeVisible()
  await expect(page.locator('[data-atlas-status="visited"]')).toBeHidden()
  await expect(page.locator('[data-atlas-flag]')).toHaveAttribute(
    'src',
    /\/flags\/[a-z]+\.svg/,
  )
  await expect(page.locator('[data-atlas-km]')).toContainText('km')
})

test('clicking open ocean returns to the world', async ({ page }) => {
  await openAtlas(page)
  await page.locator('[data-atlas-place="Singapore"]').click()
  const box = await canvasBox(page)
  // South of Singapore lies the Indian Ocean once the camera has closed in.
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.86)
  await expect(page.locator('[data-atlas-detail]')).toBeHidden()
})

test('a selected country shows the distance and both ends of the route', async ({
  page,
}) => {
  await openAtlas(page)
  await page.locator('[data-atlas-place="Japan"]').click()
  await expect(page.locator('[data-atlas-km]')).toHaveText(/^≈ [45],\d{3} km$/)
  await expect(page.locator('[data-atlas-flag]')).toHaveAttribute(
    'src',
    '/flags/jp.svg',
  )
  await expect(page.locator('[data-atlas-pin="home"]')).toBeVisible()
  await expect(page.locator('[data-atlas-pin="home"]')).toContainText(
    'Singapore',
  )
  await expect(page.locator('[data-atlas-pin="selected"]')).toContainText(
    'Japan',
  )
  const box = await canvasBox(page)
  for (const pin of ['home', 'selected']) {
    const placed = await page.locator(`[data-atlas-pin="${pin}"]`).boundingBox()
    if (!placed) throw new Error(`No ${pin} pin`)
    expect(placed.x).toBeGreaterThan(box.x)
    expect(placed.x + placed.width).toBeLessThan(box.x + box.width)
    expect(placed.y).toBeGreaterThan(box.y)
    expect(placed.y + placed.height).toBeLessThan(box.y + box.height)
  }
})

test('shows the distance on the flight line, clear of both route labels', async ({
  page,
}) => {
  await openAtlas(page)
  const overlaps = (a: DOMRectLike, b: DOMRectLike) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  for (const place of [
    'Malaysia',
    'Thailand',
    'Indonesia',
    'Japan',
    'Australia',
    'United Kingdom',
    'Iceland',
  ]) {
    await page.locator(`[data-atlas-place="${place}"]`).click()
    await page.waitForTimeout(1200)
    const line = page.locator('[data-atlas-line-km]')
    await expect(line, place).toBeVisible()
    await expect(line, place).toHaveText(
      await page.locator('[data-atlas-km]').innerText(),
    )
    const label = await line.boundingBox()
    for (const pin of ['home', 'selected']) {
      const placed = await page
        .locator(`[data-atlas-pin="${pin}"]`)
        .boundingBox()
      if (!label || !placed) throw new Error(`Missing ${pin} for ${place}`)
      expect(
        overlaps(label, placed),
        `${place} distance over ${pin} label`,
      ).toBe(false)
    }
  }
})

test('only the route labels show while hovering other countries', async ({
  page,
}) => {
  await openAtlas(page)
  const box = await canvasBox(page)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.36)
  await expect(page.locator('[data-atlas-tip]')).toBeVisible()
  await page.locator('[data-atlas-place="Japan"]').click()
  const after = await canvasBox(page)
  await page.mouse.move(
    after.x + after.width * 0.3,
    after.y + after.height * 0.35,
    { steps: 4 },
  )
  await page.waitForTimeout(400)
  await expect(page.locator('[data-atlas-tip]')).toBeHidden()
  await expect(page.locator('[data-atlas-pin="selected"]')).toContainText(
    'Japan',
  )
})

test('home shows no distance or route pin', async ({ page }) => {
  await openAtlas(page)
  await page.locator('[data-atlas-place="Singapore"]').click()
  await expect(page.locator('[data-atlas-route]')).toBeHidden()
  await expect(page.locator('[data-atlas-pin="home"]')).toBeHidden()
  await expect(page.locator('[data-atlas-line-km]')).toBeHidden()
})

test('every visited place in the list has a loading flag', async ({ page }) => {
  await page.goto('/atlas')
  const broken = await page
    .locator('[data-atlas-place] img')
    .evaluateAll(async (images) => {
      const all = images as HTMLImageElement[]
      all.forEach((image) => (image.loading = 'eager'))
      await Promise.all(
        all.map((image) => image.decode().catch(() => undefined)),
      )
      return all
        .filter((image) => image.naturalWidth === 0)
        .map((image) => image.src)
    })
  expect(broken).toEqual([])
})

test('dragging spins the globe rather than selecting', async ({ page }) => {
  await openAtlas(page)
  const canvas = page.locator('[data-atlas-canvas]')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('No canvas box')
  const before = await canvas.screenshot()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, {
    steps: 6,
  })
  await page.mouse.up()
  await page.waitForTimeout(600)
  await expect(page.locator('[data-atlas-detail]')).toBeHidden()
  expect(Buffer.compare(before, await canvas.screenshot())).not.toBe(0)
})

test('restarts cleanly after client-side navigation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openAtlas(page)
  await page.locator('header a[data-header-link="/about"]').click()
  await expect(page).toHaveURL(/\/about/)
  await page.locator('header a[data-header-link="/atlas"]').click()
  await expect(page).toHaveURL(/\/atlas/)
  await expect(page.locator('[data-atlas-stage]')).toHaveAttribute(
    'data-state',
    'ready',
    { timeout: 90_000 },
  )
  await page.locator('[data-atlas-place="Japan"]').click()
  await expect(page.locator('[data-atlas-name]')).toHaveText('Japan')
  expect(errors).toEqual([])
})

test('the About page keeps the atlas inside the personal card', async ({
  page,
}) => {
  await page.goto('/about')
  const insideCard = page.locator(
    'div.rounded-xl:has(h3[data-i18n-key="author.erniesg.name"]) [data-atlas-teaser]',
  )
  await expect(insideCard).toHaveCount(1)
})

test('the About page teases the atlas and links through', async ({ page }) => {
  await page.goto('/about')
  const teaser = page.locator('[data-atlas-teaser]')
  await expect(teaser).toContainText('25/195')
  await expect(teaser.locator('img')).toHaveCount(25)
  await teaser.scrollIntoViewIfNeeded()
  await teaser.click({ position: { x: 40, y: 40 } })
  await expect(page).toHaveURL(/\/atlas/)
})
