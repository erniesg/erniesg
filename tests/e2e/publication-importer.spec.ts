import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
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

test('adjudicates blockers and replays the sidecar to identical EPUB bytes', async ({
  page,
}) => {
  await uploadFixture(page, 'adjudication-required.pdf')

  await expect(page.getByText('AMBIGUOUS_NOTE_MATCH').first()).toBeVisible()
  await expect(page.getByText('AMBIGUOUS_READING_ORDER')).toBeVisible()

  await page
    .getByRole('button', { name: /Use note fn-p002-1 for/ })
    .first()
    .click()
  await page.getByRole('button', { name: /Use note fn-p002-1-2 for/ }).click()
  await page.getByRole('button', { name: 'Accept reading order 1' }).click()

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await expect(page.getByText(/Human adjudications:/)).toBeVisible()

  const decisionDownloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export decisions JSON' }).click()
  const decisionDownload = await decisionDownloadPromise
  const decisionBytes = await readFile((await decisionDownload.path())!)

  const firstEpubDownloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: /download epub/i }).click()
  const firstEpub = await firstEpubDownloadPromise
  const firstBytes = await readFile((await firstEpub.path())!)

  await page.getByRole('button', { name: 'New paper' }).click()
  await page.locator('#publication-decisions').setInputFiles({
    name: 'saved-decisions.json',
    mimeType: 'application/json',
    buffer: decisionBytes,
  })
  await page
    .locator('#publication-pdf')
    .setInputFiles(fixture('adjudication-required.pdf'))
  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 15_000,
  })

  const replayedEpubDownloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: /download epub/i }).click()
  const replayedEpub = await replayedEpubDownloadPromise
  const replayedBytes = await readFile((await replayedEpub.path())!)
  expect(replayedBytes).toEqual(firstBytes)
})
