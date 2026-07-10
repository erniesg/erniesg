import fs from 'node:fs/promises'
import fg from 'fast-glob'
import matter from 'gray-matter'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCALE,
  STATIC_TRANSLATIONS,
  SUPPORTED_LOCALES,
  TAG_LABELS,
  getAuthorDisplayName,
  getCanonicalPostId,
  getLocaleFromPostId,
  getLocalizedPostId,
  getPostLocalePath,
  getTagLabel,
  pickPreferredLocale,
} from './i18n'

describe('blog i18n helpers', () => {
  it('maps canonical and localized post ids without changing the English URL', () => {
    expect(getCanonicalPostId('example-post')).toBe('example-post')
    expect(getCanonicalPostId('example-post/en')).toBe('example-post')
    expect(getCanonicalPostId('example-post/zh')).toBe('example-post')
    expect(getCanonicalPostId('example-post/ko')).toBe('example-post')
    expect(getCanonicalPostId('example-post/ja')).toBe('example-post')

    expect(getLocalizedPostId('example-post', DEFAULT_LOCALE)).toBe(
      'example-post',
    )
    expect(getLocalizedPostId('example-post/en', DEFAULT_LOCALE)).toBe(
      'example-post',
    )
    expect(getLocalizedPostId('example-post', 'zh')).toBe('example-post/zh')
    expect(getLocalizedPostId('example-post/zh', 'ja')).toBe('example-post/ja')
  })

  it('detects only supported locale suffixes from post ids', () => {
    expect(getLocaleFromPostId('example-post')).toBe('en')
    expect(getLocaleFromPostId('example-post/zh')).toBe('zh')
    expect(getLocaleFromPostId('example-post/ko')).toBe('ko')
    expect(getLocaleFromPostId('example-post/ja')).toBe('ja')
    expect(getLocaleFromPostId('example-post/fr')).toBe('en')
  })

  it('builds localized blog URLs from ids', () => {
    expect(getPostLocalePath('example-post', 'en')).toBe('/blog/example-post')
    expect(getPostLocalePath('example-post', 'zh')).toBe(
      '/blog/example-post/zh',
    )
  })

  it('picks the first supported visitor language and falls back to English', () => {
    expect(pickPreferredLocale(['fr-FR', 'zh-CN', 'ja-JP'])).toBe('zh')
    expect(pickPreferredLocale(['ko-KR', 'en-US'])).toBe('ko')
    expect(pickPreferredLocale(['pt-BR'])).toBe('en')
  })

  it('localizes the registered author name without changing unknown authors', () => {
    expect(getAuthorDisplayName('erniesg', 'Chen Enjiao (Ernie)', 'zh')).toBe(
      '陈恩娇（Ernie）',
    )
    expect(getAuthorDisplayName('erniesg', 'fallback', 'en')).toBe(
      'Chen Enjiao (Ernie)',
    )
    expect(getAuthorDisplayName('guest', 'Guest Writer', 'zh')).toBe(
      'Guest Writer',
    )
  })

  it('localizes human-facing tags while preserving product names', () => {
    expect(getTagLabel('content', 'zh')).toBe('内容')
    expect(getTagLabel('engineering', 'zh')).toBe('工程')
    expect(getTagLabel('microdramas', 'zh')).toBe('微短剧')
    expect(getTagLabel('sinking markets', 'zh')).toBe('下沉市场')
    expect(getTagLabel('sinking markets', 'ko')).toBe('하침시장')
    expect(getTagLabel('sinking markets', 'ja')).toBe('下沈市場')
    expect(getTagLabel('cloudflare', 'zh')).toBe('Cloudflare')
    expect(getTagLabel('unknown', 'zh')).toBe('unknown')
  })

  it('defines every static UI key in every supported locale', () => {
    const englishKeys = Object.keys(STATIC_TRANSLATIONS.en)

    for (const locale of SUPPORTED_LOCALES) {
      const missingKeys = englishKeys.filter(
        (key) => !Object.hasOwn(STATIC_TRANSLATIONS[locale], key),
      )
      expect(missingKeys, `${locale} is missing static UI labels`).toEqual([])
    }
  })

  it('defines display labels for every tag used by published posts', async () => {
    const sourceFiles = await fg('src/content/blog/*/index.mdx')
    const usedTags = new Set<string>()

    for (const filePath of sourceFiles) {
      const frontmatter = matter(await fs.readFile(filePath, 'utf8')).data
      if (frontmatter.draft) continue
      for (const tag of frontmatter.tags ?? []) usedTags.add(String(tag))
    }

    for (const locale of SUPPORTED_LOCALES) {
      const missingTags = [...usedTags]
        .filter((tag) => !Object.hasOwn(TAG_LABELS[locale], tag))
        .sort()
      expect(missingTags, `${locale} is missing tag labels`).toEqual([])
    }
  })
})
