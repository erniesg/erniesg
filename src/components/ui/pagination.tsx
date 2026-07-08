import * as React from 'react'
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { type ButtonProps, buttonVariants } from '@/components/ui/button'
import { getStaticText, useSiteLocale } from '@/lib/use-site-locale'

type TranslatedPaginationProps = React.ComponentProps<'nav'> & {
  locale: ReturnType<typeof useSiteLocale>
}

const Pagination = ({
  className,
  locale,
  ...props
}: TranslatedPaginationProps) => (
  <nav
    role="navigation"
    aria-label={getStaticText(locale, 'ui.pagination')}
    className={cn('mx-auto flex w-full justify-center', className)}
    {...props}
  />
)
Pagination.displayName = 'Pagination'

const PaginationContent = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<'ul'>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    className={cn('flex flex-row items-center gap-1', className)}
    {...props}
  />
))
PaginationContent.displayName = 'PaginationContent'

const PaginationItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<'li'>
>(({ className, ...props }, ref) => (
  <li ref={ref} className={cn('', className)} {...props} />
))
PaginationItem.displayName = 'PaginationItem'

type PaginationLinkProps = {
  isActive?: boolean
  isDisabled?: boolean
} & Pick<ButtonProps, 'size'> &
  React.ComponentProps<'a'>

const PaginationLink = ({
  className,
  isActive,
  isDisabled,
  size = 'icon',
  ...props
}: PaginationLinkProps) => (
  <a
    aria-current={isActive ? 'page' : undefined}
    className={cn(
      buttonVariants({
        variant: isActive ? 'outline' : 'ghost',
        size,
      }),
      isDisabled && 'pointer-events-none opacity-50',
      className,
    )}
    {...props}
  />
)
PaginationLink.displayName = 'PaginationLink'

const PaginationPrevious = ({
  className,
  isDisabled,
  locale,
  ...props
}: React.ComponentProps<typeof PaginationLink> & {
  locale: ReturnType<typeof useSiteLocale>
}) => (
  <PaginationLink
    aria-label={getStaticText(locale, 'ui.previousPage')}
    size="default"
    className={cn('gap-1 pl-2.5', className)}
    isDisabled={isDisabled}
    {...props}
  >
    <ChevronLeft className="h-4 w-4" />
    <span>{getStaticText(locale, 'ui.previous')}</span>
  </PaginationLink>
)
PaginationPrevious.displayName = 'PaginationPrevious'

const PaginationNext = ({
  className,
  isDisabled,
  locale,
  ...props
}: React.ComponentProps<typeof PaginationLink> & {
  locale: ReturnType<typeof useSiteLocale>
}) => (
  <PaginationLink
    aria-label={getStaticText(locale, 'ui.nextPage')}
    size="default"
    className={cn('gap-1 pr-2.5', className)}
    isDisabled={isDisabled}
    {...props}
  >
    <span>{getStaticText(locale, 'ui.next')}</span>
    <ChevronRight className="h-4 w-4" />
  </PaginationLink>
)
PaginationNext.displayName = 'PaginationNext'

const PaginationEllipsis = ({
  className,
  locale,
  ...props
}: React.ComponentProps<'span'> & {
  locale: ReturnType<typeof useSiteLocale>
}) => (
  <span
    aria-hidden
    className={cn('flex h-9 w-9 items-center justify-center', className)}
    {...props}
  >
    <MoreHorizontal className="h-4 w-4" />
    <span className="sr-only">{getStaticText(locale, 'ui.morePages')}</span>
  </span>
)
PaginationEllipsis.displayName = 'PaginationEllipsis'

interface PaginationProps {
  currentPage: number
  totalPages: number
  baseUrl: string
}

const PaginationComponent: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  baseUrl,
}) => {
  const locale = useSiteLocale()
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1)

  const getPageUrl = (page: number) => {
    if (page === 1) return baseUrl
    return `${baseUrl}${page}`
  }

  return (
    <Pagination locale={locale}>
      <PaginationContent className="flex-wrap">
        <PaginationItem>
          <PaginationPrevious
            locale={locale}
            href={currentPage > 1 ? getPageUrl(currentPage - 1) : undefined}
            isDisabled={currentPage === 1}
          />
        </PaginationItem>

        {pages.map((page) => (
          <PaginationItem key={page}>
            <PaginationLink
              href={getPageUrl(page)}
              isActive={page === currentPage}
            >
              {page}
            </PaginationLink>
          </PaginationItem>
        ))}

        {totalPages > 5 && (
          <PaginationItem>
            <PaginationEllipsis locale={locale} />
          </PaginationItem>
        )}

        <PaginationItem>
          <PaginationNext
            locale={locale}
            href={
              currentPage < totalPages ? getPageUrl(currentPage + 1) : undefined
            }
            isDisabled={currentPage === totalPages}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

export default PaginationComponent
