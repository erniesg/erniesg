import { describe, expect, it } from 'vitest'

import { navLinks } from '../consts'
import { includeInSitemap, papersListing } from './papers-listing'

describe('the /papers listing flag', () => {
  it('defaults to what /research did: listed in dev and staging only', () => {
    expect(papersListing({ DEV: true })).toBe('listed')
    expect(papersListing({ PUBLIC_RESEARCH_RELEASE: 'staging' })).toBe('listed')
    expect(papersListing({ PUBLIC_RESEARCH_RELEASE: 'production' })).toBe(
      'unlisted',
    )
    expect(papersListing({})).toBe('unlisted')
  })

  it('is one switch that overrides the default either way', () => {
    expect(
      papersListing({
        PUBLIC_PAPERS_LISTING: 'listed',
        PUBLIC_RESEARCH_RELEASE: 'production',
      }),
    ).toBe('listed')
    expect(
      papersListing({ PUBLIC_PAPERS_LISTING: 'unlisted', DEV: true }),
    ).toBe('unlisted')
    expect(papersListing({ PUBLIC_PAPERS_LISTING: 'yes', DEV: true })).toBe(
      'listed',
    )
  })

  it('keeps /papers out of the nav and the sitemap when off', () => {
    const hrefs = navLinks('unlisted').map((link) => link.href)

    expect(hrefs).not.toContain('/papers')
    expect(hrefs).toEqual(expect.arrayContaining(['/blog', '/books', '/library']))
    for (const pathname of ['/papers', '/papers/semantic-responsive-typesetting']) {
      expect(
        includeInSitemap(pathname, { listing: 'unlisted', production: false }),
      ).toBe(false)
    }
  })

  it('puts /papers in the nav and the sitemap when on', () => {
    expect(navLinks('listed').map((link) => link.href)).toContain('/papers')
    expect(
      includeInSitemap('/papers/semantic-responsive-typesetting', {
        listing: 'listed',
        production: false,
      }),
    ).toBe(true)
  })

  it('never lists a legacy redirect or a withheld production tree', () => {
    for (const pathname of ['/research', '/research/studio', '/study']) {
      expect(
        includeInSitemap(pathname, { listing: 'listed', production: false }),
      ).toBe(false)
    }
    expect(
      includeInSitemap('/library/pdf-review', {
        listing: 'listed',
        production: true,
      }),
    ).toBe(false)
    expect(
      includeInSitemap('/library', { listing: 'unlisted', production: true }),
    ).toBe(true)
    expect(
      includeInSitemap('/papersmith', { listing: 'unlisted', production: true }),
    ).toBe(true)
  })
})
