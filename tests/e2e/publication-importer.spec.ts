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

async function downloadedEpub(page: Page, linkName: string) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: linkName, exact: true }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('Browser did not retain the EPUB download')
  return unzipSync(new Uint8Array(await readFile(downloadPath)))
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
