import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const build = 'chrome@150.0.7871.115'
const cacheRoot = resolve('node_modules/.cache/publication-browsers')
const playwrightCache = resolve(cacheRoot, 'playwright')
const puppeteerCache = resolve(cacheRoot, 'puppeteer')

execFileSync(resolve('node_modules/.bin/playwright'), ['install', 'chromium'], {
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
  execFileSync(
    resolve('node_modules/.bin/browsers'),
    ['install', build, '--path', puppeteerCache],
    {
      stdio: 'inherit',
    },
  )
}
