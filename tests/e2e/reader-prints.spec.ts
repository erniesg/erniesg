import { expect, test } from '@playwright/test'

// A reader's `print` shows under the call that made it, apart from the test
// runner's output, and Run tries the statement's samples without grading.
const CHALLENGE = '/recent-readings'

// The owner's own attempt, verbatim: prints inside the loop, wrong answer.
const ATTEMPT = [
  'def recent(readings: list[int], n: int) -> list[int]:',
  '    new_list = []',
  '    for i in range(n):',
  '        print(i)',
  '        if n == 0:',
  '            return []',
  '        else:',
  '            new_list.append(n-1)',
  '',
  '    return new_list',
  '',
].join('\n')

test('a failing case shows what the reader printed, without opening anything', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(CHALLENGE)
  const desk = page.locator('.desk')
  await desk.locator('.editor').fill(ATTEMPT)
  await desk.locator('.run').click()

  const failing = desk.locator('.call-case.bad').first()
  await expect(failing).toBeVisible({ timeout: 90_000 })
  await expect(failing.locator('.case-call')).toContainText('recent([3, 8, 2, 9, 4], 2)')
  await expect(failing.locator('.case-got')).toContainText('returned [1, 1], expected [9, 4]')
  const prints = failing.locator('.case-prints')
  await expect(prints).toHaveAttribute('open', '')
  await expect(prints.locator('pre')).toHaveText('0\n1\n')
  // the runner's own output is still there, behind a click, and never mixed in
  await expect(desk.locator('.full-output > summary')).toHaveText('Test runner output')
  await expect(desk.locator('.full-output .output')).toBeHidden()
  await expect(prints.locator('pre')).not.toContainText('FAIL')
})

test('Run (⌘\') runs every sample with its prints, and grades nothing', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(CHALLENGE)
  const desk = page.locator('.desk')
  const editor = desk.locator('.editor')
  await editor.fill(ATTEMPT)
  await editor.press('ControlOrMeta+Quote')

  const cases = desk.locator('.call-case')
  await expect(cases).toHaveCount(4, { timeout: 90_000 })
  await expect(desk.locator('.status')).toHaveText('Samples only. Not graded.')
  await expect(desk.locator('.tiers')).toBeEmpty()
  await expect(desk.locator('.desk-verdict')).toBeHidden()
  // every row ran, even after the first was wrong
  await expect(cases.nth(1).locator('.case-call')).toContainText('recent([3, 8, 2], 7)')
  await expect(cases.nth(1).locator('.case-prints pre')).toHaveText('0\n1\n2\n3\n4\n5\n6\n')
  // the empty screen is right, and printed nothing
  await expect(cases.nth(2)).toHaveClass(/good/)
  await expect(cases.nth(2).locator('.case-none')).toHaveText('Printed nothing.')
})

test('in side by side the cases sit in the code pane, and the page itself does not scroll', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(CHALLENGE)
  await page.evaluate(() => { try { localStorage.setItem('book-challenge-view', 'split') } catch {} })
  await page.reload()
  const desk = page.locator('.desk')
  await desk.locator('.editor').fill(ATTEMPT)
  await desk.locator('.sample').click()
  await expect(page.locator('.split-work .call-case')).toHaveCount(4, { timeout: 90_000 })
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('a flood of prints is cut short with a count, and the page stays usable', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(CHALLENGE)
  const desk = page.locator('.desk')
  await desk.locator('.editor').fill(
    'def recent(readings, n):\n    for i in range(100000):\n        print(i)\n    return []\n')
  await desk.locator('.sample').click()
  const first = desk.locator('.call-case').first()
  await expect(first.locator('.dropped')).toContainText(/truncated, \d+ more lines/, { timeout: 90_000 })
})
