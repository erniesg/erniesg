#!/usr/bin/env node
/**
 * Run one Playwright spec on a port nobody else is using.
 *
 * `playwright.config.ts` reads `SRT_E2E_PORT` and otherwise binds every run to
 * 1234. Up to sixteen issue workers share this host, so a fixed port is a
 * guaranteed collision and sampling a range is a likely one. This asks the
 * kernel for a free port instead, and only sets the variable the config
 * already knows about.
 *
 *   npm run test:e2e:spec -- tests/e2e/margin-anchoring.spec.ts
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: npm run test:e2e:spec -- <spec> [playwright args]')
  process.exit(2)
}

const port = process.env.SRT_E2E_PORT ?? String(await freePort())
const result = spawnSync('npx', ['playwright', 'test', ...args], {
  stdio: 'inherit',
  env: { ...process.env, SRT_E2E_PORT: port },
})
process.exit(result.status ?? 1)
