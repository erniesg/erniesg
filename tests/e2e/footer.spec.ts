import { expect, test } from '@playwright/test'

for (const width of [
  320, 360, 390, 600, 640, 768, 900, 1024, 1100, 1280, 1440, 1920,
]) {
  test(`footer icons stay on one scrollable line at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/about', { waitUntil: 'networkidle' })
    const list = page.locator('footer ul[role="list"]')
    const icons = list.locator('a')
    await expect(icons).toHaveCount(8)
    const boxes = await icons.evaluateAll((links) =>
      links.map((link) => {
        const { top, width, height } = link.getBoundingClientRect()
        return { top, width, height }
      }),
    )
    expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1)
    for (const box of boxes) {
      expect(Math.round(box.width)).toBe(36)
      expect(Math.round(box.height)).toBe(36)
    }

    // The last icon can always be brought fully into view.
    await list.evaluate((element) =>
      element.scrollTo({ left: element.scrollWidth }),
    )
    const last = await icons.last().boundingBox()
    const bounds = await list.boundingBox()
    if (!last || !bounds) throw new Error('Missing footer icons')
    expect(last.x + last.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBe(0)
  })
}

test('the footer lines up with the page column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/about', { waitUntil: 'networkidle' })
  const edges = async (selector: string) => {
    const box = await page.locator(selector).boundingBox()
    if (!box) throw new Error(`Missing ${selector}`)
    return { left: box.x, right: box.x + box.width }
  }
  const header = await edges('header > div')
  const footer = await edges('footer > div')
  expect(footer).toEqual(header)
})
