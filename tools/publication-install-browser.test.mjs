import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // A production-only install (`npm ci --omit=dev`) still runs postinstall, but
  // Playwright and @puppeteer/browsers are devDependencies and are absent.
  it('skips cleanly when dev dependencies were omitted, and only then', () => {
    const root = mkdtempSync(join(tmpdir(), 'publication-install-'))
    try {
      mkdirSync(join(root, 'tools'))
      mkdirSync(join(root, 'src/publication'), { recursive: true })
      copyFileSync(
        new URL('./publication-install-browser.mjs', import.meta.url),
        join(root, 'tools/publication-install-browser.mjs'),
      )
      copyFileSync(
        new URL('../src/publication/platform.mjs', import.meta.url),
        join(root, 'src/publication/platform.mjs'),
      )
      const run = (env) =>
        spawnSync(process.execPath, ['tools/publication-install-browser.mjs'], {
          cwd: root,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, ...env },
        })

      const omitted = run({ npm_config_omit: 'dev' })
      expect(omitted.status).toBe(0)
      expect(omitted.stdout).toMatch(/dev dependencies omitted; skipping/)

      const production = run({ NODE_ENV: 'production' })
      expect(production.status).toBe(0)

      // A full install with the tooling missing is a real fault: it still fails.
      const full = run({})
      expect(full.status).not.toBe(0)
      expect(full.stderr).toMatch(/playwright/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
