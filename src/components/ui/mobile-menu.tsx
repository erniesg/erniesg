import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NAV_LINKS } from '@/consts'
import { detectPreferredLocale, getStaticText } from '@/lib/use-site-locale'
import { type SupportedLocale, SUPPORTED_LOCALES } from '@/lib/i18n'
import { resolveDocumentLocale } from '@/lib/page-locales'
import {
  SITE_LOCALE_CHANGE_EVENT,
  SITE_LOCALE_STORAGE_KEY,
  LEGACY_BLOG_LOCALE_STORAGE_KEY,
} from '@/lib/site-preferences'
import { Menu } from 'lucide-react'

const supportedLocaleSet = new Set(SUPPORTED_LOCALES)

function getLocaleFromPathname(pathname: string): SupportedLocale | null {
  const segments = pathname.split('/').filter(Boolean)
  // URLs are structured as /<section>/<locale>/ (e.g., /research/zh/, /about/ja/)
  // The locale is the second segment if the first is a known section
  const knownSections = ['research', 'about', 'blog', 'tags', 'books', 'library', 'projects']
  if (segments.length >= 2 && knownSections.includes(segments[0])) {
    const localeSegment = segments[1]
    if (supportedLocaleSet.has(localeSegment) && localeSegment !== 'en') {
      return localeSegment as SupportedLocale
    }
  }
  return null
}

const MobileMenu = () => {
  const [isOpen, setIsOpen] = useState(false)
  const [locale, setLocale] = useState<SupportedLocale>('en')
  const [navHrefs, setNavHrefs] = useState<Record<string, string>>({})
  const t = (key: string) => getStaticText(locale, key)

  useEffect(() => {
    const syncDocumentNavigation = () => {
      let storedLocale: string | null = null
      try {
        storedLocale =
          localStorage.getItem(SITE_LOCALE_STORAGE_KEY) ??
          localStorage.getItem(LEGACY_BLOG_LOCALE_STORAGE_KEY)
      } catch {
        /* Reading navigation does not require preference storage. */
      }
      // First try to get locale from URL pathname (for native localized routes)
      const urlLocale = getLocaleFromPathname(window.location.pathname)
      const documentLocale =
        document
          .querySelector('meta[name="site-document-locale"]')
          ?.getAttribute('content') ?? document.documentElement.lang
      const resolvedLocale = urlLocale ??
        resolveDocumentLocale(storedLocale, documentLocale, detectPreferredLocale())
      setLocale(resolvedLocale)
      const hrefs: Record<string, string> = {}
      // These are the incoming page's actual, build-validated destinations.
      document
        .querySelectorAll<HTMLAnchorElement>('header nav a[data-header-link]')
        .forEach((link) => {
          const target = link.dataset.headerLink
          const href = link.getAttribute('href')
          if (target && href) hrefs[target] = href
        })
      setNavHrefs(hrefs)
    }
    syncDocumentNavigation()
    const handleViewTransitionStart = () => {
      setIsOpen(false)
    }

    document.addEventListener('astro:before-swap', handleViewTransitionStart)
    document.addEventListener('astro:page-load', syncDocumentNavigation)
    window.addEventListener(SITE_LOCALE_CHANGE_EVENT, syncDocumentNavigation)
    // Also listen to popstate for navigations that don't trigger astro:page-load
    window.addEventListener('popstate', syncDocumentNavigation)

    return () => {
      document.removeEventListener(
        'astro:before-swap',
        handleViewTransitionStart,
      )
      document.removeEventListener('astro:page-load', syncDocumentNavigation)
      window.removeEventListener(
        SITE_LOCALE_CHANGE_EVENT,
        syncDocumentNavigation,
      )
      window.removeEventListener('popstate', syncDocumentNavigation)
    }
  }, [])

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="md:hidden"
          title={t('ui.menu')}
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">{t('ui.toggleMenu')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-background">
        {NAV_LINKS.map((item) => (
          <DropdownMenuItem key={item.href} asChild>
            <a
              href={navHrefs[item.href] ?? item.href}
              className="w-full text-lg font-medium capitalize"
              onClick={() => setIsOpen(false)}
            >
              {t(`nav.${item.label}`)}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default MobileMenu
