import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfFurnitureEvidence,
  PdfFurnitureReview,
  PdfReadingOrderEdge,
  PdfReadingOrderEvaluation,
  PdfReadingOrderGraph,
  PdfReadingOrderResolution,
  PdfRegionKind,
  PdfRegionLine,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
} from './import-types'
import {
  groupRunsIntoLines,
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  joinPdfLineTexts,
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
import {
  demoteInlineVisualReferenceContinuations,
  endsCaptionSentence,
  endsIncompleteWrappedUrl,
  markAdjacentPanelLabelContinuations,
  promoteCaptionContinuations,
  splitSourceCaptionLaneContinuations,
  type ClassifiedLine,
} from './pdf-region-captions'
import {
  columnFor,
  detectColumns,
  READING_ORDER_RESOLUTION_THRESHOLD,
  rounded,
  splitRunBackedCrossGutterProse,
  type ColumnLayout,
} from './pdf-region-column-layout'
import {
  bodyFontSize,
  median,
  noteLabelFromText,
  noteLineClassificationEvidence,
  noteStratumRunKeys,
  preclassifyMarginNotes,
  quantile,
  sourceRaisedFrontMatterAffiliation,
  sourceStyledBoundaryHeadingLine,
  unreferencedSequentialNumberedListLines,
} from './pdf-region-note-classification'
import {
  beginsSourceStyledVisualCaption,
  beginsVisualCaption,
  emphasizedSourceRun,
  inlineStackedFragmentOrder,
  inlineStackedFragmentParts,
  marginBand,
  proseDominantInlineMathLine,
  restoreInlineStackedAtomicUnits,
  sourceLineFlowOrder,
  splitDetachedMathExtensionProseRuns,
  splitSourceStackedInlineFormulaLines,
  textLineFromRuns,
  unresolvedMathExtensionLine,
} from './pdf-region-line-analysis'
import { sha256HexSync } from './sha256-sync'

export {
  classifyPageFurniture,
  classifyPdfFurniture,
  digitValue,
  type PdfFurnitureAssessment,
} from './pdf-furniture'
export {
  proseDominantPdfMathSource,
  sourceInlineFractionPairs,
  sourceStackedMathPairs,
} from './pdf-region-line-analysis'
export { captionFontFamily } from './pdf-region-captions'
export {
  READING_ORDER_RESOLUTION_POLICY_VERSION,
  READING_ORDER_RESOLUTION_THRESHOLD,
  splitRunBackedCrossGutterProse,
} from './pdf-region-column-layout'
export { noteLabelFromText } from './pdf-region-note-classification'

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

function promoteNoteContinuations(lines: ClassifiedLine[]) {
  const claimed = new Set<string>()
  const seeds = lines
    .filter(
      (line) =>
        (line.kind === 'footnote' || line.kind === 'endnote') && line.y >= 0.65,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const seed of seeds) {
    let previous = seed
    while (
      !endsCaptionSentence(previous.text) ||
      endsIncompleteWrappedUrl(previous.text)
    ) {
      const candidate = lines
        .filter((line) => {
          if (
            line.page !== seed.page ||
            !(
              line.kind === 'body' ||
              line.kind === 'footer' ||
              ((line.kind === 'footnote' || line.kind === 'endnote') &&
                line.noteLabel === null)
            ) ||
            claimed.has(line.id) ||
            line.y <= previous.y
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
      candidate.kind = seed.kind
      candidate.noteContinuationSeedId = seed.id
      candidate.confidence = Math.min(seed.confidence, candidate.confidence)
      claimed.add(candidate.id)
      previous = candidate
    }
  }
}

function lineBelongsToNativeVisual(
  line: PdfTextLine,
  objects: PdfPageAnalysis['objects'],
) {
  const centerX = line.x + line.width / 2
  const centerY = line.y + line.height / 2
  return (objects ?? [])
    .filter(
      (object) =>
        object.role !== 'scan-source' &&
        object.box.width * object.box.height <= 0.72,
    )
    .some((object) => {
      const padding = Math.max(0.012, Math.min(0.04, line.height * 2.5))
      return (
        centerX >= object.box.x - padding &&
        centerX <= object.box.x + object.box.width + padding &&
        centerY >= object.box.y - padding &&
        centerY <= object.box.y + object.box.height + padding
      )
    })
}

function lineBox(line: PdfTextLine): NormalizedSourceBox {
  return {
    page: line.page,
    x: rounded(line.x),
    y: rounded(line.y),
    width: rounded(line.width),
    height: rounded(line.height),
    rotation: line.runs[0]?.rotation ?? 0,
    method: line.runs.some((run) => run.method === 'ocr') ? 'ocr' : 'pdf-text',
  }
}

function unionBox(lines: PdfRegionLine[]): NormalizedSourceBox {
  const left = Math.min(...lines.map((line) => line.box.x))
  const top = Math.min(...lines.map((line) => line.box.y))
  const right = Math.max(...lines.map((line) => line.box.x + line.box.width))
  const bottom = Math.max(...lines.map((line) => line.box.y + line.box.height))
  return {
    page: lines[0].box.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: lines[0].box.rotation,
    method: lines.some((line) => line.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

function unionRunBox(runs: PdfRegionLine['runs']): NormalizedSourceBox | null {
  if (runs.length === 0) return null
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.x + run.width))
  const bottom = Math.max(...runs.map((run) => run.y + run.height))
  return {
    page: runs[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: runs[0].rotation,
    method: runs.some((run) => run.method === 'ocr') ? 'ocr' : 'pdf-text',
  }
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

function splitNoteDefinitionOrder(left: PdfPageRegion, right: PdfPageRegion) {
  const parts = (id: string) => {
    const match = id.match(/^(.*)-note-(\d{3})$/u)
    return {
      base: match?.[1] ?? id,
      ordinal: match ? Number(match[2]) : 1,
    }
  }
  const leftParts = parts(left.id)
  const rightParts = parts(right.id)
  return leftParts.base === rightParts.base
    ? leftParts.ordinal - rightParts.ordinal
    : null
}

function standaloneSectionHeading(line: ClassifiedLine) {
  if (line.kind !== 'body' && line.kind !== 'spanning') return false
  const text = line.text.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 120) return false
  if (
    /^(?:abstract|acknowledg(?:e)?ments?|limitations?|ethics statement|references|bibliography|appendix)$/i.test(
      text,
    )
  ) {
    return true
  }
  const machineIdentifierTitle = /^(?:(?:https?:\/\/|www\.)|\S*[_@]\S*)/iu.test(
    text.replace(/^(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+/u, ''),
  )
  const stronglyStyledStructuralHeading =
    !machineIdentifierTitle &&
    emphasizedFaceShare(line) >= 0.6 &&
    /^(?:(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?)\s+\p{Lu}.{0,100}$/u.test(
      text,
    )
  return (
    /^\d{1,3}(?:\.\d+){0,3}\s+\p{Lu}[^.,;:!?]{0,100}$/u.test(text) ||
    /^[A-Z](?:\.\d+)?\s+\p{Lu}[^,;:!?]{0,100}$/u.test(text) ||
    stronglyStyledStructuralHeading
  )
}

function dominantLineHeight(line: ClassifiedLine) {
  const largestFont = Math.max(...line.runs.map((run) => run.fontSize), 0)
  const baselineHeights = line.runs
    .filter((run) => run.fontSize >= largestFont * 0.9)
    .map((run) => run.height)
    .filter((height) => height > 0)
  return median(baselineHeights) || line.height
}

function dominantBaselineMetrics(line: PdfTextLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  if (visibleRuns.length === 0) return null
  const maximumFontSize = Math.max(...visibleRuns.map((run) => run.fontSize))
  const dominantRuns = visibleRuns.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  const characterWeight = (run: PdfSourceRun) =>
    Math.max(run.text.replace(/\s+/gu, '').length, 1)
  const totalWeight = dominantRuns.reduce(
    (total, run) => total + characterWeight(run),
    0,
  )
  const representative = [...dominantRuns].sort(
    (left, right) =>
      characterWeight(right) - characterWeight(left) ||
      right.fontSize - left.fontSize ||
      left.x - right.x,
  )[0]
  return {
    fontSize: maximumFontSize,
    fontName: representative.fontName,
    top: Math.min(...dominantRuns.map((run) => run.y)),
    bottom: Math.max(...dominantRuns.map((run) => run.y + run.height)),
    baseline:
      dominantRuns.reduce(
        (total, run) => total + (run.y + run.height) * characterWeight(run),
        0,
      ) / totalWeight,
    height: median(dominantRuns.map((run) => run.height)),
  }
}

function comparableSemanticFlowFontName(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(
      /(?:bold|semibold|demi|medium|black|italic|ital|oblique|regular)/gu,
      '',
    )
    .replace(/\d+/gu, '')
    .replace(/[^a-z]+/gu, '')
}

export function sourceProvenDominantBaselineSequentialWrap(
  previous: PdfTextLine,
  line: PdfTextLine,
) {
  const previousRuns = previous.runs.filter((run) => run.text.trim())
  const lineRuns = line.runs.filter((run) => run.text.trim())
  if (
    previous.page !== line.page ||
    previous.column !== line.column ||
    previousRuns.length < 2 ||
    lineRuns.length === 0 ||
    previousRuns.some((run) => run.sourceSequenceIndex === undefined) ||
    lineRuns.some((run) => run.sourceSequenceIndex === undefined)
  ) {
    return false
  }
  const maximumPreviousSequence = Math.max(
    ...previousRuns.map((run) => run.sourceSequenceIndex!),
  )
  const minimumLineSequence = Math.min(
    ...lineRuns.map((run) => run.sourceSequenceIndex!),
  )
  const previousBoundaryRuns = previousRuns.filter(
    (run) => run.sourceSequenceIndex === maximumPreviousSequence,
  )
  const lineBoundaryRuns = lineRuns.filter(
    (run) => run.sourceSequenceIndex === minimumLineSequence,
  )
  if (previousBoundaryRuns.length !== 1 || lineBoundaryRuns.length !== 1) {
    return false
  }
  const previousBoundaryRun = previousBoundaryRuns[0]
  const lineBoundaryRun = lineBoundaryRuns[0]
  const exactSourceAdjacency =
    minimumLineSequence === maximumPreviousSequence + 1 ||
    (lineBoundaryRun.sourceWhitespaceBefore === 'pdf-text-item' &&
      lineBoundaryRun.sourceWhitespacePredecessorIndex ===
        maximumPreviousSequence)
  const previousMetrics = dominantBaselineMetrics(previous)
  const lineMetrics = dominantBaselineMetrics(line)
  if (
    !exactSourceAdjacency ||
    !previousMetrics ||
    !lineMetrics ||
    previousBoundaryRun.page !== lineBoundaryRun.page ||
    previousBoundaryRun.rotation !== lineBoundaryRun.rotation ||
    previousBoundaryRun.method !== lineBoundaryRun.method
  ) {
    return false
  }
  const fullEnvelopeGap = line.y - (previous.y + previous.height)
  const dominantGap = lineMetrics.top - previousMetrics.bottom
  const hasStackedEnvelope =
    previousRuns.some(
      (run) =>
        run.fontSize < previousMetrics.fontSize * 0.9 &&
        (run.y < previousMetrics.top ||
          run.y + run.height > previousMetrics.bottom),
    ) ||
    lineRuns.some(
      (run) =>
        run.fontSize < lineMetrics.fontSize * 0.9 &&
        (run.y < lineMetrics.top || run.y + run.height > lineMetrics.bottom),
    )
  const fontRatio =
    Math.max(previousMetrics.fontSize, lineMetrics.fontSize) /
    Math.max(1, Math.min(previousMetrics.fontSize, lineMetrics.fontSize))
  const previousFont = comparableSemanticFlowFontName(previousMetrics.fontName)
  const lineFont = comparableSemanticFlowFontName(lineMetrics.fontName)
  const fontCompatible =
    previousFont === lineFont ||
    previousFont.includes(lineFont) ||
    lineFont.includes(previousFont)
  return (
    hasStackedEnvelope &&
    fullEnvelopeGap < -0.004 &&
    dominantGap >= -0.004 &&
    dominantGap <=
      Math.max(
        0.014,
        Math.max(previousMetrics.height, lineMetrics.height) * 1.25,
      ) &&
    fontRatio <= 1.18 &&
    fontCompatible &&
    Math.abs(line.x - previous.x) <=
      Math.max(0.06, Math.max(previousMetrics.height, lineMetrics.height) * 4)
  )
}

function sourceProvenSpanningInlineMathContinuation(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  sourceSequenceCounts: ReadonlyMap<number, number>,
) {
  if (
    previous.page !== line.page ||
    previous.kind !== 'spanning' ||
    previous.column !== 'span' ||
    line.kind !== 'body' ||
    (line.column !== 'left' && line.column !== 'right') ||
    previous.y >= line.y ||
    !proseDominantInlineMathLine(previous) ||
    /[.!?](?:["'’”\])}]*)$/u.test(previous.text.trim()) ||
    !/^\p{Ll}/u.test(line.text.trim())
  ) {
    return false
  }
  const continuationWords = line.text.match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    continuationWords.length === 0 ||
    continuationWords.length > 8 ||
    line.text.trim().length > 72 ||
    line.width > Math.min(0.3, previous.width * 0.45)
  ) {
    return false
  }

  const previousRuns = previous.runs.filter((run) => run.text.trim())
  const lineRuns = line.runs.filter((run) => run.text.trim())
  const inlineMathEvidence = previousRuns.some(
    (run) =>
      /(?:cmmi|cmsy|cmex|msbm|math|symbol)/iu.test(run.fontName) ||
      /[\p{Script=Greek}∆_=+*/<>^−×÷≤≥≈≠∼⊙∂∞∏∈∉→←∫∑√]/u.test(run.text),
  )
  const previousSequenceIndexes = previousRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  const lineSequenceIndexes = lineRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  if (
    !inlineMathEvidence ||
    previousRuns.length === 0 ||
    lineRuns.length === 0 ||
    previousSequenceIndexes.length !== previousRuns.length ||
    lineSequenceIndexes.length !== lineRuns.length ||
    new Set(previousSequenceIndexes).size !== previousSequenceIndexes.length ||
    new Set(lineSequenceIndexes).size !== lineSequenceIndexes.length
  ) {
    return false
  }
  const previousBoundary = Math.max(...previousSequenceIndexes)
  const lineBoundary = Math.min(...lineSequenceIndexes)
  if (
    lineBoundary !== previousBoundary + 1 ||
    sourceSequenceCounts.get(previousBoundary) !== 1 ||
    sourceSequenceCounts.get(lineBoundary) !== 1
  ) {
    return false
  }

  const previousSource = previousRuns[0]
  const lineSource = lineRuns[0]
  if (
    previousRuns.some(
      (run) =>
        run.page !== previous.page ||
        run.rotation !== previousSource.rotation ||
        run.method !== previousSource.method,
    ) ||
    lineRuns.some(
      (run) =>
        run.page !== line.page ||
        run.rotation !== lineSource.rotation ||
        run.method !== lineSource.method,
    ) ||
    previousSource.rotation !== lineSource.rotation ||
    previousSource.method !== lineSource.method
  ) {
    return false
  }

  const previousMetrics = dominantBaselineMetrics(previous)
  const lineMetrics = dominantBaselineMetrics(line)
  if (!previousMetrics || !lineMetrics) return false
  const fontRatio =
    Math.max(previousMetrics.fontSize, lineMetrics.fontSize) /
    Math.max(1, Math.min(previousMetrics.fontSize, lineMetrics.fontSize))
  const previousFont = comparableSemanticFlowFontName(previousMetrics.fontName)
  const lineFont = comparableSemanticFlowFontName(lineMetrics.fontName)
  const fontCompatible =
    previousFont.length > 0 &&
    lineFont.length > 0 &&
    (previousFont === lineFont ||
      previousFont.includes(lineFont) ||
      lineFont.includes(previousFont))
  const dominantHeight = Math.max(previousMetrics.height, lineMetrics.height)
  const dominantGap = lineMetrics.top - previousMetrics.bottom
  const baselineStep = lineMetrics.baseline - previousMetrics.baseline
  return (
    fontRatio <= 1.08 &&
    fontCompatible &&
    Math.abs(line.x - previous.x) <=
      Math.max(
        0.006,
        Math.min(previousMetrics.height, lineMetrics.height) * 0.5,
      ) &&
    dominantGap >= -0.002 &&
    dominantGap <= Math.max(0.008, dominantHeight * 0.75) &&
    baselineStep >= dominantHeight * 0.75 &&
    baselineStep <= Math.max(0.024, dominantHeight * 1.75)
  )
}

function promoteSourceProvenSpanningInlineMathContinuations(
  lines: ClassifiedLine[],
) {
  const sourceSequenceCounts = new Map<number, number>()
  for (const run of lines.flatMap((line) => line.runs)) {
    if (!run.text.trim() || run.sourceSequenceIndex === undefined) continue
    sourceSequenceCounts.set(
      run.sourceSequenceIndex,
      (sourceSequenceCounts.get(run.sourceSequenceIndex) ?? 0) + 1,
    )
  }
  const proposals = lines.flatMap((line) => {
    const predecessors = lines.filter((previous) =>
      sourceProvenSpanningInlineMathContinuation(
        previous,
        line,
        sourceSequenceCounts,
      ),
    )
    return predecessors.length === 1
      ? [{ previous: predecessors[0], line }]
      : []
  })
  const predecessorClaims = new Map<ClassifiedLine, number>()
  const continuationClaims = new Map<ClassifiedLine, number>()
  for (const proposal of proposals) {
    predecessorClaims.set(
      proposal.previous,
      (predecessorClaims.get(proposal.previous) ?? 0) + 1,
    )
    continuationClaims.set(
      proposal.line,
      (continuationClaims.get(proposal.line) ?? 0) + 1,
    )
  }
  for (const proposal of proposals) {
    if (
      predecessorClaims.get(proposal.previous) !== 1 ||
      continuationClaims.get(proposal.line) !== 1
    ) {
      continue
    }
    proposal.line.kind = 'spanning'
    proposal.line.column = 'span'
  }
}

function hasEmphasizedFace(line: ClassifiedLine) {
  return line.runs.some(
    (run) =>
      run.bold === true ||
      /(?:bold|semibold|demi|medi(?:um)?|black)/i.test(run.fontName) ||
      /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ) ||
      /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ),
  )
}

function emphasizedFaceShare(line: ClassifiedLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  const visibleCharacters = visibleRuns.reduce(
    (total, run) => total + run.text.replace(/\s/gu, '').length,
    0,
  )
  const emphasizedCharacters = visibleRuns.reduce(
    (total, run) =>
      total +
      (run.bold === true ||
      /(?:bold|semibold|demi|medi(?:um)?|black)/i.test(run.fontName) ||
      /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ) ||
      /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
        run.fontName,
      )
        ? run.text.replace(/\s/gu, '').length
        : 0),
    0,
  )
  return visibleCharacters > 0 ? emphasizedCharacters / visibleCharacters : 0
}

function markWrappedHeadingContinuations(lines: ClassifiedLine[]) {
  const claimed = new Set<string>()
  const seeds = lines
    .filter(
      (line) =>
        line.kind === 'body' &&
        standaloneSectionHeading(line) &&
        hasEmphasizedFace(line) &&
        /^(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
          line.text.trim(),
        ),
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)
  for (const seed of seeds) {
    const sameBaselineCrossGutterCandidates = lines.filter((candidate) => {
      if (
        candidate === seed ||
        claimed.has(candidate.id) ||
        candidate.page !== seed.page ||
        seed.column !== 'left' ||
        candidate.column !== 'right' ||
        candidate.kind !== 'body' ||
        !hasEmphasizedFace(candidate) ||
        !/[:–—-]$/u.test(seed.text.trim())
      ) {
        return false
      }
      const fontRatio =
        Math.max(seed.fontSize, candidate.fontSize) /
        Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
      const horizontalGap = candidate.x - (seed.x + seed.width)
      const text = candidate.text.replace(/\s+/gu, ' ').trim()
      return (
        Math.abs(candidate.y - seed.y) <=
          Math.max(0.004, Math.max(seed.height, candidate.height) * 0.4) &&
        candidate.x > seed.x + Math.min(0.12, seed.width * 0.5) &&
        horizontalGap >= -0.03 &&
        horizontalGap <= 0.18 &&
        fontRatio <= 1.05 &&
        text.length <= 72 &&
        /^\p{Lu}[\p{L}\p{N}'’&/(),:–—\s-]*$/u.test(text) &&
        !/(?:https?:\/\/|www\.|\S*[_@]\S*)/iu.test(text)
      )
    })
    if (sameBaselineCrossGutterCandidates.length === 1) {
      const candidate = sameBaselineCrossGutterCandidates[0]
      candidate.headingContinuationSeedId = seed.id
      claimed.add(candidate.id)
    }
    const candidates = lines.filter((candidate) => {
      if (
        candidate === seed ||
        claimed.has(candidate.id) ||
        candidate.page !== seed.page ||
        candidate.column !== seed.column ||
        candidate.kind !== 'body' ||
        !hasEmphasizedFace(candidate)
      ) {
        return false
      }
      const gap = candidate.y - (seed.y + seed.height)
      const fontRatio =
        Math.max(seed.fontSize, candidate.fontSize) /
        Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
      const text = candidate.text.replace(/\s+/gu, ' ').trim()
      const continuesDiscretionaryHyphen =
        /\p{L}-$/u.test(seed.text.trim()) && /^\p{Ll}/u.test(text)
      const beginsOrdinaryHeadingWrap = /^\p{Lu}/u.test(text)
      const continuesFullyEmphasizedLowercaseWrap =
        /^\p{Ll}/u.test(text) &&
        emphasizedFaceShare(candidate) >= 0.9 &&
        (text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 8
      return (
        gap >= -0.002 &&
        gap <= Math.max(0.007, seed.height * 0.55) &&
        candidate.x - seed.x >= 0.015 &&
        candidate.x - seed.x <= 0.08 &&
        fontRatio <= 1.05 &&
        text.length <= 72 &&
        (continuesDiscretionaryHyphen ||
          beginsOrdinaryHeadingWrap ||
          continuesFullyEmphasizedLowercaseWrap) &&
        /^[\p{L}\p{N}][\p{L}\p{N}'’&/(),:–—\s-]*$/u.test(text) &&
        !/[.!?][”’'"\])}]*$/u.test(text) &&
        !/(?:https?:\/\/|www\.|\S*[_@]\S*)/iu.test(text)
      )
    })
    if (candidates.length !== 1) continue
    candidates[0].headingContinuationSeedId = seed.id
    claimed.add(candidates[0].id)
  }
}

function repairCrossGutterHeadingPrefixes(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  const split = layout.split
  if (split === null) return lines
  const consumed = new Set<ClassifiedLine>()
  for (const prefix of lines) {
    const prefixText = prefix.text.trim()
    if (
      prefix.kind !== 'body' ||
      prefix.column !== 'left' ||
      !/^\d{1,3}$/u.test(prefixText) ||
      !hasEmphasizedFace(prefix)
    ) {
      continue
    }
    const prefixRight = prefix.x + prefix.width
    if (Math.abs(prefixRight - split) > 0.04) continue
    const candidates = lines
      .filter((candidate) => {
        const text = candidate.text.replace(/\s+/g, ' ').trim()
        const baselineTolerance = Math.max(
          0.003,
          Math.min(prefix.height, candidate.height) * 0.25,
        )
        const gap = candidate.x - prefixRight
        const fontRatio =
          Math.max(prefix.fontSize, candidate.fontSize) /
          Math.max(1, Math.min(prefix.fontSize, candidate.fontSize))
        return (
          candidate !== prefix &&
          candidate.page === prefix.page &&
          candidate.kind === 'body' &&
          candidate.column === 'right' &&
          hasEmphasizedFace(candidate) &&
          Math.abs(candidate.y - prefix.y) <= baselineTolerance &&
          gap >= 0 &&
          gap <= 0.06 &&
          candidate.x - split <= 0.08 &&
          fontRatio <= 1.08 &&
          text.length <= 80 &&
          /^\p{Lu}[\p{L}\p{N}'’&/–—-]*(?:\s+\p{Lu}[\p{L}\p{N}'’&/–—-]*){1,10}$/u.test(
            text,
          )
        )
      })
      .sort(
        (left, right) =>
          left.x - prefixRight - (right.x - prefixRight) || left.x - right.x,
      )
    if (candidates.length !== 1) continue
    const heading = candidates[0]
    const right = Math.max(prefix.x + prefix.width, heading.x + heading.width)
    const bottom = Math.max(
      prefix.y + prefix.height,
      heading.y + heading.height,
    )
    heading.text = `${prefixText} ${heading.text.trim()}`
    heading.x = prefix.x
    heading.y = Math.min(prefix.y, heading.y)
    heading.width = right - heading.x
    heading.height = bottom - heading.y
    heading.fontSize = Math.max(prefix.fontSize, heading.fontSize)
    heading.confidence = Math.min(prefix.confidence, heading.confidence)
    heading.runs = [...prefix.runs, ...heading.runs].sort(
      (left, right) => left.x - right.x,
    )
    consumed.add(prefix)
  }
  return lines.filter((line) => !consumed.has(line))
}

function sourceProvenLexicalHyphenContinuation(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  hardHyphenLexicon: ReadonlySet<string>,
) {
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column
  ) {
    return false
  }
  const left = previous.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = line.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (!left || !right) return false
  const candidate = `${left}-${right}`
    .normalize('NFKC')
    .replace(/[‐‑]/gu, '-')
    .toLocaleLowerCase()
  if (!hardHyphenLexicon.has(candidate)) return false

  const leftEdgeTolerance = Math.max(
    0.012,
    Math.max(previous.height, line.height) * 0.75,
  )
  if (Math.abs(previous.x - line.x) > leftEdgeTolerance) return false
  const previousRight = previous.x + previous.width
  const lineRight = line.x + line.width
  const rightEdgeTolerance = Math.max(
    0.025,
    Math.min(previous.width, line.width) * 0.08,
  )
  return previousRight >= lineRight - rightEdgeTolerance
}

function sourceProvenDetachedDisplayEquationAtomHost(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  lines: readonly ClassifiedLine[],
): ClassifiedLine | null {
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column ||
    line.kind !== 'body'
  ) {
    return null
  }
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  if (visibleRuns.length !== 1) return null
  const atom = visibleRuns[0]
  const atomText = atom.text.replace(/\s+/gu, '')
  if (
    atom.sourceSequenceIndex === undefined ||
    !/^[\p{L}\p{N}]{1,3}$/u.test(atomText) ||
    (!emphasizedSourceRun(atom) &&
      !/(?:math|cmmi|cmsy|msbm|symbol)/iu.test(atom.fontName))
  ) {
    return null
  }

  const atomCenterX = line.x + line.width / 2
  const atomCenterY = line.y + line.height / 2
  const nearbyEquationLines = lines.filter((candidate) => {
    if (
      candidate === line ||
      candidate.page !== line.page ||
      candidate.column !== line.column ||
      candidate.kind !== 'equation'
    ) {
      return false
    }
    const centerY = candidate.y + candidate.height / 2
    const horizontalGap = Math.max(
      candidate.x - (line.x + line.width),
      line.x - (candidate.x + candidate.width),
      0,
    )
    return (
      Math.abs(centerY - atomCenterY) <= Math.max(0.04, line.height * 3) &&
      horizontalGap <= Math.max(0.08, line.height * 6)
    )
  })
  const nearbyEquationRuns = nearbyEquationLines.flatMap((candidate) =>
    candidate.runs.filter(
      (run) =>
        run.text.trim() &&
        run.sourceSequenceIndex !== undefined &&
        run.page === atom.page &&
        run.rotation === atom.rotation &&
        run.method === atom.method,
    ),
  )
  const precedingEquationIndexes = nearbyEquationRuns
    .map((run) => run.sourceSequenceIndex!)
    .filter(
      (sourceSequenceIndex) => sourceSequenceIndex < atom.sourceSequenceIndex!,
    )
  const followingEquationIndexes = nearbyEquationRuns
    .map((run) => run.sourceSequenceIndex!)
    .filter(
      (sourceSequenceIndex) => sourceSequenceIndex > atom.sourceSequenceIndex!,
    )
  if (
    precedingEquationIndexes.length === 0 ||
    followingEquationIndexes.length === 0 ||
    atom.sourceSequenceIndex - Math.max(...precedingEquationIndexes) > 4 ||
    Math.min(...followingEquationIndexes) - atom.sourceSequenceIndex > 4
  ) {
    return null
  }

  const stackedHosts = nearbyEquationLines
    .flatMap((candidate) => {
      const baselineBands: PdfSourceRun[][] = []
      for (const run of candidate.runs
        .filter((candidateRun) => candidateRun.text.trim())
        .sort(
          (left, right) =>
            left.y + left.height / 2 - (right.y + right.height / 2) ||
            left.x - right.x,
        )) {
        const centerY = run.y + run.height / 2
        const band = baselineBands.find((candidateBand) => {
          const bandCenterY = median(
            candidateBand.map(
              (candidateRun) => candidateRun.y + candidateRun.height / 2,
            ),
          )
          const bandHeight = Math.max(
            ...candidateBand.map((candidateRun) => candidateRun.height),
          )
          return (
            Math.abs(centerY - bandCenterY) <=
            Math.max(0.0025, Math.min(run.height, bandHeight) * 0.45)
          )
        })
        if (band) band.push(run)
        else baselineBands.push([run])
      }
      return baselineBands.map((runs) => {
        const x = Math.min(...runs.map((run) => run.x))
        const y = Math.min(...runs.map((run) => run.y))
        const right = Math.max(...runs.map((run) => run.x + run.width))
        const bottom = Math.max(...runs.map((run) => run.y + run.height))
        return {
          line: candidate,
          runs,
          x,
          y,
          width: right - x,
          height: bottom - y,
        }
      })
    })
    .filter((candidate) => {
      if (
        candidate.runs.length === 0 ||
        !candidate.runs.some(
          (run) =>
            run.sourceSequenceIndex !== undefined &&
            Math.abs(run.sourceSequenceIndex - atom.sourceSequenceIndex!) <=
              4 &&
            run.page === atom.page &&
            run.rotation === atom.rotation &&
            run.method === atom.method,
        )
      ) {
        return false
      }
      const overlap = Math.max(
        0,
        Math.min(line.x + line.width, candidate.x + candidate.width) -
          Math.max(line.x, candidate.x),
      )
      const minimumWidth = Math.min(line.width, candidate.width)
      const candidateCenterX = candidate.x + candidate.width / 2
      const candidateCenterY = candidate.y + candidate.height / 2
      const minimumHeight = Math.min(line.height, candidate.height)
      const verticalGap = Math.max(
        line.y - (candidate.y + candidate.height),
        candidate.y - (line.y + line.height),
        0,
      )
      return (
        minimumWidth > 0 &&
        overlap >= minimumWidth * 0.8 &&
        Math.abs(atomCenterX - candidateCenterX) <=
          Math.max(0.006, minimumWidth * 0.2) &&
        Math.abs(atomCenterY - candidateCenterY) >=
          Math.max(0.004, minimumHeight * 0.75) &&
        verticalGap <= Math.max(0.018, minimumHeight * 1.4)
      )
    })
  return stackedHosts.length === 1 ? stackedHosts[0].line : null
}

function visibleSourceSequenceIndexes(line: PdfTextLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  return sourceSequenceIndexes.length === visibleRuns.length
    ? sourceSequenceIndexes
    : null
}

function sourceProvenMultiComponentDisplayCluster(
  anchor: ClassifiedLine,
  lines: readonly ClassifiedLine[],
): ClassifiedLine[] | null {
  if (
    anchor.kind !== 'equation' ||
    !/(?:=|≤|≥|≈|≠)/u.test(anchor.text) ||
    proseDominantInlineMathLine(anchor)
  ) {
    return null
  }
  const anchorRuns = anchor.runs.filter((run) => run.text.trim())
  const anchorSequenceIndexes = visibleSourceSequenceIndexes(anchor)
  if (
    anchorRuns.length === 0 ||
    !anchorSequenceIndexes ||
    new Set(anchorSequenceIndexes).size !== anchorSequenceIndexes.length
  ) {
    return null
  }
  const anchorSource = anchorRuns[0]
  const anchorStart = Math.min(...anchorSequenceIndexes)
  const anchorEnd = Math.max(...anchorSequenceIndexes)
  const anchorCenterY = anchor.y + anchor.height / 2
  const equationNumberCandidates = lines.filter((candidate) => {
    if (
      candidate === anchor ||
      candidate.page !== anchor.page ||
      !/^\(\s*\d+(?:\.\d+)*\s*\)$/u.test(candidate.text.trim()) ||
      candidate.x < anchor.x + anchor.width ||
      Math.abs(candidate.y + candidate.height / 2 - anchorCenterY) >
        Math.max(0.05, anchor.height * 4)
    ) {
      return false
    }
    const runs = candidate.runs.filter((run) => run.text.trim())
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)
    return (
      runs.length > 0 &&
      sequenceIndexes !== null &&
      Math.min(...sequenceIndexes) > anchorEnd &&
      Math.min(...sequenceIndexes) - anchorEnd <= 128 &&
      runs.every(
        (run) =>
          run.page === anchorSource.page &&
          run.rotation === anchorSource.rotation &&
          run.method === anchorSource.method,
      )
    )
  })
  if (equationNumberCandidates.length !== 1) return null
  const equationNumber = equationNumberCandidates[0]
  const equationNumberSequenceIndexes =
    visibleSourceSequenceIndexes(equationNumber)!
  const sequenceEnd = Math.max(...equationNumberSequenceIndexes)
  const corridorLeft = anchor.x - Math.max(0.025, anchor.height * 2)
  const corridorRight =
    equationNumber.x +
    equationNumber.width +
    Math.max(0.015, equationNumber.height)
  const corridorTop = anchor.y - Math.max(0.045, anchor.height * 3.5)
  const corridorBottom =
    anchor.y + anchor.height + Math.max(0.065, anchor.height * 5)
  const sequenceIntersectingLines = lines.filter((candidate) => {
    if (candidate.page !== anchor.page) return false
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)
    return (
      sequenceIndexes !== null &&
      sequenceIndexes.some(
        (sourceSequenceIndex) =>
          sourceSequenceIndex >= anchorStart &&
          sourceSequenceIndex <= sequenceEnd,
      )
    )
  })
  const members = sequenceIntersectingLines.filter((candidate) => {
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)!
    const visibleRuns = candidate.runs.filter((run) => run.text.trim())
    return (
      sequenceIndexes.every(
        (sourceSequenceIndex) =>
          sourceSequenceIndex >= anchorStart &&
          sourceSequenceIndex <= sequenceEnd,
      ) &&
      candidate.x >= corridorLeft &&
      candidate.x + candidate.width <= corridorRight &&
      candidate.y >= corridorTop &&
      candidate.y + candidate.height <= corridorBottom &&
      visibleRuns.every(
        (run) =>
          run.page === anchorSource.page &&
          run.rotation === anchorSource.rotation &&
          run.method === anchorSource.method,
      )
    )
  })
  if (
    members.length < 8 ||
    members.length !== sequenceIntersectingLines.length ||
    !members.includes(anchor) ||
    !members.includes(equationNumber)
  ) {
    return null
  }
  const allSequenceIndexes = members
    .flatMap((member) => visibleSourceSequenceIndexes(member)!)
    .sort((left, right) => left - right)
  if (
    new Set(allSequenceIndexes).size !== allSequenceIndexes.length ||
    allSequenceIndexes[0] !== anchorStart ||
    allSequenceIndexes.at(-1) !== sequenceEnd ||
    allSequenceIndexes
      .slice(1)
      .some(
        (sourceSequenceIndex, index) =>
          sourceSequenceIndex - allSequenceIndexes[index] > 4,
      )
  ) {
    return null
  }

  const numericNumerators = members.filter((candidate) => {
    if (!/^[+-]?\d+(?:[.,]\d+)?$/u.test(candidate.text.trim())) return false
    return candidate.y + candidate.height / 2 < anchorCenterY
  })
  const extensionFont = (fontName: string) =>
    /(?:CMEX|MathExtensions?)/iu.test(fontName)
  const mathFont = (fontName: string) =>
    /(?:cmmi|cmsy|cmex|math|symbol)/iu.test(fontName)
  const denominatorHosts = new Set<ClassifiedLine>()
  for (const numerator of numericNumerators) {
    const numeratorSequenceIndexes = visibleSourceSequenceIndexes(numerator)!
    const numeratorEnd = Math.max(...numeratorSequenceIndexes)
    const numeratorCenterX = numerator.x + numerator.width / 2
    const denominatorCandidates = members.filter((candidate) => {
      if (candidate === numerator || denominatorHosts.has(candidate)) {
        return false
      }
      return candidate.runs.some((run) => {
        if (
          !run.text.trim() ||
          run.sourceSequenceIndex === undefined ||
          run.sourceSequenceIndex <= numeratorEnd ||
          extensionFont(run.fontName) ||
          !mathFont(run.fontName)
        ) {
          return false
        }
        const runCenterX = run.x + run.width / 2
        const runCenterY = run.y + run.height / 2
        return (
          runCenterY - (numerator.y + numerator.height / 2) >= 0.004 &&
          runCenterY - (numerator.y + numerator.height / 2) <=
            Math.max(0.04, numerator.height * 3) &&
          Math.abs(runCenterX - numeratorCenterX) <=
            Math.max(0.035, numerator.width * 0.9)
        )
      })
    })
    if (denominatorCandidates.length === 1) {
      denominatorHosts.add(denominatorCandidates[0])
    }
  }
  const extensionRuns = members.flatMap((member) =>
    member.runs.filter((run) => run.text.trim() && extensionFont(run.fontName)),
  )
  if (
    numericNumerators.length < 2 ||
    denominatorHosts.size < 2 ||
    extensionRuns.length < 3
  ) {
    return null
  }
  return members
}

function promoteSourceProvenMultiComponentDisplayClusters(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  const resolvedColumnAuthority =
    layout.accepted &&
    !layout.ambiguous &&
    layout.resolution?.status === 'resolved'
  const proposals = lines.flatMap((anchor) => {
    const members = sourceProvenMultiComponentDisplayCluster(anchor, lines)
    return members &&
      (!resolvedColumnAuthority ||
        members.every((member) => member.column === anchor.column))
      ? [{ anchor, members }]
      : []
  })
  const accepted = proposals.filter(
    (proposal) =>
      !proposals.some(
        (candidate) =>
          candidate !== proposal &&
          candidate.members.some((member) => proposal.members.includes(member)),
      ),
  )
  for (const { anchor, members } of accepted) {
    const seedId = `${anchor.id}-source-bounded-display-cluster`
    for (const member of members) {
      member.kind = 'equation'
      member.confidence = Math.max(member.confidence, 0.98)
      member.displayEquationClusterSeedId = seedId
    }
  }
}

function joinsRegion(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  hardHyphenLexicon: ReadonlySet<string>,
) {
  if (previous.page !== line.page) return false
  if (
    unresolvedMathExtensionLine(previous) ||
    unresolvedMathExtensionLine(line)
  ) {
    return false
  }
  if (previous.kind !== line.kind || previous.column !== line.column)
    return false
  if (previous.tabularGridBandId || line.tabularGridBandId) {
    return (
      previous.tabularGridBandId !== undefined &&
      previous.tabularGridBandId === line.tabularGridBandId
    )
  }
  const standaloneListMarker = (text: string) =>
    /^(?:\d{1,3}|[A-Za-z]|[ivxlcdm]+)[.)]$/iu.test(text.trim())
  if (line.kind !== 'caption' && standaloneListMarker(line.text)) {
    return false
  }
  if (
    previous.kind !== 'caption' &&
    standaloneListMarker(previous.text) &&
    line.x > previous.x + previous.width &&
    line.x - (previous.x + previous.width) <= 0.12 &&
    Math.abs(line.y - previous.y) <=
      Math.max(0.004, Math.max(previous.height, line.height) * 0.4)
  ) {
    return true
  }
  if (previous.headingContinuationSeedId) return false
  if (line.kind === 'caption' && beginsVisualCaption(line.text)) return false
  if (standaloneSectionHeading(previous) || standaloneSectionHeading(line)) {
    return false
  }
  if (
    (line.kind === 'footnote' || line.kind === 'endnote') &&
    line.noteLabel !== null
  ) {
    return false
  }
  if (line.kind === 'chart-label' || line.kind === 'page-number') return false
  // A printed display-equation number is often emitted as a standalone line at
  // the right edge of a column.  Do not merge it into the prose explanation
  // that begins below and to its left: the visual pass needs the detached
  // fragment so it can attach the number to the aligned equation instead of
  // layout interpreting `(4) where ...` as an ordered-list item.
  if (
    /^\(\s*\d+[a-z]?\s*\)$/iu.test(previous.text.trim()) &&
    line.x + Math.max(0.08, line.width * 0.2) < previous.x
  ) {
    return false
  }
  if (
    previous.page === 1 &&
    previous.y < 0.3 &&
    /(?:,|\s(?:and|&)\s)/i.test(previous.text) &&
    /(?:university|institute|department|laborator(?:y|ies)|\blab\b|school|college|centre|center|hospital|academy|research group)/i.test(
      line.text,
    )
  ) {
    return false
  }
  const listItem =
    /^(?:[•◦▪‣–—-]|\[\s*\d+\s*\]|\(\s*(?:\d+|[A-Za-z]|[ivxlcdm]+)\s*\)|(?:\d+|[A-Za-z]|[ivxlcdm]+)[.)])\s+/iu
  if (
    line.kind !== 'caption' &&
    listItem.test(line.text.trim()) &&
    !sourceProvenLexicalHyphenContinuation(previous, line, hardHyphenLexicon)
  ) {
    return false
  }
  if (sourceProvenDominantBaselineSequentialWrap(previous, line)) {
    return true
  }
  const gap = line.y - (previous.y + previous.height)
  const fontRatio =
    Math.max(previous.fontSize, line.fontSize) /
    Math.max(1, Math.min(previous.fontSize, line.fontSize))
  if (gap < -0.004 || fontRatio > 1.18) return false
  // Scripts legitimately expand the source-backed line envelope, but they do
  // not expand the body leading that decides whether the next baseline starts
  // a new paragraph. Using the full union here can merge separate paragraphs
  // whenever a subscript or superscript reaches toward the following line.
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  return gap <= Math.max(0.014, lineHeight * 1.25)
}

function beginsRepeatedFirstLineIndent(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length < 2) return false
  const first = group[0]
  const previous = group.at(-1)!
  if (
    line.page !== first.page ||
    line.kind !== first.kind ||
    line.column !== first.column
  ) {
    return false
  }
  const continuationX = median(group.slice(1).map((candidate) => candidate.x))
  const indent = first.x - continuationX
  const tolerance = Math.max(0.007, first.height * 0.45)
  return (
    Math.abs(indent) >= Math.max(0.012, first.height * 0.75) &&
    Math.abs(line.x - first.x) <= tolerance &&
    Math.abs(previous.x - continuationX) <= tolerance
  )
}

function endsProseSentence(line: ClassifiedLine) {
  return /[.!?](?:["'’”\])}]*)$/u.test(line.text.trim())
}

function beginsUppercaseProse(line: ClassifiedLine) {
  return /^\p{Lu}/u.test(line.text.trim())
}

function beginsIndentedParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length < 2 || !beginsUppercaseProse(line)) return false
  const previous = group.at(-1)!
  if (!endsProseSentence(previous)) return false
  const continuationX = median(
    group.slice(-Math.min(5, group.length)).map((candidate) => candidate.x),
  )
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  return line.x - continuationX >= Math.max(0.012, lineHeight * 0.75)
}

function runUsesEmphasizedOrItalicFace(run: ClassifiedLine['runs'][number]) {
  return (
    run.bold === true ||
    run.italic === true ||
    /(?:bold|semibold|demi|medi(?:um)?|black|italic|ital|oblique)/iu.test(
      run.fontName,
    ) ||
    /(?:^|[+,._\s-])cm(?:bx|b|ti|it|sl)\d*(?=$|[+,._\s-])/iu.test(run.fontName)
  )
}

function beginsStyledRunInParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length === 0 || !beginsUppercaseProse(line)) return false
  const previous = group.at(-1)!
  if (!endsProseSentence(previous)) return false
  const visibleRuns = [...line.runs]
    .filter((run) => run.text.trim())
    .sort((left, right) => left.x - right.x)
  if (
    visibleRuns.length === 0 ||
    !runUsesEmphasizedOrItalicFace(visibleRuns[0])
  ) {
    return false
  }
  const styledRunIn =
    visibleRuns.length > 1 &&
    visibleRuns.slice(1).some((run) => !runUsesEmphasizedOrItalicFace(run))
  const continuationX = median(
    group.slice(-Math.min(5, group.length)).map((candidate) => candidate.x),
  )
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  const visiblyIndented =
    line.x - continuationX >= Math.max(0.012, lineHeight * 0.75)
  return styledRunIn || visiblyIndented
}

function beginsBlankLeadingParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length === 0) return false
  const previous = group.at(-1)!
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column ||
    !['body', 'spanning'].includes(line.kind)
  ) {
    return false
  }
  const gap = line.y - (previous.y + previous.height)
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  if (
    !endsProseSentence(previous) ||
    (/:\s*$/u.test(line.text.trim()) &&
      (line.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 8)
  ) {
    return false
  }
  const priorGaps = group
    .slice(1)
    .map((candidate, index) => {
      const prior = group[index]
      return candidate.y - (prior.y + prior.height)
    })
    .filter(
      (candidateGap) =>
        candidateGap >= -0.002 && candidateGap <= lineHeight * 0.55,
    )
  if (priorGaps.length === 0) return false
  const threshold = Math.max(
    0.006,
    median(priorGaps) + lineHeight * 0.35,
    lineHeight * 0.5,
  )
  return gap >= threshold
}

function beginsParagraphBoundary(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  return (
    beginsRepeatedFirstLineIndent(group, line) ||
    beginsBlankLeadingParagraph(group, line) ||
    beginsIndentedParagraph(group, line) ||
    beginsStyledRunInParagraph(group, line)
  )
}

function makeRegions(
  lines: ClassifiedLine[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  lineBoundaryDecisions: PdfLineBoundaryDecision[],
) {
  const groups: ClassifiedLine[][] = []
  const detachedDisplayEquationAtomHosts = new Map<
    ClassifiedLine,
    ClassifiedLine
  >()
  const displayEquationClusterGroups = new Map<string, ClassifiedLine[]>()
  const ordered = [...lines].sort((left, right) => {
    if (left.page !== right.page) return left.page - right.page
    const columnOrder = left.column.localeCompare(right.column)
    if (columnOrder !== 0) return columnOrder
    return sourceLineFlowOrder(left, right)
  })
  for (const line of ordered) {
    if (line.displayEquationClusterSeedId) {
      const clusterGroup = displayEquationClusterGroups.get(
        line.displayEquationClusterSeedId,
      )
      if (clusterGroup) clusterGroup.push(line)
      else {
        const group = [line]
        groups.push(group)
        displayEquationClusterGroups.set(
          line.displayEquationClusterSeedId,
          group,
        )
      }
      continue
    }
    const headingGroup = line.headingContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.headingContinuationSeedId,
          ),
        )
      : undefined
    if (headingGroup) {
      headingGroup.push(line)
      continue
    }
    const captionGroup = line.captionContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.captionContinuationSeedId,
          ),
        )
      : undefined
    if (captionGroup) {
      captionGroup.push(line)
      continue
    }
    const panelLabelGroup = line.panelLabelContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.panelLabelContinuationSeedId,
          ),
        )
      : undefined
    if (panelLabelGroup) {
      panelLabelGroup.push(line)
      continue
    }
    const previousGroup = groups.at(-1)
    const previous = previousGroup?.at(-1)
    const paragraphBoundary = previous
      ? beginsParagraphBoundary(previousGroup!, line)
      : false
    const detachedDisplayEquationAtomHost =
      previous && !paragraphBoundary
        ? sourceProvenDetachedDisplayEquationAtomHost(previous, line, ordered)
        : null
    if (detachedDisplayEquationAtomHost) {
      detachedDisplayEquationAtomHosts.set(
        line,
        detachedDisplayEquationAtomHost,
      )
    }
    if (
      previous &&
      !paragraphBoundary &&
      !detachedDisplayEquationAtomHost &&
      joinsRegion(previous, line, hardHyphenLexicon)
    )
      previousGroup!.push(line)
    else groups.push([line])
  }

  for (const [atom, host] of detachedDisplayEquationAtomHosts.entries()) {
    const atomGroup = groups.find((group) => group.includes(atom))
    const hostGroup = groups.find((group) => group.includes(host))
    if (!atomGroup || !hostGroup || atomGroup === hostGroup) continue
    // The atom boundary was proved before grouping, but move it only while it
    // remains a standalone region. Any later claimant makes the ownership
    // ambiguous and must leave the atom visible for review.
    if (atomGroup.length !== 1) continue
    const hostIndex = hostGroup.indexOf(host)
    if (hostIndex < 0) continue
    atom.kind = 'equation'
    atom.confidence = Math.max(atom.confidence, 0.98)
    hostGroup.splice(hostIndex, 0, atom)
    groups.splice(groups.indexOf(atomGroup), 1)
  }

  const sourceOrderedGroups = groups.sort((left, right) =>
    sourceLineFlowOrder(left[0], right[0]),
  )
  const pageCounters = new Map<number, number>()
  return sourceOrderedGroups.map<PdfPageRegion>((group) => {
    const page = group[0].page
    const number = (pageCounters.get(page) ?? 0) + 1
    pageCounters.set(page, number)
    const id = `page-${String(page).padStart(3, '0')}-region-${String(number).padStart(3, '0')}`
    const orderedGroup = group[0].tabularGridBandId
      ? [...group].sort((left, right) => left.x - right.x || left.y - right.y)
      : group[0].displayEquationClusterSeedId
        ? [...group].sort((left, right) => {
            const leftSequenceIndexes = visibleSourceSequenceIndexes(left) ?? []
            const rightSequenceIndexes =
              visibleSourceSequenceIndexes(right) ?? []
            return (
              Math.min(...leftSequenceIndexes) -
                Math.min(...rightSequenceIndexes) ||
              sourceLineFlowOrder(left, right)
            )
          })
        : group.some((line) => line.headingContinuationSeedId)
          ? [...group].sort(
              (left, right) => left.y - right.y || left.x - right.x,
            )
          : group
    const regionLines = orderedGroup.map<PdfRegionLine>((line) => {
      const visibleRuns = line.runs.filter((run) => run.text.trim())
      const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
        run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
      )
      const sourceFragmentLineage =
        line.sourceFragmentLineage ??
        (sourceSequenceIndexes.length === visibleRuns.length &&
        new Set(sourceSequenceIndexes).size === sourceSequenceIndexes.length
          ? {
              algorithm: 'source-run-fragment-v1' as const,
              sourceLineId: line.id,
              fragment: 'whole' as const,
              sourceSequenceIndexes,
            }
          : undefined)
      const regionLine = {
        id: line.id,
        text: line.text,
        fontSize: rounded(line.fontSize),
        box: lineBox(line),
        runs: line.runs.map((run) => ({ ...run })),
        ...(line.captionContinuationSeedId
          ? {
              captionContinuationSeedId: line.captionContinuationSeedId,
            }
          : {}),
        ...(sourceFragmentLineage ? { sourceFragmentLineage } : {}),
      }
      copyPdfLinkedTokenSourceAnnotations(line, regionLine)
      return regionLine
    })
    const kind = orderedGroup[0].kind
    const furnitureEvidence = orderedGroup.find(
      (line) => line.furniture,
    )?.furniture
    const furnitureReview = orderedGroup.find(
      (line) => line.furnitureReview,
    )?.furnitureReview
    const sourceCaptionLaneBoundary = orderedGroup[0].sourceCaptionLaneBoundary
    const sourceCaptionLaneSide = orderedGroup[0].sourceCaptionLaneSide
    const sourceCaptionLane =
      sourceCaptionLaneBoundary !== undefined &&
      sourceCaptionLaneSide !== undefined &&
      orderedGroup.every(
        (line) =>
          line.sourceCaptionLaneBoundary === sourceCaptionLaneBoundary &&
          line.sourceCaptionLaneSide === sourceCaptionLaneSide,
      )
        ? {
            boundary: rounded(sourceCaptionLaneBoundary),
            side: sourceCaptionLaneSide,
          }
        : null
    return {
      id,
      page,
      kind,
      column: orderedGroup[0].column,
      text: joinPdfLineTexts(orderedGroup, {
        hardHyphenLexicon,
        unhyphenatedLexicon,
        language,
        regionId: id,
        decisions: lineBoundaryDecisions,
      }),
      confidence: rounded(
        Math.min(...orderedGroup.map((line) => line.confidence)),
      ),
      box: unionBox(regionLines),
      lines: regionLines,
      nativeObjectIds: [],
      includedInReadingOrder: ![
        'header',
        'footer',
        'page-number',
        'side',
        'chart-label',
      ].includes(kind),
      ...(furnitureEvidence ? { furniture: furnitureEvidence } : {}),
      ...(furnitureReview ? { furnitureReview } : {}),
      ...(sourceCaptionLane ? { sourceCaptionLane } : {}),
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

function columnOrdered(regions: PdfPageRegion[]) {
  const readingAnchor = (region: PdfPageRegion) => {
    const firstSourceLine = [...region.lines]
      .filter((line) => line.text.trim())
      .sort(
        (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
      )[0]
    return firstSourceLine?.box ?? region.box
  }
  const byY = (left: PdfPageRegion, right: PdfPageRegion) => {
    const splitDefinitionOrder = splitNoteDefinitionOrder(left, right)
    const leftAnchor = readingAnchor(left)
    const rightAnchor = readingAnchor(right)
    const inlineOrder = inlineStackedFragmentOrder(
      left.lines[0] ?? { id: undefined },
      right.lines[0] ?? { id: undefined },
    )
    return (
      splitDefinitionOrder ??
      inlineOrder ??
      (leftAnchor.y - rightAnchor.y ||
        leftAnchor.x - rightAnchor.x ||
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id))
    )
  }
  return [
    ...regions.filter((region) => region.column === 'left').sort(byY),
    ...regions.filter((region) => region.column === 'right').sort(byY),
    ...regions
      .filter(
        (region) => region.column === 'single' || region.column === 'span',
      )
      .sort(byY),
  ]
}

function orderPageRegions(regions: PdfPageRegion[], layout: ColumnLayout) {
  const included = regions.filter((region) => region.includedInReadingOrder)
  const notes = included.filter(
    (region) => region.kind === 'footnote' || region.kind === 'endnote',
  )
  const flow = included.filter(
    (region) => region.kind !== 'footnote' && region.kind !== 'endnote',
  )
  if (layout.split === null) {
    return restoreInlineStackedAtomicUnits([
      ...flow.sort(
        (left, right) =>
          inlineStackedFragmentOrder(
            left.lines[0] ?? { id: undefined },
            right.lines[0] ?? { id: undefined },
          ) ??
          (left.box.y - right.box.y || left.box.x - right.box.x),
      ),
      ...notes.sort(
        (left, right) =>
          splitNoteDefinitionOrder(left, right) ??
          (left.box.y - right.box.y || left.box.x - right.box.x),
      ),
    ])
  }

  const spanning = flow
    .filter((region) => region.column === 'span')
    .sort((left, right) => left.box.y - right.box.y)
  const columnFlow = flow.filter((region) => region.column !== 'span')
  const ordered: PdfPageRegion[] = []
  const emitted = new Set<string>()
  for (const span of spanning) {
    const band = columnFlow.filter(
      (region) => !emitted.has(region.id) && region.box.y < span.box.y,
    )
    ordered.push(...columnOrdered(band), span)
    for (const region of band) emitted.add(region.id)
  }
  ordered.push(
    ...columnOrdered(columnFlow.filter((region) => !emitted.has(region.id))),
    ...columnOrdered(notes),
  )
  return restoreInlineStackedAtomicUnits(ordered)
}

function edgeEvidence(from: PdfPageRegion, to: PdfPageRegion) {
  if (from.page !== to.page) {
    return {
      code: 'page-sequence' as const,
      detail: `Page ${from.page} precedes page ${to.page}.`,
    }
  }
  if (to.kind === 'footnote' || to.kind === 'endnote') {
    return {
      code: 'note-after-body' as const,
      detail: 'The separated note region follows the page body flow.',
    }
  }
  if (from.column !== to.column) {
    return {
      code: 'column-flow' as const,
      detail: `${from.column} column flow precedes ${to.column} column flow.`,
    }
  }
  if (
    from.kind === 'spanning' ||
    to.kind === 'spanning' ||
    from.column === 'span' ||
    to.column === 'span'
  ) {
    return {
      code: 'spanning-boundary' as const,
      detail: 'A page-spanning region forms a deterministic flow boundary.',
    }
  }
  return {
    code: 'vertical-flow' as const,
    detail: 'Regions in the same flow follow normalized vertical geometry.',
  }
}

export function hasAcceptedCycle(
  regionIds: string[],
  edges: PdfReadingOrderEdge[],
) {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges.filter(
    (candidate) => candidate.status === 'accepted',
  )) {
    const targets = outgoing.get(edge.from) ?? []
    targets.push(edge.to)
    outgoing.set(edge.from, targets)
  }
  const state = new Map<string, 'visiting' | 'visited'>()
  for (const root of regionIds) {
    if (state.has(root)) continue
    state.set(root, 'visiting')
    const stack = [{ id: root, nextTarget: 0 }]
    while (stack.length > 0) {
      const frame = stack.at(-1)!
      const targets = outgoing.get(frame.id) ?? []
      if (frame.nextTarget >= targets.length) {
        state.set(frame.id, 'visited')
        stack.pop()
        continue
      }
      const target = targets[frame.nextTarget]
      frame.nextTarget += 1
      if (state.get(target) === 'visiting') return true
      if (state.get(target) === 'visited') continue
      state.set(target, 'visiting')
      stack.push({ id: target, nextTarget: 0 })
    }
  }
  return false
}

function buildReadingOrder(
  regions: PdfPageRegion[],
  layouts: Map<number, ColumnLayout>,
) {
  const orderedRegions = [...layouts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([page, layout]) =>
      orderPageRegions(
        regions.filter((region) => region.page === page),
        layout,
      ),
    )
  const edges: PdfReadingOrderEdge[] = []
  for (let index = 0; index < orderedRegions.length - 1; index += 1) {
    const from = orderedRegions[index]
    const to = orderedRegions[index + 1]
    const layout = layouts.get(from.page)
    const crossColumnBoundary =
      from.page === to.page && from.column === 'left' && to.column === 'right'
    const ambiguousBoundary = crossColumnBoundary && Boolean(layout?.ambiguous)
    const resolvedBoundary =
      crossColumnBoundary && layout?.resolution?.status === 'resolved'
    edges.push({
      id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
      from: from.id,
      to: to.id,
      status: ambiguousBoundary ? 'candidate' : 'accepted',
      confidence:
        ambiguousBoundary || resolvedBoundary
          ? (layout?.resolution?.confidence ?? 0.5)
          : 0.96,
      evidence: ambiguousBoundary
        ? [
            ...(layout?.resolution?.evidence ?? []),
            {
              code: 'ambiguous-column-flow',
              detail: `Both column orders remain candidates because confidence ${layout?.resolution?.confidence ?? 0.5} is below threshold ${READING_ORDER_RESOLUTION_THRESHOLD}.`,
            },
          ]
        : resolvedBoundary
          ? [...layout.resolution!.evidence, edgeEvidence(from, to)]
          : [edgeEvidence(from, to)],
      sourceBoxes: [from.box, to.box],
    })
    if (ambiguousBoundary) {
      const rightRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'right',
      )
      const leftRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'left',
      )
      const reverseFrom = rightRegions.at(-1)
      const reverseTo = leftRegions[0]
      if (reverseFrom && reverseTo) {
        edges.push({
          id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
          from: reverseFrom.id,
          to: reverseTo.id,
          status: 'candidate',
          confidence: layout?.resolution?.confidence ?? 0.5,
          evidence: [
            ...(layout?.resolution?.evidence ?? []),
            {
              code: 'ambiguous-column-flow',
              detail: `The reverse column order is retained for bounded review below threshold ${READING_ORDER_RESOLUTION_THRESHOLD}.`,
            },
          ],
          sourceBoxes: [reverseFrom.box, reverseTo.box],
        })
      }
    }
  }
  const regionIds = regions.map((region) => region.id)
  const resolutions = [...layouts.entries()]
    .filter(
      (
        entry,
      ): entry is [
        number,
        ColumnLayout & { resolution: NonNullable<ColumnLayout['resolution']> },
      ] => entry[1].resolution !== null,
    )
    .map<PdfReadingOrderResolution>(([page, layout]) => ({
      page,
      ...layout.resolution,
      regionIds: regions
        .filter(
          (region) => region.page === page && region.includedInReadingOrder,
        )
        .map((region) => region.id),
    }))
  const acyclic = !hasAcceptedCycle(regionIds, edges)
  const unresolvedEdgeCount = edges.filter(
    (edge) => edge.status === 'candidate',
  ).length
  const evaluation: PdfReadingOrderEvaluation = {
    schemaVersion: '1.0.0',
    algorithm: 'deterministic-geometry-v1',
    mode: 'deterministic-only',
    regionCount: orderedRegions.length,
    acceptedEdgeCount: edges.length - unresolvedEdgeCount,
    unresolvedEdgeCount,
    cycleRate: acyclic ? 0 : 1,
    orderAccuracy: null,
    provider: null,
    modelVersion: null,
    latencyMs: 0,
    costUsd: 0,
    reviewRequired: !acyclic || unresolvedEdgeCount > 0,
  }
  return {
    schemaVersion: '1.0.0',
    regionIds,
    order: orderedRegions.map((region) => region.id),
    edges,
    resolutions,
    acyclic,
    evaluation,
  } satisfies PdfReadingOrderGraph
}

export function evaluateReadingOrder(
  graph: PdfReadingOrderGraph,
  expectedOrder?: readonly string[],
) {
  if (!expectedOrder) return { ...graph.evaluation }
  const expectedPositions = new Map(
    expectedOrder.map((id, index) => [id, index]),
  )
  const comparable = graph.order.filter((id) => expectedPositions.has(id))
  const correct = comparable.filter(
    (id, index) => expectedPositions.get(id) === index,
  ).length
  return {
    ...graph.evaluation,
    orderAccuracy:
      expectedOrder.length === 0
        ? 1
        : rounded(correct / Math.max(expectedOrder.length, graph.order.length)),
  }
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
