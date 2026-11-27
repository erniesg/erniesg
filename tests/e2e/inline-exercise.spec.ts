import { expect, test, type Page } from '@playwright/test'

// Spec 064, with results read like a grader's report: one test per expected line.
const CHAPTER = '/ch06-dicts-sets'
const STEPPING_CHAPTER = '/ch09-stepping'

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
  // Saving progress may reach the server; running the reader's code may not.
  page.on('request', r => { if (/\/api\/(exec|grade)\b/.test(r.url())) serverRan = true })
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

test('Run shows debugging prints without grading them; Check still requires exact output', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto(STEPPING_CHAPTER)
  const ex = page.locator('#ex-ch09-last-two-days')
  const debugging = `readings = [3120, 4890, 2075, 6610, 5240]

def last_n_total(n):
    total = 0
    for day in range(len(readings) - n, len(readings) - 1):
        print(day)
        total += readings[day]
    return total

print(last_n_total(2))`
  await ex.locator('.editor').fill(debugging)
  await ex.locator('.run-exercise').click()
  await expect(ex.locator('[data-exercise-output]')).toBeVisible({ timeout: 60_000 })
  await expect(ex.locator('[data-exercise-output]')).toContainText('3\n6610')
  await expect(ex.locator('.results')).toBeHidden()

  await ex.locator('.check').click()
  await expect(ex.locator('.results')).toBeVisible({ timeout: 60_000 })
  await expect(ex.locator('.results-head')).toHaveText(/0 of 1 test passed/)
  await expect(ex.locator('[data-exercise-output]')).toContainText('3\n6610')

  const answer = await ex.locator('.answer code').textContent()
  await ex.locator('.editor').fill(answer ?? '')
  await ex.locator('.run-exercise').click()
  await expect(ex.locator('[data-exercise-output]')).toContainText('11850')
  await expect(ex.locator('.results')).toBeHidden()
  await ex.locator('.check').click()
  await expect(ex.locator('.results-head')).toHaveText(/All 1 test passed/)
})

test('print renders the prompt, starter and answer with no editor', async ({ page }) => {
  const html = await (await page.request.get('/print')).text()
  const at = html.indexOf('id="ex-ch06-smallest-missing"')
  expect(at).toBeGreaterThan(-1)
  const section = html.slice(at, html.indexOf('</section>', at))
  expect(section).not.toContain('<textarea')
  expect(section).toContain('Answer')
})
