import type { ResearchPaper } from './schema'
import type {
  PdfPageRegion,
  PdfSourceRun,
  ReconstructionDiagnostic,
} from './import-types'
import {
  detachedCitationYearContinuation,
  hasOmittedSourceBetweenBlocks,
  likelyUnmarkedCrossPageContinuation,
} from './pdf-continuation-evidence'
import { resolvePdfHyphenBoundary } from './pdf-hyphenation'
import {
  blockSourceSegments,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import { rtlLanguage } from './pdf-publication-metadata'
import { sourceSemanticFlowHyphenVerdict } from './pdf-quality'
import {
  type PdfBodySourceOrderExtremum,
  pdfSourceColumnFlowJoinOutcome,
} from './pdf-regions'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  dominantSemanticFlowLineMetrics,
  sourceSemanticFlowBoundaryCandidate,
} from './pdf-semantic-flow-boundaries'

export function sourceProvenSamePageColumnFloatBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  interveningCaptions: readonly PdfListRegionBlock[],
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== 'left' ||
    continuationHeadSegment.region.column !== 'right' ||
    targetTailLine.box.y + targetTailLine.box.height < 0.65 ||
    targetTailLine.box.x >= continuationHeadLine.box.x ||
    targetTailLine.box.x + targetTailLine.box.width >
      continuationHeadLine.box.x + 0.01
  ) {
    return false
  }
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  if (fontRatio > 1.12) return false
  return interveningCaptions.some((caption) => {
    const captionBottom = caption.region.box.y + caption.region.box.height
    const captionCenterX = caption.region.box.x + caption.region.box.width / 2
    return (
      caption.region.page === targetTailSegment.region.page &&
      captionCenterX >= 0.5 &&
      captionBottom <= continuationHeadLine.box.y + 0.004 &&
      continuationHeadLine.box.y - captionBottom <= 0.12
    )
  })
}

export function sourceProvenSamePageFloatTailBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  interveningCaptions: readonly PdfListRegionBlock[],
) {
  const targetSegments = blockSourceSegments(target)
  const targetTailSegment = targetSegments.at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    new Set(targetSegments.map((segment) => segment.region.page)).size < 2 ||
    targetTailSegment.region.column !== continuationHeadSegment.region.column
  ) {
    return false
  }
  const verticalGap =
    continuationHeadLine.box.y -
    (targetTailLine.box.y + targetTailLine.box.height)
  if (
    verticalGap < -0.004 ||
    verticalGap > 0.035 ||
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) > 0.04
  ) {
    return false
  }
  const firstCurrentPageLineY = Math.min(
    ...targetSegments
      .filter(
        (segment) => segment.region.page === targetTailSegment.region.page,
      )
      .flatMap((segment) => segment.region.lines.map((line) => line.box.y)),
  )
  return interveningCaptions.some(
    (caption) =>
      caption.region.page === targetTailSegment.region.page &&
      caption.region.box.y + caption.region.box.height <=
        firstCurrentPageLineY + 0.004,
  )
}

export function sourceProvenSamePageVerticalFloatBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  interveningCaptions: readonly PdfListRegionBlock[],
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page
  ) {
    return false
  }
  const targetColumn = targetTailSegment.region.column
  const continuationColumn = continuationHeadSegment.region.column
  const compatibleColumnFlow =
    targetColumn === continuationColumn ||
    ((targetColumn === 'single' || targetColumn === 'span') &&
      (continuationColumn === 'single' || continuationColumn === 'span'))
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  if (
    !compatibleColumnFlow ||
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) > 0.06 ||
    fontRatio > 1.12 ||
    hasOmittedSourceBetweenBlocks(target, continuation)
  ) {
    return false
  }
  const targetBottom = targetTailLine.box.y + targetTailLine.box.height
  const continuationTop = continuationHeadLine.box.y
  return interveningCaptions.some(
    (caption) =>
      caption.region.page === targetTailSegment.region.page &&
      targetBottom <= caption.region.box.y + 0.004 &&
      caption.region.box.y + caption.region.box.height <=
        continuationTop + 0.004,
  )
}

export type CaptionBoundedTableInterruption = {
  caption: PdfListRegionBlock
  continuationIndex: number
  scopeBlocks: PdfListRegionBlock[]
}

function compatibleFloatScopeColumn(
  left: PdfPageRegion['column'],
  right: PdfPageRegion['column'],
) {
  return (
    left === right ||
    ((left === 'single' || left === 'span') &&
      (right === 'single' || right === 'span'))
  )
}

export function captionBoundedTableInterruption(
  blocks: readonly PdfListRegionBlock[],
  targetIndex: number,
): CaptionBoundedTableInterruption | null {
  const target = blocks[targetIndex]
  if (target?.type !== 'paragraph' || target.list) return null
  const scopeBlocks: PdfListRegionBlock[] = []
  let captionIndex = -1
  const maximumScopeEnd = Math.min(blocks.length, targetIndex + 97)
  for (
    let candidateIndex = targetIndex + 1;
    candidateIndex < maximumScopeEnd;
    candidateIndex += 1
  ) {
    const candidate = blocks[candidateIndex]
    if (candidate.type === 'heading') return null
    if (candidate.type === 'caption') {
      const label = parsePdfScholarlyVisualLabel(candidate.text, {
        context: 'caption',
      })
      if (label?.kind !== 'table') return null
      captionIndex = candidateIndex
      break
    }
    if (candidate.type !== 'paragraph' && candidate.type !== 'footnote') {
      return null
    }
    scopeBlocks.push(candidate)
  }
  if (captionIndex < 0 || scopeBlocks.length === 0) return null

  let continuationIndex = captionIndex + 1
  while (
    continuationIndex < blocks.length &&
    blocks[continuationIndex].type === 'footnote'
  ) {
    continuationIndex += 1
  }
  const caption = blocks[captionIndex]
  const continuation = blocks[continuationIndex]
  if (
    continuation?.type !== 'paragraph' ||
    continuation.list ||
    target.region.page !== caption.region.page ||
    continuation.region.page !== caption.region.page ||
    !likelyUnmarkedCrossPageContinuation(target, continuation)
  ) {
    return null
  }

  const captionColumn = caption.region.column
  const scopeRegions = scopeBlocks.map((block) => block.region)
  const firstScopeTop = Math.min(...scopeRegions.map((region) => region.box.y))
  const captionTop = caption.region.box.y
  const captionBottom = captionTop + caption.region.box.height
  const continuationTop =
    continuation.region.lines[0]?.box.y ?? continuation.region.box.y
  const physicallyBounded =
    firstScopeTop <= 0.35 &&
    scopeRegions.every(
      (region) =>
        region.page === caption.region.page &&
        compatibleFloatScopeColumn(region.column, captionColumn) &&
        region.box.y + region.box.height <= captionTop + 0.02,
    ) &&
    continuationTop >= captionBottom - 0.004
  if (!physicallyBounded) return null
  return {
    caption,
    continuationIndex,
    scopeBlocks: [...scopeBlocks, caption],
  }
}

const AMBIGUOUS_CAPTION_BOUNDED_TABLE_MESSAGE =
  'A plausible caption-bounded table interrupts two prose fragments, but no source-proven nearby sentence boundary establishes a safe canonical placement.'

export function recordAmbiguousCaptionBoundedTable(
  diagnostics: ReconstructionDiagnostic[],
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  interruption: CaptionBoundedTableInterruption,
) {
  const regionIds = [
    target.region.id,
    ...interruption.scopeBlocks.map((block) => block.region.id),
    continuation.region.id,
  ]
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'AMBIGUOUS_READING_ORDER' &&
        diagnostic.message === AMBIGUOUS_CAPTION_BOUNDED_TABLE_MESSAGE &&
        diagnostic.target?.regionIds.some((regionId) =>
          regionIds.includes(regionId),
        ),
    )
  ) {
    return
  }
  diagnostics.push({
    code: 'AMBIGUOUS_READING_ORDER',
    severity: 'error',
    page: interruption.caption.region.page,
    message: AMBIGUOUS_CAPTION_BOUNDED_TABLE_MESSAGE,
    sourceBoxes: [
      target.region.box,
      ...interruption.scopeBlocks.map((block) => block.region.box),
      continuation.region.box,
    ],
    target: {
      regionIds: [...new Set(regionIds)],
      markerId: null,
    },
  })
}

export function sourceProvenRunFragmentToSpanBoundary(
  targetRegion: PdfPageRegion,
  continuationRegion: PdfPageRegion,
) {
  const targetLine = targetRegion.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationLine = continuationRegion.lines.find((line) =>
    line.text.trim(),
  )
  if (
    !targetLine ||
    !continuationLine ||
    targetRegion.page !== continuationRegion.page ||
    targetRegion.column !== 'right' ||
    continuationRegion.column !== 'span' ||
    targetLine.sourceFragmentLineage?.fragment !== 'cross-gutter-right' ||
    continuationLine.sourceFragmentLineage === undefined
  ) {
    return false
  }
  const verticalGap =
    continuationLine.box.y - (targetLine.box.y + targetLine.box.height)
  if (
    verticalGap < -0.006 ||
    verticalGap >
      Math.max(
        0.035,
        Math.max(targetLine.box.height, continuationLine.box.height) * 2.5,
      )
  ) {
    return false
  }
  const target: PdfListRegionBlock = {
    type: 'paragraph',
    region: targetRegion,
    text: targetRegion.text,
    confidence: targetRegion.confidence,
  }
  const continuation: PdfListRegionBlock = {
    type: 'paragraph',
    region: continuationRegion,
    text: continuationRegion.text,
    confidence: continuationRegion.confidence,
  }
  return (
    sourceSemanticFlowBoundaryCandidate(
      target,
      continuation,
      'space',
      'cross-gutter-to-span',
    ) !== null
  )
}

export function sourceColumnFlowJoin(
  continuation: PdfListRegionBlock,
  language: string | null,
) {
  const continuationHeadLine = blockSourceSegments(
    continuation,
  )[0]?.region.lines.find((line) => line.text.trim())
  const continuationHeadRun = continuationHeadLine?.runs
    .filter((run) => run.text.trim() && run.sourceSequenceIndex !== undefined)
    .reduce<PdfSourceRun | undefined>(
      (candidate, run) =>
        !candidate || run.sourceSequenceIndex! < candidate.sourceSequenceIndex!
          ? run
          : candidate,
      undefined,
    )
  return continuationHeadRun
    ? pdfSourceColumnFlowJoinOutcome(
        language,
        continuation.text.trimStart(),
        continuationHeadRun,
      )
    : null
}

export function sourceProvenSamePageColumnFlowBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines.find(
    (line) => line.text.trim(),
  )
  const rtl =
    baseDirection === 'rtl' ||
    (baseDirection !== 'ltr' &&
      baseDirection !== 'unknown' &&
      (language ? rtlLanguage(language) : false))
  const sourceColumnsMatch = rtl
    ? targetTailSegment?.region.column === 'right' &&
      continuationHeadSegment?.region.column === 'left'
    : targetTailSegment?.region.column === 'left' &&
      continuationHeadSegment?.region.column === 'right'
  const sourceColumnsAreOrdered = rtl
    ? Boolean(
        targetTailLine &&
        continuationHeadLine &&
        continuationHeadLine.box.x + continuationHeadLine.box.width <=
          targetTailLine.box.x + 0.01,
      )
    : Boolean(
        targetTailLine &&
        continuationHeadLine &&
        targetTailLine.box.x + targetTailLine.box.width <=
          continuationHeadLine.box.x + 0.01,
      )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    !sourceColumnsMatch ||
    targetTailLine.box.y + targetTailLine.box.height < 0.65 ||
    continuationHeadLine.box.y > 0.35 ||
    !sourceColumnsAreOrdered ||
    /[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) ||
    detachedCitationYearContinuation(target.text, continuation.text) ||
    // Source-proven column flow: the checks above have already established that
    // these two blocks are the same column of the same page, in reading order,
    // with no omitted source between them. That is what corroborates the weaker
    // uncased leading-character signal here.
    !likelyUnmarkedCrossPageContinuation(target, continuation, {
      admitUncasedScripts: true,
    }) ||
    hasOmittedSourceBetweenBlocks(target, continuation)
  ) {
    return false
  }
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  if (fontRatio > 1.12) return false
  const candidate = sourceSemanticFlowBoundaryCandidate(
    target,
    continuation,
    sourceColumnFlowJoin(continuation, language)?.outcome ?? 'space',
    'same-page-column',
  )
  return candidate !== null
}

const PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR = new Set([
  'right',
  'single',
  'span',
])
const PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR = new Set(['left', 'single', 'span'])

/**
 * A sentence that runs off the bottom of one page and resumes at the top of the
 * next.  Everything asserted here is readable from the source: the two blocks
 * are consecutive pages, the tail sits in the bottom band of the last column
 * and the head in the top band of the first, typography matches, and the
 * continuation carries language-agnostic unfinished-sentence evidence.  The
 * remaining proof — that only page furniture was painted between them — lives
 * in `sourceSemanticFlowBoundaryCandidate`, which needs the per-page body
 * source-order extrema to establish it.
 */
export function sourceProvenCrossPageColumnFlowBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
  bodySourceOrderExtremaByPage: ReadonlyMap<number, PdfBodySourceOrderExtremum>,
) {
  if (
    !sourceProvenCrossPageColumnGeometryBoundary(
      target,
      continuation,
      language,
      baseDirection,
    ) ||
    /[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) ||
    detachedCitationYearContinuation(target.text, continuation.text) ||
    !likelyUnmarkedCrossPageContinuation(target, continuation, {
      admitUncasedScripts: true,
    })
  ) {
    return false
  }
  return (
    sourceSemanticFlowBoundaryCandidate(
      target,
      continuation,
      sourceColumnFlowJoin(continuation, language)?.outcome ?? 'space',
      'cross-page-column',
      bodySourceOrderExtremaByPage,
    ) !== null
  )
}

export function sourceProvenCrossPageColumnGeometryBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines.find(
    (line) => line.text.trim(),
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    continuationHeadSegment.region.page !== targetTailSegment.region.page + 1
  ) {
    return false
  }
  const rtl =
    baseDirection === 'rtl' ||
    (baseDirection !== 'ltr' &&
      baseDirection !== 'unknown' &&
      (language ? rtlLanguage(language) : false))
  const tailColumns = rtl
    ? PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR
    : PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR
  const headColumns = rtl
    ? PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR
    : PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR
  if (
    !tailColumns.has(targetTailSegment.region.column) ||
    !headColumns.has(continuationHeadSegment.region.column) ||
    targetTailLine.box.y + targetTailLine.box.height < 0.65 ||
    continuationHeadLine.box.y > 0.35
  ) {
    return false
  }
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  return fontRatio <= 1.12
}

export function sourceProvenSamePageParagraphBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines.at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines[0]
  const runFragmentToSpanBoundary = sourceProvenRunFragmentToSpanBoundary(
    targetTailSegment?.region ?? target.region,
    continuationHeadSegment?.region ?? continuation.region,
  )
  const sourceProvenColumnFlowBoundary = sourceProvenSamePageColumnFlowBoundary(
    target,
    continuation,
    language,
    baseDirection,
  )
  const sourceColumnFlowOutcome = sourceProvenColumnFlowBoundary
    ? (sourceColumnFlowJoin(continuation, language)?.outcome ?? 'space')
    : 'space'
  const targetLineage = targetTailLine?.sourceFragmentLineage
  const continuationLineage = continuationHeadLine?.sourceFragmentLineage
  const explicitFragmentFamilyBoundary = Boolean(
    targetLineage &&
    continuationLineage &&
    targetLineage.sourceLineId === continuationLineage.sourceLineId &&
    new Set([
      'inline-stacked-before->inline-stacked-formula',
      'inline-stacked-before->inline-stacked-after',
      'inline-stacked-formula->inline-stacked-after',
      'cross-gutter-left->cross-gutter-right',
    ]).has(`${targetLineage.fragment}->${continuationLineage.fragment}`),
  )
  const targetToken = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const continuationToken = continuation.text
    .trimStart()
    .match(/^([\p{L}\p{N}]+)/u)?.[1]
  const sourceAttestedHyphenBoundary = Boolean(
    targetToken &&
    continuationToken &&
    sourceSemanticFlowHyphenVerdict(
      resolvePdfHyphenBoundary({
        left: targetToken,
        right: continuationToken,
        language,
        sourceProven: true,
        hardHyphenLexicon,
        unhyphenatedLexicon,
      }),
    ) !== 'unresolved',
  )
  const sourceAttestedCitationYearBoundary = detachedCitationYearContinuation(
    target.text,
    continuation.text,
  )
  const semanticFlowBoundary = sourceSemanticFlowBoundaryCandidate(
    target,
    continuation,
    sourceColumnFlowOutcome,
    explicitFragmentFamilyBoundary
      ? 'inline-stacked-fragment'
      : runFragmentToSpanBoundary
        ? 'cross-gutter-to-span'
        : sourceAttestedCitationYearBoundary
          ? 'same-column-citation-year'
          : sourceProvenColumnFlowBoundary
            ? 'same-page-column'
            : 'lexical-hyphen',
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.id === continuationHeadSegment.region.id ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    (targetTailSegment.region.column !==
      continuationHeadSegment.region.column &&
      !runFragmentToSpanBoundary &&
      !sourceProvenColumnFlowBoundary) ||
    (!runFragmentToSpanBoundary &&
      !explicitFragmentFamilyBoundary &&
      !sourceAttestedHyphenBoundary &&
      !sourceAttestedCitationYearBoundary &&
      !sourceProvenColumnFlowBoundary) ||
    hasOmittedSourceBetweenBlocks(target, continuation) ||
    semanticFlowBoundary === null
  ) {
    return false
  }
  const targetMetrics = dominantSemanticFlowLineMetrics(targetTailLine)
  const continuationMetrics =
    dominantSemanticFlowLineMetrics(continuationHeadLine)
  if (!targetMetrics || !continuationMetrics) return false
  const verticalGap =
    continuationHeadLine.box.y -
    (targetTailLine.box.y + targetTailLine.box.height)
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  if (fontRatio > 1.12) return false
  if (runFragmentToSpanBoundary || sourceProvenColumnFlowBoundary) return true
  const dominantBaselineAdvance =
    continuationMetrics.baseline - targetMetrics.baseline
  const sourceProvenDominantBaselineAdvance =
    dominantBaselineAdvance >=
      Math.max(
        0.004,
        Math.min(targetMetrics.height, continuationMetrics.height) * 0.25,
      ) &&
    dominantBaselineAdvance <=
      Math.max(
        0.035,
        Math.max(targetMetrics.height, continuationMetrics.height) * 2.5,
      )
  return (
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) <= 0.06 &&
    ((verticalGap >= -0.006 &&
      verticalGap <=
        Math.max(
          0.025,
          Math.max(targetTailLine.box.height, continuationHeadLine.box.height) *
            2.5,
        )) ||
      sourceProvenDominantBaselineAdvance)
  )
}

export function sourceProvenSamePageColumnBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  const hyphenatedTokenContinuation =
    /[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) &&
    /^\p{Ll}/u.test(continuation.text.trimStart())
  const citationYearContinuation = detachedCitationYearContinuation(
    target.text,
    continuation.text,
  )
  const targetToken = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const continuationToken = continuation.text
    .trimStart()
    .match(/^([\p{L}\p{N}]+)/u)?.[1]
  const fontRatio =
    targetTailLine && continuationHeadLine
      ? Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
        Math.max(
          1,
          Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
        )
      : Number.POSITIVE_INFINITY
  const deepHyphenContinuationIsSourceAttested = Boolean(
    targetToken &&
    continuationToken &&
    fontRatio <= 1.12 &&
    resolvePdfHyphenBoundary({
      left: targetToken,
      right: continuationToken,
      language,
      sourceProven: true,
      hardHyphenLexicon,
      unhyphenatedLexicon,
    }).verdict !== 'unresolved',
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== 'left' ||
    continuationHeadSegment.region.column !== 'right' ||
    targetTailLine.box.y + targetTailLine.box.height < 0.75 ||
    targetTailLine.box.x >= continuationHeadLine.box.x ||
    targetTailLine.box.x + targetTailLine.box.width >
      continuationHeadLine.box.x + 0.01 ||
    (!hyphenatedTokenContinuation && !citationYearContinuation) ||
    (citationYearContinuation && continuationHeadLine.box.y > 0.35) ||
    (hyphenatedTokenContinuation &&
      continuationHeadLine.box.y > 0.35 &&
      !deepHyphenContinuationIsSourceAttested)
  ) {
    return false
  }
  return true
}

export function floatInterruptedHyphenJoin(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
) {
  const left = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = continuation.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (!left || !right) {
    return {
      separator: target.text ? ' ' : '',
      hyphenBoundary: null,
    }
  }
  const proof = resolvePdfHyphenBoundary({
    left,
    right,
    language,
    sourceProven: true,
    hardHyphenLexicon,
    unhyphenatedLexicon,
  })
  return {
    // A printed terminal hyphen and its lowercase page continuation are one
    // source token. Preserve the printed hyphen when lexical evidence is
    // inconclusive, but never invent whitespace inside that token.
    separator: '',
    hyphenBoundary: { proof, left, right },
  }
}
