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
    const code = await cell.locator('.code-wrap').evaluate(bg)
    expect(await cell.locator('.desk-actions').evaluate(bg)).toBe(code)
    expect(await cell.locator('.output').evaluate(bg)).toBe(code)
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
    'import sys; sys.path.insert(0, "challenges/tools"); import render; print(render.CONTENT_CSS)']).toString()
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
