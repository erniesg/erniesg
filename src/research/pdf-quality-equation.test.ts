import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSourceRun,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import {
  createSourceGeometryScriptTranscript,
  SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
} from './equation-geometry-transcript'
import { assessPdfCompleteness } from './pdf-quality'
import { createSourcePageCropAsset } from './visual-assets'
import {
  assessSourceBackedEquation,
  normalizedLength,
  run,
  sourceBackedEquationFixture,
} from './pdf-quality.test-helpers'

describe('PDF semantic signal detection', () => {
  it('accounts a strict source-text equation only through its self-caption', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const relationship = {
      ...fixture.relationship,
      captionRegionId: equationRegion.id,
      sourceRegionIds: [equationRegion.id],
      sourceBoxes: [
        { ...equationRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      altText: equationRegion.text,
      altTextSource: 'source-text',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      title: '',
      authors: [],
      nodes: [
        fixture.paper.nodes.find((node) => node.type === 'figure')!,
        {
          id: 'caption-1',
          type: 'caption',
          text: equationRegion.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      'equation-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: [{ ...equationRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [equationRegion.id],
      order: [equationRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 1,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters: equationRegion.text.length,
      runs: equationRegion.lines.flatMap((line) => line.runs),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [equationRegion],
      readingOrder,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: normalizedLength(equationRegion.text),
      outputTextCharacters: normalizedLength(equationRegion.text),
      matchedTextCharacters: normalizedLength(equationRegion.text),
      textCoverage: 1,
    })
  })

  it('does not compare a typed generated equation label with source glyph prose', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const generatedLabel = 'Display equation p001-001'
    const relationship = {
      ...fixture.relationship,
      label: generatedLabel,
      captionRegionId: equationRegion.id,
      sourceRegionIds: [equationRegion.id],
      sourceBoxes: [
        { ...equationRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      altText: equationRegion.text,
      altTextSource: 'source-text',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      title: '',
      authors: [],
      nodes: fixture.paper.nodes.map((node) =>
        node.id === relationship.captionNodeId
          ? { ...node, text: generatedLabel }
          : node.id === relationship.canonicalNodeId && node.type === 'figure'
            ? { ...node, title: generatedLabel }
            : node,
      ),
    } satisfies ResearchPaper
    const provenance = {
      ...fixture.provenance,
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: [{ ...equationRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [equationRegion.id],
      order: [equationRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 1,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters: equationRegion.text.length,
      runs: equationRegion.lines.flatMap((line) => line.runs),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [equationRegion],
      readingOrder,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: normalizedLength(equationRegion.text),
      outputTextCharacters: 0,
      matchedTextCharacters: 0,
      missingSourceRegionCount: 1,
      textCoverage: 0,
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('connects every source region represented by a strict self-captioned equation', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const scriptRun = run('2', 0.375, 0.292, 8, 0.012, 0.011)
    const scriptRegion = {
      id: 'equation-script-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: scriptRun.text,
      confidence: 1,
      box: { ...scriptRun },
      lines: [
        {
          id: 'equation-script-line',
          text: scriptRun.text,
          fontSize: scriptRun.fontSize,
          box: { ...scriptRun },
          runs: [{ ...scriptRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const sourceText = `${equationRegion.text} ${scriptRegion.text}`
    const relationship = {
      ...fixture.relationship,
      captionRegionId: equationRegion.id,
      sourceRegionIds: [equationRegion.id, scriptRegion.id],
      sourceBoxes: [
        { ...equationRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      sourceText,
      altText: sourceText,
      altTextSource: 'source-text',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      title: '',
      authors: [],
      nodes: [
        fixture.paper.nodes.find((node) => node.type === 'figure')!,
        {
          id: 'caption-1',
          type: 'caption',
          text: sourceText,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      'equation-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id, scriptRegion.id],
        boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: [{ ...equationRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [equationRegion.id, scriptRegion.id],
      order: [equationRegion.id, scriptRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 2,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters: equationRegion.text.length + scriptRegion.text.length,
      runs: [...equationRegion.lines.flatMap((line) => line.runs), scriptRun],
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [equationRegion, scriptRegion],
      readingOrder,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: normalizedLength(sourceText),
      outputTextCharacters: normalizedLength(sourceText),
      matchedTextCharacters: normalizedLength(sourceText),
      textCoverage: 1,
      missingSourceRegionCount: 0,
    })
  })

  it('counts typed semantic-table cells as represented source text', () => {
    const runs = [
      run('Profile', 0.1, 0.26, 9, 0.12),
      run('Nodes', 0.3, 0.26, 9, 0.08),
      run('Mobile', 0.1, 0.3, 9, 0.12),
      run('12', 0.3, 0.3, 9, 0.04),
      run('Table 1. Synthetic values.', 0.1, 0.2, 10, 0.42),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
      imageCount: 0,
      runs,
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'table-1',
          type: 'figure',
          objectType: 'table',
          title: 'Table 1',
          table: {
            rows: [
              {
                cells: [
                  {
                    text: 'Profile',
                    headerScope: 'column',
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                  {
                    text: 'Nodes',
                    headerScope: 'column',
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                ],
              },
              {
                cells: [
                  {
                    text: 'Mobile',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                  {
                    text: '12',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                ],
              },
            ],
          },
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
        {
          id: 'caption-1',
          type: 'caption',
          text: 'Table 1. Synthetic values.',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness).toMatchObject({
      matchedTextCharacters: result.completeness.sourceTextCharacters,
      textCoverage: 1,
    })
  })

  it('rejects WRONG visual bytes even when asset metadata and lineage still claim a match', () => {
    const fixture = sourceBackedEquationFixture()
    const input = {
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
    }
    const valid = assessPdfCompleteness({
      ...input,
      assets: [fixture.asset],
    })
    const tampered = assessPdfCompleteness({
      ...input,
      assets: [
        {
          ...fixture.asset,
          bytes: new TextEncoder().encode('WRONG'),
        },
      ],
    })

    expect(valid.completeness).toMatchObject({
      assetCoverage: 1,
      relationshipCoverage: 1,
      unresolvedObjectCount: 0,
    })
    expect(tampered.completeness.textCoverage).toBeLessThan(
      valid.completeness.textCoverage,
    )
    expect(tampered.completeness).toMatchObject({
      assetCoverage: 0,
      relationshipCoverage: 0,
    })
    expect(tampered.readiness.ready).toBe(false)
  })

  it('does not resolve a matched equation crop whose semantic transcript is unresolved or empty', () => {
    const fixture = sourceBackedEquationFixture()
    const unresolvedEvidence = assessSourceBackedEquation(fixture, {
      relationship: {
        evidence: [
          ...fixture.relationship.evidence,
          'source-text-transcript-unresolved',
        ],
      },
    })
    const emptyTranscript = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceText: '',
        altText: fixture.relationship.label,
        altTextSource: 'caption',
      },
    })

    for (const result of [unresolvedEvidence, emptyTranscript]) {
      expect(result.completeness).toMatchObject({
        assetCoverage: 1,
        missingSourceRegionCount: 0,
        resolvedRelationshipCount: 0,
        relationshipCoverage: 0,
        unresolvedObjects: { equations: 1 },
      })
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
            severity: 'error',
            relationshipId: fixture.relationship.id,
          }),
        ]),
      )
      expect(result.readiness).toMatchObject({
        ready: false,
        blockingDiagnosticCodes: expect.arrayContaining([
          'UNRESOLVED_EQUATION_TRANSCRIPT',
        ]),
      })
    }
  })

  it('counts a verified script-only geometry transcript without accepting flat source text', async () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions[1]
    const regionBox = {
      ...equationRegion.box,
      x: 0.25,
      y: 0.29,
      width: 0.14,
      height: 0.045,
    }
    const runs = [
      {
        ...regionBox,
        text: 'q',
        x: 0.27,
        y: 0.305,
        width: 0.01,
        height: 0.014,
        fontName: 'Synthetic-CMMI10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...regionBox,
        text: '2',
        x: 0.281,
        y: 0.296,
        width: 0.006,
        height: 0.007,
        fontName: 'Synthetic-CMMI8',
        fontSize: 7,
        confidence: 1,
      },
      {
        ...regionBox,
        text: '=',
        x: 0.292,
        y: 0.305,
        width: 0.008,
        height: 0.014,
        fontName: 'Synthetic-CMSY10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...regionBox,
        text: 'r',
        x: 0.306,
        y: 0.305,
        width: 0.01,
        height: 0.014,
        fontName: 'Synthetic-CMMI10',
        fontSize: 10,
        confidence: 1,
      },
    ] satisfies PdfSourceRun[]
    equationRegion.text = 'q2=r'
    equationRegion.box = regionBox
    equationRegion.lines = [
      {
        id: 'equation-region-line',
        text: equationRegion.text,
        fontSize: 10,
        box: { ...regionBox },
        runs,
      },
    ]
    const objectBox = { ...regionBox, method: 'pdf-object' as const }
    const asset = await createSourcePageCropAsset({
      kind: 'equation',
      cropBox: {
        page: 1,
        x: 0.23,
        y: 0.27,
        width: 0.2,
        height: 0.09,
        rotation: 0,
        method: 'pdf-object',
      },
      sourceObjectIds: ['equation-object'],
      sourceBoxes: [objectBox],
      width: 80,
      height: 32,
      pixels: new Uint8Array(80 * 32 * 4).fill(72),
    })
    const relationship: PdfVisualRelationship = {
      ...fixture.relationship,
      sourceRegionIds: [equationRegion.id],
      sourceLineIds: [equationRegion.lines[0].id],
      sourceObjectIds: ['equation-object'],
      assetIds: [asset.id],
      evidence: [
        'source-page-crop',
        SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
      ],
      sourceBoxes: [{ ...fixture.regions[0].box }, objectBox],
      sourceText: '',
      altTextSource: 'caption',
    }
    relationship.equationGeometryTranscript =
      createSourceGeometryScriptTranscript({
        sourceRegionIds: relationship.sourceRegionIds,
        sourceLineIds: relationship.sourceLineIds!,
        sourceObjectIds: relationship.sourceObjectIds,
        regions: fixture.regions,
        sourceCropAsset: asset,
      })!
    fixture.paper.nodes = fixture.paper.nodes.map((node) =>
      node.type === 'figure'
        ? {
            ...node,
            relationships: {
              ...node.relationships,
              assets: [asset.id],
            },
          }
        : node,
    )
    fixture.page.runs = [fixture.regions[0].lines[0].runs[0], ...runs]
    fixture.page.textCharacters = fixture.page.runs.reduce(
      (total, item) => total + item.text.length,
      0,
    )
    fixture.page.objects![0] = {
      ...fixture.page.objects![0],
      box: objectBox,
      assetId: asset.id,
    }
    fixture.provenance['equation-1'] = {
      ...fixture.provenance['equation-1'],
      boxes: [{ ...fixture.regions[0].box }, { ...objectBox }],
    }

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [asset],
    })

    expect(relationship.sourceText).toBe('')
    expect(relationship.equationGeometryTranscript).not.toBeNull()
    expect(result.completeness).toMatchObject({
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
      unresolvedObjects: { equations: 0 },
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('blocks readiness when an exact algorithm crop has no proved semantic line transcript', () => {
    const fixture = sourceBackedEquationFixture()
    fixture.regions[0].text = 'Algorithm 1 Deterministic Search'
    fixture.regions[0].lines[0].text = fixture.regions[0].text
    fixture.regions[0].lines[0].runs[0].text = fixture.regions[0].text
    fixture.regions[1].kind = 'body'
    fixture.regions[1].text =
      'Require: graph G 1: Initialize queue. 2: Visit node. 3: return result.'
    fixture.regions[1].lines[0].text = fixture.regions[1].text
    fixture.regions[1].lines[0].runs[0].text = fixture.regions[1].text
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      semanticKind: 'algorithm',
      label: 'Algorithm 1',
      sourceText: '',
      evidence: [
        'source-algorithm-block',
        'source-page-crop',
        'source-text-transcript-unresolved',
      ],
      altText: fixture.regions[0].text,
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'figure' as const,
              title: relationship.altText,
            }
          : node.type === 'caption'
            ? { ...node, text: relationship.altText }
            : node,
      ),
    } satisfies ResearchPaper
    const page = {
      ...fixture.page,
      textCharacters: fixture.regions.reduce(
        (total, region) => total + region.text.length,
        0,
      ),
      runs: fixture.regions.flatMap((region) =>
        region.lines.flatMap((line) => line.runs),
      ),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      assetCoverage: 1,
      missingSourceRegionCount: 0,
      relationshipCoverage: 1,
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_ALGORITHM_TRANSCRIPT',
          severity: 'error',
          relationshipId: relationship.id,
          target: expect.objectContaining({
            regionIds: relationship.sourceRegionIds,
          }),
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_ALGORITHM_TRANSCRIPT',
      ]),
    })
  })

  it('blocks readiness when a preformatted crop has no exact ordered-line transcript', () => {
    const fixture = sourceBackedEquationFixture()
    fixture.regions[0].text = 'Theorems and Tactics'
    fixture.regions[0].lines[0].text = fixture.regions[0].text
    fixture.regions[0].lines[0].runs[0].text = fixture.regions[0].text
    fixture.regions[1].kind = 'body'
    fixture.regions[1].text = '" state_after " : " 2 goals \\ n⊢ -π < π / 2 "'
    fixture.regions[1].lines[0].text = fixture.regions[1].text
    fixture.regions[1].lines[0].runs[0].text = fixture.regions[1].text
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      semanticKind: 'code',
      label: 'Code block p001-001',
      sourceText: '',
      preformatted: {
        status: 'unresolved',
        lines: [],
        evidence: [
          'deterministic-source-line-order',
          'source-text-exactness-unresolved',
        ],
      },
      evidence: [
        'source-preformatted-block',
        'source-page-crop',
        'source-text-transcript-unresolved',
      ],
      altText: 'Source code block',
    } as unknown as PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'figure' as const,
              title: relationship.altText,
            }
          : node.type === 'caption'
            ? { ...node, text: relationship.altText }
            : node,
      ),
    } satisfies ResearchPaper
    const page = {
      ...fixture.page,
      textCharacters: fixture.regions.reduce(
        (total, region) => total + region.text.length,
        0,
      ),
      runs: fixture.regions.flatMap((region) =>
        region.lines.flatMap((line) => line.runs),
      ),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      assetCoverage: 1,
      missingSourceRegionCount: 0,
      relationshipCoverage: 1,
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
          severity: 'error',
          relationshipId: relationship.id,
          target: expect.objectContaining({
            regionIds: relationship.sourceRegionIds,
          }),
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
      ]),
    })
  })

  it('counts every detected equation relationship whose transcript remains unresolved', () => {
    const fixture = sourceBackedEquationFixture()
    const relationships = Array.from({ length: 3 }, (_, index) => ({
      ...fixture.relationship,
      id: `relationship-${index + 1}`,
      label: `Equation ${index + 1}`,
      evidence: [
        ...fixture.relationship.evidence,
        'source-text-transcript-unresolved',
      ],
    })) satisfies PdfVisualRelationship[]

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: relationships,
      assets: [fixture.asset],
    })

    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_EQUATION_TRANSCRIPT',
      ),
    ).toHaveLength(3)
    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 0,
      unresolvedObjects: { equations: 3 },
    })
  })

  it('uses unique atomic equation relationships instead of prose Eq references when the graph is defined', () => {
    const fixture = sourceBackedEquationFixture()
    const references = [
      run('See Eq. 1 for the source relationship.', 0.1, 0.5),
      run('Equation 1 is referenced again in prose.', 0.1, 0.55),
    ]
    fixture.page.runs.push(...references)
    fixture.page.textCharacters += references.reduce(
      (total, sourceRun) => total + sourceRun.text.length,
      0,
    )

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.semanticSignals.equations).toBe(1)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      unresolvedObjects: { equations: 0 },
    })
  })

  it('keeps source-proved display equations that a partial visual graph missed', () => {
    const fixture = sourceBackedEquationFixture()
    const sourceRegion = fixture.regions.find(
      (region) => region.kind === 'equation',
    )
    expect(sourceRegion).toBeDefined()
    if (!sourceRegion) throw new Error('missing source equation region')
    const missedRegions = [2, 3].map((number, index) => {
      const sourceLine = sourceRegion.lines[0]
      const text = `q${number} = r`
      const box = {
        ...sourceRegion.box,
        y: sourceRegion.box.y + (index + 1) * 0.08,
      }
      return {
        ...sourceRegion,
        id: `missed-equation-region-${number}`,
        text,
        box,
        lines: [
          {
            ...sourceLine,
            id: `missed-equation-line-${number}`,
            text,
            box,
            runs: [{ ...sourceLine.runs[0], ...box, text }],
          },
        ],
        nativeObjectIds: [],
      } satisfies PdfPageRegion
    })

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: [...fixture.regions, ...missedRegions],
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 1,
      unresolvedObjects: { equations: 2 },
    })
    expect(result.readiness.ready).toBe(false)
  })

  it('retains raw equation-reference detection when no visual graph is defined', () => {
    const fixture = sourceBackedEquationFixture()
    const references = [
      run('See Eq. 1 for the source relationship.', 0.1, 0.5),
      run('Equation 1 is referenced again in prose.', 0.1, 0.55),
    ]
    fixture.page.runs.push(...references)
    fixture.page.textCharacters += references.reduce(
      (total, sourceRun) => total + sourceRun.text.length,
      0,
    )

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
    })

    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 0,
      unresolvedObjects: { equations: 3 },
    })
  })

  it('retains raw equation obligations when production supplies an empty visual graph', () => {
    const fixture = sourceBackedEquationFixture()
    const references = [
      run('See Eq. 1 for the source relationship.', 0.1, 0.5),
      run('Equation 1 is referenced again in prose.', 0.1, 0.55),
    ]
    fixture.page.runs.push(...references)
    fixture.page.textCharacters += references.reduce(
      (total, sourceRun) => total + sourceRun.text.length,
      0,
    )

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [],
      assets: [],
    })

    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 0,
      unresolvedObjects: { equations: 3 },
    })
    expect(result.readiness.ready).toBe(false)
  })

  it('does not resolve a nonempty equation transcript that omits a selected source line', () => {
    const fixture = sourceBackedEquationFixture()
    const continuationRun = run('+ s', 0.25, 0.325, 14, 0.06)
    const equationRegion = fixture.regions[1]
    equationRegion.text = `${equationRegion.text} ${continuationRun.text}`
    equationRegion.lines.push({
      id: 'equation-region-line-continuation',
      text: continuationRun.text,
      fontSize: continuationRun.fontSize,
      box: { ...continuationRun },
      runs: [{ ...continuationRun }],
    })
    fixture.page.runs.push(continuationRun)
    fixture.page.textCharacters += continuationRun.text.length

    const partialTranscript = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceLineIds: equationRegion.lines.map((line) => line.id),
        sourceText: 'q = r',
      },
    })

    expect(partialTranscript.completeness).toMatchObject({
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjects: { equations: 1 },
    })
    expect(partialTranscript.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          severity: 'error',
          relationshipId: fixture.relationship.id,
        }),
      ]),
    )
  })

  it('does not accept a producer-declared subset of a multi-line equation region', () => {
    const fixture = sourceBackedEquationFixture()
    const continuationRun = run('+ s', 0.25, 0.325, 14, 0.06)
    const equationRegion = fixture.regions[1]
    equationRegion.text = `${equationRegion.text} ${continuationRun.text}`
    equationRegion.lines.push({
      id: 'equation-region-line-continuation',
      text: continuationRun.text,
      fontSize: continuationRun.fontSize,
      box: { ...continuationRun },
      runs: [{ ...continuationRun }],
    })
    fixture.page.runs.push(continuationRun)
    fixture.page.textCharacters += continuationRun.text.length

    const producerSubset = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceLineIds: [equationRegion.lines[0].id],
        sourceText: equationRegion.lines[0].text,
      },
    })

    expect(producerSubset.completeness).toMatchObject({
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjects: { equations: 1 },
    })
    expect(producerSubset.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('does not accept a transcript that omits an adjacent equation source region', () => {
    const fixture = sourceBackedEquationFixture()
    const omittedRun = run('+ s', 0.25, 0.325, 14, 0.06)
    const omittedRegion = {
      id: 'omitted-equation-region',
      page: 1,
      kind: 'equation',
      column: 'single',
      text: omittedRun.text,
      confidence: 1,
      box: { ...omittedRun },
      lines: [
        {
          id: 'omitted-equation-line',
          text: omittedRun.text,
          fontSize: omittedRun.fontSize,
          box: { ...omittedRun },
          runs: [{ ...omittedRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    fixture.regions.push(omittedRegion)
    fixture.page.runs.push(omittedRun)
    fixture.page.textCharacters += omittedRun.text.length

    const missingAssociatedRegion = assessSourceBackedEquation(fixture)

    expect(missingAssociatedRegion.completeness.resolvedRelationshipCount).toBe(
      0,
    )
    expect(missingAssociatedRegion.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('rejects a flattened transcript for unproved two-dimensional script geometry', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions[1]
    const baseline = run('q', 0.25, 0.3, 14, 0.03, 0.018)
    baseline.fontName = 'Synthetic-Math-Regular'
    const superscript = run('2', 0.28, 0.291, 8, 0.012, 0.01)
    superscript.fontName = 'Synthetic-Math-Regular'
    const remainder = run(' = r', 0.298, 0.3, 14, 0.07, 0.018)
    remainder.fontName = 'Synthetic-Math-Regular'
    equationRegion.text = 'q2 = r'
    equationRegion.lines[0] = {
      ...equationRegion.lines[0],
      text: equationRegion.text,
      runs: [baseline, superscript, remainder],
    }
    fixture.page.runs = [
      ...fixture.regions[0].lines[0].runs,
      baseline,
      superscript,
      remainder,
    ]
    fixture.page.textCharacters =
      fixture.regions[0].text.length + equationRegion.text.length

    const result = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceText: equationRegion.text,
        altText: equationRegion.text,
        altTextSource: 'source-text',
      },
    })

    expect(result.completeness).toMatchObject({
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjects: { equations: 1 },
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          severity: 'error',
          relationshipId: fixture.relationship.id,
        }),
      ]),
    )
  })

  it('does not accept a transcript that omits an overlapping equation object', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions[1]
    const objectBox = {
      ...equationRegion.box,
      method: 'pdf-object' as const,
    }
    fixture.regions.push({
      id: 'omitted-equation-object-region',
      page: 1,
      kind: 'figure',
      column: 'single',
      text: '',
      confidence: 1,
      box: objectBox,
      lines: [],
      nativeObjectIds: ['omitted-equation-object'],
      includedInReadingOrder: true,
    })
    fixture.page.objects ??= []
    fixture.page.objects.push({
      id: 'omitted-equation-object',
      page: 1,
      kind: 'image',
      box: objectBox,
      confidence: 1,
      assetId: 'omitted-equation-object-asset',
    })
    fixture.page.imageCount += 1

    const missingAssociatedObject = assessSourceBackedEquation(fixture)

    expect(missingAssociatedObject.completeness.resolvedRelationshipCount).toBe(
      0,
    )
    expect(missingAssociatedObject.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('fails equation transcript completeness closed without an exact source-line ledger', () => {
    const fixture = sourceBackedEquationFixture()
    const missingLineLedger = assessSourceBackedEquation(fixture, {
      relationship: { sourceLineIds: undefined },
    })
    const unknownLine = assessSourceBackedEquation(fixture, {
      relationship: { sourceLineIds: ['missing-equation-source-line'] },
    })

    for (const result of [missingLineLedger, unknownLine]) {
      expect(result.completeness).toMatchObject({
        resolvedRelationshipCount: 0,
        relationshipCoverage: 0,
        unresolvedObjects: { equations: 1 },
      })
      expect(result.readiness).toMatchObject({
        ready: false,
        blockingDiagnosticCodes: expect.arrayContaining([
          'UNRESOLVED_EQUATION_TRANSCRIPT',
        ]),
      })
    }
  })
})
