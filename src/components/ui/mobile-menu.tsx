import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NAV_LINKS } from '@/consts'
import { getStaticText, useSiteLocale } from '@/lib/use-site-locale'
import { Menu } from 'lucide-react'

const MobileMenu = () => {
  const [isOpen, setIsOpen] = useState(false)
  const locale = useSiteLocale()
  const t = (key: string) => getStaticText(locale, key)

  useEffect(() => {
    const handleViewTransitionStart = () => {
      setIsOpen(false)
    }

    document.addEventListener('astro:before-swap', handleViewTransitionStart)

    return () => {
      document.removeEventListener(
        'astro:before-swap',
        handleViewTransitionStart,
      )
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
              href={item.href}
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
