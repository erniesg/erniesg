import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicationPlatformKey } from '../src/publication/platform.mjs'

const build = 'chrome@150.0.7871.115'
const runAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

const require = createRequire(import.meta.url)

// A production-only install (`npm ci --omit=dev`, NODE_ENV=production) still
// runs postinstall, but the browser tooling is a devDependency and is absent,
// and nothing such an install runs renders publications. What is on disk
// decides: npm has more ways to override omission (--include=dev,
// --production=false, config files) than its lifecycle environment shows, so
// installed tooling is always used, and the environment is consulted only to
// tell a deliberate omission from a broken full install.
function toolingInstalled() {
  try {
    require.resolve('playwright/package.json')
    return true
  } catch {
    return false
  }
}

function devDependenciesOmitted(env = process.env) {
  const listed = (value) => (value ?? '').split(/[\s,]+/).includes('dev')
  // Dev dependencies asked for and still missing is a broken install, not an omission.
  if (listed(env.npm_config_include)) return false
  return listed(env.npm_config_omit) || env.NODE_ENV === 'production'
}

if (runAsScript && !toolingInstalled() && devDependenciesOmitted()) {
  process.stdout.write(
    'Publication browser: dev dependencies omitted; skipping the browser install.\n',
  )
  process.exit(0)
}

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

if (runAsScript) {
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
