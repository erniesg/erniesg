import * as React from 'react'
import {
  DEFAULT_LOCALE,
  STATIC_TRANSLATIONS,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@/lib/i18n'
import {
  LEGACY_BLOG_LOCALE_CHANGE_EVENT,
  LEGACY_BLOG_LOCALE_STORAGE_KEY,
  SITE_LOCALE_CHANGE_EVENT,
  SITE_LOCALE_STORAGE_KEY,
} from '@/lib/site-preferences'

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
    setLocale(getCurrentLocalePreference())

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
      window.removeEventListener(SITE_LOCALE_CHANGE_EVENT, handleLanguageChange)
      window.removeEventListener(
        LEGACY_BLOG_LOCALE_CHANGE_EVENT,
        handleLanguageChange,
      )
    }
  }, [])

  return locale
}
