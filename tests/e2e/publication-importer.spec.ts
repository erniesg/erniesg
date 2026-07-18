import { expect, test, type Page } from '@playwright/test'
import { unzipSync, strFromU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const fixture = (name: string) =>
  path.resolve(
    'tests',
    'fixtures',
    name.endsWith('.docx') ? 'docx' : 'pdf',
    name,
  )

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
    page.getByText(
      /OCR runs offline\. Auto uses the bundled English fallback/i,
    ),
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

async function downloadedEpub(page: Page, linkName: string) {
  return unzipSync(await downloadedBytes(page, linkName))
}

async function downloadedBytes(page: Page, linkName: string) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: linkName, exact: true }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('Browser did not retain the EPUB download')
  return new Uint8Array(await readFile(downloadPath))
}

test('emits EPUB ready only after the completeness gate passes', async ({
  page,
}) => {
  await uploadFixture(page, 'born-digital.pdf')

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Download EPUB', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Download Paper Pro EPUB', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', {
      name: 'Download Paper Pro Move EPUB',
      exact: true,
    }),
  ).toBeVisible()

  for (const [linkName, profileId] of [
    ['Download Paper Pro EPUB', 'paperPro'],
    ['Download Paper Pro Move EPUB', 'paperProMove'],
  ] as const) {
    const files = await downloadedEpub(page, linkName)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))
    expect(manifest).toMatchObject({
      profile: {
        id: profileId,
        exportPolicy: { id: 'profile-tuned-reflowable' },
      },
    })
  }

  for (const [buttonName, profileId] of [
    ['Paper Pro', 'paperPro'],
    ['Pro Move', 'paperProMove'],
  ] as const) {
    await page.getByRole('button', { name: buttonName, exact: true }).click()
    const paper = page.locator('.srt-paper')
    await expect(paper).toHaveAttribute('data-target-profile', profileId)
    const diagnostics = await paper.evaluate((root) => {
      const nodes = [
        ...root.querySelectorAll<HTMLElement>('[data-canonical-id]'),
      ]
      const clipped = nodes
        .filter((node) => {
          const page = node.closest<HTMLElement>('.srt-page')
          if (!page) return true
          const box = node.getBoundingClientRect()
          const pageBox = page.getBoundingClientRect()
          return (
            box.left < pageBox.left - 1 ||
            box.right > pageBox.right + 1 ||
            box.top < pageBox.top - 1 ||
            box.bottom > pageBox.bottom + 1
          )
        })
        .map((node) => node.dataset.canonicalId)
      const overlaps: string[] = []
      for (let index = 0; index < nodes.length; index += 1) {
        for (let other = index + 1; other < nodes.length; other += 1) {
          const left = nodes[index]
          const right = nodes[other]
          if (
            left.contains(right) ||
            right.contains(left) ||
            left.closest('.srt-page-region') !==
              right.closest('.srt-page-region')
          ) {
            continue
          }
          const a = left.getBoundingClientRect()
          const b = right.getBoundingClientRect()
          if (
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
          ) {
            overlaps.push(
              `${left.dataset.canonicalId}:${right.dataset.canonicalId}`,
            )
          }
        }
      }
      return {
        clipped,
        overlaps,
        horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      }
    })
    expect(diagnostics).toEqual({
      clipped: [],
      overlaps: [],
      horizontalOverflow: false,
    })
  }
  await page.locator('.publication-diagnostics summary').click()
  await expect(page.getByText('Text coverage')).toBeVisible()
})

test('imports a born-structured DOCX and downloads its EPUB', async ({
  page,
}) => {
  await uploadFixture(page, 'structured-manuscript.docx')

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await page.locator('.publication-diagnostics summary').click()
  await expect(page.getByText('100%').first()).toBeVisible()
  const files = await downloadedEpub(page, 'Download EPUB')
  expect(files['EPUB/content.xhtml']).toBeTruthy()
  expect(files['EPUB/export.json']).toBeTruthy()
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

  const files = await downloadedEpub(page, 'Download EPUB')
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

test('visually links note candidates and both ambiguous reading orders', async ({
  page,
}) => {
  await uploadFixture(page, 'diagnostic-overlays.pdf')

  await expect(
    page.getByRole('heading', { name: 'Diagnostic page inspector' }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator('.pdf-diagnostic-page canvas')
        .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: /AMBIGUOUS_NOTE_MATCH/ }).click()
  await expect(
    page.getByRole('heading', { name: /candidate note bodies/i }),
  ).toBeVisible()
  await expect(page.locator('.pdf-diagnostic-selection li')).toHaveCount(2)
  await expect(
    page.locator('.pdf-diagnostic-selection li').first(),
  ).toContainText('label-exact')
  await expect(page.locator('.pdf-diagnostic-overlay__svg line')).toHaveCount(2)

  await page.getByRole('button', { name: /AMBIGUOUS_READING_ORDER/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Competing reading orders' }),
  ).toBeVisible()
  await expect(page.getByText(/Candidate A · left column/)).toBeVisible()
  await expect(page.getByText(/Candidate B · right column/)).toBeVisible()
  await expect(
    page.locator('.pdf-diagnostic-overlay__svg polyline'),
  ).toHaveCount(2)
})

test('adjudicates ambiguous structure and replays the exact sidecar', async ({
  page,
}) => {
  await uploadFixture(page, 'adjudication-required.pdf')

  await expect(page.getByText('Review required', { exact: true })).toBeVisible()
  for (let remaining = 2; remaining > 0; remaining -= 1) {
    const noteDiagnostics = page.getByRole('button', {
      name: /AMBIGUOUS_NOTE_MATCH/,
    })
    await expect(noteDiagnostics).toHaveCount(remaining)
    await noteDiagnostics.first().click()
    await page
      .getByRole('button', { name: /^Use note / })
      .nth(2 - remaining)
      .click()
    await expect(noteDiagnostics).toHaveCount(remaining - 1)
  }

  await page.getByRole('button', { name: /AMBIGUOUS_READING_ORDER/ }).click()
  await page
    .getByRole('button', { name: 'Accept reading order 1', exact: true })
    .click()

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await expect(page.getByText(/Human adjudications:/)).toContainText(
    'AMBIGUOUS_NOTE_MATCH 2',
  )
  await expect(page.getByText(/Human adjudications:/)).toContainText(
    'AMBIGUOUS_READING_ORDER 1',
  )

  const decisionBytes = await downloadedBytes(page, 'Export decisions JSON')
  const directEpub = await downloadedBytes(page, 'Download EPUB')
  const decisionFile = JSON.parse(new TextDecoder().decode(decisionBytes))
  expect(decisionFile.decisions).toHaveLength(3)

  await page.getByRole('button', { name: 'New paper' }).click()
  await page.locator('#publication-decisions').setInputFiles({
    name: 'review.decisions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(decisionBytes),
  })
  await expect(page.getByText(/3 decisions/)).toBeVisible()
  await page
    .locator('#publication-pdf')
    .setInputFiles(fixture('adjudication-required.pdf'))

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  const replayedEpub = await downloadedBytes(page, 'Download EPUB')
  expect(replayedEpub).toEqual(directEpub)
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

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await page.waitForFunction(
    () => document.documentElement.dataset.delayedEpubDigestComplete === 'true',
  )
  await expect(page.locator('.publication-result-bar strong')).toHaveText(
    'structured-scientific.pdf',
  )
  await expect(page.getByText('EPUB ready', { exact: true })).toHaveCount(1)
})
