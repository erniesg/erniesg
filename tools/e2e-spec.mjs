#!/usr/bin/env node
/**
 * Run one Playwright spec on a port nobody else is using.
 *
 * `playwright.config.ts` reads `SRT_E2E_PORT` and otherwise binds every run to
 * 1234. Up to sixteen issue workers share this host, so a fixed port is a
 * guaranteed collision and sampling a range is a likely one. This asks the
 * kernel for a free port and claims it with `tools/e2e-port.mjs`'s lock, so two
 * workers are never handed the same one, and only sets the variable the config
 * already knows about.
 *
 *   npm run test:e2e:spec -- tests/e2e/margin-anchoring.spec.ts
 */
import { spawnSync } from 'node:child_process'
import { lockedPort } from './e2e-port.mjs'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: npm run test:e2e:spec -- <spec> [playwright args]')
  process.exit(2)
}

// The lock is held by this process, which lives for the whole Playwright run
// (spawnSync), so no other worker can be handed the port meanwhile.
const port = process.env.SRT_E2E_PORT ?? String(await lockedPort({ owner: process.pid }))
const result = spawnSync('npx', ['playwright', 'test', ...args], {
  stdio: 'inherit',
  env: { ...process.env, SRT_E2E_PORT: port },
})
process.exit(result.status ?? 1)
