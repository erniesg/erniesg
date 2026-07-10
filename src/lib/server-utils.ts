import { getEntry } from 'astro:content'
import {
  DEFAULT_LOCALE,
  getAuthorDisplayName,
  type SupportedLocale,
} from '@/lib/i18n'

export async function parseAuthors(
  authors: string[],
  locale: SupportedLocale = DEFAULT_LOCALE,
) {
  if (!authors || authors.length === 0) return []

  const parseAuthor = async (id: string) => {
    try {
      const author = await getEntry('authors', id)
      return {
        id,
        name: getAuthorDisplayName(id, author?.data?.name || id, locale),
        avatar: author?.data?.avatar || '/static/logo.png',
        isRegistered: !!author,
      }
    } catch (error) {
      console.error(`Error fetching author with id ${id}:`, error)
      return {
        id,
        name: id,
        avatar: '/static/logo.png',
        isRegistered: false,
      }
    }
  }

  return await Promise.all(authors.map(parseAuthor))
}
