/** Compatibility names retained for existing build environment callers. Research is published. */
export type PapersListing = 'listed' | 'unlisted'
export type PapersListingEnv = {
  DEV?: boolean
  PUBLIC_PAPERS_LISTING?: string
  PUBLIC_RESEARCH_RELEASE?: string
}
export function papersListing(_env: PapersListingEnv): PapersListing {
  return 'listed'
}
function under(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}
export function includeInSitemap(
  pathname: string,
  options: { listing: PapersListing; production: boolean },
): boolean {
  if (
    ['/papers', '/study', '/research/studio', '/research/pdf-review'].some(
      (prefix) => under(pathname, prefix),
    )
  )
    return false
  if (
    options.production &&
    ['/books', '/library', '/projects'].some((prefix) =>
      under(pathname, prefix),
    )
  )
    return false
  return true
}
