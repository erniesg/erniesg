import { describe, expect, it } from 'vitest'
import { navLinks, researchDocumentUri } from '../consts'
import { includeInSitemap, papersListing } from './papers-listing'
import { getStaticTranslation, SUPPORTED_LOCALES } from './i18n'

describe('published research and site sections', () => {
  it('preserves the annotation tenancy URI when paper routes move', () => {
    expect(researchDocumentUri('if-letters-home-could-sing')).toBe('https://ernie.sg/papers/if-letters-home-could-sing/')
    expect(researchDocumentUri('semantic-responsive-typesetting')).toBe('https://ernie.sg/papers/semantic-responsive-typesetting/')
  })
  it('publishes research even with a legacy unlisted override', () => {
    expect(
      papersListing({
        PUBLIC_RESEARCH_RELEASE: 'production',
        PUBLIC_PAPERS_LISTING: 'unlisted',
      }),
    ).toBe('listed')
  })
  it('limits production navigation to Blog and Research', () => {
    expect(navLinks({ PUBLIC_RESEARCH_RELEASE: 'production' })).toEqual([
      { href: '/blog', label: 'blog' },
      { href: '/research', label: 'research' },
    ])
  })
  it('shows the five sections on development and preview', () => {
    for (const env of [{ DEV: true }, { PUBLIC_RESEARCH_RELEASE: 'staging' }]) {
      expect(navLinks(env).map(({ href }) => href)).toEqual([
        '/blog',
        '/books',
        '/research',
        '/library',
        '/projects',
      ])
    }
  })
  it('localizes all five section labels', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const section of [
        'blog',
        'books',
        'research',
        'library',
        'projects',
      ]) {
        const key = `nav.${section}`
        expect(getStaticTranslation(key, locale)).not.toBe(key)
      }
    }
  })
  it('excludes retired URLs and all withheld production trees from the sitemap', () => {
    const options = { listing: 'listed' as const, production: true }
    for (const route of [
      '/papers',
      '/papers/example',
      '/study',
      '/research/studio',
      '/research/pdf-review',
      '/books',
      '/books/example',
      '/library',
      '/library/pdf-review',
      '/projects',
      '/projects/experiments',
    ]) {
      expect(includeInSitemap(route, options), route).toBe(false)
    }
    for (const route of [
      '/research',
      '/research/example',
      '/research/struct',
      '/blog',
      '/bookshelf',
    ]) {
      expect(includeInSitemap(route, options), route).toBe(true)
    }
    expect(
      includeInSitemap('/projects/experiments', {
        ...options,
        production: false,
      }),
    ).toBe(true)
  })
})
