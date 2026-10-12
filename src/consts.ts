import type { PapersListingEnv } from './lib/papers-listing'

export type Site = {
  TITLE: string
  DESCRIPTION: string
  AUTHOR: string
  KEYWORDS: string[]
  SOCIAL_HANDLE: string
  EMAIL: string
  NUM_POSTS_ON_HOMEPAGE: number
  POSTS_PER_PAGE: number
  SITEURL: string
}

export type Link = {
  href: string
  label: string
}

export const SITE: Site = {
  TITLE: 'Ernie.SG',
  DESCRIPTION:
    'Senior AI engineer in Singapore building multilingual AI products, agent infrastructure, eval loops, and tools that turn messy workflows into production systems.',
  AUTHOR: 'Chen Enjiao (Ernie)',
  KEYWORDS: [
    'AI engineer',
    'forward deployed engineer',
    'field deployment engineering',
    'agent infrastructure',
    'AI evals',
    'multilingual AI',
    'newsroom AI',
    'developer tools',
    'Singapore',
  ],
  SOCIAL_HANDLE: '@erniesg',
  EMAIL: 'hello@ernie.sg',
  NUM_POSTS_ON_HOMEPAGE: 5,
  POSTS_PER_PAGE: 10,
  SITEURL: 'https://ernie.sg',
}

/** The five sections are visible in preview; production publishes Blog and Research. */
export function navLinks(env: PapersListingEnv): Link[] {
  const links = [
    { href: '/blog', label: 'blog' },
    { href: '/books', label: 'books' },
    { href: '/research', label: 'research' },
    { href: '/library', label: 'library' },
    { href: '/projects', label: 'projects' },
  ]
  return env.PUBLIC_RESEARCH_RELEASE === 'production'
    ? links.filter(({ href }) => href === '/blog' || href === '/research')
    : links
}

export const NAV_LINKS: Link[] = navLinks(import.meta.env)

/** Annotation tenancy is stable even when the public canonical paper route moves. */
export function researchDocumentUri(paperId: string): string {
  return new URL(`/papers/${paperId}/`, SITE.SITEURL).toString()
}

export const SOCIAL_LINKS: Link[] = [
  { href: 'https://github.com/erniesg', label: 'GitHub' },
  { href: 'https://twitter.com/erniesg', label: 'Twitter' },
  { href: 'https://www.linkedin.com/in/erniesg/', label: 'LinkedIn' },
  { href: 'https://www.youtube.com/@erniesg-ai/', label: 'YouTube' },
  { href: 'https://www.facebook.com/ernie1688/', label: 'Facebook' },
  { href: 'https://www.instagram.com/ernie0529/', label: 'Instagram' },
  { href: 'hello@ernie.sg', label: 'Email' },
  { href: '/rss.xml', label: 'RSS' },
]
