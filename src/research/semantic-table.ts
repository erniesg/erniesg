import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualRelationship,
} from './import-types'
import { mergeWrappedHeaderContinuationRuns } from './pdf-table-detection.ts'

export type StrictSemanticTableInlineRun = {
  start: number
  end: number
  bold?: boolean
  italic?: boolean
  href?: string
  annotationId?: string
  verticalAlign?: 'superscript' | 'subscript'
}

export type StrictSemanticTableSourceRun = {
  regionId: string
  lineId: string
  runIndex: number
  text: string
  box: NormalizedSourceBox
}

export type StrictSemanticTableCell = {
  text: string
  headerScope: 'column' | 'row' | null
  columnSpan: number
  rowSpan: number
  id?: string
  headerIds?: string[]
  sourceRuns?: StrictSemanticTableSourceRun[]
  inlineRuns?: StrictSemanticTableInlineRun[]
  inlineMapping?: {
    expected: number
    mapped: number
  }
}

export type StrictSemanticTable = {
  rows: Array<{ cells: StrictSemanticTableCell[] }>
}

const HEADER_SCOPES = new Set<unknown>(['column', 'row', null])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function normalizedText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

function exactSourceText(value: unknown) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
    : ''
}

function validCell(value: unknown): value is StrictSemanticTableCell {
  return (
    isRecord(value) &&
    normalizedText(value.text).length > 0 &&
    HEADER_SCOPES.has(value.headerScope) &&
    positiveInteger(value.columnSpan) &&
    positiveInteger(value.rowSpan)
  )
}

function rectangularGrid(rows: StrictSemanticTable['rows']) {
  const occupied: boolean[][] = Array.from({ length: rows.length }, () => [])
  const placements: Array<
    Array<{ columnIndex: number; columnSpan: number; rowSpan: number }>
  > = rows.map(() => [])
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (const cell of rows[rowIndex].cells) {
      let column = 0
      while (occupied[rowIndex][column]) column += 1
      if (rowIndex + cell.rowSpan > rows.length) return null
      placements[rowIndex].push({
        columnIndex: column,
        columnSpan: cell.columnSpan,
        rowSpan: cell.rowSpan,
      })
      for (
        let targetRow = rowIndex;
        targetRow < rowIndex + cell.rowSpan;
        targetRow += 1
      ) {
        for (
          let targetColumn = column;
          targetColumn < column + cell.columnSpan;
          targetColumn += 1
        ) {
          if (occupied[targetRow][targetColumn]) return null
          occupied[targetRow][targetColumn] = true
        }
      }
    }
  }
  const width = Math.max(0, ...occupied.map((row) => row.length))
  if (
    width < 2 ||
    occupied.some(
      (row) =>
        row.length !== width ||
        Array.from({ length: width }, (_, index) => row[index] === true).some(
          (present) => !present,
        ),
    )
  ) {
    return null
  }
  return { rows: rows.length, columns: width, placements }
}

export function isStrictSemanticTable(
  table: unknown,
): table is StrictSemanticTable {
  if (!isRecord(table) || !Array.isArray(table.rows) || table.rows.length < 2) {
    return false
  }
  if (
    table.rows.some(
      (row) =>
        !isRecord(row) ||
        !Array.isArray(row.cells) ||
        row.cells.length === 0 ||
        row.cells.some((cell) => !validCell(cell)),
    )
  ) {
    return false
  }
  const rows = table.rows as StrictSemanticTable['rows']
  if (!rectangularGrid(rows)) return false

  const hasColumnHeader = rows[0].cells.every(
    ({ headerScope }) => headerScope === 'column',
  )
  const hasRowHeaders = rows.every(({ cells }) =>
    cells.some(({ headerScope }) => headerScope === 'row'),
  )
  return hasColumnHeader || hasRowHeaders
}

function sameSourceBox(left: unknown, right: NormalizedSourceBox) {
  if (!isRecord(left)) return false
  return (
    left.page === right.page &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.method === right.method
  )
}

function tableBoxesOverlap(
  left: Pick<NormalizedSourceBox, 'page' | 'x' | 'y' | 'width' | 'height'>,
  right: Pick<NormalizedSourceBox, 'page' | 'x' | 'y' | 'width' | 'height'>,
) {
  return (
    left.page === right.page &&
    Math.min(left.x + left.width, right.x + right.width) >
      Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) >
      Math.max(left.y, right.y)
  )
}

function safeTableHyperlink(value: string) {
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return false
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function sourceRunBold(run: PdfSourceRun) {
  return (
    run.bold === true ||
    (run.bold === undefined &&
      /(?:bold|black|demi|semibold|(?:^|[-_])medi(?:um)?(?:$|[-_]))/iu.test(
        run.fontName,
      ))
  )
}

function sourceRunItalic(run: PdfSourceRun) {
  return (
    run.italic === true ||
    (run.italic === undefined &&
      /(?:italic|ital(?:ic)?|oblique|(?:^|[-_])it(?:$|[-_]))/iu.test(
        run.fontName,
      ))
  )
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function sourceRunVerticalAlign(
  rowRuns: readonly PdfSourceRun[],
  run: PdfSourceRun,
) {
  const maximumFontSize = Math.max(
    ...rowRuns.map((candidate) => candidate.fontSize),
  )
  if (run.fontSize >= maximumFontSize * 0.82) return undefined
  const baselineRuns = rowRuns.filter(
    (candidate) => candidate.fontSize >= maximumFontSize * 0.9,
  )
  const baselineCenter = median(
    baselineRuns.map((candidate) => candidate.y + candidate.height / 2),
  )
  const runCenter = run.y + run.height / 2
  const threshold = Math.max(
    0.0015,
    median(baselineRuns.map((candidate) => candidate.height)) * 0.12,
  )
  if (runCenter < baselineCenter - threshold) return 'superscript' as const
  if (runCenter > baselineCenter + threshold) return 'subscript' as const
  return undefined
}

function sourceLineOrder(
  left: PdfPageRegion['lines'][number],
  right: PdfPageRegion['lines'][number],
) {
  return (
    left.box.page - right.box.page ||
    left.box.y - right.box.y ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  )
}

function sourceRunKey(regionId: string, lineId: string, runIndex: number) {
  return `${regionId}\u0000${lineId}\u0000${runIndex}`
}

function sourceRunSequenceLayout<
  T extends { run: PdfSourceRun; lineId?: string },
>(sources: readonly T[]) {
  let text = ''
  return sources.map((source, index) => {
    if (index > 0) {
      const previousSource = sources[index - 1]
      const previous = previousSource.run
      if (
        previousSource.lineId !== undefined &&
        source.lineId !== undefined &&
        previousSource.lineId !== source.lineId
      ) {
        text += ' '
      } else {
        const gap = source.run.x - (previous.x + previous.width)
        const noSpaceThreshold = Math.max(
          0.0005,
          Math.min(previous.height, source.run.height) * 0.18,
        )
        if (gap > noSpaceThreshold) text += ' '
      }
    }
    const start = text.length
    text += source.run.text
    return { source, start, end: text.length, text }
  })
}

type VerifiedTableSourceRun = {
  key: string
  regionId: string
  lineId: string
  runIndex: number
  run: PdfSourceRun
}

function alignVerifiedWrappedColumnHeaderLineage({
  table,
  sourceRows,
  regionKinds,
}: {
  table: StrictSemanticTable
  sourceRows: VerifiedTableSourceRun[][]
  regionKinds: ReadonlyMap<string, PdfPageRegion['kind']>
}) {
  const header = table.rows[0]
  const firstBodyRow = table.rows[1]
  const wrappedHeaderBandCount = sourceRows.length - table.rows.length + 1
  if (
    wrappedHeaderBandCount < 2 ||
    !header ||
    !firstBodyRow ||
    !header.cells.every(
      (cell) =>
        cell.headerScope === 'column' &&
        cell.columnSpan === 1 &&
        cell.rowSpan === 1,
    ) ||
    firstBodyRow.cells.every((cell) => cell.headerScope === 'column') ||
    sourceRows
      .slice(0, wrappedHeaderBandCount)
      .flat()
      .some((source) => regionKinds.get(source.regionId) !== 'header')
  ) {
    return null
  }

  const selectedSources = sourceRows.flat()
  const selectedByKey = new Map(
    selectedSources.map((source) => [source.key, source]),
  )
  if (selectedByKey.size !== selectedSources.length) return null

  const claimedKeys = new Set<string>()
  const headerCellIndexBySourceKey = new Map<string, number>()
  const alignedRows: VerifiedTableSourceRun[][] = []
  for (const [rowIndex, row] of table.rows.entries()) {
    const physicalBands =
      rowIndex === 0
        ? sourceRows.slice(0, wrappedHeaderBandCount)
        : [sourceRows[wrappedHeaderBandCount + rowIndex - 1]]
    if (physicalBands.some((band) => !band)) return null
    const expectedSources = physicalBands.flat()
    const expectedKeys = new Set(expectedSources.map((source) => source.key))
    const aligned: VerifiedTableSourceRun[] = []
    for (const [cellIndex, cell] of row.cells.entries()) {
      for (const claimed of cell.sourceRuns ?? []) {
        const key = sourceRunKey(
          claimed.regionId,
          claimed.lineId,
          claimed.runIndex,
        )
        const selected = selectedByKey.get(key)
        if (
          !selected ||
          !expectedKeys.has(key) ||
          claimedKeys.has(key) ||
          claimed.text !== selected.run.text ||
          !sameSourceBox(claimed.box, selected.run)
        ) {
          return null
        }
        claimedKeys.add(key)
        if (rowIndex === 0) {
          headerCellIndexBySourceKey.set(key, cellIndex)
        }
        aligned.push(selected)
      }
    }
    if (aligned.length !== expectedSources.length) return null
    for (const band of physicalBands) {
      const bandKeys = new Set(band.map((source) => source.key))
      const claimedBandOrder = aligned
        .filter((source) => bandKeys.has(source.key))
        .map((source) => source.key)
      if (
        claimedBandOrder.length !== band.length ||
        claimedBandOrder.some((key, index) => key !== band[index].key)
      ) {
        return null
      }
    }
    alignedRows.push(aligned)
  }

  let simulatedHeaderRuns = sourceRows[0].map(({ run }) => run)
  for (let bandIndex = 1; bandIndex < wrappedHeaderBandCount; bandIndex += 1) {
    const continuationBand = sourceRows[bandIndex]
    const merged = mergeWrappedHeaderContinuationRuns(
      simulatedHeaderRuns,
      continuationBand.map(({ run }) => run),
    )
    if (!merged) return null
    for (const [
      continuationIndex,
      targetIndex,
    ] of merged.targetIndices.entries()) {
      const baseSource = sourceRows[0][targetIndex]
      const continuationSource = continuationBand[continuationIndex]
      const baseCellIndex = baseSource
        ? headerCellIndexBySourceKey.get(baseSource.key)
        : undefined
      const continuationCellIndex = continuationSource
        ? headerCellIndexBySourceKey.get(continuationSource.key)
        : undefined
      if (
        !baseSource ||
        baseCellIndex === undefined ||
        continuationCellIndex === undefined ||
        baseCellIndex !== continuationCellIndex
      ) {
        return null
      }
    }
    simulatedHeaderRuns = merged.runs
  }

  return claimedKeys.size === selectedSources.length ? alignedRows : null
}

function semanticCellCenter(cell: StrictSemanticTableCell) {
  if (!cell.sourceRuns?.length) return null
  const left = Math.min(...cell.sourceRuns.map((source) => source.box.x))
  const right = Math.max(
    ...cell.sourceRuns.map((source) => source.box.x + source.box.width),
  )
  return (left + right) / 2
}

function verifiedHeaderSpanGeometry(
  table: StrictSemanticTable,
  grid: NonNullable<ReturnType<typeof rectangularGrid>>,
  headerRowCount: number,
) {
  const bodyRows = table.rows.slice(headerRowCount)
  if (
    bodyRows.length === 0 ||
    bodyRows.some((row, relativeRowIndex) =>
      row.cells.some((cell, cellIndex) => {
        const placement =
          grid.placements[headerRowCount + relativeRowIndex][cellIndex]
        return (
          cell.headerScope !== null ||
          placement.columnSpan !== 1 ||
          placement.rowSpan !== 1
        )
      }),
    )
  ) {
    return false
  }
  if (headerRowCount === 1) {
    return table.rows[0].cells.every(
      (_cell, cellIndex) =>
        grid.placements[0][cellIndex].columnSpan === 1 &&
        grid.placements[0][cellIndex].rowSpan === 1,
    )
  }
  if (headerRowCount !== 2 || grid.columns < 4) return false

  const firstHeader = table.rows[0]
  const leafHeader = table.rows[1]
  const bodyCenters = Array.from({ length: grid.columns }, (_, columnIndex) => {
    const centers = bodyRows.flatMap((row, relativeRowIndex) =>
      row.cells.flatMap((cell, cellIndex) => {
        const placement =
          grid.placements[headerRowCount + relativeRowIndex][cellIndex]
        return placement.columnIndex === columnIndex
          ? [semanticCellCenter(cell)]
          : []
      }),
    )
    return centers.some((center) => center === null)
      ? null
      : median(centers as number[])
  })
  if (bodyCenters.some((center) => center === null)) return false
  const numericBodyCenters = bodyCenters as number[]
  const firstHeaderPlacements = grid.placements[0]
  const leafPlacements = grid.placements[1]
  const wrappedHeader =
    firstHeader.cells.length === grid.columns &&
    firstHeaderPlacements.every(
      (placement, index) =>
        placement.columnIndex === index &&
        placement.columnSpan === 1 &&
        (placement.rowSpan === 1 || placement.rowSpan === 2),
    ) &&
    leafHeader.cells.length > 0 &&
    leafHeader.cells.length < grid.columns &&
    leafHeader.cells.every((cell) => cell.headerScope === 'column') &&
    leafPlacements.every(
      (placement) => placement.columnSpan === 1 && placement.rowSpan === 1,
    ) &&
    firstHeaderPlacements.every(
      (placement) =>
        (placement.rowSpan === 1) ===
        leafPlacements.some(
          (leaf) => leaf.columnIndex === placement.columnIndex,
        ),
    ) &&
    firstHeader.cells.every((cell, index) => {
      const center = semanticCellCenter(cell)
      return (
        center !== null && Math.abs(center - numericBodyCenters[index]) <= 0.045
      )
    }) &&
    leafHeader.cells.every((cell, index) => {
      const center = semanticCellCenter(cell)
      return (
        center !== null &&
        Math.abs(
          center - numericBodyCenters[leafPlacements[index].columnIndex],
        ) <= 0.045
      )
    })
  if (wrappedHeader) return true

  const stub = firstHeader.cells[0]
  const stubPlacement = grid.placements[0][0]
  const groupHeaders = firstHeader.cells.slice(1)
  const groupPlacements = grid.placements[0].slice(1)
  if (
    firstHeader.cells.length < 3 ||
    stubPlacement.columnIndex !== 0 ||
    stubPlacement.columnSpan !== 1 ||
    stubPlacement.rowSpan !== 2 ||
    groupHeaders.length < 2 ||
    groupPlacements.some(
      (placement) =>
        placement.columnIndex < 1 ||
        placement.columnSpan < 1 ||
        placement.rowSpan !== 1,
    ) ||
    leafHeader.cells.length !== grid.columns - 1 ||
    leafPlacements.some(
      (placement, index) =>
        placement.columnIndex !== index + 1 ||
        placement.columnSpan !== 1 ||
        placement.rowSpan !== 1,
    )
  ) {
    return false
  }

  const stubCenter = semanticCellCenter(stub)
  if (
    stubCenter === null ||
    Math.abs(stubCenter - numericBodyCenters[0]) > 0.045
  ) {
    return false
  }
  for (const [cellIndex, cell] of leafHeader.cells.entries()) {
    const center = semanticCellCenter(cell)
    if (
      center === null ||
      Math.abs(center - numericBodyCenters[cellIndex + 1]) > 0.045
    ) {
      return false
    }
  }

  const groupCenters = groupHeaders.map(semanticCellCenter)
  if (
    groupCenters.some((center) => center === null) ||
    groupCenters.some(
      (center, index) =>
        index > 0 && Number(center) - Number(groupCenters[index - 1]) <= 0.06,
    )
  ) {
    return false
  }
  const numericGroupCenters = groupCenters as number[]
  const boundaries = numericGroupCenters
    .slice(1)
    .map((center, index) => (numericGroupCenters[index] + center) / 2)
  const groupedColumns = groupHeaders.map(() => [] as number[])
  for (
    let columnIndex = 1;
    columnIndex < numericBodyCenters.length;
    columnIndex += 1
  ) {
    const center = numericBodyCenters[columnIndex]
    const groupIndex = boundaries.findIndex((boundary) => center < boundary)
    groupedColumns[
      groupIndex === -1 ? groupHeaders.length - 1 : groupIndex
    ].push(columnIndex)
  }
  return groupedColumns.every((columns, groupIndex) => {
    if (columns.length === 0) return false
    const placement = groupPlacements[groupIndex]
    const expectedCenter = median(
      columns.map((columnIndex) => numericBodyCenters[columnIndex]),
    )
    return (
      placement.columnIndex === columns[0] &&
      placement.columnSpan === columns.length &&
      Math.abs(numericGroupCenters[groupIndex] - expectedCenter) <= 0.025
    )
  })
}

function expectedInlineRun(
  run: PdfSourceRun,
  rowRuns: readonly PdfSourceRun[],
  links: NodeSourceEvidence['links'],
) {
  const bold = sourceRunBold(run)
  const italic = sourceRunItalic(run)
  const verticalAlign = sourceRunVerticalAlign(rowRuns, run)
  const hrefs = [
    ...links.flatMap((link) =>
      link.status === 'external' &&
      tableBoxesOverlap(link.box, run) &&
      safeTableHyperlink(link.url)
        ? [link]
        : [],
    ),
  ]
  if (hrefs.length > 1) return null
  const hyperlink = hrefs[0]
  const href = hyperlink?.url
  const expected =
    Number(bold) +
    Number(italic) +
    Number(Boolean(verticalAlign)) +
    Number(Boolean(href))
  return {
    expected,
    runs:
      expected === 0
        ? []
        : [
            {
              start: 0,
              end: run.text.length,
              ...(bold ? { bold: true } : {}),
              ...(italic ? { italic: true } : {}),
              ...(href ? { href } : {}),
              ...(hyperlink ? { annotationId: hyperlink.id } : {}),
              ...(verticalAlign ? { verticalAlign } : {}),
            },
          ],
  }
}

function expectedInlineCell(
  sources: readonly { run: PdfSourceRun }[],
  rowRuns: readonly PdfSourceRun[],
  links: NodeSourceEvidence['links'],
) {
  const overlappingLinks = links.filter(
    (link) =>
      link.status === 'external' &&
      safeTableHyperlink(link.url) &&
      sources.some(({ run }) => tableBoxesOverlap(link.box, run)),
  )
  if (overlappingLinks.length > 1) return null
  const layout = sourceRunSequenceLayout(sources)
  let expected = 0
  const runs = layout.flatMap(({ source, start }) => {
    const inline = expectedInlineRun(source.run, rowRuns, [])
    if (!inline) return []
    expected += inline.expected
    return inline.runs.map((run) => ({
      ...run,
      start: run.start + start,
      end: run.end + start,
    }))
  })
  const hyperlink = overlappingLinks[0]
  if (hyperlink) {
    expected += 1
    const end = layout.at(-1)?.text.length ?? 0
    const coextensive = runs.find((run) => run.start === 0 && run.end === end)
    if (coextensive) {
      Object.assign(coextensive, {
        href: hyperlink.url,
        annotationId: hyperlink.id,
      })
    } else {
      runs.push({
        start: 0,
        end,
        href: hyperlink.url,
        annotationId: hyperlink.id,
      })
    }
  }
  return { expected, runs }
}

function sameInlineRuns(
  left: StrictSemanticTableInlineRun[] | undefined,
  right: StrictSemanticTableInlineRun[],
) {
  return (
    (left?.length ?? 0) === right.length &&
    (left ?? []).every(
      (run, index) =>
        run.start === right[index].start &&
        run.end === right[index].end &&
        run.bold === right[index].bold &&
        run.italic === right[index].italic &&
        run.href === right[index].href &&
        run.annotationId === right[index].annotationId &&
        run.verticalAlign === right[index].verticalAlign,
    )
  )
}

export function isSourceVerifiedSemanticTable({
  table,
  relationship,
  regions,
  evidence,
}: {
  table: unknown
  relationship: PdfVisualRelationship
  regions: readonly PdfPageRegion[] | undefined
  evidence: NodeSourceEvidence | undefined
}): boolean {
  if (
    !isStrictSemanticTable(table) ||
    !regions ||
    !evidence ||
    relationship.kind !== 'table' ||
    relationship.status !== 'matched' ||
    relationship.sourceRegionIds.length === 0 ||
    !relationship.sourceLineIds?.length ||
    new Set(relationship.sourceRegionIds).size !==
      relationship.sourceRegionIds.length ||
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length
  ) {
    return false
  }

  const regionOccurrences = new Map<string, PdfPageRegion[]>()
  for (const region of regions) {
    const occurrences = regionOccurrences.get(region.id) ?? []
    occurrences.push(region)
    regionOccurrences.set(region.id, occurrences)
  }
  const scopedRegions = relationship.sourceRegionIds.flatMap(
    (regionId) => regionOccurrences.get(regionId) ?? [],
  )
  if (
    scopedRegions.length !== relationship.sourceRegionIds.length ||
    relationship.sourceRegionIds.some(
      (regionId) => regionOccurrences.get(regionId)?.length !== 1,
    )
  ) {
    return false
  }

  const lineOccurrences = new Map<
    string,
    Array<{ regionId: string; line: PdfPageRegion['lines'][number] }>
  >()
  for (const region of scopedRegions) {
    for (const line of region.lines) {
      const occurrences = lineOccurrences.get(line.id) ?? []
      occurrences.push({ regionId: region.id, line })
      lineOccurrences.set(line.id, occurrences)
    }
  }
  const selectedLines = relationship.sourceLineIds.flatMap(
    (lineId) => lineOccurrences.get(lineId) ?? [],
  )
  if (
    selectedLines.length !== relationship.sourceLineIds.length ||
    relationship.sourceLineIds.some(
      (lineId) => lineOccurrences.get(lineId)?.length !== 1,
    )
  ) {
    return false
  }
  selectedLines.sort((left, right) => sourceLineOrder(left.line, right.line))

  const sourceLineBands: (typeof selectedLines)[] = []
  for (const selected of selectedLines) {
    const band = sourceLineBands.at(-1)
    const anchor = band?.[0]
    const sameBand =
      anchor !== undefined &&
      anchor.line.box.page === selected.line.box.page &&
      Math.abs(anchor.line.box.y - selected.line.box.y) <=
        Math.max(
          0.004,
          Math.min(anchor.line.box.height, selected.line.box.height) * 0.85,
        )
    if (sameBand && band) {
      band.push(selected)
    } else {
      sourceLineBands.push([selected])
    }
  }

  let sourceRows: VerifiedTableSourceRun[][] = []
  for (const band of sourceLineBands) {
    const row = band
      .flatMap((selected) =>
        selected.line.runs.flatMap((run, runIndex) =>
          run.text.trim()
            ? [
                {
                  key: sourceRunKey(
                    selected.regionId,
                    selected.line.id,
                    runIndex,
                  ),
                  regionId: selected.regionId,
                  lineId: selected.line.id,
                  runIndex,
                  run,
                },
              ]
            : [],
        ),
      )
      .sort(
        (left, right) =>
          left.run.x - right.run.x ||
          left.run.y - right.run.y ||
          left.runIndex - right.runIndex,
      )
    if (row.length > 0) sourceRows.push(row)
  }
  const canonicalCells = table.rows.flatMap((row) => row.cells)
  if (
    canonicalCells.some(
      (cell) =>
        !cell.id ||
        !Array.isArray(cell.headerIds) ||
        !Array.isArray(cell.sourceRuns) ||
        cell.sourceRuns.length === 0 ||
        cell.sourceRuns.some((source) => !isRecord(source)) ||
        !cell.inlineMapping,
    )
  ) {
    return false
  }
  if (sourceRows.length !== table.rows.length) {
    const closedRows = alignVerifiedWrappedColumnHeaderLineage({
      table,
      sourceRows,
      regionKinds: new Map(
        scopedRegions.map((region) => [region.id, region.kind]),
      ),
    })
    if (!closedRows) return false
    sourceRows = closedRows
  }
  const sourceCells = sourceRows.flat()
  if (
    exactSourceText(sourceCells.map(({ run }) => run.text).join(' ')) !==
    exactSourceText(relationship.sourceText)
  ) {
    return false
  }
  const grid = rectangularGrid(table.rows)
  if (!grid) return false
  const firstBodyRow = table.rows.findIndex(
    (row) => !row.cells.every((cell) => cell.headerScope === 'column'),
  )
  const headerRowCount = firstBodyRow === -1 ? table.rows.length : firstBodyRow
  if (!verifiedHeaderSpanGeometry(table, grid, headerRowCount)) {
    return false
  }
  const canonicalIds = canonicalCells.map((cell) => cell.id!)
  if (new Set(canonicalIds).size !== canonicalIds.length) return false
  const cellsById = new Map(canonicalCells.map((cell) => [cell.id!, cell]))

  const claimedSourceKeys: string[] = []
  const verifiedSourceCellTexts: string[] = []
  const expectedHeaderIds = (
    rowIndex: number,
    columnIndex: number,
    columnSpan: number,
  ) =>
    grid.placements
      .slice(0, Math.min(rowIndex, headerRowCount))
      .flatMap((headerRow, headerRowIndex) =>
        headerRow.flatMap((placement) =>
          placement.columnIndex <= columnIndex &&
          placement.columnIndex + placement.columnSpan >=
            columnIndex + columnSpan
            ? [`cell-r${headerRowIndex + 1}-c${placement.columnIndex + 1}`]
            : [],
        ),
      )
  for (const [rowIndex, row] of table.rows.entries()) {
    let sourceColumnIndex = 0
    for (const [cellIndex, cell] of row.cells.entries()) {
      const placement = grid.placements[rowIndex][cellIndex]
      if (cell.id !== `cell-r${rowIndex + 1}-c${placement.columnIndex + 1}`) {
        return false
      }
      const expectedHeaders =
        cell.headerScope !== null
          ? []
          : expectedHeaderIds(
              rowIndex,
              placement.columnIndex,
              placement.columnSpan,
            )
      if (
        cell.headerIds!.length !== expectedHeaders.length ||
        cell.headerIds!.some(
          (headerId, index) => headerId !== expectedHeaders[index],
        ) ||
        cell.headerIds!.some(
          (headerId) => cellsById.get(headerId)?.headerScope !== 'column',
        )
      ) {
        return false
      }

      const expectedSources = sourceRows[rowIndex].slice(
        sourceColumnIndex,
        sourceColumnIndex + cell.sourceRuns!.length,
      )
      if (expectedSources.length !== cell.sourceRuns!.length) return false
      for (const [runIndex, claimedSource] of cell.sourceRuns!.entries()) {
        const expectedSource = expectedSources[runIndex]
        const claimedKey = sourceRunKey(
          claimedSource.regionId,
          claimedSource.lineId,
          claimedSource.runIndex,
        )
        claimedSourceKeys.push(claimedKey)
        if (
          claimedKey !== expectedSource.key ||
          claimedSource.text !== expectedSource.run.text ||
          !sameSourceBox(claimedSource.box, expectedSource.run)
        ) {
          return false
        }
      }
      const sourceLayout = sourceRunSequenceLayout(expectedSources)
      const verifiedSourceText = sourceLayout.at(-1)?.text ?? ''
      verifiedSourceCellTexts.push(verifiedSourceText)
      if (cell.text !== verifiedSourceText) return false
      const expectedInline = expectedInlineCell(
        expectedSources,
        sourceRows[rowIndex].map(({ run }) => run),
        evidence.links,
      )
      if (
        !expectedInline ||
        cell.inlineMapping!.expected !== expectedInline.expected ||
        cell.inlineMapping!.mapped !== expectedInline.expected ||
        !sameInlineRuns(cell.inlineRuns, expectedInline.runs)
      ) {
        return false
      }
      sourceColumnIndex += expectedSources.length
    }
    if (sourceColumnIndex !== sourceRows[rowIndex].length) return false
  }
  if (
    new Set(claimedSourceKeys).size !== claimedSourceKeys.length ||
    claimedSourceKeys.some((key, index) => key !== sourceCells[index].key)
  ) {
    return false
  }
  return (
    exactSourceText(canonicalCells.map((cell) => cell.text).join(' ')) ===
    exactSourceText(verifiedSourceCellTexts.join(' '))
  )
}

function attributeInteger(attributes: string, name: string) {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:["'](\\d+)["']|(\\d+))`, 'iu'),
  )
  if (!match) return 1
  const value = Number(match[1] ?? match[2])
  return positiveInteger(value) ? value : null
}

function attributeValue(attributes: string, name: string) {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']+)["']|([^\\s>]+))`, 'iu'),
  )
  return (match?.[1] ?? match?.[2] ?? '').toLowerCase()
}

function decodeHtmlText(value: string) {
  const entities = new Map<string, string>([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ])
  return normalizedText(
    value
      .replace(/<br\s*\/?\s*>/giu, ' ')
      .replace(/<[^>]*>/gu, ' ')
      .replace(
        /&(?:#(\d+)|#x([a-f0-9]+)|([a-z]+));/giu,
        (original, decimal, hexadecimal, named) => {
          const codePoint = decimal
            ? Number(decimal)
            : hexadecimal
              ? Number.parseInt(hexadecimal, 16)
              : null
          if (codePoint !== null && Number.isSafeInteger(codePoint)) {
            try {
              return String.fromCodePoint(codePoint)
            } catch {
              return original
            }
          }
          return entities.get(named?.toLowerCase()) ?? original
        },
      ),
  )
}

export function semanticTableFromHtml(
  html: unknown,
): StrictSemanticTable | null {
  if (typeof html !== 'string') return null
  const tableMatch = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/iu)
  if (!tableMatch) return null
  const rows: StrictSemanticTable['rows'] = []
  for (const rowMatch of tableMatch[1].matchAll(
    /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu,
  )) {
    const cells: StrictSemanticTableCell[] = []
    for (const cellMatch of rowMatch[1].matchAll(
      /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
    )) {
      const columnSpan = attributeInteger(cellMatch[2], 'colspan')
      const rowSpan = attributeInteger(cellMatch[2], 'rowspan')
      if (columnSpan === null || rowSpan === null) return null
      const sourceScope = attributeValue(cellMatch[2], 'scope')
      const headerScope =
        cellMatch[1].toLowerCase() !== 'th'
          ? null
          : sourceScope === 'row'
            ? 'row'
            : sourceScope === 'col' || sourceScope === 'column'
              ? 'column'
              : rows.length === 0
                ? 'column'
                : 'row'
      cells.push({
        text: decodeHtmlText(cellMatch[3]),
        headerScope,
        columnSpan,
        rowSpan,
      })
    }
    rows.push({ cells })
  }
  const table = { rows }
  return isStrictSemanticTable(table) ? table : null
}
