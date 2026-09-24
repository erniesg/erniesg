import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import {
  assessPdfCompleteness,
  detectPdfSemanticSignals,
} from './pdf-quality'
import {
  assessSourceBackedEquation,
  equationAssetWithPayload,
  run,
  sourceBackedEquationFixture,
} from './pdf-quality.test-helpers'

describe('PDF semantic signal detection', () => {
  it('keeps every authoritative unresolved or ambiguous visual relationship blocking', () => {
    const fixture = sourceBackedEquationFixture()

    for (const status of ['unresolved', 'ambiguous'] as const) {
      const result = assessPdfCompleteness({
        pages: [fixture.page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [{ ...fixture.relationship, status }],
        assets: [fixture.asset],
      })

      expect(result.completeness).toMatchObject({
        sourceAssetCount: 1,
        exportedAssetCount: 0,
        assetCoverage: 0,
      })
      expect(result.readiness.ready).toBe(false)
      expect(result.readiness.blockingDiagnosticCodes).toContain(
        'INCOMPLETE_ASSET_COVERAGE',
      )
    }
  })

  it('keeps raw unreferenced PDF object inventory out of semantic obligation counts', () => {
    const boxes = [
      { x: 0.2, y: 0.2, width: 0.08, height: 0.08 },
      { x: 0.28, y: 0.2, width: 0.08, height: 0.08 },
      { x: 0.2, y: 0.28, width: 0.08, height: 0.08 },
      { x: 0.28, y: 0.28, width: 0.08, height: 0.08 },
      { x: 0.7, y: 0.7, width: 0.08, height: 0.08 },
    ].map((box) => ({
      page: 1,
      ...box,
      rotation: 0,
      method: 'pdf-object' as const,
    }))
    const page = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 0,
      imageCount: 0,
      objects: boxes.map((box, index) => ({
        id: `vector-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box,
        confidence: 1,
        assetId: null,
      })),
      runs: [],
    } satisfies PdfPageAnalysis
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [],
    } satisfies ResearchPaper

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: boxes.map((box) => ({
        code: 'UNREFERENCED_VISUAL_ASSET' as const,
        severity: 'error' as const,
        page: 1,
        message: 'Unreferenced source visual.',
        sourceBoxes: [box],
        target: { regionIds: [], markerId: null },
      })),
      visualRelationships: [],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 0,
      exportedAssetCount: 0,
      assetCoverage: 1,
    })
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNREFERENCED_VISUAL_ASSET',
    )
  })

  it('rejects a coordinated asset id that is not bound to its content digest', () => {
    const fixture = sourceBackedEquationFixture()
    const id = `asset-${'f'.repeat(24)}`
    const asset = {
      ...fixture.asset,
      id,
      href: `assets/${id}.png`,
    } satisfies PdfVisualAsset

    const result = assessSourceBackedEquation(fixture, { asset })

    expect(result.completeness.assetCoverage).toBeLessThan(1)
    expect(result.completeness.relationshipCoverage).toBe(0)
  })

  it('rejects bounded fallbacks and invalid raster/vector media pairs', () => {
    const fixture = sourceBackedEquationFixture()
    const svgBytes = new TextEncoder().encode('<svg><text>q = r</text></svg>')
    const invalidPair = equationAssetWithPayload(fixture, {
      bytes: svgBytes,
      mediaType: 'image/svg+xml',
      kind: 'raster',
      rendition: 'source-preserved',
    })
    const boundedFallback = equationAssetWithPayload(fixture, {
      bytes: svgBytes,
      mediaType: 'image/svg+xml',
      kind: 'equation',
      rendition: 'bounded-svg-fallback',
    })

    for (const asset of [invalidPair, boundedFallback]) {
      const result = assessSourceBackedEquation(fixture, { asset })
      expect(result.completeness.assetCoverage).toBeLessThan(1)
      expect(result.completeness.relationshipCoverage).toBe(0)
    }
  })

  it('rejects coordinated source-region and caption-provenance contradictions', () => {
    const fixture = sourceBackedEquationFixture()
    const emptySourceRegions = assessSourceBackedEquation(fixture, {
      relationship: { sourceRegionIds: [] },
      provenance: {
        ...fixture.provenance,
        'equation-1': {
          ...fixture.provenance['equation-1'],
          regionIds: [],
        },
      },
    })
    const wrongCaptionPage = assessSourceBackedEquation(fixture, {
      provenance: {
        ...fixture.provenance,
        'caption-1': {
          ...fixture.provenance['caption-1'],
          pages: [2],
        },
      },
    })

    for (const result of [emptySourceRegions, wrongCaptionPage]) {
      expect(result.completeness.assetCoverage).toBeLessThan(1)
      expect(result.completeness.relationshipCoverage).toBe(0)
    }
  })

  it('rejects visual source regions already rendered as canonical prose', () => {
    const fixture = sourceBackedEquationFixture()
    const paper = {
      ...fixture.paper,
      nodes: [
        ...fixture.paper.nodes,
        {
          id: 'duplicate-prose',
          type: 'paragraph',
          text: fixture.relationship.sourceText,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: {
        ...fixture.provenance,
        'duplicate-prose': {
          confidence: 1,
          pages: [1],
          regionIds: [...fixture.relationship.sourceRegionIds],
          boxes: [fixture.relationship.sourceBoxes[1]],
          links: [],
        },
      },
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
      resolvedRelationshipCount: 0,
    })
    expect(result.readiness.ready).toBe(false)
  })

  it('does not count a text-derived bounded SVG as source-backed visual text', () => {
    const runs = [run('q = r', 0.25, 0.3, 14, 0.12)]
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
          id: 'equation-1',
          type: 'figure',
          objectType: 'equation',
          title: 'Equation 1',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }
    const relationship = {
      id: 'relationship-1',
      kind: 'equation',
      label: 'Equation 1',
      captionRegionId: 'caption-region',
      sourceRegionIds: ['equation-region'],
      sourceObjectIds: ['equation-object'],
      assetIds: ['equation-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['source-equation-region'],
      candidates: [],
      sourceBoxes: [
        {
          page: 1,
          x: 0.25,
          y: 0.3,
          width: 0.12,
          height: 0.018,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      sourceText: 'q = r',
      altText: 'Equation 1. Synthetic fallback.',
      altTextSource: 'caption',
      canonicalNodeId: 'equation-1',
      captionNodeId: null,
    } satisfies PdfVisualRelationship

    const metadataOnly = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [relationship],
    })
    const asset = {
      id: 'equation-asset',
      href: 'assets/equation.svg',
      mediaType: 'image/svg+xml',
      kind: 'equation',
      rendition: 'bounded-svg-fallback',
      sha256: 'a'.repeat(64),
      bytes: new TextEncoder().encode('<svg><text>q = r</text></svg>'),
      width: 120,
      height: 30,
      resolutionDpi: null,
      sourceObjectIds: ['equation-object'],
      sourceBoxes: [relationship.sourceBoxes[0]],
    } satisfies PdfVisualAsset
    const matched = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [relationship],
      assets: [asset],
    })
    const unresolved = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [
        {
          ...relationship,
          status: 'unresolved',
          sourceRegionIds: [],
          sourceObjectIds: [],
          assetIds: [],
          canonicalNodeId: null,
        },
      ],
    })

    expect(metadataOnly.completeness.textCoverage).toBeLessThan(1)
    expect(matched.completeness.textCoverage).toBe(
      metadataOnly.completeness.textCoverage,
    )
    expect(matched.completeness.assetCoverage).toBe(0)
    expect(matched.completeness.relationshipCoverage).toBe(0)
    expect(unresolved.completeness.textCoverage).toBeLessThan(1)
  })

  it('does not count a repeated glyph from a bounded SVG approximation', () => {
    const runs = [
      run('Visible z.', 0.1, 0.2, 10, 0.18),
      run('z', 0.3, 0.3, 14, 0.02),
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
          id: 'p-1',
          type: 'paragraph',
          text: 'Visible z.',
          source: 'test',
        },
        {
          id: 'visual-1',
          type: 'figure',
          objectType: 'equation',
          title: 'Formula 1',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }
    const relationship = {
      id: 'relationship-1',
      kind: 'equation',
      label: 'Formula 1',
      captionRegionId: 'caption-region',
      sourceRegionIds: ['equation-region'],
      sourceObjectIds: ['equation-object'],
      assetIds: ['equation-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['source-equation-region'],
      candidates: [],
      sourceBoxes: [
        {
          page: 1,
          x: 0.3,
          y: 0.3,
          width: 0.02,
          height: 0.018,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      sourceText: 'z',
      altText: 'Formula 1.',
      altTextSource: 'caption',
      canonicalNodeId: 'visual-1',
      captionNodeId: null,
    } satisfies PdfVisualRelationship

    const asset = {
      id: 'equation-asset',
      href: 'assets/repeated-glyph.svg',
      mediaType: 'image/svg+xml',
      kind: 'equation',
      rendition: 'bounded-svg-fallback',
      sha256: 'b'.repeat(64),
      bytes: new TextEncoder().encode('<svg><text>z</text></svg>'),
      width: 20,
      height: 20,
      resolutionDpi: null,
      sourceObjectIds: ['equation-object'],
      sourceBoxes: [relationship.sourceBoxes[0]],
    } satisfies PdfVisualAsset

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [relationship],
      assets: [asset],
    })

    expect(result.completeness.textCoverage).toBeLessThan(1)
  })

  it('does not infer a semantic obligation from raw image-operator counts alone', () => {
    const runs = [
      run('Recovered text remains incomplete without its image.', 0.1, 0.2),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 1,
      objects: [],
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
          id: 'p-1',
          type: 'paragraph',
          text: runs[0].text,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 0,
      exportedAssetCount: 0,
      assetCoverage: 1,
    })
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNREFERENCED_VISUAL_ASSET',
    )
  })

  it('joins visually aligned runs in source order before matching signals', () => {
    const runs = [
      run('1. Split caption text', 0.165, 0.2015),
      run('Figure', 0.1, 0.2),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
      imageCount: 1,
      runs,
    }

    expect(detectPdfSemanticSignals([page])).toMatchObject({ captions: 1 })
  })

  it('counts figure obligations only from proven caption regions when regions are supplied', () => {
    const figureCaption = run('Figure 1. Proven caption.', 0.1, 0.2, 9, 0.4)
    const incidentalText = run(
      'Figure: is used as body prose here.',
      0.1,
      0.3,
      10,
      0.5,
    )
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: figureCaption.text.length + incidentalText.text.length,
      imageCount: 1,
      runs: [figureCaption, incidentalText],
    }
    const captionRegion: PdfPageRegion = {
      id: 'figure-caption',
      page: 1,
      kind: 'caption',
      column: 'single',
      text: figureCaption.text,
      confidence: 1,
      box: { ...figureCaption },
      lines: [
        {
          id: 'figure-caption-line',
          text: figureCaption.text,
          fontSize: figureCaption.fontSize,
          box: { ...figureCaption },
          runs: [{ ...figureCaption }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const bodyRegion: PdfPageRegion = {
      ...captionRegion,
      id: 'incidental-body',
      kind: 'body',
      text: incidentalText.text,
      box: { ...incidentalText },
      lines: [
        {
          id: 'incidental-body-line',
          text: incidentalText.text,
          fontSize: incidentalText.fontSize,
          box: { ...incidentalText },
          runs: [{ ...incidentalText }],
        },
      ],
    }

    expect(
      detectPdfSemanticSignals([page], [captionRegion, bodyRegion]),
    ).toMatchObject({
      captions: 1,
    })
  })

  it('keeps a proven caption-region obligation when the printed label is unparseable', () => {
    const sourceRun = run(
      'Figure: Explicit caption with unresolved numbering.',
      0.1,
      0.2,
      9,
      0.5,
    )
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 1,
      runs: [sourceRun],
    }
    const captionRegion: PdfPageRegion = {
      id: 'unparseable-figure-caption',
      page: 1,
      kind: 'caption',
      column: 'single',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: 'unparseable-figure-caption-line',
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [{ ...sourceRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }

    expect(detectPdfSemanticSignals([page], [captionRegion])).toMatchObject({
      captions: 1,
    })
  })

  it('does not count table cross-references in ordinary body regions as table obligations', () => {
    const runs = [
      run('Table 1 shows the primary result.', 0.1, 0.2, 10, 0.5),
      run('Table 2 compares the ablations.', 0.1, 0.24, 10, 0.5),
      run('Table III reports the error bands.', 0.1, 0.28, 10, 0.5),
      run('Table IV summarizes prior work.', 0.1, 0.32, 10, 0.5),
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
    const regions = runs.map(
      (sourceRun, index) =>
        ({
          id: `body-${index + 1}`,
          page: 1,
          kind: 'body',
          column: 'single',
          text: sourceRun.text,
          confidence: 1,
          box: { ...sourceRun },
          lines: [
            {
              id: `body-line-${index + 1}`,
              text: sourceRun.text,
              fontSize: sourceRun.fontSize,
              box: { ...sourceRun },
              runs: [{ ...sourceRun }],
            },
          ],
          nativeObjectIds: [],
          includedInReadingOrder: true,
        }) satisfies PdfPageRegion,
    )

    expect(detectPdfSemanticSignals([page], regions)).toMatchObject({
      tables: 0,
    })
  })

  it('counts ordinary, supplementary, and compound table captions only with caption-region proof', () => {
    const runs = [
      run('Table 5. Numeric source caption.', 0.1, 0.2, 9, 0.5),
      run('Table VI. Roman source caption.', 0.1, 0.3, 9, 0.5),
      run('Table S2. Supplementary source caption.', 0.1, 0.4, 9, 0.5),
      run('Table A.1. Dotted source caption.', 0.1, 0.5, 9, 0.5),
      run('Table B-2. Hyphenated source caption.', 0.1, 0.6, 9, 0.5),
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
    const regions = runs.map(
      (sourceRun, index) =>
        ({
          id: `caption-${index + 1}`,
          page: 1,
          kind: 'caption',
          column: 'single',
          text: sourceRun.text,
          confidence: 1,
          box: { ...sourceRun },
          lines: [
            {
              id: `caption-line-${index + 1}`,
              text: sourceRun.text,
              fontSize: sourceRun.fontSize,
              box: { ...sourceRun },
              runs: [{ ...sourceRun }],
            },
          ],
          nativeObjectIds: [],
          includedInReadingOrder: true,
        }) satisfies PdfPageRegion,
    )

    expect(detectPdfSemanticSignals([page], regions)).toMatchObject({
      tables: 5,
    })
  })

  it('does not count duplicate links to one caption as separate relationships', () => {
    const runs = [run('Figure 1. Shared caption', 0.1, 0.2)]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 2,
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
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Shared caption',
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          title: 'First image',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
        {
          id: 'figure-2',
          type: 'figure',
          title: 'Second image',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }

    expect(
      assessPdfCompleteness({ pages: [page], paper, diagnostics: [] })
        .completeness,
    ).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
    })
  })

  it('keeps a genuinely unclaimed captioned image as a blocking semantic obligation', () => {
    const runs = [run('Figure 1. Source image', 0.1, 0.2)]
    const imageBox = {
      page: 1,
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 1,
      objects: [
        {
          id: 'unclaimed-captioned-image',
          page: 1,
          kind: 'image',
          box: imageBox,
          confidence: 1,
          assetId: null,
        },
      ],
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
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Source image',
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          title: 'Placeholder only',
          relationships: { caption: 'caption-1' },
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
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
    })
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_ASSET_COVERAGE',
    )
  })

  it('fails closed on Roman-numeral table captions', () => {
    const runs = [run('TABLE IV. Comparative results', 0.1, 0.2)]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
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
          id: 'p-1',
          type: 'paragraph',
          text: runs[0].text,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.semanticSignals.tables).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_SEMANTIC_OBJECTS',
    )
  })
})
