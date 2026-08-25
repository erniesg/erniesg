import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import {
  buildEpub,
  buildReadableEpub,
  inspectEpub,
  renderPublicationXhtml,
} from './epub'
import type {
  PdfReconstruction,
  PdfSourceRun,
  PublicationAsset,
  PublicationVisualRelationship,
} from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { researchPaperSchema } from './schema'
import { createSourcePageCropAsset } from './visual-assets'

const paper = researchPaperSchema.parse(rawPaper)

describe('EPUB 3 export', () => {
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

  it('packages unresolved visual metadata without exposing OCR in readable content', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable prose before an unresolved source diagram.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'unresolved-diagram-fallback.pdf',
      byteLength: 1024,
    })
    const captionNode = {
      id: 'unresolved-diagram-caption',
      type: 'caption' as const,
      text: 'Figure 1. A source diagram awaiting visual review.',
      source: 'synthetic-unresolved-diagram',
    }
    const captionBox = {
      page: 1,
      x: 0.15,
      y: 0.6,
      width: 0.7,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const relationship = {
      id: 'unresolved-diagram-relationship',
      kind: 'figure' as const,
      label: 'Figure 1',
      captionRegionId: 'unresolved-diagram-caption-region',
      sourceRegionIds: [],
      sourceObjectIds: [],
      assetIds: [],
      status: 'unresolved' as const,
      confidence: 1,
      evidence: ['unresolved-visual-text-owned'],
      candidates: [],
      sourceBoxes: [captionBox],
      sourceText: 'Step 1: embed inputs. Step 2: create the output.',
      altText: captionNode.text,
      altTextSource: 'caption' as const,
      canonicalNodeId: null,
      captionNodeId: captionNode.id,
    }
    const withUnresolvedDiagram = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [...reconstruction.paper.nodes, captionNode],
      },
      provenance: {
        ...reconstruction.provenance,
        [captionNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [relationship.captionRegionId],
          boxes: [captionBox],
          links: [],
        },
      },
      visualRelationships: [relationship],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(
      withUnresolvedDiagram.paper,
      withUnresolvedDiagram,
    )
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain(
      `id="${captionNode.id}" data-canonical-id="${captionNode.id}" hidden="hidden"`,
    )
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain(captionNode.text)
    expect(content).not.toContain('Recovered text')
    expect(content).not.toContain(relationship.sourceText)
    expect(content).not.toContain('<img')
    expect(manifest.canonicalNodeIds).toContain(captionNode.id)
    expect(manifest.visualRelationships).toEqual([
      expect.objectContaining({
        id: relationship.id,
        status: 'unresolved',
        assetIds: [],
      }),
    ])
  })

  it('omits rejected prose-overlap pixels while preserving hidden canonical targets', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Canonical prose owns this source region.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'prose-overlap.pdf',
      byteLength: 1024,
    })
    const proseNode = reconstruction.paper.nodes.find(
      (node) => 'text' in node && node.text === run.text,
    )!
    const proseRegionId = reconstruction.provenance[proseNode.id].regionIds[0]
    const visualBox = {
      page: 1,
      x: 0.15,
      y: 0.35,
      width: 0.7,
      height: 0.25,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const captionBox = {
      page: 1,
      x: 0.15,
      y: 0.62,
      width: 0.7,
      height: 0.03,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const crop = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: visualBox,
      sourceObjectIds: ['false-visual-source'],
      sourceBoxes: [visualBox],
      width: 20,
      height: 10,
      pixels: new Uint8Array(20 * 10 * 4).fill(96),
    })
    const figureNode = {
      id: 'false-visual-node',
      type: 'figure' as const,
      objectType: 'figure' as const,
      title: 'False visual duplicate',
      relationships: {
        caption: 'false-visual-caption',
        assets: [crop.id],
      },
      source: 'synthetic-prose-overlap',
    }
    const captionNode = {
      id: 'false-visual-caption',
      type: 'caption' as const,
      text: 'Figure 1. False visual duplicate.',
      source: 'synthetic-prose-overlap',
    }
    const relationship = {
      id: 'false-visual-relationship',
      kind: 'figure' as const,
      label: 'Figure 1',
      captionRegionId: 'false-caption-region',
      sourceRegionIds: [proseRegionId],
      sourceObjectIds: ['false-visual-source'],
      assetIds: [crop.id],
      status: 'matched' as const,
      confidence: 1,
      evidence: ['synthetic-prose-overlap'],
      candidates: [],
      sourceBoxes: [visualBox, captionBox],
      sourceText: '',
      altText: captionNode.text,
      altTextSource: 'caption' as const,
      canonicalNodeId: figureNode.id,
      captionNodeId: captionNode.id,
    }
    const falseMatch = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [...reconstruction.paper.nodes, figureNode, captionNode],
      },
      provenance: {
        ...reconstruction.provenance,
        [figureNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [proseRegionId],
          boxes: relationship.sourceBoxes,
          links: [],
        },
        [captionNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [relationship.captionRegionId],
          boxes: [captionBox],
          links: [],
        },
      },
      assets: [crop],
      visualRelationships: [relationship],
    } satisfies PdfReconstruction

    expect(
      validatedPdfVisualRelationships({
        paper: falseMatch.paper,
        provenance: falseMatch.provenance,
        relationships: falseMatch.visualRelationships,
        assets: falseMatch.assets,
      }),
    ).toEqual([])

    const falselyReady = {
      ...falseMatch,
      readiness: {
        ...falseMatch.readiness,
        status: 'ready',
        ready: true,
        blockingDiagnosticCodes: [],
      },
    } satisfies PdfReconstruction
    await expect(buildEpub(falselyReady.paper, falselyReady)).rejects.toThrow(
      /visual relationship false-visual-relationship/u,
    )

    const fallback = await buildReadableEpub(falseMatch.paper, falseMatch)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(
      content.match(/Canonical prose owns this source region\./g),
    ).toHaveLength(1)
    expect(content).toContain('false-visual-node')
    expect(content).toContain('false-visual-caption')
    expect(content).toContain('hidden="hidden"')
    expect(content).not.toContain('False visual duplicate')
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('<img')
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.assets).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      falseMatch.paper.nodes.map((node) => node.id),
    )
    expect(manifest.excludedCanonicalNodeIds).toEqual([])
  })

  it('omits an unvalidated fragment bundle while retaining hidden canonical targets', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable fallback body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 17,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'fragmented-fallback.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.3,
      width: 0.8,
      height: 0.4,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const assetIds = Array.from({ length: 17 }, (_, index) => `asset-${index}`)
    const crowded = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [
          ...reconstruction.paper.nodes,
          {
            id: 'figure-node',
            type: 'figure' as const,
            title: 'Fragmented source visual',
            relationships: {
              caption: 'figure-caption',
              assets: assetIds,
            },
            source: 'test',
          },
          {
            id: 'figure-caption',
            type: 'caption' as const,
            text: 'Figure 1. Fragmented source visual.',
            source: 'test',
          },
        ],
      },
      assets: assetIds.map((id) => ({
        id,
        href: `assets/${id}.svg`,
        mediaType: 'image/svg+xml' as const,
        kind: 'vector' as const,
        rendition: 'source-preserved' as const,
        sha256: 'c'.repeat(64),
        bytes: new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
        width: 10,
        height: 10,
        resolutionDpi: null,
        sourceObjectIds: [id],
        sourceBoxes: [sourceBox],
      })),
      visualRelationships: [
        {
          id: 'visual-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: 'caption-region',
          sourceRegionIds: ['figure-region'],
          sourceObjectIds: assetIds,
          assetIds,
          status: 'matched' as const,
          confidence: 1,
          evidence: ['test'],
          candidates: [],
          sourceBoxes: [sourceBox],
          sourceText: '',
          altText: 'Fragmented source visual',
          altTextSource: 'caption' as const,
          canonicalNodeId: 'figure-node',
          captionNodeId: 'figure-caption',
        },
      ],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(crowded.paper, crowded)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).not.toContain('<img')
    expect(content).not.toContain('figure-placeholder')
    expect(content).not.toContain('omitted-visual')
    expect(content).toContain('figure-node')
    expect(content).toContain('figure-caption')
    expect(content).not.toContain('Figure 1. Fragmented source visual.')
    expect(content).toContain('hidden="hidden"')
    expect(manifest.assets).toEqual([])
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      crowded.paper.nodes.map((node) => node.id),
    )
    expect(manifest.excludedCanonicalNodeIds).toEqual([])
  })

  it('does not partially package an unvalidated visual asset bundle', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable fallback body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 2,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'solid-fill-fragment.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.2,
      y: 0.3,
      width: 0.6,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const raster = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: sourceBox,
      sourceObjectIds: ['image-p001-001'],
      sourceBoxes: [sourceBox],
      width: 2,
      height: 2,
      pixels: new Uint8Array(2 * 2 * 4).fill(96),
    })
    const rasterId = raster.id
    const solidId = 'asset-solid-fill'
    const withVisual = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [
          ...reconstruction.paper.nodes,
          {
            id: 'figure-node',
            type: 'figure' as const,
            title: 'Bounded source figure',
            relationships: {
              caption: 'figure-caption',
              assets: [rasterId, solidId],
            },
            source: 'test',
          },
          {
            id: 'figure-caption',
            type: 'caption' as const,
            text: 'Figure 1. Bounded source figure.',
            source: 'test',
          },
        ],
      },
      assets: [
        raster,
        {
          id: solidId,
          href: `assets/${solidId}.svg`,
          mediaType: 'image/svg+xml' as const,
          kind: 'vector' as const,
          rendition: 'source-preserved' as const,
          sha256: 'f'.repeat(64),
          bytes: new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><path d="M 0 0 L 600 0 L 600 300 L 0 300 Z" fill="#000" stroke="none" /></svg>',
          ),
          width: 600,
          height: 300,
          resolutionDpi: null,
          sourceObjectIds: ['vector-p001-001'],
          sourceBoxes: [sourceBox],
        },
      ],
      visualRelationships: [
        {
          id: 'visual-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: 'caption-region',
          sourceRegionIds: ['figure-region'],
          sourceObjectIds: ['image-p001-001', 'vector-p001-001'],
          assetIds: [rasterId, solidId],
          status: 'matched' as const,
          confidence: 1,
          evidence: ['test'],
          candidates: [],
          sourceBoxes: [sourceBox],
          sourceText: '',
          altText: 'Bounded source figure',
          altTextSource: 'caption' as const,
          canonicalNodeId: 'figure-node',
          captionNodeId: 'figure-caption',
        },
      ],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(withVisual.paper, withVisual)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).not.toContain('<img')
    expect(content).not.toContain(rasterId)
    expect(content).not.toContain(solidId)
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('Figure 1. Bounded source figure.')
    expect(content).toContain('hidden="hidden"')
    expect(manifest.assets).toEqual([])
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      withVisual.paper.nodes.map((node) => node.id),
    )
    expect(manifest.excludedCanonicalNodeIds).toEqual([])
  })

})
