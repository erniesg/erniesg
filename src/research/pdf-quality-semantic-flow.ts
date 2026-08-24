import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageRegion,
  PdfSourceRun,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfVisualRelationship,
} from './import-types'
import {
  PDF_HYPHEN_LEXICAL_MODEL,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE,
  resolvePdfHyphenBoundary,
  type PdfHyphenBoundaryProof,
} from './pdf-hyphenation'
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
} from './pdf-regions'
import type { ResearchPaper } from './schema'
import type { SourceSemanticFlowBoundaryLedgerAudit } from './pdf-quality-text'

type SemanticFlowHelpers = {
  rtlBaseDirection: (
    language: string | null,
    baseDirection: ResearchPaper['baseDirection'] | null,
  ) => boolean
  sentenceEndWithClosing: RegExp
  sameSourceBox: (
    left: NormalizedSourceBox,
    right: NormalizedSourceBox,
  ) => boolean
  isPdfSourceSemanticFlowBoundaryDecision: (
    value: unknown,
  ) => value is PdfSourceSemanticFlowBoundaryDecision
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
  helpers: SemanticFlowHelpers,
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
    !helpers.sameSourceBox(relationship.sourceBoxes[0], formula.region.box)
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
    helpers.sameSourceBox(candidate.sourceBoxes[0], formula.region.box) &&
    candidate.evidence.includes('source-text-transcript-unresolved') &&
    candidate.evidence.includes('incomplete-equation-source-scope') &&
    candidate.evidence.includes('source-rendition-unavailable')
  )
}

function sourceProvesInlineStackedSemanticFlowTopology(
  {
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
  },
  helpers: SemanticFlowHelpers,
) {
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
      helpers,
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
  helpers: SemanticFlowHelpers,
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
    !helpers.isPdfSourceSemanticFlowBoundaryDecision(candidates[0])
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
        helpers,
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
        helpers,
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
      !sourceProvesInlineStackedSemanticFlowTopology(
        {
          from,
          to,
          allRegions,
          visualRelationships,
          lineBoundaryDecisions,
        },
        helpers,
      )
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
      helpers,
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
  helpers: SemanticFlowHelpers,
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
    !helpers.sentenceEndWithClosing.test(previousText) &&
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
  helpers: SemanticFlowHelpers,
) {
  const unmarkedContinuation = sourceProvenUnmarkedProseContinuation(
    leftRegion.text,
    rightRegion.text,
    helpers,
  )
  const rtl = helpers.rtlBaseDirection(language, baseDirection)
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
  helpers: SemanticFlowHelpers,
) {
  const rtl = helpers.rtlBaseDirection(language, baseDirection)
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

export function auditSourceSemanticFlowBoundaryLedger(
  {
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
  },
  helpers: SemanticFlowHelpers,
): SourceSemanticFlowBoundaryLedgerAudit {
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
    if (!helpers.isPdfSourceSemanticFlowBoundaryDecision(decision)) {
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
      helpers,
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
