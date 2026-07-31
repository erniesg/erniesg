import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const viteMocks = vi.hoisted(() => ({
  createServer: vi.fn(),
}))

vi.mock('vite', () => ({
  createServer: viteMocks.createServer,
}))

import { createPdfPipeline } from './pdf-corpus-audit-lib.mjs'

describe('headless PDF pipeline runtime', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('disables filesystem watching for the one-shot Vite module graph', async () => {
    let serverOptions
    const close = vi.fn()
    const reconstructPdf = vi.fn()
    viteMocks.createServer.mockImplementation(async (options) => {
      serverOptions = options
      return {
        close,
        ssrLoadModule: vi.fn(async (path) => {
          if (path === '/src/research/pdf.ts') return { reconstructPdf }
          if (path === '/src/research/pdf-quality.ts') {
            return { DEFAULT_PDF_COMPLETENESS_POLICY: {} }
          }
          if (path === '/src/research/import-types.ts') {
            return { MAX_LOCAL_PDF_BYTES: 1 }
          }
          throw new Error(`Unexpected one-shot module request: ${path}`)
        }),
      }
    })

    const pipeline = await createPdfPipeline({ ocrEngine: 'none' })
    try {
      expect(serverOptions.server).toEqual({
        middlewareMode: true,
        watch: null,
      })
      expect(serverOptions.root).toBe(
        fileURLToPath(new URL('..', import.meta.url)),
      )
      expect(pipeline.reconstructPdf).toBe(reconstructPdf)
    } finally {
      await pipeline.close()
    }
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a one-shot server when its initial module graph fails', async () => {
    const close = vi.fn()
    const reconstructPdf = vi.fn()
    const ssrLoadModule = vi.fn(async (path) => {
      if (path === '/src/research/pdf.ts') return { reconstructPdf }
      if (path === '/src/research/pdf-quality.ts') {
        throw new Error('quality graph failed')
      }
      throw new Error(`Unexpected one-shot module request: ${path}`)
    })
    viteMocks.createServer.mockResolvedValue({
      close,
      ssrLoadModule,
    })

    await expect(createPdfPipeline({ ocrEngine: 'none' })).rejects.toThrow(
      'quality graph failed',
    )

    expect(ssrLoadModule.mock.calls.map(([path]) => path)).toEqual([
      '/src/research/pdf.ts',
      '/src/research/pdf-quality.ts',
    ])
    expect(close).toHaveBeenCalledOnce()
  })

  it('removes its temporary cache when Vite server creation fails', async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'srt-pdf-pipeline-startup-failure-'),
    )
    viteMocks.createServer.mockRejectedValue(
      new Error('vite server creation failed'),
    )

    try {
      await expect(
        createPdfPipeline({ ocrEngine: 'none', temporaryRoot }),
      ).rejects.toThrow('vite server creation failed')
      expect(await readdir(temporaryRoot)).toEqual([])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
