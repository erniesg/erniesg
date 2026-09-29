import { expect, test, type Page } from '@playwright/test'

/**
 * The in-browser exercise runner, against a stand-in Python whose load time and
 * run time the test controls. Two rules:
 *
 * - The run budget counts only the reader's code. Loading Python has its own
 *   budget, so a slow first download is never reported as an endless loop.
 * - Every run gets its own reply. Two checks started together each resolve
 *   with their own output, never with the other's, and never by timing out.
 */
const CHAPTER = '/ch06-dicts-sets'
const FIRST = 'ch06-price-or-zero'
const SECOND = 'ch06-smallest-missing'

function fakePython(loadMs: number) {
  // No single quotes: the URL is embedded in a single-quoted importScripts call.
  const source = `
self.loadPyodide = () => new Promise(resolve => setTimeout(() => resolve({
  globals: { get: () => () => ({}) },
  setStdout(options) { self.__out = options.batched },
  setStderr() {},
  async runPythonAsync(code) {
    const delay = Number((code.match(/# delay (\\d+)/) || [0, 0])[1])
    if (delay) await new Promise(done => setTimeout(done, delay))
    const flood = Number((code.match(/# flood (\\d+)/) || [0, 0])[1])
    for (let i = 0; i < flood; i += 1) self.__out("flood line " + i)
    const long = Number((code.match(/# long (\\d+)/) || [0, 0])[1])
    if (long) self.__out("x".repeat(long))
    for (const found of code.matchAll(/print\\("([^"]*)"\\)/g)) self.__out(found[1])
  },
}), ${loadMs}))
`
  return 'data:text/javascript,' + encodeURIComponent(source).replace(/'/g, '%27')
}

async function useFakePython(page: Page, loadMs: number) {
  await page.addInitScript((url) => {
    ;(window as unknown as { __bookPyodideUrl: string }).__bookPyodideUrl = url
  }, fakePython(loadMs))
}

async function check(page: Page, id: string, source: string) {
  const ex = page.locator(`#ex-${id}`)
  await ex.locator('.editor').fill(source)
  await ex.locator('.check').click()
  return ex
}

test('a slow Python load does not spend the run budget', async ({ page }) => {
  test.setTimeout(60_000)
  // Longer than the whole 8 s run budget: timing from the click would stop it.
  await useFakePython(page, 9_000)
  await page.goto(CHAPTER)
  const ex = await check(page, FIRST, 'print("loaded-then-ran")')
  await expect(ex.locator('.results')).toBeVisible({ timeout: 30_000 })
  await expect(ex.locator('.results')).toContainText('loaded-then-ran')
  await expect(ex.locator('.results')).not.toContainText('Stopped after')
})

test('a print in a loop is kept up to the cap, not in full (#398)', async ({ page }) => {
  test.setTimeout(60_000)
  await useFakePython(page, 100)
  await page.goto(CHAPTER)
  const ex = await check(page, FIRST, '# flood 200000\nprint("after-the-flood")')
  const results = ex.locator('.results')
  await expect(results).toBeVisible({ timeout: 30_000 })
  await expect(results).toContainText('flood line 0')
  // the worker kept 20,000 characters; the rest arrive as one count, and the
  // extra lines beyond it are one row, not thousands
  await expect(results).toContainText(/…and \d+ more lines no test asked for/)
  expect(await results.locator('li.case').count()).toBeLessThanOrEqual(2 + 5 + 1)
  const text = (await results.textContent()) ?? ''
  expect(text.length).toBeLessThan(2_000)
})

test('one line longer than the cap is cut and says so (#398)', async ({ page }) => {
  test.setTimeout(60_000)
  await useFakePython(page, 100)
  await page.goto(CHAPTER)
  const ex = await check(page, FIRST, '# long 100000')
  const results = ex.locator('.results')
  await expect(results).toBeVisible({ timeout: 30_000 })
  // the worker says the line was cut, and the page shows only its start
  await expect(results).toContainText('truncated, the rest of the last line')
  const text = (await results.textContent()) ?? ''
  expect(text.length).toBeLessThan(2_000)
})

test('two checks at once each get their own output', async ({ page }) => {
  test.setTimeout(60_000)
  await useFakePython(page, 100)
  await page.goto(CHAPTER)
  const first = await check(page, FIRST, '# delay 1500\nprint("from-the-first")')
  const second = await check(page, SECOND, 'print("from-the-second")')
  await expect(first.locator('.results')).toBeVisible({ timeout: 30_000 })
  await expect(second.locator('.results')).toBeVisible({ timeout: 30_000 })
  await expect(first.locator('.results')).toContainText('from-the-first')
  await expect(first.locator('.results')).not.toContainText('Stopped after')
  await expect(second.locator('.results')).toContainText('from-the-second')
  await expect(second.locator('.results')).not.toContainText('from-the-first')
})
