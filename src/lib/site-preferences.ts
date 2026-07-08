export const SITE_LOCALE_STORAGE_KEY = 'siteLang'
export const LEGACY_BLOG_LOCALE_STORAGE_KEY = 'blogLang'
export const SITE_LOCALE_CHANGE_EVENT = 'site-language-change'
export const LEGACY_BLOG_LOCALE_CHANGE_EVENT = 'blog-language-change'

export const THEME_STORAGE_KEY = 'theme'
export const SITE_THEME_VALUES = ['theme-light', 'dark', 'system'] as const
export type SiteTheme = (typeof SITE_THEME_VALUES)[number]

export function isSiteTheme(value: string | null): value is SiteTheme {
  return SITE_THEME_VALUES.includes(value as SiteTheme)
}
