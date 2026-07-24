import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createLogger, createServer } from 'vite'

import config from '../astro.config'

describe('Astro dependency optimization', () => {
  it('prebundles browser PDF.js without crawling the headless native canvas', async () => {
    expect(config).toMatchObject({
      vite: {
        optimizeDeps: {
          include: ['pdfjs-dist'],
          exclude: ['@napi-rs/canvas'],
        },
      },
    })

    const cacheDir = await mkdtemp(
      join(tmpdir(), 'srt-vite-native-dependency-'),
    )
    const optimizerErrors: string[] = []
    const logger = createLogger('silent')
    logger.error = (message, options) => {
      optimizerErrors.push(
        `${message}\n${options?.error?.message ?? options?.error ?? ''}`,
      )
    }
    const root = dirname(
      fileURLToPath(new URL('../package.json', import.meta.url)),
    )
    const server = await createServer({
      appType: 'custom',
      cacheDir,
      configFile: false,
      customLogger: logger,
      optimizeDeps: config.vite?.optimizeDeps,
      root,
      server: {
        middlewareMode: true,
      },
    })

    try {
      await server.transformRequest('/src/research/pdf.ts')
      const optimizer = server.environments.client.depsOptimizer
      expect(optimizer).toBeDefined()
      const dependencies = optimizer?.metadata.depInfoList ?? []
      const processing = dependencies.flatMap((dependency) =>
        dependency.processing ? [dependency.processing] : [],
      )
      const results = await Promise.allSettled(processing)

      expect(results.every((result) => result.status === 'fulfilled')).toBe(
        true,
      )
      expect(dependencies.map((dependency) => dependency.id)).not.toContain(
        '@napi-rs/canvas',
      )
      expect(optimizerErrors.join('\n')).not.toMatch(
        /@napi-rs\/canvas|UNLOADABLE_DEPENDENCY/u,
      )
    } finally {
      await server.close()
      await rm(cacheDir, { force: true, recursive: true })
    }
  }, 30_000)
})
