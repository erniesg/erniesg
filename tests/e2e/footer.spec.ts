import { expect, test } from '@playwright/test'

for (const width of [320, 360, 390, 600, 768, 900, 1024, 1100, 1280, 1440, 1920]) {
  test(`footer icons stay on one row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/about', { waitUntil: 'networkidle' })
    const icons = page.locator('footer ul[role="list"] a')
    await expect(icons).toHaveCount(8)
    const boxes = await icons.evaluateAll((links) =>
      links.map((link) => {
        const { top, left, right, width, height } = link.getBoundingClientRect()
        return { top, left, right, width, height }
      }),
    )
    expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1)
    for (const box of boxes) {
      // Comfortable to tap, and still square when shrunk to fit a small phone.
      expect(box.width).toBeGreaterThanOrEqual(24)
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1)
      expect(box.right).toBeLessThanOrEqual(width)
      expect(box.left).toBeGreaterThanOrEqual(0)
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBe(0)
  })
}
