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
import { Check, Languages } from 'lucide-react'
import * as React from 'react'

const supportedLocales = new Set<string>(SUPPORTED_LOCALES)

function getCurrentBlogPostPath(locale: SupportedLocale) {
  const parts = window.location.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'blog' || !parts[1]) return null
  if (/^\d+$/.test(parts[1])) return null

  const lastPart = parts.at(-1)
  const hasLocaleSuffix = lastPart ? supportedLocales.has(lastPart) : false
  const canonicalParts = hasLocaleSuffix ? parts.slice(0, -1) : parts

  if (canonicalParts.length !== 2) return null

  return `/${[...canonicalParts, ...(locale === 'en' ? [] : [locale])].join('/')}`
}

export function LanguageToggle() {
  const [locale, setLocale] = React.useState<SupportedLocale>('en')
  const t = (key: string) => getStaticText(locale, key)

  React.useEffect(() => {
    const savedLocale = normalizeLocalePreference(localStorage.getItem('blogLang'))
    const nextLocale = localStorage.getItem('blogLang')
      ? savedLocale
      : detectPreferredLocale()

    localStorage.setItem('blogLang', nextLocale)
    setLocale(nextLocale)
    window.dispatchEvent(
      new CustomEvent('blog-language-change', {
        detail: { locale: nextLocale },
      }),
    )
  }, [])

  function chooseLocale(nextLocale: SupportedLocale) {
    localStorage.setItem('blogLang', nextLocale)
    setLocale(nextLocale)
    window.dispatchEvent(
      new CustomEvent('blog-language-change', {
        detail: { locale: nextLocale },
      }),
    )

    const nextPath = getCurrentBlogPostPath(nextLocale)
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
