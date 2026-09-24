import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Rule: when a run starts, nothing the previous run showed is still showing.
 * It holds for every runner on the page: the four-tier desk, the inline
 * exercise and the runnable cell. A stale red verdict beside a run that has
 * not finished (or that never finishes, because the request failed) reads as
 * the new result.
 */
const FAILING_GRADE = {
  ok: false,
  tiers: [{ tier: 'public', outcome: 'fail' }],
  stopped_at: 'public',
  output: 'Traceback: the old failure',
  summary: 'the old failure',
}

// Long enough that only clearing at the start, not the next result arriving,
// can satisfy the during-run assertions below.
function slowly(route: Route, body: unknown, ms = 8_000) {
  return new Promise<void>((done) =>
    setTimeout(() => {
      route.fulfill({ json: body }).then(done, done)
    }, ms),
  )
}

async function answerInTurn(page: Page, url: string, answers: ((route: Route) => Promise<void>)[]) {
  let call = 0
  await page.route(url, (route) => answers[Math.min(call++, answers.length - 1)](route))
}

test('the desk clears its verdict and full output when a rerun starts', async ({ page }) => {
  test.setTimeout(30_000)
  await answerInTurn(page, '**/api/grade', [
    (route) => route.fulfill({ json: FAILING_GRADE }),
    (route) => slowly(route, { ...FAILING_GRADE, ok: true, tiers: [], output: '', summary: '' }),
  ])
  await page.goto('/max-pairwise-product')
  const desk = page.locator('.desk').first()
  await desk.locator('.run').click()
  await expect(desk.locator('.desk-verdict')).toBeVisible()
  await expect(desk.locator('.full-output')).toBeVisible()

  await desk.locator('.run').click()
  await expect(desk.locator('.run')).toBeDisabled()
  await expect(desk.locator('.desk-verdict')).toBeHidden({ timeout: 1_000 })
  await expect(desk.locator('.full-output')).toBeHidden({ timeout: 1_000 })
  await expect(desk.locator('.tiers')).toBeEmpty({ timeout: 1_000 })
})

test('a failed request does not leave the previous verdict up', async ({ page }) => {
  await answerInTurn(page, '**/api/grade', [
    (route) => route.fulfill({ json: FAILING_GRADE }),
    (route) => route.abort(),
  ])
  await page.goto('/max-pairwise-product')
  const desk = page.locator('.desk').first()
  await desk.locator('.run').click()
  await expect(desk.locator('.desk-verdict')).toBeVisible()
  await desk.locator('.run').click()
  await expect(desk.locator('.run')).toBeEnabled()
  await expect(desk.locator('.desk-verdict')).toBeHidden()
  await expect(desk.locator('.full-output')).toBeHidden()
})

test('a runnable cell clears its output and error state when a rerun starts', async ({ page }) => {
  test.setTimeout(30_000)
  await answerInTurn(page, '**/api/exec', [
    (route) => route.fulfill({ json: { output: 'KeyError: old', ok: false } }),
    (route) => slowly(route, { output: 'new', ok: true }),
  ])
  await page.goto('/ch06-dicts-sets')
  const cell = page.locator('.cell-run').first()
  await cell.locator('.exec').click()
  await expect(cell.locator('.output')).toHaveClass(/error/)
  await cell.locator('.exec').click()
  await expect(cell.locator('.exec')).toBeDisabled()
  await expect(cell.locator('.output')).toBeEmpty({ timeout: 1_000 })
  await expect(cell.locator('.output')).not.toHaveClass(/error/, { timeout: 1_000 })
})

test('an exercise hides its previous results when a recheck starts', async ({ page }) => {
  test.setTimeout(60_000)
  const source = `
self.loadPyodide = async () => ({
  globals: { get: () => () => ({}) },
  setStdout(options) { self.__out = options.batched },
  setStderr() {},
  async runPythonAsync(code) {
    if (code.includes("slow")) await new Promise(done => setTimeout(done, 6000))
    self.__out("printed")
  },
})
`
  await page.addInitScript((url) => {
    ;(window as unknown as { __bookPyodideUrl: string }).__bookPyodideUrl = url
  }, 'data:text/javascript,' + encodeURIComponent(source).replace(/'/g, '%27'))
  await page.goto('/ch06-dicts-sets')
  const ex = page.locator('#ex-ch06-price-or-zero')
  await ex.locator('.editor').fill('fast')
  await ex.locator('.check').click()
  await expect(ex.locator('.results')).toBeVisible()
  await ex.locator('.editor').fill('slow')
  await ex.locator('.check').click()
  await expect(ex.locator('.check')).toBeDisabled()
  await expect(ex.locator('.results')).toBeHidden({ timeout: 1_000 })
  await expect(ex.locator('.results')).toBeVisible({ timeout: 15_000 })
})
