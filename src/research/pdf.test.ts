import { afterEach, describe, expect, it, vi } from 'vitest'
import { strFromU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import { buildEpub, inspectEpub } from './epub'
import { PdfImportError } from './import-types'
import { reconstructPdf } from './pdf'
import type { PdfOcrOptions, PdfOcrRecognition, PdfOcrSession } from './pdf-ocr'
import {
  fixtureFile,
  oversizedPdfFixture,
} from '../../tests/fixtures/pdf-fixtures'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PDF.js browser ingestion', () => {
  it('runs a textless page through a bounded local OCR session', async () => {
    let terminated = 0
    const recognizedPages: number[] = []
    const session: PdfOcrSession = {
      async recognize(request) {
        recognizedPages.push(request.page)
        return {
          engine: 'test-local-ocr',
          engineVersion: '1.0.0',
          model: 'synthetic-eng',
          modelVersion: '1.0.0',
          languages: ['eng'],
          languageMode: 'automatic-fallback',
          raster: {
            width: request.raster.width,
            height: request.raster.height,
            sha256: request.raster.sha256,
          },
          words: [
            {
              text: 'Recovered',
              confidence: 0.98,
              bbox: { x0: 100, y0: 120, x1: 220, y1: 190 },
              lineId: 'line-1',
            },
            {
              text: 'scanned',
              confidence: 0.98,
              bbox: { x0: 240, y0: 120, x1: 340, y1: 190 },
              lineId: 'line-1',
            },
            {
              text: 'text',
              confidence: 0.98,
              bbox: { x0: 360, y0: 120, x1: 420, y1: 190 },
              lineId: 'line-1',
            },
            {
              text: 'remains',
              confidence: 0.98,
              bbox: { x0: 440, y0: 120, x1: 550, y1: 190 },
              lineId: 'line-1',
            },
            {
              text: 'entirely',
              confidence: 0.98,
              bbox: { x0: 100, y0: 260, x1: 210, y1: 330 },
              lineId: 'line-2',
            },
            {
              text: 'local',
              confidence: 0.98,
              bbox: { x0: 230, y0: 260, x1: 300, y1: 330 },
              lineId: 'line-2',
            },
            {
              text: 'on',
              confidence: 0.98,
              bbox: { x0: 320, y0: 260, x1: 360, y1: 330 },
              lineId: 'line-2',
            },
            {
              text: 'device',
              confidence: 0.98,
              bbox: { x0: 380, y0: 260, x1: 470, y1: 330 },
              lineId: 'line-2',
            },
          ],
          lines: [
            {
              id: 'line-1',
              text: 'Recovered scanned text remains',
              confidence: 0.98,
              bbox: { x0: 100, y0: 120, x1: 550, y1: 190 },
            },
            {
              id: 'line-2',
              text: 'entirely local on device',
              confidence: 0.98,
              bbox: { x0: 100, y0: 260, x1: 470, y1: 330 },
            },
          ],
        } satisfies PdfOcrRecognition
      },
      async terminate() {
        await new Promise((resolve) => setTimeout(resolve, 20))
        terminated += 1
      },
    }
    const ocr: PdfOcrOptions = {
      languages: ['eng'],
      languageMode: 'automatic-fallback',
      async createSession() {
        return session
      },
      async rasterize({ page, rotation }) {
        expect(page).toBe(1)
        expect(rotation).toBe(0)
        return {
          bytes: new Uint8Array([137, 80, 78, 71]),
          mediaType: 'image/png',
          width: 1000,
          height: 1000,
          sha256: 'b'.repeat(64),
        }
      },
    }

    const result = await reconstructPdf(
      await fixtureFile('scanned-page.pdf'),
      undefined,
      { ocr },
    )

    expect(recognizedPages).toEqual([1])
    expect(terminated).toBe(1)
    expect(result.pages[0]).toMatchObject({
      kind: 'ocr-complete',
      objects: [
        expect.objectContaining({
          role: 'scan-source',
          rolePolicy: 'ocr-scan-surface-v1',
        }),
      ],
      ocr: {
        engine: 'test-local-ocr',
        engineVersion: '1.0.0',
        languages: ['eng'],
        languageMode: 'automatic-fallback',
        sourceSha256: result.source.sha256,
        rasterSha256: 'b'.repeat(64),
      },
    })
    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('Recovered scanned text'),
        }),
      ]),
    )
    expect(Object.values(result.provenance)[0].boxes[0]).toMatchObject({
      page: 1,
      method: 'ocr',
      rotation: 0,
      confidence: 0.98,
    })
    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.ready).toBe(true)
  })

  it('keeps one physical spread and records two confident logical page regions', async () => {
    const session: PdfOcrSession = {
      async recognize(request) {
        return {
          engine: 'test-local-ocr',
          engineVersion: '1.0.0',
          model: 'synthetic-eng',
          modelVersion: '1.0.0',
          languages: ['eng'],
          languageMode: 'explicit',
          raster: {
            width: request.raster.width,
            height: request.raster.height,
            sha256: request.raster.sha256,
          },
          words: [
            {
              text: 'left-one',
              confidence: 0.98,
              bbox: { x0: 100, y0: 100, x1: 250, y1: 160 },
              lineId: 'line-left-1',
            },
            {
              text: 'left-two',
              confidence: 0.98,
              bbox: { x0: 100, y0: 220, x1: 250, y1: 280 },
              lineId: 'line-left-2',
            },
            {
              text: 'right-one',
              confidence: 0.98,
              bbox: { x0: 750, y0: 100, x1: 900, y1: 160 },
              lineId: 'line-right-1',
            },
            {
              text: 'right-two',
              confidence: 0.98,
              bbox: { x0: 750, y0: 220, x1: 900, y1: 280 },
              lineId: 'line-right-2',
            },
          ],
          lines: [],
        }
      },
      async terminate() {},
    }

    const result = await reconstructPdf(
      await fixtureFile('two-page-scan.pdf'),
      undefined,
      {
        ocr: {
          languages: ['eng'],
          languageMode: 'explicit',
          async createSession() {
            return session
          },
          async rasterize() {
            return {
              bytes: new Uint8Array([137, 80, 78, 71]),
              mediaType: 'image/png',
              width: 1000,
              height: 1000,
              sha256: 'c'.repeat(64),
            }
          },
        },
      },
    )

    expect(result.source.pageCount).toBe(1)
    expect(result.pages[0].spread).toMatchObject({
      status: 'split',
      boundary: 0.5,
      logicalRegions: [
        { physicalPage: 1, side: 'left' },
        { physicalPage: 1, side: 'right' },
      ],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNCERTAIN_SPREAD_BOUNDARY' }),
      ]),
    )
  })

  it('keeps a mixed-page image semantic when OCR only duplicates embedded text', async () => {
    const file = await fixtureFile('mixed-page.pdf')
    const baseline = await reconstructPdf(file)
    const embedded = baseline.pages[0].runs[0]
    const session: PdfOcrSession = {
      async recognize(request) {
        return {
          engine: 'test-local-ocr',
          engineVersion: '1.0.0',
          model: 'synthetic-eng',
          modelVersion: '1.0.0',
          languages: ['eng'],
          languageMode: 'explicit',
          raster: {
            width: request.raster.width,
            height: request.raster.height,
            sha256: request.raster.sha256,
          },
          words: [
            {
              text: embedded.text,
              confidence: 0.99,
              bbox: {
                x0: embedded.x * request.raster.width,
                y0: embedded.y * request.raster.height,
                x1: (embedded.x + embedded.width) * request.raster.width,
                y1: (embedded.y + embedded.height) * request.raster.height,
              },
              lineId: 'line-duplicate',
            },
          ],
          lines: [],
        }
      },
      async terminate() {},
    }

    const result = await reconstructPdf(
      await fixtureFile('mixed-page.pdf'),
      undefined,
      {
        ocr: {
          languages: ['eng'],
          languageMode: 'explicit',
          async createSession() {
            return session
          },
          async rasterize() {
            return {
              bytes: new Uint8Array([137, 80, 78, 71]),
              mediaType: 'image/png',
              width: 1000,
              height: 1000,
              sha256: 'f'.repeat(64),
            }
          },
        },
      },
    )

    expect(result.pages[0].ocr?.words[0]).toMatchObject({
      mergeStatus: 'duplicate',
    })
    expect(result.pages[0].objects?.[0]).toMatchObject({ role: 'semantic' })
    expect(result.completeness.sourceAssetCount).toBe(1)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('completes a sparse embedded-text page after duplicate-only OCR', async () => {
    const file = await fixtureFile('sparse-embedded-text.pdf')
    const baseline = await reconstructPdf(file)
    const embedded = baseline.pages[0].runs[0]

    expect(baseline.pages[0]).toMatchObject({
      kind: 'ocr-required',
      imageCount: 0,
    })
    expect(baseline.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED', severity: 'error' }),
      ]),
    )
    expect(baseline.readiness.ready).toBe(false)

    const session: PdfOcrSession = {
      async recognize(request) {
        return {
          engine: 'test-local-ocr',
          engineVersion: '1.0.0',
          model: 'synthetic-eng',
          modelVersion: '1.0.0',
          languages: ['eng'],
          languageMode: 'explicit',
          raster: {
            width: request.raster.width,
            height: request.raster.height,
            sha256: request.raster.sha256,
          },
          words: [
            {
              text: embedded.text,
              confidence: 0.99,
              bbox: {
                x0: embedded.x * request.raster.width,
                y0: embedded.y * request.raster.height,
                x1: (embedded.x + embedded.width) * request.raster.width,
                y1: (embedded.y + embedded.height) * request.raster.height,
              },
              lineId: 'line-duplicate',
            },
          ],
          lines: [],
        }
      },
      async terminate() {},
    }

    const result = await reconstructPdf(file, undefined, {
      ocr: {
        languages: ['eng'],
        languageMode: 'explicit',
        async createSession() {
          return session
        },
        async rasterize() {
          return {
            bytes: new Uint8Array([137, 80, 78, 71]),
            mediaType: 'image/png',
            width: 1000,
            height: 1000,
            sha256: '9'.repeat(64),
          }
        },
      },
    })

    expect(result.pages[0]).toMatchObject({ kind: 'ocr-complete' })
    expect(result.pages[0].ocr?.words).toEqual([
      expect.objectContaining({ mergeStatus: 'duplicate' }),
    ])
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED' }),
      ]),
    )
    expect(result.completeness.ocrRequiredPages).toEqual([])
  })

  it('retains rotated OCR boxes and physical-page provenance', async () => {
    const session: PdfOcrSession = {
      async recognize(request) {
        expect(request.rotation).toBe(90)
        const words = [
          ['ROTATED', 120, 260, 'line-1'],
          ['SOURCE', 280, 390, 'line-1'],
          ['PAGE', 410, 500, 'line-1'],
          ['ROTATION', 120, 280, 'line-2'],
          ['REMAINS', 300, 440, 'line-2'],
          ['PROVENANCE', 460, 650, 'line-2'],
          ['EVIDENCE', 670, 800, 'line-2'],
        ] as const
        return {
          engine: 'test-local-ocr',
          engineVersion: '1.0.0',
          model: 'synthetic-eng',
          modelVersion: '1.0.0',
          languages: ['eng'],
          languageMode: 'explicit',
          raster: {
            width: request.raster.width,
            height: request.raster.height,
            sha256: request.raster.sha256,
          },
          words: words.map(([text, x0, x1, lineId]) => ({
            text,
            confidence: 0.98,
            bbox: {
              x0,
              y0: lineId === 'line-1' ? 150 : 300,
              x1,
              y1: lineId === 'line-1' ? 220 : 370,
            },
            lineId,
          })),
          lines: [
            {
              id: 'line-1',
              text: 'ROTATED SOURCE PAGE',
              confidence: 0.98,
              bbox: { x0: 120, y0: 150, x1: 500, y1: 220 },
            },
            {
              id: 'line-2',
              text: 'ROTATION REMAINS PROVENANCE EVIDENCE',
              confidence: 0.98,
              bbox: { x0: 120, y0: 300, x1: 800, y1: 370 },
            },
          ],
        }
      },
      async terminate() {},
    }

    const result = await reconstructPdf(
      await fixtureFile('rotated-scan.pdf'),
      undefined,
      {
        ocr: {
          languages: ['eng'],
          languageMode: 'explicit',
          async createSession() {
            return session
          },
          async rasterize({ rotation }) {
            expect(rotation).toBe(90)
            return {
              bytes: new Uint8Array([137, 80, 78, 71]),
              mediaType: 'image/png',
              width: 1000,
              height: 1000,
              sha256: '8'.repeat(64),
            }
          },
        },
      },
    )

    expect(result.pages[0]).toMatchObject({
      kind: 'ocr-complete',
      rotation: 90,
      ocr: {
        words: expect.arrayContaining([
          expect.objectContaining({
            box: expect.objectContaining({ rotation: 90 }),
          }),
        ]),
      },
    })
    expect(
      Object.values(result.provenance).some((evidence) =>
        evidence.boxes.some(
          (box) => box.method === 'ocr' && box.rotation === 90,
        ),
      ),
    ).toBe(true)
  })

  it('preserves multilingual Unicode and explicit language provenance', async () => {
    const session: PdfOcrSession = {
      async recognize(request) {
        return {
          engine: 'test-local-ocr',
          engineVersion: '1.0.0',
          model: 'synthetic-multilingual',
          modelVersion: '1.0.0',
          languages: ['eng', 'chi_sim'],
          languageMode: 'explicit',
          raster: {
            width: request.raster.width,
            height: request.raster.height,
            sha256: request.raster.sha256,
          },
          words: [
            {
              text: '本地研究',
              confidence: 0.97,
              bbox: { x0: 100, y0: 100, x1: 380, y1: 180 },
              lineId: 'line-1',
            },
          ],
          lines: [
            {
              id: 'line-1',
              text: '本地研究',
              confidence: 0.97,
              bbox: { x0: 100, y0: 100, x1: 380, y1: 180 },
            },
          ],
        }
      },
      async terminate() {},
    }

    const result = await reconstructPdf(
      await fixtureFile('multilingual-scan.pdf'),
      undefined,
      {
        ocr: {
          languages: ['eng', 'chi_sim'],
          languageMode: 'explicit',
          async createSession() {
            return session
          },
          async rasterize() {
            return {
              bytes: new Uint8Array([137, 80, 78, 71]),
              mediaType: 'image/png',
              width: 1000,
              height: 1000,
              sha256: 'd'.repeat(64),
            }
          },
        },
      },
    )

    expect(result.pages[0].ocr).toMatchObject({
      languages: ['eng', 'chi_sim'],
      languageMode: 'explicit',
    })
    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('本地研究') }),
      ]),
    )
  })

  it('rejects an OCR raster above the per-page memory ceiling before recognition', async () => {
    let recognized = false
    let terminated = 0

    await expect(
      reconstructPdf(await fixtureFile('scanned-page.pdf'), undefined, {
        ocr: {
          languages: ['eng'],
          languageMode: 'explicit',
          async createSession() {
            return {
              async recognize() {
                recognized = true
                throw new Error('recognition must not start')
              },
              async terminate() {
                terminated += 1
              },
            }
          },
          async rasterize() {
            return {
              bytes: new Uint8Array([137, 80, 78, 71]),
              mediaType: 'image/png',
              width: 3201,
              height: 1000,
              sha256: 'e'.repeat(64),
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'OCR_REQUIRED' })
    expect(recognized).toBe(false)
    expect(terminated).toBe(1)
  })

  it('terminates an active OCR session when import is cancelled', async () => {
    const controller = new AbortController()
    let terminated = 0
    const session: PdfOcrSession = {
      recognize() {
        return new Promise(() => undefined)
      },
      async terminate() {
        terminated += 1
      },
    }

    await expect(
      reconstructPdf(
        await fixtureFile('scanned-page.pdf'),
        (progress) => {
          if (progress.phase === 'ocr') controller.abort()
        },
        {
          signal: controller.signal,
          ocr: {
            languages: ['eng'],
            languageMode: 'explicit',
            async createSession() {
              return session
            },
            async rasterize() {
              return {
                bytes: new Uint8Array([137, 80, 78, 71]),
                mediaType: 'image/png',
                width: 1000,
                height: 1000,
                sha256: 'b'.repeat(64),
              }
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(terminated).toBe(1)
  })

  it('rejects promptly during OCR session startup and terminates a late worker', async () => {
    const controller = new AbortController()
    let resolveSession!: (session: PdfOcrSession) => void
    let terminated = 0
    const pendingSession = new Promise<PdfOcrSession>((resolve) => {
      resolveSession = resolve
    })
    const session: PdfOcrSession = {
      async recognize() {
        throw new Error('recognition must not start')
      },
      async terminate() {
        terminated += 1
      },
    }

    const importResult = reconstructPdf(
      await fixtureFile('scanned-page.pdf'),
      undefined,
      {
        signal: controller.signal,
        ocr: {
          languages: ['eng'],
          languageMode: 'explicit',
          createSession() {
            controller.abort()
            return pendingSession
          },
        },
      },
    ).then(
      () => 'unexpected-success',
      (error: unknown) =>
        error instanceof PdfImportError ? error.code : 'unexpected-error',
    )
    const firstOutcome = await Promise.race([
      importResult,
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 50),
      ),
    ])

    resolveSession(session)
    await expect(importResult).resolves.toBe('IMPORT_CANCELLED')
    await vi.waitFor(() => expect(terminated).toBe(1))
    expect(firstOutcome).toBe('IMPORT_CANCELLED')
  })

  it('rejects promptly during custom rasterization and terminates its session', async () => {
    const controller = new AbortController()
    let resolveRaster!: (raster: {
      bytes: Uint8Array
      mediaType: 'image/png'
      width: number
      height: number
      sha256: string
    }) => void
    let terminated = 0
    const pendingRaster = new Promise<{
      bytes: Uint8Array
      mediaType: 'image/png'
      width: number
      height: number
      sha256: string
    }>((resolve) => {
      resolveRaster = resolve
    })

    const importResult = reconstructPdf(
      await fixtureFile('scanned-page.pdf'),
      undefined,
      {
        signal: controller.signal,
        ocr: {
          languages: ['eng'],
          languageMode: 'explicit',
          async createSession() {
            return {
              async recognize() {
                throw new Error('recognition must not start')
              },
              async terminate() {
                terminated += 1
              },
            }
          },
          rasterize({ signal }) {
            expect(signal).toBe(controller.signal)
            controller.abort()
            return pendingRaster
          },
        },
      },
    ).then(
      () => 'unexpected-success',
      (error: unknown) =>
        error instanceof PdfImportError ? error.code : 'unexpected-error',
    )
    const firstOutcome = await Promise.race([
      importResult,
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 50),
      ),
    ])

    resolveRaster({
      bytes: new Uint8Array([137, 80, 78, 71]),
      mediaType: 'image/png',
      width: 1000,
      height: 1000,
      sha256: '9'.repeat(64),
    })
    await expect(importResult).resolves.toBe('IMPORT_CANCELLED')
    expect(terminated).toBe(1)
    expect(firstOutcome).toBe('IMPORT_CANCELLED')
  })

  it('opens an actual born-digital PDF and reconstructs text with boxes', async () => {
    const file = await fixtureFile('born-digital.pdf')
    const result = await reconstructPdf(file)

    expect(result.source.pageCount).toBe(1)
    expect(result.pages[0]).toMatchObject({
      kind: 'born-digital',
      rotation: 0,
    })
    expect(result.paper.nodes.length).toBeGreaterThan(0)
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node && node.text.includes('Reconstructed Research Paper'),
      ),
    ).toBe(true)
    expect(Object.values(result.provenance)[0].boxes[0]).toMatchObject({
      page: 1,
      method: 'pdf-text',
    })
    expect(result.completeness).toMatchObject({
      textCoverage: 1,
      assetCoverage: 1,
      relationshipCoverage: 1,
      unresolvedObjectCount: 0,
    })
    expect(result.readiness).toMatchObject({ ready: true, status: 'ready' })

    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    expect(epub.fileName).toMatch(/\.epub$/)
    expect(strFromU8(files['EPUB/content.xhtml'])).toContain(
      'Reconstructed Research Paper',
    )
    expect(JSON.parse(strFromU8(files['EPUB/export.json']))).toMatchObject({
      sourcePdfSha256: result.source.sha256,
      sourceReadiness: { ready: true },
      rendition: 'reflowable-epub',
    })
  })

  it('fails closed when scientific objects and relationships are unresolved', async () => {
    const result = await reconstructPdf(
      await fixtureFile('structured-scientific.pdf'),
    )

    expect(result.pages[0].imageCount).toBeGreaterThan(0)
    expect(result.pages[0].objects).toEqual([
      expect.objectContaining({
        id: 'image-p001-001',
        kind: 'image',
        box: expect.objectContaining({
          method: 'pdf-object',
          x: expect.closeTo(220 / 612, 4),
          y: expect.closeTo(222 / 792, 4),
          width: expect.closeTo(170 / 612, 4),
          height: expect.closeTo(110 / 792, 4),
        }),
      }),
    ])
    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'caption' }),
        expect.objectContaining({ kind: 'figure' }),
        expect.objectContaining({ kind: 'footnote' }),
      ]),
    )
    expect(result.readingOrder.evaluation).toMatchObject({
      mode: 'deterministic-only',
      cycleRate: 0,
      unresolvedEdgeCount: 0,
    })
    expect(result.noteRelationships).toEqual([
      expect.objectContaining({ status: 'matched', targetNoteId: 'fn-p001-1' }),
    ])
    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'fn-p001-1',
          type: 'footnote',
          label: '1',
        }),
      ]),
    )
    expect(result.semanticSignals).toEqual({
      captions: 1,
      tables: 1,
      equations: 1,
      footnoteReferences: 1,
      footnotes: 1,
    })
    expect(result.completeness).toMatchObject({
      textCoverage: 1,
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 0.5,
      readingOrderDiagnostics: 0,
    })
    expect(result.completeness.unresolvedObjectCount).toBeGreaterThan(0)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPLETE_ASSET_COVERAGE',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'UNRESOLVED_SEMANTIC_OBJECTS',
          severity: 'error',
        }),
      ]),
    )
    await expect(buildEpub(result.paper, result)).rejects.toMatchObject({
      code: 'INCOMPLETE_RECONSTRUCTION',
    })
  })

  it('classifies scanned, mixed, rotated, multilingual, and physical-spread fixtures', async () => {
    const [scanned, mixed, twoPage, rotated, multilingual] = await Promise.all([
      reconstructPdf(await fixtureFile('scanned-page.pdf')),
      reconstructPdf(await fixtureFile('mixed-page.pdf')),
      reconstructPdf(await fixtureFile('two-page-scan.pdf')),
      reconstructPdf(await fixtureFile('rotated-scan.pdf')),
      reconstructPdf(await fixtureFile('multilingual-scan.pdf')),
    ])

    expect(scanned.pages.map((page) => page.kind)).toEqual(['ocr-required'])
    expect(mixed.pages.map((page) => page.kind)).toEqual(['mixed'])
    expect(twoPage.source.pageCount).toBe(1)
    expect(twoPage.pages.map((page) => page.kind)).toEqual(['ocr-required'])
    expect(twoPage.pages[0].spread).toMatchObject({
      status: 'uncertain',
      boundary: 0.5,
    })
    expect(twoPage.completeness.ocrRequiredPages).toEqual([1])
    expect(rotated.pages[0]).toMatchObject({
      kind: 'ocr-required',
      rotation: 90,
    })
    expect(multilingual.pages[0]).toMatchObject({ kind: 'ocr-required' })
    expect(
      [scanned, mixed, twoPage, rotated, multilingual].every(
        (result) => !result.readiness.ready,
      ),
    ).toBe(true)
  })

  it('rejects the virtual oversized fixture before reading document bytes', async () => {
    let read = false
    await expect(
      reconstructPdf(
        oversizedPdfFixture(() => {
          read = true
        }),
      ),
    ).rejects.toMatchObject({ code: 'OVERSIZED_PDF' })
    expect(read).toBe(false)
  })

  it('cancels before PDF.js opens when abort fires during hashing', async () => {
    const controller = new AbortController()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      const result = await digest(...args)
      controller.abort()
      return result
    })
    const file = new File(['%PDF-1.4\ninvalid'], 'cancel-during-hash.pdf', {
      type: 'application/pdf',
      lastModified: 0,
    })

    await expect(
      reconstructPdf(file, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })

  it('cancels when the operator aborts at reconstruction', async () => {
    const controller = new AbortController()

    await expect(
      reconstructPdf(
        await fixtureFile('born-digital.pdf'),
        (progress) => {
          if (progress.phase === 'reconstructing') controller.abort()
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })

  it('retains the published fellowship PDF as non-private local audit evidence', async () => {
    const bytes = await readFile(
      new URL(
        '../../public/research/if-letters-home-could-sing/if-letters-home-could-sing.pdf',
        import.meta.url,
      ),
    )
    const result = await reconstructPdf(
      new File([bytes], 'if-letters-home-could-sing.pdf', {
        type: 'application/pdf',
        lastModified: 0,
      }),
    )

    expect(result.source.sha256).toBe(
      'ddf25768bcc2ec8866037c553102071ee8fbb73db168f975852f69482c1eb042',
    )
    expect(result.source.pageCount).toBeGreaterThan(1)
    expect(result.completeness.sourceTextCharacters).toBeGreaterThan(0)
    expect(['ready', 'review-required']).toContain(result.readiness.status)
  })
})
