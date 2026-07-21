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
  type PdfTextLine,
} from './pdf-lines'

type ClassifiedLine = PdfTextLine & {
  id: string
  kind: PdfRegionKind
  confidence: number
  noteLabel: string | null
  captionContinuationSeedId?: string
}

type ColumnLayout = {
  split: number | null
  accepted: boolean
  ambiguous: boolean
  resolution: Omit<PdfReadingOrderResolution, 'page' | 'regionIds'> | null
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

function repeatedMarginKeys(linesByPage: PdfTextLine[][]) {
  const occurrences = new Map<string, Set<number>>()
  for (const lines of linesByPage) {
    for (const line of lines) {
      if (line.y > 0.1 && line.y + line.height < 0.9) continue
      const key = normalizeMarginText(line.text)
      if (!key || key.length > 160) continue
      const pages = occurrences.get(key) ?? new Set<number>()
      pages.add(line.page)
      occurrences.set(key, pages)
    }
  }
  return new Set(
    [...occurrences.entries()]
      .filter(([, pages]) => pages.size >= 2)
      .map(([key]) => key),
  )
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

function bodyFontSize(lines: PdfTextLine[]) {
  const central = lines.filter(
    (line) => line.y > 0.1 && line.y + line.height < 0.9,
  )
  const sizes = (central.length > 0 ? central : lines)
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

function endsCaptionSentence(text: string) {
  return /[.!?][”’'"\])}]*$/u.test(text.trim())
}

function captionContinuationGeometry(
  seed: ClassifiedLine,
  previous: ClassifiedLine,
  candidate: ClassifiedLine,
) {
  if (
    candidate.page !== seed.page ||
    (candidate.kind !== 'body' && candidate.kind !== 'caption')
  )
    return false
  if (candidate.y <= previous.y + previous.height * 0.35) return false

  const gap = candidate.y - (previous.y + previous.height)
  const maximumGap = Math.max(
    0.006,
    Math.max(previous.height, candidate.height) * 0.72,
  )
  if (gap < -0.004 || gap > maximumGap) return false

  const fontRatio =
    Math.max(seed.fontSize, candidate.fontSize) /
    Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
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
    let widestLine = Math.max(
      seed.width,
      ...lines
        .filter((line) => {
          const fontRatio =
            Math.max(seed.fontSize, line.fontSize) /
            Math.max(1, Math.min(seed.fontSize, line.fontSize))
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

      candidate.kind = 'caption'
      candidate.captionContinuationSeedId = seed.id
      candidate.confidence = Math.min(seed.confidence, candidate.confidence)
      claimed.add(candidate.id)
      widestLine = Math.max(widestLine, candidate.width)
      previous = candidate
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
    while (!endsCaptionSentence(previous.text)) {
      const candidate = lines
        .filter((line) => {
          if (
            line.page !== seed.page ||
            line.kind !== 'body' ||
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
      candidate.confidence = Math.min(seed.confidence, candidate.confidence)
      claimed.add(candidate.id)
      previous = candidate
    }
  }
}

function detectColumns(lines: ClassifiedLine[]): ColumnLayout {
  const sideLines = lines.filter((line) => line.kind === 'side')
  const candidates = lines.filter(
    (line) => line.kind === 'body' && line.text.length > 1 && line.width < 0.72,
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
  const strongest = clusters.sort(
    (left, right) =>
      right.members.length - left.members.length || left.split - right.split,
  )[0]
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
      detail: `${alignedBands} aligned bands repeat a normalized gutter at ${rounded(strongest.split)} with maximum deviation ${rounded(splitDeviation)}.`,
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

function columnFor(line: PdfTextLine, layout: ColumnLayout): PdfRegionColumn {
  if (layout.split === null) return 'single'
  const tolerance = Math.max(0.006, line.height * 0.4)
  if (line.x + line.width <= layout.split + tolerance) return 'left'
  if (line.x >= layout.split - tolerance) return 'right'
  return 'span'
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

function joinsRegion(previous: ClassifiedLine, line: ClassifiedLine) {
  if (previous.page !== line.page) return false
  if (previous.kind !== line.kind || previous.column !== line.column)
    return false
  if (
    (line.kind === 'footnote' || line.kind === 'endnote') &&
    line.noteLabel !== null
  ) {
    return false
  }
  if (line.kind === 'chart-label' || line.kind === 'page-number') return false
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
    /^(?:\[\s*\d+\s*\]|\(\s*(?:\d+|[A-Za-z]|[ivxlcdm]+)\s*\)|(?:\d+|[A-Za-z]|[ivxlcdm]+)[.)])\s+/i
  if (listItem.test(line.text.trim())) {
    return false
  }
  const gap = line.y - (previous.y + previous.height)
  const fontRatio =
    Math.max(previous.fontSize, line.fontSize) /
    Math.max(1, Math.min(previous.fontSize, line.fontSize))
  if (gap < -0.004 || fontRatio > 1.18) return false
  const lineHeight = Math.max(previous.height, line.height)
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
    indent >= Math.max(0.018, first.height) &&
    Math.abs(line.x - first.x) <= tolerance &&
    Math.abs(previous.x - continuationX) <= tolerance
  )
}

function makeRegions(
  lines: ClassifiedLine[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  lineBoundaryDecisions: PdfLineBoundaryDecision[],
) {
  const groups: ClassifiedLine[][] = []
  const ordered = [...lines].sort(
    (left, right) =>
      left.page - right.page ||
      left.column.localeCompare(right.column) ||
      left.y - right.y ||
      left.x - right.x,
  )
  for (const line of ordered) {
    const previousGroup = groups.at(-1)
    const previous = previousGroup?.at(-1)
    if (
      previous &&
      !beginsRepeatedFirstLineIndent(previousGroup!, line) &&
      joinsRegion(previous, line)
    )
      previousGroup!.push(line)
    else groups.push([line])
  }

  const sourceOrderedGroups = groups.sort(
    (left, right) =>
      left[0].page - right[0].page ||
      left[0].y - right[0].y ||
      left[0].x - right[0].x,
  )
  const pageCounters = new Map<number, number>()
  return sourceOrderedGroups.map<PdfPageRegion>((group) => {
    const page = group[0].page
    const number = (pageCounters.get(page) ?? 0) + 1
    pageCounters.set(page, number)
    const id = `page-${String(page).padStart(3, '0')}-region-${String(number).padStart(3, '0')}`
    const regionLines = group.map<PdfRegionLine>((line) => ({
      id: line.id,
      text: line.text,
      fontSize: rounded(line.fontSize),
      box: lineBox(line),
      runs: line.runs.map((run) => ({ ...run })),
    }))
    const kind = group[0].kind
    return {
      id,
      page,
      kind,
      column: group[0].column,
      text: joinPdfLineTexts(group, {
        hardHyphenLexicon,
        unhyphenatedLexicon,
        regionId: id,
        decisions: lineBoundaryDecisions,
      }),
      confidence: rounded(Math.min(...group.map((line) => line.confidence))),
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
  const byY = (left: PdfPageRegion, right: PdfPageRegion) =>
    left.box.y - right.box.y || left.box.x - right.box.x
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
        (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
      ),
      ...notes.sort(
        (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
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
  const rawLines = pages.map(groupRunsIntoLines)
  const hardHyphenLexicon = inlineHardHyphenLexicon(rawLines.flat())
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(rawLines.flat())
  const repeated = repeatedMarginKeys(rawLines)
  const classified: ClassifiedLine[] = []
  const layouts = new Map<number, ColumnLayout>()
  let inEndnotes = false

  for (const [pageIndex, pageLines] of rawLines.entries()) {
    const page = pages[pageIndex]
    const fontSize = bodyFontSize(pageLines)
    const lowerBand = quantile(
      pageLines.map((line) => line.y + line.height),
      0.65,
    )
    const preliminary = pageLines
      .sort((left, right) => left.y - right.y || left.x - right.x)
      .map<ClassifiedLine>((line, lineIndex) => {
        const normalized = normalizedNoteLabel(line.text)
        const endnoteHeading = /^(?:endnotes?|notes?)$/i.test(normalized)
        const label = noteLabelFromText(normalized)
        const explicitFootnote = new RegExp(
          `^(?:footnote|note)\\s+${NOTE_LABEL}`,
          'i',
        ).test(normalized)
        const symbolicFootnote = /^[*†‡§]/u.test(normalized)
        const renderedFootnote =
          label !== null &&
          line.y + line.height >= lowerBand &&
          line.fontSize <= fontSize * (symbolicFootnote ? 0.96 : 0.9)
        let kind: PdfRegionKind = 'body'
        let confidence = 0.9
        if (inEndnotes && label !== null) {
          kind = 'endnote'
          confidence = 0.96
        } else if (explicitFootnote || renderedFootnote) {
          kind = 'footnote'
          confidence = explicitFootnote ? 0.98 : 0.9
        } else if (
          page.page === 1 &&
          /^arxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\b/i.test(normalized) &&
          line.width >= 0.45 &&
          line.height <= 0.04 &&
          line.fontSize >= 16
        ) {
          kind = 'side'
          confidence = 0.99
        } else if (
          (line.y <= 0.1 || line.y + line.height >= 0.9) &&
          /^(?:\d{1,4}|[ivxlcdm]+)$/i.test(normalized)
        ) {
          kind = 'page-number'
          confidence = 0.98
        } else if (
          (line.y <= 0.08 || line.y + line.height >= 0.92) &&
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
        } else if (
          /^(?:(?:fig(?:ure)?|table|eq(?:uation)?)\.?\s*(?:\d+|[ivxlcdm]+)(?:\s*[.:–—-]|\s*$)|figure\s*[:.–—-])/i.test(
            normalized,
          )
        ) {
          kind = 'caption'
          confidence = 0.94
        } else if (
          line.fontSize >= fontSize * 0.95 &&
          line.text.length <= 120 &&
          /(?:=|[+−×÷∫∑√≤≥≈])/u.test(line.text)
        ) {
          kind = 'equation'
          confidence = 0.9
        } else if (
          line.fontSize <= fontSize * 0.82 &&
          normalized.length <= 32 &&
          /(?:%|^[-+]?\d+(?:\.\d+)?$|^[A-Za-z]{2,12}$)/.test(normalized)
        ) {
          kind = 'chart-label'
          confidence = 0.82
        }
        if (endnoteHeading) inEndnotes = true
        return {
          ...line,
          id: `page-${String(page.page).padStart(3, '0')}-line-${String(lineIndex + 1).padStart(4, '0')}`,
          kind,
          confidence,
          noteLabel: label,
        }
      })

    promoteCaptionContinuations(preliminary)
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
    layouts.set(page.page, layout)
    const commonX = median(
      preliminary.filter((line) => line.kind === 'body').map((line) => line.x),
    )
    for (const line of preliminary) {
      const continuationSeed = line.captionContinuationSeedId
        ? preliminary.find(
            (candidate) => candidate.id === line.captionContinuationSeedId,
          )
        : undefined
      line.column = continuationSeed
        ? columnFor(continuationSeed, layout)
        : columnFor(line, layout)
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
      classified.push(line)
    }
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
  const regions = [
    ...makeRegions(
      classified,
      hardHyphenLexicon,
      unhyphenatedLexicon,
      lineBoundaryDecisions,
    ),
    ...makeObjectRegions(pages, layouts),
  ].sort(
    (left, right) =>
      left.page - right.page ||
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
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
