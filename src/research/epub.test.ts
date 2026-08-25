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

function emptyModelConsultationReceipt(
  reconstruction: PdfReconstruction,
): ModelFallbackReceipt {
  const receipt: ModelFallbackReceipt = {
    schemaVersion: '1.0.0',
    documentId: reconstruction.paper.id,
    sourceSha256: reconstruction.source.sha256,
    consultations: [],
    decisions: [],
    metrics: {
      totalDecisionCount: 0,
      totalConsultationCount: 0,
      consultationRate: 0,
      byDecisionClass: {},
    },
  }
  receipt.semanticStateSha256 = pdfModelConsultationSemanticStateSha256(
    reconstruction,
    receipt,
  )
  return receipt
}

function withModelConsultations(
  reconstruction: PdfReconstruction,
  modelConsultations: ModelFallbackReceipt,
) {
  return {
    ...reconstruction,
    modelConsultations,
  } as PdfReconstruction & { modelConsultations: ModelFallbackReceipt }
}

async function consultedModelConsultationReceipt(
  reconstruction: PdfReconstruction,
) {
  const ledger = new ModelFallbackLedger()
  const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
  const gate = new ModelConsultationGate({
    enabled: true,
    ownerOptIn: true,
    ledger,
    model: {
      identity: {
        providerId: 'epub-receipt-test',
        modelId: 'recorded-model',
        modelVersion: '1',
        modelDigest: 'a'.repeat(64),
      },
      consult: () => ({ candidateId: point.candidates[0]!.id }),
    },
  })
  await gate.decide({
    ...point,
    documentId: reconstruction.paper.id,
    sourceSha256: reconstruction.source.sha256,
  })
  return ledger.receiptFor(reconstruction.paper.id)
}

async function resolvedVisualModelConsultation(candidateIndex = 0) {
  const reconstruction = await reconstructPdf(
    await fixtureFile('visual-adjudication-required.pdf'),
  )
  return resolvePdfModelFallbacks(reconstruction, {
    enabled: true,
    ownerOptIn: true,
    distillation: new DistillationLedger(),
    model: {
      identity: {
        providerId: 'epub-receipt-test',
        modelId: 'recorded-model',
        modelVersion: '1',
        modelDigest: 'a'.repeat(64),
      },
      consult: (request) => ({
        candidateId: request.candidates[candidateIndex]!.id,
      }),
    },
  })
}

async function pendingModelConsultationReceipt(
  reconstruction: PdfReconstruction,
) {
  const receipt = structuredClone(
    await consultedModelConsultationReceipt(reconstruction),
  )
  receipt.consultations[0]!.status = 'pending'
  receipt.consultations[0]!.choice = null
  receipt.decisions = []
  receipt.metrics = {
    totalDecisionCount: 0,
    totalConsultationCount: 0,
    consultationRate: 0,
    byDecisionClass: {},
  }
  expect(validateModelConsultationReceipt(receipt)).toBe(true)
  return receipt
}

function canonicalJsonForTest(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForTest).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalJsonForTest(entryValue)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function canonicalJsonSha256ForTest(value: unknown) {
  return createHash('sha256').update(canonicalJsonForTest(value)).digest('hex')
}

function canonicalHyphenEvidenceSha256ForTest(value: string) {
  return createHash('sha256')
    .update(`canonical-hyphen-evidence\0${value}`)
    .digest('hex')
}


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

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function staleNoteAnchorFixture() {
  const notePaper = structuredClone(paper)
  notePaper.nodes = [
    {
      id: 'stale-anchor-claim',
      type: 'paragraph',
      text: 'Claim 1.',
      noteReferences: [
        {
          id: 'stale-anchor-reference',
          label: '1',
          target: 'stale-anchor-note',
          start: 6,
          end: 7,
          confidence: 1,
        },
      ],
      source: 'synthetic-stale-note-anchor',
    },
    {
      id: 'stale-anchor-note',
      type: 'footnote',
      kind: 'footnote',
      label: '1',
      text: 'A source-backed note.',
      relationships: { backlinks: ['stale-anchor-reference'] },
      source: 'synthetic-stale-note-anchor',
    },
  ]
  const reconstruction = {
    source: { format: undefined },
    paper: notePaper,
    readiness: { ready: true },
    noteRelationships: [
      {
        id: 'stale-anchor-reference',
        label: '1',
        referenceRegionId: 'source-claim',
        referenceStart: 6,
        referenceEnd: 7,
        targetNoteId: 'stale-anchor-note',
        status: 'matched',
        canonicalAnchor: {
          kind: 'node',
          nodeId: 'stale-anchor-claim',
          start: 0,
          end: 1,
        },
        confidence: 1,
        threshold: 0.72,
        evidence: ['synthetic-stale-anchor'],
        candidates: [],
        sourceBoxes: [],
      },
    ],
    visualRelationships: [],
    assets: [],
  } as unknown as PdfReconstruction
  return { notePaper, reconstruction }
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

function exportBoundaryRun(
  text: string,
  y: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x: 0.1,
    y,
    width: 0.78,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize,
    confidence: 1,
  }
}

async function readyExternalHyperlinkFixture() {
  const linkedRun = exportBoundaryRun(
    'Open https://example.test/evidence for the source.',
    0.38,
  )
  const page: PdfPageAnalysis = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 0,
    imageCount: 0,
    runs: [
      exportBoundaryRun('Export boundary study', 0.06, 20),
      exportBoundaryRun('Ada Researcher', 0.13, 11),
      exportBoundaryRun('Abstract', 0.2, 14),
      exportBoundaryRun(
        'This abstract establishes a complete source-backed export fixture.',
        0.25,
      ),
      linkedRun,
      exportBoundaryRun('1 Methods', 0.56, 16),
      exportBoundaryRun('The methods remain canonical prose.', 0.62),
    ],
    links: [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/evidence',
        box: {
          page: 1,
          x: linkedRun.x,
          y: linkedRun.y,
          width: linkedRun.width,
          height: linkedRun.height,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ],
  }
  page.textCharacters = page.runs.reduce(
    (total, sourceRun) => total + sourceRun.text.length,
    0,
  )
  const reconstruction = await reconstructPageAnalyses({
    pages: [page],
    sourceHash: '8'.repeat(64),
    fileName: 'export-link-boundary.pdf',
    byteLength: 2048,
  })
  expect(reconstruction.readiness).toMatchObject({
    ready: true,
    blockingDiagnosticCodes: [],
  })
  return reconstruction
}

async function readyCrossReferenceFixture() {
  const page: PdfPageAnalysis = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 0,
    imageCount: 0,
    runs: [
      exportBoundaryRun('Cross-reference export study', 0.06, 20),
      exportBoundaryRun('Ada Researcher', 0.13, 11),
      exportBoundaryRun('Abstract', 0.2, 14),
      exportBoundaryRun(
        'This abstract establishes a complete source-backed export fixture.',
        0.25,
      ),
      exportBoundaryRun('See Section 4 for the source-backed method.', 0.38),
      exportBoundaryRun('4 Methods', 0.56, 16),
      exportBoundaryRun('The methods remain canonical prose.', 0.62),
    ],
  }
  page.textCharacters = page.runs.reduce(
    (total, sourceRun) => total + sourceRun.text.length,
    0,
  )
  const reconstruction = await reconstructPageAnalyses({
    pages: [page],
    sourceHash: '9'.repeat(64),
    fileName: 'export-cross-reference-boundary.pdf',
    byteLength: 2048,
  })
  expect(reconstruction.readiness).toMatchObject({
    ready: true,
    blockingDiagnosticCodes: [],
  })
  expect(reconstruction.crossReferenceRelationships).toHaveLength(1)
  return reconstruction
}

async function readyCanonicalHyphenDeletionFixture(): Promise<PdfReconstruction> {
  const reconstruction = await readyExternalHyperlinkFixture()
  const fromRun = {
    ...exportBoundaryRun('Repre-', 0.72),
    page: 2,
  }
  const toRun = {
    ...exportBoundaryRun('sentation, continued source text.', 0.08),
    page: 3,
  }
  const proofRun = {
    ...exportBoundaryRun('Representation appears in the same document.', 0.16),
    page: 3,
  }
  const sourceBox = (sourceRun: PdfSourceRun) => ({
    page: sourceRun.page,
    x: sourceRun.x,
    y: sourceRun.y,
    width: sourceRun.width,
    height: sourceRun.height,
    rotation: sourceRun.rotation,
    method: sourceRun.method,
  })
  const region = (id: string, sourceRun: PdfSourceRun) => ({
    id,
    page: sourceRun.page,
    kind: 'body' as const,
    column: 'single' as const,
    text: sourceRun.text,
    confidence: 1,
    box: sourceBox(sourceRun),
    lines: [
      {
        id: `${id}-line`,
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: sourceBox(sourceRun),
        runs: [{ ...sourceRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: false,
  })
  const fromRegion = region('canonical-hyphen-from-region', fromRun)
  const toRegion = region('canonical-hyphen-to-region', toRun)
  const proofRegion = region('canonical-hyphen-proof-region', proofRun)
  const decision = {
    id: `canonical-hyphen-boundary:canonical-flow-continuation:${fromRegion.id}:${fromRegion.lines[0].id}->${toRegion.id}:${toRegion.lines[0].id}`,
    context: 'canonical-flow-continuation' as const,
    outcome: 'removed-discretionary-hyphen' as const,
    fromRegionId: fromRegion.id,
    fromLineId: fromRegion.lines[0].id,
    toRegionId: toRegion.id,
    toLineId: toRegion.lines[0].id,
    geometry: {
      from: { ...fromRegion.lines[0].box },
      to: { ...toRegion.lines[0].box },
    },
    proof: {
      tier: 'exact-same-document' as const,
      sourceBoundaryProven: true as const,
      pinnedWord: 'representation',
      pinnedJoinedFormValid: true as const,
      pinnedSplit: {
        left: 'repre',
        right: 'sentation',
        index: 5,
      },
      splitPointValid: true as const,
      exactSameDocumentJoinedForm: 'Representation',
      sameDocumentJoinedFormValid: true as const,
      hardHyphenForm: 'repre-sentation',
      hardHyphenCounterproof: null,
      model: {
        id: 'scowl-2020.12.07+ushyphmax-2005-05-30',
        language: 'en-US',
        dictionarySha256:
          '829a043cf078d1e80e886289a13823454977f442a239a859d2133ea61944aa60',
        affixSha256:
          '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
        hyphenationSha256:
          'f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8',
      },
      evidence: [
        'source-proven-wrapped-line-boundary',
        'lexical-model:scowl-2020.12.07+ushyphmax-2005-05-30',
        'joined-form-valid:pinned-lexicon',
        'split-point-valid:pinned-hyphenation-pattern',
        'same-document-unhyphenated-word',
        'hard-hyphen-form-not-proved',
        'language-scope:en-US->en-US',
      ],
    },
  }
  return {
    ...reconstruction,
    regions: [...reconstruction.regions, fromRegion, toRegion, proofRegion],
    canonicalHyphenBoundaryDecisions: [decision],
    canonicalHyphenBoundaryDecisionCount: 1,
  } satisfies PdfReconstruction
}

async function readyDerivedAffixHyphenDeletionFixture() {
  const reconstruction = await readyCanonicalHyphenDeletionFixture()
  const fromRegion = reconstruction.regions.find(
    (region) => region.id === 'canonical-hyphen-from-region',
  )!
  const toRegion = reconstruction.regions.find(
    (region) => region.id === 'canonical-hyphen-to-region',
  )!
  const proofRegion = reconstruction.regions.find(
    (region) => region.id === 'canonical-hyphen-proof-region',
  )!
  fromRegion.text = 'Reparameter-'
  fromRegion.lines[0].text = fromRegion.text
  toRegion.text = 'ized, continued source text.'
  toRegion.lines[0].text = toRegion.text
  proofRegion.text = 'Parameterized models appear in the same document.'
  proofRegion.lines[0].text = proofRegion.text
  reconstruction.canonicalHyphenBoundaryDecisions[0].proof = {
    tier: 'same-document-derived-affix',
    sourceBoundaryProven: true,
    derivedWord: 'reparameterized',
    productivePrefix: {
      kind: 'prefix',
      value: 're',
      affixClass: 'PFX',
      flag: 'A',
      crossProduct: true,
      affixSha256:
        '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
    },
    baseWord: 'parameterized',
    pinnedBaseWordValid: true,
    pinnedSplit: { left: 'reparameter', right: 'ized', index: 11 },
    splitPointValid: true,
    exactSameDocumentBaseWord: 'Parameterized',
    sameDocumentBaseWordValid: true,
    hardHyphenForm: 'reparameter-ized',
    hardHyphenCounterproof: null,
    model: {
      id: 'scowl-2020.12.07+ushyphmax-2005-05-30',
      language: 'en-US',
      dictionarySha256:
        '829a043cf078d1e80e886289a13823454977f442a239a859d2133ea61944aa60',
      affixSha256:
        '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
      hyphenationSha256:
        'f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8',
    },
    evidence: [
      'source-proven-wrapped-line-boundary',
      'lexical-model:scowl-2020.12.07+ushyphmax-2005-05-30',
      'joined-form-valid:same-document-derived-affix',
      'split-point-valid:pinned-hyphenation-pattern',
      'productive-prefix-valid:pinned-affix-model',
      'base-form-valid:pinned-lexicon',
      'same-document-unhyphenated-base-word',
      'hard-hyphen-form-not-proved',
      'language-scope:en-US->en-US',
    ],
  }
  return reconstruction
}

describe('EPUB 3 export', () => {
  it('keeps the EPUB facade bound to the readable fallback projection module', async () => {
    const reconstruction = await reconstructPdf(
      await fixtureFile('mixed-page.pdf'),
    )

    expect(projectReadableFallbackReconstruction).toBe(
      projectReadableFallbackDirect,
    )
    expect(projectReadableFallbackReconstruction(reconstruction)).toEqual(
      projectReadableFallbackDirect(reconstruction),
    )
  }, 120_000)

  it('renders emphasis, vertical alignment, and safe links as semantic XHTML', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'emphasis raised lowered https://example.test/evidence'
    const range = (expected: string) => ({
      start: value.indexOf(expected),
      end: value.indexOf(expected) + expected.length,
    })
    inlinePaper.nodes = [
      {
        id: 'synthetic-inline-node',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          { ...range('emphasis'), italic: true },
          { ...range('raised'), verticalAlign: 'superscript' },
          { ...range('lowered'), verticalAlign: 'subscript' },
          {
            ...range('https://example.test/evidence'),
            href: 'https://example.test/evidence',
          },
        ],
        source: 'synthetic-inline-test',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain('<em>emphasis</em>')
    expect(content).toContain('<sup>raised</sup>')
    expect(content).toContain('<sub>lowered</sub>')
    expect(content).toContain(
      '<a href="https://example.test/evidence">https://example.test/evidence</a>',
    )
  })

  it('compacts only source-proved raised math atoms while preserving canonical text', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'C P lot and R Inf o. while W T and see note retain spaces.'
    const range = (expected: string) => ({
      start: value.indexOf(expected),
      end: value.indexOf(expected) + expected.length,
    })
    inlinePaper.nodes = [
      {
        id: 'synthetic-compact-math-node',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          {
            ...range('P lot'),
            italic: true,
            verticalAlign: 'superscript',
            compactMathAtom: true,
          },
          {
            ...range('Inf o.'),
            verticalAlign: 'superscript',
            compactMathAtom: true,
          },
          { ...range('W T'), italic: true },
          { ...range('see note'), verticalAlign: 'superscript' },
        ],
        source: 'synthetic-compact-math-test',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(
      'text' in inlinePaper.nodes[0] ? inlinePaper.nodes[0].text : '',
    ).toBe(value)
    expect(content).toContain('C <sup><em>Plot</em></sup>')
    expect(content).toContain('R <sup>Info.</sup>')
    expect(content).toContain('<em>W T</em>')
    expect(content).toContain('<sup>see note</sup>')
    expect(content).not.toContain('<em>WT</em>')
    expect(
      researchPaperSchema.safeParse({
        ...inlinePaper,
        nodes: [
          {
            ...inlinePaper.nodes[0],
            inlineRuns: [
              {
                ...range('P lot'),
                compactMathAtom: true,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('preserves inline mathematical styling in complete figure captions', () => {
    const captionPaper = structuredClone(paper)
    const captionText = 'Figure 1. Terms h2 and R2 remain semantic.'
    const hStart = captionText.indexOf('h2')
    const rStart = captionText.indexOf('R2')
    captionPaper.nodes = [
      {
        id: 'styled-caption-figure',
        type: 'figure',
        objectType: 'figure',
        title: captionText,
        relationships: { caption: 'styled-caption' },
        source: 'synthetic-caption-style',
      },
      {
        id: 'styled-caption',
        type: 'caption',
        text: captionText,
        inlineRuns: [
          { start: hStart, end: hStart + 1, italic: true },
          {
            start: hStart + 1,
            end: hStart + 2,
            verticalAlign: 'subscript',
          },
          {
            start: rStart + 1,
            end: rStart + 2,
            verticalAlign: 'superscript',
          },
        ],
        source: 'synthetic-caption-style',
      },
    ]

    const content = renderPublicationXhtml(captionPaper)

    expect(content).toContain(
      '<figcaption id="styled-caption" data-canonical-id="styled-caption">Figure 1. Terms <em>h</em><sub>2</sub> and R<sup>2</sup> remain semantic.</figcaption>',
    )
  })

  it('does not expose an invented display-equation placeholder as a visible caption or alt text', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const placeholder = 'Display equation p005-001'
    reconstruction.paper.nodes = reconstruction.paper.nodes.map((node) =>
      node.id === 'equation-caption'
        ? { ...node, text: placeholder, inlineRuns: undefined }
        : node,
    )
    reconstruction.visualRelationships[0] = {
      ...reconstruction.visualRelationships[0],
      label: placeholder,
      sourceText: '',
      altText: placeholder,
      altTextSource: 'caption',
      evidence: [
        ...reconstruction.visualRelationships[0].evidence,
        'source-text-transcript-unresolved',
      ],
    }

    const content = renderPublicationXhtml(reconstruction.paper, {
      reconstruction,
    })

    expect(content).not.toContain(placeholder)
    expect(content).toContain(
      'alt="Equation reproduced from the source PDF." data-alt-source="source-image"',
    )
    expect(content).not.toContain('semantic transcript unresolved')
    expect(content).not.toContain('data-alt-source="unresolved"')
    expect(content).toContain(
      '<figcaption id="equation-caption" data-canonical-id="equation-caption" class="synthetic-equation-caption" aria-hidden="true"></figcaption>',
    )
  })

  it('renders generated equation labels plainly without exposing corrupt inferred inline semantics', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    reconstruction.paper.nodes = reconstruction.paper.nodes.map((node) =>
      node.id === 'equation-caption'
        ? {
            ...node,
            text: 'Equation 1.',
            inlineRuns: [
              { start: 0, end: 1, italic: true },
              { start: 1, end: 2, verticalAlign: 'superscript' as const },
              { start: 2, end: 3, verticalAlign: 'subscript' as const },
            ],
          }
        : node,
    )
    reconstruction.visualRelationships[0] = {
      ...reconstruction.visualRelationships[0],
      label: 'Equation 1',
      sourceText: '',
      altText: 'Equation 1.',
      altTextSource: 'caption',
      evidence: [
        ...reconstruction.visualRelationships[0].evidence,
        'source-text-transcript-unresolved',
      ],
    }

    const content = renderPublicationXhtml(reconstruction.paper, {
      reconstruction,
    })

    expect(content).toContain('alt="Equation 1" data-alt-source="caption"')
    expect(content).toContain(
      'data-asset-id="' +
        reconstruction.visualRelationships[0].assetIds[0] +
        '"',
    )
    expect(content).toContain(
      '<figcaption id="equation-caption" data-canonical-id="equation-caption" class="equation-number-caption visually-hidden">Equation 1</figcaption>',
    )
    expect(content).not.toContain('<em>E</em>')
    expect(content).not.toContain('<sup>q</sup>')
    expect(content).not.toContain('<sub>u</sub>')
    expect(content).not.toContain('visual-source-transcript')
    expect(content).not.toContain('<math')
  })

  it('describes an owner-adjudicated equation transcript as available', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const placeholder = 'Display equation p005-001'
    reconstruction.paper.nodes = reconstruction.paper.nodes.map((node) =>
      node.id === 'equation-caption'
        ? { ...node, text: placeholder, inlineRuns: undefined }
        : node.id === 'equation-node'
          ? { ...node, sourceText: 'x + y = z' }
          : node,
    )
    reconstruction.visualRelationships[0] = {
      ...reconstruction.visualRelationships[0],
      label: placeholder,
      sourceText: 'x + y = z',
      altText: placeholder,
      altTextSource: 'caption',
      evidence: [
        ...reconstruction.visualRelationships[0].evidence,
        'source-text-transcript-unresolved',
      ],
      equationTranscriptAdjudication: {
        schemaVersion: '1.0.0',
        format: 'latex',
        source: 'owner-local-adjudication',
        transcriptSha256: 'a'.repeat(64),
        relationshipFingerprintSha256: 'b'.repeat(64),
        sourceCropAssetId: reconstruction.visualRelationships[0].assetIds[0],
        sourceCropAssetSha256: 'c'.repeat(64),
      },
    }

    const content = renderPublicationXhtml(reconstruction.paper, {
      reconstruction,
    })

    expect(content).toContain(
      'alt="Equation image; owner-reviewed source transcript available." data-alt-source="owner-local-adjudication"',
    )
    expect(content).not.toContain(
      'alt="Equation image; semantic transcript unresolved."',
    )
  })

  it('renders verified script MathML while hiding its source image from assistive technology', async () => {
    const { reconstruction, equationRegion } =
      await staleEquationTranscriptFixture()
    const relationship = reconstruction.visualRelationships[0]
    equationRegion.text = 'x2=y'
    Object.assign(equationRegion.box, {
      x: 0.28,
      y: 0.305,
      width: 0.09,
      height: 0.026,
    })
    equationRegion.lines = [
      {
        id: 'equation-source-line-1',
        text: equationRegion.text,
        fontSize: 10,
        box: { ...equationRegion.box },
        runs: [
          {
            ...equationRegion.box,
            text: 'x',
            x: 0.29,
            y: 0.315,
            width: 0.01,
            height: 0.014,
            fontName: 'Synthetic-CMMI10',
            fontSize: 10,
            confidence: 1,
          },
          {
            ...equationRegion.box,
            text: '2',
            x: 0.301,
            y: 0.306,
            width: 0.006,
            height: 0.007,
            fontName: 'Synthetic-CMMI8',
            fontSize: 7,
            confidence: 1,
          },
          {
            ...equationRegion.box,
            text: '=',
            x: 0.312,
            y: 0.315,
            width: 0.008,
            height: 0.014,
            fontName: 'Synthetic-CMSY10',
            fontSize: 10,
            confidence: 1,
          },
          {
            ...equationRegion.box,
            text: 'y',
            x: 0.326,
            y: 0.315,
            width: 0.01,
            height: 0.014,
            fontName: 'Synthetic-CMMI10',
            fontSize: 10,
            confidence: 1,
          },
        ],
      },
    ]
    relationship.sourceRegionIds = [equationRegion.id]
    relationship.sourceLineIds = [equationRegion.lines[0].id]
    relationship.sourceText = ''
    relationship.altTextSource = 'caption'
    relationship.evidence = [
      'source-page-crop',
      SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
    ]
    relationship.equationGeometryTranscript =
      createSourceGeometryScriptTranscript({
        sourceRegionIds: relationship.sourceRegionIds,
        sourceLineIds: relationship.sourceLineIds,
        sourceObjectIds: relationship.sourceObjectIds,
        regions: reconstruction.regions,
        sourceCropAsset: reconstruction.assets[0],
      })!

    const content = renderPublicationXhtml(reconstruction.paper, {
      reconstruction,
    })

    expect(relationship.equationGeometryTranscript).not.toBeNull()
    expect(content).toContain(
      'alt="" aria-hidden="true" data-alt-source="source-geometry-script-transcript-v1"',
    )
    expect(content).not.toContain('role="img"')
    expect(content).not.toContain('aria-describedby=')
    expect(content).toContain(
      '<math xmlns="http://www.w3.org/1998/Math/MathML" id="equation-node-equation-transcript" class="visually-hidden" display="block" data-equation-transcript-source="source-geometry-script-transcript-v1" data-equation-spoken-text="x superscript 2 equals y"',
    )
    expect(content).not.toMatch(
      /<math\b[^>]*\s(?:hidden|aria-hidden|aria-label)=/u,
    )
    expect(content).toContain(
      '<msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mi>y</mi>',
    )
    expect(content).toContain(
      '<annotation encoding="text/plain">x^(2) = y</annotation>',
    )
    expect(content).not.toContain('visual-source-transcript')
    expect(XMLValidator.validate(content)).toBe(true)
  })

  it('percent-encodes RFC-unwise external-link characters for EPUB readers', async () => {
    const linkPaper = structuredClone(paper)
    const value = 'Open the reviewed paper.'
    linkPaper.nodes = [
      {
        id: 'encoded-external-link',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          {
            start: 0,
            end: 23,
            href: 'https://example.test/forum?referrer=%5Bprofile%5D(%2Fid%3D{~}Author1)',
          },
        ],
        source: 'synthetic-rfc-unwise-link',
      },
    ]

    const content = renderPublicationXhtml(linkPaper)
    expect(content).toContain(
      'href="https://example.test/forum?referrer=%5Bprofile%5D(%2Fid%3D%7B~%7DAuthor1)"',
    )
    expect(content).not.toContain('{~}')
    const epub = await buildEpub(linkPaper)
    expect(() => inspectEpub(epub.bytes)).not.toThrow()
  })

  it('renders malformed external-link text without an invalid XHTML href', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'Malformed link text remains readable.'
    inlinePaper.nodes = [
      {
        id: 'synthetic-malformed-link-node',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          {
            start: 0,
            end: value.length,
            href: String.raw`https://example.test/archive\n\nor`,
          },
        ],
        source: 'synthetic-malformed-link-test',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain(value)
    expect(content).not.toContain('<a href=')
    expect(content).not.toContain(String.raw`archive\n\nor`)
  })

  it('composes every active overlapping inline annotation', () => {
    const inlinePaper = structuredClone(paper)
    inlinePaper.nodes = [
      {
        id: 'overlapping-inline-node',
        type: 'paragraph',
        text: 'linked emphasis',
        inlineRuns: [
          { start: 0, end: 15, italic: true },
          { start: 7, end: 15, bold: true },
          { start: 0, end: 6, href: 'https://example.test/linked' },
        ],
        source: 'synthetic-inline-overlap',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain(
      '<a href="https://example.test/linked"><em>linked</em></a><em> </em><strong><em>emphasis</em></strong>',
    )
  })

  it('preserves a zero-target semantic relationship under a fully overlapping external link', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'https://example.test/reference'
    inlinePaper.nodes = [
      {
        id: 'linked-bibliography-entry',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          { start: 0, end: value.length, href: value },
          {
            start: 0,
            end: value.length,
            relationshipId: 'bibliography-entry-1',
            semanticRole: 'bibliography-entry',
          },
        ],
        source: 'synthetic-overlapping-relationship',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain(
      '<span id="bibliography-entry-1" data-semantic-role="bibliography-entry" data-relationship-id="bibliography-entry-1"><a href="https://example.test/reference">https://example.test/reference</a></span>',
    )
  })

  it('does not create a whitespace-only link where overlapping annotations split an unresolved citation', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'Kaplan et al., 2020'
    inlinePaper.nodes = [
      {
        id: 'claim-with-overlapping-citation-links',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          {
            start: 0,
            end: 7,
            href: '#bibliography-kaplan-2020',
            annotationId: 'pdf-link-kaplan-left',
          },
          {
            start: 6,
            end: value.length,
            href: '#bibliography-kaplan-2020',
            annotationId: 'pdf-link-kaplan-right',
          },
          {
            start: 0,
            end: value.length,
            relationshipId: 'citation-kaplan-2020-unresolved',
            semanticRole: 'citation',
          },
        ],
        source: 'synthetic-overlapping-unresolved-citation',
      },
      {
        id: 'bibliography-kaplan-2020',
        type: 'paragraph',
        text: 'Kaplan et al. (2020).',
        source: 'synthetic-overlapping-unresolved-citation',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain(
      'data-relationship-id="citation-kaplan-2020-unresolved"',
    )
    expect(content).not.toMatch(/<a\b[^>]*>\s*<\/a>/u)
  })

  it('rejects a canonical note backlink with no rendered reference anchor', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'orphan-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'An affiliation note with an orphan source-region backlink.',
        relationships: { backlinks: ['page-001-author-region'] },
        source: 'synthetic-orphan-author-note',
      },
    ]

    await expect(buildEpub(notePaper)).rejects.toThrow(
      /DANGLING_EPUB_INTERNAL_REFERENCE/u,
    )
  })

  it('renders title-page author annotations as linked EPUB notes', () => {
    const notePaper = structuredClone(paper)
    notePaper.authors = ['Yeyong Yu', 'Runsheng Yu']
    notePaper.authorAffiliations = [
      { author: 'Yeyong Yu', label: '1' },
      { author: 'Runsheng Yu', label: '2' },
    ]
    notePaper.affiliations = ['1 Example University,', '2 Example Laboratory']
    notePaper.authorNotes = [
      {
        id: 'author-noteref-1',
        author: 'Yeyong Yu',
        label: '*',
        target: 'author-note-1',
      },
    ]
    notePaper.nodes = [
      {
        id: 'author-note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: 'Work done during the internship.',
        relationships: { backlinks: ['author-noteref-1'] },
        source: 'synthetic-author-note',
      },
    ]

    const content = renderPublicationXhtml(notePaper)

    expect(content).toContain(
      'Yeyong Yu<sup class="author-note-marker"><a id="author-noteref-1" href="#author-note-1" epub:type="noteref" role="doc-noteref">*</a></sup><sup class="author-affiliation-marker">1</sup>, Runsheng Yu<sup class="author-affiliation-marker">2</sup>',
    )
    expect(content).toContain(
      '<p class="affiliations"><span class="affiliation"><sup class="affiliation-marker">1</sup>Example University,</span><br /><span class="affiliation"><sup class="affiliation-marker">2</sup>Example Laboratory</span></p>',
    )
    expect(content).not.toContain('University,;')
    expect(content).toContain('href="#author-noteref-1"')
  })

  it('applies one shared numbered affiliation to every author when explicit author mappings are absent', () => {
    const sharedAffiliationPaper = structuredClone(paper)
    sharedAffiliationPaper.authors = ['Minyoung Huh', 'Brian Cheung']
    sharedAffiliationPaper.authorAffiliations = []
    sharedAffiliationPaper.affiliations = [
      '1 Massachusetts Institute of Technology',
    ]

    const content = renderPublicationXhtml(sharedAffiliationPaper)

    expect(content).toContain(
      'Minyoung Huh<sup class="author-affiliation-marker">1</sup>, Brian Cheung<sup class="author-affiliation-marker">1</sup>',
    )
  })

  it('recovers a shared affiliation marker embedded in a common symbolic author note', () => {
    const sharedNotePaper = structuredClone(paper)
    sharedNotePaper.authors = ['Minyoung Huh', 'Brian Cheung']
    sharedNotePaper.authorAffiliations = []
    sharedNotePaper.affiliations = []
    sharedNotePaper.authorNotes = sharedNotePaper.authors.map(
      (author, index) => ({
        id: `shared-note-reference-${index + 1}`,
        author,
        label: '*',
        target: 'shared-author-note',
      }),
    )
    const noteText = 'Equal contribution 1MIT. Correspondence to: Minyoung Huh.'
    const markerStart = noteText.indexOf('1')
    sharedNotePaper.nodes = [
      {
        id: 'shared-author-note',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: noteText,
        inlineRuns: [
          {
            start: markerStart,
            end: markerStart + 1,
            verticalAlign: 'superscript',
          },
        ],
        relationships: {
          backlinks: sharedNotePaper.authorNotes.map(
            (reference) => reference.id,
          ),
        },
        source: 'synthetic-shared-author-note',
      },
    ]

    const content = renderPublicationXhtml(sharedNotePaper)

    expect(content).toContain('Minyoung Huh<sup class="author-note-marker">')
    expect(content).toContain(
      '</a></sup><sup class="author-affiliation-marker">1</sup>',
    )
    expect(content).toContain('Brian Cheung<sup class="author-note-marker">')
  })

  it('renders a reconstructed byline immediately after its canonical title so author-note backlinks resolve', () => {
    const notePaper = structuredClone(paper)
    notePaper.title = 'Canonical reconstructed title'
    notePaper.authors = ['Yeyong Yu', 'Runsheng Yu']
    notePaper.authorNotes = [
      {
        id: 'reconstructed-author-noteref-1',
        author: 'Yeyong Yu',
        label: '*',
        target: 'reconstructed-author-note-1',
      },
    ]
    notePaper.nodes = [
      {
        id: 'reconstructed-author-note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: 'Work done during the internship.',
        relationships: { backlinks: ['reconstructed-author-noteref-1'] },
        source: 'pdf:synthetic#page=1',
      },
      {
        id: 'canonical-title-node',
        type: 'heading',
        level: 1,
        text: notePaper.title,
        source: 'pdf:synthetic#page=1',
      },
      {
        id: 'first-body-node',
        type: 'paragraph',
        text: 'The body follows the source byline.',
        source: 'pdf:synthetic#page=1',
      },
    ]
    const reconstruction = {
      readiness: { ready: true },
      visualRelationships: [],
      assets: [],
    } as unknown as PdfReconstruction

    const content = renderPublicationXhtml(notePaper, { reconstruction })

    expect(content).toContain(
      'Yeyong Yu<sup class="author-note-marker"><a id="reconstructed-author-noteref-1" href="#reconstructed-author-note-1" epub:type="noteref" role="doc-noteref">*</a></sup>, Runsheng Yu',
    )
    expect(content).toContain('href="#reconstructed-author-noteref-1"')
    expect(content.indexOf('id="canonical-title-node"')).toBeLessThan(
      content.indexOf('class="authors"'),
    )
    expect(content.indexOf('class="authors"')).toBeLessThan(
      content.indexOf('id="reconstructed-author-note-1"'),
    )
    expect(content.indexOf('id="reconstructed-author-note-1"')).toBeLessThan(
      content.indexOf('id="first-body-node"'),
    )
    expect(XMLValidator.validate(content)).toBe(true)
  })

  it('renders an explicit source note marker instead of discarding its note-kind text', () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        markerText: 'Footnote 1.',
        text: 'The exact source marker remains rendered.',
        relationships: { backlinks: [] },
        source: 'synthetic-explicit-note-marker',
      },
    ]

    expect(renderPublicationXhtml(notePaper)).toContain(
      '<span class="note-label" data-semantic-ledger-ignore="true">Footnote 1. </span>The exact source marker remains rendered.',
    )
  })

  it('rejects an EPUB whose canonical inline href has no internal target', async () => {
    const danglingPaper = structuredClone(paper)
    danglingPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [9].',
        inlineRuns: [
          {
            start: 11,
            end: 14,
            relationshipId: 'citation-9',
            semanticRole: 'citation',
            targetIds: ['missing-reference-9'],
          },
        ],
        source: 'synthetic-dangling-citation',
      },
    ]

    await expect(buildEpub(danglingPaper)).rejects.toThrow(
      /dangling internal reference/i,
    )
  })

  it('rejects stale reconstruction note anchors during direct XHTML rendering', () => {
    const { notePaper, reconstruction } = staleNoteAnchorFixture()

    expect(() => renderPublicationXhtml(notePaper, { reconstruction })).toThrow(
      /note-anchor-mismatch/u,
    )
  })

  it('rejects stale reconstruction note anchors before EPUB packaging', async () => {
    const { notePaper, reconstruction } = staleNoteAnchorFixture()
    reconstruction.visualRelationships = [
      {
        id: 'later-invalid-visual-relationship',
        status: 'matched',
        canonicalNodeId: null,
        assetIds: [],
      },
    ] as unknown as PdfReconstruction['visualRelationships']

    await expect(buildEpub(notePaper, reconstruction)).rejects.toThrow(
      /note-anchor-mismatch/u,
    )
  })

  it('rejects a matched note whose exact canonical anchor has no source evidence', () => {
    const { notePaper, reconstruction } = staleNoteAnchorFixture()
    reconstruction.noteRelationships[0].canonicalAnchor = {
      kind: 'node',
      nodeId: 'stale-anchor-claim',
      start: 6,
      end: 7,
    }

    expect(() => renderPublicationXhtml(notePaper, { reconstruction })).toThrow(
      /invalid-source-note-anchor/u,
    )
  })

  it('rejects a stale-ready equation whose export transcript no longer covers its source lines', async () => {
    const { reconstruction, equationRegion } =
      await staleEquationTranscriptFixture()

    await expect(
      buildEpub(reconstruction.paper, reconstruction),
    ).resolves.toMatchObject({ mode: 'publication' })

    reconstruction.visualRelationships[0] = {
      ...reconstruction.visualRelationships[0],
      sourceLineIds: [equationRegion.lines[0].id],
      sourceText: equationRegion.lines[0].text,
    }

    await expect(
      buildEpub(reconstruction.paper, reconstruction),
    ).rejects.toThrow(/equation|visual relationship/u)
  })

  it.each([
    { label: 'forbidden C0 control', text: '\u0012' },
    { label: 'Unicode replacement glyph', text: 'term \ufffd value' },
  ])('rejects lossy canonical text containing a $label', async ({ text }) => {
    const corruptPaper = structuredClone(paper)
    corruptPaper.nodes = [
      {
        id: 'corrupt-canonical-node',
        type: 'paragraph',
        text,
        source: 'synthetic-corrupt-text',
      },
    ]

    await expect(buildEpub(corruptPaper)).rejects.toThrow(
      /EPUB_TEXT_SANITIZATION_LOSS/u,
    )
  })

  it('preserves ordered-list marker style and starting ordinal', () => {
    const listPaper = structuredClone(paper)
    listPaper.nodes = [
      {
        id: 'roman-three',
        type: 'paragraph',
        text: 'Third item',
        list: {
          level: 1,
          ordered: true,
          numberingId: 'roman-list',
          markerStyle: 'lower-roman',
          ordinal: 3,
        },
        source: 'synthetic-list-test',
      },
      {
        id: 'roman-five',
        type: 'paragraph',
        text: 'Fifth item after an intentional gap',
        list: {
          level: 1,
          ordered: true,
          numberingId: 'roman-list',
          markerStyle: 'lower-roman',
          ordinal: 5,
        },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content).toContain(
      '<ol class="publication-list" data-list-level="1" data-numbering-id="roman-list" data-marker-style="lower-roman" type="i" start="3">',
    )
    expect(content).toContain('id="roman-five"')
    expect(content).toContain('data-list-level="1" value="5"')
  })

  it('renders exact source list markers, ordinal gaps, and continuation evidence', () => {
    const listPaper = structuredClone(paper)
    const item = (
      id: string,
      markerText: string,
      ordinal: number,
      markerStyle: 'decimal' | 'lower-alpha',
      extra: { level?: number; continuedFromPreviousPage?: boolean } = {},
    ) => ({
      id,
      type: 'paragraph' as const,
      text: `${id} text`,
      list: {
        level: extra.level ?? 1,
        ordered: true,
        numberingId: 'source-markers',
        markerStyle,
        ordinal,
        markerText,
        ...(extra.continuedFromPreviousPage
          ? { continuedFromPreviousPage: true }
          : {}),
      },
      source: 'synthetic-source-marker-test',
    })
    listPaper.nodes = [
      item('one-suffix', '1)', 1, 'decimal'),
      item('alpha-parenthesized', '(a)', 1, 'lower-alpha', { level: 2 }),
      item('numeric-parenthesized', '(1)', 1, 'decimal', { level: 2 }),
      item('three-gap', '3)', 3, 'decimal'),
      item('four-continuation', '4)', 4, 'decimal', {
        continuedFromPreviousPage: true,
      }),
      {
        ...item('bracketed-reference', '[1]', 1, 'decimal'),
        list: {
          ...item('bracketed-reference', '[1]', 1, 'decimal').list,
          numberingId: 'references',
        },
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    for (const marker of ['1)', '(a)', '(1)', '3)', '4)', '[1]']) {
      expect(content).toContain(
        `<span class="publication-list-marker" aria-hidden="true">${marker}</span>`,
      )
    }
    expect(content).toContain(
      'id="three-gap" data-canonical-id="three-gap" class="publication-list-item has-preserved-marker" data-list-level="1" value="3"',
    )
    expect(content).toContain(
      'id="four-continuation" data-canonical-id="four-continuation" class="publication-list-item has-preserved-marker" data-list-level="1" value="4" data-continued-from-previous-page="true"',
    )
  })

  it('emits well-formed markerless bibliography markup when the source has no ordinals', () => {
    const referencePaper = structuredClone(paper)
    referencePaper.nodes = [
      {
        id: 'reference-one',
        type: 'paragraph',
        text: 'First reference.',
        list: { level: 1, ordered: false, numberingId: 'references' },
        source: 'synthetic-list-test',
      },
      {
        id: 'reference-two',
        type: 'paragraph',
        text: 'Second reference.',
        list: { level: 1, ordered: false, numberingId: 'references' },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(referencePaper)

    expect(XMLValidator.validate(content)).toBe(true)
    expect(content).not.toContain('<ol class="publication-list')
    expect(content).toContain(
      '<ul class="publication-list markerless-list" data-list-level="1" data-numbering-id="references" data-marker-style="disc">',
    )
    expect(content.match(/<li\b/g)).toHaveLength(2)
    expect(content).not.toContain('role="listitem"')
  })

  it('recomputes PDF hyperlink ownership and rejects a stale external target at publication export', async () => {
    const reconstruction = await readyExternalHyperlinkFixture()
    const stale = structuredClone(reconstruction)
    const linkRun = stale.paper.nodes
      .flatMap((node) => ('inlineRuns' in node ? (node.inlineRuns ?? []) : []))
      .find((run) => run.annotationId === 'pdf-link-p001-a0001')
    expect(linkRun).toBeDefined()
    linkRun!.href = 'https://example.test/stale-target'

    await expect(buildEpub(stale.paper, stale)).rejects.toThrow(
      /PDF hyperlink evidence.*external target/u,
    )
  })

  it('rejects a stale ready PDF when a canonical annotation owner has no source annotation', async () => {
    const reconstruction = await readyExternalHyperlinkFixture()
    const stale = structuredClone(reconstruction)
    stale.pages[0].links = []

    await expect(buildEpub(stale.paper, stale)).rejects.toThrow(
      /PDF hyperlink evidence.*no source annotation/u,
    )
  })

  it('rejects duplicate and unresolved source hyperlink annotations despite stale ready counts', async () => {
    const reconstruction = await readyExternalHyperlinkFixture()
    const duplicate = structuredClone(reconstruction)
    duplicate.pages[0].links!.push(
      structuredClone(duplicate.pages[0].links![0]),
    )
    await expect(buildEpub(duplicate.paper, duplicate)).rejects.toThrow(
      /PDF hyperlink evidence.*duplicate source annotation/u,
    )

    const unresolved = structuredClone(reconstruction)
    unresolved.pages[0].links![0] = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'unresolved',
      target: 'https://example.test/evidence',
      reason: 'missing-target',
      box: unresolved.pages[0].links![0].box,
    }
    await expect(buildEpub(unresolved.paper, unresolved)).rejects.toThrow(
      /PDF hyperlink evidence.*remains unresolved/u,
    )
  })

  it('rejects an internal annotation whose canonical fragment target disappeared', async () => {
    const reconstruction = await readyExternalHyperlinkFixture()
    const stale = structuredClone(reconstruction)
    stale.pages[0].links![0] = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'section.999',
      box: stale.pages[0].links![0].box!,
    }
    const linkRun = stale.paper.nodes
      .flatMap((node) => ('inlineRuns' in node ? (node.inlineRuns ?? []) : []))
      .find((run) => run.annotationId === 'pdf-link-p001-a0001')
    expect(linkRun).toBeDefined()
    linkRun!.href = '#missing-canonical-target'

    await expect(buildEpub(stale.paper, stale)).rejects.toThrow(
      /PDF hyperlink evidence.*internal fragment/u,
    )
  })

  it('rejects a source annotation owner whose stale canonical range cannot render', async () => {
    const reconstruction = await readyExternalHyperlinkFixture()
    const stale = structuredClone(reconstruction)
    const linkRun = stale.paper.nodes
      .flatMap((node) => ('inlineRuns' in node ? (node.inlineRuns ?? []) : []))
      .find((run) => run.annotationId === 'pdf-link-p001-a0001')
    expect(linkRun).toBeDefined()
    linkRun!.end = Number.MAX_SAFE_INTEGER

    await expect(buildEpub(stale.paper, stale)).rejects.toThrow(
      /PDF hyperlink evidence.*non-renderable canonical range/u,
    )
  })

  it('rejects a stale scholarly cross-reference target claim at publication export', async () => {
    const reconstruction = await readyCrossReferenceFixture()
    const stale = structuredClone(reconstruction)
    const relationship = stale.crossReferenceRelationships[0]
    const wrongTarget = stale.paper.nodes.find(
      (node) => node.id !== relationship.targetNodeIds[0],
    )
    expect(wrongTarget).toBeDefined()
    relationship.targetNodeIds = [wrongTarget!.id]
    relationship.targets[0].targetNodeId = wrongTarget!.id
    relationship.targets[0].candidateNodeIds = [wrongTarget!.id]

    await expect(buildEpub(stale.paper, stale)).rejects.toThrow(
      /scholarly cross-reference.*canonical inline target/u,
    )
  })

  it('rejects a stale scholarly relationship whose canonical inline owner disappeared', async () => {
    const reconstruction = await readyCrossReferenceFixture()
    const stale = structuredClone(reconstruction)
    const relationship = stale.crossReferenceRelationships[0]
    const owner = stale.paper.nodes.find(
      (node) => node.id === relationship.canonicalAnchor?.nodeId,
    )
    expect(owner && 'inlineRuns' in owner).toBe(true)
    if (owner && 'inlineRuns' in owner) {
      owner.inlineRuns = owner.inlineRuns?.filter(
        (run) => run.relationshipId !== relationship.id,
      )
    }

    await expect(buildEpub(stale.paper, stale)).rejects.toThrow(
      /scholarly cross-reference.*exactly one canonical inline owner/u,
    )
  })

  it('redetects a source scholarly reference when both its stale claim and canonical run were removed', async () => {
    const reconstruction = await readyCrossReferenceFixture()
    const stale = structuredClone(reconstruction)
    const relationshipId = stale.crossReferenceRelationships[0].id
    stale.crossReferenceRelationships = []
    for (const node of stale.paper.nodes) {
      if ('inlineRuns' in node) {
        node.inlineRuns = node.inlineRuns?.filter(
          (run) => run.relationshipId !== relationshipId,
        )
      }
    }

    await expect(buildEpub(stale.paper, stale)).rejects.toThrow(
      /scholarly cross-reference.*missing source-detected relationship/u,
    )
  })

  it('embeds export-time reassessed PDF link coverage instead of stale receipt counts', async () => {
    const reconstruction = await readyExternalHyperlinkFixture()
    const stale = structuredClone(reconstruction)
    stale.completeness.expectedHyperlinkCount = 91
    stale.completeness.mappedHyperlinkCount = 91
    stale.completeness.hyperlinkCoverage = 1

    const epub = await buildEpub(stale.paper, stale)
    const { manifest } = inspectEpub(epub.bytes)

    expect(manifest.sourceCompleteness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })
    expect(manifest.sourceReadiness).toMatchObject({
      ready: true,
      blockingDiagnosticCodes: [],
    })
  })
})
