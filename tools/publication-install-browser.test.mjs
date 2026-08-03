import { describe, expect, it } from 'vitest'
import { publicationBrowserInstallInvocation } from './publication-install-browser.mjs'

describe('publication browser installer', () => {
  it('invokes JavaScript entrypoints through the current Node runtime', () => {
    const invocation = publicationBrowserInstallInvocation()
    expect(invocation.playwright.command).toBe(process.execPath)
    expect(invocation.playwright.args[0]).toMatch(
      /node_modules[\\/]@playwright[\\/]test[\\/]cli\.js$/,
    )
    expect(invocation.puppeteer.command).toBe(process.execPath)
    expect(invocation.puppeteer.args[0]).toMatch(
      /node_modules[\\/]@puppeteer[\\/]browsers[\\/]lib[\\/]main-cli\.js$/,
    )
  })
})
