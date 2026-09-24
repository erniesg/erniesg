import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import type {
  PdfPageAnalysis,
  PdfReconstruction,
  PdfSourceRun,
  PublicationAsset,
  PublicationVisualRelationship,
} from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { assessPdfCompleteness } from './pdf-quality'
import { researchPaperSchema } from './schema'
import { createSourcePageCropAsset } from './visual-assets'

const paper = researchPaperSchema.parse(rawPaper)

async function staleEquationTranscriptFixture() {
  const captionRun: PdfSourceRun = {
    page: 1,
    text: 'Equation 1. Source-backed display.',
    x: 0.2,
    y: 0.4,
    width: 0.42,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize: 10,
    confidence: 1,
  }
  const firstRun: PdfSourceRun = {
    ...captionRun,
    text: 'q = r',
    x: 0.28,
    y: 0.3,
    width: 0.14,
    fontSize: 14,
  }
  const secondRun: PdfSourceRun = {
    ...firstRun,
    text: '+ s',
    y: 0.325,
    width: 0.08,
  }
  const titleRun: PdfSourceRun = {
    ...captionRun,
    text: 'Equation lineage',
    x: 0.12,
    y: 0.08,
    width: 0.36,
    fontSize: 18,
  }
  const authorRun: PdfSourceRun = {
    ...captionRun,
    text: 'Ada Researcher',
    x: 0.12,
    y: 0.14,
    width: 0.24,
    fontSize: 11,
  }
  const captionBox = { ...captionRun }
  const sourceBox = {
    page: 1,
    x: 0.27,
    y: 0.29,
    width: 0.2,
    height: 0.065,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const page: PdfPageAnalysis = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: [
      titleRun,
      authorRun,
      captionRun,
      firstRun,
      secondRun,
    ].reduce((total, run) => total + run.text.length, 0),
    imageCount: 1,
    objects: [
      {
        id: 'equation-source-object',
        page: 1,
        kind: 'image',
        box: sourceBox,
        confidence: 1,
        assetId: null,
      },
    ],
    runs: [titleRun, authorRun, firstRun, secondRun, captionRun],
  }
  const pixels = new Uint8Array(24 * 12 * 4).fill(255)
  for (let y = 3; y < 9; y += 1) {
    for (let x = 4; x < 20; x += 1) {
      const offset = (y * 24 + x) * 4
      pixels.set([20, 20, 20, 255], offset)
    }
  }
  const asset = await createSourcePageCropAsset({
    kind: 'equation',
    cropBox: sourceBox,
    sourceObjectIds: ['equation-source-object'],
    sourceBoxes: [sourceBox],
    width: 24,
    height: 12,
    pixels,
  })
  page.objects![0].assetId = asset.id
  const base = await reconstructPageAnalyses({
    pages: [page],
    sourceHash: 'e'.repeat(64),
    fileName: 'equation-lineage.pdf',
    byteLength: 1024,
  })
  const equationRegion = {
    id: 'equation-source-region',
    page: 1,
    kind: 'equation' as const,
    column: 'single' as const,
    text: `${firstRun.text} ${secondRun.text}`,
    confidence: 1,
    box: {
      ...firstRun,
      width: Math.max(firstRun.width, secondRun.width),
      height: secondRun.y + secondRun.height - firstRun.y,
    },
    lines: [
      {
        id: 'equation-source-line-1',
        text: firstRun.text,
        fontSize: firstRun.fontSize,
        box: { ...firstRun },
        runs: [{ ...firstRun }],
      },
      {
        id: 'equation-source-line-2',
        text: secondRun.text,
        fontSize: secondRun.fontSize,
        box: { ...secondRun },
        runs: [{ ...secondRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
  const captionRegion = {
    id: 'equation-caption-region',
    page: 1,
    kind: 'caption' as const,
    column: 'single' as const,
    text: captionRun.text,
    confidence: 1,
    box: { ...captionRun },
    lines: [
      {
        id: 'equation-caption-line',
        text: captionRun.text,
        fontSize: captionRun.fontSize,
        box: { ...captionRun },
        runs: [{ ...captionRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
  const titleRegion = {
    id: 'equation-title-region',
    page: 1,
    kind: 'spanning' as const,
    column: 'single' as const,
    text: titleRun.text,
    confidence: 1,
    box: { ...titleRun },
    lines: [
      {
        id: 'equation-title-line',
        text: titleRun.text,
        fontSize: titleRun.fontSize,
        box: { ...titleRun },
        runs: [{ ...titleRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
  const authorRegion = {
    id: 'equation-author-region',
    page: 1,
    kind: 'body' as const,
    column: 'single' as const,
    text: authorRun.text,
    confidence: 1,
    box: { ...authorRun },
    lines: [
      {
        id: 'equation-author-line',
        text: authorRun.text,
        fontSize: authorRun.fontSize,
        box: { ...authorRun },
        runs: [{ ...authorRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
  const equationPaper = structuredClone(paper)
  equationPaper.title = 'Equation lineage'
  equationPaper.authors = ['Ada Researcher']
  equationPaper.nodes = [
    {
      id: 'equation-title-node',
      type: 'heading',
      level: 1,
      text: titleRun.text,
      source: 'synthetic-equation-lineage',
    },
    {
      id: 'equation-author-node',
      type: 'paragraph',
      text: authorRun.text,
      source: 'synthetic-equation-lineage',
    },
    {
      id: 'equation-node',
      type: 'figure',
      objectType: 'equation',
      title: captionRun.text,
      relationships: {
        caption: 'equation-caption',
        assets: [asset.id],
      },
      source: 'synthetic-equation-lineage',
    },
    {
      id: 'equation-caption',
      type: 'caption',
      text: captionRun.text,
      source: 'synthetic-equation-lineage',
    },
  ]
  const relationship: PublicationVisualRelationship = {
    id: 'equation-lineage-relationship',
    kind: 'equation',
    label: 'Equation 1',
    captionRegionId: captionRegion.id,
    sourceRegionIds: [equationRegion.id],
    sourceLineIds: equationRegion.lines.map((line) => line.id),
    sourceObjectIds: ['equation-source-object'],
    assetIds: [asset.id],
    status: 'matched',
    confidence: 1,
    evidence: ['source-page-crop', 'source-text-alt'],
    candidates: [],
    sourceBoxes: [captionBox, sourceBox],
    sourceText: equationRegion.text,
    altText: captionRun.text,
    altTextSource: 'source-text',
    canonicalNodeId: 'equation-node',
    captionNodeId: 'equation-caption',
  }
  const lineBoundaryDecisions = [
    {
      id: 'equation-line-boundary-1',
      page: 1,
      regionId: equationRegion.id,
      fromLineId: equationRegion.lines[0].id,
      toLineId: equationRegion.lines[1].id,
      outcome: 'space' as const,
      evidence: ['synthetic-source-line-order'],
    },
  ]
  const readingOrder = {
    schemaVersion: '1.0.0' as const,
    regionIds: [
      titleRegion.id,
      authorRegion.id,
      equationRegion.id,
      captionRegion.id,
    ],
    order: [
      titleRegion.id,
      authorRegion.id,
      equationRegion.id,
      captionRegion.id,
    ],
    edges: [],
    resolutions: [],
    acyclic: true,
    evaluation: {
      schemaVersion: '1.0.0' as const,
      algorithm: 'deterministic-geometry-v1' as const,
      mode: 'deterministic-only' as const,
      regionCount: 4,
      acceptedEdgeCount: 0,
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      orderAccuracy: null,
      provider: null,
      modelVersion: null,
      latencyMs: 0 as const,
      costUsd: 0 as const,
      reviewRequired: false,
    },
  }
  const candidate = {
    ...base,
    paper: equationPaper,
    pages: [page],
    regions: [titleRegion, authorRegion, equationRegion, captionRegion],
    readingOrder,
    lineBoundaryDecisions,
    unresolvedCorruptingJoinCount: 0,
    structurallyConsumedLineBoundaryCount: 0,
    noteRelationships: [],
    citationRelationships: [],
    crossReferenceRelationships: [],
    visualRelationships: [relationship],
    assets: [asset],
    provenance: {
      'equation-title-node': {
        confidence: 1,
        pages: [1],
        regionIds: [titleRegion.id],
        boxes: [{ ...titleRun }],
        links: [],
      },
      'equation-author-node': {
        confidence: 1,
        pages: [1],
        regionIds: [authorRegion.id],
        boxes: [{ ...authorRun }],
        links: [],
      },
      'equation-node': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: relationship.sourceBoxes,
        links: [],
      },
      'equation-caption': {
        confidence: 1,
        pages: [1],
        regionIds: [captionRegion.id],
        boxes: [captionBox],
        links: [],
      },
    },
    diagnostics: [],
  } satisfies PdfReconstruction
  const assessment = assessPdfCompleteness({
    pages: candidate.pages,
    paper: candidate.paper,
    diagnostics: candidate.diagnostics,
    readingOrder: candidate.readingOrder,
    regions: candidate.regions,
    visualRelationships: candidate.visualRelationships,
    assets: candidate.assets,
    citationRelationships: candidate.citationRelationships,
    noteRelationships: candidate.noteRelationships,
    policy: candidate.readiness.policy,
    lineBoundaryDecisions: candidate.lineBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions:
      candidate.sourceSemanticFlowBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisionCount:
      candidate.sourceSemanticFlowBoundaryDecisionCount,
    canonicalHyphenBoundaryDecisions:
      candidate.canonicalHyphenBoundaryDecisions,
    canonicalHyphenBoundaryDecisionCount:
      candidate.canonicalHyphenBoundaryDecisionCount,
    unresolvedCorruptingJoinCount: candidate.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      candidate.structurallyConsumedLineBoundaryCount,
    provenance: candidate.provenance,
    sourceSha256: candidate.source.sha256,
  })
  const reconstruction = {
    ...candidate,
    semanticSignals: assessment.semanticSignals,
    completeness: assessment.completeness,
    diagnostics: assessment.diagnostics,
    readiness: assessment.readiness,
  } satisfies PdfReconstruction
  expect(reconstruction.readiness.blockingDiagnosticCodes).toEqual([])
  return { reconstruction, relationship, equationRegion }
}

function readableFallbackFigure(index: number) {
  const suffix = String(index).padStart(3, '0')
  const bytes = new TextEncoder().encode(`SOURCE-FIGURE-${suffix}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const assetId = `asset-${sha256.slice(0, 24)}`
  const sourceObjectId = `fallback-figure-object-${suffix}`
  const captionRegionId = `fallback-figure-caption-region-${suffix}`
  const nodeId = `fallback-figure-node-${suffix}`
  const captionNodeId = `fallback-figure-caption-${suffix}`
  const captionBox = {
    page: 1,
    x: 0.1,
    y: 0.5,
    width: 0.4,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const sourceBox = {
    page: 1,
    x: 0.1,
    y: 0.55,
    width: 0.2,
    height: 0.1,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const asset = {
    id: assetId,
    href: `assets/${assetId}.png`,
    mediaType: 'image/png' as const,
    kind: 'raster' as const,
    rendition: 'source-preserved' as const,
    sha256,
    bytes,
    width: 20,
    height: 10,
    resolutionDpi: null,
    sourceObjectIds: [sourceObjectId],
    sourceBoxes: [sourceBox],
  } satisfies PublicationAsset
  const captionText = `Figure ${index}. Readable fallback source figure.`
  const relationship = {
    id: `fallback-figure-relationship-${suffix}`,
    kind: 'figure' as const,
    label: `Figure ${index}`,
    captionRegionId,
    sourceRegionIds: [],
    sourceLineIds: [],
    sourceObjectIds: [sourceObjectId],
    assetIds: [asset.id],
    status: 'matched' as const,
    confidence: 1,
    evidence: ['source-preserved-raster'],
    candidates: [],
    sourceBoxes: [captionBox, sourceBox],
    sourceText: '',
    altText: captionText,
    altTextSource: 'caption' as const,
    canonicalNodeId: nodeId,
    captionNodeId,
  } satisfies PublicationVisualRelationship
  return {
    asset,
    relationship,
    nodes: [
      {
        id: nodeId,
        type: 'figure' as const,
        title: captionText,
        relationships: {
          caption: captionNodeId,
          assets: [asset.id],
        },
        source: 'synthetic-readable-fallback-figure',
      },
      {
        id: captionNodeId,
        type: 'caption' as const,
        text: captionText,
        source: 'synthetic-readable-fallback-figure',
      },
    ],
    provenance: {
      [nodeId]: {
        confidence: 1,
        pages: [1],
        regionIds: [],
        boxes: relationship.sourceBoxes,
        links: [],
      },
      [captionNodeId]: {
        confidence: 1,
        pages: [1],
        regionIds: [captionRegionId],
        boxes: [captionBox],
        links: [],
      },
    },
  }
}

function withReadableFallbackFigures(
  reconstruction: PdfReconstruction,
  figures: ReturnType<typeof readableFallbackFigure>[],
) {
  return {
    ...reconstruction,
    paper: {
      ...reconstruction.paper,
      nodes: [
        ...reconstruction.paper.nodes,
        ...figures.flatMap((figure) => figure.nodes),
      ],
    },
    provenance: {
      ...reconstruction.provenance,
      ...Object.assign({}, ...figures.map((figure) => figure.provenance)),
    },
    visualRelationships: [
      ...reconstruction.visualRelationships,
      ...figures.map((figure) => figure.relationship),
    ],
    assets: [
      ...reconstruction.assets,
      ...figures.map((figure) => figure.asset),
    ],
  } satisfies PdfReconstruction
}

async function readableFallbackEquation(index: number) {
  const suffix = String(index).padStart(3, '0')
  const sourceObjectId = `fallback-equation-object-${suffix}`
  const sourceRegionId = `fallback-equation-region-${suffix}`
  const sourceLineId = `fallback-equation-line-${suffix}`
  const captionRegionId = `fallback-equation-caption-region-${suffix}`
  const nodeId = `fallback-equation-node-${suffix}`
  const captionNodeId = `fallback-equation-caption-${suffix}`
  const captionBox = {
    page: 1,
    x: 0.2,
    y: 0.4,
    width: 0.42,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const lineBox = {
    page: 1,
    x: 0.28,
    y: 0.3,
    width: 0.14,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const sourceBox = {
    ...lineBox,
    x: 0.27,
    y: 0.29,
    width: 0.2,
    height: 0.05,
    method: 'pdf-object' as const,
  }
  const pixels = new Uint8Array(12 * 6 * 4).fill(255)
  for (let y = 1; y < 5; y += 1) {
    for (let x = 2; x < 10; x += 1) {
      pixels.set([20, 20, 20, 255], (y * 12 + x) * 4)
    }
  }
  const asset = await createSourcePageCropAsset({
    kind: 'equation',
    cropBox: sourceBox,
    sourceObjectIds: [sourceObjectId],
    sourceBoxes: [sourceBox],
    width: 12,
    height: 6,
    pixels,
  })
  const sourceText = `q${index} = r`
  const region = {
    id: sourceRegionId,
    page: 1,
    kind: 'equation' as const,
    column: 'single' as const,
    text: sourceText,
    confidence: 1,
    box: lineBox,
    lines: [
      {
        id: sourceLineId,
        text: sourceText,
        fontSize: 14,
        box: lineBox,
        runs: [
          {
            ...lineBox,
            text: sourceText,
            fontName: 'Synthetic-Math',
            fontSize: 14,
            confidence: 1,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfReconstruction['regions'][number]
  const captionText = `Equation ${index}. Readable fallback source equation.`
  const relationship = {
    id: `fallback-equation-relationship-${suffix}`,
    kind: 'equation' as const,
    label: `Equation ${index}`,
    captionRegionId,
    sourceRegionIds: [sourceRegionId],
    sourceLineIds: [sourceLineId],
    sourceObjectIds: [sourceObjectId],
    assetIds: [asset.id],
    status: 'matched' as const,
    confidence: 1,
    evidence: ['source-page-crop', 'source-text-alt'],
    candidates: [],
    sourceBoxes: [captionBox, sourceBox],
    sourceText,
    altText: captionText,
    altTextSource: 'source-text' as const,
    canonicalNodeId: nodeId,
    captionNodeId,
  } satisfies PublicationVisualRelationship
  return {
    asset,
    region,
    relationship,
    nodes: [
      {
        id: nodeId,
        type: 'figure' as const,
        objectType: 'equation' as const,
        title: captionText,
        relationships: {
          caption: captionNodeId,
          assets: [asset.id],
        },
        source: 'synthetic-readable-fallback-equation',
      },
      {
        id: captionNodeId,
        type: 'caption' as const,
        text: captionText,
        source: 'synthetic-readable-fallback-equation',
      },
    ],
    provenance: {
      [nodeId]: {
        confidence: 1,
        pages: [1],
        regionIds: [sourceRegionId],
        boxes: relationship.sourceBoxes,
        links: [],
      },
      [captionNodeId]: {
        confidence: 1,
        pages: [1],
        regionIds: [captionRegionId],
        boxes: [captionBox],
        links: [],
      },
    },
  }
}

function withReadableFallbackEquations(
  reconstruction: PdfReconstruction,
  equations: Awaited<ReturnType<typeof readableFallbackEquation>>[],
) {
  return {
    ...reconstruction,
    paper: {
      ...reconstruction.paper,
      nodes: [
        ...reconstruction.paper.nodes,
        ...equations.flatMap((equation) => equation.nodes),
      ],
    },
    provenance: {
      ...reconstruction.provenance,
      ...Object.assign({}, ...equations.map((equation) => equation.provenance)),
    },
    regions: [
      ...reconstruction.regions,
      ...equations.map((equation) => equation.region),
    ],
    visualRelationships: [
      ...reconstruction.visualRelationships,
      ...equations.map((equation) => equation.relationship),
    ],
    assets: [
      ...reconstruction.assets,
      ...equations.map((equation) => equation.asset),
    ],
  } satisfies PdfReconstruction
}

function readableFallbackEquationSharingFigureAsset(
  figure: ReturnType<typeof readableFallbackFigure>,
) {
  const sourceRegionId = 'shared-cross-kind-equation-region'
  const sourceLineId = 'shared-cross-kind-equation-line'
  const captionRegionId = 'shared-cross-kind-equation-caption-region'
  const nodeId = 'shared-cross-kind-equation-node'
  const captionNodeId = 'shared-cross-kind-equation-caption'
  const sourceBox = figure.asset.sourceBoxes[0]
  const lineBox = {
    ...sourceBox,
    method: 'pdf-text' as const,
  }
  const captionBox = {
    page: 1,
    x: 0.2,
    y: 0.4,
    width: 0.42,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const sourceText = 'q = r'
  const region = {
    id: sourceRegionId,
    page: 1,
    kind: 'equation' as const,
    column: 'single' as const,
    text: sourceText,
    confidence: 1,
    box: lineBox,
    lines: [
      {
        id: sourceLineId,
        text: sourceText,
        fontSize: 14,
        box: lineBox,
        runs: [
          {
            ...lineBox,
            text: sourceText,
            fontName: 'Synthetic-Math',
            fontSize: 14,
            confidence: 1,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfReconstruction['regions'][number]
  const relationship = {
    id: 'shared-cross-kind-equation-relationship',
    kind: 'equation' as const,
    label: 'Equation shared',
    captionRegionId,
    sourceRegionIds: [sourceRegionId],
    sourceLineIds: [sourceLineId],
    sourceObjectIds: [...figure.asset.sourceObjectIds],
    assetIds: [figure.asset.id],
    status: 'matched' as const,
    confidence: 1,
    evidence: ['source-preserved-raster', 'source-text-alt'],
    candidates: [],
    sourceBoxes: [captionBox, sourceBox],
    sourceText,
    altText: 'Equation shared. Source-backed display.',
    altTextSource: 'source-text' as const,
    canonicalNodeId: nodeId,
    captionNodeId,
  } satisfies PublicationVisualRelationship
  return {
    region,
    relationship,
    nodes: [
      {
        id: nodeId,
        type: 'figure' as const,
        objectType: 'equation' as const,
        title: relationship.altText,
        relationships: {
          caption: captionNodeId,
          assets: [figure.asset.id],
        },
        source: 'synthetic-shared-cross-kind-equation',
      },
      {
        id: captionNodeId,
        type: 'caption' as const,
        text: relationship.altText,
        source: 'synthetic-shared-cross-kind-equation',
      },
    ],
    provenance: {
      [nodeId]: {
        confidence: 1,
        pages: [1],
        regionIds: [sourceRegionId],
        boxes: relationship.sourceBoxes,
        links: [],
      },
      [captionNodeId]: {
        confidence: 1,
        pages: [1],
        regionIds: [captionRegionId],
        boxes: [captionBox],
        links: [],
      },
    },
  }
}

export {
  readableFallbackEquation,
  readableFallbackEquationSharingFigureAsset,
  readableFallbackFigure,
  staleEquationTranscriptFixture,
  withReadableFallbackEquations,
  withReadableFallbackFigures,
}
