import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import {
  buildEpub,
  buildReadableEpub,
  inspectEpub,
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK,
  profileEpubCss,
  projectReadableFallbackReconstruction,
  renderPublicationXhtml,
} from './epub'
import {
  projectReadableFallbackReconstruction as projectReadableFallbackDirect,
} from './epub-readable-fallback'
import {
  createSourceGeometryScriptTranscript,
  SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
} from './equation-geometry-transcript'
import type {
  PdfPageAnalysis,
  PdfReconstruction,
  PdfSourceRun,
  PublicationAsset,
  PublicationVisualRelationship,
} from './import-types'
import {
  DistillationLedger,
  MODEL_FALLBACK_REFERENCE_FIXTURES,
  ModelConsultationGate,
  ModelFallbackLedger,
  validateModelConsultationReceipt,
  type ModelFallbackReceipt,
} from './model-fallback'
import {
  pdfModelConsultationSemanticStateSha256,
  resolvePdfModelFallbacks,
} from './model-fallback-pipeline'
import {
  attachRequiredSourcePageRenders,
  reconstructPdf,
  sourcePageRenderBudgetUsage,
} from './pdf'
import { reconstructPageAnalyses } from './pdf-layout'
import { assessPdfCompleteness } from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { researchPaperSchema } from './schema'
import { getTargetProfile, resolveTargetProfile } from './targets'
import { MAX_EPUB_ASSETS_PER_BOOK } from './publication-resource-limits'
import { createSourcePageCropAsset } from './visual-assets'

const paper = researchPaperSchema.parse(rawPaper)
function rezipEpub(files: Record<string, Uint8Array>) {
  return zipSync({
    mimetype: [files.mimetype, { level: 0 }],
    ...Object.fromEntries(
      Object.entries(files)
        .filter(([name]) => name !== 'mimetype')
        .map(([name, bytes]) => [name, [bytes, { level: 6 }]]),
    ),
  })
}
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

describe("EPUB publication profiles and asset boundaries", () => {
  it('escapes publication metadata rather than emitting invalid XHTML', async () => {
    const escaped = structuredClone(paper)
    escaped.title = 'Evidence & <meaning>'
    escaped.authors = ['A. "Reader" & Co.']
    const epub = await buildEpub(escaped)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])

    expect(content).toContain('Evidence &amp; &lt;meaning&gt;')
    expect(content).not.toContain('Evidence & <meaning>')
    expect(content).toContain('<title>Evidence &amp; &lt;meaning&gt;</title>')
    expect(opf).toContain('<dc:title>Evidence &amp; &lt;meaning&gt;</dc:title>')

    const placeholderTitle = {
      ...files,
      'EPUB/content.xhtml': strToU8(
        content.replace(
          '<title>Evidence &amp; &lt;meaning&gt;</title>',
          '<title>Publication</title>',
        ),
      ),
    }
    expect(() => inspectEpub(rezipEpub(placeholderTitle))).toThrow(
      /XHTML title.*OPF|OPF title.*XHTML/i,
    )
  })

  it('propagates authoritative publication language, direction, and dates independently of the device profile', async () => {
    const rtlPaper = {
      ...structuredClone(paper),
      language: 'ar',
      baseDirection: 'rtl' as const,
      publicationDate: '2024-08-19',
      artifactModifiedAt: '2026-07-23T00:42:00Z',
    }
    const profile = getTargetProfile('paperProMove')
    const epub = await buildEpub(rtlPaper, profile)
    const { files } = inspectEpub(epub.bytes, profile)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const nav = strFromU8(files['EPUB/nav.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])

    expect(content).toContain('xml:lang="ar" lang="ar" dir="rtl"')
    expect(nav).toContain('xml:lang="ar" lang="ar" dir="rtl"')
    expect(opf).toContain('xml:lang="ar"')
    expect(opf).toContain('<dc:language>ar</dc:language>')
    expect(opf).toContain('<dc:date>2024-08-19</dc:date>')
    expect(opf).toContain(
      '<meta property="dcterms:modified">2026-07-23T00:42:00Z</meta>',
    )
    expect(opf).toContain('page-progression-direction="rtl"')
    expect(opf).not.toContain(
      `page-progression-direction="${profile.epub.pageProgressionDirection}"`,
    )
  })

  it('renders third-order scholarly headings as h4 and mirrors their hierarchy in navigation', async () => {
    const hierarchyPaper = structuredClone(paper)
    hierarchyPaper.nodes = [
      {
        id: 'section-2',
        type: 'heading',
        level: 1,
        text: '2 Methods',
        source: 'synthetic-heading-hierarchy',
      },
      {
        id: 'section-2-2',
        type: 'heading',
        level: 2,
        text: '2.2 Patient profiles',
        source: 'synthetic-heading-hierarchy',
      },
      {
        id: 'section-2-2-1',
        type: 'heading',
        level: 3,
        text: '2.2.1 Patient cohort',
        source: 'synthetic-heading-hierarchy',
      },
    ]

    const epub = await buildEpub(hierarchyPaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const nav = strFromU8(files['EPUB/nav.xhtml'])

    expect(content).toContain(
      '<h2 id="section-2" data-canonical-id="section-2">2 Methods</h2>',
    )
    expect(content).toContain(
      '<h3 id="section-2-2" data-canonical-id="section-2-2">2.2 Patient profiles</h3>',
    )
    expect(content).toContain(
      '<h4 id="section-2-2-1" data-canonical-id="section-2-2-1">2.2.1 Patient cohort</h4>',
    )
    expect(nav).toMatch(
      /2 Methods<\/a><ol><li><a[^>]+>2\.2 Patient profiles<\/a><ol><li><a[^>]+>2\.2\.1 Patient cohort<\/a><\/li><\/ol><\/li><\/ol><\/li>/u,
    )
  })

  it('does not serialize a heading-level jump when source hierarchy starts below its proved parent', async () => {
    const hierarchyPaper = structuredClone(paper)
    hierarchyPaper.nodes = [
      {
        id: 'orphaned-third-order-heading',
        type: 'heading',
        level: 3,
        text: 'A deeply numbered heading without its source ancestors',
        source: 'synthetic-heading-jump',
      },
    ]

    const epub = await buildEpub(hierarchyPaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain(
      '<h2 id="orphaned-third-order-heading" data-canonical-id="orphaned-third-order-heading">A deeply numbered heading without its source ancestors</h2>',
    )
    expect(content).not.toContain('<h4 id="orphaned-third-order-heading"')
  })

  it('pairs EPUB note and bibliography types with their matching DPUB-ARIA roles', async () => {
    const semanticPaper = structuredClone(paper)
    semanticPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1]1.',
        noteReferences: [
          {
            id: 'note-reference-1',
            target: 'note-1',
            label: '1',
            start: 14,
            end: 15,
            confidence: 1,
          },
        ],
        inlineRuns: [
          {
            start: 11,
            end: 14,
            relationshipId: 'citation-1',
            semanticRole: 'citation',
            targetIds: ['reference-1'],
          },
        ],
        source: 'synthetic-dpub-aria-role-audit',
      },
      {
        id: 'note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'A note.',
        relationships: { backlinks: ['note-reference-1'] },
        source: 'synthetic-dpub-aria-role-audit',
      },
      {
        id: 'reference-1',
        type: 'paragraph',
        text: '[1] Reference entry.',
        source: 'synthetic-dpub-aria-role-audit',
      },
    ]

    const epub = await buildEpub(semanticPaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('epub:type="biblioref" role="doc-biblioref"')
    expect(content).toContain('epub:type="noteref" role="doc-noteref"')
    expect(content).not.toMatch(
      /<(?!a\b)[^>]+\bepub:type="(?:biblioref|noteref)"/u,
    )
    expect(content).not.toMatch(
      /<a\b(?=[^>]+\bepub:type="biblioref")(?![^>]+\brole="doc-biblioref")[^>]*>/u,
    )
    expect(content).not.toMatch(
      /<a\b(?=[^>]+\bepub:type="noteref")(?![^>]+\brole="doc-noteref")[^>]*>/u,
    )
  })

  it('uses und and omits unproven publication date and direction while preserving profile geometry', async () => {
    const unknownPaper = {
      ...structuredClone(paper),
      language: 'und',
      baseDirection: 'unknown' as const,
      publicationDate: undefined,
      artifactModifiedAt: '2026-07-23T00:42:00Z',
    }
    const profile = getTargetProfile('paperPro')
    const [unknown, baseline] = await Promise.all([
      buildEpub(unknownPaper, profile),
      buildEpub(paper, profile),
    ])
    const { files } = inspectEpub(unknown.bytes, profile)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const nav = strFromU8(files['EPUB/nav.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])
    const baselineFiles = inspectEpub(baseline.bytes, profile).files

    expect(content).toContain('xml:lang="und" lang="und"')
    expect(content).not.toMatch(/<html\b[^>]*\sdir=/)
    expect(nav).toContain('xml:lang="und" lang="und"')
    expect(nav).not.toMatch(/<html\b[^>]*\sdir=/)
    expect(opf).toContain('xml:lang="und"')
    expect(opf).toContain('<dc:language>und</dc:language>')
    expect(opf).not.toMatch(/<dc:date\b/)
    expect(opf).not.toContain('page-progression-direction=')
    expect(strFromU8(files['EPUB/styles.css'])).toBe(
      strFromU8(baselineFiles['EPUB/styles.css']),
    )
  })

  it('does not leave a trailing separator when a title slug is truncated', async () => {
    const longTitlePaper = structuredClone(paper)
    longTitlePaper.title = 'word '.repeat(30).trim()

    const epub = await buildEpub(longTitlePaper, getTargetProfile('paperPro'))

    expect(epub.fileName).toMatch(
      /^[a-z0-9]+(?:-[a-z0-9]+)*-paper-pro-[a-f0-9]{12}\.epub$/,
    )
  })

  it('derives deterministic device CSS and progression metadata from profiles', async () => {
    const paperPro = getTargetProfile('paperPro')
    const paperMove = getTargetProfile('paperProMove')
    const sameTitleDifferentPaper = structuredClone(paper)
    sameTitleDifferentPaper.id = `${paper.id}-second`
    const firstTextNode = sameTitleDifferentPaper.nodes.find(
      (
        node,
      ): node is Extract<
        (typeof sameTitleDifferentPaper.nodes)[number],
        { text: string }
      > => 'text' in node,
    )
    if (!firstTextNode) throw new Error('The EPUB identity fixture needs text.')
    firstTextNode.text += ' Distinct canonical content.'
    const [first, second, move, distinct] = await Promise.all([
      buildEpub(paper, paperPro),
      buildEpub(paper, undefined, paperPro),
      buildEpub(paper, paperMove),
      buildEpub(sameTitleDifferentPaper, paperPro),
    ])

    expect(first.bytes).toEqual(second.bytes)
    expect(first.bytes).not.toEqual(move.bytes)
    expect(distinct.fileName).not.toBe(first.fileName)

    const { files, manifest } = inspectEpub(first.bytes, paperPro)
    const moveManifest = inspectEpub(move.bytes, paperMove).manifest as {
      canonicalContentSha256: string
    }
    expect(first.fileName).toBe(
      `semantic-responsive-typesetting-paper-pro-${String(
        (manifest as { canonicalContentSha256: string }).canonicalContentSha256,
      ).slice(0, 12)}.epub`,
    )
    expect(move.fileName).toBe(
      `semantic-responsive-typesetting-paper-pro-move-${moveManifest.canonicalContentSha256.slice(0, 12)}.epub`,
    )
    expect(first.fileName).toMatch(/^[a-z0-9-]+\.epub$/)
    const css = strFromU8(files['EPUB/styles.css'])
    const opf = strFromU8(files['EPUB/package.opf'])
    expect(css).toContain(`font-family: ${paperPro.typography.fontFamily}`)
    expect(css).toContain(`font-size: ${paperPro.typography.bodySizeCssPx}px`)
    expect(css).not.toMatch(/(^|[;{]\s*)direction\s*:/m)
    expect(css).toContain('8.951% 8.025% 8.951% 8.025%')
    expect(css.match(/8\.951% 8\.025% 8\.951% 8\.025%/g)).toHaveLength(1)
    expect(css).toContain('@page { margin: 0; }')
    expect(css).toContain('main { max-width: none; padding:')
    expect(css).toContain(
      'h1, h2, h3, h4, p, figcaption, .orphan-caption, .publication-note, .publication-list, .publication-list-item { overflow-wrap: break-word; word-break: normal; }',
    )
    expect(css).toContain(
      'a, code, pre { overflow-wrap: anywhere; word-break: break-word; }',
    )
    const headingSizes = ['h2', 'h3', 'h4'].map((selector) => {
      const match = css.match(
        new RegExp(`${selector} \\{ font-size: (\\d+)px; \\}`),
      )
      expect(match, `${selector} profile rule`).not.toBeNull()
      return Number(match![1])
    })
    expect(headingSizes[0]).toBeGreaterThan(headingSizes[1])
    expect(headingSizes[1]).toBeGreaterThan(headingSizes[2])
    expect(headingSizes[2]).toBeGreaterThan(paperPro.typography.bodySizeCssPx)
    expect(css).toContain(
      '.publication-list { max-width: 100%; min-width: 0; margin: 0.8rem 0; padding-inline-start: 1.5rem; }',
    )
    expect(css).toContain('*, *::before, *::after { box-sizing: border-box; }')
    expect(css).toContain('main { box-sizing: border-box; width: 100%;')
    expect(css).toContain(
      '.semantic-table-wrapper { max-width: 100%; overflow-x: auto; }',
    )
    expect(css).toContain(
      '.omitted-table-transcript-source { max-width: 100%; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }',
    )
    expect(css).toContain(
      '.source-code { box-sizing: border-box; max-width: 100%; margin: 0; overflow-x: auto; overflow-y: hidden; overflow-wrap: normal;',
    )
    expect(css).toContain('white-space: pre; word-break: normal; }')
    expect(css).toContain(
      '.omitted-visual-transcript, .omitted-table-transcript { border-top: 0.06rem solid currentColor; margin-top: 0.75rem; padding-top: 0.75rem; }',
    )
    expect(css).toContain(
      '.semantic-table-figure, .semantic-table-wrapper, .semantic-table-wrapper table { break-inside: auto; }',
    )
    expect(css).toContain(
      '.semantic-table-wrapper thead { display: table-header-group; }',
    )
    expect(css).toContain(
      '.semantic-table-figure > figcaption { break-before: avoid; }',
    )
    expect(css).toContain('table-layout: fixed')
    expect(css).toContain(
      '.semantic-table-wrapper[data-wide-table="true"] table { min-width: 100%; table-layout: auto; width: auto; }',
    )
    expect(css).toContain(
      '.semantic-table-wrapper[data-wide-table="true"] th, .semantic-table-wrapper[data-wide-table="true"] td { min-width: 3.5rem; overflow-wrap: break-word; word-break: normal; }',
    )
    expect(opf).toContain(
      `page-progression-direction="${paperPro.epub.pageProgressionDirection}"`,
    )
    expect(opf).toContain(
      `<meta property="rendition:flow">${paperPro.epub.renditionFlow}</meta>`,
    )
    expect(manifest).toMatchObject({
      schemaVersion: '1.2.0',
      rendition: 'profile-tuned-reflowable-epub',
      profile: {
        id: 'paperPro',
        version: paperPro.version,
        dimensions: paperPro.dimensions,
        manufacturerDisplay: paperPro.manufacturerDisplay,
        preview: paperPro.preview,
        pixelsPerInch: paperPro.pixelsPerInch,
        compositionPolicy: { id: 'large-eink', version: '1.1.0' },
        exportPolicy: {
          id: 'profile-tuned-reflowable',
          version: '1.2.0',
        },
        truth: {
          geometry: 'authoritative',
          typography: 'advisory',
          pagination: 'reader-controlled',
          orientation: 'reader-controlled',
        },
      },
    })
  })

  it('binds a landscape EPUB filename, bytes, and manifest to transposed profile geometry', async () => {
    const portrait = getTargetProfile('paperPro')
    const landscape = resolveTargetProfile('paperPro', 'landscape')
    const [portraitEpub, landscapeEpub] = await Promise.all([
      buildEpub(paper, portrait),
      buildEpub(paper, landscape),
    ])
    const inspected = inspectEpub(landscapeEpub.bytes, landscape)

    expect(landscapeEpub.fileName).toContain('-paper-pro-landscape-')
    expect(landscapeEpub.bytes).not.toEqual(portraitEpub.bytes)
    expect(landscapeEpub.profile?.orientation.selected).toBe('landscape')
    expect(inspected.manifest).toMatchObject({
      profile: {
        orientation: {
          selected: 'landscape',
          supported: ['portrait', 'landscape'],
        },
        dimensions: {
          width: portrait.dimensions.height,
          height: portrait.dimensions.width,
        },
      },
    })
  })

  it('keeps heading hierarchy monotone and never forces source visuals wider than the viewport', () => {
    for (const profileId of [
      'mobile',
      'paperProMove',
      'paperPro',
      'print',
    ] as const) {
      const profile = getTargetProfile(profileId)
      const css = profileEpubCss(profile)
      const headingSizes = ['h2', 'h3', 'h4'].map((selector) => {
        const match = css.match(
          new RegExp(`${selector} \\{ font-size: (\\d+)px; \\}`),
        )
        expect(match, `${profileId} ${selector} profile rule`).not.toBeNull()
        return Number(match![1])
      })
      expect(headingSizes[0], `${profileId} h2 > h3`).toBeGreaterThan(
        headingSizes[1],
      )
      expect(headingSizes[1], `${profileId} h3 > h4`).toBeGreaterThan(
        headingSizes[2],
      )
      expect(headingSizes[2], `${profileId} h4 > body`).toBeGreaterThan(
        profile.typography.bodySizeCssPx,
      )
      expect(css).toContain(
        '.wide-source-visual-frame { max-width: 100%; overflow: visible; }',
      )
      expect(css).not.toContain(
        '.wide-source-visual-scroll[data-wide-source-visual="true"] img { max-width: none;',
      )
    }

    expect(profileEpubCss(getTargetProfile('mobile'))).not.toContain(
      'min-width: max(100%',
    )
    expect(profileEpubCss(getTargetProfile('paperProMove'))).not.toContain(
      'min-width: max(100%',
    )
  })

  it('rejects profiled EPUB styles that do not match the selected profile', async () => {
    const profile = getTargetProfile('paperPro')
    const epub = await buildEpub(paper, profile)
    const files = unzipSync(epub.bytes)
    const tampered = {
      ...files,
      'EPUB/styles.css': strToU8(
        strFromU8(files['EPUB/styles.css'])
          .replace(
            `html { font-size: ${profile.typography.bodySizeCssPx}px;`,
            'html { font-size: 1px;',
          )
          .replace(
            /main \{ max-width: none; padding: [^;]+;/,
            'main { max-width: none; padding: 0;',
          ),
      ),
    }

    expect(() => inspectEpub(rezipEpub(tampered), profile)).toThrow(
      /profile.*styles|styles.*profile/i,
    )
  })

  it('rejects stale profiled export schema, rendition, and policy metadata', async () => {
    const profile = getTargetProfile('paperProMove')
    const epub = await buildEpub(paper, profile)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, any>
    const mutations = [
      (manifest: Record<string, any>) => {
        manifest.schemaVersion = '0.0.0'
      },
      (manifest: Record<string, any>) => {
        manifest.rendition = 'reflowable-epub'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.exportPolicy.id = 'stale-policy'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.exportPolicy.version = '0.0.0'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.typography.bodySizeCssPx = 1
      },
    ]

    for (const mutate of mutations) {
      const manifest = structuredClone(originalManifest)
      mutate(manifest)
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      }

      expect(() => inspectEpub(rezipEpub(tampered), profile)).toThrow(
        /profiled export manifest contract/i,
      )
    }
  })

  it('retains more than 64 unique matched equation assets outside the optional cap', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const equations = await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        readableFallbackEquation(index + 1),
      ),
    )
    const projected = projectReadableFallbackReconstruction(
      withReadableFallbackEquations(reconstruction, equations),
    )
    const equationRelationships = projected.visualRelationships.filter(
      (relationship) => relationship.kind === 'equation',
    )
    const equationAssetIds = new Set(
      equationRelationships.flatMap((relationship) => relationship.assetIds),
    )

    expect(equationRelationships).toHaveLength(66)
    expect(equationAssetIds).toHaveLength(66)
    expect(projected.assets).toHaveLength(66)
    const epub = await buildReadableEpub(
      projected.paper,
      projected,
      getTargetProfile('paperPro'),
    )
    const content = strFromU8(
      inspectEpub(epub.bytes, getTargetProfile('paperPro')).files[
        'EPUB/content.xhtml'
      ],
    )
    expect(content.match(/data-object-type="equation"/gu)).toHaveLength(66)
    for (const relationship of equationRelationships) {
      expect(content).toContain(
        `id="${relationship.canonicalNodeId}" data-canonical-id="${relationship.canonicalNodeId}"`,
      )
    }
  })

  it('fails closed when relationships share a canonical or caption owner', async () => {
    const { reconstruction, relationship } =
      await staleEquationTranscriptFixture()
    for (const duplicate of [
      {
        ...relationship,
        id: 'duplicate-equation-canonical-owner',
        captionNodeId: 'independent-caption-owner',
      },
      {
        ...relationship,
        id: 'duplicate-equation-caption-owner',
        canonicalNodeId: 'independent-canonical-owner',
      },
    ]) {
      expect(() =>
        projectReadableFallbackReconstruction({
          ...reconstruction,
          visualRelationships: [relationship, duplicate],
        }),
      ).toThrow(/ambiguously share/u)
    }
  })

  it('fails before packaging an unbounded mandatory equation workset', async () => {
    const { reconstruction, relationship } =
      await staleEquationTranscriptFixture()
    const excessiveRelationships = Array.from(
      { length: MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK + 1 },
      (_, index) => ({
        ...relationship,
        id: `resource-bounded-equation-${index + 1}`,
      }),
    )
    expect(() =>
      projectReadableFallbackReconstruction({
        ...reconstruction,
        visualRelationships: excessiveRelationships,
      }),
    ).toThrow(/EPUB asset resource limit exceeded/u)

    expect(() =>
      projectReadableFallbackReconstruction({
        ...reconstruction,
        assets: [
          {
            ...reconstruction.assets[0],
            bytes: {
              byteLength: MAX_EPUB_ASSET_BYTES_PER_BOOK + 1,
            } as unknown as Uint8Array,
          },
        ],
      }),
    ).toThrow(/EPUB asset resource limit exceeded/u)
  })

  it('caps unique optional asset IDs without collapsing relationship ownership', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const uniqueFigures = Array.from({ length: 65 }, (_, index) =>
      readableFallbackFigure(index + 1),
    )
    const uniqueProjection = projectReadableFallbackReconstruction(
      withReadableFallbackFigures(reconstruction, uniqueFigures),
    )

    expect(
      uniqueProjection.visualRelationships.filter(
        (relationship) => relationship.kind === 'equation',
      ),
    ).toHaveLength(1)
    expect(
      uniqueProjection.visualRelationships.filter(
        (relationship) => relationship.kind === 'figure',
      ),
    ).toHaveLength(64)

    const crossKindSharedFigure = readableFallbackFigure(1)
    const crossKindOptionalFigures = [
      crossKindSharedFigure,
      ...Array.from({ length: 64 }, (_, index) =>
        readableFallbackFigure(index + 2),
      ),
    ]
    const crossKindEquation = readableFallbackEquationSharingFigureAsset(
      crossKindSharedFigure,
    )
    const crossKindBase = withReadableFallbackFigures(
      reconstruction,
      crossKindOptionalFigures,
    )
    const crossKindProjection = projectReadableFallbackReconstruction({
      ...crossKindBase,
      paper: {
        ...crossKindBase.paper,
        nodes: [...crossKindBase.paper.nodes, ...crossKindEquation.nodes],
      },
      provenance: {
        ...crossKindBase.provenance,
        ...crossKindEquation.provenance,
      },
      regions: [...crossKindBase.regions, crossKindEquation.region],
      visualRelationships: [
        ...reconstruction.visualRelationships,
        ...crossKindOptionalFigures.map((figure) => figure.relationship),
        crossKindEquation.relationship,
      ],
    })

    expect(
      crossKindProjection.visualRelationships.filter(
        (relationship) => relationship.kind === 'figure',
      ),
    ).toHaveLength(65)
    expect(crossKindProjection.assets).toHaveLength(66)
  })

  it('fails readable fallback explicitly for missing or invalid matched equation assets', async () => {
    const { reconstruction, relationship } =
      await staleEquationTranscriptFixture()
    const invalidReconstructions = [
      {
        name: 'missing',
        reconstruction: { ...reconstruction, assets: [] },
      },
      {
        name: 'invalid',
        reconstruction: {
          ...reconstruction,
          assets: [
            {
              ...reconstruction.assets[0],
              sha256: '0'.repeat(64),
            },
          ],
        },
      },
    ] satisfies Array<{ name: string; reconstruction: PdfReconstruction }>

    for (const fixture of invalidReconstructions) {
      let error: unknown
      try {
        projectReadableFallbackReconstruction(fixture.reconstruction)
      } catch (caught) {
        error = caught
      }
      expect(error, fixture.name).toMatchObject({
        code: 'INCOMPLETE_RECONSTRUCTION',
      })
      expect(String(error)).toContain(relationship.id)
    }
  })

  it('projects readable-fallback note backlinks onto anchors that can actually render', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'A claim with note 1.',
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
      sourceHash: 'b'.repeat(64),
      fileName: 'readable-note-projection.pdf',
      byteLength: 1024,
    })
    const paragraph = reconstruction.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text === run.text,
    )
    expect(paragraph?.type).toBe('paragraph')
    if (paragraph?.type !== 'paragraph') throw new Error('missing paragraph')
    paragraph.noteReferences = [
      {
        id: 'rendered-reference',
        label: '1',
        target: 'rendered-note',
        start: run.text.indexOf('1'),
        end: run.text.indexOf('1') + 1,
        confidence: 1,
      },
    ]
    reconstruction.paper.nodes.push(
      {
        id: 'rendered-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'A source-backed note.',
        relationships: {
          backlinks: ['rendered-reference', 'orphan-source-marker'],
        },
        source: 'pdf:synthetic#page=1',
      },
      {
        id: 'orphan-note',
        type: 'footnote',
        kind: 'footnote',
        label: '2',
        text: 'A note whose extracted marker cannot render.',
        relationships: { backlinks: ['another-orphan-source-marker'] },
        source: 'pdf:synthetic#page=1',
      },
    )
    const referenceStart = run.text.indexOf('1')
    reconstruction.noteRelationships.push({
      id: 'rendered-reference',
      label: '1',
      referenceRegionId: reconstruction.provenance[paragraph.id].regionIds[0],
      referenceStart,
      referenceEnd: referenceStart + 1,
      targetNoteId: 'rendered-note',
      status: 'matched',
      canonicalAnchor: {
        kind: 'node',
        nodeId: paragraph.id,
        start: referenceStart,
        end: referenceStart + 1,
      },
      confidence: 1,
      threshold: 0.72,
      evidence: ['synthetic-rendered-note-reference'],
      candidates: [],
      sourceBoxes: reconstruction.provenance[paragraph.id].boxes,
    })

    const fallback = await buildReadableEpub(
      reconstruction.paper,
      reconstruction,
    )
    const { files } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('id="rendered-reference"')
    expect(content).toContain('href="#rendered-reference"')
    expect(content).not.toContain('orphan-source-marker')
    expect(content).not.toContain('another-orphan-source-marker')
    expect(content).toContain('A note whose extracted marker cannot render.')
  })

  it('packages and renders a bounded source-page crop with its provenance', async () => {
    const titleRun: PdfSourceRun = {
      page: 1,
      text: 'Source page crop',
      x: 0.2,
      y: 0.08,
      width: 0.6,
      height: 0.035,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Heading',
      fontSize: 18,
      confidence: 1,
    }
    const bodyRun: PdfSourceRun = {
      page: 1,
      text: 'Readable source-crop body.',
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
    const captionRun: PdfSourceRun = {
      page: 1,
      text: 'Figure 1. Bounded source-page crop.',
      x: 0.15,
      y: 0.68,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Caption',
      fontSize: 9,
      confidence: 1,
    }
    const sourceRuns = [titleRun, bodyRun, captionRun]
    const reconstruction = await reconstructPageAnalyses({
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
          objects: [],
          runs: sourceRuns,
        },
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'source-page-crop.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.15,
      y: 0.35,
      width: 0.7,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const crop = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: sourceBox,
      sourceObjectIds: ['figure-source-region'],
      sourceBoxes: [sourceBox],
      width: 20,
      height: 10,
      pixels: new Uint8Array(20 * 10 * 4).fill(64),
    })
    const captionNode = reconstruction.paper.nodes.find(
      (node) => node.type === 'caption' && node.text === captionRun.text,
    )!
    const captionRegion = reconstruction.regions.find(
      (region) => region.kind === 'caption' && region.text === captionRun.text,
    )!
    const captionEvidence = reconstruction.provenance[captionNode.id]
    const figureNode = {
      id: 'source-crop-figure',
      type: 'figure' as const,
      objectType: 'figure' as const,
      title: 'Bounded source-page crop',
      relationships: {
        caption: captionNode.id,
        assets: [crop.id],
      },
      source: 'test',
    }
    const relationshipBoxes = [sourceBox, ...captionEvidence.boxes]
    const cropCandidate = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: reconstruction.paper.nodes.flatMap((node) =>
          node.id === captionNode.id ? [figureNode, node] : [node],
        ),
      },
      provenance: {
        ...reconstruction.provenance,
        [figureNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [captionRegion.id],
          boxes: relationshipBoxes,
          links: [],
        },
      },
      assets: [crop],
      visualRelationships: [
        {
          id: 'source-crop-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: captionRegion.id,
          sourceRegionIds: [captionRegion.id],
          sourceObjectIds: ['figure-source-region'],
          assetIds: [crop.id],
          status: 'matched' as const,
          confidence: 1,
          evidence: ['source-page-crop'],
          candidates: [],
          sourceBoxes: relationshipBoxes,
          sourceText: '',
          altText: captionRun.text,
          altTextSource: 'caption' as const,
          canonicalNodeId: figureNode.id,
          captionNodeId: captionNode.id,
        },
      ],
    } satisfies PdfReconstruction
    const cropAssessment = assessPdfCompleteness({
      pages: cropCandidate.pages,
      paper: cropCandidate.paper,
      diagnostics: cropCandidate.diagnostics.filter(
        (diagnostic) => diagnostic.severity !== 'error',
      ),
      readingOrder: cropCandidate.readingOrder,
      regions: cropCandidate.regions,
      visualRelationships: cropCandidate.visualRelationships,
      assets: cropCandidate.assets,
      citationRelationships: cropCandidate.citationRelationships,
      provenance: cropCandidate.provenance,
      lineBoundaryDecisions: cropCandidate.lineBoundaryDecisions,
      unresolvedCorruptingJoinCount:
        cropCandidate.unresolvedCorruptingJoinCount,
      structurallyConsumedLineBoundaryCount:
        cropCandidate.structurallyConsumedLineBoundaryCount,
      inlineSpanLedger: {
        expected: cropCandidate.completeness.expectedInlineSpanCount,
        mapped: cropCandidate.completeness.mappedInlineSpanCount,
      },
      policy: cropCandidate.readiness.policy,
    })
    const withCrop = {
      ...cropCandidate,
      semanticSignals: cropAssessment.semanticSignals,
      completeness: cropAssessment.completeness,
      diagnostics: cropAssessment.diagnostics,
      readiness: cropAssessment.readiness,
    } satisfies PdfReconstruction

    const epub = await buildReadableEpub(
      withCrop.paper,
      withCrop,
      getTargetProfile('paperPro'),
    )
    const { files, manifest } = inspectEpub(
      epub.bytes,
      getTargetProfile('paperPro'),
    )
    const content = strFromU8(files['EPUB/content.xhtml'])
    const packaged = (
      manifest.assets as Array<Record<string, unknown>> | undefined
    )?.find((asset) => asset.sourceAssetId === crop.id)

    expect(content).toContain(`<img src="${crop.href}"`)
    expect(files[`EPUB/${crop.href}`]).toEqual(crop.bytes)
    expect(packaged).toMatchObject({
      rendition: 'source-page-crop',
      sourceCropBox: sourceBox,
      sourceAssetId: crop.id,
    })
  })

})
