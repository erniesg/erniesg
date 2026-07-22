import type {
  NormalizedSourceBox,
  PdfNativeObject,
  PdfPageRegion,
  PdfRegionLine,
} from './import-types'

const BOX_TOLERANCE = 0.004
const MAX_CAPTION_DISTANCE = 0.3
const MIN_CELL_GAP = 0.02
const MIN_DENSE_CELL_GAP = 0.006
const MIN_DENSE_GAP_TO_RUN_RATIO = 0.2
const COLUMN_ANCHOR_TOLERANCE = 0.015
const MIN_GRID_ROWS = 3
const MIN_GRID_COLUMNS = 2
const MAX_GRID_COLUMNS = 12
const MIN_NATIVE_CONFIDENCE = 0.9
const MIN_RASTER_WIDTH = 0.12
const MIN_RASTER_HEIGHT = 0.03
const MAX_SCOPE_AREA = 0.72
const MAX_ATOMIC_ROW_GAP = 0.035
const MAX_LINE_BAND_CAPTION_GAP = 0.025
const MIN_LINE_BAND_WIDTH = 0.15
const MIN_LINE_BAND_HEIGHT = 0.025
const MAX_LINE_BAND_AREA = 0.5
const MIN_CAPTION_HORIZONTAL_COVERAGE = 0.8
const MIN_TABULAR_ROW_ANCHORS = 3
const MAX_TEXT_SLAB_ROW_GAP = 0.0185
const MAX_TEXT_SLAB_CAPTION_GAP = 0.02
const MIN_TEXT_SLAB_ROWS = 5
const MIN_TEXT_SLAB_WIDTH = 0.25
const MIN_WIDE_TEXT_SLAB_WIDTH = 0.65
const MIN_TEXT_SLAB_HEIGHT = 0.05
const MIN_TEXT_SLAB_SINGLE_ANCHOR_RATIO = 0.6
const MAX_COMPRESSED_TEXT_SLAB_FONT_RATIO = 0.82
const MIN_TABULAR_SLAB_ROWS = 5
const MIN_TABULAR_SLAB_ANCHORS = 3
const MIN_REPEATED_TABULAR_SLAB_ANCHORS = 3

export type PdfTableScopeProof =
  | 'text-grid'
  | 'text-nonuniform-grid'
  | 'text-tabular-line-band'
  | 'caption-bounded-text-slab'
  | 'native-raster'
  | 'native-ruled'

export type PdfTableScopeEvidence =
  | {
      code: 'caption-bounded-scope'
      captionRegionId: string
      direction: 'above' | 'below'
      boundaryRegionIds: string[]
      bounds: { top: number; bottom: number }
    }
  | {
      code: 'repeated-row-bands'
      rowCount: number
      lineIds: string[]
    }
  | {
      code: 'repeated-column-anchors'
      columnCount: number
      anchors: number[]
      strongRowCount: number
      requiredStrongRowCount: number
    }
  | {
      code: 'connected-sparse-rows'
      sparseRowCount: number
      lineIds: string[]
    }
  | {
      code: 'multi-run-tabular-line-band'
      rowCount: number
      qualifyingRowCount: number
      requiredQualifyingRowCount: number
      lineIds: string[]
    }
  | {
      code: 'partial-parent-line-selection'
      partialRegionIds: string[]
      selectedLineIds: string[]
      retainedLineIds: string[]
    }
  | {
      code: 'contiguous-single-anchor-slab'
      rowCount: number
      lineIds: string[]
      singleAnchorRowCount: number
      wideLayout: boolean
      compressedTypography: boolean
    }
  | {
      code: 'contiguous-tabular-slab'
      rowCount: number
      lineIds: string[]
      tabularRowCount: number
      repeatedAnchorCount: number
    }
  | {
      code: 'source-native-raster'
      objectIds: string[]
      assetIds: string[]
    }
  | {
      code: 'source-native-ruled-geometry'
      horizontalRuleObjectIds: string[]
      verticalRuleObjectIds: string[]
    }

export type PdfTableRegionLineage = {
  regionId: string
  lineIds: string[]
  retainedLineIds: string[]
  selection: 'whole' | 'partial'
  box: NormalizedSourceBox
}

export type PdfTableLineLineage = {
  regionId: string
  lineId: string
  box: NormalizedSourceBox
}

export type PdfTableObjectLineage = {
  objectId: string
  assetId: string
  kind: PdfNativeObject['kind']
  box: NormalizedSourceBox
}

export type PdfTableScope = {
  id: string
  proof: PdfTableScopeProof
  page: number
  direction: 'above' | 'below'
  sourceRegionIds: string[]
  sourceLineIds: string[]
  sourceObjectIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  sourceLineBoxes: NormalizedSourceBox[]
  cropBox: NormalizedSourceBox
  regionLineage: PdfTableRegionLineage[]
  lineLineage: PdfTableLineLineage[]
  objectLineage: PdfTableObjectLineage[]
  evidence: PdfTableScopeEvidence[]
}

export type PdfTableScopeAmbiguity = {
  code:
    | 'none'
    | 'invalid-caption'
    | 'no-proven-scope'
    | 'duplicate-source-lineage'
    | 'competing-scopes'
  candidateIds: string[]
  evidence: string[]
}

export type PdfTableScopeResolution = {
  schemaVersion: '1.0.0'
  captionRegionId: string
  page: number
  status: 'matched' | 'ambiguous' | 'unresolved'
  scope: PdfTableScope | null
  candidates: PdfTableScope[]
  ambiguity: PdfTableScopeAmbiguity
}

type DirectionalLane = {
  direction: 'above' | 'below'
  top: number
  bottom: number
  boundaryRegionIds: string[]
  interveningCaptionRegionId: string | null
}

type ExactNativeSource = {
  object: PdfNativeObject & { assetId: string }
  region: PdfPageRegion
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function boxKey(sourceBox: NormalizedSourceBox) {
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

function compareBoxes(left: NormalizedSourceBox, right: NormalizedSourceBox) {
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

function validBox(sourceBox: NormalizedSourceBox) {
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

function sameBox(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => Math.abs(left[key] - right[key]) <= 0.00001,
    )
  )
}

function containsBox(
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

function horizontalOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
}

function overlapsCaption(
  caption: PdfPageRegion,
  sourceBox: NormalizedSourceBox,
) {
  return (
    horizontalOverlap(caption.box, sourceBox) >=
    Math.min(caption.box.width, sourceBox.width) * 0.35
  )
}

function unionBoxes(
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

function uniqueBoxes(boxes: NormalizedSourceBox[]) {
  const byKey = new Map<string, NormalizedSourceBox>()
  for (const sourceBox of boxes) {
    byKey.set(boxKey(sourceBox), { ...sourceBox })
  }
  return [...byKey.values()].sort(compareBoxes)
}

function isTableCaption(caption: PdfPageRegion) {
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

function directionalLanes(
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

function completeAboveCaptionLane(
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

function boxWithinLane(sourceBox: NormalizedSourceBox, lane: DirectionalLane) {
  return (
    sourceBox.y >= lane.top - BOX_TOLERANCE &&
    sourceBox.y + sourceBox.height <= lane.bottom + BOX_TOLERANCE
  )
}

function gapBetween(left: NormalizedSourceBox, right: NormalizedSourceBox) {
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

function connectedRegions(left: PdfPageRegion, right: PdfPageRegion) {
  const gap = gapBetween(left.box, right.box)
  return (
    (gap.vertical <= 0.035 && horizontalOverlap(left.box, right.box) > 0) ||
    (gap.horizontal <= 0.04 && gap.vertical === 0)
  )
}

function connectedComponents<T>(
  values: T[],
  compare: (left: T, right: T) => number,
  connected: (left: T, right: T) => boolean,
) {
  const remaining = [...values].sort(compare)
  const components: T[][] = []
  while (remaining.length > 0) {
    const component = [remaining.shift()!]
    for (let index = 0; index < remaining.length; ) {
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

function cellAnchors(runs: PdfRegionLine['runs']) {
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

function alignedAnchorRows(left: number[], right: number[]) {
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

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function gridProof(regions: PdfPageRegion[]) {
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

function atomicGridRows(regions: PdfPageRegion[]) {
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

function atomicRowBands(rows: AtomicGridRow[]) {
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

function ordinalGridProof(rows: AtomicGridRow[]) {
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

type TableLineEntry = {
  region: PdfPageRegion
  line: PdfRegionLine
}

type TableLineRow = {
  y: number
  box: NormalizedSourceBox
  entries: TableLineEntry[]
  anchors: number[]
}

function validTableLineEntry(entry: TableLineEntry) {
  return (
    validBox(entry.region.box) &&
    validBox(entry.line.box) &&
    containsBox(entry.region.box, entry.line.box) &&
    entry.line.runs.length > 0 &&
    entry.line.runs.every(
      (run) =>
        validBox(run) &&
        containsBox(entry.line.box, run) &&
        run.page === entry.line.box.page &&
        run.rotation === entry.line.box.rotation,
    )
  )
}

function tableLineRows(entries: TableLineEntry[]) {
  const rows: Array<{
    y: number
    entries: TableLineEntry[]
  }> = []
  for (const entry of [...entries].sort(
    (left, right) =>
      left.line.box.y - right.line.box.y ||
      left.line.box.x - right.line.box.x ||
      left.region.id.localeCompare(right.region.id) ||
      left.line.id.localeCompare(right.line.id),
  )) {
    const row = rows.find(
      (candidate) => Math.abs(candidate.y - entry.line.box.y) <= BOX_TOLERANCE,
    )
    if (row) row.entries.push(entry)
    else rows.push({ y: entry.line.box.y, entries: [entry] })
  }
  return rows.map<TableLineRow>((row) => {
    const boxes = row.entries.map((entry) => entry.line.box)
    return {
      y: row.y,
      box: unionBoxes(
        boxes,
        boxes.some((sourceBox) => sourceBox.method === 'ocr')
          ? 'ocr'
          : 'pdf-text',
      ),
      entries: row.entries,
      anchors: cellAnchors(row.entries.flatMap((entry) => entry.line.runs)),
    }
  })
}

function repeatedTabularAnchorCount(rows: TableLineRow[]) {
  const anchors: Array<{ x: number; rowIndexes: Set<number> }> = []
  for (const [rowIndex, row] of rows.entries()) {
    for (const x of row.anchors) {
      const existing = anchors.find(
        (anchor) => Math.abs(anchor.x - x) <= COLUMN_ANCHOR_TOLERANCE,
      )
      if (existing) {
        existing.x =
          (existing.x * existing.rowIndexes.size + x) /
          (existing.rowIndexes.size + 1)
        existing.rowIndexes.add(rowIndex)
      } else {
        anchors.push({ x, rowIndexes: new Set([rowIndex]) })
      }
    }
  }
  return anchors.filter((anchor) => anchor.rowIndexes.size >= 3).length
}

function tableLineBands(rows: TableLineRow[]) {
  const bands: TableLineRow[][] = []
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

function captionGap(
  caption: PdfPageRegion,
  cropBox: NormalizedSourceBox,
  direction: DirectionalLane['direction'],
) {
  return direction === 'above'
    ? Math.max(caption.box.y - (cropBox.y + cropBox.height), 0)
    : Math.max(cropBox.y - (caption.box.y + caption.box.height), 0)
}

function tabularLineBandProof(rows: TableLineRow[]) {
  if (rows.length < MIN_GRID_ROWS) return null
  const qualifyingRows = rows.filter(
    (row) => row.anchors.length >= MIN_TABULAR_ROW_ANCHORS,
  )
  const requiredQualifyingRowCount = Math.max(
    MIN_GRID_ROWS,
    Math.floor(rows.length / 2) + 1,
  )
  if (qualifyingRows.length < requiredQualifyingRowCount) return null
  return {
    rowCount: rows.length,
    qualifyingRowCount: qualifyingRows.length,
    requiredQualifyingRowCount,
    lineIds: rows
      .flatMap((row) => row.entries.map((entry) => entry.line.id))
      .sort(),
  }
}

function captionEvidence(
  caption: PdfPageRegion,
  lane: DirectionalLane,
): PdfTableScopeEvidence {
  return {
    code: 'caption-bounded-scope',
    captionRegionId: caption.id,
    direction: lane.direction,
    boundaryRegionIds: [...lane.boundaryRegionIds],
    bounds: { top: lane.top, bottom: lane.bottom },
  }
}

function scopeId(
  proof: PdfTableScopeProof,
  sourceRegionIds: string[],
  lineLineage: PdfTableLineLineage[],
  sourceObjectIds: string[],
  cropBox: NormalizedSourceBox,
) {
  return [
    'pdf-table-scope',
    proof,
    `p${cropBox.page}`,
    `r${cropBox.rotation}`,
    [cropBox.x, cropBox.y, cropBox.width, cropBox.height]
      .map(rounded)
      .join(','),
    cropBox.method,
    sourceRegionIds.join(','),
    [...lineLineage]
      .sort(
        (left, right) =>
          left.regionId.localeCompare(right.regionId) ||
          left.lineId.localeCompare(right.lineId) ||
          compareBoxes(left.box, right.box),
      )
      .map(
        (lineage) =>
          `${lineage.regionId}/${lineage.lineId}@${boxKey(lineage.box)}`,
      )
      .join(','),
    sourceObjectIds.join(','),
  ].join(':')
}

function selectedTextLineage(
  regions: PdfPageRegion[],
  selectedLineIdsByRegion?: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const regionLineage = regions
    .map<PdfTableRegionLineage>((region) => {
      const selected = selectedLineIdsByRegion?.get(region.id)
      const lineIds = region.lines
        .filter((line) => !selected || selected.has(line.id))
        .map((line) => line.id)
        .sort()
      const retainedLineIds = region.lines
        .filter((line) => selected && !selected.has(line.id))
        .map((line) => line.id)
        .sort()
      return {
        regionId: region.id,
        lineIds,
        retainedLineIds,
        selection: retainedLineIds.length > 0 ? 'partial' : 'whole',
        box: { ...region.box },
      }
    })
    .sort((left, right) => left.regionId.localeCompare(right.regionId))
  const selections = new Map(
    regionLineage.map((lineage) => [
      lineage.regionId,
      new Set(lineage.lineIds),
    ]),
  )
  const lineLineage = regions
    .flatMap((region) =>
      region.lines
        .filter((line) => selections.get(region.id)?.has(line.id))
        .map<PdfTableLineLineage>((line) => ({
          regionId: region.id,
          lineId: line.id,
          box: { ...line.box },
        })),
    )
    .sort(
      (left, right) =>
        compareBoxes(left.box, right.box) ||
        left.regionId.localeCompare(right.regionId) ||
        left.lineId.localeCompare(right.lineId),
    )
  return {
    regionLineage,
    lineLineage,
    sourceRegionIds: regionLineage.map((source) => source.regionId),
    sourceLineIds: lineLineage.map((source) => source.lineId),
    sourceLineBoxes: lineLineage.map((source) => ({ ...source.box })),
  }
}

type TextGridProof = NonNullable<
  ReturnType<typeof gridProof> | ReturnType<typeof ordinalGridProof>
>

function textGridScope(
  caption: PdfPageRegion,
  lane: DirectionalLane,
  regions: PdfPageRegion[],
  proof: TextGridProof,
): PdfTableScope | null {
  const {
    regionLineage,
    lineLineage,
    sourceRegionIds,
    sourceLineIds,
    sourceLineBoxes,
  } = selectedTextLineage(regions)
  const sourceBoxes = uniqueBoxes(regionLineage.map((source) => source.box))
  const cropBox = unionBoxes(
    sourceBoxes,
    sourceBoxes.some((sourceBox) => sourceBox.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  )
  if (cropBox.width * cropBox.height > MAX_SCOPE_AREA) return null
  return {
    id: scopeId(proof.proof, sourceRegionIds, lineLineage, [], cropBox),
    proof: proof.proof,
    page: caption.page,
    direction: lane.direction,
    sourceRegionIds,
    sourceLineIds,
    sourceObjectIds: [],
    sourceBoxes,
    sourceLineBoxes,
    cropBox,
    regionLineage,
    lineLineage,
    objectLineage: [],
    evidence: [
      captionEvidence(caption, lane),
      {
        code: 'repeated-row-bands',
        rowCount: proof.rowCount,
        lineIds: proof.lineIds,
      },
      {
        code: 'repeated-column-anchors',
        columnCount: proof.columnCount,
        anchors: proof.anchors,
        strongRowCount: proof.strongRowCount,
        requiredStrongRowCount: proof.requiredStrongRowCount,
      },
      ...(proof.sparseRowCount > 0
        ? ([
            {
              code: 'connected-sparse-rows',
              sparseRowCount: proof.sparseRowCount,
              lineIds: proof.sparseLineIds,
            },
          ] satisfies PdfTableScopeEvidence[])
        : []),
    ],
  }
}

function textGridCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  lanes: DirectionalLane[],
) {
  const candidates: PdfTableScope[] = []
  for (const lane of lanes) {
    const eligible = pageRegions.filter(
      (region) =>
        region.page === caption.page &&
        region.id !== caption.id &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        region.nativeObjectIds.length === 0 &&
        ['body', 'spanning', 'side', 'chart-label', 'footnote'].includes(
          region.kind,
        ) &&
        validBox(region.box) &&
        boxWithinLane(region.box, lane) &&
        overlapsCaption(caption, region.box),
    )
    const independentlyProven = eligible.filter(
      (region) => gridProof([region]) !== null,
    )
    for (const component of connectedComponents(
      independentlyProven,
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
      connectedRegions,
    )) {
      const proof = gridProof(component)
      if (!proof) continue
      const scope = textGridScope(caption, lane, component, proof)
      if (scope) candidates.push(scope)
    }

    // Some PDFs emit every table cell as a separate one-line region. Those
    // atoms cannot prove a grid alone, so group their row bands only when no
    // complete region already proves a scope in this caption lane.
    if (independentlyProven.length > 0) continue
    const atomicRegions = eligible.filter(
      (region) =>
        region.lines.length === 1 &&
        region.lines[0].runs.length > 0 &&
        region.lines[0].runs.every(
          (run) =>
            validBox(run) &&
            containsBox(region.box, run) &&
            run.page === region.page &&
            run.rotation === region.box.rotation,
        ),
    )
    for (const band of atomicRowBands(atomicGridRows(atomicRegions))) {
      const proof = ordinalGridProof(band)
      if (!proof) continue
      const atomic = band.flatMap((row) => row.regions)
      const atomicCrop = unionBoxes(
        atomic.map((region) => region.box),
        atomic.some((region) => region.box.method === 'ocr')
          ? 'ocr'
          : 'pdf-text',
      )
      const atomicIds = new Set(atomic.map((region) => region.id))
      const containedMultilineRegions = eligible.filter(
        (region) =>
          !atomicIds.has(region.id) &&
          region.lines.length > 1 &&
          containsBox(atomicCrop, region.box),
      )
      const scope = textGridScope(
        caption,
        lane,
        [...atomic, ...containedMultilineRegions],
        proof,
      )
      if (scope) candidates.push(scope)
    }
  }
  return candidates
}

function lineSelectionKey(lineLineage: PdfTableLineLineage[]) {
  return [...lineLineage]
    .sort(
      (left, right) =>
        left.regionId.localeCompare(right.regionId) ||
        left.lineId.localeCompare(right.lineId) ||
        compareBoxes(left.box, right.box),
    )
    .map(
      (lineage) =>
        `${lineage.regionId}/${lineage.lineId}@${boxKey(lineage.box)}`,
    )
    .join(',')
}

function lineSelectionIds(lineLineage: PdfTableLineLineage[]) {
  return new Set(
    lineLineage.map((lineage) => `${lineage.regionId}/${lineage.lineId}`),
  )
}

function tabularLineBandCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  lanes: DirectionalLane[],
  existingCandidates: PdfTableScope[],
) {
  const candidates: PdfTableScope[] = []
  const existingLineSelections = new Set(
    existingCandidates.map((candidate) =>
      lineSelectionKey(candidate.lineLineage),
    ),
  )
  const existingLineIdSelections = existingCandidates.map((candidate) =>
    lineSelectionIds(candidate.lineLineage),
  )
  for (const lane of lanes) {
    const entries = pageRegions
      .filter(
        (region) =>
          region.page === caption.page &&
          region.id !== caption.id &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          region.nativeObjectIds.length === 0 &&
          ['body', 'spanning', 'side', 'chart-label', 'footnote'].includes(
            region.kind,
          ) &&
          validBox(region.box),
      )
      .flatMap<TableLineEntry>((region) =>
        region.lines
          .map((line) => ({ region, line }))
          .filter(
            (entry) =>
              validTableLineEntry(entry) &&
              boxWithinLane(entry.line.box, lane) &&
              overlapsCaption(caption, entry.line.box),
          ),
      )
    for (const rows of tableLineBands(tableLineRows(entries))) {
      const proof = tabularLineBandProof(rows)
      if (!proof) continue
      const selectedEntries = rows.flatMap((row) => row.entries)
      const selectedLineBoxes = selectedEntries.map((entry) => entry.line.box)
      const cropBox = unionBoxes(
        selectedLineBoxes,
        selectedLineBoxes.some((sourceBox) => sourceBox.method === 'ocr')
          ? 'ocr'
          : 'pdf-text',
      )
      if (
        captionGap(caption, cropBox, lane.direction) >
          MAX_LINE_BAND_CAPTION_GAP + BOX_TOLERANCE ||
        cropBox.width < MIN_LINE_BAND_WIDTH ||
        cropBox.height < MIN_LINE_BAND_HEIGHT ||
        cropBox.width * cropBox.height > MAX_LINE_BAND_AREA ||
        horizontalOverlap(caption.box, cropBox) / caption.box.width <
          MIN_CAPTION_HORIZONTAL_COVERAGE
      ) {
        continue
      }
      const regionsById = new Map<string, PdfPageRegion>()
      const selectedLineIdsByRegion = new Map<string, Set<string>>()
      for (const entry of selectedEntries) {
        regionsById.set(entry.region.id, entry.region)
        const selected =
          selectedLineIdsByRegion.get(entry.region.id) ?? new Set<string>()
        selected.add(entry.line.id)
        selectedLineIdsByRegion.set(entry.region.id, selected)
      }
      const regions = [...regionsById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      )
      const {
        regionLineage,
        lineLineage,
        sourceRegionIds,
        sourceLineIds,
        sourceLineBoxes,
      } = selectedTextLineage(regions, selectedLineIdsByRegion)
      const selectedIds = lineSelectionIds(lineLineage)
      const overlapsExistingSelection = existingLineIdSelections.some(
        (existingIds) =>
          existingIds.size > 0 &&
          ([...existingIds].every((id) => selectedIds.has(id)) ||
            [...selectedIds].every((id) => existingIds.has(id))),
      )
      if (
        lineLineage.length !== selectedEntries.length ||
        overlapsExistingSelection ||
        existingLineSelections.has(lineSelectionKey(lineLineage))
      ) {
        continue
      }
      const partialRegionIds = regionLineage
        .filter((lineage) => lineage.selection === 'partial')
        .map((lineage) => lineage.regionId)
      const retainedLineIds = regionLineage
        .flatMap((lineage) => lineage.retainedLineIds)
        .sort()
      const scope: PdfTableScope = {
        id: scopeId(
          'text-tabular-line-band',
          sourceRegionIds,
          lineLineage,
          [],
          cropBox,
        ),
        proof: 'text-tabular-line-band',
        page: caption.page,
        direction: lane.direction,
        sourceRegionIds,
        sourceLineIds,
        sourceObjectIds: [],
        sourceBoxes: sourceLineBoxes.map((sourceBox) => ({ ...sourceBox })),
        sourceLineBoxes,
        cropBox,
        regionLineage,
        lineLineage,
        objectLineage: [],
        evidence: [
          captionEvidence(caption, lane),
          {
            code: 'repeated-row-bands',
            rowCount: proof.rowCount,
            lineIds: proof.lineIds,
          },
          {
            code: 'multi-run-tabular-line-band',
            ...proof,
          },
          ...(partialRegionIds.length > 0
            ? ([
                {
                  code: 'partial-parent-line-selection',
                  partialRegionIds,
                  selectedLineIds: [...sourceLineIds],
                  retainedLineIds,
                },
              ] satisfies PdfTableScopeEvidence[])
            : []),
        ],
      }
      candidates.push(scope)
      existingLineSelections.add(lineSelectionKey(lineLineage))
      existingLineIdSelections.push(selectedIds)
    }
  }
  return candidates
}

function captionBoundedTextSlabCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  existingTextCandidates: PdfTableScope[],
) {
  if (existingTextCandidates.length > 0) return []
  const candidates: PdfTableScope[] = []
  for (const lane of [completeAboveCaptionLane(caption, pageRegions)]) {
    const entries = pageRegions
      .filter(
        (region) =>
          region.page === caption.page &&
          region.id !== caption.id &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          region.nativeObjectIds.length === 0 &&
          ['body', 'spanning', 'side', 'chart-label', 'footnote'].includes(
            region.kind,
          ) &&
          validBox(region.box) &&
          horizontalOverlap(caption.box, region.box) > BOX_TOLERANCE,
      )
      .flatMap<TableLineEntry>((region) =>
        region.lines
          .map((line) => ({ region, line }))
          .filter(
            (entry) =>
              validTableLineEntry(entry) && boxWithinLane(entry.line.box, lane),
          ),
      )
    const rows = tableLineRows(entries)
    const nearest = lane.direction === 'above' ? rows.at(-1) : rows[0]
    if (
      !nearest ||
      captionGap(caption, nearest.box, lane.direction) >
        MAX_TEXT_SLAB_CAPTION_GAP + BOX_TOLERANCE
    ) {
      continue
    }
    const selectedRows = [nearest]
    const increment = lane.direction === 'above' ? -1 : 1
    for (
      let index = lane.direction === 'above' ? rows.length - 2 : 1;
      index >= 0 && index < rows.length;
      index += increment
    ) {
      const candidate = rows[index]
      const current =
        lane.direction === 'above' ? selectedRows[0] : selectedRows.at(-1)!
      if (
        gapBetween(candidate.box, current.box).vertical > MAX_TEXT_SLAB_ROW_GAP
      ) {
        break
      }
      if (lane.direction === 'above') selectedRows.unshift(candidate)
      else selectedRows.push(candidate)
    }
    if (selectedRows.length < MIN_TEXT_SLAB_ROWS) continue
    const selectedEntries = selectedRows.flatMap((row) => row.entries)
    const selectedLineBoxes = selectedEntries.map((entry) => entry.line.box)
    const cropBox = unionBoxes(
      selectedLineBoxes,
      selectedLineBoxes.some((sourceBox) => sourceBox.method === 'ocr')
        ? 'ocr'
        : 'pdf-text',
    )
    const singleAnchorRowCount = selectedRows.filter(
      (row) => row.anchors.length === 1,
    ).length
    const wideLayout = cropBox.width >= MIN_WIDE_TEXT_SLAB_WIDTH
    const selectedMaximumFontSize = Math.max(
      ...selectedEntries.map((entry) => entry.line.fontSize),
    )
    const pageMaximumFontSize = Math.max(
      ...pageRegions.flatMap((region) =>
        region.page === caption.page && region.kind !== 'caption'
          ? region.lines.map((line) => line.fontSize)
          : [],
      ),
      selectedMaximumFontSize,
    )
    const compressedTypography =
      selectedMaximumFontSize < pageMaximumFontSize &&
      selectedMaximumFontSize / pageMaximumFontSize <=
        MAX_COMPRESSED_TEXT_SLAB_FONT_RATIO
    const tabularRowCount = selectedRows.filter(
      (row) => row.anchors.length >= MIN_TABULAR_SLAB_ANCHORS,
    ).length
    const repeatedAnchorCount = repeatedTabularAnchorCount(selectedRows)
    const singleAnchorSlab =
      singleAnchorRowCount / selectedRows.length >=
      MIN_TEXT_SLAB_SINGLE_ANCHOR_RATIO
    const tabularSlab =
      tabularRowCount >= MIN_TABULAR_SLAB_ROWS &&
      repeatedAnchorCount >= MIN_REPEATED_TABULAR_SLAB_ANCHORS
    if (
      cropBox.width < MIN_TEXT_SLAB_WIDTH ||
      cropBox.height < MIN_TEXT_SLAB_HEIGHT ||
      cropBox.width * cropBox.height > MAX_SCOPE_AREA ||
      horizontalOverlap(caption.box, cropBox) <= BOX_TOLERANCE ||
      (!singleAnchorSlab && !tabularSlab) ||
      (!wideLayout && !compressedTypography)
    ) {
      continue
    }
    const regionsById = new Map<string, PdfPageRegion>()
    const selectedLineIdsByRegion = new Map<string, Set<string>>()
    for (const entry of selectedEntries) {
      regionsById.set(entry.region.id, entry.region)
      const selected =
        selectedLineIdsByRegion.get(entry.region.id) ?? new Set<string>()
      selected.add(entry.line.id)
      selectedLineIdsByRegion.set(entry.region.id, selected)
    }
    const regions = [...regionsById.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
    const {
      regionLineage,
      lineLineage,
      sourceRegionIds,
      sourceLineIds,
      sourceLineBoxes,
    } = selectedTextLineage(regions, selectedLineIdsByRegion)
    candidates.push({
      id: scopeId(
        'caption-bounded-text-slab',
        sourceRegionIds,
        lineLineage,
        [],
        cropBox,
      ),
      proof: 'caption-bounded-text-slab',
      page: caption.page,
      direction: lane.direction,
      sourceRegionIds,
      sourceLineIds,
      sourceObjectIds: [],
      sourceBoxes: sourceLineBoxes.map((sourceBox) => ({ ...sourceBox })),
      sourceLineBoxes,
      cropBox,
      regionLineage,
      lineLineage,
      objectLineage: [],
      evidence: [
        captionEvidence(caption, lane),
        ...(singleAnchorSlab
          ? ([
              {
                code: 'contiguous-single-anchor-slab',
                rowCount: selectedRows.length,
                lineIds: [...sourceLineIds],
                singleAnchorRowCount,
                wideLayout,
                compressedTypography,
              },
            ] satisfies PdfTableScopeEvidence[])
          : []),
        ...(tabularSlab
          ? ([
              {
                code: 'contiguous-tabular-slab',
                rowCount: selectedRows.length,
                lineIds: [...sourceLineIds],
                tabularRowCount,
                repeatedAnchorCount,
              },
            ] satisfies PdfTableScopeEvidence[])
          : []),
      ],
    })
  }
  return candidates
}

function exactMappings(object: PdfNativeObject, pageRegions: PdfPageRegion[]) {
  return pageRegions
    .filter(
      (region) =>
        region.page === object.page &&
        region.nativeObjectIds.length === 1 &&
        region.nativeObjectIds[0] === object.id &&
        validBox(region.box) &&
        sameBox(region.box, object.box),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
}

function eligibleNativeObject(
  object: PdfNativeObject,
  caption: PdfPageRegion,
  lane: DirectionalLane,
): object is PdfNativeObject & { assetId: string } {
  return (
    object.page === caption.page &&
    object.role !== 'scan-source' &&
    object.confidence >= MIN_NATIVE_CONFIDENCE &&
    typeof object.assetId === 'string' &&
    object.assetId.length > 0 &&
    validBox(object.box) &&
    boxWithinLane(object.box, lane)
  )
}

function nativeSourceLineage(source: ExactNativeSource) {
  return {
    region: {
      regionId: source.region.id,
      lineIds: source.region.lines.map((line) => line.id).sort(),
      retainedLineIds: [],
      selection: 'whole',
      box: { ...source.region.box },
    } satisfies PdfTableRegionLineage,
    object: {
      objectId: source.object.id,
      assetId: source.object.assetId,
      kind: source.object.kind,
      box: { ...source.object.box },
    } satisfies PdfTableObjectLineage,
  }
}

function rasterCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  nativeObjects: PdfNativeObject[],
  lanes: DirectionalLane[],
) {
  const candidates: PdfTableScope[] = []
  const duplicateObjectIds = new Set<string>()
  for (const lane of lanes) {
    for (const object of nativeObjects
      .filter(
        (candidate): candidate is PdfNativeObject & { assetId: string } =>
          candidate.kind === 'image' &&
          eligibleNativeObject(candidate, caption, lane) &&
          candidate.box.width >= MIN_RASTER_WIDTH &&
          candidate.box.height >= MIN_RASTER_HEIGHT &&
          candidate.box.width * candidate.box.height <= MAX_SCOPE_AREA &&
          overlapsCaption(caption, candidate.box),
      )
      .sort((left, right) => left.id.localeCompare(right.id))) {
      const mappings = exactMappings(object, pageRegions)
      if (mappings.length > 1) duplicateObjectIds.add(object.id)
      for (const region of mappings) {
        const lineage = nativeSourceLineage({ object, region })
        const sourceRegionIds = [region.id]
        const sourceObjectIds = [object.id]
        const sourceBoxes = uniqueBoxes([region.box, object.box])
        const cropBox = unionBoxes(sourceBoxes, 'pdf-object')
        candidates.push({
          id: scopeId(
            'native-raster',
            sourceRegionIds,
            [],
            sourceObjectIds,
            cropBox,
          ),
          proof: 'native-raster',
          page: caption.page,
          direction: lane.direction,
          sourceRegionIds,
          sourceLineIds: [],
          sourceObjectIds,
          sourceBoxes,
          sourceLineBoxes: [],
          cropBox,
          regionLineage: [lineage.region],
          lineLineage: [],
          objectLineage: [lineage.object],
          evidence: [
            captionEvidence(caption, lane),
            {
              code: 'source-native-raster',
              objectIds: sourceObjectIds,
              assetIds: [object.assetId],
            },
          ],
        })
      }
    }
  }
  return { candidates, duplicateObjectIds }
}

function horizontalRule(source: ExactNativeSource) {
  const { width, height } = source.object.box
  return width >= 0.1 && height <= Math.max(0.004, width * 0.035)
}

function verticalRule(source: ExactNativeSource) {
  const { width, height } = source.object.box
  return height >= 0.05 && width <= Math.max(0.004, height * 0.035)
}

function connectedRules(left: ExactNativeSource, right: ExactNativeSource) {
  const leftBox = left.object.box
  const rightBox = right.object.box
  return (
    leftBox.x <= rightBox.x + rightBox.width + BOX_TOLERANCE &&
    rightBox.x <= leftBox.x + leftBox.width + BOX_TOLERANCE &&
    leftBox.y <= rightBox.y + rightBox.height + BOX_TOLERANCE &&
    rightBox.y <= leftBox.y + leftBox.height + BOX_TOLERANCE
  )
}

function ruledProof(sources: ExactNativeSource[]) {
  const horizontal = sources.filter(horizontalRule)
  const vertical = sources.filter(verticalRule)
  if (horizontal.length < 3 || vertical.length < 3) return null
  const horizontalIds = horizontal.map((source) => source.object.id).sort()
  const verticalIds = vertical.map((source) => source.object.id).sort()
  const everyRuleIntersects = horizontal.every((horizontalSource) =>
    vertical.every((verticalSource) =>
      connectedRules(horizontalSource, verticalSource),
    ),
  )
  if (!everyRuleIntersects) return null
  const distinctRowBands = new Set(
    horizontal.map((source) => rounded(source.object.box.y)),
  )
  const distinctColumnBands = new Set(
    vertical.map((source) => rounded(source.object.box.x)),
  )
  return distinctRowBands.size >= 3 && distinctColumnBands.size >= 3
    ? { horizontalIds, verticalIds }
    : null
}

function ruledCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  nativeObjects: PdfNativeObject[],
  lanes: DirectionalLane[],
) {
  const candidates: PdfTableScope[] = []
  const duplicateObjectIds = new Set<string>()
  for (const lane of lanes) {
    const exactSources = nativeObjects
      .filter(
        (object): object is PdfNativeObject & { assetId: string } =>
          object.kind === 'vector' &&
          eligibleNativeObject(object, caption, lane),
      )
      .flatMap<ExactNativeSource>((object) => {
        const mappings = exactMappings(object, pageRegions)
        if (mappings.length > 1) duplicateObjectIds.add(object.id)
        return mappings.length === 1 ? [{ object, region: mappings[0] }] : []
      })
    const ruleSources = exactSources.filter(
      (source) => horizontalRule(source) || verticalRule(source),
    )
    for (const component of connectedComponents(
      ruleSources,
      (left, right) => left.object.id.localeCompare(right.object.id),
      connectedRules,
    )) {
      const proof = ruledProof(component)
      if (!proof) continue
      const cropBox = unionBoxes(
        component.map((source) => source.object.box),
        'pdf-object',
      )
      if (
        cropBox.width * cropBox.height > MAX_SCOPE_AREA ||
        !overlapsCaption(caption, cropBox)
      ) {
        continue
      }
      const lineages = component
        .map(nativeSourceLineage)
        .sort((left, right) =>
          left.object.objectId.localeCompare(right.object.objectId),
        )
      const regionLineage = lineages
        .map((lineage) => lineage.region)
        .sort((left, right) => left.regionId.localeCompare(right.regionId))
      const objectLineage = lineages.map((lineage) => lineage.object)
      const sourceRegionIds = regionLineage.map((source) => source.regionId)
      const sourceObjectIds = objectLineage.map((source) => source.objectId)
      candidates.push({
        id: scopeId(
          'native-ruled',
          sourceRegionIds,
          [],
          sourceObjectIds,
          cropBox,
        ),
        proof: 'native-ruled',
        page: caption.page,
        direction: lane.direction,
        sourceRegionIds,
        sourceLineIds: [],
        sourceObjectIds,
        sourceBoxes: uniqueBoxes([
          ...regionLineage.map((source) => source.box),
          ...objectLineage.map((source) => source.box),
        ]),
        sourceLineBoxes: [],
        cropBox,
        regionLineage,
        lineLineage: [],
        objectLineage,
        evidence: [
          captionEvidence(caption, lane),
          {
            code: 'source-native-ruled-geometry',
            horizontalRuleObjectIds: proof.horizontalIds,
            verticalRuleObjectIds: proof.verticalIds,
          },
        ],
      })
    }
  }
  return { candidates, duplicateObjectIds }
}

function unresolved(
  caption: PdfPageRegion,
  code: PdfTableScopeAmbiguity['code'],
  candidates: PdfTableScope[],
  evidence: string[],
): PdfTableScopeResolution {
  return {
    schemaVersion: '1.0.0',
    captionRegionId: caption.id,
    page: caption.page,
    status:
      code === 'duplicate-source-lineage' || code === 'competing-scopes'
        ? 'ambiguous'
        : 'unresolved',
    scope: null,
    candidates,
    ambiguity: {
      code,
      candidateIds: candidates.map((candidate) => candidate.id),
      evidence,
    },
  }
}

function orderedProseScope(
  scope: PdfTableScope,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
) {
  const scopedRegions = scope.sourceRegionIds
    .map((id) => regionsById.get(id))
    .filter((region): region is PdfPageRegion => Boolean(region))
    .sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x)
  if (scopedRegions.length < 2) return false
  const ordinals = scopedRegions.map((region) => {
    const match = region.text.trim().match(/^(\d+)[.)]\s+\p{L}/u)
    return match ? Number(match[1]) : null
  })
  return ordinals.every(
    (ordinal, index) =>
      ordinal !== null &&
      (index === 0 || ordinal === (ordinals[index - 1] ?? 0) + 1),
  )
}

function arabicTableNumber(region: PdfPageRegion) {
  const match = region.text.match(/^\s*table(?:\s|[.:])*(\d+)\b/i)
  return match ? Number(match[1]) : null
}

function belongsToFollowingNumberedCaption(
  scope: PdfTableScope,
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
) {
  if (scope.direction !== 'below') return false
  const currentNumber = arabicTableNumber(caption)
  if (currentNumber === null) return false
  const currentGap = gapBetween(scope.cropBox, caption.box).vertical
  return pageRegions.some((candidate) => {
    if (
      candidate.id === caption.id ||
      arabicTableNumber(candidate) !== currentNumber + 1 ||
      candidate.box.y < scope.cropBox.y + scope.cropBox.height ||
      !overlapsCaption(candidate, scope.cropBox)
    ) {
      return false
    }
    return (
      gapBetween(scope.cropBox, candidate.box).vertical + BOX_TOLERANCE / 2 <
      currentGap
    )
  })
}

/**
 * Resolves only an exact, caption-bounded source scope for a PDF table.
 *
 * A matched native scope is not a claim that its pixels form a semantic cell
 * grid. Semantic table validation intentionally remains a separate operation.
 */
export function resolvePdfTableScope({
  caption,
  pageRegions,
  nativeObjects,
}: {
  caption: PdfPageRegion
  pageRegions: PdfPageRegion[]
  nativeObjects: PdfNativeObject[]
}): PdfTableScopeResolution {
  if (!isTableCaption(caption) || !validBox(caption.box)) {
    return unresolved(
      caption,
      'invalid-caption',
      [],
      ['table-caption-region-required'],
    )
  }
  const regions = [...pageRegions].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const objects = [...nativeObjects].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const lanes = directionalLanes(caption, regions)
  const textGrids = textGridCandidates(caption, regions, lanes)
  const tabularLineBands = tabularLineBandCandidates(
    caption,
    regions,
    lanes,
    textGrids,
  )
  const textSlabs = captionBoundedTextSlabCandidates(caption, regions, [
    ...textGrids,
    ...tabularLineBands,
  ])
  const raster = rasterCandidates(caption, regions, objects, lanes)
  const ruled = ruledCandidates(caption, regions, objects, lanes)
  const uniqueGridOverUnprovenRasters =
    textGrids.length === 1 &&
    tabularLineBands.length === 0 &&
    textSlabs.length === 0 &&
    ruled.candidates.length === 0 &&
    raster.candidates.length > 0
  const candidates = (
    uniqueGridOverUnprovenRasters
      ? [textGrids[0]]
      : [
          ...textGrids,
          ...tabularLineBands,
          ...textSlabs,
          ...raster.candidates,
          ...ruled.candidates,
        ]
  ).sort((left, right) => left.id.localeCompare(right.id))
  const regionsById = new Map(regions.map((region) => [region.id, region]))
  const captionOwnedCandidates = candidates.some(
    (candidate) => candidate.direction === 'above',
  )
    ? candidates.filter(
        (candidate) =>
          !belongsToFollowingNumberedCaption(candidate, caption, regions),
      )
    : candidates
  const nonProseCandidates = captionOwnedCandidates.filter(
    (candidate) => !orderedProseScope(candidate, regionsById),
  )
  const resolvedCandidates =
    captionOwnedCandidates.length > 1 && nonProseCandidates.length === 1
      ? nonProseCandidates
      : captionOwnedCandidates
  const duplicateObjectIds = [
    ...new Set([...raster.duplicateObjectIds, ...ruled.duplicateObjectIds]),
  ].sort()
  if (!uniqueGridOverUnprovenRasters && duplicateObjectIds.length > 0) {
    return unresolved(
      caption,
      'duplicate-source-lineage',
      resolvedCandidates,
      duplicateObjectIds,
    )
  }
  if (resolvedCandidates.length === 0) {
    const evidence = ['deterministic-geometry-required']
    if (lanes.some((lane) => lane.interveningCaptionRegionId)) {
      evidence.push('intervening-caption-boundary')
    }
    return unresolved(caption, 'no-proven-scope', [], evidence)
  }
  if (resolvedCandidates.length > 1) {
    return unresolved(caption, 'competing-scopes', resolvedCandidates, [
      'more-than-one-bounded-scope',
    ])
  }
  return {
    schemaVersion: '1.0.0',
    captionRegionId: caption.id,
    page: caption.page,
    status: 'matched',
    scope: resolvedCandidates[0],
    candidates: resolvedCandidates,
    ambiguity: { code: 'none', candidateIds: [], evidence: [] },
  }
}
