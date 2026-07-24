import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import {
  classifyPdfPage,
  detectPhysicalSpread,
  mergeOcrPage,
  type PdfOcrRecognition,
} from './pdf-ocr'

function run(
  text: string,
  x: number,
  y: number,
  width = 0.2,
  height = 0.02,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Test',
    fontSize: 12,
    confidence: 1,
  }
}

function page(
  runs: PdfSourceRun[],
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce(
      (total, item) => total + item.text.replace(/\s/g, '').length,
      0,
    ),
    imageCount: objects.length,
    objects,
    runs,
  }
}

function scanObject(coverage = 0.85) {
  return {
    id: 'image-p001-001',
    page: 1,
    kind: 'image' as const,
    assetId: null,
    box: {
      page: 1,
      x: 0.05,
      y: 0.05,
      width: coverage,
      height: coverage,
      rotation: 0,
      method: 'pdf-object' as const,
    },
    confidence: 0.98,
  }
}

function boundedFigureObject() {
  return {
    id: 'image-p001-figure',
    page: 1,
    kind: 'image' as const,
    assetId: 'asset-figure',
    box: {
      page: 1,
      x: 0.24,
      y: 0.35,
      width: 0.52,
      height: 0.275,
      rotation: 0,
      method: 'pdf-object' as const,
    },
    confidence: 0.98,
  }
}

describe('PDF OCR page classification', () => {
  it('uses text geometry, run count, and image coverage to distinguish OCR classes', () => {
    const cases = [
      { page: page([]), expected: 'textless' },
      { page: page([], [scanObject()]), expected: 'image-only' },
      { page: page([run('Short', 0.1, 0.1)]), expected: 'sparse-text' },
      {
        page: page(
          [run('Sparse embedded heading', 0.1, 0.1, 0.35, 0.03)],
          [scanObject(0.7)],
        ),
        expected: 'mixed',
      },
      {
        page: page([
          run('A complete first line of embedded document text', 0.1, 0.1, 0.7),
          run(
            'A second line establishes meaningful vertical coverage',
            0.1,
            0.2,
            0.7,
          ),
          run(
            'A third line prevents a character-only classification',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        expected: 'born-digital',
      },
    ]

    expect(
      cases.map(({ page: value }) => classifyPdfPage(value).contentClass),
    ).toEqual(cases.map(({ expected }) => expected))
    expect(classifyPdfPage(cases[3].page)).toMatchObject({
      needsOcr: true,
      evidence: {
        runCount: 1,
        imageCoverage: expect.any(Number),
        textArea: expect.any(Number),
      },
    })
  })

  it('keeps an inset scholarly figure with an explicit adjacent caption out of OCR', () => {
    const figurePage = page(
      [
        run(
          'Figure N: (ChatGPT-4, 2/3) A good move, rewriting the goal to “',
          0.184,
          0.635,
          0.424,
          0.0126,
        ),
        run('a + (c + b) = a + c + b', 0.608, 0.635, 0.197, 0.0126),
        run('”.', 0.805, 0.635, 0.011, 0.0126),
        run('39', 0.492, 0.934, 0.016, 0.0126),
      ],
      [boundedFigureObject()],
    )

    expect(classifyPdfPage(figurePage)).toMatchObject({
      contentClass: 'scholarly-visual',
      needsOcr: false,
    })
  })

  it('keeps sparse image pages review-blocked without a proved inset caption relationship', () => {
    const boundedWithoutCaption = page(
      [run('An isolated label', 0.184, 0.635, 0.2, 0.0126)],
      [boundedFigureObject()],
    )
    const distantCaption = page(
      [run('Figure 1: A distant label.', 0.1, 0.08, 0.3, 0.0126)],
      [boundedFigureObject()],
    )
    const fullPageScanWithCaptionText = page(
      [run('Figure 1: Text recovered from a scan.', 0.1, 0.82, 0.5, 0.02)],
      [scanObject()],
    )

    expect(classifyPdfPage(boundedWithoutCaption)).toMatchObject({
      contentClass: 'mixed',
      needsOcr: true,
    })
    expect(classifyPdfPage(distantCaption)).toMatchObject({
      contentClass: 'mixed',
      needsOcr: true,
    })
    expect(classifyPdfPage(fullPageScanWithCaptionText)).toMatchObject({
      contentClass: 'mixed',
      needsOcr: true,
    })
  })
})

function recognition(
  words: PdfOcrRecognition['words'],
  lines: PdfOcrRecognition['lines'] = [],
): PdfOcrRecognition {
  return {
    engine: 'tesseract.js',
    engineVersion: '6.0.1',
    model: 'tessdata_best_int',
    modelVersion: '4.0.0',
    languages: ['eng'],
    languageMode: 'automatic-fallback',
    raster: {
      width: 1000,
      height: 1000,
      sha256: 'b'.repeat(64),
    },
    words,
    lines,
  }
}

describe('OCR evidence merging', () => {
  it('does not hide an image-only semantic object after recognizing one small label', () => {
    const imageOnly = page([], [scanObject()])
    imageOnly.kind = 'ocr-required'

    const result = mergeOcrPage(
      imageOnly,
      recognition([
        {
          text: 'label',
          confidence: 0.99,
          bbox: { x0: 100, y0: 100, x1: 220, y1: 150 },
          lineId: 'line-1',
        },
      ]),
      { sourceSha256: 'a'.repeat(64) },
    )

    expect(result.page.objects?.[0]).toMatchObject({ role: 'semantic' })
  })

  it('deduplicates OCR words contained by a phrase-level PDF text run', () => {
    const embedded = page(
      [run('Hello world', 0.1, 0.1, 0.4, 0.05)],
      [scanObject()],
    )
    embedded.kind = 'mixed'

    const result = mergeOcrPage(
      embedded,
      recognition([
        {
          text: 'Hello',
          confidence: 0.99,
          bbox: { x0: 100, y0: 100, x1: 250, y1: 150 },
          lineId: 'line-1',
        },
        {
          text: 'world',
          confidence: 0.99,
          bbox: { x0: 300, y0: 100, x1: 500, y1: 150 },
          lineId: 'line-1',
        },
      ]),
      { sourceSha256: 'a'.repeat(64) },
    )

    expect(result.page.runs.map((item) => item.text)).toEqual(['Hello world'])
    expect(result.page.ocr?.words.map((word) => word.mergeStatus)).toEqual([
      'duplicate',
      'duplicate',
    ])
    expect(result.diagnostics).toEqual([])
  })

  it('completes an embedded-only sparse page when OCR confirms only duplicates', () => {
    const sparse = page([run('Section divider', 0.1, 0.1, 0.3, 0.05)])
    sparse.kind = 'ocr-required'

    const result = mergeOcrPage(
      sparse,
      recognition([
        {
          text: 'Section divider',
          confidence: 0.99,
          bbox: { x0: 100, y0: 100, x1: 400, y1: 150 },
          lineId: 'line-1',
        },
      ]),
      { sourceSha256: 'a'.repeat(64) },
    )

    expect(result.page.kind).toBe('ocr-complete')
    expect(result.page.runs.map((item) => item.text)).toEqual([
      'Section divider',
    ])
    expect(result.page.ocr?.words).toEqual([
      expect.objectContaining({ mergeStatus: 'duplicate' }),
    ])
    expect(result.diagnostics).toEqual([])

    const lowConfidence = mergeOcrPage(
      sparse,
      recognition([
        {
          text: 'Section divider',
          confidence: 0.61,
          bbox: { x0: 100, y0: 100, x1: 400, y1: 150 },
          lineId: 'line-1',
        },
      ]),
      { sourceSha256: 'a'.repeat(64) },
    )
    expect(lowConfidence.page.kind).toBe('ocr-required')
    expect(lowConfidence.diagnostics).toEqual([
      expect.objectContaining({
        code: 'LOW_CONFIDENCE_OCR',
        severity: 'error',
      }),
    ])
  })

  it('deduplicates matching text, retains embedded links, and diagnoses conflicts', () => {
    const embedded = page([run('Hello', 0.1, 0.1, 0.2, 0.05)], [scanObject()])
    embedded.kind = 'mixed'
    embedded.links = [
      {
        url: 'https://example.test/source',
        box: {
          page: 1,
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.05,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = mergeOcrPage(
      embedded,
      recognition(
        [
          {
            text: 'Hello',
            confidence: 0.99,
            bbox: { x0: 100, y0: 100, x1: 300, y1: 150 },
            lineId: 'line-1',
          },
          {
            text: 'Hullo',
            confidence: 0.94,
            bbox: { x0: 110, y0: 105, x1: 295, y1: 150 },
            lineId: 'line-1',
          },
          {
            text: 'world',
            confidence: 0.96,
            bbox: { x0: 400, y0: 100, x1: 600, y1: 150 },
            lineId: 'line-1',
          },
        ],
        [
          {
            id: 'line-1',
            text: 'Hello Hullo world',
            confidence: 0.94,
            bbox: { x0: 100, y0: 100, x1: 600, y1: 150 },
          },
        ],
      ),
      { sourceSha256: 'a'.repeat(64) },
    )

    expect(result.page.runs.map((item) => item.text)).toEqual([
      'Hello',
      'world',
    ])
    expect(result.page.links).toEqual(embedded.links)
    expect(result.page.kind).toBe('mixed')
    expect(result.page.objects?.[0]).toMatchObject({ role: 'semantic' })
    expect(result.page.ocr).toMatchObject({
      sourceSha256: 'a'.repeat(64),
      engine: 'tesseract.js',
      engineVersion: '6.0.1',
      modelVersion: '4.0.0',
      languages: ['eng'],
      languageMode: 'automatic-fallback',
      words: [
        expect.objectContaining({ text: 'Hello', mergeStatus: 'duplicate' }),
        expect.objectContaining({ text: 'Hullo', mergeStatus: 'conflict' }),
        expect.objectContaining({ text: 'world', mergeStatus: 'accepted' }),
      ],
      lines: [
        expect.objectContaining({
          id: 'line-1',
          box: expect.objectContaining({ method: 'ocr', width: 0.5 }),
        }),
      ],
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'MIXED_OCR_CONFLICT',
        severity: 'error',
      }),
    ])
  })

  it('keeps low confidence OCR as review-blocking evidence', () => {
    const scanned = page([], [scanObject()])
    scanned.kind = 'ocr-required'

    const result = mergeOcrPage(
      scanned,
      recognition([
        {
          text: 'uncertain',
          confidence: 0.61,
          bbox: { x0: 100, y0: 100, x1: 300, y1: 150 },
          lineId: 'line-1',
        },
      ]),
      { sourceSha256: 'a'.repeat(64) },
    )

    expect(result.page.kind).toBe('ocr-complete')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'LOW_CONFIDENCE_OCR',
        severity: 'error',
      }),
    ])
  })
})

describe('physical spread detection', () => {
  it('does not reinterpret a wide born-digital page as a scanned spread', () => {
    const landscape = page(
      [
        run('A complete first line of embedded document text', 0.08, 0.1, 0.7),
        run('A complete second line of embedded document text', 0.08, 0.2, 0.7),
        run('A complete third line of embedded document text', 0.08, 0.3, 0.7),
      ],
      [scanObject(0.9)],
    )
    landscape.width = 1224
    landscape.height = 792

    expect(detectPhysicalSpread(landscape)).toMatchObject({
      status: 'single',
      boundary: null,
    })
  })

  it('splits a wide scan into logical regions without changing physical provenance', () => {
    const wide = page([], [scanObject(0.9)])
    wide.kind = 'ocr-required'
    wide.width = 1224
    wide.height = 792
    const merged = mergeOcrPage(
      wide,
      recognition([
        {
          text: 'left-one',
          confidence: 0.98,
          bbox: { x0: 100, y0: 100, x1: 250, y1: 150 },
          lineId: 'line-left-1',
        },
        {
          text: 'left-two',
          confidence: 0.98,
          bbox: { x0: 100, y0: 220, x1: 250, y1: 270 },
          lineId: 'line-left-2',
        },
        {
          text: 'right-one',
          confidence: 0.98,
          bbox: { x0: 750, y0: 100, x1: 900, y1: 150 },
          lineId: 'line-right-1',
        },
        {
          text: 'right-two',
          confidence: 0.98,
          bbox: { x0: 750, y0: 220, x1: 900, y1: 270 },
          lineId: 'line-right-2',
        },
      ]),
      { sourceSha256: 'a'.repeat(64) },
    ).page

    expect(detectPhysicalSpread(merged)).toMatchObject({
      status: 'split',
      boundary: 0.5,
      logicalRegions: [
        { id: 'physical-p001-left', physicalPage: 1, side: 'left' },
        { id: 'physical-p001-right', physicalPage: 1, side: 'right' },
      ],
    })
  })

  it('requires review when OCR crosses a likely spread boundary', () => {
    const wide = page([], [scanObject(0.9)])
    wide.kind = 'ocr-required'
    wide.width = 1224
    wide.height = 792
    const merged = mergeOcrPage(
      wide,
      recognition([
        {
          text: 'crossing',
          confidence: 0.98,
          bbox: { x0: 450, y0: 100, x1: 550, y1: 150 },
          lineId: 'line-crossing',
        },
      ]),
      { sourceSha256: 'a'.repeat(64) },
    ).page

    expect(detectPhysicalSpread(merged)).toMatchObject({
      status: 'uncertain',
      boundary: 0.5,
    })
  })
})
