import { expect, test } from '@playwright/test'

const CHAPTER = '/books/build-a-coding-agent/ch09-stepping/'

test('the practice debugger distinguishes next from step-in and shows inspected values', async ({ page }) => {
  await page.goto(CHAPTER)
  const demo = page.locator('[data-pdb-demo]')
  await expect(demo.locator('[aria-current="step"]')).toContainText('for day in range')
  await demo.locator('[data-pdb-quick-command="n"]').click()
  await expect(demo.locator('[aria-current="step"]')).toContainText('total += steps_on(day)')
  await demo.locator('[data-pdb-quick-command="s"]').click()
  await expect(demo.locator('[aria-current="step"]')).toContainText('def steps_on(day)')
  await demo.locator('[data-pdb-command]').fill('p day')
  await demo.locator('[data-pdb-command-form] button[type="submit"]').click()
  await expect(demo.locator('[data-pdb-output]')).toContainText('(Pdb) p day\n3')
  await demo.locator('[data-pdb-quick-command="c"]').click()
  await expect(demo.locator('[data-pdb-output]')).toContainText('22985')
  await expect(demo.locator('[data-pdb-command]')).toBeDisabled()
  await demo.locator('[data-pdb-reset]').click()
  await expect(demo.locator('[data-pdb-command]')).toBeEnabled()
  await expect(demo.locator('[aria-current="step"]')).toContainText('for day in range')
})

test('code explanations work by tap on phones without widening the page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 })
  await page.goto(CHAPTER)
  const demo = page.locator('[data-pdb-demo]')
  await demo.locator('[aria-current="step"]').click()
  await expect(demo.locator('.pdb-line-note:visible')).toContainText('stops before the last number')
  await page.keyboard.press('Escape')
  await expect(demo.locator('.pdb-line-note:visible')).toHaveCount(0)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await demo.locator('.pdb-reference > summary').click()
  await expect(demo.locator('.pdb-reference')).toContainText('Six commands')
})
