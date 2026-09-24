import type {
  PdfCanonicalHyphenBoundaryDecision,
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
  ReconstructionDiagnostic,
} from './import-types'
import {
  appendBibliographyContinuation,
  bibliographyContinuationFormEvidence,
  detachedScholarlyReferenceContinuation,
  likelyUnmarkedCrossPageContinuation,
  provenBibliographyContinuation,
  recordUncertainBibliographyBoundary,
} from './pdf-continuation-evidence'
import {
  ambiguousParenthesizedRomanListMarker,
  blockSourceSegments,
  flowingParenthesizedDecimalEnumerationContinuation,
  flowingSentenceFinalMathVariableContinuation,
  flowingSuffixedDecimalEnumerationContinuation,
  orderedMarkerHasIndependentEvidence,
  parsedBibliographyListMarker,
  parsedBulletListMarker,
  parsedOrderedListMarker,
  stripBlockMarker,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import { appendBlockContinuation } from './pdf-paragraph-continuations'
import {
  PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE,
  yieldPdfReconstructionTask,
} from './pdf-region-block-recovery'

export async function assignPdfRegionBlockLists(
  blocks: PdfListRegionBlock[],
  bibliographyScopeRegionIds: ReadonlySet<string>,
  bibliographyRegionIds: ReadonlySet<string>,
  bodySize: number,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  canonicalHyphenBoundaryDecisions: PdfCanonicalHyphenBoundaryDecision[],
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[],
  diagnostics: ReconstructionDiagnostic[],
  citationLedRegionIds: ReadonlySet<string>,
  signal?: AbortSignal,
) {
  let activeList:
    | {
        page: number
        column: PdfPageRegion['column']
        baseX: number
        numberingId: string
        ordered: boolean
        markerStyle: NonNullable<PdfListRegionBlock['list']>['markerStyle']
        lastOrdinal?: number
      }
    | undefined
  let lastBibliographyEntryPage: number | undefined
  let pendingBibliographyContinuation:
    { target: PdfListRegionBlock; tailPage: number } | undefined
  let activeNumberedBibliographyEntry: PdfListRegionBlock | undefined
  let lastListBlock: PdfListRegionBlock | undefined
  const mergedContinuationBlocks = new Set<PdfListRegionBlock>()
  const listCounts = new Map<number, number>()
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    if (
      blockIndex > 0 &&
      blockIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      await yieldPdfReconstructionTask(signal)
    }
    const block = blocks[blockIndex]
    if (block.type !== 'paragraph') {
      lastBibliographyEntryPage = undefined
      pendingBibliographyContinuation = undefined
      activeNumberedBibliographyEntry = undefined
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    const bibliography = bibliographyScopeRegionIds.has(block.region.id)
    if (bibliography) {
      const entry = parsedBibliographyListMarker(block.text)
      const numberedContinuationTarget =
        activeNumberedBibliographyEntry ??
        pendingBibliographyContinuation?.target
      const continuationProof =
        !entry && numberedContinuationTarget
          ? provenBibliographyContinuation(numberedContinuationTarget, block)
          : null
      if (continuationProof === 'same-page' && numberedContinuationTarget) {
        appendBibliographyContinuation(
          numberedContinuationTarget,
          block,
          hardHyphenLexicon,
          unhyphenatedLexicon,
          language,
          canonicalHyphenBoundaryDecisions,
          sourceSemanticFlowBoundaryDecisions,
          'bibliography-hanging-indent',
        )
        mergedContinuationBlocks.add(block)
        lastBibliographyEntryPage = block.region.page
        if (pendingBibliographyContinuation) {
          pendingBibliographyContinuation.tailPage = block.region.page
        }
        activeList = undefined
        continue
      }
      if (
        continuationProof === 'adjacent-page' &&
        numberedContinuationTarget &&
        pendingBibliographyContinuation &&
        pendingBibliographyContinuation.target === numberedContinuationTarget
      ) {
        appendBibliographyContinuation(
          numberedContinuationTarget,
          block,
          hardHyphenLexicon,
          unhyphenatedLexicon,
          language,
          canonicalHyphenBoundaryDecisions,
          sourceSemanticFlowBoundaryDecisions,
          'bibliography-hanging-indent',
        )
        mergedContinuationBlocks.add(block)
        lastBibliographyEntryPage = block.region.page
        pendingBibliographyContinuation.tailPage = block.region.page
        activeList = undefined
        continue
      }
      if (
        !entry &&
        numberedContinuationTarget &&
        !continuationProof &&
        bibliographyContinuationFormEvidence(numberedContinuationTarget, block)
      ) {
        recordUncertainBibliographyBoundary(
          diagnostics,
          numberedContinuationTarget,
          block,
        )
      }
      pendingBibliographyContinuation = undefined
      if (entry) stripBlockMarker(block, entry)
      const continuedFromPreviousPage =
        lastBibliographyEntryPage !== undefined &&
        block.region.page > lastBibliographyEntryPage
      block.list = {
        level: 1,
        ordered: Boolean(entry),
        numberingId: 'references',
        markerStyle: entry?.markerStyle ?? 'disc',
        ...(entry
          ? { ordinal: entry.ordinal, markerText: entry.markerText }
          : {}),
        ...(continuedFromPreviousPage
          ? { continuedFromPreviousPage: true }
          : block.bibliographyContinuedFromPreviousPage
            ? { continuedFromPreviousPage: true }
            : {}),
      }
      lastBibliographyEntryPage = block.region.page
      if (entry) {
        pendingBibliographyContinuation = {
          target: block,
          tailPage: block.region.page,
        }
        activeNumberedBibliographyEntry = block
      } else {
        activeNumberedBibliographyEntry = undefined
      }
      activeList = undefined
      lastListBlock = entry ? block : undefined
      continue
    }
    lastBibliographyEntryPage = undefined
    pendingBibliographyContinuation = undefined
    activeNumberedBibliographyEntry = undefined
    let ordered = parsedOrderedListMarker(block.text)
    const precedingBlock = blocks[blockIndex - 1]
    if (
      flowingParenthesizedDecimalEnumerationContinuation(
        precedingBlock,
        block,
        ordered,
      ) ||
      flowingSuffixedDecimalEnumerationContinuation(
        precedingBlock,
        block,
        ordered,
      ) ||
      flowingSentenceFinalMathVariableContinuation(
        precedingBlock,
        block,
        ordered,
      )
    ) {
      appendBlockContinuation(
        precedingBlock!,
        block,
        undefined,
        null,
        sourceSemanticFlowBoundaryDecisions,
        'aligned-enumeration',
      )
      mergedContinuationBlocks.add(block)
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    if (
      ordered &&
      /^\[\s*\d+\s*\]$/u.test(ordered.markerText) &&
      citationLedRegionIds.has(block.region.id)
    ) {
      ordered = null
    }
    if (
      ordered &&
      precedingBlock?.type === 'paragraph' &&
      detachedScholarlyReferenceContinuation(precedingBlock.text, block.text)
    ) {
      appendBlockContinuation(
        precedingBlock,
        block,
        undefined,
        null,
        sourceSemanticFlowBoundaryDecisions,
      )
      mergedContinuationBlocks.add(block)
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    if (
      ordered &&
      !orderedMarkerHasIndependentEvidence(
        blockIndex,
        blocks,
        ordered,
        bodySize,
      )
    ) {
      ordered = null
    }
    if (!activeList && ambiguousParenthesizedRomanListMarker(ordered)) {
      const nextBlock = blocks[blockIndex + 1]
      const nextMarker =
        nextBlock?.type === 'paragraph' &&
        !bibliographyRegionIds.has(nextBlock.region.id)
          ? parsedOrderedListMarker(nextBlock.text)
          : null
      const sourceBackedSequence = Boolean(
        nextMarker &&
        ambiguousParenthesizedRomanListMarker(nextMarker) &&
        nextMarker.ordinal === ordered!.ordinal + 1 &&
        (nextBlock.region.page !== block.region.page ||
          nextBlock.region.column === block.region.column),
      )
      if (!sourceBackedSequence) ordered = null
    }
    let bullet = parsedBulletListMarker(block.text)
    if (bullet && !activeList && /^[–—-]$/u.test(bullet.markerText)) {
      const nextBlock = blocks[blockIndex + 1]
      const nextBullet =
        nextBlock?.type === 'paragraph'
          ? parsedBulletListMarker(nextBlock.text)
          : null
      const sourceBackedSequence = Boolean(
        nextBullet &&
        nextBlock?.region.column === block.region.column &&
        (nextBlock.region.page === block.region.page ||
          nextBlock.region.page === block.region.page + 1),
      )
      const introducedIndentedItem = Boolean(
        precedingBlock?.type === 'paragraph' &&
        /:\s*$/u.test(precedingBlock.text) &&
        block.region.box.x > precedingBlock.region.box.x + 0.012,
      )
      if (!sourceBackedSequence && !introducedIndentedItem) bullet = null
    }
    const marker = ordered
    const itemText = ordered?.itemText ?? bullet?.itemText
    if (!itemText) {
      const continuationStartBox =
        block.region.lines[0]?.box ?? block.region.box
      const targetTailSegment = lastListBlock
        ? blockSourceSegments(lastListBlock).at(-1)
        : undefined
      const targetTailRegion =
        targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
      const samePageVerticalGap = targetTailRegion
        ? continuationStartBox.y -
          (targetTailRegion.box.y + targetTailRegion.box.height)
        : Number.POSITIVE_INFINITY
      const samePageIndentedContinuation = Boolean(
        activeList &&
        block.region.page === activeList.page &&
        block.region.column === activeList.column &&
        continuationStartBox.x > activeList.baseX + 0.012 &&
        samePageVerticalGap >= -0.004 &&
        samePageVerticalGap <= 0.03,
      )
      const crossPageContinuation = Boolean(
        activeList &&
        block.region.page > activeList.page &&
        block.region.box.x >= activeList.baseX - 0.012,
      )
      const nextListBlock = blocks[blockIndex + 1]
      const nextOrderedMarker =
        nextListBlock?.type === 'paragraph' &&
        !bibliographyScopeRegionIds.has(nextListBlock.region.id)
          ? parsedOrderedListMarker(nextListBlock.text)
          : null
      const targetTailLine = targetTailRegion?.lines.at(-1)
      const continuationHeadLine = block.region.lines[0]
      const continuationFontRatio =
        targetTailLine && continuationHeadLine
          ? Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
            Math.max(
              1,
              Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
            )
          : Number.POSITIVE_INFINITY
      const samePageFlushContinuationBeforeNextMarker = Boolean(
        activeList &&
        lastListBlock &&
        activeList.ordered &&
        activeList.lastOrdinal !== undefined &&
        nextOrderedMarker &&
        nextOrderedMarker.markerStyle === activeList.markerStyle &&
        nextOrderedMarker.ordinal === activeList.lastOrdinal + 1 &&
        nextListBlock?.region.page === block.region.page &&
        nextListBlock.region.column === block.region.column &&
        block.region.page === activeList.page &&
        block.region.column === activeList.column &&
        Math.abs(continuationStartBox.x - activeList.baseX) <= 0.012 &&
        samePageVerticalGap >= -0.004 &&
        samePageVerticalGap <= 0.03 &&
        continuationFontRatio <= 1.12,
      )
      if (
        activeList &&
        lastListBlock &&
        (samePageIndentedContinuation ||
          samePageFlushContinuationBeforeNextMarker ||
          crossPageContinuation) &&
        likelyUnmarkedCrossPageContinuation(lastListBlock, block)
      ) {
        appendBlockContinuation(
          lastListBlock,
          block,
          undefined,
          null,
          sourceSemanticFlowBoundaryDecisions,
        )
        mergedContinuationBlocks.add(block)
        activeList.page = block.region.page
        activeList.column = block.region.column
        continue
      }
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    const continuesAcrossPage = Boolean(
      activeList &&
      activeList.page !== block.region.page &&
      activeList.ordered &&
      marker &&
      activeList.markerStyle === marker.markerStyle &&
      activeList.lastOrdinal !== undefined &&
      marker.ordinal > activeList.lastOrdinal,
    )
    const isNestedItem = Boolean(
      activeList &&
      activeList.page === block.region.page &&
      activeList.column === block.region.column &&
      block.region.box.x > activeList.baseX + 0.012,
    )
    const continuesCurrentList = Boolean(
      activeList &&
      (isNestedItem ||
        ((activeList.page === block.region.page || continuesAcrossPage) &&
          (activeList.page !== block.region.page ||
            activeList.column === block.region.column) &&
          activeList.ordered === Boolean(ordered) &&
          activeList.markerStyle === (marker?.markerStyle ?? 'disc') &&
          (!marker ||
            activeList.lastOrdinal === undefined ||
            marker.ordinal > activeList.lastOrdinal))),
    )
    if (!continuesCurrentList) {
      const sequence = (listCounts.get(block.region.page) ?? 0) + 1
      listCounts.set(block.region.page, sequence)
      activeList = {
        page: block.region.page,
        column: block.region.column,
        baseX: block.region.box.x,
        numberingId: `pdf-list-p${String(block.region.page).padStart(3, '0')}-${String(sequence).padStart(3, '0')}`,
        ordered: Boolean(ordered),
        markerStyle: marker?.markerStyle ?? 'disc',
        lastOrdinal: marker?.ordinal,
      }
    } else if (activeList && !isNestedItem) {
      activeList.page = block.region.page
      activeList.column = block.region.column
      activeList.lastOrdinal = marker?.ordinal
    }
    const list = activeList
    if (!list) continue
    const indentation = Math.max(0, block.region.box.x - list.baseX)
    stripBlockMarker(block, ordered ?? bullet!)
    block.list = {
      level: Math.min(9, Math.max(1, Math.round(indentation / 0.025) + 1)),
      ordered: Boolean(ordered),
      numberingId: list.numberingId,
      markerStyle: marker?.markerStyle ?? 'disc',
      ...(marker ? { ordinal: marker.ordinal } : {}),
      ...(ordered
        ? { markerText: ordered.markerText }
        : bullet
          ? { markerText: bullet.markerText }
          : {}),
      ...(continuesAcrossPage ? { continuedFromPreviousPage: true } : {}),
    }
    lastListBlock = block
  }
  return blocks.filter((block) => !mergedContinuationBlocks.has(block))
}
