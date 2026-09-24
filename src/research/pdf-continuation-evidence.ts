import type {
  PdfCanonicalHyphenBoundaryDecision,
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
  ReconstructionDiagnostic,
} from './import-types'
import { sameSourceBox } from './pdf-canonical-node-composition'
import { resolvePdfHyphenBoundary } from './pdf-hyphenation'
import {
  blockSourceSegments,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import { appendBlockContinuation } from './pdf-paragraph-continuations'
import { pdfSourceColumnFlowStartsWithCjkNumericContinuation } from './pdf-regions'

function bibliographyContinuationJoin(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
) {
  const left = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = continuation.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (left && right) {
    const proof = resolvePdfHyphenBoundary({
      left,
      right,
      language,
      sourceProven: true,
      hardHyphenLexicon,
      unhyphenatedLexicon,
    })
    return {
      separator: '',
      hyphenBoundary: { proof, left, right },
    }
  }
  if (/^[,;:)\]]/u.test(continuation.text.trimStart())) {
    return { separator: '', hyphenBoundary: null }
  }
  const previousYearPrefix = target.text.match(/(?:18|19|20)\d$/u)?.[0]
  const finalYearDigit = continuation.text.match(/^(\d)(?=[.,;:)])/u)?.[1]
  if (
    previousYearPrefix &&
    finalYearDigit &&
    Number(`${previousYearPrefix}${finalYearDigit}`) <= 2099
  ) {
    return { separator: '', hyphenBoundary: null }
  }
  if (/[-–—]$/u.test(target.text) && /^\d/u.test(continuation.text)) {
    return { separator: '', hyphenBoundary: null }
  }
  return {
    separator: target.text ? ' ' : '',
    hyphenBoundary: null,
  }
}

export function appendBibliographyContinuation(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  canonicalHyphenBoundaryDecisions: PdfCanonicalHyphenBoundaryDecision[],
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[],
  topology: 'bibliography-same-baseline' | 'bibliography-hanging-indent',
) {
  const join = bibliographyContinuationJoin(
    target,
    continuation,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language,
  )
  appendBlockContinuation(
    target,
    continuation,
    join.separator,
    join.hyphenBoundary
      ? {
          context: 'bibliography-continuation',
          ...join.hyphenBoundary,
          decisions: canonicalHyphenBoundaryDecisions,
        }
      : null,
    sourceSemanticFlowBoundaryDecisions,
    topology,
  )
}

export function hasOmittedSourceBetweenBlocks(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
) {
  const targetSegments = blockSourceSegments(target)
  const continuationSegments = blockSourceSegments(continuation)
  return continuationSegments.some((continuationSegment) => {
    const precedingTargetSegments = targetSegments.filter(
      (targetSegment) =>
        targetSegment.region.id === continuationSegment.region.id &&
        targetSegment.sourceStart < continuationSegment.sourceStart,
    )
    if (precedingTargetSegments.length === 0) return false
    const precedingSourceEnd = Math.max(
      ...precedingTargetSegments.map(
        (targetSegment) =>
          targetSegment.sourceStart + targetSegment.text.length,
      ),
    )
    // A reconstructed region inserts at most one separator between adjacent
    // retained line ranges. A larger gap proves that another source span was
    // consumed by a visual or otherwise omitted, so prose/reference flow must
    // not jump across it.
    return continuationSegment.sourceStart > precedingSourceEnd + 1
  })
}

export function bibliographyContinuationFormEvidence(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
) {
  const continuationSegments = blockSourceSegments(continuation)
  const continuationHeadSegment = continuationSegments[0]
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const continuationText = continuation.text.trimStart()
  if (
    !continuationText ||
    (continuationEvidenceRegion &&
      likelyAuthorYearBibliographyEntryStart(
        continuationEvidenceRegion.lines,
        0,
      ))
  ) {
    return false
  }

  const targetHeadSegment = blockSourceSegments(target)[0]
  const targetEvidenceRegion =
    targetHeadSegment?.evidenceRegion ?? targetHeadSegment?.region
  const targetHeadLine = targetEvidenceRegion?.lines.find((line) =>
    line.text.trim(),
  )
  const continuationHeadLine = continuationEvidenceRegion?.lines.find((line) =>
    line.text.trim(),
  )
  const hangingIndentContinuation = Boolean(
    targetHeadLine &&
    continuationHeadLine &&
    continuationHeadLine.box.x - targetHeadLine.box.x >= 0.008 &&
    continuationHeadLine.box.x - targetHeadLine.box.x <= 0.06,
  )
  const bibliographicLocator =
    /\b(?:arXiv|doi|preprint|proceedings|journal|volume|vol\.|pages?|pp?\.|https?:\/\/|www\.)\b/iu.test(
      continuationText,
    )
  return (
    !/[.!?](?:["'’”\])}]*)$/u.test(target.text.trimEnd()) ||
    /^[\p{Ll}\p{N},;:)\]]/u.test(continuationText) ||
    hangingIndentContinuation ||
    bibliographicLocator
  )
}

function sourceContiguousSamePageBibliographyContinuation(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines.at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== continuationHeadSegment.region.column ||
    hasOmittedSourceBetweenBlocks(target, continuation) ||
    !bibliographyContinuationFormEvidence(target, continuation)
  ) {
    return false
  }
  const verticalGap =
    continuationHeadLine.box.y -
    (targetTailLine.box.y + targetTailLine.box.height)
  const maximumVerticalGap = Math.max(
    0.025,
    Math.max(targetTailLine.box.height, continuationHeadLine.box.height) * 2.5,
  )
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  const targetFlowStartX = Math.min(
    ...blockSourceSegments(target).flatMap((segment) => {
      const evidenceRegion = segment.evidenceRegion ?? segment.region
      return evidenceRegion.lines
        .filter((line) => line.text.trim())
        .map((line) => line.box.x)
    }),
  )
  const alignedContinuation =
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) <= 0.06
  const rightEdgeLineWrap =
    targetTailLine.box.x + targetTailLine.box.width >= 0.65 &&
    continuationHeadLine.box.x >= targetFlowStartX - 0.012 &&
    continuationHeadLine.box.x <= targetFlowStartX + 0.06
  return (
    verticalGap >= -0.006 &&
    verticalGap <= maximumVerticalGap &&
    (alignedContinuation || rightEdgeLineWrap) &&
    fontRatio <= 1.12
  )
}

function sourceProvenAdjacentPageBibliographyContinuation(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
) {
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
    !targetEvidenceRegion ||
    !continuationEvidenceRegion ||
    !targetTailLine ||
    !continuationHeadLine
  ) {
    return false
  }
  const targetColumn = targetTailSegment.region.column
  const continuationColumn = continuationHeadSegment.region.column
  const wrappedColumnTransition =
    targetColumn === 'right' && continuationColumn === 'left'
  const nonColumnarTransition =
    (targetColumn === 'single' || targetColumn === 'span') &&
    (continuationColumn === 'single' || continuationColumn === 'span')
  const compatibleColumnFlow =
    targetColumn === continuationColumn ||
    wrappedColumnTransition ||
    nonColumnarTransition
  const targetFlowStartX = Math.min(
    ...blockSourceSegments(target)
      .filter(
        (segment) => segment.region.page === targetTailSegment.region.page,
      )
      .flatMap((segment) => {
        const evidenceRegion = segment.evidenceRegion ?? segment.region
        return evidenceRegion.lines
          .filter((line) => line.text.trim())
          .map((line) => line.box.x)
      }),
  )
  const horizontallyAligned =
    wrappedColumnTransition ||
    Math.abs(continuationHeadLine.box.x - targetFlowStartX) <= 0.06
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  return (
    compatibleColumnFlow &&
    horizontallyAligned &&
    fontRatio <= 1.12 &&
    sourceProvenCrossPageBoundary(target, continuation, []) &&
    !hasOmittedSourceBetweenBlocks(target, continuation) &&
    likelyUnmarkedCrossPageContinuation(target, continuation) &&
    bibliographyContinuationFormEvidence(target, continuation)
  )
}

export function provenBibliographyContinuation(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
) {
  if (sourceContiguousSamePageBibliographyContinuation(target, continuation)) {
    return 'same-page' as const
  }
  if (sourceProvenAdjacentPageBibliographyContinuation(target, continuation)) {
    return 'adjacent-page' as const
  }
  return null
}

const PDF_SENTENCE_END_WITH_CLOSING =
  /\p{Sentence_Terminal}(?:["'’”\p{Close_Punctuation}\p{Final_Punctuation}]*)$/u

const UNCERTAIN_BIBLIOGRAPHY_BOUNDARY_MESSAGE =
  'The bibliography item boundary is uncertain because a plausible markerless continuation lacks source-contiguous same-flow or adjacent-page geometry.'

export function recordUncertainBibliographyBoundary(
  diagnostics: ReconstructionDiagnostic[],
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  if (!targetTailSegment || !continuationHeadSegment) return
  const targetEvidenceRegion =
    targetTailSegment.evidenceRegion ?? targetTailSegment.region
  const continuationEvidenceRegion =
    continuationHeadSegment.evidenceRegion ?? continuationHeadSegment.region
  const sourceBoxes = [targetEvidenceRegion.box, continuationEvidenceRegion.box]
  const duplicate = diagnostics.some((diagnostic) => {
    const diagnosticBoxes = diagnostic.sourceBoxes
    return (
      diagnostic.code === 'LOW_CONFIDENCE_BLOCK' &&
      diagnostic.message === UNCERTAIN_BIBLIOGRAPHY_BOUNDARY_MESSAGE &&
      diagnosticBoxes !== undefined &&
      diagnosticBoxes.length === sourceBoxes.length &&
      diagnosticBoxes.every((box, index) =>
        sameSourceBox(box, sourceBoxes[index]),
      )
    )
  })
  if (duplicate) return
  diagnostics.push({
    code: 'LOW_CONFIDENCE_BLOCK',
    severity: 'warning',
    page: continuationEvidenceRegion.page,
    message: UNCERTAIN_BIBLIOGRAPHY_BOUNDARY_MESSAGE,
    sourceBoxes,
    target: {
      regionIds: [
        ...new Set([
          targetTailSegment.region.id,
          continuationHeadSegment.region.id,
        ]),
      ],
      markerId: null,
    },
  })
}

// A lowercase leading letter is the cased-script signal that a block continues
// an unfinished sentence. Uncased scripts have no such signal: Han, Arabic and
// Hebrew letters are all `\p{Lo}`, so `\p{Ll}` is never true for them and this
// evidence is simply unavailable.
const PDF_UNMARKED_CONTINUATION_LEAD = /^\p{Ll}/u
// Admitting `\p{Lo}` restores the signal for uncased scripts, but it admits
// *every* uncased-script block, which is far weaker evidence than a lowercase
// letter is in a cased script. It is therefore opt-in per call site rather
// than shared: source-proven column flow independently establishes that the
// two blocks are the same column of the same page pair, which is the
// corroboration that makes the weaker leading-character test safe to use.
const PDF_UNMARKED_CONTINUATION_LEAD_WITH_UNCASED = /^(?:\p{Ll}|\p{Lo})/u

export function likelyUnmarkedCrossPageContinuation(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  { admitUncasedScripts = false }: { admitUncasedScripts?: boolean } = {},
) {
  const previousText = target.text.trimEnd()
  const continuationText = continuation.text.trimStart()
  const leadingLetter = admitUncasedScripts
    ? PDF_UNMARKED_CONTINUATION_LEAD_WITH_UNCASED
    : PDF_UNMARKED_CONTINUATION_LEAD
  return Boolean(
    previousText &&
    continuationText &&
    !PDF_SENTENCE_END_WITH_CLOSING.test(previousText) &&
    (leadingLetter.test(continuationText) ||
      detachedScholarlyReferenceContinuation(previousText, continuationText) ||
      detachedCitationYearContinuation(previousText, continuationText) ||
      detachedNumericProseContinuation(previousText, continuationText) ||
      detachedDashProseContinuation(previousText, continuationText)),
  )
}

function detachedNumericProseContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    (/\b(?:a|an|the|of|for|from|with|without|among|between|over|under|by|than|approximately|about|around|nearly|roughly|exactly|includes?|including|contains?|containing|comprises?|comprising)\s*$/iu.test(
      previousText.trimEnd(),
    ) &&
      /^\d+(?:[,.]\d+)*(?:\s*[%×x+-]\s*\d+(?:[,.]\d+)*)?\s+\p{L}/u.test(
        continuationText.trimStart(),
      )) ||
    pdfSourceColumnFlowStartsWithCjkNumericContinuation(continuationText)
  )
}

export function detachedScholarlyReferenceContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    /\b(?:Section|Appendix|Figure|Fig\.|Table|Equation|Eq\.)$/u.test(
      previousText.trimEnd(),
    ) &&
    /^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\.(?:\s|$)/u.test(
      continuationText.trimStart(),
    )
  )
}

function detachedDashProseContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    !/[.!?:;](?:["'’”\])}]*)$/u.test(previousText.trimEnd()) &&
    /^[–—-]\s+\p{Ll}/u.test(continuationText.trimStart())
  )
}

export function detachedCitationYearContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    /\b\p{Lu}[\p{L}'’.-]*(?:\s+et\s+al\.)?,\s*$/u.test(
      previousText.trimEnd(),
    ) &&
    /^(?:18|19|20)\d{2}[a-z]?(?=[,;:)])/u.test(continuationText.trimStart())
  )
}

export function scholarlyLabelFloatContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    /\b(?:in|of|to|from|with|by|at|on|as|than|between|for|following)\s*$/iu.test(
      previousText.trimEnd(),
    ) &&
    /^(?:Table|Figure|Equation|Eq\.|Section|Appendix)\s+(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\b/u.test(
      continuationText.trimStart(),
    )
  )
}

export function sourceProvenCrossPageBoundary(
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
  interveningCaptions: readonly PdfListRegionBlock[],
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines.at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    continuationHeadSegment.region.page !== targetTailSegment.region.page + 1 ||
    targetTailLine.box.y < 0.55
  ) {
    return false
  }
  if (interveningCaptions.length === 0) {
    return continuationHeadLine.box.y <= 0.35
  }
  return interveningCaptions.some((caption) => {
    if (caption.region.page === continuationHeadSegment.region.page) {
      return (
        caption.region.box.y + caption.region.box.height <=
        continuationHeadLine.box.y + 0.004
      )
    }
    return (
      caption.region.page === targetTailSegment.region.page &&
      caption.region.box.y >=
        targetTailLine.box.y + targetTailLine.box.height - 0.004
    )
  })
}

export function likelyAuthorYearBibliographyEntryStart(
  lines: PdfPageRegion['lines'],
  index: number,
) {
  const text = lines[index]?.text.trim() ?? ''
  if (!(
    /^\p{Lu}[\p{L}'’.-]+,\s*(?:\p{Lu}(?:[.-]\p{Lu})*\.?|[\p{Lu}][\p{L}'’.-]+)/u.test(
      text,
    ) ||
    /^(?:[\p{Lu}\p{N}][\p{L}\p{N}&'’+.-]*\s*){1,5}\.\s+\p{Lu}/u.test(text) ||
    /^[a-z][\p{L}\p{N}.-]*\.\s+\p{Lu}/u.test(text)
  )) {
    return false
  }
  return /\b(?:18|19|20)\d{2}[a-z]?\b/u.test(
    lines
      .slice(index, index + 8)
      .map((line) => line.text)
      .join(' '),
  )
}
