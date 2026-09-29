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

/**
 * The mode Astro runs in, which decides which `.env.<mode>` files Vite gives
 * page modules. The config is evaluated before Astro resolves it, so read the
 * CLI's `--mode` directly; without one, a dev server is `development` and
 * everything else `production`.
 */
export function astroMode(
  argv: readonly string[] = process.argv,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--mode' && argv[index + 1]) return argv[index + 1]
    if (argument.startsWith('--mode=')) return argument.slice('--mode='.length)
  }
  return nodeEnv === 'development' ? 'development' : 'production'
}
