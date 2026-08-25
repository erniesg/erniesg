import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfFurnitureBand,
  PdfFurnitureClassification,
  PdfFurnitureEvidence,
  PdfFurnitureReview,
  PdfReadingOrderAmbiguityClass,
  PdfReadingOrderEdge,
  PdfReadingOrderEvaluation,
  PdfReadingOrderEvidence,
  PdfReadingOrderGraph,
  PdfReadingOrderResolution,
  PdfRegionColumn,
  PdfRegionKind,
  PdfRegionLine,
  PdfSourceFragmentLineage,
  PdfSourceRun,
} from './import-types'
import {
  groupRunsIntoLines,
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  joinPdfLineTexts,
  mergePdfRunText,
  type PdfTextLine,
} from './pdf-lines'
import { copyPdfLinkedTokenSourceAnnotations } from './pdf-links'
import {
  classifyPdfFurniture,
  firstPageTitleBlockRun,
  furnitureRunKey,
  marginTextIsNumeralOnly,
  normalizeMarginText,
  sourceRunBox,
} from './pdf-furniture'
import { normalizedNoteLabel } from './note-label'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  buildReadingOrder,
  inlineStackedFragmentOrder,
  inlineStackedFragmentParts,
  READING_ORDER_RESOLUTION_POLICY_VERSION,
  READING_ORDER_RESOLUTION_THRESHOLD,
  restoreInlineStackedAtomicUnits,
  splitNoteDefinitionOrder,
} from './pdf-reading-order'
import {
  marginBand,
  proseDominantInlineMathLine,
  sourceLineFlowOrder,
  splitDetachedMathExtensionProseRuns,
  splitSourceStackedInlineFormulaLines,
  textLineFromRuns,
  unresolvedMathExtensionLine,
} from './pdf-source-math'
import {
  dominantLineHeight,
  emphasizedSourceRun,
  markWrappedHeadingContinuations,
  promoteSourceProvenMultiComponentDisplayClusters,
  promoteSourceProvenSpanningInlineMathContinuations,
  repairCrossGutterHeadingPrefixes,
  sourceProvenDetachedDisplayEquationAtomHost,
  sourceProvenLexicalHyphenContinuation,
  sourceProvenMultiComponentDisplayCluster,
  sourceProvenSpanningInlineMathContinuation,
  sourceProvenDominantBaselineSequentialWrap,
  standaloneSectionHeading,
  visibleSourceSequenceIndexes,
} from './pdf-semantic-recovery'
import {
  lineBelongsToNativeVisual,
  lineBox,
  makeRegions,
  unionBox,
  unionRunBox,
} from './pdf-region-materialization'
import {
  beginsVisualCaption,
  classifiedLineFragment,
  columnFor,
  demoteInlineVisualReferenceContinuations,
  detectColumns,
  dominantIndent,
  endsCaptionSentence,
  endsIncompleteWrappedUrl,
  markAdjacentPanelLabelContinuations,
  promoteCaptionContinuations,
  promoteNoteContinuations,
  splitSourceCaptionLaneContinuations,
  type ClassifiedLine,
  type ColumnLayout,
} from './pdf-page-layout'
export {
  classifyPageFurniture,
  classifyPdfFurniture,
  digitValue,
  type PdfFurnitureAssessment,
} from './pdf-furniture'

export {
  canonicalPdfSourceSemanticFlowEvidence,
  pdfBodySourceOrderExtremaByPage,
  pdfSourceColumnFlowJoinOutcome,
  pdfSourceColumnFlowStartsWithCjkNumericContinuation,
  pdfSourceFragmentId,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
  PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE,
  type PdfBodySourceOrderExtremum,
} from './pdf-source-semantic-flow'
export { sourceProvenDominantBaselineSequentialWrap } from './pdf-semantic-recovery'
export {
  proseDominantPdfMathSource,
  sourceInlineFractionPairs,
  sourceStackedMathPairs,
} from './pdf-source-math'
export { captionFontFamily } from './pdf-page-layout'
export {
  evaluateReadingOrder,
  hasAcceptedCycle,
  READING_ORDER_RESOLUTION_POLICY_VERSION,
  READING_ORDER_RESOLUTION_THRESHOLD,
} from './pdf-reading-order'

const NOTE_LABEL = String.raw`(?:\d{1,3}|[*†‡§])`

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function quantile(values: number[], fraction: number) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[
    Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))
  ]
}

function beginsSourceStyledVisualCaption(line: PdfTextLine) {
  const dedicatedStyle = (run: PdfSourceRun) =>
    run.bold === true ||
    /(?:bold|black|demi|semibold|(?:^|[-_])medi(?:um)?(?:$|[-_]))/iu.test(
      run.fontName,
    )
  const substantiveRuns = line.runs.filter((run) => run.text.trim())
  const styledPrefixRuns: PdfSourceRun[] = []
  for (const run of substantiveRuns) {
    if (!dedicatedStyle(run)) break
    styledPrefixRuns.push(run)
  }
  if (styledPrefixRuns.length === 0) return false
  const styledPrefix = styledPrefixRuns.map((run) => run.text.trim()).join(' ')
  const styledLabel = parsePdfScholarlyVisualLabel(styledPrefix, {
    context: 'reference',
  })
  const lineLabel = parsePdfScholarlyVisualLabel(line.text, {
    context: 'reference',
  })
  return (
    styledLabel?.status === 'parsed' &&
    lineLabel?.status === 'parsed' &&
    styledLabel.kind === lineLabel.kind &&
    styledLabel.identifier === lineLabel.identifier &&
    styledLabel.consumedEnd === styledPrefix.length
  )
}

function sourceProvenRepeatedMarginHeadingLines(
  pages: readonly (readonly PdfTextLine[])[],
  repeated: ReadonlySet<string>,
) {
  const candidates = pages.flatMap((lines) =>
    lines.flatMap((line) => {
      const runs = line.runs
        .filter((run) => run.text.trim())
        .sort((left, right) => left.x - right.x)
      if (!marginBand(line) || runs.length !== 2) return []
      const prefixText = runs[0].text.replace(/\s+/gu, ' ').trim()
      const titleText = runs[1].text.replace(/\s+/gu, ' ').trim()
      const prefix = prefixText.match(
        /^([A-Z])\.(\d{1,3}(?:\.\d{1,3}){0,2})\.?$/u,
      )
      const titleWords = titleText.match(/[\p{L}\p{N}]+/gu) ?? []
      const normalizedTitle = normalizeMarginText(titleText)
      if (
        !prefix ||
        !repeated.has(normalizedTitle) ||
        !normalizedTitle.includes('#') ||
        titleWords.length < 2 ||
        titleWords.length > 12 ||
        titleText.length > 120 ||
        !/^\p{Lu}/u.test(titleText) ||
        /[.!?;:](?:["'’”)\]]*)$/u.test(titleText) ||
        !emphasizedSourceRun(runs[0]) ||
        !emphasizedSourceRun(runs[1]) ||
        runs[0].fontName !== runs[1].fontName ||
        runs[0].width > 0.08 ||
        runs[1].width < 0.12
      ) {
        return []
      }
      const ordinal = prefix[2].split('.').map(Number)
      const finalOrdinal = ordinal.at(-1)!
      const titleOrdinal = Number(titleText.match(/(\d{1,3})\s*$/u)?.[1])
      const fontRatio =
        Math.max(runs[0].fontSize, runs[1].fontSize) /
        Math.max(1, Math.min(runs[0].fontSize, runs[1].fontSize))
      const baselineGap = Math.abs(
        runs[0].y + runs[0].height / 2 - (runs[1].y + runs[1].height / 2),
      )
      const horizontalGap = runs[1].x - (runs[0].x + runs[0].width)
      if (
        titleOrdinal !== finalOrdinal ||
        fontRatio > 1.03 ||
        baselineGap >
          Math.max(0.0025, Math.min(runs[0].height, runs[1].height) * 0.2) ||
        horizontalGap < 0 ||
        horizontalGap > 0.035
      ) {
        return []
      }
      return [
        {
          line,
          letter: prefix[1],
          ordinal,
          normalizedTitle,
        },
      ]
    }),
  )
  const groups = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const key = `${candidate.letter}\u0000${candidate.normalizedTitle}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  const protectedLines = new Set<PdfTextLine>()
  const allLines = pages.flat()
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.line.page - right.line.page || left.line.y - right.line.y,
    )
    const depth = ordered[0]?.ordinal.length ?? 0
    if (
      ordered.length < 3 ||
      ordered[0].ordinal.at(-1) !== 1 ||
      ordered.some(
        (candidate, index) =>
          candidate.ordinal.length !== depth ||
          candidate.line.page <= (ordered[index - 1]?.line.page ?? 0) ||
          candidate.ordinal
            .slice(0, -1)
            .some(
              (part, partIndex) => part !== ordered[0].ordinal[partIndex],
            ) ||
          candidate.ordinal.at(-1) !== index + 1,
      )
    ) {
      continue
    }
    const first = ordered[0]
    const parentPattern = new RegExp(`^${first.letter}\\.?\\s+\\p{Lu}`, 'u')
    const parent = allLines.find((line) => {
      const text = line.text.replace(/\s+/gu, ' ').trim()
      const visibleRuns = line.runs.filter((run) => run.text.trim())
      const precedesFirst =
        line.page < first.line.page ||
        (line.page === first.line.page && line.y < first.line.y)
      return (
        precedesFirst &&
        parentPattern.test(text) &&
        text.length <= 120 &&
        !/[.!?;:](?:["'’”)\]]*)$/u.test(text) &&
        visibleRuns.length > 0 &&
        visibleRuns.every(emphasizedSourceRun) &&
        Math.max(...visibleRuns.map((run) => run.fontSize)) >=
          first.line.fontSize * 0.95
      )
    })
    if (!parent) continue
    ordered.forEach((candidate) => protectedLines.add(candidate.line))
  }
  return protectedLines
}

function splitRepeatedMarginSourceRuns(
  lines: PdfTextLine[],
  repeated: ReadonlySet<string>,
  protectedLines: ReadonlySet<PdfTextLine> = new Set(),
  furnitureByRunKey: ReadonlyMap<string, PdfFurnitureEvidence> = new Map(),
  furnitureReviewByRunKey: ReadonlyMap<string, PdfFurnitureReview> = new Map(),
) {
  return lines.flatMap((line) => {
    if (
      protectedLines.has(line) ||
      !marginBand(line) ||
      line.runs.length < 2 ||
      noteLabelFromText(line.text) !== null
    ) {
      return [line]
    }
    const orderedRuns = [...line.runs].sort((left, right) => left.x - right.x)
    const repeatedIndexes = orderedRuns.flatMap((run, index) =>
      marginBand(run) &&
      (furnitureByRunKey.has(furnitureRunKey(run)) ||
        furnitureReviewByRunKey.has(furnitureRunKey(run)) ||
        repeated.has(normalizeMarginText(run.text)))
        ? [index]
        : [],
    )
    if (repeatedIndexes.length === 0) return [line]
    // A diagram title and a margin run can overlap vertically enough for line
    // grouping to fuse them. Split only runs with furniture evidence (or a
    // bounded review record), retaining every residual run as its own line.
    const repeatedIndexSet = new Set(repeatedIndexes)
    const fragments: PdfTextLine[] = []
    let ordinaryRuns: typeof orderedRuns = []
    const flushOrdinaryRuns = () => {
      if (ordinaryRuns.length === 0) return
      fragments.push(textLineFromRuns(line, ordinaryRuns))
      ordinaryRuns = []
    }
    orderedRuns.forEach((run, index) => {
      if (!repeatedIndexSet.has(index)) {
        ordinaryRuns.push(run)
        return
      }
      flushOrdinaryRuns()
      fragments.push(textLineFromRuns(line, [run]))
    })
    flushOrdinaryRuns()
    return fragments.sort((left, right) => left.x - right.x)
  })
}

function explicitFirstPageParatextSeed(line: PdfTextLine, bodySize: number) {
  if (line.page !== 1 || line.y < 0.65) return false
  const text = line.text.replace(/\s+/gu, ' ').trim()
  const geometricFooter =
    line.x < 0.45 &&
    line.x + line.width > 0.55 &&
    line.width >= 0.4 &&
    line.height <= 0.04 &&
    // Geometry alone must not turn ordinary first-page prose near the bottom
    // into page furniture. Unlabelled publication bands are materially
    // smaller than body text; explicit address/legal/venue patterns below
    // remain eligible independently of this stricter typographic gate.
    medianLineFontSize(line) <= bodySize * 0.86 &&
    (text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
    !beginsVisualCaption(text) &&
    noteLabelFromText(text) === null
  return (
    geometricFooter ||
    /^authors?[’']?\s+address\s*:/iu.test(text) ||
    /^(?:permission to (?:make|copy)|(?:this )?work is licensed under|licensed under (?:the )?|creative commons\b|all rights reserved\b)/iu.test(
      text,
    ) ||
    /^(?:©\s*)?(?:\d{4}\s+)?copyright\b/iu.test(text) ||
    /^proceedings\s+of\s+(?:the\s+)?(?:\d+\s*(?:st|nd|rd|th)?\s+)?(?:international\s+)?(?:conference|symposium|workshop)\b/iu.test(
      text,
    ) ||
    /^(?:preprint(?:[.,].*)?|manuscript under review|under review)\.?$/iu.test(
      text,
    )
  )
}

function medianLineFontSize(line: PdfTextLine) {
  return (
    median(
      line.runs
        .filter((run) => run.text.trim())
        .map((run) => run.fontSize)
        .filter((size) => size > 0),
    ) || line.fontSize
  )
}

function firstPageParatextLines(lines: PdfTextLine[]) {
  const bodySize = bodyFontSize(lines)
  const ordered = [...lines].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  const bibliographyHeadingY = ordered.find((line) =>
    /^(?:(?:\d+(?:\.\d+)*)[.)]?\s+)?references$/iu.test(line.text.trim()),
  )?.y
  const claimed = new Set<PdfTextLine>()
  for (const [seedIndex, seed] of ordered.entries()) {
    if (bibliographyHeadingY !== undefined && seed.y > bibliographyHeadingY) {
      continue
    }
    if (!explicitFirstPageParatextSeed(seed, bodySize)) continue
    claimed.add(seed)
    let previous = seed
    for (const candidate of ordered.slice(seedIndex + 1)) {
      if (candidate.page !== 1 || candidate.y < previous.y) continue
      const compactInlineFragment =
        candidate.text.trim().length <= 4 &&
        candidate.width <= 0.05 &&
        candidate.x >= seed.x - 0.01 &&
        candidate.x + candidate.width <= seed.x + seed.width + 0.01 &&
        candidate.y < seed.y + seed.height &&
        candidate.y + candidate.height > seed.y
      if (compactInlineFragment) {
        claimed.add(candidate)
        continue
      }
      const horizontalOverlap = Math.max(
        0,
        Math.min(seed.x + seed.width, candidate.x + candidate.width) -
          Math.max(seed.x, candidate.x),
      )
      const overlapRatio =
        horizontalOverlap /
        Math.max(0.001, Math.min(seed.width, candidate.width))
      const aligned =
        Math.abs(candidate.x - seed.x) <= 0.08 || overlapRatio >= 0.72
      const horizontalSeparation = Math.max(
        candidate.x - (seed.x + seed.width),
        seed.x - (candidate.x + candidate.width),
        0,
      )
      if (!aligned && horizontalSeparation >= 0.012) continue
      const gap = candidate.y - (previous.y + previous.height)
      const fontRatio =
        Math.max(medianLineFontSize(previous), medianLineFontSize(candidate)) /
        Math.max(
          1,
          Math.min(medianLineFontSize(previous), medianLineFontSize(candidate)),
        )
      const wrapped =
        gap >= -0.002 &&
        gap <= Math.max(0.012, previous.height * 1.8) &&
        fontRatio <= 1.12 &&
        aligned &&
        !beginsVisualCaption(candidate.text) &&
        noteLabelFromText(candidate.text) === null
      if (!wrapped) break
      claimed.add(candidate)
      previous = candidate
    }
  }
  return claimed
}

export { normalizedNoteLabel } from './note-label'

export function noteLabelFromText(text: string) {
  const normalized = normalizedNoteLabel(text)
  const attachedSymbolic = normalized.match(/^([*†‡§])/u)
  if (attachedSymbolic) return attachedSymbolic[1]
  const explicit = normalized.match(
    new RegExp(`^(?:footnote|note)\\s+(${NOTE_LABEL})(?:\\s*[:.)-]|\\s+)`, 'i'),
  )
  if (explicit) return explicit[1]
  const leading = normalized.match(
    new RegExp(`^(${NOTE_LABEL})(?:[.)\\]]|\\s+)`),
  )
  return leading?.[1] ?? null
}

const NUMBERED_BODY_SECTION_TITLE =
  /^(?:abstract|introduction|background|related work|literature review|methods?|methodology|approach|framework|experiments?|evaluation|results?|discussion|limitations?|conclusion|references|appendix)\b/iu

function numberedBodySectionHeading(text: string) {
  const match = text.match(
    /^(\d{1,3}(?:\.\d+){0,3})([.)]?)\s+(\p{Lu}[^.,;:!?]{0,99})$/u,
  )
  if (!match) return false
  const [, sectionNumber, markerPunctuation, title] = match
  return (
    sectionNumber.includes('.') ||
    (markerPunctuation === '' && NUMBERED_BODY_SECTION_TITLE.test(title))
  )
}

function fusedNumberedListOrdinal(line: PdfTextLine) {
  const firstRun = line.runs.find((run) => run.text.trim())
  const match = firstRun?.text.match(/^\s*(\d{1,3})\.\s+\S/u)
  return match ? Number(match[1]) : null
}

function sourceSmallCapsTypography(line: PdfTextLine) {
  const letters = line.text.match(/\p{L}/gu) ?? []
  if (
    letters.length < 4 ||
    letters.some((letter) => letter !== letter.toLocaleUpperCase())
  ) {
    return false
  }
  const letterRuns = line.runs.filter(
    (run) => run.text.trim() && /\p{L}/u.test(run.text),
  )
  if (letterRuns.length < 2) return false
  const leadingLetters =
    letterRuns[0].text.match(/\p{L}/gu)?.length ?? Number.POSITIVE_INFINITY
  const largestSize = Math.max(...letterRuns.map((run) => run.fontSize))
  return (
    leadingLetters <= 2 &&
    letterRuns[0].fontSize >= largestSize * 0.95 &&
    letterRuns.slice(1).some((run) => run.fontSize <= largestSize * 0.9)
  )
}

function sourceStyledBoundaryHeadingLine(
  lines: readonly PdfTextLine[],
  lineIndex: number,
  bodySize: number,
) {
  const line = lines[lineIndex]
  const text = line.text.replace(/\s+/gu, ' ').trim()
  const letters = text.match(/\p{L}/gu) ?? []
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    text.length > 96 ||
    letters.length < 4 ||
    words.length === 0 ||
    words.length > 10 ||
    letters.some((letter) => letter !== letter.toLocaleUpperCase()) ||
    /(?:https?:\/\/|www\.|\S*[_@]\S*|(?:\.\s*){3,})/iu.test(text)
  ) {
    return false
  }
  const emphasized =
    line.runs.some(
      (run) =>
        run.bold === true ||
        /(?:bold|semibold|demi|medi(?:um)?|black)/iu.test(run.fontName) ||
        /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
          run.fontName,
        ) ||
        /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
          run.fontName,
        ),
    ) ||
    sourceSmallCapsTypography(line) ||
    line.fontSize >= bodySize * 1.12
  if (!emphasized) return false

  const contentLike = (candidate: PdfTextLine) =>
    candidate.text.trim().length >= 40 &&
    candidate.width >= Math.max(0.3, line.width * 1.35) &&
    Math.abs(candidate.x - line.x) <= 0.07
  const previous = lines
    .slice(0, lineIndex)
    .reverse()
    .find(
      (candidate) =>
        contentLike(candidate) &&
        candidate.y + candidate.height <= line.y + 0.002,
    )
  const next = lines
    .slice(lineIndex + 1)
    .find(
      (candidate) =>
        contentLike(candidate) && candidate.y >= line.y + line.height - 0.002,
    )
  if (!next) return false
  const lineHeight = Math.max(line.height, 0.008)
  const precedingGap = previous
    ? line.y - (previous.y + previous.height)
    : Number.POSITIVE_INFINITY
  const followingGap = next.y - (line.y + line.height)
  const startsAtPageBoundary = !previous && line.y <= 0.22
  return (
    (startsAtPageBoundary ||
      precedingGap >= Math.max(0.006, lineHeight * 0.45)) &&
    followingGap >= Math.max(0.004, lineHeight * 0.3) &&
    followingGap <= Math.max(0.055, lineHeight * 3.5)
  )
}

function hasApparentNumericNoteReference(
  lines: readonly PdfTextLine[],
  definitionLines: ReadonlySet<PdfTextLine>,
  labels: ReadonlySet<string>,
) {
  const explicitReference = new RegExp(
    String.raw`\b(?:footnote|note(?:\s+reference)?)\s*#?\s*(${[...labels].join('|')})\b`,
    'iu',
  )
  for (const line of lines) {
    if (definitionLines.has(line)) continue
    if (explicitReference.test(normalizedNoteLabel(line.text))) return true
    const runs = line.runs.filter((run) => run.text.trim())
    const largestFont = Math.max(...runs.map((run) => run.fontSize), 0)
    const tallestRun = Math.max(...runs.map((run) => run.height), 0)
    if (
      runs.some(
        (run) =>
          labels.has(normalizedNoteLabel(run.text)) &&
          runs.length > 1 &&
          (run.fontSize <= largestFont * 0.82 ||
            run.height <= tallestRun * 0.82),
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * A compact numbered prompt/list at the bottom of a page can share every
 * coarse feature of a footnote band. Keep only the narrow source-backed case:
 * at least three consecutive dotted items beginning at 1, aligned and set in
 * one fused prose run, with no raised or explicit same-page note reference.
 * Separately typeset note markers and referenced compact note bands therefore
 * remain eligible for normal note classification.
 */
function unreferencedSequentialNumberedListLines(lines: PdfTextLine[]) {
  const candidates = lines
    .flatMap((line) => {
      const ordinal = fusedNumberedListOrdinal(line)
      return ordinal === null ? [] : [{ line, ordinal }]
    })
    .sort(
      (left, right) => left.line.y - right.line.y || left.line.x - right.line.x,
    )
  const sequences: (typeof candidates)[] = []
  let sequence: typeof candidates = []
  const flush = () => {
    if (sequence.length > 0) sequences.push(sequence)
    sequence = []
  }
  for (const candidate of candidates) {
    const previous = sequence.at(-1)
    const fontRatio = previous
      ? Math.max(previous.line.fontSize, candidate.line.fontSize) /
        Math.max(1, Math.min(previous.line.fontSize, candidate.line.fontSize))
      : 1
    if (
      previous &&
      candidate.ordinal === previous.ordinal + 1 &&
      candidate.line.y - previous.line.y <=
        Math.max(0.06, previous.line.height * 5) &&
      Math.abs(candidate.line.x - previous.line.x) <=
        Math.max(0.012, previous.line.height) &&
      fontRatio <= 1.08
    ) {
      sequence.push(candidate)
    } else {
      flush()
      sequence = [candidate]
    }
  }
  flush()

  const bodyListLines = new Set<PdfTextLine>()
  for (const candidateSequence of sequences) {
    if (candidateSequence.length < 3 || candidateSequence[0].ordinal !== 1) {
      continue
    }
    const definitionLines = new Set(
      candidateSequence.map((candidate) => candidate.line),
    )
    const labels = new Set(
      candidateSequence.map((candidate) => String(candidate.ordinal)),
    )
    if (hasApparentNumericNoteReference(lines, definitionLines, labels)) {
      continue
    }
    for (const candidate of candidateSequence) {
      bodyListLines.add(candidate.line)
    }
  }
  return bodyListLines
}

function bodyFontSize(lines: PdfTextLine[]) {
  const central = lines.filter(
    (line) => line.y > 0.1 && line.y + line.height < 0.9,
  )
  const prose = central.filter(
    (line) =>
      line.width >= 0.25 && (line.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 3,
  )
  // Dense plots and diagrams can contribute hundreds of tiny label lines and
  // overwhelm a page-wide font quantile. Prefer repeated, wide prose evidence
  // whenever it exists so genuine bottom notes are compared with the document
  // body rather than with chart ticks.
  const population =
    prose.length >= 2 ? prose : central.length > 0 ? central : lines
  const sizes = population
    .map((line) => line.fontSize)
    .filter((size) => size > 0)
  return quantile(sizes, 0.75) || median(sizes) || 12
}

type NoteLineClassificationEvidence = {
  label: string | null
  explicitFootnote: boolean
  symbolicFootnote: boolean
  renderedFootnote: boolean
}

function hasCompactStandaloneNoteContinuation(
  marker: PdfTextLine,
  lines: readonly PdfTextLine[],
  bodyFontSize: number,
) {
  const normalizedMarker = normalizedNoteLabel(marker.text)
  if (
    !/^\d{1,3}$/u.test(normalizedMarker) ||
    !marginTextIsNumeralOnly(normalizedMarker)
  ) {
    return false
  }
  const markerBottom = marker.y + marker.height
  const fontTolerance = Math.max(0.6, marker.fontSize * 0.08)
  return lines.some((candidate) => {
    if (candidate === marker || candidate.page !== marker.page) return false
    const normalizedCandidate = normalizedNoteLabel(candidate.text)
    const gap = candidate.y - markerBottom
    return (
      gap >= -0.002 &&
      gap <= Math.max(0.012, marker.height) &&
      Math.abs(candidate.x - marker.x) <= 0.04 &&
      Math.abs(candidate.fontSize - marker.fontSize) <= fontTolerance &&
      candidate.fontSize >= 5 &&
      candidate.fontSize <= bodyFontSize * 0.9 + 0.01 &&
      candidate.y + candidate.height >= 0.92 &&
      !marginTextIsNumeralOnly(normalizedCandidate) &&
      (normalizedCandidate.match(/\p{L}{2,}/gu)?.length ?? 0) >= 2
    )
  })
}

function noteLineClassificationEvidence(
  line: PdfTextLine,
  fontSize: number,
  lowerBand: number,
  numberedBodyListLines: ReadonlySet<PdfTextLine>,
  pageLines: readonly PdfTextLine[],
): NoteLineClassificationEvidence {
  const normalized = normalizedNoteLabel(line.text)
  const standaloneNoteContinuation = hasCompactStandaloneNoteContinuation(
    line,
    pageLines,
    fontSize,
  )
  const label =
    noteLabelFromText(normalized) ??
    (standaloneNoteContinuation ? normalized : null)
  const explicitFootnote = new RegExp(
    `^(?:footnote|note)\\s+${NOTE_LABEL}`,
    'i',
  ).test(normalized)
  const symbolicFootnote = /^[*†‡§]/u.test(normalized)
  const substantiveRuns = line.runs.filter((run) => run.text.trim())
  const monospacedNumberedContent =
    !symbolicFootnote &&
    /^\d{1,3}(?:[.)\]]|\s)/u.test(normalized) &&
    substantiveRuns.length > 0 &&
    substantiveRuns.every((run) =>
      /(?:courier|inconsolata|nimbusmon|mono|typewriter|cmtt|lmtt|sftt)/iu.test(
        run.fontName,
      ),
    )
  // Decimal-leading lower-band content is overwhelmingly a plot tick, metric
  // row, or table cell, not an integer-labeled note body. Integer-only labels
  // remain eligible because a genuine footnote may place its marker on a line
  // of its own.
  const decimalTabularContent = /^[-+]?\d+[.,]\d/u.test(normalized)
  const isolatedMarginFolio =
    substantiveRuns.length > 0 &&
    substantiveRuns.every((run) =>
      marginTextIsNumeralOnly(run.text.normalize('NFKC').trim()),
    ) &&
    (line.y <= 0.08 || line.y + line.height >= 0.92) &&
    !standaloneNoteContinuation
  const renderedFootnote =
    label !== null &&
    !decimalTabularContent &&
    !isolatedMarginFolio &&
    !monospacedNumberedContent &&
    !numberedBodyListLines.has(line) &&
    !numberedBodySectionHeading(normalized) &&
    line.y + line.height >= lowerBand &&
    line.fontSize >= 5 &&
    line.fontSize <= fontSize * (symbolicFootnote ? 0.96 : 0.9) + 0.01
  return {
    label,
    explicitFootnote,
    symbolicFootnote,
    renderedFootnote,
  }
}

/**
 * Footnote ownership is resolved before furniture. This hand-off is
 * geometry- and marker-based; it deliberately has no journal or keyword
 * allowlist. Any source run in a note-owned line is deferred to the note
 * stratum, so a repeated lower band cannot hide a genuine note body.
 */
function noteStratumRunKeys(lines: readonly PdfTextLine[]) {
  const pageFontSize = bodyFontSize([...lines])
  const numberedBodyListLines = unreferencedSequentialNumberedListLines([
    ...lines,
  ])
  const lowerBand = quantile(
    lines.map((line) => line.y + line.height),
    0.65,
  )
  const orderedLines = [...lines].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  const keys = new Set<string>()
  const noteSeeds = orderedLines.filter((line) => {
    const evidence = noteLineClassificationEvidence(
      line,
      pageFontSize,
      lowerBand,
      numberedBodyListLines,
      lines,
    )
    return evidence.explicitFootnote || evidence.renderedFootnote
  })
  for (const seed of noteSeeds) {
    for (const run of seed.runs) {
      if (run.text.trim()) keys.add(furnitureRunKey(run))
    }
    let previous = seed
    while (
      !endsCaptionSentence(previous.text) ||
      endsIncompleteWrappedUrl(previous.text)
    ) {
      const candidate = orderedLines
        .filter((line) => {
          if (
            line.page !== seed.page ||
            line === seed ||
            line.y <= previous.y ||
            noteLabelFromText(line.text) !== null
          ) {
            return false
          }
          const verticalGap = line.y - (previous.y + previous.height)
          const fontTolerance = Math.max(0.6, seed.fontSize * 0.08)
          return (
            verticalGap <= Math.max(0.008, seed.height * 0.8) &&
            Math.abs(line.x - seed.x) <= 0.04 &&
            Math.abs(line.fontSize - seed.fontSize) <= fontTolerance
          )
        })
        .sort(
          (left, right) =>
            left.y - right.y ||
            Math.abs(left.x - seed.x) - Math.abs(right.x - seed.x),
        )[0]
      if (!candidate) break
      previous = candidate
      for (const run of candidate.runs) {
        if (run.text.trim()) keys.add(furnitureRunKey(run))
      }
    }
  }
  return keys
}

function preclassifyMarginNotes(
  lines: ClassifiedLine[],
  pageBodyFontSize: number,
) {
  const body = lines.filter((line) => line.kind === 'body')
  const dominant = dominantIndent(body)
  if (!dominant || dominant.members.length < 2) return
  for (const line of body) {
    if (line.furnitureReview) continue
    if (dominant.members.includes(line)) continue
    const alignedWithBody = dominant.members.some((candidate) => {
      const lineCenter = line.y + line.height / 2
      const candidateCenter = candidate.y + candidate.height / 2
      return (
        Math.abs(lineCenter - candidateCenter) <=
        Math.max(0.012, line.height, candidate.height)
      )
    })
    if (
      alignedWithBody &&
      line.fontSize <= pageBodyFontSize * 0.85 &&
      line.width <= 0.25 &&
      line.text.length <= 120 &&
      Math.abs(line.x - dominant.x) >= 0.18
    ) {
      line.kind = 'side'
      line.confidence = 0.9
    }
  }
}

function sourceRaisedFrontMatterAffiliation(line: ClassifiedLine) {
  if (line.page !== 1 || line.y >= 0.32) return false
  const runs = line.runs.filter((run) => run.text.trim())
  const marker = runs[0]
  const institution = runs[1]
  if (
    !marker ||
    !institution ||
    !/^\d{1,3}(?:,\d{1,3})*$/u.test(marker.text.trim()) ||
    !/(?:university|institute|department|laborator(?:y|ies)|school|college|centre|center|hospital|academy|technolog(?:y|ies))/iu.test(
      runs
        .slice(1)
        .map((run) => run.text)
        .join(' '),
    )
  ) {
    return false
  }
  const markerCenter = marker.y + marker.height / 2
  const institutionCenter = institution.y + institution.height / 2
  const horizontalGap = institution.x - (marker.x + marker.width)
  return (
    marker.fontSize <= institution.fontSize * 0.92 + 0.01 &&
    markerCenter <=
      institutionCenter - Math.max(0.0005, institution.height * 0.18) &&
    horizontalGap >= -0.001 &&
    horizontalGap <= 0.012
  )
}

export function splitRunBackedCrossGutterProse(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  if (layout.split === null) return lines
  const split = layout.split
  return lines.flatMap((line) => {
    if (
      line.kind !== 'body' ||
      layout.tabularGridBands?.has(line.id) ||
      line.runs.length < 2 ||
      line.x >= split - 0.08 ||
      line.x + line.width <= split + 0.08
    ) {
      return [line]
    }
    const runs = [...line.runs].sort(
      (left, right) => left.x - right.x || left.y - right.y,
    )
    const boundaries = runs.flatMap((rightRun, index) => {
      if (index === 0) return []
      const leftRun = runs[index - 1]
      const leftEdge = leftRun.x + leftRun.width
      const gap = rightRun.x - leftEdge
      const center = (leftEdge + rightRun.x) / 2
      if (
        gap <
          Math.max(0.018, Math.min(leftRun.height, rightRun.height) * 0.8) ||
        Math.abs(center - split) > 0.035
      ) {
        return []
      }
      const leftRuns = runs.slice(0, index)
      const rightRuns = runs.slice(index)
      const leftWords =
        mergePdfRunText(leftRuns).match(/\p{L}{2,}/gu)?.length ?? 0
      const rightWords =
        mergePdfRunText(rightRuns).match(/\p{L}{2,}/gu)?.length ?? 0
      return leftWords >= 2 && rightWords >= 2
        ? [{ index, distance: Math.abs(center - split) }]
        : []
    })
    const boundary = boundaries.sort(
      (left, right) => left.distance - right.distance,
    )[0]
    if (!boundary) return [line]
    return [
      classifiedLineFragment(line, runs.slice(0, boundary.index), 'left'),
      classifiedLineFragment(line, runs.slice(boundary.index), 'right'),
    ]
  })
}

function splitRunBackedSymbolicNoteDefinitions(region: PdfPageRegion) {
  if (
    (region.kind !== 'footnote' && region.kind !== 'endnote') ||
    region.lines.length !== 1
  ) {
    return [region]
  }
  const line = region.lines[0]
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 4 || !/^[*†‡§]$/u.test(runs[0].text.trim())) {
    return [region]
  }

  const runRanges: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const run of runs) {
    const text = run.text.replace(/\s+/gu, ' ').trim()
    const start = region.text.indexOf(text, cursor)
    if (start < cursor) return [region]
    runRanges.push({ start, end: start + text.length })
    cursor = start + text.length
  }
  const markerIndexes = runs.flatMap((run, index) =>
    /^[*†‡§]$/u.test(run.text.trim()) ? [index] : [],
  )
  if (
    markerIndexes.length < 2 ||
    markerIndexes[0] !== 0 ||
    markerIndexes.some(
      (markerIndex, index) =>
        (markerIndexes[index + 1] ?? runs.length) - markerIndex < 2,
    )
  ) {
    return [region]
  }

  return markerIndexes.map((markerIndex, index) => {
    const nextMarkerIndex = markerIndexes[index + 1] ?? runs.length
    const fragmentRuns = runs
      .slice(markerIndex, nextMarkerIndex)
      .map((run) => ({ ...run }))
    const sourceStart = runRanges[markerIndex].start
    const sourceEnd =
      index + 1 < markerIndexes.length
        ? runRanges[nextMarkerIndex].start
        : region.text.length
    const text = region.text.slice(sourceStart, sourceEnd).trimEnd()
    const box = unionRunBox(fragmentRuns)
    if (!box) return region
    const suffix =
      index === 0 ? '' : `-note-${String(index + 1).padStart(3, '0')}`
    const fragmentLine: PdfRegionLine = {
      ...line,
      id: `${line.id}${suffix}`,
      text,
      box,
      runs: fragmentRuns,
    }
    return {
      ...region,
      id: `${region.id}${suffix}`,
      text,
      box,
      lines: [fragmentLine],
    }
  })
}

function makeObjectRegions(
  pages: PdfPageAnalysis[],
  layouts: Map<number, ColumnLayout>,
  furnitureByObjectId: ReadonlyMap<string, PdfFurnitureEvidence> = new Map(),
) {
  return pages.flatMap((page) =>
    (page.objects ?? [])
      .filter((object) => object.role !== 'scan-source')
      .map<PdfPageRegion>((object, index) => {
        const layout = layouts.get(page.page) ?? {
          split: null,
          accepted: false,
          ambiguous: false,
          resolution: null,
        }
        const column = columnFor(
          {
            page: page.page,
            text: '',
            x: object.box.x,
            y: object.box.y,
            width: object.box.width,
            height: object.box.height,
            fontSize: 0,
            runs: [],
            column: 'single',
          },
          layout,
        )
        const furniture = furnitureByObjectId.get(object.id)
        return {
          id: `page-${String(page.page).padStart(3, '0')}-object-region-${String(index + 1).padStart(3, '0')}`,
          page: page.page,
          kind: 'figure',
          column,
          text: '',
          confidence: object.confidence,
          box: { ...object.box },
          lines: [],
          nativeObjectIds: [object.id],
          includedInReadingOrder: !furniture,
          ...(furniture ? { furniture } : {}),
        }
      }),
  )
}

export function reconstructPageRegions(
  pages: PdfPageAnalysis[],
  { language = null }: { language?: string | null } = {},
) {
  const groupedLines = pages.map((page) => groupRunsIntoLines(page))
  const deferredFurnitureRunKeys = new Set<string>()
  for (const lines of groupedLines) {
    for (const key of noteStratumRunKeys(lines)) {
      deferredFurnitureRunKeys.add(key)
    }
  }
  const furnitureAssessment = classifyPdfFurniture(pages, {
    deferredRunKeys: deferredFurnitureRunKeys,
  })
  const repeated = new Set(
    furnitureAssessment.patterns.map((pattern) => pattern.normalizedText),
  )
  const protectedRepeatedMarginHeadings =
    sourceProvenRepeatedMarginHeadingLines(groupedLines, repeated)
  const protectedRepeatedMarginHeadingRunKeys = new Set(
    [...protectedRepeatedMarginHeadings].flatMap((line) =>
      line.runs
        .filter((run) => run.text.trim())
        .map((run) => furnitureRunKey(run)),
    ),
  )
  const rawLines = groupedLines.map((lines) =>
    splitDetachedMathExtensionProseRuns(
      splitSourceStackedInlineFormulaLines(
        splitRepeatedMarginSourceRuns(
          lines,
          repeated,
          protectedRepeatedMarginHeadings,
          furnitureAssessment.byRunKey,
          furnitureAssessment.reviewByRunKey,
        ),
      ),
    ),
  )
  const hardHyphenLexicon = inlineHardHyphenLexicon(rawLines.flat())
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(rawLines.flat())
  const classified: ClassifiedLine[] = []
  const layouts = new Map<number, ColumnLayout>()
  let inEndnotes = false

  const lineFurniture = (line: PdfTextLine) => {
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    if (visibleRuns.length === 0) return undefined
    if (
      visibleRuns.every((run) =>
        protectedRepeatedMarginHeadingRunKeys.has(furnitureRunKey(run)),
      )
    ) {
      return undefined
    }
    const evidences = visibleRuns.flatMap((run) => {
      const evidence = furnitureAssessment.byRunKey.get(furnitureRunKey(run))
      return evidence ? [evidence] : []
    })
    if (evidences.length === visibleRuns.length && evidences.length > 0) {
      return evidences[0]
    }
    return undefined
  }
  const lineDeferredToNotes = (line: PdfTextLine) => {
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    return (
      visibleRuns.length > 0 &&
      visibleRuns.every((run) =>
        deferredFurnitureRunKeys.has(furnitureRunKey(run)),
      )
    )
  }
  const lineFurnitureReview = (
    line: PdfTextLine,
    explicitParatextLines?: ReadonlySet<PdfTextLine>,
  ) => {
    if (explicitParatextLines?.has(line)) return undefined
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    if (visibleRuns.length === 0) return undefined
    const reviews = visibleRuns.flatMap((run) => {
      const review = furnitureAssessment.reviewByRunKey.get(
        furnitureRunKey(run),
      )
      return review ? [review] : []
    })
    return reviews.length === visibleRuns.length && reviews.length > 0
      ? reviews[0]
      : undefined
  }

  for (const [pageIndex, pageLines] of rawLines.entries()) {
    const page = pages[pageIndex]
    const fontSize = bodyFontSize(pageLines)
    const paratextLines = firstPageParatextLines(pageLines)
    const numberedBodyListLines =
      unreferencedSequentialNumberedListLines(pageLines)
    const lowerBand = quantile(
      pageLines.map((line) => line.y + line.height),
      0.65,
    )
    let preliminary = pageLines
      .sort(sourceLineFlowOrder)
      .map<ClassifiedLine>((line, lineIndex) => {
        const furniture = lineFurniture(line)
        const furnitureReview = lineFurnitureReview(line, paratextLines)
        const normalized = normalizedNoteLabel(line.text)
        const endnoteHeading = /^(?:endnotes?|notes?)$/i.test(normalized)
        const noteEvidence = noteLineClassificationEvidence(
          line,
          fontSize,
          lowerBand,
          numberedBodyListLines,
          pageLines,
        )
        const { label, explicitFootnote, renderedFootnote } = noteEvidence
        const inlineStackedFragment = inlineStackedFragmentParts(line)
        const firstPageTitleBlockLine = line.runs.some((run) =>
          firstPageTitleBlockRun(run, fontSize),
        )
        let kind: PdfRegionKind = 'body'
        let confidence = 0.9
        if (inEndnotes && label !== null) {
          kind = 'endnote'
          confidence = 0.96
        } else if (explicitFootnote || renderedFootnote) {
          kind = 'footnote'
          confidence = explicitFootnote ? 0.98 : 0.9
        } else if (
          beginsVisualCaption(normalized) ||
          beginsSourceStyledVisualCaption(line)
        ) {
          kind = 'caption'
          confidence = 0.94
        } else if (
          page.page === 1 &&
          /^arxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\b/i.test(normalized) &&
          line.width >= 0.45 &&
          line.height <= 0.04 &&
          line.fontSize >= 16
        ) {
          kind = 'side'
          confidence = 0.99
        } else if (paratextLines.has(line)) {
          kind = 'footer'
          confidence = 0.99
        } else if (furniture) {
          kind =
            furniture.band === 'left' || furniture.band === 'right'
              ? 'side'
              : furniture.classification === 'incrementing-numeral' &&
                  marginTextIsNumeralOnly(line.text)
                ? 'page-number'
                : furniture.band === 'top'
                  ? 'header'
                  : 'footer'
          confidence = 0.99
        } else if (
          !firstPageTitleBlockLine &&
          marginBand(line) &&
          repeated.has(normalizeMarginText(line.text))
        ) {
          kind = line.y < 0.5 ? 'header' : 'footer'
          confidence = 0.99
        } else if (
          !furnitureReview &&
          !firstPageTitleBlockLine &&
          (line.y <= 0.08 || line.y + line.height >= 0.92) &&
          line.fontSize <= fontSize * 0.9
        ) {
          kind = line.y <= 0.08 ? 'header' : 'footer'
          confidence = 0.78
        } else if (/-detached-math-\d+-host-/u.test(line.id ?? '')) {
          kind = 'equation'
          confidence = 0.98
        } else if (
          unresolvedMathExtensionLine(line) &&
          !proseDominantInlineMathLine(line)
        ) {
          kind = 'equation'
          confidence = 0.96
        } else if (
          inlineStackedFragment?.part === 'formula' &&
          !proseDominantInlineMathLine(line)
        ) {
          kind = 'equation'
          confidence = 0.96
        } else if (
          line.fontSize >= fontSize * 0.95 &&
          line.text.length <= 120 &&
          /(?:=|[+−×÷∫∑√≤≥≈])/u.test(line.text) &&
          !proseDominantInlineMathLine(line)
        ) {
          kind = 'equation'
          confidence = 0.9
        } else if (
          line.fontSize <= fontSize * 0.95 &&
          normalized.length <= 120 &&
          lineBelongsToNativeVisual(line, page.objects) &&
          !sourceStyledBoundaryHeadingLine(pageLines, lineIndex, fontSize)
        ) {
          kind = 'chart-label'
          confidence = 0.94
        } else if (
          line.fontSize <= fontSize * 0.82 &&
          normalized.length <= 32 &&
          !sourceStyledBoundaryHeadingLine(pageLines, lineIndex, fontSize) &&
          /(?:%|^[-+]?\d+(?:[.,]\d+)?$|^[A-Za-z]{2,12}$)/.test(normalized)
        ) {
          kind = 'chart-label'
          confidence = 0.82
        }
        if (endnoteHeading) inEndnotes = true
        return {
          ...line,
          id:
            line.id ??
            `page-${String(page.page).padStart(3, '0')}-line-${String(lineIndex + 1).padStart(4, '0')}`,
          kind,
          confidence,
          noteLabel: label,
          ...(furniture
            ? { furniture }
            : paratextLines.has(line) && !lineDeferredToNotes(line)
              ? {
                  furniture: {
                    classification: 'explicit-paratext' as const,
                    band: 'bottom' as const,
                    pages: [line.page],
                    boxes: line.runs
                      .filter((run) => run.text.trim())
                      .map(sourceRunBox),
                    evidence: ['first-page-paratext-geometry'],
                    normalizedText: normalizeMarginText(line.text),
                  },
                }
              : {}),
          ...(furnitureReview ? { furnitureReview } : {}),
        }
      })

    demoteInlineVisualReferenceContinuations(preliminary)
    preliminary = splitSourceCaptionLaneContinuations(preliminary)
    promoteCaptionContinuations(preliminary)
    markAdjacentPanelLabelContinuations(preliminary, page.objects)
    promoteNoteContinuations(preliminary)
    preclassifyMarginNotes(preliminary, fontSize)
    const spreadBoundary =
      page.spread?.status === 'split' ? page.spread.boundary : null
    const layout: ColumnLayout =
      spreadBoundary !== null
        ? {
            split: spreadBoundary,
            accepted: true,
            ambiguous: false,
            resolution: null,
          }
        : detectColumns(preliminary)
    preliminary = splitRunBackedCrossGutterProse(preliminary, layout)
    layouts.set(page.page, layout)
    const commonX = median(
      preliminary.filter((line) => line.kind === 'body').map((line) => line.x),
    )
    for (const line of preliminary) {
      line.tabularGridBandId = layout.tabularGridBands?.get(line.id)
      const continuationSeedId =
        line.captionContinuationSeedId ??
        line.panelLabelContinuationSeedId ??
        line.noteContinuationSeedId
      const continuationSeed = continuationSeedId
        ? preliminary.find((candidate) => candidate.id === continuationSeedId)
        : undefined
      line.column = continuationSeed
        ? columnFor(continuationSeed, layout)
        : (line.sourceOwnedColumn ?? columnFor(line, layout))
      if (
        line.kind === 'body' &&
        line.column === 'span' &&
        layout.split !== null
      ) {
        line.kind = 'spanning'
        line.confidence = layout.accepted ? 0.95 : 0.58
      } else if (
        line.kind === 'body' &&
        !line.furnitureReview &&
        !/^\p{L}$/u.test(normalizedNoteLabel(line.text)) &&
        !sourceRaisedFrontMatterAffiliation(line) &&
        line.fontSize <= fontSize * 0.85 &&
        line.text.length <= 120 &&
        Math.abs(line.x - commonX) > Math.max(0.18, line.width * 0.8)
      ) {
        line.kind = 'side'
        line.confidence = 0.76
      }
      if (
        layout.ambiguous &&
        (line.column === 'left' || line.column === 'right')
      ) {
        line.confidence = Math.min(line.confidence, 0.58)
      }
    }
    promoteSourceProvenSpanningInlineMathContinuations(preliminary)
    promoteSourceProvenMultiComponentDisplayClusters(preliminary, layout)
    markWrappedHeadingContinuations(preliminary)
    classified.push(...repairCrossGutterHeadingPrefixes(preliminary, layout))
  }

  const hasSingleColumnPage =
    layouts.size > 1 &&
    [...layouts.values()].some(
      (layout) => layout.split === null && !layout.ambiguous,
    )
  if (hasSingleColumnPage) {
    for (const layout of layouts.values()) {
      if (
        layout.resolution?.status === 'resolved' &&
        layout.resolution.ambiguityClass === 'sparse-column-gutter'
      ) {
        layout.resolution.ambiguityClass = 'mixed-single-two-column'
      }
    }
  }

  const lineBoundaryDecisions: PdfLineBoundaryDecision[] = []
  const textRegions = makeRegions(
    classified,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language,
    lineBoundaryDecisions,
  ).flatMap(splitRunBackedSymbolicNoteDefinitions)
  const regions = [
    ...textRegions,
    ...makeObjectRegions(pages, layouts, furnitureAssessment.objectById),
  ].sort((left, right) => {
    if (left.page !== right.page) return left.page - right.page
    const splitDefinitionOrder = splitNoteDefinitionOrder(left, right)
    if (splitDefinitionOrder !== null) return splitDefinitionOrder
    const inlineOrder = inlineStackedFragmentOrder(
      left.lines[0] ?? { id: undefined },
      right.lines[0] ?? { id: undefined },
    )
    if (inlineOrder !== null) return inlineOrder
    return (
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id)
    )
  })
  const readingOrder = buildReadingOrder(regions, layouts)
  return {
    regions,
    lineBoundaryDecisions,
    unresolvedCorruptingJoinCount: lineBoundaryDecisions.filter(
      (decision) =>
        decision.outcome === 'unresolved' || decision.outcome === 'ambiguous',
    ).length,
    readingOrder,
    repeatedMarginCount: furnitureAssessment.repeatedMarginCount,
    furnitureExcludedRunCount: furnitureAssessment.furnitureRuns.length,
    furnitureExcludedTextCharacters: furnitureAssessment.furnitureRuns.reduce(
      (total, { run }) => total + [...run.text].length,
      0,
    ),
    furnitureReviewCount: furnitureAssessment.reviewRuns.length,
    furnitureAssessment,
    ambiguousPages: [...layouts.entries()]
      .filter(([, layout]) => layout.ambiguous)
      .map(([page]) => page),
  }
}
