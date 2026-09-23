import { expect, test, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'

const CHAPTER = '/books/build-a-coding-agent/ch12-hash-maps/'

async function open(page: Page) {
  const writes: Record<string, unknown>[] = []
  await page.route('**/api/margin/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      writes.push(body)
      await route.fulfill({
        json: {
          ...body,
          id: `urn:margin:annotation:${writes.length}`,
        },
      })
    } else if (request.method() === 'GET' && url.pathname.endsWith('/prefs')) {
      await route.fulfill({
        json: { defaultVisibility: 'private', viewerKey: 'reader-one' },
      })
    } else if (request.method() === 'GET') {
      await route.fulfill({ json: { annotations: [] } })
    } else {
      await route.fulfill({ json: request.postDataJSON() ?? {} })
    }
  })
  await installStaticRoutes(page)
  await page.goto(CHAPTER)
  const rail = page.locator('margin-rail')
  await expect(rail.locator('[data-margin-panel]')).toBeAttached()
  return { rail, writes }
}

async function selectFirstWords(page: Page) {
  await page.evaluate(() => {
    const block = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.book-content [data-block-kind="prose"]',
      ),
    ).find((candidate) => (candidate.textContent?.length ?? 0) > 80)
    if (!block) throw new Error('Book has no prose block')
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode() as Text | null
    if (!node || node.length < 15)
      throw new Error('Book has no first text segment')
    const range = document.createRange()
    range.setStart(node, 2)
    range.setEnd(node, 13)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
}

test('keyboard selection opens a trapped popup, saves a semantic highlight and retains private visibility after default changes', async ({
  page,
}) => {
  const { rail, writes } = await open(page)
  await selectFirstWords(page)
  const popup = rail.locator('[data-margin-popup]')
  await expect(popup).toBeVisible()
  await expect(rail.locator('[data-margin-color="highlight"]')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(popup.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(rail.locator('[data-margin-color="highlight"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(rail.locator('[data-margin-annotation]')).toHaveCount(1)
  await expect(rail.locator('[data-margin-annotation]')).toContainText(
    'private',
  )
  await rail.locator('[data-margin-default-visibility]').selectOption('public')
  await expect(rail.locator('[data-margin-annotation]')).toContainText(
    'private',
  )
  expect(writes[0]?.['margin:color']).toBe('highlight')
  expect(writes[0]?.['margin:visibility']).toBe('private')
})

test('Escape returns focus to the text and saves nothing', async ({ page }) => {
  const { rail, writes } = await open(page)
  await selectFirstWords(page)
  await expect(rail.locator('[data-margin-popup]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(rail.locator('[data-margin-popup]')).toHaveCount(0)
  expect(writes).toHaveLength(0)
  expect(
    await page.evaluate(
      () => document.activeElement?.closest('[data-block-kind]') !== null,
    ),
  ).toBe(true)
})

test('orphaned notes stay searchable, editable, and deletable', async ({
  page,
}) => {
  const { rail } = await open(page)
  await page.evaluate(() => {
    const element = document.querySelector('margin-rail') as HTMLElement & {
      annotations: unknown[]
      transport: null
    }
    element.transport = null
    element.annotations = [
      {
        id: 'orphan-one',
        kind: 'note',
        body: 'Original thought',
        geometryCache: [],
        target: {
          nodeId: 'gone-block',
          positionUnit: 'utf16',
          position: { start: 0, end: 8 },
          quote: { exact: 'lost line', prefix: '', suffix: '' },
        },
      },
    ]
  })
  await expect(rail.locator('[data-orphaned]')).toContainText('lost line')
  await rail.locator('[data-margin-search]').fill('original')
  await expect(rail.locator('[data-margin-annotation]')).toHaveCount(1)
  await rail.locator('[data-margin-search]').fill('no match')
  await expect(rail.locator('[data-margin-annotation]')).toHaveCount(0)
  await rail.locator('[data-margin-search]').fill('')
  await rail.locator('[data-margin-edit]').click()
  await rail.locator('[data-margin-edit-field]').fill('Revised thought')
  await rail.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(rail.locator('[data-orphaned]')).toContainText('Revised thought')
  await rail.locator('[data-margin-delete]').click()
  await expect(rail.locator('[data-margin-annotation]')).toHaveCount(0)
})

test('a delayed visibility update cannot be overtaken by a second toggle', async ({
  page,
}) => {
  const { rail, writes } = await open(page)
  await selectFirstWords(page)
  await rail.locator('[data-margin-color="highlight"]').click()
  await expect(rail.locator('[data-margin-annotation]')).toHaveCount(1)
  await expect(rail.locator('[data-margin-annotation]')).toHaveAttribute(
    'data-margin-annotation',
    'urn:margin:annotation:1',
  )
  let release: (() => void) | undefined
  let patches = 0
  await page.route('**/api/margin/v1/annotations/**', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    patches += 1
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({
      json: {
        ...writes[0],
        id: 'urn:margin:annotation:1',
        'margin:visibility': 'public',
        creator: 'reader-one',
      },
    })
  })
  const toggle = rail.locator('[data-margin-visibility]')
  await toggle.click()
  await expect(toggle).toBeDisabled()
  await page.evaluate(() => {
    document
      .querySelector('margin-rail')
      ?.shadowRoot?.querySelector<HTMLButtonElement>('[data-margin-visibility]')
      ?.click()
  })
  expect(patches).toBe(1)
  release?.()
  await expect(toggle).toBeEnabled()
  await expect(rail.locator('[data-margin-annotation]')).toContainText('public')
})

test('API refresh removes stale rows and only the authenticated creator can edit', async ({
  page,
}) => {
  const { rail } = await open(page)
  await page.evaluate(() => {
    const element = document.querySelector('margin-rail') as HTMLElement & {
      transport: {
        request: (request: {
          path: string
        }) => Promise<{ status: number; body: unknown }>
      }
    }
    const row = (id: string, creator: string) => ({
      id,
      creator,
      motivation: 'commenting',
      body: { type: 'TextualBody', value: 'Saved note', format: 'text/plain' },
      'margin:visibility': 'public',
      target: {
        source: element.getAttribute('document-uri'),
        selector: [
          { type: 'TextQuoteSelector', exact: 'lost line' },
          { type: 'TextPositionSelector', start: 0, end: 9 },
          { type: 'margin:StructSelector', 'margin:nodeId': 'gone-block' },
        ],
      },
    })
    element.transport = {
      request: async ({ path }) => ({
        status: 200,
        body: path.endsWith('/prefs')
          ? { defaultVisibility: 'private', viewerKey: 'reader-one' }
          : {
              annotations: [
                row('mine', 'reader-one'),
                row('theirs', 'reader-two'),
              ],
            },
      }),
    }
  })
  await expect(rail.locator('[data-margin-annotation]')).toHaveCount(2)
  await expect(
    rail.locator('[data-margin-annotation="mine"] [data-margin-edit]'),
  ).toBeVisible()
  await expect(
    rail.locator('[data-margin-annotation="theirs"] [data-margin-edit]'),
  ).toHaveCount(0)
  await page.evaluate(() => {
    const element = document.querySelector('margin-rail') as HTMLElement & {
      transport: {
        request: (request: {
          path: string
        }) => Promise<{ status: number; body: unknown }>
      }
    }
    element.transport = {
      request: async ({ path }) => ({
        status: 200,
        body: path.endsWith('/prefs')
          ? { defaultVisibility: 'private', viewerKey: 'reader-one' }
          : { annotations: [] },
      }),
    }
  })
  await expect(rail.locator('[data-margin-annotation]')).toHaveCount(0)
})

test('narrow rail is an overlay and never changes text width', async ({
  page,
}) => {
  for (const width of [390, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    const { rail } = await open(page)
    const before = await page
      .locator('[data-reading-column="text"]')
      .boundingBox()
    if (width < 1280) {
      await rail.locator('[data-margin-toggle]').click()
      await expect(rail.locator('[data-margin-panel]')).toBeVisible()
    } else {
      await expect(rail.locator('[data-margin-panel]')).toBeVisible()
    }
    const after = await page
      .locator('[data-reading-column="text"]')
      .boundingBox()
    expect(after?.width).toBe(before?.width)
    await page.screenshot({
      path: `../margin313-${width}.png`,
      fullPage: false,
    })
  }
})
