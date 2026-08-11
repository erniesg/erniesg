import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
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
import { reconstructPageAnalyses } from './pdf-layout'
import { assessPdfCompleteness } from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { researchPaperSchema } from './schema'
import { getTargetProfile, resolveTargetProfile } from './targets'
import { createSourcePageCropAsset } from './visual-assets'

const paper = researchPaperSchema.parse(rawPaper)

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

function numericCitationTarget(id: string, ordinal: number | null) {
  return ordinal === null
    ? {
        id,
        type: 'paragraph' as const,
        text: 'Bibliography entry without a recoverable numeric marker.',
        source: 'synthetic-semantic-alignment',
      }
    : {
        id,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-semantic-alignment',
      }
}

function numericCitationPaper({
  surface,
  targetIds,
  targets,
}: {
  surface: string
  targetIds: string[]
  targets: Array<[id: string, ordinal: number | null]>
}) {
  const candidate = structuredClone(paper)
  candidate.nodes = [
    {
      id: 'semantic-alignment-claim',
      type: 'paragraph',
      text: surface,
      inlineRuns: [
        {
          start: 0,
          end: surface.length,
          relationshipId: 'semantic-alignment-citation',
          semanticRole: 'citation',
          targetIds,
        },
      ],
      source: 'synthetic-semantic-alignment',
    },
    ...targets.map(([id, ordinal]) => numericCitationTarget(id, ordinal)),
  ]
  return candidate
}

function equationRangePaper({
  surface,
  targetIds,
  identifiers,
}: {
  surface: string
  targetIds: string[]
  identifiers: Array<[id: string, identifier: string | null]>
}) {
  const candidate = structuredClone(paper)
  candidate.nodes = [
    {
      id: 'semantic-equation-claim',
      type: 'paragraph',
      text: surface,
      inlineRuns: [
        {
          start: 0,
          end: surface.length,
          relationshipId: 'semantic-equation-range',
          semanticRole: 'cross-reference',
          targetIds,
        },
      ],
      source: 'synthetic-semantic-alignment',
    },
    ...identifiers.flatMap(([id, identifier]) => [
      {
        id,
        type: 'figure' as const,
        objectType: 'equation' as const,
        title: identifier ? `Equation ${identifier}` : 'Source equation',
        relationships: { caption: `${id}-caption` },
        source: 'synthetic-semantic-alignment',
      },
      {
        id: `${id}-caption`,
        type: 'caption' as const,
        text: identifier
          ? `Equation ${identifier}. Source equation.`
          : 'Source equation without a recoverable identifier.',
        source: 'synthetic-semantic-alignment',
      },
    ]),
  ]
  return candidate
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

function parsedXmlElements(
  value: unknown,
  elementName: string,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = []
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, child] of Object.entries(candidate)) {
      if (key === elementName) {
        const elements = Array.isArray(child) ? child : [child]
        for (const element of elements) {
          if (element && typeof element === 'object') {
            matches.push(element as Record<string, unknown>)
          }
        }
      }
      visit(child)
    }
  }
  visit(value)
  return matches
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

  it('nests ordered and unordered list levels without changing surrounding node order', () => {
    const listPaper = structuredClone(paper)
    listPaper.nodes = [
      {
        id: 'before-list',
        type: 'paragraph',
        text: 'Before list.',
        source: 'synthetic-list-test',
      },
      {
        id: 'ordered-root',
        type: 'paragraph',
        text: 'Ordered root',
        list: { level: 1, ordered: true, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'unordered-child',
        type: 'paragraph',
        text: 'Unordered child',
        list: { level: 2, ordered: false, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'ordered-child',
        type: 'paragraph',
        text: 'Ordered child',
        list: { level: 2, ordered: true, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'ordered-peer',
        type: 'paragraph',
        text: 'Ordered peer',
        list: { level: 1, ordered: true, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'after-list',
        type: 'paragraph',
        text: 'After list.',
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content).toContain(
      '<ol class="publication-list" data-list-level="1" data-numbering-id="outline" data-marker-style="decimal"><li id="ordered-root" data-canonical-id="ordered-root" class="publication-list-item" data-list-level="1">Ordered root<ul class="publication-list" data-list-level="2" data-numbering-id="outline" data-marker-style="disc"><li id="unordered-child" data-canonical-id="unordered-child" class="publication-list-item" data-list-level="2">Unordered child</li></ul><ol class="publication-list" data-list-level="2" data-numbering-id="outline" data-marker-style="decimal"><li id="ordered-child" data-canonical-id="ordered-child" class="publication-list-item" data-list-level="2">Ordered child</li></ol></li><li id="ordered-peer" data-canonical-id="ordered-peer" class="publication-list-item" data-list-level="1">Ordered peer</li></ol>',
    )
    expect(content.indexOf('id="before-list"')).toBeLessThan(
      content.indexOf('id="ordered-root"'),
    )
    expect(content.indexOf('id="ordered-peer"')).toBeLessThan(
      content.indexOf('id="after-list"'),
    )
  })

  it('starts a new list when the numbering sequence changes', () => {
    const listPaper = structuredClone(paper)
    listPaper.nodes = [
      {
        id: 'sequence-a-one',
        type: 'paragraph',
        text: 'Sequence A one',
        list: { level: 1, ordered: true, numberingId: 'sequence-a' },
        source: 'synthetic-list-test',
      },
      {
        id: 'sequence-a-two',
        type: 'paragraph',
        text: 'Sequence A two',
        list: { level: 1, ordered: true, numberingId: 'sequence-a' },
        source: 'synthetic-list-test',
      },
      {
        id: 'sequence-b-one',
        type: 'paragraph',
        text: 'Sequence B one',
        list: { level: 1, ordered: true, numberingId: 'sequence-b' },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content.match(/<ol class="publication-list"/g)).toHaveLength(2)
    expect(content).toContain(
      'Sequence A two</li></ol>\n<ol class="publication-list" data-list-level="1" data-numbering-id="sequence-b" data-marker-style="decimal">',
    )
  })

  it('preserves inline formatting, links, and note references inside list items', () => {
    const listPaper = structuredClone(paper)
    const value = 'Bold 1 link'
    listPaper.nodes = [
      {
        id: 'inline-list-item',
        type: 'paragraph',
        text: value,
        list: { level: 1, ordered: false, numberingId: 'inline-list' },
        inlineRuns: [
          { start: 0, end: 4, bold: true },
          { start: 5, end: 6, verticalAlign: 'superscript' },
          { start: 7, end: 11, href: 'https://example.test/list' },
        ],
        noteReferences: [
          {
            id: 'inline-note-reference',
            label: '1',
            target: 'inline-note',
            start: 5,
            end: 6,
            confidence: 1,
          },
        ],
        source: 'synthetic-list-test',
      },
      {
        id: 'inline-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'Inline list note.',
        relationships: { backlinks: ['inline-note-reference'] },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content).toContain(
      '<li id="inline-list-item" data-canonical-id="inline-list-item" class="publication-list-item" data-list-level="1"><strong>Bold</strong> <a id="inline-note-reference" href="#inline-note" epub:type="noteref" role="doc-noteref"><sup>1</sup></a> <a href="https://example.test/list">link</a></li>',
    )
  })

  it('links canonical citation spans to their bibliography targets', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1].',
        inlineRuns: [
          {
            start: 11,
            end: 14,
            relationshipId: 'citation-1',
            semanticRole: 'citation',
            targetIds: ['reference-1'],
          },
        ],
        source: 'synthetic-citation-test',
      },
      {
        id: 'reference-1',
        type: 'paragraph',
        text: '[1] Reference entry.',
        list: { level: 1, ordered: true, numberingId: 'references' },
        source: 'synthetic-citation-test',
      },
    ]

    const content = renderPublicationXhtml(citationPaper)

    expect(content).toContain(
      '<a id="citation-1" href="#reference-1" epub:type="biblioref" role="doc-biblioref" data-semantic-role="citation" data-relationship-id="citation-1" data-target-ids="reference-1">[1]</a>',
    )
  })

  it('renders a citation range once without hidden canonical-text copies', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1–3].',
        inlineRuns: [
          {
            start: 11,
            end: 16,
            relationshipId: 'citation-range',
            semanticRole: 'citation',
            targetIds: ['reference-1', 'reference-2', 'reference-3'],
          },
          { start: 12, end: 15, italic: true },
        ],
        source: 'synthetic-citation-range',
      },
      ...[1, 2, 3].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-citation-range',
      })),
    ]

    const content = renderPublicationXhtml(citationPaper)

    expect(content).toContain('href="#reference-1"')
    expect(content).toContain('href="#reference-2"')
    expect(content).toContain('href="#reference-3"')
    expect(content).toContain(
      'data-target-ids="reference-1 reference-2 reference-3"',
    )
    expect(content.match(/\sid="citation-range"/g)).toHaveLength(1)
    expect(content).toContain(
      '[<em><a href="#reference-1" epub:type="biblioref" role="doc-biblioref">1</a>–<a href="#reference-3" epub:type="biblioref" role="doc-biblioref">3</a></em>]',
    )
    expect(content.match(/>1<\/a>–<a[^>]*>3<\/a>/g)).toHaveLength(1)
    expect(content).toContain('class="additional-biblioref"')
  })

  it('maps mixed singleton and numeric-range citation labels without inventing visible text', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [16, 38–40].',
        inlineRuns: [
          {
            start: 11,
            end: 22,
            relationshipId: 'citation-mixed-range',
            semanticRole: 'citation',
            targetIds: [
              'reference-16',
              'reference-38',
              'reference-39',
              'reference-40',
            ],
          },
        ],
        source: 'synthetic-mixed-citation-range',
      },
      ...[16, 38, 39, 40].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-mixed-citation-range',
      })),
    ]

    const content = renderPublicationXhtml(citationPaper)

    expect(content).toContain('href="#reference-16"')
    expect(content).toContain('href="#reference-38"')
    expect(content).toContain('href="#reference-39"')
    expect(content).toContain('href="#reference-40"')
    expect(content).toContain(
      'data-target-ids="reference-16 reference-38 reference-39 reference-40"',
    )
    expect(content).toContain(
      '[<a href="#reference-16" epub:type="biblioref" role="doc-biblioref">16</a>, <a href="#reference-38" epub:type="biblioref" role="doc-biblioref">38</a>–<a href="#reference-40" epub:type="biblioref" role="doc-biblioref">40</a>]',
    )
    expect(content).toContain('class="additional-biblioref"')
  })

  it('fails closed when a mixed numeric citation range cannot account for every target', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [16, 38–40].',
        inlineRuns: [
          {
            start: 11,
            end: 22,
            relationshipId: 'citation-mixed-range-mismatch',
            semanticRole: 'citation',
            targetIds: [
              'reference-16',
              'reference-38',
              'reference-39',
              'reference-40',
              'reference-41',
            ],
          },
        ],
        source: 'synthetic-mixed-citation-range-mismatch',
      },
      ...[16, 38, 39, 40, 41].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-mixed-citation-range-mismatch',
      })),
    ]

    expect(() => renderPublicationXhtml(citationPaper)).toThrow(
      /EPUB_SEMANTIC_LINK_ALIGNMENT/u,
    )
  })

  it.each([
    {
      name: 'omits an implicit range member',
      surface: '[16, 38–40]',
      targetIds: ['reference-16', 'reference-38', 'reference-40'],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-40', 40],
      ],
    },
    {
      name: 'reorders canonical targets',
      surface: '[16, 38–40]',
      targetIds: [
        'reference-16',
        'reference-39',
        'reference-38',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-39', 39],
        ['reference-40', 40],
      ],
    },
    {
      name: 'duplicates a canonical target',
      surface: '[16, 38–40]',
      targetIds: [
        'reference-16',
        'reference-38',
        'reference-38',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-40', 40],
      ],
    },
    {
      name: 'contains an unknown canonical target identity',
      surface: '[16, 38–40]',
      targetIds: [
        'reference-16',
        'reference-38',
        'reference-unknown',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-unknown', null],
        ['reference-40', 40],
      ],
    },
    {
      name: 'uses whitespace instead of citation punctuation',
      surface: '[16 38–40]',
      targetIds: [
        'reference-16',
        'reference-38',
        'reference-39',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-39', 39],
        ['reference-40', 40],
      ],
    },
    {
      name: 'absorbs prose between explicit identifiers',
      surface: '[16] prose [38]',
      targetIds: ['reference-16', 'reference-38'],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
      ],
    },
  ] as const)(
    'fails closed when a citation surface $name',
    ({ surface, targetIds, targets }) => {
      expect(() =>
        renderPublicationXhtml(
          numericCitationPaper({
            surface,
            targetIds: [...targetIds],
            targets: targets.map(([id, ordinal]) => [id, ordinal]),
          }),
        ),
      ).toThrow(/EPUB_SEMANTIC_LINK_ALIGNMENT/u)
    },
  )

  it.each(['-', '–', '—'] as const)(
    'validates every compact dotted-equation target before linking %s endpoints',
    (connector) => {
      const surface = `Eqs. (4.17${connector}4.19)`
      const content = renderPublicationXhtml(
        equationRangePaper({
          surface,
          targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.19'],
          identifiers: [
            ['equation-4.17', '4.17'],
            ['equation-4.18', '4.18'],
            ['equation-4.19', '4.19'],
          ],
        }),
      )

      expect(content).toContain('href="#equation-4.17"')
      expect(content).toContain('href="#equation-4.19"')
      expect(content).toContain(
        'href="#equation-4.18" class="additional-cross-reference"',
      )
      expect(content).toContain(
        'data-target-ids="equation-4.17 equation-4.18 equation-4.19"',
      )
      expect(content).toContain(
        `Eqs. (<a href="#equation-4.17">4.17</a>${connector}<a href="#equation-4.19">4.19</a>)`,
      )
    },
  )

  it.each(['−', '‑', '‒'] as const)(
    'fails closed on unsupported Unicode range connector %s',
    (connector) => {
      const surface = `Eqs. (4.17${connector}4.19)`
      expect(() =>
        renderPublicationXhtml(
          equationRangePaper({
            surface,
            targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.19'],
            identifiers: [
              ['equation-4.17', '4.17'],
              ['equation-4.18', '4.18'],
              ['equation-4.19', '4.19'],
            ],
          }),
        ),
      ).toThrow(
        /DANGLING_EPUB_INTERNAL_REFERENCE|EPUB_SEMANTIC_LINK_ALIGNMENT/u,
      )
    },
  )

  it.each([
    {
      name: 'descends',
      surface: 'Eqs. (4.19-4.17)',
      targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.19'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.18', '4.18'],
        ['equation-4.19', '4.19'],
      ],
    },
    {
      name: 'omits an interior target',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-4.19'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.19', '4.19'],
      ],
    },
    {
      name: 'reorders targets',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-4.19', 'equation-4.18'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.18', '4.18'],
        ['equation-4.19', '4.19'],
      ],
    },
    {
      name: 'duplicates a target',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.18'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.18', '4.18'],
      ],
    },
    {
      name: 'contains an unknown target identity',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-unknown', 'equation-4.19'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-unknown', null],
        ['equation-4.19', '4.19'],
      ],
    },
  ] as const)(
    'fails closed when a compact dotted equation range $name',
    ({ surface, targetIds, identifiers }) => {
      expect(() =>
        renderPublicationXhtml(
          equationRangePaper({
            surface,
            targetIds: [...targetIds],
            identifiers: identifiers.map(([id, identifier]) => [
              id,
              identifier,
            ]),
          }),
        ),
      ).toThrow(/EPUB_SEMANTIC_LINK_ALIGNMENT/u)
    },
  )

  it('links every explicit citation label exactly once to its matching target', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [62, 63, 48].',
        inlineRuns: [
          {
            start: 11,
            end: 23,
            relationshipId: 'citation-list',
            semanticRole: 'citation',
            targetIds: ['reference-62', 'reference-63', 'reference-48'],
          },
        ],
        source: 'synthetic-citation-list',
      },
      ...[62, 63, 48].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-citation-list',
      })),
    ]

    const content = renderPublicationXhtml(citationPaper)

    for (const ordinal of [62, 63, 48]) {
      expect(content).toContain(
        `<a href="#reference-${ordinal}" epub:type="biblioref" role="doc-biblioref">${ordinal}</a>`,
      )
      expect(content.match(new RegExp(`>${ordinal}<`, 'g'))).toHaveLength(1)
    }
    expect(content).not.toContain('additional-biblioref')
    expect(content).not.toContain(
      '<span class="visually-hidden">[62, 63, 48]</span>',
    )
  })

  it('renders resolved scholarly cross references as semantic internal links', () => {
    const crossReferencePaper = structuredClone(paper)
    crossReferencePaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Figures 4 and 5.',
        inlineRuns: [
          {
            start: 0,
            end: 15,
            relationshipId: 'cross-reference-figures-4-5',
            semanticRole: 'cross-reference',
            targetIds: ['figure-4', 'figure-5'],
          },
        ],
        source: 'synthetic-cross-reference',
      },
      ...[4, 5].map((ordinal) => ({
        id: `figure-${ordinal}`,
        type: 'figure' as const,
        title: `Figure ${ordinal}`,
        objectType: 'figure' as const,
        relationships: { caption: `caption-${ordinal}` },
        source: 'synthetic-cross-reference',
      })),
      ...[4, 5].map((ordinal) => ({
        id: `caption-${ordinal}`,
        type: 'caption' as const,
        text: `Figure ${ordinal}.`,
        source: 'synthetic-cross-reference',
      })),
    ]

    const content = renderPublicationXhtml(crossReferencePaper)

    expect(content).toContain('href="#figure-4"')
    expect(content).toContain('href="#figure-5"')
    expect(content.match(/\sid="cross-reference-figures-4-5"/gu)).toHaveLength(
      1,
    )
    expect(content).toContain('data-semantic-role="cross-reference"')
    expect(content).toContain(
      'data-relationship-id="cross-reference-figures-4-5"',
    )
  })

  it.each([
    {
      semanticRole: 'citation' as const,
      relationshipId: 'overlapping-citation',
      targetId: 'overlapping-reference-target',
    },
    {
      semanticRole: 'cross-reference' as const,
      relationshipId: 'overlapping-cross-reference',
      targetId: 'overlapping-section-target',
    },
  ])(
    'preserves an internal $semanticRole target when an external PDF link overlaps it',
    ({ semanticRole, relationshipId, targetId }) => {
      const overlapPaper = structuredClone(paper)
      const marker = semanticRole === 'citation' ? '[1]' : 'Section 2'
      const externalHref = 'https://example.test/source-annotation'
      overlapPaper.nodes = [
        {
          id: 'overlapping-link-claim',
          type: 'paragraph',
          text: marker,
          inlineRuns: [
            {
              start: 0,
              end: marker.length,
              href: externalHref,
            },
            {
              start: 0,
              end: marker.length,
              relationshipId,
              semanticRole,
              targetIds: [targetId],
            },
          ],
          source: 'synthetic-overlapping-pdf-link',
        },
        {
          id: targetId,
          type: 'paragraph',
          text: 'Canonical internal target.',
          source: 'synthetic-overlapping-pdf-link',
        },
      ]

      const content = renderPublicationXhtml(overlapPaper)

      expect(content).toContain(`href="#${targetId}"`)
      expect(content).toContain(`data-relationship-id="${relationshipId}"`)
      expect(content).not.toContain(externalHref)
    },
  )

  it('narrows a broad PDF destination run to the exact scholarly marker', () => {
    const linkedPaper = structuredClone(paper)
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'The drift is given by (3). Basket claims follow.',
        inlineRuns: [
          {
            start: 13,
            end: 46,
            href: '#equation-3',
            annotationId: 'pdf-link-equation-3',
          },
        ],
        source: 'synthetic-broad-pdf-link',
      },
      {
        id: 'equation-3',
        type: 'figure',
        objectType: 'equation',
        title: 'Equation 3',
        relationships: { caption: 'equation-3-caption' },
        source: 'synthetic-broad-pdf-link',
      },
      {
        id: 'equation-3-caption',
        type: 'caption',
        text: 'Equation 3.',
        source: 'synthetic-broad-pdf-link',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      'The drift is given by <a href="#equation-3" data-source-annotation-id="pdf-link-equation-3">(3)</a>. Basket claims follow.',
    )
    expect(content).not.toContain(
      '<a href="#equation-3">given by (3). Basket claims follow</a>',
    )
  })

  it('keeps a multi-character Roman scholarly label bounded when the PDF destination and semantic run coincide', async () => {
    const linkedPaper = structuredClone(paper)
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'The filters are summarized in Table II.',
        inlineRuns: [
          {
            start: 30,
            end: 38,
            href: '#table-ii',
            annotationId: 'pdf-link-table-ii',
            relationshipId: 'cross-reference-table-ii',
            semanticRole: 'cross-reference',
            targetIds: ['table-ii'],
          },
        ],
        source: 'synthetic-roman-cross-reference',
      },
      {
        id: 'table-ii',
        type: 'figure',
        objectType: 'table',
        title: 'Table II',
        relationships: { caption: 'table-ii-caption' },
        source: 'synthetic-roman-cross-reference',
      },
      {
        id: 'table-ii-caption',
        type: 'caption',
        text: 'Table II. Phase filters.',
        source: 'synthetic-roman-cross-reference',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      '<a id="cross-reference-table-ii" href="#table-ii" data-semantic-role="cross-reference" data-relationship-id="cross-reference-table-ii" data-target-ids="table-ii">Table II</a>',
    )
    expect(content).not.toContain(
      'data-relationship-id="cross-reference-table-ii">II</a>',
    )
    await expect(buildEpub(linkedPaper)).resolves.toMatchObject({
      mode: 'publication',
    })
  })

  it('narrows a broad caption annotation to its exact table label', () => {
    const linkedPaper = structuredClone(paper)
    const caption =
      'Table 6. Thus if e.g., a name already appears in the premise, it can be easily copied. After each name, more prose follows.'
    linkedPaper.nodes = [
      {
        id: 'annotated-caption',
        type: 'caption',
        text: caption,
        inlineRuns: [
          {
            start: 0,
            end: caption.indexOf('more prose'),
            href: '#table-6',
            annotationId: 'pdf-link-table-6',
          },
        ],
        source: 'synthetic-broad-caption-link',
      },
      {
        id: 'table-6',
        type: 'figure',
        objectType: 'table',
        title: 'Table 6',
        relationships: { caption: 'table-6-caption' },
        source: 'synthetic-broad-caption-link',
      },
      {
        id: 'table-6-caption',
        type: 'caption',
        text: 'Table 6. The canonical visual caption.',
        source: 'synthetic-broad-caption-link',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      '<a href="#table-6" data-source-annotation-id="pdf-link-table-6">Table 6</a>. Thus if e.g.',
    )
    expect(content).not.toContain(
      '<a href="#table-6" data-source-annotation-id="pdf-link-table-6">Table 6. Thus',
    )
  })

  it('drops a coarse PDF destination when its scholarly kind conflicts with the visible marker', () => {
    const linkedPaper = structuredClone(paper)
    const claim = 'The prompt is shown in Table 22.'
    const semanticStart = claim.indexOf('Table 22')
    const annotationStart = claim.indexOf('shown')
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: claim,
        inlineRuns: [
          {
            start: annotationStart,
            end: claim.length - 1,
            href: '#figure-22',
            annotationId: 'pdf-link-figure-22',
          },
          {
            start: semanticStart,
            end: semanticStart + 'Table 22'.length,
            relationshipId: 'unresolved-table-22-reference',
            semanticRole: 'cross-reference',
            targetIds: [],
          },
        ],
        source: 'synthetic-conflicting-pdf-link',
      },
      {
        id: 'figure-22',
        type: 'figure',
        objectType: 'figure',
        title: 'Figure 22',
        relationships: { caption: 'figure-22-caption' },
        source: 'synthetic-conflicting-pdf-link',
      },
      {
        id: 'figure-22-caption',
        type: 'caption',
        text: 'Figure 22. An unrelated visual destination.',
        source: 'synthetic-conflicting-pdf-link',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      'shown in <span id="unresolved-table-22-reference" data-semantic-role="cross-reference" data-relationship-id="unresolved-table-22-reference">Table 22</span>.',
    )
    expect(content.match(/Table 22/gu)).toHaveLength(1)
    expect(content).not.toContain('href="#figure-22"')
    expect(content).not.toContain('pdf-link-figure-22')
  })

  it('keeps one semantic wrapper when a PDF destination resolves one label in an unresolved scholarly group', () => {
    const linkedPaper = structuredClone(paper)
    const claim = 'See Tables 54, 55, 56 for the generated stories.'
    const semanticStart = claim.indexOf('Tables 54')
    const annotationStart = claim.indexOf('54')
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: claim,
        inlineRuns: [
          {
            start: annotationStart,
            end: claim.length,
            href: '#table-55',
            annotationId: 'pdf-link-table-55',
          },
          {
            start: semanticStart,
            end: semanticStart + 'Tables 54, 55, 56'.length,
            relationshipId: 'partially-resolved-table-group',
            semanticRole: 'cross-reference',
            targetIds: [],
          },
        ],
        source: 'synthetic-partially-resolved-cross-reference',
      },
      {
        id: 'table-55',
        type: 'figure',
        objectType: 'table',
        title: 'Table 55',
        relationships: { caption: 'table-55-caption' },
        source: 'synthetic-partially-resolved-cross-reference',
      },
      {
        id: 'table-55-caption',
        type: 'caption',
        text: 'Table 55. The matched member of a partially resolved group.',
        source: 'synthetic-partially-resolved-cross-reference',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      '<span id="partially-resolved-table-group" data-semantic-role="cross-reference" data-relationship-id="partially-resolved-table-group">Tables 54, <a href="#table-55" data-source-annotation-id="pdf-link-table-55">55</a>, 56</span>',
    )
    expect(content.match(/Tables 54, /gu)).toHaveLength(1)
    expect(content.match(/href="#table-55"/gu)).toHaveLength(1)
  })

  it('emits one note-reference id when inline styling splits the marker', () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Claim 12.',
        noteReferences: [
          {
            id: 'note-reference-12',
            label: '12',
            target: 'note-12',
            start: 6,
            end: 8,
            confidence: 1,
          },
        ],
        inlineRuns: [
          { start: 6, end: 7, italic: true },
          { start: 7, end: 8, bold: true },
        ],
        source: 'synthetic-split-note',
      },
      {
        id: 'note-12',
        type: 'footnote',
        kind: 'footnote',
        label: '12',
        text: 'Split marker note.',
        relationships: { backlinks: ['note-reference-12'] },
        source: 'synthetic-split-note',
      },
    ]

    const content = renderPublicationXhtml(notePaper)

    expect(content.match(/id="note-reference-12"/g)).toHaveLength(1)
    expect(content).toContain(
      '<a id="note-reference-12" href="#note-12" epub:type="noteref" role="doc-noteref"><em>1</em><strong>2</strong></a>',
    )
  })

  it('emits footnote backlinks for rendered note-reference anchors', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Claim 2.',
        noteReferences: [
          {
            id: 'rendered-note-reference',
            label: '2',
            target: 'note-2',
            start: 6,
            end: 7,
            confidence: 1,
          },
        ],
        source: 'synthetic-orphan-backlink',
      },
      {
        id: 'note-2',
        type: 'footnote',
        kind: 'footnote',
        label: '2',
        text: 'The note remains readable at https://example.test/source.',
        relationships: {
          backlinks: ['rendered-note-reference'],
        },
        source: 'synthetic-orphan-backlink',
      },
    ]

    const epub = await buildEpub(notePaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('href="#rendered-note-reference"')
    expect(content).toContain('aria-label="Back to reference 2"')
    expect(content).toContain('The note remains readable at')
    expect(content).toContain(
      '<a href="https://example.test/source">https://example.test/source</a>.',
    )
  })

  it('emits footnote backlinks for note-reference anchors rendered inside associated captions', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'captioned-figure',
        type: 'figure',
        title: 'Captioned figure',
        relationships: { caption: 'caption-with-note' },
        source: 'synthetic-caption-note',
      },
      {
        id: 'caption-with-note',
        type: 'caption',
        text: 'Figure caption 6.',
        noteReferences: [
          {
            id: 'caption-note-reference-6',
            label: '6',
            target: 'caption-note-6',
            start: 15,
            end: 16,
            confidence: 1,
          },
        ],
        source: 'synthetic-caption-note',
      },
      {
        id: 'caption-note-6',
        type: 'footnote',
        kind: 'footnote',
        label: '6',
        text: 'A note referenced from the caption.',
        relationships: { backlinks: ['caption-note-reference-6'] },
        source: 'synthetic-caption-note',
      },
    ]

    const epub = await buildEpub(notePaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain(
      'id="caption-note-reference-6" href="#caption-note-6"',
    )
    expect(content).toContain('href="#caption-note-reference-6"')
  })

  it('omits a caption-note backlink when an unresolved visual suppresses its reference anchor', () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'unresolved-captioned-figure',
        type: 'figure',
        title: 'Unresolved captioned figure',
        relationships: { caption: 'unresolved-caption-with-note' },
        source: 'synthetic-unresolved-caption-note',
      },
      {
        id: 'unresolved-caption-with-note',
        type: 'caption',
        text: 'Figure caption 6.',
        noteReferences: [
          {
            id: 'suppressed-caption-note-reference-6',
            label: '6',
            target: 'suppressed-caption-note-6',
            start: 15,
            end: 16,
            confidence: 1,
          },
        ],
        source: 'synthetic-unresolved-caption-note',
      },
      {
        id: 'suppressed-caption-note-6',
        type: 'footnote',
        kind: 'footnote',
        label: '6',
        text: 'A note whose caption reference cannot render.',
        relationships: { backlinks: ['suppressed-caption-note-reference-6'] },
        source: 'synthetic-unresolved-caption-note',
      },
    ]

    const content = renderPublicationXhtml(notePaper, {
      reconstruction: {
        readiness: { ready: false },
        visualRelationships: [
          {
            id: 'unresolved-caption-visual',
            kind: 'figure',
            label: 'Figure 1',
            captionRegionId: 'source-caption-region',
            sourceRegionIds: [],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: ['unresolved-visual-text-owned'],
            candidates: [],
            sourceBoxes: [],
            sourceText: '',
            altText: 'Unresolved captioned figure',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'unresolved-caption-with-note',
          },
        ],
        assets: [],
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="unresolved-caption-with-note" data-canonical-id="unresolved-caption-with-note" hidden="hidden"',
    )
    expect(content).not.toContain('id="suppressed-caption-note-reference-6"')
    expect(content).not.toContain('href="#suppressed-caption-note-reference-6"')
  })

  it('omits a table-cell note backlink when an unresolved visual suppresses its reference anchor', () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'unresolved-table-with-note',
        type: 'figure',
        title: 'Unresolved table with note',
        objectType: 'table',
        table: {
          columns: [{ id: 'column-1', label: 'Value' }],
          rows: [
            {
              cells: [
                {
                  id: 'cell-1',
                  text: 'Value6',
                  noteReferences: [
                    {
                      id: 'suppressed-table-cell-note-reference-6',
                      label: '6',
                      target: 'suppressed-table-cell-note-6',
                      start: 5,
                      end: 6,
                      confidence: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
        relationships: { caption: 'unresolved-table-caption' },
        source: 'synthetic-unresolved-table-note',
      },
      {
        id: 'unresolved-table-caption',
        type: 'caption',
        text: 'Table caption 6.',
        source: 'synthetic-unresolved-table-note',
      },
      {
        id: 'suppressed-table-cell-note-6',
        type: 'footnote',
        kind: 'footnote',
        label: '6',
        text: 'A note whose table-cell reference cannot render.',
        relationships: {
          backlinks: ['suppressed-table-cell-note-reference-6'],
        },
        source: 'synthetic-unresolved-table-note',
      },
    ]

    const content = renderPublicationXhtml(notePaper, {
      reconstruction: {
        readiness: { ready: false },
        visualRelationships: [
          {
            id: 'unresolved-table-visual',
            kind: 'table',
            label: 'Table 1',
            captionRegionId: 'source-table-caption-region',
            sourceRegionIds: [],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: ['unresolved-visual-text-owned'],
            candidates: [],
            sourceBoxes: [],
            sourceText: '',
            altText: 'Unresolved table with note',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'unresolved-table-caption',
          },
        ],
        assets: [],
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="unresolved-table-with-note" data-canonical-id="unresolved-table-with-note" hidden="hidden"',
    )
    expect(content).not.toContain('id="suppressed-table-cell-note-reference-6"')
    expect(content).not.toContain(
      'href="#suppressed-table-cell-note-reference-6"',
    )
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

  it('renders validated canonical tables inline without a clipped nested document', () => {
    const tablePaper = structuredClone(paper)
    tablePaper.nodes = [
      {
        id: 'table-node',
        type: 'figure',
        title: 'Synthetic semantic table',
        objectType: 'table',
        table: {
          rows: [
            {
              cells: [
                {
                  text: 'Profile & target',
                  headerScope: 'column',
                  columnSpan: 6,
                  rowSpan: 1,
                },
              ],
            },
            {
              cells: [
                {
                  text: 'Mobile',
                  headerScope: 'row',
                  columnSpan: 1,
                  rowSpan: 1,
                },
                {
                  text: '<12>',
                  headerScope: null,
                  columnSpan: 1,
                  rowSpan: 1,
                },
                ...['Coherent', 'Relevant', 'Humanlike', 'Misc Problems'].map(
                  (text) => ({
                    text,
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  }),
                ),
              ],
            },
          ],
        },
        relationships: { caption: 'table-caption', assets: ['table-asset'] },
        sourceText:
          'Profile & target Mobile <12> Coherent Relevant Humanlike Misc Problems',
        source: 'synthetic-table-test',
      },
      {
        id: 'table-caption',
        type: 'caption',
        text: 'Table 1. Synthetic values.',
        source: 'synthetic-table-test',
      },
    ]
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const asset = {
      id: 'table-asset',
      href: 'assets/table-asset.xhtml',
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: 'a'.repeat(64),
      bytes: new TextEncoder().encode('<html><body><table /></body></html>'),
      width: 400,
      height: 160,
      resolutionDpi: null,
      sourceObjectIds: ['table-source'],
      sourceBoxes: [sourceBox],
    } satisfies PublicationAsset
    const relationship = {
      id: 'table-relationship',
      kind: 'table',
      label: 'Table 1',
      captionRegionId: 'table-caption-region',
      sourceRegionIds: ['table-region'],
      sourceObjectIds: ['table-source'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['synthetic-table-test'],
      candidates: [],
      sourceBoxes: [sourceBox],
      sourceText: '',
      altText: 'Synthetic semantic table',
      altTextSource: 'caption',
      canonicalNodeId: 'table-node',
      captionNodeId: 'table-caption',
    } satisfies PublicationVisualRelationship
    const reconstruction = {
      readiness: { ready: true },
      visualRelationships: [relationship],
      assets: [asset],
    } as unknown as PdfReconstruction

    const content = renderPublicationXhtml(tablePaper, {
      reconstruction,
      visualAssets: new Map([[asset.id, asset]]),
    })

    expect(content).toContain('class="semantic-table-wrapper"')
    expect(content).not.toContain('data-wide-source-visual="true"')
    expect(content).toContain('data-wide-table="true" data-table-columns="6"')
    expect(content).toContain('class="semantic-table-figure"')
    expect(content).toContain('data-asset-id="table-asset"')
    expect(content).toContain(
      'class="semantic-table-wrapper" role="region" aria-labelledby="table-caption"',
    )
    expect(content).not.toContain('aria-label="Scrollable table"')
    expect(content).toContain('<table aria-describedby="table-caption"><thead>')
    expect(content).toContain(
      '<th id="table-node-cell-r1-c1" scope="col" colspan="6">',
    )
    expect(content).toContain(
      '<th id="table-node-cell-r2-c1" scope="row">Mobile</th>',
    )
    expect(content).toContain('Profile &amp; target')
    expect(content).toContain('&lt;12&gt;')
    expect(content).toContain('<tbody>')
    expect(content).not.toContain('<object')

    const document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
    }).parse(content)
    const sourceTranscripts = parsedXmlElements(document, 'span').filter(
      (element) =>
        typeof element.class === 'string' &&
        element.class.split(/\s+/u).includes('visual-source-transcript'),
    )
    expect(sourceTranscripts).toEqual([
      expect.objectContaining({
        'aria-hidden': 'true',
        'data-source-transcript-for': 'table-node',
      }),
    ])
    expect(parsedXmlElements(document, 'table')).toHaveLength(1)
  })

  it('wraps wide source figures and raster tables in an accessible scroller while excluding equations and algorithms', () => {
    const figurePaper = {
      ...structuredClone(paper),
      nodes: [
        {
          id: 'wide-source-figure',
          type: 'figure' as const,
          objectType: 'figure' as const,
          title: 'Figure 1. A wide source diagram.',
          relationships: {
            caption: 'wide-source-caption',
            assets: ['wide-source-asset'],
          },
          source: 'synthetic-wide-source-figure',
        },
        {
          id: 'wide-source-caption',
          type: 'caption' as const,
          text: 'Figure 1. A wide source diagram.',
          source: 'synthetic-wide-source-figure',
        },
      ],
    }
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.25,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const asset = {
      id: 'wide-source-asset',
      href: 'assets/wide-source-asset.png',
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'source-page-crop',
      sha256: 'b'.repeat(64),
      bytes: new Uint8Array([1]),
      width: 1_200,
      height: 400,
      resolutionDpi: 220,
      sourceObjectIds: ['wide-source-object'],
      sourceBoxes: [sourceBox],
    } satisfies PublicationAsset
    const relationship = {
      id: 'wide-source-relationship',
      kind: 'figure',
      label: 'Figure 1',
      captionRegionId: 'wide-source-caption-region',
      sourceRegionIds: ['wide-source-region'],
      sourceObjectIds: ['wide-source-object'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['source-page-crop'],
      candidates: [],
      sourceBoxes: [sourceBox],
      sourceText: '',
      altText: 'Figure 1. A wide source diagram.',
      altTextSource: 'caption',
      canonicalNodeId: 'wide-source-figure',
      captionNodeId: 'wide-source-caption',
    } satisfies PublicationVisualRelationship
    const renderWithRelationship = (
      candidate: PublicationVisualRelationship,
      candidateAsset: PublicationAsset = asset,
    ) =>
      renderPublicationXhtml(figurePaper, {
        reconstruction: {
          readiness: { ready: true },
          visualRelationships: [candidate],
          assets: [candidateAsset],
        } as unknown as PdfReconstruction,
        visualAssets: new Map([[candidateAsset.id, candidateAsset]]),
      })

    const content = renderWithRelationship(relationship)
    const wrapperStart = content.indexOf(
      '<div class="wide-source-visual-frame" data-wide-source-visual="true" data-source-visual-kind="figure"',
    )
    const wrapperEnd = content.indexOf('</div>', wrapperStart)
    const captionStart = content.indexOf('<figcaption', wrapperStart)

    expect(wrapperStart).toBeGreaterThan(-1)
    expect(content).toContain('data-source-visual-kind="figure"><img')
    expect(wrapperEnd).toBeLessThan(captionStart)
    expect(
      renderWithRelationship({
        ...relationship,
        kind: 'table',
      }),
    ).toContain(
      'data-wide-source-visual="true" data-source-visual-kind="table"><img',
    )
    expect(
      renderWithRelationship(
        {
          ...relationship,
          kind: 'table',
        },
        {
          ...asset,
          kind: 'table',
          width: 1_378,
          height: 1_241,
        },
      ),
    ).toContain(
      'data-wide-source-visual="true" data-source-visual-kind="table"><img',
    )
    expect(
      renderWithRelationship(
        {
          ...relationship,
          kind: 'table',
        },
        {
          ...asset,
          kind: 'table',
          width: 672,
          height: 400,
        },
      ),
    ).not.toContain('data-wide-source-visual="true"')
    expect(
      renderWithRelationship({
        ...relationship,
        kind: 'equation',
      }),
    ).not.toContain('data-wide-source-visual="true"')
    expect(
      renderWithRelationship({
        ...relationship,
        semanticKind: 'algorithm',
      }),
    ).not.toContain('data-wide-source-visual="true"')
  })

  it('builds an explicitly non-publication-grade readable fallback without weakening the strict gate', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable text must still flow when a decorative image is unresolved.',
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
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: run.text.length,
      imageCount: 1,
      objects: [],
      runs: [run],
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [page],
      sourceHash: 'a'.repeat(64),
      fileName: 'readable-fallback.pdf',
      byteLength: 1024,
    })
    reconstruction.paper.title = run.text

    expect(reconstruction.readiness.ready).toBe(false)
    await expect(
      buildEpub(reconstruction.paper, reconstruction),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })

    const fallback = await buildReadableEpub(
      reconstruction.paper,
      reconstruction,
    )
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(fallback.mode).toBe('readable-fallback')
    expect(fallback.fileName).toMatch(/-readable\.epub$/)
    expect(content).toContain('Readable text must still flow')
    expect(content).toContain(
      '<title>Readable text must still flow when a decorative image is unresolved.</title>',
    )
    expect(content).not.toContain('<title>Publication</title>')
    expect(content.match(/Readable text must still flow/g)).toHaveLength(2)
    expect(content).not.toContain(
      'This readable fallback is incomplete and is not publication-grade.',
    )
    expect(content).not.toContain(
      'Omitted source visuals and unresolved relationships require review against the source PDF.',
    )
    expect(content).not.toContain('class="reconstruction-status"')
    expect(content).not.toContain('class="publication-header"')
    expect(content).not.toContain('class="reconstructed-header"')
    expect(content).not.toContain('class="reconstructed-header"')
    expect(content).not.toContain('working · 1970-01-01')
    expect(manifest).toMatchObject({
      exportMode: 'readable-fallback',
      publicationGrade: false,
      sourceReadiness: { ready: false },
    })
  })

  it('refuses a readable fallback for a sparse mixed raster page without OCR evidence', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Sparse embedded heading',
      x: 0.1,
      y: 0.1,
      width: 0.35,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 12,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'mixed',
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
      fileName: 'mixed-without-ocr.pdf',
      byteLength: 1024,
    })

    expect(reconstruction.completeness.ocrRequiredPages).toEqual([1])
    await expect(
      buildReadableEpub(reconstruction.paper, reconstruction),
    ).rejects.toMatchObject({
      code: 'INCOMPLETE_RECONSTRUCTION',
    })
  })

  it('keeps a complete bounded source-backed table image in readable fallback', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable prose around a source-backed table.',
      x: 0.1,
      y: 0.1,
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
      sourceHash: '7'.repeat(64),
      fileName: 'bounded-table-fallback.pdf',
      byteLength: 1024,
    })
    const captionBox = {
      page: 1,
      x: 0.15,
      y: 0.28,
      width: 0.7,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const tableBox = {
      page: 1,
      x: 0.18,
      y: 0.33,
      width: 0.64,
      height: 0.24,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const sourceTableWidth = 1_000
    const sourceTableHeight = 900
    const crop = await createSourcePageCropAsset({
      kind: 'table',
      cropBox: { ...tableBox, method: 'pdf-object' },
      sourceObjectIds: ['bounded-table-source'],
      sourceBoxes: [tableBox],
      width: sourceTableWidth,
      height: sourceTableHeight,
      pixels: new Uint8Array(sourceTableWidth * sourceTableHeight * 4).fill(80),
    })
    const sourceText = 'Method Score Baseline 72 Proposed 81'
    const figureNode = {
      id: 'bounded-table-node',
      type: 'figure' as const,
      objectType: 'table' as const,
      title: 'Table 1. Source-backed comparison.',
      sourceText,
      inlineRuns: [
        { start: 0, end: 'Method'.length, bold: true },
        {
          start: sourceText.indexOf('Proposed'),
          end: sourceText.indexOf('Proposed') + 'Proposed'.length,
          italic: true,
        },
      ],
      relationships: {
        caption: 'bounded-table-caption',
        assets: [crop.id],
      },
      source: 'synthetic-bounded-table',
    }
    const captionNode = {
      id: 'bounded-table-caption',
      type: 'caption' as const,
      text: 'Table 1. Source-backed comparison.',
      source: 'synthetic-bounded-table',
    }
    const relationship = {
      id: 'bounded-table-relationship',
      kind: 'table' as const,
      label: 'Table 1',
      captionRegionId: 'bounded-table-caption-region',
      sourceRegionIds: ['bounded-table-source-region'],
      sourceLineIds: ['bounded-table-header-line', 'bounded-table-body-line'],
      sourceObjectIds: ['bounded-table-source'],
      assetIds: [crop.id],
      status: 'matched' as const,
      confidence: 1,
      evidence: [
        'bounded-table-scope',
        'non-semantic-source-scope',
        'source-page-crop',
      ],
      candidates: [],
      sourceBoxes: [captionBox, tableBox],
      sourceText,
      altText: captionNode.text,
      altTextSource: 'caption' as const,
      canonicalNodeId: figureNode.id,
      captionNodeId: captionNode.id,
    }
    const withTable = {
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
          regionIds: relationship.sourceRegionIds,
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

    const fallback = await buildReadableEpub(withTable.paper, withTable)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('data-object-type="table"')
    expect(content).toContain(`data-asset-id="${crop.id}"`)
    expect(content).not.toContain('loading="lazy"')
    expect(content).toContain('loading="eager"')
    expect(content).toContain('Table 1. Source-backed comparison.')
    expect(content).toContain(
      '<span class="visually-hidden visual-source-transcript"',
    )
    expect(content).toContain(
      '<strong>Method</strong> Score Baseline 72 <em>Proposed</em> 81',
    )
    expect(content).not.toContain('<table')
    expect(manifest.visualRelationships).toEqual([
      expect.objectContaining({
        id: relationship.id,
        kind: 'table',
        assetIds: [crop.id],
      }),
    ])
    expect(manifest.assets).toEqual([
      expect.objectContaining({
        id: crop.id,
        kind: 'table',
        rendition: 'source-page-crop',
      }),
    ])

    const moveProfile = getTargetProfile('paperProMove')
    const moveFallback = await buildReadableEpub(
      withTable.paper,
      withTable,
      moveProfile,
    )
    const moveInspection = inspectEpub(moveFallback.bytes, moveProfile)
    const moveContent = strFromU8(moveInspection.files['EPUB/content.xhtml'])
    const moveManifest = moveInspection.manifest as {
      assets?: Array<Record<string, unknown>>
    }
    const moveTableAsset = moveManifest.assets?.find(
      (candidate) => candidate.sourceAssetId === crop.id,
    )

    expect(moveContent).toContain(
      'data-wide-source-visual="true" data-source-visual-kind="table"',
    )
    expect(moveContent).toContain(
      `<img src="${crop.href}" width="${sourceTableWidth}" height="${sourceTableHeight}"`,
    )
    expect(moveInspection.files[`EPUB/${crop.href}`]).toEqual(crop.bytes)
    expect(moveTableAsset).toMatchObject({
      id: crop.id,
      width: sourceTableWidth,
      height: sourceTableHeight,
      sourceAssetId: crop.id,
      policy: {
        id: 'preserve-scrollable-table-source',
        action: 'preserved',
        sourceWidth: sourceTableWidth,
        sourceHeight: sourceTableHeight,
        packagedWidth: sourceTableWidth,
        packagedHeight: sourceTableHeight,
        maximumWidth: null,
        resampling: 'none',
        neverUpscaled: true,
      },
    })
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
