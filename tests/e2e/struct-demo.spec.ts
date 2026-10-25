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
  await expect(
    sample.getByRole('link', { name: 'Source PDF' }),
  ).toHaveAttribute('href', /\.pdf$/)
  await expect(page.locator('[data-struct-preview-frame]')).toHaveAttribute(
    'sandbox',
    '',
  )
  await expect(
    sample.getByRole('link', { name: /EPUB/ }).first(),
  ).toHaveAttribute('download', '')
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
  await sample
    .getByText('Source, credits and review notes', { exact: true })
    .click()
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
    cached.getByRole('link', { name: 'Paper Pro EPUB', exact: true }),
  ).toHaveAttribute('download', '')
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
  [
    'zh',
    '转换完成',
    '下载 paper.epub',
    '此网络今天还可转换 3 次',
    '请选择有效的 PDF 文件',
  ],
  [
    'ja',
    '変換が完了しました',
    'paper.epub をダウンロード',
    'このネットワークでは本日あと 3 回',
    '有効な PDF ファイルを選択してください',
  ],
  [
    'ko',
    '변환이 완료되었습니다',
    'paper.epub 다운로드',
    '이 네트워크에서 오늘 3회',
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
    document
      .querySelector('[data-struct-demo]')!
      .dispatchEvent(
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
      document
        .querySelector('[data-struct-demo]')!
        .dispatchEvent(
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
      document
        .querySelector('[data-struct-demo]')!
        .dispatchEvent(
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
    await page.evaluate(() =>
      document
        .querySelector('[data-struct-demo]')!
        .dispatchEvent(
          new CustomEvent('struct:preview-ready', {
            detail: {
              requestId: 'B',
              html: '<h1>B result</h1>',
              title: 'B.pdf',
            },
          }),
        ),
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
