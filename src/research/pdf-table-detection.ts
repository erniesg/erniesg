import type { PdfPageRegion, PdfRegionLine } from './import-types'

const FIXED_CELL_GAP_THRESHOLD = 0.012
const COLUMN_ANCHOR_TOLERANCE = 0.025
const MIN_ADAPTIVE_GAP_ROWS = 3
const MIN_ADAPTIVE_GAP_BAND_SEPARATION = 0.002
const MIN_ADAPTIVE_GAP_RATIO = 1.5
const COLUMN_CENTER_TOLERANCE = 0.045
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
}

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
    let complete = true
    for (const run of continuation.runs) {
      const center = run.x + run.width / 2
      const candidates = header.runs
        .map((target, index) => ({
          index,
          distance: Math.abs(target.x + target.width / 2 - center),
        }))
        .sort(
          (left, right) =>
            left.distance - right.distance || left.index - right.index,
        )
      const selected = candidates[0]
      if (!selected || selected.distance > COLUMN_CENTER_TOLERANCE) {
        complete = false
        break
      }
      const target = header.runs[selected.index]
      const left = Math.min(target.x, run.x)
      const top = Math.min(target.y, run.y)
      const right = Math.max(target.x + target.width, run.x + run.width)
      const bottom = Math.max(target.y + target.height, run.y + run.height)
      header.runs[selected.index] = {
        ...target,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        text: `${target.text} ${run.text}`.trim(),
      }
    }
    if (!complete) break
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
  })
}

function tableShape(lines: ClusteredTableRow[]) {
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
  const centerAnchors = cellsByColumn.map((cells) =>
    median(cells.map((cell) => cell.x + cell.width / 2)),
  )
  if (
    centerAnchors.length < 2 ||
    centerAnchors.length > 12 ||
    structuralRows.some((line) =>
      cellsByLine
        .get(line)!
        .some(
          (cell, index) =>
            Math.abs(cell.x + cell.width / 2 - centerAnchors[index]) >
            COLUMN_CENTER_TOLERANCE,
        ),
    )
  ) {
    return null
  }
  const anchors = cellsByColumn.map((cells) =>
    median(cells.map((cell) => cell.x)),
  )
  const populatedRows = lines.map<ClusteredTableRow>((line) => {
    const cells = cellsByLine.get(line)!
    return {
      ...line,
      runs: anchors.map((anchor, index) => ({
        ...cells[index],
        x: anchor,
      })),
    }
  })
  if (populatedRows.length < 2 || populatedRows.length !== lines.length)
    return null
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
    return (
      Math.min(leftDistance, centerDistance) <= COLUMN_ANCHOR_TOLERANCE
    )
  })
  if (!sameColumns) return null
  const header: ClusteredTableRow = {
    ...sourceHeader,
    id: 'detected-table-header-row-001',
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
  const bodyShape = tableShape(bodyRows)
  if (!bodyShape) return null
  let shape = bodyShape
  let headerEvidence: PdfDetectedTableHeaderEvidence | null = null
  if (direction === 'above') {
    const tableTop = Math.min(
      ...sourceRegions.map((region) => region.box.y),
    )
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
    sourceLineIds: [...new Set(shape.rows.flatMap((row) => row.sourceLineIds))],
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
