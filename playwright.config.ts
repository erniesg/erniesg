import { defineConfig } from '@playwright/test'
import path from 'node:path'

const evidenceRoot = process.env.AGENT_EVIDENCE_DIR ?? '.agent/evidence'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  outputDir: path.resolve(evidenceRoot, 'playwright'),
  reporter: [['line']],
  updateSnapshots: 'none',
  use: {
    baseURL: 'http://127.0.0.1:1234',
    browserName: 'chromium',
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    contextOptions: { reducedMotion: 'reduce' },
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 1200 },
  },
  webServer: {
    command: 'ASTRO_DEV_BACKGROUND=0 npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:1234/research',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
