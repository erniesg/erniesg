import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
} from './import-types'

const MAX_CAPTION_DISTANCE = 0.3
const MIN_CELL_GAP = 0.02
const MIN_DENSE_GAP_TO_RUN_RATIO = 0.2
const MAX_GRID_COLUMNS = 12

export const BOX_TOLERANCE = 0.004
export const MIN_DENSE_CELL_GAP = 0.006
export const COLUMN_ANCHOR_TOLERANCE = 0.015
export const MIN_GRID_ROWS = 3
export const MIN_GRID_COLUMNS = 2
export const MAX_ATOMIC_ROW_GAP = 0.035
export const MIN_TABULAR_ROW_ANCHORS = 3

export type DirectionalLane = {
  direction: 'above' | 'below'
  top: number
  bottom: number
  boundaryRegionIds: string[]
  interveningCaptionRegionId: string | null
}

export function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

export function boxKey(sourceBox: NormalizedSourceBox) {
  return [
    sourceBox.page,
    sourceBox.x,
    sourceBox.y,
    sourceBox.width,
    sourceBox.height,
    sourceBox.rotation,
    sourceBox.method,
  ].join(':')
}

export function compareBoxes(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return (
    left.page - right.page ||
    left.y - right.y ||
    left.x - right.x ||
    left.height - right.height ||
    left.width - right.width ||
    left.rotation - right.rotation ||
    left.method.localeCompare(right.method)
  )
}

export function validBox(sourceBox: NormalizedSourceBox) {
  const values = [
    sourceBox.x,
    sourceBox.y,
    sourceBox.width,
    sourceBox.height,
    sourceBox.rotation,
  ]
  return (
    Number.isInteger(sourceBox.page) &&
    sourceBox.page >= 1 &&
    values.every(Number.isFinite) &&
    sourceBox.x >= 0 &&
    sourceBox.y >= 0 &&
    sourceBox.width > 0 &&
    sourceBox.height > 0 &&
    sourceBox.x + sourceBox.width <= 1 + BOX_TOLERANCE &&
    sourceBox.y + sourceBox.height <= 1 + BOX_TOLERANCE
  )
}

export function sameBox(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => Math.abs(left[key] - right[key]) <= 0.00001,
    )
  )
}

export function containsBox(
  container: NormalizedSourceBox,
  candidate: NormalizedSourceBox,
) {
  return (
    container.page === candidate.page &&
    container.rotation === candidate.rotation &&
    candidate.x >= container.x - BOX_TOLERANCE &&
    candidate.y >= container.y - BOX_TOLERANCE &&
    candidate.x + candidate.width <=
      container.x + container.width + BOX_TOLERANCE &&
    candidate.y + candidate.height <=
      container.y + container.height + BOX_TOLERANCE
  )
}

export function horizontalOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
}

export function overlapsCaption(
  caption: PdfPageRegion,
  sourceBox: NormalizedSourceBox,
) {
  return (
    horizontalOverlap(caption.box, sourceBox) >=
    Math.min(caption.box.width, sourceBox.width) * 0.35
  )
}

export function unionBoxes(
  boxes: NormalizedSourceBox[],
  method: NormalizedSourceBox['method'],
) {
  const left = Math.min(...boxes.map((sourceBox) => sourceBox.x))
  const top = Math.min(...boxes.map((sourceBox) => sourceBox.y))
  const right = Math.max(
    ...boxes.map((sourceBox) => sourceBox.x + sourceBox.width),
  )
  const bottom = Math.max(
    ...boxes.map((sourceBox) => sourceBox.y + sourceBox.height),
  )
  return {
    page: boxes[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: boxes[0].rotation,
    method,
  } satisfies NormalizedSourceBox
}

export function uniqueBoxes(boxes: NormalizedSourceBox[]) {
  const byKey = new Map<string, NormalizedSourceBox>()
  for (const sourceBox of boxes) {
    byKey.set(boxKey(sourceBox), { ...sourceBox })
  }
  return [...byKey.values()].sort(compareBoxes)
}

export function isTableCaption(caption: PdfPageRegion) {
  return (
    caption.kind === 'caption' &&
    /^\s*table(?:\s|[.:])*([0-9]+|[ivxlcdm]+)\b/i.test(caption.text)
  )
}

function captionBoundaryCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
) {
  return pageRegions
    .filter(
      (region) =>
        region.id !== caption.id &&
        region.page === caption.page &&
        region.kind === 'caption' &&
        validBox(region.box) &&
        overlapsCaption(caption, region.box),
    )
    .sort(
      (left, right) =>
        left.box.y - right.box.y || left.id.localeCompare(right.id),
    )
}

export function directionalLanes(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
): DirectionalLane[] {
  const otherCaptions = captionBoundaryCandidates(caption, pageRegions)
  const captionTop = caption.box.y
  const captionBottom = caption.box.y + caption.box.height
  const previous = otherCaptions
    .filter(
      (candidate) =>
        candidate.box.y + candidate.box.height <= captionTop + BOX_TOLERANCE,
    )
    .at(-1)
  const next = otherCaptions.find(
    (candidate) => candidate.box.y >= captionBottom - BOX_TOLERANCE,
  )
  return [
    {
      direction: 'above',
      top: rounded(
        Math.max(
          0,
          captionTop - MAX_CAPTION_DISTANCE,
          previous ? previous.box.y + previous.box.height + BOX_TOLERANCE : 0,
        ),
      ),
      bottom: rounded(captionTop),
      boundaryRegionIds: previous ? [previous.id, caption.id] : [caption.id],
      interveningCaptionRegionId: previous?.id ?? null,
    },
    {
      direction: 'below',
      top: rounded(captionBottom),
      bottom: rounded(
        Math.min(
          1,
          captionBottom + MAX_CAPTION_DISTANCE,
          next ? next.box.y - BOX_TOLERANCE : 1,
        ),
      ),
      boundaryRegionIds: next ? [caption.id, next.id] : [caption.id],
      interveningCaptionRegionId: next?.id ?? null,
    },
  ]
}

export function completeAboveCaptionLane(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
): DirectionalLane {
  const captionTop = caption.box.y
  const previous = captionBoundaryCandidates(caption, pageRegions)
    .filter(
      (candidate) =>
        candidate.box.y + candidate.box.height <= captionTop + BOX_TOLERANCE,
    )
    .at(-1)
  return {
    direction: 'above',
    top: rounded(
      previous ? previous.box.y + previous.box.height + BOX_TOLERANCE : 0,
    ),
    bottom: rounded(captionTop),
    boundaryRegionIds: previous ? [previous.id, caption.id] : [caption.id],
    interveningCaptionRegionId: previous?.id ?? null,
  }
}

export function completeBelowCaptionLane(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
): DirectionalLane {
  const captionBottom = caption.box.y + caption.box.height
  const next = captionBoundaryCandidates(caption, pageRegions).find(
    (candidate) => candidate.box.y >= captionBottom - BOX_TOLERANCE,
  )
  return {
    direction: 'below',
    top: rounded(captionBottom),
    bottom: rounded(next ? next.box.y - BOX_TOLERANCE : 1),
    boundaryRegionIds: next ? [caption.id, next.id] : [caption.id],
    interveningCaptionRegionId: next?.id ?? null,
  }
}

export function boxWithinLane(
  sourceBox: NormalizedSourceBox,
  lane: DirectionalLane,
) {
  return (
    sourceBox.y >= lane.top - BOX_TOLERANCE &&
    sourceBox.y + sourceBox.height <= lane.bottom + BOX_TOLERANCE
  )
}

export function explicitTableStyle(run: PdfRegionLine['runs'][number]) {
  return (
    run.bold === true ||
    /(?:bold|black|demi|semibold|(?:^|[-_])medi(?:um)?(?:$|[-_]))/i.test(
      run.fontName,
    )
  )
}

export function labeledRecordLine(line: PdfRegionLine) {
  const text = line.text.trim()
  const colonIndex = text.indexOf(':')
  const firstRun = line.runs.find((run) => run.text.trim())
  const value = colonIndex >= 0 ? text.slice(colonIndex + 1).trim() : ''
  return Boolean(
    firstRun &&
    colonIndex >= 2 &&
    colonIndex <= 120 &&
    explicitTableStyle(firstRun) &&
    (value.match(/\p{L}{2,}/gu)?.length ?? 0) >= 3,
  )
}

function proseDominantTabularEquationLine(line: PdfRegionLine) {
  const proseWordCount = line.text.match(/\p{L}{2,}/gu)?.length ?? 0
  return (
    proseWordCount >= 3 &&
    (cellAnchors(line.runs).length >= MIN_TABULAR_ROW_ANCHORS ||
      labeledRecordLine(line))
  )
}

export function eligibleTableTextRegion(region: PdfPageRegion) {
  return (
    ['body', 'spanning', 'side', 'chart-label', 'footnote'].includes(
      region.kind,
    ) ||
    (region.kind === 'equation' &&
      (region.lines.length === 1 ||
        region.lines.some(proseDominantTabularEquationLine)))
  )
}

export function gapBetween(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return {
    horizontal: Math.max(
      left.x - (right.x + right.width),
      right.x - (left.x + left.width),
      0,
    ),
    vertical: Math.max(
      left.y - (right.y + right.height),
      right.y - (left.y + left.height),
      0,
    ),
  }
}

export function connectedRegions(left: PdfPageRegion, right: PdfPageRegion) {
  const gap = gapBetween(left.box, right.box)
  return (
    (gap.vertical <= 0.035 && horizontalOverlap(left.box, right.box) > 0) ||
    (gap.horizontal <= 0.04 && gap.vertical === 0)
  )
}

export function connectedComponents<T>(
  values: T[],
  compare: (left: T, right: T) => number,
  connected: (left: T, right: T) => boolean,
) {
  const remaining = [...values].sort(compare)
  const components: T[][] = []
  while (remaining.length > 0) {
    const component = [remaining.shift()!]
    for (let index = 0; index < remaining.length;) {
      const candidate = remaining[index]!
      if (component.some((item) => connected(item, candidate))) {
        component.push(remaining.splice(index, 1)[0]!)
        index = 0
      } else {
        index += 1
      }
    }
    components.push(component.sort(compare))
  }
  return components
}

function clusterRows(lines: PdfRegionLine[]) {
  const rows: Array<{
    y: number
    lineIds: string[]
    runs: PdfRegionLine['runs']
  }> = []
  for (const line of [...lines].sort(
    (left, right) =>
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )) {
    const row = rows.find(
      (candidate) => Math.abs(candidate.y - line.box.y) <= BOX_TOLERANCE,
    )
    if (row) {
      row.lineIds.push(line.id)
      row.runs.push(...line.runs)
      row.runs.sort((left, right) => left.x - right.x)
    } else {
      rows.push({
        y: line.box.y,
        lineIds: [line.id],
        runs: [...line.runs].sort((left, right) => left.x - right.x),
      })
    }
  }
  return rows
}

export function cellAnchors(runs: PdfRegionLine['runs']) {
  const populated = runs
    .filter((run) => run.text.trim())
    .sort((left, right) => left.x - right.x)
  if (populated.length === 0) return []
  const anchors = [populated[0].x]
  let previous = populated[0]
  for (const run of populated.slice(1)) {
    const gap = run.x - (previous.x + previous.width)
    const relativeGap =
      gap / Math.max(Math.min(previous.width, run.width), MIN_DENSE_CELL_GAP)
    if (
      gap >= MIN_CELL_GAP ||
      (gap >= MIN_DENSE_CELL_GAP && relativeGap >= MIN_DENSE_GAP_TO_RUN_RATIO)
    ) {
      anchors.push(run.x)
    }
    previous = run
  }
  return anchors
}

export function alignedAnchorRows(left: number[], right: number[]) {
  return (
    left.length === right.length &&
    left.every(
      (anchor, index) =>
        Math.abs(anchor - right[index]) <= COLUMN_ANCHOR_TOLERANCE,
    )
  )
}

function sparseAnchorsBelongToColumns(
  sparseAnchors: number[],
  columnAnchors: number[],
) {
  if (
    sparseAnchors.length < MIN_GRID_COLUMNS ||
    sparseAnchors.length >= columnAnchors.length
  ) {
    return false
  }
  const claimed = new Set<number>()
  return sparseAnchors.every((anchor) => {
    const candidates = columnAnchors
      .map((columnAnchor, index) => ({
        index,
        distance: Math.abs(columnAnchor - anchor),
      }))
      .filter(
        (candidate) =>
          candidate.distance <= COLUMN_ANCHOR_TOLERANCE &&
          !claimed.has(candidate.index),
      )
      .sort(
        (left, right) =>
          left.distance - right.distance || left.index - right.index,
      )
    const selected = candidates[0]
    if (!selected) return false
    claimed.add(selected.index)
    return true
  })
}

function requiredStrongRows(rowCount: number) {
  return rowCount === 3 ? 2 : Math.max(3, Math.floor(rowCount / 2) + 1)
}

export function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

export function gridProof(regions: PdfPageRegion[]) {
  if (
    regions.some(
      (region) =>
        !validBox(region.box) ||
        !['pdf-text', 'ocr'].includes(region.box.method) ||
        region.lines.some(
          (line) =>
            !containsBox(region.box, line.box) ||
            line.runs.some(
              (run) =>
                !containsBox(region.box, run) ||
                run.page !== line.box.page ||
                run.rotation !== line.box.rotation,
            ),
        ),
    )
  ) {
    return null
  }
  const lines = regions.flatMap((region) => region.lines)
  if (
    lines.length === 0 ||
    lines.some(
      (line) =>
        !validBox(line.box) ||
        line.runs.length === 0 ||
        line.runs.some((run) => !validBox(run)),
    )
  ) {
    return null
  }
  const rows = clusterRows(lines)
  if (rows.length < MIN_GRID_ROWS) return null
  const rowAnchors = rows.map((row) => ({
    row,
    anchors: cellAnchors(row.runs),
  }))
  const requiredStrongRowCount = requiredStrongRows(rows.length)
  const signatures = rowAnchors
    .filter(
      ({ anchors }) =>
        anchors.length >= MIN_GRID_COLUMNS &&
        anchors.length <= MAX_GRID_COLUMNS,
    )
    .map(({ anchors }) => {
      const strongRows = rowAnchors.filter((candidate) =>
        alignedAnchorRows(candidate.anchors, anchors),
      )
      return { anchors, strongRows }
    })
    .filter(({ strongRows }) => strongRows.length >= requiredStrongRowCount)
    .sort(
      (left, right) =>
        right.strongRows.length - left.strongRows.length ||
        right.anchors.length - left.anchors.length ||
        left.anchors[0] - right.anchors[0],
    )
  const selected = signatures[0]
  if (!selected) return null
  const columnCount = selected.anchors.length
  const anchors = Array.from({ length: columnCount }, (_, columnIndex) => {
    const values = selected.strongRows.map(
      (strongRow) => strongRow.anchors[columnIndex],
    )
    return rounded(
      values.reduce((total, value) => total + value, 0) / values.length,
    )
  })
  if (
    anchors.some(
      (anchor, index) =>
        index > 0 && anchor - anchors[index - 1] < MIN_DENSE_CELL_GAP,
    )
  ) {
    return null
  }
  const strongRows = new Set(selected.strongRows)
  const sparseRows = rowAnchors.filter(
    (candidate) =>
      !strongRows.has(candidate) &&
      sparseAnchorsBelongToColumns(candidate.anchors, anchors),
  )
  if (selected.strongRows.length + sparseRows.length !== rows.length) {
    return null
  }
  return {
    proof:
      sparseRows.length > 0
        ? ('text-nonuniform-grid' as const)
        : ('text-grid' as const),
    rowCount: rows.length,
    lineIds: rows.flatMap((row) => row.lineIds).sort(),
    columnCount,
    anchors,
    strongRowCount: selected.strongRows.length,
    requiredStrongRowCount,
    sparseRowCount: sparseRows.length,
    sparseLineIds: sparseRows.flatMap(({ row }) => row.lineIds).sort(),
  }
}

type AtomicGridRow = {
  y: number
  box: NormalizedSourceBox
  regions: PdfPageRegion[]
  lineIds: string[]
  anchors: number[]
}

export function atomicGridRows(regions: PdfPageRegion[]) {
  const rows: Array<{
    y: number
    regions: PdfPageRegion[]
  }> = []
  for (const region of [...regions].sort(
    (left, right) =>
      left.lines[0].box.y - right.lines[0].box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )) {
    const line = region.lines[0]
    const row = rows.find(
      (candidate) => Math.abs(candidate.y - line.box.y) <= BOX_TOLERANCE,
    )
    if (row) row.regions.push(region)
    else rows.push({ y: line.box.y, regions: [region] })
  }
  return rows.map<AtomicGridRow>((row) => {
    const orderedRegions = row.regions.sort(
      (left, right) =>
        left.box.x - right.box.x || left.id.localeCompare(right.id),
    )
    return {
      y: row.y,
      box: unionBoxes(
        orderedRegions.map((region) => region.box),
        orderedRegions.some((region) => region.box.method === 'ocr')
          ? 'ocr'
          : 'pdf-text',
      ),
      regions: orderedRegions,
      lineIds: orderedRegions.map((region) => region.lines[0].id).sort(),
      anchors: cellAnchors(
        orderedRegions.flatMap((region) => region.lines[0].runs),
      ),
    }
  })
}

export function atomicRowBands(rows: AtomicGridRow[]) {
  const bands: AtomicGridRow[][] = []
  for (const row of rows) {
    const band = bands.at(-1)
    const previous = band?.at(-1)
    if (
      band &&
      previous &&
      gapBetween(previous.box, row.box).vertical <= MAX_ATOMIC_ROW_GAP
    ) {
      band.push(row)
    } else {
      bands.push([row])
    }
  }
  return bands
}

export function ordinalGridProof(rows: AtomicGridRow[]) {
  if (rows.length < MIN_GRID_ROWS) return null
  const multiAnchorRows = rows.filter(
    (row) =>
      row.anchors.length >= MIN_GRID_COLUMNS &&
      row.anchors.length <= MAX_GRID_COLUMNS,
  )
  const counts = new Map<number, number>()
  for (const row of multiAnchorRows) {
    counts.set(row.anchors.length, (counts.get(row.anchors.length) ?? 0) + 1)
  }
  const selectedColumnCount = [...counts]
    .sort(
      ([leftColumns, leftCount], [rightColumns, rightCount]) =>
        rightCount - leftCount || rightColumns - leftColumns,
    )
    .at(0)?.[0]
  if (!selectedColumnCount) return null
  const strongRows = multiAnchorRows.filter(
    (row) => row.anchors.length === selectedColumnCount,
  )
  const requiredStrongRowCount = Math.max(
    3,
    Math.floor(multiAnchorRows.length / 2) + 1,
  )
  if (strongRows.length < requiredStrongRowCount) return null

  const columnBands = Array.from(
    { length: selectedColumnCount },
    (_, columnIndex) => {
      const values = strongRows.map((row) => row.anchors[columnIndex])
      return {
        min: Math.min(...values),
        max: Math.max(...values),
        anchor: rounded(median(values)),
      }
    },
  )
  const ordinalAnchors = columnBands.map((band) => band.anchor)
  if (
    ordinalAnchors.some(
      (anchor, index) =>
        index > 0 && anchor - ordinalAnchors[index - 1] < MIN_DENSE_CELL_GAP,
    ) ||
    strongRows.some((row) =>
      row.anchors.some((anchor, index) => {
        const leftBoundary =
          index === 0
            ? -Infinity
            : (ordinalAnchors[index - 1] + ordinalAnchors[index]) / 2
        const rightBoundary =
          index === ordinalAnchors.length - 1
            ? Infinity
            : (ordinalAnchors[index] + ordinalAnchors[index + 1]) / 2
        return anchor <= leftBoundary || anchor >= rightBoundary
      }),
    )
  ) {
    return null
  }
  const left = Math.min(...strongRows.map((row) => row.box.x))
  const right = Math.max(...strongRows.map((row) => row.box.x + row.box.width))
  const sparseRows = rows.filter((row) => !strongRows.includes(row))
  if (
    sparseRows.some(
      (row) =>
        row.anchors.length === 0 ||
        row.anchors.length > selectedColumnCount + 1 ||
        row.box.x + row.box.width < left - BOX_TOLERANCE ||
        row.box.x > right + BOX_TOLERANCE,
    )
  ) {
    return null
  }
  return {
    proof:
      sparseRows.length > 0 ||
      columnBands.some((band) => band.max - band.min > COLUMN_ANCHOR_TOLERANCE)
        ? ('text-nonuniform-grid' as const)
        : ('text-grid' as const),
    rowCount: rows.length,
    lineIds: rows.flatMap((row) => row.lineIds).sort(),
    columnCount: selectedColumnCount,
    anchors: ordinalAnchors,
    strongRowCount: strongRows.length,
    requiredStrongRowCount,
    sparseRowCount: sparseRows.length,
    sparseLineIds: sparseRows.flatMap((row) => row.lineIds).sort(),
  }
}
