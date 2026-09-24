import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Rule: every Playwright spec runs under exactly one config, and every config
 * has a script that selects it. The book specs need the book's own preview
 * server; under the root config they hit Astro and fail, and a config no
 * script selects is never exercised.
 */
const ROOT = path.resolve(__dirname, '..')
const CONFIGS = ['playwright.config.ts', 'playwright.book.config.ts']

function listed(config: string): Set<string> {
  const out = execFileSync(
    path.join(ROOT, 'node_modules/.bin/playwright'),
    ['test', '--list', '--config', config],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SRT_STATIC_BUILD_DIR: '', SRT_WORKERS_DEV_BASE_URL: '' } },
  )
  const files = new Set<string>()
  for (const line of out.split('\n')) {
    const found = line.match(/([\w.-]+\.spec\.ts):\d+:\d+/)
    if (found) files.add(found[1])
  }
  return files
}

describe('Playwright configs', () => {
  it('run each spec under exactly one config', { timeout: 120_000 }, () => {
    const specs = readdirSync(path.join(ROOT, 'tests/e2e')).filter((name) => name.endsWith('.spec.ts'))
    const byConfig = CONFIGS.map(listed)
    for (const spec of specs) {
      const owners = CONFIGS.filter((_, index) => byConfig[index].has(spec))
      expect(owners, `${spec} must run under exactly one config`).toHaveLength(1)
    }
  })

  it('give every config a script that selects it', () => {
    const scripts = Object.values(
      JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>,
    )
    for (const config of CONFIGS) {
      const selects = (script: string) =>
        config === 'playwright.config.ts'
          ? /\bplaywright test\b/.test(script) && !/--config/.test(script)
          : script.includes(`--config ${config}`)
      expect(scripts.some(selects), `no script selects ${config}`).toBe(true)
    }
  })
})
