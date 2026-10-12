import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
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
  extractPageSegments,
  generatePageTranslations,
  localizedInternalHref,
  localizedSitemapPaths,
  pagePathForLocale,
} from './pages.mjs'

const sourceHtml = `<!doctype html>
<html lang="en"><head><title>Research | Ernie</title><link rel="canonical" href="https://ernie.sg/research/"><meta property="og:url" content="https://ernie.sg/research/"></head>
<body><main><h1 id="research">Research</h1><p>Read <a href="/research/struct/">the Struct project</a>.</p><img src="/static/research.png" alt="Research diagram"><article data-i18n-card data-localizations='{"zh":{"url":"/blog/native/zh/","title":"母语标题","description":"母语摘要","date":"今天","readTime":"3 分钟","imageAlt":"母语图片","tags":["人工智能"]}}'><a data-i18n-card-link href="/blog/native/"><span data-i18n-card-title>English title</span></a><p data-i18n-card-description>English description</p><span data-i18n-card-date>Today</span><span data-i18n-card-read-time>3 min</span><img data-i18n-card-image alt="English image"><div data-i18n-card-tags><a href="/tags/ai/"><span data-i18n-card-tag-label>AI</span></a></div></article><pre><code>const untouched = true</code></pre><iframe src="https://demo.example/"></iframe></main></body></html>`
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
      expect(localized).toContain('property="og:url" content="https://ernie.sg/research/zh/"')
      expect(localized).toContain('研究')
      expect(localized).toContain('href="/research/struct/"')
      expect(localized).toContain('id="research"')
      expect(localized).toContain('const untouched = true')
      expect(localized).toContain('src="https://demo.example/"')
      expect(localized).toContain('母语标题')
      expect(localized).toContain('href="/blog/native/zh/"')
      expect(localized).toContain('人工智能')
      expect(localized).toContain('href="/tags/ai/"')
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

  it('preserves unknown locale ownership and refuses to generate over it', async () => {
    const { root, distDir } = await fixture()
    const catalogPath = path.join(root, 'pages.json')
    try {
      const catalog = await extractPageCatalog({ distDir })
      const page = catalog.pages['/research/']
      page.locales.zh = {
        status: 'external-owner',
        sourceHash: 'old-source-hash',
        translations: {},
      }
      await writeFile(catalogPath, JSON.stringify(catalog))
      const extracted = await extractPageCatalog({ distDir, outputPath: catalogPath })
      expect(extracted.pages['/research/'].locales.zh).toEqual(page.locales.zh)
      const generated = await generatePageTranslations({
        catalog: extracted,
        locale: 'zh',
        batchLimit: 1,
      })
      expect(generated.generatedRoutes).toEqual([])
      expect(
        await checkPageCatalog({ distDir, catalog: extracted, locales: ['zh'] }),
      ).toContain('/research/: zh has invalid status')
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
    expect(() =>
      assertPageTranslations({
        locale: 'ko',
        segments: {
          s0001: { sourceText: '11.8″ · 1620 × 2160 · 229 PPI' },
          s0002: { sourceText: 'https://doi.org/10.1000/example' },
        },
        translations: {
          s0001: '11.8″ · 1620 × 2160 · 229 PPI',
          s0002: 'https://doi.org/10.1000/example',
        },
      }),
    ).not.toThrow()
  })

  it('preserves bibliography entries while retaining a translatable references heading', () => {
    const segments = extractPageSegments(`<!doctype html><section aria-labelledby="references"><h2 id="references">References</h2><p>Benton, G., &amp; Liu, H. (2018). <a href="https://doi.org/10.1/example">https://doi.org/10.1/example</a>. University of California Press.</p></section>`)
    const values = Object.values(segments)
    expect(values.find((segment) => segment.sourceText === 'References')?.preserveOriginal).toBeUndefined()
    expect(values.find((segment) => segment.sourceText.includes('Benton'))?.preserveOriginal).toBe(true)
    expect(values.find((segment) => segment.sourceText.includes('doi.org'))?.preserveOriginal).toBe(true)
  })

  it('retries only omitted provider fragments and retains valid partial memory', async () => {
    const catalog = {
      strings: {}, translations: {}, pages: {
        '/research/': {
          sourceHash: 'source', locales: {}, segments: {
            s0001: { sourceText: 'Read this research report before making any conclusions.', translationKey: 'one' },
            s0002: { sourceText: ' in Guangdong ', translationKey: 'two' },
          },
        },
      },
    }
    const calls = []
    const partials = []
    const generated = await generatePageTranslations({
      catalog, locale: 'ko', batchLimit: 1,
      runStructuredJson: async ({ userPayload }) => {
        calls.push(userPayload.segments.map((segment) => segment.id))
        return calls.length === 1
          ? { translations: { s0001: '결론을 내리기 전에 이 연구 보고서를 읽으세요.' } }
          : { translations: { s0002: ' 광둥에서 ' } }
      },
      onPartial: async (next) => partials.push(next.translations.ko.one?.text),
    })
    expect(calls).toEqual([['s0001', 's0002'], ['s0002']])
    expect(partials).toContain('결론을 내리기 전에 이 연구 보고서를 읽으세요.')
    expect(generated.catalog.pages['/research/'].locales.ko.translationKeys).toEqual({ s0001: 'one', s0002: 'two' })
  })

  it('stops after the bounded fragment retry when a provider keeps omitting output', async () => {
    const catalog = {
      strings: {}, translations: {}, pages: {
        '/': { sourceHash: 'source', locales: {}, segments: {
          s0001: { sourceText: 'A substantive sentence that needs a translation now.', translationKey: 'one' },
        } },
      },
    }
    let calls = 0
    await expect(generatePageTranslations({
      catalog, locale: 'zh', batchLimit: 1,
      runStructuredJson: async () => { calls += 1; return { translations: {} } },
    })).rejects.toThrow(/omitted required segments after retry/)
    expect(calls).toBe(2)
  })

  it('does not persist an echoed prose fragment before its targeted repair succeeds', async () => {
    const sourceText = 'This substantive paragraph needs a natural localized translation.'
    const catalog = {
      strings: {}, translations: {}, pages: {
        '/': { sourceHash: 'source', locales: {}, segments: {
          s0001: { sourceText, translationKey: 'one' },
        } },
      },
    }
    const calls = []
    const partials = []
    const generated = await generatePageTranslations({
      catalog, locale: 'zh', batchLimit: 1,
      runStructuredJson: async ({ userPayload }) => {
        calls.push(userPayload.segments.map((segment) => segment.id))
        return { translations: { s0001: calls.length === 1 ? sourceText : '这段内容需要自然的本地化翻译。' } }
      },
      onPartial: async (next) => partials.push(next.translations.zh.one?.text),
    })
    expect(calls).toEqual([['s0001'], ['s0001']])
    expect(partials).not.toContain(sourceText)
    expect(generated.catalog.translations.zh.one.text).toBe('这段内容需要自然的本地化翻译。')
  })

  it('replaces cached machine output unless it has canonical Codex provenance', async () => {
    const sourceText = 'This substantive paragraph needs a natural localized translation.'
    const key = 'memory-key'
    const sourceHash = crypto.createHash('sha256').update(sourceText).digest('hex')
    const catalog = {
      strings: { [key]: { sourceText, sourceHash } },
      translations: {
        zh: {
          [key]: {
            text: '伪造的缓存译文。',
            status: 'machine',
            sourceHash,
            provenance: { provider: 'openai' },
          },
        },
      },
      pages: {
        '/': {
          sourceHash: 'page-hash',
          locales: {
            zh: {
              status: 'machine',
              sourceHash: 'page-hash',
              translationKeys: { s0001: key },
            },
          },
          segments: { s0001: { sourceText, translationKey: key } },
        },
      },
    }
    let calls = 0
    const generated = await generatePageTranslations({
      catalog,
      locale: 'zh',
      batchLimit: 1,
      runStructuredJson: async () => {
        calls += 1
        return { translations: { s0001: '这段内容需要自然的本地化翻译。' } }
      },
    })
    expect(calls).toBe(1)
    expect(generated.catalog.translations.zh[key].provenance.provider).toBe(
      'codex-cli',
    )
  })

  it('does not reuse a self-consistent Codex cache entry under a stale segment key', async () => {
    const sourceText = 'This substantive paragraph needs a natural localized translation.'
    const staleText = 'A different prior paragraph had a cached translation.'
    const staleKey = crypto.createHash('sha256').update(staleText).digest('hex')
    const catalog = {
      strings: { [staleKey]: { sourceText: staleText, sourceHash: staleKey } },
      translations: { zh: { [staleKey]: { text: '另一段旧文本。', status: 'machine', sourceHash: staleKey, provenance: { provider: 'codex-cli' } } } },
      pages: { '/': { sourceHash: 'page', locales: { zh: { status: 'machine', sourceHash: 'page', translationKeys: { s0001: staleKey } } }, segments: { s0001: { sourceText, translationKey: staleKey } } } },
    }
    let calls = 0
    await generatePageTranslations({
      catalog,
      locale: 'zh',
      runStructuredJson: async () => {
        calls += 1
        return { translations: { s0001: '这段内容需要自然的本地化翻译。' } }
      },
    })
    expect(calls).toBe(1)
  })

  it('reuses canonical Codex and native page translation memory', async () => {
    const sourceText = 'This substantive paragraph needs a natural localized translation.'
    const sourceHash = crypto.createHash('sha256').update(sourceText).digest('hex')
    const codexKey = sourceHash
    const nativeKey = sourceHash
    const catalog = {
      strings: { [codexKey]: { sourceText, sourceHash } },
      translations: {
        zh: {
          [codexKey]: { text: '这段内容需要自然的本地化翻译。', status: 'machine', sourceHash, provenance: { provider: 'codex-cli' } },
        },
      },
      pages: {
        '/codex/': { sourceHash: 'codex-page', locales: { zh: { status: 'machine', sourceHash: 'codex-page', translationKeys: { s0001: codexKey } } }, segments: { s0001: { sourceText, translationKey: codexKey } } },
      },
    }
    let calls = 0
    const generated = await generatePageTranslations({
      catalog,
      locale: 'zh',
      batchLimit: 2,
      runStructuredJson: async () => {
        calls += 1
        return { translations: {} }
      },
    })
    expect(calls).toBe(0)
    expect(generated.generatedRoutes).toEqual([])
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
