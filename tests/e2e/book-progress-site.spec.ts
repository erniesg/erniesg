import { expect, test, type Page } from '@playwright/test'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * Reading progress on the published book. The page code is the local
 * preview's (books/tools/runtime/book-progress.mjs); here it keeps progress in
 * the browser, and for a signed-in reader who may write, in their margin
 * account through the real router over SQLite.
 *
 * Python is a stand-in that prints each `print("...")` literal.
 */
const CHAPTER = '/books/build-a-coding-agent/ch07-strings/'
const SOLVE = 'ch07-tidy-the-order'
const DRAFT = 'ch07-receipt-line'

const OWNER: Principal = {
  provider: 'workos',
  issuer: 'https://api.workos.com/',
  subject: 'user_owner',
  email: 'hello@ernie.sg',
}

function fakePython() {
  const source = `
self.loadPyodide = () => Promise.resolve({
  globals: { get: () => () => ({}) },
  setStdout(options) { self.__out = options.batched },
  setStderr() {},
  async runPythonAsync(code) {
    for (const found of code.matchAll(/print\\("([^"]*)"\\)/g)) self.__out(found[1])
  },
})
`
  return 'data:text/javascript,' + encodeURIComponent(source).replace(/'/g, '%27')
}

type Account = { principal: Principal | null; canWrite: boolean; patches: unknown[] }

/** /auth/me and the margin routes, answered in-process by the real router. */
async function mountAccount(page: Page, account: Account) {
  await installStaticRoutes(page)
  const repository = new D1MarginRepository(SqliteD1Database.inMemory())
  let clock = 0
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: Boolean(account.principal),
        canWrite: account.canWrite,
        isAdmin: false,
      }),
    }),
  )
  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    if (method === 'PATCH') account.patches.push(JSON.parse(incoming.postData() ?? '{}'))
    const response = await handleMarginRequest(
      new Request(incoming.url(), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: incoming.postData() ?? undefined }),
      }),
      {
        repository,
        principal: account.principal,
        now: () => new Date(Date.UTC(2026, 8, 28, 12, 0, 0, (clock += 1))).toISOString(),
        newId: () => `annotation-${(clock += 1)}`,
      },
    )
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    })
  })
}

/**
 * Playwright answers with the route registered last, so the static site goes
 * in before the account routes, never after: it would answer them with 404s.
 */
async function open(page: Page) {
  await page.addInitScript((url) => {
    ;(window as unknown as { __bookPyodideUrl: string }).__bookPyodideUrl = url
  }, fakePython())
  await page.goto(CHAPTER)
  await expect(page.locator('[data-progress-count]')).toContainText('/55 exercises')
}

async function solve(page: Page, id: string) {
  const section = page.locator(`#ex-${id}`)
  const expected = (await section.getAttribute('data-expected')) ?? ''
  const source = expected
    .replace(/^\n+|\n+$/g, '')
    .split('\n')
    .map((line) => `print("${line.trimEnd()}")`)
    .join('\n')
  await section.locator('.editor').fill(source)
  await section.locator('.check').click()
  await expect(section.locator('.results')).toHaveClass(/pass/, { timeout: 30_000 })
  await expect(section).toHaveClass(/solved/)
}

test('the published book grades an exercise and remembers it, and the draft, across a reload', async ({ page }) => {
  await mountAccount(page, { principal: null, canWrite: false, patches: [] })
  await open(page)
  await expect(page.locator('[data-progress-count]')).toHaveText('0/55 exercises · 0/30 challenges solved')
  await solve(page, SOLVE)
  await expect(page.locator('[data-progress-count]')).toHaveText('1/55 exercises · 0/30 challenges solved')
  await page.locator(`#ex-${DRAFT} .editor`).fill('# half done\nprint("x")')
  await expect(page.locator('[data-progress-status]')).toHaveText('Saved in this browser.')
  // Let the draft's short save delay pass.
  await page.waitForTimeout(1200)

  await page.reload()
  await expect(page.locator(`#ex-${SOLVE}`)).toHaveClass(/solved/)
  await expect(page.locator(`#ex-${DRAFT} .editor`)).toHaveValue('# half done\nprint("x")')
  await expect(page.locator('[data-progress-count]')).toHaveText('1/55 exercises · 0/30 challenges solved')
})

test('a signed-in reader who may write gets progress back from their account in a fresh browser', async ({ page, context }) => {
  const account: Account = { principal: OWNER, canWrite: true, patches: [] }
  await mountAccount(page, account)
  await open(page)
  await expect(page.locator('[data-progress-status]')).toHaveText('Saved in this browser and to your account.')
  await solve(page, SOLVE)
  await expect.poll(() => account.patches.length).toBeGreaterThan(0)

  // A different browser: nothing stored locally, the account still knows.
  await context.clearCookies()
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.locator(`#ex-${SOLVE}`)).toHaveClass(/solved/)
  await expect(page.locator('[data-progress-count]')).toHaveText('1/55 exercises · 0/30 challenges solved')
})

test('export and import carry progress, merged, never replaced', async ({ page }) => {
  await mountAccount(page, { principal: null, canWrite: false, patches: [] })
  await open(page)
  await solve(page, SOLVE)

  const download = page.waitForEvent('download')
  await page.locator('[data-progress-export]').click()
  const file = await (await download).path()
  const { readFile } = await import('node:fs/promises')
  const exported = JSON.parse(await readFile(file!, 'utf8'))
  expect(exported).toMatchObject({ version: 1, book: 'build-a-coding-agent', solved: [SOLVE] })

  // A file from the local preview: a challenge only the preview can grade.
  await page.locator('[data-progress-import-file]').setInputFiles({
    name: 'progress.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ solved: ['sum-of-two-digits'] })),
  })
  await expect(page.locator('[data-progress-status]')).toHaveText(
    'Imported: 1 newly solved. Saved in this browser.',
  )
  // A file that belongs to another book is refused, not re-keyed.
  await page.locator('[data-progress-import-file]').setInputFiles({
    name: 'other.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, book: 'another-book', solved: ['ch07-receipt-line'] })),
  })
  await expect(page.locator('[data-progress-status]')).toContainText(
    'That file is progress for another book (another-book).',
  )
  await expect(page.locator('#ex-ch07-receipt-line')).not.toHaveClass(/solved/)
  await expect(page.locator('[data-progress-count]')).toHaveText('1/55 exercises · 1/30 challenges solved')
  await expect(page.locator(`#ex-${SOLVE}`)).toHaveClass(/solved/)
  await expect(page.locator('a[data-progress-items="sum-of-two-digits"]')).toHaveAttribute('data-progress-done', '')
})

test('the page works with browser storage blocked', async ({ page }) => {
  await mountAccount(page, { principal: null, canWrite: false, patches: [] })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
  })
  await open(page)
  await solve(page, SOLVE)
  await expect(page.locator('[data-progress-count]')).toHaveText('1/55 exercises · 0/30 challenges solved')
})

test('a draft typed just before a reload is still there', async ({ page }) => {
  await mountAccount(page, { principal: null, canWrite: false, patches: [] })
  await open(page)
  const code = '# typed then reloaded at once'
  await page.locator(`#ex-${DRAFT} .editor`).fill(code)
  await page.reload()
  await expect(page.locator(`#ex-${DRAFT} .editor`)).toHaveValue(code)
})
