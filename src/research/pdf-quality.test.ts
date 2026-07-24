import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSourceRun,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import {
  assessPdfCompleteness,
  classifyStructuralLineBoundaryDecisions,
  detectPdfSemanticSignals,
} from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import {
  canonicalTableFromLines,
  createSourcePageCropAsset,
} from './visual-assets'

function run(
  text: string,
  x: number,
  y: number,
  fontSize = 10,
  width = 0.06,
  height = 0.018,
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
    fontName: 'Body',
    fontSize,
    confidence: 1,
  }
}

function normalizedLength(value: string) {
  return [...value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')].length
}

function sourceBackedEquationFixture() {
  const captionRun = run('Equation 1. Source glyph.', 0.2, 0.2, 10, 0.4)
  const equationRun = run('q = r', 0.25, 0.3, 14, 0.12)
  const objectBox = {
    page: 1,
    x: equationRun.x,
    y: equationRun.y,
    width: equationRun.width,
    height: equationRun.height,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const bytes = new TextEncoder().encode('SOURCE-GLYPH')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const assetId = `asset-${sha256.slice(0, 24)}`
  const region = (
    id: string,
    kind: PdfPageRegion['kind'],
    sourceRun: PdfSourceRun,
    nativeObjectIds: string[] = [],
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
      nativeObjectIds,
      includedInReadingOrder: true,
    }) satisfies PdfPageRegion
  const captionRegion = region('caption-region', 'caption', captionRun)
  const equationRegion = region('equation-region', 'equation', equationRun, [
    'equation-object',
  ])
  const relationship = {
    id: 'relationship-1',
    kind: 'equation',
    label: 'Equation 1',
    captionRegionId: captionRegion.id,
    sourceRegionIds: [equationRegion.id],
    sourceLineIds: equationRegion.lines.map((line) => line.id),
    sourceObjectIds: ['equation-object'],
    assetIds: [assetId],
    status: 'matched',
    confidence: 1,
    evidence: ['source-glyph-raster'],
    candidates: [],
    sourceBoxes: [{ ...captionRegion.box }, { ...objectBox }],
    sourceText: equationRun.text,
    altText: captionRun.text,
    altTextSource: 'caption',
    canonicalNodeId: 'equation-1',
    captionNodeId: 'caption-1',
  } satisfies PdfVisualRelationship
  const asset = {
    id: assetId,
    href: `assets/${assetId}.png`,
    mediaType: 'image/png',
    kind: 'raster',
    rendition: 'source-preserved',
    sha256,
    bytes,
    width: 120,
    height: 30,
    resolutionDpi: null,
    sourceObjectIds: ['equation-object'],
    sourceBoxes: [{ ...objectBox }],
  } satisfies PdfVisualAsset
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: captionRun.text.length + equationRun.text.length,
    imageCount: 1,
    objects: [
      {
        id: 'equation-object',
        page: 1,
        kind: 'image',
        box: { ...objectBox },
        confidence: 1,
        assetId,
      },
    ],
    runs: [captionRun, equationRun],
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
    nodes: [
      {
        id: 'equation-1',
        type: 'figure',
        objectType: 'equation',
        title: 'Equation 1',
        relationships: { caption: 'caption-1', assets: [assetId] },
        source: 'test',
      },
      {
        id: 'caption-1',
        type: 'caption',
        text: captionRun.text,
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
      regionIds: [captionRegion.id],
      boxes: [{ ...captionRegion.box }],
      links: [],
    },
  } satisfies Record<string, NodeSourceEvidence>
  const readingOrder = {
    schemaVersion: '1.0.0',
    regionIds: [captionRegion.id, equationRegion.id],
    order: [captionRegion.id, equationRegion.id],
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
  return {
    page,
    paper,
    relationship,
    asset,
    provenance,
    regions: [captionRegion, equationRegion],
    readingOrder,
  }
}

function assessSourceBackedEquation(
  fixture: ReturnType<typeof sourceBackedEquationFixture>,
  options: {
    asset?: PdfVisualAsset
    relationship?: Partial<PdfVisualRelationship>
    provenance?: Record<string, NodeSourceEvidence>
  } = {},
) {
  const asset = options.asset ?? fixture.asset
  const relationship = {
    ...fixture.relationship,
    assetIds: [asset.id],
    ...options.relationship,
  } satisfies PdfVisualRelationship
  const paper = {
    ...fixture.paper,
    nodes: fixture.paper.nodes.map((node) =>
      node.type === 'figure'
        ? {
            ...node,
            relationships: { ...node.relationships, assets: [asset.id] },
          }
        : node,
    ),
  } satisfies ResearchPaper
  const page = {
    ...fixture.page,
    objects: fixture.page.objects?.map((object) => ({
      ...object,
      assetId: asset.id,
    })),
  } satisfies PdfPageAnalysis
  return assessPdfCompleteness({
    pages: [page],
    paper,
    diagnostics: [],
    regions: fixture.regions,
    readingOrder: fixture.readingOrder,
    provenance: options.provenance ?? fixture.provenance,
    visualRelationships: [relationship],
    assets: [asset],
  })
}

function equationAssetWithPayload(
  fixture: ReturnType<typeof sourceBackedEquationFixture>,
  input: {
    bytes: Uint8Array
    mediaType: PdfVisualAsset['mediaType']
    kind: PdfVisualAsset['kind']
    rendition: PdfVisualAsset['rendition']
  },
) {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const id = `asset-${sha256.slice(0, 24)}`
  const extension =
    input.mediaType === 'image/svg+xml'
      ? 'svg'
      : input.mediaType === 'application/xhtml+xml'
        ? 'xhtml'
        : 'png'
  return {
    ...fixture.asset,
    ...input,
    id,
    href: `assets/${id}.${extension}`,
    sha256,
  } satisfies PdfVisualAsset
}

function strictTableBoundaryFixture() {
  const captionRun = run('Table 1. Source-backed values.', 0.2, 0.18, 10, 0.4)
  const headerLabelRun = run('Header', 0.2, 0.3, 10, 0.18)
  const headerValueRun = run('Value', 0.45, 0.3, 10, 0.12)
  const bodyLabelRun = run('inter-national', 0.2, 0.325, 10, 0.18)
  const bodyValueRun = run('1', 0.45, 0.325, 10, 0.04)
  const captionRegion = {
    id: 'table-caption-region',
    page: 1,
    kind: 'caption',
    column: 'single',
    text: captionRun.text,
    confidence: 1,
    box: { ...captionRun },
    lines: [
      {
        id: 'table-caption-line',
        text: captionRun.text,
        fontSize: captionRun.fontSize,
        box: { ...captionRun },
        runs: [{ ...captionRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const tableBox = {
    page: 1,
    x: 0.18,
    y: 0.27,
    width: 0.5,
    height: 0.12,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const tableRegion = {
    id: 'table-source-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text: 'Header Value inter-national 1',
    confidence: 1,
    box: {
      page: 1,
      x: 0.2,
      y: 0.3,
      width: 0.14,
      height: 0.043,
      rotation: 0,
      method: 'pdf-text' as const,
    },
    lines: [
      {
        id: 'table-line-1',
        text: `${headerLabelRun.text} ${headerValueRun.text}`,
        fontSize: headerLabelRun.fontSize,
        box: {
          ...headerLabelRun,
          width: headerValueRun.x + headerValueRun.width - headerLabelRun.x,
        },
        runs: [{ ...headerLabelRun }, { ...headerValueRun }],
      },
      {
        id: 'table-line-2',
        text: `${bodyLabelRun.text} ${bodyValueRun.text}`,
        fontSize: bodyLabelRun.fontSize,
        box: {
          ...bodyLabelRun,
          width: bodyValueRun.x + bodyValueRun.width - bodyLabelRun.x,
        },
        runs: [{ ...bodyLabelRun }, { ...bodyValueRun }],
      },
    ],
    nativeObjectIds: ['table-object'],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const table = canonicalTableFromLines(tableRegion.lines, {
    sourceHeaderLineIds: ['table-line-1'],
    sourceRegions: [tableRegion],
  })
  if (!table) throw new Error('expected source-verifiable table fixture')
  const bytes = new TextEncoder().encode(
    '<table><tr><th>Header</th><th>Value</th></tr><tr><td>international</td><td>1</td></tr></table>',
  )
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const asset = {
    id: `asset-${sha256.slice(0, 24)}`,
    href: `assets/asset-${sha256.slice(0, 24)}.xhtml`,
    mediaType: 'application/xhtml+xml',
    kind: 'table',
    rendition: 'semantic-table',
    sha256,
    bytes,
    width: 1,
    height: 1,
    resolutionDpi: null,
    sourceObjectIds: ['table-object'],
    sourceBoxes: [{ ...tableBox }],
  } satisfies PdfVisualAsset
  const relationship = {
    id: 'table-relationship',
    kind: 'table',
    label: 'Table 1',
    captionRegionId: captionRegion.id,
    sourceRegionIds: [tableRegion.id],
    sourceLineIds: tableRegion.lines.map((line) => line.id),
    sourceObjectIds: ['table-object'],
    assetIds: [asset.id],
    status: 'matched',
    confidence: 1,
    evidence: ['semantic-table'],
    candidates: [],
    sourceBoxes: [{ ...captionRegion.box }, { ...tableBox }],
    sourceText: tableRegion.text,
    altText: captionRegion.text,
    altTextSource: 'caption',
    canonicalNodeId: 'table-1',
    captionNodeId: 'table-caption-1',
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
        id: 'table-1',
        type: 'figure',
        objectType: 'table',
        title: 'Table 1',
        sourceText: tableRegion.text,
        table,
        relationships: {
          caption: 'table-caption-1',
          assets: [asset.id],
        },
        source: 'test',
      },
      {
        id: 'table-caption-1',
        type: 'caption',
        text: captionRegion.text,
        source: 'test',
      },
    ],
  } satisfies ResearchPaper
  const provenance = {
    'table-1': {
      confidence: 1,
      pages: [1],
      regionIds: [tableRegion.id],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: [],
    },
    'table-caption-1': {
      confidence: 1,
      pages: [1],
      regionIds: [captionRegion.id],
      boxes: [{ ...captionRegion.box }],
      links: [],
    },
  } satisfies Record<string, NodeSourceEvidence>
  const decision = {
    id: 'table-boundary',
    page: 1,
    regionId: tableRegion.id,
    fromLineId: tableRegion.lines[0].id,
    toLineId: tableRegion.lines[1].id,
    outcome: 'unresolved',
    evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
  } satisfies PdfLineBoundaryDecision
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters:
      captionRun.text.length +
      headerLabelRun.text.length +
      headerValueRun.text.length +
      bodyLabelRun.text.length +
      bodyValueRun.text.length,
    imageCount: 0,
    objects: [],
    runs: [
      captionRun,
      headerLabelRun,
      headerValueRun,
      bodyLabelRun,
      bodyValueRun,
    ],
  } satisfies PdfPageAnalysis
  const readingOrder = {
    schemaVersion: '1.0.0',
    regionIds: [captionRegion.id, tableRegion.id],
    order: [captionRegion.id, tableRegion.id],
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
  return {
    paper,
    provenance,
    relationship,
    asset,
    decision,
    page,
    regions: [captionRegion, tableRegion],
    readingOrder,
  }
}

describe('PDF semantic signal detection', () => {
  function singleRegionEvidence(sourceRun: PdfSourceRun) {
    const region = {
      id: 'region-1',
      page: sourceRun.page,
      kind: 'body',
      column: 'single',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: 'line-1',
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [{ ...sourceRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const readingOrder = {
      schemaVersion: '1.0.0',
      regionIds: [region.id],
      order: [region.id],
      edges: [],
      resolutions: [],
      acyclic: true,
      evaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 1,
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
    const evidence = {
      confidence: 1,
      pages: [sourceRun.page],
      regionIds: [region.id],
      boxes: [{ ...sourceRun }],
      links: [],
    } satisfies NodeSourceEvidence
    return { region, readingOrder, evidence }
  }

  it('aggregates canonical-flow ambiguity into reading-order review truth', () => {
    const sourceRun = run('A source-backed paragraph.', 0.1, 0.2)
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'paragraph-1',
          type: 'paragraph',
          text: sourceRun.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const assessed = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRun.text.length,
          imageCount: 0,
          runs: [sourceRun],
        },
      ],
      paper,
      diagnostics: [
        {
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'warning',
          page: 1,
          message:
            'A canonical visual has exact references in multiple heading scopes.',
        },
      ],
      readingOrder,
      regions: [region],
      provenance: { 'paragraph-1': evidence },
    })

    expect(assessed.completeness.readingOrderDiagnostics).toBe(1)
    expect(assessed.completeness.readingOrderEvaluation).toMatchObject({
      regionCount: 1,
      unresolvedEdgeCount: 0,
      reviewRequired: true,
    })
    expect(assessed.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('fails a configured hyperlink obligation ledger closed', () => {
    const sourceRun = run('A source-backed link owner.', 0.1, 0.2)
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'paragraph-1',
          type: 'paragraph',
          text: sourceRun.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const assessed = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRun.text.length,
          imageCount: 0,
          runs: [sourceRun],
        },
      ],
      paper,
      diagnostics: [],
      readingOrder,
      regions: [region],
      provenance: { 'paragraph-1': evidence },
      hyperlinkLedger: { expected: 1, mapped: 0 },
    })

    expect(assessed.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
    expect(assessed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          severity: 'error',
        }),
      ]),
    )
    expect(assessed.readiness.ready).toBe(false)
  })

  it('classifies an unresolved strict table-only transition as structural', () => {
    const fixture = strictTableBoundaryFixture()
    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
      }),
    ).toEqual([fixture.relationship])

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [fixture.decision],
      paper: fixture.paper,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      regions: fixture.regions,
    })
    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 1,
      decisions: [
        {
          outcome: 'structural-boundary',
          evidence: [
            'insufficient-hyphen-evidence',
            'source-form-preserved',
            'strict-visual-only-region',
          ],
        },
      ],
    })

    const assessed = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      lineBoundaryDecisions: [fixture.decision],
    })
    expect(assessed.completeness).toMatchObject({
      lineBoundaryCount: 1,
      decidedLineBoundaryCount: 1,
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 1,
    })
    expect(assessed.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_CORRUPTING_JOIN',
    )
  })

  it('retains a complete bounded table crop without counting it as semantic table resolution', async () => {
    const fixture = strictTableBoundaryFixture()
    const width = 12
    const height = 8
    const pixels = new Uint8Array(width * height * 4).fill(255)
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 10; x += 1) {
        const offset = (y * width + x) * 4
        pixels.set([0, 0, 0, 255], offset)
      }
    }
    const crop = await createSourcePageCropAsset({
      kind: 'table',
      cropBox: fixture.asset.sourceBoxes[0],
      sourceObjectIds: fixture.asset.sourceObjectIds,
      sourceBoxes: fixture.asset.sourceBoxes,
      width,
      height,
      pixels,
    })
    const relationship = {
      ...fixture.relationship,
      assetIds: [crop.id],
      sourceLineIds: fixture.regions[1].lines.map((line) => line.id),
      evidence: [
        'bounded-table-scope',
        'non-semantic-source-scope',
        'source-page-crop',
      ],
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              table: undefined,
              sourceText: fixture.relationship.sourceText,
              relationships: { ...node.relationships, assets: [crop.id] },
            }
          : node,
      ),
    } satisfies ResearchPaper

    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [crop],
      }),
    ).toEqual([relationship])
    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance: fixture.provenance,
        relationships: [{ ...relationship, sourceLineIds: [] }],
        assets: [crop],
      }),
    ).toEqual([])
    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance: fixture.provenance,
        relationships: [
          {
            ...relationship,
            evidence: relationship.evidence.filter(
              (item) => item !== 'source-page-crop',
            ),
          },
        ],
        assets: [crop],
      }),
    ).toEqual([])
    expect(
      validatedPdfVisualRelationships({
        paper: {
          ...paper,
          nodes: paper.nodes.map((node) =>
            node.type === 'figure'
              ? { ...node, sourceText: `${node.sourceText} missing` }
              : node,
          ),
        },
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [crop],
      }),
    ).toEqual([])

    const clippedCrop = await createSourcePageCropAsset({
      kind: 'table',
      cropBox: {
        ...fixture.asset.sourceBoxes[0],
        width: fixture.asset.sourceBoxes[0].width / 2,
        height: fixture.asset.sourceBoxes[0].height / 2,
      },
      sourceObjectIds: fixture.asset.sourceObjectIds,
      sourceBoxes: fixture.asset.sourceBoxes,
      width,
      height,
      pixels,
    })
    expect(
      validatedPdfVisualRelationships({
        paper: {
          ...paper,
          nodes: paper.nodes.map((node) =>
            node.type === 'figure'
              ? {
                  ...node,
                  relationships: {
                    ...node.relationships,
                    assets: [clippedCrop.id],
                  },
                }
              : node,
          ),
        },
        provenance: fixture.provenance,
        relationships: [{ ...relationship, assetIds: [clippedCrop.id] }],
        assets: [clippedCrop],
      }),
    ).toEqual([])

    const assessed = assessPdfCompleteness({
      pages: [fixture.page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [crop],
      lineBoundaryDecisions: [fixture.decision],
    })

    expect(assessed.completeness.assetCoverage).toBe(1)
    expect(assessed.completeness.relationshipCoverage).toBe(0)
    expect(assessed.completeness.unresolvedObjects.tables).toBe(1)
    expect(assessed.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_SEMANTIC_OBJECTS',
    )
  })

  it('does not resolve empty, one-cell, or headerless semantic-table claims', () => {
    const fixture = strictTableBoundaryFixture()
    const cell = (text: string, headerScope: 'column' | null) => ({
      text,
      headerScope,
      columnSpan: 1,
      rowSpan: 1,
    })
    const invalidTables: Array<
      NonNullable<
        Extract<ResearchPaper['nodes'][number], { type: 'figure' }>['table']
      >
    > = [
      { rows: [] },
      { rows: [{ cells: [cell('Only', 'column')] }] },
      {
        rows: [
          { cells: [cell('A', null), cell('B', null)] },
          { cells: [cell('1', null), cell('2', null)] },
        ],
      },
    ]

    for (const table of invalidTables) {
      const paper: ResearchPaper = structuredClone(fixture.paper)
      const node = paper.nodes.find((candidate) => candidate.type === 'figure')
      if (!node || node.type !== 'figure') throw new Error('missing table node')
      node.table = table
      const assessed = assessPdfCompleteness({
        pages: [fixture.page],
        paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        lineBoundaryDecisions: [fixture.decision],
      })

      expect(assessed.completeness.relationshipCoverage).toBe(0)
      expect(assessed.completeness.unresolvedObjects.tables).toBe(1)
      expect(assessed.readiness.blockingDiagnosticCodes).toContain(
        'UNRESOLVED_SEMANTIC_OBJECTS',
      )
    }
  })

  it('keeps an unresolved rejected table transition corrupting', () => {
    const fixture = strictTableBoundaryFixture()
    const rejected = {
      ...fixture.relationship,
      status: 'unresolved',
    } satisfies PdfVisualRelationship

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [fixture.decision],
      paper: fixture.paper,
      provenance: fixture.provenance,
      visualRelationships: [rejected],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [{ outcome: 'unresolved' }],
    })
  })

  it('reverts a stale structural boundary when strict ownership no longer holds', () => {
    const fixture = strictTableBoundaryFixture()
    const rejected = {
      ...fixture.relationship,
      status: 'unresolved',
    } satisfies PdfVisualRelationship
    const staleDecision = {
      ...fixture.decision,
      outcome: 'structural-boundary',
      evidence: [...fixture.decision.evidence, 'strict-visual-only-region'],
    } satisfies PdfLineBoundaryDecision

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [staleDecision],
      paper: fixture.paper,
      provenance: fixture.provenance,
      visualRelationships: [rejected],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [
        {
          outcome: 'unresolved',
          evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
        },
      ],
    })
  })

  it('keeps a mixed prose-and-table transition corrupting', () => {
    const fixture = strictTableBoundaryFixture()
    const paper = {
      ...fixture.paper,
      nodes: [
        ...fixture.paper.nodes,
        {
          id: 'shared-prose',
          type: 'paragraph',
          text: 'inter-national',
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      ...fixture.provenance,
      'shared-prose': {
        confidence: 1,
        pages: [1],
        regionIds: [fixture.decision.regionId],
        boxes: [
          {
            page: 1,
            x: 0.2,
            y: 0.3,
            width: 0.14,
            height: 0.043,
            rotation: 0,
            method: 'pdf-text',
          },
        ],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [fixture.decision],
      paper,
      provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [{ outcome: 'unresolved' }],
    })
  })

  it('keeps partial table transitions corrupting when the selected cells do not replay their source lines', () => {
    const fixture = strictTableBoundaryFixture()
    const tableRegion = fixture.regions.find(
      (region) => region.id === fixture.decision.regionId,
    )!
    const sourceRun = tableRegion.lines[0].runs[0]
    tableRegion.lines = [
      { ...tableRegion.lines[0], id: 'prose-line-1', text: 'retained-' },
      { ...tableRegion.lines[1], id: 'prose-line-2', text: 'prose-' },
      { ...tableRegion.lines[0], id: 'table-line-1', text: 'header-' },
      { ...tableRegion.lines[1], id: 'table-line-2', text: 'value' },
    ]
    tableRegion.text = 'retained-prose-header-value'
    const relationship: PdfVisualRelationship = {
      ...fixture.relationship,
      sourceLineIds: ['table-line-1', 'table-line-2'],
    }
    const paper: ResearchPaper = {
      ...fixture.paper,
      nodes: [
        ...fixture.paper.nodes,
        {
          id: 'retained-prose',
          type: 'paragraph',
          text: 'retained-prose-',
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      ...fixture.provenance,
      'retained-prose': {
        confidence: 1,
        pages: [1],
        regionIds: [tableRegion.id],
        boxes: [{ ...sourceRun }],
        links: [],
      },
    }
    const decisions = tableRegion.lines.slice(1).map((line, index) => ({
      id: `partial-boundary-${index + 1}`,
      page: 1,
      regionId: tableRegion.id,
      fromLineId: tableRegion.lines[index].id,
      toLineId: line.id,
      outcome: 'unresolved' as const,
      evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
    }))

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions,
      paper,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 3,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [
        {
          fromLineId: 'prose-line-1',
          toLineId: 'prose-line-2',
          outcome: 'unresolved',
        },
        {
          fromLineId: 'prose-line-2',
          toLineId: 'table-line-1',
          outcome: 'unresolved',
        },
        {
          fromLineId: 'table-line-1',
          toLineId: 'table-line-2',
          outcome: 'unresolved',
        },
      ],
    })
  })

  it('fails closed when canonical prose preserves characters but changes their order', () => {
    const sourceRun = run('abc', 0.1, 0.2)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
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
          id: 'paragraph-1',
          type: 'paragraph',
          text: 'cba',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_TEXT_COVERAGE',
    )
  })

  it('keeps an exact ordered match above the large-component threshold', () => {
    const sourceText = Array.from({ length: 1_001 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index),
    ).join('')
    const outputText = `${sourceText.slice(0, 500)}a${sourceText.slice(500)}`
    const sourceRun = run(sourceText, 0.1, 0.2, 10, 0.8)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceText.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const paper: ResearchPaper = {
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
          id: 'paragraph-1',
          type: 'paragraph',
          text: outputText,
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
      sourceTextCharacters: 1_001,
      outputTextCharacters: 1_002,
      matchedTextCharacters: 1_001,
    })
    expect(result.completeness.textCoverage).toBeLessThan(1)
  })

  it('still rejects large reordered prose above the exact-LCS threshold', () => {
    const sourceText = `${'a'.repeat(600)}${'b'.repeat(600)}`
    const outputText = `${'b'.repeat(600)}${'a'.repeat(600)}`
    const sourceRun = run(sourceText, 0.1, 0.2, 10, 0.8)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceText.length,
      imageCount: 0,
      runs: [sourceRun],
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
          id: 'paragraph-1',
          type: 'paragraph',
          text: outputText,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.matchedTextCharacters).toBe(600)
    expect(result.completeness.textCoverage).toBe(0.5)
    expect(result.readiness.ready).toBe(false)
  })

  it('does not misclassify one reordered canonical span as a duplicate', () => {
    const sourceRun = run(
      'Gamma delta precedes alpha beta in the source.',
      0.1,
      0.2,
      10,
      0.6,
    )
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
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
          id: 'paragraph-1',
          type: 'paragraph',
          text: 'Alpha beta follows gamma delta in the source.',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.completeness.duplicateCanonicalSpanCount).toBe(0)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_TEXT_COVERAGE',
    )
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'DUPLICATE_CANONICAL_SPAN',
    )
  })

  it('fails closed when a canonical span is duplicated', () => {
    const value = 'Alpha beta gamma delta.'
    const sourceRun = run(value, 0.1, 0.2, 10, 0.5)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const paragraph = (id: string) => ({
      id,
      type: 'paragraph' as const,
      text: value,
      source: 'test',
    })
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [paragraph('paragraph-1'), paragraph('paragraph-2')],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.duplicateCanonicalSpanCount).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'DUPLICATE_CANONICAL_SPAN',
    )
  })

  it('fails closed when metadata titles or adjacent headings repeat as canonical roles', () => {
    const titleRun = run('Paper Title', 0.1, 0.1, 16, 0.3)
    const firstMethodRun = run('Method', 0.1, 0.2, 14, 0.2)
    const secondMethodRun = run('Method', 0.1, 0.3, 14, 0.2)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters:
        titleRun.text.length +
        firstMethodRun.text.length +
        secondMethodRun.text.length,
      imageCount: 0,
      runs: [titleRun, firstMethodRun, secondMethodRun],
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper Title',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'title-heading',
          type: 'heading',
          level: 1,
          text: 'Paper Title',
          source: 'test',
        },
        {
          id: 'method-one',
          type: 'heading',
          level: 2,
          text: 'Method',
          source: 'test',
        },
        {
          id: 'method-two',
          type: 'heading',
          level: 2,
          text: 'Method',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'DUPLICATE_CANONICAL_ROLE',
    )
  })

  it('allows one source-backed canonical node to carry the publication title role', () => {
    const titleRun = run('Paper Title', 0.1, 0.1, 16, 0.3)
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: titleRun.text,
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'title-heading',
          type: 'heading',
          level: 1,
          text: titleRun.text,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: titleRun.text.length,
          imageCount: 0,
          runs: [titleRun],
        },
      ],
      paper,
      diagnostics: [],
    })

    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'DUPLICATE_CANONICAL_ROLE',
    )
  })

  it('fails closed when canonical prose reverses source reading-order intervals', () => {
    const firstRun = run('First source paragraph.', 0.1, 0.2, 10, 0.6)
    const secondRun = run('Second source paragraph.', 0.1, 0.3, 10, 0.6)
    const sourceRegion = (id: string, sourceRun: PdfSourceRun) => ({
      id,
      page: 1,
      kind: 'body' as const,
      column: 'single' as const,
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
    })
    const firstRegion = sourceRegion('first-region', firstRun)
    const secondRegion = sourceRegion('second-region', secondRun)
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
          id: 'second-node',
          type: 'paragraph',
          text: secondRun.text,
          source: 'test',
        },
        {
          id: 'first-node',
          type: 'paragraph',
          text: firstRun.text,
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'first-node': {
        confidence: 1,
        pages: [1],
        regionIds: [firstRegion.id],
        boxes: [{ ...firstRegion.box }],
        links: [],
      },
      'second-node': {
        confidence: 1,
        pages: [1],
        regionIds: [secondRegion.id],
        boxes: [{ ...secondRegion.box }],
        links: [],
      },
    }
    const readingOrder: PdfReadingOrderGraph = {
      schemaVersion: '1.0.0',
      regionIds: [firstRegion.id, secondRegion.id],
      order: [firstRegion.id, secondRegion.id],
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
    }

    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: firstRun.text.length + secondRun.text.length,
          imageCount: 0,
          runs: [firstRun, secondRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [firstRegion, secondRegion],
      readingOrder,
      provenance,
    })

    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
    expect(result.completeness.readingOrderDiagnostics).toBe(1)
    expect(result.completeness.readingOrderEvaluation).toMatchObject({
      regionCount: 2,
      unresolvedEdgeCount: 0,
      reviewRequired: true,
    })
  })

  it('fails closed on a small same-region line reversal above the coverage threshold', () => {
    const sourceRuns = [
      run('a'.repeat(700), 0.1, 0.2, 10, 0.6),
      run('second marker', 0.1, 0.23, 10, 0.3),
      run('third marker', 0.1, 0.26, 10, 0.3),
      run('z'.repeat(700), 0.1, 0.29, 10, 0.6),
    ]
    const region: PdfPageRegion = {
      id: 'shared-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: sourceRuns.map((sourceRun) => sourceRun.text).join(' '),
      confidence: 1,
      box: {
        ...sourceRuns[0],
        height:
          sourceRuns.at(-1)!.y + sourceRuns.at(-1)!.height - sourceRuns[0].y,
      },
      lines: sourceRuns.map((sourceRun, index) => ({
        id: `shared-line-${index + 1}`,
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [{ ...sourceRun }],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const nodeOrder = [0, 2, 1, 3]
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: nodeOrder.map((sourceIndex) => ({
        id: `node-${sourceIndex + 1}`,
        type: 'paragraph' as const,
        text: sourceRuns[sourceIndex].text,
        source: 'test',
      })),
    }
    const provenance: Record<string, NodeSourceEvidence> = Object.fromEntries(
      sourceRuns.map(
        (sourceRun, index) =>
          [
            `node-${index + 1}`,
            {
              confidence: 1,
              pages: [1],
              regionIds: [region.id],
              boxes: [{ ...sourceRun }],
              links: [],
            },
          ] satisfies [string, NodeSourceEvidence],
      ),
    )
    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRuns.reduce(
            (total, sourceRun) => total + sourceRun.text.length,
            0,
          ),
          imageCount: 0,
          runs: sourceRuns,
        },
      ],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder: {
        schemaVersion: '1.0.0',
        regionIds: [region.id],
        order: [region.id],
        edges: [],
        resolutions: [],
        acyclic: true,
        evaluation: {
          schemaVersion: '1.0.0',
          algorithm: 'deterministic-geometry-v1',
          mode: 'deterministic-only',
          regionCount: 1,
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
      },
      provenance,
    })

    expect(result.completeness.textCoverage).toBeGreaterThan(0.98)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('fails closed on a small same-region omission above the coverage threshold', () => {
    const retainedRun = run('a'.repeat(1_000), 0.1, 0.2, 10, 0.6)
    const omittedRun = run('omitted marker', 0.1, 0.23, 10, 0.3)
    const region: PdfPageRegion = {
      id: 'partially-rendered-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: `${retainedRun.text} ${omittedRun.text}`,
      confidence: 1,
      box: {
        ...retainedRun,
        height: omittedRun.y + omittedRun.height - retainedRun.y,
      },
      lines: [retainedRun, omittedRun].map((sourceRun, index) => ({
        id: `partial-line-${index + 1}`,
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [{ ...sourceRun }],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
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
          id: 'retained-node',
          type: 'paragraph',
          text: retainedRun.text,
          source: 'test',
        },
      ],
    }
    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: retainedRun.text.length + omittedRun.text.length,
          imageCount: 0,
          runs: [retainedRun, omittedRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder: {
        schemaVersion: '1.0.0',
        regionIds: [region.id],
        order: [region.id],
        edges: [],
        resolutions: [],
        acyclic: true,
        evaluation: {
          schemaVersion: '1.0.0',
          algorithm: 'deterministic-geometry-v1',
          mode: 'deterministic-only',
          regionCount: 1,
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
      },
      provenance: {
        'retained-node': {
          confidence: 1,
          pages: [1],
          regionIds: [region.id],
          boxes: [{ ...retainedRun }],
          links: [],
        },
      },
    })

    expect(result.completeness.textCoverage).toBeGreaterThan(0.98)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it.each([
    {
      name: 'numeric page range',
      source: ['Conference proceedings, pp. 36–', '49. IEEE Press.'],
      output: 'Conference proceedings, pp. 36–49. IEEE Press.',
    },
    {
      name: 'hyphenated identifier',
      source: ['ISBN 979-8-4007-0103-', '0. ACM Press.'],
      output: 'ISBN 979-8-4007-0103-0. ACM Press.',
    },
    {
      name: 'four-digit year',
      source: ['Example venue, 202', '0. doi: 10.1000/example.'],
      output: 'Example venue, 2020. doi: 10.1000/example.',
    },
  ])(
    'accepts a source-proven numeric fragment join across regions for $name',
    ({ source, output }) => {
      const sourceRuns = source.map((text, index) =>
        run(text, index === 0 ? 0.1 : 0.12, 0.2 + index * 0.05, 10, 0.7),
      )
      const regions = sourceRuns.map(
        (sourceRun, index) =>
          ({
            id: `numeric-fragment-region-${index + 1}`,
            page: 1,
            kind: 'body',
            column: 'single',
            text: sourceRun.text,
            confidence: 1,
            box: { ...sourceRun },
            lines: [
              {
                id: `numeric-fragment-line-${index + 1}`,
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
      const paper: ResearchPaper = {
        id: 'paper',
        version: '1.0.0',
        status: 'working',
        title: output,
        subtitle: 'Test',
        authors: ['Test'],
        updated: '2026-07-14',
        abstract: 'Test',
        nodes: [
          {
            id: 'numeric-fragment-node',
            type: 'paragraph',
            text: output,
            source: 'test',
          },
        ],
      }
      const result = assessPdfCompleteness({
        pages: [
          {
            page: 1,
            kind: 'born-digital',
            width: 612,
            height: 792,
            rotation: 0,
            textCharacters: source.reduce(
              (total, text) => total + text.length,
              0,
            ),
            imageCount: 0,
            runs: sourceRuns,
          },
        ],
        paper,
        diagnostics: [],
        regions,
        readingOrder: {
          schemaVersion: '1.0.0',
          regionIds: regions.map((region) => region.id),
          order: regions.map((region) => region.id),
          edges: [],
          resolutions: [],
          acyclic: true,
          evaluation: {
            schemaVersion: '1.0.0',
            algorithm: 'deterministic-geometry-v1',
            mode: 'deterministic-only',
            regionCount: regions.length,
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
        },
        provenance: {
          'numeric-fragment-node': {
            confidence: 1,
            pages: [1],
            regionIds: regions.map((region) => region.id),
            boxes: sourceRuns.map((sourceRun) => ({ ...sourceRun })),
            links: [],
          },
        },
      })

      expect(result.readiness.blockingDiagnosticCodes).not.toContain(
        'CANONICAL_FLOW_ORDER_VIOLATION',
      )
    },
  )

  it.each([
    {
      name: 'scientific operators and signs',
      source: 'The estimate is −0.5 ≤ p < 0.01.',
      output: 'The estimate is 0.5 p 0.01.',
    },
    {
      name: 'word boundaries',
      source: 'The model is robust.',
      output: 'Themodel is robust.',
    },
  ])(
    'fails closed when normalized character coverage hides changed $name',
    ({ source, output }) => {
      const sourceRun = run(source, 0.1, 0.2, 10, 0.7)
      const region: PdfPageRegion = {
        id: 'semantic-text-region',
        page: 1,
        kind: 'body',
        column: 'single',
        text: source,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: 'semantic-text-line',
            text: source,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [{ ...sourceRun }],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
      const result = assessPdfCompleteness({
        pages: [
          {
            page: 1,
            kind: 'born-digital',
            width: 612,
            height: 792,
            rotation: 0,
            textCharacters: source.length,
            imageCount: 0,
            runs: [sourceRun],
          },
        ],
        paper: {
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
              id: 'semantic-text-node',
              type: 'paragraph',
              text: output,
              source: 'test',
            },
          ],
        },
        diagnostics: [],
        regions: [region],
        readingOrder: {
          schemaVersion: '1.0.0',
          regionIds: [region.id],
          order: [region.id],
          edges: [],
          resolutions: [],
          acyclic: true,
          evaluation: {
            schemaVersion: '1.0.0',
            algorithm: 'deterministic-geometry-v1',
            mode: 'deterministic-only',
            regionCount: 1,
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
        },
        provenance: {
          'semantic-text-node': {
            confidence: 1,
            pages: [1],
            regionIds: [region.id],
            boxes: [{ ...sourceRun }],
            links: [],
          },
        },
      })

      expect(result.completeness.textCoverage).toBe(1)
      expect(result.readiness.blockingDiagnosticCodes).toContain(
        'CANONICAL_FLOW_ORDER_VIOLATION',
      )
    },
  )

  it('allows complete ordered canonical fragments from one styled source line', () => {
    const headingRun = run('Background', 0.1, 0.2, 12, 0.16)
    const paragraphRun = run('This is the complete prose.', 0.27, 0.2, 10, 0.43)
    const region: PdfPageRegion = {
      id: 'styled-line-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: `${headingRun.text} ${paragraphRun.text}`,
      confidence: 1,
      box: {
        ...headingRun,
        width: paragraphRun.x + paragraphRun.width - headingRun.x,
      },
      lines: [
        {
          id: 'styled-line',
          text: `${headingRun.text} ${paragraphRun.text}`,
          fontSize: headingRun.fontSize,
          box: {
            ...headingRun,
            width: paragraphRun.x + paragraphRun.width - headingRun.x,
          },
          runs: [{ ...headingRun }, { ...paragraphRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
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
          id: 'background-heading',
          type: 'heading',
          level: 2,
          text: headingRun.text,
          source: 'test',
        },
        {
          id: 'background-paragraph',
          type: 'paragraph',
          text: paragraphRun.text,
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'background-heading': {
        confidence: 1,
        pages: [1],
        regionIds: [region.id],
        boxes: [{ ...headingRun }],
        links: [],
      },
      'background-paragraph': {
        confidence: 1,
        pages: [1],
        regionIds: [region.id],
        boxes: [{ ...paragraphRun }],
        links: [],
      },
    }
    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: headingRun.text.length + paragraphRun.text.length,
          imageCount: 0,
          runs: [headingRun, paragraphRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder: {
        schemaVersion: '1.0.0',
        regionIds: [region.id],
        order: [region.id],
        edges: [],
        resolutions: [],
        acyclic: true,
        evaluation: {
          schemaVersion: '1.0.0',
          algorithm: 'deterministic-geometry-v1',
          mode: 'deterministic-only',
          regionCount: 1,
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
      },
      provenance,
    })

    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('does not treat floating visual provenance as canonical prose flow', () => {
    const firstRun = run('First source paragraph.', 0.1, 0.2, 10, 0.6)
    const secondRun = run('Second source paragraph.', 0.1, 0.3, 10, 0.6)
    const visualRun = run('Figure artwork.', 0.1, 0.7, 10, 0.6)
    const sourceRegion = (
      id: string,
      sourceRun: PdfSourceRun,
      kind: PdfPageRegion['kind'],
    ): PdfPageRegion => ({
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
    })
    const firstRegion = sourceRegion('first-region', firstRun, 'body')
    const secondRegion = sourceRegion('second-region', secondRun, 'body')
    const visualRegion = sourceRegion('visual-region', visualRun, 'figure')
    const paper = {
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
          id: 'first-node',
          type: 'paragraph',
          text: firstRun.text,
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
        {
          id: 'second-node',
          type: 'paragraph',
          text: secondRun.text,
          source: 'test',
        },
        {
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Synthetic visual.',
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance: Record<string, NodeSourceEvidence> = {
      'first-node': {
        confidence: 1,
        pages: [1],
        regionIds: [firstRegion.id],
        boxes: [{ ...firstRegion.box }],
        links: [],
      },
      'second-node': {
        confidence: 1,
        pages: [1],
        regionIds: [secondRegion.id],
        boxes: [{ ...secondRegion.box }],
        links: [],
      },
      'figure-1': {
        confidence: 1,
        pages: [1],
        regionIds: [visualRegion.id],
        boxes: [{ ...visualRegion.box }],
        links: [],
      },
    }
    const readingOrder: PdfReadingOrderGraph = {
      schemaVersion: '1.0.0',
      regionIds: [firstRegion.id, secondRegion.id, visualRegion.id],
      order: [firstRegion.id, secondRegion.id, visualRegion.id],
      edges: [],
      resolutions: [],
      acyclic: true,
      evaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 3,
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
    }

    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters:
            firstRun.text.length +
            secondRun.text.length +
            visualRun.text.length,
          imageCount: 1,
          runs: [firstRun, secondRun, visualRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [firstRegion, secondRegion, visualRegion],
      readingOrder,
      provenance,
    })

    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('fails closed when provenance omits an extra rendered canonical node', () => {
    const sourceRun = run('Source-backed canonical prose.', 0.1, 0.2, 10, 0.5)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
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
          id: 'paragraph-1',
          type: 'paragraph',
          text: sourceRun.text,
          source: 'test',
        },
        {
          id: 'invented-extra',
          type: 'paragraph',
          text: 'Invented rendered prose.',
          source: 'test',
        },
      ],
    }
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder,
      provenance: { 'paragraph-1': evidence },
    })

    expect(result.completeness.outputTextCharacters).toBeGreaterThan(
      result.completeness.sourceTextCharacters,
    )
    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_TEXT_COVERAGE',
    )
  })

  it('fails closed when separately provenanced nodes duplicate a partial source overlap', () => {
    const sourceRun = run('Alpha beta gamma delta.', 0.1, 0.2, 10, 0.5)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
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
          id: 'first-overlap',
          type: 'paragraph',
          text: 'Alpha beta gamma',
          source: 'test',
        },
        {
          id: 'second-overlap',
          type: 'paragraph',
          text: 'beta gamma delta.',
          source: 'test',
        },
      ],
    }
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder,
      provenance: {
        'first-overlap': evidence,
        'second-overlap': evidence,
      },
    })

    expect(result.completeness.matchedTextCharacters).toBe(
      result.completeness.sourceTextCharacters,
    )
    expect(result.completeness.outputTextCharacters).toBeGreaterThan(
      result.completeness.sourceTextCharacters,
    )
    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.readiness.ready).toBe(false)
  })

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

  it('requires OCR evidence for a mixed raster page with only sparse embedded text', () => {
    const fixture = sourceBackedEquationFixture()
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'mixed',
          imageCount: fixture.page.imageCount + 1,
          ocr: undefined,
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness.ocrRequiredPages).toEqual([1])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OCR_REQUIRED',
          severity: 'error',
          page: 1,
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining(['OCR_REQUIRED']),
    })
  })

  it('requires substantive internally valid OCR evidence for mixed and OCR-complete pages', () => {
    const fixture = sourceBackedEquationFixture()
    const evidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const invalidPages: PdfPageAnalysis[] = [
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: evidence,
      },
      {
        ...fixture.page,
        kind: 'ocr-complete',
        imageCount: fixture.page.imageCount + 1,
        ocr: undefined,
      },
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: { ...evidence, sourceSha256: 'not-a-sha256' },
      },
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: { ...evidence, sourceSha256: 'c'.repeat(64) },
      },
    ]

    for (const page of invalidPages) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        sourceSha256: 'a'.repeat(64),
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('accepts page-bound recovered OCR content with matching source identity', () => {
    const fixture = sourceBackedEquationFixture()
    const acceptedRun = {
      ...run('Recovered', 0.2, 0.5, 10, 0.2),
      method: 'ocr' as const,
      fontName: 'OCR',
    }
    const ocr = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [
        {
          text: acceptedRun.text,
          confidence: 1,
          lineId: 'ocr-line-1',
          box: { ...acceptedRun },
          mergeStatus: 'accepted',
        },
      ],
      lines: [
        {
          id: 'ocr-line-1',
          text: acceptedRun.text,
          confidence: 1,
          box: { ...acceptedRun },
        },
      ],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'mixed',
          imageCount: fixture.page.imageCount + 1,
          runs: [...fixture.page.runs, acceptedRun],
          ocr,
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      sourceSha256: 'a'.repeat(64),
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('accepts source-matched duplicate-only OCR confirmation for an embedded-only sparse page', () => {
    const fixture = sourceBackedEquationFixture()
    const embeddedRun = fixture.page.runs[0]
    const duplicateBox = {
      page: embeddedRun.page,
      x: embeddedRun.x,
      y: embeddedRun.y,
      width: embeddedRun.width,
      height: embeddedRun.height,
      rotation: embeddedRun.rotation,
      method: 'ocr' as const,
    }
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'ocr-complete',
          imageCount: 0,
          objects: [],
          textCharacters: embeddedRun.text.replace(/\s/gu, '').length,
          runs: [embeddedRun],
          ocr: {
            engine: 'local-engine',
            engineVersion: '1.0.0',
            model: 'local-model',
            modelVersion: '1.0.0',
            languages: ['eng'],
            languageMode: 'explicit',
            sourceSha256: 'a'.repeat(64),
            rasterSha256: 'b'.repeat(64),
            confidence: 0.99,
            words: [
              {
                text: embeddedRun.text,
                confidence: 0.99,
                lineId: 'ocr-line-1',
                box: duplicateBox,
                mergeStatus: 'duplicate',
              },
            ],
            lines: [],
          },
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      sourceSha256: 'a'.repeat(64),
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('rejects duplicate-only OCR evidence that is not embedded-only and source-matched', () => {
    const fixture = sourceBackedEquationFixture()
    const embeddedRun = fixture.page.runs[0]
    const duplicateEvidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 0.99,
      words: [
        {
          text: embeddedRun.text,
          confidence: 0.99,
          lineId: 'ocr-line-1',
          box: {
            page: embeddedRun.page,
            x: embeddedRun.x,
            y: embeddedRun.y,
            width: embeddedRun.width,
            height: embeddedRun.height,
            rotation: embeddedRun.rotation,
            method: 'ocr' as const,
          },
          mergeStatus: 'duplicate' as const,
        },
      ],
      lines: [],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const basePage = {
      ...fixture.page,
      kind: 'ocr-complete',
      imageCount: 0,
      objects: [],
      textCharacters: embeddedRun.text.replace(/\s/gu, '').length,
      runs: [embeddedRun],
      ocr: duplicateEvidence,
    } satisfies PdfPageAnalysis
    const invalidPages: PdfPageAnalysis[] = [
      {
        ...basePage,
        imageCount: 1,
        objects: fixture.page.objects,
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          words: [
            {
              ...duplicateEvidence.words[0],
              text: 'Fabricated text',
            },
          ],
        },
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          words: [
            {
              ...duplicateEvidence.words[0],
              box: {
                ...duplicateEvidence.words[0].box,
                x: 0.75,
              },
            },
          ],
        },
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          sourceSha256: 'c'.repeat(64),
        },
      },
    ]

    for (const page of invalidPages) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        sourceSha256: 'a'.repeat(64),
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('requires accepted OCR words to be page-bound and present in recovered runs', () => {
    const fixture = sourceBackedEquationFixture()
    const acceptedBox = {
      page: 1,
      x: 0.2,
      y: 0.5,
      width: 0.2,
      height: 0.02,
      rotation: 0,
      method: 'ocr' as const,
    }
    const evidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [
        {
          text: 'Recovered',
          confidence: 1,
          lineId: 'ocr-line-1',
          box: acceptedBox,
          mergeStatus: 'accepted',
        },
      ],
      lines: [
        {
          id: 'ocr-line-1',
          text: 'Recovered',
          confidence: 1,
          box: acceptedBox,
        },
      ],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const missingRecoveredRun = {
      ...fixture.page,
      kind: 'mixed',
      imageCount: fixture.page.imageCount + 1,
      ocr: evidence,
    } satisfies PdfPageAnalysis
    const outOfBounds = {
      ...fixture.page,
      kind: 'mixed',
      imageCount: fixture.page.imageCount + 1,
      runs: [
        ...fixture.page.runs,
        {
          ...fixture.page.runs[0],
          text: 'Recovered',
          method: 'ocr',
          x: 1.1,
          y: 0.5,
          width: 0.2,
          height: 0.02,
        },
      ],
      ocr: {
        ...evidence,
        words: [
          {
            ...evidence.words[0],
            box: { ...acceptedBox, x: 1.1 },
          },
        ],
        lines: [
          {
            ...evidence.lines[0],
            box: { ...acceptedBox, x: 1.1 },
          },
        ],
      },
    } satisfies PdfPageAnalysis

    for (const page of [missingRecoveredRun, outOfBounds]) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('does not require OCR when every mixed-page object is a validated semantic visual', () => {
    const fixture = sourceBackedEquationFixture()
    const result = assessPdfCompleteness({
      pages: [{ ...fixture.page, kind: 'mixed', ocr: undefined }],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('counts one validated multi-fragment figure crop as one semantic asset', async () => {
    const fixture = sourceBackedEquationFixture()
    const sourceObjectIds = Array.from(
      { length: 4 },
      (_, index) => `figure-fragment-${index + 1}`,
    )
    const sourceBoxes = sourceObjectIds.map((_, index) => ({
      page: 1,
      x: 0.2 + index * 0.06,
      y: 0.3 + (index % 2) * 0.05,
      width: 0.08,
      height: 0.08,
      rotation: 0,
      method: 'pdf-object' as const,
    }))
    const cropBox = {
      page: 1,
      x: 0.19,
      y: 0.29,
      width: 0.29,
      height: 0.15,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const pixels = new Uint8Array(8 * 8 * 4).fill(255)
    for (const pixel of [9, 18, 27, 36]) {
      pixels.fill(0, pixel * 4, pixel * 4 + 3)
      pixels[pixel * 4 + 3] = 255
    }
    const asset = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox,
      sourceObjectIds,
      sourceBoxes,
      width: 8,
      height: 8,
      pixels,
    })
    const captionNode = fixture.paper.nodes.find(
      (node) => node.type === 'caption',
    )!
    const paper = {
      ...fixture.paper,
      nodes: [
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: { caption: captionNode.id, assets: [asset.id] },
          source: 'test',
        },
        captionNode,
      ],
    } satisfies ResearchPaper
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      label: 'Figure 1',
      sourceRegionIds: ['figure-region'],
      sourceObjectIds,
      assetIds: [asset.id],
      sourceBoxes: [fixture.relationship.sourceBoxes[0], ...sourceBoxes],
      sourceText: '',
      canonicalNodeId: 'figure-1',
    } satisfies PdfVisualRelationship
    const page = {
      ...fixture.page,
      imageCount: 0,
      objects: sourceObjectIds.map((id, index) => ({
        id,
        page: 1,
        kind: 'vector' as const,
        box: sourceBoxes[index],
        confidence: 1,
        assetId: asset.id,
      })),
    } satisfies PdfPageAnalysis
    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: {
        ...fixture.provenance,
        'figure-1': {
          confidence: 1,
          pages: [1],
          regionIds: ['figure-region'],
          boxes: relationship.sourceBoxes,
          links: [],
        },
      },
      visualRelationships: [relationship],
      assets: [asset],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 1,
      exportedAssetCount: 1,
      assetCoverage: 1,
    })
  })

  it('counts connected orphan PDF components as one unresolved visual obligation', () => {
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
      sourceAssetCount: 2,
      exportedAssetCount: 0,
      assetCoverage: 0,
    })
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

  it('counts unmatched image operators when bbox extraction yields no objects', () => {
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
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
    })
    expect(result.readiness.ready).toBe(false)
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

  it('does not count figure placeholders as exported source-image payloads', () => {
    const runs = [run('Figure 1. Source image', 0.1, 0.2)]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 1,
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

  it('fails closed on a rendered superscript marker and bottom footnote', () => {
    const runs = [
      run('Body text', 0.1, 0.2, 10, 0.16),
      run('1', 0.262, 0.196, 6, 0.008, 0.009),
      run('1. Note text', 0.1, 0.82, 7, 0.3, 0.012),
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
          text: 'Body text 1 1. Note text',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.semanticSignals).toMatchObject({
      footnoteReferences: 1,
      footnotes: 1,
    })
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toEqual(
      expect.arrayContaining([
        'INCOMPLETE_RELATIONSHIP_COVERAGE',
        'UNRESOLVED_SEMANTIC_OBJECTS',
      ]),
    )
  })

  it.each([
    { label: 'forbidden C0 control', text: '\u0012' },
    { label: 'Unicode replacement glyph', text: 'term \ufffd value' },
  ])('blocks canonical text containing a $label', ({ text }) => {
    const sourceRun = run(text, 0.1, 0.2)
    const sourcePage: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: text.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const corruptPaper: ResearchPaper = {
      id: 'corrupt-text-paper',
      version: '1.0.0',
      status: 'working',
      title: 'Corrupt text',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'corrupt-node',
          type: 'paragraph',
          text,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [sourcePage],
      paper: corruptPaper,
      diagnostics: [],
    })

    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'EPUB_TEXT_SANITIZATION_LOSS',
    )
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'EPUB_TEXT_SANITIZATION_LOSS',
        severity: 'error',
      }),
    )
  })

  it('blocks an orphan canonical note backlink before EPUB rendering', () => {
    const sourceRun = run('Affiliation note', 0.1, 0.82)
    const sourcePage: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const notePaper: ResearchPaper = {
      id: 'orphan-note-paper',
      version: '1.0.0',
      status: 'working',
      title: 'Orphan note',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'orphan-note',
          type: 'footnote',
          kind: 'footnote',
          label: '1',
          text: sourceRun.text,
          relationships: { backlinks: ['page-001-author-region'] },
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [sourcePage],
      paper: notePaper,
      diagnostics: [],
    })

    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'DANGLING_EPUB_INTERNAL_REFERENCE',
    )
  })
})
