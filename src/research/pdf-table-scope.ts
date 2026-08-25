import type {
  NormalizedSourceBox,
  PdfNativeObject,
  PdfPageRegion,
  PdfRegionLine,
} from './import-types'
import {
  BOX_TOLERANCE,
  COLUMN_ANCHOR_TOLERANCE,
  MIN_DENSE_CELL_GAP,
  MIN_GRID_ROWS,
  MIN_TABULAR_ROW_ANCHORS,
  alignedAnchorRows,
  atomicGridRows,
  atomicRowBands,
  boxKey,
  boxWithinLane,
  cellAnchors,
  compareBoxes,
  completeAboveCaptionLane,
  completeBelowCaptionLane,
  connectedComponents,
  connectedRegions,
  containsBox,
  directionalLanes,
  eligibleTableTextRegion,
  explicitTableStyle,
  gapBetween,
  gridProof,
  horizontalOverlap,
  isTableCaption,
  labeledRecordLine,
  median,
  ordinalGridProof,
  overlapsCaption,
  rounded,
  sameBox,
  unionBoxes,
  uniqueBoxes,
  validBox,
  type DirectionalLane,
} from './pdf-table-scope-grid'
import {
  MAX_LINE_BAND_CAPTION_GAP,
  MAX_TEXT_SLAB_CAPTION_GAP,
  captionGap,
  captionOwnedTableEntries,
  captionOwnedTableRows,
  captionOwnsTableLine,
  explicitTableHeaderRow,
  lineHeightMatchesBand,
  repeatedTabularAnchorCount,
  rowHeightMatchesBand,
  tableLineBands,
  tableLineEntryKey,
  tableLineRows,
  tabularLineBandProof,
  validTableLineEntry,
  weakSlabTypographyBoundaryMatches,
  type TableColumnLane,
  type TableLineEntry,
  type TableLineRow,
} from './pdf-table-scope-line-bands'
import {
  MAX_SCOPE_AREA,
  captionOwnsTextSlabLine,
  completeCaptionLaneTextCandidates,
  inferredLocalCaptionLane,
  scopeId,
  scopeLineEntries,
  selectedTextLineage,
} from './pdf-table-scope-source-completion'

const MIN_NATIVE_CONFIDENCE = 0.9
const MIN_RASTER_WIDTH = 0.12
const MIN_RASTER_HEIGHT = 0.03
const MIN_LINE_BAND_WIDTH = 0.15
const MIN_LINE_BAND_HEIGHT = 0.025
const MAX_LINE_BAND_AREA = 0.5
const MIN_CAPTION_HORIZONTAL_COVERAGE = 0.8
const MAX_NUMERIC_TABLE_ROW_STUB_WIDTH = 0.18
const MAX_NUMERIC_TABLE_ROW_STUB_WORDS = 6
const MIN_ATOMIC_BAND_REGION_HORIZONTAL_COVERAGE = 0.5
const MAX_TEXT_SLAB_ROW_GAP = 0.0185
const MAX_PROMPT_SLAB_ROW_GAP = 0.035
const MAX_PROMPT_SLAB_CAPTION_GAP = 0.03
const MIN_TEXT_SLAB_ROWS = 5
const MIN_PROMPT_SLAB_ROWS = 6
const MIN_PROMPT_STRUCTURED_RECORDS = 3
const MIN_TEXT_SLAB_WIDTH = 0.25
const MIN_WIDE_TEXT_SLAB_WIDTH = 0.65
const MIN_TEXT_SLAB_HEIGHT = 0.05
const MIN_TEXT_SLAB_SINGLE_ANCHOR_RATIO = 0.6
const MAX_COMPRESSED_TEXT_SLAB_FONT_RATIO = 0.82
const MIN_TABULAR_SLAB_ROWS = 5
const MIN_TABULAR_SLAB_ANCHORS = 3
const MIN_REPEATED_TABULAR_SLAB_ANCHORS = 3
const MIN_LABELED_RECORD_ROWS = 3
const MIN_LABELED_RECORD_WIDTH = 0.5
const MAX_UNPROVEN_PAGE_TOP_TABLE_START = 0.105
const MAX_SOURCE_FALLBACK_CAPTION_GAP = 0.055
const MAX_SOURCE_FALLBACK_ROW_GAP = 0.055
const MIN_SOURCE_FALLBACK_SCORE = 4

export function compactTabularSlabMayFollowCaption({
  tabularSlab,
  cropWidth,
}: {
  tabularSlab: boolean
  cropWidth: number
}) {
  return tabularSlab && cropWidth >= MIN_TEXT_SLAB_WIDTH
}

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
      code: 'supplemental-equation-cell-shard'
      regionIds: string[]
      lineIds: string[]
      columnAnchors: number[]
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
      sourceStartHeading: boolean
    }
  | {
      code: 'contiguous-tabular-slab'
      rowCount: number
      lineIds: string[]
      tabularRowCount: number
      repeatedAnchorCount: number
    }
  | {
      code: 'caption-bounded-prompt-slab'
      rowCount: number
      lineIds: string[]
      monospacedRowCount: number
      structuredRecordCount: number
    }
  | {
      code: 'caption-lane-source-completion'
      lineIds: string[]
      headerLineIds: string[]
      rowFragmentLineIds: string[]
      captionAdjacentLineIds: string[]
      borderInkPadding: number
    }
  | {
      code: 'repeated-labeled-record-rows'
      rowCount: number
      lineIds: string[]
      labeledRowCount: number
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
  /**
   * A fallback scope is intentionally not a semantic-table claim. It is a
   * deterministic source envelope that lets the readable export retain the
   * original region while a later semantic detector remains free to fail
   * closed.
   */
  fallback?: 'source-preserved'
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
  /**
   * Candidate source envelopes that are safe to preserve but not strong
   * enough to promote as a bounded table scope. Keeping these separate from
   * `candidates` preserves the semantic resolver's fail-closed contract.
   */
  fallbackCandidates?: PdfTableScope[]
  ambiguity: PdfTableScopeAmbiguity
}

type ExactNativeSource = {
  object: PdfNativeObject & { assetId: string }
  region: PdfPageRegion
}

function numericMetricRun(run: PdfRegionLine['runs'][number]) {
  const text = run.text.trim()
  return /\d/u.test(text) && (text.match(/\p{L}/gu)?.length ?? 0) <= 1
}

function numericTableRowStub(run: PdfRegionLine['runs'][number]) {
  const text = run.text.trim()
  const wordCount =
    text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu)?.length ?? 0
  return (
    text.length > 0 &&
    run.width <= MAX_NUMERIC_TABLE_ROW_STUB_WIDTH &&
    wordCount <= MAX_NUMERIC_TABLE_ROW_STUB_WORDS &&
    !/[.!?](?:["')\]]*)$/u.test(text)
  )
}

// Crossing the ordinary caption-distance cap is safe only when source
// geometry supplies both an explicit header and one dominant numeric column
// signature. Mixed signatures fail closed instead of exporting a lower shard.
function stableNumericTableBandProof(rows: TableLineRow[]) {
  if (!explicitTableHeaderRow(rows[0])) return false
  const numericRows = rows.filter((row) => {
    const runs = row.entries.flatMap((entry) =>
      entry.line.runs.filter((run) => run.text.trim()),
    )
    const numericRuns = runs.filter(numericMetricRun)
    const nonNumericRuns = runs.filter((run) => !numericMetricRun(run))
    const leftmostNumericX = Math.min(...numericRuns.map((run) => run.x))
    const hasOnlyOwnedRowStub =
      nonNumericRuns.length === 0 ||
      (nonNumericRuns.length === 1 &&
        nonNumericRuns[0].x <= leftmostNumericX + BOX_TOLERANCE &&
        numericTableRowStub(nonNumericRuns[0]))
    return (
      numericRuns.length >= MIN_TABULAR_ROW_ANCHORS &&
      hasOnlyOwnedRowStub &&
      numericRuns.length >= Math.max(1, runs.length - 1) * 0.6
    )
  })
  const requiredNumericRows = Math.max(5, Math.floor(rows.length * 0.6) + 1)
  if (numericRows.length < requiredNumericRows) return false
  const signatures = numericRows.map((row) =>
    cellAnchors(row.entries.flatMap((entry) => entry.line.runs)),
  )
  const requiredAlignedRows = Math.max(
    5,
    Math.floor(numericRows.length * 0.6) + 1,
  )
  return signatures.some(
    (signature) =>
      signature.length >= MIN_TABULAR_ROW_ANCHORS &&
      signatures.filter((candidate) => alignedAnchorRows(candidate, signature))
        .length >= requiredAlignedRows,
  )
}

function lexicalTableHeaderRow(row: TableLineRow) {
  const runs = row.entries.flatMap((entry) =>
    entry.line.runs.filter((run) => run.text.trim()),
  )
  return (
    row.anchors.length >= MIN_TABULAR_ROW_ANCHORS &&
    runs.length >= MIN_TABULAR_ROW_ANCHORS &&
    runs.every((run) => /\p{L}/u.test(run.text) && !numericMetricRun(run))
  )
}

function strongSparseExtensionBoundary(
  row: TableLineRow,
  precedingRows: TableLineRow[],
) {
  if (
    precedingRows.length < MIN_GRID_ROWS ||
    row.anchors.length >= MIN_TABULAR_ROW_ANCHORS
  ) {
    return false
  }
  const previous = precedingRows.at(-1)!
  const boundaryGap = gapBetween(previous.box, row.box).vertical
  const establishedGaps = precedingRows
    .slice(1)
    .map(
      (candidate, index) =>
        gapBetween(precedingRows[index].box, candidate.box).vertical,
    )
  const visibleRuns = row.entries.flatMap((entry) =>
    entry.line.runs.filter((run) => run.text.trim()),
  )
  const emphasizedCharacters = visibleRuns.reduce(
    (total, run) =>
      total + (explicitTableStyle(run) ? run.text.trim().length : 0),
    0,
  )
  const visibleCharacters = visibleRuns.reduce(
    (total, run) => total + run.text.trim().length,
    0,
  )
  return (
    visibleCharacters > 0 &&
    (row.entries.every((entry) => entry.region.kind === 'header') ||
      emphasizedCharacters >= visibleCharacters * 0.6) &&
    boundaryGap >= 0.018 &&
    boundaryGap >= Math.max(median(establishedGaps), 0.001) * 2.5
  )
}

function styledSparseRowSpansProvenColumns(
  row: TableLineRow,
  columns: Array<{ anchor: number }>,
) {
  const visibleRuns = row.entries.flatMap((entry) =>
    entry.line.runs.filter((run) => run.text.trim()),
  )
  return (
    visibleRuns.length > 0 &&
    visibleRuns.every(explicitTableStyle) &&
    visibleRuns.every((run) =>
      columns.some(
        (column) =>
          column.anchor >= run.x - COLUMN_ANCHOR_TOLERANCE &&
          column.anchor <= run.x + run.width + COLUMN_ANCHOR_TOLERANCE,
      ),
    )
  )
}

// Long tables below their captions may legitimately cross the conservative
// ordinary caption-distance cap. Extend only one continuous band whose
// caption-adjacent header and body independently establish at least three
// dominant columns. A competing column family or a second table after a
// section boundary remains ambiguous.
function stableRepeatedTableBandRows(rows: TableLineRow[]) {
  const boundaryIndex = rows.findIndex((row, index) =>
    strongSparseExtensionBoundary(row, rows.slice(0, index)),
  )
  const provenRows = boundaryIndex >= 0 ? rows.slice(0, boundaryIndex) : rows
  const remainder = boundaryIndex >= 0 ? rows.slice(boundaryIndex + 1) : []
  if (provenRows.length < 10) return null
  if (
    !explicitTableHeaderRow(provenRows[0]) &&
    !lexicalTableHeaderRow(provenRows[0])
  ) {
    return null
  }
  if (
    remainder.some(
      (_row, index) => tabularLineBandProof(remainder.slice(index)) !== null,
    )
  ) {
    return null
  }

  const qualifyingRows = provenRows.filter(
    (row) => row.anchors.length >= MIN_TABULAR_ROW_ANCHORS,
  )
  const requiredQualifyingRows = Math.max(
    10,
    Math.floor(provenRows.length * 0.35) + 1,
  )
  if (qualifyingRows.length < requiredQualifyingRows) return null

  const numericRows = qualifyingRows
    .slice(1)
    .filter((row) =>
      row.entries.some((entry) => entry.line.runs.some(numericMetricRun)),
    )
  const requiredNumericRows = Math.max(
    6,
    Math.floor((qualifyingRows.length - 1) * 0.6) + 1,
  )
  if (numericRows.length < requiredNumericRows) return null

  const columns: Array<{
    anchor: number
    values: number[]
    rowIndexes: Set<number>
  }> = []
  for (const [rowIndex, row] of qualifyingRows.entries()) {
    for (const anchor of row.anchors) {
      const column = columns
        .map((candidate) => ({
          candidate,
          distance: Math.abs(candidate.anchor - anchor),
        }))
        .filter(({ distance }) => distance <= COLUMN_ANCHOR_TOLERANCE)
        .sort(
          (left, right) =>
            left.distance - right.distance ||
            left.candidate.anchor - right.candidate.anchor,
        )[0]?.candidate
      if (column) {
        column.values.push(anchor)
        column.anchor = median(column.values)
        column.rowIndexes.add(rowIndex)
      } else {
        columns.push({
          anchor,
          values: [anchor],
          rowIndexes: new Set([rowIndex]),
        })
      }
    }
  }
  const requiredColumnRows = Math.max(
    8,
    Math.floor(qualifyingRows.length * 0.7) + 1,
  )
  const dominantColumns = columns.filter(
    (column) => column.rowIndexes.size >= requiredColumnRows,
  )
  if (dominantColumns.length < MIN_TABULAR_ROW_ANCHORS) return null
  const alignedRows = qualifyingRows.filter((row) => {
    const claimedColumns = new Set<number>()
    const alignedAnchors = row.anchors.filter((anchor) => {
      const match = dominantColumns
        .map((column, index) => ({
          index,
          distance: Math.abs(column.anchor - anchor),
        }))
        .filter(
          (candidate) =>
            candidate.distance <= COLUMN_ANCHOR_TOLERANCE &&
            !claimedColumns.has(candidate.index),
        )
        .sort(
          (left, right) =>
            left.distance - right.distance || left.index - right.index,
        )[0]
      if (!match) return false
      claimedColumns.add(match.index)
      return true
    })
    return alignedAnchors.length >= MIN_TABULAR_ROW_ANCHORS
  })
  const requiredAlignedRows = Math.max(
    8,
    Math.floor(qualifyingRows.length * 0.7) + 1,
  )
  if (alignedRows.length < requiredAlignedRows) return null
  const sparseRows = provenRows.filter(
    (row) =>
      row.anchors.length > 0 && row.anchors.length < MIN_TABULAR_ROW_ANCHORS,
  )
  const ownedSparseRows = sparseRows.filter(
    (row) =>
      row.anchors.every((anchor) =>
        dominantColumns.some(
          (column) =>
            Math.abs(column.anchor - anchor) <= COLUMN_ANCHOR_TOLERANCE,
        ),
      ) || styledSparseRowSpansProvenColumns(row, dominantColumns),
  )
  const requiredOwnedSparseRows =
    sparseRows.length === 0 ? 0 : Math.floor(sparseRows.length * 0.8) + 1
  return ownedSparseRows.length >= requiredOwnedSparseRows ? provenRows : null
}

type ExtendedTabularLaneDecision = {
  lane: DirectionalLane | null
  truncatedAtCaptionDistance: boolean
  crossingLineIds: string[]
  provenLineIds: string[]
}

function extendedNumericAboveTableLane(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  lanes: DirectionalLane[],
): ExtendedTabularLaneDecision {
  const standardAbove = lanes.find((lane) => lane.direction === 'above')!
  const completeAbove = completeAboveCaptionLane(caption, pageRegions)
  const none = {
    lane: null,
    truncatedAtCaptionDistance: false,
    crossingLineIds: [],
    provenLineIds: [],
  } satisfies ExtendedTabularLaneDecision
  if (completeAbove.top >= standardAbove.top - BOX_TOLERANCE) return none

  const entries = pageRegions
    .filter(
      (region) =>
        region.page === caption.page &&
        region.id !== caption.id &&
        region.kind !== 'caption' &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        region.nativeObjectIds.length === 0 &&
        (eligibleTableTextRegion(region) || region.kind === 'header') &&
        validBox(region.box),
    )
    .flatMap<TableLineEntry>((region) =>
      region.lines
        .map((line) => ({ region, line }))
        .filter(
          (entry) =>
            validTableLineEntry(entry) &&
            boxWithinLane(entry.line.box, completeAbove) &&
            captionOwnsTableLine(caption, entry),
        ),
    )
  const crossingBands = tableLineBands(tableLineRows(entries)).filter(
    (rows) => {
      const boxes = rows.map((row) => row.box)
      const cropBox = unionBoxes(
        boxes,
        boxes.some((sourceBox) => sourceBox.method === 'ocr')
          ? 'ocr'
          : 'pdf-text',
      )
      const rowsInsideStandardLane = rows.filter(
        (row) =>
          row.box.y + row.box.height >= standardAbove.top - BOX_TOLERANCE,
      )
      return (
        rows.some((row) => row.box.y < standardAbove.top - BOX_TOLERANCE) &&
        tabularLineBandProof(rowsInsideStandardLane) !== null &&
        captionGap(caption, cropBox, 'above') <=
          MAX_LINE_BAND_CAPTION_GAP + BOX_TOLERANCE &&
        cropBox.width >= MIN_LINE_BAND_WIDTH &&
        cropBox.height >= MIN_LINE_BAND_HEIGHT &&
        cropBox.width * cropBox.height <= MAX_LINE_BAND_AREA &&
        horizontalOverlap(caption.box, cropBox) /
          Math.min(caption.box.width, cropBox.width) >=
          MIN_CAPTION_HORIZONTAL_COVERAGE
      )
    },
  )
  const provenBands = crossingBands.filter(stableNumericTableBandProof)
  const lineIds = (bands: TableLineRow[][]) =>
    [
      ...new Set(
        bands.flatMap((rows) =>
          rows.flatMap((row) => row.entries.map((entry) => entry.line.id)),
        ),
      ),
    ].sort()
  return {
    lane: provenBands.length === 1 ? completeAbove : null,
    truncatedAtCaptionDistance: crossingBands.length > 0,
    crossingLineIds: lineIds(crossingBands),
    provenLineIds: provenBands.length === 1 ? lineIds(provenBands) : [],
  }
}

function extendedRepeatedBelowTableLane(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  lanes: DirectionalLane[],
): ExtendedTabularLaneDecision {
  const standardBelow = lanes.find((lane) => lane.direction === 'below')!
  const completeBelow = completeBelowCaptionLane(caption, pageRegions)
  const none = {
    lane: null,
    truncatedAtCaptionDistance: false,
    crossingLineIds: [],
    provenLineIds: [],
  } satisfies ExtendedTabularLaneDecision
  if (completeBelow.bottom <= standardBelow.bottom + BOX_TOLERANCE) return none

  const entries = pageRegions
    .filter(
      (region) =>
        region.page === caption.page &&
        region.id !== caption.id &&
        region.kind !== 'caption' &&
        region.kind !== 'page-number' &&
        region.includedInReadingOrder !== false &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        region.nativeObjectIds.length === 0 &&
        (eligibleTableTextRegion(region) || region.kind === 'header') &&
        validBox(region.box),
    )
    .flatMap<TableLineEntry>((region) =>
      region.lines
        .map((line) => ({ region, line }))
        .filter(
          (entry) =>
            validTableLineEntry(entry) &&
            boxWithinLane(entry.line.box, completeBelow) &&
            captionOwnsTableLine(caption, entry),
        ),
    )
  const crossingBands = tableLineBands(tableLineRows(entries)).filter(
    (rows) => {
      const boxes = rows.map((row) => row.box)
      const cropBox = unionBoxes(
        boxes,
        boxes.some((sourceBox) => sourceBox.method === 'ocr')
          ? 'ocr'
          : 'pdf-text',
      )
      const rowsInsideStandardLane = rows.filter(
        (row) => row.box.y <= standardBelow.bottom + BOX_TOLERANCE,
      )
      const denseRowsInsideStandardLane = rowsInsideStandardLane.filter(
        (row) => row.anchors.length >= MIN_TABULAR_ROW_ANCHORS,
      )
      return (
        rows.some(
          (row) =>
            row.box.y + row.box.height > standardBelow.bottom + BOX_TOLERANCE,
        ) &&
        (tabularLineBandProof(rowsInsideStandardLane) !== null ||
          tabularLineBandProof(denseRowsInsideStandardLane) !== null) &&
        captionGap(caption, cropBox, 'below') <=
          MAX_LINE_BAND_CAPTION_GAP + BOX_TOLERANCE &&
        cropBox.width >= MIN_LINE_BAND_WIDTH &&
        cropBox.height >= MIN_LINE_BAND_HEIGHT &&
        cropBox.width * cropBox.height <= MAX_LINE_BAND_AREA &&
        horizontalOverlap(caption.box, cropBox) /
          Math.min(caption.box.width, cropBox.width) >=
          MIN_CAPTION_HORIZONTAL_COVERAGE
      )
    },
  )
  const provenBands = crossingBands.flatMap((rows) => {
    const provenRows = stableRepeatedTableBandRows(rows)
    return provenRows ? [provenRows] : []
  })
  const lineIds = (bands: TableLineRow[][]) =>
    [
      ...new Set(
        bands.flatMap((rows) =>
          rows.flatMap((row) => row.entries.map((entry) => entry.line.id)),
        ),
      ),
    ].sort()
  const provenRows = provenBands.length === 1 ? provenBands[0] : null
  const provenBottom = provenRows
    ? Math.max(...provenRows.map((row) => row.box.y + row.box.height))
    : null
  return {
    lane:
      provenBottom === null
        ? null
        : {
            ...completeBelow,
            bottom: rounded(provenBottom),
          },
    truncatedAtCaptionDistance: crossingBands.length > 0,
    crossingLineIds: lineIds(crossingBands),
    provenLineIds: provenRows ? lineIds([provenRows]) : [],
  }
}

function matchingTableRowIndex(rows: TableLineRow[], line: PdfRegionLine) {
  const matches = rows
    .map((row, index) => ({ index, distance: Math.abs(row.y - line.box.y) }))
    .filter((candidate) => candidate.distance <= BOX_TOLERANCE)
    .sort(
      (left, right) =>
        left.distance - right.distance || left.index - right.index,
    )
  return matches.length === 1 ? matches[0].index : null
}

function recurringCaptionBandEntries(
  captionRows: TableLineRow[],
  laneEntries: TableLineEntry[],
) {
  const captionEntryKeys = new Set(
    captionRows
      .flatMap((row) => row.entries)
      .map((entry) => tableLineEntryKey(entry)),
  )
  const entries = laneEntries
    .map((entry) => ({
      entry,
      rowIndex: matchingTableRowIndex(captionRows, entry.line),
      anchors: cellAnchors(entry.line.runs),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        entry: TableLineEntry
        rowIndex: number
        anchors: number[]
      } => candidate.rowIndex !== null && candidate.anchors.length > 0,
    )
  const anchorBands: Array<{
    anchor: number
    values: number[]
    rowIndexes: Set<number>
  }> = []
  for (const { rowIndex, anchors } of entries) {
    for (const anchor of anchors) {
      const band = anchorBands
        .map((candidate) => ({
          candidate,
          distance: Math.abs(candidate.anchor - anchor),
        }))
        .filter(({ distance }) => distance <= COLUMN_ANCHOR_TOLERANCE)
        .sort(
          (left, right) =>
            left.distance - right.distance ||
            left.candidate.anchor - right.candidate.anchor,
        )[0]?.candidate
      if (band) {
        band.values.push(anchor)
        band.anchor = median(band.values)
        band.rowIndexes.add(rowIndex)
      } else {
        anchorBands.push({
          anchor,
          values: [anchor],
          rowIndexes: new Set([rowIndex]),
        })
      }
    }
  }
  const recurringBands = anchorBands.filter(
    (band) => band.rowIndexes.size === captionRows.length,
  )
  return entries
    .filter(({ entry, anchors }) => {
      if (captionEntryKeys.has(tableLineEntryKey(entry))) return true
      return anchors.every((anchor) =>
        recurringBands.some(
          (band) => Math.abs(band.anchor - anchor) <= COLUMN_ANCHOR_TOLERANCE,
        ),
      )
    })
    .map(({ entry }) => entry)
}

type SupplementalEquationCellShards = {
  entries: TableLineEntry[]
  ambiguous: boolean
  regionIds: string[]
  lineIds: string[]
  columnAnchors: number[]
}

function supplementalEquationCellShardEntries({
  caption,
  lane,
  pageRegions,
  ordinaryEntries,
}: {
  caption: PdfPageRegion
  lane: DirectionalLane
  pageRegions: PdfPageRegion[]
  ordinaryEntries: TableLineEntry[]
}): SupplementalEquationCellShards {
  const none = {
    entries: [],
    ambiguous: false,
    regionIds: [],
    lineIds: [],
    columnAnchors: [],
  } satisfies SupplementalEquationCellShards
  const ordinaryRows = tableLineRows(
    ordinaryEntries.filter((entry) => entry.region.kind !== 'equation'),
  )
  const strongRows = ordinaryRows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => row.anchors.length >= MIN_TABULAR_ROW_ANCHORS)
  if (strongRows.length < 2) return none

  const establishedColumns: Array<{
    anchor: number
    values: number[]
    rowIndexes: Set<number>
  }> = []
  for (const { row, rowIndex } of strongRows) {
    for (const anchor of row.anchors) {
      const column = establishedColumns
        .map((candidate) => ({
          candidate,
          distance: Math.abs(candidate.anchor - anchor),
        }))
        .filter(({ distance }) => distance <= COLUMN_ANCHOR_TOLERANCE)
        .sort(
          (left, right) =>
            left.distance - right.distance ||
            left.candidate.anchor - right.candidate.anchor,
        )[0]?.candidate
      if (column) {
        column.values.push(anchor)
        column.anchor = median(column.values)
        column.rowIndexes.add(rowIndex)
      } else {
        establishedColumns.push({
          anchor,
          values: [anchor],
          rowIndexes: new Set([rowIndex]),
        })
      }
    }
  }
  const provenColumns = establishedColumns.filter(
    (column) => column.rowIndexes.size >= 2,
  )
  if (provenColumns.length < MIN_TABULAR_ROW_ANCHORS) return none

  const qualified = pageRegions.flatMap((region) => {
    if (
      region.page !== caption.page ||
      region.id === caption.id ||
      region.kind !== 'equation' ||
      region.lines.length < 2 ||
      region.nativeObjectIds.length > 0 ||
      eligibleTableTextRegion(region) ||
      !validBox(region.box)
    ) {
      return []
    }
    const lines = region.lines.map((line) => {
      const entry = { region, line }
      const anchors = cellAnchors(line.runs)
      if (
        !validTableLineEntry(entry) ||
        !boxWithinLane(line.box, lane) ||
        !overlapsCaption(caption, line.box) ||
        anchors.length !== 1
      ) {
        return null
      }
      const rowIndex = matchingTableRowIndex(ordinaryRows, line)
      if (rowIndex === null) return null
      const anchor = anchors[0]
      const ordinaryAnchors = ordinaryRows[rowIndex].anchors
      if (
        !ordinaryAnchors.some(
          (candidate) => candidate < anchor - MIN_DENSE_CELL_GAP,
        ) ||
        !ordinaryAnchors.some(
          (candidate) => candidate > anchor + MIN_DENSE_CELL_GAP,
        )
      ) {
        return null
      }
      const columns = provenColumns
        .map((column, columnIndex) => ({
          columnIndex,
          anchor: column.anchor,
          distance: Math.abs(column.anchor - anchor),
        }))
        .filter((candidate) => candidate.distance <= COLUMN_ANCHOR_TOLERANCE)
        .sort(
          (left, right) =>
            left.distance - right.distance ||
            left.columnIndex - right.columnIndex,
        )
      if (columns.length !== 1) return null
      return {
        entry,
        rowIndex,
        columnIndex: columns[0].columnIndex,
        columnAnchor: rounded(columns[0].anchor),
      }
    })
    if (
      lines.some((line) => line === null) ||
      new Set(
        lines.map((line) =>
          line ? `${line.rowIndex}:${line.columnIndex}` : '',
        ),
      ).size !== lines.length
    ) {
      return []
    }
    return [
      {
        region,
        lines: lines as Array<NonNullable<(typeof lines)[number]>>,
      },
    ]
  })
  if (qualified.length === 0) return none

  const slotOwners = new Map<string, Set<string>>()
  for (const candidate of qualified) {
    for (const line of candidate.lines) {
      const slot = `${line.rowIndex}:${line.columnIndex}`
      const owners = slotOwners.get(slot) ?? new Set<string>()
      owners.add(candidate.region.id)
      slotOwners.set(slot, owners)
    }
  }
  if ([...slotOwners.values()].some((owners) => owners.size > 1)) {
    return { ...none, ambiguous: true }
  }
  const entries = qualified.flatMap((candidate) =>
    candidate.lines.map((line) => line.entry),
  )
  return {
    entries,
    ambiguous: false,
    regionIds: qualified.map((candidate) => candidate.region.id).sort(),
    lineIds: entries.map((entry) => entry.line.id).sort(),
    columnAnchors: [
      ...new Set(
        qualified.flatMap((candidate) =>
          candidate.lines.map((line) => line.columnAnchor),
        ),
      ),
    ].sort((left, right) => left - right),
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
        eligibleTableTextRegion(region) &&
        validBox(region.box) &&
        boxWithinLane(region.box, lane) &&
        overlapsCaption(caption, region.box) &&
        (!(
          caption.sourceCaptionLane ||
          caption.column === 'left' ||
          caption.column === 'right'
        ) ||
          region.lines.every((line) =>
            captionOwnsTableLine(caption, { region, line }),
          )),
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
      const atomicLineHeights = atomic.flatMap((region) =>
        region.lines.map((line) => line.box.height),
      )
      const containedMultilineRegions = eligible.filter(
        (region) =>
          !atomicIds.has(region.id) &&
          region.lines.length > 1 &&
          horizontalOverlap(atomicCrop, region.box) /
            Math.min(atomicCrop.width, region.box.width) >=
            MIN_ATOMIC_BAND_REGION_HORIZONTAL_COVERAGE &&
          region.lines.every(
            (line) =>
              line.box.y >= atomicCrop.y - BOX_TOLERANCE &&
              line.box.y + line.box.height <=
                atomicCrop.y + atomicCrop.height + BOX_TOLERANCE &&
              lineHeightMatchesBand(line, atomicLineHeights),
          ),
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

function closeProvenTableLineBand(
  caption: PdfPageRegion,
  lane: DirectionalLane,
  pageRegions: PdfPageRegion[],
  initiallySelected: TableLineEntry[],
) {
  const selected = new Map(
    initiallySelected.map((entry) => [tableLineEntryKey(entry), entry]),
  )
  const candidates = pageRegions
    .filter(
      (region) =>
        region.page === caption.page &&
        region.id !== caption.id &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        validBox(region.box),
    )
    .flatMap<TableLineEntry>((region) =>
      region.lines
        .map((line) => ({ region, line }))
        .filter(
          (entry) =>
            validTableLineEntry(entry) &&
            boxWithinLane(entry.line.box, lane) &&
            (!(
              caption.sourceCaptionLane ||
              caption.column === 'left' ||
              caption.column === 'right'
            ) ||
              captionOwnsTableLine(caption, entry)),
        ),
    )
  let changed = true
  while (changed) {
    changed = false
    const selectedEntries = [...selected.values()]
    const selectedBoxes = selectedEntries.map((entry) => entry.line.box)
    const cropBox = unionBoxes(
      selectedBoxes,
      selectedBoxes.some((sourceBox) => sourceBox.method === 'ocr')
        ? 'ocr'
        : 'pdf-text',
    )
    for (const candidate of candidates) {
      const key = tableLineEntryKey(candidate)
      if (selected.has(key)) continue
      const sameParentSourceRow = selectedEntries.some(
        (entry) =>
          entry.region.id === candidate.region.id &&
          Math.abs(entry.line.box.y - candidate.line.box.y) <= BOX_TOLERANCE,
      )
      const candidateCenterX =
        candidate.line.box.x + candidate.line.box.width / 2
      const candidateCenterY =
        candidate.line.box.y + candidate.line.box.height / 2
      const enclosedByCrop =
        candidateCenterX >= cropBox.x - BOX_TOLERANCE &&
        candidateCenterX <= cropBox.x + cropBox.width + BOX_TOLERANCE &&
        candidateCenterY >= cropBox.y - BOX_TOLERANCE &&
        candidateCenterY <= cropBox.y + cropBox.height + BOX_TOLERANCE &&
        horizontalOverlap(cropBox, candidate.line.box) /
          candidate.line.box.width >=
          0.5
      if (!sameParentSourceRow && !enclosedByCrop) continue
      selected.set(key, candidate)
      changed = true
    }
  }
  return [...selected.values()]
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
    const laneEntries = pageRegions
      .filter(
        (region) =>
          region.page === caption.page &&
          region.id !== caption.id &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          region.nativeObjectIds.length === 0 &&
          eligibleTableTextRegion(region) &&
          validBox(region.box),
      )
      .flatMap<TableLineEntry>((region) =>
        region.lines
          .map((line) => ({ region, line }))
          .filter(
            (entry) =>
              validTableLineEntry(entry) && boxWithinLane(entry.line.box, lane),
          ),
      )
    const captionEntries = laneEntries.filter((entry) =>
      overlapsCaption(caption, entry.line.box),
    )
    for (const captionRows of tableLineBands(tableLineRows(captionEntries))) {
      const recurringEntries = recurringCaptionBandEntries(
        captionRows,
        laneEntries,
      )
      const supplementalEquationCells = supplementalEquationCellShardEntries({
        caption,
        lane,
        pageRegions,
        ordinaryEntries: recurringEntries,
      })
      if (supplementalEquationCells.ambiguous) continue
      const scopedLaneEntries =
        supplementalEquationCells.entries.length > 0
          ? [...recurringEntries, ...supplementalEquationCells.entries]
          : laneEntries
      const bandTop = Math.min(...captionRows.map((row) => row.box.y))
      const bandBottom = Math.max(
        ...captionRows.map((row) => row.box.y + row.box.height),
      )
      const captionLineHeights = captionRows.flatMap((row) =>
        row.entries.map((entry) => entry.line.box.height),
      )
      // A centered caption can be substantially narrower than its source
      // table. First prove the vertically contiguous band from caption-
      // overlapping lines, then close only that already-proven vertical span
      // across the page. This recovers atomized left/right cells without
      // extending into adjacent prose rows or another caption lane.
      const boundedBandEntries = scopedLaneEntries.filter(
        (entry) =>
          entry.line.box.y >= bandTop - BOX_TOLERANCE &&
          entry.line.box.y + entry.line.box.height <=
            bandBottom + BOX_TOLERANCE &&
          lineHeightMatchesBand(entry.line, captionLineHeights),
      )
      const candidateRows = tableLineRows(
        captionOwnedTableEntries(
          caption,
          captionRows,
          boundedBandEntries,
          supplementalEquationCells.entries,
        ),
      )
      // Re-evaluate the page gutter after collecting the full vertical band.
      // The caption-overlapping seed may contain only one column and therefore
      // cannot prove a gutter by itself. Once the complete band proves two
      // lanes, retain only the lane containing every exact seed entry. This
      // prevents an adjacent figure or prose column at the same y coordinates
      // from becoming table source while preserving full-width tables when no
      // source-backed gutter exists.
      const rows = captionOwnedTableRows(captionRows, candidateRows)
      if (!rows) continue
      const proof = tabularLineBandProof(rows)
      if (!proof) continue
      const selectedEntries = closeProvenTableLineBand(
        caption,
        lane,
        pageRegions,
        rows.flatMap((row) => row.entries),
      )
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
        horizontalOverlap(caption.box, cropBox) /
          Math.min(caption.box.width, cropBox.width) <
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
            lineIds: [...sourceLineIds],
          },
          {
            code: 'multi-run-tabular-line-band',
            ...proof,
            lineIds: [...sourceLineIds],
          },
          ...(supplementalEquationCells.entries.length > 0
            ? ([
                {
                  code: 'supplemental-equation-cell-shard',
                  regionIds: supplementalEquationCells.regionIds,
                  lineIds: supplementalEquationCells.lineIds,
                  columnAnchors: supplementalEquationCells.columnAnchors,
                },
              ] satisfies PdfTableScopeEvidence[])
            : []),
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
  const candidates: PdfTableScope[] = []
  for (const lane of [
    completeAboveCaptionLane(caption, pageRegions),
    completeBelowCaptionLane(caption, pageRegions),
  ]) {
    if (
      existingTextCandidates.some(
        (candidate) => candidate.direction === lane.direction,
      )
    ) {
      continue
    }
    const entries = pageRegions
      .filter(
        (region) =>
          region.page === caption.page &&
          region.id !== caption.id &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          region.nativeObjectIds.length === 0 &&
          eligibleTableTextRegion(region) &&
          validBox(region.box) &&
          horizontalOverlap(caption.box, region.box) > BOX_TOLERANCE,
      )
      .flatMap<TableLineEntry>((region) =>
        region.lines
          .map((line) => ({ region, line }))
          .filter(
            (entry) =>
              validTableLineEntry(entry) &&
              boxWithinLane(entry.line.box, lane) &&
              (lane.direction === 'above' ||
                captionOwnsTextSlabLine(caption, entry)),
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
        gapBetween(candidate.box, current.box).vertical >
          MAX_TEXT_SLAB_ROW_GAP ||
        (lane.direction === 'below' &&
          (!rowHeightMatchesBand(candidate, selectedRows) ||
            !weakSlabTypographyBoundaryMatches(candidate, selectedRows, false)))
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
    const wideLayout = cropBox.width + BOX_TOLERANCE >= MIN_WIDE_TEXT_SLAB_WIDTH
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
    const labeledRowCount = selectedRows.filter((row) =>
      row.entries.some((entry) => labeledRecordLine(entry.line)),
    ).length
    const sourceStartHeading = selectedRows[0].entries.some((entry) => {
      const firstRun = entry.line.runs.find((run) => run.text.trim())
      return Boolean(firstRun && explicitTableStyle(firstRun))
    })
    const singleAnchorSlab =
      singleAnchorRowCount / selectedRows.length >=
      MIN_TEXT_SLAB_SINGLE_ANCHOR_RATIO
    const structuredSingleAnchorSlab =
      singleAnchorSlab &&
      (compressedTypography ||
        sourceStartHeading ||
        labeledRowCount >= MIN_LABELED_RECORD_ROWS)
    const tabularSlab =
      tabularRowCount >= MIN_TABULAR_SLAB_ROWS &&
      repeatedAnchorCount >= MIN_REPEATED_TABULAR_SLAB_ANCHORS
    const compactTabularSlab = compactTabularSlabMayFollowCaption({
      tabularSlab,
      cropWidth: cropBox.width,
    })
    const labeledRecordSlab =
      lane.direction === 'below' &&
      cropBox.width >= MIN_LABELED_RECORD_WIDTH &&
      labeledRowCount >= MIN_LABELED_RECORD_ROWS
    if (
      cropBox.width < MIN_TEXT_SLAB_WIDTH ||
      cropBox.height < MIN_TEXT_SLAB_HEIGHT ||
      cropBox.width * cropBox.height > MAX_SCOPE_AREA ||
      horizontalOverlap(caption.box, cropBox) <= BOX_TOLERANCE ||
      (!structuredSingleAnchorSlab && !tabularSlab && !labeledRecordSlab) ||
      (!wideLayout &&
        !compressedTypography &&
        !labeledRecordSlab &&
        !compactTabularSlab) ||
      (lane.direction === 'below' && !labeledRecordSlab && !compactTabularSlab)
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
        ...(structuredSingleAnchorSlab
          ? ([
              {
                code: 'contiguous-single-anchor-slab',
                rowCount: selectedRows.length,
                lineIds: [...sourceLineIds],
                singleAnchorRowCount,
                wideLayout,
                compressedTypography,
                sourceStartHeading,
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
        ...(labeledRecordSlab
          ? ([
              {
                code: 'repeated-labeled-record-rows',
                rowCount: selectedRows.length,
                lineIds: [...sourceLineIds],
                labeledRowCount,
              },
            ] satisfies PdfTableScopeEvidence[])
          : []),
      ],
    })
  }
  return candidates
}

const MONOSPACED_TABLE_SOURCE_FONT =
  /(?:mono|code|courier|inconsolata|sourcecode|typewriter|cmtt|lmtt|nimbusmon)/iu

function monospacedTableLine(line: PdfRegionLine) {
  const runs = line.runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 &&
    runs.every((run) => MONOSPACED_TABLE_SOURCE_FONT.test(run.fontName))
  )
}

function proportionalTableLine(line: PdfRegionLine) {
  const runs = line.runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 &&
    runs.every((run) => !MONOSPACED_TABLE_SOURCE_FONT.test(run.fontName))
  )
}

function proportionalTextScope(
  scope: PdfTableScope,
  pageRegions: PdfPageRegion[],
) {
  const regionsById = new Map(pageRegions.map((region) => [region.id, region]))
  const lines = scopeLineEntries(scope, regionsById).map((entry) => entry.line)
  return lines.length > 0 && lines.every(proportionalTableLine)
}

function alignedSingleColumnPromptRows(rows: TableLineRow[]) {
  if (rows.length === 0 || rows.some((row) => row.anchors.length !== 1)) {
    return false
  }
  const anchors = rows.map((row) => row.anchors[0])
  return Math.max(...anchors) - Math.min(...anchors) <= COLUMN_ANCHOR_TOLERANCE
}

function structuredPromptRecord(line: PdfRegionLine) {
  return /^(?:(?:question|context|premise|setting|characters?|outline|generated(?:\s+(?:story|outline))?|extract\s+attributes|attribute|input|output)\s*:|(?:\d{1,2}[.)]\s+\S)|(?:[-—]{2,}))\s*/iu.test(
    line.text.trim(),
  )
}

/**
 * Prompt-example tables often preserve source-authored paragraph spacing
 * inside a compressed monospaced panel. Those gaps are intentionally wider
 * than a numeric grid, so require the exact caption lane plus multiple
 * prompt-record markers before accepting the complete line scope.
 */
function captionBoundedPromptSlabCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  existingTextCandidates: PdfTableScope[],
) {
  if (!/\bprompt\b/iu.test(caption.text)) return []
  const candidates: PdfTableScope[] = []
  const lane = completeAboveCaptionLane(caption, pageRegions)
  if (
    existingTextCandidates.some(
      (candidate) => candidate.direction === lane.direction,
    )
  ) {
    return candidates
  }
  const entries = pageRegions
    .filter(
      (region) =>
        region.page === caption.page &&
        region.id !== caption.id &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        region.nativeObjectIds.length === 0 &&
        eligibleTableTextRegion(region) &&
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
  const nearest = rows.at(-1)
  if (
    !nearest ||
    captionGap(caption, nearest.box, 'above') >
      MAX_PROMPT_SLAB_CAPTION_GAP + BOX_TOLERANCE
  ) {
    return candidates
  }
  const selectedRows = [nearest]
  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const candidate = rows[index]
    const current = selectedRows[0]
    if (
      gapBetween(candidate.box, current.box).vertical >
      MAX_PROMPT_SLAB_ROW_GAP + BOX_TOLERANCE
    ) {
      break
    }
    selectedRows.unshift(candidate)
  }
  const monospacedRowCount = selectedRows.filter((row) =>
    row.entries.every((entry) => monospacedTableLine(entry.line)),
  ).length
  const proportionalRowCount = selectedRows.filter((row) =>
    row.entries.every((entry) => proportionalTableLine(entry.line)),
  ).length
  const structuredRecordCount = selectedRows.filter((row) =>
    row.entries.some((entry) => structuredPromptRecord(entry.line)),
  ).length
  const selectedEntries = selectedRows.flatMap((row) => row.entries)
  const selectedLineBoxes = selectedEntries.map((entry) => entry.line.box)
  const cropBox = unionBoxes(
    selectedLineBoxes,
    selectedLineBoxes.some((sourceBox) => sourceBox.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  )
  const siblingCaption = lane.interveningCaptionRegionId
    ? pageRegions.find(
        (region) => region.id === lane.interveningCaptionRegionId,
      )
    : null
  const exactSiblingCaptionBounds = Boolean(
    siblingCaption && isTableCaption(siblingCaption),
  )
  const proportionalPromptSlab =
    proportionalRowCount === selectedRows.length &&
    exactSiblingCaptionBounds &&
    alignedSingleColumnPromptRows(selectedRows)
  const selectedLineKeys = new Set(selectedEntries.map(tableLineEntryKey))
  const unownedFlowWithinLane = proportionalPromptSlab
    ? pageRegions.some(
        (region) =>
          region.page === caption.page &&
          region.kind !== 'caption' &&
          region.includedInReadingOrder &&
          region.text.trim().length > 0 &&
          region.lines.some((line) => {
            const entry = { region, line }
            if (
              selectedLineKeys.has(tableLineEntryKey(entry)) ||
              !validTableLineEntry(entry) ||
              !boxWithinLane(line.box, lane) ||
              !captionOwnsTableLine(caption, entry)
            ) {
              return false
            }
            const lineCenter = line.box.x + line.box.width / 2
            return (
              horizontalOverlap(cropBox, line.box) > BOX_TOLERANCE ||
              (lineCenter >= cropBox.x - BOX_TOLERANCE &&
                lineCenter <= cropBox.x + cropBox.width + BOX_TOLERANCE)
            )
          }),
      )
    : false
  if (
    selectedRows.length < MIN_PROMPT_SLAB_ROWS ||
    (monospacedRowCount !== selectedRows.length && !proportionalPromptSlab) ||
    structuredRecordCount < MIN_PROMPT_STRUCTURED_RECORDS ||
    unownedFlowWithinLane
  ) {
    return candidates
  }
  if (
    cropBox.width < MIN_TEXT_SLAB_WIDTH ||
    cropBox.height < MIN_TEXT_SLAB_HEIGHT ||
    cropBox.width * cropBox.height > MAX_SCOPE_AREA ||
    horizontalOverlap(caption.box, cropBox) <= BOX_TOLERANCE
  ) {
    return candidates
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
    direction: 'above',
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
        code: 'caption-bounded-prompt-slab',
        rowCount: selectedRows.length,
        lineIds: [...sourceLineIds],
        monospacedRowCount,
        structuredRecordCount,
      },
    ],
  })
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

function interveningSourceTextRegionIds(
  caption: PdfPageRegion,
  sourceBox: NormalizedSourceBox,
  pageRegions: PdfPageRegion[],
) {
  const captionBottom = caption.box.y + caption.box.height
  const sourceBottom = sourceBox.y + sourceBox.height
  const gap =
    sourceBox.y >= captionBottom - BOX_TOLERANCE
      ? { top: captionBottom, bottom: sourceBox.y }
      : caption.box.y >= sourceBottom - BOX_TOLERANCE
        ? { top: sourceBottom, bottom: caption.box.y }
        : null
  if (!gap || gap.bottom - gap.top <= BOX_TOLERANCE) return []

  return pageRegions
    .filter(
      (region) =>
        region.id !== caption.id &&
        region.page === caption.page &&
        region.text.trim().length > 0 &&
        region.lines.some(
          (line) =>
            validBox(line.box) &&
            line.box.page === sourceBox.page &&
            line.box.y >= gap.top - BOX_TOLERANCE &&
            line.box.y + line.box.height <= gap.bottom + BOX_TOLERANCE &&
            horizontalOverlap(line.box, sourceBox) > BOX_TOLERANCE,
        ),
    )
    .map((region) => region.id)
    .sort()
}

function rasterCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  nativeObjects: PdfNativeObject[],
  lanes: DirectionalLane[],
) {
  const candidates: PdfTableScope[] = []
  const duplicateObjectIds = new Set<string>()
  const interveningTextRegionIds = new Set<string>()
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
      const separatingRegionIds = interveningSourceTextRegionIds(
        caption,
        object.box,
        pageRegions,
      )
      if (separatingRegionIds.length > 0) {
        for (const regionId of separatingRegionIds) {
          interveningTextRegionIds.add(regionId)
        }
        continue
      }
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
  return { candidates, duplicateObjectIds, interveningTextRegionIds }
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

function sourceFallbackStructuredPromptLine(line: PdfRegionLine) {
  return /^(?:#{1,6}\s|[-*]\s|\d{1,3}[.)]\s|\{[^}]+\}|(?:you|return|output|response|action|world|role|environment)\b)/iu.test(
    line.text.trim(),
  )
}

function sourceFallbackNumericLine(line: PdfRegionLine) {
  const text = line.text.trim()
  const numericTokens = text.match(/[-+]?\d+(?:[.,]\d+)?%?/gu) ?? []
  const lexicalTokens = text.match(/\p{L}{2,}/gu) ?? []
  return (
    numericTokens.length >= 2 && numericTokens.length >= lexicalTokens.length
  )
}

function sourceFallbackTableScore(rows: TableLineRow[]) {
  const entries = rows.flatMap((row) => row.entries)
  const lines = entries.map((entry) => entry.line)
  const multiAnchorRows = rows.filter(
    (row) => row.anchors.length >= MIN_TABULAR_ROW_ANCHORS,
  ).length
  const numericRows = lines.filter(sourceFallbackNumericLine).length
  const structuredPromptRows = lines.filter(
    sourceFallbackStructuredPromptLine,
  ).length
  const chartLabelRows = entries.filter((entry) =>
    ['chart-label', 'side'].includes(entry.region.kind),
  ).length
  const wideRows = rows.filter((row) => row.box.width >= 0.5).length
  return (
    multiAnchorRows * 4 +
    numericRows +
    structuredPromptRows * 2 +
    Math.min(chartLabelRows, 4) +
    (rows.length >= 5 ? 2 : 0) +
    (wideRows >= 5 ? 2 : 0)
  )
}

function sourceFallbackStructuralRow(row: TableLineRow) {
  return (
    row.anchors.length >= 2 ||
    row.entries.some((entry) =>
      ['chart-label', 'side'].includes(entry.region.kind),
    ) ||
    row.entries.some((entry) => sourceFallbackNumericLine(entry.line))
  )
}

function sourceFallbackTableLikeRows(rows: TableLineRow[]) {
  const structural = rows.map(sourceFallbackStructuralRow)
  return rows.map(
    (row, index) =>
      structural[index] ||
      (row.anchors.length === 1 &&
        structural[index - 1] === true &&
        structural[index + 1] === true),
  )
}

/**
 * Find the nearest deterministic source envelope when semantic table proof
 * fails. This deliberately accepts mixed text shapes (atomized chart labels,
 * compact numeric rows, and prompt-like blocks), but it never promotes the
 * result to a semantic table. The envelope is retained only as a readable
 * source-artwork fallback and is ranked by source geometry/text signals.
 */
function sourcePreservedFallbackTableCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
) {
  const ranked: Array<{ score: number; scope: PdfTableScope }> = []
  const promptLikeCaption = /\bprompt\b/iu.test(caption.text)
  const lanes = [
    completeAboveCaptionLane(caption, pageRegions),
    completeBelowCaptionLane(caption, pageRegions),
  ]
  for (const lane of lanes) {
    const excludedVisualTextLineCount = pageRegions
      .filter(
        (region) =>
          region.page === caption.page &&
          ['chart-label', 'side'].includes(region.kind) &&
          region.includedInReadingOrder === false,
      )
      .reduce((total, region) => total + region.lines.length, 0)
    const entries = pageRegions
      .filter(
        (region) =>
          region.id !== caption.id &&
          region.page === caption.page &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          region.nativeObjectIds.length === 0 &&
          eligibleTableTextRegion(region) &&
          region.kind !== 'header' &&
          region.kind !== 'footer' &&
          (region.includedInReadingOrder !== false ||
            (excludedVisualTextLineCount >= 5 &&
              ['chart-label', 'side'].includes(region.kind))) &&
          validBox(region.box),
      )
      .flatMap<TableLineEntry>((region) =>
        region.lines
          .map((line) => ({ region, line }))
          .filter(
            (entry) =>
              validTableLineEntry(entry) &&
              boxWithinLane(entry.line.box, lane) &&
              captionOwnsTextSlabLine(caption, entry),
          ),
      )
    const rows = tableLineRows(entries)
    if (rows.length === 0) continue
    const rowLanes = [
      ...new Set(rows.map((row) => row.lane)),
    ] as TableColumnLane[]
    for (const rowLane of rowLanes) {
      const laneRows = rows
        .filter((row) => row.lane === rowLane)
        .sort((left, right) => left.y - right.y)
      const tableLikeRows = sourceFallbackTableLikeRows(laneRows)
      if (laneRows.length === 0) continue
      const distanceFromCaption = (row: TableLineRow) =>
        lane.direction === 'above'
          ? caption.box.y - (row.box.y + row.box.height)
          : row.box.y - (caption.box.y + caption.box.height)
      const nearestIndex = laneRows.reduce(
        (best, row, index) =>
          Math.max(distanceFromCaption(row), 0) <
          Math.max(distanceFromCaption(laneRows[best]), 0)
            ? index
            : best,
        0,
      )
      if (
        distanceFromCaption(laneRows[nearestIndex]) >
        MAX_SOURCE_FALLBACK_CAPTION_GAP
      ) {
        continue
      }
      if (!promptLikeCaption && !tableLikeRows[nearestIndex]) {
        continue
      }
      const selectedRows = [laneRows[nearestIndex]]
      for (let index = nearestIndex - 1; index >= 0; index -= 1) {
        const current = selectedRows[0]
        if (!promptLikeCaption && !tableLikeRows[index]) {
          break
        }
        if (
          gapBetween(laneRows[index].box, current.box).vertical >
          MAX_SOURCE_FALLBACK_ROW_GAP
        ) {
          break
        }
        selectedRows.unshift(laneRows[index])
      }
      for (let index = nearestIndex + 1; index < laneRows.length; index += 1) {
        const current = selectedRows.at(-1)!
        if (!promptLikeCaption && !tableLikeRows[index]) {
          break
        }
        if (
          gapBetween(current.box, laneRows[index].box).vertical >
          MAX_SOURCE_FALLBACK_ROW_GAP
        ) {
          break
        }
        selectedRows.push(laneRows[index])
      }
      const score = sourceFallbackTableScore(selectedRows)
      if (score < MIN_SOURCE_FALLBACK_SCORE) continue
      const selectedEntries = selectedRows.flatMap((row) => row.entries)
      const selectedLineBoxes = selectedEntries.map((entry) => entry.line.box)
      const cropBox = unionBoxes(
        selectedLineBoxes,
        selectedLineBoxes.some((sourceBox) => sourceBox.method === 'ocr')
          ? 'ocr'
          : 'pdf-text',
      )
      if (
        cropBox.width < MIN_TEXT_SLAB_WIDTH * 0.45 ||
        cropBox.height < MIN_TEXT_SLAB_HEIGHT * 0.3 ||
        cropBox.width * cropBox.height > MAX_SCOPE_AREA ||
        horizontalOverlap(caption.box, cropBox) <= BOX_TOLERANCE
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
      const selectedRegions = [...regionsById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      )
      const {
        regionLineage,
        lineLineage,
        sourceRegionIds,
        sourceLineIds,
        sourceLineBoxes,
      } = selectedTextLineage(selectedRegions, selectedLineIdsByRegion)
      const scope: PdfTableScope = {
        id: scopeId(
          'caption-bounded-text-slab',
          sourceRegionIds,
          lineLineage,
          [],
          cropBox,
        ),
        proof: 'caption-bounded-text-slab',
        fallback: 'source-preserved',
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
            code: 'contiguous-single-anchor-slab',
            rowCount: selectedRows.length,
            lineIds: [...sourceLineIds],
            singleAnchorRowCount: selectedRows.filter(
              (row) => row.anchors.length === 1,
            ).length,
            wideLayout: cropBox.width >= MIN_WIDE_TEXT_SLAB_WIDTH,
            compressedTypography: false,
            sourceStartHeading: false,
          },
        ],
      }
      ranked.push({ score, scope })
    }
  }
  const unique = new Map<string, { score: number; scope: PdfTableScope }>()
  for (const candidate of ranked) {
    const existing = unique.get(candidate.scope.id)
    if (!existing || candidate.score > existing.score) {
      unique.set(candidate.scope.id, candidate)
    }
  }
  const best = [...unique.values()].sort(
    (left, right) =>
      right.score - left.score || left.scope.id.localeCompare(right.scope.id),
  )[0]
  return best ? [best.scope] : []
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

function unprovenPageTopTableStart(
  scope: PdfTableScope,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
) {
  if (
    scope.proof !== 'caption-bounded-text-slab' ||
    scope.direction !== 'above' ||
    scope.cropBox.y > MAX_UNPROVEN_PAGE_TOP_TABLE_START + BOX_TOLERANCE ||
    scope.evidence.some(
      (evidence) => evidence.code === 'caption-bounded-prompt-slab',
    ) ||
    !scope.evidence.some(
      (evidence) => evidence.code === 'contiguous-single-anchor-slab',
    )
  ) {
    return false
  }
  const firstLineage = [...scope.lineLineage].sort(
    (left, right) =>
      compareBoxes(left.box, right.box) ||
      left.regionId.localeCompare(right.regionId) ||
      left.lineId.localeCompare(right.lineId),
  )[0]
  const firstLine = firstLineage
    ? regionsById
        .get(firstLineage.regionId)
        ?.lines.find((line) => line.id === firstLineage.lineId)
    : null
  const firstRun = firstLine?.runs.find((run) => run.text.trim())
  // A compressed prose slab touching the page's content origin can be the
  // terminal page of a source object. Ordinary body typography does not prove
  // that the object begins here; a source-authored heading does.
  return !firstRun || !explicitTableStyle(firstRun)
}

function siblingTableCaptionLanesCrossed(
  scope: PdfTableScope,
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
) {
  if (scope.direction !== 'above') return []
  return pageRegions
    .filter((candidate) => {
      if (
        candidate.id === caption.id ||
        candidate.page !== caption.page ||
        !isTableCaption(candidate) ||
        !validBox(candidate.box)
      ) {
        return false
      }
      const captionOverlap = horizontalOverlap(caption.box, candidate.box)
      if (captionOverlap > BOX_TOLERANCE) return false
      const targetCoverage =
        horizontalOverlap(scope.cropBox, caption.box) / caption.box.width
      const siblingCoverage =
        horizontalOverlap(scope.cropBox, candidate.box) / candidate.box.width
      return (
        targetCoverage >= MIN_CAPTION_HORIZONTAL_COVERAGE &&
        siblingCoverage >= MIN_CAPTION_HORIZONTAL_COVERAGE &&
        scope.cropBox.y <=
          candidate.box.y + candidate.box.height + BOX_TOLERANCE
      )
    })
    .map((candidate) => candidate.id)
    .sort()
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

function unscopedAdjacentTableHeaderLineIds(
  scope: PdfTableScope,
  pageRegions: PdfPageRegion[],
) {
  if (scope.direction !== 'above') return []
  const selectedLineIds = new Set(scope.sourceLineIds)
  return pageRegions
    .filter(
      (region) =>
        region.page === scope.page &&
        !scope.sourceRegionIds.includes(region.id) &&
        ['body', 'equation', 'header', 'spanning'].includes(region.kind),
    )
    .flatMap((region) =>
      region.lines.filter((line) => {
        if (
          selectedLineIds.has(line.id) ||
          !validTableLineEntry({ region, line })
        ) {
          return false
        }
        const gap = scope.cropBox.y - (line.box.y + line.box.height)
        const overlap = horizontalOverlap(scope.cropBox, line.box)
        const headerStyled =
          region.kind === 'equation' ||
          region.kind === 'header' ||
          line.runs.every(explicitTableStyle)
        return (
          gap >= -BOX_TOLERANCE &&
          gap <= MAX_LINE_BAND_CAPTION_GAP &&
          overlap / Math.min(scope.cropBox.width, line.box.width) >= 0.5 &&
          cellAnchors(line.runs).length >= MIN_TABULAR_ROW_ANCHORS &&
          headerStyled
        )
      }),
    )
    .map((line) => line.id)
    .sort()
}

/**
 * Resolves only an exact, caption-bounded source scope for a PDF table.
 *
 * A matched native scope is not a claim that its pixels form a semantic cell
 * grid. Semantic table validation intentionally remains a separate operation.
 */
export function resolvePdfTableScope({
  caption: inputCaption,
  pageRegions,
  nativeObjects,
}: {
  caption: PdfPageRegion
  pageRegions: PdfPageRegion[]
  nativeObjects: PdfNativeObject[]
}): PdfTableScopeResolution {
  if (!isTableCaption(inputCaption) || !validBox(inputCaption.box)) {
    return unresolved(
      inputCaption,
      'invalid-caption',
      [],
      ['table-caption-region-required'],
    )
  }
  const localCaptionLane = inferredLocalCaptionLane(inputCaption, pageRegions)
  const caption = localCaptionLane
    ? { ...inputCaption, sourceCaptionLane: localCaptionLane }
    : inputCaption
  const regions = [...pageRegions].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const objects = [...nativeObjects].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const lanes = directionalLanes(caption, regions)
  const extendedAboveTabularLane = extendedNumericAboveTableLane(
    caption,
    regions,
    lanes,
  )
  const extendedBelowTabularLane = extendedRepeatedBelowTableLane(
    caption,
    regions,
    lanes,
  )
  const extendedTabularLanes = [
    extendedAboveTabularLane,
    extendedBelowTabularLane,
  ]
  const provenExtendedLineIds = new Set(
    extendedTabularLanes.flatMap((decision) => decision.provenLineIds),
  )
  const textGrids = textGridCandidates(caption, regions, lanes).filter(
    (candidate) => {
      const extended = extendedTabularLanes.find(
        (decision) => decision.lane?.direction === candidate.direction,
      )
      return (
        !extended?.lane ||
        !candidate.sourceLineIds.some((lineId) =>
          provenExtendedLineIds.has(lineId),
        )
      )
    },
  )
  const tabularLanes = lanes.map(
    (lane) =>
      extendedTabularLanes.find(
        (decision) => decision.lane?.direction === lane.direction,
      )?.lane ?? lane,
  )
  const tabularLineBands = tabularLineBandCandidates(
    caption,
    regions,
    tabularLanes,
    textGrids,
  )
  const textSlabs = captionBoundedTextSlabCandidates(caption, regions, [
    ...textGrids,
    ...tabularLineBands,
  ])
  const exactAboveLane = completeAboveCaptionLane(caption, regions)
  const exactPreviousTableCaption = exactAboveLane.interveningCaptionRegionId
    ? regions.find(
        (region) => region.id === exactAboveLane.interveningCaptionRegionId,
      )
    : null
  const constrainedTextSlabs =
    /\bprompt\b/iu.test(caption.text) &&
    exactPreviousTableCaption &&
    isTableCaption(exactPreviousTableCaption)
      ? textSlabs.filter(
          (candidate) =>
            candidate.direction !== 'above' ||
            !proportionalTextScope(candidate, regions),
        )
      : textSlabs
  const promptSlabs = captionBoundedPromptSlabCandidates(caption, regions, [
    ...textGrids,
    ...tabularLineBands,
    ...constrainedTextSlabs,
  ])
  const raster = rasterCandidates(caption, regions, objects, lanes)
  const ruled = ruledCandidates(caption, regions, objects, lanes)
  const uniqueGridOverUnprovenRasters =
    textGrids.length === 1 &&
    tabularLineBands.length === 0 &&
    textSlabs.length === 0 &&
    ruled.candidates.length === 0 &&
    raster.candidates.length > 0
  const rawCandidates = (
    uniqueGridOverUnprovenRasters
      ? [textGrids[0]]
      : [
          ...textGrids,
          ...tabularLineBands,
          ...constrainedTextSlabs,
          ...promptSlabs,
          ...raster.candidates,
          ...ruled.candidates,
        ]
  ).sort((left, right) => left.id.localeCompare(right.id))
  const candidates = completeCaptionLaneTextCandidates(
    caption,
    regions,
    rawCandidates,
  ).sort((left, right) => left.id.localeCompare(right.id))
  const regionsById = new Map(regions.map((region) => [region.id, region]))
  const captionOwnedCandidates = candidates.filter(
    (candidate) =>
      !belongsToFollowingNumberedCaption(candidate, caption, regions),
  )
  const incompleteHeaderLineIds = [
    ...new Set(
      captionOwnedCandidates.flatMap((candidate) =>
        unscopedAdjacentTableHeaderLineIds(candidate, regions),
      ),
    ),
  ].sort()
  const headerCompleteCandidates = captionOwnedCandidates.filter(
    (candidate) =>
      unscopedAdjacentTableHeaderLineIds(candidate, regions).length === 0,
  )
  const crossedSiblingCaptionIds = [
    ...new Set(
      headerCompleteCandidates.flatMap((candidate) =>
        siblingTableCaptionLanesCrossed(candidate, caption, regions),
      ),
    ),
  ].sort()
  const captionDistanceTruncatesCandidate = (candidate: PdfTableScope) => {
    const extended = extendedTabularLanes.find(
      (decision) =>
        decision.truncatedAtCaptionDistance &&
        !decision.lane &&
        candidate.direction ===
          (decision === extendedAboveTabularLane ? 'above' : 'below'),
    )
    if (!extended) return false
    const truncatedLineIds = new Set(extended.crossingLineIds)
    return candidate.sourceLineIds.some((lineId) =>
      truncatedLineIds.has(lineId),
    )
  }
  const unprovenStartCandidates = headerCompleteCandidates.filter(
    (candidate) =>
      unprovenPageTopTableStart(candidate, regionsById) ||
      captionDistanceTruncatesCandidate(candidate),
  )
  const sourceCompleteCandidates = headerCompleteCandidates.filter(
    (candidate) =>
      siblingTableCaptionLanesCrossed(candidate, caption, regions).length ===
        0 &&
      !unprovenPageTopTableStart(candidate, regionsById) &&
      !captionDistanceTruncatesCandidate(candidate),
  )
  const nonProseCandidates = sourceCompleteCandidates.filter(
    (candidate) => !orderedProseScope(candidate, regionsById),
  )
  const resolvedCandidates =
    sourceCompleteCandidates.length > 1 && nonProseCandidates.length === 1
      ? nonProseCandidates
      : sourceCompleteCandidates
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
    const interveningTextRegionIds = [...raster.interveningTextRegionIds].sort()
    if (interveningTextRegionIds.length > 0) {
      evidence.push('intervening-source-text', ...interveningTextRegionIds)
    }
    if (incompleteHeaderLineIds.length > 0) {
      evidence.push(
        'table-header-outside-source-scope',
        'incomplete-table-header-scope',
        ...incompleteHeaderLineIds,
      )
    }
    if (crossedSiblingCaptionIds.length > 0) {
      evidence.push(
        'table-scope-crosses-sibling-caption-lane',
        ...crossedSiblingCaptionIds,
      )
    }
    if (unprovenStartCandidates.length > 0) {
      evidence.push('table-source-start-boundary-unproven')
    }
    const result = unresolved(caption, 'no-proven-scope', [], evidence)
    const fallbackCandidates = sourcePreservedFallbackTableCandidates(
      caption,
      regions,
    )
    return fallbackCandidates.length > 0
      ? { ...result, fallbackCandidates }
      : result
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
