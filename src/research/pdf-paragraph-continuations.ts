import type {
  PdfLineBoundaryDecision,
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfVisualRelationship,
} from './import-types'
import { sameSourceBox } from './pdf-canonical-node-composition'
import {
  blockSourceSegments,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import { resolveRegisteredPdfLinkedTokenContinuity } from './pdf-links'
import { sourceSemanticFlowHyphenVerdict } from './pdf-quality'
import type { PdfBodySourceOrderExtremum } from './pdf-regions'
import {
  canonicalHyphenDeletionDecision,
  sourceSemanticFlowBoundaryDecision,
  type CanonicalHyphenDeletionRequest,
  type SourceSemanticFlowBoundaryCandidate,
} from './pdf-semantic-flow-boundaries'

export function appendBlockContinuation(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  requestedSeparator = target.text ? ' ' : '',
  hyphenDeletion: CanonicalHyphenDeletionRequest | null = null,
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] = [],
  requestedTopology:
    SourceSemanticFlowBoundaryCandidate['topology'] | null = null,
  bodySourceOrderExtremaByPage: ReadonlyMap<
    number,
    PdfBodySourceOrderExtremum
  > = new Map(),
  requiredSemanticFlowDecision: PdfSourceSemanticFlowBoundaryDecision | null = null,
) {
  const targetTailLine = blockSourceSegments(target).at(-1)?.region.lines.at(-1)
  const continuationHeadLine =
    blockSourceSegments(continuation)[0]?.region.lines[0]
  const linkedTokenContinuities =
    targetTailLine && continuationHeadLine
      ? resolveRegisteredPdfLinkedTokenContinuity([
          targetTailLine,
          continuationHeadLine,
        ])
      : []
  const linkedTargetPrefix =
    linkedTokenContinuities.length === 1 &&
    linkedTokenContinuities[0].status === 'unresolved' &&
    linkedTokenContinuities[0].reason === 'url-round-trip-failed' &&
    linkedTokenContinuities[0].visibleText.startsWith(
      linkedTokenContinuities[0].target,
    ) &&
    /^[,.;:!?)}\]\s]/u.test(
      linkedTokenContinuities[0].visibleText.slice(
        linkedTokenContinuities[0].target.length,
      ),
    )
  const separator =
    (linkedTokenContinuities.length === 1 &&
      linkedTokenContinuities[0].status === 'matched') ||
    linkedTargetPrefix
      ? ''
      : requestedSeparator
  const targetSegments = blockSourceSegments(target).map((segment) => ({
    ...segment,
  }))
  let targetText = target.text
  const deletionDecision = canonicalHyphenDeletionDecision(
    target,
    continuation,
    targetSegments,
    hyphenDeletion,
  )
  const deletionDecisionIsUnique =
    deletionDecision !== null &&
    hyphenDeletion !== null &&
    !hyphenDeletion.decisions.some(
      (decision) =>
        decision.id === deletionDecision.id ||
        (decision.fromRegionId === deletionDecision.fromRegionId &&
          decision.fromLineId === deletionDecision.fromLineId &&
          decision.toRegionId === deletionDecision.toRegionId &&
          decision.toLineId === deletionDecision.toLineId),
    )
  const semanticHyphenVerdict = hyphenDeletion
    ? sourceSemanticFlowHyphenVerdict(hyphenDeletion.proof)
    : 'unresolved'
  const semanticDeletionDecision =
    deletionDecision === null &&
    requestedTopology !== 'cross-page-column' &&
    hyphenDeletion?.proof.sourceBoundaryProven === true &&
    semanticHyphenVerdict === 'remove'
      ? sourceSemanticFlowBoundaryDecision(
          target,
          continuation,
          'discretionary-hyphen-delete',
          'lexical-hyphen',
        )
      : null
  const semanticDeletionDecisionIsUnique =
    semanticDeletionDecision !== null &&
    !sourceSemanticFlowBoundaryDecisions.some(
      (decision) =>
        decision.id === semanticDeletionDecision.id ||
        (decision.from.regionId === semanticDeletionDecision.from.regionId &&
          decision.from.lineId === semanticDeletionDecision.from.lineId &&
          decision.to.regionId === semanticDeletionDecision.to.regionId &&
          decision.to.lineId === semanticDeletionDecision.to.lineId),
    )
  const deletionApplied =
    (deletionDecision !== null && deletionDecisionIsUnique) ||
    (semanticDeletionDecision !== null &&
      semanticDeletionDecisionIsUnique &&
      semanticHyphenVerdict === 'remove')
  if (deletionApplied) {
    targetText = targetText.slice(0, -1)
    const tail = targetSegments.at(-1)!
    tail.text = tail.text.slice(0, -1)
  }
  const semanticFlowOutcome: SourceSemanticFlowBoundaryCandidate['outcome'] =
    deletionApplied
      ? 'discretionary-hyphen-delete'
      : separator === ' '
        ? 'space'
        : /[-‐‑]$/u.test(targetText.trimEnd())
          ? semanticHyphenVerdict === 'preserve'
            ? 'hard-hyphen-retain'
            : 'unresolved'
          : 'no-space'
  const targetLineage = targetTailLine?.sourceFragmentLineage
  const continuationLineage = continuationHeadLine?.sourceFragmentLineage
  const inferredTopology:
    SourceSemanticFlowBoundaryCandidate['topology'] | null =
    requestedTopology === 'cross-page-column'
      ? 'cross-page-column'
      : semanticFlowOutcome === 'discretionary-hyphen-delete' ||
          semanticFlowOutcome === 'hard-hyphen-retain'
        ? 'lexical-hyphen'
        : targetLineage &&
            continuationLineage &&
            targetLineage.sourceLineId === continuationLineage.sourceLineId &&
            (targetLineage.fragment.startsWith('inline-stacked-') ||
              continuationLineage.fragment.startsWith('inline-stacked-'))
          ? 'inline-stacked-fragment'
          : target.region.column === 'right' &&
              continuation.region.column === 'span' &&
              targetLineage?.fragment === 'cross-gutter-right'
            ? 'cross-gutter-to-span'
            : requestedTopology
  const recordableTopology =
    inferredTopology === 'inline-stacked-fragment' ||
    inferredTopology === 'lexical-hyphen' ||
    inferredTopology === 'same-page-column' ||
    inferredTopology === 'cross-page-column'
      ? inferredTopology
      : null
  const derivedSemanticFlowDecision =
    semanticDeletionDecision ??
    (recordableTopology &&
    semanticFlowOutcome !== 'unresolved' &&
    (recordableTopology === 'same-page-column' ||
    recordableTopology === 'cross-page-column'
      ? recordableTopology === 'cross-page-column' ||
        semanticFlowOutcome === 'space' ||
        semanticFlowOutcome === 'no-space'
      : semanticFlowOutcome !== 'space'
        ? recordableTopology === 'inline-stacked-fragment' ||
          recordableTopology === 'lexical-hyphen'
        : false)
      ? sourceSemanticFlowBoundaryDecision(
          target,
          continuation,
          semanticFlowOutcome,
          recordableTopology,
          bodySourceOrderExtremaByPage,
        )
      : null)
  const requiredBoundaryAlreadyExists =
    requiredSemanticFlowDecision !== null &&
    sourceSemanticFlowBoundaryDecisions.some(
      (decision) =>
        decision.from.regionId === requiredSemanticFlowDecision.from.regionId &&
        decision.from.lineId === requiredSemanticFlowDecision.from.lineId &&
        decision.to.regionId === requiredSemanticFlowDecision.to.regionId &&
        decision.to.lineId === requiredSemanticFlowDecision.to.lineId,
    )
  if (
    requiredSemanticFlowDecision !== null &&
    (derivedSemanticFlowDecision?.id !== requiredSemanticFlowDecision.id ||
      requiredBoundaryAlreadyExists)
  ) {
    return false
  }
  const semanticFlowDecision =
    requiredSemanticFlowDecision ?? derivedSemanticFlowDecision
  if (deletionApplied && deletionDecision) {
    hyphenDeletion!.decisions.push(deletionDecision)
  }
  if (
    semanticFlowDecision &&
    !sourceSemanticFlowBoundaryDecisions.some(
      (decision) =>
        decision.id === semanticFlowDecision.id ||
        (decision.from.regionId === semanticFlowDecision.from.regionId &&
          decision.from.lineId === semanticFlowDecision.from.lineId &&
          decision.to.regionId === semanticFlowDecision.to.regionId &&
          decision.to.lineId === semanticFlowDecision.to.lineId),
    )
  ) {
    sourceSemanticFlowBoundaryDecisions.push(semanticFlowDecision)
  }
  const previousMaximumPage = Math.max(
    ...targetSegments.map((segment) => segment.region.page),
  )
  const canonicalStart = targetText.length + separator.length
  target.sourceSegments = [
    ...targetSegments,
    ...blockSourceSegments(continuation).map((segment) => ({
      ...segment,
      canonicalStart: canonicalStart + segment.canonicalStart,
    })),
  ]
  target.text = `${targetText}${separator}${continuation.text}`
  target.confidence = Math.min(target.confidence, continuation.confidence)
  if (target.list && continuation.region.page > previousMaximumPage) {
    target.list.continuedFromPreviousPage = true
  }
  return true
}

type InlineStackedParagraphFragment = {
  baseId: string
  part: 'before' | 'formula' | 'after'
  line: PdfPageRegion['lines'][number]
}

function inlineStackedParagraphFragments(block: PdfListRegionBlock) {
  return block.region.lines.flatMap<InlineStackedParagraphFragment>((line) => {
    const match = line.id?.match(
      /^(.*-inline-stacked-\d+)-(before|formula|after)$/u,
    )
    return match
      ? [
          {
            baseId: match[1],
            part: match[2] as InlineStackedParagraphFragment['part'],
            line,
          },
        ]
      : []
  })
}

function exactInlineStackedParagraphFragment(
  block: PdfListRegionBlock,
): InlineStackedParagraphFragment | null {
  const fragments = inlineStackedParagraphFragments(block)
  return fragments.length === 1 ? fragments[0] : null
}

function sourceProvesInlineStackedBoundary(
  left: InlineStackedParagraphFragment,
  right: InlineStackedParagraphFragment,
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

function sourceProvesInlineStackedBlockScope(
  block: PdfListRegionBlock,
  fragment: InlineStackedParagraphFragment,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const nonblankLines = block.region.lines.filter((line) => line.text.trim())
  if (fragment.part !== 'after') {
    return nonblankLines.length === 1 && nonblankLines[0] === fragment.line
  }
  if (nonblankLines[0] !== fragment.line) return false
  for (let index = 1; index < nonblankLines.length; index += 1) {
    const previous = nonblankLines[index - 1]
    const current = nonblankLines[index]
    const decisions = lineBoundaryDecisions.filter(
      (decision) =>
        decision.regionId === block.region.id &&
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

function visualRelationshipTouchesInlineFormula(
  relationship: PdfVisualRelationship,
  formulaRegionId: string,
  formulaLineId: string,
) {
  return (
    relationship.sourceRegionIds.includes(formulaRegionId) ||
    relationship.sourceLineIds?.includes(formulaLineId) === true ||
    relationship.candidates.some(
      (candidate) =>
        candidate.sourceRegionIds.includes(formulaRegionId) ||
        candidate.sourceLineIds?.includes(formulaLineId) === true,
    )
  )
}

function provesUnresolvedInlineFormulaRelationship(
  relationship: PdfVisualRelationship,
  beforeRegionId: string,
  formulaBlock: PdfListRegionBlock,
  formulaLineId: string,
  afterRegionId: string,
) {
  if (
    relationship.kind !== 'equation' ||
    relationship.status !== 'unresolved' ||
    !relationship.evidence.includes('source-text-transcript-unresolved') ||
    relationship.captionRegionId !== formulaBlock.region.id
  ) {
    return false
  }
  const directSource =
    relationship.sourceRegionIds.includes(formulaBlock.region.id) &&
    !relationship.sourceRegionIds.includes(beforeRegionId) &&
    !relationship.sourceRegionIds.includes(afterRegionId) &&
    relationship.sourceLineIds?.filter((lineId) => lineId === formulaLineId)
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
    !sameSourceBox(relationship.sourceBoxes[0], formulaBlock.region.box)
  ) {
    return false
  }
  const candidate = relationship.candidates[0]
  return (
    candidate.sourceRegionIds.length === 1 &&
    candidate.sourceRegionIds[0] === formulaBlock.region.id &&
    (candidate.sourceLineIds === undefined ||
      (candidate.sourceLineIds.length === 1 &&
        candidate.sourceLineIds[0] === formulaLineId)) &&
    candidate.sourceObjectIds.length === 1 &&
    candidate.assetIds.length === 0 &&
    candidate.sourceBoxes.length === 1 &&
    sameSourceBox(candidate.sourceBoxes[0], formulaBlock.region.box) &&
    candidate.evidence.includes('source-text-transcript-unresolved') &&
    candidate.evidence.includes('incomplete-equation-source-scope') &&
    candidate.evidence.includes('source-rendition-unavailable')
  )
}

export function coalesceProvedInlineStackedParagraphs(
  blocks: PdfListRegionBlock[],
  relationships: readonly PdfVisualRelationship[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[],
) {
  const fragments = blocks.map(exactInlineStackedParagraphFragment)
  const occurrencesByBaseId = new Map<
    string,
    Array<{ index: number; fragment: InlineStackedParagraphFragment }>
  >()
  for (const [index, block] of blocks.entries()) {
    for (const fragment of inlineStackedParagraphFragments(block)) {
      const occurrences = occurrencesByBaseId.get(fragment.baseId) ?? []
      occurrences.push({ index, fragment })
      occurrencesByBaseId.set(fragment.baseId, occurrences)
    }
  }

  for (let index = 0; index <= blocks.length - 3;) {
    const candidateBlocks = blocks.slice(index, index + 3)
    const candidateFragments = candidateBlocks.map(
      exactInlineStackedParagraphFragment,
    )
    const before = candidateFragments[0]
    const formula = candidateFragments[1]
    const after = candidateFragments[2]
    if (
      candidateBlocks.some(
        (block) => block.type !== 'paragraph' || block.list !== undefined,
      ) ||
      !before ||
      !formula ||
      !after ||
      before.part !== 'before' ||
      formula.part !== 'formula' ||
      after.part !== 'after' ||
      before.baseId !== formula.baseId ||
      formula.baseId !== after.baseId ||
      (occurrencesByBaseId.get(formula.baseId)?.length ?? 0) !== 3 ||
      new Set(candidateBlocks.map((block) => block.region.id)).size !== 3 ||
      new Set(candidateBlocks.map((block) => block.region.page)).size !== 1 ||
      new Set(
        candidateBlocks.map(
          (block) =>
            block.region.kind === 'footnote' || block.region.kind === 'endnote',
        ),
      ).size !== 1 ||
      !/\p{L}{2,}/u.test(candidateBlocks[0].text) ||
      !/^[,.;:!?)}\]]/u.test(candidateBlocks[2].text.trimStart()) ||
      !/\p{L}{2,}/u.test(candidateBlocks[2].text) ||
      !sourceProvesInlineStackedBlockScope(
        candidateBlocks[0],
        before,
        lineBoundaryDecisions,
      ) ||
      !sourceProvesInlineStackedBlockScope(
        candidateBlocks[1],
        formula,
        lineBoundaryDecisions,
      ) ||
      !sourceProvesInlineStackedBlockScope(
        candidateBlocks[2],
        after,
        lineBoundaryDecisions,
      ) ||
      !sourceProvesInlineStackedBoundary(before, formula) ||
      !sourceProvesInlineStackedBoundary(formula, after)
    ) {
      index += 1
      continue
    }
    const participatingRelationships = relationships.filter(
      (relationship) =>
        relationship.kind === 'equation' &&
        visualRelationshipTouchesInlineFormula(
          relationship,
          candidateBlocks[1].region.id,
          formula.line.id,
        ),
    )
    const relationshipCandidates = participatingRelationships.filter(
      (relationship) =>
        provesUnresolvedInlineFormulaRelationship(
          relationship,
          candidateBlocks[0].region.id,
          candidateBlocks[1],
          formula.line.id,
          candidateBlocks[2].region.id,
        ),
    )
    if (
      participatingRelationships.length !== 1 ||
      relationshipCandidates.length !== 1
    ) {
      index += 1
      continue
    }

    appendBlockContinuation(
      candidateBlocks[0],
      candidateBlocks[1],
      ' ',
      null,
      sourceSemanticFlowBoundaryDecisions,
    )
    appendBlockContinuation(
      candidateBlocks[0],
      candidateBlocks[2],
      '',
      null,
      sourceSemanticFlowBoundaryDecisions,
    )
    blocks.splice(index + 1, 2)
    fragments.splice(index + 1, 2)
    index += 1
  }
}
