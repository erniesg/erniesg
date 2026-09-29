import { expect, test, type Page } from '@playwright/test'

/**
 * Progress in the local preview: a solved exercise and the code a reader left
 * behind survive a reload, because the page saves both to the preview's
 * progress file through /api/progress. The site runs the same page code
 * (books/tools/runtime/book-progress.mjs) against browser storage instead.
 *
 * Python is a stand-in that prints each `print("...")` literal, so a solve is
 * fast and deterministic.
 */
const CHAPTER = '/ch07-strings'
const SOLVE = 'ch07-tidy-the-order'
const DRAFT = 'ch07-receipt-line'

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

async function openChapter(page: Page) {
  await page.addInitScript((url) => {
    ;(window as unknown as { __bookPyodideUrl: string }).__bookPyodideUrl = url
  }, fakePython())
  await page.goto(CHAPTER)
}

/** An answer the stand-in Python gets right: print every expected line. */
async function passingSource(page: Page, id: string) {
  const expected = (await page.locator(`#ex-${id}`).getAttribute('data-expected')) ?? ''
  return expected
    .replace(/^\n+|\n+$/g, '')
    .split('\n')
    .map((line) => `print("${line.trimEnd()}")`)
    .join('\n')
}

test('a solved exercise and an unfinished draft both survive a reload', async ({ page }) => {
  test.setTimeout(60_000)
  await openChapter(page)
  const solving = page.locator(`#ex-${SOLVE}`)
  await solving.locator('.editor').fill(await passingSource(page, SOLVE))
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/progress') && r.request().method() === 'POST',
  )
  await solving.locator('.check').click()
  await expect(solving.locator('.results')).toHaveClass(/pass/, { timeout: 30_000 })
  await expect(solving).toHaveClass(/solved/)
  await saved

  const drafting = page.locator(`#ex-${DRAFT}`)
  const draft = '# not finished yet\nprint("half")'
  await drafting.locator('.editor').fill(draft)
  // Drafts save shortly after typing stops.
  await page.waitForResponse(
    (r) => r.url().endsWith('/api/progress') && r.request().method() === 'POST',
  )

  await page.reload()
  await expect(page.locator(`#ex-${SOLVE}`)).toHaveClass(/solved/)
  await expect(page.locator(`#ex-${DRAFT} .editor`)).toHaveValue(draft)
  // An exercise the reader never touched keeps its starter.
  const untouched = page.locator('#ex-ch07-same-address .editor')
  expect(await untouched.inputValue()).toBe(
    await untouched.evaluate((el) => (el as HTMLTextAreaElement).defaultValue),
  )
})

test('a failing check after a solve does not un-solve it', async ({ page }) => {
  test.setTimeout(60_000)
  await openChapter(page)
  const solving = page.locator(`#ex-${SOLVE}`)
  await solving.locator('.editor').fill(await passingSource(page, SOLVE))
  await solving.locator('.check').click()
  await expect(solving).toHaveClass(/solved/, { timeout: 30_000 })
  await solving.locator('.editor').fill('print("wrong")')
  await solving.locator('.check').click()
  await expect(solving.locator('.results')).toHaveClass(/fail/, { timeout: 30_000 })
  await expect(solving).toHaveClass(/solved/)
  const progress = await (await page.request.get('/api/progress')).json()
  expect(progress.solved).toContain(SOLVE)
})

test('code typed into a graded challenge survives a reload', async ({ page }) => {
  await page.goto('/sum-of-two-digits')
  const editor = page.locator('.desk .editor')
  const code = 'def solve(n):\n    return 0  # still working'
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/progress') && r.request().method() === 'POST',
  )
  await editor.fill(code)
  await saved
  await page.reload()
  await expect(page.locator('.desk .editor')).toHaveValue(code)
})

test('a draft typed just before leaving the page is still saved', async ({ page }) => {
  await openChapter(page)
  const code = '# typed then straight away left'
  await page.locator(`#ex-${DRAFT} .editor`).fill(code)
  // Well inside the save delay: the page must write it on the way out.
  await page.goto('/ch06-dicts-sets')
  await page.goto(CHAPTER)
  await expect(page.locator(`#ex-${DRAFT} .editor`)).toHaveValue(code)
})
