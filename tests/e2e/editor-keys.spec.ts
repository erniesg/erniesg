import { expect, test, type Page } from '@playwright/test'

// Spec 065: the editor must behave like a code editor.
const CHALLENGE = '/max-pairwise-product'
const CHAPTER = '/ch05-functions'

async function freshEditor(page: Page, path = CHALLENGE) {
  await page.goto(path)
  const editor = page.locator('.editor').first()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  return editor
}

test('Tab inserts four spaces and Shift+Tab removes them', async ({ page }) => {
  const editor = await freshEditor(page)
  await page.keyboard.press('Tab')
  await expect(editor).toHaveValue('    ')
  await page.keyboard.press('Shift+Tab')
  await expect(editor).toHaveValue('')
})

test('Tab and Shift+Tab act on every line of a selection', async ({ page }) => {
  const editor = await freshEditor(page)
  await editor.fill('a\nb\nc')
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.length))
  await page.keyboard.press('Tab')
  await expect(editor).toHaveValue('    a\n    b\n    c')
  await page.keyboard.press('Shift+Tab')
  await expect(editor).toHaveValue('a\nb\nc')
})

test('Escape then Tab leaves the editor', async ({ page }) => {
  const editor = await freshEditor(page)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect(editor).not.toBeFocused()
  await expect(editor).toHaveValue('')
})

test('Enter keeps indentation and indents after a colon', async ({ page }) => {
  const editor = await freshEditor(page)
  await page.keyboard.type('def f():')
  await page.keyboard.press('Enter')
  await page.keyboard.type('x = 1')
  await page.keyboard.press('Enter')
  await page.keyboard.type('return x')
  await page.keyboard.press('Enter')
  await expect(editor).toHaveValue('def f():\n    x = 1\n    return x\n')
})

test('Backspace at an indent removes one whole level at each depth', async ({ page }) => {
  const editor = await freshEditor(page)
  await page.keyboard.type('        ')
  await page.keyboard.press('Backspace')
  await expect(editor).toHaveValue('    ')
  await page.keyboard.press('Backspace')
  await expect(editor).toHaveValue('')
})

test('Shift+Enter inserts a newline and runs nothing', async ({ page }) => {
  const editor = await freshEditor(page, CHAPTER)
  let ran = false
  page.on('request', r => { if (r.url().includes('/api/exec')) ran = true })
  await page.keyboard.type('x = 1')
  await page.keyboard.press('Shift+Enter')
  await expect(editor).toHaveValue('x = 1\n')
  await page.waitForTimeout(300)
  expect(ran).toBe(false)
})

test('Cmd/Ctrl+Enter runs; Cmd/Ctrl+Shift+Enter runs and moves on', async ({ page }) => {
  const editor = await freshEditor(page, CHAPTER)
  await page.keyboard.type('print(41 + 1)')
  const cell = page.locator('.cell-run').first()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(cell.locator('.output')).toContainText('42')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+Shift+Enter')
  await expect(page.locator('.editor').nth(1)).toBeFocused()
})

test('the Tab escape is documented beside every editor', async ({ page }) => {
  await page.goto(CHAPTER)
  const editors = await page.locator('.editor').count()
  const hints = page.locator('.keys-hint[role="note"]')
  await expect(hints).toHaveCount(editors)
  await expect(hints.first()).toContainText('Esc')
})

test('undo after auto-indent restores in one step', async ({ page }) => {
  const editor = await freshEditor(page)
  await page.keyboard.type('def f():')
  await page.keyboard.press('Enter')
  await expect(editor).toHaveValue('def f():\n    ')
  await page.keyboard.press('ControlOrMeta+Z')
  // One undo removes the auto-indent. Chromium stops at the typed line; WebKit
  // groups the whole burst of typing into one step, which is its native undo.
  await expect(editor).not.toHaveValue(/def f\(\):\n {4}$/)
  if (test.info().project.use.browserName !== 'webkit') await expect(editor).toHaveValue('def f():')
})

test('the web edition shows no grade.py command; print does', async ({ page }) => {
  await page.goto(CHALLENGE)
  await expect(page.locator('.desk .editor')).not.toHaveValue(/grade\.py/)
  const print = await page.request.get('/print')
  expect(await print.text()).toContain('grade.py max-pairwise-product')
})

test('code is coloured, numbered and indent-guided like a real editor', async ({ page }) => {
  await freshEditor(page)
  await page.keyboard.type('def f(A):')
  await page.keyboard.press('Enter')
  await page.keyboard.type('while 1 in A:  # loop')
  const hl = page.locator('.desk .code-hl')
  await expect(hl.locator('.def')).toHaveText('def')
  await expect(hl.locator('.fn')).toHaveText('f')
  await expect(hl.locator('.kw').first()).toHaveText('while')
  await expect(hl.locator('.num')).toHaveText('1')
  await expect(hl.locator('.com')).toHaveText('# loop')
  await expect(hl.locator('.ig')).toHaveCount(1)
  await expect(page.locator('.desk .code-gutter')).toHaveText('1\n2')
})
