/**
 * The book's two looks: the site's reading shell, or the plain reader that
 * `books/tools/preview.py` draws. One build serves both; the choice is a
 * `data-book-look` attribute on <html>, set before first paint by the inline
 * script in `Head.astro` and changed by the switch in `BookBar.astro`.
 */
export const BOOK_LOOK_STORAGE_KEY = 'book-look'
export const BOOK_LOOK_ATTRIBUTE = 'data-book-look'
export const BOOK_LOOKS = ['site', 'plain'] as const
export type BookLook = (typeof BOOK_LOOKS)[number]
export const DEFAULT_BOOK_LOOK: BookLook = 'site'

export function isBookLook(value: string | null): value is BookLook {
  return BOOK_LOOKS.includes(value as BookLook)
}
