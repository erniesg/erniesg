import { expect, test, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'

const limits = {
  available: true,
  dailyLimit: 3,
  remaining: 3,
  resetsAt: '2026-10-13T00:00:00Z',
  maxBytes: 10 * 1024 * 1024,
  globalRemaining: 20,
}
const pdf = {
  name: 'paper.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7\nfixture'),
}
async function setup(page: Page, available = true) {
  await installStaticRoutes(page)
  await page.route('**/api/struct-demo/limits', (route) =>
    route.fulfill({ json: { ...limits, available } }),
  )
}

test('unavailable uploads preserve sample browsing and sandbox reflow', async ({
  page,
}) => {
  await setup(page, false)
  await page.goto('/research/struct/demo/')
  await expect(page.getByRole('button', { name: 'Convert PDF' })).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Convert this paper' }),
  ).toBeDisabled()
  await expect(page.getByText(/Uploads are unavailable/)).toBeVisible()
  const sample = page
    .locator('[data-struct-sample]')
    .filter({
      has: page.getByRole('heading', { name: 'AI Must Die', exact: true }),
    })
  await expect(sample).toBeVisible()
  await expect(
    sample.getByRole('link', { name: 'Source PDF' }),
  ).toHaveAttribute('href', /\.pdf$/)
  await expect(sample.locator('iframe')).toHaveAttribute('sandbox', '')
  await expect(
    sample.getByRole('link', { name: /EPUB/ }).first(),
  ).toHaveAttribute('download', '')
})

test('uploads raw PDF once and presents private EPUB download when done', async ({
  page,
}) => {
  await setup(page)
  let submissions = 0
  await page.route('**/api/struct-demo/jobs', async (route) => {
    submissions++
    expect(route.request().headers()['content-type']).toBe('application/pdf')
    expect(route.request().headers()['x-filename']).toBe('paper.pdf')
    expect(route.request().postDataBuffer()?.toString()).toContain('%PDF-1.7')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await route.fulfill({
      status: 202,
      json: { id: 'job-1', status: 'queued' },
    })
  })
  await page.route('**/api/struct-demo/jobs/job-1', (route) =>
    route.fulfill({
      json: {
        id: 'job-1',
        status: 'done',
        files: [
          { name: 'paper.epub' },
          { name: '../secret.epub' },
          { name: 'unsafe.html' },
        ],
      },
    }),
  )
  await page.goto('/research/struct/demo/')
  await page.getByLabel('Choose a PDF').setInputFiles(pdf)
  await page.getByRole('button', { name: 'Convert PDF' }).dblclick()
  await expect(
    page.getByRole('link', { name: 'Download paper.epub' }),
  ).toHaveAttribute('href', '/api/struct-demo/jobs/job-1/files/paper.epub')
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(1)
  expect(submissions).toBe(1)
})

test('quota rejection disables upload and shows reset without raw server error', async ({
  page,
}) => {
  await setup(page)
  await page.route('**/api/struct-demo/jobs', (route) =>
    route.fulfill({
      status: 429,
      json: {
        resetsAt: limits.resetsAt,
        message: 'SECRET internal backend trace',
      },
    }),
  )
  await page.goto('/research/struct/demo/')
  await page.getByLabel('Choose a PDF').setInputFiles(pdf)
  await page.getByRole('button', { name: 'Convert PDF' }).click()
  await expect(page.getByRole('status')).toContainText(/daily limit/i)
  await expect(page.getByRole('status')).toContainText(/UTC/)
  await expect(page.getByRole('button', { name: 'Convert PDF' })).toBeDisabled()
  await expect(page.getByText('SECRET internal backend trace')).toHaveCount(0)
})

test('rejects a disguised PDF before uploading', async ({ page }) => {
  await setup(page)
  let submissions = 0
  await page.route('**/api/struct-demo/jobs', async (route) => {
    submissions++
    await route.fulfill({ status: 400 })
  })
  await page.goto('/research/struct/demo/')
  await page.getByLabel('Choose a PDF').setInputFiles({
    name: 'fake.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('not a pdf'),
  })
  await page.getByRole('button', { name: 'Convert PDF' }).click()
  await expect(page.getByRole('status')).toContainText(/valid PDF/i)
  expect(submissions).toBe(0)
})

test('resumes a saved job and recovers polling without another upload', async ({
  page,
}) => {
  await setup(page)
  await page.addInitScript(() =>
    sessionStorage.setItem('struct-demo-job', 'saved-job'),
  )
  let checks = 0
  await page.route('**/api/struct-demo/jobs/saved-job', async (route) => {
    checks++
    if (checks === 1) await route.abort()
    else
      await route.fulfill({
        json: {
          id: 'saved-job',
          status: 'done',
          files: [{ name: 'resumed.epub' }],
        },
      })
  })
  await page.goto('/research/struct/demo/')
  await expect(page.getByRole('status')).toContainText(/checking paused/i)
  await expect(page.getByRole('button', { name: 'Convert PDF' })).toBeDisabled()
  await page.getByRole('button', { name: 'Retry status check' }).click()
  await expect(
    page.getByRole('link', { name: 'Download resumed.epub' }),
  ).toBeVisible()
})

test('oversize PDFs stay on the client', async ({ page }) => {
  await setup(page)
  let submissions = 0
  await page.route('**/api/struct-demo/jobs', async (route) => {
    submissions++
    await route.fulfill({ status: 400 })
  })
  await page.goto('/research/struct/demo/')
  await page.getByLabel('Choose a PDF').setInputFiles({
    name: 'large.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  })
  await page.getByRole('button', { name: 'Convert PDF' }).click()
  await expect(page.getByRole('status')).toContainText(/no larger than 10 MiB/i)
  expect(submissions).toBe(0)
})

test('real paper sample credits its authors, source, license, and reconstruction caveat', async ({
  page,
}) => {
  await setup(page, false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/research/struct/demo/')
  const sample = page
    .locator('[data-struct-sample]')
    .filter({ has: page.getByRole('heading', { name: /AI Must Die/i }) })
  await expect(sample).toContainText('Myke Walton')
  await expect(sample).toContainText('Cam Smith')
  await expect(
    sample.getByRole('link', { name: 'Original publication' }),
  ).toHaveAttribute('href', /^https:\/\//)
  await expect(
    sample.getByRole('link', { name: /CC BY-NC-SA/i }),
  ).toHaveAttribute('href', /creativecommons.org\/licenses\/by-nc-sa\/4.0/)
  await expect(sample.locator('[data-struct-changes]')).toContainText(
    /reflow|reconstruct/i,
  )
  await expect(sample.locator('[data-struct-verdict]')).toContainText(/review/i)
  await sample.getByText('Read reflowed HTML', { exact: true }).click()
  await expect(sample.locator('iframe')).toBeVisible()
  await expect(
    sample
      .frameLocator('iframe')
      .getByRole('heading', { name: 'AI MUST DIE', exact: true }),
  ).toBeVisible()
  await sample
    .locator('iframe')
    .screenshot({ path: '.agent/evidence/struct-demo-mobile-reflow.png' })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({
    path: '.agent/evidence/struct-demo-mobile.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.evaluate(() => scrollTo(0, 0))
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: '.agent/evidence/struct-demo-desktop.png',
    fullPage: true,
  })
})

test('converts the pinned paper without a client URL and prevents competing uploads', async ({
  page,
}) => {
  await setup(page)
  let starts = 0
  let uploads = 0
  await page.route(
    '**/api/struct-demo/samples/attention-is-all-you-need',
    async (route) => {
      starts++
      expect(route.request().method()).toBe('POST')
      expect(route.request().postData()).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 250))
      await route.fulfill({
        status: 202,
        json: { id: 'attention-job', status: 'queued' },
      })
    },
  )
  await page.route('**/api/struct-demo/jobs', async (route) => {
    uploads++
    await route.fulfill({ status: 500 })
  })
  await page.route('**/api/struct-demo/jobs/attention-job', (route) =>
    route.fulfill({
      json: {
        id: 'attention-job',
        status: 'done',
        files: [{ name: 'attention.epub' }],
      },
    }),
  )
  await page.goto('/research/struct/demo/')
  await page.getByLabel('Choose a PDF').setInputFiles(pdf)
  const convert = page.getByRole('button', { name: 'Convert this paper' })
  await convert.click()
  await expect(convert).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Convert PDF' })).toBeDisabled()
  await page
    .locator('[data-struct-form]')
    .evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expect(
    page.getByRole('link', { name: 'Download attention.epub' }),
  ).toHaveAttribute(
    'href',
    '/api/struct-demo/jobs/attention-job/files/attention.epub',
  )
  expect(starts).toBe(1)
  expect(uploads).toBe(0)
})

test('paper conversion obeys quota while cached samples remain free', async ({
  page,
}) => {
  await setup(page)
  await page.route(
    '**/api/struct-demo/samples/attention-is-all-you-need',
    (route) =>
      route.fulfill({ status: 429, json: { resetsAt: limits.resetsAt } }),
  )
  await page.goto('/research/struct/demo/')
  await page.getByRole('button', { name: 'Convert this paper' }).click()
  await expect(page.getByRole('status')).toContainText(/daily limit/i)
  await expect(
    page.getByRole('button', { name: 'Convert this paper' }),
  ).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Convert PDF' })).toBeDisabled()
  const cached = page.locator('[data-struct-sample]').filter({
    has: page.getByRole('heading', { name: 'AI Must Die', exact: true }),
  })
  await cached.getByText('Read reflowed HTML', { exact: true }).click()
  await expect(cached.locator('iframe')).toBeVisible()
  await expect(
    cached.getByRole('link', { name: 'Paper Pro EPUB', exact: true }),
  ).toHaveAttribute('download', '')
})
