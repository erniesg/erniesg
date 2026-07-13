import { expect, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { makeBlankPdf, makeBornDigitalPdf } from '../fixtures/pdf'

async function waitForImporter(page: Page) {
  await expect(
    page.locator('astro-island[component-url$="PublicationImporter.tsx"]'),
  ).toHaveAttribute('client-render-time', /.+/)
}

test('converts an uploaded born-digital PDF into a downloadable EPUB', async ({
  page,
}, testInfo) => {
  await page.goto('/research')
  await waitForImporter(page)

  await page.locator('#publication-pdf').setInputFiles({
    name: 'browser-conversion.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(makeBornDigitalPdf()),
  })

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download EPUB' }).click()
  const download = await downloadPromise
  const outputPath = testInfo.outputPath(download.suggestedFilename())
  await download.saveAs(outputPath)

  const files = unzipSync(new Uint8Array(await readFile(outputPath)))
  expect(strFromU8(files.mimetype)).toBe('application/epub+zip')
  expect(strFromU8(files['EPUB/content.xhtml'])).toContain(
    'Real Browser Conversion Test',
  )
  expect(strFromU8(files['EPUB/nav.xhtml'])).toContain('Table of contents')
})

test('fails closed for a PDF without embedded text', async ({ page }) => {
  await page.goto('/research')
  await waitForImporter(page)

  await page.locator('#publication-pdf').setInputFiles({
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(makeBlankPdf()),
  })

  await expect(
    page.getByRole('heading', {
      name: 'This PDF needs OCR before it can become an EPUB.',
    }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('link', { name: 'Download EPUB' })).toHaveCount(0)
})

test('converts the fellowship paper PDF through the public interaction', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/research')
  await waitForImporter(page)

  await page
    .locator('#publication-pdf')
    .setInputFiles(
      path.resolve(
        'public/research/if-letters-home-could-sing/if-letters-home-could-sing.pdf',
      ),
    )
  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  })

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download EPUB' }).click()
  const download = await downloadPromise
  const outputPath = testInfo.outputPath(`real-${download.suggestedFilename()}`)
  await download.saveAs(outputPath)

  const files = unzipSync(new Uint8Array(await readFile(outputPath)))
  const content = strFromU8(files['EPUB/content.xhtml'])
  expect(strFromU8(files.mimetype)).toBe('application/epub+zip')
  expect(content).toContain('NATIONAL MUSEUM OF SINGAPORE')
  expect(content).toContain('Hainanese women')
})

test('does not submit an empty PDF link', async ({ page }) => {
  await page.goto('/research')
  await waitForImporter(page)
  await expect(page.getByRole('button', { name: 'Create EPUB' })).toBeDisabled()
})
