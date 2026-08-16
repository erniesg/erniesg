import { describe, expect, it } from 'vitest'
import { publicationBrowserInstallInvocation } from './publication-install-browser.mjs'

describe('publication browser installer', () => {
  it('invokes JavaScript entrypoints through the current Node runtime', () => {
    const invocation = publicationBrowserInstallInvocation('linux', 'arm64')
    expect(invocation.playwright.command).toBe(process.execPath)
    expect(invocation.playwright.args[0]).toMatch(
      /node_modules[\\/]playwright[\\/]cli\.js$/,
    )
    expect(invocation.playwright.args[0]).not.toMatch(/@playwright[\\/]test/)
    expect(invocation.puppeteer.command).toBe(process.execPath)
    expect(invocation.puppeteer.args[0]).toMatch(
      /node_modules[\\/]@puppeteer[\\/]browsers[\\/]lib[\\/]main-cli\.js$/,
    )
  })

  it('fails before installation on unsupported OS and architecture pairs', () => {
    expect(() => publicationBrowserInstallInvocation('win32', 'x64')).toThrow(
      /Unsupported publication operating system/,
    )
    expect(() =>
      publicationBrowserInstallInvocation('linux', 'riscv64'),
    ).toThrow(/Unsupported publication architecture/)
  })
})
