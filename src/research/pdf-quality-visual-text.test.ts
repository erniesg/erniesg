import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSourceRun,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import { assessPdfCompleteness } from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import {
  normalizedLength,
  run,
  sourceBackedEquationFixture,
} from './pdf-quality.test-helpers'

describe('PDF semantic signal detection', () => {
  it('conserves validated visual text locally without treating other non-reading regions as prose', () => {
    const fixture = sourceBackedEquationFixture()
    const titleRun = run('Paper', 0.1, 0.1, 12, 0.2)
    const authorRun = run('Test', 0.1, 0.13, 10, 0.12)
    const titleRegion = {
      id: 'title-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: titleRun.text,
      confidence: 1,
      box: { ...titleRun },
      lines: [
        {
          id: 'title-line',
          text: titleRun.text,
          fontSize: titleRun.fontSize,
          box: { ...titleRun },
          runs: [{ ...titleRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const authorRegion = {
      id: 'author-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: authorRun.text,
      confidence: 1,
      box: { ...authorRun },
      lines: [
        {
          id: 'author-line',
          text: authorRun.text,
          fontSize: authorRun.fontSize,
          box: { ...authorRun },
          runs: [{ ...authorRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const captionRegion = fixture.regions.find(
      (region) => region.id === 'caption-region',
    )!
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const nonReadingEquationRegion = {
      ...equationRegion,
      includedInReadingOrder: false,
    } satisfies PdfPageRegion
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [titleRegion.id, authorRegion.id, captionRegion.id],
      order: [titleRegion.id, authorRegion.id, captionRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 3,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters:
        fixture.page.textCharacters +
        titleRun.text.length +
        authorRun.text.length,
      runs: [titleRun, authorRun, ...fixture.page.runs],
    } satisfies PdfPageAnalysis
    const titleEvidence = {
      confidence: 1,
      pages: [1],
      regionIds: [titleRegion.id],
      boxes: [{ ...titleRegion.box }],
      links: [],
    } satisfies NodeSourceEvidence
    const regions = [
      titleRegion,
      authorRegion,
      captionRegion,
      nonReadingEquationRegion,
    ]
    const paperFor = (
      objectType: 'figure' | 'table' | 'equation',
    ): ResearchPaper => ({
      ...fixture.paper,
      nodes: [
        {
          id: 'title-node',
          type: 'paragraph',
          text: fixture.paper.title,
          source: 'test',
        },
        ...fixture.paper.nodes.map((node) =>
          node.type === 'figure'
            ? {
                ...node,
                objectType,
                ...(objectType === 'table'
                  ? {
                      table: {
                        rows: [
                          {
                            cells: [
                              {
                                text: 'q',
                                headerScope: 'column' as const,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                              {
                                text: '=',
                                headerScope: 'column' as const,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                            ],
                          },
                          {
                            cells: [
                              {
                                text: 'r',
                                headerScope: null,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                              {
                                text: '.',
                                headerScope: null,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                            ],
                          },
                        ],
                      },
                    }
                  : {}),
              }
            : node,
        ),
      ],
    })
    const provenance = {
      ...fixture.provenance,
      'title-node': titleEvidence,
    } satisfies Record<string, NodeSourceEvidence>
    const semanticTableBytes = new TextEncoder().encode(
      '<table><tr><th>q</th><th>=</th></tr><tr><td>r</td><td>.</td></tr></table>',
    )
    const semanticTableSha256 = createHash('sha256')
      .update(semanticTableBytes)
      .digest('hex')
    const semanticTableAsset = {
      ...fixture.asset,
      id: `asset-${semanticTableSha256.slice(0, 24)}`,
      href: `assets/asset-${semanticTableSha256.slice(0, 24)}.xhtml`,
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: semanticTableSha256,
      bytes: semanticTableBytes,
    } satisfies PdfVisualAsset

    // This fixture has one equation source run, so treating it as a fabricated
    // 2×2 semantic table must no longer count as source conservation. Genuine
    // source-run-backed tables are covered by semantic-table-source.test.ts.
    for (const objectType of ['figure', 'equation'] as const) {
      const selectedAsset = fixture.asset
      const selectedPaper = paperFor(objectType)
      const visualNode = selectedPaper.nodes.find(
        (node) => node.type === 'figure',
      )
      if (visualNode?.type !== 'figure') throw new Error('missing visual node')
      visualNode.relationships.assets = [selectedAsset.id]
      const result = assessPdfCompleteness({
        pages: [page],
        paper: selectedPaper,
        diagnostics: [],
        regions,
        readingOrder,
        provenance,
        visualRelationships: [
          {
            ...fixture.relationship,
            kind: objectType,
            assetIds: [selectedAsset.id],
          },
        ],
        assets: [selectedAsset],
      })

      expect(result.completeness, objectType).toMatchObject({
        sourceTextCharacters:
          normalizedLength(titleRegion.text) +
          normalizedLength(authorRegion.text) +
          normalizedLength(captionRegion.text) +
          normalizedLength(nonReadingEquationRegion.text),
        outputTextCharacters:
          normalizedLength(titleRegion.text) +
          normalizedLength(authorRegion.text) +
          normalizedLength(captionRegion.text) +
          normalizedLength(nonReadingEquationRegion.text),
        matchedTextCharacters:
          normalizedLength(titleRegion.text) +
          normalizedLength(authorRegion.text) +
          normalizedLength(captionRegion.text) +
          normalizedLength(nonReadingEquationRegion.text),
        textCoverage: 1,
        missingSourceRegionCount: 0,
        unprovenancedRenderedUnitCount: 0,
      })
    }

    const invalidRelationship = {
      ...fixture.relationship,
      sourceRegionIds: ['absent-visual-region'],
    } satisfies PdfVisualRelationship
    const invalid = assessPdfCompleteness({
      pages: [page],
      paper: paperFor('equation'),
      diagnostics: [],
      regions,
      readingOrder,
      provenance: {
        ...provenance,
        'equation-1': {
          ...fixture.provenance['equation-1'],
          regionIds: ['absent-visual-region'],
        },
      },
      visualRelationships: [invalidRelationship],
      assets: [fixture.asset],
    })
    expect(invalid.completeness.unprovenancedRenderedUnitCount).toBe(1)
    expect(invalid.completeness.textCoverage).toBeLessThan(1)

    const paragraphPaper = {
      ...fixture.paper,
      nodes: [
        {
          id: 'title-node',
          type: 'paragraph',
          text: fixture.paper.title,
          source: 'test',
        },
        {
          id: 'non-reading-paragraph',
          type: 'paragraph',
          text: equationRegion.text,
          source: 'test',
        },
        fixture.paper.nodes.find((node) => node.type === 'caption')!,
      ],
    } satisfies ResearchPaper
    const paragraph = assessPdfCompleteness({
      pages: [page],
      paper: paragraphPaper,
      diagnostics: [],
      regions,
      readingOrder,
      provenance: {
        'title-node': titleEvidence,
        'non-reading-paragraph': fixture.provenance['equation-1'],
        'caption-1': fixture.provenance['caption-1'],
      },
    })
    expect(paragraph.completeness.unprovenancedRenderedUnitCount).toBe(0)
    expect(paragraph.completeness.outputTextCharacters).toBeGreaterThan(
      paragraph.completeness.sourceTextCharacters,
    )
    expect(paragraph.completeness.textCoverage).toBeLessThan(1)
  })

  it('conserves reordered text only for an exclusive strict positional visual', () => {
    const captionRun = run('Figure 1. Positional labels.', 0.2, 0.5, 10, 0.45)
    const alphaRun = run('alpha', 0.2, 0.25, 10, 0.08)
    const betaRun = run('beta', 0.55, 0.25, 10, 0.07)
    const region = (
      id: string,
      kind: PdfPageRegion['kind'],
      sourceRun: PdfSourceRun,
    ) =>
      ({
        id,
        page: 1,
        kind,
        column: 'single',
        text: sourceRun.text,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: `${id}-line`,
            text: sourceRun.text,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [{ ...sourceRun }],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }) satisfies PdfPageRegion
    const alphaRegion = region('alpha-region', 'body', alphaRun)
    const betaRegion = {
      ...region('beta-region', 'body', betaRun),
      includedInReadingOrder: false,
    } satisfies PdfPageRegion
    const captionRegion = region('caption-region', 'caption', captionRun)
    const objectBox = {
      page: 1,
      x: 0.18,
      y: 0.2,
      width: 0.5,
      height: 0.22,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const bytes = new TextEncoder().encode('POSITIONAL-SOURCE')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const asset = {
      id: `asset-${sha256.slice(0, 24)}`,
      href: `assets/asset-${sha256.slice(0, 24)}.png`,
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'source-preserved',
      sha256,
      bytes,
      width: 200,
      height: 100,
      resolutionDpi: null,
      sourceObjectIds: ['image-object'],
      sourceBoxes: [{ ...objectBox }],
    } satisfies PdfVisualAsset
    const relationship = {
      id: 'relationship-1',
      kind: 'figure',
      label: 'Figure 1',
      captionRegionId: captionRegion.id,
      sourceRegionIds: [alphaRegion.id, betaRegion.id],
      sourceObjectIds: ['image-object'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['source-preserved'],
      candidates: [],
      sourceBoxes: [{ ...captionRegion.box }, { ...objectBox }],
      sourceText: 'beta alpha',
      altText: captionRegion.text,
      altTextSource: 'caption',
      canonicalNodeId: 'figure-1',
      captionNodeId: 'caption-1',
    } satisfies PdfVisualRelationship
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: '',
      subtitle: 'Test',
      authors: [],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: { caption: 'caption-1', assets: [asset.id] },
          source: 'test',
        },
        {
          id: 'caption-1',
          type: 'caption',
          text: captionRegion.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const page = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters:
        alphaRun.text.length + betaRun.text.length + captionRun.text.length,
      imageCount: 1,
      objects: [
        {
          id: 'image-object',
          page: 1,
          kind: 'image',
          box: { ...objectBox },
          confidence: 1,
          assetId: asset.id,
        },
      ],
      runs: [alphaRun, betaRun, captionRun],
    } satisfies PdfPageAnalysis
    const readingOrder = {
      schemaVersion: '1.0.0',
      regionIds: [alphaRegion.id, captionRegion.id],
      order: [alphaRegion.id, captionRegion.id],
      edges: [],
      resolutions: [],
      acyclic: true,
      evaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 2,
        acceptedEdgeCount: 0,
        unresolvedEdgeCount: 0,
        cycleRate: 0,
        orderAccuracy: null,
        provider: null,
        modelVersion: null,
        latencyMs: 0,
        costUsd: 0,
        reviewRequired: false,
      },
    } satisfies PdfReadingOrderGraph
    const provenance = {
      'figure-1': {
        confidence: 1,
        pages: [1],
        regionIds: [...relationship.sourceRegionIds],
        boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [captionRegion.id],
        boxes: [{ ...captionRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const assess = (sourceText: string) =>
      assessPdfCompleteness({
        pages: [page],
        paper,
        diagnostics: [],
        regions: [alphaRegion, betaRegion, captionRegion],
        readingOrder,
        provenance,
        visualRelationships: [{ ...relationship, sourceText }],
        assets: [asset],
      })

    const reordered = assess('beta alpha')
    expect(reordered.completeness).toMatchObject({
      matchedTextCharacters: reordered.completeness.sourceTextCharacters,
      outputTextCharacters: reordered.completeness.sourceTextCharacters,
      textCoverage: 1,
    })
    for (const lossy of [
      assess('beta alph'),
      assess('beta alphaa'),
      assess('beta alphx'),
    ]) {
      expect(lossy.completeness.textCoverage).toBeLessThan(1)
    }

    const semanticBytes = new TextEncoder().encode(
      '<table><tr><th>beta</th><th>.</th></tr><tr><td>alpha</td><td>.</td></tr></table>',
    )
    const semanticSha256 = createHash('sha256')
      .update(semanticBytes)
      .digest('hex')
    const semanticAsset = {
      ...asset,
      id: `asset-${semanticSha256.slice(0, 24)}`,
      href: `assets/asset-${semanticSha256.slice(0, 24)}.xhtml`,
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: semanticSha256,
      bytes: semanticBytes,
    } satisfies PdfVisualAsset
    const semanticRelationship = {
      ...relationship,
      kind: 'table',
      label: 'Table 1',
      assetIds: [semanticAsset.id],
    } satisfies PdfVisualRelationship
    const semanticPaper = {
      ...paper,
      nodes: paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'table' as const,
              table: {
                rows: [
                  {
                    cells: [
                      {
                        text: 'beta',
                        headerScope: 'column',
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                      {
                        text: '.',
                        headerScope: 'column',
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                    ],
                  },
                  {
                    cells: [
                      {
                        text: 'alpha',
                        headerScope: null,
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                      {
                        text: '.',
                        headerScope: null,
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                    ],
                  },
                ],
              },
              relationships: {
                ...node.relationships,
                assets: [semanticAsset.id],
              },
            }
          : node,
      ),
    } satisfies ResearchPaper
    expect(
      validatedPdfVisualRelationships({
        paper: semanticPaper,
        provenance,
        relationships: [semanticRelationship],
        assets: [semanticAsset],
        regions: [alphaRegion, betaRegion, captionRegion],
      }),
    ).toEqual([])
    const semanticResult = assessPdfCompleteness({
      pages: [page],
      paper: semanticPaper,
      diagnostics: [],
      regions: [alphaRegion, betaRegion, captionRegion],
      readingOrder,
      provenance,
      visualRelationships: [semanticRelationship],
      assets: [semanticAsset],
    })
    expect(semanticResult.completeness.textCoverage).toBeLessThan(1)
  })
})
