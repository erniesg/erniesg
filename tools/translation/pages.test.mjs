import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import {
  applyPageCatalog,
  assertPageTranslations,
  checkPageCatalog,
  extractPageCatalog,
  localizedInternalHref,
  localizedSitemapPaths,
  pagePathForLocale,
} from './pages.mjs'

const sourceHtml = `<!doctype html>
<html lang="en"><head><title>Research | Ernie</title><link rel="canonical" href="https://ernie.sg/research/"></head>
<body><main><h1 id="research">Research</h1><p>Read <a href="/research/struct/">the Struct project</a>.</p><img src="/static/research.png" alt="Research diagram"><article data-i18n-card data-localizations='{"zh":{"url":"/blog/native/zh/","title":"母语标题","description":"母语摘要","date":"今天","readTime":"3 分钟","imageAlt":"母语图片"}}'><a data-i18n-card-link href="/blog/native/"><span data-i18n-card-title>English title</span></a><p data-i18n-card-description>English description</p><span data-i18n-card-date>Today</span><span data-i18n-card-read-time>3 min</span><img data-i18n-card-image alt="English image"></article><pre><code>const untouched = true</code></pre><iframe src="https://demo.example/"></iframe></main></body></html>`
const execFile = promisify(execFileCallback)
const pagesCli = path.resolve('tools/translation/pages.mjs')

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pages-localization-'))
  const distDir = path.join(root, 'dist')
  await writeFile(path.join(root, 'placeholder'), '')
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(path.join(distDir, 'research'), { recursive: true }),
  )
  await writeFile(path.join(distDir, 'research', 'index.html'), sourceHtml)
  return { root, distDir }
}

describe('owned page localization catalog', () => {
  it('extracts bounded reader prose and attributes while protecting markup and code', async () => {
    const { root, distDir } = await fixture()
    try {
      const catalog = await extractPageCatalog({ distDir })
      const page = catalog.pages['/research/']
      expect(page).toBeTruthy()
      expect(
        Object.values(page.segments).map((segment) => segment.sourceText),
      ).toEqual(
        expect.arrayContaining([
          'Research | Ernie',
          'Research',
          'Read ',
          'the Struct project',
          'Research diagram',
        ]),
      )
      expect(
        Object.values(page.segments)
          .map((segment) => segment.sourceText)
          .join(' '),
      ).not.toContain('const untouched')
      expect(page.sourceHtml).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies localized prose to a copied route without changing IDs, URLs, code, or iframe assets', async () => {
    const { root, distDir } = await fixture()
    try {
      const catalog = await extractPageCatalog({ distDir })
      const page = catalog.pages['/research/']
      const bySource = Object.fromEntries(
        Object.entries(page.segments).map(([id, segment]) => [
          segment.sourceText,
          id,
        ]),
      )
      page.locales = {
        zh: {
          status: 'final',
          sourceHash: page.sourceHash,
          translations: {
            [bySource['Research | Ernie']]: '研究 | Ernie',
            [bySource.Research]: '研究',
            [bySource['Read ']]: '阅读 ',
            [bySource['the Struct project']]: 'Struct 项目',
            [bySource['Research diagram']]: '研究示意图',
          },
        },
      }
      await applyPageCatalog({ distDir, catalog, locales: ['zh'] })
      const english = await readFile(
        path.join(distDir, 'research', 'index.html'),
        'utf8',
      )
      const localized = await readFile(
        path.join(distDir, 'research', 'zh', 'index.html'),
        'utf8',
      )
      expect(english).toContain('hreflang="zh"')
      expect(english).toContain('id="site-locale-paths"')
      expect(localized).toContain('<html lang="zh-Hans">')
      expect(localized).toContain('https://ernie.sg/research/zh/')
      expect(localized).toContain('研究')
      expect(localized).toContain('href="/research/struct/"')
      expect(localized).toContain('id="research"')
      expect(localized).toContain('const untouched = true')
      expect(localized).toContain('src="https://demo.example/"')
      expect(localized).toContain('母语标题')
      expect(localized).toContain('href="/blog/native/zh/"')
      expect(localized).toContain('id="site-locale-paths"')
      expect(localized).toContain('hreflang="zh"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports missing required locale translations and stale machine source hashes', async () => {
    const { root, distDir } = await fixture()
    try {
      const catalog = await extractPageCatalog({ distDir })
      const problems = await checkPageCatalog({
        distDir,
        catalog,
        locales: ['zh', 'ja', 'ko'],
      })
      expect(problems).toContainEqual(
        expect.stringContaining('/research/: missing zh'),
      )
      expect(problems).toContainEqual(
        expect.stringContaining('/research/: missing ja'),
      )
      expect(problems).toContainEqual(
        expect.stringContaining('/research/: missing ko'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a newly built owned page that has no catalog entry', async () => {
    const { root, distDir } = await fixture()
    try {
      const catalog = await extractPageCatalog({ distDir })
      await import('node:fs/promises').then(({ mkdir }) =>
        mkdir(path.join(distDir, 'new-public-page'), { recursive: true }),
      )
      await writeFile(
        path.join(distDir, 'new-public-page', 'index.html'),
        sourceHtml,
      )
      const problems = await checkPageCatalog({ distDir, catalog, locales: [] })
      expect(problems).toContain('/new-public-page/: missing from page catalog')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not stale a catalog when only a generated script payload changes', async () => {
    const { root, distDir } = await fixture()
    try {
      const catalog = await extractPageCatalog({ distDir })
      const file = path.join(distDir, 'research', 'index.html')
      await writeFile(
        file,
        `${sourceHtml}<script src="/_astro/new-hash.js"></script>`,
      )
      const problems = await checkPageCatalog({ distDir, catalog, locales: [] })
      expect(problems).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an English echo before provider output can enter the catalog', () => {
    const segments = {
      s0001: {
        sourceText:
          'Research in progress needs careful evidence before publication.',
      },
      s0002: {
        sourceText:
          'Read the project notes and compare the documented limitations.',
      },
    }
    expect(() =>
      assertPageTranslations({
        segments,
        locale: 'zh',
        translations: {
          s0001: segments.s0001.sourceText,
          s0002: segments.s0002.sourceText,
        },
      }),
    ).toThrow(/echo English/)
    expect(() =>
      assertPageTranslations({
        segments,
        locale: 'ko',
        translations: {
          s0001: '연구 진행 중',
          s0002: '프로젝트 노트를 읽어 보세요',
        },
      }),
    ).not.toThrow()
  })

  it('allows native UI and proper-name identity values while still rejecting echoed prose', () => {
    expect(() =>
      assertPageTranslations({
        locale: 'zh',
        segments: {
          s0001: { sourceText: '404' },
          s0002: { sourceText: 'Ernie.SG' },
          s0003: { sourceText: 'GitHub' },
          s0004: { sourceText: 'YouTube' },
        },
        translations: {
          s0001: '404',
          s0002: 'Ernie.SG',
          s0003: 'GitHub',
          s0004: 'YouTube',
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertPageTranslations({
        locale: 'ja',
        segments: {
          s0001: {
            sourceText:
              'This paragraph explains the current research direction and its limitations.',
          },
        },
        translations: {
          s0001:
            'This paragraph explains the current research direction and its limitations.',
        },
      }),
    ).toThrow(/echo English/)
  })

  it('rewrites only known owned or native locale links and keeps query and fragment state', () => {
    const routes = new Map([
      ['/about/', { en: '/about/', zh: '/about/zh/' }],
      [
        '/blog/native-post/',
        { en: '/blog/native-post/', zh: '/blog/native-post/zh/' },
      ],
    ])
    expect(
      localizedInternalHref('/about/?tab=projects#card', 'zh', routes),
    ).toBe('/about/zh/?tab=projects#card')
    expect(localizedInternalHref('/blog/native-post/', 'zh', routes)).toBe(
      '/blog/native-post/zh/',
    )
    expect(
      localizedInternalHref('https://example.com/about/', 'zh', routes),
    ).toBe('https://example.com/about/')
    expect(localizedInternalHref('/api/annotations', 'zh', routes)).toBe(
      '/api/annotations',
    )
    expect(
      localizedSitemapPaths({ pages: { '/': {}, '/404/': {} } }, ['zh']),
    ).toEqual(['/zh/', '/404/zh/'])
  })

  it('accepts CLI --dist and --catalog values for extract, check, and apply', async () => {
    const { root, distDir } = await fixture()
    const catalogPath = path.join(root, 'pages.json')
    try {
      await execFile(process.execPath, [
        pagesCli,
        'extract',
        '--dist',
        distDir,
        '--catalog',
        catalogPath,
      ])
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
      const page = catalog.pages['/research/']
      for (const locale of ['zh', 'ja', 'ko']) {
        page.locales[locale] = {
          status: 'final',
          sourceHash: page.sourceHash,
          translations: Object.fromEntries(
            Object.keys(page.segments).map((id) => [id, `_${locale}_${id}`]),
          ),
        }
      }
      await writeFile(catalogPath, JSON.stringify(catalog))
      await execFile(process.execPath, [
        pagesCli,
        'check',
        '--dist',
        distDir,
        '--catalog',
        catalogPath,
      ])
      await execFile(process.execPath, [
        pagesCli,
        'apply',
        '--dist',
        distDir,
        '--catalog',
        catalogPath,
      ])
      expect(
        await readFile(
          path.join(distDir, 'research', 'ko', 'index.html'),
          'utf8',
        ),
      ).toContain('lang="ko"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps blog routes out of the owned page catalog and maps locale routes at the final path segment', async () => {
    const { root, distDir } = await fixture()
    try {
      await import('node:fs/promises').then(({ mkdir }) =>
        Promise.all([
          mkdir(path.join(distDir, 'about'), { recursive: true }),
          mkdir(path.join(distDir, 'tags'), { recursive: true }),
          mkdir(path.join(distDir, 'research', 'struct', 'demo'), {
            recursive: true,
          }),
          mkdir(
            path.join(distDir, 'research', 'struct', 'exports', 'reflowable'),
            { recursive: true },
          ),
          mkdir(
            path.join(
              distDir,
              'research',
              'struct',
              'samples',
              'ai-must-die',
              'content',
            ),
            { recursive: true },
          ),
          mkdir(path.join(distDir, 'blog', 'native-post', 'zh'), {
            recursive: true,
          }),
        ]),
      )
      await Promise.all([
        writeFile(path.join(distDir, '404.html'), sourceHtml),
        writeFile(
          path.join(distDir, 'about', 'index.html'),
          sourceHtml.replace('Research | Ernie', 'About | Ernie'),
        ),
        writeFile(
          path.join(distDir, 'tags', 'index.html'),
          sourceHtml.replace('Research | Ernie', 'Tags | Ernie'),
        ),
        writeFile(
          path.join(distDir, 'research', 'struct', 'demo', 'index.html'),
          sourceHtml.replace('Research | Ernie', 'Struct demo | Ernie'),
        ),
        writeFile(
          path.join(
            distDir,
            'research',
            'struct',
            'exports',
            'reflowable',
            'index.html',
          ),
          sourceHtml,
        ),
        writeFile(
          path.join(
            distDir,
            'research',
            'struct',
            'samples',
            'ai-must-die',
            'content',
            'index.html',
          ),
          sourceHtml,
        ),
        writeFile(
          path.join(distDir, 'blog', 'native-post', 'zh', 'index.html'),
          sourceHtml,
        ),
      ])
      const catalog = await extractPageCatalog({ distDir })
      expect(Object.keys(catalog.pages)).toEqual(
        expect.arrayContaining([
          '/404/',
          '/about/',
          '/tags/',
          '/research/struct/demo/',
        ]),
      )
      expect(catalog.pages).not.toHaveProperty('/blog/native-post/zh/')
      expect(catalog.pages).not.toHaveProperty(
        '/research/struct/exports/reflowable/',
      )
      expect(catalog.pages).not.toHaveProperty(
        '/research/struct/samples/ai-must-die/content/',
      )
      expect(pagePathForLocale('/research/struct/', 'ko')).toBe(
        '/research/struct/ko/',
      )
      expect(pagePathForLocale('/', 'ja')).toBe('/ja/')
      expect(pagePathForLocale('/404/', 'zh')).toBe('/404/zh/')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
