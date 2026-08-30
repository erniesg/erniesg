import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { installStaticRoutes } from './static-build'

const fixture = (name: string) => path.resolve('tests/fixtures/pdf', name)

test.describe.configure({ timeout: 120_000 })
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const audit: string[] = []
    Object.defineProperty(globalThis, '__studyPersistenceAudit', {
      value: audit,
    })
    const nativeSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      audit.push(`storage:${key}`)
      return nativeSetItem.call(this, key, value)
    }
    const nativeOpen = IDBFactory.prototype.open
    IDBFactory.prototype.open = function (...args) {
      audit.push(`indexeddb:${String(args[0])}`)
      return nativeOpen.apply(this, args)
    }
    if (globalThis.caches) {
      const nativeCacheOpen = globalThis.caches.open.bind(globalThis.caches)
      globalThis.caches.open = async (name) => {
        audit.push(`cache:${name}`)
        return nativeCacheOpen(name)
      }
    }
  })
  await installStaticRoutes(page)
})

test('Study uses the real file input and yields an inspected EPUB', async ({
  page,
}) => {
  await page.goto('/study/experiments/pdf-to-epub')
  const input = page.locator('#publication-pdf')
  await expect(input).toBeEnabled({ timeout: 30_000 })
  await input.setInputFiles(fixture('born-digital.pdf'))
  const link = page.getByRole('link', {
    name: 'Download Mobile EPUB',
    exact: true,
  })
  await expect(link).toBeVisible({ timeout: 45_000 })
  const downloadEvent = page.waitForEvent('download')
  await link.click()
  const download = await downloadEvent
  const saved = await download.path()
  expect(saved).toBeTruthy()
  const bytes = await readFile(saved!)
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304')
})

test('hostile PDF fails clearly without browser persistence', async ({
  page,
}) => {
  await page.goto('/study/experiments/pdf-to-epub')
  const input = page.locator('#publication-pdf')
  await expect(input).toBeEnabled({ timeout: 30_000 })
  await page.evaluate(() => {
    ;(
      globalThis as typeof globalThis & { __studyPersistenceAudit: string[] }
    ).__studyPersistenceAudit.length = 0
  })
  await input.setInputFiles(
    fixture('heldout-v1/holdout-hostile-javascript.pdf'),
  )
  const alert = page.locator('.publication-failure[role="alert"]')
  await expect(alert).toContainText('UNSUPPORTED PDF', { timeout: 30_000 })
  await expect(alert).toContainText('Nothing was saved or uploaded')
  await expect(
    page.getByRole('link', { name: /Download .*EPUB/u }),
  ).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __studyPersistenceAudit: string[]
          }
        ).__studyPersistenceAudit,
    ),
  ).toEqual([])
})
