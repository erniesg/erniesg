import type {
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
  PdfSourceSemanticFlowBoundaryDecision,
} from './import-types'
import { sha256HexSync } from './sha256-sync'

export function pdfSourceSemanticFlowRunSha256(run: PdfSourceRun) {
  return sha256HexSync(
    JSON.stringify([
      run.page,
      run.rotation,
      run.method,
      run.x,
      run.y,
      run.width,
      run.height,
      run.text.normalize('NFC'),
      run.fontName,
      run.fontSize,
      run.sourceSequenceIndex ?? null,
      run.sourceWhitespaceBefore ?? null,
      run.sourceWhitespacePredecessorIndex ?? null,
    ]),
  )
}

export function pdfSourceFragmentId(line: PdfRegionLine) {
  const lineage = line.sourceFragmentLineage
  return lineage ? `${lineage.sourceLineId}:${lineage.fragment}` : null
}

export const PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE = Object.freeze(
  [
    'exact-source-sequence-adjacency',
    'font-baseline-compatible',
    'explicit-fragment-lineage',
  ].sort(),
)

export const PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE = Object.freeze(
  [
    ...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
    'continuation-punctuation',
    'stacked-fragment-transition',
  ].sort(),
)

export const PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE = Object.freeze(
  [
    ...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
    'source-whitespace-separator',
  ].sort(),
)

export const PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE = Object.freeze(
  [
    'exact-source-sequence-adjacency',
    'explicit-fragment-lineage',
    'same-page-column-flow',
    'same-page-column-geometry',
  ].sort(),
)

// A page break is not a source-order adjacency: `sourceSequenceIndex` is the
// per-page text-item index, so the tail of page N and the head of page N+1 are
// never numerically adjacent. What the source can prove instead is that the
// tail is the last prose text item its page paints and the continuation is the
// first prose text item the next page paints, with only independently accounted
// non-prose between them. That includes issue 042 page furniture and validated
// visual/table ownership, neither of which may enter the paragraph.
export const PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE = Object.freeze(
  [
    'cross-page-column-geometry',
    'explicit-fragment-lineage',
    'non-prose-excluded-page-boundary',
    'page-head-source-order-extremum',
    'page-tail-source-order-extremum',
  ].sort(),
)

export type PdfBodySourceOrderExtremum = { first: number; last: number }

/**
 * Per-page first and last source text-item index over everything that is not
 * accounted page furniture or validated non-prose visual content. Extraction
 * and the independent quality audit both derive the cross-page prose boundary
 * from this map, so they cannot disagree about which runs a page break may skip.
 */
export function pdfBodySourceOrderExtremaByPage(
  regions: readonly Pick<
    PdfPageRegion,
    'id' | 'page' | 'lines' | 'furniture'
  >[],
  accountedNonProseRegionIds: ReadonlySet<string> = new Set(),
) {
  const extrema = new Map<number, PdfBodySourceOrderExtremum>()
  for (const region of regions) {
    if (region.furniture || accountedNonProseRegionIds.has(region.id)) continue
    for (const line of region.lines) {
      for (const run of line.runs) {
        if (!run.text.trim() || run.sourceSequenceIndex === undefined) continue
        const current = extrema.get(run.page)
        if (!current) {
          extrema.set(run.page, {
            first: run.sourceSequenceIndex,
            last: run.sourceSequenceIndex,
          })
          continue
        }
        current.first = Math.min(current.first, run.sourceSequenceIndex)
        current.last = Math.max(current.last, run.sourceSequenceIndex)
      }
    }
  }
  return extrema
}

export function pdfSourceColumnFlowStartsWithCjkNumericContinuation(
  continuationText: string,
) {
  return /^\p{N}+(?:[,.]\p{N}+)*(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/u.test(
    continuationText.trimStart(),
  )
}

export function pdfSourceColumnFlowJoinOutcome(
  language: string | null,
  continuationText: string,
  continuationRun: PdfSourceRun,
) {
  const hasSourceWhitespace =
    continuationRun.sourceWhitespaceBefore === 'pdf-text-item' &&
    continuationRun.sourceWhitespacePredecessorIndex !== undefined
  if (hasSourceWhitespace) {
    return { outcome: 'space' as const, separator: ' ' as const }
  }
  const cjkScript =
    /^[^\p{L}\p{N}]*(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/u.test(
      continuationText,
    ) || pdfSourceColumnFlowStartsWithCjkNumericContinuation(continuationText)
  return cjkScript
    ? { outcome: 'no-space' as const, separator: '' as const }
    : { outcome: 'space' as const, separator: ' ' as const }
}

export function canonicalPdfSourceSemanticFlowEvidence(
  evidence: readonly string[],
) {
  return [...new Set(evidence)].sort()
}

export function pdfSourceSemanticFlowBoundaryDecisionId(
  decision: Omit<PdfSourceSemanticFlowBoundaryDecision, 'id'>,
) {
  const endpoint = (value: PdfSourceSemanticFlowBoundaryDecision['from']) => [
    value.regionId,
    value.lineId,
    value.runIndex,
    value.sourceSequenceIndex,
    value.sourceRunSha256,
    value.sourceFragmentId,
  ]
  return sha256HexSync(
    JSON.stringify([
      'pdf-source-semantic-flow-boundary-v1',
      decision.page,
      decision.rotation,
      decision.method,
      decision.topology,
      decision.outcome,
      endpoint(decision.from),
      endpoint(decision.to),
      canonicalPdfSourceSemanticFlowEvidence(decision.evidence),
    ]),
  )
}
