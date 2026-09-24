import type {
  PdfReadingOrderAmbiguityClass,
  PdfReadingOrderEvidence,
  PdfReadingOrderResolution,
  PdfRegionColumn,
} from './import-types'
import { mergePdfRunText, type PdfTextLine } from './pdf-lines'
import {
  classifiedLineFragment,
  type ClassifiedLine,
} from './pdf-region-captions'
import {
  alignedBandCount,
  distinctLines,
  maximumVerticalGap,
  median,
  spread,
} from './pdf-region-note-classification'

type ColumnLayout = {
  split: number | null
  accepted: boolean
  ambiguous: boolean
  resolution: Omit<PdfReadingOrderResolution, 'page' | 'regionIds'> | null
  tabularGridBands?: ReadonlyMap<string, string>
  tabularGridColumns?: ReadonlyMap<string, PdfRegionColumn>
}

export const READING_ORDER_RESOLUTION_POLICY_VERSION = '1.0.0' as const
export const READING_ORDER_RESOLUTION_THRESHOLD = 0.85

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
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

function detectColumns(lines: ClassifiedLine[]): ColumnLayout {
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

function columnFor(
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

export { columnFor, detectColumns, rounded }
export type { ColumnLayout }
