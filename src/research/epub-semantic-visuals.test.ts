import { XMLParser } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { renderPublicationXhtml } from './epub'
import type {
  PdfReconstruction,
  PublicationAsset,
  PublicationVisualRelationship,
} from './import-types'
import { researchPaperSchema } from './schema'

const paper = researchPaperSchema.parse(rawPaper)

function parsedXmlElements(
  value: unknown,
  elementName: string,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = []
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, child] of Object.entries(candidate)) {
      if (key === elementName) {
        const elements = Array.isArray(child) ? child : [child]
        for (const element of elements) {
          if (element && typeof element === 'object') {
            matches.push(element as Record<string, unknown>)
          }
        }
      }
      visit(child)
    }
  }
  visit(value)
  return matches
}

describe('EPUB 3 export', () => {
  it('renders validated canonical tables inline without a clipped nested document', () => {
    const tablePaper = structuredClone(paper)
    tablePaper.nodes = [
      {
        id: 'table-node',
        type: 'figure',
        title: 'Synthetic semantic table',
        objectType: 'table',
        table: {
          rows: [
            {
              cells: [
                {
                  text: 'Profile & target',
                  headerScope: 'column',
                  columnSpan: 6,
                  rowSpan: 1,
                },
              ],
            },
            {
              cells: [
                {
                  text: 'Mobile',
                  headerScope: 'row',
                  columnSpan: 1,
                  rowSpan: 1,
                },
                {
                  text: '<12>',
                  headerScope: null,
                  columnSpan: 1,
                  rowSpan: 1,
                },
                ...['Coherent', 'Relevant', 'Humanlike', 'Misc Problems'].map(
                  (text) => ({
                    text,
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  }),
                ),
              ],
            },
          ],
        },
        relationships: { caption: 'table-caption', assets: ['table-asset'] },
        sourceText:
          'Profile & target Mobile <12> Coherent Relevant Humanlike Misc Problems',
        source: 'synthetic-table-test',
      },
      {
        id: 'table-caption',
        type: 'caption',
        text: 'Table 1. Synthetic values.',
        source: 'synthetic-table-test',
      },
    ]
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const asset = {
      id: 'table-asset',
      href: 'assets/table-asset.xhtml',
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: 'a'.repeat(64),
      bytes: new TextEncoder().encode('<html><body><table /></body></html>'),
      width: 400,
      height: 160,
      resolutionDpi: null,
      sourceObjectIds: ['table-source'],
      sourceBoxes: [sourceBox],
    } satisfies PublicationAsset
    const relationship = {
      id: 'table-relationship',
      kind: 'table',
      label: 'Table 1',
      captionRegionId: 'table-caption-region',
      sourceRegionIds: ['table-region'],
      sourceObjectIds: ['table-source'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['synthetic-table-test'],
      candidates: [],
      sourceBoxes: [sourceBox],
      sourceText: '',
      altText: 'Synthetic semantic table',
      altTextSource: 'caption',
      canonicalNodeId: 'table-node',
      captionNodeId: 'table-caption',
    } satisfies PublicationVisualRelationship
    const reconstruction = {
      readiness: { ready: true },
      visualRelationships: [relationship],
      assets: [asset],
    } as unknown as PdfReconstruction

    const content = renderPublicationXhtml(tablePaper, {
      reconstruction,
      visualAssets: new Map([[asset.id, asset]]),
    })

    expect(content).toContain('class="semantic-table-wrapper"')
    expect(content).not.toContain('data-wide-source-visual="true"')
    expect(content).toContain('data-wide-table="true" data-table-columns="6"')
    expect(content).toContain('class="semantic-table-figure"')
    expect(content).toContain('data-asset-id="table-asset"')
    expect(content).toContain(
      'class="semantic-table-wrapper" role="region" aria-labelledby="table-caption"',
    )
    expect(content).not.toContain('aria-label="Scrollable table"')
    expect(content).toContain('<table aria-describedby="table-caption"><thead>')
    expect(content).toContain(
      '<th id="table-node-cell-r1-c1" scope="col" colspan="6">',
    )
    expect(content).toContain(
      '<th id="table-node-cell-r2-c1" scope="row">Mobile</th>',
    )
    expect(content).toContain('Profile &amp; target')
    expect(content).toContain('&lt;12&gt;')
    expect(content).toContain('<tbody>')
    expect(content).not.toContain('<object')

    const document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
    }).parse(content)
    const sourceTranscripts = parsedXmlElements(document, 'span').filter(
      (element) =>
        typeof element.class === 'string' &&
        element.class.split(/\s+/u).includes('visual-source-transcript'),
    )
    expect(sourceTranscripts).toEqual([
      expect.objectContaining({
        'aria-hidden': 'true',
        'data-source-transcript-for': 'table-node',
      }),
    ])
    expect(parsedXmlElements(document, 'table')).toHaveLength(1)
  })

  it('wraps wide source figures and raster tables in an accessible scroller while excluding equations and algorithms', () => {
    const figurePaper = {
      ...structuredClone(paper),
      nodes: [
        {
          id: 'wide-source-figure',
          type: 'figure' as const,
          objectType: 'figure' as const,
          title: 'Figure 1. A wide source diagram.',
          relationships: {
            caption: 'wide-source-caption',
            assets: ['wide-source-asset'],
          },
          source: 'synthetic-wide-source-figure',
        },
        {
          id: 'wide-source-caption',
          type: 'caption' as const,
          text: 'Figure 1. A wide source diagram.',
          source: 'synthetic-wide-source-figure',
        },
      ],
    }
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.25,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const asset = {
      id: 'wide-source-asset',
      href: 'assets/wide-source-asset.png',
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'source-page-crop',
      sha256: 'b'.repeat(64),
      bytes: new Uint8Array([1]),
      width: 1_200,
      height: 400,
      resolutionDpi: 220,
      sourceObjectIds: ['wide-source-object'],
      sourceBoxes: [sourceBox],
    } satisfies PublicationAsset
    const relationship = {
      id: 'wide-source-relationship',
      kind: 'figure',
      label: 'Figure 1',
      captionRegionId: 'wide-source-caption-region',
      sourceRegionIds: ['wide-source-region'],
      sourceObjectIds: ['wide-source-object'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['source-page-crop'],
      candidates: [],
      sourceBoxes: [sourceBox],
      sourceText: '',
      altText: 'Figure 1. A wide source diagram.',
      altTextSource: 'caption',
      canonicalNodeId: 'wide-source-figure',
      captionNodeId: 'wide-source-caption',
    } satisfies PublicationVisualRelationship
    const renderWithRelationship = (
      candidate: PublicationVisualRelationship,
      candidateAsset: PublicationAsset = asset,
    ) =>
      renderPublicationXhtml(figurePaper, {
        reconstruction: {
          readiness: { ready: true },
          visualRelationships: [candidate],
          assets: [candidateAsset],
        } as unknown as PdfReconstruction,
        visualAssets: new Map([[candidateAsset.id, candidateAsset]]),
      })

    const content = renderWithRelationship(relationship)
    const wrapperStart = content.indexOf(
      '<div class="wide-source-visual-frame" data-wide-source-visual="true" data-source-visual-kind="figure"',
    )
    const wrapperEnd = content.indexOf('</div>', wrapperStart)
    const captionStart = content.indexOf('<figcaption', wrapperStart)

    expect(wrapperStart).toBeGreaterThan(-1)
    expect(content).toContain('data-source-visual-kind="figure"><img')
    expect(wrapperEnd).toBeLessThan(captionStart)
    expect(
      renderWithRelationship({
        ...relationship,
        kind: 'table',
      }),
    ).toContain(
      'data-wide-source-visual="true" data-source-visual-kind="table"><img',
    )
    expect(
      renderWithRelationship(
        {
          ...relationship,
          kind: 'table',
        },
        {
          ...asset,
          kind: 'table',
          width: 1_378,
          height: 1_241,
        },
      ),
    ).toContain(
      'data-wide-source-visual="true" data-source-visual-kind="table"><img',
    )
    expect(
      renderWithRelationship(
        {
          ...relationship,
          kind: 'table',
        },
        {
          ...asset,
          kind: 'table',
          width: 672,
          height: 400,
        },
      ),
    ).not.toContain('data-wide-source-visual="true"')
    expect(
      renderWithRelationship({
        ...relationship,
        kind: 'equation',
      }),
    ).not.toContain('data-wide-source-visual="true"')
    expect(
      renderWithRelationship({
        ...relationship,
        semanticKind: 'algorithm',
      }),
    ).not.toContain('data-wide-source-visual="true"')
  })

  it('keeps unresolved diagram OCR out of reader-facing content', () => {
    const paper = {
      id: 'unresolved-diagram-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Unresolved diagram transcript',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A bounded unresolved diagram.',
      nodes: [
        {
          id: 'caption-figure-1',
          type: 'caption' as const,
          text: 'Figure 1. A bounded unresolved diagram.',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const content = renderPublicationXhtml(paper, {
      reconstruction: {
        visualRelationships: [
          {
            id: 'visual-relationship-1',
            kind: 'figure',
            label: 'Figure 1',
            captionRegionId: 'page-001-caption',
            sourceRegionIds: [],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: ['unresolved-visual-text-owned'],
            candidates: [],
            sourceBoxes: [],
            sourceText: 'Step 1: embed inputs. Step 2: create the output.',
            altText: 'Figure 1. A bounded unresolved diagram.',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'caption-figure-1',
          },
        ],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="caption-figure-1" data-canonical-id="caption-figure-1" hidden="hidden"',
    )
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('Recovered text')
    expect(content).not.toContain(
      'Step 1: embed inputs. Step 2: create the output.',
    )
  })

  it('keeps unresolved bounded-table OCR out of reader-facing content', () => {
    const paper = {
      id: 'unresolved-table-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Unresolved bounded table transcript',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A bounded table whose row semantics remain unresolved.',
      nodes: [
        {
          id: 'caption-table-1',
          type: 'caption' as const,
          text: 'Table 1. A bounded comparison.',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const sourceText = 'Model Accuracy Baseline 72.1 Proposed 81.4'
    const content = renderPublicationXhtml(paper, {
      reconstruction: {
        visualRelationships: [
          {
            id: 'visual-relationship-table-1',
            kind: 'table',
            label: 'Table 1',
            captionRegionId: 'page-001-caption',
            sourceRegionIds: ['page-001-table-body'],
            sourceLineIds: [
              'page-001-table-header',
              'page-001-table-row-1',
              'page-001-table-row-2',
            ],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: ['unresolved-bounded-table-text-owned'],
            candidates: [],
            sourceBoxes: [],
            sourceText,
            altText: 'Table 1. A bounded comparison.',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'caption-table-1',
          },
        ],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="caption-table-1" data-canonical-id="caption-table-1" hidden="hidden"',
    )
    expect(content).not.toContain('omitted-table-transcript')
    expect(content).not.toContain('Recovered table source text')
    expect(content).not.toContain(sourceText)
    expect(content).not.toContain('<table')
  })

  it('renders a source-proved unresolved partial-parent table caption as an orphan link target', () => {
    const referenceText = 'Results appear in Table 1.'
    const referenceStart = referenceText.indexOf('Table 1')
    const captionNodeId = 'caption-partial-parent-table-1'
    const relationshipId = 'partial-parent-table-reference'
    const paper = {
      id: 'unresolved-partial-parent-table-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Unresolved partial-parent table',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-30',
      abstract: 'A partial-parent table whose source crop remains unresolved.',
      nodes: [
        {
          id: 'partial-parent-table-reference-owner',
          type: 'paragraph' as const,
          text: referenceText,
          inlineRuns: [
            {
              start: referenceStart,
              end: referenceStart + 'Table 1'.length,
              relationshipId,
              semanticRole: 'cross-reference' as const,
              targetIds: [captionNodeId],
            },
          ],
          source: 'pdf:test#page=1',
        },
        {
          id: captionNodeId,
          type: 'caption' as const,
          text: 'Table 1. Partial-parent results awaiting source rendition.',
          source: 'pdf:test#page=2',
        },
      ],
    }
    const sourceText = 'Model Accuracy Baseline 72.1 Proposed 81.4'
    const content = renderPublicationXhtml(paper, {
      reconstruction: {
        visualRelationships: [
          {
            id: 'visual-relationship-partial-parent-table-1',
            kind: 'table',
            label: 'Table 1',
            captionRegionId: 'page-002-caption',
            sourceRegionIds: ['page-002-mixed-parent'],
            sourceLineIds: [
              'page-002-table-header',
              'page-002-table-row-1',
              'page-002-table-row-2',
            ],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: [
              'partial-parent-line-selection',
              'unresolved-bounded-table-text-owned',
            ],
            candidates: [],
            sourceBoxes: [],
            sourceText,
            altText:
              'Table 1. Partial-parent results awaiting source rendition.',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId,
          },
        ],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      `<a id="${relationshipId}" href="#${captionNodeId}" data-semantic-role="cross-reference" data-relationship-id="${relationshipId}" data-target-ids="${captionNodeId}">Table 1</a>`,
    )
    expect(content).toContain(
      `<aside id="${captionNodeId}" data-canonical-id="${captionNodeId}" class="orphan-caption">Table 1. Partial-parent results awaiting source rendition.</aside>`,
    )
    expect(content).not.toContain(
      `id="${captionNodeId}" data-canonical-id="${captionNodeId}" hidden="hidden"`,
    )
    expect(content).not.toContain(sourceText)
    expect(content).not.toContain('<figure')
    expect(content).not.toContain('<table')
  })

  it('serializes an exact algorithm crop as an algorithm object without duplicating its printed title visibly', () => {
    const algorithmPaper = {
      id: 'matched-algorithm-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Matched algorithm crop',
      subtitle: 'Source-backed algorithm',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A bounded algorithm panel.',
      nodes: [
        {
          id: 'algorithm-1',
          type: 'figure' as const,
          objectType: 'figure' as const,
          title: 'Algorithm 1 Deterministic Search',
          relationships: {
            caption: 'caption-algorithm-1',
            assets: ['asset-algorithm-1'],
          },
          source: 'pdf:test#page=1',
        },
        {
          id: 'caption-algorithm-1',
          type: 'caption' as const,
          text: 'Algorithm 1 Deterministic Search',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const relationship = {
      id: 'visual-relationship-algorithm-1',
      kind: 'figure',
      semanticKind: 'algorithm',
      label: 'Algorithm 1',
      captionRegionId: 'page-001-algorithm-caption',
      sourceRegionIds: ['page-001-algorithm-body'],
      sourceLineIds: ['page-001-algorithm-line-1'],
      sourceObjectIds: ['algorithm-source-p001-001'],
      assetIds: ['asset-algorithm-1'],
      status: 'matched',
      confidence: 1,
      evidence: [
        'source-algorithm-block',
        'source-page-crop',
        'source-text-transcript-unresolved',
      ],
      candidates: [],
      sourceBoxes: [],
      sourceText: '',
      altText: 'Algorithm 1 Deterministic Search',
      altTextSource: 'caption',
      canonicalNodeId: 'algorithm-1',
      captionNodeId: 'caption-algorithm-1',
    } satisfies PublicationVisualRelationship
    const asset = {
      id: 'asset-algorithm-1',
      href: 'assets/asset-algorithm-1.png',
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'source-page-crop',
      sha256: 'a'.repeat(64),
      bytes: new Uint8Array([1]),
      width: 320,
      height: 220,
      resolutionDpi: 220,
      sourceObjectIds: ['algorithm-source-p001-001'],
      sourceBoxes: [],
    } satisfies PublicationAsset

    const content = renderPublicationXhtml(algorithmPaper, {
      reconstruction: {
        visualRelationships: [relationship],
        assets: [asset],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain('data-object-type="algorithm"')
    expect(content).toContain('class="algorithm-figure"')
    expect(content).toContain(
      '<figcaption id="caption-algorithm-1" data-canonical-id="caption-algorithm-1" class="algorithm-source-caption visually-hidden">Algorithm 1 Deterministic Search</figcaption>',
    )
    expect(content).not.toContain('class="visual-source-transcript"')
  })

  it('does not serialize failed algorithm OCR as reader-facing content', () => {
    const algorithmPaper = {
      id: 'unresolved-algorithm-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Unresolved algorithm crop',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A bounded unresolved algorithm.',
      nodes: [
        {
          id: 'caption-algorithm-2',
          type: 'caption' as const,
          text: 'Algorithm 2 Deterministic Search',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const content = renderPublicationXhtml(algorithmPaper, {
      reconstruction: {
        visualRelationships: [
          {
            id: 'visual-relationship-algorithm-2',
            kind: 'figure',
            semanticKind: 'algorithm',
            label: 'Algorithm 2',
            captionRegionId: 'page-001-algorithm-caption',
            sourceRegionIds: ['page-001-algorithm-body'],
            sourceLineIds: [
              'page-001-algorithm-line-1',
              'page-001-algorithm-line-2',
            ],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: [
              'source-algorithm-block',
              'source-text-transcript-unresolved',
              'unresolved-visual-text-owned',
              'source-rendition-unavailable',
            ],
            candidates: [],
            sourceBoxes: [],
            sourceText: '1: Initialize queue.\n2: return result.',
            altText: 'Algorithm 2 Deterministic Search',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'caption-algorithm-2',
          },
        ],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="caption-algorithm-2" data-canonical-id="caption-algorithm-2" hidden="hidden"',
    )
    expect(content).not.toContain('data-object-type="algorithm"')
    expect(content).not.toContain('Recovered source text')
    expect(content).not.toContain('1: Initialize queue.')
  })

  it('serializes proved source code lines directly as whitespace-preserving pre and code elements', () => {
    const codePaper = {
      id: 'matched-code-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Matched source code',
      subtitle: 'Source-backed code',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A bounded code block.',
      nodes: [
        {
          id: 'code-block-1',
          type: 'figure' as const,
          objectType: 'figure' as const,
          title: 'Here is the specific prompt used:',
          relationships: {
            caption: 'caption-code-block-1',
            assets: ['asset-code-page-1', 'asset-code-page-2'],
          },
          source: 'pdf:test#page=1',
        },
        {
          id: 'caption-code-block-1',
          type: 'caption' as const,
          text: 'Here is the specific prompt used:',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const sourceBox = {
      page: 1,
      x: 0.18,
      y: 0.6,
      width: 0.62,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const relationship = {
      id: 'visual-relationship-code-1',
      kind: 'figure',
      semanticKind: 'code',
      label: 'Code block p001-001',
      captionRegionId: 'page-001-code-caption',
      sourceRegionIds: ['page-001-code-body', 'page-002-code-continuation'],
      sourceLineIds: [
        'page-001-code-line-1',
        'page-001-code-line-2',
        'page-002-code-line-1',
      ],
      sourceObjectIds: ['code-source-p001-001', 'code-source-p002-001'],
      assetIds: ['asset-code-page-1', 'asset-code-page-2'],
      status: 'matched',
      confidence: 1,
      evidence: [
        'source-preformatted-block',
        'deterministic-source-line-order',
        'exact-single-run-line-text',
        'source-page-crop',
      ],
      preformatted: {
        status: 'proved',
        evidence: [
          'deterministic-source-line-order',
          'exact-single-run-line-text',
        ],
        lines: [
          {
            text: 'GET /Patient?name=a&format=json',
            sourceRegionId: 'page-001-code-body',
            sourceLineId: 'page-001-code-line-1',
            sourceBox,
            sourceRunBoxes: [sourceBox],
          },
          {
            text: 'POST /Patient',
            sourceRegionId: 'page-001-code-body',
            sourceLineId: 'page-001-code-line-2',
            sourceBox: { ...sourceBox, y: 0.62 },
            sourceRunBoxes: [{ ...sourceBox, y: 0.62 }],
          },
          {
            text: '{functions}',
            sourceRegionId: 'page-002-code-continuation',
            sourceLineId: 'page-002-code-line-1',
            sourceBox: { ...sourceBox, page: 2, y: 0.09 },
            sourceRunBoxes: [{ ...sourceBox, page: 2, y: 0.09 }],
          },
        ],
      },
      candidates: [],
      sourceBoxes: [],
      sourceText: 'GET /Patient?name=a&format=json\nPOST /Patient\n{functions}',
      altText: 'Here is the specific prompt used:',
      altTextSource: 'caption',
      canonicalNodeId: 'code-block-1',
      captionNodeId: 'caption-code-block-1',
    } as unknown as PublicationVisualRelationship
    const assets = [
      {
        id: 'asset-code-page-1',
        href: 'assets/asset-code-page-1.png',
        mediaType: 'image/png',
        kind: 'raster',
        rendition: 'source-page-crop',
        sha256: 'a'.repeat(64),
        bytes: new Uint8Array([1]),
        width: 320,
        height: 220,
        resolutionDpi: 220,
        sourceObjectIds: ['code-source-p001-001'],
        sourceBoxes: [sourceBox],
      },
      {
        id: 'asset-code-page-2',
        href: 'assets/asset-code-page-2.png',
        mediaType: 'image/png',
        kind: 'raster',
        rendition: 'source-page-crop',
        sha256: 'b'.repeat(64),
        bytes: new Uint8Array([2]),
        width: 320,
        height: 80,
        resolutionDpi: 220,
        sourceObjectIds: ['code-source-p002-001'],
        sourceBoxes: [{ ...sourceBox, page: 2, y: 0.09 }],
      },
    ] satisfies PublicationAsset[]

    const content = renderPublicationXhtml(codePaper, {
      reconstruction: {
        visualRelationships: [relationship],
        assets,
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain('data-object-type="code"')
    expect(content).toContain('class="source-code-figure"')
    expect(content).toContain(
      '<pre class="source-code" data-whitespace-source="source-lines" data-transcript-status="proved"><code><span class="source-code-line source-code-indent-0" data-source-region-id="page-001-code-body" data-source-line-id="page-001-code-line-1" data-indent-columns="0">GET /Patient?name=a&amp;format=json</span>\n<span class="source-code-line source-code-indent-0" data-source-region-id="page-001-code-body" data-source-line-id="page-001-code-line-2" data-indent-columns="0">POST /Patient</span>\n<span class="source-code-line source-code-indent-0" data-source-region-id="page-002-code-continuation" data-source-line-id="page-002-code-line-1" data-indent-columns="0">{functions}</span></code></pre>',
    )
    expect(content).not.toContain('<img ')
    expect(content).not.toContain('class="visual-source-transcript"')

    const unresolvedContent = renderPublicationXhtml(codePaper, {
      reconstruction: {
        visualRelationships: [
          {
            ...relationship,
            preformatted: {
              ...relationship.preformatted!,
              status: 'unresolved',
            },
          },
        ],
        assets,
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })
    expect(unresolvedContent).not.toContain(
      'data-transcript-status="unresolved"',
    )
    expect(unresolvedContent).not.toContain('source-code-image-comparison')
    expect(unresolvedContent).toContain('<img ')
  })

  it('does not serialize failed code OCR without a source crop', () => {
    const codePaper = {
      id: 'unresolved-code-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Unresolved source code',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A bounded unresolved code block.',
      nodes: [
        {
          id: 'caption-code-block-2',
          type: 'caption' as const,
          text: 'Here is the specific prompt used:',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const content = renderPublicationXhtml(codePaper, {
      reconstruction: {
        visualRelationships: [
          {
            id: 'visual-relationship-code-2',
            kind: 'figure',
            semanticKind: 'code',
            label: 'Code block p001-001',
            captionRegionId: 'page-001-code-caption',
            sourceRegionIds: ['page-001-code-body'],
            sourceLineIds: ['page-001-code-line-1'],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: [
              'source-preformatted-block',
              'source-rendition-unavailable',
              'unresolved-visual-text-owned',
            ],
            preformatted: {
              status: 'proved',
              evidence: [
                'deterministic-source-line-order',
                'exact-single-run-line-text',
              ],
              lines: [],
            },
            candidates: [],
            sourceBoxes: [],
            sourceText: 'GET /Patient?name=value\nPOST /Patient',
            altText: 'Here is the specific prompt used:',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'caption-code-block-2',
          } as unknown as PublicationVisualRelationship,
        ],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="caption-code-block-2" data-canonical-id="caption-code-block-2" hidden="hidden"',
    )
    expect(content).not.toContain('data-object-type="code"')
    expect(content).not.toContain('Recovered source lines')
    expect(content).not.toContain('GET /Patient?name=value')
  })

  it('keeps a caption-only unresolved table out of readable output', () => {
    const paper = {
      id: 'unresolved-table-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Unresolved table',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A table continuation remains unresolved.',
      nodes: [
        {
          id: 'caption-table-1',
          type: 'caption' as const,
          text: 'Table 1. A multi-page source table awaiting review.',
          source: 'pdf:test#page=2',
        },
      ],
    }
    const content = renderPublicationXhtml(paper, {
      reconstruction: {
        visualRelationships: [
          {
            id: 'visual-relationship-table-1',
            kind: 'table',
            label: 'Table 1',
            captionRegionId: 'page-002-caption',
            sourceRegionIds: [],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: ['table-source-start-boundary-unproven'],
            candidates: [],
            sourceBoxes: [],
            sourceText: '',
            altText: 'Table 1. A multi-page source table awaiting review.',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'caption-table-1',
          },
        ],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="caption-table-1" data-canonical-id="caption-table-1" hidden="hidden"',
    )
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain(
      'Table 1. A multi-page source table awaiting review.',
    )
  })

  it('keeps a canonical orphan caption out of readable output', () => {
    const paper = {
      id: 'orphan-caption-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Orphan caption',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A canonical caption has no bounded visual relationship.',
      nodes: [
        {
          id: 'caption-figure-1',
          type: 'caption' as const,
          text: 'Figure 1. A source visual whose bounded rendition is unavailable.',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const content = renderPublicationXhtml(paper, {
      reconstruction: {
        visualRelationships: [],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="caption-figure-1" data-canonical-id="caption-figure-1" hidden="hidden"',
    )
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain(
      'Figure 1. A source visual whose bounded rendition is unavailable.',
    )
  })
})
