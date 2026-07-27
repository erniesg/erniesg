import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderAmbiguityClass,
  PdfReadingOrderEdge,
  PdfReadingOrderEvaluation,
  PdfReadingOrderEvidence,
  PdfReadingOrderGraph,
  PdfReadingOrderResolution,
  PdfRegionColumn,
  PdfRegionKind,
  PdfRegionLine,
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
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import { sanitizeXmlText } from './publication-integrity'

type ClassifiedLine = PdfTextLine & {
  id: string
  kind: PdfRegionKind
  confidence: number
  noteLabel: string | null
  captionContinuationSeedId?: string
  panelLabelContinuationSeedId?: string
  noteContinuationSeedId?: string
  headingContinuationSeedId?: string
  tabularGridBandId?: string
}

type ColumnLayout = {
  split: number | null
  accepted: boolean
  ambiguous: boolean
  resolution: Omit<PdfReadingOrderResolution, 'page' | 'regionIds'> | null
  tabularGridBands?: ReadonlyMap<string, string>
}

const NOTE_LABEL = String.raw`(?:\d{1,3}|[*†‡§])`
export const READING_ORDER_RESOLUTION_POLICY_VERSION = '1.0.0' as const
export const READING_ORDER_RESOLUTION_THRESHOLD = 0.85

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

function normalizeMarginText(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

function beginsVisualCaption(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return (
    Boolean(
      parsePdfScholarlyVisualLabel(normalized, {
        context: 'caption',
      }),
    ) ||
    /^[^.!?;:]{1,72}\s+(?:fig(?:ure)?|table)\.?\s*(?:\d+|[ivxlcdm]+)\s*[.:–—-]\s*\p{Lu}/iu.test(
      normalized,
    )
  )
}

function unpublishableText(text: string) {
  return text.includes('\ufffd') || sanitizeXmlText(text) !== text
}

function unresolvedMathExtensionLine(line: PdfTextLine) {
  return line.runs.some(
    (run) => /CMEX\d*/iu.test(run.fontName) && unpublishableText(run.text),
  )
}

function proseDominantInlineMathLine(line: PdfTextLine) {
  const text = line.text.replace(/\s+/gu, ' ').trim()
  const proseWords = text.match(/\p{L}{3,}/gu) ?? []
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  const visibleCharacters = visibleRuns.reduce(
    (total, run) => total + run.text.replace(/\s/gu, '').length,
    0,
  )
  const mathCharacters = visibleRuns.reduce(
    (total, run) =>
      total +
      (/(?:cmmi|cmsy|cmex|math|symbol)/iu.test(run.fontName)
        ? run.text.replace(/\s/gu, '').length
        : 0),
    0,
  )
  const proseFontShare =
    visibleCharacters > 0 ? 1 - mathCharacters / visibleCharacters : 1
  const numberedInstruction =
    /^(?:\d+|[A-Za-z])[.)]\s+\p{Lu}/u.test(text) && proseWords.length >= 3
  return (
    numberedInstruction ||
    (line.width >= 0.3 && proseWords.length >= 4 && proseFontShare >= 0.5)
  )
}

function marginBand(source: Pick<PdfTextLine, 'y' | 'height'>) {
  return source.y <= 0.1 || source.y + source.height >= 0.9
}

function repeatedMarginKeys(pages: PdfPageAnalysis[]) {
  const occurrences = new Map<string, Set<number>>()
  for (const page of pages) {
    for (const run of page.runs) {
      if (!marginBand(run)) continue
      const key = normalizeMarginText(run.text)
      // Compact repeated cells are ambiguous and stay visible. Running
      // furniture must supply a prose-sized source run; folios are classified
      // independently from their bounded numeric syntax.
      if (key.length < 4 || key.length > 160 || run.width < 0.12) continue
      const pageNumbers = occurrences.get(key) ?? new Set<number>()
      pageNumbers.add(page.page)
      occurrences.set(key, pageNumbers)
    }
  }
  return new Set(
    [...occurrences.entries()]
      .filter(([, pages]) => pages.size >= 2)
      .map(([key]) => key),
  )
}

function textLineFromRuns(source: PdfTextLine, runs: PdfTextLine['runs']) {
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.x + run.width))
  const bottom = Math.max(...runs.map((run) => run.y + run.height))
  const fragment = {
    ...source,
    text: mergePdfRunText(runs),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    fontSize: Math.max(...runs.map((run) => run.fontSize)),
    runs,
  }
  copyPdfLinkedTokenSourceAnnotations(source, fragment)
  return fragment
}

function computerModernMathSourceRun(
  run: PdfTextLine['runs'][number],
  maximumFontSize: number,
) {
  const text = run.text.replace(/\s+/gu, ' ').trim()
  if (!text) return false
  if (/(?:^|[+_-])CM(?:MI|SY|EX)\d*(?:$|[+_-])/iu.test(run.fontName)) {
    return true
  }
  if (!/(?:^|[+_-])CMR\d*(?:$|[+_-])/iu.test(run.fontName)) return false
  const proseWords = text.match(/\p{L}{3,}/gu) ?? []
  return (
    run.fontSize <= maximumFontSize * 0.82 ||
    proseWords.length === 0 ||
    (proseWords.length === 1 &&
      /^(?:arg|cosh?|diag|exp|min|max|log|sinh?|sqrt|tanh?|var)\b/iu.test(text))
  )
}

function horizontallyStackedMathPair(
  left: PdfTextLine['runs'][number],
  right: PdfTextLine['runs'][number],
  maximumFontSize: number,
) {
  if (
    left.fontSize > maximumFontSize * 0.86 ||
    right.fontSize > maximumFontSize * 0.86
  ) {
    return false
  }
  const horizontalOverlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const minimumWidth = Math.min(left.width, right.width)
  if (
    minimumWidth <= 0 ||
    horizontalOverlap < minimumWidth * 0.7 ||
    Math.abs(left.x + left.width / 2 - (right.x + right.width / 2)) >
      Math.max(0.008, Math.max(left.width, right.width) * 0.3)
  ) {
    return false
  }
  const leftCenterY = left.y + left.height / 2
  const rightCenterY = right.y + right.height / 2
  const minimumHeight = Math.min(left.height, right.height)
  const verticalGap = Math.max(
    left.y - (right.y + right.height),
    right.y - (left.y + left.height),
    0,
  )
  return (
    Math.abs(leftCenterY - rightCenterY) >=
      Math.max(0.003, minimumHeight * 0.45) &&
    verticalGap <= Math.max(0.006, minimumHeight * 0.7)
  )
}

function horizontalBoxGap(
  left: PdfTextLine['runs'][number],
  right: PdfTextLine['runs'][number],
) {
  return Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0,
  )
}

export function sourceStackedMathPairs(
  runs: PdfTextLine['runs'],
  maximumFontSize: number,
) {
  return runs.flatMap((left, leftIndex) =>
    runs
      .slice(leftIndex + 1)
      .flatMap((right) =>
        horizontallyStackedMathPair(left, right, maximumFontSize)
          ? [[left, right] as const]
          : [],
      ),
  )
}

export function sourceInlineFractionPairs(line: PdfTextLine) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 2 || runs.some(mathExtensionSourceRun)) return []
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  // PDF placement alone cannot distinguish a stacked numerator/denominator
  // from simultaneous super/subscripts, including mixed letter pairs such as
  // x/y beside a coefficient. Preserve every such pair as a two-dimensional
  // equation obligation instead of guessing canonical inline semantics.
  return sourceStackedMathPairs(runs, maximumFontSize)
}

function verticalLineOverlap(left: PdfTextLine, right: PdfTextLine) {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
}

function mathExtensionSourceRun(run: PdfTextLine['runs'][number]) {
  return (
    /(?:^|[+_-])CMEX\d*(?:$|[+_-])/iu.test(run.fontName) ||
    /^[∑∫∏√]$/u.test(run.text.trim())
  )
}

/**
 * Large operators can cause PDF.js to split one visual row into two source
 * lines: the operator and its scripts land in one line while a neighboring
 * fraction plus prose land in another. Coalesce only the proved source case:
 * a vertically interleaved math-extension line beside a companion that owns a
 * small stacked pair and prose before the operator. The ordinary inline
 * splitter can then retain prose and crop the complete 2-D formula envelope.
 */
function mergeInterleavedStackedFormulaLines(lines: PdfTextLine[]) {
  const claimed = new Set<number>()
  const mergedAt = new Map<number, PdfTextLine>()

  for (const [lineIndex, line] of lines.entries()) {
    if (claimed.has(lineIndex)) continue
    const extensionRuns = line.runs.filter(mathExtensionSourceRun)
    if (extensionRuns.length === 0) continue
    const extensionLeft = Math.min(...extensionRuns.map((run) => run.x))
    const candidates = lines
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) => {
        if (
          candidateIndex === lineIndex ||
          claimed.has(candidateIndex) ||
          candidate.page !== line.page
        ) {
          return false
        }
        const overlap = verticalLineOverlap(line, candidate)
        if (overlap < Math.min(line.height, candidate.height) * 0.45) {
          return false
        }
        const maximumFontSize = Math.max(
          ...candidate.runs.map((run) => run.fontSize),
        )
        const pairs = sourceStackedMathPairs(candidate.runs, maximumFontSize)
        if (pairs.length === 0) return false
        const pairNearExtension = pairs.some((pair) =>
          pair.some((run) =>
            extensionRuns.some(
              (extension) => horizontalBoxGap(run, extension) <= 0.02,
            ),
          ),
        )
        if (!pairNearExtension) return false
        return candidate.runs.some(
          (run) =>
            run.x + run.width <= extensionLeft &&
            !computerModernMathSourceRun(run, maximumFontSize) &&
            (run.text.match(/\p{L}{2,}/gu)?.length ?? 0) > 0,
        )
      })
      .sort(
        (left, right) =>
          Math.abs(left.candidate.y - line.y) -
            Math.abs(right.candidate.y - line.y) ||
          left.candidateIndex - right.candidateIndex,
      )
    const match = candidates[0]
    if (!match) continue

    const runs = [...line.runs, ...match.candidate.runs].sort(
      (left, right) => left.x - right.x || left.y - right.y,
    )
    const merged = textLineFromRuns(line, runs)
    const outputIndex = Math.min(lineIndex, match.candidateIndex)
    mergedAt.set(outputIndex, merged)
    claimed.add(lineIndex)
    claimed.add(match.candidateIndex)
  }

  return lines.flatMap((line, lineIndex) => {
    const merged = mergedAt.get(lineIndex)
    if (merged) return [merged]
    return claimed.has(lineIndex) ? [] : [line]
  })
}

/**
 * A PDF text line can contain a prose prefix and a visually stacked fraction
 * or simultaneous super/subscripts. Linear text merging cannot distinguish
 * those semantics. Split the source-backed two-dimensional run geometry,
 * retaining the prose runs as ordinary text and the exact run envelope as an
 * equation crop candidate.
 */
function splitSourceStackedInlineFormulaLines(lines: PdfTextLine[]) {
  return mergeInterleavedStackedFormulaLines(lines).flatMap(
    (line, lineIndex) => {
      const runs = line.runs.filter((run) => run.text.trim())
      if (runs.length < 2) return [line]
      const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
      const stackedPairs = sourceStackedMathPairs(runs, maximumFontSize)
      if (stackedPairs.length === 0) return [line]
      const baseId = `page-${String(line.page).padStart(3, '0')}-inline-stacked-${String(lineIndex + 1).padStart(4, '0')}`

      const formulaRuns = new Set(stackedPairs.flat())
      let expanded = true
      while (expanded) {
        expanded = false
        for (const candidate of runs) {
          const compactCandidateText = candidate.text.replace(/\s+/gu, '')
          const adjacentBaselineAnchor =
            candidate.fontSize >= maximumFontSize * 0.9 &&
            /^[\p{L}\p{N})\]}]{1,4}$/u.test(compactCandidateText) &&
            stackedPairs.some((pair) => {
              const pairLeft = Math.min(...pair.map((run) => run.x))
              const pairCenters = pair
                .map((run) => run.y + run.height / 2)
                .sort((left, right) => left - right)
              const horizontalGap = pairLeft - (candidate.x + candidate.width)
              const candidateCenter = candidate.y + candidate.height / 2
              return (
                !pair.includes(candidate) &&
                horizontalGap >= -0.001 &&
                horizontalGap <= Math.max(0.004, candidate.width * 0.45) &&
                candidateCenter > pairCenters[0] &&
                candidateCenter < pairCenters[1]
              )
            })
          if (
            formulaRuns.has(candidate) ||
            (!computerModernMathSourceRun(candidate, maximumFontSize) &&
              !adjacentBaselineAnchor)
          ) {
            continue
          }
          if (
            [...formulaRuns].some(
              (owned) => horizontalBoxGap(owned, candidate) <= 0.02,
            )
          ) {
            formulaRuns.add(candidate)
            expanded = true
          }
        }
      }
      const formulaLeft = Math.min(...[...formulaRuns].map((run) => run.x))
      const formulaRight = Math.max(
        ...[...formulaRuns].map((run) => run.x + run.width),
      )
      for (const candidate of runs) {
        if (
          !formulaRuns.has(candidate) &&
          /^[,.;:!?()[\]{}]+$/u.test(candidate.text.trim()) &&
          horizontalBoxGap(candidate, {
            ...candidate,
            x: formulaLeft,
            width: formulaRight - formulaLeft,
          }) <= 0.008
        ) {
          formulaRuns.add(candidate)
        }
      }
      const beforeRuns = runs.filter(
        (run) => !formulaRuns.has(run) && run.x + run.width <= formulaLeft,
      )
      const afterRuns = runs.filter(
        (run) => !formulaRuns.has(run) && run.x >= formulaRight,
      )
      const unownedRuns = runs.filter(
        (run) =>
          !formulaRuns.has(run) &&
          !beforeRuns.includes(run) &&
          !afterRuns.includes(run),
      )
      const proseWordCount =
        [...beforeRuns, ...afterRuns]
          .map((run) => run.text)
          .join(' ')
          .match(/\p{L}{2,}/gu)?.length ?? 0
      const hasProseSiblings = beforeRuns.length > 0 || afterRuns.length > 0
      if (unownedRuns.length > 0 || (hasProseSiblings && proseWordCount < 2)) {
        // The stacked source geometry is still ambiguous even when the
        // surrounding text cannot be split conservatively. Withhold the whole
        // line as one equation obligation rather than publishing guessed
        // super/subscript semantics.
        return [{ ...line, id: `${baseId}-formula` }]
      }

      const fragments: PdfTextLine[] = []
      if (beforeRuns.length > 0) {
        fragments.push({
          ...textLineFromRuns(line, beforeRuns),
          id: `${baseId}-before`,
        })
      }
      fragments.push({
        ...textLineFromRuns(
          line,
          [...formulaRuns].sort(
            (left, right) => left.x - right.x || left.y - right.y,
          ),
        ),
        id: `${baseId}-formula`,
      })
      if (afterRuns.length > 0) {
        fragments.push({
          ...textLineFromRuns(line, afterRuns),
          id: `${baseId}-after`,
        })
      }
      return fragments
    },
  )
}

function inlineStackedFragmentParts(line: Pick<PdfTextLine, 'id'>) {
  const match = line.id?.match(
    /^(.*-inline-stacked-\d+)-(before|formula|after)$/u,
  )
  return match
    ? {
        baseId: match[1],
        part: match[2] as 'before' | 'formula' | 'after',
      }
    : null
}

function inlineStackedFragmentOrder(
  left: Pick<PdfTextLine, 'id'>,
  right: Pick<PdfTextLine, 'id'>,
) {
  const leftParts = inlineStackedFragmentParts(left)
  const rightParts = inlineStackedFragmentParts(right)
  if (!leftParts || !rightParts || leftParts.baseId !== rightParts.baseId) {
    return null
  }
  const order = { before: 0, formula: 1, after: 2 } as const
  return order[leftParts.part] - order[rightParts.part]
}

function sourceLineFlowOrder(left: PdfTextLine, right: PdfTextLine) {
  if (left.page !== right.page) return left.page - right.page
  const inlineOrder = inlineStackedFragmentOrder(left, right)
  return inlineOrder ?? (left.y - right.y || left.x - right.x)
}

function emphasizedSourceRun(run: PdfTextLine['runs'][number]) {
  return (
    run.bold === true ||
    /(?:bold|semibold|demi|medi(?:um)?|black)/iu.test(run.fontName) ||
    /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
      run.fontName,
    ) ||
    /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
      run.fontName,
    )
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
      marginBand(run) && repeated.has(normalizeMarginText(run.text))
        ? [index]
        : [],
    )
    if (repeatedIndexes.length === 0) return [line]
    // A diagram title and a running author can overlap vertically enough for
    // line grouping to fuse them. Split only source runs already proven
    // repeated across pages, retaining every residual run as its own line.
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
    medianLineFontSize(line) <= bodySize * 0.92 &&
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
  const claimed = new Set<PdfTextLine>()
  for (const [seedIndex, seed] of ordered.entries()) {
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

export function normalizedNoteLabel(value: string) {
  const superscripts: Record<string, string> = {
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
    '∗': '*',
  }
  return [...value]
    .map((character) => superscripts[character] ?? character)
    .join('')
    .trim()
}

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

function spread(values: number[]) {
  return values.length < 2 ? 0 : Math.max(...values) - Math.min(...values)
}

function distinctLines(values: ClassifiedLine[]): ClassifiedLine[] {
  return [...new Set(values)]
}

function alignedBandCount(
  members: Array<{ left: ClassifiedLine; right: ClassifiedLine }>,
) {
  const centers = members
    .map(
      ({ left, right }) =>
        (left.y + left.height / 2 + right.y + right.height / 2) / 2,
    )
    .sort((left, right) => left - right)
  const bands: number[] = []
  for (const center of centers) {
    if (bands.every((candidate) => Math.abs(candidate - center) > 0.012)) {
      bands.push(center)
    }
  }
  return bands.length
}

function maximumVerticalGap(lines: ClassifiedLine[]) {
  const ordered = distinctLines(lines).sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  if (ordered.length < 2) return Number.POSITIVE_INFINITY
  return Math.max(
    ...ordered.slice(1).map((line, index) => {
      const previous = ordered[index]
      return line.y - (previous.y + previous.height)
    }),
  )
}

function dominantIndent(lines: ClassifiedLine[]) {
  const clusters = lines.map((seed) => {
    const members = lines.filter((line) => Math.abs(line.x - seed.x) <= 0.04)
    return {
      members,
      x: median(members.map((line) => line.x)),
    }
  })
  return clusters.sort(
    (left, right) =>
      right.members.length - left.members.length || left.x - right.x,
  )[0]
}

function preclassifyMarginNotes(
  lines: ClassifiedLine[],
  pageBodyFontSize: number,
) {
  const body = lines.filter((line) => line.kind === 'body')
  const dominant = dominantIndent(body)
  if (!dominant || dominant.members.length < 2) return
  for (const line of body) {
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

function endsCaptionSentence(text: string) {
  return /[.!?][”’'"\])}]*$/u.test(text.trim())
}

function endsIncompleteWrappedUrl(text: string) {
  return /(?:https?:\/\/|www\.)\S+\.$/iu.test(text.trim())
}

function captionLineFontSize(line: PdfTextLine) {
  const runs = line.runs
    .filter((run) => run.fontSize > 0 && run.text.trim().length > 0)
    .map((run) => ({
      fontSize: run.fontSize,
      weight: Math.max(1, run.text.replace(/\s/gu, '').length),
    }))
    .sort((left, right) => left.fontSize - right.fontSize)
  if (runs.length === 0) return line.fontSize

  const midpoint = runs.reduce((total, run) => total + run.weight, 0) / 2
  let cumulative = 0
  for (const run of runs) {
    cumulative += run.weight
    if (cumulative >= midpoint) return run.fontSize
  }
  return line.fontSize
}

function completesQuotedCaptionExpression(
  previous: ClassifiedLine,
  candidate: ClassifiedLine,
) {
  const openQuotes = previous.text.match(/“/gu)?.length ?? 0
  const closeQuotes = previous.text.match(/”/gu)?.length ?? 0
  return (
    openQuotes > closeQuotes &&
    candidate.text.includes('”') &&
    endsCaptionSentence(candidate.text)
  )
}

function captionContinuationGeometry(
  seed: ClassifiedLine,
  previous: ClassifiedLine,
  candidate: ClassifiedLine,
) {
  const candidateProseWordCount =
    candidate.text.match(/\p{L}{2,}/gu)?.length ?? 0
  const equationClassifiedCaptionProse =
    candidate.kind === 'equation' &&
    (candidateProseWordCount >= 4 ||
      (candidateProseWordCount >= 2 && endsCaptionSentence(candidate.text)) ||
      completesQuotedCaptionExpression(previous, candidate))
  const footerClassifiedSplitWordContinuation =
    candidate.kind === 'footer' &&
    /\p{L}-$|\p{L}‐$/u.test(previous.text.trim()) &&
    /^\p{L}/u.test(candidate.text.trim())
  if (
    candidate.page !== seed.page ||
    beginsVisualCaption(candidate.text) ||
    (candidate.kind !== 'body' &&
      candidate.kind !== 'caption' &&
      !equationClassifiedCaptionProse &&
      !footerClassifiedSplitWordContinuation)
  )
    return false
  if (candidate.y <= previous.y + previous.height * 0.35) return false

  const gap = candidate.y - (previous.y + previous.height)
  const maximumGap = Math.max(
    0.006,
    Math.max(previous.height, candidate.height) * 0.72,
  )
  if (gap < -0.004 || gap > maximumGap) return false

  const seedFontSize = captionLineFontSize(seed)
  const candidateFontSize = captionLineFontSize(candidate)
  const fontRatio =
    Math.max(seedFontSize, candidateFontSize) /
    Math.max(1, Math.min(seedFontSize, candidateFontSize))
  if (fontRatio > 1.12) return false

  const intersection = Math.max(
    0,
    Math.min(seed.x + seed.width, candidate.x + candidate.width) -
      Math.max(seed.x, candidate.x),
  )
  const overlapRatio =
    intersection / Math.max(0.001, Math.min(seed.width, candidate.width))
  const alignmentTolerance = Math.max(0.025, seed.height * 1.6)
  const aligned =
    Math.abs(candidate.x - seed.x) <= alignmentTolerance ||
    Math.abs(candidate.x + candidate.width - (seed.x + seed.width)) <=
      alignmentTolerance ||
    Math.abs(candidate.x + candidate.width / 2 - (seed.x + seed.width / 2)) <=
      alignmentTolerance
  return overlapRatio >= 0.72 && aligned
}

function demoteInlineVisualReferenceContinuations(lines: ClassifiedLine[]) {
  const ordered = [...lines].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  for (const candidate of ordered.filter(
    (line) => line.kind === 'caption' && beginsVisualCaption(line.text),
  )) {
    const previous = ordered
      .filter(
        (line) =>
          line.id !== candidate.id &&
          line.page === candidate.page &&
          line.kind === 'body' &&
          line.y < candidate.y,
      )
      .filter((line) => {
        const text = line.text.trim()
        const proseWordCount = text.match(/\p{L}{2,}/gu)?.length ?? 0
        const unfinishedBodyLine =
          proseWordCount >= 4 &&
          /\p{Ll}[\p{L}\p{M}'’]*$/u.test(text) &&
          !/[.!?;:]\s*$/u.test(text)
        if (!unfinishedBodyLine) return false

        const gap = candidate.y - (line.y + line.height)
        const maximumGap = Math.max(
          0.006,
          Math.max(line.height, candidate.height) * 0.45,
        )
        if (gap < -0.003 || gap > maximumGap) return false

        const previousFontSize = captionLineFontSize(line)
        const candidateFontSize = captionLineFontSize(candidate)
        const fontRatio =
          Math.max(previousFontSize, candidateFontSize) /
          Math.max(1, Math.min(previousFontSize, candidateFontSize))
        if (fontRatio > 1.06) return false

        const intersection = Math.max(
          0,
          Math.min(line.x + line.width, candidate.x + candidate.width) -
            Math.max(line.x, candidate.x),
        )
        const overlapRatio =
          intersection / Math.max(0.001, Math.min(line.width, candidate.width))
        const alignmentTolerance = Math.max(
          0.014,
          Math.max(line.height, candidate.height),
        )
        return (
          overlapRatio >= 0.72 &&
          Math.abs(line.x - candidate.x) <= alignmentTolerance
        )
      })
      .sort(
        (left, right) =>
          right.y + right.height - (left.y + left.height) ||
          Math.abs(left.x - candidate.x) - Math.abs(right.x - candidate.x),
      )[0]
    if (!previous) continue

    candidate.kind = 'body'
    candidate.confidence = Math.min(candidate.confidence, previous.confidence)
  }
}

/**
 * PDF text extraction marks only the label-bearing first line of a wrapped
 * caption. Promote its geometrically continuous wrap lines before column
 * classification so a page-spanning table caption does not become a separate
 * `spanning` prose region. The chain stops at whitespace, font, alignment, and
 * paragraph-boundary evidence rather than consuming the following body flow.
 */
function promoteCaptionContinuations(lines: ClassifiedLine[]) {
  const claimed = new Set<string>()
  const seeds = lines
    .filter((line) => line.kind === 'caption')
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const seed of seeds) {
    let previous = seed
    const alignmentTolerance = Math.max(0.025, seed.height * 1.6)
    const seedFontSize = captionLineFontSize(seed)
    let widestLine = Math.max(
      seed.width,
      ...lines
        .filter((line) => {
          const lineFontSize = captionLineFontSize(line)
          const fontRatio =
            Math.max(seedFontSize, lineFontSize) /
            Math.max(1, Math.min(seedFontSize, lineFontSize))
          return (
            line.page === seed.page &&
            fontRatio <= 1.12 &&
            Math.abs(line.x - seed.x) <= alignmentTolerance
          )
        })
        .map((line) => line.width),
    )
    while (true) {
      const previousIsShortConclusion =
        endsCaptionSentence(previous.text) && previous.width < widestLine * 0.82
      if (previousIsShortConclusion) break

      const candidate = lines
        .filter(
          (line) =>
            !claimed.has(line.id) &&
            captionContinuationGeometry(seed, previous, line),
        )
        .sort(
          (left, right) =>
            left.y - right.y ||
            Math.abs(left.x - seed.x) - Math.abs(right.x - seed.x),
        )[0]
      if (!candidate) break

      const paragraphIndent = candidate.x - seed.x
      if (
        endsCaptionSentence(previous.text) &&
        paragraphIndent > Math.max(0.018, seed.height * 1.25)
      ) {
        break
      }

      const fragmentParts = inlineStackedFragmentParts(candidate)
      const fragmentSiblings = fragmentParts
        ? lines
            .filter(
              (line) =>
                inlineStackedFragmentParts(line)?.baseId ===
                fragmentParts.baseId,
            )
            .sort(sourceLineFlowOrder)
        : [candidate]
      const continuationLines = fragmentSiblings.every(
        (line) => !claimed.has(line.id),
      )
        ? fragmentSiblings
        : [candidate]
      for (const continuation of continuationLines) {
        const continuationFragment = inlineStackedFragmentParts(continuation)
        if (continuationFragment?.part === 'formula') {
          // Keep the exact source geometry in the caption's reading-order
          // neighborhood, but do not relabel a provably two-dimensional math
          // fragment as linear caption prose. The visual pass owns this line
          // as an unresolved equation crop obligation.
          continuation.kind = 'equation'
          delete continuation.captionContinuationSeedId
        } else {
          continuation.kind = 'caption'
          continuation.captionContinuationSeedId = seed.id
        }
        continuation.confidence = Math.min(
          seed.confidence,
          continuation.confidence,
        )
        claimed.add(continuation.id)
        widestLine = Math.max(widestLine, continuation.width)
      }
      previous = continuationLines.at(-1)!
    }
  }
}

function horizontalOverlapRatio(
  left: Pick<PdfTextLine, 'x' | 'width'>,
  right: Pick<PdfTextLine, 'x' | 'width'>,
) {
  const overlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  return overlap / Math.max(0.001, Math.min(left.width, right.width))
}

/**
 * Side-by-side panels are emitted row-first by PDF.js: panel A line 1,
 * panel B line 1, panel A line 2, panel B line 2. Without the native-panel
 * and shared-caption proof below, sequential region joining assigns each
 * continuation to the opposite panel. Preserve the source lane before region
 * grouping so the visual pass can own complete `(a)` / `(b)` labels.
 */
function markAdjacentPanelLabelContinuations(
  lines: ClassifiedLine[],
  objects: PdfPageAnalysis['objects'],
) {
  const images = (objects ?? []).filter(
    (object) => object.kind === 'image' && object.role !== 'scan-source',
  )
  if (images.length < 2) return

  for (const caption of lines.filter(
    (line) => line.kind === 'caption' && beginsVisualCaption(line.text),
  )) {
    const eligibleImages = images.filter(
      (image) =>
        image.box.y + image.box.height <= caption.y + 0.004 &&
        caption.y - (image.box.y + image.box.height) <= 0.12,
    )
    if (eligibleImages.length < 2) continue
    const closestBottom = Math.max(
      ...eligibleImages.map((image) => image.box.y + image.box.height),
    )
    const bandReference = eligibleImages.reduce((closest, candidate) =>
      candidate.box.y + candidate.box.height >
      closest.box.y + closest.box.height
        ? candidate
        : closest,
    )
    const panels = eligibleImages
      .filter((image) => {
        const bottom = image.box.y + image.box.height
        const verticalOverlap = Math.max(
          0,
          Math.min(
            image.box.y + image.box.height,
            bandReference.box.y + bandReference.box.height,
          ) - Math.max(image.box.y, bandReference.box.y),
        )
        return (
          closestBottom - bottom <= 0.02 &&
          verticalOverlap >=
            Math.min(image.box.height, bandReference.box.height) * 0.7
        )
      })
      .sort((left, right) => left.box.x - right.box.x)
    if (panels.length < 2) continue
    const panelLeft = Math.min(...panels.map((panel) => panel.box.x))
    const panelRight = Math.max(
      ...panels.map((panel) => panel.box.x + panel.box.width),
    )
    if (
      panelRight - panelLeft < 0.5 ||
      caption.width < (panelRight - panelLeft) * 0.75
    ) {
      continue
    }

    const panelBottom = Math.max(
      ...panels.map((panel) => panel.box.y + panel.box.height),
    )
    const seeds = lines
      .filter(
        (line) =>
          line.kind === 'body' &&
          /^\s*\([a-z0-9ivxlcdm]+\)\s+\p{L}/iu.test(line.text) &&
          line.y >= panelBottom - 0.012 &&
          line.y + line.height <= caption.y + 0.004,
      )
      .sort((left, right) => left.x - right.x)
    if (seeds.length !== panels.length) continue
    const seedPanels = seeds.map((seed) => {
      const overlaps = panels.map((panel) =>
        horizontalOverlapRatio(seed, panel.box),
      )
      const best = Math.max(...overlaps)
      const bestIndex = overlaps.indexOf(best)
      const runnerUp = Math.max(
        ...overlaps.filter((_overlap, index) => index !== bestIndex),
        0,
      )
      return best >= 0.7 && best - runnerUp >= 0.2 ? bestIndex : -1
    })
    if (
      seedPanels.some((index) => index < 0) ||
      new Set(seedPanels).size !== panels.length
    ) {
      continue
    }

    const claimed = new Set(seeds.map((seed) => seed.id))
    for (const [seedIndex, seed] of seeds.entries()) {
      const panel = panels[seedPanels[seedIndex]]
      let previous = seed
      while (true) {
        const candidates = lines
          .filter((candidate) => {
            if (
              claimed.has(candidate.id) ||
              candidate.kind !== 'body' ||
              candidate.page !== seed.page ||
              candidate.y < previous.y + previous.height - 0.002 ||
              candidate.y + candidate.height > caption.y + 0.004 ||
              /^\s*\([a-z0-9ivxlcdm]+\)\s+\p{L}/iu.test(candidate.text)
            ) {
              return false
            }
            const gap = candidate.y - (previous.y + previous.height)
            const fontRatio =
              Math.max(seed.fontSize, candidate.fontSize) /
              Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
            return (
              gap <= Math.max(0.014, seed.height * 1.25) &&
              fontRatio <= 1.18 &&
              horizontalOverlapRatio(candidate, panel.box) >= 0.7 &&
              panels.filter(
                (otherPanel) =>
                  horizontalOverlapRatio(candidate, otherPanel.box) >= 0.7,
              ).length === 1
            )
          })
          .sort(
            (left, right) =>
              left.y - right.y ||
              Math.abs(left.x - panel.box.x) - Math.abs(right.x - panel.box.x),
          )
        if (candidates.length === 0) break
        const candidate = candidates[0]
        candidate.panelLabelContinuationSeedId = seed.id
        candidate.confidence = Math.min(seed.confidence, candidate.confidence)
        claimed.add(candidate.id)
        previous = candidate
      }
    }
  }
}

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

type TabularGridFragment = {
  left: number
  right: number
  text: string
}

type TabularGridBand = {
  center: number
  lines: ClassifiedLine[]
  fragments: TabularGridFragment[]
}

function tabularGridFragments(lines: ClassifiedLine[]) {
  const fragments: TabularGridFragment[] = []
  const runs = lines
    .flatMap((line) => line.runs.filter((run) => run.text.trim()))
    .sort((left, right) => left.x - right.x)
  for (const run of runs) {
    const right = run.x + run.width
    const previous = fragments.at(-1)
    const joinsPrevious =
      previous && run.x <= previous.right + Math.max(0.006, run.height * 0.5)
    if (previous && joinsPrevious) {
      previous.right = Math.max(previous.right, right)
      previous.text = `${previous.text} ${run.text}`
      continue
    }
    fragments.push({
      left: run.x,
      right,
      text: run.text,
    })
  }
  return fragments
}

function hasParallelProseColumnFragments(
  fragments: readonly TabularGridFragment[],
) {
  const left = fragments.filter((fragment) => fragment.right <= 0.49)
  const right = fragments.filter((fragment) => fragment.left >= 0.51)
  if (left.length === 0 || right.length === 0) return false
  const leftCoverage = left.at(-1)!.right - left[0].left
  const rightCoverage = right.at(-1)!.right - right[0].left
  const gutter = right[0].left - left.at(-1)!.right
  const wordCount = (side: readonly TabularGridFragment[]) =>
    side.reduce(
      (total, fragment) =>
        total + (fragment.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0),
      0,
    )
  return (
    leftCoverage >= 0.28 &&
    rightCoverage >= 0.28 &&
    gutter >= 0.015 &&
    wordCount(left) >= 4 &&
    wordCount(right) >= 4
  )
}

function hasParallelProseColumnLines(lines: readonly ClassifiedLine[]) {
  const proseLine = (line: ClassifiedLine) =>
    line.width >= 0.18 && (line.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 3
  const left = lines.some(
    (line) => line.x < 0.49 && line.x + line.width <= 0.5 && proseLine(line),
  )
  const right = lines.some(
    (line) => line.x >= 0.5 && line.x + line.width > 0.51 && proseLine(line),
  )
  return left && right
}

/**
 * Dense table rows can repeat many source-run anchors while presenting only
 * two or three grouped text lines. Those repeated cell gaps are not evidence
 * for page columns. Identify only compact, full-width grids with at least four
 * recurring anchors in three adjacent row bands; ordinary two-column prose
 * therefore remains eligible to prove its real gutter.
 */
function denseTabularGridBands(lines: ClassifiedLine[]) {
  const bands: Array<Omit<TabularGridBand, 'fragments'>> = []
  for (const line of lines
    .filter((candidate) => candidate.kind === 'body' && candidate.text.trim())
    .sort((left, right) => left.y - right.y || left.x - right.x)) {
    const center = line.y + line.height / 2
    const band = bands.find(
      (candidate) =>
        Math.abs(candidate.center - center) <=
        Math.max(0.007, line.height * 0.7),
    )
    if (band) {
      band.lines.push(line)
      band.center = median(
        band.lines.map((candidate) => candidate.y + candidate.height / 2),
      )
    } else {
      bands.push({ center, lines: [line] })
    }
  }

  const denseBands = bands
    .map<TabularGridBand>((band) => ({
      ...band,
      fragments: tabularGridFragments(band.lines),
    }))
    .filter((band) => {
      if (hasParallelProseColumnLines(band.lines)) return false
      if (hasParallelProseColumnFragments(band.fragments)) return false
      if (band.fragments.length < 4) return false
      const coverage = band.fragments.at(-1)!.right - band.fragments[0].left
      const compactFragments = band.fragments.filter((fragment) => {
        const wordCount = fragment.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
        return fragment.right - fragment.left <= 0.18 || wordCount <= 3
      }).length
      return (
        coverage >= 0.45 && compactFragments >= band.fragments.length * 0.75
      )
    })

  const recurringBands = denseBands.filter((band) => {
    const recurringFragments = band.fragments.filter((fragment) => {
      const matchingBands = denseBands.filter(
        (candidate) =>
          candidate !== band &&
          candidate.fragments.some(
            (candidateFragment) =>
              Math.abs(candidateFragment.left - fragment.left) <= 0.025 ||
              Math.abs(candidateFragment.right - fragment.right) <= 0.025,
          ),
      )
      return matchingBands.length >= 2
    })
    return recurringFragments.length >= 4
  })

  const adjacentClusters: TabularGridBand[][] = []
  for (const band of recurringBands.sort(
    (left, right) => left.center - right.center,
  )) {
    const cluster = adjacentClusters.at(-1)
    if (cluster && band.center - cluster.at(-1)!.center <= 0.08) {
      cluster.push(band)
    } else {
      adjacentClusters.push([band])
    }
  }

  return new Map<string, string>(
    adjacentClusters.flatMap((cluster, clusterIndex) =>
      cluster.length < 3
        ? []
        : cluster.flatMap((band, bandIndex) =>
            band.lines.map(
              (line) =>
                [
                  line.id,
                  `tabular-grid-${clusterIndex + 1}-band-${bandIndex + 1}`,
                ] as const,
            ),
          ),
    ),
  )
}

function detectColumns(lines: ClassifiedLine[]): ColumnLayout {
  const sideLines = lines.filter((line) => line.kind === 'side')
  const tabularGridBands = denseTabularGridBands(lines)
  const candidates = lines.filter(
    (line) =>
      line.kind === 'body' &&
      line.text.length > 1 &&
      line.width < 0.72 &&
      !tabularGridBands.has(line.id),
  )
  const gaps: Array<{
    split: number
    left: ClassifiedLine
    right: ClassifiedLine
  }> = []
  for (let index = 0; index < candidates.length; index += 1) {
    for (
      let nextIndex = index + 1;
      nextIndex < candidates.length;
      nextIndex += 1
    ) {
      const first = candidates[index]
      const second = candidates[nextIndex]
      const left = first.x <= second.x ? first : second
      const right = left === first ? second : first
      const centerDifference = Math.abs(
        left.y + left.height / 2 - (right.y + right.height / 2),
      )
      const gap = right.x - (left.x + left.width)
      if (
        centerDifference > Math.max(0.007, left.height, right.height) ||
        gap <= Math.max(0.01, Math.min(left.height, right.height) * 0.6)
      ) {
        continue
      }
      gaps.push({ split: left.x + left.width + gap / 2, left, right })
    }
  }
  if (gaps.length === 0) {
    const bodyIndent = spread(candidates.map((line) => line.x))
    if (sideLines.length > 0 && candidates.length >= 2 && bodyIndent <= 0.04) {
      const bodyMedian = median(candidates.map((line) => line.fontSize))
      const sideMedian = median(sideLines.map((line) => line.fontSize))
      return {
        split: null,
        accepted: false,
        ambiguous: false,
        tabularGridBands,
        resolution: {
          policyVersion: READING_ORDER_RESOLUTION_POLICY_VERSION,
          ambiguityClass: 'single-column-with-margin-notes',
          status: 'resolved',
          confidence: 0.94,
          threshold: READING_ORDER_RESOLUTION_THRESHOLD,
          evidence: [
            {
              code: 'font-metrics',
              detail: `Margin median font ${rounded(sideMedian)} is subordinate to body median font ${rounded(bodyMedian)}.`,
            },
            {
              code: 'indentation-continuity',
              detail: `The retained body flow has normalized indentation spread ${rounded(bodyIndent)}.`,
            },
            {
              code: 'margin-note-exclusion',
              detail: `${sideLines.length} aligned narrow side region${sideLines.length === 1 ? '' : 's'} remain outside canonical reading order.`,
            },
          ],
        },
      }
    }
    return {
      split: null,
      accepted: false,
      ambiguous: false,
      tabularGridBands,
      resolution: null,
    }
  }

  const clusters = gaps.map((seed) => {
    const members = gaps.filter(
      (candidate) => Math.abs(candidate.split - seed.split) <= 0.05,
    )
    return {
      members,
      split: median(members.map((member) => member.split)),
    }
  })
  const rankedClusters = clusters.sort(
    (left, right) =>
      right.members.length - left.members.length || left.split - right.split,
  )
  let strongest = rankedClusters[0]
  const crossingCandidateCount = (split: number) =>
    candidates.filter((line) => {
      const tolerance = Math.max(0.006, Math.min(0.018, line.height * 0.4))
      return (
        line.x < split - tolerance && line.x + line.width > split + tolerance
      )
    }).length
  const strongestCrossingCount = crossingCandidateCount(strongest.split)
  // A compact grid can repeat an internal cell gap more often than the real
  // page gutter. Prefer only another well-supported central gap, and only
  // when it partitions more source lines instead of cutting through them.
  const centralProseGutter = rankedClusters
    .filter(
      (cluster) =>
        cluster.split >= 0.4 &&
        cluster.split <= 0.6 &&
        alignedBandCount(cluster.members) >= 2 &&
        cluster.members.length >=
          Math.max(2, Math.ceil(strongest.members.length * 0.4)),
    )
    .map((cluster) => ({
      ...cluster,
      crossingCount: crossingCandidateCount(cluster.split),
    }))
    .sort(
      (left, right) =>
        left.crossingCount - right.crossingCount ||
        right.members.length - left.members.length ||
        Math.abs(left.split - 0.5) - Math.abs(right.split - 0.5),
    )[0]
  if (
    centralProseGutter &&
    (strongest.split < 0.4 ||
      strongest.split > 0.6 ||
      centralProseGutter.crossingCount < strongestCrossingCount)
  ) {
    strongest = centralProseGutter
  }
  const selectedCrossingCount = crossingCandidateCount(strongest.split)
  const tolerance = 0.008
  const leftLines = candidates.filter(
    (line) => line.x + line.width <= strongest.split + tolerance,
  )
  const rightLines = candidates.filter(
    (line) => line.x >= strongest.split - tolerance,
  )
  const leftRange = [
    Math.min(...leftLines.map((line) => line.y)),
    Math.max(...leftLines.map((line) => line.y + line.height)),
  ]
  const rightRange = [
    Math.min(...rightLines.map((line) => line.y)),
    Math.max(...rightLines.map((line) => line.y + line.height)),
  ]
  const overlapsVertically =
    leftLines.length > 0 &&
    rightLines.length > 0 &&
    Math.min(leftRange[1], rightRange[1]) >
      Math.max(leftRange[0], rightRange[0])
  const pairedLeft = distinctLines(
    strongest.members.map((member) => member.left),
  )
  const pairedRight = distinctLines(
    strongest.members.map((member) => member.right),
  )
  const alignedBands = alignedBandCount(strongest.members)
  if (
    overlapsVertically &&
    alignedBands < 2 &&
    pairedLeft.length >= 2 &&
    pairedRight.length >= 2
  ) {
    return {
      split: null,
      accepted: false,
      ambiguous: false,
      tabularGridBands,
      resolution: {
        policyVersion: READING_ORDER_RESOLUTION_POLICY_VERSION,
        ambiguityClass: 'fragmented-inline-cluster',
        status: 'resolved',
        confidence: 0.92,
        threshold: READING_ORDER_RESOLUTION_THRESHOLD,
        evidence: [
          {
            code: 'block-adjacency',
            detail:
              'Separated fragments occupy one horizontal band and do not establish adjacent vertical column blocks.',
          },
        ],
      },
    }
  }

  const splitDeviation = Math.max(
    ...strongest.members.map((member) =>
      Math.abs(member.split - strongest.split),
    ),
  )
  const minimumGutter = Math.min(
    ...strongest.members.map(
      (member) => member.right.x - (member.left.x + member.left.width),
    ),
  )
  const gutterStable =
    alignedBands >= 2 &&
    strongest.split >= 0.25 &&
    strongest.split <= 0.75 &&
    splitDeviation <= 0.025 &&
    minimumGutter >= 0.01
  const leftIndentSpread = spread(pairedLeft.map((line) => line.x))
  const rightIndentSpread = spread(pairedRight.map((line) => line.x))
  const leftWidthSpread = spread(pairedLeft.map((line) => line.width))
  const rightWidthSpread = spread(pairedRight.map((line) => line.width))
  const indentationContinuous =
    leftIndentSpread <= 0.035 &&
    rightIndentSpread <= 0.035 &&
    leftWidthSpread <= 0.08 &&
    rightWidthSpread <= 0.08
  const leftFont = median(pairedLeft.map((line) => line.fontSize))
  const rightFont = median(pairedRight.map((line) => line.fontSize))
  const fontRatio =
    Math.max(leftFont, rightFont) / Math.max(1, Math.min(leftFont, rightFont))
  const fontCompatible = fontRatio <= 1.15
  const leftGap = maximumVerticalGap(pairedLeft)
  const rightGap = maximumVerticalGap(pairedRight)
  const blocksAdjacent =
    alignedBands >= 2 && leftGap <= 0.12 && rightGap <= 0.12

  const crossesSplit = (line: ClassifiedLine) =>
    line.x < strongest.split - 0.04 &&
    line.x + line.width > strongest.split + 0.04
  const captions = lines.filter(
    (line) => line.kind === 'caption' && crossesSplit(line),
  )
  const spanning = lines.filter(
    (line) => line.kind === 'body' && crossesSplit(line),
  )
  const footnotes = lines.filter(
    (line) => line.kind === 'footnote' || line.kind === 'endnote',
  )
  const ambiguityClass: PdfReadingOrderAmbiguityClass = lines.some((line) =>
    /^(?:references|bibliography)$/i.test(line.text.trim()),
  )
    ? 'dense-reference-section'
    : footnotes.length > 0
      ? 'footnote-band'
      : captions.length > 0
        ? 'two-column-with-spanning-float'
        : spanning.length > 0
          ? 'mixed-single-two-column'
          : 'sparse-column-gutter'
  const evidence: PdfReadingOrderEvidence[] = []
  let confidence = 0.45
  if (gutterStable) {
    confidence += 0.2
    evidence.push({
      code: 'column-gutter',
      detail: `${alignedBands} aligned bands repeat a normalized gutter at ${rounded(strongest.split)} with maximum deviation ${rounded(splitDeviation)}; ${selectedCrossingCount} candidate line${selectedCrossingCount === 1 ? '' : 's'} cross the selected split.`,
    })
  }
  if (fontCompatible) {
    confidence += 0.1
    evidence.push({
      code: 'font-metrics',
      detail: `Left and right median font sizes are ${rounded(leftFont)} and ${rounded(rightFont)} (ratio ${rounded(fontRatio)}).`,
    })
  }
  if (indentationContinuous) {
    confidence += 0.1
    evidence.push({
      code: 'indentation-continuity',
      detail: `Column indentation spreads are ${rounded(leftIndentSpread)} left and ${rounded(rightIndentSpread)} right; width spreads are ${rounded(leftWidthSpread)} and ${rounded(rightWidthSpread)}.`,
    })
  }
  if (blocksAdjacent) {
    confidence += 0.1
    evidence.push({
      code: 'block-adjacency',
      detail: `Maximum normalized within-column gaps are ${rounded(leftGap)} left and ${rounded(rightGap)} right.`,
    })
  }
  if (captions.length > 0) {
    confidence += 0.03
    evidence.push({
      code: 'caption-proximity',
      detail: `${captions.length} caption region${captions.length === 1 ? '' : 's'} cross the stable gutter as a page-spanning boundary.`,
    })
  }
  if (spanning.length > 0) {
    confidence += 0.02
    evidence.push({
      code: 'spanning-boundary',
      detail: `${spanning.length} body region${spanning.length === 1 ? '' : 's'} cross the stable gutter and delimit column bands.`,
    })
  }
  if (footnotes.length > 0) {
    confidence += 0.02
    evidence.push({
      code: 'footnote-band',
      detail: `${footnotes.length} smaller-font note region${footnotes.length === 1 ? '' : 's'} form a separated lower band after body flow.`,
    })
  }
  confidence = rounded(Math.min(confidence, 0.99))
  const coreEvidenceCount = [
    fontCompatible,
    indentationContinuous,
    blocksAdjacent,
  ].filter(Boolean).length
  const repeatedGeometry =
    overlapsVertically &&
    alignedBands >= 3 &&
    pairedLeft.length >= 3 &&
    pairedRight.length >= 3
  const resolvedSparseGeometry =
    overlapsVertically &&
    gutterStable &&
    coreEvidenceCount >= 2 &&
    confidence >= READING_ORDER_RESOLUTION_THRESHOLD
  const accepted = repeatedGeometry || resolvedSparseGeometry
  const ambiguous =
    !accepted &&
    overlapsVertically &&
    alignedBands >= 2 &&
    pairedLeft.length >= 2 &&
    pairedRight.length >= 2
  return {
    split: accepted || ambiguous ? rounded(strongest.split) : null,
    accepted,
    ambiguous,
    tabularGridBands,
    resolution:
      resolvedSparseGeometry || ambiguous
        ? {
            policyVersion: READING_ORDER_RESOLUTION_POLICY_VERSION,
            ambiguityClass,
            status: resolvedSparseGeometry ? 'resolved' : 'ambiguous',
            confidence,
            threshold: READING_ORDER_RESOLUTION_THRESHOLD,
            evidence,
          }
        : null,
  }
}

function columnFor(
  line: PdfTextLine & { id?: string },
  layout: ColumnLayout,
): PdfRegionColumn {
  if (layout.split === null) return 'single'
  if (line.id && layout.tabularGridBands?.has(line.id)) return 'span'
  const tolerance = Math.max(0.006, Math.min(0.018, line.height * 0.4))
  if (line.x + line.width <= layout.split + tolerance) return 'left'
  if (line.x >= layout.split - tolerance) return 'right'
  const hangsIntoGutterFromRight =
    line.x >= layout.split - Math.max(0.02, tolerance * 2) &&
    line.width <= 0.48 &&
    line.x + line.width >= layout.split + Math.max(0.12, line.width * 0.35) &&
    line.x + line.width <= 0.96
  if (hangsIntoGutterFromRight) return 'right'
  return 'span'
}

function classifiedLineFragment(
  source: ClassifiedLine,
  runs: ClassifiedLine['runs'],
  suffix: 'left' | 'right',
): ClassifiedLine {
  const orderedRuns = [...runs].sort(
    (left, right) => left.x - right.x || left.y - right.y,
  )
  const left = Math.min(...orderedRuns.map((run) => run.x))
  const top = Math.min(...orderedRuns.map((run) => run.y))
  const right = Math.max(...orderedRuns.map((run) => run.x + run.width))
  const bottom = Math.max(...orderedRuns.map((run) => run.y + run.height))
  return {
    ...source,
    id: `${source.id}-${suffix}`,
    text: mergePdfRunText(orderedRuns),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    fontSize: Math.max(...orderedRuns.map((run) => run.fontSize)),
    runs: orderedRuns,
  }
}

function splitRunBackedCrossGutterProse(
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
  lineBoundaryDecisions: PdfLineBoundaryDecision[],
) {
  const groups: ClassifiedLine[][] = []
  const ordered = [...lines].sort((left, right) => {
    if (left.page !== right.page) return left.page - right.page
    const columnOrder = left.column.localeCompare(right.column)
    if (columnOrder !== 0) return columnOrder
    return sourceLineFlowOrder(left, right)
  })
  for (const line of ordered) {
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
    if (
      previous &&
      !beginsParagraphBoundary(previousGroup!, line) &&
      joinsRegion(previous, line, hardHyphenLexicon)
    )
      previousGroup!.push(line)
    else groups.push([line])
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
      : group.some((line) => line.headingContinuationSeedId)
        ? [...group].sort((left, right) => left.y - right.y || left.x - right.x)
        : group
    const regionLines = orderedGroup.map<PdfRegionLine>((line) => {
      const regionLine = {
        id: line.id,
        text: line.text,
        fontSize: rounded(line.fontSize),
        box: lineBox(line),
        runs: line.runs.map((run) => ({ ...run })),
      }
      copyPdfLinkedTokenSourceAnnotations(line, regionLine)
      return regionLine
    })
    const kind = orderedGroup[0].kind
    return {
      id,
      page,
      kind,
      column: orderedGroup[0].column,
      text: joinPdfLineTexts(orderedGroup, {
        hardHyphenLexicon,
        unhyphenatedLexicon,
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
    }
  })
}

function makeObjectRegions(
  pages: PdfPageAnalysis[],
  layouts: Map<number, ColumnLayout>,
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
          includedInReadingOrder: true,
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
    return [
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
    ]
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
  return ordered
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
          ? layout.resolution!.evidence
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

export function reconstructPageRegions(pages: PdfPageAnalysis[]) {
  const repeated = repeatedMarginKeys(pages)
  const groupedLines = pages.map((page) => groupRunsIntoLines(page))
  const protectedRepeatedMarginHeadings =
    sourceProvenRepeatedMarginHeadingLines(groupedLines, repeated)
  const rawLines = groupedLines.map((lines) =>
    splitSourceStackedInlineFormulaLines(
      splitRepeatedMarginSourceRuns(
        lines,
        repeated,
        protectedRepeatedMarginHeadings,
      ),
    ),
  )
  const hardHyphenLexicon = inlineHardHyphenLexicon(rawLines.flat())
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(rawLines.flat())
  const classified: ClassifiedLine[] = []
  const layouts = new Map<number, ColumnLayout>()
  let inEndnotes = false

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
        const normalized = normalizedNoteLabel(line.text)
        const endnoteHeading = /^(?:endnotes?|notes?)$/i.test(normalized)
        const label = noteLabelFromText(normalized)
        const inlineStackedFragment = inlineStackedFragmentParts(line)
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
        // Decimal-leading lower-band content is overwhelmingly a plot tick,
        // metric row, or table cell, not an integer-labeled note body. The
        // comma form covers decimal-comma plots as well. Integer-only labels
        // remain eligible because a genuine footnote may place its marker on
        // a line of its own.
        const decimalTabularContent = /^[-+]?\d+[.,]\d/u.test(normalized)
        const renderedFootnote =
          label !== null &&
          !decimalTabularContent &&
          !monospacedNumberedContent &&
          !numberedBodyListLines.has(line) &&
          !numberedBodySectionHeading(normalized) &&
          line.y + line.height >= lowerBand &&
          line.fontSize >= 5 &&
          line.fontSize <= fontSize * (symbolicFootnote ? 0.96 : 0.9) + 0.01
        let kind: PdfRegionKind = 'body'
        let confidence = 0.9
        if (inEndnotes && label !== null) {
          kind = 'endnote'
          confidence = 0.96
        } else if (explicitFootnote || renderedFootnote) {
          kind = 'footnote'
          confidence = explicitFootnote ? 0.98 : 0.9
        } else if (beginsVisualCaption(normalized)) {
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
        } else if (
          (line.y <= 0.1 || line.y + line.height >= 0.9) &&
          /^(?:\d{1,4}(?::\d{1,4})?|[ivxlcdm]+)$/i.test(normalized)
        ) {
          kind = 'page-number'
          confidence = 0.98
        } else if (
          marginBand(line) &&
          repeated.has(normalizeMarginText(line.text))
        ) {
          kind = line.y < 0.5 ? 'header' : 'footer'
          confidence = 0.99
        } else if (line.y <= 0.08 && line.fontSize <= fontSize * 0.9) {
          kind = 'header'
          confidence = 0.78
        } else if (
          line.y + line.height >= 0.92 &&
          line.fontSize <= fontSize * 0.9
        ) {
          kind = 'footer'
          confidence = 0.78
        } else if (unresolvedMathExtensionLine(line)) {
          kind = 'equation'
          confidence = 0.96
        } else if (inlineStackedFragment?.part === 'formula') {
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
        }
      })

    demoteInlineVisualReferenceContinuations(preliminary)
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
    lineBoundaryDecisions,
  ).flatMap(splitRunBackedSymbolicNoteDefinitions)
  const regions = [...textRegions, ...makeObjectRegions(pages, layouts)].sort(
    (left, right) => {
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
    },
  )
  const readingOrder = buildReadingOrder(regions, layouts)
  return {
    regions,
    lineBoundaryDecisions,
    unresolvedCorruptingJoinCount: lineBoundaryDecisions.filter(
      (decision) => decision.outcome === 'unresolved',
    ).length,
    readingOrder,
    repeatedMarginCount: repeated.size,
    ambiguousPages: [...layouts.entries()]
      .filter(([, layout]) => layout.ambiguous)
      .map(([page]) => page),
  }
}
