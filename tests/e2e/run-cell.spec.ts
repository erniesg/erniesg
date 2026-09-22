import { expect, test } from '@playwright/test'

// Spec 063: a runnable cell reads as one terminal.
const CHAPTER = '/ch06-dicts-sets'

const bg = (el: Element) => getComputedStyle(el).backgroundColor

for (const width of [1280, 375]) {
  test(`code, actions and output share one surface at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(CHAPTER)
    const cell = page.locator('.cell-run').first()
    await cell.locator('.exec').click()
    await expect(cell.locator('.output')).not.toBeEmpty()
    // every block is either see-through or the terminal's own colour
    const surface = await cell.evaluate(bg)
    for (const part of ['.code-wrap', '.desk-actions', '.output']) {
      expect([surface, 'rgba(0, 0, 0, 0)']).toContain(await cell.locator(part).evaluate(bg))
    }
    expect(await cell.evaluate(el => getComputedStyle(el).borderRadius)).toBe('8px')
    expect(await cell.locator('.output').evaluate(el => getComputedStyle(el).borderRadius)).toBe('0px')
  })
}

test('before running there is no empty output panel', async ({ page }) => {
  await page.goto(CHAPTER)
  await expect(page.locator('.cell-run .output').first()).toBeHidden()
})

test('a cell that raises is labelled as an error', async ({ page }) => {
  await page.goto(CHAPTER)
  const cell = page.locator('.cell-run').first()
  await cell.locator('.editor').fill('{}["missing"]')
  await cell.locator('.exec').click()
  await expect(cell.locator('.output')).toHaveClass(/error/)
  await expect(cell.locator('.output')).toContainText('KeyError')
})

test('focus stays visible on the dark surface', async ({ page }) => {
  await page.goto(CHAPTER)
  const cell = page.locator('.cell-run').first()
  await cell.locator('.editor').focus()
  expect(await cell.locator('.desk-actions').evaluate(el => getComputedStyle(el).borderTopColor))
    .toBe('rgb(3, 105, 161)')
  await cell.locator('.exec').focus()
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab') // make focus keyboard-visible
  await cell.locator('.exec').evaluate(el => (el as HTMLElement).focus())
  expect(await cell.locator('.exec').evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
})

test('the chrome lives in the shared stylesheet, not the preview', async () => {
  const { execFileSync } = await import('node:child_process')
  const python = process.env.BOOK_PYTHON ?? 'python3'
  const css = execFileSync(python, ['-c',
    'import sys; sys.path.insert(0, "books/tools"); import render; print(render.CONTENT_CSS)']).toString()
  expect(css).toContain('.cell-run, .exercise-run, .desk {')
  expect(css).toContain('.desk-actions {')
})

test('the highlight layer never paints outside its editor', async ({ page }) => {
  await page.goto('/max-pairwise-product')
  const desk = page.locator('.desk')
  const wrap = await desk.locator('.code-wrap').boundingBox()
  const actions = await desk.locator('.desk-actions').boundingBox()
  expect(wrap!.y + wrap!.height).toBeLessThanOrEqual(actions!.y + 1)
  expect(await desk.locator('.code-wrap').evaluate(el => getComputedStyle(el).overflow)).toBe('hidden')
  // the whole starter fits, so nothing is hidden behind an inner scrollbar
  const editor = desk.locator('.editor')
  expect(await editor.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
})

test('a walk figure explains each step and keeps the answer for the end', async ({ page }) => {
  await page.goto('/max-pairwise-product')
  const walk = page.locator('.walk')
  await expect(walk.locator('.walk-answer')).toBeHidden()
  await expect(walk.locator('.walk-note:visible')).toHaveCount(1)
  for (let i = 0; i < 2; i++) await walk.locator('[data-walk="next"]').click()
  await expect(walk.locator('.walk-note:visible')).toContainText('only ties biggest')
  for (let i = 0; i < 2; i++) await walk.locator('[data-walk="next"]').click()
  await expect(walk.locator('.walk-answer')).toBeVisible()
  await expect(walk).not.toContainText('-1')
})

test('a failing tier says what was called, what came back, and what was expected', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/max-pairwise-product')
  const desk = page.locator('.desk')
  await desk.locator('.editor').fill(
    'def max_pairwise_product(numbers):\n    max1 = max2 = -1\n    for x in numbers:\n'
    + '        if x > max1:\n            max2 = max1\n            x = max1\n'
    + '        elif x > max2:\n            x = max2\n    return max1 * max2\n')
  await desk.locator('.run').click()
  const verdict = desk.locator('.desk-verdict')
  await expect(verdict).toBeVisible({ timeout: 90_000 })
  await expect(verdict).toContainText('max_pairwise_product([1, 2, 3]) returned 1, expected 6')
  await expect(desk.locator('.full-output')).toBeVisible()
  await expect(desk.locator('.full-output .output')).toBeHidden() // the dump waits behind a click
})

test('shortcuts sit behind a keyboard icon and open on hover or focus', async ({ page }) => {
  await page.goto('/ch06-dicts-sets')
  const keys = page.locator('.cell-run .keys').first()
  await expect(keys.locator('.keys-hint')).toBeHidden()
  await keys.locator('.keys-button').hover()
  await expect(keys.locator('.keys-hint')).toBeVisible()
  await expect(keys.locator('.keys-hint')).toContainText('leave the editor')
  await page.mouse.move(0, 0)
  await keys.locator('.keys-button').focus()
  await expect(keys.locator('.keys-hint')).toBeVisible()
})

test('Print opens the print edition at the page you were reading', async ({ page }) => {
  await page.goto('/cut-them-all-the-same')
  await page.locator('header .graph-link', { hasText: 'Print' }).click()
  await expect(page).toHaveURL(/\/print#print-cut-them-all-the-same$/)
  await expect(page.locator('#print-cut-them-all-the-same h1')).toBeInViewport()
})
