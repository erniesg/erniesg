/**
 * Whether `/papers` is listed: in the nav and in the sitemap.
 *
 * Listing is not existence. The surface exists in every build and answers by
 * direct URL whatever this says; the flag decides only whether the site
 * points at it. Listing it publicly is an act of publishing and the owner's
 * call (ADR 010), so the default is exactly what `/research` did before it
 * was renamed: listed in dev and on staging, unlisted everywhere else.
 *
 * `PUBLIC_PAPERS_LISTING=listed` or `=unlisted` overrides that default,
 * except in a production build, which withholds `/papers` and never lists it.
 */
export type PapersListing = 'listed' | 'unlisted'

export type PapersListingEnv = {
  DEV?: boolean
  PUBLIC_PAPERS_LISTING?: string
  PUBLIC_RESEARCH_RELEASE?: string
}

export function papersListing(env: PapersListingEnv): PapersListing {
  // A production build withholds /papers entirely (release-gate.mjs), so no
  // override can list it: the link would be a 404.
  if (env.PUBLIC_RESEARCH_RELEASE === 'production') return 'unlisted'
  if (
    env.PUBLIC_PAPERS_LISTING === 'listed' ||
    env.PUBLIC_PAPERS_LISTING === 'unlisted'
  ) {
    return env.PUBLIC_PAPERS_LISTING
  }
  return env.DEV || env.PUBLIC_RESEARCH_RELEASE === 'staging'
    ? 'listed'
    : 'unlisted'
}

/** URL prefixes that only redirect now, and so never belong in a sitemap. */
const LEGACY_PREFIXES = ['/research', '/study']

/** Trees a production build withholds; see `tools/deployment/release-gate.mjs`. */
const WITHHELD_IN_PRODUCTION = ['/papers', '/library/pdf-review']

function under(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function includeInSitemap(
  pathname: string,
  options: { listing: PapersListing; production: boolean },
): boolean {
  if (LEGACY_PREFIXES.some((prefix) => under(pathname, prefix))) return false
  if (options.listing === 'unlisted' && under(pathname, '/papers')) return false
  if (
    options.production &&
    WITHHELD_IN_PRODUCTION.some((prefix) => under(pathname, prefix))
  ) {
    return false
  }
  return true
}
