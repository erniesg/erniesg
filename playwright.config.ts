import { defineConfig } from '@playwright/test'
import path from 'node:path'

const evidenceRoot = process.env.AGENT_EVIDENCE_DIR ?? '.agent/evidence'
const staticBuildDirectory = process.env.SRT_STATIC_BUILD_DIR
const workersDevBaseUrl = process.env.SRT_WORKERS_DEV_BASE_URL
const devPort = process.env.SRT_E2E_PORT ?? '1234'
const devBaseUrl = `http://127.0.0.1:${devPort}`
const browserName =
  process.env.SRT_E2E_BROWSER === 'webkit' ? 'webkit' : 'chromium'

if (staticBuildDirectory && workersDevBaseUrl) {
  throw new Error(
    'SRT_STATIC_BUILD_DIR and SRT_WORKERS_DEV_BASE_URL are mutually exclusive',
  )
}

if (workersDevBaseUrl) {
  const parsed = new URL(workersDevBaseUrl)
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.workers.dev') ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'SRT_WORKERS_DEV_BASE_URL must be an origin-only HTTPS workers.dev URL',
    )
  }
}

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
    ...(staticBuildDirectory && browserName === 'chromium'
      ? { channel: 'chromium' as const }
      : {}),
    baseURL:
      workersDevBaseUrl ??
      (staticBuildDirectory ? 'https://srt-evaluation.test' : devBaseUrl),
    browserName,
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    contextOptions: { reducedMotion: 'reduce' },
    timezoneId: 'UTC',
    trace: workersDevBaseUrl ? 'off' : 'retain-on-failure',
    viewport: { width: 1440, height: 1200 },
  },
  webServer:
    staticBuildDirectory || workersDevBaseUrl
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
