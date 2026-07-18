import type {
  PdfCompletenessMetrics,
  PdfCompletenessPolicy,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfReadiness,
  PdfSemanticSignals,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { groupRunsIntoLines } from './pdf-lines'
import { classifyPdfNoteMarkers } from './pdf-note-classifier'
import { reconstructPageRegions } from './pdf-regions'
import type { ResearchNode, ResearchPaper } from './schema'

export const DEFAULT_PDF_COMPLETENESS_POLICY: PdfCompletenessPolicy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 1,
  minimumRelationshipCoverage: 1,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
}

type QualityInput = {
  pages: PdfPageAnalysis[]
  paper: ResearchPaper
  diagnostics: ReconstructionDiagnostic[]
  readingOrder?: PdfReadingOrderGraph
  regions?: PdfPageRegion[]
  visualRelationships?: PdfVisualRelationship[]
  policy?: PdfCompletenessPolicy
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function normalizedText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function characterCount(value: string) {
  return [...value].length
}

function nodeText(node: ResearchNode) {
  if (node.type === 'footnote') {
    return `${node.kind === 'footnote' ? 'Footnote' : 'Endnote'} ${node.label} ${node.text}`
  }
  if ('text' in node) return node.text
  return node.type === 'figure' ? node.title : ''
}

function matchedCharacters(source: string, output: string) {
  const remaining = new Map<string, number>()
  for (const character of output) {
    remaining.set(character, (remaining.get(character) ?? 0) + 1)
  }
  let matched = 0
  for (const character of source) {
    const count = remaining.get(character) ?? 0
    if (count < 1) continue
    matched += 1
    remaining.set(character, count - 1)
  }
  return matched
}

function pageLines(page: PdfPageAnalysis) {
  return groupRunsIntoLines(page)
}

export function detectPdfSemanticSignals(
  pages: PdfPageAnalysis[],
  suppliedRegions?: PdfPageRegion[],
): PdfSemanticSignals {
  const regions = suppliedRegions ?? reconstructPageRegions(pages).regions
  const markerResult = classifyPdfNoteMarkers(regions)
  const signals: PdfSemanticSignals = {
    captions: 0,
    tables: 0,
    equations: 0,
    footnoteReferences: markerResult.classifications.filter(
      (classification) => classification.disposition === 'note-reference',
    ).length,
    footnotes: markerResult.noteBodyRegionIds.length,
  }
  for (const page of pages) {
    for (const line of pageLines(page)) {
      if (/^(?:fig(?:ure)?\.?\s*\d+\b|figure\s*[:.-])/i.test(line.text)) {
        signals.captions += 1
      }
      if (/^table\s+(?:\d+|[ivxlcdm]+)\b/i.test(line.text)) {
        signals.tables += 1
      }
      if (/(?:^|\b)(?:equation|eq\.?)\s*\(?\d+\)?/i.test(line.text)) {
        signals.equations += 1
      }
    }
  }
  return signals
}

function coverage(resolved: number, expected: number) {
  return expected === 0 ? 1 : rounded(Math.min(resolved / expected, 1))
}

function relationshipCounts(
  paper: ResearchPaper,
  signals: PdfSemanticSignals,
  visualRelationships?: PdfVisualRelationship[],
) {
  const captions = new Set(
    paper.nodes
      .filter((node) => node.type === 'caption')
      .map((node) => node.id),
  )
  const resolvedCaptions = visualRelationships
    ? visualRelationships.filter(
        (relationship) =>
          relationship.kind === 'figure' && relationship.status === 'matched',
      ).length
    : new Set(
        paper.nodes
          .filter(
            (node): node is Extract<ResearchNode, { type: 'figure' }> =>
              node.type === 'figure' &&
              captions.has(node.relationships.caption),
          )
          .map((node) => node.relationships.caption),
      ).size
  const resolvedTables =
    visualRelationships?.filter(
      (relationship) =>
        relationship.kind === 'table' && relationship.status === 'matched',
    ).length ?? 0
  const resolvedEquations =
    visualRelationships?.filter(
      (relationship) =>
        relationship.kind === 'equation' && relationship.status === 'matched',
    ).length ?? 0
  const noteIds = new Set(
    paper.nodes
      .filter((node) => node.type === 'footnote')
      .map((node) => node.id),
  )
  const noteReferences = paper.nodes.flatMap((node) =>
    'noteReferences' in node && node.noteReferences ? node.noteReferences : [],
  )
  const resolvedNoteReferences = noteReferences.filter((reference) =>
    noteIds.has(reference.target),
  )
  const resolvedNotes = new Set(
    resolvedNoteReferences.map((reference) => reference.target),
  )
  return {
    expected:
      signals.captions +
      signals.tables +
      signals.equations +
      signals.footnoteReferences,
    resolved:
      Math.min(resolvedCaptions, signals.captions) +
      Math.min(resolvedTables, signals.tables) +
      Math.min(resolvedEquations, signals.equations) +
      Math.min(resolvedNoteReferences.length, signals.footnoteReferences),
    resolvedCaptions: Math.min(resolvedCaptions, signals.captions),
    resolvedTables: Math.min(resolvedTables, signals.tables),
    resolvedEquations: Math.min(resolvedEquations, signals.equations),
    resolvedNoteReferences: Math.min(
      resolvedNoteReferences.length,
      signals.footnoteReferences,
    ),
    resolvedNotes: Math.min(resolvedNotes.size, signals.footnotes),
  }
}

function readingOrderDiagnosticCount(diagnostics: ReconstructionDiagnostic[]) {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === 'LOW_CONFIDENCE_BLOCK' ||
      diagnostic.code === 'AMBIGUOUS_READING_ORDER',
  ).length
}

export function assessPdfCompleteness({
  pages,
  paper,
  diagnostics,
  readingOrder,
  regions,
  visualRelationships,
  policy = DEFAULT_PDF_COMPLETENESS_POLICY,
}: QualityInput): {
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  diagnostics: ReconstructionDiagnostic[]
  readiness: PdfReadiness
} {
  const semanticSignals = detectPdfSemanticSignals(pages, regions)
  const sourceText = normalizedText(
    pages
      .flatMap((page) => page.runs)
      .map((run) => run.text)
      .join(' '),
  )
  const outputText = normalizedText(paper.nodes.map(nodeText).join(' '))
  const matchedTextCharacters = matchedCharacters(sourceText, outputText)
  const nativeObjects = pages
    .flatMap((page) => page.objects ?? [])
    .filter((object) => object.role !== 'scan-source')
  const sourceAssetCount =
    pages.reduce((total, page) => {
      const objects = page.objects ?? []
      const semanticObjectCount = objects.filter(
        (object) => object.role !== 'scan-source',
      ).length
      const provenScanSourceCount = objects.filter(
        (object) => object.role === 'scan-source',
      ).length
      return (
        total +
        Math.max(semanticObjectCount, page.imageCount - provenScanSourceCount)
      )
    }, 0) +
    semanticSignals.tables +
    semanticSignals.equations
  const exportedNativeObjects = nativeObjects.filter(
    (object) => object.assetId !== null,
  ).length
  const exportedFallbackObjects =
    visualRelationships
      ?.filter(
        (relationship) =>
          relationship.status === 'matched' &&
          (relationship.kind === 'table' || relationship.kind === 'equation'),
      )
      .reduce(
        (total, relationship) =>
          total +
          Math.min(
            relationship.sourceObjectIds.length,
            relationship.assetIds.length,
          ),
        0,
      ) ?? 0
  const exportedAssetCount = exportedNativeObjects + exportedFallbackObjects
  const relationships = relationshipCounts(
    paper,
    semanticSignals,
    visualRelationships,
  )
  const unresolvedObjects = {
    assets: Math.max(sourceAssetCount - exportedAssetCount, 0),
    captions: Math.max(
      semanticSignals.captions - relationships.resolvedCaptions,
      0,
    ),
    tables: Math.max(semanticSignals.tables - relationships.resolvedTables, 0),
    equations: Math.max(
      semanticSignals.equations - relationships.resolvedEquations,
      0,
    ),
    footnoteReferences: Math.max(
      semanticSignals.footnoteReferences - relationships.resolvedNoteReferences,
      0,
    ),
    footnotes: Math.max(
      semanticSignals.footnotes - relationships.resolvedNotes,
      0,
    ),
  }
  const unresolvedObjectCount = Object.values(unresolvedObjects).reduce(
    (total, count) => total + count,
    0,
  )
  const readingOrderDiagnostics = readingOrderDiagnosticCount(diagnostics)
  const readingOrderEvaluation =
    readingOrder?.evaluation ??
    ({
      schemaVersion: '1.0.0',
      algorithm: 'deterministic-geometry-v1',
      mode: 'deterministic-only',
      regionCount: 0,
      acceptedEdgeCount: 0,
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      orderAccuracy: null,
      provider: null,
      modelVersion: null,
      latencyMs: 0,
      costUsd: 0,
      reviewRequired: false,
    } as const)
  const completeness: PdfCompletenessMetrics = {
    sourceTextCharacters: characterCount(sourceText),
    outputTextCharacters: characterCount(outputText),
    matchedTextCharacters,
    textCoverage: coverage(matchedTextCharacters, characterCount(sourceText)),
    sourceAssetCount,
    exportedAssetCount,
    assetCoverage: coverage(exportedAssetCount, sourceAssetCount),
    expectedRelationshipCount: relationships.expected,
    resolvedRelationshipCount: relationships.resolved,
    relationshipCoverage: coverage(
      relationships.resolved,
      relationships.expected,
    ),
    unresolvedObjectCount,
    unresolvedObjects,
    ocrRequiredPages: pages
      .filter((page) => page.kind === 'ocr-required')
      .map((page) => page.page),
    readingOrderDiagnostics,
    readingOrderEvaluation,
  }
  const qualityDiagnostics: ReconstructionDiagnostic[] = []
  if (completeness.textCoverage < policy.minimumTextCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_TEXT_COVERAGE',
      severity: 'error',
      message: `Recovered text coverage ${completeness.textCoverage.toFixed(3)} is below the configured minimum ${policy.minimumTextCoverage.toFixed(3)}.`,
    })
  }
  if (completeness.assetCoverage < policy.minimumAssetCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_ASSET_COVERAGE',
      severity: 'error',
      message: `Reconstructed ${exportedAssetCount} of ${sourceAssetCount} source image objects; required coverage is ${policy.minimumAssetCoverage.toFixed(3)}.`,
    })
  }
  if (completeness.relationshipCoverage < policy.minimumRelationshipCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
      severity: 'error',
      message: `Resolved ${relationships.resolved} of ${relationships.expected} detected semantic relationships; required coverage is ${policy.minimumRelationshipCoverage.toFixed(3)}.`,
    })
  }
  if (unresolvedObjectCount > policy.maximumUnresolvedObjects) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_SEMANTIC_OBJECTS',
      severity: 'error',
      message: `${unresolvedObjectCount} detected semantic object${unresolvedObjectCount === 1 ? '' : 's'} remain unresolved (images ${unresolvedObjects.assets}, captions ${unresolvedObjects.captions}, tables ${unresolvedObjects.tables}, equations ${unresolvedObjects.equations}, footnote references ${unresolvedObjects.footnoteReferences}, notes ${unresolvedObjects.footnotes}).`,
    })
  }

  const allDiagnostics = [...diagnostics, ...qualityDiagnostics]
  const policyFailed =
    completeness.ocrRequiredPages.length > policy.maximumOcrRequiredPages ||
    readingOrderDiagnostics > policy.maximumReadingOrderDiagnostics ||
    readingOrderEvaluation.reviewRequired
  const blockingDiagnosticCodes = [
    ...new Set([
      ...allDiagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.code),
      ...(readingOrderDiagnostics > policy.maximumReadingOrderDiagnostics
        ? allDiagnostics
            .filter(
              (diagnostic) =>
                diagnostic.code === 'LOW_CONFIDENCE_BLOCK' ||
                diagnostic.code === 'AMBIGUOUS_READING_ORDER',
            )
            .map((diagnostic) => diagnostic.code)
        : []),
    ]),
  ]
  const ready = blockingDiagnosticCodes.length === 0 && !policyFailed

  return {
    semanticSignals,
    completeness,
    diagnostics: allDiagnostics,
    readiness: {
      status: ready ? 'ready' : 'review-required',
      ready,
      policy: { ...policy },
      blockingDiagnosticCodes,
    },
  }
}
