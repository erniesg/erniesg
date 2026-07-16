import { expect, test, type Page } from '@playwright/test'
import { unzipSync, strFromU8 } from 'fflate'
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

test('packages scientific visual objects as real EPUB assets', async ({
  page,
}) => {
  await uploadFixture(page, 'structured-scientific.pdf')

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await page.locator('.publication-diagnostics summary').click()
  await expect(page.getByText('Asset coverage')).toBeVisible()
  await expect(page.getByText('5 of 5 source visual objects')).toBeVisible()
  await expect(page.getByText('UNRESOLVED_SEMANTIC_OBJECTS')).toHaveCount(0)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: /download epub/i }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('Browser did not retain the EPUB download')
  const files = unzipSync(new Uint8Array(await readFile(downloadPath)))
  const content = strFromU8(files['EPUB/content.xhtml'])
  const opf = strFromU8(files['EPUB/package.opf'])
  const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))

  expect(content).not.toMatch(/figure-placeholder|placeholder only/i)
  expect(content).toContain('<object')
  expect(manifest.assets).toHaveLength(4)
  expect(manifest.visualRelationships).toHaveLength(4)
  for (const asset of manifest.assets) {
    expect(files[`EPUB/${asset.href}`]).toBeTruthy()
    expect(opf).toContain(`href="${asset.href}"`)
  }
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

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await page.waitForFunction(
    () => document.documentElement.dataset.delayedEpubDigestComplete === 'true',
  )
  await expect(page.locator('.publication-result-bar strong')).toHaveText(
    'structured-scientific.pdf',
  )
  await expect(page.getByText('EPUB ready', { exact: true })).toHaveCount(1)
})
