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

describe("EPUB package and receipt integrity", () => {
  it('builds a deterministic reflowable container with stored first mimetype', async () => {
    const first = await buildEpub(paper)
    const second = await buildEpub(paper)
    const { files, entries } = inspectEpub(first.bytes)

    expect(first.bytes).toEqual(second.bytes)
    expect(first.sha256).toBe(second.sha256)
    expect(first.fileName).toMatch(/\.epub$/)
    expect(entries[0]).toBe('mimetype')
    expect(first.bytes[8] | (first.bytes[9] << 8)).toBe(0)
    expect(strFromU8(files['META-INF/container.xml'])).toContain(
      'EPUB/package.opf',
    )
    const opf = strFromU8(files['EPUB/package.opf'])
    const navigation = strFromU8(files['EPUB/nav.xhtml'])
    expect(opf).toContain('version="3.0"')
    expect(opf).toContain('properties="nav"')
    expect(opf).toContain('<meta property="schema:accessMode">textual</meta>')
    expect(opf).toContain(
      '<meta property="schema:accessibilityFeature">structuralNavigation</meta>',
    )
    expect(opf).toContain(
      '<meta property="schema:accessibilityHazard">none</meta>',
    )
    expect(opf).toContain(
      '<meta property="schema:accessModeSufficient">textual</meta>',
    )
    expect(opf).toContain('<meta property="schema:accessibilitySummary">')
    expect(navigation).toContain('<nav epub:type="toc" role="doc-toc"')
  })

  it('rejects malformed package graphs and asset bytes that do not match their manifest receipt', async () => {
    const epub = await buildEpub(paper)
    const original = unzipSync(epub.bytes)
    const manifest = JSON.parse(strFromU8(original['EPUB/export.json']))
    manifest.assets = [
      {
        id: 'tampered-asset',
        href: 'assets/tampered.png',
        mediaType: 'image/png',
        kind: 'raster',
        rendition: 'source-preserved',
        sha256: '0'.repeat(64),
      },
    ]
    const withAsset = {
      ...original,
      'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      'EPUB/package.opf': strToU8(
        strFromU8(original['EPUB/package.opf']).replace(
          '</manifest>',
          '<item id="tampered-asset" href="assets/tampered.png" media-type="image/png" /></manifest>',
        ),
      ),
      'EPUB/content.xhtml': strToU8(
        strFromU8(original['EPUB/content.xhtml']).replace(
          '</main>',
          '<img src="assets/tampered.png" alt="tampered" /></main>',
        ),
      ),
      'EPUB/assets/tampered.png': new Uint8Array([1, 2, 3]),
    }

    expect(() => inspectEpub(rezipEpub(withAsset))).toThrow(/SHA-256/i)

    const duplicateOpf = {
      ...original,
      'EPUB/package.opf': strToU8(
        strFromU8(original['EPUB/package.opf']).replace(
          '</manifest>',
          '<item id="content" href="content.xhtml" media-type="application/xhtml+xml" /></manifest>',
        ),
      ),
    }
    expect(() => inspectEpub(rezipEpub(duplicateOpf))).toThrow(
      /duplicate manifest id/i,
    )

    const danglingSpine = {
      ...original,
      'EPUB/package.opf': strToU8(
        strFromU8(original['EPUB/package.opf']).replace(
          'idref="content"',
          'idref="missing"',
        ),
      ),
    }
    expect(() => inspectEpub(rezipEpub(danglingSpine))).toThrow(
      /spine.*missing/i,
    )

    const malformed = {
      ...original,
      'EPUB/content.xhtml': strToU8(
        strFromU8(original['EPUB/content.xhtml']).replace('</main>', ''),
      ),
    }
    expect(() => inspectEpub(rezipEpub(malformed))).toThrow(/well-formed/i)
  })

  it('rejects receipt-backed raster signatures without complete image structure', async () => {
    const epub = await buildEpub(paper)
    const original = unzipSync(epub.bytes)
    const cases = [
      {
        id: 'truncated-png',
        href: 'assets/truncated.png',
        mediaType: 'image/png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
      {
        id: 'truncated-jpeg',
        href: 'assets/truncated.jpg',
        mediaType: 'image/jpeg',
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      },
      {
        id: 'truncated-gif',
        href: 'assets/truncated.gif',
        mediaType: 'image/gif',
        bytes: strToU8('GIF89a'),
      },
    ] as const

    for (const candidate of cases) {
      const manifest = JSON.parse(strFromU8(original['EPUB/export.json']))
      manifest.assets.push({
        id: candidate.id,
        href: candidate.href,
        mediaType: candidate.mediaType,
        sha256: await sha256Hex(candidate.bytes),
      })
      const tampered = {
        ...original,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
        'EPUB/package.opf': strToU8(
          strFromU8(original['EPUB/package.opf']).replace(
            '</manifest>',
            `<item id="${candidate.id}" href="${candidate.href}" media-type="${candidate.mediaType}" /></manifest>`,
          ),
        ),
        'EPUB/content.xhtml': strToU8(
          strFromU8(original['EPUB/content.xhtml']).replace(
            '</main>',
            `<img src="${candidate.href}" alt="truncated" /></main>`,
          ),
        ),
        [`EPUB/${candidate.href}`]: candidate.bytes,
      }

      expect(() => inspectEpub(rezipEpub(tampered))).toThrow(
        new RegExp(`bytes do not match ${candidate.mediaType}`),
      )
    }
  })

  it('rejects a receipt-backed alternate XHTML document swapped into the OPF spine', async () => {
    const epub = await buildEpub(paper, getTargetProfile('paperPro'))
    const files = unzipSync(epub.bytes)
    const alternate = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Alternate</title></head><body><main>Alternate spine content.</main></body></html>`)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))
    manifest.assets.push({
      id: 'alternate-content',
      href: 'alternate.xhtml',
      mediaType: 'application/xhtml+xml',
      sha256: await sha256Hex(alternate),
    })
    const swapped = {
      ...files,
      'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      'EPUB/package.opf': strToU8(
        strFromU8(files['EPUB/package.opf'])
          .replace(
            '</manifest>',
            '<item id="alternate-content" href="alternate.xhtml" media-type="application/xhtml+xml" /></manifest>',
          )
          .replace('idref="content"', 'idref="alternate-content"'),
      ),
      'EPUB/alternate.xhtml': alternate,
    }

    expect(() =>
      inspectEpub(rezipEpub(swapped), getTargetProfile('paperPro')),
    ).toThrow(/spine.*content\.xhtml|content\.xhtml.*spine/i)
  })

  it('rejects single-quoted dangling href, src, and data attributes', async () => {
    const epub = await buildEpub(paper)
    const files = unzipSync(epub.bytes)
    const cases = [
      {
        markup: "<a href='#missing-fragment'>missing</a>",
        expected: /dangling internal reference #missing-fragment/i,
      },
      {
        markup:
          "<a href='missing-document.xhtml#missing-fragment'>missing document</a>",
        expected: /dangling internal reference missing-document\.xhtml/i,
      },
      {
        markup:
          "<a xmlns:xlink='http://www.w3.org/1999/xlink' xlink:href='#missing-namespaced-fragment'>missing namespaced fragment</a>",
        expected: /dangling internal reference #missing-namespaced-fragment/i,
      },
      {
        markup: "<img src='assets/missing.png' alt='missing' />",
        expected: /dangling asset reference assets\/missing\.png/i,
      },
      {
        markup:
          "<object data='assets/missing.xhtml' type='application/xhtml+xml' />",
        expected: /dangling asset reference assets\/missing\.xhtml/i,
      },
    ]

    for (const candidate of cases) {
      const tampered = {
        ...files,
        'EPUB/content.xhtml': strToU8(
          strFromU8(files['EPUB/content.xhtml']).replace(
            '</main>',
            `${candidate.markup}</main>`,
          ),
        ),
      }

      expect(() => inspectEpub(rezipEpub(tampered))).toThrow(candidate.expected)
    }
  })

  it.each([
    ['supplement.xhtml/', 'supplement.xhtml'],
    ['chapters//supplement.xhtml', 'chapters/supplement.xhtml'],
  ])(
    'does not alias internal href %s to packaged document %s',
    async (href, packagedHref) => {
      const epub = await buildEpub(paper)
      const files = unzipSync(epub.bytes)
      const packaged = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Supplement</title></head><body><p>Different exact path.</p></body></html>`)
      const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))
      manifest.assets.push({
        id: 'path-alias-supplement',
        href: packagedHref,
        mediaType: 'application/xhtml+xml',
        sha256: await sha256Hex(packaged),
      })
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
        'EPUB/package.opf': strToU8(
          strFromU8(files['EPUB/package.opf']).replace(
            '</manifest>',
            `<item id="path-alias-supplement" href="${packagedHref}" media-type="application/xhtml+xml" /></manifest>`,
          ),
        ),
        'EPUB/content.xhtml': strToU8(
          strFromU8(files['EPUB/content.xhtml']).replace(
            '</main>',
            `<a href="${href}">Broken alias</a></main>`,
          ),
        ),
        [`EPUB/${packagedHref}`]: packaged,
      }

      expect(() => inspectEpub(rezipEpub(tampered))).toThrow(
        new RegExp(
          `dangling internal reference ${href.replaceAll('/', '\\/')}`,
        ),
      )
    },
  )

  it('rejects hidden duplicate canonical citation text in serialized XHTML', async () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [62, 63].',
        inlineRuns: [
          {
            start: 11,
            end: 19,
            relationshipId: 'citation-list',
            semanticRole: 'citation',
            targetIds: ['reference-62', 'reference-63'],
          },
        ],
        source: 'serialized-citation-audit',
      },
      ...[62, 63].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        source: 'serialized-citation-audit',
      })),
    ]
    const epub = await buildEpub(citationPaper)
    const files = unzipSync(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const tamperedContent = content.replace(
      '</span>.</p>',
      '<a href="#reference-63" epub:type="biblioref" class="additional-biblioref"><span class="visually-hidden">[62, 63]</span></a></span>.</p>',
    )
    expect(tamperedContent).not.toBe(content)

    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/content.xhtml': strToU8(tamperedContent),
        }),
      ),
    ).toThrow(/duplicate canonical citation text|hidden semantic text/iu)
  })

  it.each([
    {
      label: 'unbounded scholarly destination text',
      mutate: (content: string) =>
        content.replace('>Eq. (3)</a>', '>Eq. (3) and the trailing clause</a>'),
      expected: /unbounded scholarly destination text/iu,
    },
    {
      label: 'overlapping nested destination anchor',
      mutate: (content: string) =>
        content.replace(
          '>Eq. (3)</a>',
          '><a href="#equation-3">Eq. (3)</a></a>',
        ),
      expected: /overlapping.*anchor|nested.*anchor/iu,
    },
  ])('rejects $label in serialized XHTML', async ({ mutate, expected }) => {
    const linkedPaper = structuredClone(paper)
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'See Eq. (3).',
        inlineRuns: [
          {
            start: 4,
            end: 11,
            href: '#equation-3',
            annotationId: 'pdf-link-equation-3',
          },
        ],
        source: 'serialized-link-audit',
      },
      {
        id: 'equation-3',
        type: 'figure',
        objectType: 'equation',
        title: 'Equation 3',
        relationships: { caption: 'equation-3-caption' },
        source: 'serialized-link-audit',
      },
      {
        id: 'equation-3-caption',
        type: 'caption',
        text: 'Equation 3.',
        source: 'serialized-link-audit',
      },
    ]
    const epub = await buildEpub(linkedPaper)
    const files = unzipSync(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const tamperedContent = mutate(content)
    expect(tamperedContent).not.toBe(content)

    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/content.xhtml': strToU8(tamperedContent),
        }),
      ),
    ).toThrow(expected)
  })

  it('preserves canonical reading order and addressable node IDs in XHTML', async () => {
    const epub = await buildEpub(paper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))

    expect(manifest.canonicalNodeIds).toEqual(
      paper.nodes.map((node) => node.id),
    )
    for (const node of paper.nodes) {
      expect(content).toContain(`id="${node.id}"`)
    }
    expect(content.indexOf(paper.nodes[0].id)).toBeLessThan(
      content.indexOf(paper.nodes.at(-1)!.id),
    )
  })

  it('fails before XHTML generation when canonical node ids are not globally unique', async () => {
    const duplicateIds = structuredClone(paper)
    duplicateIds.nodes[1].id = duplicateIds.nodes[0].id

    await expect(buildEpub(duplicateIds)).rejects.toThrow(
      /canonical node ids must be globally unique/i,
    )
  })

  it('requires a typed, non-empty canonicalNodeIds integrity receipt', async () => {
    const epub = await buildEpub(paper)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, unknown>
    const invalidReceipts: unknown[] = [undefined, [], ['valid-id', 7]]

    for (const canonicalNodeIds of invalidReceipts) {
      const manifest = { ...originalManifest }
      if (canonicalNodeIds === undefined) delete manifest.canonicalNodeIds
      else manifest.canonicalNodeIds = canonicalNodeIds
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      }

      expect(() => inspectEpub(rezipEpub(tampered))).toThrow(
        /canonicalNodeIds.*non-empty strings/i,
      )
    }
  })

  it('rejects tampered export receipt identity, hash fields, and unknown fields', async () => {
    const epub = await buildEpub(paper)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, unknown>
    const expected = {
      canonicalPaper: paper,
      sourceCanonicalPaper: paper,
    }
    const cases: Array<{
      name: string
      mutate: (manifest: Record<string, unknown>) => void
      expected: RegExp
    }> = [
      {
        name: 'changed receipt URN',
        mutate: (manifest) => {
          manifest.identifier =
            'urn:srt:substituted:000000000000000000000000:publication'
        },
        expected: /identifier.*OPF|OPF.*identifier/i,
      },
      {
        name: 'type-confused canonical hash',
        mutate: (manifest) => {
          manifest.canonicalContentSha256 = 7
        },
        expected: /canonicalContentSha256.*SHA-256/i,
      },
      {
        name: 'malformed source canonical hash',
        mutate: (manifest) => {
          manifest.sourceCanonicalContentSha256 = 'A'.repeat(64)
        },
        expected: /sourceCanonicalContentSha256.*SHA-256/i,
      },
      {
        name: 'validly shaped but false canonical hash',
        mutate: (manifest) => {
          manifest.canonicalContentSha256 = '0'.repeat(64)
        },
        expected: /canonicalContentSha256.*canonical input/i,
      },
      {
        name: 'validly shaped but false source canonical hash',
        mutate: (manifest) => {
          manifest.sourceCanonicalContentSha256 = '1'.repeat(64)
        },
        expected: /sourceCanonicalContentSha256.*canonical input/i,
      },
      {
        name: 'unknown receipt field',
        mutate: (manifest) => {
          manifest.untrustedExtension = true
        },
        expected: /unknown export manifest field/i,
      },
    ]

    for (const candidate of cases) {
      const manifest = structuredClone(originalManifest)
      candidate.mutate(manifest)
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      }

      expect(
        () => inspectEpub(rezipEpub(tampered), undefined, expected),
        candidate.name,
      ).toThrow(candidate.expected)
    }

    const opfIdentifier = String(originalManifest.identifier)
    const mismatchedOpf = {
      ...files,
      'EPUB/package.opf': strToU8(
        strFromU8(files['EPUB/package.opf']).replace(
          `>${opfIdentifier}</dc:identifier>`,
          '>urn:srt:substituted:000000000000000000000000:publication</dc:identifier>',
        ),
      ),
    }
    expect(() =>
      inspectEpub(rezipEpub(mismatchedOpf), undefined, expected),
    ).toThrow(/identifier.*OPF|OPF.*identifier/i)
  })

  it('validates a source PDF hash receipt and binds an expected source hash', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const sourcePdfSha256 = reconstruction.source.sha256
    const sourcePaper = reconstruction.paper
    const epub = await buildEpub(sourcePaper, reconstruction)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, unknown>
    const expected = {
      canonicalPaper: sourcePaper,
      sourceCanonicalPaper: sourcePaper,
      sourcePdfSha256,
    }

    expect(originalManifest).toMatchObject({
      canonicalHyphenDeletionCount: 0,
      canonicalHyphenDeletionContextCounts: {},
      canonicalHyphenDeletionLedger: [],
      canonicalHyphenDeletionLedgerSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(() => inspectEpub(epub.bytes, undefined, expected)).not.toThrow()

    for (const invalid of [7, 'A'.repeat(64), 'abc']) {
      const manifest = {
        ...originalManifest,
        sourcePdfSha256: invalid,
      }
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      }
      expect(() =>
        inspectEpub(rezipEpub(tampered), undefined, expected),
      ).toThrow(/sourcePdfSha256.*SHA-256/i)
    }

    expect(() =>
      inspectEpub(epub.bytes, undefined, {
        ...expected,
        sourcePdfSha256: 'b'.repeat(64),
      }),
    ).toThrow(/sourcePdfSha256.*expected source/i)
  })

  it('persists an exact validated model-consultation receipt in the PDF export manifest', async () => {
    const withReceipt = await resolvedVisualModelConsultation()
    const modelConsultations = withReceipt.modelConsultations!

    const epub = await buildReadableEpub(withReceipt.paper, withReceipt)
    const { files, manifest } = inspectEpub(epub.bytes, undefined, {
      canonicalPaper: withReceipt.paper,
      sourceCanonicalPaper: withReceipt.paper,
      sourcePdfSha256: withReceipt.source.sha256,
    })
    const serializedManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, unknown>

    expect(serializedManifest.modelConsultations).toEqual(modelConsultations)
    expect(manifest.modelConsultations).toEqual(modelConsultations)
  })

  it('refuses to publish model-derived state whose receipt was dropped', async () => {
    // The receipt was validated only when present, so deleting it laundered
    // the provenance: STRUCT refuses the same document with
    // MISSING_MODEL_CONSULTATION_RECEIPT, but the research EPUB — a shipping
    // export path — published it. A guarantee enforceable on one of two exits
    // is not a guarantee.
    const laundered = await resolvedVisualModelConsultation()
    expect(laundered.modelConsultations).toBeDefined()
    delete (laundered as { modelConsultations?: unknown }).modelConsultations

    await expect(buildReadableEpub(laundered.paper, laundered)).rejects.toThrow(
      'MISSING_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('rejects a same-source receipt for a differently resolved PDF at the direct EPUB boundary', async () => {
    const first = await resolvedVisualModelConsultation(0)
    const differentlyResolved = await resolvedVisualModelConsultation(1)
    differentlyResolved.modelConsultations = structuredClone(
      first.modelConsultations,
    )

    await expect(
      buildReadableEpub(differentlyResolved.paper, differentlyResolved),
    ).rejects.toThrow(/model consultation receipt.*semantic state/i)
  })

  it('rejects a valid alternate-resolution receipt swapped into a packaged EPUB manifest', async () => {
    const first = await resolvedVisualModelConsultation(0)
    const alternate = await resolvedVisualModelConsultation(1)
    const epub = await buildReadableEpub(first.paper, first)
    const files = unzipSync(epub.bytes)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json'])) as Record<
      string,
      unknown
    >
    manifest.modelConsultations = alternate.modelConsultations

    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
        }),
      ),
    ).toThrow(/model consultation receipt.*binding/i)
  })

  it('rejects malformed, pending, and unknown model-consultation receipt data', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const validReceipt = emptyModelConsultationReceipt(reconstruction)
    const withReceipt = withModelConsultations(reconstruction, validReceipt)
    const epub = await buildEpub(withReceipt.paper, withReceipt)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, unknown>

    const malformed = structuredClone(originalManifest)
    ;(
      (malformed.modelConsultations as ModelFallbackReceipt).metrics as Record<
        string,
        unknown
      >
    ).untrustedNestedField = true
    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/export.json': strToU8(`${JSON.stringify(malformed)}\n`),
        }),
      ),
    ).toThrow(/model consultation receipt/i)

    const unknown = structuredClone(originalManifest)
    unknown.untrustedExtension = true
    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/export.json': strToU8(`${JSON.stringify(unknown)}\n`),
        }),
      ),
    ).toThrow(/unknown export manifest field/i)

    const pendingReceipt = await pendingModelConsultationReceipt(reconstruction)
    const pending = withModelConsultations(reconstruction, pendingReceipt)
    await expect(buildEpub(pending.paper, pending)).rejects.toThrow(
      /pending model consultation/i,
    )
    const pendingManifest = {
      ...originalManifest,
      modelConsultations: pendingReceipt,
    }
    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/export.json': strToU8(`${JSON.stringify(pendingManifest)}\n`),
        }),
      ),
    ).toThrow(/pending model consultation/i)
  })

  it('binds a persisted model-consultation receipt to its PDF document and source', async () => {
    const { reconstruction } = await staleEquationTranscriptFixture()
    const validReceipt = emptyModelConsultationReceipt(reconstruction)

    for (const receipt of [
      { ...validReceipt, documentId: 'different-document' },
      { ...validReceipt, sourceSha256: 'b'.repeat(64) },
    ]) {
      const mismatched = withModelConsultations(reconstruction, receipt)
      await expect(buildEpub(mismatched.paper, mismatched)).rejects.toThrow(
        /model consultation receipt.*(?:document|source)/i,
      )
    }

    const withReceipt = withModelConsultations(reconstruction, validReceipt)
    const epub = await buildEpub(withReceipt.paper, withReceipt)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, unknown>
    for (const modelConsultations of [
      { ...validReceipt, documentId: 'different-document' },
      { ...validReceipt, sourceSha256: 'b'.repeat(64) },
    ]) {
      const tampered = { ...originalManifest, modelConsultations }
      expect(() =>
        inspectEpub(
          rezipEpub({
            ...files,
            'EPUB/export.json': strToU8(`${JSON.stringify(tampered)}\n`),
          }),
        ),
      ).toThrow(/model consultation receipt.*(?:document|source)/i)
    }
  })

  it('rejects a publication export when a PDF reconstruction omits reassessment evidence', async () => {
    const partial = {
      source: {
        format: 'pdf',
        sha256: 'a'.repeat(64),
        fileName: 'partial.pdf',
        byteLength: 1024,
      },
      paper,
      readiness: { ready: true, blockingDiagnosticCodes: [] },
      noteRelationships: [],
      visualRelationships: [],
      assets: [],
    } as unknown as PdfReconstruction

    await expect(buildEpub(paper, partial)).rejects.toMatchObject({
      code: 'INCOMPLETE_RECONSTRUCTION',
    })
  })

  it('fails closed when publication reassessment omits or corrupts the semantic-flow ledger receipt', async () => {
    const complete = await readyExternalHyperlinkFixture()
    const missingDecisions = structuredClone(
      complete,
    ) as Partial<PdfReconstruction>
    delete missingDecisions.sourceSemanticFlowBoundaryDecisions
    const missingCount = structuredClone(complete) as Partial<PdfReconstruction>
    delete missingCount.sourceSemanticFlowBoundaryDecisionCount
    const malformed = structuredClone(complete) as unknown as {
      sourceSemanticFlowBoundaryDecisions: unknown[]
      sourceSemanticFlowBoundaryDecisionCount: number
    }
    malformed.sourceSemanticFlowBoundaryDecisions = [null]
    malformed.sourceSemanticFlowBoundaryDecisionCount = 1

    for (const candidate of [missingDecisions, missingCount, malformed]) {
      await expect(
        buildEpub(complete.paper, candidate as PdfReconstruction),
      ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })
    }
  })

  it('persists and validates the PDF semantic-flow boundary receipt', async () => {
    const complete = await readyExternalHyperlinkFixture()
    const epub = await buildEpub(complete.paper, complete)
    const files = unzipSync(epub.bytes)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json'])) as {
      sourceSemanticFlowBoundaryCount: number
      sourceSemanticFlowBoundaryLedger: unknown[]
      sourceSemanticFlowBoundaryLedgerSha256: string
    }

    expect(manifest.sourceSemanticFlowBoundaryCount).toBe(
      complete.sourceSemanticFlowBoundaryDecisionCount,
    )
    expect(manifest.sourceSemanticFlowBoundaryLedger).toHaveLength(
      complete.sourceSemanticFlowBoundaryDecisionCount,
    )
    expect(manifest.sourceSemanticFlowBoundaryLedgerSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    )
    expect(() =>
      inspectEpub(epub.bytes, undefined, {
        sourceSemanticFlowBoundaryLedgerSha256:
          manifest.sourceSemanticFlowBoundaryLedgerSha256,
      }),
    ).not.toThrow()
  })

  it('rejects a canonically hashed default-space semantic-flow manifest record', async () => {
    const complete = await readyExternalHyperlinkFixture()
    const epub = await buildEpub(complete.paper, complete)
    const files = unzipSync(epub.bytes)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json'])) as Record<
      string,
      unknown
    >
    const endpoint = {
      regionId: '1'.repeat(64),
      lineId: '2'.repeat(64),
      runIndex: 0,
      sourceSequenceIndex: 0,
      sourceRunSha256: '3'.repeat(64),
      sourceFragmentId: '4'.repeat(64),
    }
    const to = {
      ...endpoint,
      regionId: '5'.repeat(64),
      lineId: '6'.repeat(64),
      sourceSequenceIndex: 1,
      sourceRunSha256: '7'.repeat(64),
      sourceFragmentId: '8'.repeat(64),
    }
    const evidence = [
      'exact-source-sequence-adjacency',
      'explicit-fragment-lineage',
      'font-baseline-compatible',
    ]
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          'pdf-source-semantic-flow-boundary-v1',
          1,
          0,
          'pdf-text',
          'inline-stacked-fragment',
          'space',
          [
            endpoint.regionId,
            endpoint.lineId,
            endpoint.runIndex,
            endpoint.sourceSequenceIndex,
            endpoint.sourceRunSha256,
            endpoint.sourceFragmentId,
          ],
          [
            to.regionId,
            to.lineId,
            to.runIndex,
            to.sourceSequenceIndex,
            to.sourceRunSha256,
            to.sourceFragmentId,
          ],
          evidence,
        ]),
      )
      .digest('hex')
    const records = [
      {
        id,
        page: 1,
        rotation: 0,
        method: 'pdf-text',
        topology: 'inline-stacked-fragment',
        outcome: 'space',
        from: endpoint,
        to,
        evidenceSha256s: evidence.map((value) =>
          createHash('sha256').update(value).digest('hex'),
        ),
      },
    ]
    manifest.sourceSemanticFlowBoundaryCount = 1
    manifest.sourceSemanticFlowBoundaryLedger = records
    manifest.sourceSemanticFlowBoundaryLedgerSha256 =
      canonicalJsonSha256ForTest(records)
    const tampered = {
      ...files,
      'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
    }

    expect(() => inspectEpub(rezipEpub(tampered))).toThrow(
      /semantic-flow boundary ledger is invalid/iu,
    )
  })

  it('fails closed at publication export for missing, malformed, or duplicate canonical hyphen deletion proof', async () => {
    const complete = await readyCanonicalHyphenDeletionFixture()
    await expect(buildEpub(complete.paper, complete)).resolves.toMatchObject({
      mode: 'publication',
    })

    const malformed = structuredClone(complete)
    malformed.canonicalHyphenBoundaryDecisions[0].proof.pinnedSplit.index += 1
    const duplicate = structuredClone(complete)
    duplicate.canonicalHyphenBoundaryDecisions.push(
      structuredClone(duplicate.canonicalHyphenBoundaryDecisions[0]),
    )
    duplicate.canonicalHyphenBoundaryDecisionCount = 2
    const missing = structuredClone(complete) as Partial<PdfReconstruction>
    delete missing.canonicalHyphenBoundaryDecisions

    for (const candidate of [
      missing,
      {
        ...structuredClone(complete),
        canonicalHyphenBoundaryDecisions: [],
      },
      malformed,
      duplicate,
    ]) {
      await expect(
        buildEpub(complete.paper, candidate as PdfReconstruction),
      ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })
    }
    expect(
      malformed.regions.find(
        (region) => region.id === 'canonical-hyphen-from-region',
      )?.text,
    ).toBe('Repre-')
  })

  it('persists and validates the normalized PDF canonical hyphen deletion receipt', async () => {
    const complete = await readyCanonicalHyphenDeletionFixture()
    const epub = await buildEpub(complete.paper, complete)
    const files = unzipSync(epub.bytes)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json'])) as Record<
      string,
      unknown
    >
    const ledger = manifest.canonicalHyphenDeletionLedger as Array<
      Record<string, unknown>
    >
    const ledgerSha256 = manifest.canonicalHyphenDeletionLedgerSha256 as string

    expect(manifest).toMatchObject({
      canonicalHyphenDeletionCount: 1,
      canonicalHyphenDeletionContextCounts: {
        'canonical-flow-continuation': 1,
      },
      canonicalHyphenDeletionLedgerSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      proof: {
        tier: 'exact-same-document',
        sourceBoundaryProven: true,
        pinnedWordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        pinnedJoinedFormValid: true,
        pinnedSplit: {
          leftSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          rightSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          index: 5,
        },
        splitPointValid: true,
        exactSameDocumentJoinedFormSha256:
          expect.stringMatching(/^[a-f0-9]{64}$/),
        sameDocumentJoinedFormValid: true,
        hardHyphenFormSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        hardHyphenCounterproof: null,
        model: complete.canonicalHyphenBoundaryDecisions[0].proof.model,
        evidenceSha256s: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/),
        ]),
      },
    })
    expect(JSON.stringify(ledger)).not.toContain('Representation')
    expect(JSON.stringify(ledger)).not.toContain('language-scope:en-US->en-US')
    expect(() =>
      inspectEpub(epub.bytes, undefined, {
        canonicalHyphenDeletionLedgerSha256: ledgerSha256,
      }),
    ).not.toThrow()
    const legacyManifest = structuredClone(manifest)
    legacyManifest.schemaVersion = '1.1.0'
    const legacyRecords =
      legacyManifest.canonicalHyphenDeletionLedger as Array<{
        proof: Record<string, unknown>
      }>
    for (const record of legacyRecords) delete record.proof.tier
    legacyManifest.canonicalHyphenDeletionLedgerSha256 =
      canonicalJsonSha256ForTest(legacyRecords)
    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/export.json': strToU8(`${JSON.stringify(legacyManifest)}\n`),
        }),
      ),
    ).not.toThrow()
    expect(() =>
      inspectEpub(epub.bytes, undefined, {
        canonicalHyphenDeletionLedgerSha256: '0'.repeat(64),
      }),
    ).toThrow(/canonicalHyphenDeletionLedgerSha256.*expected PDF ledger/i)

    for (const field of [
      'canonicalHyphenDeletionCount',
      'canonicalHyphenDeletionContextCounts',
      'canonicalHyphenDeletionLedger',
      'canonicalHyphenDeletionLedgerSha256',
    ]) {
      const missing = structuredClone(manifest)
      delete missing[field]
      expect(() =>
        inspectEpub(
          rezipEpub({
            ...files,
            'EPUB/export.json': strToU8(`${JSON.stringify(missing)}\n`),
          }),
        ),
      ).toThrow(/missing.*canonical hyphen deletion receipt/i)
    }

    const countTampered = {
      ...structuredClone(manifest),
      canonicalHyphenDeletionCount: 0,
    }
    const duplicate = structuredClone(manifest)
    ;(duplicate.canonicalHyphenDeletionLedger as unknown[]).push(
      structuredClone(
        (duplicate.canonicalHyphenDeletionLedger as unknown[])[0],
      ),
    )
    duplicate.canonicalHyphenDeletionCount = 2
    duplicate.canonicalHyphenDeletionContextCounts = {
      'canonical-flow-continuation': 2,
    }
    const hashTampered = {
      ...structuredClone(manifest),
      canonicalHyphenDeletionLedgerSha256: '0'.repeat(64),
    }
    const joinedDigestMismatch = structuredClone(manifest)
    const joinedDigestMismatchRecords =
      joinedDigestMismatch.canonicalHyphenDeletionLedger as Array<{
        proof: { exactSameDocumentJoinedFormSha256: string }
      }>
    joinedDigestMismatchRecords[0].proof.exactSameDocumentJoinedFormSha256 =
      'f'.repeat(64)
    joinedDigestMismatch.canonicalHyphenDeletionLedgerSha256 =
      canonicalJsonSha256ForTest(joinedDigestMismatchRecords)

    const missingMandatoryEvidence = structuredClone(manifest)
    const missingMandatoryEvidenceRecords =
      missingMandatoryEvidence.canonicalHyphenDeletionLedger as Array<{
        proof: { evidenceSha256s: string[] }
      }>
    missingMandatoryEvidenceRecords[0].proof.evidenceSha256s = ['a'.repeat(64)]
    missingMandatoryEvidence.canonicalHyphenDeletionLedgerSha256 =
      canonicalJsonSha256ForTest(missingMandatoryEvidenceRecords)

    const forbiddenCounterproof = structuredClone(manifest)
    const forbiddenCounterproofRecords =
      forbiddenCounterproof.canonicalHyphenDeletionLedger as Array<{
        proof: { evidenceSha256s: string[] }
      }>
    forbiddenCounterproofRecords[0].proof.evidenceSha256s.push(
      canonicalHyphenEvidenceSha256ForTest(
        'hard-hyphen-form-valid:same-document',
      ),
    )
    forbiddenCounterproofRecords[0].proof.evidenceSha256s.sort()
    forbiddenCounterproof.canonicalHyphenDeletionLedgerSha256 =
      canonicalJsonSha256ForTest(forbiddenCounterproofRecords)

    for (const tampered of [
      countTampered,
      duplicate,
      hashTampered,
      joinedDigestMismatch,
      missingMandatoryEvidence,
      forbiddenCounterproof,
    ]) {
      expect(() =>
        inspectEpub(
          rezipEpub({
            ...files,
            'EPUB/export.json': strToU8(`${JSON.stringify(tampered)}\n`),
          }),
        ),
      ).toThrow(/canonical hyphen deletion/iu)
    }
  })

  it('persists and validates a derived-affix canonical hyphen receipt without joined-surface assertions', async () => {
    const complete = await readyDerivedAffixHyphenDeletionFixture()
    const epub = await buildEpub(complete.paper, complete)
    const files = unzipSync(epub.bytes)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json'])) as Record<
      string,
      unknown
    >
    const ledger = manifest.canonicalHyphenDeletionLedger as Array<{
      proof: Record<string, unknown>
    }>

    expect(manifest).toMatchObject({ schemaVersion: '1.2.0' })
    expect(ledger).toEqual([
      expect.objectContaining({
        proof: {
          tier: 'same-document-derived-affix',
          sourceBoundaryProven: true,
          derivedWordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          productivePrefix: {
            kind: 'prefix',
            value: 're',
            affixClass: 'PFX',
            flag: 'A',
            crossProduct: true,
            affixSha256:
              '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
          },
          baseWordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          derivationBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          pinnedBaseWordValid: true,
          pinnedSplit: {
            leftSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            rightSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            index: 11,
          },
          splitPointValid: true,
          exactSameDocumentBaseWordSha256:
            expect.stringMatching(/^[a-f0-9]{64}$/),
          sameDocumentBaseWordValid: true,
          hardHyphenFormSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          hardHyphenCounterproof: null,
          model: complete.canonicalHyphenBoundaryDecisions[0].proof.model,
          evidenceSha256s: expect.arrayContaining([
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ]),
        },
      }),
    ])
    expect(ledger[0].proof).not.toHaveProperty('pinnedJoinedFormValid')
    expect(ledger[0].proof).not.toHaveProperty('sameDocumentJoinedFormValid')
    expect(() => inspectEpub(epub.bytes)).not.toThrow()

    const tampered = structuredClone(manifest)
    const records = tampered.canonicalHyphenDeletionLedger as Array<{
      proof: {
        productivePrefix: { flag: string }
      }
    }>
    records[0].proof.productivePrefix.flag = 'Z'
    tampered.canonicalHyphenDeletionLedgerSha256 =
      canonicalJsonSha256ForTest(records)
    expect(() =>
      inspectEpub(
        rezipEpub({
          ...files,
          'EPUB/export.json': strToU8(`${JSON.stringify(tampered)}\n`),
        }),
      ),
    ).toThrow(/canonical hyphen deletion/iu)
  })

})
