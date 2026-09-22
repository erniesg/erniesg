import { expect, test } from '@playwright/test'

// Spec 064: something to write before the chapter ends, checked in the browser.
const CHAPTER = '/ch06-dicts-sets'
const ID = '#ex-ch06-smallest-missing'

test('a wrong answer shows produced beside expected; a right one passes', async ({ page }) => {
  test.setTimeout(90_000) // the first check downloads Pyodide
  let serverRan = false
  page.on('request', r => { if (r.url().includes('/api/')) serverRan = true })
  await page.goto(CHAPTER)
  const ex = page.locator(ID)
  const editor = ex.locator('.editor')

  await ex.locator('.check').click()
  await expect(ex.locator('.verdict.fail')).toBeVisible({ timeout: 60_000 })
  await expect(ex.locator('.verdict')).toContainText('Your code printed')
  await expect(ex.locator('.verdict')).toContainText('Expected')

  const answer = await ex.locator('.answer code').textContent()
  await editor.fill(answer ?? '')
  await ex.locator('.check').click()
  await expect(ex.locator('.verdict.pass')).toBeVisible({ timeout: 30_000 })
  expect(serverRan).toBe(false)
})

test('revealing the answer is a click and runs nothing', async ({ page }) => {
  await page.goto(CHAPTER)
  const ex = page.locator(ID)
  await expect(ex.locator('.answer code')).not.toBeVisible()
  await ex.locator('.answer > summary').click()
  await expect(ex.locator('.answer code')).toBeVisible()
  await expect(ex.locator('.verdict')).toBeHidden()
})

test('print renders the prompt, starter and answer with no editor', async ({ page }) => {
  const html = await (await page.request.get('/print')).text()
  const at = html.indexOf('id="ex-ch06-smallest-missing"')
  expect(at).toBeGreaterThan(-1)
  const section = html.slice(at, html.indexOf('</section>', at))
  expect(section).not.toContain('<textarea')
  expect(section).toContain('Answer')
})
