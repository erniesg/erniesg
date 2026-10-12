import { expect, test } from '@playwright/test'
import { installStaticRoutes } from './static-build'

const routes = [
  '/research/',
  '/research/representing-taste/',
  '/research/struct/',
  '/research/struct/demo/',
]

for (const locale of ['', 'zh/', 'ja/', 'ko/']) {
  test(`research shares the site shell and breadcrumb navigation (${locale || 'en'})`, async ({
    page,
  }) => {
    test.skip(
      !process.env.SRT_STATIC_BUILD_DIR,
      'Uses the localized production artifact',
    )
    await installStaticRoutes(page)
    await page.goto(`/about/${locale}`)
    const siteHeader = page.locator('body > div > header')
    const referenceLinks = await siteHeader
      .locator('nav a')
      .evaluateAll((links) =>
        links.map((link) => [
          link.textContent?.trim(),
          link.getAttribute('href'),
        ]),
      )
    const referenceFooter = await page.locator('footer').innerText()
    for (const route of routes) {
      await page.goto(`${route}${locale}`)
      await expect(siteHeader).toBeVisible()
      expect(
        await siteHeader
          .locator('nav a')
          .evaluateAll((links) =>
            links.map((link) => [
              link.textContent?.trim(),
              link.getAttribute('href'),
            ]),
          ),
      ).toEqual(referenceLinks)
      expect(await page.locator('footer').innerText()).toBe(referenceFooter)
      const breadcrumbs = page
        .locator('main nav')
        .filter({ has: page.locator('[aria-current="page"]') })
      await expect(breadcrumbs).toBeVisible()
      await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveCount(1)
      if (route !== '/research/') {
        await expect(
          breadcrumbs.locator(`a[href="/research/${locale}"]`),
        ).toHaveCount(1)
      }
      if (route.endsWith('/demo/')) {
        await expect(
          breadcrumbs.locator(`a[href="/research/struct/${locale}"]`),
        ).toHaveCount(1)
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/research/${locale}`)
    await siteHeader
      .locator('button')
      .filter({ has: page.locator('svg.lucide-menu') })
      .click()
    for (const [label, href] of referenceLinks) {
      await expect(
        page.getByRole('menuitem', { name: label!, exact: true }),
      ).toHaveAttribute('href', href!)
    }
  })
}
