import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import type { PdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  captionLaneHorizontalBounds,
  captionSourceLaneMatchesBox,
  FIGURE_OVERLAY_BOX_TOLERANCE,
  horizontalOverlapRatio,
  rounded,
  SOURCE_CROP_CONTAINMENT_TOLERANCE,
  sourceBoxWithinHorizontalBounds,
  TEXT_OVERLAY_PREFIX,
  type SourceHorizontalBounds,
  type VisualCandidate,
} from './pdf-visual-matching'
import {
  boxForLines,
  materiallyOverlappingSourceBoxes,
  paddedUnionBox,
} from './pdf-visual-source-geometry'
import { samePdfSourceBox as sameSourceBox } from './pdf-visual-source-crops'

type PdfNativeObject = NonNullable<PdfPageAnalysis['objects']>[number]

export const MIN_COMPOSITE_FIGURE_FRAGMENTS = 2
export const MIN_FIGURE_OVERLAY_RENDER_CONTAINMENT = 0.95
export const MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT = 2
export const MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT = 8
export const CAPTION_BOUNDED_PANEL_EDGE_RETRY_PADDING = 0.012
export const CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING = 0.018
export const CAPTION_BOUNDED_PANEL_BOTTOM_INSET = 0.008
export const MAX_CAPTION_BOUNDED_PANEL_RECOVERY_ATTEMPTS = 8

export function fullyContainsBox(
  container: NormalizedSourceBox,
  candidate: NormalizedSourceBox,
  tolerance: number,
) {
  return (
    container.page === candidate.page &&
    container.rotation === candidate.rotation &&
    candidate.x >= container.x - tolerance &&
    candidate.y >= container.y - tolerance &&
    candidate.x + candidate.width <=
      container.x + container.width + tolerance &&
    candidate.y + candidate.height <= container.y + container.height + tolerance
  )
}

export function intersectionArea(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  if (left.page !== right.page || left.rotation !== right.rotation) return 0
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
  return width * height
}

export function intersectSourceBox(
  scope: NormalizedSourceBox,
  source: NormalizedSourceBox,
) {
  if (scope.page !== source.page || scope.rotation !== source.rotation) {
    return null
  }
  const left = Math.max(scope.x, source.x)
  const top = Math.max(scope.y, source.y)
  const right = Math.min(scope.x + scope.width, source.x + source.width)
  const bottom = Math.min(scope.y + scope.height, source.y + source.height)
  if (right <= left || bottom <= top) return null
  const clipped = {
    ...source,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
  }
  return clipped.width > 0 && clipped.height > 0 ? clipped : null
}

export function sourceLineageWithinRenderScope(
  candidate: VisualCandidate,
  sourceCropBox: NormalizedSourceBox,
) {
  if (candidate.kind !== 'figure' || !candidate.renderBox) {
    return {
      sourceObjectIds: candidate.sourceObjectIds,
      sourceBoxes: candidate.sourceBoxes,
      clipped: false,
    }
  }
  const retained = candidate.sourceObjectIds.flatMap(
    (sourceObjectId, index) => {
      const sourceBox = candidate.sourceBoxes[index]
      const clippedBox = intersectSourceBox(sourceCropBox, sourceBox)
      return clippedBox ? [{ sourceObjectId, sourceBox, clippedBox }] : []
    },
  )
  return {
    sourceObjectIds: retained.map((item) => item.sourceObjectId),
    sourceBoxes: retained.map((item) => item.clippedBox),
    clipped:
      retained.length !== candidate.sourceObjectIds.length ||
      retained.some((item) => !sameSourceBox(item.sourceBox, item.clippedBox)),
  }
}

export function projectFigureLineageToAcceptedSourceCrop(
  candidate: VisualCandidate,
  sourceCrop: PdfVisualAsset,
  sourceCropBox: NormalizedSourceBox,
  caption: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const sourceRegionIds = candidate.sourceRegionIds.filter((sourceRegionId) => {
    const sourceRegion = regions.find((region) => region.id === sourceRegionId)
    return Boolean(
      sourceRegion && intersectSourceBox(sourceCropBox, sourceRegion.box),
    )
  })
  const sourceObjectIds = [...sourceCrop.sourceObjectIds]
  const sourceBoxes = sourceCrop.sourceBoxes.map((sourceBox) => ({
    ...sourceBox,
  }))
  const syntheticPanelRecovery = sourceObjectIds.some((sourceObjectId) =>
    sourceObjectId.startsWith('source-panel:'),
  )
  if (!caption.sourceCaptionLane) {
    if (!syntheticPanelRecovery) {
      return {
        sourceObjectIds,
        sourceBoxes,
        sourceRegionIds,
        sourceLineIds: candidate.sourceLineIds,
        sourceText: candidate.sourceText,
      }
    }
    const retainedSourceLineIds = new Set(
      regions.flatMap((region) =>
        sourceRegionIds.includes(region.id)
          ? region.lines.flatMap((line) =>
              intersectSourceBox(sourceCropBox, line.box) ? [line.id] : [],
            )
          : [],
      ),
    )
    return {
      sourceObjectIds,
      sourceBoxes,
      sourceRegionIds,
      sourceLineIds: candidate.sourceLineIds?.filter((sourceLineId) =>
        retainedSourceLineIds.has(sourceLineId),
      ),
      sourceText: regions
        .filter((region) => sourceRegionIds.includes(region.id))
        .flatMap((region) =>
          region.lines.filter((line) => retainedSourceLineIds.has(line.id)),
        )
        .map((line) => line.text)
        .join(' '),
    }
  }

  const explicitSourceLineIds = candidate.sourceLineIds?.length
    ? new Set(candidate.sourceLineIds)
    : null
  const horizontalBounds = captionLaneHorizontalBounds(caption)
  const retainedTextRegionIds = new Set<string>()
  const retainedSourceLineIds: string[] = []
  const retainedSourceText: string[] = []
  const seenSourceLineIds = new Set<string>()
  for (const sourceRegionId of sourceRegionIds) {
    const sourceRegion = regions.find((region) => region.id === sourceRegionId)
    if (!sourceRegion || sourceRegion.lines.length === 0) continue
    for (const line of sourceRegion.lines) {
      if (
        seenSourceLineIds.has(line.id) ||
        (explicitSourceLineIds && !explicitSourceLineIds.has(line.id)) ||
        !line.text.trim() ||
        !fullyContainsBox(
          sourceCropBox,
          line.box,
          SOURCE_CROP_CONTAINMENT_TOLERANCE,
        ) ||
        !sourceBoxWithinHorizontalBounds(line.box, horizontalBounds)
      ) {
        continue
      }
      seenSourceLineIds.add(line.id)
      retainedTextRegionIds.add(sourceRegionId)
      retainedSourceLineIds.push(line.id)
      retainedSourceText.push(line.text)
    }
  }
  return {
    sourceObjectIds,
    sourceBoxes,
    sourceRegionIds: sourceRegionIds.filter((sourceRegionId) => {
      const sourceRegion = regions.find(
        (region) => region.id === sourceRegionId,
      )
      return Boolean(
        sourceRegion &&
        (sourceRegion.lines.length === 0 ||
          sourceRegion.nativeObjectIds.length > 0 ||
          retainedTextRegionIds.has(sourceRegionId)),
      )
    }),
    sourceLineIds: retainedSourceLineIds,
    sourceText: retainedSourceText.join(' '),
  }
}

export function renderScopeContainsCompleteFigureLineage(
  candidate: VisualCandidate,
  sourceCropBox: NormalizedSourceBox,
  regions: readonly PdfPageRegion[],
) {
  if (
    candidate.kind !== 'figure' ||
    candidate.sourceObjectIds.length === 0 ||
    candidate.sourceObjectIds.length !== candidate.sourceBoxes.length ||
    candidate.sourceRegionIds.length === 0 ||
    candidate.sourceBoxes.some(
      (sourceBox) =>
        !fullyContainsBox(
          sourceCropBox,
          sourceBox,
          SOURCE_CROP_CONTAINMENT_TOLERANCE,
        ),
    )
  ) {
    return false
  }
  return candidate.sourceRegionIds.every((sourceRegionId) => {
    const sourceRegion = regions.find((region) => region.id === sourceRegionId)
    return Boolean(
      sourceRegion &&
      fullyContainsBox(
        sourceCropBox,
        sourceRegion.box,
        SOURCE_CROP_CONTAINMENT_TOLERANCE,
      ),
    )
  })
}

export function nativeOnlyFigureCandidate(
  candidate: VisualCandidate,
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null | undefined>,
) {
  if (
    candidate.kind !== 'figure' ||
    !candidate.sourcePageCropBlockedByReadingOrderText
  ) {
    return candidate
  }
  const nativeLineage = candidate.sourceObjectIds.flatMap(
    (sourceObjectId, index) =>
      sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)
        ? []
        : [
            {
              sourceObjectId,
              sourceBox: candidate.sourceBoxes[index],
            },
          ],
  )
  const nativeObjectIds = new Set(
    nativeLineage.map((item) => item.sourceObjectId),
  )
  return {
    ...candidate,
    sourceRegionIds: candidate.sourceRegionIds.filter((sourceRegionId) => {
      const sourceRegion = regions.find(
        (region) => region.id === sourceRegionId,
      )
      return Boolean(
        sourceRegion?.nativeObjectIds.some((sourceObjectId) =>
          nativeObjectIds.has(sourceObjectId),
        ),
      )
    }),
    sourceObjectIds: nativeLineage.map((item) => item.sourceObjectId),
    sourceBoxes: nativeLineage.map((item) => item.sourceBox),
    sourceLineIds: [],
    assetIds: nativeLineage
      .map((item) => objectAssetIds.get(item.sourceObjectId))
      .filter((assetId): assetId is string => Boolean(assetId)),
    sourceText: '',
  }
}

type ContainedFigureOverlay = {
  regionId: string
  lineIds: string[]
  sourceObjectId: string
  sourceBox: NormalizedSourceBox
  sourceText: string
}

export function explicitFigureOverlayLineage(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
  options: {
    containmentBox?: NormalizedSourceBox
    excludedLineIds?: ReadonlySet<string>
  } = {},
) {
  if (candidate.kind !== 'figure' || !candidate.renderBox) {
    return []
  }
  const containmentBox =
    options.containmentBox ?? candidate.textOwnershipBox ?? candidate.renderBox
  const regionsById = new Map(regions.map((region) => [region.id, region]))
  const overlays = new Map<string, ContainedFigureOverlay>()
  for (const sourceObjectId of candidate.sourceObjectIds) {
    if (!sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)) continue
    const regionId = sourceObjectId.slice(TEXT_OVERLAY_PREFIX.length)
    const region = regionsById.get(regionId)
    if (!region || region.lines.length === 0 || !region.text.trim()) continue
    const containedLines = region.lines
      .filter((line) => {
        const area = line.box.width * line.box.height
        return (
          line.text.trim().length > 0 &&
          !options.excludedLineIds?.has(line.id) &&
          area > 0 &&
          intersectionArea(line.box, containmentBox) / area >=
            MIN_FIGURE_OVERLAY_RENDER_CONTAINMENT
        )
      })
      .sort(
        (left, right) =>
          left.box.page - right.box.page ||
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    if (containedLines.length === 0) continue
    const sourceBox = boxForLines(containedLines)
    overlays.set(regionId, {
      regionId,
      lineIds: containedLines.map((line) => line.id),
      sourceObjectId,
      sourceBox,
      sourceText: containedLines.map((line) => line.text).join(' '),
    })
  }
  return [...overlays.values()].sort(
    (left, right) =>
      left.sourceBox.page - right.sourceBox.page ||
      left.sourceBox.y - right.sourceBox.y ||
      left.sourceBox.x - right.sourceBox.x ||
      left.regionId.localeCompare(right.regionId),
  )
}

export function containedFigureOverlayLineage(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
  options: {
    containmentBox?: NormalizedSourceBox
    excludedLineIds?: ReadonlySet<string>
  } = {},
) {
  return candidate.evidence?.includes('caption-bounded-native-scaffold')
    ? explicitFigureOverlayLineage(candidate, regions, options)
    : []
}

type ConnectedFigureReservationLineage = {
  nativeSourceObjectIds: string[]
  overlays: ContainedFigureOverlay[]
}

export function connectedFigureReservationLineage(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
): ConnectedFigureReservationLineage | null {
  if (
    candidate.kind !== 'figure' ||
    !candidate.renderBox ||
    !candidate.evidence?.includes('connected-native-scaffold') ||
    candidate.evidence.includes('caption-bounded-native-scaffold') ||
    candidate.sourceObjectIds.length !== candidate.sourceBoxes.length
  ) {
    return null
  }
  const nativeSourceObjectIds = candidate.sourceObjectIds.filter(
    (sourceObjectId) => !sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX),
  )
  const explicitOverlayObjectIds = candidate.sourceObjectIds.filter(
    (sourceObjectId) => sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX),
  )
  if (
    nativeSourceObjectIds.length === 0 ||
    explicitOverlayObjectIds.length === 0 ||
    candidate.sourceBoxes.some(
      (sourceBox) =>
        !fullyContainsBox(
          candidate.renderBox!,
          sourceBox,
          SOURCE_CROP_CONTAINMENT_TOLERANCE,
        ),
    )
  ) {
    return null
  }

  const overlays = explicitFigureOverlayLineage(candidate, regions, {
    containmentBox: candidate.renderBox,
  })
  const overlaysByObjectId = new Map(
    overlays.map((overlay) => [overlay.sourceObjectId, overlay]),
  )
  const regionsById = new Map(regions.map((region) => [region.id, region]))
  const completeExplicitOverlayLineage = explicitOverlayObjectIds.every(
    (sourceObjectId) => {
      const region = regionsById.get(
        sourceObjectId.slice(TEXT_OVERLAY_PREFIX.length),
      )
      const overlay = overlaysByObjectId.get(sourceObjectId)
      const visibleLineIds =
        region?.lines
          .filter((line) => line.text.trim())
          .map((line) => line.id)
          .sort() ?? []
      return (
        overlay !== undefined &&
        visibleLineIds.length > 0 &&
        overlay.lineIds.length === visibleLineIds.length &&
        [...overlay.lineIds]
          .sort()
          .every((lineId, index) => lineId === visibleLineIds[index])
      )
    },
  )
  return completeExplicitOverlayLineage &&
    overlays.length === explicitOverlayObjectIds.length
    ? { nativeSourceObjectIds, overlays }
    : null
}

export function captionToSourceBoxGap(
  caption: PdfPageRegion,
  sourceBox: NormalizedSourceBox,
) {
  const captionBottom = caption.box.y + caption.box.height
  const sourceBottom = sourceBox.y + sourceBox.height
  const gap =
    sourceBottom < caption.box.y
      ? caption.box.y - sourceBottom
      : captionBottom < sourceBox.y
        ? sourceBox.y - captionBottom
        : 0
  return gap <= FIGURE_OVERLAY_BOX_TOLERANCE ? 0 : gap
}

export function connectedFigureReservationContestedByTableCaption(
  candidate: VisualCandidate,
  ownerCaption: PdfPageRegion,
  captions: readonly PdfPageRegion[],
  regions: readonly PdfPageRegion[],
  captionLabels: ReadonlyMap<PdfPageRegion, PdfScholarlyVisualLabel>,
) {
  if (
    !candidate.renderBox ||
    !connectedFigureReservationLineage(candidate, regions)
  ) {
    return false
  }
  const ownerGap = captionToSourceBoxGap(ownerCaption, candidate.renderBox)
  if (ownerGap > 0.28) return true
  return captions.some((caption) => {
    const label = captionLabels.get(caption)
    if (
      caption.id === ownerCaption.id ||
      caption.page !== candidate.page ||
      label?.status !== 'parsed' ||
      label.kind !== 'table' ||
      !captionSourceLaneMatchesBox(
        caption,
        candidate.renderBox!,
        candidate.column,
      ) ||
      horizontalOverlapRatio(caption.box, candidate.renderBox!) < 0.35
    ) {
      return false
    }
    const tableGap = captionToSourceBoxGap(caption, candidate.renderBox!)
    return (
      tableGap <= 0.28 && tableGap <= ownerGap + FIGURE_OVERLAY_BOX_TOLERANCE
    )
  })
}

export function nativeContainedFigureOverlayLineage(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
) {
  const nativeSourceBoxes = candidate.sourceObjectIds.flatMap(
    (sourceObjectId, index) =>
      sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)
        ? []
        : [candidate.sourceBoxes[index]],
  )
  return nativeSourceBoxes.length > 0
    ? containedFigureOverlayLineage(candidate, regions, {
        containmentBox: paddedUnionBox(nativeSourceBoxes),
      })
    : []
}

export function strongFigureOwnershipKeys(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
) {
  const connectedLineage = connectedFigureReservationLineage(candidate, regions)
  if (connectedLineage) {
    return [
      ...connectedLineage.nativeSourceObjectIds.map(
        (sourceObjectId) => `native\u0000${sourceObjectId}`,
      ),
      ...connectedLineage.overlays.flatMap((overlay) =>
        overlay.lineIds.map((lineId) => `line\u0000${lineId}`),
      ),
    ].sort()
  }
  return [
    ...candidate.sourceObjectIds.flatMap((sourceObjectId) =>
      sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)
        ? []
        : [`native\u0000${sourceObjectId}`],
    ),
    ...containedFigureOverlayLineage(candidate, regions).flatMap((overlay) =>
      overlay.lineIds.map((lineId) => `line\u0000${lineId}`),
    ),
  ].sort()
}

export function preTableFigureReservationOverlayLineage(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
) {
  return (
    connectedFigureReservationLineage(candidate, regions)?.overlays ??
    nativeContainedFigureOverlayLineage(candidate, regions)
  )
}

export function retainConnectedFigureReservationLineage(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
) {
  const connectedLineage = connectedFigureReservationLineage(candidate, regions)
  return connectedLineage
    ? {
        ...candidate,
        sourceLineIds: connectedLineage.overlays.flatMap(
          (overlay) => overlay.lineIds,
        ),
        sourceText: connectedLineage.overlays
          .map((overlay) => overlay.sourceText)
          .join(' '),
      }
    : candidate
}

export function trimStrongFigureCandidateOverlays(
  candidate: VisualCandidate,
  regions: readonly PdfPageRegion[],
) {
  const contained = containedFigureOverlayLineage(candidate, regions)
  const retainedOverlayObjectIds = new Set(
    contained.map((overlay) => overlay.sourceObjectId),
  )
  const containedByObjectId = new Map(
    contained.map((overlay) => [overlay.sourceObjectId, overlay]),
  )
  const allOverlayObjectIds = candidate.sourceObjectIds.filter(
    (sourceObjectId) => sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX),
  )
  const allOverlayLinesRetained = allOverlayObjectIds.every(
    (sourceObjectId) => {
      const region = regions.find(
        (candidateRegion) =>
          candidateRegion.id ===
          sourceObjectId.slice(TEXT_OVERLAY_PREFIX.length),
      )
      const retained = containedByObjectId.get(sourceObjectId)
      const visibleLineIds =
        region?.lines
          .filter((line) => line.text.trim())
          .map((line) => line.id) ?? []
      return (
        retained !== undefined &&
        retained.lineIds.length === visibleLineIds.length &&
        visibleLineIds.every((lineId) => retained.lineIds.includes(lineId))
      )
    },
  )
  if (allOverlayObjectIds.length === 0) {
    return candidate
  }
  const lineageTrimmed =
    retainedOverlayObjectIds.size !== allOverlayObjectIds.length ||
    !allOverlayLinesRetained
  const removedOverlayRegionIds = new Set(
    allOverlayObjectIds
      .filter((sourceObjectId) => !retainedOverlayObjectIds.has(sourceObjectId))
      .map((sourceObjectId) =>
        sourceObjectId.slice(TEXT_OVERLAY_PREFIX.length),
      ),
  )
  const retainedLineage = candidate.sourceObjectIds.flatMap(
    (sourceObjectId, index) => {
      if (!sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)) {
        return [{ sourceObjectId, sourceBox: candidate.sourceBoxes[index] }]
      }
      const retained = containedByObjectId.get(sourceObjectId)
      return retained ? [{ sourceObjectId, sourceBox: retained.sourceBox }] : []
    },
  )
  return {
    ...candidate,
    sourceRegionIds: candidate.sourceRegionIds.filter(
      (sourceRegionId) => !removedOverlayRegionIds.has(sourceRegionId),
    ),
    sourceLineIds: contained.flatMap((overlay) => overlay.lineIds),
    sourceObjectIds: retainedLineage.map((item) => item.sourceObjectId),
    sourceBoxes: retainedLineage.map((item) => item.sourceBox),
    sourceText: contained.map((overlay) => overlay.sourceText).join(' '),
    evidence: lineageTrimmed
      ? [
          ...(candidate.evidence ?? []),
          'caption-bounded-overlay-lineage-trimmed',
        ]
      : candidate.evidence,
  }
}

export function captionTextBoundedFigureRetryBox(
  candidate: VisualCandidate,
  boundedSourceBox: NormalizedSourceBox,
  captionBox: NormalizedSourceBox,
  horizontalBounds?: SourceHorizontalBounds,
) {
  if (
    candidate.kind !== 'figure' ||
    !candidate.renderBox ||
    boundedSourceBox.y > SOURCE_CROP_CONTAINMENT_TOLERANCE ||
    !candidate.evidence?.includes('caption-bounded-native-scaffold')
  ) {
    return null
  }
  const overlayBoxes = candidate.sourceObjectIds.flatMap(
    (sourceObjectId, index) =>
      sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)
        ? [candidate.sourceBoxes[index]]
        : [],
  )
  if (overlayBoxes.length < MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT) {
    return null
  }
  const nativeObjectCount = candidate.sourceObjectIds.filter(
    (sourceObjectId) => !sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX),
  ).length
  const top = rounded(
    Math.max(
      boundedSourceBox.y,
      Math.min(...overlayBoxes.map((sourceBox) => sourceBox.y)) -
        CAPTION_BOUNDED_PANEL_EDGE_RETRY_PADDING,
    ),
  )
  const bottom = boundedSourceBox.y + boundedSourceBox.height
  const left = rounded(
    Math.max(
      horizontalBounds?.left ?? 0,
      nativeObjectCount >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT
        ? captionBox.x
        : Math.min(...overlayBoxes.map((sourceBox) => sourceBox.x)) -
            CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING,
    ),
  )
  const right = rounded(
    Math.min(
      horizontalBounds?.right ?? 1,
      nativeObjectCount >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT
        ? captionBox.x + captionBox.width
        : Math.max(
            ...overlayBoxes.map((sourceBox) => sourceBox.x + sourceBox.width),
          ) + CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING,
    ),
  )
  if (
    top <= boundedSourceBox.y + SOURCE_CROP_CONTAINMENT_TOLERANCE ||
    top >= bottom ||
    left >= right
  ) {
    return null
  }
  const retryBox = {
    ...boundedSourceBox,
    x: left,
    y: top,
    width: rounded(right - left),
    height: rounded(bottom - top),
  }
  return overlayBoxes.every((sourceBox) =>
    fullyContainsBox(retryBox, sourceBox, SOURCE_CROP_CONTAINMENT_TOLERANCE),
  )
    ? retryBox
    : null
}

export function captionBoundedPanelRecoveryBoxes(
  candidate: VisualCandidate,
  caption: PdfPageRegion,
  regions: readonly PdfPageRegion[],
  objectKinds: ReadonlyMap<string, PdfNativeObject['kind']>,
  pageCropFailureEvidence: string | undefined,
  horizontalBounds?: SourceHorizontalBounds,
) {
  const captionBox = caption.box
  const evidence = new Set(candidate.evidence ?? [])
  const boundedRecoveryFailure = [
    'source-page-crop-edge-contact',
    'source-page-crop-containment-rejected',
    'source-page-crop-lineage-rejected',
    'source-page-crop-lineage-geometry-rejected',
  ].includes(pageCropFailureEvidence ?? '')
  const malformedTrimmedEnvelope =
    candidate.nativeEnvelopeIncomplete === true &&
    evidence.has('source-scaffold-trimmed-page-furniture-overlap')
  const failedReusedClipEnvelope =
    evidence.has('source-reused-page-edge-clipping-layer') &&
    boundedRecoveryFailure
  const failedReusedGridEnvelope =
    evidence.has('caption-bounded-reused-layer-grid-scaffold') &&
    boundedRecoveryFailure
  const imageObjectCount = candidate.sourceObjectIds.filter(
    (sourceObjectId) => objectKinds.get(sourceObjectId) === 'image',
  ).length
  const multipartRasterEnvelope =
    imageObjectCount >= MIN_COMPOSITE_FIGURE_FRAGMENTS &&
    boundedRecoveryFailure &&
    evidence.has('caption-bounded-native-scaffold') &&
    (candidate.captionRegionId === undefined ||
      candidate.captionRegionId === caption.id)
  if (
    candidate.kind !== 'figure' ||
    !candidate.renderBox ||
    candidate.sourcePageCropBlockedByReadingOrderText ||
    !evidence.has('caption-bounded-native-scaffold') ||
    (!malformedTrimmedEnvelope &&
      !failedReusedClipEnvelope &&
      !failedReusedGridEnvelope &&
      !multipartRasterEnvelope)
  ) {
    return []
  }

  const nativeObjectCount = candidate.sourceObjectIds.filter(
    (sourceObjectId) => !sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX),
  ).length
  const overlayBoxes = candidate.sourceObjectIds.flatMap(
    (sourceObjectId, index) =>
      sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)
        ? [candidate.sourceBoxes[index]]
        : [],
  )
  const nativeSourceBoxes = candidate.sourceObjectIds.flatMap(
    (sourceObjectId, index) =>
      !sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX) &&
      objectKinds.has(sourceObjectId)
        ? [candidate.sourceBoxes[index]]
        : [],
  )
  const requiresCompleteNativeEnvelope =
    multipartRasterEnvelope &&
    !malformedTrimmedEnvelope &&
    !failedReusedClipEnvelope &&
    !failedReusedGridEnvelope
  if (
    nativeObjectCount < MIN_COMPOSITE_FIGURE_FRAGMENTS ||
    overlayBoxes.length < MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT ||
    (requiresCompleteNativeEnvelope &&
      nativeSourceBoxes.length !== nativeObjectCount) ||
    (!multipartRasterEnvelope &&
      nativeObjectCount + overlayBoxes.length <
        MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT)
  ) {
    return []
  }

  const left = rounded(
    Math.max(
      horizontalBounds?.left ?? 0,
      Math.min(
        captionBox.x + CAPTION_BOUNDED_PANEL_EDGE_RETRY_PADDING,
        Math.min(...overlayBoxes.map((box) => box.x)) -
          CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING,
        ...(requiresCompleteNativeEnvelope
          ? nativeSourceBoxes.map((box) => box.x)
          : []),
      ),
    ),
  )
  const right = rounded(
    Math.min(
      horizontalBounds?.right ?? 1,
      Math.max(
        captionBox.x +
          captionBox.width -
          CAPTION_BOUNDED_PANEL_EDGE_RETRY_PADDING,
        Math.max(...overlayBoxes.map((box) => box.x + box.width)) +
          CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING,
        ...(requiresCompleteNativeEnvelope
          ? nativeSourceBoxes.map((box) => box.x + box.width)
          : []),
      ),
    ),
  )
  const bottom = rounded(
    Math.min(
      requiresCompleteNativeEnvelope
        ? Math.max(
            candidate.renderBox.y + candidate.renderBox.height,
            ...nativeSourceBoxes.map((box) => box.y + box.height),
          )
        : candidate.renderBox.y + candidate.renderBox.height,
      captionBox.y - CAPTION_BOUNDED_PANEL_BOTTOM_INSET,
    ),
  )
  const topCandidates = [
    ...new Set(
      [
        ...(malformedTrimmedEnvelope || requiresCompleteNativeEnvelope
          ? [
              requiresCompleteNativeEnvelope
                ? Math.min(
                    candidate.renderBox.y,
                    ...nativeSourceBoxes.map((box) => box.y),
                  )
                : candidate.renderBox.y,
            ]
          : []),
        ...overlayBoxes.map((box) =>
          rounded(
            Math.max(
              candidate.renderBox!.y,
              box.y - CAPTION_BOUNDED_PANEL_HORIZONTAL_EDGE_RETRY_PADDING,
            ),
          ),
        ),
      ].filter(
        (top) =>
          (malformedTrimmedEnvelope || requiresCompleteNativeEnvelope
            ? top >=
              (requiresCompleteNativeEnvelope
                ? Math.min(
                    candidate.renderBox!.y,
                    ...nativeSourceBoxes.map((box) => box.y),
                  )
                : candidate.renderBox!.y)
            : top >
              candidate.renderBox!.y + SOURCE_CROP_CONTAINMENT_TOLERANCE) &&
          top < bottom,
      ),
    ),
  ].sort((leftTop, rightTop) => leftTop - rightTop)
  const claimedRegionIds = new Set(candidate.sourceRegionIds)

  return topCandidates
    .flatMap((top) => {
      const sourceBox = {
        ...candidate.renderBox!,
        x: left,
        y: top,
        width: rounded(right - left),
        height: rounded(bottom - top),
      }
      const ownedSourceBoxes = overlayBoxes.filter((box) =>
        fullyContainsBox(sourceBox, box, SOURCE_CROP_CONTAINMENT_TOLERANCE),
      )
      if (
        sourceBox.width <= 0 ||
        sourceBox.height <= 0 ||
        ownedSourceBoxes.length < MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT ||
        (requiresCompleteNativeEnvelope &&
          !nativeSourceBoxes.every((box) =>
            fullyContainsBox(sourceBox, box, SOURCE_CROP_CONTAINMENT_TOLERANCE),
          ))
      ) {
        return []
      }
      const overlapsUnclaimedFlowText = regions.some(
        (region) =>
          region.page === sourceBox.page &&
          !claimedRegionIds.has(region.id) &&
          region.includedInReadingOrder &&
          region.nativeObjectIds.length === 0 &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          ['body', 'spanning'].includes(region.kind) &&
          materiallyOverlappingSourceBoxes(sourceBox, region.box),
      )
      const competingCaption = regions.some(
        (region) =>
          region.kind === 'caption' &&
          region.id !== caption.id &&
          region.page === sourceBox.page &&
          region.box.y >= sourceBox.y - FIGURE_OVERLAY_BOX_TOLERANCE &&
          region.box.y <=
            captionBox.y + captionBox.height + FIGURE_OVERLAY_BOX_TOLERANCE &&
          horizontalOverlapRatio(sourceBox, region.box) >= 0.35,
      )
      const exactCaptionLane =
        sourceBox.page === caption.page &&
        sourceBox.y + sourceBox.height <=
          captionBox.y + FIGURE_OVERLAY_BOX_TOLERANCE &&
        horizontalOverlapRatio(sourceBox, captionBox) >= 0.35 &&
        !competingCaption
      return overlapsUnclaimedFlowText || !exactCaptionLane
        ? []
        : [
            {
              sourceBox,
              ownedSourceBoxes,
              evidence: [
                ...(failedReusedGridEnvelope
                  ? ['caption-bounded-reused-grid-recovery']
                  : []),
                ...(multipartRasterEnvelope
                  ? ['caption-bounded-multipart-raster-recovery']
                  : []),
              ],
            },
          ]
    })
    .slice(0, MAX_CAPTION_BOUNDED_PANEL_RECOVERY_ATTEMPTS)
}
