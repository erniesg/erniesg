import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { installStaticRoutes } from './static-build'

type FidelityContract = {
  fixture: string
  title: string
  canonicalSpans: Array<{ kind: string; text: string }>
  headings: Array<{ text: string; level: number }>
  listItems: Array<{ text: string; level: number; ordered: boolean }>
  inlineSemantics: Array<{
    text: string
    bold?: boolean
    italic?: boolean
    href?: string
    verticalAlign?: 'superscript' | 'subscript'
    relationship?: 'footnote'
  }>
  note: { label: string; text: string }
  references: string[]
  visuals: Array<{
    kind: string
    caption: string
    rows?: string[][]
    sourceText?: string
  }>
  profiles: Array<{
    id: 'mobile' | 'paperProMove' | 'paperPro'
    version: string
    width: number
    height: number | null
    unit: 'css-px' | 'device-px'
    pixelsPerInch: number | null
    previewWidthCssPx: number
    margins: { top: number; right: number; bottom: number; left: number }
  }>
}

const contract = JSON.parse(
  await readFile(
    new URL(
      '../fixtures/pdf/pdf-to-epub-fidelity.contract.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as FidelityContract
const fixture = path.resolve('tests', 'fixtures', 'pdf', contract.fixture)
const profileUi = {
  mobile: { label: 'Mobile', download: 'Download Mobile EPUB' },
  paperProMove: {
    label: 'Paper Pro Move',
    download: 'Download Paper Pro Move EPUB',
  },
  paperPro: { label: 'Paper Pro', download: 'Download Paper Pro EPUB' },
} as const

test.describe.configure({ timeout: 120_000 })
test.beforeEach(async ({ page }) => installStaticRoutes(page))

async function waitForImporter(page: Page) {
  await expect(page.locator('#publication-pdf')).toBeEnabled({
    timeout: 30_000,
  })
}

async function downloadBytes(page: Page, linkName: string) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: linkName, exact: true }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('Browser did not retain the EPUB download')
  return new Uint8Array(await readFile(downloadPath))
}

test('uploads once and previews the matching Mobile, Move, and Pro EPUB artifacts without overflow', async ({
  page,
}) => {
  let downloadCount = 0
  page.on('download', () => {
    downloadCount += 1
  })

  await page.goto('/research/studio')
  await waitForImporter(page)
  await page.locator('#publication-pdf').setInputFiles(fixture)
  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  })

  const downloaded: Array<{
    profileId: string
    hash: string
    manifest: {
      canonicalContentSha256: string
      canonicalNodeIds: string[]
      visualRelationships: Array<{
        kind: string
        canonicalNodeId: string
        captionNodeId: string
      }>
      assets: Array<{ id: string; href: string; sha256: string }>
      profile: { id: string; version: string }
    }
  }> = []
  let previousPreviewHash: string | null = null

  for (const expected of contract.profiles) {
    const ui = profileUi[expected.id as keyof typeof profileUi]
    const switcher = page.locator('.epub-device-switcher')
    const button = switcher.getByText(ui.label, { exact: true }).locator('..')
    const downloadsBeforeSwitch = downloadCount
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveAttribute('data-profile-id', expected.id)
    await expect(button).toHaveAttribute(
      'data-profile-version',
      expected.version,
    )
    expect(downloadCount).toBe(downloadsBeforeSwitch)

    const preview = page.locator('.epub-rendition-preview')
    await expect(preview).toHaveAttribute('data-profile-id', expected.id)
    await expect(preview).toHaveAttribute(
      'data-profile-version',
      expected.version,
    )
    const previewHash = await preview.getAttribute('data-artifact-sha256')
    expect(previewHash).toMatch(/^[a-f0-9]{64}$/)
    if (previousPreviewHash) expect(previewHash).not.toBe(previousPreviewHash)
    previousPreviewHash = previewHash
    const receipt = page.getByLabel('Selected EPUB artifact receipt')
    await expect(receipt).toContainText(`${expected.id}@${expected.version}`)
    await expect(
      receipt.locator('[data-truth-authority="authoritative"]'),
    ).toHaveCount(expected.id === 'mobile' ? 1 : 2)
    await expect(
      receipt.locator('[data-truth-authority="advisory"]'),
    ).toHaveCount(expected.id === 'mobile' ? 2 : 1)
    await expect(
      receipt.locator('[data-truth-authority="reader-controlled"]'),
    ).toHaveCount(2)

    const device = page.locator(
      `.epub-preview-device[data-device="${expected.id}"]`,
    )
    await expect(device).toBeVisible()
    const deviceBox = await device.boundingBox()
    expect(deviceBox).not.toBeNull()
    if (expected.height !== null && deviceBox) {
      expect(deviceBox.width / deviceBox.height).toBeCloseTo(
        expected.width / expected.height,
        2,
      )
      expect(deviceBox.width).toBeLessThanOrEqual(
        expected.previewWidthCssPx + 1,
      )
    }
    expect(
      await device.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true)

    const frame = page
      .getByTitle(`Generated EPUB rendition on ${ui.label}`)
      .contentFrame()
    await expect(frame.locator('main')).toBeVisible()
    const geometry = await frame.locator('main').evaluate((main) => {
      const style = getComputedStyle(main)
      return {
        viewportWidth: document.documentElement.clientWidth,
        mainWidth: main.getBoundingClientRect().width,
        bodyPadding: getComputedStyle(document.body).padding,
        paddingTop: Number.parseFloat(style.paddingTop),
        paddingRight: Number.parseFloat(style.paddingRight),
        paddingBottom: Number.parseFloat(style.paddingBottom),
        paddingLeft: Number.parseFloat(style.paddingLeft),
      }
    })
    expect(geometry.mainWidth).toBeCloseTo(geometry.viewportWidth, 0)
    expect(geometry.bodyPadding).toBe('0px')
    expect(geometry.paddingTop / geometry.viewportWidth).toBeCloseTo(
      expected.margins.top / expected.width,
      3,
    )
    expect(geometry.paddingRight / geometry.viewportWidth).toBeCloseTo(
      expected.margins.right / expected.width,
      3,
    )
    expect(geometry.paddingBottom / geometry.viewportWidth).toBeCloseTo(
      expected.margins.bottom / expected.width,
      3,
    )
    expect(geometry.paddingLeft / geometry.viewportWidth).toBeCloseTo(
      expected.margins.left / expected.width,
      3,
    )
    await expect(frame.getByText(contract.title, { exact: true })).toHaveCount(
      1,
    )
    for (const span of contract.canonicalSpans) {
      await expect(frame.getByText(span.text, { exact: true })).toHaveCount(1)
    }
    for (const heading of contract.headings) {
      const renderedLevel = Math.min(3, heading.level + 1)
      await expect(
        frame.locator(`h${renderedLevel}`, {
          hasText: new RegExp(
            `^${heading.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          ),
        }),
      ).toHaveCount(1)
    }
    const previewListItems = await frame
      .locator('.publication-list-item')
      .evaluateAll((items) =>
        items.map((item) => ({
          text: [...item.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
          level: Number(item.getAttribute('data-list-level')),
          ordered: item.parentElement?.tagName === 'OL',
        })),
      )
    expect(previewListItems).toEqual([
      ...contract.listItems.map(({ text, level, ordered }) => ({
        text,
        level,
        ordered,
      })),
      ...contract.references.map((text) => ({
        text,
        level: 1,
        ordered: true,
      })),
    ])
    await expect(frame.locator('strong', { hasText: /^bold$/ })).toHaveCount(1)
    await expect(frame.locator('em', { hasText: /^italic$/ })).toHaveCount(1)
    await expect(
      frame.locator('strong > em', { hasText: /^combined$/ }),
    ).toHaveCount(1)
    const expectedSafeLink = contract.inlineSemantics.find(
      (semantic) => semantic.href,
    )
    if (!expectedSafeLink?.href) {
      throw new Error('Safe-link contract is incomplete')
    }
    const safeLink = frame.locator(
      `a[role="link"][data-original-href="${expectedSafeLink.href}"] > em`,
      { hasText: /^safe link$/ },
    )
    await expect(safeLink).toHaveCount(1)
    await expect(safeLink.locator('..')).not.toHaveAttribute('href')
    await expect(safeLink.locator('..')).toHaveAttribute('tabindex', '0')
    await expect(frame.locator('sub', { hasText: /^2$/ })).toHaveCount(1)
    await expect(
      frame.locator('a[epub\\:type="noteref"] > sup', { hasText: /^1$/ }),
    ).toHaveCount(1)
    const note = frame.locator('aside[role="doc-footnote"]')
    await expect(note).toContainText(contract.note.text)
    const noteBacklink = note.locator('.note-backlink')
    await expect(noteBacklink).toHaveAttribute('href', /^#.+/)
    for (const visual of contract.visuals) {
      await expect(
        frame.locator(`figure[data-object-type="${visual.kind}"]`),
      ).toHaveCount(1)
      await expect(
        frame.getByText(visual.caption, { exact: true }),
      ).toHaveCount(1)
    }
    await expect(frame.locator('.figure-placeholder')).toHaveCount(0)
    const tableContract = contract.visuals.find(
      (visual) => visual.kind === 'table',
    )
    if (!tableContract?.rows) throw new Error('Table contract is incomplete')
    const table = frame.locator('table')
    await expect(table).toHaveCount(1)
    await expect(table.locator('thead tr')).toHaveCount(1)
    await expect(table.locator('tbody tr')).toHaveCount(
      tableContract.rows.length - 1,
    )
    expect(
      await table
        .locator('tr')
        .evaluateAll((rows) =>
          rows.map((row) =>
            [...row.querySelectorAll('th, td')].map(
              (cell) => cell.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            ),
          ),
        ),
    ).toEqual(tableContract.rows)
    expect(
      await table.locator('thead th').evaluateAll((cells) =>
        cells.map((cell) => ({
          text: cell.textContent?.trim(),
          scope: cell.getAttribute('scope'),
        })),
      ),
    ).toEqual(tableContract.rows[0].map((text) => ({ text, scope: 'col' })))
    await expect(table.locator('tbody th')).toHaveCount(0)
    await expect(frame.locator('img')).not.toHaveCount(0)
    expect(
      await frame.locator('img').evaluateAll((images) =>
        images.every((image) => {
          const imageBox = image.getBoundingClientRect()
          const containerBox =
            image.parentElement?.getBoundingClientRect() ??
            image.closest('main')?.getBoundingClientRect()
          return (
            imageBox.width > 0 &&
            imageBox.height > 0 &&
            (!containerBox || imageBox.width <= containerBox.width + 1)
          )
        }),
      ),
    ).toBe(true)
    expect(
      await frame
        .locator('[data-wide-source-visual="true"]')
        .evaluateAll((visuals) =>
          visuals.every(
            (visual) => visual.scrollWidth <= visual.clientWidth + 1,
          ),
        ),
    ).toBe(true)
    await expect(frame.locator('main')).not.toContainText('discre-tionary')
    await expect(
      frame.locator('main p').filter({ hasText: /^\s*[A-Za-z]\s*$/ }),
    ).toHaveCount(0)
    expect(
      await frame
        .locator('html')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    expect(
      await frame.locator('main').evaluate((main) => {
        const probe = document.createElement('h3')
        probe.textContent = 'W'.repeat(256)
        main.append(probe)
        const fits =
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
        probe.remove()
        return fits
      }),
    ).toBe(true)

    const previewCanonicalIds = await frame
      .locator('[data-canonical-id]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-canonical-id')),
      )
    expect(new Set(previewCanonicalIds).size).toBe(previewCanonicalIds.length)

    const link = page.getByRole('link', { name: ui.download, exact: true })
    await expect(link).toHaveAttribute('data-profile-id', expected.id)
    await expect(link).toHaveAttribute('data-profile-version', expected.version)
    await expect(link).toHaveAttribute('data-artifact-sha256', previewHash!)
    const bytes = await downloadBytes(page, ui.download)
    const downloadedHash = createHash('sha256').update(bytes).digest('hex')
    expect(downloadedHash).toBe(previewHash)
    const files = unzipSync(bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('class="semantic-table-wrapper"')
    expect(content).toContain('<thead>')
    expect(content).toContain('<tbody>')
    const downloadedTable = await page.evaluate((xhtml) => {
      const document = new DOMParser().parseFromString(
        xhtml,
        'application/xhtml+xml',
      )
      const parserError = document.querySelector('parsererror')
      if (parserError) throw new Error(parserError.textContent ?? 'Invalid XML')
      const table = document.querySelector('table')
      if (!table) throw new Error('Downloaded EPUB has no semantic table')
      return {
        headers: [...table.querySelectorAll('thead th')].map((cell) => ({
          scope: cell.getAttribute('scope'),
          text: cell.textContent,
        })),
        rows: [...table.querySelectorAll('tbody tr')].map((row) =>
          [...row.querySelectorAll('td')].map((cell) => cell.textContent),
        ),
      }
    }, content)
    expect(downloadedTable.headers).toEqual(
      tableContract.rows[0].map((cell) => ({ scope: 'col', text: cell })),
    )
    expect(downloadedTable.rows).toEqual(tableContract.rows.slice(1))
    expect(content).toContain('<strong>bold</strong>')
    expect(content).toContain('<em>italic</em>')
    expect(content).toContain('<strong><em>combined</em></strong>')
    expect(content).toContain(
      '<a href="https://example.com/fidelity-evidence"><em>safe link</em></a>',
    )
    expect(content).toContain('<sub>2</sub>')
    expect(content).toMatch(
      /<a\b[^>]*epub:type="noteref"[^>]*><sup>1<\/sup><\/a>/,
    )
    expect(content).not.toContain('<object')
    const manifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as (typeof downloaded)[number]['manifest']
    expect(manifest.profile).toMatchObject({
      id: expected.id,
      version: expected.version,
    })
    expect(previewCanonicalIds).toEqual(manifest.canonicalNodeIds)
    for (const asset of manifest.assets) {
      expect(files[`EPUB/${asset.href}`]).toBeTruthy()
    }
    downloaded.push({
      profileId: expected.id,
      hash: downloadedHash,
      manifest,
    })
  }

  expect(downloadCount).toBe(contract.profiles.length)
  expect(new Set(downloaded.map(({ hash }) => hash)).size).toBe(
    contract.profiles.length,
  )
  const canonicalGraphs = downloaded.map(({ manifest }) => ({
    canonicalContentSha256: manifest.canonicalContentSha256,
    canonicalNodeIds: manifest.canonicalNodeIds,
    visualRelationships: manifest.visualRelationships.map(
      ({ kind, canonicalNodeId, captionNodeId }) => ({
        kind,
        canonicalNodeId,
        captionNodeId,
      }),
    ),
  }))
  expect(canonicalGraphs).toEqual([
    canonicalGraphs[0],
    canonicalGraphs[0],
    canonicalGraphs[0],
  ])

  // Keep both e-ink frames on one physical scale even when the viewport is
  // narrower than Paper Pro. The stage may scroll; the page itself may not.
  await page.setViewportSize({ width: 360, height: 900 })
  const moveProfile = contract.profiles.find(
    (profile) => profile.id === 'paperProMove',
  )!
  const proProfile = contract.profiles.find(
    (profile) => profile.id === 'paperPro',
  )!
  const frameWidths: Record<'paperProMove' | 'paperPro', number> = {
    paperProMove: 0,
    paperPro: 0,
  }
  for (const profileId of ['paperProMove', 'paperPro'] as const) {
    const ui = profileUi[profileId]
    await page
      .locator('.epub-device-switcher')
      .getByText(ui.label, { exact: true })
      .locator('..')
      .click()
    const device = page.locator(
      `.epub-preview-device[data-device="${profileId}"]`,
    )
    const box = await device.boundingBox()
    expect(box).not.toBeNull()
    frameWidths[profileId] = box!.width
    expect(box!.width).toBeCloseTo(
      contract.profiles.find((profile) => profile.id === profileId)!
        .previewWidthCssPx,
      0,
    )
  }
  expect(frameWidths.paperProMove / frameWidths.paperPro).toBeCloseTo(
    moveProfile.width /
      moveProfile.pixelsPerInch! /
      (proProfile.width / proProfile.pixelsPerInch!),
    2,
  )
  const narrowStage = page.locator('.epub-preview-stage')
  await expect(narrowStage).toHaveAttribute('tabindex', '0')
  await expect(narrowStage).toHaveAccessibleName(
    'Scrollable Paper Pro EPUB viewport',
  )
  const [stageBox, proBox] = await Promise.all([
    narrowStage.boundingBox(),
    page.locator('.epub-preview-device[data-device="paperPro"]').boundingBox(),
  ])
  expect(stageBox).not.toBeNull()
  expect(proBox).not.toBeNull()
  expect(proBox!.x).toBeGreaterThanOrEqual(stageBox!.x - 1)
  expect(
    await narrowStage.evaluate(
      (stage) => stage.scrollWidth > stage.clientWidth,
    ),
  ).toBe(true)
  expect(
    await page
      .locator('html')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true)
})

test('invalidates preview receipts and object URLs before reusing a filename', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const trackedWindow = window as unknown as Window & {
      __createdFidelityUrls: Array<{ url: string; type: string }>
      __revokedFidelityUrls: string[]
    }
    trackedWindow.__createdFidelityUrls = []
    trackedWindow.__revokedFidelityUrls = []
    const createObjectUrl = URL.createObjectURL.bind(URL)
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (object) => {
      const url = createObjectUrl(object)
      trackedWindow.__createdFidelityUrls.push({
        url,
        type: object instanceof Blob ? object.type : '',
      })
      return url
    }
    URL.revokeObjectURL = (url) => {
      trackedWindow.__revokedFidelityUrls.push(url)
      revokeObjectUrl(url)
    }
  })

  const first = await readFile(fixture)
  const second = await readFile(
    path.resolve('tests', 'fixtures', 'pdf', 'born-digital.pdf'),
  )
  const equalLength = Math.max(first.byteLength, second.byteLength)
  const padded = (bytes: Buffer) => {
    const result = Buffer.alloc(equalLength, 0x20)
    bytes.copy(result)
    return result
  }
  const upload = (buffer: Buffer) => ({
    name: 'same-paper.pdf',
    mimeType: 'application/pdf',
    buffer: padded(buffer),
  })

  await page.goto('/research/studio')
  await waitForImporter(page)
  await page.locator('#publication-pdf').setInputFiles(upload(first))
  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  })

  const firstPreview = page.locator('.epub-rendition-preview')
  const firstHash = await firstPreview.getAttribute('data-artifact-sha256')
  const firstHref = await page
    .getByRole('link', { name: 'Download Mobile EPUB', exact: true })
    .getAttribute('href')
  expect(firstHash).toMatch(/^[a-f0-9]{64}$/)
  expect(firstHref).toMatch(/^blob:/)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tracker = window as Window & {
          __createdFidelityUrls?: Array<{ url: string; type: string }>
        }
        const entries = tracker.__createdFidelityUrls ?? []
        return {
          epub: entries.filter(({ type }) => type === 'application/epub+zip')
            .length,
          images: entries.filter(({ type }) => type.startsWith('image/'))
            .length,
        }
      }),
    )
    .toEqual({
      epub: 1,
      images: contract.visuals.filter((visual) => visual.kind !== 'table')
        .length,
    })
  const firstUrls = await page.evaluate(() =>
    (
      window as Window & {
        __createdFidelityUrls?: Array<{ url: string; type: string }>
      }
    ).__createdFidelityUrls?.map(({ url }) => url),
  )
  expect(firstUrls).toBeDefined()
  expect(firstUrls!.length).toBeGreaterThan(1)

  await page.getByRole('button', { name: 'New paper' }).click()
  await expect(firstPreview).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Download Mobile EPUB', exact: true }),
  ).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        (oldHref) =>
          (
            window as Window & {
              __revokedFidelityUrls?: string[]
            }
          ).__revokedFidelityUrls?.filter((url) => url === oldHref).length ?? 0,
        firstHref,
      ),
    )
    .toBe(1)
  await expect
    .poll(() =>
      page.evaluate(
        (urls) =>
          urls.map(
            (url) =>
              (
                window as Window & {
                  __revokedFidelityUrls?: string[]
                }
              ).__revokedFidelityUrls?.filter((candidate) => candidate === url)
                .length ?? 0,
          ),
        firstUrls!,
      ),
    )
    .toEqual(firstUrls!.map(() => 1))

  await page.locator('#publication-pdf').setInputFiles(upload(second))
  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.locator('.publication-result-bar strong')).toHaveText(
    'same-paper.pdf',
  )
  const secondPreview = page.locator('.epub-rendition-preview')
  const secondHash = await secondPreview.getAttribute('data-artifact-sha256')
  const secondHref = await page
    .getByRole('link', { name: 'Download Mobile EPUB', exact: true })
    .getAttribute('href')
  expect(secondHash).toMatch(/^[a-f0-9]{64}$/)
  expect(secondHash).not.toBe(firstHash)
  expect(secondHref).toMatch(/^blob:/)
  expect(secondHref).not.toBe(firstHref)
  expect(
    await page.evaluate(
      (oldHref) =>
        (
          window as Window & { __revokedFidelityUrls?: string[] }
        ).__revokedFidelityUrls?.filter((url) => url === oldHref).length ?? 0,
      firstHref,
    ),
  ).toBe(1)
  await expect(
    page
      .getByTitle('Generated EPUB rendition on Mobile')
      .contentFrame()
      .getByText(contract.title, { exact: true }),
  ).toHaveCount(0)
})
