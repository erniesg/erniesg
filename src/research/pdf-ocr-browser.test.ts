import { describe, expect, it } from 'vitest'
import {
  createBrowserOcrSession,
  localBrowserOcrAssets,
  validateLocalOcrAssets,
  type BrowserOcrAssets,
  type TesseractWorkerAdapter,
} from './pdf-ocr-browser'

const assets: BrowserOcrAssets = {
  workerUrl: 'https://ernie.test/assets/ocr/worker.min.js',
  corePath: 'https://ernie.test/assets/ocr/',
  langPath: 'https://ernie.test/assets/ocr/',
  modelUrl: 'https://ernie.test/assets/ocr/eng.traineddata.gz',
}

describe('same-origin browser OCR', () => {
  it('uses stable same-origin paths for every emitted runtime asset', () => {
    expect(localBrowserOcrAssets('https://ernie.test')).toEqual({
      workerUrl: 'https://ernie.test/assets/ocr/worker.min.js',
      corePath: 'https://ernie.test/assets/ocr/',
      langPath: 'https://ernie.test/assets/ocr/',
      modelUrl: 'https://ernie.test/assets/ocr/eng.traineddata.gz',
    })
  })

  it('rejects a worker, core, or language asset outside the site origin', () => {
    expect(() =>
      validateLocalOcrAssets(assets, 'https://ernie.test'),
    ).not.toThrow()
    expect(() =>
      validateLocalOcrAssets(
        { ...assets, langPath: 'https://cdn.example/ocr/' },
        'https://ernie.test',
      ),
    ).toThrow(/same origin/i)
  })

  it('fails closed on an unavailable explicit language before creating a worker', async () => {
    let workerCreations = 0

    await expect(
      createBrowserOcrSession(
        { languages: ['deu'], languageMode: 'explicit' },
        {
          assets,
          origin: 'https://ernie.test',
          async createWorker() {
            workerCreations += 1
            throw new Error('must not create a worker')
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'OCR_LANGUAGE_UNAVAILABLE' })
    expect(workerCreations).toBe(0)
  })

  it('terminates a worker that finishes startup after cancellation', async () => {
    const controller = new AbortController()
    let terminations = 0
    const worker: TesseractWorkerAdapter = {
      async recognize() {
        throw new Error('recognition must not start')
      },
      async terminate() {
        terminations += 1
      },
    }

    await expect(
      createBrowserOcrSession(
        {
          languages: ['eng'],
          languageMode: 'explicit',
          signal: controller.signal,
        },
        {
          assets,
          origin: 'https://ernie.test',
          async createWorker() {
            controller.abort()
            return worker
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(terminations).toBe(1)
  })

  it('returns versioned word and line evidence and terminates once', async () => {
    let terminations = 0
    const worker: TesseractWorkerAdapter = {
      async recognize() {
        return {
          data: {
            confidence: 96,
            version: '5.3.4',
            text: 'Recovered local text',
            blocks: [
              {
                paragraphs: [
                  {
                    lines: [
                      {
                        text: 'Recovered local text',
                        confidence: 96,
                        bbox: { x0: 20, y0: 30, x1: 420, y1: 80 },
                        words: [
                          {
                            text: 'Recovered',
                            confidence: 97,
                            bbox: { x0: 20, y0: 30, x1: 200, y1: 80 },
                          },
                          {
                            text: 'local text',
                            confidence: 95,
                            bbox: { x0: 220, y0: 30, x1: 420, y1: 80 },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }
      },
      async terminate() {
        terminations += 1
      },
    }
    const session = await createBrowserOcrSession(
      { languages: ['eng'], languageMode: 'automatic-fallback' },
      {
        assets,
        origin: 'https://ernie.test',
        async createWorker(_languages, options) {
          expect(options).toMatchObject({
            workerPath: assets.workerUrl,
            corePath: assets.corePath,
            langPath: assets.langPath,
          })
          return worker
        },
      },
    )

    const result = await session.recognize({
      page: 2,
      rotation: 90,
      sourceSha256: 'a'.repeat(64),
      raster: {
        bytes: new Uint8Array([137, 80, 78, 71]),
        mediaType: 'image/png',
        width: 1000,
        height: 1200,
        sha256: 'b'.repeat(64),
      },
    })

    expect(result).toMatchObject({
      engine: 'tesseract.js',
      engineVersion: '6.0.1',
      model: 'tessdata_best_int',
      modelVersion: '4.0.0',
      languages: ['eng'],
      languageMode: 'automatic-fallback',
      raster: { width: 1000, height: 1200, sha256: 'b'.repeat(64) },
      words: [
        { text: 'Recovered', confidence: 0.97, lineId: 'ocr-p002-line-001' },
        { text: 'local text', confidence: 0.95, lineId: 'ocr-p002-line-001' },
      ],
      lines: [
        {
          id: 'ocr-p002-line-001',
          text: 'Recovered local text',
          confidence: 0.96,
        },
      ],
    })
    await session.terminate()
    await session.terminate()
    expect(terminations).toBe(1)
  })
})
