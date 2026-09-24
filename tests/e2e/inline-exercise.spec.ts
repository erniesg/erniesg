import { expect, test, type Page } from '@playwright/test'

// Spec 064, with results read like a grader's report: one test per expected line.
const CHAPTER = '/ch06-dicts-sets'

async function check(page: Page, id: string, source: string) {
  const ex = page.locator(`#ex-${id}`)
  await ex.locator('.editor').fill(source)
  await ex.locator('.check').click()
  await expect(ex.locator('.results')).toBeVisible({ timeout: 60_000 })
  return ex
}

test('a partial answer says how many tests passed and what failed', async ({ page }) => {
  test.setTimeout(90_000) // the first check downloads Pyodide
  let serverRan = false
  page.on('request', r => { if (r.url().includes('/api/')) serverRan = true })
  await page.goto(CHAPTER)
  const ex = await check(page, 'ch06-price-or-zero',
    'prices = {"rice": 3, "oil": 7}\nprint(prices.get("tea", 0))')
  await expect(ex.locator('.results-head')).toHaveText(/1 of 2 tests passed/)
  await expect(ex.locator('.case.pass')).toHaveCount(1)
  await expect(ex.locator('.case.fail')).toHaveCount(1)
  await expect(ex.locator('.case.fail')).toContainText('Test 2')
  await expect(ex.locator('.case.fail')).toContainText('expected 3')
  await expect(ex.locator('.case.fail')).toContainText('got nothing')
  // pass and fail differ by glyph, not colour alone
  await expect(ex.locator('.case.pass .mark')).toHaveText('✓')
  await expect(ex.locator('.case.fail .mark')).toHaveText('✗')
  expect(serverRan).toBe(false)
})

test('a correct answer passes every test', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto(CHAPTER)
  const answer = await page.locator('#ex-ch06-price-or-zero .answer code').textContent()
  const ex = await check(page, 'ch06-price-or-zero', answer ?? '')
  await expect(ex.locator('.results-head')).toHaveText(/All 2 tests passed/)
  await expect(ex.locator('.results')).toHaveClass(/pass/)
})

test('a crash is shown as the error, not as missing lines alone', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto(CHAPTER)
  const ex = await check(page, 'ch06-price-or-zero',
    'prices = {"rice": 3, "oil": 7}\nprint(prices["tea"])')
  await expect(ex.locator('.results-head')).toHaveText(/0 of 2 tests passed/)
  await expect(ex.locator('.case-error')).toHaveText("Crashed on line 2 · KeyError: 'tea'")
})

test('revealing the answer is a click and runs nothing', async ({ page }) => {
  await page.goto(CHAPTER)
  const ex = page.locator('#ex-ch06-smallest-missing')
  await expect(ex.locator('.answer code')).not.toBeVisible()
  await ex.locator('.answer > summary').click()
  await expect(ex.locator('.answer code')).toBeVisible()
  await expect(ex.locator('.results')).toBeHidden()
})

test('print renders the prompt, starter and answer with no editor', async ({ page }) => {
  const html = await (await page.request.get('/print')).text()
  const at = html.indexOf('id="ex-ch06-smallest-missing"')
  expect(at).toBeGreaterThan(-1)
  const section = html.slice(at, html.indexOf('</section>', at))
  expect(section).not.toContain('<textarea')
  expect(section).toContain('Answer')
})
