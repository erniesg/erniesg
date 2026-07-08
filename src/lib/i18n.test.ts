import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCALE,
  getCanonicalPostId,
  getLocaleFromPostId,
  getLocalizedPostId,
  getPostLocalePath,
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
})
