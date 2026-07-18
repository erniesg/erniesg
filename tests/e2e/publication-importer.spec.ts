import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'

const fixture = (name: string) => path.resolve('tests', 'fixtures', 'pdf', name)

test.describe.configure({ timeout: 120_000 })

async function waitForImporter(page: Page) {
  await expect(
    page.locator('astro-island[component-url$="PublicationImporter.tsx"]'),
  ).toHaveAttribute('client-render-time', /.+/)
}

test('offers an explicit offline OCR language choice', async ({ page }) => {
  await page.goto('/research/studio')

  await expect(page.getByLabel('OCR language')).toHaveValue('auto')
  await expect(
    page.getByText(/OCR runs offline\. Auto uses the bundled English fallback/i),
  ).toBeVisible()
  await expect(page.getByText(/local language pack/i)).toBeVisible()
})

test('recognizes a scanned fixture without any cross-origin request', async ({
  page,
}) => {
  const externalRequests: string[] = []
  await page.goto('/research/studio')
  await waitForImporter(page)
  const applicationOrigin = new URL(page.url()).origin
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.protocol.startsWith('http') && url.origin !== applicationOrigin) {
      externalRequests.push(url.href)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })

  await page
    .locator('#publication-pdf')
    .setInputFiles(fixture('scanned-page.pdf'))

  await expect(page.locator('.publication-result-bar')).toBeVisible({
    timeout: 90_000,
  })
  const details = page.locator('.publication-diagnostics')
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  ) {
    await details.locator('summary').click()
  }
  await expect(page.getByText(/tesseract\.js 6\.0\.1/i)).toBeVisible()
  await expect(page.getByText('OCR_REQUIRED')).toHaveCount(0)
  expect(externalRequests).toEqual([])
})

async function uploadFixture(page: Page, name: string) {
  await expect(async () => {
    await page.goto('/research/studio')
    await waitForImporter(page)
    await page.locator('#publication-pdf').setInputFiles(fixture(name))
    await expect(page.locator('.publication-result-bar')).toBeVisible({
      timeout: 5_000,
    })
  }).toPass({ timeout: 45_000 })
}

test('emits EPUB ready only after the completeness gate passes', async ({
  page,
}) => {
  await uploadFixture(page, 'born-digital.pdf')

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /download epub/i })).toBeVisible()
  await page.locator('.publication-diagnostics summary').click()
  await expect(page.getByText('Text coverage')).toBeVisible()
})

test('blocks a text-only EPUB when scientific objects are unresolved', async ({
  page,
}) => {
  await uploadFixture(page, 'structured-scientific.pdf')

  await expect(page.getByText('Review required', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'This reconstruction is incomplete.' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: /download epub/i })).toHaveCount(
    0,
  )
  await expect(page.getByRole('button', { name: 'Print / PDF' })).toBeDisabled()
  await expect(page.getByText('INCOMPLETE_ASSET_COVERAGE')).toBeVisible()
  await expect(page.getByText('UNRESOLVED_SEMANTIC_OBJECTS')).toBeVisible()

  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.publication-preview-blocked')).toBeHidden()
})

test('keeps the newest result when an active import is superseded', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const subtle = globalThis.crypto.subtle
    const digest = subtle.digest.bind(subtle)
    let delayed = false
    Object.defineProperty(subtle, 'digest', {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto['digest']>) => {
        const input = args[1]
        const bytes =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        // buildEpub hashes JSON.stringify(paper) before assembling the archive.
        const isEpubCanonicalPayload =
          !delayed &&
          new TextDecoder().decode(bytes.subarray(0, 11)) === '{"id":"pdf-'
        if (isEpubCanonicalPayload) {
          delayed = true
          await new Promise((resolve) => setTimeout(resolve, 750))
        }
        const result = await digest(...args)
        if (isEpubCanonicalPayload) {
          document.documentElement.dataset.delayedEpubDigestComplete = 'true'
        }
        return result
      },
    })
  })
  await page.goto('/research/studio', { waitUntil: 'networkidle' })
  await waitForImporter(page)

  await page
    .locator('#publication-pdf')
    .setInputFiles(fixture('born-digital.pdf'))
  await expect(page.getByText('Validating EPUB…')).toBeVisible()
  await page.getByRole('button', { name: 'New paper' }).click()
  await page
    .locator('#publication-pdf')
    .setInputFiles(fixture('structured-scientific.pdf'))

  await expect(page.getByText('Review required', { exact: true })).toBeVisible()
  await page.waitForFunction(
    () => document.documentElement.dataset.delayedEpubDigestComplete === 'true',
  )
  await expect(page.locator('.publication-result-bar strong')).toHaveText(
    'structured-scientific.pdf',
  )
  await expect(page.getByText('EPUB ready', { exact: true })).toHaveCount(0)
})
