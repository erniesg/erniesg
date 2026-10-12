import { describe, expect, it } from 'vitest'
import { localizedNavigationUrl, resolveDocumentLocale } from './page-locales'

describe('localizedNavigationUrl', () => {
  it('keeps the current query and fragment when moving to a localized full page', () => {
    expect(
      localizedNavigationUrl('/research/zh/', 'https://ernie.sg/research/?tab=notes#evidence'),
    ).toBe('https://ernie.sg/research/zh/?tab=notes#evidence')
  })

  it('keeps a native localized document when no preference is saved', () => {
    expect(resolveDocumentLocale(null, 'zh-Hans', 'en-US')).toBe('zh')
    expect(resolveDocumentLocale('en', 'zh-Hans', 'zh-CN')).toBe('en')
    expect(resolveDocumentLocale(null, 'en', 'ko-KR')).toBe('ko')
  })
})
