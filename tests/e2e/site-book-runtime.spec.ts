import { expect, test, type Page } from '@playwright/test'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * The published book's page code, as the site serves it (#380). Every other
 * exercise spec runs against `books/tools/preview.py`, which is how the site
 * shipped Check buttons with nothing behind them and nobody noticed. These run
 * against the Astro build.
 *
 * Python is a stand-in that prints each `print("...")` literal.
 */
const CHAPTER = '/books/build-a-coding-agent/ch07-strings/'
const NEXT_CHAPTER = '/books/build-a-coding-agent/ch08-errors/'
const CHALLENGE = '/books/build-a-coding-agent/pool-ticket-price/'

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

/** An anonymous reader: the margin service answers, nobody is signed in. */
async function mount(page: Page) {
  await installStaticRoutes(page)
  const repository = new D1MarginRepository(SqliteD1Database.inMemory())
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, canWrite: false, isAdmin: false }),
    }),
  )
  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    const response = await handleMarginRequest(
      new Request(incoming.url(), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: incoming.postData() ?? undefined }),
      }),
      {
        repository,
        principal: null,
        now: () => new Date(Date.UTC(2026, 8, 28, 12)).toISOString(),
        newId: () => 'annotation-1',
      },
    )
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
  })
  await page.addInitScript((url) => {
    ;(window as unknown as { __bookPyodideUrl: string }).__bookPyodideUrl = url
  }, fakePython())
}

async function answer(page: Page, sectionId: string) {
  const expected = (await page.locator(`#${sectionId}`).getAttribute('data-expected')) ?? ''
  return expected
    .replace(/^\n+|\n+$/g, '')
    .split('\n')
    .map((line) => `print("${line.trimEnd()}")`)
    .join('\n')
}

test('a published chapter checks an exercise in the browser', async ({ page }) => {
  await mount(page)
  await page.goto(CHAPTER)
  const section = page.locator('.exercise').first()
  const id = (await section.getAttribute('id')) ?? ''
  await section.locator('.editor').fill(await answer(page, id))
  await section.locator('.check').click()
  await expect(section.locator('.results')).toHaveClass(/pass/, { timeout: 30_000 })
  await expect(section.locator('.results-head')).toContainText('passed')
})

test('published editors get the preview editor: colour, line numbers and the Python keys', async ({ page }) => {
  await mount(page)
  await page.goto(CHAPTER)
  const section = page.locator('.exercise').first()
  const editor = section.locator('.editor')
  // Syntax colour and line numbers are a highlighted copy drawn under the textarea.
  await expect(section.locator('.code-wrap .code-hl')).toHaveCount(1)
  await expect(section.locator('.code-wrap .code-gutter')).toHaveCount(1)
  await editor.fill('')
  await editor.focus()
  await page.keyboard.type('for x in range(2):')
  await page.keyboard.press('Enter')
  await page.keyboard.type('print(x)')
  await expect(editor).toHaveValue('for x in range(2):\n    print(x)')
  await expect(section.locator('.code-hl .kw').first()).toHaveText('for')
  await expect(section.locator('.code-gutter')).toHaveText('1\n2')
  // The coloured copy sits exactly under the typed text, clear of the line
  // numbers. The site's own `pre` styles must not reach the editor's layers.
  const layers = await section.evaluate((ex) => {
    const px = (sel: string, prop: string) =>
      parseFloat(getComputedStyle(ex.querySelector(sel) as Element).getPropertyValue(prop))
    return {
      editorLeft: px('.editor', 'padding-left'),
      hlLeft: px('.code-hl', 'padding-left'),
      editorTop: px('.editor', 'padding-top'),
      hlTop: px('.code-hl', 'padding-top'),
      gutter: (ex.querySelector('.code-gutter') as HTMLElement).getBoundingClientRect().width,
    }
  })
  expect(layers.hlLeft).toBeCloseTo(layers.editorLeft, 0)
  expect(layers.hlTop).toBeCloseTo(layers.editorTop, 0)
  expect(layers.hlLeft).toBeGreaterThan(layers.gutter)
  // Tab indents to the next four-space stop instead of leaving the editor.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(editor).toHaveValue('for x in range(2):\n    print(x)\n        ')
  await expect(editor).toBeFocused()
  // Cmd/Ctrl+Enter checks, as the button's own shortcut says.
  const id = (await section.getAttribute('id')) ?? ''
  await editor.fill(await answer(page, id))
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(section.locator('.results')).toHaveClass(/pass/, { timeout: 30_000 })
})

test('editors and Check still work after the site swaps pages without a reload', async ({ page }) => {
  await mount(page)
  await page.goto(CHAPTER)
  await expect(page.locator('.exercise .code-wrap').first()).toBeVisible()
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true))
  // A DOM click, which the router intercepts like a reader's: what is under
  // test is the page after the swap, not reaching the contents rail.
  await page.locator(`a[href="${NEXT_CHAPTER}"]`).first().evaluate((a) => (a as HTMLAnchorElement).click())
  await expect(page).toHaveURL(new RegExp(`${NEXT_CHAPTER}$`))
  // Same document: the router swapped the page instead of loading a new one.
  // Chromium's `moveBefore` refused the swap while the header's islands were
  // persisted inside the persisted header, and the reader stayed put.
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true)
  // The header came across whole, its controls still working.
  await expect(page.locator('header').getByRole('button', { name: 'Toggle theme' })).toBeVisible()
  const section = page.locator('.exercise').first()
  await expect(section.locator('.code-wrap')).toHaveCount(1)
  const id = (await section.getAttribute('id')) ?? ''
  await section.locator('.editor').fill(await answer(page, id))
  await section.locator('.check').click()
  await expect(section.locator('.results')).toHaveClass(/pass/, { timeout: 30_000 })
})

test('a published challenge offers no button it cannot back, and says where to grade', async ({ page }) => {
  await mount(page)
  await page.goto(CHALLENGE)
  await expect(page.locator('.book-content button.run, .book-content button.exec')).toHaveCount(0)
  await expect(page.locator('.book-content')).toContainText("from a terminal with the book's grader")
  // Every Check button a published page does show is one the page can run.
  for (const button of await page.locator('.book-content .exercise .check').all()) {
    await expect(button).toBeEnabled()
  }
})
