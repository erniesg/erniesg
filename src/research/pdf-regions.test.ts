import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import {
  evaluateReadingOrder,
  hasAcceptedCycle,
  noteLabelFromText,
  reconstructPageRegions,
} from './pdf-regions'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
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
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: objects.length,
    objects,
    runs,
  }
}

async function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('recognizes an attached symbolic footnote marker', () => {
    expect(noteLabelFromText('*Work done during the internship.')).toBe('*')
  })

  it('checks dense reading-order graphs without overflowing the call stack', () => {
    const regionIds = Array.from(
      { length: 20_000 },
      (_, index) => `region-${index}`,
    )
    const edges = regionIds.slice(1).map((to, index) => ({
      id: `edge-${index}`,
      from: regionIds[index],
      to,
      status: 'accepted' as const,
      confidence: 1,
      evidence: [],
      sourceBoxes: [],
    }))

    expect(hasAcceptedCycle(regionIds, edges)).toBe(false)
    expect(
      hasAcceptedCycle(regionIds, [
        ...edges,
        { ...edges[0], id: 'cycle', from: regionIds.at(-1)!, to: regionIds[0] },
      ]),
    ).toBe(true)
  })

  it('orders every left logical page region before the right side of an accepted scan spread', async () => {
    const spread = page(1, [
      run(1, 'Left opening.', 0.08, 0.12, 0.3),
      run(1, 'Right opening.', 0.62, 0.14, 0.3),
      run(1, 'Right continuation.', 0.62, 0.22, 0.3),
      run(1, 'Left conclusion.', 0.08, 0.72, 0.3),
    ])
    spread.kind = 'ocr-complete'
    spread.runs = spread.runs.map((item) => ({ ...item, method: 'ocr' }))
    spread.spread = {
      status: 'split',
      boundary: 0.5,
      confidence: 0.9,
      logicalRegions: [
        {
          id: 'physical-p001-left',
          physicalPage: 1,
          side: 'left',
          box: {
            page: 1,
            x: 0,
            y: 0,
            width: 0.5,
            height: 1,
            rotation: 0,
            method: 'ocr',
          },
        },
        {
          id: 'physical-p001-right',
          physicalPage: 1,
          side: 'right',
          box: {
            page: 1,
            x: 0.5,
            y: 0,
            width: 0.5,
            height: 1,
            rotation: 0,
            method: 'ocr',
          },
        },
      ],
    }

    const result = await reconstruct([spread])
    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')

    expect(text.indexOf('Left conclusion')).toBeLessThan(
      text.indexOf('Right opening'),
    )
    expect(
      result.regions
        .filter((region) => region.text)
        .map((region) => region.column),
    ).toEqual(expect.arrayContaining(['left', 'right']))
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('segments one-column flow without inventing a column boundary', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'One column title', 0.1, 0.12, 0.72, 18),
        run(1, 'First body line.', 0.1, 0.24, 0.72),
        run(1, 'Second body line.', 0.1, 0.28, 0.72),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.includedInReadingOrder)
        .every((region) => region.column === 'single'),
    ).toBe(true)
    expect(result.readingOrder).toMatchObject({ acyclic: true })
    expect(result.readingOrder.evaluation).toMatchObject({
      mode: 'deterministic-only',
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      reviewRequired: false,
    })
  })

  it('uses an exact unhyphenated word from another region as line-join evidence', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Synthetic Parser Study', 0.1, 0.1, 0.72, 18),
        run(1, 'Compare ZX-', 0.1, 0.3, 0.72),
        run(1, 'ALPHA controls.', 0.1, 0.322, 0.72),
        run(1, 'A separate paragraph cites ZXALPHA.', 0.1, 0.6, 0.72),
      ]),
    ])

    expect(result.regions.map((region) => region.text)).toContain(
      'Compare ZXALPHA controls.',
    )
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'removed-discretionary-hyphen',
          evidence: ['same-document-unhyphenated-word'],
        }),
      ]),
    )
  })

  it('retains uncaptioned equation text but does not promote a generated SVG to exact source visual evidence', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Equation preservation', 0.1, 0.12, 0.72, 18),
        run(1, 'x + y = z', 0.24, 0.28, 0.4, 14),
        run(1, 'Following body text.', 0.1, 0.38, 0.72),
        run(1, 'Additional body text.', 0.1, 0.44, 0.72),
        run(1, 'More body text.', 0.1, 0.5, 0.72),
        run(1, 'Final body text.', 0.1, 0.56, 0.72),
      ]),
    ])

    const equationRegion = result.regions.find(
      (region) => region.kind === 'equation',
    )!
    expect(equationRegion.text).toBe('x + y = z')
    expect(result.visualRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'equation',
          status: 'unresolved',
          captionRegionId: equationRegion.id,
          sourceRegionIds: [],
          sourceObjectIds: [],
          assetIds: [],
          sourceText: 'x + y = z',
          altText: 'x + y = z',
          altTextSource: 'source-text',
          candidates: expect.arrayContaining([
            expect.objectContaining({
              sourceRegionIds: [equationRegion.id],
              sourceObjectIds: ['equation-source-p001-001'],
              assetIds: [expect.stringMatching(/^asset-/)],
              evidence: expect.arrayContaining([
                'readable-text-svg-approximation',
              ]),
            }),
          ]),
        }),
      ]),
    )
    const equationNodeIndex = result.paper.nodes.findIndex(
      (node) => node.type === 'figure' && node.objectType === 'equation',
    )
    const equationTextIndex = result.paper.nodes.findIndex(
      (node) => 'text' in node && node.text === 'x + y = z',
    )
    expect(equationNodeIndex).toBe(-1)
    expect(equationTextIndex).toBeGreaterThan(-1)
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'paragraph' && node.text === 'x + y = z',
      ),
    ).toBe(false)
    expect(
      result.paper.nodes.findIndex(
        (node) =>
          node.type === 'paragraph' && node.text === 'Following body text.',
      ),
    ).toBeGreaterThan(equationTextIndex)
    const asset = result.assets.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(asset).toMatchObject({
      mediaType: 'image/svg+xml',
      rendition: 'bounded-svg-fallback',
      sourceBoxes: [equationRegion.box],
    })
    const svg = strFromU8(asset.bytes)
    expect(svg).toContain('x + y = z')
    expect(svg).not.toMatch(/<math\b|mathml|latex/i)
    expect(result.semanticSignals.equations).toBe(1)
    expect(result.completeness).toMatchObject({
      textCoverage: 1,
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 0,
      unresolvedObjectCount: 2,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_VISUAL_OBJECT' }),
        expect.objectContaining({ code: 'INCOMPLETE_ASSET_COVERAGE' }),
        expect.objectContaining({ code: 'INCOMPLETE_RELATIONSHIP_COVERAGE' }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
    await expect(buildEpub(result.paper, result)).rejects.toThrow(
      /INCOMPLETE_ASSET_COVERAGE/,
    )
  })

  it('keeps a first-page arXiv margin identifier out of canonical prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'A Synthetic Scholarly Paper', 0.14, 0.12, 0.72, 18),
        run(1, 'Abstract', 0.14, 0.24, 0.2, 12),
        run(
          1,
          'Synthetic body text remains in reading order.',
          0.14,
          0.31,
          0.72,
        ),
        run(
          1,
          'A second body line establishes body typography.',
          0.14,
          0.36,
          0.72,
        ),
        run(1, 'A third body line remains canonical.', 0.14, 0.41, 0.72),
        run(1, 'arXiv:2401.01234v2 [cs.CL] 31 Jan 2024', 0.052, 0.68, 0.81, 20),
      ]),
    ])

    const identifier = result.regions.find((region) =>
      region.text.startsWith('arXiv:'),
    )
    expect(identifier).toMatchObject({
      kind: 'side',
      includedInReadingOrder: false,
    })
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).not.toContain('arXiv:2401.01234v2')
  })

  it('retains ordinary body prose that begins with an arXiv identifier', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'A Synthetic Scholarly Paper', 0.14, 0.12, 0.72, 18),
        run(1, 'First body line.', 0.14, 0.28, 0.72),
        run(
          1,
          'arXiv:2401.01234 provides an ordinary prose example.',
          0.14,
          0.34,
          0.72,
        ),
        run(1, 'Final body line.', 0.14, 0.4, 0.72),
      ]),
    ])

    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('arXiv:2401.01234 provides an ordinary prose example.')
  })

  it('does not promote isolated author initials to section headings', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'A Synthetic Scholarly Paper', 0.14, 0.12, 0.72, 18),
        run(1, 'R', 0.14, 0.21, 0.05, 12),
        run(1, 'D', 0.14, 0.27, 0.05, 12),
        run(1, 'Abstract body line one.', 0.14, 0.35, 0.72, 9),
        run(1, 'Abstract body line two.', 0.14, 0.4, 0.72, 9),
        run(1, 'Abstract body line three.', 0.14, 0.45, 0.72, 9),
        run(1, 'Abstract body line four.', 0.14, 0.5, 0.72, 9),
        run(1, 'Abstract body line five.', 0.14, 0.55, 0.72, 9),
      ]),
    ])

    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'heading' && (node.text === 'R' || node.text === 'D'),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && (node.text === 'R' || node.text === 'D'),
      ),
    ).toHaveLength(2)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ISOLATED_PROSE_GLYPH',
          severity: 'error',
        }),
      ]),
    )
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'ISOLATED_PROSE_GLYPH',
      ),
    ).toHaveLength(2)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining(['ISOLATED_PROSE_GLYPH']),
    })
  })

  it('keeps an unclaimed small alphabetic glyph visible and fails closed', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Synthetic glyph review', 0.1, 0.12, 0.72, 18),
        run(1, 'Ordinary body text establishes typography.', 0.1, 0.24, 0.72),
        run(1, 'Q', 0.46, 0.5, 0.018, 8),
        run(1, 'More ordinary body text follows.', 0.1, 0.62, 0.72),
      ]),
    ])

    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'paragraph', text: 'Q' }),
      ]),
    )
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ISOLATED_PROSE_GLYPH',
          severity: 'error',
        }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('keeps unproven table-cell text visible and blocks export instead of inventing a semantic table', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Table 1. Synthetic categories.', 0.1, 0.2, 0.45, 10),
        run(1, 'Key', 0.1, 0.26, 0.08, 9),
        run(1, 'Value', 0.3, 0.26, 0.08, 9),
        run(1, 'A', 0.1, 0.3, 0.02, 9),
        run(1, '1', 0.3, 0.3, 0.02, 9),
        run(1, 'B', 0.1, 0.34, 0.02, 9),
        run(1, '2', 0.3, 0.34, 0.02, 9),
      ]),
    ])

    expect(
      result.paper.nodes.some(
        (node) => node.type === 'figure' && node.objectType === 'table',
      ),
    ).toBe(false)
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && /(?:Key|Value|A|B|1|2)/.test(node.text),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Key' }),
        expect.objectContaining({ text: 'Value A' }),
        expect.objectContaining({ text: '1 B' }),
        expect.objectContaining({ text: '2' }),
      ]),
    )
    expect(result.visualRelationships).toEqual([
      expect.objectContaining({
        kind: 'table',
        status: 'unresolved',
        assetIds: [],
        candidates: [
          expect.objectContaining({
            sourceObjectIds: ['table-p001-001'],
            assetIds: [],
            evidence: expect.arrayContaining(['semantic-table-unresolved']),
          }),
        ],
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_VISUAL_OBJECT' }),
        expect.objectContaining({ code: 'INCOMPLETE_ASSET_COVERAGE' }),
        expect.objectContaining({ code: 'INCOMPLETE_RELATIONSHIP_COVERAGE' }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('separates a larger title line from a tightly spaced author block', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Synthetic Benchmark Title', 0.18, 0.1, 0.64, 14.4),
        run(1, 'Ada Example, Babbage Example', 0.14, 0.137, 0.72, 12),
        run(1, 'Example University', 0.24, 0.158, 0.52, 12),
        run(1, 'Abstract', 0.14, 0.24, 0.2, 12),
        ...Array.from({ length: 16 }, (_, index) =>
          run(
            1,
            `Body line ${index + 1} remains ordinary prose.`,
            0.14,
            0.31 + index * 0.035,
            0.72,
            10,
          ),
        ),
      ]),
    ])

    expect(result.paper).toMatchObject({
      title: 'Synthetic Benchmark Title',
      authors: ['Ada Example', 'Babbage Example'],
      affiliations: ['Example University'],
    })
    expect(result.paper.nodes[0]).toMatchObject({
      type: 'heading',
      text: 'Abstract',
    })
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node &&
          (node.text.includes('Synthetic Benchmark Title') ||
            node.text.includes('Ada Example') ||
            node.text.includes('Example University')),
      ),
    ).toBe(false)
  })

  it('keeps repeated margins, page numbers, chart labels, and notes out of body prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Journal running header', 0.1, 0.02, 0.4, 8),
        run(1, 'Page one body.', 0.1, 0.24, 0.72),
        run(1, '50%', 0.82, 0.5, 0.06, 7),
        run(1, 'Sidebar context', 0.82, 0.58, 0.12, 7),
        run(1, 'Footnote 1: Separated note.', 0.1, 0.82, 0.72, 7),
        run(1, 'Journal running footer', 0.1, 0.93, 0.4, 8),
        run(1, '1', 0.48, 0.96, 0.02, 8),
      ]),
      page(2, [
        run(2, 'Journal running header', 0.1, 0.02, 0.4, 8),
        run(2, 'Page two body.', 0.1, 0.24, 0.72),
        run(2, 'Journal running footer', 0.1, 0.93, 0.4, 8),
        run(2, '2', 0.48, 0.96, 0.02, 8),
      ]),
    ])

    expect(result.regions.map((region) => region.kind)).toEqual(
      expect.arrayContaining([
        'header',
        'footer',
        'page-number',
        'chart-label',
        'side',
        'footnote',
      ]),
    )
    const body = result.paper.nodes
      .filter((node) => node.type === 'paragraph')
      .map((node) => node.text)
      .join(' ')
    expect(body).not.toContain('running header')
    expect(body).not.toContain('running footer')
    expect(body).not.toContain('50%')
    expect(body).not.toContain('Sidebar context')
  })

  it('does not classify repeated table-cell symbols as page margins', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Table heading', 0.1, 0.18, 0.3, 10),
        run(1, '✓', 0.45, 0.22, 0.03, 8),
        run(1, 'First table row', 0.1, 0.22, 0.25, 8),
      ]),
      page(2, [
        run(2, 'Another table heading', 0.1, 0.18, 0.3, 10),
        run(2, '✓', 0.45, 0.22, 0.03, 8),
        run(2, 'Second table row', 0.1, 0.22, 0.25, 8),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.text === '✓')
        .every(
          (region) => region.kind !== 'header' && region.kind !== 'footer',
        ),
    ).toBe(true)
  })

  it('reconstructs complete wrapped captions without swallowing following prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 1. A complete synthetic caption whose first',
          0.54,
          0.2,
          0.36,
          9,
        ),
        run(1, 'line wraps into this concluding line.', 0.54, 0.222, 0.25, 9),
        run(
          1,
          'Following body prose remains independent.',
          0.56,
          0.27,
          0.34,
          10,
        ),
        run(
          1,
          'Its continuation remains in the prose flow.',
          0.54,
          0.292,
          0.36,
          10,
        ),
      ]),
    ])

    const captions = result.regions.filter(
      (region) => region.kind === 'caption',
    )
    expect(captions).toHaveLength(1)
    expect(captions[0]).toMatchObject({
      column: 'single',
      text: 'Figure 1. A complete synthetic caption whose first line wraps into this concluding line.',
    })
    expect(captions[0].lines).toHaveLength(2)
    expect(
      result.paper.nodes.find((node) => node.type === 'caption'),
    ).toMatchObject({ text: captions[0].text })
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text.includes('Following body'),
      ),
    ).toMatchObject({
      text: 'Following body prose remains independent. Its continuation remains in the prose flow.',
    })
  })

  it('stops after a short terminal caption even when prose follows at normal leading', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Figure 2. A short caption.', 0.1, 0.2, 0.2, 9),
        run(
          1,
          'Following prose begins without an extra vertical gap.',
          0.1,
          0.222,
          0.38,
          9,
        ),
        run(
          1,
          'Its second line remains ordinary body text.',
          0.1,
          0.244,
          0.34,
          9,
        ),
      ]),
    ])

    expect(
      result.regions.find((region) => region.kind === 'caption'),
    ).toMatchObject({
      text: 'Figure 2. A short caption.',
      lines: [expect.objectContaining({ text: 'Figure 2. A short caption.' })],
    })
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('Following prose'),
      ),
    ).toMatchObject({
      text: 'Following prose begins without an extra vertical gap. Its second line remains ordinary body text.',
    })
  })

  it('keeps a multi-line page-spanning table caption in one caption region', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Left column establishes a stable layout.', 0.08, 0.1, 0.34),
        run(1, 'Left column continues in source order.', 0.08, 0.13, 0.34),
        run(1, 'Right column establishes a stable layout.', 0.58, 0.1, 0.34),
        run(1, 'Right column continues in source order.', 0.58, 0.13, 0.34),
        run(
          1,
          'Table 1. Comparison across all evaluated systems and',
          0.08,
          0.4,
          0.84,
          9,
        ),
        run(
          1,
          'the dimensions included by each benchmark.',
          0.08,
          0.422,
          0.64,
          9,
        ),
        run(1, 'Subsequent prose starts after the caption.', 0.08, 0.48, 0.34),
        run(1, 'A second prose line follows normally.', 0.08, 0.502, 0.34),
      ]),
    ])

    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption).toMatchObject({
      column: 'span',
      text: 'Table 1. Comparison across all evaluated systems and the dimensions included by each benchmark.',
    })
    expect(caption?.lines).toHaveLength(2)
    expect(
      result.paper.nodes.filter((node) => node.type === 'caption'),
    ).toEqual([expect.objectContaining({ text: caption?.text })])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text.includes('Subsequent prose starts after the caption.'),
      ),
    ).toBe(true)
  })

  it('orders both column bands around a spanning block and links notes under each column', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(1, 'Two column study', 0.08, 0.1, 0.84, 18),
          run(1, 'Left above one.', 0.08, 0.2, 0.32),
          run(1, 'Left above two.', 0.08, 0.24, 0.32),
          run(1, 'Left claim', 0.08, 0.28, 0.24),
          run(1, '1', 0.325, 0.283, 0.008, 6, 0.009),
          run(1, 'Right above one.', 0.56, 0.2, 0.32),
          run(1, 'Right above two.', 0.56, 0.24, 0.32),
          run(1, 'Right claim', 0.56, 0.28, 0.24),
          run(1, '2', 0.805, 0.283, 0.008, 6, 0.009),
          run(1, 'Spanning figure between column bands', 0.12, 0.42, 0.76, 11),
          run(1, 'Left below one.', 0.08, 0.54, 0.32),
          run(1, 'Left below two.', 0.08, 0.58, 0.32),
          run(1, 'Left below three.', 0.08, 0.62, 0.32),
          run(1, 'Right below one.', 0.56, 0.54, 0.32),
          run(1, 'Right below two.', 0.56, 0.58, 0.32),
          run(1, 'Right below three.', 0.56, 0.62, 0.32),
          run(1, '1. Left-column note.', 0.08, 0.82, 0.32, 7),
          run(1, '2. Right-column note.', 0.56, 0.82, 0.32, 7),
        ],
        [
          {
            id: 'image-p001-001',
            page: 1,
            kind: 'image',
            assetId: null,
            box: {
              page: 1,
              x: 0.2,
              y: 0.36,
              width: 0.6,
              height: 0.05,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 0.98,
          },
        ],
      ),
    ])

    const canonicalText = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(canonicalText.indexOf('Left above')).toBeLessThan(
      canonicalText.indexOf('Right above'),
    )
    expect(canonicalText.indexOf('Right above')).toBeLessThan(
      canonicalText.indexOf('Spanning figure'),
    )
    expect(canonicalText.indexOf('Spanning figure')).toBeLessThan(
      canonicalText.indexOf('Left below'),
    )
    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'spanning', column: 'span' }),
        expect.objectContaining({ kind: 'figure', column: 'span' }),
        expect.objectContaining({ kind: 'footnote', column: 'left' }),
        expect.objectContaining({ kind: 'footnote', column: 'right' }),
      ]),
    )
    const figure = result.regions.find((region) => region.kind === 'figure')!
    const above = result.regions.find((region) =>
      region.text.includes('Left above'),
    )!
    const below = result.regions.find((region) =>
      region.text.includes('Left below'),
    )!
    expect(result.readingOrder.order.indexOf(above.id)).toBeLessThan(
      result.readingOrder.order.indexOf(figure.id),
    )
    expect(result.readingOrder.order.indexOf(figure.id)).toBeLessThan(
      result.readingOrder.order.indexOf(below.id),
    )
    expect(result.noteRelationships).toHaveLength(2)
    expect(
      result.noteRelationships.every((note) => note.status === 'matched'),
    ).toBe(true)
    expect(result.noteRelationships.map((note) => note.evidence)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['same-column-geometry']),
      ]),
    )
    expect(
      result.regions.every(
        (region) => region.confidence > 0 && region.box.page === region.page,
      ),
    ).toBe(true)
    expect(
      result.readingOrder.edges.every(
        (edge) =>
          edge.confidence > 0 &&
          edge.evidence.length > 0 &&
          edge.sourceBoxes.length === 2,
      ),
    ).toBe(true)
    expect(
      result.noteRelationships.every(
        (relationship) =>
          relationship.confidence > 0 && relationship.sourceBoxes.length === 2,
      ),
    ).toBe(true)
    expect(result.completeness).toMatchObject({
      relationshipCoverage: 1,
      readingOrderDiagnostics: 0,
    })
  })

  it('keeps every included column region when a spanning object overlaps its vertical band', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(1, 'Overlapping float study', 0.08, 0.08, 0.84, 18),
          run(1, 'Left retained one.', 0.08, 0.2, 0.32),
          run(1, 'Left retained two.', 0.08, 0.24, 0.32),
          run(1, 'Left retained three.', 0.08, 0.28, 0.32),
          run(1, 'Right retained one.', 0.56, 0.2, 0.32),
          run(1, 'Right retained two.', 0.56, 0.24, 0.32),
          run(1, 'Right retained three.', 0.56, 0.28, 0.32),
        ],
        [
          {
            id: 'vector-p001-001',
            page: 1,
            kind: 'vector',
            assetId: null,
            box: {
              page: 1,
              x: 0.2,
              y: 0.15,
              width: 0.6,
              height: 0.5,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 0.98,
          },
        ],
      ),
    ])

    const included = result.regions
      .filter((region) => region.includedInReadingOrder)
      .map((region) => region.id)
    expect(new Set(result.readingOrder.order)).toEqual(new Set(included))
    expect(result.readingOrder.order).toHaveLength(included.length)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('Left retained')
  })

  it('matches a page-wide symbolic footnote and emits EPUB note semantics and backlinks', async () => {
    const result = await reconstruct(
      [
        page(1, [
          run(1, 'Regions', 0.35, 0.08, 0.3, 18, 0.03),
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Left two.', 0.08, 0.24, 0.32),
          run(1, 'Left marker', 0.08, 0.28, 0.24),
          run(1, '*', 0.325, 0.283, 0.008, 6, 0.009),
          run(1, 'Right one.', 0.56, 0.2, 0.32),
          run(1, 'Right two.', 0.56, 0.24, 0.32),
          run(1, 'Right three.', 0.56, 0.28, 0.32),
          run(
            1,
            '*. A note spanning the full page width.',
            0.08,
            0.82,
            0.84,
            7,
          ),
        ]),
      ],
      '8',
    )

    expect(result.noteRelationships).toEqual([
      expect.objectContaining({
        label: '*',
        status: 'matched',
        evidence: expect.arrayContaining(['page-wide-note-region']),
      }),
    ])
    expect(result.readiness.ready).toBe(true)
    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('epub:type="noteref"')
    expect(content).toContain('epub:type="footnote"')
    expect(content).toContain('class="note-backlink"')
  })

  it('retains a near-body-size symbolic bottom note as a footnote', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
        run(1, '* Work done during the internship.', 0.08, 0.86, 0.7, 9.5),
      ]),
    ])

    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'footnote',
          text: expect.stringContaining('Work done during the internship.'),
        }),
      ]),
    )
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'footnote' && node.text.includes('Work done'),
      ),
    ).toBe(true)
  })

  it('keeps a wrapped symbolic note continuation in the note', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'LightSpeed Studios, Tencent', 0.2, 0.1, 0.5, 9),
        run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
        run(
          1,
          '*Work done during the internship at Tencent Lightspeed stu-',
          0.109,
          0.862,
          0.369,
          9,
          0.011,
        ),
        run(1, 'dios.', 0.088, 0.875, 0.028, 9, 0.011),
      ]),
    ])

    expect(
      result.paper.nodes.find((node) => node.type === 'footnote'),
    ).toMatchObject({
      text: '*Work done during the internship at Tencent Lightspeed studios.',
    })
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'paragraph' && node.text.includes('dios.'),
      ),
    ).toBe(false)
  })

  it('retains unresolved and equally plausible note candidates as explicit diagnostics', async () => {
    const unresolved = await reconstruct([
      page(1, [run(1, 'A claim with an unavailable note[3].', 0.1, 0.2, 0.72)]),
    ])
    expect(unresolved.noteRelationships).toEqual([
      expect.objectContaining({
        label: '3',
        status: 'unresolved',
        targetNoteId: null,
        candidates: [],
      }),
    ])
    expect(unresolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_NOTE_REFERENCE' }),
      ]),
    )

    const ambiguous = await reconstruct([
      page(1, [
        run(1, 'Left one.', 0.08, 0.2, 0.32),
        run(1, 'Left two.', 0.08, 0.24, 0.32),
        run(1, 'Left three.', 0.08, 0.28, 0.32),
        run(1, 'Right one.', 0.56, 0.2, 0.32),
        run(1, 'Right two.', 0.56, 0.24, 0.32),
        run(1, 'Right three.', 0.56, 0.28, 0.32),
        run(1, 'A spanning claim has note reference 1.', 0.1, 0.42, 0.8),
        run(1, '1. Left candidate.', 0.08, 0.82, 0.32, 7),
        run(1, '1. Right candidate.', 0.56, 0.82, 0.32, 7),
      ]),
    ])
    expect(ambiguous.noteRelationships).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        targetNoteId: null,
        candidates: [
          expect.objectContaining({ score: 0.85 }),
          expect.objectContaining({ score: 0.85 }),
        ],
      }),
    ])
    expect(ambiguous.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_NOTE_MATCH' }),
      ]),
    )
  })

  it('resolves multi-page endnotes and exposes machine-readable order accuracy', async () => {
    const result = await reconstruct(
      [
        page(1, [
          run(1, 'The first claim has note reference 1.', 0.1, 0.2, 0.72),
          run(1, 'The second claim has note reference 2.', 0.1, 0.25, 0.72),
        ]),
        page(2, [
          run(2, 'Endnotes', 0.1, 0.12, 0.3, 18),
          run(2, '1. First endnote on page two.', 0.1, 0.22, 0.72),
        ]),
        page(3, [run(3, '2. Second endnote on page three.', 0.1, 0.18, 0.72)]),
      ],
      '9',
    )

    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([
      expect.objectContaining({ kind: 'endnote', label: '1' }),
      expect.objectContaining({ kind: 'endnote', label: '2' }),
    ])
    expect(
      result.noteRelationships.every((note) => note.status === 'matched'),
    ).toBe(true)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 2,
      relationshipCoverage: 1,
    })
    expect(
      evaluateReadingOrder(result.readingOrder, result.readingOrder.order),
    ).toMatchObject({ orderAccuracy: 1, cycleRate: 0 })
  })
})
