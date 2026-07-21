import { defineConfig } from '@playwright/test'
import path from 'node:path'

const evidenceRoot = process.env.AGENT_EVIDENCE_DIR ?? '.agent/evidence'
const staticBuildDirectory = process.env.SRT_STATIC_BUILD_DIR
const devPort = process.env.SRT_E2E_PORT ?? '1234'
const devBaseUrl = `http://127.0.0.1:${devPort}`

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
    ...(staticBuildDirectory ? { channel: 'chromium' as const } : {}),
    baseURL: staticBuildDirectory ? 'https://srt-evaluation.test' : devBaseUrl,
    browserName: 'chromium',
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    contextOptions: { reducedMotion: 'reduce' },
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 1200 },
  },
  webServer: staticBuildDirectory
    ? undefined
    : {
        command: `ASTRO_DEV_BACKGROUND=0 npm run dev -- --host 127.0.0.1 --port ${devPort}`,
        url: `${devBaseUrl}/research`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
