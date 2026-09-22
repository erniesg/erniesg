import { defineConfig } from '@playwright/test'
import path from 'node:path'

// The challenges book is served by its own local preview, not Astro.
// Pick once and export, so the workers that re-load this file agree on it.
process.env.PREVIEW_PORT ??= String(8700 + Math.floor(Math.random() * 200))
const port = process.env.PREVIEW_PORT
const python = process.env.BOOK_PYTHON ?? 'python3'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['editor-keys.spec.ts', 'hint-ladder.spec.ts', 'inline-exercise.spec.ts', 'run-cell.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: path.resolve(process.env.AGENT_EVIDENCE_DIR ?? '.agent/evidence', 'playwright-book'),
  reporter: [['line']],
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: process.env.BOOK_BROWSER === 'webkit' ? 'webkit' : 'chromium', viewport: { width: 1280, height: 1000 } },
  webServer: {
    command: `${python} challenges/tools/preview.py --port ${port} --no-open`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
