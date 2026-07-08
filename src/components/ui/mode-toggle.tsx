import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getStaticText, useSiteLocale } from '@/lib/use-site-locale'
import {
  THEME_STORAGE_KEY,
  isSiteTheme,
  type SiteTheme,
} from '@/lib/site-preferences'
import { Laptop, Moon, Sun } from 'lucide-react'
import * as React from 'react'

export function ModeToggle() {
  const locale = useSiteLocale()
  const t = (key: string) => getStaticText(locale, key)
  const [theme, setThemeState] = React.useState<SiteTheme>('system')

  React.useEffect(() => {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
    setThemeState(isSiteTheme(storedTheme) ? storedTheme : 'system')
  }, [])

  React.useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = () => {
      const isDark =
        theme === 'dark' || (theme === 'system' && mediaQuery.matches)

      document.documentElement.classList.add('disable-transitions')

      document.documentElement.classList[isDark ? 'add' : 'remove']('dark')

      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue('opacity')

      requestAnimationFrame(() => {
        document.documentElement.classList.remove('disable-transitions')
      })
    }

    localStorage.setItem(THEME_STORAGE_KEY, theme)
    applyTheme()

    if (theme !== 'system') return
    mediaQuery.addEventListener('change', applyTheme)
    return () => mediaQuery.removeEventListener('change', applyTheme)
  }, [theme])

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="group"
          title={t('ui.toggleTheme')}
        >
          <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">{t('ui.toggleTheme')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-background">
        <DropdownMenuItem onClick={() => setThemeState('theme-light')}>
          <Sun className="mr-2 size-4" />
          <span>{t('ui.theme.light')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setThemeState('dark')}>
          <Moon className="mr-2 size-4" />
          <span>{t('ui.theme.dark')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setThemeState('system')}>
          <Laptop className="mr-2 size-4" />
          <span>{t('ui.theme.system')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
