import { expect, test, type Locator, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'

const LOCALE_EXPECTATIONS = {
  zh: { html: 'zh-Hans', characters: /[\u3400-\u9fff]/ },
  ja: { html: 'ja', characters: /[\u3040-\u30ff\u3400-\u9fff]/ },
  ko: { html: 'ko', characters: /[\uac00-\ud7af]/ },
} as const

test.describe('completed localized artifact', () => {
  test.skip(
    !process.env.SRT_STATIC_BUILD_DIR,
    'Checks localized routes in the completed production artifact',
  )

  async function expectLocalizedProse(
    page: Page,
    locale: keyof typeof LOCALE_EXPECTATIONS,
  ) {
    const expected = LOCALE_EXPECTATIONS[locale]
    await expect(page.locator('html')).toHaveAttribute('lang', expected.html)
    await expect(page.locator('main').getByRole('heading').first()).toHaveText(
      expected.characters,
    )
    await expect(page.locator('main')).toContainText(expected.characters)
  }

  function headerNav(page: Page, index: number): Locator {
    return page.locator('header nav:visible a').nth(index)
  }

  test('keeps a saved Chinese reading path through the persisted header and supports switching back to English', async ({
    page,
  }) => {
    await installStaticRoutes(page)
    await page.addInitScript(() => {
      if (!localStorage.getItem('siteLang'))
        localStorage.setItem('siteLang', 'zh')
    })

    await page.goto('/research/zh/')
    await expectLocalizedProse(page, 'zh')
    await expect(headerNav(page, 2)).toHaveAttribute('href', '/about/zh/')

    await headerNav(page, 2).click()
    await expect(page).toHaveURL(/\/about\/zh\/$/)
    await expectLocalizedProse(page, 'zh')
    await expect(headerNav(page, 0)).toHaveAttribute('href', '/blog/zh/')

    await headerNav(page, 0).click()
    await expect(page).toHaveURL(/\/blog\/zh\/$/)
    await expectLocalizedProse(page, 'zh')
    await expect(headerNav(page, 1)).toHaveAttribute('href', '/research/zh/')

    await headerNav(page, 1).click()
    await expect(page).toHaveURL(/\/research\/zh\/$/)
    await expectLocalizedProse(page, 'zh')

    await page.locator('[data-language-trigger]').click()
    await page.locator('[data-language-choice="en"]').click()
    await expect(page).toHaveURL(/\/research\/$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('main h1')).toHaveText('Research')
    await expect(page.locator('main')).toContainText(
      'Investigating representations of creative decisions',
    )
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('siteLang')))
      .toBe('en')
  })

  test('preserves the final native Chinese loss essay without machine replacement', async ({
    page,
  }) => {
    await installStaticRoutes(page)
    await page.goto('/blog/loss-price-love/zh/')

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await expect(
      page.getByRole('heading', { name: '失去是挚爱付出的代价', exact: true }),
    ).toBeVisible()
    await expect(page.locator('main')).toContainText(
      '如果失去是我们为爱付出的代价，遗憾是利息',
    )
  })

  for (const locale of Object.keys(LOCALE_EXPECTATIONS) as Array<
    keyof typeof LOCALE_EXPECTATIONS
  >) {
    test(`publishes the ${locale} REPResenting Taste programme, Struct, and demo pages with localized prose and links`, async ({
      page,
    }) => {
      await installStaticRoutes(page)
      await page.addInitScript((language) => {
        localStorage.setItem('siteLang', language)
      }, locale)

      await page.goto(`/research/representing-taste/${locale}/`)
      await expectLocalizedProse(page, locale)
      await expect(page.locator('main h2').first()).toHaveText(
        LOCALE_EXPECTATIONS[locale].characters,
      )
      await expect(
        page.locator(`a[href="/research/struct/demo/${locale}/"]`).first(),
      ).toBeVisible()

      await page.goto(`/research/struct/${locale}/`)
      await expectLocalizedProse(page, locale)
      await expect(
        page.locator(`a[href="/research/struct/demo/${locale}/"]`).first(),
      ).toBeVisible()

      await page.goto(`/research/struct/demo/${locale}/`)
      await expectLocalizedProse(page, locale)
      await expect(
        page.locator(`a[href="/research/struct/${locale}/"]`).first(),
      ).toBeVisible()
    })
  }
})

// Astro dev serves source routes; production localization creates these native
// documents at build time. The fixture retains the actual Header and islands.
async function directLocaleRoutes(page: Page) {
  await installStaticRoutes(page)
  if (process.env.SRT_STATIC_BUILD_DIR) return
  await page.route('**/{research,about}/{zh,ja,ko}/', async (route) => {
    const locale = new URL(route.request().url()).pathname
      .split('/')
      .filter(Boolean)
      .at(-1) as keyof typeof LOCALE_EXPECTATIONS
    const section = new URL(route.request().url()).pathname
      .split('/')
      .filter(Boolean)[0]
    const paths = {
      en: `/${section}/`,
      zh: `/${section}/zh/`,
      ja: `/${section}/ja/`,
      ko: `/${section}/ko/`,
    }
    const response = await route.fetch({
      url: new URL(`/${section}/`, route.request().url()).href,
    })
    const html = (await response.text())
      .replace(
        /(<html[^>]*\blang=")[^"]*(")/,
        `$1${LOCALE_EXPECTATIONS[locale].html}$2`,
      )
      .replace(
        /(<meta\s+name="site-document-locale"\s+content=")[^"]*(")/,
        `$1${locale}$2`,
      )
      .replace(
        '</head>',
        `<script id="site-locale-paths" type="application/json">${JSON.stringify(paths)}</script></head>`,
      )
      .replace(/<a\b[^>]*data-i18n-key="nav\.[^"]*"[^>]*>/g, (tag) =>
        tag.replace(
          /href="\/(blog|research|about|tags)\/?"/,
          (_, section) => `href="/${section}/${locale}/"`,
        ),
      )
    await route.fulfill({ response, body: html })
  })
  // Warm Vite's real island imports before fulfilling a native-document
  // fixture; otherwise its first optimizer pass can invalidate their URLs.
  await page.goto('/research/')
  await expect(
    page.locator('astro-island[component-url*="language-toggle"][ssr]'),
  ).toHaveCount(0)
  await page.evaluate(() => localStorage.clear())
}

for (const locale of Object.keys(LOCALE_EXPECTATIONS) as Array<
  keyof typeof LOCALE_EXPECTATIONS
>) {
  test(`preserves the direct ${locale} route without a stored language choice`, async ({
    page,
  }) => {
    await directLocaleRoutes(page)
    await page.goto(`/research/${locale}/`)
    await expect(page.locator('html')).toHaveAttribute(
      'lang',
      LOCALE_EXPECTATIONS[locale].html,
    )
    await expect(page.locator('[data-language-trigger]')).toContainText(
      { zh: '中', ja: '日', ko: '한' }[locale],
    )
    await expect(page).toHaveURL(new RegExp(`/research/${locale}/$`))
    expect(
      await page.evaluate(() => localStorage.getItem('siteLang')),
    ).toBeNull()
  })
}

test.describe('a browser language different from the linked document', () => {
  test.use({ locale: 'ja-JP' })
  test('keeps a direct Chinese route Chinese for a Japanese browser', async ({
    page,
  }) => {
    await directLocaleRoutes(page)
    await page.goto('/research/zh/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await expect(page.locator('[data-language-trigger]')).toContainText('中')
    await expect(page).toHaveURL(/\/research\/zh\/$/)
  })
})

test('honors an explicit saved English choice over a linked Chinese document', async ({
  page,
}) => {
  await directLocaleRoutes(page)
  await page.addInitScript(() => localStorage.setItem('siteLang', 'en'))
  await page.goto('/research/zh/')
  await expect(page).toHaveURL(/\/research\/$/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('[data-language-trigger]')).toContainText('EN')
})

test('updates the persisted header to an incoming native document without creating a saved preference', async ({
  page,
}) => {
  await directLocaleRoutes(page)
  await page.goto('/research/ja/')
  await expect(page.locator('[data-language-trigger]')).toContainText('日')
  await page.evaluate(() => {
    document
      .querySelector('header')!
      .setAttribute('data-persistence-probe', 'native-route')
    const link = document.createElement('a')
    link.href = '/research/zh/'
    link.textContent = 'Native Chinese route'
    link.setAttribute('data-native-route-test', '')
    document.querySelector('main')!.append(link)
  })
  await page.locator('[data-native-route-test]').click()
  await expect(page).toHaveURL(/\/research\/zh\/$/)
  await expect(page.getByRole('banner')).toHaveAttribute(
    'data-persistence-probe',
    'native-route',
  )
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
  await expect(page.locator('[data-language-trigger]')).toContainText('中')
  await expect(page.locator('header nav a[href="/about/zh/"]')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('siteLang'))).toBeNull()
})

test('mobile navigation keeps a native Chinese reader on localized About without a saved preference', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await directLocaleRoutes(page)
  await page.goto('/research/zh/')
  await page.locator('header button.md\\:hidden').click()
  const about = page.getByRole('menuitem', { name: '关于', exact: true })
  await expect(about).toHaveAttribute('href', '/about/zh/')
  await about.click()
  await expect(page).toHaveURL(/\/about\/zh\/$/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
  await page.locator('header button.md\\:hidden').click()
  await expect(
    page.getByRole('menuitem', { name: '研究', exact: true }),
  ).toHaveAttribute('href', '/research/zh/')
  expect(await page.evaluate(() => localStorage.getItem('siteLang'))).toBeNull()
})
