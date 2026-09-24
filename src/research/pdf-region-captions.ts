import type {
  PdfFurnitureEvidence,
  PdfFurnitureReview,
  PdfPageAnalysis,
  PdfRegionKind,
  PdfSourceFragmentLineage,
} from './import-types'
import { mergePdfRunText, type PdfTextLine } from './pdf-lines'
import {
  beginsVisualCaption,
  inlineStackedFragmentParts,
  sourceLineFlowOrder,
} from './pdf-region-line-analysis'

type ClassifiedLine = PdfTextLine & {
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

function splitSourceCaptionLaneContinuations(lines: ClassifiedLine[]) {
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

export {
  classifiedLineFragment,
  demoteInlineVisualReferenceContinuations,
  endsCaptionSentence,
  endsIncompleteWrappedUrl,
  markAdjacentPanelLabelContinuations,
  promoteCaptionContinuations,
  splitSourceCaptionLaneContinuations,
}
export type { ClassifiedLine }
