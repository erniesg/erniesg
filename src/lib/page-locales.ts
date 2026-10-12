import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './i18n'

/** Make a locale route a full-document navigation while retaining reader state in the URL. */
export function localizedNavigationUrl(
  localizedPath: string,
  currentUrl: string,
): string {
  const current = new URL(currentUrl)
  const target = new URL(localizedPath, current.origin)
  target.search = current.search
  target.hash = current.hash
  return target.toString()
}

/** A native localized document wins only when the reader has not saved a choice. */
export function resolveDocumentLocale(
  storedLocale: string | null,
  documentLang: string,
  browserLocale: string,
): SupportedLocale {
  const normalize = (value: string) => {
    const primary = value.toLowerCase().split('-')[0]
    return SUPPORTED_LOCALES.includes(primary as SupportedLocale)
      ? (primary as SupportedLocale)
      : DEFAULT_LOCALE
  }
  if (storedLocale) return normalize(storedLocale)
  const declared = normalize(documentLang)
  return declared !== DEFAULT_LOCALE
    ? declared
    : normalize(browserLocale)
}
