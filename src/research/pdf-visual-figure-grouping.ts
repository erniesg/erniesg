import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageRegion,
} from './import-types'
import { PdfImportError } from './import-types'
import {
  captionSourceLaneMatchesBox,
  FIGURE_OVERLAY_BOX_TOLERANCE,
  horizontalOverlapRatio,
  rounded,
} from './pdf-visual-matching'
import { isLargeVectorBox } from './pdf-visual-native-artifacts'

const MIN_ADJACENT_PANEL_FIGURE_SPAN = 0.6
export const MAX_SINGLE_COLUMN_FIGURE_WIDTH = 0.55
const MAX_ADJACENT_PANEL_GAP = 0.1
export const PDF_VISUAL_COOPERATIVE_BATCH_SIZE = 8
export const PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE = 64

export function throwIfPdfVisualWorkAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw new PdfImportError(
    'IMPORT_CANCELLED',
    'The local PDF reconstruction was cancelled and its working data was released.',
  )
}

export async function yieldPdfVisualTask(signal?: AbortSignal) {
  throwIfPdfVisualWorkAborted(signal)
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  throwIfPdfVisualWorkAborted(signal)
}

export function boxGap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
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

export function narrowCaptionClaimsOneColumn(
  left: PdfPageRegion,
  right: PdfPageRegion,
  captions: PdfPageRegion[],
) {
  const gap = boxGap(left.box, right.box)
  if (
    gap.horizontal === 0 ||
    left.box.width > MAX_SINGLE_COLUMN_FIGURE_WIDTH ||
    right.box.width > MAX_SINGLE_COLUMN_FIGURE_WIDTH
  ) {
    return false
  }
  return captions.some((caption) => {
    if (caption.page !== left.page) return false
    const claims = (region: PdfPageRegion) => {
      const verticalGap = caption.box.y - (region.box.y + region.box.height)
      return (
        verticalGap >= -0.004 &&
        verticalGap <= 0.08 &&
        horizontalOverlapRatio(caption.box, region.box) >= 0.35
      )
    }
    const leftClaimed = claims(left)
    const rightClaimed = claims(right)
    return (
      (leftClaimed && horizontalOverlapRatio(caption.box, right.box) < 0.1) ||
      (rightClaimed && horizontalOverlapRatio(caption.box, left.box) < 0.1)
    )
  })
}

export function captionSeparates(
  left: PdfPageRegion,
  right: PdfPageRegion,
  captions: PdfPageRegion[],
) {
  const leftCenter = left.box.y + left.box.height / 2
  const rightCenter = right.box.y + right.box.height / 2
  const top = Math.min(leftCenter, rightCenter)
  const bottom = Math.max(leftCenter, rightCenter)
  if (bottom - top <= 0.01) return false
  return captions.some((caption) => {
    if (caption.page !== left.page) return false
    const center = caption.box.y + caption.box.height / 2
    if (center <= top || center >= bottom) return false
    return [left, right].every((region) => {
      const overlap = Math.max(
        0,
        Math.min(
          caption.box.x + caption.box.width,
          region.box.x + region.box.width,
        ) - Math.max(caption.box.x, region.box.x),
      )
      return overlap >= Math.min(caption.box.width, region.box.width) * 0.35
    })
  })
}

export function connected(
  left: PdfPageRegion,
  right: PdfPageRegion,
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
) {
  if (left.page !== right.page) return false
  const gap = boxGap(left.box, right.box)
  const geometricallyConnected =
    (gap.vertical === 0 && gap.horizontal <= FIGURE_CONNECTIVITY_GAP) ||
    (gap.horizontal === 0 && gap.vertical <= FIGURE_CONNECTIVITY_GAP)
  const verticalOverlap = Math.max(
    0,
    Math.min(left.box.y + left.box.height, right.box.y + right.box.height) -
      Math.max(left.box.y, right.box.y),
  )
  const adjacentImagePanelCandidate =
    gap.vertical === 0 &&
    gap.horizontal <= MAX_ADJACENT_PANEL_GAP &&
    verticalOverlap >= Math.min(left.box.height, right.box.height) * 0.7 &&
    left.nativeObjectIds.some((id) => id.startsWith('image-')) &&
    right.nativeObjectIds.some((id) => id.startsWith('image-'))
  if (!geometricallyConnected && !adjacentImagePanelCandidate) return false
  if (captionSeparates(left, right, captions)) return false
  if (narrowCaptionClaimsOneColumn(left, right, captions)) return false
  return (
    geometricallyConnected ||
    adjacentPanelLabelOverlays([left, right], regions, captions).length === 2
  )
}

export function isDecorativeVectorArtifact(
  region: PdfPageRegion,
  decorativeObjectIds: Set<string>,
) {
  const vectorOnly = region.nativeObjectIds.every((id) =>
    id.startsWith('vector-'),
  )
  return (
    region.box.method === 'pdf-object' &&
    vectorOnly &&
    region.nativeObjectIds.every((id) => decorativeObjectIds.has(id))
  )
}

export function isLargeVectorArtifact(region: PdfPageRegion) {
  return (
    region.box.method === 'pdf-object' &&
    region.nativeObjectIds.every((id) => id.startsWith('vector-')) &&
    isLargeVectorBox(region.box)
  )
}

export function containsCenter(
  container: PdfPageRegion,
  candidate: PdfPageRegion,
) {
  const x = candidate.box.x + candidate.box.width / 2
  const y = candidate.box.y + candidate.box.height / 2
  return (
    x >= container.box.x - 0.004 &&
    x <= container.box.x + container.box.width + 0.004 &&
    y >= container.box.y - 0.004 &&
    y <= container.box.y + container.box.height + 0.004
  )
}

export function unionObjectBox(regions: PdfPageRegion[]): NormalizedSourceBox {
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
    method: 'pdf-object',
  }
}

export function owningCaptionForBox(
  box: NormalizedSourceBox,
  captions: PdfPageRegion[],
) {
  return captions
    .filter((candidate) => {
      if (candidate.page !== box.page || candidate.box.y < box.y) return false
      if (
        candidate.sourceCaptionLane &&
        !captionSourceLaneMatchesBox(candidate, box, 'span')
      ) {
        return false
      }
      const overlap = Math.max(
        0,
        Math.min(candidate.box.x + candidate.box.width, box.x + box.width) -
          Math.max(candidate.box.x, box.x),
      )
      return overlap >= Math.min(candidate.box.width, box.width) * 0.35
    })
    .sort((left, right) => left.box.y - right.box.y)[0]
}

export function adjacentPanelLabelOverlays(
  group: PdfPageRegion[],
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
) {
  if (
    group.length < 2 ||
    !group.every((region) =>
      region.nativeObjectIds.some((id) => id.startsWith('image-')),
    )
  ) {
    return []
  }
  const nativeBox = unionObjectBox(group)
  const caption = owningCaptionForBox(nativeBox, captions)
  if (
    !caption ||
    nativeBox.width < MIN_ADJACENT_PANEL_FIGURE_SPAN ||
    caption.box.width < nativeBox.width * 0.75
  ) {
    return []
  }
  const panels = [...group].sort(
    (left, right) =>
      left.box.x - right.box.x || left.id.localeCompare(right.id),
  )
  const samePanelBand = panels.every((panel) => {
    const overlap = Math.max(
      0,
      Math.min(
        panels[0].box.y + panels[0].box.height,
        panel.box.y + panel.box.height,
      ) - Math.max(panels[0].box.y, panel.box.y),
    )
    return overlap >= Math.min(panels[0].box.height, panel.box.height) * 0.7
  })
  if (!samePanelBand) return []

  const panelBottom = Math.max(
    ...panels.map((panel) => panel.box.y + panel.box.height),
  )
  const candidates = regions
    .filter(
      (region) =>
        region.page === nativeBox.page &&
        region.includedInReadingOrder &&
        region.nativeObjectIds.length === 0 &&
        region.lines.length > 0 &&
        ['body', 'spanning'].includes(region.kind) &&
        /^\s*\([a-z0-9ivxlcdm]+\)\s+\p{L}/iu.test(region.text) &&
        region.box.y >= panelBottom - 0.012 &&
        region.box.y + region.box.height <=
          caption.box.y + FIGURE_OVERLAY_BOX_TOLERANCE,
    )
    .sort(
      (left, right) =>
        left.box.x - right.box.x ||
        left.box.y - right.box.y ||
        left.id.localeCompare(right.id),
    )
  if (candidates.length !== panels.length) return []

  const assignedPanelIndexes = candidates.map((candidate) => {
    const overlaps = panels.map((panel) => {
      const overlap = Math.max(
        0,
        Math.min(
          candidate.box.x + candidate.box.width,
          panel.box.x + panel.box.width,
        ) - Math.max(candidate.box.x, panel.box.x),
      )
      return overlap / Math.min(candidate.box.width, panel.box.width)
    })
    const best = Math.max(...overlaps)
    const bestIndex = overlaps.indexOf(best)
    const runnerUp = Math.max(
      ...overlaps.filter((_overlap, index) => index !== bestIndex),
      0,
    )
    return best >= 0.7 && best - runnerUp >= 0.2 ? bestIndex : -1
  })
  return assignedPanelIndexes.every((index) => index >= 0) &&
    new Set(assignedPanelIndexes).size === panels.length
    ? candidates
    : []
}

export function probablePanelLabelOverlayRegion(region: PdfPageRegion) {
  return (
    region.includedInReadingOrder &&
    region.nativeObjectIds.length === 0 &&
    region.lines.length > 0 &&
    ['body', 'spanning'].includes(region.kind) &&
    /^\s*\([a-z0-9ivxlcdm]+\)\s+\p{L}/iu.test(region.text)
  )
}

const FIGURE_CONNECTIVITY_CELL_SIZE = 0.08
const FIGURE_CONNECTIVITY_GAP = 0.04

export function figureConnectivityCells(
  box: NormalizedSourceBox,
  expansion = 0,
) {
  const left = Math.floor((box.x - expansion) / FIGURE_CONNECTIVITY_CELL_SIZE)
  const top = Math.floor((box.y - expansion) / FIGURE_CONNECTIVITY_CELL_SIZE)
  const right = Math.floor(
    (box.x + box.width + expansion) / FIGURE_CONNECTIVITY_CELL_SIZE,
  )
  const bottom = Math.floor(
    (box.y + box.height + expansion) / FIGURE_CONNECTIVITY_CELL_SIZE,
  )
  const cells: string[] = []
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      cells.push(`${box.page}:${x}:${y}`)
    }
  }
  return cells
}

export function figureRegionSpatialIndex(regions: readonly PdfPageRegion[]) {
  const cells = new Map<string, PdfPageRegion[]>()
  for (const region of regions) {
    for (const key of figureConnectivityCells(region.box)) {
      const values = cells.get(key) ?? []
      values.push(region)
      cells.set(key, values)
    }
  }
  return {
    query(box: NormalizedSourceBox, expansion = 0) {
      return [
        ...new Map(
          figureConnectivityCells(box, expansion)
            .flatMap((key) => cells.get(key) ?? [])
            .map((region) => [region.id, region] as const),
        ).values(),
      ]
    },
    provesCompositeScaffold(region: PdfPageRegion) {
      if (!isLargeVectorArtifact(region)) return false
      const area = region.box.width * region.box.height
      let containedCount = 0
      let containsImage = false
      const examined = new Set<string>()
      for (const key of figureConnectivityCells(region.box)) {
        for (const candidate of cells.get(key) ?? []) {
          if (candidate.id === region.id || examined.has(candidate.id)) {
            continue
          }
          examined.add(candidate.id)
          if (
            candidate.box.width * candidate.box.height >= area * 0.9 ||
            !containsCenter(region, candidate)
          ) {
            continue
          }
          containedCount += 1
          containsImage ||= candidate.nativeObjectIds.some((id) =>
            id.startsWith('image-'),
          )
          if (containedCount >= 2 && (containsImage || containedCount >= 4)) {
            return true
          }
        }
      }
      return false
    },
  }
}

export function mutableFigureRegionSpatialIndex(
  regions: readonly PdfPageRegion[],
) {
  const cells = new Map<string, Set<number>>()
  const regionCells = regions.map((region, index) => {
    const keys = figureConnectivityCells(region.box)
    for (const key of keys) {
      const values = cells.get(key) ?? new Set<number>()
      values.add(index)
      cells.set(key, values)
    }
    return keys
  })
  return {
    remove(index: number) {
      for (const key of regionCells[index]) {
        const values = cells.get(key)
        values?.delete(index)
        if (values?.size === 0) cells.delete(key)
      }
    },
    query(box: NormalizedSourceBox, expansion: number) {
      const indexes = new Set<number>()
      for (const key of figureConnectivityCells(box, expansion)) {
        for (const index of cells.get(key) ?? []) indexes.add(index)
      }
      return [...indexes].sort((left, right) => left - right)
    },
  }
}

export type PdfFigureGroupingEvidence = {
  figureRegionCount: number
  retainedFigureRegionCount: number
  connectivityComparisons: number
  groupCount: number
}

export async function connectedFigureRegionGroups({
  figureRegions,
  panelLabelRegionsByPage,
  captionsByPage,
  decorativeObjectIds,
  pageBackdropObjectIds,
  evidence,
  onProgress,
  signal,
}: {
  figureRegions: PdfPageRegion[]
  panelLabelRegionsByPage: ReadonlyMap<number, PdfPageRegion[]>
  captionsByPage: ReadonlyMap<number, PdfPageRegion[]>
  decorativeObjectIds: Set<string>
  pageBackdropObjectIds: Set<string>
  evidence: PdfFigureGroupingEvidence
  onProgress?: (progress: PdfImportProgress) => void
  signal?: AbortSignal
}) {
  const allFigureIndex = figureRegionSpatialIndex(figureRegions)
  const retained: PdfPageRegion[] = []
  for (const [regionIndex, region] of figureRegions.entries()) {
    if (
      !region.nativeObjectIds.some((id) => pageBackdropObjectIds.has(id)) &&
      (!isDecorativeVectorArtifact(region, decorativeObjectIds) ||
        allFigureIndex.provesCompositeScaffold(region))
    ) {
      retained.push(region)
    }
    if ((regionIndex + 1) % PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE === 0) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: regionIndex + 1,
        total: figureRegions.length,
        message: `Filtering bounded native figure regions ${regionIndex + 1} of ${figureRegions.length}…`,
        checkpoint: 'figure-grouping-filter',
      })
      await yieldPdfVisualTask(signal)
    }
  }
  evidence.retainedFigureRegionCount = retained.length
  const retainedIndex = mutableFigureRegionSpatialIndex(retained)
  const assigned = new Set<number>()
  const groups: PdfPageRegion[][] = []
  let cooperativeWork = 0
  let lastYieldedCooperativeWork = 0
  for (const seedIndex of retained.keys()) {
    if (assigned.has(seedIndex)) continue
    assigned.add(seedIndex)
    retainedIndex.remove(seedIndex)
    const memberIndexes: number[] = []
    const frontier = [seedIndex]
    for (
      let frontierIndex = 0;
      frontierIndex < frontier.length;
      frontierIndex += 1
    ) {
      const leftIndex = frontier[frontierIndex]
      const left = retained[leftIndex]
      memberIndexes.push(leftIndex)
      cooperativeWork += 1
      const pagePanelLabelRegions = panelLabelRegionsByPage.get(left.page) ?? []
      const pageCaptions = captionsByPage.get(left.page) ?? []
      const expansion = left.nativeObjectIds.some((id) =>
        id.startsWith('image-'),
      )
        ? MAX_ADJACENT_PANEL_GAP
        : FIGURE_CONNECTIVITY_GAP
      for (const rightIndex of retainedIndex.query(left.box, expansion)) {
        const right = retained[rightIndex]
        evidence.connectivityComparisons += 1
        cooperativeWork += 1
        if (!connected(left, right, pagePanelLabelRegions, pageCaptions)) {
          if (
            cooperativeWork - lastYieldedCooperativeWork >=
            PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE
          ) {
            onProgress?.({
              phase: 'semantic-promotion',
              completed: assigned.size,
              total: retained.length,
              message: `Grouping ${assigned.size} of ${retained.length} retained native figure regions…`,
              checkpoint: 'figure-grouping-connectivity',
            })
            await yieldPdfVisualTask(signal)
            lastYieldedCooperativeWork = cooperativeWork
          }
          continue
        }
        assigned.add(rightIndex)
        retainedIndex.remove(rightIndex)
        frontier.push(rightIndex)
        if (
          cooperativeWork - lastYieldedCooperativeWork >=
          PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE
        ) {
          onProgress?.({
            phase: 'semantic-promotion',
            completed: assigned.size,
            total: retained.length,
            message: `Grouping ${assigned.size} of ${retained.length} retained native figure regions…`,
            checkpoint: 'figure-grouping-connectivity',
          })
          await yieldPdfVisualTask(signal)
          lastYieldedCooperativeWork = cooperativeWork
        }
      }
      if (
        cooperativeWork - lastYieldedCooperativeWork >=
        PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE
      ) {
        onProgress?.({
          phase: 'semantic-promotion',
          completed: assigned.size,
          total: retained.length,
          message: `Grouping ${assigned.size} of ${retained.length} retained native figure regions…`,
          checkpoint: 'figure-grouping-connectivity',
        })
        await yieldPdfVisualTask(signal)
        lastYieldedCooperativeWork = cooperativeWork
      }
    }
    groups.push(
      memberIndexes
        .sort((left, right) => left - right)
        .map((index) => retained[index]),
    )
  }
  evidence.groupCount = groups.length
  return groups
}
