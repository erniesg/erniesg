import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpub, buildReadableEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { reconstructPageRegions } from './pdf-regions'

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
          sourceRegionIds: [equationRegion.id],
          sourceLineIds: ['page-001-line-0002'],
          sourceObjectIds: [],
          assetIds: [],
          canonicalNodeId: null,
          sourceText: 'x + y = z',
          altText: 'x + y = z',
          altTextSource: 'source-text',
          evidence: expect.not.arrayContaining(['source-page-crop']),
          candidates: expect.arrayContaining([
            expect.objectContaining({
              id: expect.stringMatching(/^visual-candidate-[a-f0-9]{64}$/u),
              sourceRegionIds: [equationRegion.id],
              sourceLineIds: ['page-001-line-0002'],
              sourceText: 'x + y = z',
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
    expect(result.regions.map((region) => region.id)).toContain(
      equationRegion.id,
    )
    expect(result.regions.map((region) => region.text)).toContain(
      'Following body text.',
    )
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
      unprovenancedRenderedUnitCount: 0,
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
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNPROVENANCED_RENDERED_UNIT' }),
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
    const visibleFallbackText = result.paper.nodes
      .flatMap((node) =>
        node.type === 'paragraph' && /(?:Key|Value|A|B|1|2)/.test(node.text)
          ? [node.text]
          : [],
      )
      .join(' ')
    expect(visibleFallbackText.match(/\b(?:Key|Value|A|B|1|2)\b/gu)).toEqual([
      'Key',
      'Value',
      'A',
      '1',
      'B',
      '2',
    ])
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

  it('keeps standalone Unicode note markers with adjacent compact bodies out of page furniture', () => {
    const markers = ['1', '٢', '³']
    const result = reconstructPageRegions(
      markers.map((marker, index) => {
        const pageNumber = index + 1
        return page(pageNumber, [
          run(
            pageNumber,
            `Canonical body prose on page ${pageNumber}.`,
            0.12,
            0.24,
            0.72,
            10,
          ),
          run(pageNumber, marker, 0.12, 0.93, 0.02, 7, 0.008),
          run(
            pageNumber,
            `Detached footnote body for marker ${pageNumber}.`,
            0.12,
            0.941,
            0.5,
            7,
            0.012,
          ),
        ])
      }),
    )

    const notes = result.regions.filter((region) => region.kind === 'footnote')
    expect(notes).toHaveLength(3)
    expect(
      notes.map((region) => ({
        includedInReadingOrder: region.includedInReadingOrder,
        sourceText: region.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      })),
    ).toEqual(
      markers.map((marker, index) => ({
        includedInReadingOrder: true,
        sourceText: [marker, `Detached footnote body for marker ${index + 1}.`],
      })),
    )
    expect(notes.every((region) => region.furniture === undefined)).toBe(true)
    expect(
      result.regions.some(
        (region) =>
          region.kind === 'page-number' && markers.includes(region.text),
      ),
    ).toBe(false)
  })

  it('classifies repeated source-run margins before a colliding diagram title is joined', () => {
    const runningAuthor =
      'Paul Pu Liang, Amir Zadeh, and Louis-Philippe Morency'
    const runningTitle = 'Foundations & Trends in Multimodal Machine Learning'
    const result = reconstructPageRegions([
      page(2, [
        run(2, '1:2', 0.094, 0.083, 0.019, 8, 0.011),
        run(2, runningAuthor, 0.525, 0.083, 0.381, 8, 0.011),
        run(2, 'Page-two prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(3, [
        run(3, runningTitle, 0.094, 0.083, 0.377, 8, 0.011),
        run(3, '1:3', 0.887, 0.083, 0.019, 8, 0.011),
        run(3, 'Page-three prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(4, [
        run(4, '1:4', 0.094, 0.083, 0.019, 8, 0.011),
        run(4, runningAuthor, 0.525, 0.083, 0.381, 8, 0.011),
        run(4, 'Dimensions of Heterogeneity', 0.176, 0.075, 0.386, 13.5, 0.019),
        run(4, 'Page-four prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(5, [
        run(5, runningTitle, 0.094, 0.083, 0.377, 8, 0.011),
        run(5, '1:5', 0.887, 0.083, 0.019, 8, 0.011),
        run(5, 'Page-five prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
    ])

    const furniture = result.regions.filter(
      (region) =>
        region.text === runningAuthor ||
        region.text === runningTitle ||
        /^1:\d+$/u.test(region.text),
    )
    expect(furniture).toHaveLength(8)
    expect(
      furniture.every(
        (region) =>
          ['header', 'page-number'].includes(region.kind) &&
          region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    expect(
      result.regions.find(
        (region) => region.text === 'Dimensions of Heterogeneity',
      ),
    ).toMatchObject({
      includedInReadingOrder: true,
    })
    expect(
      result.regions
        .filter((region) => region.includedInReadingOrder)
        .map((region) => region.text),
    ).toEqual([
      'Page-two prose remains canonical.',
      'Page-three prose remains canonical.',
      'Dimensions of Heterogeneity',
      'Page-four prose remains canonical.',
      'Page-five prose remains canonical.',
    ])
  })

  it('does not treat normalized numeric repetitions on one page as margins', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, '3. MLPs 14-18 fit the b token', 0.1, 0.18, 0.55),
        run(1, 'and retain the ordinary step explanation.', 0.12, 0.205, 0.68),
        run(1, '4. MLPs 19-27 fit the a token', 0.1, 0.34, 0.55),
        run(
          1,
          'and retain the next ordinary step explanation.',
          0.12,
          0.365,
          0.7,
        ),
      ]),
    ])

    expect(
      result.regions.map((region) => ({
        kind: region.kind,
        includedInReadingOrder: region.includedInReadingOrder,
        text: region.text,
      })),
    ).toEqual([
      {
        kind: 'body',
        includedInReadingOrder: true,
        text: '3. MLPs 14-18 fit the b token and retain the ordinary step explanation.',
      },
      {
        kind: 'body',
        includedInReadingOrder: true,
        text: '4. MLPs 19-27 fit the a token and retain the next ordinary step explanation.',
      },
    ])
  })

  it('owns explicit first-page address and legal bands as source-preserved paratext', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(
            1,
            'The introduction begins as continuous prose and reaches this',
            0.094,
            0.706,
            0.81,
            10,
            0.014,
          ),
          run(
            1,
            'Authors’ address: Ada Example, ada@example.edu;',
            0.094,
            0.75,
            0.5,
            8,
            0.011,
          ),
          run(
            1,
            'Example Institute, 500 Research Avenue.',
            0.094,
            0.764,
            0.38,
            8,
            0.011,
          ),
          run(
            1,
            'Permission to make digital or hard copies of this work is granted without fee',
            0.094,
            0.816,
            0.81,
            8,
            0.011,
          ),
          run(
            1,
            'provided that copies bear this notice and the full citation.',
            0.094,
            0.83,
            0.64,
            8,
            0.011,
          ),
          run(
            1,
            '© 2022 Copyright held by the owner/author(s).',
            0.094,
            0.873,
            0.31,
            8,
            0.011,
          ),
          run(1, '0360-0300/2022/10-ART1', 0.094, 0.887, 0.17, 8, 0.011),
          run(
            1,
            'https://doi.org/10.0000/example',
            0.094,
            0.901,
            0.26,
            8,
            0.011,
          ),
          run(
            1,
            'Preprint, Vol. 1, No. 1. Publication date: October 2022.',
            0.48,
            0.934,
            0.43,
            8,
            0.011,
          ),
        ].map((sourceRun, sourceSequenceIndex) => ({
          ...sourceRun,
          sourceSequenceIndex,
        })),
      ),
      page(2, [
        {
          ...run(
            2,
            'vibrant research continues without intervening page furniture.',
            0.094,
            0.14,
            0.72,
          ),
          sourceSequenceIndex: 0,
        },
      ]),
    ])

    const paratext = result.regions.filter((region) =>
      /(?:Authors.? address|Permission to make|Copyright held|0360-0300|doi\.org|Preprint, Vol\.)/iu.test(
        region.text,
      ),
    )
    expect(paratext.length).toBeGreaterThanOrEqual(4)
    expect(
      paratext.every(
        (region) =>
          region.kind === 'footer' && region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    const canonicalText = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .filter(Boolean)
    expect(canonicalText).toEqual([
      'The introduction begins as continuous prose and reaches this vibrant research continues without intervening page furniture.',
    ])
  })

  it('keeps near-bottom first-page body text in canonical prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Earlier body prose establishes the primary type size.',
          0.18,
          0.5,
          0.64,
          11,
        ),
        run(
          1,
          'A second ordinary body line continues the discussion.',
          0.18,
          0.53,
          0.64,
          11,
        ),
        run(
          1,
          'The paragraph reaches the lower page while producing',
          0.18,
          0.755,
          0.64,
          10,
        ),
        run(
          1,
          'the complete result and retains all enumerated benefits,',
          0.18,
          0.772,
          0.64,
          10,
        ),
        run(
          1,
          'including the final source-backed contribution.',
          0.18,
          0.789,
          0.64,
          10,
        ),
      ]),
    ])

    const lowerBody = result.regions.filter((region) =>
      /(?:lower page|enumerated benefits|final source-backed)/u.test(
        region.text,
      ),
    )
    expect(lowerBody.length).toBeGreaterThan(0)
    expect(
      lowerBody.every(
        (region) =>
          region.kind === 'body' && region.includedInReadingOrder === true,
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('retains all enumerated benefits')
  })

  it('excludes geometrically isolated first-page small print from two-column prose flow', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'systems support a large range of tasks, including robotics (Driess et al., 2023; Brohan',
          0.08,
          0.6,
          0.4,
          10,
        ),
        run(
          1,
          'et al., 2023), bioinformatics and health-care.',
          0.54,
          0.14,
          0.38,
          10,
        ),
        run(
          1,
          'Workshop publication metadata and venue details',
          0.08,
          0.82,
          0.58,
          8,
          0.011,
        ),
        run(
          1,
          'Right-column prose continues independently.',
          0.7,
          0.827,
          0.22,
          10,
        ),
        run(
          1,
          'Volume information, publication date, and rights statement.',
          0.16,
          0.836,
          0.62,
          8,
          0.011,
        ),
        run(1, 'Another right-column line follows.', 0.7, 0.845, 0.22, 10),
      ]),
    ])

    const imprintRegions = result.regions.filter((region) =>
      /(?:publication metadata|Volume information)/u.test(region.text),
    )
    expect(imprintRegions.length).toBeGreaterThan(0)
    expect(
      imprintRegions.every(
        (region) =>
          region.kind === 'footer' && region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).not.toContain('Workshop publication metadata')
  })

  it('keeps a complete chart-axis label out of neighboring prose', async () => {
    const result = await reconstruct([
      page(
        2,
        [
          run(2, 'Horizontal measure (sample=19)', 0.08, 0.54, 0.34, 8),
          run(
            2,
            'neighboring prose continues in the other column.',
            0.54,
            0.54,
            0.38,
            10,
          ),
        ],
        [
          {
            id: 'vector-chart',
            page: 2,
            kind: 'vector',
            box: {
              page: 2,
              x: 0.06,
              y: 0.2,
              width: 0.4,
              height: 0.38,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
            role: 'semantic',
          },
        ],
      ),
    ])

    expect(
      result.regions.some(
        (region) =>
          region.kind === 'chart-label' &&
          region.text === 'Horizontal measure (sample=19)',
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('neighboring prose continues in the other column.')
  })

  it('separates publication status while retaining notes, captions, and bottom prose', () => {
    const result = reconstructPageRegions([
      page(1, [
        ...Array.from({ length: 5 }, (_, index) =>
          run(
            1,
            `Earlier body line ${index + 1} establishes page typography.`,
            0.176,
            0.2 + index * 0.08,
            0.65,
            10,
            0.013,
          ),
        ),
        run(
          1,
          'Ordinary body prose remains canonical near the bottom of the page.',
          0.176,
          0.88,
          0.65,
          10,
          0.013,
        ),
        run(1, '∗ Equal contribution.', 0.176, 0.905, 0.15, 8, 0.011),
        run(
          1,
          'Figure 7. A genuine bottom-band caption.',
          0.48,
          0.923,
          0.35,
          8,
          0.011,
        ),
        run(1, 'Preprint. Under review.', 0.176, 0.946, 0.14, 9, 0.011),
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.text.includes('Ordinary body prose'),
      ),
    ).toMatchObject({ kind: 'body', includedInReadingOrder: true })
    expect(
      result.regions.find((region) => region.text === '∗ Equal contribution.'),
    ).toMatchObject({ kind: 'footnote', includedInReadingOrder: true })
    expect(
      result.regions.find((region) => region.text.startsWith('Figure 7.')),
    ).toMatchObject({ kind: 'caption', includedInReadingOrder: true })
    expect(
      result.regions.find(
        (region) => region.text === 'Preprint. Under review.',
      ),
    ).toMatchObject({ kind: 'footer', includedInReadingOrder: false })
  })

  it('keeps repeated URL notes when dense chart labels skew page font statistics', async () => {
    const chartLabels = Array.from({ length: 48 }, (_, index) =>
      run(
        1,
        String(index),
        0.12 + (index % 8) * 0.09,
        0.38 + Math.floor(index / 8) * 0.045,
        0.03,
        3.5,
        0.006,
      ),
    )
    const note = (pageNumber: number, label: string) => {
      const marker = run(pageNumber, label, 0.197, 0.909, 0.005, 6, 0.0075)
      const url = run(
        pageNumber,
        'https://github.com/example/repeated-source',
        0.203,
        0.91,
        0.42,
        9,
        0.0113,
      )
      url.fontName = 'SyntheticMono'
      return [marker, url]
    }
    const prose = (pageNumber: number) => [
      run(
        pageNumber,
        'Ordinary scholarly prose establishes the actual body font.',
        0.176,
        0.18,
        0.64,
      ),
      run(
        pageNumber,
        'A second continuous sentence supplies stable prose evidence.',
        0.176,
        0.21,
        0.64,
      ),
      run(
        pageNumber,
        'A third continuous sentence supplies stable prose evidence.',
        0.176,
        0.24,
        0.64,
      ),
    ]
    const result = await reconstruct([
      page(1, [...prose(1), ...chartLabels, ...note(1, '8')]),
      page(2, [...prose(2), ...note(2, '9')]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'footnote')
        .map((region) => region.text),
    ).toEqual([
      '8 https://github.com/example/repeated-source',
      '9 https://github.com/example/repeated-source',
    ])
  })

  it('does not classify repeated table-cell symbols as page margins', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Table heading', 0.1, 0.06, 0.3, 10),
        run(1, '✓', 0.45, 0.083, 0.03, 8),
        run(1, 'First table row', 0.1, 0.083, 0.25, 8),
      ]),
      page(2, [
        run(2, 'Another table heading', 0.1, 0.06, 0.3, 10),
        run(2, '✓', 0.45, 0.083, 0.03, 8),
        run(2, 'Second table row', 0.1, 0.083, 0.25, 8),
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

  it('keeps interleaved multi-panel label continuations with their source panel', () => {
    const result = reconstructPageRegions([
      page(
        1,
        [
          run(
            1,
            '(a) SEQCODER-1.5B accuracy as a function of',
            0.176,
            0.277,
            0.291,
            9,
            0.011,
          ),
          run(
            1,
            '(b) SEQCODER-1.5B accuracy as a function of',
            0.532,
            0.277,
            0.291,
            9,
            0.011,
          ),
          run(1, 'gold program lengths.', 0.176, 0.29, 0.129, 9, 0.011),
          run(1, 'input sequence lengths.', 0.532, 0.29, 0.137, 9, 0.011),
          run(
            1,
            'Figure 11: Accuracy as a function of program and input sequence lengths.',
            0.182,
            0.315,
            0.635,
            9,
            0.013,
          ),
        ],
        [
          {
            id: 'panel-a',
            page: 1,
            kind: 'image',
            box: {
              page: 1,
              x: 0.176,
              y: 0.103,
              width: 0.291,
              height: 0.169,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
          },
          {
            id: 'panel-b',
            page: 1,
            kind: 'image',
            box: {
              page: 1,
              x: 0.532,
              y: 0.103,
              width: 0.291,
              height: 0.169,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
          },
        ],
      ),
    ])

    expect(
      result.regions
        .filter((region) => /^\([ab]\)/u.test(region.text))
        .map((region) => region.text),
    ).toEqual([
      '(a) SEQCODER-1.5B accuracy as a function of gold program lengths.',
      '(b) SEQCODER-1.5B accuracy as a function of input sequence lengths.',
    ])
  })

  it('keeps prose with inline equations in the complete caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 16. We plot the magnitude of each Fourier feature.',
          0.09,
          0.2,
          0.39,
          9,
        ),
        run(
          1,
          'The period T = 2 component is omitted from the plotted basis.',
          0.09,
          0.222,
          0.39,
          9,
        ),
        run(
          1,
          'Its output is measured on a different scale.',
          0.09,
          0.244,
          0.32,
          9,
        ),
        run(1, 'Following body prose.', 0.09, 0.29, 0.39, 10),
      ]),
    ])

    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption?.text).toBe(
      'Figure 16. We plot the magnitude of each Fourier feature. The period T = 2 component is omitted from the plotted basis. Its output is measured on a different scale.',
    )
    expect(caption?.lines).toHaveLength(3)
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text === 'Following body prose.',
      ),
    ).toBeDefined()
  })

  it('keeps split caption prose and source-backed stacked formula obligations', async () => {
    const mathRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize: number,
      height: number,
      fontName: string,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 8. An inline formula is preserved by',
          0.5,
          0.2,
          0.385,
          9,
          0.01132,
        ),
        run(
          1,
          'helix(x). We use evidence to show that',
          0.5,
          0.214,
          0.305,
          9,
          0.01132,
        ),
        mathRun('l', 0.8197, 0.213, 0.004, 6, 0.00755, 'Synthetic+CMMI6'),
        mathRun('=', 0.8197, 0.2208, 0.009, 6, 0.00755, 'Synthetic+CMR6'),
        mathRun('h', 0.811, 0.214, 0.0087, 9, 0.01132, 'Synthetic+CMMI9'),
        run(1, 'for', 0.835, 0.214, 0.02, 9, 0.01132),
        run(
          1,
          'the model in every evaluated layer.',
          0.5,
          0.228,
          0.24,
          9,
          0.01132,
        ),
      ]),
    ])

    const caption = result.paper.nodes.find((node) => node.type === 'caption')
    expect(caption?.text).toContain(
      'Figure 8. An inline formula is preserved by helix(x). We use evidence to show that',
    )
    expect(caption?.text).toContain('for the model in every evaluated layer.')
    expect(caption?.text).not.toContain('hl=')
    const formulaNodes = result.paper.nodes.filter(
      (node) =>
        node.type === 'paragraph' &&
        /^(?:l=h|hl=)(?:\s+for)?$/u.test(node.text),
    )
    expect(formulaNodes).toEqual([
      expect.objectContaining({
        type: 'paragraph',
        text: 'hl=',
        inlineRuns: expect.arrayContaining([
          expect.objectContaining({ verticalAlign: 'superscript' }),
          expect.objectContaining({ verticalAlign: 'subscript' }),
        ]),
      }),
    ])
    expect(result.provenance[formulaNodes[0].id]?.boxes.length).toBeGreaterThan(
      0,
    )
    const captionRegion = result.regions.find(
      (region) => region.kind === 'caption',
    )
    expect(
      captionRegion?.lines.flatMap((line) =>
        line.runs.map((sourceRun) => sourceRun.text),
      ),
    ).toEqual(expect.arrayContaining(['for']))
    expect(
      captionRegion?.lines.flatMap((line) =>
        line.runs.map((sourceRun) => sourceRun.text),
      ),
    ).not.toEqual(expect.arrayContaining(['h', 'l', '=']))

    expect(
      result.visualRelationships.find(
        (relationship) =>
          relationship.kind === 'equation' &&
          relationship.evidence.includes('source-text-transcript-unresolved'),
      ),
    ).toMatchObject({
      status: 'unresolved',
      sourceText: '',
      altTextSource: 'caption',
    })
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_VISUAL_OBJECT',
      ]),
    })
    expect(result.completeness.expectedInlineSpanCount).toBeGreaterThan(0)

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('<em>h</em><sup><em>l</em></sup><sub>=</sub>')
    expect(content).not.toContain('>Display equation p001-001<')
    expect(content).not.toContain('orphan-caption omitted-visual')
  })

  it('keeps a short sentence-like inline equation continuation in its caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 39. We analyze each selected neuron’s maximally',
          0.09,
          0.28,
          0.79,
          9,
          0.011,
        ),
        run(1, 'activating a + b example.', 0.091, 0.294, 0.15, 9, 0.011),
        run(1, 'Following prose remains separate.', 0.09, 0.35, 0.36, 9),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 39. We analyze each selected neuron’s maximally activating a + b example.',
        lines: expect.arrayContaining([
          expect.objectContaining({ text: 'activating a + b example.' }),
        ]),
      }),
    ])
  })

  it('keeps enumerated subfigure prose in one complete caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 1. Comparison of three strategies. (a) Fixed planning.',
          0.54,
          0.2,
          0.36,
          9,
        ),
        run(
          1,
          '(b) Interactive planning. The proposed method appears in (c).',
          0.54,
          0.222,
          0.36,
          9,
        ),
        run(
          1,
          'Following body prose remains independent.',
          0.54,
          0.27,
          0.34,
          10,
        ),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 1. Comparison of three strategies. (a) Fixed planning. (b) Interactive planning. The proposed method appears in (c).',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: '(b) Interactive planning. The proposed method appears in (c).',
          }),
        ]),
      }),
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text === 'Following body prose remains independent.',
      ),
    ).toBe(true)
  })

  it('keeps an inline abbreviated figure reference in continuous body prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'The comparison is continued in', 0.12, 0.2, 0.34, 10, 0.018),
        run(
          1,
          'Fig. 8. Specifically, the discussion follows the same protocol',
          0.12,
          0.218,
          0.52,
          10,
          0.018,
        ),
        run(
          1,
          'and remains part of the surrounding paragraph.',
          0.12,
          0.236,
          0.4,
          10,
          0.018,
        ),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text),
    ).toEqual([
      'The comparison is continued in Fig. 8. Specifically, the discussion follows the same protocol and remains part of the surrounding paragraph.',
    ])
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

})
