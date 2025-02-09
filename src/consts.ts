export type Site = {
  TITLE: string
  DESCRIPTION: string
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
    'Full-stack A.I. Engineer and Editorial AI Lead. Writing about multimodal A.I., open source, generative agents and more in plain language.',
  EMAIL: 'hello@ernie.sg',
  NUM_POSTS_ON_HOMEPAGE: 5,
  POSTS_PER_PAGE: 10,
  SITEURL: 'https://ernie.sg',
}

export const NAV_LINKS: Link[] = [
  { href: '/blog', label: 'blog' },
  { href: '/about', label: 'about' },
  { href: '/tags', label: 'tags' },
]

export const SOCIAL_LINKS: Link[] = [
  { href: 'https://github.com/erniesg', label: 'GitHub' },
  { href: 'https://twitter.com/erniesg', label: 'Twitter' },
  { href: 'https://www.linkedin.com/in/erniesg', label: 'LinkedIn' },
  { href: 'mailto:hello@ernie.sg', label: 'Email' },
  { href: '/rss.xml', label: 'RSS' },
]
