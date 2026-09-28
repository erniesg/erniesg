import { loadEnv } from 'vite'
import type { PapersListingEnv } from './papers-listing'

/**
 * The listing inputs as page modules see them through `import.meta.env`.
 *
 * `astro.config.ts` is evaluated before Vite adds `.env` values to the
 * environment, so reading `process.env` there would miss an override kept in
 * `.env`: the nav would honour it and the sitemap would not. This loads the
 * mode's `.env` files the way Vite does, with the invoking shell winning.
 * Node-only: the config imports it, client code must not.
 */
export function papersListingEnv(
  mode: string,
  root: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): PapersListingEnv {
  const fromFiles = loadEnv(mode, root, 'PUBLIC_')
  const read = (key: string) => processEnv[key] ?? fromFiles[key]
  return {
    DEV: mode === 'development',
    PUBLIC_PAPERS_LISTING: read('PUBLIC_PAPERS_LISTING'),
    PUBLIC_RESEARCH_RELEASE: read('PUBLIC_RESEARCH_RELEASE'),
  }
}
