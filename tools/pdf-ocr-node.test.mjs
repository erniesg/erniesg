import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it, vi } from 'vitest'
import {
  auditPdfPath,
  createPdfPipeline,
  createPdfStructuralReceipt,
} from './pdf-corpus-audit-lib.mjs'
import {
  createNodeOcrSession,
  DEFAULT_HEADLESS_OCR_ENGINE,
  localNodeOcrAssets,
  normalizeHeadlessOcrEngine,
  validateLocalNodeOcrAssets,
} from './pdf-ocr-node.mjs'

const SCANNED_FIXTURE = 'tests/fixtures/pdf/scanned-page.pdf'

function privateLocalAssets() {
  return {
    workerPath: '/private/node_modules/tesseract.js/worker.js',
    langPath: '/private/node_modules/@tesseract.js-data/eng/model',
    modelPath:
      '/private/node_modules/@tesseract.js-data/eng/model/eng.traineddata.gz',
    corePaths: [
      '/private/node_modules/tesseract.js-core/core-lstm.js',
      '/private/node_modules/tesseract.js-core/core-simd-lstm.js',
    ],
  }
}

describe('headless local OCR', () => {
  it('defaults to disabled OCR and accepts only the explicit local engine', () => {
    expect(DEFAULT_HEADLESS_OCR_ENGINE).toBe('none')
    expect(normalizeHeadlessOcrEngine('none')).toBe('none')
    expect(normalizeHeadlessOcrEngine('tesseract')).toBe('tesseract')
    for (const value of ['', 'remote', 'auto', undefined]) {
      expect(() => normalizeHeadlessOcrEngine(value)).toThrow(
        'INVALID_OCR_ENGINE',
      )
    }
  })

  it('resolves every pinned OCR dependency to a readable local path', async () => {
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8'))
    const assets = await validateLocalNodeOcrAssets(localNodeOcrAssets())

    expect(packageManifest.dependencies).toMatchObject({
      '@napi-rs/canvas': '0.1.100',
      '@tesseract.js-data/eng': '1.0.0',
      'tesseract.js': '6.0.1',
      'tesseract.js-core': '6.1.2',
    })
    expect(
      [
        assets.workerPath,
        assets.langPath,
        assets.modelPath,
        ...assets.corePaths,
      ].every((path) => isAbsolute(path) && !/^[a-z]+:/iu.test(path)),
    ).toBe(true)
  })

  it('starts the worker with filesystem-only assets and no cache fallback', async () => {
    const terminate = vi.fn(async () => undefined)
    const recognize = vi.fn(async () => ({
      data: {
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    text: 'Local evidence',
                    confidence: 98,
                    bbox: { x0: 10, y0: 20, x1: 110, y1: 50 },
                    words: [
                      {
                        text: 'Local',
                        confidence: 99,
                        bbox: { x0: 10, y0: 20, x1: 50, y1: 50 },
                      },
                      {
                        text: 'evidence',
                        confidence: 97,
                        bbox: { x0: 55, y0: 20, x1: 110, y1: 50 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    }))
    const createWorker = vi.fn(async () => ({ recognize, terminate }))
    const accessFile = vi.fn(async () => undefined)
    const session = await createNodeOcrSession(
      { languages: ['eng'], languageMode: 'explicit' },
      {
        assets: privateLocalAssets(),
        accessFile,
        createWorker,
      },
    )

    const [languages, workerOptions] = createWorker.mock.calls[0]
    expect(languages).toEqual(['eng'])
    expect(workerOptions).toMatchObject({
      workerPath: '/private/node_modules/tesseract.js/worker.js',
      corePath: '/private/node_modules/tesseract.js-core',
      langPath: '/private/node_modules/@tesseract.js-data/eng/model',
      gzip: true,
      cacheMethod: 'none',
    })
    expect(JSON.stringify(workerOptions)).not.toMatch(/(?:https?|file|ftp):/iu)

    const recognition = await session.recognize({
      page: 3,
      rotation: 0,
      sourceSha256: 'a'.repeat(64),
      raster: {
        bytes: new Uint8Array([137, 80, 78, 71]),
        mediaType: 'image/png',
        width: 120,
        height: 80,
        sha256: 'b'.repeat(64),
      },
    })
    expect(recognition).toMatchObject({
      engine: 'tesseract.js',
      engineVersion: '6.0.1',
      model: 'tessdata_best_int',
      modelVersion: '4.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      raster: { width: 120, height: 80, sha256: 'b'.repeat(64) },
      words: [
        { text: 'Local', lineId: 'ocr-p003-line-001' },
        { text: 'evidence', lineId: 'ocr-p003-line-001' },
      ],
    })
    expect(Buffer.isBuffer(recognize.mock.calls[0][0])).toBe(true)
    await session.terminate()
    await session.terminate()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('fails closed before worker startup when a pinned asset is unavailable', async () => {
    const createWorker = vi.fn()
    await expect(
      createNodeOcrSession(
        { languages: ['eng'], languageMode: 'explicit' },
        {
          assets: privateLocalAssets(),
          accessFile: async () => {
            throw new Error('missing')
          },
          createWorker,
        },
      ),
    ).rejects.toMatchObject({ code: 'OCR_REQUIRED' })
    expect(createWorker).not.toHaveBeenCalled()

    await expect(
      createNodeOcrSession(
        { languages: ['eng'], languageMode: 'explicit' },
        {
          resolveModule() {
            throw new Error('missing package')
          },
          createWorker,
        },
      ),
    ).rejects.toMatchObject({ code: 'OCR_REQUIRED' })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('produces deterministic provenance while retaining low-confidence review gates', async () => {
    const pipeline = await createPdfPipeline({ ocrEngine: 'tesseract' })
    try {
      const first = await auditPdfPath(SCANNED_FIXTURE, pipeline)
      const second = await auditPdfPath(SCANNED_FIXTURE, pipeline)
      const firstPage = first.reconstruction.pages[0]
      const secondPage = second.reconstruction.pages[0]

      expect(firstPage).toMatchObject({
        kind: 'ocr-complete',
        ocr: {
          engine: 'tesseract.js',
          engineVersion: '6.0.1',
          model: 'tessdata_best_int',
          modelVersion: '4.0.0',
          languages: ['eng'],
          languageMode: 'explicit',
          sourceSha256: first.reconstruction.source.sha256,
        },
      })
      expect(firstPage.ocr.words.length).toBeGreaterThan(0)
      expect(firstPage.ocr).toEqual(secondPage.ocr)
      expect(createPdfStructuralReceipt(first.reconstruction)).toEqual(
        createPdfStructuralReceipt(second.reconstruction),
      )
      expect(first.reconstruction.readiness).toMatchObject({
        ready: false,
        blockingDiagnosticCodes: expect.arrayContaining([
          'LOW_CONFIDENCE_OCR',
          'OCR_REQUIRED',
        ]),
      })
      expect(first.reconstruction.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'NO_RECONSTRUCTABLE_TEXT' }),
        ]),
      )
    } finally {
      await pipeline.close()
    }
  }, 30_000)

  it('threads the explicit engine through the corpus CLI deterministically', async () => {
    const run = () =>
      spawnSync(
        process.execPath,
        [
          'tools/pdf-corpus-audit.mjs',
          '--report-only',
          '--ocr-engine',
          'tesseract',
          SCANNED_FIXTURE,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      )
    const first = run()
    const second = run()

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(first.stdout).toBe(second.stdout)
    const report = JSON.parse(first.stdout)
    expect(report).toMatchObject({
      schemaVersion: '1.7.0',
      reportSchema: 'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
      summary: {
        documents: 1,
        reviewRequired: 1,
        failureReasons: {
          LOW_CONFIDENCE_OCR: 1,
          OCR_REQUIRED: 1,
        },
      },
      documents: [
        {
          ocr: [
            {
              page: 1,
              engine: 'tesseract.js',
              engineVersion: '6.0.1',
              model: 'tessdata_best_int',
              modelVersion: '4.0.0',
              languages: ['eng'],
              languageMode: 'explicit',
              rasterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              confidence: expect.any(Number),
            },
          ],
        },
      ],
    })
    const [legacySchema, ocrSchema, provenanceSchema] = await Promise.all(
      [
        'docs/schemas/pdf-corpus-audit.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
        'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
      ].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
    )
    const ajv = new Ajv2020({ strict: false })
    for (const schema of [legacySchema, ocrSchema, provenanceSchema]) {
      ajv.addSchema(schema)
    }
    const validateLegacy = ajv.getSchema(legacySchema.$id)
    const validateOcr = ajv.getSchema(ocrSchema.$id)
    const validateProvenance = ajv.getSchema(provenanceSchema.$id)
    expect(validateLegacy(report)).toBe(false)
    expect(validateOcr(report)).toBe(false)
    expect(validateProvenance(report), validateProvenance.errors).toBe(true)
    expect(first.stdout).not.toContain('NO_RECONSTRUCTABLE_TEXT')
  }, 30_000)

  it('recognizes the scanned fixture with outbound network APIs denied', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-ocr-offline-'))
    const preload = join(directory, 'deny-network.cjs')
    try {
      await writeFile(
        preload,
        `'use strict'
const forbidden = () => { throw new Error('OUTBOUND_NETWORK_FORBIDDEN') }
for (const name of ['node:http', 'node:https']) {
  const module = require(name)
  module.request = forbidden
  module.get = forbidden
}
const net = require('node:net')
net.connect = forbidden
net.createConnection = forbidden
net.Socket.prototype.connect = forbidden
const tls = require('node:tls')
tls.connect = forbidden
const dgram = require('node:dgram')
dgram.createSocket = forbidden
globalThis.fetch = forbidden
`,
      )
      const result = spawnSync(
        process.execPath,
        [
          'tools/pdf-corpus-audit.mjs',
          '--report-only',
          '--ocr-engine=tesseract',
          SCANNED_FIXTURE,
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
              .filter(Boolean)
              .join(' '),
          },
        },
      )

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        documents: [
          {
            ocr: [
              {
                engine: 'tesseract.js',
                model: 'tessdata_best_int',
              },
            ],
          },
        ],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
