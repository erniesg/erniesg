import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageRegion,
} from './import-types'
import {
  CAPTION_BOUNDED_PANEL_BOTTOM_INSET,
  fullyContainsBox,
  intersectionArea,
  MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT,
} from './pdf-visual-figure-lineage'
import {
  containsCenter,
  figureRegionSpatialIndex,
  isLargeVectorArtifact,
  owningCaptionForBox,
  unionObjectBox,
  yieldPdfVisualTask,
} from './pdf-visual-figure-grouping'
import {
  captionSourceLaneMatches,
  compatibleCaptionLaneColumns,
  FIGURE_OVERLAY_BOX_TOLERANCE,
  horizontalOverlapRatio,
  rounded,
  TEXT_OVERLAY_PREFIX,
  type VisualCandidate,
} from './pdf-visual-matching'
import { materiallyOverlappingSourceBoxes } from './pdf-visual-source-geometry'

const MIN_NATIVE_SCAFFOLD_AREA = 0.04
const MIN_COEXTENSIVE_NATIVE_LAYER_OVERLAP = 0.9
export const MAX_REUSED_PAGE_BACKDROP_EDGE_INSET = 0.02
export const CAPTION_ENVELOPE_SOURCE_CROP_RETRY_PADDINGS = [
  0.016, 0.02, 0.024, 0.028, 0.032, 0.04, 0.05,
] as const
const MIN_CAPTION_ENVELOPE_NATIVE_OBJECT_COUNT = 4
const MIN_CAPTION_ENVELOPE_TEXT_LINE_COUNT = 4
const MIN_CAPTION_ENVELOPE_WIDTH = 0.45
const MIN_CAPTION_ENVELOPE_HEIGHT = 0.12
const MIN_CAPTION_ENVELOPE_HORIZONTAL_RULE_COUNT = 2
const MIN_CAPTION_ENVELOPE_VERTICAL_RULE_COUNT = 2
const MIN_CAPTION_ENVELOPE_GRID_COLUMN_COUNT = 2
const MIN_CAPTION_ENVELOPE_GRID_ROW_COUNT = 3
const MAX_CAPTION_ENVELOPE_TITLE_GAP = 0.04

export function textOverlayId(region: PdfPageRegion) {
  return `${TEXT_OVERLAY_PREFIX}${region.id}`
}

export function isCompositeScaffold(
  region: PdfPageRegion,
  figureRegions: PdfPageRegion[],
) {
  if (!isLargeVectorArtifact(region)) return false
  const area = region.box.width * region.box.height
  const contained = figureRegions.filter(
    (candidate) =>
      candidate.id !== region.id &&
      candidate.box.width * candidate.box.height < area * 0.9 &&
      containsCenter(region, candidate),
  )
  return (
    contained.length >= 2 &&
    (contained.some((candidate) =>
      candidate.nativeObjectIds.some((id) => id.startsWith('image-')),
    ) ||
      contained.length >= 4)
  )
}

export function bindsDenseNativeFragmentSet(
  region: PdfPageRegion,
  figureRegions: PdfPageRegion[],
) {
  const area = region.box.width * region.box.height
  if (area < MIN_NATIVE_SCAFFOLD_AREA) return false
  return (
    figureRegions.filter(
      (candidate) =>
        candidate.id !== region.id &&
        candidate.box.width * candidate.box.height < area * 0.9 &&
        containsCenter(region, candidate),
    ).length >= 4
  )
}

export function coextensiveNativeLayerPair(
  left: PdfPageRegion,
  right: PdfPageRegion,
) {
  const smallerArea = Math.min(
    left.box.width * left.box.height,
    right.box.width * right.box.height,
  )
  return (
    smallerArea >= MIN_NATIVE_SCAFFOLD_AREA &&
    intersectionArea(left.box, right.box) / smallerArea >=
      MIN_COEXTENSIVE_NATIVE_LAYER_OVERLAP
  )
}

export function coextensiveNativeLayerCluster(group: PdfPageRegion[]) {
  const remaining = new Set(group)
  const originalIndexes = new Map(
    group.map((region, index) => [region, index] as const),
  )
  const spatialIndex = figureRegionSpatialIndex(group)
  const components: PdfPageRegion[][] = []
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as PdfPageRegion
    remaining.delete(seed)
    const component = [seed]
    for (
      let index = 0;
      index < component.length && remaining.size > 0;
      index += 1
    ) {
      const localCandidates = spatialIndex
        .query(component[index].box)
        .filter((candidate) => remaining.has(candidate))
        .sort(
          (left, right) =>
            originalIndexes.get(left)! - originalIndexes.get(right)!,
        )
      for (const candidate of localCandidates) {
        if (!coextensiveNativeLayerPair(component[index], candidate)) continue
        remaining.delete(candidate)
        component.push(candidate)
      }
    }
    if (component.length >= 2) components.push(component)
  }
  return (
    components.sort(
      (left, right) =>
        right.length - left.length ||
        right.reduce(
          (total, region) => total + region.nativeObjectIds.length,
          0,
        ) -
          left.reduce(
            (total, region) => total + region.nativeObjectIds.length,
            0,
          ) ||
        left
          .map((region) => region.id)
          .sort()
          .join(':')
          .localeCompare(
            right
              .map((region) => region.id)
              .sort()
              .join(':'),
          ),
    )[0] ?? null
  )
}

export function coextensiveNativeLayers(group: PdfPageRegion[]) {
  return coextensiveNativeLayerCluster(group) !== null
}

export function provesCaptionBoundedNativeScaffold(
  group: PdfPageRegion[],
  figureRegions: PdfPageRegion[],
) {
  const scope = unionObjectBox(group)
  if (scope.width * scope.height < MIN_NATIVE_SCAFFOLD_AREA) return false
  return (
    group.length >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT ||
    group.some((region) => isCompositeScaffold(region, figureRegions)) ||
    group.some((region) =>
      bindsDenseNativeFragmentSet(region, figureRegions),
    ) ||
    coextensiveNativeLayers(group)
  )
}

export function renderBoxForGroup(
  group: PdfPageRegion[],
  captions: PdfPageRegion[],
) {
  const box = unionObjectBox(group)
  const caption = owningCaptionForBox(box, captions)
  if (!caption || box.y + box.height <= caption.box.y - 0.002) return box
  const bottom = Math.max(box.y + 0.004, caption.box.y - 0.004)
  return { ...box, height: rounded(bottom - box.y) }
}

export function captionBoundedRenderBox(
  group: PdfPageRegion[],
  captions: PdfPageRegion[],
  useCaptionBounds: boolean,
) {
  const box = renderBoxForGroup(group, captions)
  if (!useCaptionBounds) return box
  const caption = owningCaptionForBox(box, captions)
  if (!caption) return box
  const left = Math.min(box.x, caption.box.x)
  const right = Math.max(box.x + box.width, caption.box.x + caption.box.width)
  const bottom = Math.max(
    box.y + box.height,
    Math.max(box.y + 0.004, caption.box.y - 0.008),
  )
  return {
    ...box,
    x: rounded(left),
    width: rounded(right - left),
    height: rounded(bottom - box.y),
  }
}

export function denseGridNeighborRegions(regions: PdfPageRegion[]) {
  const coordinate = (
    region: PdfPageRegion,
    axis: 'horizontal' | 'vertical',
  ) =>
    axis === 'horizontal'
      ? region.box.x + region.box.width / 2
      : region.box.y + region.box.height / 2
  const bucketed = (axis: 'horizontal' | 'vertical', tolerance: number) => {
    const buckets = new Map<number, PdfPageRegion[]>()
    for (const region of regions) {
      const key = Math.floor(coordinate(region, axis) / tolerance)
      const values = buckets.get(key) ?? []
      values.push(region)
      buckets.set(key, values)
    }
    return {
      hasNeighbors(region: PdfPageRegion, minimum: number) {
        const center = coordinate(region, axis)
        const key = Math.floor(center / tolerance)
        let matches = 0
        for (
          let candidateKey = key - 1;
          candidateKey <= key + 1;
          candidateKey += 1
        ) {
          for (const candidate of buckets.get(candidateKey) ?? []) {
            if (
              candidate === region ||
              Math.abs(coordinate(candidate, axis) - center) > tolerance
            ) {
              continue
            }
            matches += 1
            if (matches >= minimum) return true
          }
        }
        return false
      },
    }
  }
  const columns = bucketed('horizontal', 0.06)
  const rows = bucketed('vertical', 0.035)
  return regions.filter(
    (region) =>
      columns.hasNeighbors(region, MIN_CAPTION_ENVELOPE_GRID_ROW_COUNT - 1) &&
      rows.hasNeighbors(region, MIN_CAPTION_ENVELOPE_GRID_COLUMN_COUNT - 1),
  )
}

export async function captionBoundedSemanticEnvelopeCandidates(
  figureRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  pageBackdropObjectIds: ReadonlySet<string>,
  panelClipObjectIds: ReadonlySet<string>,
  strongHeadingRegionIds: ReadonlySet<string>,
  repeatedPageFurnitureRegionIds: ReadonlySet<string>,
  onProgress?: (progress: PdfImportProgress) => void,
  signal?: AbortSignal,
) {
  const orderedCaptions = [...captions].sort(
    (left, right) =>
      left.page - right.page ||
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
  const candidateForCaption = (
    caption: PdfPageRegion,
    captionIndex: number,
  ): VisualCandidate[] => {
    const previousCaption = orderedCaptions
      .slice(0, captionIndex)
      .reverse()
      .find(
        (candidate) =>
          candidate.page === caption.page &&
          compatibleCaptionLaneColumns(candidate.column, caption.column) &&
          horizontalOverlapRatio(candidate.box, caption.box) >= 0.35,
      )
    const laneTop = previousCaption
      ? previousCaption.box.y + previousCaption.box.height
      : 0
    const laneBottom = caption.box.y
    if (
      caption.box.width < MIN_CAPTION_ENVELOPE_WIDTH ||
      laneBottom - laneTop < MIN_CAPTION_ENVELOPE_HEIGHT
    ) {
      return []
    }

    const pageEdgeBackdropRegions = figureRegions.filter((region) => {
      const box = region.box
      const reachesPageEdge =
        box.x <= MAX_REUSED_PAGE_BACKDROP_EDGE_INSET ||
        box.y <= MAX_REUSED_PAGE_BACKDROP_EDGE_INSET ||
        box.x + box.width >= 1 - MAX_REUSED_PAGE_BACKDROP_EDGE_INSET ||
        box.y + box.height >= 1 - MAX_REUSED_PAGE_BACKDROP_EDGE_INSET
      return (
        region.page === caption.page &&
        reachesPageEdge &&
        region.nativeObjectIds.length > 0 &&
        region.nativeObjectIds.every((sourceObjectId) =>
          pageBackdropObjectIds.has(sourceObjectId),
        )
      )
    })
    const excludedPageBackdropObjectIds = new Set(
      pageEdgeBackdropRegions.flatMap((region) => region.nativeObjectIds),
    )
    const captionLaneNativeRegions = figureRegions.filter((region) => {
      if (
        region.page !== caption.page ||
        region.box.y < laneTop - FIGURE_OVERLAY_BOX_TOLERANCE ||
        region.box.y + region.box.height >
          laneBottom + FIGURE_OVERLAY_BOX_TOLERANCE ||
        region.nativeObjectIds.length === 0 ||
        region.nativeObjectIds.every((sourceObjectId) =>
          excludedPageBackdropObjectIds.has(sourceObjectId),
        )
      ) {
        return false
      }
      return true
    })
    const laneNativeRegions = captionLaneNativeRegions.filter(
      (region) => horizontalOverlapRatio(caption.box, region.box) >= 0.35,
    )
    const reusedBackdropLayerCluster = coextensiveNativeLayerCluster(
      pageEdgeBackdropRegions,
    )
    const reusedBackdropEnvelopeBox = reusedBackdropLayerCluster
      ? unionObjectBox(reusedBackdropLayerCluster)
      : null
    const backdropLaneNativeRegions = reusedBackdropEnvelopeBox
      ? captionLaneNativeRegions.filter((region) =>
          fullyContainsBox(
            reusedBackdropEnvelopeBox,
            region.box,
            FIGURE_OVERLAY_BOX_TOLERANCE,
          ),
        )
      : []
    const laneHorizontalRules = laneNativeRegions.filter(
      (region) => region.box.width >= 0.15 && region.box.height <= 0.012,
    )
    const laneVerticalRules = laneNativeRegions.filter(
      (region) => region.box.height >= 0.08 && region.box.width <= 0.012,
    )
    const ruleEnvelopeBox =
      laneHorizontalRules.length >=
        MIN_CAPTION_ENVELOPE_HORIZONTAL_RULE_COUNT &&
      laneVerticalRules.length >= MIN_CAPTION_ENVELOPE_VERTICAL_RULE_COUNT
        ? unionObjectBox([...laneHorizontalRules, ...laneVerticalRules])
        : null
    const denseGridPool =
      backdropLaneNativeRegions.length > 0
        ? backdropLaneNativeRegions
        : laneNativeRegions
    const denseGridRegions = denseGridNeighborRegions(denseGridPool)
    const usesDenseGridEnvelope =
      ruleEnvelopeBox === null &&
      denseGridRegions.flatMap((region) => region.nativeObjectIds).length >=
        MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT
    const usesReusedBackdropGridEnvelope =
      usesDenseGridEnvelope &&
      reusedBackdropEnvelopeBox !== null &&
      backdropLaneNativeRegions.length >= denseGridRegions.length
    const laneContainsPanelClip = laneNativeRegions.some((region) =>
      region.nativeObjectIds.some((sourceObjectId) =>
        panelClipObjectIds.has(sourceObjectId),
      ),
    )
    const coextensiveLayerCluster =
      ruleEnvelopeBox === null &&
      !usesDenseGridEnvelope &&
      excludedPageBackdropObjectIds.size === 0 &&
      !laneContainsPanelClip
        ? coextensiveNativeLayerCluster(laneNativeRegions)
        : null
    const coextensiveLayerEnvelopeBox = coextensiveLayerCluster
      ? unionObjectBox(coextensiveLayerCluster)
      : null
    const usesCoextensiveLayerEnvelope = coextensiveLayerEnvelopeBox !== null
    // A caption lane is only a search bound, not an ownership claim. Once a
    // ruled semantic panel proves a tighter envelope, unrelated native
    // objects outside that envelope must remain orphan obligations.
    const nativeRegions = ruleEnvelopeBox
      ? laneNativeRegions.filter((region) =>
          fullyContainsBox(
            ruleEnvelopeBox,
            region.box,
            FIGURE_OVERLAY_BOX_TOLERANCE,
          ),
        )
      : usesDenseGridEnvelope
        ? usesReusedBackdropGridEnvelope
          ? backdropLaneNativeRegions
          : denseGridRegions
        : coextensiveLayerEnvelopeBox
          ? laneNativeRegions.filter((region) =>
              fullyContainsBox(
                coextensiveLayerEnvelopeBox,
                region.box,
                FIGURE_OVERLAY_BOX_TOLERANCE,
              ),
            )
          : laneNativeRegions
    const nativeLineage = [
      ...new Map(
        nativeRegions.flatMap((region) =>
          region.nativeObjectIds
            .filter(
              (sourceObjectId) =>
                !excludedPageBackdropObjectIds.has(sourceObjectId),
            )
            .map(
              (sourceObjectId) =>
                [
                  sourceObjectId,
                  { sourceObjectId, sourceBox: region.box },
                ] as const,
            ),
        ),
      ).values(),
    ]
    if (
      nativeLineage.length <
        (usesCoextensiveLayerEnvelope
          ? 2
          : MIN_CAPTION_ENVELOPE_NATIVE_OBJECT_COUNT) ||
      nativeRegions.length === 0 ||
      nativeLineage.some(({ sourceObjectId }) =>
        panelClipObjectIds.has(sourceObjectId),
      )
    ) {
      return []
    }

    const nativeRegionBox = unionObjectBox(nativeRegions)
    const nativeBox =
      usesReusedBackdropGridEnvelope && reusedBackdropEnvelopeBox
        ? {
            ...nativeRegionBox,
            y: Math.max(laneTop, reusedBackdropEnvelopeBox.y),
            height:
              nativeRegionBox.y +
              nativeRegionBox.height -
              Math.max(laneTop, reusedBackdropEnvelopeBox.y),
          }
        : nativeRegionBox
    if (
      nativeBox.width <
        (usesDenseGridEnvelope
          ? MIN_CAPTION_ENVELOPE_WIDTH * 0.65
          : MIN_CAPTION_ENVELOPE_WIDTH) ||
      nativeBox.height < MIN_CAPTION_ENVELOPE_HEIGHT
    ) {
      return []
    }
    const horizontalRules = nativeRegions.filter(
      (region) => region.box.width >= 0.15 && region.box.height <= 0.012,
    ).length
    const verticalRules = nativeRegions.filter(
      (region) => region.box.height >= 0.08 && region.box.width <= 0.012,
    ).length
    const denseFragmentProof =
      usesDenseGridEnvelope &&
      nativeLineage.length >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT
    const ruledPanelProof =
      horizontalRules >= MIN_CAPTION_ENVELOPE_HORIZONTAL_RULE_COUNT &&
      verticalRules >= MIN_CAPTION_ENVELOPE_VERTICAL_RULE_COUNT
    const coextensiveLayerProof = coextensiveNativeLayers(nativeRegions)
    if (!denseFragmentProof && !ruledPanelProof && !coextensiveLayerProof) {
      return []
    }

    const titleOverlays = regions.filter(
      (region) =>
        region.page === caption.page &&
        region.id !== caption.id &&
        region.nativeObjectIds.length === 0 &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        !region.includedInReadingOrder &&
        captionSourceLaneMatches(caption, region) &&
        !repeatedPageFurnitureRegionIds.has(region.id) &&
        !strongHeadingRegionIds.has(region.id) &&
        ![
          'caption',
          'header',
          'footer',
          'page-number',
          'footnote',
          'endnote',
        ].includes(region.kind) &&
        region.box.y >= laneTop - FIGURE_OVERLAY_BOX_TOLERANCE &&
        region.box.y + region.box.height <=
          nativeBox.y + FIGURE_OVERLAY_BOX_TOLERANCE &&
        nativeBox.y - (region.box.y + region.box.height) <=
          MAX_CAPTION_ENVELOPE_TITLE_GAP &&
        horizontalOverlapRatio(region.box, nativeBox) >= 0.35 &&
        horizontalOverlapRatio(region.box, caption.box) >= 0.35,
    )
    const left = Math.min(nativeBox.x, caption.box.x)
    const right = Math.max(
      nativeBox.x + nativeBox.width,
      caption.box.x + caption.box.width,
    )
    const top = Math.min(
      nativeBox.y,
      ...titleOverlays.map((region) => region.box.y),
    )
    const bottom = laneBottom - CAPTION_BOUNDED_PANEL_BOTTOM_INSET
    if (bottom <= top) return []
    const renderBox = {
      ...nativeBox,
      x: rounded(left),
      y: rounded(top),
      width: rounded(right - left),
      height: rounded(bottom - top),
    }
    const enclosedText = regions
      .filter(
        (region) =>
          region.page === caption.page &&
          region.id !== caption.id &&
          region.nativeObjectIds.length === 0 &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          !strongHeadingRegionIds.has(region.id) &&
          ![
            'caption',
            'header',
            'footer',
            'page-number',
            'footnote',
            'endnote',
          ].includes(region.kind) &&
          fullyContainsBox(renderBox, region.box, FIGURE_OVERLAY_BOX_TOLERANCE),
      )
      .sort(
        (leftRegion, rightRegion) =>
          leftRegion.box.y - rightRegion.box.y ||
          leftRegion.box.x - rightRegion.box.x ||
          leftRegion.id.localeCompare(rightRegion.id),
      )
    const coordinateClusterCount = (values: number[], tolerance: number) => {
      const ordered = [...values].sort(
        (leftValue, rightValue) => leftValue - rightValue,
      )
      let clusterCount = 0
      let previousClusterStart = -Infinity
      for (const value of ordered) {
        if (clusterCount > 0 && value - previousClusterStart <= tolerance) {
          continue
        }
        clusterCount += 1
        previousClusterStart = value
      }
      return clusterCount
    }
    const denseGridProof =
      denseFragmentProof &&
      coordinateClusterCount(
        nativeRegions.map((region) => region.box.x + region.box.width / 2),
        0.06,
      ) >= MIN_CAPTION_ENVELOPE_GRID_COLUMN_COUNT &&
      coordinateClusterCount(
        nativeRegions.map((region) => region.box.y + region.box.height / 2),
        0.035,
      ) >= MIN_CAPTION_ENVELOPE_GRID_ROW_COUNT
    const reusedLayerGridProof =
      denseGridProof && usesReusedBackdropGridEnvelope
    const uniquelyOwnsReadingOrderText =
      ruledPanelProof || reusedLayerGridProof || coextensiveLayerProof
    const overlays = enclosedText.filter(
      (region) =>
        !region.includedInReadingOrder ||
        !['body', 'spanning'].includes(region.kind) ||
        uniquelyOwnsReadingOrderText,
    )
    const overlayLineCount = overlays.reduce(
      (total, region) => total + region.lines.length,
      0,
    )
    if (overlayLineCount < MIN_CAPTION_ENVELOPE_TEXT_LINE_COUNT) return []

    const overlayIds = new Set(overlays.map((region) => region.id))
    const overlapsUnclaimedFlowText = regions.some(
      (region) =>
        region.page === caption.page &&
        region.id !== caption.id &&
        !overlayIds.has(region.id) &&
        region.includedInReadingOrder &&
        region.nativeObjectIds.length === 0 &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        ['body', 'spanning'].includes(region.kind) &&
        materiallyOverlappingSourceBoxes(renderBox, region.box),
    )
    if (overlapsUnclaimedFlowText) return []

    const overlayLineage = overlays.map((region) => ({
      sourceObjectId: textOverlayId(region),
      sourceBox: region.box,
    }))
    const lineage = [...nativeLineage, ...overlayLineage]
    return [
      {
        kind: 'figure',
        captionRegionId: caption.id,
        sourceRegionIds: [
          ...new Set([
            ...nativeRegions.map((region) => region.id),
            ...overlays.map((region) => region.id),
          ]),
        ],
        sourceObjectIds: lineage.map((item) => item.sourceObjectId),
        assetIds: [],
        sourceBoxes: lineage.map((item) => item.sourceBox),
        sourceText: overlays.map((region) => region.text).join(' '),
        page: caption.page,
        renderBox,
        textOwnershipBox: renderBox,
        sourcePageCropBlockedByReadingOrderText: false,
        nativeEnvelopeIncomplete: false,
        evidence: [
          'source-text-overlay',
          'caption-bounded-native-scaffold',
          'caption-bounded-semantic-envelope',
          ...(uniquelyOwnsReadingOrderText
            ? ['caption-bounded-unique-text-ownership']
            : []),
          ...(coextensiveLayerProof
            ? ['caption-bounded-coextensive-layer']
            : []),
          ...(ruledPanelProof ? ['caption-bounded-rule-scaffold'] : []),
          ...(reusedLayerGridProof
            ? ['caption-bounded-reused-layer-grid-scaffold']
            : []),
          ...(titleOverlays.length > 0
            ? ['caption-bounded-non-flow-title']
            : []),
        ],
        column: 'span',
      },
    ]
  }
  const candidates: VisualCandidate[] = []
  for (const [captionIndex, caption] of orderedCaptions.entries()) {
    candidates.push(...candidateForCaption(caption, captionIndex))
    onProgress?.({
      phase: 'semantic-promotion',
      completed: captionIndex + 1,
      total: orderedCaptions.length,
      message: `Resolving caption-bounded semantic figure envelopes ${captionIndex + 1} of ${orderedCaptions.length}…`,
      checkpoint: 'figure-grouping-envelopes',
    })
    await yieldPdfVisualTask(signal)
  }
  return candidates
}
