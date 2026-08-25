import type {
  PdfFurnitureEvidence,
  PdfFurnitureReview,
  PdfPageAnalysis,
  PdfReadingOrderAmbiguityClass,
  PdfReadingOrderEvidence,
  PdfReadingOrderResolution,
  PdfRegionColumn,
  PdfRegionKind,
  PdfSourceFragmentLineage,
} from './import-types'
import { mergePdfRunText, type PdfTextLine } from './pdf-lines'
import { normalizedNoteLabel } from './note-label'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  inlineStackedFragmentParts,
  READING_ORDER_RESOLUTION_POLICY_VERSION,
  READING_ORDER_RESOLUTION_THRESHOLD,
} from './pdf-reading-order'
import { sourceLineFlowOrder, textLineFromRuns } from './pdf-source-math'

export type ClassifiedLine = PdfTextLine & {
  id: string
  kind: PdfRegionKind
  confidence: number
  noteLabel: string | null
  captionContinuationSeedId?: string
  panelLabelContinuationSeedId?: string
  noteContinuationSeedId?: string
  headingContinuationSeedId?: string
  displayEquationClusterSeedId?: string
  tabularGridBandId?: string
  captionLaneSplitAmbiguous?: boolean
  sourceFragmentLineage?: PdfSourceFragmentLineage
  furniture?: PdfFurnitureEvidence
  furnitureReview?: PdfFurnitureReview
}

export type ColumnLayout = {
  split: number | null
  accepted: boolean
  ambiguous: boolean
  resolution: Omit<PdfReadingOrderResolution, 'page' | 'regionIds'> | null
  tabularGridBands?: ReadonlyMap<string, string>
  tabularGridColumns?: ReadonlyMap<string, PdfRegionColumn>
}

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

export function beginsVisualCaption(text: string) {
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

export function dominantIndent(lines: ClassifiedLine[]) {
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

export function endsCaptionSentence(text: string) {
  return /[.!?][”’'"\])}]*$/u.test(text.trim())
}

export function endsIncompleteWrappedUrl(text: string) {
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

export function captionFontFamily(fontName: string) {
  const normalized = fontName.trim().toLocaleLowerCase()
  if (/^[a-z][a-z0-9]*_d\d+_f\d+$/u.test(normalized)) {
    return normalized.replace(/[^a-z0-9]+/gu, '')
  }
  return normalized
    .replace(/^[a-z]{6}\+/iu, '')
    .replace(/mt$/iu, '')
    .replace(/ps(?=[-+_,.\s]|$)/iu, '')
    .replace(
      /(?:[-+_,.\s]*(?:bold|black|demi(?:bold)?|semibold|medium|regular|roman|book|italic|ital|oblique|obl))+$/iu,
      '',
    )
    .replace(
      /(?:[-+_,.\s]+(?:reguital|medi|regu|bdit|bdi|bi|bd|it|reg|rm|md|med|lt|sb))+$/iu,
      '',
    )
    .replace(/\d+$/u, '')
    .replace(/[^a-z0-9]+/gu, '')
}

function captionLineDominantFontFamily(line: PdfTextLine) {
  const counts = new Map<string, number>()
  for (const run of line.runs) {
    const textLength = run.text.replace(/\s/gu, '').length
    if (textLength === 0) continue
    const family = captionFontFamily(run.fontName)
    if (!family) continue
    counts.set(family, (counts.get(family) ?? 0) + textLength)
  }
  return (
    [...counts.entries()].sort(
      ([leftFamily, leftCount], [rightFamily, rightCount]) =>
        rightCount - leftCount || leftFamily.localeCompare(rightFamily),
    )[0]?.[0] ?? null
  )
}

function captionTypographyCompatible(
  seed: PdfTextLine,
  candidate: PdfTextLine,
) {
  return (
    captionLineDominantFontFamily(seed) ===
    captionLineDominantFontFamily(candidate)
  )
}

function captionLaneCompatible(
  seed: PdfTextLine,
  previous: PdfTextLine,
  candidate: PdfTextLine,
) {
  const boundary =
    seed.sourceCaptionLaneBoundary ?? previous.sourceCaptionLaneBoundary
  const side = seed.sourceCaptionLaneSide ?? previous.sourceCaptionLaneSide
  if (boundary === undefined || side === undefined) return true
  if (
    (candidate.sourceCaptionLaneBoundary !== undefined &&
      Math.abs(candidate.sourceCaptionLaneBoundary - boundary) > 0.002) ||
    (candidate.sourceCaptionLaneSide !== undefined &&
      candidate.sourceCaptionLaneSide !== side)
  ) {
    return false
  }
  const left = candidate.x
  const right = candidate.x + candidate.width
  const tolerance = 0.004
  if (candidate.sourceCaptionLaneSide === undefined) {
    if (side === 'left' && right > boundary - tolerance) return false
    if (side === 'right' && left < boundary + tolerance) return false
  }
  if (left < boundary - tolerance && right > boundary + tolerance) {
    return false
  }
  const center = left + candidate.width / 2
  return side === 'left'
    ? center <= boundary + tolerance
    : center >= boundary - tolerance
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
  enforceCaptionLane = true,
) {
  if (candidate.captionLaneSplitAmbiguous) return false
  if (
    (enforceCaptionLane && !captionLaneCompatible(seed, previous, candidate)) ||
    !captionTypographyCompatible(seed, candidate)
  ) {
    return false
  }
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

function sourceCaptionLaneSeedPairs(lines: ClassifiedLine[]) {
  const seeds = lines.filter(
    (line) =>
      line.kind === 'caption' &&
      line.sourceCaptionLaneBoundary !== undefined &&
      (line.sourceCaptionLaneSide === 'left' ||
        line.sourceCaptionLaneSide === 'right'),
  )
  const candidates = seeds.flatMap((left) => {
    if (left.sourceCaptionLaneSide !== 'left') return []
    const rightCandidates = seeds.filter(
      (right) =>
        right.sourceCaptionLaneSide === 'right' &&
        right.page === left.page &&
        right.sourceCaptionLaneBoundary === left.sourceCaptionLaneBoundary &&
        Math.abs(left.y + left.height / 2 - (right.y + right.height / 2)) <=
          Math.max(0.004, left.height * 0.65, right.height * 0.65),
    )
    return rightCandidates.length === 1
      ? [
          {
            left,
            right: rightCandidates[0],
            boundary: left.sourceCaptionLaneBoundary!,
          },
        ]
      : []
  })
  return candidates.filter(
    ({ left, right, boundary }) =>
      candidates.filter(
        (candidate) =>
          candidate.right.id === right.id && candidate.boundary === boundary,
      ).length === 1 &&
      left.x + left.width <= boundary &&
      right.x >= boundary,
  )
}

export function splitSourceCaptionLaneContinuations(lines: ClassifiedLine[]) {
  const output = [...lines]
  const claimed = new Set<string>()
  for (const pair of sourceCaptionLaneSeedPairs(output)) {
    let leftPrevious = pair.left
    let rightPrevious = pair.right
    while (true) {
      const candidates = output.flatMap((line) => {
        if (
          claimed.has(line.id) ||
          line.page !== pair.left.page ||
          beginsVisualCaption(line.text) ||
          line.sourceCaptionLaneSide !== undefined ||
          line.runs.length < 2 ||
          line.x >= pair.boundary ||
          line.x + line.width <= pair.boundary
        ) {
          return []
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
              Math.max(
                0.002,
                Math.min(leftRun.height, rightRun.height) * 0.2,
              ) ||
            Math.abs(center - pair.boundary) > 0.02
          ) {
            return []
          }
          const left = {
            ...classifiedLineFragment(line, runs.slice(0, index), 'left'),
            sourceCaptionLaneBoundary: pair.boundary,
            sourceCaptionLaneSide: 'left' as const,
          }
          const right = {
            ...classifiedLineFragment(line, runs.slice(index), 'right'),
            sourceCaptionLaneBoundary: pair.boundary,
            sourceCaptionLaneSide: 'right' as const,
          }
          return captionContinuationGeometry(
            pair.left,
            leftPrevious,
            left,
            false,
          ) &&
            captionContinuationGeometry(pair.right, rightPrevious, right, false)
            ? [{ line, left, right }]
            : []
        })
        if (boundaries.length !== 1) {
          if (
            captionContinuationGeometry(pair.left, leftPrevious, line, false) ||
            captionContinuationGeometry(pair.right, rightPrevious, line, false)
          ) {
            line.captionLaneSplitAmbiguous = true
          }
          return []
        }
        return boundaries
      })
      const orderedCandidates = candidates.sort(
        (left, right) =>
          Math.max(left.left.y, left.right.y) -
            Math.max(right.left.y, right.right.y) ||
          left.line.id.localeCompare(right.line.id),
      )
      const first = orderedCandidates[0]
      if (!first) break
      const firstCenter = first.line.y + first.line.height / 2
      const immediateCandidates = orderedCandidates.filter((candidate) => {
        const center = candidate.line.y + candidate.line.height / 2
        return (
          Math.abs(center - firstCenter) <=
          Math.max(
            0.004,
            first.line.height * 0.65,
            candidate.line.height * 0.65,
          )
        )
      })
      if (immediateCandidates.length !== 1) {
        for (const candidate of immediateCandidates) {
          candidate.line.captionLaneSplitAmbiguous = true
        }
        break
      }
      const [next] = immediateCandidates

      const index = output.indexOf(next.line)
      if (index < 0) break
      output.splice(index, 1, next.left, next.right)
      claimed.add(next.line.id)
      leftPrevious = next.left
      rightPrevious = next.right
    }
  }
  return output
}

export function demoteInlineVisualReferenceContinuations(
  lines: ClassifiedLine[],
) {
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
export function promoteCaptionContinuations(lines: ClassifiedLine[]) {
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
export function markAdjacentPanelLabelContinuations(
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

export function promoteNoteContinuations(lines: ClassifiedLine[]) {
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
  column: Extract<PdfRegionColumn, 'left' | 'right' | 'span'>
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

function strictTabularNumericCell(text: string) {
  return /^(?:[<>≤≥~≈])?[+\-−]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:(?:[eE][+\-−]?\d+)|(?:[x×]10[+\-−]?\d+))?(?:%|[x×])?$/u.test(
    text.replace(/\s+/gu, ''),
  )
}

function denseTabularGridBand(band: Omit<TabularGridBand, 'fragments'>) {
  const fragments = tabularGridFragments(band.lines)
  if (fragments.length < 4) return null
  const coverage = fragments.at(-1)!.right - fragments[0].left
  const compactFragments = fragments.filter((fragment) => {
    const wordCount = fragment.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
    return fragment.right - fragment.left <= 0.18 || wordCount <= 3
  }).length
  const minimumCoverage = band.column === 'span' ? 0.45 : 0.2
  const coversColumnLane =
    band.column === 'span' ||
    (band.column === 'left'
      ? fragments.at(-1)!.right >= 0.42
      : fragments[0].left <= 0.58)
  const provesLaneNumericMatrixBody =
    band.column === 'span' ||
    (!strictTabularNumericCell(fragments[0].text) &&
      /\p{L}/u.test(fragments[0].text) &&
      fragments
        .slice(1)
        .every((fragment) => strictTabularNumericCell(fragment.text)))
  if (
    coverage < minimumCoverage ||
    compactFragments < fragments.length * 0.75 ||
    !coversColumnLane ||
    !provesLaneNumericMatrixBody
  ) {
    return null
  }
  return { ...band, fragments }
}

/**
 * Dense table rows can repeat many source-run anchors while presenting only
 * two or three grouped text lines. Those repeated cell gaps are not evidence
 * for page columns. Identify compact full-width grids, or numeric grids wholly
 * inside one page lane, with at least four recurring anchors in three adjacent
 * row bands; ordinary two-column prose therefore remains eligible to prove its
 * real gutter.
 */
function denseTabularGridBands(lines: ClassifiedLine[]) {
  const bands: Array<Omit<TabularGridBand, 'fragments' | 'column'>> = []
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

  const denseBands = bands.flatMap<TabularGridBand>((band) => {
    const spanning = denseTabularGridBand({ ...band, column: 'span' })
    if (
      spanning &&
      !hasParallelProseColumnLines(spanning.lines) &&
      !hasParallelProseColumnFragments(spanning.fragments)
    ) {
      return [spanning]
    }
    // A table can occupy one page column while prose continues in the other.
    // Keep only whole PDF.js-backed lines on each side of the page center;
    // never split a source run or synthesize a character/cell box.
    return [
      {
        column: 'left' as const,
        lines: band.lines.filter((line) => line.x + line.width <= 0.49),
      },
      {
        column: 'right' as const,
        lines: band.lines.filter((line) => line.x >= 0.51),
      },
    ]
      .filter((candidate) => candidate.lines.length > 0)
      .flatMap((candidate) => {
        const dense = denseTabularGridBand({
          center: band.center,
          lines: candidate.lines,
          column: candidate.column,
        })
        return dense ? [dense] : []
      })
  })

  const recurringBands = denseBands.filter((band) => {
    const recurringFragments = band.fragments.filter((fragment) => {
      const matchingBands = denseBands.filter(
        (candidate) =>
          candidate !== band &&
          candidate.column === band.column &&
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
    (left, right) =>
      left.column.localeCompare(right.column) || left.center - right.center,
  )) {
    const cluster = adjacentClusters.at(-1)
    if (
      cluster &&
      cluster[0].column === band.column &&
      band.center - cluster.at(-1)!.center <= 0.08
    ) {
      cluster.push(band)
    } else {
      adjacentClusters.push([band])
    }
  }

  const entries = adjacentClusters.flatMap((cluster, clusterIndex) =>
    cluster.length < 3
      ? []
      : cluster.flatMap((band, bandIndex) =>
          band.lines.map(
            (line) =>
              ({
                lineId: line.id,
                bandId: `tabular-grid-${cluster[0].column}-${clusterIndex + 1}-band-${bandIndex + 1}`,
                column: cluster[0].column,
              }) as const,
          ),
        ),
  )
  return {
    bands: new Map(entries.map((entry) => [entry.lineId, entry.bandId])),
    columns: new Map(
      entries.map((entry) => [entry.lineId, entry.column] as const),
    ),
  }
}

export function detectColumns(lines: ClassifiedLine[]): ColumnLayout {
  const sideLines = lines.filter((line) => line.kind === 'side')
  const tabularGrid = denseTabularGridBands(lines)
  const tabularGridBands = tabularGrid.bands
  const tabularGridColumns = tabularGrid.columns
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
        tabularGridColumns,
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
      tabularGridColumns,
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
      tabularGridColumns,
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
    tabularGridColumns,
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

export function columnFor(
  line: PdfTextLine & { id?: string },
  layout: ColumnLayout,
): PdfRegionColumn {
  const tabularColumn = line.id
    ? layout.tabularGridColumns?.get(line.id)
    : undefined
  if (tabularColumn && tabularColumn !== 'span') return tabularColumn
  if (layout.split === null) return 'single'
  if (tabularColumn) return tabularColumn
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

export function classifiedLineFragment(
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
  const sourceSequenceIndexes = orderedRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  const sourceFragmentLineage =
    sourceSequenceIndexes.length === orderedRuns.length &&
    new Set(sourceSequenceIndexes).size === sourceSequenceIndexes.length
      ? {
          algorithm: 'source-run-fragment-v1' as const,
          sourceLineId: source.id,
          fragment: `cross-gutter-${suffix}` as const,
          sourceSequenceIndexes,
        }
      : undefined
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
    ...(sourceFragmentLineage ? { sourceFragmentLineage } : {}),
  }
}
