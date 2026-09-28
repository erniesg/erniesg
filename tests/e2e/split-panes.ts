import { expect, type Page } from '@playwright/test'

/**
 * Split means two scroll containers and a page that does not scroll: moving
 * one pane never moves the other. Used by the site and the local preview.
 */

type State = { top: number; box: { x: number; y: number; width: number; height: number } }

async function pane(page: Page, selector: string): Promise<State> {
  return page.locator(selector).evaluate((element) => {
    const r = element.getBoundingClientRect()
    return { top: element.scrollTop, box: { x: r.x, y: r.y, width: r.width, height: r.height } }
  })
}

async function wheelOver(page: Page, selector: string, delta: number) {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300))
  await page.mouse.wheel(0, delta)
}

export async function expectIndependentPanes(page: Page) {
  const left = '.split-question'
  const right = '.split-work'
  // Both panes need more than 600px to scroll through: every disclosure opened,
  // and a tall filler appended, so the check is about independence, not length.
  for (const selector of [left, right]) {
    await page.locator(selector).evaluate((element) => {
      for (const details of element.querySelectorAll('details')) details.open = true
      const filler = document.createElement('div')
      filler.style.height = '1500px'
      filler.setAttribute('data-test-filler', '')
      element.append(filler)
    })
  }
  for (const selector of [left, right]) {
    const overflows = await page
      .locator(selector)
      .evaluate((element) => element.scrollHeight > element.clientHeight + 100)
    expect(overflows, `${selector} overflows its pane`).toBe(true)
  }

  const beforeRight = await pane(page, right)
  await wheelOver(page, left, 600)
  await expect.poll(async () => (await pane(page, left)).top).toBeGreaterThanOrEqual(500)
  expect(await pane(page, right)).toEqual(beforeRight)
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0)

  const beforeLeft = await pane(page, left)
  await wheelOver(page, right, 600)
  await expect.poll(async () => (await pane(page, right)).top).toBeGreaterThanOrEqual(500)
  expect(await pane(page, left)).toEqual(beforeLeft)
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0)

  // The keyboard scrolls the focused pane only.
  const rightTop = (await pane(page, right)).top
  const leftTop = (await pane(page, left)).top
  await page.locator(left).focus()
  await page.keyboard.press('PageDown')
  await expect.poll(async () => (await pane(page, left)).top).toBeGreaterThan(leftTop)
  expect((await pane(page, right)).top).toBe(rightTop)
}
