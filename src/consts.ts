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
    'Ernie is a full-stack A.I. Engineer and Editorial AI Lead based in Singapore. I write about multimodal AI, open source, generative agents and more in plain language.',
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
  { href: 'https://www.linkedin.com/in/erniesg/', label: 'LinkedIn' },
  { href: 'https://www.youtube.com/@erniesg-ai/', label: 'YouTube' },
  { href: 'https://www.facebook.com/ernie1688/', label: 'Facebook' },
  { href: 'https://www.instagram.com/ernie0529/', label: 'Instagram' },
  { href: 'hello@ernie.sg', label: 'Email' },
  { href: '/rss.xml', label: 'RSS' },
]
