import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'

const FIXED_CELL_GAP_THRESHOLD = 0.012
const COLUMN_ANCHOR_TOLERANCE = 0.025
const MIN_ADAPTIVE_GAP_ROWS = 3
const MIN_ADAPTIVE_GAP_BAND_SEPARATION = 0.002
const MIN_ADAPTIVE_GAP_RATIO = 1.5
export const PDF_TABLE_COLUMN_CENTER_TOLERANCE = 0.045
const COLUMN_CENTER_TOLERANCE = PDF_TABLE_COLUMN_CENTER_TOLERANCE
const MAX_TABLE_LOCAL_HEADER_GAP = 0.024

export type PdfDetectedTableHeaderEvidence = {
  kind: 'table-local-geometry'
  sourceRegionIds: string[]
  sourceLineIds: string[]
  detectedHeaderLineIds: string[]
}

type TableLineEntry = {
  region: PdfPageRegion
  line: PdfRegionLine
}

type ClusteredTableRow = PdfRegionLine & {
  sourceLineIds: string[]
  sourceRegionIds: string[]
  sourceRegionKinds: PdfPageRegion['kind'][]
  sourceCellBoxes?: NormalizedSourceBox[]
}

type DetectedTableCellRun = PdfSourceRun & {
  sourceLineIds?: string[]
}

export type PdfDetectedTableGrid = {
  sourceRegions: PdfPageRegion[]
  sourceLineIds: string[]
  lines: Array<
    ClusteredTableRow & {
      cells: Array<{
        run: PdfSourceRun
        columnIndex: number
        columnSpan: number
        rowSpan: number
      }>
    }
  >
  columnCount: number
  headerRowCount: number
  evidence: string[]
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function normalizedSourceBox(run: PdfSourceRun): NormalizedSourceBox {
  return {
    page: run.page,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
  }
}

function overlapsCaption(caption: PdfPageRegion, region: PdfPageRegion) {
  const left = Math.max(caption.box.x, region.box.x)
  const right = Math.min(
    caption.box.x + caption.box.width,
    region.box.x + region.box.width,
  )
  return right - left >= Math.min(caption.box.width, region.box.width) * 0.35
}

function clusterRows(entries: TableLineEntry[]) {
  const ordered = [...entries].sort(
    (left, right) =>
      left.line.box.y - right.line.box.y ||
      left.line.box.x - right.line.box.x ||
      left.region.id.localeCompare(right.region.id) ||
      left.line.id.localeCompare(right.line.id),
  )
  const rows: TableLineEntry[][] = []
  for (const entry of ordered) {
    const row = rows.at(-1)
    const anchor = row?.[0]?.line
    const line = entry.line
    const tolerance = Math.max(
      0.003,
      Math.min(anchor?.box.height ?? line.box.height, line.box.height) * 0.85,
    )
    if (anchor && Math.abs(anchor.box.y - line.box.y) <= tolerance)
      row!.push(entry)
    else rows.push([entry])
  }
  return rows.map<ClusteredTableRow>((row, index) => {
    const runs = row
      .flatMap((entry) => entry.line.runs)
      .sort((a, b) => a.x - b.x)
    const left = Math.min(...row.map((entry) => entry.line.box.x))
    const top = Math.min(...row.map((entry) => entry.line.box.y))
    const right = Math.max(
      ...row.map((entry) => entry.line.box.x + entry.line.box.width),
    )
    const bottom = Math.max(
      ...row.map((entry) => entry.line.box.y + entry.line.box.height),
    )
    return {
      id: `detected-table-row-${String(index + 1).padStart(3, '0')}`,
      text: runs.map((run) => run.text).join(' '),
      fontSize: Math.min(...row.map((entry) => entry.line.fontSize)),
      box: {
        ...row[0].line.box,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      runs,
      sourceLineIds: row.map((entry) => entry.line.id).sort(),
      sourceRegionIds: [...new Set(row.map((entry) => entry.region.id))].sort(),
      sourceRegionKinds: [
        ...new Set(row.map((entry) => entry.region.kind)),
      ].sort(),
    }
  })
}

function pageHeaderCandidateRow(row: ClusteredTableRow) {
  return (
    row.sourceRegionKinds.length > 0 &&
    row.sourceRegionKinds.every((kind) => kind === 'header')
  )
}

export function mergeWrappedHeaderContinuationRuns(
  headerRuns: readonly PdfSourceRun[],
  continuationRuns: readonly PdfSourceRun[],
) {
  if (
    headerRuns.length < 2 ||
    continuationRuns.length === 0 ||
    continuationRuns.length >= headerRuns.length
  ) {
    return null
  }
  const anchor = headerRuns[0]
  const headerTop = Math.min(...headerRuns.map((run) => run.y))
  const headerBottom = Math.max(...headerRuns.map((run) => run.y + run.height))
  const continuationTop = Math.min(...continuationRuns.map((run) => run.y))
  const verticalGap = continuationTop - headerBottom
  if (
    headerRuns.some(
      (run) =>
        run.page !== anchor.page ||
        run.rotation !== anchor.rotation ||
        run.method !== anchor.method,
    ) ||
    continuationRuns.some(
      (run) =>
        run.page !== anchor.page ||
        run.rotation !== anchor.rotation ||
        run.method !== anchor.method,
    ) ||
    verticalGap < -0.003 ||
    verticalGap > Math.max(0.004, (headerBottom - headerTop) * 0.75)
  ) {
    return null
  }
  const targetIndices: number[] = []
  const assignedTargets = new Set<number>()
  for (const run of continuationRuns) {
    const center = run.x + run.width / 2
    const selected = headerRuns
      .map((target, index) => ({
        index,
        distance: Math.abs(target.x + target.width / 2 - center),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.index - right.index,
      )[0]
    if (
      !selected ||
      selected.distance > COLUMN_CENTER_TOLERANCE ||
      assignedTargets.has(selected.index)
    ) {
      return null
    }
    assignedTargets.add(selected.index)
    targetIndices.push(selected.index)
  }

  const runs = headerRuns.map((run) => ({ ...run }))
  continuationRuns.forEach((run, index) => {
    const targetIndex = targetIndices[index]
    const target = runs[targetIndex]
    const left = Math.min(target.x, run.x)
    const top = Math.min(target.y, run.y)
    const right = Math.max(target.x + target.width, run.x + run.width)
    const bottom = Math.max(target.y + target.height, run.y + run.height)
    runs[targetIndex] = {
      ...target,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      text: `${target.text} ${run.text}`.trim(),
    }
  })
  return { runs, targetIndices }
}

function mergePageHeaderCandidateContinuations(rows: ClusteredTableRow[]) {
  const merged = rows.map<ClusteredTableRow>((row) => ({
    ...row,
    box: { ...row.box },
    runs: row.runs.map((run) => ({ ...run })),
    sourceLineIds: [...row.sourceLineIds],
    sourceRegionIds: [...row.sourceRegionIds],
    sourceRegionKinds: [...row.sourceRegionKinds],
  }))
  const headerIndex = merged.findIndex(pageHeaderCandidateRow)
  if (headerIndex < 0) return merged
  const header = merged[headerIndex]
  if (header.runs.length < 2) return merged
  let nextIndex = headerIndex + 1
  while (nextIndex < merged.length) {
    const continuation = merged[nextIndex]
    const verticalGap = continuation.box.y - (header.box.y + header.box.height)
    if (
      !pageHeaderCandidateRow(continuation) ||
      continuation.runs.length >= header.runs.length ||
      verticalGap < -0.003 ||
      verticalGap > Math.max(0.004, header.box.height * 0.75)
    ) {
      break
    }
    const continuationMerge = mergeWrappedHeaderContinuationRuns(
      header.runs,
      continuation.runs,
    )
    if (!continuationMerge) break
    header.runs = continuationMerge.runs
    const left = Math.min(header.box.x, continuation.box.x)
    const top = Math.min(header.box.y, continuation.box.y)
    const right = Math.max(
      header.box.x + header.box.width,
      continuation.box.x + continuation.box.width,
    )
    const bottom = Math.max(
      header.box.y + header.box.height,
      continuation.box.y + continuation.box.height,
    )
    header.box = {
      ...header.box,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }
    header.text = header.runs.map((run) => run.text).join(' ')
    header.sourceLineIds = [
      ...new Set([...header.sourceLineIds, ...continuation.sourceLineIds]),
    ].sort()
    header.sourceRegionIds = [
      ...new Set([...header.sourceRegionIds, ...continuation.sourceRegionIds]),
    ].sort()
    merged.splice(nextIndex, 1)
  }
  return merged
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
  sourceRunLineIds?: ReadonlyMap<PdfSourceRun, string>,
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
    const cell = mergedTableCellRuns(group)
    const sourceLineIds = sourceRunLineIds
      ? [
          ...new Set(
            group.flatMap((run) => {
              const sourceLineId = sourceRunLineIds.get(run)
              return sourceLineId ? [sourceLineId] : []
            }),
          ),
        ].sort()
      : []
    return sourceLineIds.length > 0
      ? ({ ...cell, sourceLineIds } satisfies DetectedTableCellRun)
      : cell
  })
}

function mergedTableCellRuns(group: PdfSourceRun[]) {
  const first = group[0]
  const right = Math.max(...group.map((run) => run.x + run.width))
  const bottom = Math.max(...group.map((run) => run.y + run.height))
  return {
    ...first,
    width: right - first.x,
    height: bottom - first.y,
    text: group.reduce((text, run, index) => {
      if (index === 0) return run.text
      const previous = group[index - 1]
      const gap = run.x - (previous.x + previous.width)
      const noSpaceThreshold = Math.max(
        0.0005,
        Math.min(previous.height, run.height) * 0.18,
      )
      return `${text}${gap <= noSpaceThreshold ? '' : ' '}${run.text}`
    }, ''),
  }
}

type TableColumnAlignment = 'center' | 'proven-left'

function tableShape(
  lines: ClusteredTableRow[],
  columnAlignment: TableColumnAlignment = 'center',
) {
  const gapThreshold = adaptiveCellGapThreshold(lines)
  const cellsByLine = new Map(
    lines.map((line) => [line, rowCells(line, gapThreshold)]),
  )
  const rowColumnCounts = [...cellsByLine.values()]
    .map((cells) => cells.length)
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
    (line) => cellsByLine.get(line)?.length === modalColumnCount,
  )
  if (structuralRows.length !== lines.length) return null
  const cellsByColumn = Array.from({ length: modalColumnCount }, (_, index) =>
    structuralRows.map((line) => cellsByLine.get(line)![index]),
  )
  const leftAnchors = cellsByColumn.map((cells) =>
    median(cells.map((cell) => cell.x)),
  )
  const centerAnchors = cellsByColumn.map((cells) =>
    median(cells.map((cell) => cell.x + cell.width / 2)),
  )
  if (
    centerAnchors.length < 2 ||
    centerAnchors.length > 12 ||
    structuralRows.some((line) =>
      cellsByLine
        .get(line)!
        .some((cell, index) =>
          columnAlignment === 'proven-left'
            ? Math.abs(cell.x - leftAnchors[index]) > COLUMN_ANCHOR_TOLERANCE
            : Math.abs(cell.x + cell.width / 2 - centerAnchors[index]) >
              COLUMN_CENTER_TOLERANCE,
        ),
    )
  ) {
    return null
  }
  const populatedRows = lines.map<ClusteredTableRow>((line) => {
    const cells = cellsByLine.get(line)!
    return {
      ...line,
      sourceCellBoxes: cells.map(normalizedSourceBox),
      runs: leftAnchors.map((anchor, index) => ({
        ...cells[index],
        x: anchor,
      })),
    }
  })
  if (populatedRows.length < 2 || populatedRows.length !== lines.length)
    return null
  const density =
    populatedRows.reduce((total, line) => total + line.runs.length, 0) /
    (populatedRows.length * leftAnchors.length)
  return density >= 0.35
    ? {
        anchors: leftAnchors,
        rows: populatedRows,
        density,
        structure: 'rectangular' as const,
      }
    : null
}

function closeBodyShapeWithTableLocalHeader(
  headerRows: ClusteredTableRow[],
  bodyShape: NonNullable<ReturnType<typeof tableShape>>,
) {
  if (headerRows.length !== 1) return null
  const sourceHeader = headerRows[0]
  const headerCells = rowCells(sourceHeader, FIXED_CELL_GAP_THRESHOLD)
  if (headerCells.length !== bodyShape.anchors.length) return null
  const bodyCenterAnchors = bodyShape.anchors.map((_, columnIndex) =>
    median(
      bodyShape.rows.map((row) => {
        const cell = row.runs[columnIndex]
        return cell.x + cell.width / 2
      }),
    ),
  )
  const sameColumns = headerCells.every((cell, columnIndex) => {
    const leftDistance = Math.abs(cell.x - bodyShape.anchors[columnIndex])
    const centerDistance = Math.abs(
      cell.x + cell.width / 2 - bodyCenterAnchors[columnIndex],
    )
    return Math.min(leftDistance, centerDistance) <= COLUMN_ANCHOR_TOLERANCE
  })
  if (!sameColumns) return null
  const header: ClusteredTableRow = {
    ...sourceHeader,
    id: 'detected-table-header-row-001',
    sourceCellBoxes: headerCells.map(normalizedSourceBox),
    runs: headerCells.map((cell, columnIndex) => ({
      ...cell,
      x: bodyShape.anchors[columnIndex],
    })),
  }
  return {
    ...bodyShape,
    rows: [header, ...bodyShape.rows],
  }
}

function directionalCandidate(
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  direction: 'above' | 'below',
  columnAlignment: TableColumnAlignment = 'center',
) {
  const maximumDistance = direction === 'above' ? 0.22 : 0.16
  const directionalRegions = regions.filter((region) => {
    if (
      region.page !== caption.page ||
      region.id === caption.id ||
      region.lines.length === 0 ||
      ['caption', 'page-number', 'figure', 'header', 'footer'].includes(
        region.kind,
      )
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
  const bodyRows = clusterRows(
    sourceRegions.flatMap((region) =>
      region.lines.map((line) => ({ region, line })),
    ),
  )
  const bodyShape = tableShape(bodyRows, columnAlignment)
  if (!bodyShape) return null
  let shape = bodyShape
  let headerEvidence: PdfDetectedTableHeaderEvidence | null = null
  if (direction === 'above') {
    const tableTop = Math.min(...sourceRegions.map((region) => region.box.y))
    const pageHeaderCandidates = regions.filter((region) => {
      if (
        region.page !== caption.page ||
        region.kind !== 'header' ||
        region.lines.length === 0 ||
        !overlapsCaption(caption, region)
      ) {
        return false
      }
      const gap = tableTop - (region.box.y + region.box.height)
      return gap >= -0.003 && gap <= MAX_TABLE_LOCAL_HEADER_GAP
    })
    const headerRows = mergePageHeaderCandidateContinuations(
      clusterRows(
        pageHeaderCandidates.flatMap((region) =>
          region.lines.map((line) => ({ region, line })),
        ),
      ),
    )
    if (headerRows.length === 1) {
      const closedShape = closeBodyShapeWithTableLocalHeader(
        headerRows,
        bodyShape,
      )
      if (closedShape) {
        shape = closedShape
        const header = closedShape.rows[0]
        const acceptedHeaderIds = new Set(header.sourceRegionIds)
        sourceRegions = [
          ...pageHeaderCandidates.filter((region) =>
            acceptedHeaderIds.has(region.id),
          ),
          ...sourceRegions,
        ]
        headerEvidence = {
          kind: 'table-local-geometry',
          sourceRegionIds: [...header.sourceRegionIds],
          sourceLineIds: [...header.sourceLineIds],
          detectedHeaderLineIds: [header.id],
        }
      }
    }
  }
  if (!shape) return null
  const usedRegionIds = new Set(
    shape.rows.flatMap((row) => row.sourceRegionIds),
  )
  const usedRegions = sourceRegions.filter((region) =>
    usedRegionIds.has(region.id),
  )
  if (
    usedRegions.length === 0 ||
    new Set(usedRegions.map((region) => region.id)).size !== usedRegionIds.size
  ) {
    return null
  }
  const sourceLineIds = [
    ...new Set(shape.rows.flatMap((row) => row.sourceLineIds)),
  ]
  if (
    sourceLineIds.some(
      (lineId) =>
        usedRegions.reduce(
          (count, region) =>
            count + Number(region.lines.some((line) => line.id === lineId)),
          0,
        ) !== 1,
    )
  ) {
    return null
  }
  const orderedUsedRegions = [...usedRegions].sort(
    (left, right) =>
      left.page - right.page ||
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
  const nearest = Math.min(
    ...usedRegions.map((region) =>
      direction === 'above'
        ? caption.box.y - (region.box.y + region.box.height)
        : region.box.y - (caption.box.y + caption.box.height),
    ),
  )
  return {
    sourceRegions: orderedUsedRegions,
    sourceLineIds,
    lines: shape.rows,
    structure: shape.structure,
    headerEvidence,
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

// Variable-width formula cells can move their centers far from otherwise
// stable column starts. Left-edge alignment is therefore available only after
// the independent scope resolver has proved the exact supplemental shard and
// every claimed non-empty source line; the ordinary detector remains stricter.
export function detectTableWithinProvenScope(
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  scope: {
    direction: 'above' | 'below'
    sourceRegionIds: readonly string[]
    sourceLineIds: readonly string[]
    evidence: readonly { code: string }[]
  },
) {
  if (
    !scope.evidence.some(
      (item) => item.code === 'supplemental-equation-cell-shard',
    ) ||
    scope.sourceRegionIds.length === 0 ||
    new Set(scope.sourceRegionIds).size !== scope.sourceRegionIds.length ||
    scope.sourceLineIds.length === 0 ||
    new Set(scope.sourceLineIds).size !== scope.sourceLineIds.length
  ) {
    return null
  }

  const sourceRegionIds = new Set(scope.sourceRegionIds)
  const sourceLineIds = new Set(scope.sourceLineIds)
  const sourceRegions = regions.filter((region) =>
    sourceRegionIds.has(region.id),
  )
  if (sourceRegions.length !== sourceRegionIds.size) return null

  const nonemptySourceLines = sourceRegions.flatMap((region) =>
    region.lines.filter(
      (line) =>
        line.text.trim().length > 0 ||
        line.runs.some((run) => run.text.trim().length > 0),
    ),
  )
  if (
    nonemptySourceLines.length !== sourceLineIds.size ||
    nonemptySourceLines.some((line) => !sourceLineIds.has(line.id))
  ) {
    return null
  }

  const detected = directionalCandidate(
    caption,
    sourceRegions,
    scope.direction,
    'proven-left',
  )
  if (
    !detected ||
    detected.sourceRegions.length !== sourceRegionIds.size ||
    detected.sourceRegions.some((region) => !sourceRegionIds.has(region.id)) ||
    detected.sourceLineIds.length !== sourceLineIds.size ||
    detected.sourceLineIds.some((lineId) => !sourceLineIds.has(lineId))
  ) {
    return null
  }
  return detected
}

function numericTableBodyCell(text: string) {
  return /^[+\-−]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:%|[x×])?$/u.test(
    text.replace(/\s+/gu, ''),
  )
}

function tableHeaderCell(text: string) {
  return /\p{L}/u.test(text) && !numericTableBodyCell(text)
}

function sourceRunHasHeaderFace(run: PdfSourceRun) {
  return (
    run.bold === true ||
    /(?:bold|semi[- ]?bold|demi|medi(?:um)?|black)/iu.test(run.fontName)
  )
}

function scopeProvenNumericMatrixBodyCell(text: string) {
  return /^(?:[<>≤≥~≈])?[+\-−]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:(?:[eE][+\-−]?\d+)|(?:[x×]10[+\-−]?\d+))?(?:%|[x×])?$/u.test(
    text.replace(/\s+/gu, ''),
  )
}

function scopeProvenNumericMatrixHeaderCell(text: string) {
  return /\p{L}/u.test(text) && !scopeProvenNumericMatrixBodyCell(text)
}

function headerCellsForBodyAnchors(
  headerRuns: PdfSourceRun[],
  bodyCenters: number[],
) {
  const boundaries = bodyCenters
    .slice(1)
    .map((center, index) => (bodyCenters[index] + center) / 2)
  const groups = bodyCenters.map(() => [] as PdfSourceRun[])
  for (const run of [...headerRuns].sort((left, right) => left.x - right.x)) {
    const center = run.x + run.width / 2
    if (boundaries.some((boundary) => Math.abs(center - boundary) < 0.002)) {
      return null
    }
    const boundaryIndex = boundaries.findIndex((boundary) => center < boundary)
    groups[boundaryIndex === -1 ? groups.length - 1 : boundaryIndex].push(run)
  }
  if (groups.some((group) => group.length === 0)) return null
  const cells = groups.map(mergedTableCellRuns)
  return cells.every(
    (cell, index) =>
      Math.abs(cell.x + cell.width / 2 - bodyCenters[index]) <=
      COLUMN_CENTER_TOLERANCE,
  )
    ? cells
    : null
}

function exactScopedSourceRegions(
  regions: PdfPageRegion[],
  scope: {
    sourceRegionIds: readonly string[]
    sourceLineIds: readonly string[]
  },
) {
  if (
    scope.sourceRegionIds.length === 0 ||
    new Set(scope.sourceRegionIds).size !== scope.sourceRegionIds.length ||
    scope.sourceLineIds.length === 0 ||
    new Set(scope.sourceLineIds).size !== scope.sourceLineIds.length
  ) {
    return null
  }
  const sourceRegionIds = new Set(scope.sourceRegionIds)
  const sourceLineIds = new Set(scope.sourceLineIds)
  const sourceRegions = regions.filter((region) =>
    sourceRegionIds.has(region.id),
  )
  if (sourceRegions.length !== sourceRegionIds.size) return null
  const nonemptySourceLines = sourceRegions.flatMap((region) =>
    region.lines.filter(
      (line) =>
        line.text.trim().length > 0 ||
        line.runs.some((run) => run.text.trim().length > 0),
    ),
  )
  if (
    nonemptySourceLines.length !== sourceLineIds.size ||
    nonemptySourceLines.some((line) => !sourceLineIds.has(line.id))
  ) {
    return null
  }
  return sourceRegions
}

// A plain one-row header is promoted only inside an independently proved
// repeated text line-band. The first column is a variable-width textual stub,
// so its left edge must repeat while the numeric body columns repeat their
// centers. Every source row must be complete; empty corner cells, spans,
// section rows, and synthetic cells remain unsupported.
export function detectExplicitHeaderNumericTableWithinProvenScope(
  regions: PdfPageRegion[],
  scope: {
    direction: 'above' | 'below'
    sourceRegionIds: readonly string[]
    sourceLineIds: readonly string[]
    evidence: readonly { code: string }[]
  },
): PdfDetectedTableGrid | null {
  if (
    !scope.evidence.some((item) => item.code === 'repeated-row-bands') ||
    !scope.evidence.some((item) => item.code === 'multi-run-tabular-line-band')
  ) {
    return null
  }
  const sourceRegions = exactScopedSourceRegions(regions, scope)
  if (!sourceRegions) return null
  const rows = clusterRows(
    sourceRegions.flatMap((region) =>
      region.lines
        .filter((line) => scope.sourceLineIds.includes(line.id))
        .map((line) => ({ region, line })),
    ),
  )
  if (rows.length < 4) return null

  const gapThreshold = adaptiveCellGapThreshold(rows)
  const cellsByRow = rows.map((row) => rowCells(row, gapThreshold))
  const header = cellsByRow[0]
  const bodyRows = cellsByRow.slice(1)
  const columnCount = bodyRows[0]?.length ?? 0
  if (
    columnCount < 3 ||
    columnCount > 12 ||
    bodyRows.length < 3 ||
    header.length !== columnCount ||
    bodyRows.some((row) => row.length !== columnCount) ||
    !header.every((cell) => scopeProvenNumericMatrixHeaderCell(cell.text)) ||
    bodyRows.some(
      (row) =>
        !scopeProvenNumericMatrixHeaderCell(row[0].text) ||
        row
          .slice(1)
          .some((cell) => !scopeProvenNumericMatrixBodyCell(cell.text)),
    )
  ) {
    return null
  }

  const stubAnchor = median(bodyRows.map((row) => row[0].x))
  const numericCenters = Array.from(
    { length: columnCount - 1 },
    (_, columnIndex) =>
      median(
        bodyRows.map((row) => {
          const cell = row[columnIndex + 1]
          return cell.x + cell.width / 2
        }),
      ),
  )
  const alignedRow = (row: PdfSourceRun[]) =>
    Math.abs(row[0].x - stubAnchor) <= COLUMN_ANCHOR_TOLERANCE &&
    row
      .slice(1)
      .every(
        (cell, columnIndex) =>
          Math.abs(cell.x + cell.width / 2 - numericCenters[columnIndex]) <=
          COLUMN_CENTER_TOLERANCE,
      )
  if (!alignedRow(header) || bodyRows.some((row) => !alignedRow(row))) {
    return null
  }

  const gridLines: PdfDetectedTableGrid['lines'] = rows.map((row, rowIndex) => {
    const cells = cellsByRow[rowIndex].map((run, columnIndex) => ({
      run,
      columnIndex,
      columnSpan: 1,
      rowSpan: 1,
    }))
    return {
      ...row,
      runs: cells.map((cell) => cell.run),
      cells,
    }
  })
  return {
    sourceRegions: [...sourceRegions].sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    ),
    sourceLineIds: [...scope.sourceLineIds],
    lines: gridLines,
    columnCount,
    headerRowCount: 1,
    evidence: [
      'complete-bounded-table-scope',
      'semantic-header-explicit-matrix-geometry',
      'repeated-uniform-numeric-body-rows',
      'variable-width-stub-left-anchor',
    ],
  }
}

// Promote an ordinary rectangular table only after the scope resolver has
// accounted for every non-empty source line, repeated geometry proves the
// columns, and either source lineage or typography proves the header. Cell
// text always comes from the source runs; an unproved grid stays a raster.
export function detectRectangularTableWithinProvenScope(
  regions: PdfPageRegion[],
  scope: {
    direction: 'above' | 'below'
    sourceRegionIds: readonly string[]
    sourceLineIds: readonly string[]
    evidence: readonly {
      code: string
      headerLineIds?: readonly string[]
    }[]
  },
): PdfDetectedTableGrid | null {
  const hasRowProof = scope.evidence.some(
    (item) => item.code === 'repeated-row-bands',
  )
  const hasColumnProof = scope.evidence.some(
    (item) =>
      item.code === 'repeated-column-anchors' ||
      item.code === 'multi-run-tabular-line-band' ||
      item.code === 'contiguous-tabular-slab',
  )
  if (!hasRowProof || !hasColumnProof) return null

  const sourceRegions = exactScopedSourceRegions(regions, scope)
  if (!sourceRegions) return null
  const rows = clusterRows(
    sourceRegions.flatMap((region) =>
      region.lines
        .filter((line) => scope.sourceLineIds.includes(line.id))
        .map((line) => ({ region, line })),
    ),
  )
  // Require three body rows so a caption-adjacent two-fragment header plus a
  // pair of prose records cannot become a table merely by sharing anchors.
  if (rows.length < 4) return null

  const gapThreshold = adaptiveCellGapThreshold(rows)
  const cellsByRow = rows.map((row) => rowCells(row, gapThreshold))
  const columnCount = cellsByRow[0]?.length ?? 0
  if (
    columnCount < 2 ||
    columnCount > 12 ||
    cellsByRow.some(
      (cells) =>
        cells.length !== columnCount ||
        cells.some((cell) => cell.text.trim().length === 0) ||
        cells.some(
          (cell, index) =>
            index < cells.length - 1 &&
            cell.x + cell.width > cells[index + 1].x + 0.001,
        ),
    )
  ) {
    return null
  }

  const sourceHeaderLineIds = new Set(
    scope.evidence.flatMap((item) => item.headerLineIds ?? []),
  )
  const headerByLineage =
    sourceHeaderLineIds.size > 0 &&
    rows[0].sourceLineIds.every((lineId) => sourceHeaderLineIds.has(lineId)) &&
    rows
      .slice(1)
      .every((row) =>
        row.sourceLineIds.every((lineId) => !sourceHeaderLineIds.has(lineId)),
      )
  const headerByRegion = rows[0].sourceRegionKinds.every(
    (kind) => kind === 'header',
  )
  const headerByTypography =
    cellsByRow[0].every(sourceRunHasHeaderFace) &&
    cellsByRow
      .slice(1)
      .some((cells) => cells.some((cell) => !sourceRunHasHeaderFace(cell)))
  if (!headerByLineage && !headerByRegion && !headerByTypography) return null

  const leftAnchors = Array.from({ length: columnCount }, (_, columnIndex) =>
    median(cellsByRow.map((cells) => cells[columnIndex].x)),
  )
  const centerAnchors = Array.from({ length: columnCount }, (_, columnIndex) =>
    median(
      cellsByRow.map((cells) => {
        const cell = cells[columnIndex]
        return cell.x + cell.width / 2
      }),
    ),
  )
  const alignedColumns = Array.from({ length: columnCount }, (_, index) => {
    const leftDeviation = Math.max(
      ...cellsByRow.map((cells) =>
        Math.abs(cells[index].x - leftAnchors[index]),
      ),
    )
    const centerDeviation = Math.max(
      ...cellsByRow.map((cells) =>
        Math.abs(
          cells[index].x + cells[index].width / 2 - centerAnchors[index],
        ),
      ),
    )
    return Math.min(leftDeviation, centerDeviation) <= COLUMN_ANCHOR_TOLERANCE
  })
  if (alignedColumns.some((aligned) => !aligned)) return null

  return {
    sourceRegions: [...sourceRegions].sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    ),
    sourceLineIds: [...scope.sourceLineIds],
    lines: rows.map((row, rowIndex) => {
      const cells = cellsByRow[rowIndex].map((run, columnIndex) => ({
        run,
        columnIndex,
        columnSpan: 1,
        rowSpan: 1,
      }))
      return { ...row, runs: cells.map((cell) => cell.run), cells }
    }),
    columnCount,
    headerRowCount: 1,
    evidence: [
      'complete-bounded-table-scope',
      'repeated-rectangular-column-geometry',
      headerByLineage
        ? 'source-lineage-header'
        : headerByRegion
          ? 'source-region-header'
          : 'source-typography-header',
    ],
  }
}

function mergeWrappedBodyCellRuns(
  current: DetectedTableCellRun,
  continuation: DetectedTableCellRun,
) {
  const right = Math.max(
    current.x + current.width,
    continuation.x + continuation.width,
  )
  const bottom = Math.max(
    current.y + current.height,
    continuation.y + continuation.height,
  )
  const sourceLineIds = [
    ...new Set([
      ...(current.sourceLineIds ?? []),
      ...(continuation.sourceLineIds ?? []),
    ]),
  ].sort()
  return {
    ...current,
    width: right - current.x,
    height: bottom - current.y,
    text: `${current.text} ${continuation.text}`,
    ...(sourceLineIds.length > 0 ? { sourceLineIds } : {}),
  } satisfies DetectedTableCellRun
}

function mergeWrappedBodyTableRow(
  row: ClusteredTableRow,
  cells: DetectedTableCellRun[],
  continuation: ClusteredTableRow,
) {
  const left = Math.min(row.box.x, continuation.box.x)
  const top = Math.min(row.box.y, continuation.box.y)
  const right = Math.max(
    row.box.x + row.box.width,
    continuation.box.x + continuation.box.width,
  )
  const bottom = Math.max(
    row.box.y + row.box.height,
    continuation.box.y + continuation.box.height,
  )
  return {
    ...row,
    text: cells.map((cell) => cell.text).join(' '),
    box: {
      ...row.box,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
    runs: cells,
    sourceLineIds: [
      ...new Set([...row.sourceLineIds, ...continuation.sourceLineIds]),
    ].sort(),
    sourceRegionIds: [
      ...new Set([...row.sourceRegionIds, ...continuation.sourceRegionIds]),
    ].sort(),
    sourceRegionKinds: [
      ...new Set([...row.sourceRegionKinds, ...continuation.sourceRegionKinds]),
    ].sort(),
  }
}

// Promote a table whose body cells wrap onto source lines below their row. The
// scope must already account for every non-empty source line; this detector
// only folds a sparse continuation line into the immediately preceding body
// row when its cells map uniquely to stable column anchors. Wide/ambiguous
// rows remain source-preserved fallbacks rather than invented table cells.
export function detectWrappedCellTableWithinProvenScope(
  regions: PdfPageRegion[],
  scope: {
    direction: 'above' | 'below'
    sourceRegionIds: readonly string[]
    sourceLineIds: readonly string[]
    evidence: readonly {
      code: string
      headerLineIds?: readonly string[]
    }[]
  },
): PdfDetectedTableGrid | null {
  const hasRowProof = scope.evidence.some(
    (item) =>
      item.code === 'repeated-row-bands' ||
      item.code === 'contiguous-tabular-slab' ||
      item.code === 'contiguous-single-anchor-slab',
  )
  const hasColumnProof = scope.evidence.some(
    (item) =>
      item.code === 'repeated-column-anchors' ||
      item.code === 'multi-run-tabular-line-band' ||
      item.code === 'contiguous-tabular-slab',
  )
  if (!hasRowProof || !hasColumnProof) return null

  const sourceRegions = exactScopedSourceRegions(regions, scope)
  if (!sourceRegions) return null
  const sourceRunLineIds = new Map<PdfSourceRun, string>()
  for (const sourceRegion of sourceRegions) {
    for (const sourceLine of sourceRegion.lines) {
      for (const run of sourceLine.runs)
        sourceRunLineIds.set(run, sourceLine.id)
    }
  }
  const rows = clusterRows(
    sourceRegions.flatMap((region) =>
      region.lines
        .filter((line) => scope.sourceLineIds.includes(line.id))
        .map((line) => ({ region, line })),
    ),
  )
  const gapThreshold = adaptiveCellGapThreshold(rows)
  const cellsByRow = rows.map((row) =>
    rowCells(row, gapThreshold, sourceRunLineIds),
  )
  const frequency = new Map<number, number>()
  for (const cells of cellsByRow) {
    if (cells.length >= 2 && cells.length <= 12) {
      frequency.set(cells.length, (frequency.get(cells.length) ?? 0) + 1)
    }
  }
  const columnCount = [...frequency.entries()].sort(
    (left, right) => right[1] - left[1] || right[0] - left[0],
  )[0]?.[0]
  if (
    !columnCount ||
    rows.length === 0 ||
    cellsByRow[0].length !== columnCount
  ) {
    return null
  }

  const completeBodyRowIndexes = cellsByRow.flatMap((cells, index) =>
    index > 0 && cells.length === columnCount ? [index] : [],
  )
  if (completeBodyRowIndexes.length < 3) return null

  const bodyRows = completeBodyRowIndexes.map((index) => cellsByRow[index])
  const leftAnchors = Array.from({ length: columnCount }, (_, columnIndex) =>
    median(bodyRows.map((cells) => cells[columnIndex].x)),
  )
  const centerAnchors = Array.from({ length: columnCount }, (_, columnIndex) =>
    median(
      bodyRows.map((cells) => {
        const cell = cells[columnIndex]
        return cell.x + cell.width / 2
      }),
    ),
  )
  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
    median(bodyRows.map((cells) => cells[columnIndex].width)),
  )
  const alignedColumn = (cell: PdfSourceRun, columnIndex: number) =>
    Math.min(
      Math.abs(cell.x - leftAnchors[columnIndex]),
      Math.abs(cell.x + cell.width / 2 - centerAnchors[columnIndex]),
    ) <= COLUMN_ANCHOR_TOLERANCE
  if (
    bodyRows.some((cells) =>
      cells.some((cell, columnIndex) => !alignedColumn(cell, columnIndex)),
    )
  ) {
    return null
  }

  const sourceHeaderLineIds = new Set(
    scope.evidence.flatMap((item) => item.headerLineIds ?? []),
  )
  const headerByLineage =
    sourceHeaderLineIds.size > 0 &&
    rows[0].sourceLineIds.every((lineId) => sourceHeaderLineIds.has(lineId)) &&
    rows
      .slice(1)
      .every((row) =>
        row.sourceLineIds.every((lineId) => !sourceHeaderLineIds.has(lineId)),
      )
  const headerByRegion = rows[0].sourceRegionKinds.every(
    (kind) => kind === 'header',
  )
  const headerByTypography = cellsByRow[0].every(sourceRunHasHeaderFace)
  if (!headerByLineage && !headerByRegion && !headerByTypography) return null
  if (bodyRows.every((cells) => cells.every(sourceRunHasHeaderFace))) {
    return null
  }

  const columnIndexForCell = (cell: PdfSourceRun) => {
    const candidates = Array.from(
      { length: columnCount },
      (_, columnIndex) => ({
        columnIndex,
        distance: Math.min(
          Math.abs(cell.x - leftAnchors[columnIndex]),
          Math.abs(cell.x + cell.width / 2 - centerAnchors[columnIndex]),
        ),
      }),
    ).sort(
      (left, right) =>
        left.distance - right.distance || left.columnIndex - right.columnIndex,
    )
    const closest = candidates[0]
    return closest && closest.distance <= COLUMN_ANCHOR_TOLERANCE
      ? closest.columnIndex
      : null
  }

  const logicalRows: Array<{
    row: ClusteredTableRow
    cells: DetectedTableCellRun[]
  }> = [
    {
      row: rows[0],
      cells: cellsByRow[0],
    },
  ]
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]
    const cells = cellsByRow[rowIndex]
    if (cells.length === columnCount) {
      logicalRows.push({ row, cells })
      continue
    }
    if (
      cells.length === 0 ||
      cells.length >= columnCount ||
      logicalRows.length < 2 ||
      row.sourceRegionKinds.every((kind) => kind === 'header') ||
      cells.every(sourceRunHasHeaderFace)
    ) {
      return null
    }
    const previous = logicalRows.at(-1)!
    const previousBottom = previous.row.box.y + previous.row.box.height
    const continuationGap = row.box.y - previousBottom
    if (
      continuationGap < -0.003 ||
      continuationGap > Math.max(0.035, previous.row.box.height * 3)
    ) {
      return null
    }
    const mappedColumns = cells.map(columnIndexForCell)
    if (
      mappedColumns.some((column) => column === null) ||
      new Set(mappedColumns).size !== mappedColumns.length
    ) {
      return null
    }
    const mergedCells = [...previous.cells]
    for (const [cellIndex, column] of mappedColumns.entries()) {
      const columnIndex = column!
      if (
        cells[cellIndex].width > Math.max(0.12, columnWidths[columnIndex] * 1.8)
      ) {
        return null
      }
      mergedCells[columnIndex] = mergeWrappedBodyCellRuns(
        mergedCells[columnIndex],
        cells[cellIndex],
      )
    }
    previous.cells = mergedCells
    previous.row = mergeWrappedBodyTableRow(previous.row, mergedCells, row)
  }

  if (logicalRows.length < 4) return null
  const gridLines: PdfDetectedTableGrid['lines'] = logicalRows.map(
    ({ row, cells: rowCellsByColumn }) => {
      const cells = rowCellsByColumn.map((run, columnIndex) => ({
        run,
        columnIndex,
        columnSpan: 1,
        rowSpan: 1,
      }))
      return {
        ...row,
        runs: cells.map((cell) => cell.run),
        cells,
      }
    },
  )
  return {
    sourceRegions: [...sourceRegions].sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    ),
    sourceLineIds: [...scope.sourceLineIds],
    lines: gridLines,
    columnCount,
    headerRowCount: 1,
    evidence: [
      'complete-bounded-table-scope',
      'repeated-rectangular-column-geometry',
      'semantic-body-continuation-geometry',
      headerByLineage
        ? 'source-lineage-header'
        : headerByRegion
          ? 'source-region-header'
          : 'source-typography-header',
    ],
  }
}

// A wrapped single-level header is promoted only when an independently proved
// scope contains exactly two header bands followed by at least three complete,
// repeated body rows. Header continuations remain separate cells so every
// source run keeps exact lineage while body cells can reference both headers.
export function detectWrappedHeaderTableWithinProvenScope(
  regions: PdfPageRegion[],
  scope: {
    direction: 'above' | 'below'
    sourceRegionIds: readonly string[]
    sourceLineIds: readonly string[]
    evidence: readonly { code: string }[]
  },
): PdfDetectedTableGrid | null {
  if (
    !scope.evidence.some(
      (item) =>
        item.code === 'repeated-row-bands' ||
        item.code === 'repeated-column-anchors',
    )
  ) {
    return null
  }
  const sourceRegions = exactScopedSourceRegions(regions, scope)
  if (!sourceRegions) return null
  const rows = clusterRows(
    sourceRegions.flatMap((region) =>
      region.lines
        .filter((line) => scope.sourceLineIds.includes(line.id))
        .map((line) => ({ region, line })),
    ),
  )
  if (rows.length < 5) return null

  const gapThreshold = adaptiveCellGapThreshold(rows)
  const cellsByRow = rows.map((row) => rowCells(row, gapThreshold))
  const bodyRows = cellsByRow.slice(2)
  const columnCount = bodyRows[0]?.length ?? 0
  const firstHeader = cellsByRow[0]
  const continuationHeader = cellsByRow[1]
  if (
    columnCount < 3 ||
    columnCount > 12 ||
    bodyRows.length < 3 ||
    bodyRows.some((row) => row.length !== columnCount) ||
    firstHeader.length !== columnCount ||
    continuationHeader.length === 0 ||
    continuationHeader.length >= columnCount ||
    !firstHeader.every((cell) => tableHeaderCell(cell.text)) ||
    !continuationHeader.every((cell) => tableHeaderCell(cell.text)) ||
    bodyRows.some(
      (row) =>
        !tableHeaderCell(row[0].text) ||
        row.slice(1).some((cell) => !numericTableBodyCell(cell.text)),
    )
  ) {
    return null
  }

  const bodyCenters = Array.from({ length: columnCount }, (_, index) =>
    median(bodyRows.map((row) => row[index].x + row[index].width / 2)),
  )
  const columnIndexForCell = (cell: PdfSourceRun) => {
    const center = cell.x + cell.width / 2
    const closest = bodyCenters
      .map((anchor, index) => ({
        index,
        distance: Math.abs(anchor - center),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.index - right.index,
      )[0]
    return closest && closest.distance <= COLUMN_CENTER_TOLERANCE
      ? closest.index
      : null
  }
  const firstHeaderColumns = firstHeader.map(columnIndexForCell)
  const continuationColumns = continuationHeader.map(columnIndexForCell)
  if (
    firstHeaderColumns.some((column) => column === null) ||
    firstHeaderColumns.some((column, index) => column !== index) ||
    continuationColumns.some((column) => column === null) ||
    new Set(continuationColumns).size !== continuationColumns.length ||
    continuationColumns.some(
      (column, index) =>
        index > 0 && column! <= continuationColumns[index - 1]!,
    ) ||
    bodyRows.some((row) =>
      row.some(
        (cell, index) =>
          Math.abs(cell.x + cell.width / 2 - bodyCenters[index]) >
          COLUMN_CENTER_TOLERANCE,
      ),
    )
  ) {
    return null
  }

  const continuedColumns = new Set(
    continuationColumns.filter((column): column is number => column !== null),
  )
  const gridLines: PdfDetectedTableGrid['lines'] = rows.map((row, rowIndex) => {
    const cells = cellsByRow[rowIndex]
    const gridCells =
      rowIndex === 0
        ? cells.map((run, columnIndex) => ({
            run,
            columnIndex,
            columnSpan: 1,
            rowSpan: continuedColumns.has(columnIndex) ? 1 : 2,
          }))
        : rowIndex === 1
          ? cells.map((run, index) => ({
              run,
              columnIndex: continuationColumns[index]!,
              columnSpan: 1,
              rowSpan: 1,
            }))
          : cells.map((run, columnIndex) => ({
              run,
              columnIndex,
              columnSpan: 1,
              rowSpan: 1,
            }))
    return {
      ...row,
      runs: gridCells.map((cell) => cell.run),
      cells: gridCells,
    }
  })
  return {
    sourceRegions: [...sourceRegions].sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    ),
    sourceLineIds: [...scope.sourceLineIds],
    lines: gridLines,
    columnCount,
    headerRowCount: 2,
    evidence: [
      'complete-bounded-table-scope',
      'semantic-header-wrapped-geometry',
      'repeated-uniform-numeric-body-rows',
    ],
  }
}

// A multi-level header is promoted only when a proved text line-band has:
// - exactly two header bands;
// - at least three complete, repeated numeric body rows;
// - one stub header spanning both header bands;
// - two or more group headers that uniquely partition every leaf header.
// This intentionally excludes merged PDF header runs (for example, one run
// containing several visually separated labels) and nonuniform body grids.
export function detectHierarchicalTableWithinProvenScope(
  regions: PdfPageRegion[],
  scope: {
    direction: 'above' | 'below'
    sourceRegionIds: readonly string[]
    sourceLineIds: readonly string[]
    evidence: readonly { code: string }[]
  },
): PdfDetectedTableGrid | null {
  if (
    !scope.evidence.some(
      (item) =>
        item.code === 'multi-run-tabular-line-band' ||
        item.code === 'contiguous-tabular-slab',
    )
  ) {
    return null
  }
  const sourceRegions = exactScopedSourceRegions(regions, scope)
  if (!sourceRegions) return null
  const rows = clusterRows(
    sourceRegions.flatMap((region) =>
      region.lines
        .filter((line) => scope.sourceLineIds.includes(line.id))
        .map((line) => ({ region, line })),
    ),
  )
  if (rows.length < 5) return null

  const gapThreshold = adaptiveCellGapThreshold(rows)
  const cellsByRow = rows.map((row) => rowCells(row, gapThreshold))
  const frequency = new Map<number, number>()
  for (const cells of cellsByRow) {
    if (cells.length >= 4 && cells.length <= 12) {
      frequency.set(cells.length, (frequency.get(cells.length) ?? 0) + 1)
    }
  }
  const columnCount = [...frequency.entries()].sort(
    (left, right) => right[1] - left[1] || right[0] - left[0],
  )[0]?.[0]
  if (!columnCount) return null
  const bodyStart = cellsByRow.findIndex(
    (cells, index) =>
      index === 2 &&
      cells.length === columnCount &&
      cellsByRow.length - index >= 3 &&
      cellsByRow.slice(index).every((row) => row.length === columnCount),
  )
  if (bodyStart !== 2) return null

  const superHeader = cellsByRow[0]
  const bodyRows = cellsByRow.slice(bodyStart)
  if (
    superHeader.length < 3 ||
    superHeader.length >= columnCount ||
    !superHeader.every((cell) => tableHeaderCell(cell.text)) ||
    bodyRows.some(
      (row) =>
        !tableHeaderCell(row[0].text) ||
        row.slice(1).some((cell) => !numericTableBodyCell(cell.text)),
    )
  ) {
    return null
  }

  const bodyStubCenter = median(
    bodyRows.map((row) => row[0].x + row[0].width / 2),
  )
  const bodyCenters = Array.from({ length: columnCount - 1 }, (_, index) =>
    median(
      bodyRows.map((row) => {
        const cell = row[index + 1]
        return cell.x + cell.width / 2
      }),
    ),
  )
  const leafHeader = headerCellsForBodyAnchors(rows[1].runs, bodyCenters)
  if (
    !leafHeader ||
    leafHeader.length !== columnCount - 1 ||
    !leafHeader.every((cell) => tableHeaderCell(cell.text))
  ) {
    return null
  }
  if (
    bodyRows.some(
      (row) =>
        Math.abs(row[0].x + row[0].width / 2 - bodyStubCenter) >
          COLUMN_CENTER_TOLERANCE ||
        row
          .slice(1)
          .some(
            (cell, index) =>
              Math.abs(cell.x + cell.width / 2 - bodyCenters[index]) >
              COLUMN_CENTER_TOLERANCE,
          ),
    ) ||
    Math.abs(superHeader[0].x + superHeader[0].width / 2 - bodyStubCenter) >
      COLUMN_CENTER_TOLERANCE ||
    leafHeader.some(
      (cell, index) =>
        Math.abs(cell.x + cell.width / 2 - bodyCenters[index]) >
        COLUMN_CENTER_TOLERANCE,
    )
  ) {
    return null
  }

  const groupHeaders = superHeader.slice(1)
  const groupCenters = groupHeaders.map((cell) => cell.x + cell.width / 2)
  if (
    groupCenters.some(
      (center, index) => index > 0 && center - groupCenters[index - 1] <= 0.06,
    )
  ) {
    return null
  }
  const groupBoundaries = groupCenters
    .slice(1)
    .map((center, index) => (groupCenters[index] + center) / 2)
  const groupedColumns = groupHeaders.map(() => [] as number[])
  for (const [columnIndex, center] of bodyCenters.entries()) {
    const groupIndex = groupBoundaries.findIndex(
      (boundary) => center < boundary,
    )
    groupedColumns[
      groupIndex === -1 ? groupHeaders.length - 1 : groupIndex
    ].push(columnIndex + 1)
  }
  if (
    groupedColumns.some((columns) => columns.length === 0) ||
    groupedColumns.some((columns, groupIndex) => {
      const first = columns[0] - 1
      const last = columns.at(-1)! - 1
      const expectedCenter = median(bodyCenters.slice(first, last + 1))
      return Math.abs(groupCenters[groupIndex] - expectedCenter) > 0.045
    })
  ) {
    return null
  }

  const gridLines: PdfDetectedTableGrid['lines'] = rows.map((row, rowIndex) => {
    const cells = rowIndex === 1 ? leafHeader : cellsByRow[rowIndex]
    const gridCells =
      rowIndex === 0
        ? [
            {
              run: cells[0],
              columnIndex: 0,
              columnSpan: 1,
              rowSpan: 2,
            },
            ...cells.slice(1).map((run, groupIndex) => ({
              run,
              columnIndex: groupedColumns[groupIndex][0],
              columnSpan: groupedColumns[groupIndex].length,
              rowSpan: 1,
            })),
          ]
        : rowIndex === 1
          ? cells.map((run, columnIndex) => ({
              run,
              columnIndex: columnIndex + 1,
              columnSpan: 1,
              rowSpan: 1,
            }))
          : cells.map((run, columnIndex) => ({
              run,
              columnIndex,
              columnSpan: 1,
              rowSpan: 1,
            }))
    return {
      ...row,
      runs: gridCells.map((cell) => cell.run),
      cells: gridCells,
    }
  })
  return {
    sourceRegions: [...sourceRegions].sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    ),
    sourceLineIds: [...scope.sourceLineIds],
    lines: gridLines,
    columnCount,
    headerRowCount: 2,
    evidence: [
      'complete-bounded-table-scope',
      'semantic-header-hierarchical-geometry',
      'repeated-uniform-numeric-body-rows',
    ],
  }
}
