import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  LOCALE_LABELS,
  LOCALE_SHORT_LABELS,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@/lib/i18n'
import {
  detectPreferredLocale,
  getStaticText,
  normalizeLocalePreference,
} from '@/lib/use-site-locale'
import {
  LEGACY_BLOG_LOCALE_STORAGE_KEY,
  SITE_LOCALE_CHANGE_EVENT,
  SITE_LOCALE_STORAGE_KEY,
} from '@/lib/site-preferences'
import { Check, Languages } from 'lucide-react'
import * as React from 'react'

function getLocalizedPagePath(locale: SupportedLocale) {
  const mapElement = document.getElementById('site-locale-paths')
  if (!mapElement?.textContent) return null

  try {
    const paths = JSON.parse(mapElement.textContent) as Partial<
      Record<SupportedLocale, string>
    >
    return paths[locale] ?? null
  } catch {
    return null
  }
}

function dispatchLocaleChange(locale: SupportedLocale) {
  window.dispatchEvent(
    new CustomEvent(SITE_LOCALE_CHANGE_EVENT, {
      detail: { locale },
    }),
  )
}

export function LanguageToggle() {
  const [locale, setLocale] = React.useState<SupportedLocale>('en')
  const t = (key: string) => getStaticText(locale, key)

  React.useEffect(() => {
    const storedLocale =
      localStorage.getItem(SITE_LOCALE_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_BLOG_LOCALE_STORAGE_KEY)
    const nextLocale = storedLocale
      ? normalizeLocalePreference(storedLocale)
      : detectPreferredLocale()

    localStorage.setItem(SITE_LOCALE_STORAGE_KEY, nextLocale)
    setLocale(nextLocale)
    dispatchLocaleChange(nextLocale)
  }, [])

  function chooseLocale(nextLocale: SupportedLocale) {
    localStorage.setItem(SITE_LOCALE_STORAGE_KEY, nextLocale)
    setLocale(nextLocale)
    dispatchLocaleChange(nextLocale)

    const nextPath = getLocalizedPagePath(nextLocale)
    if (nextPath && nextPath !== window.location.pathname) {
      window.location.assign(nextPath)
    }
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="group relative"
          data-language-trigger
          title={t('ui.changeLanguage')}
        >
          <Languages className="size-4" />
          <span className="absolute -bottom-1 -right-1 rounded-sm bg-background px-0.5 text-[0.6rem] font-semibold leading-none text-muted-foreground">
            {LOCALE_SHORT_LABELS[locale]}
          </span>
          <span className="sr-only">{t('ui.changeLanguage')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-background">
        {SUPPORTED_LOCALES.map((item) => (
          <DropdownMenuItem
            key={item}
            data-language-choice={item}
            onClick={() => chooseLocale(item)}
          >
            <span className="mr-2 w-5 text-center text-xs font-semibold">
              {LOCALE_SHORT_LABELS[item]}
            </span>
            <span>{LOCALE_LABELS[item]}</span>
            {item === locale && <Check className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
