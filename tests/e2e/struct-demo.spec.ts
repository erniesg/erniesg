import { expect, test, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

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
  // Match the static host's sample assets. Astro dev rejects their opaque
  // sandbox origin, while published CSS/images are ordinary public files.
  if (!process.env.SRT_STATIC_BUILD_DIR) {
    const publicRoot = resolve('public')
    await page.route('**/research/struct/samples/**', async (route) => {
      const file = resolve(
        publicRoot,
        decodeURIComponent(new URL(route.request().url()).pathname).replace(
          /^\/+/,
          '',
        ),
      )
      if (!file.startsWith(`${publicRoot}${sep}`)) {
        await route.abort()
        return
      }
      try {
        const body = await readFile(file)
        const contentType =
          (
            {
              '.html': 'text/html',
              '.css': 'text/css',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.svg': 'image/svg+xml',
              '.epub': 'application/epub+zip',
            } as Record<string, string>
          )[extname(file)] ?? 'application/octet-stream'
        await route.fulfill({ body, contentType })
      } catch {
        await route.fulfill({ status: 404 })
      }
    })
  }
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
  await expect(page.getByText(/Uploads are unavailable/)).toBeVisible()
  await page.getByLabel('Existing paper').selectOption('ai-must-die')
  const sample = page.locator('[data-struct-sample]').filter({
    has: page.getByRole('heading', { name: 'AI Must Die', exact: true }),
  })
  await expect(sample).toBeVisible()
  await expect(sample.getByRole('link', { name: 'Source PDF' })).toHaveCount(0)
  await expect(page.locator('[data-struct-preview-frame]')).toHaveAttribute(
    'sandbox',
    '',
  )
  await expect(
    sample.getByRole('link', { name: 'Download EPUB', exact: true }),
  ).toHaveAttribute('download', 'ai-must-die.epub')
  await expect(sample.getByRole('link', { name: /EPUB/ })).toHaveCount(1)
  await expect(sample).not.toContainText('Free sample')
  await page
    .getByLabel('Existing paper')
    .selectOption('attention-is-all-you-need')
  await expect(
    page.getByRole('button', { name: 'Convert this paper' }),
  ).toBeDisabled()
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
        error: { code: 'daily_limit' },
        message: 'SECRET internal backend trace',
      },
    }),
  )
  await page.goto('/research/struct/demo/')
  await page.getByLabel('Choose a PDF').setInputFiles(pdf)
  await page.getByRole('button', { name: 'Convert PDF' }).click()
  await expect(page.locator('[data-struct-status]')).toContainText(
    /daily limit/i,
  )
  await expect(page.locator('[data-struct-status]')).toContainText(/UTC/)
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
  await expect(page.locator('[data-struct-status]')).toContainText(/valid PDF/i)
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
  await expect(page.locator('[data-struct-status]')).toContainText(
    /checking paused/i,
  )
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
  await expect(page.locator('[data-struct-status]')).toContainText(
    /no larger than 10 MiB/i,
  )
  expect(submissions).toBe(0)
})

test('real paper sample credits its authors, source, license, and reconstruction caveat', async ({
  page,
}) => {
  await setup(page, false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/research/struct/demo/')
  await page.getByLabel('Existing paper').selectOption('ai-must-die')
  const sample = page
    .locator('[data-struct-sample]')
    .filter({ has: page.getByRole('heading', { name: /AI Must Die/i }) })
  await sample.getByText('Credits', { exact: true }).click()
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
  await expect(page.locator('[data-struct-preview-frame]')).toBeVisible()
  await expect(
    page
      .frameLocator('[data-struct-preview-frame]')
      .getByRole('heading', { name: 'AI MUST DIE', exact: true }),
  ).toBeVisible()
  await page
    .locator('[data-struct-preview-frame]')
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

test('compares each sample original beside its reconstruction on desktop and stacks on mobile', async ({
  page,
}) => {
  await setup(page, false)
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto('/research/struct/demo/')

  const standardContent = page.locator('[data-struct-standard-content]')
  const comparison = page.locator('[data-struct-comparison]')
  const sampleSelect = page.getByLabel('Existing paper')
  const controls = page.locator('[data-struct-preview-controls]')
  const original = comparison.getByRole('heading', {
    name: 'Original',
    exact: true,
  })
  const reconstruction = comparison.getByRole('heading', {
    name: 'Reconstruction',
    exact: true,
  })
  await expect(original).toBeVisible()
  await expect(reconstruction).toBeVisible()
  await expect(standardContent).toBeVisible()
  await expect(sampleSelect).toBeVisible()
  await expect(controls).toBeVisible()
  const uploadDetails = page.locator('details').filter({
    has: page.getByText('Upload details', { exact: true }),
  })
  await expect(uploadDetails).not.toHaveAttribute('open', '')
  await uploadDetails.getByText('Upload details', { exact: true }).click()
  await expect(uploadDetails).toHaveAttribute('open', '')
  await expect(uploadDetails).toContainText('Server conversion: 10 MiB')
  await expect(uploadDetails).toContainText('3 attempts/network/day')
  await expect(uploadDetails).toContainText(
    '20 total/day (UTC), including failures',
  )
  await expect(uploadDetails).toContainText('completed files expire after 72h')
  await expect(uploadDetails).toContainText(
    'pending jobs remain until complete',
  )
  await uploadDetails.getByText('Upload details', { exact: true }).click()
  await expect(uploadDetails).not.toHaveAttribute('open', '')
  await expect(page.locator('[data-struct-original-frame]')).toHaveAttribute(
    'src',
    '/research/struct/samples/docling-technical-report/source.pdf',
  )
  const originalCanvas = page.locator('[data-struct-original-frame] canvas')
  await expect(originalCanvas).toBeVisible()
  await expect
    .poll(() =>
      originalCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(0)
  await expect(page.getByLabel(/^Original PDF page 1 of/)).toBeVisible()

  const desktopLayout = await page.evaluate(() => {
    const standard = document.querySelector<HTMLElement>(
      '[data-struct-standard-content]',
    )!
    const comparison = document.querySelector<HTMLElement>(
      '[data-struct-comparison]',
    )!
    const sample = document.querySelector<HTMLElement>(
      '[data-struct-sample-select]',
    )!
    const controls = document.querySelector<HTMLElement>(
      '[data-struct-preview-controls]',
    )!
    const title = document.querySelector('h1')!
    const upload = document.querySelector<HTMLElement>('[data-struct-form]')!
    const breadcrumb = document.querySelector('nav')!
    const bounds = (element: Element) => {
      const { left, right, width } = element.getBoundingClientRect()
      return { left, right, width }
    }
    return {
      standard: bounds(standard),
      comparison: bounds(comparison),
      sample: bounds(sample),
      controls: bounds(controls),
      title: bounds(title),
      upload: bounds(upload),
      breadcrumb: bounds(breadcrumb),
      controlsWrap: getComputedStyle(controls).flexWrap,
    }
  })
  expect(desktopLayout.standard.width).toBeLessThanOrEqual(768)
  expect(desktopLayout.comparison.width).toBeGreaterThan(
    desktopLayout.standard.width,
  )
  expect(desktopLayout.sample.width).toBeLessThanOrEqual(320)
  expect(desktopLayout.controlsWrap).toBe('wrap')
  for (const content of [
    desktopLayout.breadcrumb,
    desktopLayout.title,
    desktopLayout.upload,
    desktopLayout.sample,
    desktopLayout.controls,
  ]) {
    expect(content.left).toBeGreaterThanOrEqual(desktopLayout.standard.left)
    expect(content.right).toBeLessThanOrEqual(desktopLayout.standard.right)
  }

  const desktopPanels = await comparison
    .locator(':scope > section')
    .evaluateAll((panels) =>
      panels.map((panel) => {
        const { left, top } = panel.getBoundingClientRect()
        return { left, top }
      }),
    )
  expect(desktopPanels).toHaveLength(2)
  expect(desktopPanels[0].left).toBeLessThan(desktopPanels[1].left)
  expect(desktopPanels[0].top).toBe(desktopPanels[1].top)

  await page.getByLabel('Existing paper').selectOption('ai-must-die')
  const selectedSample = page.locator('[data-struct-sample]').filter({
    has: page.getByRole('heading', { name: 'AI Must Die', exact: true }),
  })
  const selectedPdf = await selectedSample.getAttribute('data-sample-pdf')
  expect(selectedPdf).toBeTruthy()
  await expect(page.locator('[data-struct-original-frame]')).toHaveAttribute(
    'src',
    new RegExp(`${selectedPdf}$`),
  )
  await expect(page.locator('[data-struct-original-link]')).toHaveAttribute(
    'href',
    new RegExp(`${selectedPdf}$`),
  )

  await page.setViewportSize({ width: 390, height: 844 })
  const mobilePanels = await comparison
    .locator(':scope > section')
    .evaluateAll((panels) =>
      panels.map((panel) => {
        const { left, top } = panel.getBoundingClientRect()
        return { left, top }
      }),
    )
  expect(mobilePanels[0].left).toBe(mobilePanels[1].left)
  expect(mobilePanels[0].top).toBeLessThan(mobilePanels[1].top)
  const mobileLayout = await page.evaluate(() => {
    const standard = document.querySelector<HTMLElement>(
      '[data-struct-standard-content]',
    )!
    const comparison = document.querySelector<HTMLElement>(
      '[data-struct-comparison]',
    )!
    const sample = document.querySelector<HTMLElement>(
      '[data-struct-sample-select]',
    )!
    const bounds = (element: Element) => {
      const { left, right, width } = element.getBoundingClientRect()
      return { left, right, width }
    }
    return {
      standard: bounds(standard),
      comparison: bounds(comparison),
      sample: bounds(sample),
      scrolls: document.documentElement.scrollWidth <= innerWidth,
    }
  })
  expect(mobileLayout.scrolls).toBe(true)
  expect(mobileLayout.comparison.left).toBe(mobileLayout.standard.left)
  expect(mobileLayout.comparison.right).toBe(mobileLayout.standard.right)
  expect(mobileLayout.sample.width).toBe(mobileLayout.standard.width)
})

test('clears the original PDF when an upload preview has no source file', async ({
  page,
}) => {
  await setup(page)
  await page.goto('/research/struct/demo/')
  await expect(page.locator('[data-struct-original-frame]')).toHaveAttribute(
    'src',
    /source\.pdf$/,
  )

  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-start', {
        detail: { requestId: 'upload-without-source' },
      }),
    ),
  )
  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-ready', {
        detail: {
          requestId: 'upload-without-source',
          html: '<h1>Uploaded reconstruction</h1>',
          title: 'upload.pdf',
        },
      }),
    ),
  )

  await expect(page.getByLabel('Existing paper')).toHaveValue('__upload__')
  await expect(page.locator('[data-struct-original-frame]')).toBeHidden()
  await expect(
    page.locator('[data-struct-original-frame]'),
  ).not.toHaveAttribute('src')
  await expect(page.locator('[data-struct-original-link]')).toBeHidden()
  await expect(page.locator('[data-struct-original-link]')).not.toHaveAttribute(
    'href',
  )
  await expect(page.locator('[data-struct-original-empty]')).toBeVisible()
  await expect(
    page
      .frameLocator('[data-struct-preview-frame]')
      .getByRole('heading', { name: 'Uploaded reconstruction' }),
  ).toBeVisible()
})

test('resumed paper conversion restores its original sample PDF', async ({
  page,
}) => {
  await setup(page)
  await page.addInitScript(() => {
    sessionStorage.setItem('struct-demo-job', 'saved-job')
    sessionStorage.setItem(
      'struct-demo-source-sample',
      JSON.stringify({
        jobId: 'saved-job',
        sampleId: 'attention-is-all-you-need',
      }),
    )
  })
  await page.route('**/api/struct-demo/jobs/saved-job', (route) =>
    route.fulfill({
      json: {
        id: 'saved-job',
        status: 'done',
        files: [{ name: 'attention.epub' }],
      },
    }),
  )
  await page.route(
    '**/api/struct-demo/jobs/saved-job/files/attention.epub',
    (route) => route.fulfill({ status: 404 }),
  )
  await page.goto('/research/struct/demo/')

  await expect(page.locator('[data-struct-original-frame]')).toHaveAttribute(
    'src',
    'https://arxiv.org/pdf/1706.03762v7',
  )
  await expect(page.locator('[data-struct-original-link]')).toHaveAttribute(
    'href',
    'https://arxiv.org/pdf/1706.03762v7',
  )
  await expect(
    page.getByRole('link', { name: 'Download attention.epub' }),
  ).toBeVisible()
})

test('keeps an upload source PDF through duplicate starts and replaces it with the selected sample source', async ({
  page,
}) => {
  const sourcePdf = (
    await readFile('tests/fixtures/pdf/born-digital.pdf')
  ).toString('base64')
  await setup(page)
  await page.goto('/research/struct/demo/')

  await page.evaluate((bytes) => {
    const binary = atob(bytes)
    const sourceFile = new File(
      [Uint8Array.from(binary, (character) => character.charCodeAt(0))],
      'source.pdf',
      { type: 'application/pdf' },
    )
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-start', {
        detail: { requestId: 'upload-with-source', sourceFile },
      }),
    )
  }, sourcePdf)
  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-ready', {
        detail: {
          requestId: 'upload-with-source',
          html: '<h1>Upload reconstruction</h1>',
          title: 'source.pdf',
        },
      }),
    ),
  )

  const original = page.locator('[data-struct-original-frame]')
  await expect(original).toHaveAttribute('src', /^blob:/)
  const blobSource = await original.getAttribute('src')
  await expect(
    page
      .frameLocator('[data-struct-preview-frame]')
      .getByRole('heading', { name: 'Upload reconstruction' }),
  ).toBeVisible()

  await page.evaluate((bytes) => {
    const binary = atob(bytes)
    const sourceFile = new File(
      [Uint8Array.from(binary, (character) => character.charCodeAt(0))],
      'source.pdf',
      { type: 'application/pdf' },
    )
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-start', {
        detail: { requestId: 'upload-with-source', sourceFile },
      }),
    )
  }, sourcePdf)
  await expect(original).toHaveAttribute('src', blobSource!)

  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-start', {
        detail: {
          requestId: 'sample-source',
          sourceSampleId: 'ai-must-die',
        },
      }),
    ),
  )
  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-ready', {
        detail: {
          requestId: 'sample-source',
          html: '<h1>Sample reconstruction</h1>',
          title: 'AI Must Die.pdf',
        },
      }),
    ),
  )
  await expect(original).toHaveAttribute(
    'src',
    /\/research\/struct\/samples\/ai-must-die\/source\.pdf$/,
  )
  await expect(page.locator('[data-struct-original-link]')).toHaveAttribute(
    'href',
    /\/research\/struct\/samples\/ai-must-die\/source\.pdf$/,
  )
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
  await page
    .getByLabel('Existing paper')
    .selectOption('attention-is-all-you-need')
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
      route.fulfill({
        status: 429,
        json: { resetsAt: limits.resetsAt, error: { code: 'daily_limit' } },
      }),
  )
  await page.goto('/research/struct/demo/')
  await page
    .getByLabel('Existing paper')
    .selectOption('attention-is-all-you-need')
  await page.getByRole('button', { name: 'Convert this paper' }).click()
  await expect(page.locator('[data-struct-status]')).toContainText(
    /daily limit/i,
  )
  await expect(
    page.getByRole('button', { name: 'Convert this paper' }),
  ).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Convert PDF' })).toBeDisabled()
  const cached = page.locator('[data-struct-sample]').filter({
    has: page.getByRole('heading', { name: 'AI Must Die', exact: true }),
  })
  await page.getByLabel('Existing paper').selectOption('ai-must-die')
  await expect(page.locator('[data-struct-preview-frame]')).toBeVisible()
  await expect(
    cached.getByRole('link', { name: 'Download EPUB', exact: true }),
  ).toHaveAttribute('download', 'ai-must-die.epub')
})

for (const mode of ['upload', 'paper'] as const) {
  test(`${mode} capacity rejection offers retry without claiming the daily allowance is exhausted`, async ({
    page,
  }) => {
    await setup(page)
    const endpoint =
      mode === 'upload'
        ? '**/api/struct-demo/jobs'
        : '**/api/struct-demo/samples/attention-is-all-you-need'
    await page.route(endpoint, (route) =>
      route.fulfill({
        status: 429,
        json: { error: { code: 'busy', message: 'PRIVATE provider trace' } },
      }),
    )
    await page.goto('/research/struct/demo/')
    await page
      .getByLabel('Existing paper')
      .selectOption('attention-is-all-you-need')
    if (mode === 'upload') {
      await page.getByLabel('Choose a PDF').setInputFiles(pdf)
      await page.getByRole('button', { name: 'Convert PDF' }).click()
    } else {
      await page
        .getByLabel('Existing paper')
        .selectOption('attention-is-all-you-need')
      await page.getByRole('button', { name: 'Convert this paper' }).click()
    }
    await expect(page.locator('[data-struct-status]')).toContainText(
      /converter is busy/i,
    )
    await expect(page.locator('[data-struct-status]')).not.toContainText(
      /daily limit|UTC/i,
    )
    await expect(page.locator('[data-struct-status]')).not.toContainText(
      'PRIVATE provider trace',
    )
    await expect(
      page.getByRole('button', { name: 'Convert PDF' }),
    ).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Convert this paper' }),
    ).toBeDisabled()
    await page
      .getByRole('button', { name: 'Check upload availability' })
      .click()
    await expect(
      page.getByRole('button', { name: 'Convert PDF' }),
    ).toBeEnabled()
    await expect(
      page.getByRole('button', { name: 'Convert this paper' }),
    ).toBeEnabled()
  })
}

for (const [locale, ready, download, quotaText, invalid] of [
  ['zh', '转换完成', '下载 paper.epub', '3/3（今日）', '请选择有效的 PDF 文件'],
  [
    'ja',
    '変換が完了しました',
    'paper.epub をダウンロード',
    '3/3（今日）',
    '有効な PDF ファイルを選択してください',
  ],
  [
    'ko',
    '변환이 완료되었습니다',
    'paper.epub 다운로드',
    '3/3 (오늘)',
    '유효한 PDF 파일을 선택해 주세요',
  ],
] as const) {
  test(`${locale} conversion messages and download labels preserve source filenames`, async ({
    page,
  }) => {
    await setup(page)
    await page.addInitScript(
      (language) => localStorage.setItem('siteLang', language),
      locale,
    )
    await page.route('**/api/struct-demo/jobs', (route) =>
      route.fulfill({
        status: 202,
        json: { id: 'localized-job', status: 'queued' },
      }),
    )
    await page.route('**/api/struct-demo/jobs/localized-job', (route) =>
      route.fulfill({
        json: {
          id: 'localized-job',
          status: 'done',
          files: [{ name: 'paper.epub' }],
        },
      }),
    )
    await page.goto('/research/struct/demo/')
    await expect(page.locator('[data-struct-quota]')).toContainText(quotaText)
    await page.locator('[data-struct-form] input').setInputFiles({
      name: 'fake.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('not pdf'),
    })
    await page.locator('[data-struct-form] button').click()
    await expect(page.locator('[data-struct-status]')).toContainText(invalid)
    await page.locator('[data-struct-form] input').setInputFiles(pdf)
    await page.locator('[data-struct-form] button').click()
    await expect(page.locator('[data-struct-status]')).toContainText(ready)
    await expect(page.locator('[data-struct-downloads] a')).toHaveText(download)
    await expect(page.locator('[data-struct-downloads] a')).toHaveAttribute(
      'download',
      'paper.epub',
    )
  })
}

test('Chinese daily limit and busy messages retain distinct retry semantics', async ({
  page,
}) => {
  await setup(page)
  await page.addInitScript(() => localStorage.setItem('siteLang', 'zh'))
  let attempt = 0
  await page.route(
    '**/api/struct-demo/samples/attention-is-all-you-need',
    (route) =>
      route.fulfill({
        status: 429,
        json:
          attempt++ === 0
            ? { error: { code: 'busy' } }
            : { error: { code: 'daily_limit' }, resetsAt: limits.resetsAt },
      }),
  )
  await page.goto('/research/struct/demo/')
  await page
    .locator('[data-struct-sample-select]')
    .selectOption('attention-is-all-you-need')
  await page.locator('[data-struct-convert-sample]').click()
  await expect(page.locator('[data-struct-status]')).toContainText(
    '转换服务正忙',
  )
  await expect(page.locator('[data-struct-status]')).not.toContainText(
    /UTC|每日限额/,
  )
  await page.locator('[data-struct-refresh]').click()
  await page
    .locator('[data-struct-sample-select]')
    .selectOption('attention-is-all-you-need')
  await page.locator('[data-struct-convert-sample]').click()
  await expect(page.locator('[data-struct-status]')).toContainText(
    '已达到每日限额',
  )
  await expect(page.locator('[data-struct-status]')).toContainText(
    '2026-10-13 00:00:00 UTC',
  )
})

test('preview opens Docling immediately and preserves actual device viewport widths on mobile', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await setup(page, false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/research/struct/demo/')
  await expect(page.getByLabel('Existing paper')).toHaveValue(
    'docling-technical-report',
  )
  const frame = page.locator('[data-struct-preview-frame]')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute(
    'src',
    '/research/struct/samples/docling-technical-report/content.html',
  )
  await expect(frame).toHaveAttribute('sandbox', '')
  await page.getByRole('button', { name: 'Desktop', exact: true }).click()
  await expect
    .poll(() => frame.evaluate((el: HTMLIFrameElement) => el.offsetWidth))
    .toBe(1280)
  await expect
    .poll(() =>
      page
        .frameLocator('[data-struct-preview-frame]')
        .locator('body')
        .evaluate(() => innerWidth),
    )
    .toBe(1280)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.getByRole('button', { name: 'E-ink', exact: true }).click()
  await expect
    .poll(() => frame.evaluate((el: HTMLIFrameElement) => el.offsetWidth))
    .toBe(600)
  await page.getByRole('button', { name: 'Phone', exact: true }).click()
  await expect(
    page.frameLocator('[data-struct-preview-frame]').locator('img').first(),
  ).toBeVisible()
  await expect
    .poll(() =>
      page
        .frameLocator('[data-struct-preview-frame]')
        .locator('img')
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0)
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({
    path: '.agent/evidence/struct-demo-concise-mobile.png',
    fullPage: true,
  })
  await frame.screenshot({
    path: '.agent/evidence/struct-demo-concise-mobile-frame.png',
  })
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({
    path: '.agent/evidence/struct-demo-concise-desktop.png',
    fullPage: true,
  })
  expect(errors).toEqual([])
})

test('uploaded documents use the same sandboxed preview and show a localized fallback on failure', async ({
  page,
}) => {
  await setup(page)
  await page.goto('/research/struct/demo/')
  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-start', {
        detail: { requestId: 'upload-test' },
      }),
    ),
  )
  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-ready', {
        detail: {
          requestId: 'upload-test',
          html: '<!doctype html><html><body><h1>Uploaded document</h1><script>parent.document.body.dataset.unsafe="yes"</script></body></html>',
          title: 'original.pdf',
        },
      }),
    ),
  )
  await expect(page.locator('[data-struct-preview-title]')).toHaveText(
    'original.pdf',
  )
  await expect(
    page
      .frameLocator('[data-struct-preview-frame]')
      .getByRole('heading', { name: 'Uploaded document' }),
  ).toBeVisible()
  await expect(page.locator('body')).not.toHaveAttribute('data-unsafe', 'yes')
  await expect(page.locator('[data-struct-preview-frame]')).toHaveAttribute(
    'sandbox',
    '',
  )
  await page.evaluate(() =>
    document.querySelector('[data-struct-demo]')!.dispatchEvent(
      new CustomEvent('struct:preview-ready', {
        detail: { requestId: 'upload-test', error: 'preview-unavailable' },
      }),
    ),
  )
  await expect(page.locator('[data-struct-preview-error]')).toBeVisible()
  await expect(page.locator('[data-struct-preview-frame]')).toBeHidden()
})

for (const outcome of ['success', 'failure'] as const) {
  test(`late ${outcome} preserves the reader's newer sample and ignores older request tokens`, async ({
    page,
  }) => {
    await setup(page)
    await page.goto('/research/struct/demo/')
    await page.evaluate(() =>
      document.querySelector('[data-struct-demo]')!.dispatchEvent(
        new CustomEvent('struct:preview-start', {
          detail: { requestId: 'A' },
        }),
      ),
    )
    await page.getByLabel('Existing paper').selectOption('ai-must-die')
    const detail =
      outcome === 'success'
        ? { requestId: 'A', html: '<h1>A result</h1>', title: 'A.pdf' }
        : { requestId: 'A', error: 'preview-unavailable' }
    await page.evaluate(
      (value) =>
        document
          .querySelector('[data-struct-demo]')!
          .dispatchEvent(
            new CustomEvent('struct:preview-ready', { detail: value }),
          ),
      detail,
    )
    await expect(page.getByLabel('Existing paper')).toHaveValue('ai-must-die')
    await expect(page.locator('[data-struct-preview-frame]')).toHaveAttribute(
      'src',
      '/research/struct/samples/ai-must-die/content.html',
    )
    await expect(page.locator('[data-struct-preview-error]')).toBeHidden()
    if (outcome === 'success') {
      await page.getByLabel('Existing paper').selectOption('__upload__')
      await expect(
        page
          .frameLocator('[data-struct-preview-frame]')
          .getByRole('heading', { name: 'A result' }),
      ).toBeVisible()
      await page.getByLabel('Existing paper').selectOption('ai-must-die')
    }
    await page.evaluate(() =>
      document.querySelector('[data-struct-demo]')!.dispatchEvent(
        new CustomEvent('struct:preview-start', {
          detail: { requestId: 'B' },
        }),
      ),
    )
    await page.evaluate(
      (value) =>
        document
          .querySelector('[data-struct-demo]')!
          .dispatchEvent(
            new CustomEvent('struct:preview-ready', { detail: value }),
          ),
      detail,
    )
    await expect(page.getByLabel('Existing paper')).toHaveValue('ai-must-die')
    await expect(page.locator('[data-struct-preview-error]')).toBeHidden()
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>(
        '[data-struct-preview-frame]',
      )!
      // Mutating src can navigate to about:blank even after srcdoc changes.
      // Install the uploaded document once without touching the fallback URL.
      const observer = new MutationObserver((records) => {
        frame.dataset.previewNavigation = records
          .map((record) => record.attributeName)
          .join(',')
        observer.disconnect()
      })
      observer.observe(frame, {
        attributes: true,
        attributeFilter: ['srcdoc', 'src'],
      })
      document.querySelector('[data-struct-demo]')!.dispatchEvent(
        new CustomEvent('struct:preview-ready', {
          detail: {
            requestId: 'B',
            html: '<h1>B result</h1>',
            title: 'B.pdf',
          },
        }),
      )
    })
    await expect(page.locator('[data-struct-preview-frame]')).toHaveAttribute(
      'data-preview-navigation',
      'srcdoc',
    )
    await expect(page.getByLabel('Existing paper')).toHaveValue('__upload__')
    await expect(page.locator('[data-struct-upload-option]')).toHaveText(
      'B.pdf',
    )
    await expect(
      page
        .frameLocator('[data-struct-preview-frame]')
        .getByRole('heading', { name: 'B result' }),
    ).toBeVisible()
  })
}

test('reader controls reflow samples and uploads at model and custom sizes', async ({
  page,
}) => {
  await setup(page, false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/research/struct/demo/')
  const settings = page.locator('[data-struct-reader-settings]')
  await expect(settings).not.toHaveAttribute('open', '')
  await expect(page.getByLabel('Device model', { exact: true })).toBeHidden()
  await settings.locator('summary').click()
  await expect(page.getByLabel('Device model', { exact: true })).toBeVisible()
  const frame = page.locator('[data-struct-preview-frame]')
  const body = page.frameLocator('[data-struct-preview-frame]').locator('body')
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('16px')
  await page.getByRole('button', { name: 'E-ink', exact: true }).click()
  await page
    .getByLabel('Device model', { exact: true })
    .selectOption('remarkable-move')
  await expect
    .poll(() => frame.evaluate((el) => (el as HTMLIFrameElement).offsetWidth))
    .toBe(477)
  await page.getByLabel('Width (px)', { exact: true }).fill('720')
  await page.getByLabel('Width (px)', { exact: true }).press('Tab')
  await expect(page.getByLabel('Device model', { exact: true })).toHaveValue(
    'custom',
  )
  await expect
    .poll(() => frame.evaluate((el) => (el as HTMLIFrameElement).offsetWidth))
    .toBe(720)
  await page.getByLabel('Font size (px)', { exact: true }).fill('24')
  await page.getByLabel('Font size (px)', { exact: true }).press('Tab')
  await page.getByLabel('Font family', { exact: true }).selectOption('sans')
  await page.getByLabel('Margins (px)', { exact: true }).fill('32')
  await page.getByLabel('Margins (px)', { exact: true }).press('Tab')
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('24px')
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).fontFamily))
    .toContain('Arial')
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).paddingLeft))
    .toBe('32px')
  await expect
    .poll(() =>
      page
        .frameLocator('[data-struct-preview-frame]')
        .locator('img')
        .first()
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0)
  await settings.locator('summary').click()
  await expect(page.getByLabel('Font family', { exact: true })).toBeHidden()
  await settings.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Font family', { exact: true })).toHaveValue(
    'sans',
  )
  await page.evaluate(() => {
    const root = document.querySelector('[data-struct-demo]')!
    root.dispatchEvent(
      new CustomEvent('struct:preview-start', {
        detail: { requestId: 'reader-settings' },
      }),
    )
    root.dispatchEvent(
      new CustomEvent('struct:preview-ready', {
        detail: {
          requestId: 'reader-settings',
          title: 'Settings test',
          html: "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'none'\"></head><body><p>Uploaded reader text</p></body></html>",
        },
      }),
    )
  })
  await expect(body).toContainText('Uploaded reader text')
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('24px')
  await expect(frame).toHaveAttribute('sandbox', '')
  await expect(
    page
      .frameLocator('[data-struct-preview-frame]')
      .locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute('content', /script-src 'none'/)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.getByRole('button', { name: 'Reset reader', exact: true }).click()
  await expect(page.getByLabel('Device model', { exact: true })).toHaveValue(
    'phone',
  )
  await expect
    .poll(() => body.evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('16px')
  await expect(body).toContainText('Uploaded reader text')
  await expect(frame).toHaveAttribute('srcdoc', /Uploaded reader text/)
  await page.screenshot({
    path: '.agent/evidence/struct-reader-controls-mobile.png',
    fullPage: true,
  })
})
