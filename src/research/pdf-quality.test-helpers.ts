import { createHash } from 'node:crypto'
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

export function run(
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

export function normalizedLength(value: string) {
  return [...value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')].length
}

export function sourceBackedEquationFixture() {
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

export function assessSourceBackedEquation(
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

export function equationAssetWithPayload(
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
