import * as React from 'react'
import {
  DEFAULT_LOCALE,
  STATIC_TRANSLATIONS,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './i18n'
import {
  LEGACY_BLOG_LOCALE_CHANGE_EVENT,
  LEGACY_BLOG_LOCALE_STORAGE_KEY,
  SITE_LOCALE_CHANGE_EVENT,
  SITE_LOCALE_STORAGE_KEY,
} from './site-preferences'

const supportedLocaleSet = new Set<string>(SUPPORTED_LOCALES)

export function normalizeLocalePreference(
  locale: string | null | undefined,
): SupportedLocale {
  const primary = locale?.toLowerCase().split('-')[0]
  return primary && supportedLocaleSet.has(primary)
    ? (primary as SupportedLocale)
    : DEFAULT_LOCALE
}

export function detectPreferredLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE

  const languages = navigator.languages?.length
    ? navigator.languages
    : [navigator.language]

  for (const language of languages) {
    const locale = normalizeLocalePreference(language)
    if (locale !== DEFAULT_LOCALE) return locale
  }

  return DEFAULT_LOCALE
}

export function getCurrentLocalePreference(): SupportedLocale {
  if (typeof window !== 'undefined') {
    const parts = window.location.pathname.split('/').filter(Boolean)
    const routeLocale = parts.at(-1)
    if (
      parts[0] === 'blog' &&
      parts.length >= 2 &&
      routeLocale &&
      supportedLocaleSet.has(routeLocale)
    ) {
      return routeLocale as SupportedLocale
    }
  }

  if (typeof localStorage === 'undefined') return DEFAULT_LOCALE

  const savedLocale =
    localStorage.getItem(SITE_LOCALE_STORAGE_KEY) ??
    localStorage.getItem(LEGACY_BLOG_LOCALE_STORAGE_KEY)
  return savedLocale
    ? normalizeLocalePreference(savedLocale)
    : detectPreferredLocale()
}

export function getStaticText(locale: SupportedLocale, key: string): string {
  return (
    STATIC_TRANSLATIONS[locale]?.[key] ??
    STATIC_TRANSLATIONS[DEFAULT_LOCALE]?.[key] ??
    key
  )
}

export function useSiteLocale(): SupportedLocale {
  const [locale, setLocale] = React.useState<SupportedLocale>(DEFAULT_LOCALE)

  React.useEffect(() => {
    const syncLocale = () => {
      const nextLocale = getCurrentLocalePreference()
      localStorage.setItem(SITE_LOCALE_STORAGE_KEY, nextLocale)
      setLocale(nextLocale)
      window.dispatchEvent(
        new CustomEvent(SITE_LOCALE_CHANGE_EVENT, {
          detail: { locale: nextLocale },
        }),
      )
    }
    syncLocale()
    document.addEventListener('astro:page-load', syncLocale)

    const handleLanguageChange = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      setLocale(normalizeLocalePreference(event.detail?.locale))
    }

    window.addEventListener(SITE_LOCALE_CHANGE_EVENT, handleLanguageChange)
    window.addEventListener(
      LEGACY_BLOG_LOCALE_CHANGE_EVENT,
      handleLanguageChange,
    )

    return () => {
      document.removeEventListener('astro:page-load', syncLocale)
      window.removeEventListener(SITE_LOCALE_CHANGE_EVENT, handleLanguageChange)
      window.removeEventListener(
        LEGACY_BLOG_LOCALE_CHANGE_EVENT,
        handleLanguageChange,
      )
    }
  }, [])

  return locale
}
