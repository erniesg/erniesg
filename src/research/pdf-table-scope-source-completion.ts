import type { NormalizedSourceBox, PdfPageRegion } from './import-types'
import {
  BOX_TOLERANCE,
  MAX_ATOMIC_ROW_GAP,
  MIN_GRID_COLUMNS,
  MIN_TABULAR_ROW_ANCHORS,
  boxKey,
  boxWithinLane,
  compareBoxes,
  completeAboveCaptionLane,
  completeBelowCaptionLane,
  eligibleTableTextRegion,
  explicitTableStyle,
  gapBetween,
  horizontalOverlap,
  labeledRecordLine,
  median,
  rounded,
  unionBoxes,
  uniqueBoxes,
  validBox,
  type DirectionalLane,
} from './pdf-table-scope-grid'
import {
  MAX_LINE_BAND_CAPTION_GAP,
  MAX_TEXT_SLAB_CAPTION_GAP,
  captionOwnsTableLine,
  dominantCandidateColumnGutter,
  explicitTableHeaderRow,
  normalizedTableFontName,
  rowHeightMatchesBand,
  sourceCaptionLaneOwnsBox,
  tableLineEntryKey,
  tableLineRows,
  validTableLineEntry,
  weakSlabTypographyBoundaryMatches,
  type TableLineEntry,
  type TableLineRow,
} from './pdf-table-scope-line-bands'
import type {
  PdfTableLineLineage,
  PdfTableRegionLineage,
  PdfTableScope,
  PdfTableScopeEvidence,
  PdfTableScopeProof,
} from './pdf-table-scope'

export const MAX_SCOPE_AREA = 0.72

const TABLE_BORDER_INK_PADDING = 0.004

export function scopeId(
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

export function selectedTextLineage(
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

type CaptionLaneSourceCompletion = {
  scope: PdfTableScope
  additions: TableLineEntry[]
  headerLineIds: string[]
  rowFragmentLineIds: string[]
  captionAdjacentLineIds: string[]
  unsafe: boolean
}

function textBackedTableScope(scope: PdfTableScope) {
  return (
    scope.proof === 'text-grid' ||
    scope.proof === 'text-nonuniform-grid' ||
    scope.proof === 'text-tabular-line-band' ||
    scope.proof === 'caption-bounded-text-slab'
  )
}

export function scopeLineEntries(
  scope: PdfTableScope,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
) {
  return scope.lineLineage.flatMap<TableLineEntry>((lineage) => {
    const region = regionsById.get(lineage.regionId)
    const line = region?.lines.find(
      (candidate) => candidate.id === lineage.lineId,
    )
    return region && line ? [{ region, line }] : []
  })
}

export function inferredLocalCaptionLane(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
) {
  if (
    caption.sourceCaptionLane ||
    !['single', 'span'].includes(caption.column)
  ) {
    return null
  }
  const regionOwnsPageLane = (
    region: PdfPageRegion,
    column: 'left' | 'right',
  ) =>
    region.id !== caption.id &&
    region.page === caption.page &&
    region.column === column &&
    region.lines.length > 0 &&
    validBox(region.box)
  const leftEdges = pageRegions
    .filter((region) => regionOwnsPageLane(region, 'left'))
    .map((region) => region.box.x + region.box.width)
  const rightEdges = pageRegions
    .filter((region) => regionOwnsPageLane(region, 'right'))
    .map((region) => region.box.x)
  const exactBoundary =
    leftEdges.length > 0 && rightEdges.length > 0
      ? {
          left: Math.max(...leftEdges),
          right: Math.min(...rightEdges),
        }
      : null
  const exactProvesGutter =
    exactBoundary !== null &&
    exactBoundary.left <= exactBoundary.right + BOX_TOLERANCE
  const captionLaneAtBoundary = (boundary: number) => {
    const captionLeft = caption.box.x
    const captionRight = caption.box.x + caption.box.width
    if (captionRight <= boundary + BOX_TOLERANCE) {
      return { boundary, side: 'left' as const }
    }
    if (captionLeft >= boundary - BOX_TOLERANCE) {
      return { boundary, side: 'right' as const }
    }
    return null
  }
  const exactLane = exactProvesGutter
    ? captionLaneAtBoundary(
        rounded((exactBoundary!.left + exactBoundary!.right) / 2),
      )
    : null
  if (exactLane) return exactLane

  // Region extrema can prove an internal table-column gap instead of the page
  // gutter when the first table column inherits the neighbouring prose
  // column's label. If that boundary cuts through the caption, fall back to
  // exact source-line corridors. Page furniture is not content geometry and
  // cannot witness a scholarly caption lane.
  const directionalGutterCenters = [
    completeAboveCaptionLane(caption, pageRegions),
    completeBelowCaptionLane(caption, pageRegions),
  ].flatMap((lane) => {
    const entries = pageRegions
      .filter(
        (region) =>
          region.id !== caption.id &&
          region.page === caption.page &&
          region.kind !== 'caption' &&
          region.includedInReadingOrder !== false &&
          region.lines.length > 0,
      )
      .flatMap<TableLineEntry>((region) =>
        region.lines
          .map((line) => ({ region, line }))
          .filter(
            (entry) =>
              validTableLineEntry(entry) && boxWithinLane(entry.line.box, lane),
          ),
      )
    const gutter = dominantCandidateColumnGutter(
      entries,
      caption,
      lane.direction,
    )
    return gutter ? [(gutter.from + gutter.to) / 2] : []
  })
  if (
    directionalGutterCenters.length === 0 ||
    Math.max(...directionalGutterCenters) -
      Math.min(...directionalGutterCenters) >
      BOX_TOLERANCE
  ) {
    return null
  }
  return captionLaneAtBoundary(rounded(median(directionalGutterCenters)))
}

export function captionOwnsTextSlabLine(
  caption: PdfPageRegion,
  entry: TableLineEntry,
) {
  const localLaneOwnership = sourceCaptionLaneOwnsBox(caption, entry.line.box)
  if (localLaneOwnership !== null) return localLaneOwnership
  if (
    (caption.column === 'left' && entry.region.column === 'right') ||
    (caption.column === 'right' && entry.region.column === 'left')
  ) {
    return false
  }
  if (caption.column === 'span') return true
  if (caption.column === 'single') {
    return entry.region.column === 'single' || entry.region.column === 'span'
  }
  const center = entry.line.box.x + entry.line.box.width / 2
  const laneTolerance =
    MAX_LINE_BAND_CAPTION_GAP + MAX_TEXT_SLAB_CAPTION_GAP + BOX_TOLERANCE
  return caption.column === 'left'
    ? center <= caption.box.x + caption.box.width + laneTolerance
    : center >= caption.box.x - laneTolerance
}

function lineMatchesTableTypography(
  entry: TableLineEntry,
  selectedFontNames: ReadonlySet<string>,
) {
  const visibleRuns = entry.line.runs.filter((run) => run.text.trim())
  return (
    visibleRuns.length > 0 &&
    visibleRuns.every(
      (run) =>
        selectedFontNames.has(normalizedTableFontName(run.fontName)) ||
        explicitTableStyle(run),
    )
  )
}

function sparseHeaderContinuationMatchesBase(
  continuation: TableLineRow,
  base: TableLineRow,
) {
  const continuationRuns = continuation.entries.flatMap((entry) =>
    entry.line.runs.filter((run) => run.text.trim()),
  )
  const baseRuns = base.entries.flatMap((entry) =>
    entry.line.runs.filter((run) => run.text.trim()),
  )
  if (
    continuationRuns.length === 0 ||
    continuation.anchors.length >= MIN_TABULAR_ROW_ANCHORS ||
    !continuation.entries.every((entry) => entry.region.kind === 'header') ||
    !explicitTableHeaderRow(base)
  ) {
    return false
  }
  const claimedBaseRuns = new Set<number>()
  return continuationRuns.every((run) => {
    const runCenter = run.x + run.width / 2
    const candidates = baseRuns.flatMap((baseRun, index) => {
      const baseCenter = baseRun.x + baseRun.width / 2
      const overlap = horizontalOverlap(run, baseRun)
      return overlap / Math.min(run.width, baseRun.width) >= 0.8 &&
        Math.abs(runCenter - baseCenter) <=
          Math.max(BOX_TOLERANCE, Math.min(run.width, baseRun.width) / 2)
        ? [index]
        : []
    })
    if (candidates.length !== 1 || claimedBaseRuns.has(candidates[0])) {
      return false
    }
    claimedBaseRuns.add(candidates[0])
    return true
  })
}

function completeTextScopeWithinCaptionLane(
  scope: PdfTableScope,
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
): CaptionLaneSourceCompletion {
  const none = {
    scope,
    additions: [],
    headerLineIds: [],
    rowFragmentLineIds: [],
    captionAdjacentLineIds: [],
    unsafe: false,
  } satisfies CaptionLaneSourceCompletion
  if (!textBackedTableScope(scope) || scope.lineLineage.length === 0) {
    return none
  }
  const regionsById = new Map(pageRegions.map((region) => [region.id, region]))
  const selectedEntries = scopeLineEntries(scope, regionsById)
  if (selectedEntries.length !== scope.lineLineage.length) {
    return { ...none, unsafe: true }
  }
  const selected = new Map(
    selectedEntries.map((entry) => [tableLineEntryKey(entry), entry]),
  )
  const selectedFontNames = new Set(
    selectedEntries.flatMap((entry) =>
      entry.line.runs
        .filter((run) => run.text.trim())
        .map((run) => normalizedTableFontName(run.fontName)),
    ),
  )
  const lane =
    scope.direction === 'above'
      ? completeAboveCaptionLane(caption, pageRegions)
      : completeBelowCaptionLane(caption, pageRegions)
  const captionOwnsCandidateLine = (entry: TableLineEntry) =>
    scope.proof === 'caption-bounded-text-slab' && scope.direction === 'below'
      ? captionOwnsTextSlabLine(caption, entry)
      : captionOwnsTableLine(caption, entry)
  const candidates = pageRegions
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
            !selected.has(tableLineEntryKey(entry)) &&
            validTableLineEntry(entry) &&
            boxWithinLane(entry.line.box, lane) &&
            captionOwnsCandidateLine(entry),
        ),
    )
  if (candidates.length === 0) return none

  const additions = new Map<string, TableLineEntry>()
  const headerLineIds = new Set<string>()
  const rowFragmentLineIds = new Set<string>()
  const captionAdjacentLineIds = new Set<string>()
  const selectedRows = tableLineRows(selectedEntries)

  // A spanning caption owns all table-font fragments on the same proved row.
  // A column caption is deliberately stricter and can close only fragments
  // classified into that same source column.
  for (const candidate of candidates) {
    if (
      selectedRows.some(
        (row) => Math.abs(row.y - candidate.line.box.y) <= BOX_TOLERANCE,
      ) &&
      (candidate.region.lines.length === 1 ||
        ['equation', 'header', 'spanning'].includes(candidate.region.kind)) &&
      lineMatchesTableTypography(candidate, selectedFontNames)
    ) {
      additions.set(tableLineEntryKey(candidate), candidate)
      rowFragmentLineIds.add(candidate.line.id)
    }
  }

  const currentEntries = () => [...selected.values(), ...additions.values()]
  const remainingRows = () =>
    tableLineRows(
      candidates.filter((entry) => !additions.has(tableLineEntryKey(entry))),
    )

  // Complete contiguous tabular rows between the proved body and its caption.
  // Encountering non-tabular source flow in that corridor invalidates this
  // candidate instead of silently cropping through the prose. Cross-type
  // figure ownership is removed from the available source-line set before
  // this completion pass; font-family changes within a real table are not
  // reliable ownership boundaries.
  let unsafe = false
  while (true) {
    const crop = unionBoxes(
      currentEntries().map((entry) => entry.line.box),
      scope.cropBox.method === 'ocr' ? 'ocr' : 'pdf-text',
    )
    const rows = remainingRows().filter((row) =>
      scope.direction === 'above'
        ? row.box.y >= crop.y + crop.height - BOX_TOLERANCE &&
          row.box.y + row.box.height <= caption.box.y + BOX_TOLERANCE
        : row.box.y + row.box.height <= crop.y + BOX_TOLERANCE &&
          row.box.y >= caption.box.y + caption.box.height - BOX_TOLERANCE,
    )
    const next =
      scope.direction === 'above'
        ? rows.sort((left, right) => left.box.y - right.box.y)[0]
        : rows.sort(
            (left, right) =>
              right.box.y + right.box.height - (left.box.y + left.box.height),
          )[0]
    if (!next) break
    if (gapBetween(crop, next.box).vertical > MAX_ATOMIC_ROW_GAP) break
    if (
      scope.proof === 'caption-bounded-text-slab' &&
      scope.direction === 'below' &&
      (!rowHeightMatchesBand(next, tableLineRows(currentEntries())) ||
        !weakSlabTypographyBoundaryMatches(
          next,
          tableLineRows(currentEntries()),
          false,
        ))
    ) {
      break
    }
    const tableTypography = next.entries.every((entry) =>
      lineMatchesTableTypography(entry, selectedFontNames),
    )
    const tabularGeometry =
      next.anchors.length >= MIN_GRID_COLUMNS ||
      next.entries.every((entry) => entry.region.kind === 'equation') ||
      next.entries.some((entry) => labeledRecordLine(entry.line))
    if (!tableTypography || !tabularGeometry) {
      unsafe = true
      break
    }
    for (const entry of next.entries) {
      additions.set(tableLineEntryKey(entry), entry)
      captionAdjacentLineIds.add(entry.line.id)
    }
  }

  // Close upward over one or more adjacent, explicit multi-anchor header rows.
  // This is intentionally asymmetric: source headers precede tables above
  // their captions, and generic prose may never be pulled in by this step.
  if (!unsafe && scope.direction === 'above') {
    while (true) {
      const crop = unionBoxes(
        currentEntries().map((entry) => entry.line.box),
        scope.cropBox.method === 'ocr' ? 'ocr' : 'pdf-text',
      )
      const rows = remainingRows()
        .filter(
          (candidate) =>
            candidate.box.y + candidate.box.height <= crop.y + BOX_TOLERANCE,
        )
        .sort(
          (left, right) =>
            right.box.y + right.box.height - (left.box.y + left.box.height),
        )
      const row = rows[0]
      const rowWithinScope =
        row !== undefined &&
        gapBetween(crop, row.box).vertical <=
          MAX_LINE_BAND_CAPTION_GAP + BOX_TOLERANCE &&
        horizontalOverlap(crop, row.box) /
          Math.min(crop.width, row.box.width) >=
          0.5
      if (!rowWithinScope) {
        break
      }
      let headerRows = explicitTableHeaderRow(row) ? [row] : []
      if (headerRows.length === 0) {
        const base = rows
          .slice(1)
          .filter(
            (candidate) =>
              candidate.box.y + candidate.box.height <=
              row.box.y + BOX_TOLERANCE,
          )
          .sort(
            (left, right) =>
              right.box.y + right.box.height - (left.box.y + left.box.height),
          )[0]
        if (
          !base ||
          gapBetween(row.box, base.box).vertical >
            MAX_LINE_BAND_CAPTION_GAP + BOX_TOLERANCE ||
          horizontalOverlap(crop, base.box) /
            Math.min(crop.width, base.box.width) <
            0.5 ||
          !row.entries.every((entry) =>
            lineMatchesTableTypography(entry, selectedFontNames),
          ) ||
          !base.entries.every((entry) =>
            lineMatchesTableTypography(entry, selectedFontNames),
          ) ||
          !sparseHeaderContinuationMatchesBase(row, base)
        ) {
          break
        }
        headerRows = [base, row]
      }
      for (const entry of headerRows.flatMap(
        (headerRow) => headerRow.entries,
      )) {
        additions.set(tableLineEntryKey(entry), entry)
        headerLineIds.add(entry.line.id)
      }
    }
  }

  return {
    scope,
    additions: [...additions.values()],
    headerLineIds: [...headerLineIds].sort(),
    rowFragmentLineIds: [...rowFragmentLineIds].sort(),
    captionAdjacentLineIds: [...captionAdjacentLineIds].sort(),
    unsafe,
  }
}

function paddedCompletedTableCrop(
  sourceBoxes: NormalizedSourceBox[],
  lane: DirectionalLane,
) {
  const raw = unionBoxes(
    sourceBoxes,
    sourceBoxes.some((sourceBox) => sourceBox.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  )
  const left = Math.max(0, raw.x - TABLE_BORDER_INK_PADDING)
  const top = Math.max(lane.top, raw.y - TABLE_BORDER_INK_PADDING)
  const right = Math.min(1, raw.x + raw.width + TABLE_BORDER_INK_PADDING)
  const bottom = Math.min(
    lane.bottom,
    raw.y + raw.height + TABLE_BORDER_INK_PADDING,
  )
  return {
    ...raw,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
  }
}

function applyCaptionLaneSourceCompletion(
  proposal: CaptionLaneSourceCompletion,
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
) {
  if (proposal.additions.length === 0) return proposal.scope
  const regionsById = new Map(pageRegions.map((region) => [region.id, region]))
  const selectedEntries = [
    ...scopeLineEntries(proposal.scope, regionsById),
    ...proposal.additions,
  ]
  const selectedLineIdsByRegion = new Map<string, Set<string>>()
  const selectedRegions = new Map<string, PdfPageRegion>()
  for (const entry of selectedEntries) {
    selectedRegions.set(entry.region.id, entry.region)
    const lineIds =
      selectedLineIdsByRegion.get(entry.region.id) ?? new Set<string>()
    lineIds.add(entry.line.id)
    selectedLineIdsByRegion.set(entry.region.id, lineIds)
  }
  const lineage = selectedTextLineage(
    [...selectedRegions.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    selectedLineIdsByRegion,
  )
  const lane =
    proposal.scope.direction === 'above'
      ? completeAboveCaptionLane(caption, pageRegions)
      : completeBelowCaptionLane(caption, pageRegions)
  const cropBox = paddedCompletedTableCrop(lineage.sourceLineBoxes, lane)
  if (cropBox.width * cropBox.height > MAX_SCOPE_AREA) return proposal.scope
  const partialRegionIds = lineage.regionLineage
    .filter((item) => item.selection === 'partial')
    .map((item) => item.regionId)
  const retainedLineIds = lineage.regionLineage
    .flatMap((item) => item.retainedLineIds)
    .sort()
  const completionEvidence: PdfTableScopeEvidence = {
    code: 'caption-lane-source-completion',
    lineIds: proposal.additions.map((entry) => entry.line.id).sort(),
    headerLineIds: proposal.headerLineIds,
    rowFragmentLineIds: proposal.rowFragmentLineIds,
    captionAdjacentLineIds: proposal.captionAdjacentLineIds,
    borderInkPadding: TABLE_BORDER_INK_PADDING,
  }
  const evidence: PdfTableScopeEvidence[] = proposal.scope.evidence.filter(
    (item) =>
      item.code !== 'caption-lane-source-completion' &&
      item.code !== 'partial-parent-line-selection',
  )
  if (partialRegionIds.length > 0) {
    evidence.push({
      code: 'partial-parent-line-selection',
      partialRegionIds,
      selectedLineIds: [...lineage.sourceLineIds],
      retainedLineIds,
    })
  }
  evidence.push(completionEvidence)
  return {
    ...proposal.scope,
    id: scopeId(
      proposal.scope.proof,
      lineage.sourceRegionIds,
      lineage.lineLineage,
      [],
      cropBox,
    ),
    sourceRegionIds: lineage.sourceRegionIds,
    sourceLineIds: lineage.sourceLineIds,
    sourceBoxes: uniqueBoxes([
      ...proposal.scope.sourceBoxes,
      ...proposal.additions.map((entry) => entry.line.box),
    ]),
    sourceLineBoxes: lineage.sourceLineBoxes,
    cropBox,
    regionLineage: lineage.regionLineage,
    lineLineage: lineage.lineLineage,
    evidence,
  } satisfies PdfTableScope
}

export function completeCaptionLaneTextCandidates(
  caption: PdfPageRegion,
  pageRegions: PdfPageRegion[],
  candidates: PdfTableScope[],
) {
  const proposals = candidates.map((scope) =>
    completeTextScopeWithinCaptionLane(scope, caption, pageRegions),
  )
  const owners = new Map<string, Set<string>>()
  for (const proposal of proposals) {
    for (const entry of proposal.additions) {
      const key = tableLineEntryKey(entry)
      const values = owners.get(key) ?? new Set<string>()
      values.add(proposal.scope.id)
      owners.set(key, values)
    }
  }
  return proposals.flatMap((proposal) => {
    if (proposal.unsafe) return []
    const contested = proposal.additions.filter(
      (entry) => (owners.get(tableLineEntryKey(entry))?.size ?? 0) !== 1,
    )
    if (
      contested.some((entry) => !proposal.headerLineIds.includes(entry.line.id))
    ) {
      return []
    }
    if (contested.length > 0) {
      return [proposal.scope]
    }
    return [applyCaptionLaneSourceCompletion(proposal, caption, pageRegions)]
  })
}
