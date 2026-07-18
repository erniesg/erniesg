import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
): PdfPageAnalysis {
  return {
    page: number,
    kind,
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: kind === 'born-digital' ? 0 : 1,
    runs,
  }
}

describe('PDF semantic reconstruction', () => {
  it('removes repeated margins and retains normalized source-box provenance', async () => {
    const pages = [
      page(1, [
        run(1, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(1, 'A Semantic Paper', 0.1, 0.15, 0.7, 22),
        run(1, 'This is the first reconstructed paragraph.', 0.1, 0.24, 0.72),
      ]),
      page(2, [
        run(2, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(2, 'Methods', 0.1, 0.16, 0.25, 17),
        run(2, 'The second page remains in reading order.', 0.1, 0.24, 0.7),
      ]),
    ]
    const result = await reconstructPageAnalyses({
      pages,
      sourceHash: 'a'.repeat(64),
      fileName: 'paper.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example', modified: '2026-07-13' },
    })

    expect(result.paper.title).toBe('A Semantic Paper')
    expect(result.paper.authors).toEqual(['Ada Example'])
    expect(
      result.paper.nodes.map((node) => 'text' in node && node.text),
    ).not.toContain('Journal 2026')
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REPEATED_MARGIN_TEXT' }),
      ]),
    )
    const first = result.paper.nodes[0]
    expect(result.provenance[first.id]).toMatchObject({
      confidence: 0.9,
      pages: [1],
    })
    expect(result.provenance[first.id].boxes[0]).toMatchObject({
      page: 1,
      method: 'pdf-text',
      x: 0.1,
      y: 0.15,
    })
  })

  it('retains embedded links alongside reconstructed node provenance', async () => {
    const linked = page(1, [
      run(1, 'Linked embedded text remains source evidence.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        url: 'https://example.test/evidence',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: 'e'.repeat(64),
      fileName: 'linked.pdf',
      byteLength: 2048,
    })

    expect(Object.values(result.provenance)[0].links).toEqual(linked.links)
  })

  it('orders detected columns left before right without storing target geometry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Left two.', 0.08, 0.24, 0.32),
          run(1, 'Left three.', 0.08, 0.28, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Right two.', 0.55, 0.24, 0.32),
          run(1, 'Right three.', 0.55, 0.28, 0.32),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'columns.pdf',
      byteLength: 4096,
    })
    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left one')).toBeLessThan(text.indexOf('Right one'))
    expect(result.paper).not.toHaveProperty('geometry')
    expect(result.paper).not.toHaveProperty('pages')
  })

  it('preserves narrow-gutter columns instead of interleaving their rows', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.43),
          run(1, 'Right one.', 0.53, 0.2, 0.39),
          run(1, 'Left two.', 0.08, 0.24, 0.43),
          run(1, 'Right two.', 0.53, 0.24, 0.39),
          run(1, 'Left three.', 0.08, 0.28, 0.43),
          run(1, 'Right three.', 0.53, 0.28, 0.39),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'narrow-gutter-columns.pdf',
      byteLength: 2048,
    })

    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left three')).toBeLessThan(text.indexOf('Right one'))
    expect(result.readiness.ready).toBe(true)
  })

  it('fails closed when a short two-column page cannot be ordered safely', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Indented left two.', 0.18, 0.7, 0.22),
          run(1, 'Right two.', 0.55, 0.7, 0.32),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'short-columns.pdf',
      byteLength: 2048,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('uses visual line grouping to detect split, out-of-order captions', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1. A split caption', 0.2, 0.398, 0.32, 8),
          run(1, 'Figure', 0.1, 0.4, 0.08, 8),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'split-caption.pdf',
      byteLength: 2048,
    })

    expect(result.semanticSignals.captions).toBe(1)
    expect(result.completeness.unresolvedObjects.captions).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
          severity: 'error',
        }),
      ]),
    )
  })

  it('does not treat vertically separate metadata and body as columns', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Metadata A', 0.7, 0.1, 0.2),
          run(1, 'Metadata B', 0.7, 0.14, 0.2),
          run(1, 'Body line one.', 0.1, 0.3, 0.2),
          run(1, 'Body line two.', 0.1, 0.34, 0.2),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'metadata-and-body.pdf',
      byteLength: 2048,
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_READING_ORDER' }),
      ]),
    )
    expect(result.readiness.ready).toBe(true)
  })

  it('counts supplementary Unicode text by code point', async () => {
    const math = '𝑥'.repeat(30)
    const result = await reconstructPageAnalyses({
      pages: [page(1, [run(1, math, 0.1, 0.2, 0.5)])],
      sourceHash: '0'.repeat(64),
      fileName: 'unicode-math.pdf',
      byteLength: 2048,
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: 30,
      outputTextCharacters: 30,
      matchedTextCharacters: 30,
      textCoverage: 1,
    })
    expect(result.readiness.ready).toBe(true)
  })

  it('emits stable OCR gates instead of silently exporting partial text', async () => {
    const pages = [page(1, [], 'ocr-required')]
    const input = {
      pages,
      sourceHash: 'c'.repeat(64),
      fileName: 'scan.pdf',
      byteLength: 8192,
    }
    const first = await reconstructPageAnalyses(input)
    const second = await reconstructPageAnalyses(input)

    expect(first).toEqual(second)
    expect(first.paper.nodes).toEqual([])
    expect(first.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED', severity: 'error' }),
        expect.objectContaining({ code: 'NO_RECONSTRUCTABLE_TEXT' }),
      ]),
    )
    expect(first.completeness.ocrRequiredPages).toEqual([1])
    expect(first.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('clears the OCR gate for accepted scan text without counting the scan surface as a figure', async () => {
    const ocrRun: PdfSourceRun = {
      ...run(
        1,
        'Recovered locally from a scanned source page with enough text.',
        0.1,
        0.2,
        0.72,
      ),
      method: 'ocr',
      confidence: 0.96,
    }
    const scanned: PdfPageAnalysis = {
      ...page(1, [ocrRun], 'ocr-complete'),
      objects: [
        {
          id: 'image-p001-001',
          page: 1,
          kind: 'image',
          assetId: null,
          role: 'scan-source',
          confidence: 0.98,
          box: {
            page: 1,
            x: 0.05,
            y: 0.05,
            width: 0.9,
            height: 0.9,
            rotation: 0,
            method: 'pdf-object',
          },
        },
      ],
      ocr: {
        engine: 'tesseract.js',
        engineVersion: '6.0.1',
        model: 'tessdata_best_int',
        modelVersion: '4.0.0',
        languages: ['eng'],
        languageMode: 'automatic-fallback',
        sourceSha256: 'a'.repeat(64),
        rasterSha256: 'b'.repeat(64),
        confidence: 0.96,
        words: [],
        lines: [],
      },
    }

    const result = await reconstructPageAnalyses({
      pages: [scanned],
      sourceHash: 'a'.repeat(64),
      fileName: 'scan.pdf',
      byteLength: 8192,
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED' }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      sourceAssetCount: 0,
      ocrRequiredPages: [],
    })
    expect(result.regions.some((region) => region.kind === 'figure')).toBe(
      false,
    )
    expect(result.readiness.ready).toBe(true)
  })

  it('blocks low-confidence OCR and uncertain spread boundaries for review', async () => {
    const ocrRun: PdfSourceRun = {
      ...run(1, 'Uncertain recovered scan text.', 0.1, 0.2, 0.35),
      method: 'ocr',
      confidence: 0.61,
    }
    const scanned: PdfPageAnalysis = {
      ...page(1, [ocrRun], 'ocr-complete'),
      width: 1224,
      ocr: {
        engine: 'tesseract.js',
        engineVersion: '6.0.1',
        model: 'tessdata_best_int',
        modelVersion: '4.0.0',
        languages: ['eng'],
        languageMode: 'explicit',
        sourceSha256: 'a'.repeat(64),
        rasterSha256: 'b'.repeat(64),
        confidence: 0.61,
        words: [],
        lines: [],
      },
      spread: {
        status: 'uncertain',
        boundary: 0.5,
        confidence: 0.55,
        logicalRegions: [],
      },
    }

    const result = await reconstructPageAnalyses({
      pages: [scanned],
      sourceHash: 'a'.repeat(64),
      fileName: 'spread.pdf',
      byteLength: 8192,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'LOW_CONFIDENCE_OCR',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'UNCERTAIN_SPREAD_BOUNDARY',
          severity: 'error',
        }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })
})
