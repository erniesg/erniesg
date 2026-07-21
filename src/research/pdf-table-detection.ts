import type { PdfPageRegion, PdfRegionLine } from './import-types'

const FIXED_CELL_GAP_THRESHOLD = 0.012
const COLUMN_ANCHOR_TOLERANCE = 0.025
const MIN_ADAPTIVE_GAP_ROWS = 3
const MIN_ADAPTIVE_GAP_BAND_SEPARATION = 0.002
const MIN_ADAPTIVE_GAP_RATIO = 1.5

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function overlapsCaption(caption: PdfPageRegion, region: PdfPageRegion) {
  const left = Math.max(caption.box.x, region.box.x)
  const right = Math.min(
    caption.box.x + caption.box.width,
    region.box.x + region.box.width,
  )
  return right - left >= Math.min(caption.box.width, region.box.width) * 0.35
}

function clusterRows(lines: PdfRegionLine[]) {
  const ordered = [...lines].sort(
    (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
  )
  const rows: PdfRegionLine[][] = []
  for (const line of ordered) {
    const row = rows.at(-1)
    const anchor = row?.[0]
    const tolerance = Math.max(
      0.003,
      Math.min(anchor?.box.height ?? line.box.height, line.box.height) * 0.85,
    )
    if (anchor && Math.abs(anchor.box.y - line.box.y) <= tolerance)
      row!.push(line)
    else rows.push([line])
  }
  return rows.map<PdfRegionLine>((row, index) => {
    const runs = row.flatMap((line) => line.runs).sort((a, b) => a.x - b.x)
    const left = Math.min(...row.map((line) => line.box.x))
    const top = Math.min(...row.map((line) => line.box.y))
    const right = Math.max(...row.map((line) => line.box.x + line.box.width))
    const bottom = Math.max(...row.map((line) => line.box.y + line.box.height))
    return {
      id: `detected-table-row-${String(index + 1).padStart(3, '0')}`,
      text: runs.map((run) => run.text).join(' '),
      fontSize: Math.min(...row.map((line) => line.fontSize)),
      box: {
        ...row[0].box,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      runs,
    }
  })
}

function orderedRuns(line: PdfRegionLine) {
  return [...line.runs]
    .filter((run) => run.text.trim())
    .sort((left, right) => left.x - right.x)
}

function hasRepeatedBoundaryAnchor(
  evidence: Array<{ boundaryX: number; rowId: string }>,
) {
  const anchors: Array<{ x: number; rowIds: Set<string> }> = []
  for (const item of [...evidence].sort(
    (left, right) => left.boundaryX - right.boundaryX,
  )) {
    const anchor = anchors.find(
      (candidate) =>
        Math.abs(candidate.x - item.boundaryX) <= COLUMN_ANCHOR_TOLERANCE,
    )
    if (!anchor) {
      anchors.push({ x: item.boundaryX, rowIds: new Set([item.rowId]) })
      continue
    }
    anchor.x =
      (anchor.x * anchor.rowIds.size + item.boundaryX) /
      (anchor.rowIds.size + 1)
    anchor.rowIds.add(item.rowId)
  }
  return anchors.some((anchor) => anchor.rowIds.size >= MIN_ADAPTIVE_GAP_ROWS)
}

function adaptiveCellGapThreshold(lines: PdfRegionLine[]) {
  const gaps = lines
    .flatMap((line) => {
      const runs = orderedRuns(line)
      return runs.slice(1).flatMap((run, index) => {
        const previous = runs[index]
        const gap = run.x - (previous.x + previous.width)
        return gap >= 0 && gap < FIXED_CELL_GAP_THRESHOLD
          ? [{ gap, boundaryX: run.x, rowId: line.id }]
          : []
      })
    })
    .sort((left, right) => left.gap - right.gap)
  const candidates: Array<{ threshold: number; separation: number }> = []
  for (let index = 0; index < gaps.length - 1; index += 1) {
    const small = gaps.slice(0, index + 1)
    const large = gaps.slice(index + 1)
    const smallRows = new Set(small.map((item) => item.rowId))
    const largeRows = new Set(large.map((item) => item.rowId))
    if (
      smallRows.size < MIN_ADAPTIVE_GAP_ROWS ||
      largeRows.size < MIN_ADAPTIVE_GAP_ROWS
    ) {
      continue
    }
    const smallMinimum = small[0].gap
    const smallMaximum = small.at(-1)!.gap
    const largeMinimum = large[0].gap
    const largeMaximum = large.at(-1)!.gap
    const separation = largeMinimum - smallMaximum
    if (
      separation < MIN_ADAPTIVE_GAP_BAND_SEPARATION ||
      largeMinimum /
        Math.max(smallMaximum, MIN_ADAPTIVE_GAP_BAND_SEPARATION / 2) <
        MIN_ADAPTIVE_GAP_RATIO ||
      smallMaximum - smallMinimum > separation ||
      largeMaximum - largeMinimum > separation ||
      !hasRepeatedBoundaryAnchor(large)
    ) {
      continue
    }
    candidates.push({
      threshold: (smallMaximum + largeMinimum) / 2,
      separation,
    })
  }
  return (
    candidates.sort(
      (left, right) =>
        right.separation - left.separation || right.threshold - left.threshold,
    )[0]?.threshold ?? FIXED_CELL_GAP_THRESHOLD
  )
}

function rowCells(
  line: PdfRegionLine,
  gapThreshold = FIXED_CELL_GAP_THRESHOLD,
) {
  const runs = orderedRuns(line)
  const groups: (typeof runs)[] = []
  for (const run of runs) {
    const group = groups.at(-1)
    const previous = group?.at(-1)
    if (
      !group ||
      !previous ||
      run.x - (previous.x + previous.width) >= gapThreshold
    ) {
      groups.push([run])
    } else {
      group.push(run)
    }
  }
  return groups.map((group) => {
    const first = group[0]
    const right = Math.max(...group.map((run) => run.x + run.width))
    const bottom = Math.max(...group.map((run) => run.y + run.height))
    return {
      ...first,
      width: right - first.x,
      height: bottom - first.y,
      text: group.map((run) => run.text).join(' '),
    }
  })
}

function columnAnchors(lines: PdfRegionLine[], gapThreshold: number) {
  const anchors: number[] = []
  for (const x of lines
    .flatMap((line) => rowCells(line, gapThreshold).map((cell) => cell.x))
    .sort()) {
    const existing = anchors.findIndex(
      (anchor) => Math.abs(anchor - x) <= COLUMN_ANCHOR_TOLERANCE,
    )
    if (existing === -1) anchors.push(x)
    else anchors[existing] = (anchors[existing] + x) / 2
  }
  return anchors
}

function tableShape(lines: PdfRegionLine[]) {
  const gapThreshold = adaptiveCellGapThreshold(lines)
  const rowColumnCounts = lines
    .map((line) => rowCells(line, gapThreshold).length)
    .filter((count) => count >= 2 && count <= 12)
  const frequency = new Map<number, number>()
  for (const count of rowColumnCounts) {
    frequency.set(count, (frequency.get(count) ?? 0) + 1)
  }
  const modalColumnCount = [...frequency.entries()].sort(
    (left, right) => right[1] - left[1] || right[0] - left[0],
  )[0]?.[0]
  if (!modalColumnCount) return null
  const structuralRows = lines.filter(
    (line) => rowCells(line, gapThreshold).length === modalColumnCount,
  )
  const anchors = columnAnchors(structuralRows, gapThreshold)
  if (anchors.length < 2 || anchors.length > 12) return null
  const populatedRows = lines
    .map((line) => {
      const cells = new Map<number, typeof line.runs>()
      for (const run of rowCells(line, gapThreshold)) {
        let closest = 0
        for (let index = 1; index < anchors.length; index += 1) {
          if (
            Math.abs(anchors[index] - run.x) <
            Math.abs(anchors[closest] - run.x)
          ) {
            closest = index
          }
        }
        cells.set(closest, [...(cells.get(closest) ?? []), run])
      }
      if (cells.size !== anchors.length) return null
      return {
        ...line,
        runs: anchors.map((anchor, index) => {
          const grouped = cells.get(index)!
          return {
            ...grouped[0],
            x: anchor,
            text: grouped.map((run) => run.text).join(' '),
          }
        }),
      }
    })
    .filter((line): line is PdfRegionLine => Boolean(line))
  if (populatedRows.length < 2) return null
  const density =
    populatedRows.reduce((total, line) => total + line.runs.length, 0) /
    (populatedRows.length * anchors.length)
  return density >= 0.35
    ? {
        anchors,
        rows: populatedRows,
        density,
        structure: 'rectangular' as const,
      }
    : null
}

function directionalCandidate(
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  direction: 'above' | 'below',
) {
  const maximumDistance = direction === 'above' ? 0.22 : 0.16
  const directionalRegions = regions.filter((region) => {
    if (
      region.page !== caption.page ||
      region.id === caption.id ||
      region.lines.length === 0 ||
      ['caption', 'page-number', 'figure'].includes(region.kind) ||
      ((region.kind === 'header' || region.kind === 'footer') &&
        (region.box.y < 0.1 || region.box.y > 0.9))
    ) {
      return false
    }
    const distance =
      direction === 'above'
        ? caption.box.y - (region.box.y + region.box.height)
        : region.box.y - (caption.box.y + caption.box.height)
    return distance >= -0.004 && distance <= maximumDistance
  })
  const eligibleRegions = directionalRegions.filter(
    (region) =>
      overlapsCaption(caption, region) &&
      (region.column === caption.column ||
        region.column === 'span' ||
        caption.column === 'span'),
  )
  const orderedRegions = [...eligibleRegions].sort((left, right) =>
    direction === 'above'
      ? right.box.y + right.box.height - (left.box.y + left.box.height)
      : left.box.y - right.box.y,
  )
  let sourceRegions: PdfPageRegion[] = []
  let frontier =
    direction === 'above' ? caption.box.y : caption.box.y + caption.box.height
  for (const region of orderedRegions) {
    const edge =
      direction === 'above' ? region.box.y + region.box.height : region.box.y
    const gap = direction === 'above' ? frontier - edge : edge - frontier
    if (sourceRegions.length > 0 && gap > 0.018) break
    sourceRegions.push(region)
    frontier =
      direction === 'above'
        ? Math.min(frontier, region.box.y)
        : Math.max(frontier, region.box.y + region.box.height)
  }
  const sourceLines = sourceRegions.flatMap((region) => region.lines)
  const sourceFontSize = median(sourceLines.map((line) => line.fontSize))
  const captionFontSize = median(caption.lines.map((line) => line.fontSize))
  if (
    sourceLines.length >= 2 &&
    sourceFontSize > 0 &&
    captionFontSize > 0 &&
    sourceFontSize <= captionFontSize * 0.9
  ) {
    const rowPeers = directionalRegions.filter(
      (region) =>
        !sourceRegions.some((source) => source.id === region.id) &&
        region.lines.some((line) =>
          sourceLines.some((sourceLine) => {
            const tolerance = Math.max(
              0.003,
              Math.min(line.box.height, sourceLine.box.height) * 0.85,
            )
            const fontRatio =
              Math.max(line.fontSize, sourceLine.fontSize) /
              Math.max(1, Math.min(line.fontSize, sourceLine.fontSize))
            return (
              Math.abs(line.box.y - sourceLine.box.y) <= tolerance &&
              fontRatio <= 1.15
            )
          }),
        ),
    )
    sourceRegions = [...sourceRegions, ...rowPeers]
  }
  const lines = clusterRows(sourceRegions.flatMap((region) => region.lines))
  const shape = tableShape(lines)
  if (!shape) return null
  const usedRegions = sourceRegions.filter((region) =>
    region.lines.some((line) =>
      shape.rows.some(
        (row) =>
          Math.abs(row.box.y - line.box.y) <=
          Math.max(0.003, Math.min(row.box.height, line.box.height) * 0.85),
      ),
    ),
  )
  if (usedRegions.length === 0) return null
  const nearest = Math.min(
    ...usedRegions.map((region) =>
      direction === 'above'
        ? caption.box.y - (region.box.y + region.box.height)
        : region.box.y - (caption.box.y + caption.box.height),
    ),
  )
  return {
    sourceRegions: usedRegions,
    lines: shape.rows,
    structure: shape.structure,
    score:
      shape.density + (direction === 'above' ? 0.2 : 0) - Math.max(nearest, 0),
    direction,
  }
}

export function detectTableNearCaption(
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
) {
  return (
    (['above', 'below'] as const)
      .map((direction) => directionalCandidate(caption, regions, direction))
      .filter((candidate): candidate is NonNullable<typeof candidate> =>
        Boolean(candidate),
      )
      .sort((left, right) => right.score - left.score)[0] ?? null
  )
}
