import type {
  PdfCompletenessMetrics,
  PdfCompletenessPolicy,
  PdfPageAnalysis,
  PdfReadiness,
  PdfSemanticSignals,
  ReconstructionDiagnostic,
} from './import-types'
import { groupRunsIntoLines } from './pdf-lines'
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

function upperQuartile(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.75) - 1]
}

function runGap(
  left: PdfPageAnalysis['runs'][number],
  right: PdfPageAnalysis['runs'][number],
) {
  return Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0,
  )
}

function renderedFootnoteMarkers(page: PdfPageAnalysis, bodyFontSize: number) {
  if (!bodyFontSize) return 0
  return page.runs.filter((run) => {
    if (!/^(?:\d{1,3}|[*†‡§])$/.test(run.text.trim())) return false
    if (run.fontSize > bodyFontSize * 0.82 || run.y > 0.88) return false
    const center = run.y + run.height / 2
    return page.runs.some((candidate) => {
      if (candidate === run || !candidate.text.trim()) return false
      const candidateCenter = candidate.y + candidate.height / 2
      return (
        candidate.fontSize > run.fontSize &&
        Math.abs(center - candidateCenter) <=
          Math.max(0.022, Math.max(run.height, candidate.height) * 1.2) &&
        runGap(run, candidate) <= 0.03
      )
    })
  }).length
}

export function detectPdfSemanticSignals(
  pages: PdfPageAnalysis[],
): PdfSemanticSignals {
  const signals: PdfSemanticSignals = {
    captions: 0,
    tables: 0,
    equations: 0,
    footnoteReferences: 0,
    footnotes: 0,
  }
  for (const page of pages) {
    const bodyFontSize = upperQuartile(
      page.runs.map((run) => run.fontSize).filter((size) => size > 0),
    )
    signals.footnoteReferences += renderedFootnoteMarkers(page, bodyFontSize)
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
      if (
        /\b(?:footnote|note)\s+(?:reference|marker)\s*\d+\b/i.test(line.text)
      ) {
        signals.footnoteReferences += 1
      }
      const explicitFootnote = /^(?:footnote|note)\s*\d+\s*[:.-]/i.test(
        line.text,
      )
      const renderedFootnote =
        line.y >= 0.7 &&
        line.fontSize <= bodyFontSize * 0.9 &&
        /^(?:\d{1,3}|[*†‡§])(?:[.)\]]|\s)/.test(line.text)
      if (explicitFootnote || renderedFootnote) signals.footnotes += 1
    }
  }
  return signals
}

function coverage(resolved: number, expected: number) {
  return expected === 0 ? 1 : rounded(Math.min(resolved / expected, 1))
}

function relationshipCounts(paper: ResearchPaper, signals: PdfSemanticSignals) {
  const captions = new Set(
    paper.nodes
      .filter((node) => node.type === 'caption')
      .map((node) => node.id),
  )
  const resolvedCaptions = new Set(
    paper.nodes
      .filter(
        (node): node is Extract<ResearchNode, { type: 'figure' }> =>
          node.type === 'figure' && captions.has(node.relationships.caption),
      )
      .map((node) => node.relationships.caption),
  ).size
  return {
    expected: signals.captions + signals.footnoteReferences,
    resolved: Math.min(resolvedCaptions, signals.captions),
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
  policy = DEFAULT_PDF_COMPLETENESS_POLICY,
}: QualityInput): {
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  diagnostics: ReconstructionDiagnostic[]
  readiness: PdfReadiness
} {
  const semanticSignals = detectPdfSemanticSignals(pages)
  const sourceText = normalizedText(
    pages
      .flatMap((page) => page.runs)
      .map((run) => run.text)
      .join(' '),
  )
  const outputText = normalizedText(paper.nodes.map(nodeText).join(' '))
  const matchedTextCharacters = matchedCharacters(sourceText, outputText)
  const sourceAssetCount = pages.reduce(
    (total, page) => total + page.imageCount,
    0,
  )
  // Figure nodes currently render placeholders only. Until the canonical model
  // carries an exported source-image payload and identity, none of those nodes
  // may satisfy source asset coverage.
  const exportedAssetCount = 0
  const relationships = relationshipCounts(paper, semanticSignals)
  const unresolvedObjects = {
    assets: Math.max(sourceAssetCount - exportedAssetCount, 0),
    captions: Math.max(semanticSignals.captions - relationships.resolved, 0),
    tables: semanticSignals.tables,
    equations: semanticSignals.equations,
    footnoteReferences: semanticSignals.footnoteReferences,
    footnotes: semanticSignals.footnotes,
  }
  const unresolvedObjectCount = Object.values(unresolvedObjects).reduce(
    (total, count) => total + count,
    0,
  )
  const readingOrderDiagnostics = readingOrderDiagnosticCount(diagnostics)
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
    readingOrderDiagnostics > policy.maximumReadingOrderDiagnostics
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
