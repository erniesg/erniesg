import type {
  PdfCompletenessMetrics,
  PdfCanonicalHyphenBoundaryDecision,
  PdfCompletenessPolicy,
  PdfCitationRelationship,
  PdfLineBoundaryDecision,
  PdfNoteRelationship,
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfReadiness,
  PdfSemanticSignals,
  PdfSourceRun,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import type { EquationTranscriptContext } from './equation-transcript-adjudication'
import {
  groupRunsIntoLines,
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
} from './pdf-lines'
import {
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE,
  PDF_HYPHEN_LEXICAL_MODEL,
  resolvePdfHyphenBoundary,
  type PdfHyphenBoundaryProof,
} from './pdf-hyphenation'
import { unprovedInlineMathAtomNodeIds } from './pdf-inline-script-integrity'
import { classifyPdfNoteMarkers } from './pdf-note-classifier'
import {
  canonicalPdfSourceSemanticFlowEvidence,
  pdfBodySourceOrderExtremaByPage,
  pdfSourceColumnFlowJoinOutcome,
  pdfSourceColumnFlowStartsWithCjkNumericContinuation,
  PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  pdfSourceFragmentId,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
  reconstructPageRegions,
} from './pdf-regions'
import {
  decorativeNativeObjectIds,
  isProbableDisplayEquation,
} from './pdf-visuals'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import type { ResearchNode, ResearchPaper } from './schema'
import {
  canonicalTextIntegrityIssues,
  internalReferenceIntegrityIssues,
} from './publication-integrity'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  canonicalFlowOrderViolationNodeIds,
  canonicalVisualOrderViolationRelationshipIds,
  characterCount,
  duplicateCanonicalRoleNodeIds,
  duplicateCanonicalSpanCount,
  nodeText,
  normalizedText,
  occurrenceBoundedMatchedCharacters,
  orderedMatchedCharacters,
  validatedVisualRepresentationByNode,
} from './pdf-quality-canonical-analysis'
import type { CanonicalFloatScopeEvidence } from './pdf-quality-canonical-analysis'
import {
  hasResolvedEquationTranscript,
  relationshipCounts,
} from './pdf-quality-relationships'
import {
  hasValidCanonicalHyphenBoundaryLedger,
  hasValidSourceSemanticFlowBoundaryLedgerCount,
  isPdfSourceSemanticFlowBoundaryDecision,
} from './pdf-quality-ledger-validation'
import {
  classifyStructuralLineBoundaryDecisions,
  validateLineBoundaryLedger,
} from './pdf-quality-line-boundary-analysis'
export { hasResolvedEquationTranscript } from './pdf-quality-relationships'
export { canonicalVisualOrderViolationRelationshipIds } from './pdf-quality-canonical-analysis'
export {
  hasValidCanonicalHyphenBoundaryLedger,
  hasValidSourceSemanticFlowBoundaryLedgerCount,
} from './pdf-quality-ledger-validation'
export { classifyStructuralLineBoundaryDecisions } from './pdf-quality-line-boundary-analysis'
export type { CanonicalFloatScopeEvidence } from './pdf-quality-canonical-analysis'

export const DEFAULT_PDF_COMPLETENESS_POLICY: PdfCompletenessPolicy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 1,
  minimumRelationshipCoverage: 1,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
}

const UNRESOLVED_AUTHOR_PLACEHOLDER = 'Imported locally'

const PDF_SENTENCE_END_WITH_CLOSING =
  /\p{Sentence_Terminal}(?:["'’”\p{Close_Punctuation}\p{Final_Punctuation}]*)$/u

function rtlLanguage(tag: string | null) {
  if (!tag) return false
  try {
    const locale = new Intl.Locale(tag)
    const script = locale.script
    if (
      script &&
      ['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm'].includes(script)
    ) {
      return true
    }
    return [
      'ar',
      'dv',
      'fa',
      'he',
      'ks',
      'ku',
      'ps',
      'sd',
      'syr',
      'ug',
      'ur',
      'yi',
    ].includes(locale.language)
  } catch {
    return false
  }
}

function rtlBaseDirection(
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  if (baseDirection === 'rtl') return true
  if (baseDirection === 'ltr' || baseDirection === 'unknown') return false
  return rtlLanguage(language)
}

type QualityInput = {
  pages: PdfPageAnalysis[]
  paper: ResearchPaper
  diagnostics: ReconstructionDiagnostic[]
  readingOrder?: PdfReadingOrderGraph
  regions?: PdfPageRegion[]
  visualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  citationRelationships?: PdfCitationRelationship[]
  noteRelationships?: PdfNoteRelationship[]
  policy?: PdfCompletenessPolicy
  reclassifiedNoteReferenceCount?: number
  reclassifiedCitationCount?: number
  lineBoundaryDecisions?: PdfLineBoundaryDecision[]
  sourceSemanticFlowBoundaryDecisions?: readonly PdfSourceSemanticFlowBoundaryDecision[]
  sourceSemanticFlowBoundaryDecisionCount?: number
  canonicalHyphenBoundaryDecisions?: readonly PdfCanonicalHyphenBoundaryDecision[]
  canonicalHyphenBoundaryDecisionCount?: number
  unresolvedCorruptingJoinCount?: number
  structurallyConsumedLineBoundaryCount?: number
  provenance?: Record<string, NodeSourceEvidence>
  inlineSpanLedger?: { expected: number; mapped: number }
  hyperlinkLedger?: { expected: number; mapped: number }
  sourceSha256?: string
  canonicalFloatScopes?: readonly CanonicalFloatScopeEvidence[]
  furnitureExcludedRunCount?: number
  furnitureExcludedTextCharacters?: number
  furnitureContaminationCount?: number
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function meaningPreservingText(value: string) {
  return value
    .normalize('NFC')
    .replace(/\u00ad/gu, '')
    .replace(/(?<=\p{N}[-–—])\s+(?=\p{N})/gu, '')
    .replace(/\b((?:18|19|20)\d)\s+(?=\d(?:[.,;:)]|$))/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

function dominantSemanticFlowLineMetrics(line: PdfPageRegion['lines'][number]) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length === 0) return null
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const dominantRuns = runs.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  const weightedBaseline =
    dominantRuns.reduce(
      (total, run) =>
        total + (run.y + run.height) * Math.max(run.text.trim().length, 1),
      0,
    ) /
    dominantRuns.reduce(
      (total, run) => total + Math.max(run.text.trim().length, 1),
      0,
    )
  return {
    fontSize: maximumFontSize,
    baseline: weightedBaseline,
    height: Math.max(...dominantRuns.map((run) => run.height)),
  }
}

type ResolvedSourceSemanticFlowEndpoint = {
  region: PdfPageRegion
  line: PdfPageRegion['lines'][number]
  run: PdfSourceRun
}

type InlineStackedSemanticFlowFragment = {
  baseId: string
  part: 'before' | 'formula' | 'after'
  region: PdfPageRegion
  line: PdfPageRegion['lines'][number]
}

function inlineStackedSemanticFlowFragment(
  region: PdfPageRegion,
  line: PdfPageRegion['lines'][number],
): InlineStackedSemanticFlowFragment | null {
  const match = line.id?.match(
    /^(.*-inline-stacked-\d+)-(before|formula|after)$/u,
  )
  if (!match) return null
  const part = match[2] as InlineStackedSemanticFlowFragment['part']
  const lineage = line.sourceFragmentLineage
  if (
    lineage?.algorithm !== 'source-run-fragment-v1' ||
    lineage.fragment !== `inline-stacked-${part}`
  ) {
    return null
  }
  return { baseId: match[1], part, region, line }
}

function sourceProvesInlineStackedSemanticFlowBoundary(
  left: InlineStackedSemanticFlowFragment,
  right: InlineStackedSemanticFlowFragment,
) {
  const leftRuns = left.line.runs.filter((run) => run.text.trim())
  const rightRuns = right.line.runs.filter((run) => run.text.trim())
  if (
    leftRuns.length === 0 ||
    rightRuns.length === 0 ||
    leftRuns.some((run) => run.sourceSequenceIndex === undefined) ||
    rightRuns.some((run) => run.sourceSequenceIndex === undefined)
  ) {
    return false
  }
  const leftMaximumSequence = Math.max(
    ...leftRuns.map((run) => run.sourceSequenceIndex!),
  )
  const rightMinimumSequence = Math.min(
    ...rightRuns.map((run) => run.sourceSequenceIndex!),
  )
  const leftBoundaryRuns = leftRuns.filter(
    (run) => run.sourceSequenceIndex === leftMaximumSequence,
  )
  const rightBoundaryRuns = rightRuns.filter(
    (run) => run.sourceSequenceIndex === rightMinimumSequence,
  )
  return (
    leftBoundaryRuns.length === 1 &&
    rightBoundaryRuns.length === 1 &&
    rightBoundaryRuns[0].sourceWhitespaceBefore === 'pdf-text-item' &&
    rightBoundaryRuns[0].sourceWhitespacePredecessorIndex ===
      leftBoundaryRuns[0].sourceSequenceIndex
  )
}

function sourceProvesInlineStackedSemanticFlowScope(
  fragment: InlineStackedSemanticFlowFragment,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const nonblankLines = fragment.region.lines.filter((line) => line.text.trim())
  if (fragment.part !== 'after') {
    return nonblankLines.length === 1 && nonblankLines[0] === fragment.line
  }
  if (nonblankLines[0] !== fragment.line) return false
  for (let index = 1; index < nonblankLines.length; index += 1) {
    const previous = nonblankLines[index - 1]
    const current = nonblankLines[index]
    const decisions = lineBoundaryDecisions.filter(
      (decision) =>
        decision.regionId === fragment.region.id &&
        decision.fromLineId === previous.id &&
        decision.toLineId === current.id,
    )
    if (
      decisions.length !== 1 ||
      ![
        'space',
        'no-space',
        'preserved-lexical-hyphen',
        'removed-discretionary-hyphen',
      ].includes(decisions[0].outcome)
    ) {
      return false
    }
  }
  return true
}

function visualRelationshipTouchesInlineStackedSemanticFlowFormula(
  relationship: PdfVisualRelationship,
  formula: InlineStackedSemanticFlowFragment,
) {
  return (
    relationship.sourceRegionIds.includes(formula.region.id) ||
    relationship.sourceLineIds?.includes(formula.line.id) === true ||
    relationship.candidates.some(
      (candidate) =>
        candidate.sourceRegionIds.includes(formula.region.id) ||
        candidate.sourceLineIds?.includes(formula.line.id) === true,
    )
  )
}

function provesUnresolvedInlineStackedSemanticFlowRelationship(
  relationship: PdfVisualRelationship,
  before: InlineStackedSemanticFlowFragment,
  formula: InlineStackedSemanticFlowFragment,
  after: InlineStackedSemanticFlowFragment,
) {
  if (
    relationship.kind !== 'equation' ||
    relationship.status !== 'unresolved' ||
    !relationship.evidence.includes('source-text-transcript-unresolved') ||
    relationship.captionRegionId !== formula.region.id
  ) {
    return false
  }
  const directSource =
    relationship.sourceRegionIds.includes(formula.region.id) &&
    !relationship.sourceRegionIds.includes(before.region.id) &&
    !relationship.sourceRegionIds.includes(after.region.id) &&
    relationship.sourceLineIds?.filter((lineId) => lineId === formula.line.id)
      .length === 1
  if (directSource) return true

  if (
    relationship.sourceRegionIds.length !== 0 ||
    (relationship.sourceLineIds?.length ?? 0) !== 0 ||
    relationship.sourceObjectIds.length !== 0 ||
    relationship.assetIds.length !== 0 ||
    relationship.canonicalNodeId !== null ||
    !relationship.evidence.includes('incomplete-equation-source-scope') ||
    !relationship.evidence.includes('source-rendition-unavailable') ||
    relationship.candidates.length !== 1 ||
    relationship.sourceBoxes.length !== 1 ||
    !sameSourceBox(relationship.sourceBoxes[0], formula.region.box)
  ) {
    return false
  }
  const candidate = relationship.candidates[0]
  return (
    candidate.sourceRegionIds.length === 1 &&
    candidate.sourceRegionIds[0] === formula.region.id &&
    (candidate.sourceLineIds === undefined ||
      (candidate.sourceLineIds.length === 1 &&
        candidate.sourceLineIds[0] === formula.line.id)) &&
    candidate.sourceObjectIds.length === 1 &&
    candidate.assetIds.length === 0 &&
    candidate.sourceBoxes.length === 1 &&
    sameSourceBox(candidate.sourceBoxes[0], formula.region.box) &&
    candidate.evidence.includes('source-text-transcript-unresolved') &&
    candidate.evidence.includes('incomplete-equation-source-scope') &&
    candidate.evidence.includes('source-rendition-unavailable')
  )
}

function sourceProvesInlineStackedSemanticFlowTopology({
  from,
  to,
  allRegions,
  visualRelationships,
  lineBoundaryDecisions,
}: {
  from: ResolvedSourceSemanticFlowEndpoint
  to: ResolvedSourceSemanticFlowEndpoint
  allRegions: readonly PdfPageRegion[]
  visualRelationships: readonly PdfVisualRelationship[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
}) {
  const fromFragment = inlineStackedSemanticFlowFragment(from.region, from.line)
  const toFragment = inlineStackedSemanticFlowFragment(to.region, to.line)
  if (
    !fromFragment ||
    !toFragment ||
    fromFragment.baseId !== toFragment.baseId ||
    !new Set(['before->formula', 'formula->after']).has(
      `${fromFragment.part}->${toFragment.part}`,
    )
  ) {
    return false
  }
  const occurrences = allRegions.flatMap((region) =>
    region.lines.flatMap((line) => {
      const fragment = inlineStackedSemanticFlowFragment(region, line)
      return fragment?.baseId === fromFragment.baseId ? [fragment] : []
    }),
  )
  const byPart = new Map(
    occurrences.map((fragment) => [fragment.part, fragment]),
  )
  const before = byPart.get('before')
  const formula = byPart.get('formula')
  const after = byPart.get('after')
  if (
    occurrences.length !== 3 ||
    byPart.size !== 3 ||
    !before ||
    !formula ||
    !after ||
    new Set(occurrences.map((fragment) => fragment.region.id)).size !== 3 ||
    new Set(occurrences.map((fragment) => fragment.region.page)).size !== 1 ||
    new Set(
      occurrences.map(
        (fragment) =>
          fragment.region.kind === 'footnote' ||
          fragment.region.kind === 'endnote',
      ),
    ).size !== 1 ||
    occurrences.some(
      (fragment) =>
        fragment.region.lines.filter((line) =>
          /-inline-stacked-\d+-(?:before|formula|after)$/u.test(line.id ?? ''),
        ).length !== 1,
    ) ||
    !/\p{L}{2,}/u.test(before.region.text) ||
    !/^[,.;:!?)}\]]/u.test(after.region.text.trimStart()) ||
    !/\p{L}{2,}/u.test(after.region.text) ||
    !occurrences.every((fragment) =>
      sourceProvesInlineStackedSemanticFlowScope(
        fragment,
        lineBoundaryDecisions,
      ),
    ) ||
    !sourceProvesInlineStackedSemanticFlowBoundary(before, formula) ||
    !sourceProvesInlineStackedSemanticFlowBoundary(formula, after)
  ) {
    return false
  }
  const participatingRelationships = visualRelationships.filter(
    (relationship) =>
      relationship.kind === 'equation' &&
      visualRelationshipTouchesInlineStackedSemanticFlowFormula(
        relationship,
        formula,
      ),
  )
  return (
    participatingRelationships.length === 1 &&
    provesUnresolvedInlineStackedSemanticFlowRelationship(
      participatingRelationships[0],
      before,
      formula,
      after,
    )
  )
}

export function sourceSemanticFlowHyphenVerdict(
  proof: PdfHyphenBoundaryProof,
): PdfHyphenBoundaryProof['verdict'] {
  if (proof.verdict !== 'unresolved') return proof.verdict
  const model = proof.model
  const pinnedSourceDeletionEvidence =
    proof.sourceBoundaryProven &&
    proof.pinnedJoinedFormValid &&
    proof.splitPointValid &&
    !proof.hardHyphenFormValid &&
    model?.id === PDF_HYPHEN_LEXICAL_MODEL.id &&
    model.language === PDF_HYPHEN_LEXICAL_MODEL.language &&
    model.dictionarySha256 === PDF_HYPHEN_LEXICAL_MODEL.dictionarySha256 &&
    model.affixSha256 === PDF_HYPHEN_LEXICAL_MODEL.affixSha256 &&
    model.hyphenationSha256 === PDF_HYPHEN_LEXICAL_MODEL.hyphenationSha256 &&
    [
      'source-proven-wrapped-line-boundary',
      `lexical-model:${PDF_HYPHEN_LEXICAL_MODEL.id}`,
      'joined-form-valid:pinned-lexicon',
      'split-point-valid:pinned-hyphenation-pattern',
      'hard-hyphen-form-not-proved',
    ].every((evidence) => proof.evidence.includes(evidence)) &&
    !PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE.some((evidence) =>
      proof.evidence.includes(evidence),
    )
  return pinnedSourceDeletionEvidence ? 'remove' : 'unresolved'
}

function validatedSourceSemanticFlowBoundaryDecision(
  leftRegion: PdfPageRegion,
  rightRegion: PdfPageRegion,
  allRegions: readonly PdfPageRegion[],
  visualRelationships: readonly PdfVisualRelationship[],
  validatedNonProseRelationships: readonly PdfVisualRelationship[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  decisions: readonly PdfSourceSemanticFlowBoundaryDecision[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const candidates = decisions.filter(
    (decision) =>
      decision.from.regionId === leftRegion.id &&
      decision.to.regionId === rightRegion.id,
  )
  if (
    candidates.length !== 1 ||
    new Set(decisions.map((decision) => decision.id)).size !==
      decisions.length ||
    !isPdfSourceSemanticFlowBoundaryDecision(candidates[0])
  ) {
    return null
  }
  const decision = candidates[0]
  const resolveEndpoint = (
    endpoint: PdfSourceSemanticFlowBoundaryDecision['from'],
  ) => {
    const matchingRegions = allRegions.filter(
      (region) => region.id === endpoint.regionId,
    )
    if (matchingRegions.length !== 1) return null
    const region = matchingRegions[0]
    const matchingLines = region.lines.filter(
      (line) => line.id === endpoint.lineId,
    )
    if (matchingLines.length !== 1) return null
    const line = matchingLines[0]
    const run = line.runs[endpoint.runIndex]
    if (
      !run ||
      !run.text.trim() ||
      run.sourceSequenceIndex !== endpoint.sourceSequenceIndex ||
      pdfSourceSemanticFlowRunSha256(run) !== endpoint.sourceRunSha256 ||
      pdfSourceFragmentId(line) !== endpoint.sourceFragmentId
    ) {
      return null
    }
    const lineage = line.sourceFragmentLineage
    const visibleSequences = line.runs.flatMap((candidate) =>
      candidate.text.trim() && candidate.sourceSequenceIndex !== undefined
        ? [candidate.sourceSequenceIndex]
        : [],
    )
    if (
      !lineage ||
      visibleSequences.length !==
        line.runs.filter((candidate) => candidate.text.trim()).length ||
      new Set(lineage.sourceSequenceIndexes).size !==
        lineage.sourceSequenceIndexes.length ||
      lineage.sourceSequenceIndexes.length !== visibleSequences.length ||
      lineage.sourceSequenceIndexes.some(
        (sequence, index) => sequence !== visibleSequences[index],
      )
    ) {
      return null
    }
    const sameSequenceCandidates = allRegions.flatMap((candidateRegion) =>
      candidateRegion.page === run.page
        ? candidateRegion.lines.flatMap((candidateLine) =>
            candidateLine.runs.filter(
              (candidateRun) =>
                candidateRun.sourceSequenceIndex === run.sourceSequenceIndex,
            ),
          )
        : [],
    )
    if (sameSequenceCandidates.length !== 1) return null
    return { region, line, run }
  }
  const from = resolveEndpoint(decision.from)
  const to = resolveEndpoint(decision.to)
  if (!from || !to) return null
  const fromVisibleRuns = from.line.runs.filter((run) => run.text.trim())
  const toVisibleRuns = to.line.runs.filter((run) => run.text.trim())
  const fromMaximumSequence = Math.max(
    ...fromVisibleRuns.map((run) => run.sourceSequenceIndex!),
  )
  const toMinimumSequence = Math.min(
    ...toVisibleRuns.map((run) => run.sourceSequenceIndex!),
  )
  const crossPage = decision.topology === 'cross-page-column'
  const accountedNonProseRegionIds = new Set(
    validatedNonProseRelationships.flatMap((relationship) =>
      relationship.status === 'matched' && relationship.kind !== 'equation'
        ? [relationship.captionRegionId, ...relationship.sourceRegionIds]
        : [],
    ),
  )
  const accountedNonProseBetweenBoundary = [...accountedNonProseRegionIds]
    .flatMap((regionId) =>
      allRegions.filter((region) => region.id === regionId),
    )
    .some((region) =>
      region.lines.some((line) =>
        line.runs.some(
          (run) =>
            run.sourceSequenceIndex !== undefined &&
            ((run.page === from.run.page &&
              run.sourceSequenceIndex > decision.from.sourceSequenceIndex) ||
              (run.page === to.run.page &&
                run.sourceSequenceIndex < decision.to.sourceSequenceIndex)),
        ),
      ),
    )
  // Independent re-derivation of the page-break adjacency proof: the tail must
  // be the last body text item its page paints and the head the first the next
  // page paints, so only accounted page furniture can sit between them. The
  // extrema sweep every region, so only a cross-page decision pays for it.
  const crossPageSourceAdjacency =
    crossPage &&
    to.run.page === from.run.page + 1 &&
    (() => {
      const extrema = pdfBodySourceOrderExtremaByPage(
        allRegions,
        accountedNonProseRegionIds,
      )
      return (
        extrema.get(from.run.page)?.last ===
          decision.from.sourceSequenceIndex &&
        extrema.get(to.run.page)?.first === decision.to.sourceSequenceIndex
      )
    })()
  const exactSourceAdjacency = crossPage
    ? crossPageSourceAdjacency
    : decision.to.sourceSequenceIndex ===
        decision.from.sourceSequenceIndex + 1 ||
      (to.run.sourceWhitespaceBefore === 'pdf-text-item' &&
        to.run.sourceWhitespacePredecessorIndex ===
          decision.from.sourceSequenceIndex)
  const fromMetrics = dominantSemanticFlowLineMetrics(from.line)
  const toMetrics = dominantSemanticFlowLineMetrics(to.line)
  if (
    from.region !== leftRegion ||
    to.region !== rightRegion ||
    decision.page !== from.run.page ||
    (crossPage
      ? decision.page + 1 !== to.run.page
      : decision.page !== to.run.page) ||
    decision.rotation !== from.run.rotation ||
    decision.rotation !== to.run.rotation ||
    decision.method !== from.run.method ||
    decision.method !== to.run.method ||
    decision.from.sourceSequenceIndex !== fromMaximumSequence ||
    decision.to.sourceSequenceIndex !== toMinimumSequence ||
    !exactSourceAdjacency ||
    !fromMetrics ||
    !toMetrics
  ) {
    return null
  }
  const fontRatio =
    Math.max(fromMetrics.fontSize, toMetrics.fontSize) /
    Math.max(1, Math.min(fromMetrics.fontSize, toMetrics.fontSize))
  const baselineGap = Math.abs(fromMetrics.baseline - toMetrics.baseline)
  if (
    fontRatio > 1.5 ||
    (decision.topology !== 'same-page-column' &&
      !crossPage &&
      baselineGap >
        Math.max(0.06, Math.max(fromMetrics.height, toMetrics.height) * 4))
  ) {
    return null
  }
  const exactStackedPunctuationTransition =
    from.line.sourceFragmentLineage?.fragment === 'inline-stacked-formula' &&
    to.line.sourceFragmentLineage?.fragment === 'inline-stacked-after' &&
    from.line.sourceFragmentLineage.sourceLineId ===
      to.line.sourceFragmentLineage.sourceLineId &&
    /^[,.;:!?%)}\]]/u.test(rightRegion.text.trimStart())
  const leftHyphenToken = leftRegion.text
    .trimEnd()
    .match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const rightHyphenToken = rightRegion.text
    .trimStart()
    .match(/^([\p{L}\p{N}]+)/u)?.[1]
  let expectedOutcome: PdfSourceSemanticFlowBoundaryDecision['outcome']
  let expectedEvidence: readonly string[]
  if (crossPage) {
    if (
      !sourceProvenCrossPageColumnGeometryBoundary(
        leftRegion,
        rightRegion,
        from.line,
        to.line,
        language,
        baseDirection,
      )
    ) {
      return null
    }
    const detachedCitationYear = sourceProvenDetachedCitationYearContinuation(
      leftRegion.text,
      rightRegion.text,
    )
    const scholarlyLabelFloat = sourceProvenScholarlyLabelFloatContinuation(
      leftRegion.text,
      rightRegion.text,
    )
    if (leftHyphenToken && rightHyphenToken) {
      const proof = resolvePdfHyphenBoundary({
        left: leftHyphenToken,
        right: rightHyphenToken,
        language,
        sourceProven: true,
        hardHyphenLexicon,
        unhyphenatedLexicon,
      })
      const semanticVerdict = sourceSemanticFlowHyphenVerdict(proof)
      if (semanticVerdict === 'remove') {
        expectedOutcome = 'discretionary-hyphen-delete'
      } else if (semanticVerdict === 'preserve') {
        expectedOutcome = 'hard-hyphen-retain'
      } else {
        return null
      }
    } else if (
      detachedCitationYear ||
      sourceProvenUnmarkedProseContinuation(
        leftRegion.text,
        rightRegion.text,
      ) ||
      (scholarlyLabelFloat && accountedNonProseBetweenBoundary)
    ) {
      expectedOutcome = pdfSourceColumnFlowJoinOutcome(
        language,
        rightRegion.text.trimStart(),
        to.run,
      ).outcome
    } else {
      return null
    }
    expectedEvidence = PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE
  } else if (leftHyphenToken && rightHyphenToken) {
    const proof = resolvePdfHyphenBoundary({
      left: leftHyphenToken,
      right: rightHyphenToken,
      language,
      sourceProven: true,
      hardHyphenLexicon,
      unhyphenatedLexicon,
    })
    const semanticVerdict = sourceSemanticFlowHyphenVerdict(proof)
    if (semanticVerdict === 'remove') {
      expectedOutcome = 'discretionary-hyphen-delete'
    } else if (semanticVerdict === 'preserve') {
      expectedOutcome = 'hard-hyphen-retain'
    } else {
      return null
    }
    if (decision.topology !== 'lexical-hyphen') return null
    expectedEvidence = PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE
  } else if (exactStackedPunctuationTransition) {
    if (
      decision.topology !== 'inline-stacked-fragment' ||
      !sourceProvesInlineStackedSemanticFlowTopology({
        from,
        to,
        allRegions,
        visualRelationships,
        lineBoundaryDecisions,
      })
    ) {
      return null
    }
    expectedOutcome = 'no-space'
    expectedEvidence = PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE
  } else if (
    decision.topology === 'same-page-column' &&
    sourceProvenSamePageColumnFlowBoundary(
      leftRegion,
      rightRegion,
      from.line,
      to.line,
      language,
      baseDirection,
    )
  ) {
    expectedOutcome = pdfSourceColumnFlowJoinOutcome(
      language,
      rightRegion.text.trimStart(),
      to.run,
    ).outcome
    expectedEvidence = PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE
  } else {
    return null
  }
  const canonicalExpectedEvidence =
    canonicalPdfSourceSemanticFlowEvidence(expectedEvidence)
  if (
    decision.outcome !== expectedOutcome ||
    decision.evidence.length !== canonicalExpectedEvidence.length ||
    decision.evidence.some(
      (evidence, index) => evidence !== canonicalExpectedEvidence[index],
    ) ||
    decision.id !==
      pdfSourceSemanticFlowBoundaryDecisionId({
        page: decision.page,
        rotation: decision.rotation,
        method: decision.method,
        topology: decision.topology,
        outcome: expectedOutcome,
        from: decision.from,
        to: decision.to,
        evidence: canonicalExpectedEvidence,
      })
  ) {
    return null
  }
  return decision
}

function sourceSemanticFlowBoundaryKey(
  fromRegionId: string,
  toRegionId: string,
) {
  return `${fromRegionId}\0${toRegionId}`
}

// Language-agnostic evidence that a block leaves a sentence unfinished and the
// next block resumes it. Mirrors `likelyUnmarkedCrossPageContinuation` in the
// extractor; both the same-page column boundary and the cross-page boundary are
// re-derived from it here, independently of how extraction reached them.
function sourceProvenUnmarkedProseContinuation(
  leftText: string,
  rightText: string,
) {
  const previousText = leftText.trimEnd()
  const continuationText = rightText.trimStart()
  const detachedNumericContinuation =
    (/\b(?:a|an|the|of|for|from|with|without|among|between|over|under|by|than|approximately|about|around|nearly|roughly|exactly|includes?|including|contains?|containing|comprises?|comprising)\s*$/iu.test(
      previousText,
    ) &&
      /^\d+(?:[,.]\d+)*(?:\s*[%×x+-]\s*\d+(?:[,.]\d+)*)?\s+\p{L}/u.test(
        continuationText,
      )) ||
    pdfSourceColumnFlowStartsWithCjkNumericContinuation(continuationText)
  const detachedScholarlyContinuation =
    /\b(?:Section|Appendix|Figure|Fig\.|Table|Equation|Eq\.)$/u.test(
      previousText,
    ) && /^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\.(?:\s|$)/u.test(continuationText)
  const detachedDashContinuation =
    !/[.!?:;\u061F\u0964\u0965\u1362\u1803\u3002\uFF01\uFF0E\uFF1F](?:["'’”\])}]*)$/u.test(
      previousText,
    ) && /^[–—-]\s+\p{Ll}/u.test(continuationText)
  return Boolean(
    previousText &&
    continuationText &&
    !PDF_SENTENCE_END_WITH_CLOSING.test(previousText) &&
    (/^(?:\p{Ll}|\p{Lo})/u.test(continuationText) ||
      detachedNumericContinuation ||
      detachedScholarlyContinuation ||
      detachedDashContinuation),
  )
}

function sourceProvenSamePageColumnFlowBoundary(
  leftRegion: PdfPageRegion,
  rightRegion: PdfPageRegion,
  fromLine: PdfPageRegion['lines'][number],
  toLine: PdfPageRegion['lines'][number],
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const unmarkedContinuation = sourceProvenUnmarkedProseContinuation(
    leftRegion.text,
    rightRegion.text,
  )
  const rtl = rtlBaseDirection(language, baseDirection)
  const columnsMatch = rtl
    ? leftRegion.column === 'right' && rightRegion.column === 'left'
    : leftRegion.column === 'left' && rightRegion.column === 'right'
  const columnsAreOrdered = rtl
    ? toLine.box.x + toLine.box.width <= fromLine.box.x + 0.01
    : fromLine.box.x + fromLine.box.width <= toLine.box.x + 0.01
  if (
    leftRegion.page !== rightRegion.page ||
    !columnsMatch ||
    fromLine.id !==
      leftRegion.lines.filter((line) => line.text.trim()).at(-1)?.id ||
    toLine.id !== rightRegion.lines.find((line) => line.text.trim())?.id ||
    fromLine.box.y + fromLine.box.height < 0.65 ||
    toLine.box.y > 0.35 ||
    !columnsAreOrdered ||
    !unmarkedContinuation
  ) {
    return false
  }
  const fontRatio =
    Math.max(fromLine.fontSize, toLine.fontSize) /
    Math.max(1, Math.min(fromLine.fontSize, toLine.fontSize))
  return fontRatio <= 1.12
}

const PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR = new Set([
  'right',
  'single',
  'span',
])
const PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR = new Set(['left', 'single', 'span'])

function sourceProvenDetachedCitationYearContinuation(
  leftText: string,
  rightText: string,
) {
  return (
    /\b\p{Lu}[\p{L}'’.-]*(?:\s+et\s+al\.)?,\s*$/u.test(leftText.trimEnd()) &&
    /^(?:18|19|20)\d{2}[a-z]?(?=[,;:)])/u.test(rightText.trimStart())
  )
}

function sourceProvenScholarlyLabelFloatContinuation(
  leftText: string,
  rightText: string,
) {
  return (
    /\b(?:in|of|to|from|with|by|at|on|as|than|between|for|following)\s*$/iu.test(
      leftText.trimEnd(),
    ) &&
    /^(?:Table|Figure|Equation|Eq\.|Section|Appendix)\s+(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\b/u.test(
      rightText.trimStart(),
    )
  )
}

function sourceProvenCrossPageColumnGeometryBoundary(
  leftRegion: PdfPageRegion,
  rightRegion: PdfPageRegion,
  fromLine: PdfPageRegion['lines'][number],
  toLine: PdfPageRegion['lines'][number],
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const rtl = rtlBaseDirection(language, baseDirection)
  const tailColumns = rtl
    ? PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR
    : PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR
  const headColumns = rtl
    ? PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR
    : PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR
  return (
    rightRegion.page === leftRegion.page + 1 &&
    tailColumns.has(leftRegion.column) &&
    headColumns.has(rightRegion.column) &&
    fromLine.id ===
      leftRegion.lines.filter((line) => line.text.trim()).at(-1)?.id &&
    toLine.id === rightRegion.lines.find((line) => line.text.trim())?.id &&
    fromLine.box.y + fromLine.box.height >= 0.65 &&
    toLine.box.y <= 0.35 &&
    Math.max(fromLine.fontSize, toLine.fontSize) /
      Math.max(1, Math.min(fromLine.fontSize, toLine.fontSize)) <=
      1.12
  )
}

type SourceSemanticFlowBoundaryLedgerAudit = {
  valid: boolean
  decisionsByBoundary: Map<string, PdfSourceSemanticFlowBoundaryDecision>
  consumptionById: Map<string, number>
}

function auditSourceSemanticFlowBoundaryLedger({
  allRegions,
  visualRelationships,
  validatedNonProseRelationships,
  lineBoundaryDecisions,
  decisions,
  hardHyphenLexicon,
  unhyphenatedLexicon,
  language,
  baseDirection,
}: {
  allRegions: readonly PdfPageRegion[]
  visualRelationships: readonly PdfVisualRelationship[]
  validatedNonProseRelationships: readonly PdfVisualRelationship[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
  decisions: readonly PdfSourceSemanticFlowBoundaryDecision[]
  hardHyphenLexicon: ReadonlySet<string>
  unhyphenatedLexicon: ReadonlySet<string>
  language: string | null
  baseDirection: ResearchPaper['baseDirection'] | null
}): SourceSemanticFlowBoundaryLedgerAudit {
  const audit: SourceSemanticFlowBoundaryLedgerAudit = {
    valid: true,
    decisionsByBoundary: new Map(),
    consumptionById: new Map(),
  }
  const regionOwners = new Map<string, PdfPageRegion[]>()
  for (const region of allRegions) {
    const owners = regionOwners.get(region.id) ?? []
    owners.push(region)
    regionOwners.set(region.id, owners)
  }
  const ids = new Set<string>()
  for (const decision of decisions) {
    if (!isPdfSourceSemanticFlowBoundaryDecision(decision)) {
      audit.valid = false
      continue
    }
    const fromOwners = regionOwners.get(decision.from.regionId) ?? []
    const toOwners = regionOwners.get(decision.to.regionId) ?? []
    const boundary = sourceSemanticFlowBoundaryKey(
      decision.from.regionId,
      decision.to.regionId,
    )
    if (
      ids.has(decision.id) ||
      audit.decisionsByBoundary.has(boundary) ||
      fromOwners.length !== 1 ||
      toOwners.length !== 1
    ) {
      audit.valid = false
      continue
    }
    ids.add(decision.id)
    const validated = validatedSourceSemanticFlowBoundaryDecision(
      fromOwners[0],
      toOwners[0],
      allRegions,
      visualRelationships,
      validatedNonProseRelationships,
      lineBoundaryDecisions,
      [decision],
      hardHyphenLexicon,
      unhyphenatedLexicon,
      language,
      baseDirection,
    )
    if (!validated) {
      audit.valid = false
      continue
    }
    audit.decisionsByBoundary.set(boundary, validated)
    audit.consumptionById.set(validated.id, 0)
  }
  return audit
}

function sourceProvenBoundaryTokenText(
  values: readonly string[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  regions: readonly PdfPageRegion[] = [],
  sourceSemanticFlowBoundaryLedger?: SourceSemanticFlowBoundaryLedgerAudit,
  requireCrossPageDecision = false,
) {
  let combined = values[0] ?? ''
  for (const [offset, value] of values.slice(1).entries()) {
    const boundaryIndex = offset + 1
    const semanticFlowDecision =
      regions[boundaryIndex - 1] && regions[boundaryIndex]
        ? sourceSemanticFlowBoundaryLedger?.decisionsByBoundary.get(
            sourceSemanticFlowBoundaryKey(
              regions[boundaryIndex - 1].id,
              regions[boundaryIndex].id,
            ),
          )
        : null
    if (
      sourceSemanticFlowBoundaryLedger &&
      requireCrossPageDecision &&
      regions[boundaryIndex - 1]?.page !== regions[boundaryIndex]?.page &&
      !semanticFlowDecision
    ) {
      sourceSemanticFlowBoundaryLedger.valid = false
    }
    if (semanticFlowDecision && sourceSemanticFlowBoundaryLedger) {
      const consumed =
        (sourceSemanticFlowBoundaryLedger.consumptionById.get(
          semanticFlowDecision.id,
        ) ?? 0) + 1
      sourceSemanticFlowBoundaryLedger.consumptionById.set(
        semanticFlowDecision.id,
        consumed,
      )
      if (consumed > 1) sourceSemanticFlowBoundaryLedger.valid = false
    }
    if (semanticFlowDecision?.outcome === 'no-space') {
      combined = `${combined.trimEnd()}${value.trimStart()}`
      continue
    }
    if (
      semanticFlowDecision?.outcome === 'discretionary-hyphen-delete' &&
      /[-‐‑\u00ad]$/u.test(combined.trimEnd())
    ) {
      combined = `${combined.trimEnd().slice(0, -1)}${value.trimStart()}`
      continue
    }
    if (
      semanticFlowDecision?.outcome === 'hard-hyphen-retain' &&
      /[-‐‑]$/u.test(combined.trimEnd())
    ) {
      combined = `${combined.trimEnd()}${value.trimStart()}`
      continue
    }
    const suppliedBoundaryCandidates =
      regions[boundaryIndex - 1] && regions[boundaryIndex]
        ? sourceSemanticFlowBoundaryLedger?.decisionsByBoundary.has(
            sourceSemanticFlowBoundaryKey(
              regions[boundaryIndex - 1].id,
              regions[boundaryIndex].id,
            ),
          )
        : false
    if (suppliedBoundaryCandidates) {
      combined = `${combined.trimEnd()} ${value.trimStart()}`
      continue
    }
    const urlContinuation =
      /(?:https?:\/\/|www\.)[^\s<>"'`]*[./?=&_%+-]$/iu.test(
        combined.trimEnd(),
      ) && /^[^\s<>"'`]/u.test(value.trimStart())
    if (urlContinuation) {
      combined = `${combined.trimEnd()}${value.trimStart()}`
      continue
    }
    const left = combined.match(/([\p{L}\p{N}]+)[-‐‑]\s*$/u)
    const right = value.match(/^\s*([\p{L}\p{N}]+)/u)
    if (!left || !right) {
      combined = `${combined} ${value}`
      continue
    }
    const proof = resolvePdfHyphenBoundary({
      left: left[1],
      right: right[1],
      language,
      sourceProven: true,
      hardHyphenLexicon,
      unhyphenatedLexicon,
    })
    if (proof.verdict === 'remove') {
      combined = `${combined.trimEnd().slice(0, -1)}${value.trimStart()}`
    } else {
      combined = `${combined.trimEnd()}${value.trimStart()}`
    }
  }
  return combined
}

export function provenanceTextConservation({
  allRegions,
  orderedRegions,
  paper,
  provenance,
  visualRelationships,
  validatedVisualRelationships,
  assets,
  pages,
  lineBoundaryDecisions,
  sourceSemanticFlowBoundaryDecisions = [],
}: {
  allRegions: PdfPageRegion[]
  orderedRegions: PdfPageRegion[]
  paper: ResearchPaper
  provenance: Record<string, NodeSourceEvidence>
  visualRelationships?: PdfVisualRelationship[]
  validatedVisualRelationships?: PdfVisualRelationship[]
  assets?: PdfVisualAsset[]
  pages?: readonly PdfPageAnalysis[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
  sourceSemanticFlowBoundaryDecisions?: readonly PdfSourceSemanticFlowBoundaryDecision[]
}) {
  const allRegionMap = new Map(allRegions.map((region) => [region.id, region]))
  const sourceLines = allRegions.flatMap((region) => region.lines)
  const hardHyphenLexicon = inlineHardHyphenLexicon(sourceLines)
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(sourceLines)
  const semanticFlowBoundaryLedger = auditSourceSemanticFlowBoundaryLedger({
    allRegions,
    visualRelationships: visualRelationships ?? [],
    validatedNonProseRelationships: validatedVisualRelationships ?? [],
    lineBoundaryDecisions,
    decisions: sourceSemanticFlowBoundaryDecisions,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language: paper.language ?? null,
    baseDirection: paper.baseDirection ?? null,
  })
  const orderedRegionMap = new Map(
    orderedRegions.map((region) => [region.id, region]),
  )
  const orderedRegionIds = new Set(orderedRegionMap.keys())
  const visualRepresentation = validatedVisualRepresentationByNode(
    paper,
    provenance,
    visualRelationships,
    assets,
    allRegions,
    pages,
  )
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const generatedEquationCaptionNodeIds = new Set(
    (visualRelationships ?? []).flatMap((relationship) =>
      relationship.kind === 'equation' &&
      relationship.captionNodeId !== null &&
      (() => {
        const caption = nodesById.get(relationship.captionNodeId)
        if (caption?.type !== 'caption') return false
        const captionText = caption.text.trim()
        const normalizedCaption = captionText.replace(/[.]$/u, '').trim()
        const normalizedLabel = relationship.label
          .trim()
          .replace(/[.]$/u, '')
          .trim()
        return (
          /^Display equation p\d{3}-\d{3}$/u.test(captionText) ||
          normalizedCaption === normalizedLabel
        )
      })()
        ? [relationship.captionNodeId]
        : [],
    ),
  )
  const visualSourceRegionIds = [
    ...visualRepresentation.sourceRegionIdsByNode.values(),
  ].flat()
  const uniqueVisualSourceRegionIds = [...new Set(visualSourceRegionIds)]
  const visualSourceRegionIdSet = new Set(uniqueVisualSourceRegionIds)
  const conservedRegions = [
    ...orderedRegions.filter(
      (region) => !visualSourceRegionIdSet.has(region.id),
    ),
    ...uniqueVisualSourceRegionIds
      .map((regionId) => allRegionMap.get(regionId))
      .filter((region): region is PdfPageRegion => Boolean(region)),
  ]
  const conservedRegionMap = new Map(
    conservedRegions.map((region) => [region.id, region]),
  )
  const regionOrder = new Map(
    conservedRegions.map((region, index) => [region.id, index]),
  )
  const outputUnits: Array<{
    key: string
    nodeId?: string
    text: string
    order: number
    regionIds: string[]
    provenanced: boolean
    conservationExempt: boolean
    positionalVisual: boolean
  }> = []

  for (const [index, node] of paper.nodes.entries()) {
    // Equation captions generated from a printed number or a stable internal
    // identity label are not source prose. The typed equation relationship
    // owns (or fail-closed rejects) the source glyph region; comparing that
    // label with the glyph transcript invents a canonical-flow violation and
    // can expose an internal label in prose-quality evidence.
    const rendered = generatedEquationCaptionNodeIds.has(node.id)
      ? ''
      : nodeText(node, visualRepresentation.textByNode.get(node.id))
    const lineageConnector =
      node.type === 'figure' &&
      visualRepresentation.lineageConnectorNodeIds.has(node.id)
    if (!normalizedText(rendered) && !lineageConnector) continue
    const evidence = provenance[node.id]
    const validEvidence = Boolean(
      evidence &&
      evidence.regionIds.length > 0 &&
      evidence.boxes.length > 0 &&
      evidence.regionIds.every((regionId) => {
        const region = allRegionMap.get(regionId)
        return region && evidence.pages.includes(region.page)
      }),
    )
    const regionIds = validEvidence ? [...new Set(evidence!.regionIds)] : []
    const visualEvidenceRegionIds = new Set(
      visualRepresentation.sourceRegionIdsByNode.get(node.id) ?? [],
    )
    const conservedEvidenceRegionIds = regionIds.filter(
      (regionId) =>
        orderedRegionIds.has(regionId) || visualEvidenceRegionIds.has(regionId),
    )
    outputUnits.push({
      key: `output:node:${node.id}`,
      nodeId: node.id,
      text: rendered,
      order: 10_000 + index,
      regionIds: conservedEvidenceRegionIds,
      provenanced: validEvidence,
      conservationExempt:
        node.type === 'figure' &&
        validEvidence &&
        conservedEvidenceRegionIds.length === 0,
      positionalVisual:
        node.type === 'figure' &&
        visualRepresentation.positionalNodeIds.has(node.id),
    })
  }

  const canonicalTitleNode = paper.nodes.some(
    (node) =>
      (node.type === 'heading' || node.type === 'paragraph') &&
      normalizedText(node.text) === normalizedText(paper.title),
  )
  const canonicalTextValues = new Set(
    paper.nodes.flatMap((node) =>
      'text' in node ? [normalizedText(node.text)] : [],
    ),
  )
  const metadataValues = [
    ...(canonicalTitleNode ? [] : [paper.title]),
    ...paper.authors,
    ...(paper.affiliations ?? []),
  ]
    .filter((value) => value !== UNRESOLVED_AUTHOR_PLACEHOLDER)
    .map((value) => ({
      value,
      representedByCanonicalNode: canonicalTextValues.has(
        normalizedText(value),
      ),
    }))
  const affiliationMarkersByRegion = new Map<string, Array<[number, number]>>()
  for (const classification of classifyPdfNoteMarkers(
    orderedRegions,
    undefined,
    lineBoundaryDecisions,
  ).classifications) {
    if (
      !classification.accepted ||
      classification.taxonomy !== 'author-affiliation-superscript'
    ) {
      continue
    }
    const ranges =
      affiliationMarkersByRegion.get(classification.referenceRegionId) ?? []
    ranges.push([classification.start, classification.end])
    affiliationMarkersByRegion.set(classification.referenceRegionId, ranges)
  }
  const markerStrippedMetadataSourceText = (region: PdfPageRegion) => {
    let value = region.text
    const ranges = [...(affiliationMarkersByRegion.get(region.id) ?? [])].sort(
      (left, right) => right[0] - left[0] || right[1] - left[1],
    )
    for (const [start, end] of ranges) {
      value = `${value.slice(0, start)}${value.slice(end)}`
    }
    return value
  }
  const sourceMarkerStrippedMetadataText = (region: PdfPageRegion) =>
    region.text.replace(/(?<=\p{L})[\d*†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?=(?:[\s,;]|$))/gu, '')
  const metadataRegionIds = (value: string) => {
    const comparable = (text: string) =>
      text
        .toLocaleLowerCase()
        .replace(/(\p{N})(?=\p{L})/gu, '$1 ')
        .replace(/(\p{L})(?=\p{N})/gu, '$1 ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
    const target = comparable(value)
    if (!target) return []
    const representations = [
      (region: PdfPageRegion) => region.text,
      markerStrippedMetadataSourceText,
      sourceMarkerStrippedMetadataText,
    ]
    const candidates: Array<{
      regionIds: string[]
      exact: boolean
      extraCharacters: number
      start: number
      representation: number
    }> = []
    for (const [
      representationIndex,
      representation,
    ] of representations.entries()) {
      for (let start = 0; start < orderedRegions.length; start += 1) {
        let combined = ''
        for (
          let end = start;
          end < orderedRegions.length && end < start + 8;
          end += 1
        ) {
          combined = [combined, comparable(representation(orderedRegions[end]))]
            .filter(Boolean)
            .join(' ')
          if (` ${combined} `.includes(` ${target} `)) {
            candidates.push({
              regionIds: orderedRegions
                .slice(start, end + 1)
                .map((region) => region.id),
              exact: combined === target,
              extraCharacters: combined.length - target.length,
              start,
              representation: representationIndex,
            })
            break
          }
          if (combined.length > target.length * 2 + 32) break
        }
      }
    }
    return (
      candidates.sort(
        (left, right) =>
          Number(right.exact) - Number(left.exact) ||
          left.regionIds.length - right.regionIds.length ||
          left.extraCharacters - right.extraCharacters ||
          left.start - right.start ||
          left.representation - right.representation,
      )[0]?.regionIds ?? []
    )
  }
  for (const [index, metadata] of metadataValues.entries()) {
    const { value } = metadata
    const regionIds = metadataRegionIds(value)
    outputUnits.push({
      key: `output:metadata:${index}`,
      text: value,
      order: index,
      regionIds,
      provenanced: regionIds.length > 0,
      conservationExempt: metadata.representedByCanonicalNode,
      positionalVisual: false,
    })
  }

  const parent = new Map<string, string>()
  const add = (key: string) => {
    if (!parent.has(key)) parent.set(key, key)
  }
  const find = (key: string): string => {
    const candidate = parent.get(key)
    if (!candidate || candidate === key) return key
    const root = find(candidate)
    parent.set(key, root)
    return root
  }
  const union = (left: string, right: string) => {
    add(left)
    add(right)
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
  }
  for (const region of conservedRegions) add(`source:${region.id}`)
  for (const unit of outputUnits) {
    add(unit.key)
    for (const regionId of unit.regionIds) {
      union(unit.key, `source:${regionId}`)
    }
  }

  const components = new Map<
    string,
    { regionIds: string[]; outputs: typeof outputUnits }
  >()
  for (const region of conservedRegions) {
    const root = find(`source:${region.id}`)
    const component = components.get(root) ?? { regionIds: [], outputs: [] }
    component.regionIds.push(region.id)
    components.set(root, component)
  }
  for (const unit of outputUnits) {
    if (unit.conservationExempt) continue
    const root = find(unit.key)
    const component = components.get(root) ?? { regionIds: [], outputs: [] }
    component.outputs.push(unit)
    components.set(root, component)
  }

  let sourceCharacters = 0
  let outputCharacters = 0
  let matchedCharacters = 0
  const missingSourceRegionIds: string[] = []
  const canonicalProseNodeIds = new Set(
    paper.nodes
      .filter(
        (
          node,
        ): node is Extract<ResearchNode, { type: 'heading' | 'paragraph' }> =>
          node.type === 'heading' || node.type === 'paragraph',
      )
      .map((node) => node.id),
  )
  const sameRegionFlowViolationNodeIds = new Set<string>()
  const semanticTextViolationNodeIds = new Set<string>()
  const canonicalTextNodeIds = new Set(
    paper.nodes.filter((node) => node.type !== 'figure').map((node) => node.id),
  )
  for (const component of components.values()) {
    const orderedComponentRegionIds = [...component.regionIds].sort(
      (left, right) =>
        (regionOrder.get(left) ?? 0) - (regionOrder.get(right) ?? 0),
    )
    const orderedComponentOutputs = [...component.outputs].sort(
      (left, right) => left.order - right.order,
    )
    const sourceRegionTexts = orderedComponentRegionIds.map(
      (regionId) => conservedRegionMap.get(regionId)?.text ?? '',
    )
    const sourceComponentRegions = orderedComponentRegionIds.flatMap(
      (regionId) => {
        const region = conservedRegionMap.get(regionId)
        return region ? [region] : []
      },
    )
    const rawSourceText = sourceRegionTexts.join(' ')
    const outputText = orderedComponentOutputs
      .map((unit) => unit.text)
      .join(' ')
    const semanticOutputNodes = orderedComponentOutputs
      .map((unit) => (unit.nodeId ? nodesById.get(unit.nodeId) : undefined))
      .filter((node): node is ResearchNode => node !== undefined)
    const noteOnlyComponent =
      semanticOutputNodes.length === orderedComponentOutputs.length &&
      semanticOutputNodes.length > 0 &&
      semanticOutputNodes.every((node) => node.type === 'footnote') &&
      orderedComponentRegionIds.every((regionId) =>
        ['footnote', 'endnote'].includes(
          conservedRegionMap.get(regionId)?.kind ?? '',
        ),
      )
    const stripLeadingNoteMarker = (value: string) =>
      value.replace(/^\s*(?:[\d⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§]+)[.)]?\s*/u, '')
    const sourceText = rawSourceText
    const comparableSourceText = noteOnlyComponent
      ? stripLeadingNoteMarker(sourceText)
      : sourceText
    const comparableOutputText = noteOnlyComponent
      ? stripLeadingNoteMarker(outputText)
      : outputText
    const source = normalizedText(sourceText)
    const output = normalizedText(outputText)
    sourceCharacters += characterCount(source)
    outputCharacters += characterCount(output)
    matchedCharacters +=
      component.outputs.length > 0 &&
      component.outputs.every((unit) => unit.positionalVisual)
        ? occurrenceBoundedMatchedCharacters(source, output)
        : orderedMatchedCharacters(source, output)
    const soleSourceRegion =
      component.regionIds.length === 1
        ? conservedRegionMap.get(component.regionIds[0])
        : undefined
    const canonicalProseOutputs = component.outputs.filter(
      (
        unit,
      ): unit is (typeof outputUnits)[number] & {
        nodeId: string
      } =>
        typeof unit.nodeId === 'string' &&
        canonicalProseNodeIds.has(unit.nodeId),
    )
    const canonicalTextOutputs = component.outputs.filter(
      (
        unit,
      ): unit is (typeof outputUnits)[number] & {
        nodeId: string
      } =>
        typeof unit.nodeId === 'string' &&
        canonicalTextNodeIds.has(unit.nodeId),
    )
    if (
      source.length > 0 &&
      canonicalTextOutputs.length > 0 &&
      canonicalTextOutputs.length === component.outputs.length &&
      meaningPreservingText(
        component.regionIds.length > 1
          ? sourceProvenBoundaryTokenText(
              noteOnlyComponent
                ? [
                    stripLeadingNoteMarker(sourceRegionTexts[0] ?? ''),
                    ...sourceRegionTexts.slice(1),
                  ]
                : sourceRegionTexts,
              hardHyphenLexicon,
              unhyphenatedLexicon,
              paper.language ?? null,
              sourceComponentRegions,
              semanticFlowBoundaryLedger,
              semanticOutputNodes.length > 0 &&
                semanticOutputNodes.every(
                  (node) => node.type === 'paragraph' && !node.list,
                ),
            )
          : comparableSourceText,
      ) !== meaningPreservingText(comparableOutputText)
    ) {
      for (const unit of canonicalTextOutputs) {
        semanticTextViolationNodeIds.add(unit.nodeId)
      }
    }
    if (
      soleSourceRegion &&
      (soleSourceRegion.kind === 'body' ||
        soleSourceRegion.kind === 'spanning') &&
      canonicalProseOutputs.length > 0 &&
      canonicalProseOutputs.length === component.outputs.length &&
      source.normalize('NFKC') !== output.normalize('NFKC')
    ) {
      for (const unit of canonicalProseOutputs) {
        sameRegionFlowViolationNodeIds.add(unit.nodeId)
      }
    }
    if (source && component.outputs.length === 0) {
      missingSourceRegionIds.push(...component.regionIds)
    }
  }
  if (
    [...semanticFlowBoundaryLedger.consumptionById.values()].some(
      (consumptionCount) => consumptionCount !== 1,
    )
  ) {
    semanticFlowBoundaryLedger.valid = false
  }
  if (!semanticFlowBoundaryLedger.valid) {
    for (const nodeId of canonicalTextNodeIds) {
      semanticTextViolationNodeIds.add(nodeId)
    }
  }

  return {
    sourceCharacters,
    outputCharacters,
    matchedCharacters,
    missingSourceRegionIds: [...new Set(missingSourceRegionIds)],
    sameRegionFlowViolationNodeIds: [...sameRegionFlowViolationNodeIds],
    semanticTextViolationNodeIds: [...semanticTextViolationNodeIds],
    semanticFlowBoundaryLedgerValid: semanticFlowBoundaryLedger.valid,
    unprovenancedRenderedUnitKeys: outputUnits
      .filter((unit) => !unit.provenanced)
      .map((unit) => unit.key),
  }
}

function pageLines(page: PdfPageAnalysis) {
  return groupRunsIntoLines(page)
}

function scholarlyCaptionKind(value: string) {
  return (
    parsePdfScholarlyVisualLabel(value, { context: 'caption' })?.kind ?? null
  )
}

export function detectPdfSemanticSignals(
  pages: PdfPageAnalysis[],
  suppliedRegions?: PdfPageRegion[],
  suppliedLineBoundaryDecisions?: readonly PdfLineBoundaryDecision[],
): PdfSemanticSignals {
  const reconstructed = suppliedRegions ? null : reconstructPageRegions(pages)
  const regions = suppliedRegions ?? reconstructed!.regions
  const lineBoundaryDecisions =
    suppliedLineBoundaryDecisions ?? reconstructed?.lineBoundaryDecisions ?? []
  const markerResult = classifyPdfNoteMarkers(
    regions,
    undefined,
    lineBoundaryDecisions,
  )
  const captionFigures = regions.filter(
    (region) =>
      region.kind === 'caption' &&
      scholarlyCaptionKind(region.text) === 'figure',
  ).length
  const signals: PdfSemanticSignals = {
    // Once region reconstruction is available, a figure obligation requires
    // the same caption-region proof as tables. Counting raw PDF lines here
    // double-counts a split caption (or incidental "Figure:" text) and makes
    // an otherwise complete visual graph fail closed.
    captions: suppliedRegions ? captionFigures : 0,
    tables: regions.filter(
      (region) =>
        region.kind === 'caption' &&
        scholarlyCaptionKind(region.text) === 'table',
    ).length,
    equations: 0,
    citations: markerResult.classifications.filter(
      (classification) => classification.disposition === 'citation',
    ).length,
    footnoteReferences: markerResult.classifications.filter(
      (classification) => classification.disposition === 'note-reference',
    ).length,
    footnotes: markerResult.noteBodyRegionIds.length,
  }
  for (const page of pages) {
    for (const line of pageLines(page)) {
      if (!suppliedRegions && scholarlyCaptionKind(line.text) === 'figure') {
        signals.captions += 1
      }
      if (/(?:^|\b)(?:equation|eq\.?)\s*\(?\d+\)?/i.test(line.text)) {
        signals.equations += 1
      }
    }
  }
  signals.equations = Math.max(
    signals.equations,
    regions.filter(isProbableDisplayEquation).length,
  )
  return signals
}

function coverage(resolved: number, expected: number) {
  return expected === 0 ? 1 : rounded(Math.min(resolved / expected, 1))
}

function readingOrderDiagnosticCount(diagnostics: ReconstructionDiagnostic[]) {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === 'LOW_CONFIDENCE_BLOCK' ||
      diagnostic.code === 'AMBIGUOUS_READING_ORDER',
  ).length
}

function semanticAssetCounts({
  semanticSignals,
  visualRelationships,
  validatedVisualRelationships,
}: {
  semanticSignals: PdfSemanticSignals
  visualRelationships?: PdfVisualRelationship[]
  validatedVisualRelationships: PdfVisualRelationship[]
}) {
  const relationships = visualRelationships ?? []
  // A relationship is the authoritative semantic unit. Multi-asset
  // relationships have one obligation per selected component, while raw PDF
  // objects remain inventory evidence and never inflate this denominator.
  const relationshipComponentCount = (
    sourceRelationships: readonly PdfVisualRelationship[],
  ) =>
    sourceRelationships.reduce(
      (total, relationship) =>
        total + Math.max(new Set(relationship.assetIds).size, 1),
      0,
    )
  const detectedSemanticVisuals = Math.max(
    relationshipComponentCount(relationships),
    semanticSignals.captions,
    semanticSignals.tables + semanticSignals.equations,
  )
  const sourcePreservedFallbackCount = relationshipComponentCount(
    relationships.filter(
      (relationship) =>
        relationship.status !== 'matched' &&
        relationship.assetIds.length > 0 &&
        relationship.evidence.includes('source-preserved-table-fallback'),
    ),
  )
  return {
    sourceAssetCount: detectedSemanticVisuals,
    // Count the validated side with the same relationship-scoped component
    // identity. A content-addressed asset may legitimately satisfy more than
    // one independently validated relationship.
    exportedAssetCount:
      relationshipComponentCount(validatedVisualRelationships) +
      sourcePreservedFallbackCount,
  }
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u

function validUnitSourceBox(
  box: NormalizedSourceBox,
  page: PdfPageAnalysis,
  method: NormalizedSourceBox['method'],
) {
  const tolerance = 0.00001
  return (
    box.page === page.page &&
    box.rotation === page.rotation &&
    box.method === method &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1 + tolerance &&
    box.y + box.height <= 1 + tolerance
  )
}

function sameSourceBox(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.method === right.method
  )
}

function sourceBoxOverlapRatio(
  left: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
  right: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
) {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
  const smallerArea = Math.min(
    Math.max(0, left.width) * Math.max(0, left.height),
    Math.max(0, right.width) * Math.max(0, right.height),
  )
  return smallerArea > 0
    ? (intersectionWidth * intersectionHeight) / smallerArea
    : 0
}

function duplicateOcrTextMatchesEmbedded(
  embeddedText: string,
  duplicateText: string,
) {
  const duplicate = normalizedText(duplicateText)
  const embeddedTokens =
    embeddedText
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.map(normalizedText) ?? []
  return (
    duplicate.length > 0 &&
    (normalizedText(embeddedText) === duplicate ||
      embeddedTokens.includes(duplicate))
  )
}

function hasVerifiedEmbeddedOnlyOcrConfirmation(
  page: PdfPageAnalysis,
  expectedSourceSha256?: string,
) {
  const ocr = page.ocr
  const embeddedRuns = page.runs.filter(
    (run) =>
      run.method === 'pdf-text' &&
      run.text.trim() &&
      validUnitSourceBox(run, page, 'pdf-text'),
  )
  if (
    page.kind !== 'ocr-complete' ||
    page.imageCount !== 0 ||
    (page.objects?.length ?? 0) !== 0 ||
    page.runs.some((run) => run.method === 'ocr') ||
    embeddedRuns.length === 0 ||
    !ocr ||
    !ocr.engine.trim() ||
    !ocr.engineVersion.trim() ||
    !ocr.model.trim() ||
    !ocr.modelVersion.trim() ||
    ocr.languages.length === 0 ||
    ocr.languages.some((language) => !language.trim()) ||
    !SHA256_HEX_PATTERN.test(ocr.sourceSha256) ||
    !SHA256_HEX_PATTERN.test(ocr.rasterSha256) ||
    (expectedSourceSha256 !== undefined &&
      ocr.sourceSha256 !== expectedSourceSha256) ||
    !Number.isFinite(ocr.confidence) ||
    ocr.confidence < 0.75 ||
    ocr.confidence > 1 ||
    ocr.words.length === 0 ||
    ocr.words.some(
      (word) =>
        word.mergeStatus !== 'duplicate' ||
        !word.text.trim() ||
        !word.lineId.trim() ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 1 ||
        !validUnitSourceBox(word.box, page, 'ocr'),
    ) ||
    new Set(ocr.lines.map((line) => line.id)).size !== ocr.lines.length ||
    ocr.lines.some(
      (line) =>
        !line.id.trim() ||
        !line.text.trim() ||
        !Number.isFinite(line.confidence) ||
        line.confidence < 0 ||
        line.confidence > 1 ||
        !validUnitSourceBox(line.box, page, 'ocr'),
    )
  ) {
    return false
  }
  const lineIds = new Set(ocr.lines.map((line) => line.id))
  if (lineIds.size > 0 && ocr.words.some((word) => !lineIds.has(word.lineId))) {
    return false
  }
  const matchingRuns = (word: NonNullable<typeof ocr>['words'][number]) =>
    embeddedRuns.filter(
      (run) =>
        sourceBoxOverlapRatio(run, word.box) >= 0.55 &&
        duplicateOcrTextMatchesEmbedded(run.text, word.text),
    )
  return (
    ocr.words.every((word) => matchingRuns(word).length > 0) &&
    embeddedRuns.every((run) =>
      ocr.words.some(
        (word) =>
          sourceBoxOverlapRatio(run, word.box) >= 0.55 &&
          duplicateOcrTextMatchesEmbedded(run.text, word.text),
      ),
    )
  )
}

function hasSubstantiveOcrEvidence(
  page: PdfPageAnalysis,
  expectedSourceSha256?: string,
) {
  const ocr = page.ocr
  if (
    !ocr ||
    !ocr.engine.trim() ||
    !ocr.engineVersion.trim() ||
    !ocr.model.trim() ||
    !ocr.modelVersion.trim() ||
    ocr.languages.length === 0 ||
    ocr.languages.some((language) => !language.trim()) ||
    !SHA256_HEX_PATTERN.test(ocr.sourceSha256) ||
    !SHA256_HEX_PATTERN.test(ocr.rasterSha256) ||
    (expectedSourceSha256 !== undefined &&
      ocr.sourceSha256 !== expectedSourceSha256) ||
    !Number.isFinite(ocr.confidence) ||
    ocr.confidence < 0.75 ||
    ocr.confidence > 1 ||
    ocr.lines.length === 0 ||
    new Set(ocr.lines.map((line) => line.id)).size !== ocr.lines.length
  ) {
    return false
  }
  const linesById = new Map(ocr.lines.map((line) => [line.id, line]))
  if (
    ocr.lines.some(
      (line) =>
        !line.id.trim() ||
        !line.text.trim() ||
        !Number.isFinite(line.confidence) ||
        line.confidence < 0 ||
        line.confidence > 1 ||
        !validUnitSourceBox(line.box, page, 'ocr'),
    ) ||
    ocr.words.some(
      (word) =>
        !word.text.trim() ||
        !word.lineId.trim() ||
        !linesById.has(word.lineId) ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 1 ||
        !validUnitSourceBox(word.box, page, 'ocr'),
    )
  ) {
    return false
  }
  const acceptedWords = ocr.words.filter(
    (word) => word.mergeStatus === 'accepted',
  )
  if (acceptedWords.length === 0) return false
  const recoveredRuns = page.runs.filter(
    (run) =>
      run.method === 'ocr' &&
      run.text.trim() &&
      validUnitSourceBox(run, page, 'ocr'),
  )
  return acceptedWords.every((word) =>
    recoveredRuns.some(
      (run) => run.text === word.text.trim() && sameSourceBox(run, word.box),
    ),
  )
}

function mixedPageHasCompleteSemanticVisualCoverage({
  page,
  pages,
  regions,
  validatedVisualRelationships,
  equationTranscriptContext,
}: {
  page: PdfPageAnalysis
  pages: readonly PdfPageAnalysis[]
  regions: readonly PdfPageRegion[]
  validatedVisualRelationships: readonly PdfVisualRelationship[]
  equationTranscriptContext: EquationTranscriptContext
}) {
  const objects = page.objects ?? []
  const decorativeObjectIds = decorativeNativeObjectIds([...pages])
  const semanticObjects = objects.filter(
    (object) =>
      object.role !== 'scan-source' && !decorativeObjectIds.has(object.id),
  )
  if (
    objects.some((object) => object.role === 'scan-source') ||
    semanticObjects.length === 0 ||
    page.imageCount > objects.filter((object) => object.kind === 'image').length
  ) {
    return false
  }
  const claimedObjectIds = new Set(
    validatedVisualRelationships.flatMap((relationship) => {
      if (
        !relationship.sourceBoxes.some((box) => box.page === page.page) ||
        (relationship.kind === 'equation' &&
          !hasResolvedEquationTranscript(
            relationship,
            regions,
            pages,
            equationTranscriptContext,
          ))
      ) {
        return []
      }
      return relationship.sourceObjectIds
    }),
  )
  return semanticObjects.every((object) => claimedObjectIds.has(object.id))
}

export function assessPdfCompleteness({
  pages,
  paper,
  diagnostics,
  readingOrder,
  regions,
  visualRelationships,
  assets,
  citationRelationships,
  noteRelationships,
  policy = DEFAULT_PDF_COMPLETENESS_POLICY,
  reclassifiedNoteReferenceCount = 0,
  reclassifiedCitationCount = 0,
  lineBoundaryDecisions,
  sourceSemanticFlowBoundaryDecisions,
  sourceSemanticFlowBoundaryDecisionCount,
  canonicalHyphenBoundaryDecisions,
  canonicalHyphenBoundaryDecisionCount,
  unresolvedCorruptingJoinCount,
  structurallyConsumedLineBoundaryCount,
  provenance,
  inlineSpanLedger = { expected: 0, mapped: 0 },
  hyperlinkLedger = { expected: 0, mapped: 0 },
  sourceSha256,
  canonicalFloatScopes = [],
  furnitureExcludedRunCount,
  furnitureExcludedTextCharacters,
  furnitureContaminationCount,
}: QualityInput): {
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  diagnostics: ReconstructionDiagnostic[]
  readiness: PdfReadiness
} {
  const semanticSignals = detectPdfSemanticSignals(
    pages,
    regions,
    lineBoundaryDecisions,
  )
  if (visualRelationships !== undefined) {
    const relationshipEquationCount = new Set(
      visualRelationships
        .filter((relationship) => relationship.kind === 'equation')
        .map((relationship) => relationship.id),
    ).size
    const probableDisplayEquationCount = (
      regions ?? reconstructPageRegions(pages).regions
    ).filter(isProbableDisplayEquation).length
    // A non-empty equation graph is the authoritative atomic denominator and
    // avoids counting repeated prose references as separate equations, but it
    // cannot erase source-proved display regions that the graph missed. An
    // empty graph is likewise not proof that raw equation evidence was a false
    // positive: production supplies [] when detection misses every equation.
    // Preserve those obligations so reconstruction always fails closed.
    if (relationshipEquationCount > 0) {
      semanticSignals.equations = Math.max(
        relationshipEquationCount,
        probableDisplayEquationCount,
      )
    } else if (semanticSignals.equations === 0) {
      semanticSignals.equations = 0
    }
  }
  semanticSignals.footnoteReferences = Math.max(
    semanticSignals.footnoteReferences - reclassifiedNoteReferenceCount,
    0,
  )
  semanticSignals.citations += reclassifiedCitationCount
  const validatedVisualRelationships = validatedPdfVisualRelationships({
    paper,
    provenance,
    relationships: visualRelationships,
    assets,
    regions,
    pages,
  })
  const allSourceRegions = regions ?? []
  const equationTranscriptContext: EquationTranscriptContext = {
    paper,
    pages,
    regions: allSourceRegions,
    visualRelationships: visualRelationships ?? [],
    assets: assets ?? [],
  }
  const regionMap = new Map(
    allSourceRegions.map((region) => [region.id, region]),
  )
  const orderedSourceRegions = readingOrder
    ? readingOrder.order
        .map((id) => regionMap.get(id))
        .filter((region): region is PdfPageRegion => Boolean(region))
    : []
  const sourceText = normalizedText(
    orderedSourceRegions.length > 0
      ? orderedSourceRegions.map((region) => region.text).join(' ')
      : pages
          .flatMap((page) => page.runs)
          .map((run) => run.text)
          .join(' '),
  )
  const orderedSourceRegionIds = new Set(
    orderedSourceRegions.map((region) => region.id),
  )
  const furnitureRegions = allSourceRegions.filter((region) => region.furniture)
  const excludedFurnitureRegions = furnitureRegions.filter(
    (region) => !orderedSourceRegionIds.has(region.id),
  )
  const derivedFurnitureRunCount = furnitureRegions.reduce(
    (total, region) =>
      total + region.lines.reduce((count, line) => count + line.runs.length, 0),
    0,
  )
  const derivedFurnitureTextCharacters = excludedFurnitureRegions.reduce(
    (total, region) =>
      total +
      region.lines.reduce(
        (lineTotal, line) =>
          lineTotal +
          line.runs.reduce(
            (runTotal, run) =>
              runTotal + characterCount(normalizedText(run.text)),
            0,
          ),
        0,
      ),
    0,
  )
  const derivedFurnitureContaminationCount = furnitureRegions.filter((region) =>
    orderedSourceRegionIds.has(region.id),
  ).length
  const validatedVisualRepresentation = validatedVisualRepresentationByNode(
    paper,
    provenance,
    validatedVisualRelationships,
    assets,
    allSourceRegions,
    pages,
  )
  const outputText = normalizedText(
    paper.nodes
      .map((node) =>
        nodeText(node, validatedVisualRepresentation.textByNode.get(node.id)),
      )
      .filter(Boolean)
      .join(' '),
  )
  const provenanceBackedConservation =
    orderedSourceRegions.length > 0 && provenance
  const semanticFlowLedgerCountValid =
    hasValidSourceSemanticFlowBoundaryLedgerCount({
      decisions: sourceSemanticFlowBoundaryDecisions,
      expectedCount: sourceSemanticFlowBoundaryDecisionCount,
    })
  const conservedText = provenanceBackedConservation
    ? provenanceTextConservation({
        allRegions: allSourceRegions,
        orderedRegions: orderedSourceRegions,
        paper,
        provenance,
        visualRelationships,
        validatedVisualRelationships,
        assets,
        pages,
        lineBoundaryDecisions: lineBoundaryDecisions ?? [],
        sourceSemanticFlowBoundaryDecisions: semanticFlowLedgerCountValid
          ? (sourceSemanticFlowBoundaryDecisions ?? [])
          : [],
      })
    : {
        sourceCharacters: characterCount(sourceText),
        outputCharacters: characterCount(outputText),
        matchedCharacters: orderedMatchedCharacters(sourceText, outputText),
        missingSourceRegionIds: [],
        sameRegionFlowViolationNodeIds: [],
        semanticTextViolationNodeIds: [],
        semanticFlowBoundaryLedgerValid: true,
        unprovenancedRenderedUnitKeys: [],
      }
  const semanticFlowLedgerValid =
    semanticFlowLedgerCountValid &&
    conservedText.semanticFlowBoundaryLedgerValid
  const invalidSemanticFlowLedgerNodeIds =
    !semanticFlowLedgerValid && provenance
      ? paper.nodes.flatMap((node) =>
          (provenance[node.id]?.regionIds.length ?? 0) > 1 ? [node.id] : [],
        )
      : []
  const furnitureRegionIds = new Set(
    furnitureRegions.map((region) => region.id),
  )
  const provenanceFurnitureContaminationCount = paper.nodes.reduce(
    (total, node) =>
      total +
      (provenance?.[node.id]?.regionIds ?? []).filter((regionId) =>
        furnitureRegionIds.has(regionId),
      ).length,
    0,
  )
  const resolvedFurnitureRunCount =
    furnitureExcludedRunCount ?? derivedFurnitureRunCount
  const resolvedFurnitureTextCharacters =
    furnitureExcludedTextCharacters ?? derivedFurnitureTextCharacters
  const resolvedFurnitureContaminationCount = Math.max(
    furnitureContaminationCount ?? 0,
    derivedFurnitureContaminationCount,
    provenanceFurnitureContaminationCount,
  )
  const matchedTextCharacters = conservedText.matchedCharacters
  const duplicateSpans = duplicateCanonicalSpanCount(sourceText, paper)
  const classifiedLineBoundaries = classifyStructuralLineBoundaryDecisions({
    decisions: lineBoundaryDecisions ?? [],
    paper,
    provenance,
    visualRelationships,
    assets,
    regions: allSourceRegions,
    pages,
  })
  const lineLedger = validateLineBoundaryLedger(
    regions,
    lineBoundaryDecisions ? classifiedLineBoundaries.decisions : undefined,
    unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount,
  )
  const { sourceAssetCount, exportedAssetCount } = semanticAssetCounts({
    semanticSignals,
    visualRelationships,
    validatedVisualRelationships,
  })
  const relationships = relationshipCounts(
    paper,
    semanticSignals,
    pages,
    visualRelationships === undefined
      ? undefined
      : validatedVisualRelationships,
    citationRelationships,
    noteRelationships,
    provenance,
    assets,
    allSourceRegions,
    equationTranscriptContext,
    readingOrder,
    lineBoundaryDecisions,
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
    citations: Math.max(
      semanticSignals.citations - relationships.resolvedCitations,
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
  const flowOrderViolationNodeIds = [
    ...new Set([
      ...canonicalFlowOrderViolationNodeIds(
        paper,
        provenance,
        orderedSourceRegions,
        canonicalFloatScopes,
      ),
      ...conservedText.sameRegionFlowViolationNodeIds,
      ...conservedText.semanticTextViolationNodeIds,
      ...invalidSemanticFlowLedgerNodeIds,
      ...unprovedInlineMathAtomNodeIds({
        paper,
        provenance,
        regions: allSourceRegions,
      }),
    ]),
  ]
  const visualOrderViolationRelationshipIds =
    canonicalVisualOrderViolationRelationshipIds(
      paper,
      validatedVisualRelationships,
      readingOrder,
    )
  const readingOrderDiagnostics =
    readingOrderDiagnosticCount(diagnostics) +
    (flowOrderViolationNodeIds.length > 0 ? 1 : 0) +
    (visualOrderViolationRelationshipIds.length > 0 ? 1 : 0)
  const sourceReadingOrderEvaluation =
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
  const readingOrderEvaluation = {
    ...sourceReadingOrderEvaluation,
    reviewRequired:
      sourceReadingOrderEvaluation.reviewRequired ||
      readingOrderDiagnostics > 0,
  }
  const ocrRequiredPages = pages
    .filter((page) => {
      if (page.kind === 'born-digital') return false
      const substantiveOcr =
        hasSubstantiveOcrEvidence(page, sourceSha256) ||
        hasVerifiedEmbeddedOnlyOcrConfirmation(page, sourceSha256)
      if (page.kind === 'ocr-complete') return !substantiveOcr
      if (page.kind === 'ocr-required') return true
      return (
        !substantiveOcr &&
        !mixedPageHasCompleteSemanticVisualCoverage({
          page,
          pages,
          regions: allSourceRegions,
          validatedVisualRelationships,
          equationTranscriptContext,
        })
      )
    })
    .map((page) => page.page)
  const coveredByFurnitureCharacters = derivedFurnitureTextCharacters
  // The non-provenance fallback derives source text from every page run,
  // including furniture. Provenance-backed conservation starts from the
  // canonical flow and therefore needs the excluded furniture added back.
  const sourceTextCharactersWithFurniture = provenanceBackedConservation
    ? conservedText.sourceCharacters + coveredByFurnitureCharacters
    : conservedText.sourceCharacters
  const coveredInFlowCharacters = matchedTextCharacters
  const lostTextCharacterCount = Math.max(
    sourceTextCharactersWithFurniture -
      coveredInFlowCharacters -
      coveredByFurnitureCharacters,
    0,
  )
  const furnitureAccountingEnabled =
    furnitureRegions.length > 0 ||
    resolvedFurnitureRunCount > 0 ||
    resolvedFurnitureContaminationCount > 0
  const completeness: PdfCompletenessMetrics = {
    sourceTextCharacters: furnitureAccountingEnabled
      ? sourceTextCharactersWithFurniture
      : conservedText.sourceCharacters,
    outputTextCharacters: conservedText.outputCharacters,
    matchedTextCharacters,
    textCoverage: Math.min(
      coverage(
        matchedTextCharacters + coveredByFurnitureCharacters,
        sourceTextCharactersWithFurniture,
      ),
      coverage(matchedTextCharacters, conservedText.outputCharacters),
    ),
    duplicateCanonicalSpanCount: duplicateSpans,
    missingSourceRegionCount: conservedText.missingSourceRegionIds.length,
    unprovenancedRenderedUnitCount:
      conservedText.unprovenancedRenderedUnitKeys.length,
    expectedInlineSpanCount: inlineSpanLedger.expected,
    mappedInlineSpanCount: inlineSpanLedger.mapped,
    inlineSpanCoverage: coverage(
      inlineSpanLedger.mapped,
      inlineSpanLedger.expected,
    ),
    expectedHyperlinkCount: hyperlinkLedger.expected,
    mappedHyperlinkCount: hyperlinkLedger.mapped,
    hyperlinkCoverage: coverage(
      hyperlinkLedger.mapped,
      hyperlinkLedger.expected,
    ),
    lineBoundaryCount: lineLedger.expected,
    decidedLineBoundaryCount: lineLedger.decided,
    unresolvedCorruptingJoinCount: lineLedger.unresolved,
    structurallyConsumedLineBoundaryCount: lineLedger.structurallyConsumed,
    sourceAssetCount,
    exportedAssetCount,
    assetCoverage: coverage(exportedAssetCount, sourceAssetCount),
    expectedRelationshipCount: relationships.expected,
    resolvedRelationshipCount: relationships.resolved,
    relationshipCoverage: coverage(
      relationships.resolved,
      relationships.expected,
    ),
    expectedSemanticTableCount: semanticSignals.tables,
    resolvedSemanticTableCount: relationships.resolvedSemanticTables,
    semanticTableCoverage: coverage(
      relationships.resolvedSemanticTables,
      semanticSignals.tables,
    ),
    unresolvedObjectCount,
    unresolvedObjects,
    ocrRequiredPages,
    readingOrderDiagnostics,
    readingOrderEvaluation,
    ...(furnitureAccountingEnabled
      ? {
          furnitureExcludedRunCount: resolvedFurnitureRunCount,
          furnitureExcludedTextCharacters: resolvedFurnitureTextCharacters,
          furnitureContaminationCount: resolvedFurnitureContaminationCount,
          lostTextCharacterCount,
          textCoverageAccounting: {
            sourceCharacters: sourceTextCharactersWithFurniture,
            coveredInFlowCharacters,
            coveredByFurnitureCharacters,
            lostCharacters: lostTextCharacterCount,
          },
        }
      : {}),
  }
  const qualityDiagnostics: ReconstructionDiagnostic[] = []
  const furnitureReviewRegions = allSourceRegions.filter(
    (region) => region.furnitureReview,
  )
  if (furnitureReviewRegions.length > 0) {
    qualityDiagnostics.push({
      code: 'FURNITURE_REVIEW_REQUIRED',
      severity: 'error',
      message: `${furnitureReviewRegions.length} single-occurrence margin run${furnitureReviewRegions.length === 1 ? '' : 's'} remain readable but require bounded source review before publication.`,
      sourceBoxes: furnitureReviewRegions.flatMap(
        (region) => region.furnitureReview?.boxes ?? [],
      ),
      target: {
        regionIds: furnitureReviewRegions.map((region) => region.id),
        markerId: null,
      },
    })
  }
  if (resolvedFurnitureContaminationCount > 0) {
    const contaminationRegionIds = furnitureRegions
      .filter((region) => orderedSourceRegionIds.has(region.id))
      .map((region) => region.id)
    qualityDiagnostics.push({
      code: 'FURNITURE_CONTAMINATION',
      severity: 'error',
      message: `${resolvedFurnitureContaminationCount} accounted furniture region${resolvedFurnitureContaminationCount === 1 ? '' : 's'} entered canonical body flow.`,
      sourceBoxes: furnitureRegions
        .filter((region) => orderedSourceRegionIds.has(region.id))
        .flatMap((region) => [region.box, ...(region.furniture?.boxes ?? [])]),
      ...(contaminationRegionIds.length > 0
        ? { target: { regionIds: contaminationRegionIds, markerId: null } }
        : {}),
    })
  }
  if (!semanticFlowLedgerValid) {
    qualityDiagnostics.push({
      code: 'INVALID_SOURCE_SEMANTIC_FLOW_BOUNDARY_LEDGER',
      severity: 'error',
      message:
        'The source semantic-flow boundary ledger is missing, malformed, stale, conflicting, or not consumed exactly once by canonical text reconstruction.',
    })
  }
  for (const page of pages) {
    const extractedImageObjectCount = (page.objects ?? []).filter(
      (object) => object.kind === 'image',
    ).length
    if (page.imageCount <= extractedImageObjectCount) continue
    qualityDiagnostics.push({
      code: 'UNREFERENCED_VISUAL_ASSET',
      severity: 'error',
      page: page.page,
      message: `Page ${page.page} reports ${page.imageCount} embedded image operator${page.imageCount === 1 ? '' : 's'}, but only ${extractedImageObjectCount} have source-bounded object geometry; publication is blocked until every operator is classified or reconstructed.`,
      sourceBoxes: [
        {
          page: page.page,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          rotation: page.rotation,
          method: 'pdf-object',
        },
      ],
    })
  }
  if (
    !hasValidCanonicalHyphenBoundaryLedger({
      decisions: canonicalHyphenBoundaryDecisions,
      expectedCount: canonicalHyphenBoundaryDecisionCount,
      regions: allSourceRegions,
    })
  ) {
    qualityDiagnostics.push({
      code: 'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
      severity: 'error',
      message:
        'A canonical discretionary-hyphen deletion is missing complete, unique, source-bound geometry and lexical counterproof.',
    })
  }
  for (const page of pages.filter((candidate) =>
    ocrRequiredPages.includes(candidate.page),
  )) {
    if (
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'OCR_REQUIRED' &&
          diagnostic.severity === 'error' &&
          diagnostic.page === page.page,
      )
    ) {
      continue
    }
    qualityDiagnostics.push({
      code: 'OCR_REQUIRED',
      severity: 'error',
      page: page.page,
      message: `Page ${page.page} has insufficient source-backed text recovery and requires local OCR evidence.`,
      sourceBoxes: [
        {
          page: page.page,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          rotation: page.rotation,
          method: 'pdf-object',
        },
      ],
    })
  }
  const unresolvedEquationTranscripts = (visualRelationships ?? []).filter(
    (relationship) =>
      relationship.kind === 'equation' &&
      relationship.status === 'matched' &&
      !hasResolvedEquationTranscript(
        relationship,
        regions,
        pages,
        equationTranscriptContext,
      ),
  )
  for (const relationship of unresolvedEquationTranscripts) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `${relationship.label || relationship.id} has a matched visual rendition but no complete source-line-backed semantic transcript; its crop preserves visual fidelity without resolving equation semantics.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: relationship.sourceRegionIds,
        markerId: relationship.id,
      },
    })
  }
  const unresolvedAlgorithmTranscripts = (visualRelationships ?? []).filter(
    (relationship) =>
      relationship.semanticKind === 'algorithm' &&
      relationship.status === 'matched' &&
      (relationship.sourceText.trim().length === 0 ||
        relationship.evidence.includes('source-text-transcript-unresolved')),
  )
  for (const relationship of unresolvedAlgorithmTranscripts) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_ALGORITHM_TRANSCRIPT',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `${relationship.label || relationship.id} is preserved as an exact source visual, but its semantic line indentation and continuation ownership remain unresolved.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: relationship.sourceRegionIds,
        markerId: null,
      },
    })
  }
  const unresolvedPreformattedTranscripts = (visualRelationships ?? []).filter(
    (relationship) =>
      relationship.semanticKind === 'code' &&
      relationship.status === 'matched' &&
      (relationship.preformatted?.status !== 'proved' ||
        relationship.preformatted.lines.length === 0 ||
        relationship.evidence.includes('source-text-transcript-unresolved')),
  )
  for (const relationship of unresolvedPreformattedTranscripts) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `${relationship.label || relationship.id} is preserved as an exact source crop, but its textual tokens, whitespace, indentation, or column ownership are not fully proved by source-line evidence.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: relationship.sourceRegionIds,
        markerId: null,
      },
    })
  }
  const textIntegrityIssues = canonicalTextIntegrityIssues(paper)
  if (textIntegrityIssues.length > 0) {
    const forbiddenXmlCharacterCount = textIntegrityIssues.reduce(
      (total, issue) => total + issue.forbiddenXmlCharacterCount,
      0,
    )
    const replacementGlyphCount = textIntegrityIssues.reduce(
      (total, issue) => total + issue.replacementGlyphCount,
      0,
    )
    const regionIds = [
      ...new Set(
        textIntegrityIssues.flatMap(
          (issue) => provenance?.[issue.nodeId]?.regionIds ?? [],
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'EPUB_TEXT_SANITIZATION_LOSS',
      severity: 'error',
      message: `${textIntegrityIssues.length} canonical text field${textIntegrityIssues.length === 1 ? '' : 's'} contain ${forbiddenXmlCharacterCount} forbidden XML code point${forbiddenXmlCharacterCount === 1 ? '' : 's'} and ${replacementGlyphCount} Unicode replacement glyph${replacementGlyphCount === 1 ? '' : 's'}; EPUB export would be lossy or preserve known character corruption.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  const internalReferenceIssues = internalReferenceIntegrityIssues(
    paper,
    noteRelationships,
    noteRelationships === undefined
      ? undefined
      : {
          regions: allSourceRegions,
          provenance: provenance ?? {},
        },
  )
  if (internalReferenceIssues.length > 0) {
    const regionIds = [
      ...new Set(
        internalReferenceIssues.flatMap(
          (issue) => provenance?.[issue.sourceId]?.regionIds ?? [],
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
      severity: 'error',
      message: `${internalReferenceIssues.length} canonical internal relationship${internalReferenceIssues.length === 1 ? '' : 's'} would render with a missing target or be silently omitted from EPUB navigation.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  if (completeness.textCoverage < policy.minimumTextCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_TEXT_COVERAGE',
      severity: 'error',
      message: `Recovered text coverage ${completeness.textCoverage.toFixed(3)} is below the configured minimum ${policy.minimumTextCoverage.toFixed(3)}.`,
    })
  }
  if (duplicateSpans > 0) {
    qualityDiagnostics.push({
      code: 'DUPLICATE_CANONICAL_SPAN',
      severity: 'error',
      message: `${duplicateSpans} canonical text span${duplicateSpans === 1 ? '' : 's'} exceed the source-backed occurrence count.`,
    })
  }
  const duplicateRoleNodeIds = duplicateCanonicalRoleNodeIds(paper)
  if (duplicateRoleNodeIds.length > 0) {
    const regionIds = [
      ...new Set(
        duplicateRoleNodeIds.flatMap(
          (nodeId) => provenance?.[nodeId]?.regionIds ?? [],
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'DUPLICATE_CANONICAL_ROLE',
      severity: 'error',
      message: `${duplicateRoleNodeIds.length} canonical role${duplicateRoleNodeIds.length === 1 ? '' : 's'} repeat the publication title or an adjacent normalized-equal heading.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  if (flowOrderViolationNodeIds.length > 0) {
    const flowRegionIds = new Set(
      orderedSourceRegions
        .filter(
          (region) => region.kind === 'body' || region.kind === 'spanning',
        )
        .map((region) => region.id),
    )
    const regionIds = [
      ...new Set(
        flowOrderViolationNodeIds.flatMap((nodeId) =>
          (provenance?.[nodeId]?.regionIds ?? []).filter((regionId) =>
            flowRegionIds.has(regionId),
          ),
        ),
      ),
    ]
    qualityDiagnostics.push({
      code: 'CANONICAL_FLOW_ORDER_VIOLATION',
      severity: 'error',
      message: `${flowOrderViolationNodeIds.length} canonical text unit${flowOrderViolationNodeIds.length === 1 ? '' : 's'} cross or reverse source order, omit source text, or change source punctuation, operators, case, or token boundaries.`,
      ...(regionIds.length > 0
        ? { target: { regionIds, markerId: null } }
        : {}),
    })
  }
  if (visualOrderViolationRelationshipIds.length > 0) {
    const violatingRelationships = validatedVisualRelationships.filter(
      (relationship) =>
        visualOrderViolationRelationshipIds.includes(relationship.id),
    )
    qualityDiagnostics.push({
      code: 'CANONICAL_VISUAL_ORDER_VIOLATION',
      severity: 'error',
      message: `${visualOrderViolationRelationshipIds.length} matched visual relationship${visualOrderViolationRelationshipIds.length === 1 ? '' : 's'} reverse the source-proved order of their atomic visual-caption pairs.`,
      sourceBoxes: violatingRelationships.flatMap(
        (relationship) => relationship.sourceBoxes,
      ),
      target: {
        regionIds: [
          ...new Set(
            violatingRelationships.flatMap((relationship) => [
              relationship.captionRegionId,
              ...relationship.sourceRegionIds,
            ]),
          ),
        ],
        markerId: null,
      },
    })
  }
  if (completeness.missingSourceRegionCount > 0) {
    qualityDiagnostics.push({
      code: 'MISSING_SOURCE_REGION',
      severity: 'error',
      message: `${completeness.missingSourceRegionCount} nonempty source reading-order region${completeness.missingSourceRegionCount === 1 ? '' : 's'} have no canonical rendered unit.`,
      target: {
        regionIds: conservedText.missingSourceRegionIds,
        markerId: null,
      },
    })
  }
  if (completeness.unprovenancedRenderedUnitCount > 0) {
    qualityDiagnostics.push({
      code: 'UNPROVENANCED_RENDERED_UNIT',
      severity: 'error',
      message: `${completeness.unprovenancedRenderedUnitCount} nonempty rendered unit${completeness.unprovenancedRenderedUnitCount === 1 ? '' : 's'} lack valid source-region provenance.`,
    })
  }
  if (completeness.inlineSpanCoverage < 1) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_INLINE_STYLE_COVERAGE',
      severity: 'error',
      message: `Mapped ${completeness.mappedInlineSpanCount} of ${completeness.expectedInlineSpanCount} supported source inline-style spans into canonical content.`,
    })
  }
  if (
    completeness.hyperlinkCoverage < 1 &&
    !diagnostics.some(
      (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
    )
  ) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_HYPERLINK',
      severity: 'error',
      message: `Verified ${completeness.mappedHyperlinkCount} of ${completeness.expectedHyperlinkCount} source links. Unverified links remain visible as text instead of becoming broken links.`,
    })
  }
  if (lineLedger.configured && !lineLedger.valid) {
    qualityDiagnostics.push({
      code: 'INVALID_LINE_BOUNDARY_LEDGER',
      severity: 'error',
      message: `The line-boundary ledger accounts for ${lineLedger.decided} of ${lineLedger.expected} adjacent source-line transitions or contains invalid transition evidence.`,
    })
  }
  if (lineLedger.unresolved > 0) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_CORRUPTING_JOIN',
      severity: 'error',
      message: `${lineLedger.unresolved} line join${lineLedger.unresolved === 1 ? '' : 's'} remain uncertain. The export keeps those breaks rather than joining words incorrectly.`,
    })
  }
  if (completeness.assetCoverage < policy.minimumAssetCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_ASSET_COVERAGE',
      severity: 'error',
      message: `Kept ${exportedAssetCount} of ${sourceAssetCount} detected visual regions. Any missing artwork remains a named source-recovery item instead of being silently omitted.`,
    })
  }
  if (completeness.relationshipCoverage < policy.minimumRelationshipCoverage) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
      severity: 'error',
      message: `Verified ${relationships.resolved} of ${relationships.expected} links between captions, notes, citations, and their targets. Uncertain connections remain visible without a guessed destination.`,
    })
  }
  if (
    completeness.expectedSemanticTableCount !== undefined &&
    completeness.resolvedSemanticTableCount !== undefined &&
    completeness.resolvedSemanticTableCount <
      completeness.expectedSemanticTableCount
  ) {
    qualityDiagnostics.push({
      code: 'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
      severity: 'error',
      message: `Rebuilt ${completeness.resolvedSemanticTableCount} of ${completeness.expectedSemanticTableCount} tables as structured rows and columns. The remaining table${completeness.expectedSemanticTableCount - completeness.resolvedSemanticTableCount === 1 ? '' : 's'} stays as source-preserved artwork or a bounded text fallback.`,
    })
  }
  if (unresolvedObjectCount > policy.maximumUnresolvedObjects) {
    qualityDiagnostics.push({
      code: 'UNRESOLVED_SEMANTIC_OBJECTS',
      severity: 'error',
      message: `${unresolvedObjectCount} source detail${unresolvedObjectCount === 1 ? '' : 's'} still need review: ${unresolvedObjects.assets} visual${unresolvedObjects.assets === 1 ? '' : 's'}, ${unresolvedObjects.tables} table${unresolvedObjects.tables === 1 ? '' : 's'}, ${unresolvedObjects.equations} equation${unresolvedObjects.equations === 1 ? '' : 's'}, ${unresolvedObjects.citations} citation${unresolvedObjects.citations === 1 ? '' : 's'}, and ${unresolvedObjects.footnotes + unresolvedObjects.footnoteReferences} note reference${unresolvedObjects.footnotes + unresolvedObjects.footnoteReferences === 1 ? '' : 's'}. Recoverable source content is kept in the readable export.`,
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
