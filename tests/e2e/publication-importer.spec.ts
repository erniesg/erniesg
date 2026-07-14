import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'

const fixture = (name: string) => path.resolve('tests', 'fixtures', 'pdf', name)

test.describe.configure({ timeout: 60_000 })

async function uploadFixture(page: Page, name: string) {
  await expect(async () => {
    await page.goto('/research/studio')
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
  await page.goto('/research/studio')
  await page.evaluate(() => {
    const subtle = globalThis.crypto.subtle
    const digest = subtle.digest.bind(subtle)
    let calls = 0
    Object.defineProperty(subtle, 'digest', {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto['digest']>) => {
        calls += 1
        const call = calls
        if (call === 2) {
          await new Promise((resolve) => setTimeout(resolve, 750))
        }
        const result = await digest(...args)
        if (call === 2) {
          document.documentElement.dataset.delayedDigestComplete = 'true'
        }
        return result
      },
    })
  })

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
    () => document.documentElement.dataset.delayedDigestComplete === 'true',
  )
  await expect(page.locator('.publication-result-bar strong')).toHaveText(
    'structured-scientific.pdf',
  )
  await expect(page.getByText('EPUB ready', { exact: true })).toHaveCount(0)
})
