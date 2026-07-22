import { expect, test, type Page } from '@playwright/test'
import { unzipSync, strFromU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { installStaticRoutes } from './static-build'

const fixture = (name: string) =>
  path.resolve(
    'tests',
    'fixtures',
    name.endsWith('.docx') ? 'docx' : 'pdf',
    name,
  )

function unresolvedLineJoinPdf() {
  const content = [
    'BT /F1 11 Tf 54 632 Td (This source contains a scenar-) Tj ET',
    'BT /F1 11 Tf 54 614 Td (io that remains continuous prose.) Tj ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n% owner-local line-join fixture\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

test.describe.configure({ timeout: 120_000 })
test.beforeEach(async ({ page }) => installStaticRoutes(page))

async function waitForImporter(page: Page) {
  await expect(page.locator('#publication-pdf')).toBeEnabled({
    timeout: 30_000,
  })
}

test('offers an explicit offline OCR language choice', async ({ page }) => {
  await page.goto('/research/studio')
  await waitForImporter(page)

  await expect(page.getByLabel('OCR language')).toHaveValue('auto')
  await expect(
    page.getByText(
      /OCR runs offline\. Auto uses the bundled English fallback/i,
    ),
  ).toBeVisible()
  await expect(page.getByText(/local language pack/i)).toBeVisible()
  await expect(async () => {
    const dropzone = page.locator('.publication-dropzone')
    await dropzone.dispatchEvent('dragenter')
    await expect(dropzone).toHaveClass(/\bis-dragging\b/)
  }).toPass({ timeout: 10_000 })
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
    await route.fallback()
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
    page.getByRole('link', { name: 'Download Mobile EPUB', exact: true }),
  ).toBeVisible()
  const rendition = page.getByTitle('Generated EPUB rendition on Mobile')
  await expect(rendition).toBeVisible()
  await expect(
    rendition.contentFrame().locator('[data-canonical-id]').first(),
  ).toBeVisible()
  await expect(rendition.contentFrame().locator('script')).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Download Paper Pro EPUB', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('link', {
      name: 'Download Paper Pro Move EPUB',
      exact: true,
    }),
  ).toHaveCount(0)
  const switcher = page.locator('.epub-device-switcher')
  await expect(
    switcher.locator('button[data-profile-id="mobile"]'),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.srt-paper')).toHaveCount(0)

  for (const [label, linkName, profileId] of [
    ['Mobile', 'Download Mobile EPUB', 'mobile'],
    ['Paper Pro', 'Download Paper Pro EPUB', 'paperPro'],
    ['Paper Pro Move', 'Download Paper Pro Move EPUB', 'paperProMove'],
  ] as const) {
    await switcher.getByText(label, { exact: true }).locator('..').click()
    await expect(
      switcher.locator(`button[data-profile-id="${profileId}"]`),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.locator('.publication-actions a[data-artifact-sha256]'),
    ).toHaveCount(1)
    const files = await downloadedEpub(page, linkName)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))
    expect(manifest).toMatchObject({
      profile: {
        id: profileId,
        exportPolicy: { id: 'profile-tuned-reflowable' },
      },
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
  const frame = page
    .getByTitle('Generated EPUB rendition on Mobile')
    .contentFrame()
  await expect(frame.locator('strong', { hasText: 'bold' })).toBeVisible()
  await expect(frame.locator('em', { hasText: 'italic' })).toBeVisible()
  const inertExternalLink = frame.locator(
    'a[role="link"][data-original-href="https://example.com/source"]',
    { hasText: 'linked text' },
  )
  await expect(inertExternalLink).toBeVisible()
  await expect(inertExternalLink).not.toHaveAttribute('href')
  await expect(inertExternalLink).toHaveAttribute(
    'aria-label',
    /link disabled in preview/,
  )
  await expect(inertExternalLink).toHaveAttribute('tabindex', '0')
  const internalLink = frame.locator('a[href^="#"]').first()
  await expect(internalLink).toBeVisible()
  await internalLink.focus()
  await expect
    .poll(() =>
      internalLink.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      ),
    )
    .not.toBe('none')
  await expect(frame.locator('aside[role="doc-footnote"]')).toBeVisible()
  await expect(frame.locator('aside[role="doc-endnote"]')).toBeVisible()
  const backlink = frame.locator('.note-backlink').first()
  await expect(backlink).toBeVisible()
  const backlinkHref = await backlink.getAttribute('href')
  expect(backlinkHref).toMatch(/^#.+/)
  await expect(frame.locator(backlinkHref!)).toHaveCount(1)
  const files = await downloadedEpub(page, 'Download Mobile EPUB')
  expect(files['EPUB/content.xhtml']).toBeTruthy()
  expect(files['EPUB/export.json']).toBeTruthy()
  expect(strFromU8(files['EPUB/content.xhtml'])).toContain(
    '<a href="https://example.com/source">linked text</a>',
  )
})

test('packages scientific visual objects as real EPUB assets', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const trackedWindow = window as unknown as Window & {
      __revokedPreviewUrls: string[]
    }
    trackedWindow.__revokedPreviewUrls = []
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url) => {
      trackedWindow.__revokedPreviewUrls.push(url)
      revokeObjectUrl(url)
    }
  })
  await uploadFixture(page, 'structured-scientific.pdf')

  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible()
  await page.locator('.publication-diagnostics summary').click()
  await expect(page.getByText('Asset coverage')).toBeVisible()
  await expect(page.getByText('4 of 4 source visual objects')).toBeVisible()
  await expect(page.getByText('UNRESOLVED_SEMANTIC_OBJECTS')).toHaveCount(0)
  const frame = page
    .getByTitle('Generated EPUB rendition on Mobile')
    .contentFrame()
  await expect(frame.locator('.srt-pipeline')).toHaveCount(0)
  await expect(
    frame.locator('figure').first().locator('img, table').first(),
  ).toBeVisible()
  expect(
    await frame.locator('img').evaluateAll((images) =>
      (images as HTMLImageElement[]).map((image) => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      })),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        complete: true,
        naturalWidth: expect.any(Number),
        naturalHeight: expect.any(Number),
      }),
    ]),
  )
  expect(
    await frame
      .locator('img')
      .evaluateAll((images) =>
        (images as HTMLImageElement[]).every((image) => image.naturalWidth > 0),
      ),
  ).toBe(true)
  await expect(frame.locator('iframe, object')).toHaveCount(0)
  const files = await downloadedEpub(page, 'Download Mobile EPUB')
  const content = strFromU8(files['EPUB/content.xhtml'])
  const opf = strFromU8(files['EPUB/package.opf'])
  const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))

  const firstFigureRelationship = manifest.visualRelationships.find(
    (relationship: { label: string }) => relationship.label === 'Figure 1',
  )
  expect(firstFigureRelationship).toMatchObject({
    sourceObjectIds: ['image-p001-001'],
    assetIds: [expect.any(String)],
  })
  const firstFigureAssets = frame
    .locator('figure')
    .first()
    .locator('[data-asset-id]')
  await expect(firstFigureAssets).toHaveCount(
    firstFigureRelationship.assetIds.length,
  )
  expect(
    await firstFigureAssets.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-asset-id')),
    ),
  ).toEqual(firstFigureRelationship.assetIds)

  expect(content).not.toMatch(/figure-placeholder|placeholder only/i)
  const tableRelationship = manifest.visualRelationships.find(
    (relationship: { kind: string }) => relationship.kind === 'table',
  )
  expect(tableRelationship).toMatchObject({
    captionNodeId: expect.any(String),
  })
  expect(content).toContain(
    `<table aria-describedby="${tableRelationship.captionNodeId}">`,
  )
  expect(content).toContain('<thead>')
  expect(content).toContain('<tbody>')
  expect(content).not.toContain('<object')
  expect(manifest.assets).toHaveLength(4)
  expect(manifest.visualRelationships).toHaveLength(4)
  for (const asset of manifest.assets) {
    expect(files[`EPUB/${asset.href}`]).toBeTruthy()
    expect(opf).toContain(`href="${asset.href}"`)
  }

  await page.getByRole('button', { name: 'New paper' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __revokedPreviewUrls?: string[]
            }
          ).__revokedPreviewUrls?.length ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(
      manifest.assets.filter(
        (asset: { mediaType: string }) =>
          asset.mediaType !== 'application/xhtml+xml',
      ).length,
    )
})

test('visually links note candidates and both ambiguous reading orders', async ({
  page,
}) => {
  await uploadFixture(page, 'diagnostic-overlays.pdf')
  await expect(page.locator('.publication-diagnostics')).not.toHaveAttribute(
    'open',
    '',
  )
  await page.locator('.publication-diagnostics summary').click()

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

test('adjudicates ambiguous structure while preserving independent blockers and replays the exact sidecar', async ({
  page,
}) => {
  await uploadFixture(page, 'adjudication-required.pdf')

  await expect(page.getByText('Review required', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('link', {
      name: 'Download readable Mobile EPUB (review recommended)',
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByLabel('Blocking issue groups')).toBeVisible()
  await page.locator('.publication-diagnostics summary').click()
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

  await expect(page.getByText('Review required', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Blocking issue groups')).toContainText(
    'UNPROVENANCED RENDERED UNIT',
  )
  await expect(page.getByLabel('Blocking issue groups')).toContainText(
    'INCOMPLETE TEXT COVERAGE',
  )
  await expect(page.getByText(/Human adjudications:/)).toContainText(
    'AMBIGUOUS_NOTE_MATCH 2',
  )
  await expect(page.getByText(/Human adjudications:/)).toContainText(
    'AMBIGUOUS_READING_ORDER 1',
  )

  const decisionBytes = await downloadedBytes(page, 'Export decisions JSON')
  const directEpub = await downloadedBytes(
    page,
    'Download readable Mobile EPUB (review recommended)',
  )
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

  await expect(page.getByText('Review required', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Blocking issue groups')).toContainText(
    'UNPROVENANCED RENDERED UNIT',
  )
  await expect(page.getByLabel('Blocking issue groups')).toContainText(
    'INCOMPLETE TEXT COVERAGE',
  )
  const replayedEpub = await downloadedBytes(
    page,
    'Download readable Mobile EPUB (review recommended)',
  )
  expect(replayedEpub).toEqual(directEpub)
})

test('adjudicates an unresolved line join with three explicit choices and replays the exact sidecar', async ({
  page,
}) => {
  const source = unresolvedLineJoinPdf()
  const upload = async () => {
    await page.locator('#publication-pdf').setInputFiles({
      name: 'unresolved-line-join.pdf',
      mimeType: 'application/pdf',
      buffer: source,
    })
    await expect(page.locator('.publication-result-bar')).toBeVisible({
      timeout: 45_000,
    })
  }

  await page.goto('/research/studio')
  await waitForImporter(page)
  await upload()
  await expect(page.getByText('Review required', { exact: true })).toBeVisible()
  await page.locator('.publication-diagnostics summary').click()
  await expect(
    page.getByRole('heading', { name: 'Line-join review', exact: true }),
  ).toBeVisible()
  const remove = page.getByRole('button', { name: 'Remove wrap hyphen' })
  const preserve = page.getByRole('button', {
    name: 'Preserve authored hyphen',
  })
  const unresolved = page.getByRole('button', { name: 'Leave unresolved' })
  await expect(remove).not.toHaveAttribute('aria-pressed', 'true')
  await expect(preserve).not.toHaveAttribute('aria-pressed', 'true')
  await expect(unresolved).not.toHaveAttribute('aria-pressed', 'true')

  await unresolved.click()
  await expect(unresolved).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Blocking issue groups')).toContainText(
    'UNRESOLVED CORRUPTING JOIN',
  )

  await preserve.click()
  await expect(preserve).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Blocking issue groups')).not.toContainText(
    'UNRESOLVED CORRUPTING JOIN',
  )

  await remove.click()
  await expect(remove).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/scenar-\s*$/u)).toBeVisible()
  await expect(
    page.getByText(/^io that remains continuous prose\./u),
  ).toBeVisible()

  const decisionBytes = await downloadedBytes(page, 'Export decisions JSON')
  const decisionFile = JSON.parse(new TextDecoder().decode(decisionBytes))
  expect(decisionFile).toMatchObject({
    schemaVersion: '1.1.0',
    decisions: [
      {
        diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
        resolution: {
          type: 'resolve-line-join',
          outcome: 'remove-wrap-hyphen',
          confidence: 1,
          evidence: ['bounded-source-context', 'owner-local-adjudication'],
        },
      },
    ],
  })
  expect(JSON.stringify(decisionFile)).not.toContain('continuous prose')

  await page.getByRole('button', { name: 'New paper' }).click()
  await page.locator('#publication-decisions').setInputFiles({
    name: 'line-join.decisions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(decisionBytes),
  })
  await upload()
  await page.locator('.publication-diagnostics summary').click()
  await expect(
    page.getByRole('button', { name: 'Remove wrap hyphen' }),
  ).toHaveAttribute('aria-pressed', 'true')
  const replayedDecisionBytes = await downloadedBytes(
    page,
    'Export decisions JSON',
  )
  expect(replayedDecisionBytes).toEqual(decisionBytes)
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
  await expect(page.getByText('EPUB ready', { exact: true })).toHaveCount(0)
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
