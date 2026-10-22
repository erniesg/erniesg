import { expect, test } from '@playwright/test'
import { installStaticRoutes } from './static-build'

test.skip(
  !process.env.SRT_STATIC_BUILD_DIR,
  'Checks the gated production artifact',
)

test('production has Blog, Research, About, and Tags navigation and preserves the live author article', async ({
  page,
}) => {
  await installStaticRoutes(page)
  await page.goto('/research/')
  await expect(
    page.getByRole('heading', { name: 'Research', exact: true }),
  ).toBeVisible()
  const links = page.locator('header nav:visible a')
  await expect(links).toHaveCount(4)
  await expect(links.nth(0)).toHaveAttribute('href', '/blog')
  await expect(links.nth(1)).toHaveAttribute('href', '/research')
  await expect(links.nth(2)).toHaveAttribute('href', '/about')
  await expect(links.nth(3)).toHaveAttribute('href', '/tags')
  await expect(links).toHaveText(['Blog', 'Research', 'About', 'Tags'])
  await expect(
    page.getByRole('link', {
      name: 'Struct: Document Reconstruction and Responsive Typesetting',
    }),
  ).toBeVisible()
  await page.goto('/blog/loss-price-love/zh/')
  await expect(
    page.getByRole('heading', { name: '失去是挚爱付出的代价', exact: true }),
  ).toBeVisible()
  for (const path of ['/books/', '/library/', '/projects/']) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(404)
  }
})

test('the actual AI sample renders its packaged figures and stylesheet inside the sandbox', async ({
  page,
}) => {
  await installStaticRoutes(page)
  await page.route('**/api/struct-demo/limits', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }),
  )
  await page.goto('/research/struct/demo/')
  const sample = page.locator('[data-struct-sample]').filter({
    has: page.getByRole('heading', {
      name: 'Docling Technical Report',
      exact: true,
    }),
  })
  await sample.locator('summary').click()
  const frame = sample.frameLocator('iframe')
  await expect(frame.locator('h1')).toContainText('Docling')
  await expect
    .poll(async () =>
      frame
        .locator('img')
        .evaluateAll(
          (images) =>
            images.filter(
              (image) => (image as HTMLImageElement).naturalWidth > 0,
            ).length,
        ),
    )
    .toBeGreaterThan(0)
  await expect
    .poll(async () =>
      frame
        .locator('body')
        .evaluate((body) => getComputedStyle(body).fontFamily),
    )
    .not.toBe('"Times New Roman"')
  await page.screenshot({
    path: '.agent/evidence/struct-demo-production.png',
    fullPage: true,
  })
})
