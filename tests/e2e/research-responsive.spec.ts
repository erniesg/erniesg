import { expect, test } from '@playwright/test'

const widths = [360, 390, 768, 1024, 1440]

for (const width of widths) {
  test(`research shell follows the site measure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/research')

    const shell = page.locator('.research-shell')
    await expect(shell).toBeVisible()
    const box = await shell.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(Math.min(width, 768) + 1)
    expect(Math.abs(box!.x - (width - box!.width) / 2)).toBeLessThanOrEqual(1)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)

    await expect(page.getByRole('heading', { name: 'Papers' })).toBeVisible()
    await expect(page.getByText(/Papers, prototypes/)).toHaveCount(0)
    await expect(page.getByText(/published ·|working ·/i)).toHaveCount(0)
  })
}

test('fellowship paper inherits the site shell and has no browser prototype', async ({
  page,
}) => {
  await page.goto('/research/if-letters-home-could-sing')

  await expect(page.locator('.research-shell')).toBeVisible()
  await expect(page.locator('.heart-prototype')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /prototype/i })).toHaveCount(0)
  await expect(page.locator('.letters-system-diagram svg')).toBeVisible()
  await expect(page.locator('.letters-system-diagram svg rect')).toHaveCount(20)
  await expect(page.locator('.letters-system-diagram pre')).toHaveCount(0)

  const colors = await page
    .locator('.letters-publication')
    .evaluate((paper) => ({
      paper: getComputedStyle(paper).backgroundColor,
      site: getComputedStyle(document.documentElement).backgroundColor,
    }))
  expect(colors.paper).toBe(colors.site)
})
