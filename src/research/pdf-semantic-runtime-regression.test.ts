import { describe, expect, it } from 'vitest'
import { renderPublicationXhtml } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { researchPaperSchema } from './schema'
import { createSourcePageCropAsset } from './visual-assets'

function sourceRun(
  page: number,
  text: string,
  x: number,
  y: number,
  width = 0.72,
  fontSize = 10,
  fontName = 'Body',
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
    fontName,
    fontSize,
    confidence: 1,
  }
}

function page(number: number, runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs,
  }
}

function reconstruct(
  pages: PdfPageAnalysis[],
  options: {
    title?: string
    fileName?: string
    rasterizeFigure?: Parameters<
      typeof reconstructPageAnalyses
    >[0]['rasterizeFigure']
  } = {},
) {
  return reconstructPageAnalyses({
    pages,
    sourceHash: '9'.repeat(64),
    fileName: options.fileName ?? 'semantic-runtime.pdf',
    byteLength: 4096,
    metadata: options.title ? { title: options.title } : {},
    rasterizeFigure: options.rasterizeFigure,
  })
}

describe('PDF semantic runtime regressions', () => {
  it('anchors citations consumed by a source-backed table to its canonical visual owner', async () => {
    const tableCell = (
      text: string,
      x: number,
      y: number,
      fontName = 'Table',
    ) => sourceRun(1, text, x, y, 0.16, 8, fontName)
    const result = await reconstruct(
      [
        page(1, [
          sourceRun(1, 'Table citation study', 0.1, 0.04, 0.72, 18, 'Heading'),
          tableCell('System', 0.12, 0.14, 'TableBold'),
          tableCell('Score', 0.4, 0.14, 'TableBold'),
          tableCell('Evidence', 0.67, 0.14, 'TableBold'),
          tableCell('Baseline', 0.12, 0.19),
          tableCell('71', 0.4, 0.19),
          tableCell('[1]', 0.67, 0.19),
          tableCell('Method A', 0.12, 0.24),
          tableCell('82', 0.4, 0.24),
          tableCell('[2]', 0.67, 0.24),
          tableCell('Method B', 0.12, 0.29),
          tableCell('84', 0.4, 0.29),
          tableCell('[1-2]', 0.67, 0.29),
          sourceRun(
            1,
            'Table 1. Source-backed benchmark results.',
            0.12,
            0.35,
            0.68,
            10,
            'Caption',
          ),
        ]),
        page(2, [
          sourceRun(2, 'References', 0.1, 0.1, 0.3, 16, 'Heading'),
          sourceRun(2, '[1] Synthetic reference alpha.', 0.1, 0.18),
          sourceRun(2, '[2] Synthetic reference beta.', 0.1, 0.24),
        ]),
      ],
      {
        rasterizeFigure: async (input) =>
          createSourcePageCropAsset({
            kind: input.kind === 'figure' ? 'raster' : input.kind,
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 710,
            height: 168,
            pixels: new Uint8Array(710 * 168 * 4).fill(88),
          }),
      },
    )
    const table = result.paper.nodes.find(
      (node) => node.type === 'figure' && node.objectType === 'table',
    )
    const citations = result.citationRelationships.filter((relationship) =>
      relationship.sourceBoxes.some((sourceBox) => sourceBox.page === 1),
    )

    expect(result.visualRelationships).toEqual([
      expect.objectContaining({ kind: 'table', status: 'matched' }),
    ])
    expect(table).toMatchObject({
      type: 'figure',
      objectType: 'table',
      sourceText: expect.stringContaining('[1-2]'),
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({
          semanticRole: 'citation',
          relationshipId: expect.any(String),
        }),
      ]),
    })
    expect(citations).toHaveLength(3)
    expect(
      citations.every(
        (relationship) =>
          relationship.status === 'matched' &&
          relationship.canonicalAnchor?.nodeId === table?.id,
      ),
    ).toBe(true)
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNMAPPED_CITATION_ANCHOR',
      ),
    ).toEqual([])
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: expect.any(Number),
      inlineSpanCoverage: 1,
      unresolvedObjects: { citations: 0 },
    })
    expect(researchPaperSchema.safeParse(result.paper).success).toBe(true)
    const xhtml = renderPublicationXhtml(result.paper, {
      reconstruction: result,
    })
    expect(xhtml).toContain('class="visually-hidden visual-source-transcript"')
    expect(xhtml.replace(/<[^>]+>/gu, '')).toContain('[1-2]')
    for (const citation of citations) {
      expect(xhtml).toContain(`data-relationship-id="${citation.id}"`)
    }
  })

  it('anchors a table citation after an exact discretionary-hyphen replay', async () => {
    const tableLine = (text: string, y: number) =>
      sourceRun(1, text, 0.12, y, 0.68, 8, 'TableSerif')
    const result = await reconstruct(
      [
        page(1, [
          sourceRun(
            1,
            'Hyphenated table study',
            0.1,
            0.04,
            0.72,
            18,
            'Heading',
          ),
          sourceRun(
            1,
            'The word hyphenated is established in source context.',
            0.1,
            0.08,
            0.72,
            10,
          ),
          tableLine('Prompt hyphen-', 0.12),
          sourceRun(1, 'ated result', 0.12, 0.145, 0.25, 8, 'TableSerif'),
          sourceRun(1, '[1]', 0.39, 0.142, 0.04, 8, 'TableSerif'),
          tableLine('Second source row [1]', 0.17),
          tableLine('Third source row', 0.195),
          tableLine('Fourth source row', 0.22),
          tableLine('Fifth source row', 0.245),
          sourceRun(
            1,
            'Table 1. Caption-bounded source transcript.',
            0.12,
            0.28,
            0.68,
            10,
            'Caption',
          ),
        ]),
        page(2, [
          sourceRun(2, 'References', 0.1, 0.1, 0.3, 16, 'Heading'),
          sourceRun(2, '[1] Synthetic reference.', 0.1, 0.18),
        ]),
      ],
      {
        rasterizeFigure: async (input) =>
          createSourcePageCropAsset({
            kind: input.kind === 'figure' ? 'raster' : input.kind,
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 680,
            height: 143,
            pixels: new Uint8Array(680 * 143 * 4).fill(88),
          }),
      },
    )
    const table = result.paper.nodes.find(
      (node) => node.type === 'figure' && node.objectType === 'table',
    )
    const citations = result.citationRelationships.filter((relationship) =>
      relationship.sourceBoxes.some((sourceBox) => sourceBox.page === 1),
    )

    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'removed-discretionary-hyphen',
        }),
      ]),
    )
    expect(table).toMatchObject({
      sourceText: expect.stringContaining('[1]'),
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({
          semanticRole: 'citation',
          relationshipId: expect.any(String),
        }),
      ]),
    })
    expect(citations).toHaveLength(2)
    expect(
      citations.every(
        (citation) =>
          citation.status === 'matched' &&
          citation.canonicalAnchor?.nodeId === table?.id,
      ),
    ).toBe(true)
  })

  it('rebases citation spans after stripping a list marker and drops marker-only bibliography spans', async () => {
    const result = await reconstruct([
      page(1, [
        sourceRun(1, 'Citation study', 0.1, 0.08, 0.72, 18, 'Heading'),
        sourceRun(1, 'Abstract', 0.1, 0.18, 0.3, 16, 'Heading'),
        sourceRun(1, '• Prior work [1] supports the claim.', 0.1, 0.28),
        sourceRun(1, 'Later work [2] confirms it.', 0.1, 0.36),
      ]),
      page(2, [
        sourceRun(2, 'References', 0.1, 0.2, 0.3, 16, 'Heading'),
        sourceRun(2, '[1] Source reference.', 0.1, 0.28),
        sourceRun(2, '[2] Second source reference.', 0.1, 0.36),
      ]),
    ])
    const claim = result.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text.includes('Prior work'),
    )
    const citation =
      claim && 'inlineRuns' in claim
        ? claim.inlineRuns?.find((run) => run.semanticRole === 'citation')
        : undefined
    expect(claim).toMatchObject({
      text: 'Prior work [1] supports the claim.',
      list: { markerText: '•' },
    })
    expect(citation).toMatchObject({
      start: 'Prior work '.length,
      end: 'Prior work [1]'.length,
      targetIds: [expect.stringMatching(/^p-/)],
    })
    expect(claim && 'text' in claim && citation).toBeTruthy()
    if (!claim || !('text' in claim) || !citation) return
    expect(claim.text.slice(citation.start, citation.end)).toBe('[1]')

    const bibliography = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references',
    )
    expect(
      bibliography && 'inlineRuns' in bibliography
        ? bibliography.inlineRuns?.filter(
            (run) => run.semanticRole === 'bibliography-entry',
          )
        : [],
    ).toEqual([])

    const xhtml = renderPublicationXhtml(result.paper, {
      reconstruction: result,
    })
    expect(xhtml).toMatch(
      /publication-list-marker[^>]*>•<\/span>Prior work <a[^>]+>\[1\]<\/a> supports the claim\./u,
    )
    expect(xhtml).not.toMatch(/data-semantic-role="bibliography-entry"/u)
  })

  it('accounts for and preserves a supported bold span after marker stripping', async () => {
    const result = await reconstruct([
      page(1, [
        sourceRun(1, '1) Styled list content', 0.1, 0.2, 0.5, 10, 'SourceBold'),
      ]),
    ])
    const node = result.paper.nodes.find(
      (candidate) => candidate.type === 'paragraph',
    )

    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 1,
      mappedInlineSpanCount: 1,
      inlineSpanCoverage: 1,
    })
    expect(node && 'inlineRuns' in node ? node.inlineRuns : undefined).toEqual([
      expect.objectContaining({
        start: 0,
        end: 'Styled list content'.length,
        bold: true,
      }),
    ])
    expect(
      renderPublicationXhtml(result.paper, { reconstruction: result }),
    ).toContain('<strong>Styled list content</strong>')
  })

  it('keeps a single aligned person name out of a multiline title', async () => {
    const result = await reconstruct([
      page(1, [
        sourceRun(1, 'Visible Source Title', 0.1, 0.07, 0.72, 22, 'Heading'),
        sourceRun(1, 'Ada Example', 0.1, 0.13, 0.72, 17, 'Heading'),
        sourceRun(1, 'Example University', 0.1, 0.2, 0.6, 10),
        sourceRun(1, 'Abstract', 0.1, 0.3, 0.3, 16, 'Heading'),
        sourceRun(1, 'Source abstract.', 0.1, 0.36),
      ]),
    ])

    expect(result.paper.title).toBe('Visible Source Title')
    expect(result.paper.authors).toEqual(['Ada Example'])
  })

  it('rejects stale PDF title metadata as the visible publication title', async () => {
    const result = await reconstruct(
      [
        page(1, [
          sourceRun(1, 'Visible Source Title', 0.1, 0.07, 0.72, 22, 'Heading'),
          sourceRun(1, 'Ada Example', 0.1, 0.16, 0.5, 11),
          sourceRun(1, 'Example University', 0.1, 0.21, 0.6, 10),
          sourceRun(1, 'Abstract', 0.1, 0.3, 0.3, 16, 'Heading'),
          sourceRun(1, 'Source abstract.', 0.1, 0.36),
        ]),
      ],
      { title: 'Stale Export Filename Title' },
    )

    expect(result.paper.title).toBe('Visible Source Title')
    expect(result.paper.title).not.toContain('Stale')
  })

  it('merges an unmarked cross-page bibliography continuation into its marked item provenance', async () => {
    const result = await reconstruct([
      page(1, [
        sourceRun(1, 'References', 0.1, 0.68, 0.3, 16, 'Heading'),
        sourceRun(1, '[1] A long reference begins on this page', 0.1, 0.76),
      ]),
      page(2, [
        sourceRun(2, 'and continues without repeating its marker.', 0.1, 0.1),
      ]),
    ])
    const references = result.paper.nodes.filter(
      (node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references',
    )

    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({
      text: 'A long reference begins on this page and continues without repeating its marker.',
      list: {
        markerText: '[1]',
        continuedFromPreviousPage: true,
      },
    })
    expect(result.provenance[references[0].id]).toMatchObject({
      pages: [1, 2],
      regionIds: [
        expect.stringMatching(/^page-001-region-/),
        expect.stringMatching(/^page-002-region-/),
      ],
    })
  })

  it('merges an unmarked cross-page list continuation without inventing a new item', async () => {
    const result = await reconstruct([
      page(1, [sourceRun(1, '• A list item begins on this page', 0.1, 0.76)]),
      page(2, [sourceRun(2, 'and continues as the same item.', 0.1, 0.1)]),
    ])
    const listNodes = result.paper.nodes.filter(
      (node) => node.type === 'paragraph' && node.list,
    )

    expect(listNodes).toHaveLength(1)
    expect(listNodes[0]).toMatchObject({
      text: 'A list item begins on this page and continues as the same item.',
      list: { markerText: '•', continuedFromPreviousPage: true },
    })
    expect(result.provenance[listNodes[0].id].pages).toEqual([1, 2])
  })

  it('does not absorb a new cross-page paragraph after a completed list item', async () => {
    const result = await reconstruct([
      page(1, [sourceRun(1, '• A complete list item.', 0.1, 0.76)]),
      page(2, [
        sourceRun(2, 'A new paragraph begins on the next page.', 0.1, 0.1),
      ]),
    ])
    const listNodes = result.paper.nodes.filter(
      (node) => node.type === 'paragraph' && node.list,
    )

    expect(listNodes).toHaveLength(1)
    expect(listNodes[0]).toMatchObject({
      text: 'A complete list item.',
      list: { markerText: '•' },
    })
    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'paragraph',
          text: 'A new paragraph begins on the next page.',
        }),
      ]),
    )
  })

  it('emits one nonempty link for every explicit label in a citation range', () => {
    const paper = {
      id: 'citation-range-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Citation range',
      subtitle: 'Test',
      authors: ['Test Author'],
      updated: '2026-07-21',
      abstract: 'Test',
      nodes: [
        {
          id: 'claim',
          type: 'paragraph' as const,
          text: 'Prior work [1–3].',
          inlineRuns: [
            {
              start: 11,
              end: 16,
              semanticRole: 'citation' as const,
              relationshipId: 'citation-range',
              targetIds: ['reference-1', 'reference-2', 'reference-3'],
            },
          ],
          source: 'test',
        },
        ...[1, 2, 3].map((ordinal) => ({
          id: `reference-${ordinal}`,
          type: 'paragraph' as const,
          text: `Reference ${ordinal}`,
          source: 'test',
        })),
      ],
    }
    const xhtml = renderPublicationXhtml(paper)
    const anchors = [
      ...xhtml.matchAll(
        /<a\b[^>]*epub:type="biblioref"[^>]*>([\s\S]*?)<\/a>/gu,
      ),
    ]

    expect(anchors).toHaveLength(2)
    expect(anchors.every((match) => match[1].trim().length > 0)).toBe(true)
    expect(xhtml.match(/Prior work/g)).toHaveLength(1)
    expect(xhtml).toContain(
      'data-target-ids="reference-1 reference-2 reference-3"',
    )
    expect(xhtml.match(/>1<\/a>–<a[^>]*>3<\/a>/gu)).toHaveLength(1)
  })
})
