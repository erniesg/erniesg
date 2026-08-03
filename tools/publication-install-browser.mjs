import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const build = 'chrome@150.0.7871.115'
const cacheRoot = resolve('node_modules/.cache/publication-browsers')
const playwrightCache = resolve(cacheRoot, 'playwright')
const puppeteerCache = resolve(cacheRoot, 'puppeteer')

export function publicationBrowserInstallInvocation() {
  return {
    playwright: {
      command: process.execPath,
      args: [resolve('node_modules/@playwright/test/cli.js'), 'install', 'chromium'],
    },
    puppeteer: {
      command: process.execPath,
      args: [
        resolve('node_modules/@puppeteer/browsers/lib/main-cli.js'),
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
  execFileSync(
    invocation.playwright.command,
    invocation.playwright.args,
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: playwrightCache,
      },
    },
  )
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
