import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicationPlatformKey } from '../src/publication/platform.mjs'

const build = 'chrome@150.0.7871.115'
const require = createRequire(import.meta.url)
const playwrightRoot = dirname(require.resolve('playwright/package.json'))
const nodeModulesRoot = resolve(playwrightRoot, '..')
const cacheRoot = resolve(nodeModulesRoot, '.cache/publication-browsers')
const playwrightCache = resolve(cacheRoot, 'playwright')
const puppeteerCache = resolve(cacheRoot, 'puppeteer')

export function publicationBrowserInstallInvocation(
  platform = process.platform,
  architecture = process.arch,
) {
  publicationPlatformKey(platform, architecture)
  return {
    playwright: {
      command: process.execPath,
      args: [resolve(playwrightRoot, 'cli.js'), 'install', 'chromium'],
    },
    puppeteer: {
      command: process.execPath,
      args: [
        require.resolve('@puppeteer/browsers/lib/main-cli.js'),
        'install',
        build,
        '--path',
        puppeteerCache,
      ],
    },
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const invocation = publicationBrowserInstallInvocation()
  execFileSync(invocation.playwright.command, invocation.playwright.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: playwrightCache,
    },
  })
  if (process.arch === 'arm64') {
    process.stdout.write(
      'Publication browser: ARM64 uses the pinned Playwright Chromium compatibility revision.\n',
    )
  } else {
    execFileSync(invocation.puppeteer.command, invocation.puppeteer.args, {
      stdio: 'inherit',
    })
  }
}
