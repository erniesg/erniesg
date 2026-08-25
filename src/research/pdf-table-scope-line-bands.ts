import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
} from './import-types'
import {
  BOX_TOLERANCE,
  COLUMN_ANCHOR_TOLERANCE,
  MAX_ATOMIC_ROW_GAP,
  MIN_GRID_ROWS,
  MIN_TABULAR_ROW_ANCHORS,
  cellAnchors,
  containsBox,
  explicitTableStyle,
  gapBetween,
  labeledRecordLine,
  median,
  unionBoxes,
  validBox,
  type DirectionalLane,
} from './pdf-table-scope-grid'

export const MAX_LINE_BAND_CAPTION_GAP = 0.025
export const MAX_TEXT_SLAB_CAPTION_GAP = 0.02

const MIN_ROW_BAND_LINE_HEIGHT_RATIO = 0.9
const MAX_ROW_BAND_LINE_HEIGHT_RATIO = 1.2
const MIN_COLUMN_GUTTER_WIDTH = 0.02
const MIN_COLUMN_GUTTER_CENTRE = 0.25
const MAX_COLUMN_GUTTER_CENTRE = 0.75
const MIN_DOMINANT_GUTTER_SIDE_ENTRIES = 3
const MIN_DOMINANT_GUTTER_COLUMN_AGREEMENT = 0.7

export type TableColumnLane = 'left' | 'right' | 'full'

export type TableLineEntry = {
  region: PdfPageRegion
  line: PdfRegionLine
}

export type TableLineRow = {
  y: number
  lane: TableColumnLane
  box: NormalizedSourceBox
  entries: TableLineEntry[]
  anchors: number[]
}

export function validTableLineEntry(entry: TableLineEntry) {
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

// Row membership is a page-layout fact, not only a vertical one. On a
// multi-column page the neighbouring column's body prose shares row
// coordinates with a table, so grouping by `y` alone unions both columns into
// one row and lets a band claim the whole text measure.
//
// The separating gutter is proved from the candidate lines themselves: a
// vertical corridor that no candidate line crosses, wide enough and central
// enough to be a page gutter, with the region classifier independently
// agreeing that the two sides are opposite columns. A genuinely page-spanning
// table has cells tiling across the gutter, so no such corridor exists and it
// keeps banding as one lane.
function candidateColumnGutter(entries: TableLineEntry[]) {
  const intervals = entries
    .map((entry) => ({
      left: entry.line.box.x,
      right: entry.line.box.x + entry.line.box.width,
      column: entry.region.column,
    }))
    .sort((left, right) => left.left - right.left)
  if (intervals.length === 0) return null

  const corridors: Array<{ from: number; to: number }> = []
  let covered = intervals[0].right
  for (const interval of intervals.slice(1)) {
    if (interval.left > covered) {
      corridors.push({ from: covered, to: interval.left })
    }
    covered = Math.max(covered, interval.right)
  }

  const qualifying = corridors
    .filter((corridor) => {
      const width = corridor.to - corridor.from
      const centre = (corridor.from + corridor.to) / 2
      if (
        width < MIN_COLUMN_GUTTER_WIDTH ||
        centre < MIN_COLUMN_GUTTER_CENTRE ||
        centre > MAX_COLUMN_GUTTER_CENTRE
      ) {
        return false
      }
      // The region classifier must independently read the two sides as
      // opposite columns; an internal cell gap never satisfies this.
      const before = intervals.filter((item) => item.right <= corridor.from)
      const after = intervals.filter((item) => item.left >= corridor.to)
      return (
        before.length > 0 &&
        after.length > 0 &&
        before.every((item) => item.column === 'left') &&
        after.every((item) => item.column === 'right')
      )
    })
    .sort(
      (left, right) =>
        right.to - right.from - (left.to - left.from) || left.from - right.from,
    )

  return qualifying[0] ?? null
}

export function dominantCandidateColumnGutter(
  entries: TableLineEntry[],
  caption: PdfPageRegion,
  direction: DirectionalLane['direction'],
) {
  const captionTop = caption.box.y
  const captionBottom = caption.box.y + caption.box.height
  const intervals = entries
    .map((entry) => ({
      left: entry.line.box.x,
      right: entry.line.box.x + entry.line.box.width,
      column: entry.region.column,
      captionGap:
        direction === 'below'
          ? Math.max(0, entry.line.box.y - captionBottom)
          : Math.max(
              0,
              captionTop - (entry.line.box.y + entry.line.box.height),
            ),
    }))
    .sort((left, right) => left.left - right.left)
  if (intervals.length === 0) return null

  const corridors: Array<{ from: number; to: number }> = []
  let covered = intervals[0].right
  for (const interval of intervals.slice(1)) {
    if (interval.left > covered) {
      corridors.push({ from: covered, to: interval.left })
    }
    covered = Math.max(covered, interval.right)
  }
  const adjacentGap =
    MAX_TEXT_SLAB_CAPTION_GAP + MAX_LINE_BAND_CAPTION_GAP + BOX_TOLERANCE
  const qualifying = corridors
    .filter((corridor) => {
      const width = corridor.to - corridor.from
      const centre = (corridor.from + corridor.to) / 2
      if (
        width < MIN_COLUMN_GUTTER_WIDTH ||
        centre < MIN_COLUMN_GUTTER_CENTRE ||
        centre > MAX_COLUMN_GUTTER_CENTRE
      ) {
        return false
      }
      const before = intervals.filter((item) => item.right <= corridor.from)
      const after = intervals.filter((item) => item.left >= corridor.to)
      const explicitBefore = before.filter(
        (item) => item.column === 'left' || item.column === 'right',
      )
      const explicitAfter = after.filter(
        (item) => item.column === 'left' || item.column === 'right',
      )
      const leftAgreement =
        explicitBefore.filter((item) => item.column === 'left').length /
        Math.max(1, explicitBefore.length)
      const rightAgreement =
        explicitAfter.filter((item) => item.column === 'right').length /
        Math.max(1, explicitAfter.length)
      return (
        explicitBefore.length >= MIN_DOMINANT_GUTTER_SIDE_ENTRIES &&
        explicitAfter.length >= MIN_DOMINANT_GUTTER_SIDE_ENTRIES &&
        leftAgreement >= MIN_DOMINANT_GUTTER_COLUMN_AGREEMENT &&
        rightAgreement >= MIN_DOMINANT_GUTTER_COLUMN_AGREEMENT &&
        before.some((item) => item.captionGap <= adjacentGap) &&
        after.some((item) => item.captionGap <= adjacentGap)
      )
    })
    .sort(
      (left, right) =>
        right.to - right.from - (left.to - left.from) || left.from - right.from,
    )
  if (
    qualifying.length > 1 &&
    qualifying[0].to -
      qualifying[0].from -
      (qualifying[1].to - qualifying[1].from) <=
      BOX_TOLERANCE
  ) {
    return null
  }
  return qualifying[0] ?? null
}

export function tableLineRows(entries: TableLineEntry[]) {
  const gutter = candidateColumnGutter(entries)
  const columnLane = (entry: TableLineEntry): TableColumnLane =>
    gutter === null ? 'full' : entry.line.box.x >= gutter.to ? 'right' : 'left'
  const rows: Array<{
    y: number
    lane: TableColumnLane
    entries: TableLineEntry[]
  }> = []
  for (const entry of [...entries].sort(
    (left, right) =>
      left.line.box.y - right.line.box.y ||
      left.line.box.x - right.line.box.x ||
      left.region.id.localeCompare(right.region.id) ||
      left.line.id.localeCompare(right.line.id),
  )) {
    const lane = columnLane(entry)
    const row = rows.find(
      (candidate) =>
        candidate.lane === lane &&
        Math.abs(candidate.y - entry.line.box.y) <= BOX_TOLERANCE,
    )
    if (row) row.entries.push(entry)
    else rows.push({ y: entry.line.box.y, lane, entries: [entry] })
  }
  return rows.map<TableLineRow>((row) => {
    const boxes = row.entries.map((entry) => entry.line.box)
    return {
      y: row.y,
      lane: row.lane,
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

export function captionOwnedTableRows(
  captionRows: TableLineRow[],
  candidateRows: TableLineRow[],
): TableLineRow[] | null {
  const captionEntryKeys = new Set(
    captionRows.flatMap((row) =>
      row.entries.map((entry) => tableLineEntryKey(entry)),
    ),
  )
  const recoveredCaptionEntryKeys = new Set<string>()
  const ownerLanes = new Set<TableColumnLane>()
  for (const row of candidateRows) {
    let ownsCaptionEntry = false
    for (const entry of row.entries) {
      const key = tableLineEntryKey(entry)
      if (!captionEntryKeys.has(key)) continue
      recoveredCaptionEntryKeys.add(key)
      ownsCaptionEntry = true
    }
    if (ownsCaptionEntry) ownerLanes.add(row.lane)
  }
  if (
    captionEntryKeys.size === 0 ||
    recoveredCaptionEntryKeys.size !== captionEntryKeys.size ||
    ownerLanes.size !== 1
  ) {
    return candidateRows.some((row) => row.lane !== 'full')
      ? null
      : candidateRows
  }
  const [ownerLane] = ownerLanes
  return candidateRows.filter((row) => row.lane === ownerLane)
}

export function captionOwnedTableEntries(
  caption: PdfPageRegion,
  captionRows: TableLineRow[],
  candidateEntries: TableLineEntry[],
  supplementalEntries: TableLineEntry[],
) {
  if (
    caption.sourceCaptionLane ||
    caption.column === 'left' ||
    caption.column === 'right'
  ) {
    const supplementalEntryKeys = new Set(
      supplementalEntries.map((entry) => tableLineEntryKey(entry)),
    )
    return candidateEntries.filter(
      (entry) =>
        captionOwnsTableLine(caption, entry) ||
        supplementalEntryKeys.has(tableLineEntryKey(entry)),
    )
  }
  const seedEntries = captionRows.flatMap((row) => row.entries)
  const seedColumn =
    seedEntries.length > 0 &&
    seedEntries.every((entry) => entry.region.column === 'left')
      ? 'left'
      : seedEntries.length > 0 &&
          seedEntries.every((entry) => entry.region.column === 'right')
        ? 'right'
        : null
  if (seedColumn === null) return candidateEntries
  const supplementalEntryKeys = new Set(
    supplementalEntries.map((entry) => tableLineEntryKey(entry)),
  )
  return candidateEntries.filter(
    (entry) =>
      entry.region.column === seedColumn ||
      supplementalEntryKeys.has(tableLineEntryKey(entry)),
  )
}

export function repeatedTabularAnchorCount(rows: TableLineRow[]) {
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

function sourceStyledSectionBoundaryRow(
  row: TableLineRow,
  precedingRows: TableLineRow[],
) {
  if (precedingRows.length < MIN_GRID_ROWS) return false
  const orderedEntries = [...row.entries].sort(
    (left, right) =>
      left.line.box.x - right.line.box.x ||
      left.line.id.localeCompare(right.line.id),
  )
  const visibleText = orderedEntries
    .map((entry) => entry.line.text.trim())
    .filter(Boolean)
    .join(' ')
  if (
    !/^(?:\d+(?:\.\d+){0,3}[.)]?|[A-Z](?:\.\d+)+[.)]?)\s+\p{Lu}/u.test(
      visibleText,
    )
  ) {
    return false
  }
  const runs = orderedEntries.flatMap((entry) => entry.line.runs)
  const visibleCharacters = runs.reduce(
    (total, run) => total + run.text.trim().length,
    0,
  )
  const emphasizedCharacters = runs.reduce(
    (total, run) =>
      total + (explicitTableStyle(run) ? run.text.trim().length : 0),
    0,
  )
  const precedingFontSize = median(
    precedingRows.flatMap((candidate) =>
      candidate.entries.map((entry) => entry.line.fontSize),
    ),
  )
  const rowFontSize = Math.max(
    ...orderedEntries.map((entry) => entry.line.fontSize),
  )
  const hierarchicalNumberedHeading = /^\d+\.\d/u.test(visibleText)
  return (
    visibleCharacters > 0 &&
    ((hierarchicalNumberedHeading && rowFontSize >= precedingFontSize * 1.12) ||
      (emphasizedCharacters >= visibleCharacters * 0.6 &&
        rowFontSize >= precedingFontSize * 1.05))
  )
}

function startsSparseContinuation(
  establishedRows: TableLineRow[],
  remainingRows: TableLineRow[],
) {
  if (
    establishedRows.length < MIN_GRID_ROWS ||
    remainingRows.length < MIN_GRID_ROWS ||
    !tabularLineBandProof(establishedRows) ||
    remainingRows
      .slice(0, MIN_GRID_ROWS)
      .some((row) => row.anchors.length >= MIN_TABULAR_ROW_ANCHORS)
  ) {
    return false
  }
  const previous = establishedRows.at(-1)!
  const boundaryGap = gapBetween(previous.box, remainingRows[0].box).vertical
  const establishedGaps = establishedRows
    .slice(1)
    .map(
      (row, index) => gapBetween(establishedRows[index].box, row.box).vertical,
    )
  const continuation = remainingRows.slice(0, MIN_GRID_ROWS)
  const continuationGaps = continuation
    .slice(1)
    .map((row, index) => gapBetween(continuation[index].box, row.box).vertical)
  const establishedGap = median(establishedGaps)
  const continuationGap = median(continuationGaps)
  return (
    boundaryGap >= 0.018 &&
    boundaryGap >= Math.max(establishedGap, 0.001) * 2.5 &&
    boundaryGap >= Math.max(continuationGap, 0.001) * 2.5
  )
}

// Band each column lane independently. Interleaving two columns' rows by `y`
// and banding the merged sequence would either union the columns into one
// band or shatter both into single rows, so neither column could ever prove a
// table on a multi-column page.
function tableLineBandsWithinLane(rows: TableLineRow[]) {
  const bands: TableLineRow[][] = []
  for (const [rowIndex, row] of rows.entries()) {
    const band = bands.at(-1)
    const previous = band?.at(-1)
    if (
      band &&
      previous &&
      !sourceStyledSectionBoundaryRow(row, band) &&
      !startsSparseContinuation(band, rows.slice(rowIndex)) &&
      gapBetween(previous.box, row.box).vertical <= MAX_ATOMIC_ROW_GAP
    ) {
      band.push(row)
    } else {
      bands.push([row])
    }
  }
  return bands
}

const TABLE_COLUMN_LANE_ORDER: TableColumnLane[] = ['full', 'left', 'right']

export function tableLineBands(rows: TableLineRow[]) {
  return TABLE_COLUMN_LANE_ORDER.flatMap((lane) =>
    tableLineBandsWithinLane(rows.filter((row) => row.lane === lane)),
  )
}

export function lineHeightMatchesBand(
  line: PdfRegionLine,
  referenceHeights: number[],
) {
  const referenceHeight = median(referenceHeights)
  if (referenceHeight <= 0) return false
  const ratio = line.box.height / referenceHeight
  return (
    ratio >= MIN_ROW_BAND_LINE_HEIGHT_RATIO &&
    ratio <= MAX_ROW_BAND_LINE_HEIGHT_RATIO
  )
}

export function rowHeightMatchesBand(
  row: TableLineRow,
  referenceRows: TableLineRow[],
) {
  const referenceHeight = median(
    referenceRows.flatMap((candidate) =>
      candidate.entries.map((entry) => entry.line.box.height),
    ),
  )
  const rowHeight = median(row.entries.map((entry) => entry.line.box.height))
  if (referenceHeight <= 0 || rowHeight <= 0) return false
  const ratio = rowHeight / referenceHeight
  return (
    ratio >= MIN_ROW_BAND_LINE_HEIGHT_RATIO &&
    ratio <= MAX_ROW_BAND_LINE_HEIGHT_RATIO
  )
}

function rowTypographyMatchesBand(
  row: TableLineRow,
  referenceRows: TableLineRow[],
) {
  const referenceFontNames = new Set(
    referenceRows.flatMap((candidate) =>
      candidate.entries.flatMap((entry) =>
        entry.line.runs
          .filter((run) => run.text.trim())
          .map((run) => normalizedTableFontName(run.fontName)),
      ),
    ),
  )
  const rowFontNames = new Set(
    row.entries.flatMap((entry) =>
      entry.line.runs
        .filter((run) => run.text.trim())
        .map((run) => normalizedTableFontName(run.fontName)),
    ),
  )
  return (
    referenceFontNames.size > 0 &&
    rowFontNames.size > 0 &&
    [...rowFontNames].every((fontName) => referenceFontNames.has(fontName))
  )
}

function explicitlyStyledTableRow(row: TableLineRow) {
  const visibleRuns = row.entries.flatMap((entry) =>
    entry.line.runs.filter((run) => run.text.trim()),
  )
  return visibleRuns.length > 0 && visibleRuns.every(explicitTableStyle)
}

function provedTableHeaderBodyTransition(
  row: TableLineRow,
  header: TableLineRow,
) {
  if (
    !explicitTableHeaderRow(header) ||
    row.anchors.length < MIN_TABULAR_ROW_ANCHORS
  ) {
    return false
  }
  const claimedHeaderAnchors = new Set<number>()
  return row.anchors.every((anchor) => {
    const candidates = header.anchors
      .map((headerAnchor, index) => ({
        index,
        distance: Math.abs(headerAnchor - anchor),
      }))
      .filter(
        (candidate) =>
          candidate.distance <= COLUMN_ANCHOR_TOLERANCE &&
          !claimedHeaderAnchors.has(candidate.index),
      )
      .sort(
        (left, right) =>
          left.distance - right.distance || left.index - right.index,
      )
    const selected = candidates[0]
    if (!selected) return false
    claimedHeaderAnchors.add(selected.index)
    return true
  })
}

export function weakSlabTypographyBoundaryMatches(
  row: TableLineRow,
  referenceRows: TableLineRow[],
  allowLeadingSourceHeading: boolean,
) {
  const labeledRecordAnchors = (candidate: TableLineRow) =>
    candidate.entries.flatMap((entry) => {
      if (!labeledRecordLine(entry.line)) return []
      const labelRun = entry.line.runs.find((run) => run.text.trim())
      return labelRun
        ? [
            {
              fontName: normalizedTableFontName(labelRun.fontName),
              x: labelRun.x,
            },
          ]
        : []
    })
  const incomingRecordAnchors = labeledRecordAnchors(row)
  const establishedRecordAnchors = referenceRows.flatMap(labeledRecordAnchors)
  const crossesLabeledRecordBoundary =
    incomingRecordAnchors.length > 0 && establishedRecordAnchors.length > 0
  const labeledRecordTransition = incomingRecordAnchors.some((incoming) =>
    establishedRecordAnchors.some(
      (established) =>
        incoming.fontName === established.fontName &&
        Math.abs(incoming.x - established.x) <= COLUMN_ANCHOR_TOLERANCE,
    ),
  )
  return (
    (rowTypographyMatchesBand(row, referenceRows) &&
      !crossesLabeledRecordBoundary) ||
    labeledRecordTransition ||
    (allowLeadingSourceHeading && explicitlyStyledTableRow(row)) ||
    (referenceRows.length === 1 &&
      provedTableHeaderBodyTransition(row, referenceRows[0]))
  )
}

export function captionGap(
  caption: PdfPageRegion,
  cropBox: NormalizedSourceBox,
  direction: DirectionalLane['direction'],
) {
  return direction === 'above'
    ? Math.max(caption.box.y - (cropBox.y + cropBox.height), 0)
    : Math.max(cropBox.y - (caption.box.y + caption.box.height), 0)
}

export function tabularLineBandProof(rows: TableLineRow[]) {
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

export function tableLineEntryKey(entry: TableLineEntry) {
  return `${entry.region.id}/${entry.line.id}`
}

export function normalizedTableFontName(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/^[a-z]{6}\+/u, '')
    .replace(
      /(?:[-_ ]?(?:bold|black|demi|semibold|medium|italic|oblique|regular))+$/gu,
      '',
    )
}

export function sourceCaptionLaneOwnsBox(
  caption: PdfPageRegion,
  sourceBox: NormalizedSourceBox,
) {
  const lane = caption.sourceCaptionLane
  if (!lane) return null
  const left = sourceBox.x
  const right = sourceBox.x + sourceBox.width
  if (
    left < lane.boundary - BOX_TOLERANCE &&
    right > lane.boundary + BOX_TOLERANCE
  ) {
    return false
  }
  const center = left + sourceBox.width / 2
  return lane.side === 'left'
    ? center <= lane.boundary + BOX_TOLERANCE
    : center >= lane.boundary - BOX_TOLERANCE
}

export function captionOwnsTableLine(
  caption: PdfPageRegion,
  entry: TableLineEntry,
) {
  const localLaneOwnership = sourceCaptionLaneOwnsBox(caption, entry.line.box)
  if (localLaneOwnership !== null) return localLaneOwnership
  if (caption.column === 'left' || caption.column === 'right') {
    return entry.region.column === caption.column
  }
  const center = entry.line.box.x + entry.line.box.width / 2
  return (
    center >= caption.box.x - MAX_LINE_BAND_CAPTION_GAP &&
    center <= caption.box.x + caption.box.width + MAX_LINE_BAND_CAPTION_GAP
  )
}

export function explicitTableHeaderRow(row: TableLineRow) {
  const runs = row.entries.flatMap((entry) =>
    entry.line.runs.filter((run) => run.text.trim()),
  )
  return (
    (row.anchors.length >= MIN_TABULAR_ROW_ANCHORS &&
      runs.length > 0 &&
      row.entries.every((entry) => entry.region.kind === 'header')) ||
    (row.anchors.length >= MIN_TABULAR_ROW_ANCHORS &&
      runs.length > 0 &&
      runs.every(explicitTableStyle))
  )
}
