import { expect, test, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'

const CHAPTER = '/books/build-a-coding-agent/meter-days/'
const QUOTE = '0 <= credit <= 1,000,000,000'

function contrast(foreground: string, background: string) {
  const channels = (value: string) =>
    (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const luminance = ([red, green, blue]: number[]) => {
    const channel = (value: number) => {
      const normalized = value / 255
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    }
    return (
      0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    )
  }
  const fore = luminance(channels(foreground))
  const back = luminance(channels(background))
  return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05)
}

async function open(
  page: Page,
  look: 'site' | 'plain',
  theme: 'theme-light' | 'dark',
) {
  await installStaticRoutes(page)
  // This suite supplies its annotation directly and never calls a real Margin
  // endpoint. A 404 is the rail's documented client-only mode.
  await page.route('**/api/margin/v1/**', (route) =>
    route.fulfill({ status: 404 }),
  )
  await page.addInitScript(
    ({ look, theme }) => {
      localStorage.setItem('book-look', look)
      localStorage.setItem('theme', theme)
    },
    { look, theme },
  )
  await page.goto(CHAPTER)
  await expect(page.locator('margin-rail')).toBeAttached()
  await expect(page.locator('.labelled li > code').first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-book-look', look)
  expect(
    await page
      .locator('html')
      .evaluate((element) => element.classList.contains('dark')),
  ).toBe(theme === 'dark')
}

async function addPlainNote(page: Page) {
  await page.evaluate((quote) => {
    const code = Array.from(
      document.querySelectorAll<HTMLElement>('.labelled li > code'),
    ).find((element) => element.textContent === quote)
    const block = code?.closest<HTMLElement>('[data-block-kind]')
    const rail = document.querySelector('margin-rail') as HTMLElement & {
      annotations: unknown[]
    }
    if (!code || !block || !rail)
      throw new Error('meter-days constraint note fixture is missing')
    const start = (block.textContent ?? '').indexOf(quote)
    if (start < 0)
      throw new Error('constraint quote is outside its anchorable block')
    rail.annotations = [
      {
        id: 'constraint-note',
        kind: 'note',
        target: {
          nodeId: block.id,
          position: { start, end: start + quote.length },
          quote: { exact: quote, prefix: '', suffix: '' },
        },
        body: 'Keep this bound in view.',
        geometryCache: [],
      },
    ]
  }, QUOTE)
}

async function noteHighlightName(page: Page) {
  return page.evaluate((quote) => {
    const registry = (
      CSS as unknown as { highlights?: Map<string, Set<Range>> }
    ).highlights
    if (!registry) return null
    return (
      Array.from(registry.entries()).find(([, highlight]) =>
        Array.from(highlight).some((range) => range.toString() === quote),
      )?.[0] ?? null
    )
  }, QUOTE)
}

for (const look of ['site', 'plain'] as const) {
  for (const theme of ['theme-light', 'dark'] as const) {
    test(`a saved note is distinct and its constraint chip is legible (${look}, ${theme})`, async ({
      page,
    }) => {
      await open(page, look, theme)
      const chip = page.locator('.labelled li > code', { hasText: QUOTE })
      const colors = await chip.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }))
      expect(
        contrast(colors.foreground, colors.background),
      ).toBeGreaterThanOrEqual(4.5)

      const before = await chip.screenshot()
      await addPlainNote(page)
      const name = await noteHighlightName(page)
      expect(
        name,
        'Chromium should use the native Custom Highlight painter',
      ).not.toBeNull()
      await expect
        .poll(() =>
          chip.evaluate((element, name) => {
            const style = getComputedStyle(element, `::highlight(${name})`)
            return style.textDecorationLine
          }, name!),
        )
        .toBe('underline')
      expect(await chip.screenshot()).not.toEqual(before)
    })
  }
}

test('a saved note remains visibly underlined when the overlay painter is used', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(CSS, 'highlights', {
      configurable: true,
      value: undefined,
    })
  })
  await open(page, 'site', 'dark')
  const chip = page.locator('.labelled li > code', { hasText: QUOTE })
  const before = await chip.screenshot()
  await addPlainNote(page)
  const cue = page.locator('[data-erniesg-margin-note-cues] > *')
  await expect(cue).toHaveCount(1)
  await expect
    .poll(() =>
      cue.evaluate((element) => {
        const style = getComputedStyle(element)
        return [style.zIndex, style.borderBottomWidth, style.borderBottomStyle]
      }),
    )
    .toEqual(['1', '2px', 'solid'])
  expect(await chip.screenshot()).not.toEqual(before)
})
