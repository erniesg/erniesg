import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
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
const CELLS = '/books/build-a-coding-agent/ch02-conditionals/'

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
async function mount(page: Page, python: 'fake' | 'real' = 'fake') {
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
  // The desk runs the real grader (unittest, bookgrader, grader_observe), which
  // no stand-in can fake, so those tests load real Pyodide: from the CDN the
  // page uses, or from BOOK_PYODIDE_URL where there is no network.
  const url = python === 'fake' ? fakePython() : process.env.BOOK_PYODIDE_URL
  if (url) {
    await page.addInitScript((pyodide) => {
      ;(window as unknown as { __bookPyodideUrl: string }).__bookPyodideUrl = pyodide
    }, url)
  }
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
  // The editor's layers stack inside its own terminal, never above the page's
  // overlays: the margin popup, drawn over the text, must win the click.
  for (const terminal of ['.exercise-run', '.cell-run', '.desk']) {
    for (const element of await page.locator(`.book-content ${terminal}`).all()) {
      await expect(element).toHaveCSS('isolation', 'isolate')
    }
  }
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

// A starter that prints, and is wrong only for the over-65s.
const PRINTING = `def ticket_price(age: int) -> int:
    print("checking", age)
    if age < 5:
        return 0
    if age < 18:
        return 350
    return 620
`

test('Run on a published challenge calls every sample and shows each print under its own call', async ({ page }) => {
  test.slow()
  await mount(page, 'real')
  await page.goto(CHALLENGE)
  const desk = page.locator('.desk').first()
  await desk.locator('.editor').fill(PRINTING)
  await desk.locator('.editor').focus()
  await page.keyboard.press("ControlOrMeta+'")
  await expect(desk.locator('.status')).toHaveText('Samples only. Not graded.', { timeout: 120_000 })
  await expect(desk.locator('.call-case')).toHaveCount(6)
  // Every row ran, though the last is wrong; nothing was graded.
  await expect(desk.locator('.tiers .tier')).toHaveCount(0)
  const wrong = desk.locator('.call-case.bad')
  await expect(wrong).toHaveCount(1)
  await expect(wrong.locator('.case-call')).toContainText('ticket_price(65)')
  await expect(wrong.locator('.case-got')).toContainText('returned 620, expected 400')
  await expect(wrong.locator('.case-prints')).toHaveAttribute('open', '')
  await expect(wrong.locator('.case-prints pre')).toHaveText('checking 65')
  // A right call keeps its own print, one click away.
  const first = desk.locator('.call-case').first()
  await expect(first.locator('.case-call')).toContainText('ticket_price(4)')
  await expect(first.locator('.case-prints pre')).toHaveText('checking 4')
})

test('Run all tiers grades a published challenge in the browser and records the solve', async ({ page }) => {
  test.slow()
  await mount(page, 'real')
  await page.goto(CHALLENGE)
  const desk = page.locator('.desk').first()
  await desk.locator('.editor').fill(PRINTING)
  await desk.locator('.run').click()
  await expect(desk.locator('.tiers .tier')).toHaveText(['public - fail'], { timeout: 120_000 })
  await expect(desk.locator('.desk-verdict')).toContainText('ticket_price(65) returned 620, expected 400')
  await expect(desk.locator('.call-case.bad .case-prints pre')).toHaveText('checking 65')
  await expect(page.locator('[data-progress-count]')).toContainText('0/30 challenges solved')

  await desk.locator('.editor').fill(readFileSync('books/challenges/pool-ticket-price/solution.py', 'utf8'))
  await desk.locator('.run').click()
  await expect(desk.locator('.status')).toHaveText('All four tiers green.', { timeout: 120_000 })
  await expect(desk.locator('.tiers .tier')).toHaveText([
    'public - pass',
    'edge - pass',
    'stress - pass',
    'perf - pass',
  ])
  await expect(page.locator('[data-progress-count]')).toContainText('1/30 challenges solved')
})

test("a page's unfinished run does not hold up the next page's", async ({ page }) => {
  test.slow()
  await mount(page, 'real')
  await page.goto(CELLS)
  const cell = page.locator('.cell-run').first()
  await cell.locator('.editor').fill('while True:\n    pass')
  await cell.locator('.exec').click()
  // Leave while it loops, through the site's own router.
  await page.locator(`a[href="${CHALLENGE}"]`).first().evaluate((a) => (a as HTMLAnchorElement).click())
  await expect(page).toHaveURL(new RegExp(`${CHALLENGE}$`))
  const desk = page.locator('.desk').first()
  await desk.locator('.editor').fill(PRINTING)
  const started = Date.now()
  await desk.locator('.sample').click()
  await expect(desk.locator('.status')).toHaveText('Samples only. Not graded.', { timeout: 60_000 })
  // The looping cell had 30 seconds left to run; the new page did not wait for it.
  expect(Date.now() - started).toBeLessThan(20_000)
})

test('a published runnable cell runs after the cells before it', async ({ page }) => {
  test.slow()
  await mount(page, 'real')
  await page.goto(CELLS)
  const cells = page.locator('.cell-run')
  await cells.first().locator('.editor').fill('greeting = "hello from an earlier cell"')
  const second = cells.nth(1)
  await second.locator('.editor').fill('print(greeting)')
  await second.locator('.exec').click()
  await expect(second.locator('.output')).toHaveText('hello from an earlier cell', { timeout: 120_000 })
  await expect(second.locator('.output')).not.toHaveClass(/error/)

  // A print in a loop is kept to the grader's per-call cap as it is produced,
  // and says how much it dropped, rather than filling the tab's memory.
  await second.locator('.editor').fill('for i in range(200_000):\n    print(i)')
  await second.locator('.exec').click()
  await expect(second.locator('.output')).toContainText('truncated', { timeout: 120_000 })
  const shown = await second.locator('.output').innerText()
  expect(shown.length).toBeLessThan(25_000)
  expect(shown.startsWith('0\n1\n2')).toBe(true)
})
