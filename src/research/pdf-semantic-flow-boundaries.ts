import type {
  PdfCanonicalHyphenBoundaryDecision,
  PdfPageRegion,
  PdfSourceRun,
  PdfSourceSemanticFlowBoundaryDecision,
} from './import-types'
import {
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
  type PdfHyphenBoundaryProof,
} from './pdf-hyphenation'
import {
  blockSourceSegments,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import {
  canonicalPdfSourceSemanticFlowEvidence,
  PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE,
  type PdfBodySourceOrderExtremum,
  pdfSourceFragmentId,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
} from './pdf-regions'

export type CanonicalHyphenDeletionRequest = {
  context: PdfCanonicalHyphenBoundaryDecision['context']
  proof: PdfHyphenBoundaryProof
  left: string
  right: string
  decisions: PdfCanonicalHyphenBoundaryDecision[]
}

export function canonicalHyphenDeletionDecision(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  targetSegments: ReturnType<typeof blockSourceSegments>,
  request: CanonicalHyphenDeletionRequest | null,
): PdfCanonicalHyphenBoundaryDecision | null {
  if (!request) return null
  const tailSegment = targetSegments.at(-1)
  const headSegment = blockSourceSegments(continuation)[0]
  const tailEvidenceRegion = tailSegment?.evidenceRegion ?? tailSegment?.region
  const headEvidenceRegion = headSegment?.evidenceRegion ?? headSegment?.region
  const tailLine = tailEvidenceRegion?.lines.at(-1)
  const headLine = headEvidenceRegion?.lines[0]
  const actualLeft = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const actualRight = continuation.text
    .trimStart()
    .match(/^([\p{L}\p{N}]+)/u)?.[1]
  const joinedForm = `${request.left}${request.right}`.normalize('NFKC')
  const proof = request.proof
  const lexicalProof = proof.lexicalProof
  const exactSameDocumentProof =
    lexicalProof?.tier === 'exact-same-document' &&
    proof.pinnedJoinedFormValid &&
    proof.sameDocumentJoinedFormValid &&
    proof.evidence.includes('same-document-unhyphenated-word')
  const derivedAffixProof =
    lexicalProof?.tier === 'same-document-derived-affix' &&
    !proof.pinnedJoinedFormValid &&
    !proof.sameDocumentJoinedFormValid &&
    lexicalProof.derivedWord ===
      joinedForm.normalize('NFKC').toLocaleLowerCase('en-US') &&
    lexicalProof.productivePrefix.kind ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.kind &&
    lexicalProof.productivePrefix.value ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value &&
    lexicalProof.productivePrefix.affixClass ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.affixClass &&
    lexicalProof.productivePrefix.flag ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.flag &&
    lexicalProof.productivePrefix.crossProduct ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.crossProduct &&
    lexicalProof.productivePrefix.affixSha256 ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.affixSha256 &&
    lexicalProof.pinnedBaseWordValid &&
    lexicalProof.sameDocumentBaseWordValid &&
    PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE.every((evidence) =>
      proof.evidence.includes(evidence),
    )
  if (
    !tailSegment ||
    !headSegment ||
    !tailLine ||
    !headLine ||
    !actualLeft ||
    !actualRight ||
    actualLeft.normalize('NFKC') !== request.left.normalize('NFKC') ||
    actualRight.normalize('NFKC') !== request.right.normalize('NFKC') ||
    !/[-‐‑]$/u.test(target.text) ||
    !/[-‐‑]$/u.test(tailSegment.text) ||
    proof.verdict !== 'remove' ||
    !proof.sourceBoundaryProven ||
    !proof.joinedFormValid ||
    !proof.splitPointValid ||
    proof.hardHyphenFormValid ||
    proof.model === null ||
    !lexicalProof ||
    (!exactSameDocumentProof && !derivedAffixProof) ||
    proof.joinedForm !== joinedForm ||
    proof.evidence.includes('hard-hyphen-form-valid:same-document')
  ) {
    return null
  }
  const pinnedSplit = {
    left: request.left,
    right: request.right,
    index: request.left.normalize('NFKC').length,
  }
  const commonProof = {
    sourceBoundaryProven: true as const,
    pinnedSplit,
    splitPointValid: true as const,
    hardHyphenForm: proof.hardHyphenForm,
    hardHyphenCounterproof: null,
    model: { ...proof.model },
    evidence: [...proof.evidence],
  }
  const canonicalProof =
    lexicalProof.tier === 'exact-same-document'
      ? {
          ...commonProof,
          tier: 'exact-same-document' as const,
          pinnedWord: proof.joinedForm,
          pinnedJoinedFormValid: true as const,
          exactSameDocumentJoinedForm: proof.joinedForm,
          sameDocumentJoinedFormValid: true as const,
        }
      : {
          ...commonProof,
          tier: 'same-document-derived-affix' as const,
          derivedWord: proof.joinedForm,
          productivePrefix: { ...lexicalProof.productivePrefix },
          baseWord: lexicalProof.baseWord,
          pinnedBaseWordValid: true as const,
          exactSameDocumentBaseWord: lexicalProof.exactSameDocumentBaseWord,
          sameDocumentBaseWordValid: true as const,
        }
  return {
    id: `canonical-hyphen-boundary:${request.context}:${tailSegment.region.id}:${tailLine.id}->${headSegment.region.id}:${headLine.id}`,
    context: request.context,
    outcome: 'removed-discretionary-hyphen',
    fromRegionId: tailSegment.region.id,
    fromLineId: tailLine.id,
    toRegionId: headSegment.region.id,
    toLineId: headLine.id,
    geometry: {
      from: { ...tailLine.box },
      to: { ...headLine.box },
    },
    proof: canonicalProof,
  }
}

export function dominantSemanticFlowLineMetrics(
  line: PdfPageRegion['lines'][number],
) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length === 0) return null
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const dominantRuns = runs.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  return {
    fontSize: maximumFontSize,
    baseline:
      dominantRuns.reduce(
        (total, run) =>
          total + (run.y + run.height) * Math.max(run.text.trim().length, 1),
        0,
      ) /
      dominantRuns.reduce(
        (total, run) => total + Math.max(run.text.trim().length, 1),
        0,
      ),
    height: Math.max(...dominantRuns.map((run) => run.height)),
  }
}

export type SourceSemanticFlowBoundaryCandidate = Omit<
  PdfSourceSemanticFlowBoundaryDecision,
  'id' | 'outcome' | 'topology'
> & {
  topology:
    | PdfSourceSemanticFlowBoundaryDecision['topology']
    | 'cross-gutter-to-span'
    | 'same-column-citation-year'
    | 'cross-column-citation-year'
    | 'aligned-enumeration'
    | 'bibliography-same-baseline'
    | 'bibliography-hanging-indent'
  outcome:
    PdfSourceSemanticFlowBoundaryDecision['outcome'] | 'space' | 'unresolved'
}

export function sourceSemanticFlowBoundaryCandidate(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  outcome: SourceSemanticFlowBoundaryCandidate['outcome'],
  topology: SourceSemanticFlowBoundaryCandidate['topology'],
  bodySourceOrderExtremaByPage: ReadonlyMap<
    number,
    PdfBodySourceOrderExtremum
  > = new Map(),
): SourceSemanticFlowBoundaryCandidate | null {
  const crossPage = topology === 'cross-page-column'
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines.find((line) =>
    line.text.trim(),
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine
  ) {
    return null
  }
  const targetSourceLines = targetTailSegment.region.lines.filter(
    (line) => line.id === targetTailLine.id,
  )
  const continuationSourceLines = continuationHeadSegment.region.lines.filter(
    (line) => line.id === continuationHeadLine.id,
  )
  if (targetSourceLines.length !== 1 || continuationSourceLines.length !== 1) {
    return null
  }
  const fromLine = targetSourceLines[0]
  const toLine = continuationSourceLines[0]
  const fromVisibleRuns = fromLine.runs
    .map((run, runIndex) => ({ run, runIndex }))
    .filter(({ run }) => run.text.trim())
  const toVisibleRuns = toLine.runs
    .map((run, runIndex) => ({ run, runIndex }))
    .filter(({ run }) => run.text.trim())
  if (
    fromVisibleRuns.length === 0 ||
    toVisibleRuns.length === 0 ||
    fromVisibleRuns.some(({ run }) => run.sourceSequenceIndex === undefined) ||
    toVisibleRuns.some(({ run }) => run.sourceSequenceIndex === undefined)
  ) {
    return null
  }
  const maximumFromSequence = Math.max(
    ...fromVisibleRuns.map(({ run }) => run.sourceSequenceIndex!),
  )
  const minimumToSequence = Math.min(
    ...toVisibleRuns.map(({ run }) => run.sourceSequenceIndex!),
  )
  const fromCandidates = fromVisibleRuns.filter(
    ({ run }) => run.sourceSequenceIndex === maximumFromSequence,
  )
  const toCandidates = toVisibleRuns.filter(
    ({ run }) => run.sourceSequenceIndex === minimumToSequence,
  )
  if (fromCandidates.length !== 1 || toCandidates.length !== 1) return null
  const exactFragmentLineage = (
    line: PdfPageRegion['lines'][number],
    visibleRuns: Array<{ run: PdfSourceRun; runIndex: number }>,
  ) => {
    const lineage = line.sourceFragmentLineage
    const sourceSequenceIndexes = visibleRuns.map(
      ({ run }) => run.sourceSequenceIndex!,
    )
    return Boolean(
      lineage &&
      new Set(lineage.sourceSequenceIndexes).size ===
        lineage.sourceSequenceIndexes.length &&
      lineage.sourceSequenceIndexes.length === sourceSequenceIndexes.length &&
      lineage.sourceSequenceIndexes.every(
        (sequence, index) => sequence === sourceSequenceIndexes[index],
      ),
    )
  }
  if (
    !exactFragmentLineage(fromLine, fromVisibleRuns) ||
    !exactFragmentLineage(toLine, toVisibleRuns)
  ) {
    return null
  }
  const from = fromCandidates[0]
  const to = toCandidates[0]
  // Across a page break the two indexes belong to different per-page sequences,
  // so adjacency is proved by extremity instead: the tail is the last body item
  // its page paints and the head is the first body item the next page paints.
  const crossPageSourceAdjacency = Boolean(
    crossPage &&
    to.run.page === from.run.page + 1 &&
    bodySourceOrderExtremaByPage.get(from.run.page)?.last ===
      maximumFromSequence &&
    bodySourceOrderExtremaByPage.get(to.run.page)?.first === minimumToSequence,
  )
  const exactSourceAdjacency = crossPage
    ? crossPageSourceAdjacency
    : minimumToSequence === maximumFromSequence + 1 ||
      (to.run.sourceWhitespaceBefore === 'pdf-text-item' &&
        to.run.sourceWhitespacePredecessorIndex === maximumFromSequence)
  const fromFragmentId = pdfSourceFragmentId(fromLine)
  const toFragmentId = pdfSourceFragmentId(toLine)
  const fromMetrics = dominantSemanticFlowLineMetrics(fromLine)
  const toMetrics = dominantSemanticFlowLineMetrics(toLine)
  if (
    !exactSourceAdjacency ||
    !fromFragmentId ||
    !toFragmentId ||
    !fromMetrics ||
    !toMetrics ||
    (crossPage
      ? to.run.page !== from.run.page + 1
      : from.run.page !== to.run.page) ||
    from.run.rotation !== to.run.rotation ||
    from.run.method !== to.run.method ||
    (from.run.method !== 'pdf-text' && from.run.method !== 'ocr')
  ) {
    return null
  }
  const fontRatio =
    Math.max(fromMetrics.fontSize, toMetrics.fontSize) /
    Math.max(1, Math.min(fromMetrics.fontSize, toMetrics.fontSize))
  const baselineGap = Math.abs(fromMetrics.baseline - toMetrics.baseline)
  if (
    fontRatio > 1.5 ||
    (topology !== 'same-page-column' &&
      !crossPage &&
      baselineGap >
        Math.max(0.06, Math.max(fromMetrics.height, toMetrics.height) * 4))
  ) {
    return null
  }
  const exactStackedPunctuationTransition = Boolean(
    fromLine.sourceFragmentLineage?.fragment === 'inline-stacked-formula' &&
    toLine.sourceFragmentLineage?.fragment === 'inline-stacked-after' &&
    fromLine.sourceFragmentLineage.sourceLineId ===
      toLine.sourceFragmentLineage.sourceLineId &&
    /^[,.;:!?%)}\]]/u.test(continuation.text.trimStart()),
  )
  const noSpaceColumnFlowTransition =
    (topology === 'same-page-column' || crossPage) &&
    outcome === 'no-space' &&
    to.run.sourceWhitespaceBefore !== 'pdf-text-item'
  if (
    (outcome === 'no-space' &&
      !exactStackedPunctuationTransition &&
      !noSpaceColumnFlowTransition) ||
    (outcome === 'space' && exactStackedPunctuationTransition)
  ) {
    return null
  }
  const evidence = canonicalPdfSourceSemanticFlowEvidence(
    crossPage
      ? PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE
      : topology === 'same-page-column'
        ? PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE
        : exactStackedPunctuationTransition
          ? PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE
          : outcome === 'space' &&
              to.run.sourceWhitespaceBefore === 'pdf-text-item' &&
              to.run.sourceWhitespacePredecessorIndex === maximumFromSequence
            ? PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE
            : PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  )
  const decision: SourceSemanticFlowBoundaryCandidate = {
    page: from.run.page,
    rotation: from.run.rotation,
    method: from.run.method,
    topology,
    outcome,
    from: {
      regionId: targetTailSegment.region.id,
      lineId: fromLine.id,
      runIndex: from.runIndex,
      sourceSequenceIndex: maximumFromSequence,
      sourceRunSha256: pdfSourceSemanticFlowRunSha256(from.run),
      sourceFragmentId: fromFragmentId,
    },
    to: {
      regionId: continuationHeadSegment.region.id,
      lineId: toLine.id,
      runIndex: to.runIndex,
      sourceSequenceIndex: minimumToSequence,
      sourceRunSha256: pdfSourceSemanticFlowRunSha256(to.run),
      sourceFragmentId: toFragmentId,
    },
    evidence,
  }
  return decision
}

export function sourceSemanticFlowBoundaryDecision(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  outcome: PdfSourceSemanticFlowBoundaryDecision['outcome'],
  topology: PdfSourceSemanticFlowBoundaryDecision['topology'],
  bodySourceOrderExtremaByPage: ReadonlyMap<
    number,
    PdfBodySourceOrderExtremum
  > = new Map(),
): PdfSourceSemanticFlowBoundaryDecision | null {
  const decision = sourceSemanticFlowBoundaryCandidate(
    target,
    continuation,
    outcome,
    topology,
    bodySourceOrderExtremaByPage,
  )
  if (!decision) return null
  const canonicalDecision: Omit<PdfSourceSemanticFlowBoundaryDecision, 'id'> = {
    ...decision,
    topology,
    outcome,
  }
  return {
    id: pdfSourceSemanticFlowBoundaryDecisionId(canonicalDecision),
    ...canonicalDecision,
  }
}
