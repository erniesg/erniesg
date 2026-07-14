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
})
