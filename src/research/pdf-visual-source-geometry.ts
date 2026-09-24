import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
} from './import-types'
import {
  captionSourceLaneMatches,
  horizontalBoxOverlap,
  rounded,
  type SourceHorizontalBounds,
} from './pdf-visual-matching'

export const TABLE_SOURCE_CROP_RETRY_PADDINGS = [
  0.006, 0.008, 0.01, 0.012, 0.014, 0.016, 0.02, 0.024, 0.028, 0.032,
] as const
const TABLE_SOURCE_CROP_RELATIVE_RETRY_FRACTIONS = [
  0.1, 0.15, 0.2, 0.25,
] as const

export function nextSourceRegions(
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  kind: 'table' | 'equation',
) {
  const maximumDistance = kind === 'table' ? 0.16 : 0.1
  const eligible = regions.filter((region) => {
    return (
      region.page === caption.page &&
      region.id !== caption.id &&
      region.lines.length > 0 &&
      captionSourceLaneMatches(caption, region) &&
      (kind === 'table'
        ? ['body', 'spanning', 'chart-label', 'side', 'footnote'].includes(
            region.kind,
          )
        : ['body', 'spanning', 'equation'].includes(region.kind))
    )
  })
  const below = eligible
    .filter((region) => {
      const distance = region.box.y - (caption.box.y + caption.box.height)
      return distance >= -0.004 && distance <= maximumDistance
    })
    .sort((left, right) => left.box.y - right.box.y)
  if (kind !== 'table') return below.slice(0, 1)
  const above = eligible
    .filter((region) => {
      const distance = caption.box.y - (region.box.y + region.box.height)
      return distance >= -0.004 && distance <= maximumDistance
    })
    .sort((left, right) => left.box.y - right.box.y)
  return above.length > 0 ? above : below
}

export function tableRowBandCount(lines: PdfPageRegion['lines']) {
  const rows: number[] = []
  for (const line of lines) {
    if (line.runs.every((run) => !run.text.trim())) continue
    if (!rows.some((y) => Math.abs(y - line.box.y) <= 0.004))
      rows.push(line.box.y)
  }
  return rows.length
}

export function unionBox(regions: PdfPageRegion[]): NormalizedSourceBox {
  const left = Math.min(...regions.map((region) => region.box.x))
  const top = Math.min(...regions.map((region) => region.box.y))
  const right = Math.max(
    ...regions.map((region) => region.box.x + region.box.width),
  )
  const bottom = Math.max(
    ...regions.map((region) => region.box.y + region.box.height),
  )
  return {
    page: regions[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: regions[0].box.rotation,
    method: regions.some((region) => region.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

export function boxForLines(
  lines: PdfPageRegion['lines'],
): NormalizedSourceBox {
  const left = Math.min(...lines.map((line) => line.box.x))
  const top = Math.min(...lines.map((line) => line.box.y))
  const right = Math.max(...lines.map((line) => line.box.x + line.box.width))
  const bottom = Math.max(...lines.map((line) => line.box.y + line.box.height))
  return {
    page: lines[0].box.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: lines[0].box.rotation,
    method: lines.some((line) => line.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

export function exactSourceLinesById(
  regions: readonly PdfPageRegion[],
  sourceLineIds: readonly string[],
): PdfRegionLine[] | null {
  if (
    sourceLineIds.length === 0 ||
    new Set(sourceLineIds).size !== sourceLineIds.length
  ) {
    return null
  }
  const selectedIds = new Set(sourceLineIds)
  const owners = new Map<string, PdfRegionLine[]>()
  for (const region of regions) {
    for (const line of region.lines) {
      if (!selectedIds.has(line.id)) continue
      const matching = owners.get(line.id) ?? []
      matching.push(line)
      owners.set(line.id, matching)
    }
  }
  const selected = sourceLineIds.flatMap((lineId) => {
    const matching = owners.get(lineId)
    return matching?.length === 1 ? matching : []
  })
  if (
    selected.length !== sourceLineIds.length ||
    selected.some(
      (line) =>
        line.box.page !== selected[0].box.page ||
        line.box.rotation !== selected[0].box.rotation,
    )
  ) {
    return null
  }
  return selected
}

export function availableRegionsForTable(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  consumedLineIds: ReadonlySet<string>,
  reservedFigureLineIds: ReadonlySet<string>,
  unavailableSourceObjectIds: ReadonlySet<string>,
) {
  return regions.flatMap((region) => {
    if (region.kind === 'caption') return [region]
    if (consumedRegionIds.has(region.id)) return []
    const retainedLines = region.lines.filter(
      (line) =>
        !consumedLineIds.has(line.id) && !reservedFigureLineIds.has(line.id),
    )
    const retainedNativeObjectIds = region.nativeObjectIds.filter(
      (sourceObjectId) => !unavailableSourceObjectIds.has(sourceObjectId),
    )
    if (
      retainedLines.length === region.lines.length &&
      retainedNativeObjectIds.length === region.nativeObjectIds.length
    ) {
      return [region]
    }
    if (retainedLines.length === 0 && retainedNativeObjectIds.length === 0) {
      return []
    }
    return [
      {
        ...region,
        text: retainedLines.map((line) => line.text).join(' '),
        box: retainedLines.length > 0 ? boxForLines(retainedLines) : region.box,
        lines: retainedLines,
        nativeObjectIds: retainedNativeObjectIds,
      },
    ]
  })
}

export function paddedUnionBox(
  boxes: NormalizedSourceBox[],
  horizontalBounds?: SourceHorizontalBounds,
) {
  const padding = 0.004
  const left = Math.max(
    horizontalBounds?.left ?? 0,
    Math.min(...boxes.map((box) => box.x)) - padding,
  )
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - padding)
  const right = Math.min(
    horizontalBounds?.right ?? 1,
    Math.max(...boxes.map((box) => box.x + box.width)) + padding,
  )
  const bottom = Math.min(
    1,
    Math.max(...boxes.map((box) => box.y + box.height)) + padding,
  )
  return {
    page: boxes[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: boxes[0].rotation,
    method: 'pdf-object' as const,
  }
}

export function verticalBoxOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
}

export function materiallyOverlappingSourceBoxes(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const horizontalOverlap = horizontalBoxOverlap(left, right)
  const verticalOverlap = verticalBoxOverlap(left, right)
  return (
    horizontalOverlap >= Math.min(left.width, right.width) * 0.5 &&
    verticalOverlap >= Math.min(left.height, right.height) * 0.35
  )
}

export function paddedEquationCropBox(
  sourceBox: NormalizedSourceBox,
  desiredPadding: number,
) {
  const left = Math.max(0, sourceBox.x - desiredPadding)
  const top = Math.max(0, sourceBox.y - desiredPadding)
  const right = Math.min(1, sourceBox.x + sourceBox.width + desiredPadding)
  const bottom = Math.min(1, sourceBox.y + sourceBox.height + desiredPadding)
  return {
    page: sourceBox.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: sourceBox.rotation,
    method: 'pdf-object' as const,
  }
}

export function tableSourceCropRetryPaddings(sourceBox: NormalizedSourceBox) {
  return [
    ...new Set(
      [
        ...TABLE_SOURCE_CROP_RETRY_PADDINGS,
        ...TABLE_SOURCE_CROP_RELATIVE_RETRY_FRACTIONS.map(
          (fraction) => sourceBox.width * fraction,
        ),
      ].map(rounded),
    ),
  ].sort((left, right) => left - right)
}

export function neighborBoundedCropBoxes(
  sourceBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
  desiredPadding: number,
  neighborGapFraction = 0.25,
  horizontalBounds?: SourceHorizontalBounds,
) {
  const padded = paddedEquationCropBox(sourceBox, desiredPadding)
  const desired = {
    left: padded.x,
    top: padded.y,
    right: padded.x + padded.width,
    bottom: padded.y + padded.height,
  }
  const seenLineIds = new Set<string>()
  const neighboringLines = regions.flatMap((region) =>
    region.page !== sourceBox.page
      ? []
      : region.lines.filter((line) => {
          if (sourceLineIds.has(line.id) || seenLineIds.has(line.id)) {
            return false
          }
          seenLineIds.add(line.id)
          return true
        }),
  )
  // A single logical line can have runs on both sides of a stacked glyph.
  // Bound horizontal padding from the physical run edges so the crop does
  // not take a sliver of either neighboring glyph merely because their
  // enclosing line box spans across the owned source box.
  const neighboringHorizontalBoxes = neighboringLines.flatMap((line) => {
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    return visibleRuns.length > 0
      ? visibleRuns.map((run) => ({
          page: run.page,
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
          rotation: run.rotation,
          method: run.method,
        }))
      : [{ ...line.box }]
  })
  const nearestAbove = Math.max(
    ...neighboringLines
      .filter(
        (line) =>
          line.box.y + line.box.height <= sourceBox.y &&
          horizontalBoxOverlap(line.box, sourceBox) > 0,
      )
      .map((line) => line.box.y + line.box.height),
    0,
  )
  const nearestBelow = Math.min(
    ...neighboringLines
      .filter(
        (line) =>
          line.box.y >= sourceBox.y + sourceBox.height &&
          horizontalBoxOverlap(line.box, sourceBox) > 0,
      )
      .map((line) => line.box.y),
    1,
  )
  const nearestLeft = Math.max(
    ...neighboringHorizontalBoxes
      .filter(
        (box) =>
          box.x + box.width <= sourceBox.x &&
          verticalBoxOverlap(box, sourceBox) > 0,
      )
      .map((box) => box.x + box.width),
    0,
  )
  const nearestRight = Math.min(
    ...neighboringHorizontalBoxes
      .filter(
        (box) =>
          box.x >= sourceBox.x + sourceBox.width &&
          verticalBoxOverlap(box, sourceBox) > 0,
      )
      .map((box) => box.x),
    1,
  )
  const bounds = {
    top:
      nearestAbove > 0 && desired.top <= nearestAbove
        ? sourceBox.y - (sourceBox.y - nearestAbove) * neighborGapFraction
        : null,
    bottom:
      nearestBelow < 1 && desired.bottom >= nearestBelow
        ? sourceBox.y +
          sourceBox.height +
          (nearestBelow - (sourceBox.y + sourceBox.height)) *
            neighborGapFraction
        : null,
    left:
      nearestLeft > 0 && desired.left <= nearestLeft
        ? sourceBox.x - (sourceBox.x - nearestLeft) * neighborGapFraction
        : null,
    right:
      nearestRight < 1 && desired.right >= nearestRight
        ? sourceBox.x +
          sourceBox.width +
          (nearestRight - (sourceBox.x + sourceBox.width)) * neighborGapFraction
        : null,
  }
  const left = Math.max(
    horizontalBounds?.left ?? 0,
    bounds.left ?? desired.left,
  )
  const top = bounds.top ?? desired.top
  const right = Math.min(
    horizontalBounds?.right ?? 1,
    bounds.right ?? desired.right,
  )
  const bottom = bounds.bottom ?? desired.bottom
  return [
    {
      page: sourceBox.page,
      x: rounded(left),
      y: rounded(top),
      width: rounded(right - left),
      height: rounded(bottom - top),
      rotation: sourceBox.rotation,
      method: 'pdf-object' as const,
    },
  ]
}
