import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { detectTableNearCaption } from './pdf-table-detection'
import {
  resolvePdfTableScope,
  type PdfTableScope,
  type PdfTableScopeResolution,
} from './pdf-table-scope'
import {
  canonicalTableFromLines,
  createHeadlessCompositePngAsset,
  createHeadlessCompositeSvgAsset,
  createTableAsset,
  createTextSvgAsset,
  isValidSourcePageCropPayload,
  type CanonicalTable,
} from './visual-assets'

type VisualKind = PdfVisualRelationship['kind']
type PdfNativeObject = NonNullable<PdfPageAnalysis['objects']>[number]
type DetectedPdfTable = NonNullable<ReturnType<typeof detectTableNearCaption>>

type CompleteSemanticTableScope = {
  sourceHeaderLineIds: string[]
  evidence: string[]
}

export type PdfFigureRasterizer = (input: {
  kind: VisualKind
  page: number
  sourceBox: NormalizedSourceBox
  sourceObjectIds: string[]
  sourceBoxes: NormalizedSourceBox[]
}) => Promise<PdfVisualAsset | null>

export type PdfPartialRegionLineSelection = {
  regionId: string
  consumedLineIds: string[]
  retainedLineIds: string[]
}

const MIN_COMPOSITE_FIGURE_FRAGMENTS = 2
const TEXT_OVERLAY_PREFIX = 'text-overlay:'
const FIGURE_OVERLAY_BOX_TOLERANCE = 0.004
// Diagram labels must remain outside canonical reading order and subordinate
// to the established native render scope. The area cap is a secondary bound;
// individually small fragments are not evidence that canonical prose is safe.
const MAX_FIGURE_TEXT_OVERLAY_AREA_RATIO = 0.2
const MAX_CAPTION_BOUNDED_FLOW_OVERLAY_AREA_RATIO = 0.45
const MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT = 2
const MAX_SINGLE_LINE_CHART_OVERLAY_CHARACTERS = 48
const MAX_SINGLE_LINE_CHART_OVERLAY_AREA_RATIO = 0.03
const MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT = 8
const MIN_NATIVE_SCAFFOLD_AREA = 0.04
const MIN_COEXTENSIVE_NATIVE_LAYER_OVERLAP = 0.9
const SOURCE_CROP_CONTAINMENT_TOLERANCE = 0.00001
const MIN_CROSS_COLUMN_FIGURE_SPAN = 0.65
const MAX_SINGLE_COLUMN_FIGURE_WIDTH = 0.55
const MAX_TABLE_HEADER_SCOPE_GAP = 0.025
const MIN_TABLE_HEADER_HORIZONTAL_COVERAGE = 0.5

type VisualCandidate = {
  kind: VisualKind
  sourceRegionIds: string[]
  sourceLineIds?: string[]
  sourceObjectIds: string[]
  assetIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  sourceText: string
  page: number
  column: PdfPageRegion['column']
  renderBox?: NormalizedSourceBox
  evidence?: string[]
  sourcePageCropBlockedByReadingOrderText?: boolean
  nativeEnvelopeIncomplete?: boolean
  tableRegionLineage?: PdfTableScope['regionLineage']
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function visualLabel(text: string) {
  const match = text
    .trim()
    .match(/^(fig(?:ure)?|table|eq(?:uation)?)\.?\s*([0-9]+|[ivxlcdm]+)\b/i)
  if (!match) return null
  const prefix = match[1].toLocaleLowerCase()
  const kind: VisualKind = prefix.startsWith('fig')
    ? 'figure'
    : prefix.startsWith('table')
      ? 'table'
      : 'equation'
  const name =
    kind === 'figure' ? 'Figure' : kind === 'table' ? 'Table' : 'Equation'
  return { kind, sequence: match[2], label: `${name} ${match[2]}` }
}

function boxGap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
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

function horizontalBoxOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
}

function horizontalOverlapRatio(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const denominator = Math.min(left.width, right.width)
  return denominator > 0 ? horizontalBoxOverlap(left, right) / denominator : 0
}

function narrowCaptionClaimsOneColumn(
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

function captionSeparates(
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

function connected(
  left: PdfPageRegion,
  right: PdfPageRegion,
  captions: PdfPageRegion[],
) {
  if (left.page !== right.page) return false
  if (captionSeparates(left, right, captions)) return false
  if (narrowCaptionClaimsOneColumn(left, right, captions)) return false
  const gap = boxGap(left.box, right.box)
  return (
    (gap.vertical === 0 && gap.horizontal <= 0.04) ||
    (gap.horizontal === 0 && gap.vertical <= 0.04)
  )
}

function isLargeVectorBox(box: NormalizedSourceBox) {
  return box.width >= 0.65 && box.height >= 0.35
}

function isPageFurnitureVectorBox(box: NormalizedSourceBox) {
  const nearHorizontalEdge = box.y <= 0.15 || box.y + box.height >= 0.85
  const nearVerticalEdge = box.x <= 0.08 || box.x + box.width >= 0.92
  return (
    (nearHorizontalEdge && box.width >= 0.45 && box.height <= 0.008) ||
    (nearVerticalEdge && box.width <= 0.008 && box.height >= 0.2)
  )
}

function isStructuralVectorRuleBox(box: NormalizedSourceBox) {
  return (
    (box.width >= 0.02 && box.height <= 0.0001) ||
    (box.width >= 0.45 && box.height <= 0.008) ||
    (box.height >= 0.2 && box.width <= 0.012)
  )
}

function sameRepeatedGeometry(left: PdfNativeObject, right: PdfNativeObject) {
  if (left.page === right.page || left.box.rotation !== right.box.rotation)
    return false
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(left.box[key] - right.box[key]) <= 0.004,
  )
}

export function decorativeNativeObjectIds(pages: PdfPageAnalysis[]) {
  const vectors = pages
    .flatMap((page) => page.objects ?? [])
    .filter((object) => object.kind === 'vector')
  const decorative = new Set(
    vectors
      .filter(
        (object) =>
          isPageFurnitureVectorBox(object.box) ||
          isStructuralVectorRuleBox(object.box),
      )
      .map((object) => object.id),
  )
  for (const object of vectors.filter((candidate) =>
    isLargeVectorBox(candidate.box),
  )) {
    if (
      vectors.some(
        (candidate) =>
          candidate.id !== object.id && sameRepeatedGeometry(object, candidate),
      )
    ) {
      decorative.add(object.id)
    }
  }
  return decorative
}

function isDecorativeVectorArtifact(
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

function isLargeVectorArtifact(region: PdfPageRegion) {
  return (
    region.box.method === 'pdf-object' &&
    region.nativeObjectIds.every((id) => id.startsWith('vector-')) &&
    isLargeVectorBox(region.box)
  )
}

function containsCenter(container: PdfPageRegion, candidate: PdfPageRegion) {
  const x = candidate.box.x + candidate.box.width / 2
  const y = candidate.box.y + candidate.box.height / 2
  return (
    x >= container.box.x - 0.004 &&
    x <= container.box.x + container.box.width + 0.004 &&
    y >= container.box.y - 0.004 &&
    y <= container.box.y + container.box.height + 0.004
  )
}

function fullyContainsBox(
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

function textOverlayId(region: PdfPageRegion) {
  return `${TEXT_OVERLAY_PREFIX}${region.id}`
}

function boundedTextOverlays(
  group: PdfPageRegion[],
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
) {
  const scope = {
    ...group[0],
    box: renderBoxForGroup(group, captions),
  }
  const scopeArea = scope.box.width * scope.box.height
  const groupIds = new Set(group.map((region) => region.id))
  return regions
    .filter(
      (region) =>
        region.page === scope.page &&
        !groupIds.has(region.id) &&
        !region.includedInReadingOrder &&
        region.nativeObjectIds.length === 0 &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        ![
          'caption',
          'header',
          'footer',
          'page-number',
          'footnote',
          'endnote',
        ].includes(region.kind) &&
        fullyContainsBox(scope.box, region.box, FIGURE_OVERLAY_BOX_TOLERANCE) &&
        region.box.width * region.box.height <=
          scopeArea * MAX_FIGURE_TEXT_OVERLAY_AREA_RATIO,
    )
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
}

function scopeContainsReadingOrderText(
  scope: NormalizedSourceBox,
  regions: PdfPageRegion[],
  claimedRegionIds: ReadonlySet<string> = new Set<string>(),
) {
  return regions.some(
    (region) =>
      region.page === scope.page &&
      !claimedRegionIds.has(region.id) &&
      region.includedInReadingOrder &&
      region.nativeObjectIds.length === 0 &&
      region.lines.length > 0 &&
      region.text.trim().length > 0 &&
      ['body', 'spanning'].includes(region.kind) &&
      fullyContainsBox(scope, region.box, 0),
  )
}

function isCompositeScaffold(
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

function bindsDenseNativeFragmentSet(
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

function intersectionArea(
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

function coextensiveNativeLayers(group: PdfPageRegion[]) {
  return group.some((left, leftIndex) =>
    group.slice(leftIndex + 1).some((right) => {
      const smallerArea = Math.min(
        left.box.width * left.box.height,
        right.box.width * right.box.height,
      )
      return (
        smallerArea >= MIN_NATIVE_SCAFFOLD_AREA &&
        intersectionArea(left.box, right.box) / smallerArea >=
          MIN_COEXTENSIVE_NATIVE_LAYER_OVERLAP
      )
    }),
  )
}

function provesCaptionBoundedNativeScaffold(
  group: PdfPageRegion[],
  figureRegions: PdfPageRegion[],
) {
  const scope = unionObjectBox(group)
  if (scope.width * scope.height < MIN_NATIVE_SCAFFOLD_AREA) return false
  return (
    group.some((region) => isCompositeScaffold(region, figureRegions)) ||
    group.some((region) =>
      bindsDenseNativeFragmentSet(region, figureRegions),
    ) ||
    coextensiveNativeLayers(group) ||
    group.length >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT
  )
}

function unionObjectBox(regions: PdfPageRegion[]): NormalizedSourceBox {
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

function owningCaptionForBox(
  box: NormalizedSourceBox,
  captions: PdfPageRegion[],
) {
  return captions
    .filter((candidate) => {
      if (candidate.page !== box.page || candidate.box.y < box.y) return false
      const overlap = Math.max(
        0,
        Math.min(candidate.box.x + candidate.box.width, box.x + box.width) -
          Math.max(candidate.box.x, box.x),
      )
      return overlap >= Math.min(candidate.box.width, box.width) * 0.35
    })
    .sort((left, right) => left.box.y - right.box.y)[0]
}

function renderBoxForGroup(group: PdfPageRegion[], captions: PdfPageRegion[]) {
  const box = unionObjectBox(group)
  const caption = owningCaptionForBox(box, captions)
  if (!caption || box.y + box.height <= caption.box.y - 0.002) return box
  const bottom = Math.max(box.y + 0.004, caption.box.y - 0.004)
  return { ...box, height: rounded(bottom - box.y) }
}

function captionBoundedRenderBox(
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

function captionBoundedReadingOrderOverlays(
  group: PdfPageRegion[],
  figureRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
) {
  if (!provesCaptionBoundedNativeScaffold(group, figureRegions)) return []
  const nativeBox = unionObjectBox(group)
  const caption = owningCaptionForBox(nativeBox, captions)
  if (!caption) return []
  const scope = renderBoxForGroup(group, captions)
  const scopeArea = scope.width * scope.height
  const candidates = regions
    .filter(
      (region) =>
        region.page === scope.page &&
        region.includedInReadingOrder &&
        region.nativeObjectIds.length === 0 &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        ['body', 'spanning'].includes(region.kind) &&
        region.box.y + region.box.height <=
          caption.box.y + FIGURE_OVERLAY_BOX_TOLERANCE &&
        fullyContainsBox(scope, region.box, FIGURE_OVERLAY_BOX_TOLERANCE) &&
        region.box.width * region.box.height <=
          scopeArea * MAX_CAPTION_BOUNDED_FLOW_OVERLAY_AREA_RATIO,
    )
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
  const lineCount = candidates.reduce(
    (total, region) => total + region.lines.length,
    0,
  )
  if (lineCount >= MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT) {
    return candidates
  }
  // PDF extractors occasionally classify one short chart-legend label as
  // body text while classifying its sibling series/axis labels correctly.
  // A dense native scaffold, a caption boundary, and an independent enclosed
  // chart label jointly prove ownership without granting loose vector boxes
  // permission to absorb ordinary prose.
  const hasIndependentChartLabel = regions.some(
    (region) =>
      region.page === scope.page &&
      region.kind === 'chart-label' &&
      !region.includedInReadingOrder &&
      region.text.trim().length > 0 &&
      fullyContainsBox(scope, region.box, FIGURE_OVERLAY_BOX_TOLERANCE),
  )
  return candidates.length === 1 &&
    candidates[0].lines.length === 1 &&
    candidates[0].text.trim().length <=
      MAX_SINGLE_LINE_CHART_OVERLAY_CHARACTERS &&
    candidates[0].box.width * candidates[0].box.height <=
      scopeArea * MAX_SINGLE_LINE_CHART_OVERLAY_AREA_RATIO &&
    hasIndependentChartLabel
    ? candidates
    : []
}

function figureCandidates(
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  decorativeObjectIds: Set<string>,
) {
  const figureRegions = regions.filter(
    (region) => region.kind === 'figure' && region.nativeObjectIds.length > 0,
  )
  const remaining = figureRegions.filter(
    (region) =>
      !isDecorativeVectorArtifact(region, decorativeObjectIds) ||
      isCompositeScaffold(region, figureRegions),
  )
  const groups: PdfPageRegion[][] = []
  while (remaining.length > 0) {
    const group = [remaining.shift()!]
    for (let index = 0; index < remaining.length;) {
      if (
        group.some((region) => connected(region, remaining[index], captions))
      ) {
        group.push(remaining.splice(index, 1)[0])
        index = 0
      } else {
        index += 1
      }
    }
    groups.push(group)
  }
  return groups
    .map<VisualCandidate>((group) => {
      const flowOverlays = captionBoundedReadingOrderOverlays(
        group,
        figureRegions,
        regions,
        captions,
      )
      const claimedFlowOverlayIds = new Set(
        flowOverlays.map((region) => region.id),
      )
      const unclaimedReadingOrderText = regions.filter(
        (region) =>
          region.page === group[0].page &&
          region.includedInReadingOrder &&
          !claimedFlowOverlayIds.has(region.id) &&
          region.nativeObjectIds.length === 0 &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          ['body', 'spanning'].includes(region.kind),
      )
      const uncontaminatedGroup = group.filter(
        (region) =>
          !materiallyOverlapsSourceText(region, unclaimedReadingOrderText),
      )
      const nativeGroup =
        provesCaptionBoundedNativeScaffold(group, figureRegions) &&
        uncontaminatedGroup.length >= MIN_COMPOSITE_FIGURE_FRAGMENTS
          ? uncontaminatedGroup
          : group
      const nativeRenderBox = renderBoxForGroup(nativeGroup, captions)
      const overlays = [
        ...boundedTextOverlays(nativeGroup, regions, captions),
        ...flowOverlays,
      ].sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
      const provesNativeScaffold = provesCaptionBoundedNativeScaffold(
        group,
        figureRegions,
      )
      const captionBoundedOverlayLineCount = overlays.reduce(
        (total, region) => total + region.lines.length,
        0,
      )
      const useCaptionBounds =
        provesNativeScaffold &&
        (flowOverlays.reduce(
          (total, region) => total + region.lines.length,
          0,
        ) >= MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT ||
          (nativeGroup.length < group.length &&
            captionBoundedOverlayLineCount >=
              MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT))
      const ownsSingleLineChartOverlay =
        flowOverlays.length === 1 && flowOverlays[0].lines.length === 1
      const renderBox = captionBoundedRenderBox(
        [...nativeGroup, ...overlays],
        captions,
        useCaptionBounds,
      )
      const nativeGroupIds = new Set(nativeGroup.map((region) => region.id))
      const omittedNativeMaterial = group.filter(
        (region) =>
          !nativeGroupIds.has(region.id) &&
          !isCompositeScaffold(region, figureRegions) &&
          !bindsDenseNativeFragmentSet(region, figureRegions) &&
          intersectionArea(region.box, renderBox) > 0,
      )
      const sourcePageCropBlockedByReadingOrderText =
        scopeContainsReadingOrderText(
          paddedUnionBox([nativeRenderBox]),
          regions,
          new Set(flowOverlays.map((region) => region.id)),
        )
      const nativeLineage = nativeGroup.flatMap((region) =>
        region.nativeObjectIds.map((sourceObjectId) => ({
          sourceObjectId,
          sourceBox: region.box,
        })),
      )
      const overlayLineage = overlays.map((region) => ({
        sourceObjectId: textOverlayId(region),
        sourceBox: region.box,
      }))
      const lineage = [...nativeLineage, ...overlayLineage]
      return {
        kind: 'figure',
        sourceRegionIds: [
          ...nativeGroup.map((region) => region.id),
          ...overlays.map((region) => region.id),
        ],
        sourceObjectIds: lineage.map((item) => item.sourceObjectId),
        assetIds: [],
        sourceBoxes: lineage.map((item) => item.sourceBox),
        sourceText: overlays.map((region) => region.text).join(' '),
        page: group[0].page,
        renderBox,
        sourcePageCropBlockedByReadingOrderText,
        nativeEnvelopeIncomplete: omittedNativeMaterial.length > 0,
        evidence: [
          ...(useCaptionBounds ? ['caption-bounded-native-scaffold'] : []),
          ...(ownsSingleLineChartOverlay
            ? ['single-line-chart-overlay-source-owned']
            : []),
          ...(nativeGroup.length < group.length
            ? ['source-scaffold-trimmed-reading-order-overlap']
            : []),
          ...(sourcePageCropBlockedByReadingOrderText
            ? ['source-page-crop-vetoed-reading-order-text']
            : []),
          ...(omittedNativeMaterial.length > 0
            ? ['source-native-envelope-incomplete']
            : []),
        ],
        column: [...nativeGroup, ...overlays].every(
          (region) => region.column === nativeGroup[0].column,
        )
          ? nativeGroup[0].column
          : 'span',
      }
    })
    .sort(
      (left, right) =>
        left.page - right.page ||
        Math.min(...left.sourceBoxes.map((box) => box.y)) -
          Math.min(...right.sourceBoxes.map((box) => box.y)),
    )
}

function nextSourceRegions(
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
      (region.column === caption.column ||
        region.column === 'span' ||
        caption.column === 'span') &&
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

function tableRowBandCount(lines: PdfPageRegion['lines']) {
  const rows: number[] = []
  for (const line of lines) {
    if (line.runs.every((run) => !run.text.trim())) continue
    if (!rows.some((y) => Math.abs(y - line.box.y) <= 0.004))
      rows.push(line.box.y)
  }
  return rows.length
}

function unionBox(regions: PdfPageRegion[]): NormalizedSourceBox {
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

function boxForLines(lines: PdfPageRegion['lines']): NormalizedSourceBox {
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

function availableRegionsForTable(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  consumedLineIds: ReadonlySet<string>,
) {
  return regions.flatMap((region) => {
    if (region.kind === 'caption') return [region]
    if (consumedRegionIds.has(region.id)) return []
    const retainedLines = region.lines.filter(
      (line) => !consumedLineIds.has(line.id),
    )
    if (retainedLines.length === region.lines.length) return [region]
    if (retainedLines.length === 0) return []
    return [
      {
        ...region,
        text: retainedLines.map((line) => line.text).join(' '),
        box: boxForLines(retainedLines),
        lines: retainedLines,
      },
    ]
  })
}

function paddedUnionBox(boxes: NormalizedSourceBox[]) {
  const padding = 0.004
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - padding)
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - padding)
  const right = Math.min(
    1,
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

function intersectSourceBox(
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

function sourceLineageWithinRenderScope(
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

function nativeOnlyFigureCandidate(
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
    assetIds: nativeLineage
      .map((item) => objectAssetIds.get(item.sourceObjectId))
      .filter((assetId): assetId is string => Boolean(assetId)),
    sourceText: '',
  }
}

function mergeAsset(store: Map<string, PdfVisualAsset>, next: PdfVisualAsset) {
  const current = store.get(next.id)
  if (!current) {
    store.set(next.id, next)
    return
  }
  for (const [index, sourceObjectId] of next.sourceObjectIds.entries()) {
    if (current.sourceObjectIds.includes(sourceObjectId)) continue
    current.sourceObjectIds.push(sourceObjectId)
    current.sourceBoxes.push({ ...next.sourceBoxes[index] })
  }
}

function sameSourceBox(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    left.method === right.method &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => Math.abs(left[key] - right[key]) <= 0.00001,
    )
  )
}

function hasValidPayload(asset: PdfVisualAsset) {
  return (
    asset.id.trim().length > 0 &&
    asset.href.trim().length > 0 &&
    asset.bytes.byteLength > 0 &&
    Number.isFinite(asset.width) &&
    asset.width > 0 &&
    Number.isFinite(asset.height) &&
    asset.height > 0
  )
}

function completeSingleSourceAsset(
  visualAsset: PdfVisualAsset | undefined,
  sourceObjectId: string,
  sourceBox: NormalizedSourceBox,
) {
  if (
    !visualAsset ||
    !sourceObjectId.trim() ||
    !hasValidPayload(visualAsset) ||
    !['source-preserved', 'semantic-table'].includes(visualAsset.rendition) ||
    visualAsset.sourceObjectIds.length !== visualAsset.sourceBoxes.length
  ) {
    return false
  }
  const assetIndex = visualAsset.sourceObjectIds.indexOf(sourceObjectId)
  return (
    assetIndex >= 0 &&
    sameSourceBox(visualAsset.sourceBoxes[assetIndex], sourceBox)
  )
}

function materiallyOverlapsSourceText(
  objectRegion: PdfPageRegion,
  textSources: PdfPageRegion[],
) {
  return textSources.some((source) => {
    if (source.page !== objectRegion.page) return false
    if (
      source.nativeObjectIds.some((sourceObjectId) =>
        objectRegion.nativeObjectIds.includes(sourceObjectId),
      )
    ) {
      return true
    }
    const width = Math.max(
      0,
      Math.min(
        source.box.x + source.box.width,
        objectRegion.box.x + objectRegion.box.width,
      ) - Math.max(source.box.x, objectRegion.box.x),
    )
    const height = Math.max(
      0,
      Math.min(
        source.box.y + source.box.height,
        objectRegion.box.y + objectRegion.box.height,
      ) - Math.max(source.box.y, objectRegion.box.y),
    )
    const smallerArea = Math.min(
      source.box.width * source.box.height,
      objectRegion.box.width * objectRegion.box.height,
    )
    return smallerArea > 0 && (width * height) / smallerArea >= 0.35
  })
}

function sourceEquationRendition(
  caption: PdfPageRegion,
  textSources: PdfPageRegion[],
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null>,
  objectBoxes: ReadonlyMap<string, NormalizedSourceBox>,
  assetStore: ReadonlyMap<string, PdfVisualAsset>,
): VisualCandidate | null {
  const captionBottom = caption.box.y + caption.box.height
  const candidates = regions
    .filter((region) => {
      if (
        region.page !== caption.page ||
        region.nativeObjectIds.length !== 1 ||
        !['figure', 'equation'].includes(region.kind) ||
        !materiallyOverlapsSourceText(region, textSources)
      ) {
        return false
      }
      const distance = region.box.y - captionBottom
      const overlap = Math.max(
        0,
        Math.min(
          region.box.x + region.box.width,
          caption.box.x + caption.box.width,
        ) - Math.max(region.box.x, caption.box.x),
      )
      return (
        distance >= -0.02 &&
        distance <= 0.16 &&
        overlap >= Math.min(region.box.width, caption.box.width) * 0.35
      )
    })
    .flatMap((region) => {
      const sourceObjectId = region.nativeObjectIds[0]
      const assetId = objectAssetIds.get(sourceObjectId)
      const sourceBox = objectBoxes.get(sourceObjectId)
      const visualAsset = assetId ? assetStore.get(assetId) : undefined
      return sourceBox &&
        assetId &&
        completeSingleSourceAsset(visualAsset, sourceObjectId, sourceBox)
        ? [
            {
              region,
              sourceObjectId,
              sourceBox,
              assetId,
              visualAsset: visualAsset!,
            },
          ]
        : []
    })
    .sort(
      (left, right) =>
        Math.abs(left.region.box.y - captionBottom) -
          Math.abs(right.region.box.y - captionBottom) ||
        left.sourceObjectId.localeCompare(right.sourceObjectId),
    )
  const selected = candidates[0]
  if (!selected) return null
  return {
    kind: 'equation',
    sourceRegionIds: [
      ...textSources.map((region) => region.id),
      selected.region.id,
    ],
    sourceObjectIds: [selected.sourceObjectId],
    assetIds: [selected.assetId],
    sourceBoxes: [selected.sourceBox],
    sourceText: equationSourceText(textSources),
    page: selected.region.page,
    column: selected.region.column,
    evidence: [
      selected.visualAsset.kind === 'raster'
        ? 'source-glyph-raster'
        : 'source-glyph-vector',
      'accessible-source-text',
      'bounded-source-geometry',
    ],
  }
}

function completeCompositeAsset(
  visualAsset: PdfVisualAsset,
  sourceObjectIds: string[],
  sourceBoxes: NormalizedSourceBox[],
) {
  const sourcePreservedSvgComposite =
    visualAsset.mediaType === 'image/svg+xml' &&
    visualAsset.kind === 'vector' &&
    visualAsset.rendition === 'source-preserved' &&
    new TextDecoder()
      .decode(visualAsset.bytes)
      .includes('data-pdf-composite="true"')
  const rasterComposite =
    visualAsset.mediaType === 'image/png' &&
    visualAsset.kind === 'raster' &&
    visualAsset.rendition === 'browser-composite-raster'
  if (
    (!rasterComposite && !sourcePreservedSvgComposite) ||
    !hasValidPayload(visualAsset) ||
    !Number.isFinite(visualAsset.width) ||
    visualAsset.width <= 0 ||
    !Number.isFinite(visualAsset.height) ||
    visualAsset.height <= 0 ||
    sourceObjectIds.length < MIN_COMPOSITE_FIGURE_FRAGMENTS ||
    sourceObjectIds.length !== sourceBoxes.length ||
    visualAsset.sourceObjectIds.length !== sourceObjectIds.length ||
    visualAsset.sourceBoxes.length !== sourceObjectIds.length ||
    new Set(visualAsset.sourceObjectIds).size !== sourceObjectIds.length
  ) {
    return false
  }
  return sourceObjectIds.every((sourceObjectId, index) => {
    const assetIndex = visualAsset.sourceObjectIds.indexOf(sourceObjectId)
    return (
      assetIndex >= 0 &&
      sameSourceBox(visualAsset.sourceBoxes[assetIndex], sourceBoxes[index])
    )
  })
}

function completeSourcePageCropAsset(
  visualAsset: PdfVisualAsset,
  kind: VisualKind,
  sourceObjectIds: string[],
  sourceBoxes: NormalizedSourceBox[],
  sourceCropBox: NormalizedSourceBox,
) {
  return (
    sourcePageCropValidationFailure(
      visualAsset,
      kind,
      sourceObjectIds,
      sourceBoxes,
      sourceCropBox,
    ) === null
  )
}

function sourcePageCropValidationFailure(
  visualAsset: PdfVisualAsset,
  kind: VisualKind,
  sourceObjectIds: string[],
  sourceBoxes: NormalizedSourceBox[],
  sourceCropBox: NormalizedSourceBox,
) {
  const expectedKind = kind === 'figure' ? 'raster' : kind
  if (
    visualAsset.mediaType !== 'image/png' ||
    visualAsset.kind !== expectedKind ||
    visualAsset.rendition !== 'source-page-crop'
  ) {
    return 'source-page-crop-rendition-rejected'
  }
  if (!visualAsset.sourceCropBox) {
    return 'source-page-crop-identity-rejected'
  }
  const sourceInkTightened = !sameSourceBox(
    visualAsset.sourceCropBox,
    sourceCropBox,
  )
  if (
    sourceInkTightened &&
    (kind !== 'figure' ||
      visualAsset.sourceCropBox.method !== sourceCropBox.method ||
      !fullyContainsBox(
        sourceCropBox,
        visualAsset.sourceCropBox,
        SOURCE_CROP_CONTAINMENT_TOLERANCE,
      ))
  ) {
    return 'source-page-crop-identity-rejected'
  }
  if (
    !hasValidPayload(visualAsset) ||
    !isValidSourcePageCropPayload(visualAsset)
  ) {
    return 'source-page-crop-payload-rejected'
  }
  if (
    sourceObjectIds.length === 0 ||
    sourceObjectIds.length !== sourceBoxes.length ||
    new Set(sourceObjectIds).size !== sourceObjectIds.length
  ) {
    return 'source-page-crop-lineage-rejected'
  }
  const expectedLineage = sourceInkTightened
    ? sourceObjectIds.flatMap((sourceObjectId, index) => {
        const clippedBox = intersectSourceBox(
          visualAsset.sourceCropBox!,
          sourceBoxes[index],
        )
        return clippedBox ? [{ sourceObjectId, sourceBox: clippedBox }] : []
      })
    : sourceObjectIds.map((sourceObjectId, index) => ({
        sourceObjectId,
        sourceBox: sourceBoxes[index],
      }))
  if (
    expectedLineage.length === 0 ||
    visualAsset.sourceObjectIds.length !== expectedLineage.length ||
    visualAsset.sourceBoxes.length !== expectedLineage.length ||
    new Set(visualAsset.sourceObjectIds).size !== expectedLineage.length
  ) {
    return 'source-page-crop-lineage-rejected'
  }
  if (
    visualAsset.sourceBoxes.some(
      (sourceBox) =>
        !fullyContainsBox(
          visualAsset.sourceCropBox!,
          sourceBox,
          SOURCE_CROP_CONTAINMENT_TOLERANCE,
        ),
    )
  ) {
    return 'source-page-crop-containment-rejected'
  }
  const exactLineage = expectedLineage.every((item) => {
    const assetIndex = visualAsset.sourceObjectIds.indexOf(item.sourceObjectId)
    return (
      assetIndex >= 0 &&
      sameSourceBox(visualAsset.sourceBoxes[assetIndex], item.sourceBox)
    )
  })
  return exactLineage ? null : 'source-page-crop-lineage-geometry-rejected'
}

function sourcePageCropFailureEvidence(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'source-page-crop-aborted'
  }
  const message = error instanceof Error ? error.message : ''
  if (/timed out/i.test(message)) return 'source-page-crop-timeout'
  if (/bounded|rotation|source region/i.test(message)) {
    return 'source-page-crop-geometry-rejected'
  }
  if (/pixel|ink|png|rgba/i.test(message)) {
    return 'source-page-crop-payload-rejected'
  }
  if (/canvas|render|bitmap|image\s*data/i.test(message)) {
    return 'source-page-crop-render-backend-error'
  }
  return 'source-page-crop-rasterization-error'
}

function sourcePageCropTouchesEdge(error: unknown) {
  return (
    error instanceof Error &&
    /source ink touching its edge/i.test(error.message)
  )
}

function candidateScore(
  caption: PdfPageRegion,
  label: NonNullable<ReturnType<typeof visualLabel>>,
  candidate: VisualCandidate,
  sequence: number,
  regions: PdfPageRegion[],
) {
  if (candidate.page !== caption.page) return null
  const nativeSourceBoxes = candidate.sourceObjectIds
    .map((sourceObjectId, index) =>
      sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)
        ? null
        : candidate.sourceBoxes[index],
    )
    .filter((sourceBox): sourceBox is NormalizedSourceBox => Boolean(sourceBox))
  if (
    label.kind === 'figure' &&
    caption.box.width < MIN_CROSS_COLUMN_FIGURE_SPAN &&
    nativeSourceBoxes.some(
      (sourceBox) => horizontalOverlapRatio(caption.box, sourceBox) < 0.35,
    )
  ) {
    return null
  }
  const scopeBoxes = candidate.renderBox
    ? [candidate.renderBox]
    : candidate.sourceBoxes
  const top = Math.min(...scopeBoxes.map((box) => box.y))
  const bottom = Math.max(...scopeBoxes.map((box) => box.y + box.height))
  const captionBottom = caption.box.y + caption.box.height
  const figureDirection =
    label.kind !== 'figure'
      ? null
      : bottom <= caption.box.y + 0.004
        ? ('object-above-caption' as const)
        : top >= captionBottom - 0.004
          ? ('object-below-caption' as const)
          : null
  if (label.kind === 'figure' && !figureDirection) return null
  const distance =
    label.kind === 'figure'
      ? figureDirection === 'object-above-caption'
        ? caption.box.y - bottom
        : top - captionBottom
      : label.kind === 'table' && bottom <= caption.box.y + 0.004
        ? caption.box.y - bottom
        : top - captionBottom
  if (distance < -0.02 || distance > 0.28) return null
  let score = 0.44
  const evidence = ['same-page-scope', ...(candidate.evidence ?? [])]
  if (figureDirection) evidence.push(figureDirection)
  if (distance <= 0.08) {
    score += 0.24 * (1 - Math.max(distance, 0) / 0.08)
    evidence.push('bounded-distance')
  }
  if (
    caption.column === candidate.column ||
    caption.column === 'span' ||
    candidate.column === 'span'
  ) {
    score += 0.1
    evidence.push('column-scope')
  }
  const left = Math.max(
    caption.box.x,
    Math.min(...scopeBoxes.map((box) => box.x)),
  )
  const right = Math.min(
    caption.box.x + caption.box.width,
    Math.max(...scopeBoxes.map((box) => box.x + box.width)),
  )
  const horizontalOverlap = Math.max(right - left, 0)
  const candidateWidth =
    Math.max(...scopeBoxes.map((box) => box.x + box.width)) -
    Math.min(...scopeBoxes.map((box) => box.x))
  const horizontalAlignment =
    caption.box.width > 0 && candidateWidth > 0
      ? Math.min(
          horizontalOverlap / caption.box.width,
          horizontalOverlap / candidateWidth,
        )
      : 0
  if (horizontalAlignment >= 0.5) {
    score += 0.14 * horizontalAlignment
    evidence.push('horizontal-alignment')
  }
  const numericSequence = Number.parseInt(label.sequence, 10)
  // The figure-candidate ordinal is only the order in which native objects
  // survived extraction. It is not a source-grounded figure number: decorative
  // plots, missed figures, and multi-panel groups can all shift it. Using that
  // ordinal as a strong figure signal can therefore outrank the object directly
  // adjacent to a caption. Keep positional sequence evidence for generated
  // table/equation candidates, but never use it to guess a figure relationship.
  if (label.kind !== 'figure') {
    if (Number.isFinite(numericSequence) && numericSequence === sequence + 1) {
      score += 0.12
      evidence.push('label-sequence')
    } else if (Number.isFinite(numericSequence)) {
      score -= 0.08
      evidence.push('label-sequence-mismatch')
    }
  }
  if (caption.confidence >= 0.9) {
    score += 0.05
    evidence.push('caption-typography')
  }
  const crossReference = new RegExp(
    `\\b${label.label.replace(/\s+/g, '\\s+')}\\b`,
    'i',
  )
  if (
    regions.some(
      (region) => region.id !== caption.id && crossReference.test(region.text),
    )
  ) {
    score += 0.05
    evidence.push('source-cross-reference')
  }
  return { score: rounded(Math.min(score, 1)), evidence }
}

function matchCandidate(
  caption: PdfPageRegion,
  label: NonNullable<ReturnType<typeof visualLabel>>,
  candidates: VisualCandidate[],
  regions: PdfPageRegion[],
) {
  const allScored = candidates
    .map((candidate, index) => {
      const score = candidateScore(caption, label, candidate, index, regions)
      return score ? { candidate, ...score } : null
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
  const directionScored =
    label.kind === 'figure' &&
    allScored.some((candidate) =>
      candidate.evidence.includes('object-above-caption'),
    )
      ? allScored.filter((candidate) =>
          candidate.evidence.includes('object-above-caption'),
        )
      : allScored
  const candidateScope = (candidate: VisualCandidate) => {
    const boxes = candidate.renderBox
      ? [candidate.renderBox]
      : candidate.sourceBoxes
    if (boxes.length === 0) return null
    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.width))
    const bottom = Math.max(...boxes.map((box) => box.y + box.height))
    return {
      page: boxes[0].page,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      rotation: boxes[0].rotation,
      method: boxes[0].method,
    } satisfies NormalizedSourceBox
  }
  const isUniqueNativeRaster = (candidate: VisualCandidate) =>
    candidate.sourceObjectIds.length === 1 &&
    candidate.sourceObjectIds[0].startsWith('image-') &&
    candidate.assetIds.length === 1
  const shadowedByNearerRaster = (
    farther: (typeof directionScored)[number],
  ) => {
    if (
      label.kind !== 'figure' ||
      !isUniqueNativeRaster(farther.candidate) ||
      farther.evidence.includes('bounded-distance')
    ) {
      return false
    }
    const fartherBox = candidateScope(farther.candidate)
    if (!fartherBox) return false
    const direction = farther.evidence.includes('object-above-caption')
      ? 'above'
      : farther.evidence.includes('object-below-caption')
        ? 'below'
        : null
    if (!direction) return false
    return directionScored.some((nearer) => {
      if (
        nearer === farther ||
        !nearer.evidence.includes('bounded-distance') ||
        !nearer.evidence.includes(`object-${direction}-caption`) ||
        !isUniqueNativeRaster(nearer.candidate)
      ) {
        return false
      }
      const nearerBox = candidateScope(nearer.candidate)
      if (!nearerBox) return false
      const verticallyBetween =
        direction === 'above'
          ? fartherBox.y + fartherBox.height <= nearerBox.y + 0.004
          : nearerBox.y + nearerBox.height <= fartherBox.y + 0.004
      return (
        verticallyBetween &&
        horizontalOverlapRatio(nearerBox, fartherBox) >= 0.65 &&
        horizontalOverlapRatio(caption.box, nearerBox) >= 0.5 &&
        horizontalOverlapRatio(caption.box, fartherBox) >= 0.5
      )
    })
  }
  const scored = directionScored
    .filter((candidate) => !shadowedByNearerRaster(candidate))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.sourceObjectIds
          .join(':')
          .localeCompare(right.candidate.sourceObjectIds.join(':')),
    )
  const best = scored[0]
  const ambiguous =
    Boolean(best) && Boolean(scored[1]) && best.score - scored[1].score < 0.08
  return {
    scored,
    best,
    ambiguous,
    matched: Boolean(best) && best.score >= 0.72 && !ambiguous,
  }
}

function tableScopeCandidate(
  scope: PdfTableScope,
  resolution: PdfTableScopeResolution,
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null>,
): VisualCandidate {
  const sourceRegions = scope.sourceRegionIds
    .map((sourceRegionId) =>
      regions.find((region) => region.id === sourceRegionId),
    )
    .filter((region): region is PdfPageRegion => Boolean(region))
  const textScope =
    scope.proof === 'text-grid' ||
    scope.proof === 'text-nonuniform-grid' ||
    scope.proof === 'text-tabular-line-band' ||
    scope.proof === 'caption-bounded-text-slab'
  const syntheticTextGridObjectId = `table-scope-source:${scope.id}`
  const sourceObjectIds = textScope
    ? [syntheticTextGridObjectId]
    : scope.objectLineage.map((source) => source.objectId)
  const sourceBoxes = textScope
    ? [{ ...scope.cropBox }]
    : scope.objectLineage.map((source) => ({ ...source.box }))
  const evidence = [
    'bounded-table-scope',
    'non-semantic-source-scope',
    ...scope.evidence.map((item) => item.code),
    ...(resolution.status === 'ambiguous'
      ? [
          'bounded-table-scope-ambiguous',
          resolution.ambiguity.code,
          ...resolution.ambiguity.evidence,
        ]
      : []),
  ]
  const selectedSourceText = textScope
    ? scope.lineLineage
        .map((lineage) =>
          sourceRegions
            .find((region) => region.id === lineage.regionId)
            ?.lines.find((line) => line.id === lineage.lineId),
        )
        .filter((line): line is NonNullable<typeof line> => Boolean(line))
        .map((line) => line.text)
        .join(' ')
    : sourceRegions
        .map((sourceRegion) => sourceRegion.text)
        .filter(Boolean)
        .join(' ')
  return {
    kind: 'table',
    sourceRegionIds: [...scope.sourceRegionIds],
    sourceLineIds: [...scope.sourceLineIds],
    sourceObjectIds,
    assetIds: [
      ...new Set(
        sourceObjectIds
          .map((sourceObjectId) => objectAssetIds.get(sourceObjectId))
          .filter((assetId): assetId is string => Boolean(assetId)),
      ),
    ],
    sourceBoxes,
    sourceText: selectedSourceText,
    page: scope.page,
    column:
      sourceRegions.length > 0 &&
      sourceRegions.every(
        (sourceRegion) => sourceRegion.column === sourceRegions[0].column,
      )
        ? sourceRegions[0].column
        : 'span',
    renderBox: { ...scope.cropBox },
    evidence: [...new Set(evidence)],
    ...(scope.lineLineage.length > 0
      ? {
          tableRegionLineage: scope.regionLineage.map((lineage) => ({
            ...lineage,
            lineIds: [...lineage.lineIds],
            retainedLineIds: [...lineage.retainedLineIds],
            box: { ...lineage.box },
          })),
        }
      : {}),
  }
}

function tableHeaderOutsideSourceScope(
  candidate: VisualCandidate,
  regions: PdfPageRegion[],
) {
  const scope = candidate.renderBox
  if (!scope || scope.width <= 0) return false
  const sourceRegionIds = new Set(candidate.sourceRegionIds)
  const adjacentHeaders = regions.filter((region) => {
    if (
      region.page !== scope.page ||
      region.kind !== 'header' ||
      sourceRegionIds.has(region.id) ||
      region.lines.length === 0 ||
      !region.text.trim()
    ) {
      return false
    }
    const gap = scope.y - (region.box.y + region.box.height)
    return (
      gap >= -0.002 &&
      gap <= MAX_TABLE_HEADER_SCOPE_GAP &&
      horizontalBoxOverlap(scope, region.box) > 0
    )
  })
  const runCount = adjacentHeaders.reduce(
    (total, region) =>
      total + region.lines.reduce((lines, line) => lines + line.runs.length, 0),
    0,
  )
  if (adjacentHeaders.length < 2 && runCount < 3) return false
  const intervals = adjacentHeaders
    .map(
      (region) =>
        [
          Math.max(scope.x, region.box.x),
          Math.min(scope.x + scope.width, region.box.x + region.box.width),
        ] as const,
    )
    .filter(([left, right]) => right > left)
    .sort(([left], [right]) => left - right)
  let covered = 0
  let intervalLeft: number | null = null
  let intervalRight: number | null = null
  for (const [left, right] of intervals) {
    if (intervalLeft === null || intervalRight === null) {
      intervalLeft = left
      intervalRight = right
    } else if (left <= intervalRight) {
      intervalRight = Math.max(intervalRight, right)
    } else {
      covered += intervalRight - intervalLeft
      intervalLeft = left
      intervalRight = right
    }
  }
  if (intervalLeft !== null && intervalRight !== null) {
    covered += intervalRight - intervalLeft
  }
  return covered / scope.width >= MIN_TABLE_HEADER_HORIZONTAL_COVERAGE
}

function horizontalCoverageWithinScope(
  scope: NormalizedSourceBox,
  boxes: NormalizedSourceBox[],
) {
  const intervals = boxes
    .map(
      (box) =>
        [
          Math.max(scope.x, box.x),
          Math.min(scope.x + scope.width, box.x + box.width),
        ] as const,
    )
    .filter(([left, right]) => right > left)
    .sort(([left], [right]) => left - right)
  let covered = 0
  let intervalLeft: number | null = null
  let intervalRight: number | null = null
  for (const [left, right] of intervals) {
    if (intervalLeft === null || intervalRight === null) {
      intervalLeft = left
      intervalRight = right
    } else if (left <= intervalRight) {
      intervalRight = Math.max(intervalRight, right)
    } else {
      covered += intervalRight - intervalLeft
      intervalLeft = left
      intervalRight = right
    }
  }
  if (intervalLeft !== null && intervalRight !== null) {
    covered += intervalRight - intervalLeft
  }
  return scope.width > 0 ? covered / scope.width : 0
}

function completeSemanticTableScope(
  detectedTable: DetectedPdfTable | null,
  resolution: PdfTableScopeResolution,
): CompleteSemanticTableScope | null {
  const scope = resolution.scope
  if (
    !detectedTable ||
    resolution.status !== 'matched' ||
    !scope ||
    scope.sourceLineIds.length === 0 ||
    detectedTable.sourceLineIds.length === 0
  ) {
    return null
  }

  const detectedLineIds = new Set(detectedTable.sourceLineIds)
  if (!scope.sourceLineIds.every((lineId) => detectedLineIds.has(lineId))) {
    return null
  }

  const sourceLineOwners = new Map<string, PdfPageRegion[]>()
  for (const region of detectedTable.sourceRegions) {
    for (const line of region.lines) {
      if (!line.text.trim() && line.runs.every((run) => !run.text.trim())) {
        continue
      }
      const owners = sourceLineOwners.get(line.id) ?? []
      owners.push(region)
      sourceLineOwners.set(line.id, owners)
    }
  }
  // The semantic detector must account for every non-empty line in every
  // source region it claims. A rectangular subset of a mixed prose parent is
  // not a complete table and must remain on the crop-only path.
  if (
    sourceLineOwners.size !== detectedLineIds.size ||
    [...sourceLineOwners.keys()].some((lineId) => !detectedLineIds.has(lineId))
  ) {
    return null
  }

  const boundedLineIds = new Set(scope.sourceLineIds)
  const closingHeaderRegions = [
    ...new Map(
      detectedTable.sourceLineIds
        .filter((lineId) => !boundedLineIds.has(lineId))
        .flatMap((lineId) => sourceLineOwners.get(lineId) ?? [])
        .map((region) => [region.id, region] as const),
    ).values(),
  ]
  if (
    closingHeaderRegions.some((region) => region.kind !== 'header') ||
    closingHeaderRegions.some((region) => {
      const gap = scope.cropBox.y - (region.box.y + region.box.height)
      return (
        region.page !== scope.page ||
        gap < -0.002 ||
        gap > MAX_TABLE_HEADER_SCOPE_GAP
      )
    }) ||
    (closingHeaderRegions.length > 0 &&
      horizontalCoverageWithinScope(
        scope.cropBox,
        closingHeaderRegions.map((region) => region.box),
      ) < MIN_TABLE_HEADER_HORIZONTAL_COVERAGE)
  ) {
    return null
  }

  const sourceHeaderLineIds =
    detectedTable.headerEvidence?.detectedHeaderLineIds ?? []
  if (
    !canonicalTableFromLines(detectedTable.lines, {
      sourceHeaderLineIds,
      detectedRectangularGeometry: true,
    })
  ) {
    return null
  }
  return {
    sourceHeaderLineIds,
    evidence: [
      'complete-bounded-table-scope',
      detectedTable.headerEvidence
        ? 'semantic-header-table-local-geometry'
        : 'semantic-header-explicit-style',
    ],
  }
}

function matchTableScopeResolution(
  resolution: PdfTableScopeResolution,
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null>,
): ReturnType<typeof matchCandidate> {
  const scored = resolution.candidates.map((scope) => {
    const candidate = tableScopeCandidate(
      scope,
      resolution,
      regions,
      objectAssetIds,
    )
    if (tableHeaderOutsideSourceScope(candidate, regions)) {
      candidate.nativeEnvelopeIncomplete = true
      candidate.evidence = [
        ...(candidate.evidence ?? []),
        'table-header-outside-source-scope',
      ]
    }
    const sourceConfidences = candidate.sourceRegionIds
      .map((sourceRegionId) =>
        regions.find((region) => region.id === sourceRegionId),
      )
      .filter((region): region is PdfPageRegion => Boolean(region))
      .map((region) => region.confidence)
    return {
      candidate,
      score: rounded(Math.min(caption.confidence, ...sourceConfidences)),
      evidence: ['same-page-scope', ...(candidate.evidence ?? [])],
    }
  })
  const best = scored[0]
  return {
    scored,
    best,
    ambiguous: resolution.status === 'ambiguous',
    matched:
      resolution.status === 'matched' &&
      scored.length === 1 &&
      Boolean(best) &&
      !best?.candidate.nativeEnvelopeIncomplete,
  }
}

function matchRecord(
  scored: ReturnType<typeof matchCandidate>['scored'][number],
): PdfVisualMatchCandidate {
  return {
    sourceRegionIds: scored.candidate.sourceRegionIds,
    sourceObjectIds: scored.candidate.sourceObjectIds,
    assetIds: scored.candidate.assetIds,
    score: scored.score,
    evidence: scored.evidence,
    sourceBoxes: scored.candidate.sourceBoxes,
  }
}

function probableDisplayEquationText(sourceText: string) {
  const text = sourceText.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 240) return false
  if (
    /^(?:\d{1,3}|[A-Za-z])[.)]\s+\S/u.test(text) ||
    /^\(\s*\d{1,3}\s*\)\s+\S/u.test(text)
  ) {
    return false
  }
  if (
    /(?:https?:\/\/|www\.|openreview|forum\?id=|\bdoi\s*:|\S+@\S+)/iu.test(
      text,
    ) ||
    /(?:^|\s)(?:id|doi)\s*=\s*[A-Za-z0-9_-]{6,}\.?$/u.test(text)
  ) {
    return false
  }
  const proseWords = text.match(/[A-Za-z]{2,}/g) ?? []
  const proseCue =
    /\b(?:the|this|that|these|those|we|our|for|with|from|where|which|using|use|used|each|value|model|models|result|results|example|examples|figure|table|equation|performance|activating|because|namely|allowing|represents|output|number|sharp|discontinuity|simple|optimizer|epochs|trained|gains|point|moving)\b/iu.test(
      text,
    )
  if (proseCue && proseWords.length >= 2) return false
  const operators = text.match(/[=+-−×÷∫∑√≤≥≈∼⊙∂∞∏∈∉→←]/gu)?.length ?? 0
  const compactLength = text.replace(/\s+/g, '').length
  const operatorDensity = compactLength > 0 ? operators / compactLength : 0
  const hasRelation =
    /[\p{L}\p{N})\]}]\s*(?:=+|≤|≥|≈|∼|∈|∉|→|←)\s*[\p{L}\p{N}([{]/u.test(text)
  const hasLargeOperator = /[∫∑√∂∞∏⊙]/u.test(text)
  if (hasRelation) return proseWords.length <= 3 || operatorDensity >= 0.1
  return (
    (hasLargeOperator || operators > 0) &&
    proseWords.length <= 1 &&
    operatorDensity >= 0.12
  )
}

export function isProbableDisplayEquation(region: PdfPageRegion) {
  return (
    region.kind === 'equation' &&
    region.lines.length > 0 &&
    probableDisplayEquationText(region.text)
  )
}

function compactEquationFragment(region: PdfPageRegion) {
  const text = region.text.trim()
  return (
    region.lines.length > 0 &&
    text.length > 0 &&
    text.length <= 12 &&
    !/\s/u.test(text) &&
    /^[\p{L}\p{N}()[\]{}.,|+*/=<>_\-−×÷≤≥≈∼⊙∂∞∏∈∉→←]+$/u.test(text) &&
    (/[\p{N}=−×÷≤≥≈∼⊙∂∞∏∈∉→←]/u.test(text) || /\p{Script=Greek}/u.test(text))
  )
}

function printedEquationNumberFragment(region: PdfPageRegion) {
  return /^\(\s*\d+[a-z]?\s*\)$/i.test(region.text.trim())
}

function alignedPrintedEquationNumber(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
) {
  if (!printedEquationNumberFragment(candidate)) return false
  const gap = boxGap(source.box, candidate.box)
  const sourceCenter = source.box.y + source.box.height / 2
  const candidateCenter = candidate.box.y + candidate.box.height / 2
  const aligned =
    Math.abs(sourceCenter - candidateCenter) <=
    Math.max(0.018, source.box.height, candidate.box.height)
  const toRight = candidate.box.x >= source.box.x + source.box.width
  const inRightMarginBand =
    candidate.box.x >= Math.max(0.65, source.box.x + source.box.width * 0.65)
  const nearOrMarginAligned = gap.horizontal <= 0.08 || inRightMarginBand
  return aligned && (toRight || inRightMarginBand) && nearOrMarginAligned
}

function adjacentDisplayEquationRegion(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
) {
  const gap = boxGap(source.box, candidate.box)
  const horizontalOverlap = Math.max(
    0,
    Math.min(
      source.box.x + source.box.width,
      candidate.box.x + candidate.box.width,
    ) - Math.max(source.box.x, candidate.box.x),
  )
  const minimumWidth = Math.min(source.box.width, candidate.box.width)
  const verticalOverlap = Math.max(
    0,
    Math.min(
      source.box.y + source.box.height,
      candidate.box.y + candidate.box.height,
    ) - Math.max(source.box.y, candidate.box.y),
  )
  const minimumHeight = Math.min(source.box.height, candidate.box.height)
  return (
    (gap.vertical <= Math.max(0.012, minimumHeight) &&
      horizontalOverlap >= minimumWidth * 0.25) ||
    (gap.horizontal <= 0.12 && verticalOverlap >= minimumHeight * 0.25)
  )
}

function forbiddenEquationTranscriptText(text: string) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
}

function unreliableMathExtensionRun(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    /CMEX\d*/iu.test(run.fontName) &&
    (forbiddenEquationTranscriptText(run.text) || /^[A-Za-z]$/u.test(run.text))
  )
}

function mathExtensionGlyphFragment(region: PdfPageRegion) {
  const runs = region.lines.flatMap((line) => line.runs)
  return runs.length > 0 && runs.every((run) => /CMEX\d*/iu.test(run.fontName))
}

function equationTranscriptResolved(regions: PdfPageRegion[]) {
  return !regions.some((region) =>
    region.lines.some(
      (line) =>
        forbiddenEquationTranscriptText(line.text) ||
        line.runs.some(unreliableMathExtensionRun),
    ),
  )
}

function equationLineText(line: PdfPageRegion['lines'][number]) {
  const runs = [...line.runs]
    .filter(
      (run) =>
        run.text.trim() &&
        !forbiddenEquationTranscriptText(run.text) &&
        !unreliableMathExtensionRun(run),
    )
    .sort((left, right) => left.x - right.x || left.y - right.y)
  if (runs.length === 0) return line.text.trim()
  let text = ''
  for (const [index, run] of runs.entries()) {
    const next = run.text.trim()
    if (!next) continue
    if (!text) {
      text = next
      continue
    }
    const previous = runs[index - 1]
    const gap = Math.max(run.x - (previous.x + previous.width), 0)
    const attachedScript =
      run.fontSize <= previous.fontSize * 0.82 &&
      gap <= Math.max(0.006, previous.height * 0.75)
    const touchingGlyph = gap <= 0.0035
    text += `${attachedScript || touchingGlyph ? '' : ' '}${next}`
  }
  return text.replace(/\s+/g, ' ').trim()
}

function equationSourceText(regions: PdfPageRegion[]) {
  return regions
    .flatMap((region) => region.lines)
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
    .map(equationLineText)
    .filter(Boolean)
    .join(' ')
}

function attachedEquationRegions(
  source: PdfPageRegion,
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
) {
  const displayRegions = [source]
  let foundAdjacent = true
  while (foundAdjacent) {
    foundAdjacent = false
    for (const candidate of regions) {
      if (
        candidate.id === source.id ||
        candidate.page !== source.page ||
        consumedRegionIds.has(candidate.id) ||
        displayRegions.some((region) => region.id === candidate.id) ||
        candidate.kind !== 'equation' ||
        !isProbableDisplayEquation(candidate) ||
        !displayRegions.some((region) =>
          adjacentDisplayEquationRegion(region, candidate),
        )
      ) {
        continue
      }
      const combined = unionBox([...displayRegions, candidate])
      if (combined.height > 0.12 || combined.width > 0.6) continue
      displayRegions.push(candidate)
      foundAdjacent = true
    }
  }
  const displayScope = {
    ...source,
    box: unionBox(displayRegions),
  }
  const insideDisplayEnvelope = (candidate: PdfPageRegion) => {
    const centerX = candidate.box.x + candidate.box.width / 2
    const centerY = candidate.box.y + candidate.box.height / 2
    return (
      centerX >= displayScope.box.x - 0.025 &&
      centerX <= displayScope.box.x + displayScope.box.width + 0.025 &&
      centerY >= displayScope.box.y - 0.025 &&
      centerY <= displayScope.box.y + displayScope.box.height + 0.025
    )
  }
  return [
    ...displayRegions,
    ...regions.filter((candidate) => {
      if (
        displayRegions.some((region) => region.id === candidate.id) ||
        candidate.page !== source.page ||
        consumedRegionIds.has(candidate.id) ||
        !['body', 'spanning', 'side', 'chart-label', 'page-number'].includes(
          candidate.kind,
        )
      ) {
        return false
      }
      if (mathExtensionGlyphFragment(candidate)) {
        return insideDisplayEnvelope(candidate)
      }
      if (!compactEquationFragment(candidate)) return false
      const gap = boxGap(displayScope.box, candidate.box)
      return (
        alignedPrintedEquationNumber(displayScope, candidate) ||
        displayRegions.some((region) => {
          const regionGap = boxGap(region.box, candidate.box)
          return regionGap.horizontal <= 0.01 && regionGap.vertical <= 0.012
        }) ||
        (gap.horizontal <= 0.01 && gap.vertical <= 0.012)
      )
    }),
  ].sort(
    (left, right) =>
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
}

function sourceEquationLabel(
  region: PdfPageRegion,
  pageSequence: number,
  sources: PdfPageRegion[],
) {
  const printedNumber = sources
    .find(printedEquationNumberFragment)
    ?.text.match(/^\(\s*(\d+[a-z]?)\s*\)$/i)?.[1]
  return printedNumber
    ? `Equation ${printedNumber}`
    : `Display equation p${String(region.page).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}`
}

function relationshipPosition(relationship: PdfVisualRelationship) {
  const boxes = relationship.sourceBoxes
  return {
    page: Math.min(...boxes.map((box) => box.page)),
    y: Math.min(...boxes.map((box) => box.y)),
    x: Math.min(...boxes.map((box) => box.x)),
  }
}

function visualOnlyColumnSplits(relationships: PdfVisualRelationship[]) {
  const relationshipsByPage = new Map<number, PdfVisualRelationship[]>()
  for (const relationship of relationships) {
    const page = relationshipPosition(relationship).page
    const values = relationshipsByPage.get(page) ?? []
    values.push(relationship)
    relationshipsByPage.set(page, values)
  }
  const splits = new Map<number, number>()
  for (const [page, values] of relationshipsByPage) {
    if (
      values.length < 3 ||
      values.some(
        (relationship) =>
          relationship.kind !== 'figure' ||
          !relationship.sourceBoxes[0] ||
          relationship.sourceBoxes[0].width < 0.2 ||
          relationship.sourceBoxes[0].width > MAX_SINGLE_COLUMN_FIGURE_WIDTH,
      )
    ) {
      continue
    }
    const ordered = values
      .map((relationship) => relationship.sourceBoxes[0])
      .sort(
        (left, right) => left.x + left.width / 2 - (right.x + right.width / 2),
      )
    const gaps = ordered.slice(1).map((box, index) => ({
      index,
      gap:
        box.x + box.width / 2 - (ordered[index].x + ordered[index].width / 2),
    }))
    const strongest = gaps.sort((left, right) => right.gap - left.gap)[0]
    if (!strongest || strongest.gap < 0.15) continue
    const left = ordered.slice(0, strongest.index + 1)
    const right = ordered.slice(strongest.index + 1)
    if (left.length < 2 || right.length < 1) continue
    const leftEdge = Math.max(...left.map((box) => box.x + box.width))
    const rightEdge = Math.min(...right.map((box) => box.x))
    if (leftEdge > rightEdge + 0.02) continue
    splits.set(page, (leftEdge + rightEdge) / 2)
  }
  return splits
}

export async function reconstructPdfVisuals({
  pages,
  regions,
  rasterizeFigure,
}: {
  pages: PdfPageAnalysis[]
  regions: PdfPageRegion[]
  rasterizeFigure?: PdfFigureRasterizer
}) {
  const diagnostics: ReconstructionDiagnostic[] = []
  const assetStore = new Map<string, PdfVisualAsset>()
  const canonicalTablesByAssetId = new Map<string, CanonicalTable>()
  const scanSourceObjectIds = new Set(
    pages
      .flatMap((page) => page.objects ?? [])
      .filter((object) => object.role === 'scan-source')
      .map((object) => object.id),
  )
  for (const visualAsset of pages.flatMap((page) => page.assets ?? [])) {
    if (
      visualAsset.sourceObjectIds.length > 0 &&
      visualAsset.sourceObjectIds.every((id) => scanSourceObjectIds.has(id))
    ) {
      continue
    }
    mergeAsset(assetStore, visualAsset)
  }
  const objectAssetIds = new Map(
    pages
      .flatMap((page) => page.objects ?? [])
      .map((object) => [object.id, object.assetId]),
  )
  const objectBoxes = new Map(
    pages
      .flatMap((page) => page.objects ?? [])
      .map((object) => [object.id, object.box]),
  )
  const lineageBoxes = new Map([
    ...objectBoxes,
    ...regions
      .filter((region) => region.lines.length > 0 && region.text.trim())
      .map((region) => [textOverlayId(region), region.box] as const),
  ])
  const decorativeObjectIds = decorativeNativeObjectIds(pages)
  // Region classification is part of the caption evidence. Looking only at the
  // leading text turns sentences such as "Table 5 shows ..." into invented
  // visual relationships when they occur at the start of a paragraph.
  const captions = regions.filter(
    (region) => region.kind === 'caption' && visualLabel(region.text),
  )
  const figureCaptions = captions.filter(
    (caption) => visualLabel(caption.text)?.kind === 'figure',
  )
  const figures = figureCandidates(
    regions,
    figureCaptions,
    decorativeObjectIds,
  ).map((candidate) => ({
    ...candidate,
    assetIds: candidate.sourceObjectIds
      .map((id) => objectAssetIds.get(id))
      .filter((id): id is string => Boolean(id)),
  }))
  const consumedRegionIds = new Set<string>()
  const consumedLineIds = new Set<string>()
  const relationships: PdfVisualRelationship[] = []

  for (const [captionIndex, caption] of captions.entries()) {
    const label = visualLabel(caption.text)!
    let tableScopeResolution: PdfTableScopeResolution | null = null
    let semanticTableScope: CompleteSemanticTableScope | null = null
    let candidates = figures.filter(
      (candidate) => candidate.kind === label.kind,
    )
    if (label.kind === 'table' || label.kind === 'equation') {
      const availableTableRegions = availableRegionsForTable(
        regions,
        consumedRegionIds,
        consumedLineIds,
      )
      const detectedTable =
        label.kind === 'table'
          ? detectTableNearCaption(caption, availableTableRegions)
          : null
      if (label.kind === 'table') {
        const boundedScope = resolvePdfTableScope({
          caption,
          pageRegions: availableTableRegions,
          nativeObjects:
            pages.find((page) => page.page === caption.page)?.objects ?? [],
        })
        semanticTableScope = completeSemanticTableScope(
          detectedTable,
          boundedScope,
        )
        // A proved bounded text/native scope outranks the legacy geometric
        // detector. The latter may join a neighbouring chart that shares row
        // coordinates with a table; a scope carries exact line/object lineage.
        // Semantic promotion is allowed only when the detector consumes every
        // claimed source line and either agrees with that exact scope or closes
        // it using adjacent source-classified header regions.
        tableScopeResolution = semanticTableScope
          ? null
          : boundedScope.status === 'matched' || detectedTable === null
            ? boundedScope
            : null
      }
      const nearbySources = nextSourceRegions(caption, regions, label.kind)
      const selectedSources =
        label.kind === 'table'
          ? (detectedTable?.sourceRegions ?? [])
          : nearbySources[0]
            ? attachedEquationRegions(
                nearbySources[0],
                regions,
                consumedRegionIds,
              )
            : nearbySources
      const sources =
        label.kind === 'equation' &&
        !probableDisplayEquationText(equationSourceText(selectedSources))
          ? []
          : selectedSources
      candidates = []
      if (!tableScopeResolution && sources.length > 0) {
        const sourceBox = unionBox(sources)
        const sourceObjectId = `${label.kind}-p${String(sourceBox.page).padStart(3, '0')}-${String(captionIndex + 1).padStart(3, '0')}`
        const page = pages.find((item) => item.page === sourceBox.page)!
        const sourceLines = sources.flatMap((source) => source.lines)
        const incompleteDetectedTable =
          label.kind === 'table' &&
          semanticTableScope === null &&
          detectedTable !== null &&
          tableRowBandCount(sourceLines) >
            tableRowBandCount(detectedTable.lines)
        const lines = incompleteDetectedTable
          ? sourceLines
          : (detectedTable?.lines ?? sourceLines)
        const nativeEquationRendition =
          label.kind === 'equation'
            ? sourceEquationRendition(
                caption,
                sources,
                regions,
                objectAssetIds,
                objectBoxes,
                assetStore,
              )
            : null
        const visualAsset =
          label.kind === 'table'
            ? incompleteDetectedTable
              ? null
              : await createTableAsset({
                  sourceObjectId,
                  sourceBox,
                  lines,
                  sourceHeaderLineIds:
                    semanticTableScope?.sourceHeaderLineIds ?? [],
                  detectedRectangularGeometry: Boolean(semanticTableScope),
                  pageWidth: page.width,
                  pageHeight: page.height,
                })
            : nativeEquationRendition
              ? null
              : await createTextSvgAsset({
                  kind: 'equation',
                  sourceObjectId,
                  sourceBox,
                  lines,
                  pageWidth: page.width,
                  pageHeight: page.height,
                })
        if (
          visualAsset?.rendition === 'semantic-table' &&
          label.kind === 'table'
        ) {
          const table = canonicalTableFromLines(lines, {
            sourceHeaderLineIds: semanticTableScope?.sourceHeaderLineIds ?? [],
            detectedRectangularGeometry: Boolean(semanticTableScope),
          })
          if (table) canonicalTablesByAssetId.set(visualAsset.id, table)
        }
        if (visualAsset) mergeAsset(assetStore, visualAsset)
        if (nativeEquationRendition) {
          candidates.push(nativeEquationRendition)
        } else {
          candidates.push({
            kind: label.kind,
            sourceRegionIds: sources.map((source) => source.id),
            sourceLineIds:
              label.kind === 'table' && detectedTable
                ? [...detectedTable.sourceLineIds]
                : lines.map((line) => line.id),
            sourceObjectIds: [sourceObjectId],
            assetIds: visualAsset ? [visualAsset.id] : [],
            sourceBoxes: [sourceBox],
            sourceText:
              label.kind === 'equation'
                ? equationSourceText(sources)
                : lines.map((line) => line.text).join(' '),
            page: sourceBox.page,
            column: sources.every(
              (source) => source.column === sources[0].column,
            )
              ? sources[0].column
              : 'span',
            ...(label.kind === 'table'
              ? {
                  evidence: visualAsset
                    ? [
                        'detected-table-geometry',
                        'semantic-table',
                        ...(semanticTableScope?.evidence ?? []),
                      ]
                    : [
                        'detected-table-geometry',
                        'semantic-table-unresolved',
                        'exact-source-raster-unavailable',
                        ...(semanticTableScope?.evidence ?? []),
                      ],
                }
              : {
                  evidence: [
                    'bounded-source-geometry',
                    'readable-text-svg-approximation',
                  ],
                }),
          })
        }
      }
    }
    const result = tableScopeResolution
      ? matchTableScopeResolution(
          tableScopeResolution,
          caption,
          regions,
          objectAssetIds,
        )
      : matchCandidate(caption, label, candidates, regions)
    const scoredCandidateRecords = result.scored.map(matchRecord)
    const matchedCandidate = result.best?.candidate
    const sourcePageCropVetoed = Boolean(
      matchedCandidate?.sourcePageCropBlockedByReadingOrderText,
    )
    const best = matchedCandidate
      ? nativeOnlyFigureCandidate(matchedCandidate, regions, objectAssetIds)
      : undefined
    const sourceObjectBoxes = (best?.sourceObjectIds ?? [])
      .map((id) => lineageBoxes.get(id))
      .filter((box): box is NormalizedSourceBox => Boolean(box))
    let compositeSourceBox: NormalizedSourceBox | null = best
      ? paddedUnionBox(best.renderBox ? [best.renderBox] : best.sourceBoxes)
      : null
    let scopedSourceLineage =
      best && compositeSourceBox
        ? sourceLineageWithinRenderScope(best, compositeSourceBox)
        : null
    const existingSingleSourceAsset =
      best?.sourceObjectIds.length === 1 && best.assetIds.length === 1
        ? assetStore.get(best.assetIds[0])
        : undefined
    const existingSingleSourceComplete = Boolean(
      best &&
      existingSingleSourceAsset &&
      completeSingleSourceAsset(
        existingSingleSourceAsset,
        best.sourceObjectIds[0],
        best.sourceBoxes[0],
      ),
    )
    if (
      result.matched &&
      sourcePageCropVetoed &&
      existingSingleSourceComplete &&
      result.best &&
      !result.best.evidence.includes('native-only-exact-rendition')
    ) {
      result.best.evidence.push('native-only-exact-rendition')
    }
    let retainedPageCrop: PdfVisualAsset | undefined
    let pageCropFailureEvidence: string | undefined
    if (
      result.matched &&
      best &&
      scopedSourceLineage &&
      scopedSourceLineage.sourceObjectIds.length > 0 &&
      scopedSourceLineage.sourceObjectIds.length ===
        scopedSourceLineage.sourceBoxes.length &&
      compositeSourceBox &&
      rasterizeFigure &&
      !best.nativeEnvelopeIncomplete &&
      !sourcePageCropVetoed &&
      (scopedSourceLineage.sourceObjectIds.length > 1 ||
        !existingSingleSourceComplete ||
        scopedSourceLineage.clipped)
    ) {
      let cropTouchedEdge = false
      let sourceCrop = await rasterizeFigure({
        kind: best.kind,
        page: best.page,
        sourceBox: compositeSourceBox,
        sourceObjectIds: [...scopedSourceLineage.sourceObjectIds],
        sourceBoxes: scopedSourceLineage.sourceBoxes.map((box) => ({ ...box })),
      }).catch((error: unknown) => {
        cropTouchedEdge = sourcePageCropTouchesEdge(error)
        pageCropFailureEvidence = sourcePageCropFailureEvidence(error)
        return null
      })
      if (
        !sourceCrop &&
        cropTouchedEdge &&
        best.renderBox &&
        !sameSourceBox(compositeSourceBox, best.renderBox)
      ) {
        const boundedSourceBox = { ...best.renderBox }
        const boundedSourceLineage = sourceLineageWithinRenderScope(
          best,
          boundedSourceBox,
        )
        if (
          boundedSourceLineage.sourceObjectIds.length > 0 &&
          boundedSourceLineage.sourceObjectIds.length ===
            boundedSourceLineage.sourceBoxes.length
        ) {
          sourceCrop = await rasterizeFigure({
            kind: best.kind,
            page: best.page,
            sourceBox: boundedSourceBox,
            sourceObjectIds: [...boundedSourceLineage.sourceObjectIds],
            sourceBoxes: boundedSourceLineage.sourceBoxes.map((box) => ({
              ...box,
            })),
          }).catch((error: unknown) => {
            pageCropFailureEvidence = sourcePageCropFailureEvidence(error)
            return null
          })
          if (
            sourceCrop &&
            completeSourcePageCropAsset(
              sourceCrop,
              best.kind,
              boundedSourceLineage.sourceObjectIds,
              boundedSourceLineage.sourceBoxes,
              boundedSourceBox,
            )
          ) {
            compositeSourceBox = boundedSourceBox
            scopedSourceLineage = boundedSourceLineage
            pageCropFailureEvidence = undefined
            result.best!.evidence.push(
              'source-page-crop-tightened-away-from-adjacent-text',
            )
          }
        }
      }
      if (
        sourceCrop &&
        completeSourcePageCropAsset(
          sourceCrop,
          best.kind,
          scopedSourceLineage.sourceObjectIds,
          scopedSourceLineage.sourceBoxes,
          compositeSourceBox!,
        )
      ) {
        const sourceInkTightened = Boolean(
          sourceCrop.sourceCropBox &&
          !sameSourceBox(sourceCrop.sourceCropBox, compositeSourceBox!),
        )
        if (sourceInkTightened) {
          compositeSourceBox = { ...sourceCrop.sourceCropBox! }
          scopedSourceLineage = {
            sourceObjectIds: [...sourceCrop.sourceObjectIds],
            sourceBoxes: sourceCrop.sourceBoxes.map((box) => ({ ...box })),
            clipped: true,
          }
          result.best!.evidence.push('source-page-crop-source-ink-tightened')
        }
        mergeAsset(assetStore, sourceCrop)
        best.sourceObjectIds = [...scopedSourceLineage.sourceObjectIds]
        best.sourceBoxes = scopedSourceLineage.sourceBoxes.map((box) => ({
          ...box,
        }))
        best.sourceRegionIds = best.sourceRegionIds.filter((sourceRegionId) => {
          const sourceRegion = regions.find(
            (region) => region.id === sourceRegionId,
          )
          return Boolean(
            sourceRegion &&
            intersectSourceBox(compositeSourceBox!, sourceRegion.box),
          )
        })
        best.assetIds = [sourceCrop.id]
        retainedPageCrop = sourceCrop
        result.best!.evidence = result.best!.evidence.filter(
          (item) => item !== 'exact-source-raster-unavailable',
        )
        result.best!.evidence.push('source-page-crop')
        if (scopedSourceLineage.clipped) {
          result.best!.evidence.push('source-lineage-clipped-to-render-scope')
        }
      } else if (sourceCrop) {
        pageCropFailureEvidence =
          sourcePageCropValidationFailure(
            sourceCrop,
            best.kind,
            scopedSourceLineage.sourceObjectIds,
            scopedSourceLineage.sourceBoxes,
            compositeSourceBox!,
          ) ?? undefined
      }
    }
    if (
      pageCropFailureEvidence &&
      result.best &&
      !result.best.evidence.includes(pageCropFailureEvidence)
    ) {
      result.best.evidence.push(pageCropFailureEvidence)
    }
    let retainedComposite =
      best && best.sourceObjectIds.length > 1 && best.assetIds.length === 1
        ? assetStore.get(best.assetIds[0])
        : undefined
    if (
      label.kind === 'figure' &&
      result.matched &&
      best &&
      compositeSourceBox &&
      best.sourceObjectIds.length >= MIN_COMPOSITE_FIGURE_FRAGMENTS &&
      sourceObjectBoxes.length === best.sourceObjectIds.length &&
      !best.nativeEnvelopeIncomplete &&
      !retainedPageCrop &&
      !(
        retainedComposite &&
        completeCompositeAsset(
          retainedComposite,
          best.sourceObjectIds,
          sourceObjectBoxes,
        )
      )
    ) {
      const fragments = best.sourceObjectIds
        .map((sourceObjectId, index) => {
          const assetId = objectAssetIds.get(sourceObjectId)
          const visualAsset = assetId ? assetStore.get(assetId) : undefined
          return completeSingleSourceAsset(
            visualAsset,
            sourceObjectId,
            sourceObjectBoxes[index],
          )
            ? {
                sourceObjectId,
                sourceBox: sourceObjectBoxes[index],
                asset: visualAsset!,
              }
            : null
        })
        .filter((fragment): fragment is NonNullable<typeof fragment> =>
          Boolean(fragment),
        )
      if (fragments.length === best.sourceObjectIds.length) {
        let composite = await createHeadlessCompositePngAsset({
          sourceBox: compositeSourceBox,
          fragments,
        }).catch(() => null)
        let compositeEvidence = 'headless-composite-raster'
        if (!composite) {
          composite = await createHeadlessCompositeSvgAsset({
            sourceBox: compositeSourceBox,
            fragments,
          }).catch(() => null)
          compositeEvidence = 'headless-composite-svg'
        }
        if (
          composite &&
          completeCompositeAsset(
            composite,
            best.sourceObjectIds,
            sourceObjectBoxes,
          )
        ) {
          mergeAsset(assetStore, composite)
          best.assetIds = [composite.id]
          retainedComposite = composite
          result.best!.evidence.push(compositeEvidence)
        }
      }
    }
    const payloadComplete =
      Boolean(best) &&
      !best!.nativeEnvelopeIncomplete &&
      best!.sourceObjectIds.length > 0 &&
      (Boolean(
        retainedPageCrop &&
        compositeSourceBox &&
        completeSourcePageCropAsset(
          retainedPageCrop,
          best!.kind,
          best!.sourceObjectIds,
          best!.sourceBoxes,
          compositeSourceBox,
        ),
      ) ||
        (best!.sourceObjectIds.length === 1
          ? best!.assetIds.length === 1 &&
            completeSingleSourceAsset(
              assetStore.get(best!.assetIds[0]),
              best!.sourceObjectIds[0],
              best!.sourceBoxes[0],
            )
          : Boolean(
              retainedComposite &&
              completeCompositeAsset(
                retainedComposite,
                best!.sourceObjectIds,
                sourceObjectBoxes,
              ),
            )))
    const status = result.ambiguous
      ? ('ambiguous' as const)
      : result.matched && payloadComplete
        ? ('matched' as const)
        : ('unresolved' as const)
    const unresolvedOverlayRegionIds =
      status === 'unresolved' &&
      label.kind === 'figure' &&
      result.matched &&
      result.scored.length === 1 &&
      matchedCandidate?.renderBox &&
      matchedCandidate.sourceText.trim() &&
      result.best?.evidence.includes('caption-bounded-native-scaffold')
        ? matchedCandidate.sourceObjectIds.flatMap((sourceObjectId, index) => {
            if (!sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)) return []
            const sourceBox = matchedCandidate.sourceBoxes[index]
            const area = sourceBox.width * sourceBox.height
            const covered = intersectionArea(
              sourceBox,
              matchedCandidate.renderBox!,
            )
            return area > 0 && covered / area >= 0.95
              ? [sourceObjectId.slice(TEXT_OVERLAY_PREFIX.length)]
              : []
          })
        : []
    const ownsUnresolvedFigureText =
      unresolvedOverlayRegionIds.length > 0 &&
      unresolvedOverlayRegionIds.length ===
        matchedCandidate!.sourceObjectIds.filter((sourceObjectId) =>
          sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX),
        ).length
    if (
      ownsUnresolvedFigureText &&
      result.best &&
      !result.best.evidence.includes('unresolved-visual-text-owned')
    ) {
      result.best.evidence.push('unresolved-visual-text-owned')
    }
    if (status === 'matched') {
      if (label.kind === 'table' || label.kind === 'equation') {
        if (
          label.kind === 'table' &&
          best!.tableRegionLineage &&
          best!.tableRegionLineage.length > 0
        ) {
          for (const lineage of best!.tableRegionLineage) {
            for (const lineId of lineage.lineIds) {
              consumedLineIds.add(lineId)
            }
            if (lineage.selection === 'whole') {
              consumedRegionIds.add(lineage.regionId)
            }
          }
        } else {
          for (const sourceRegionId of best!.sourceRegionIds) {
            consumedRegionIds.add(sourceRegionId)
          }
        }
      } else {
        const retainedSourceRegionIds = new Set(best!.sourceRegionIds)
        for (const sourceObjectId of best!.sourceObjectIds) {
          if (!sourceObjectId.startsWith(TEXT_OVERLAY_PREFIX)) continue
          const sourceRegionId = sourceObjectId.slice(
            TEXT_OVERLAY_PREFIX.length,
          )
          if (retainedSourceRegionIds.has(sourceRegionId)) {
            consumedRegionIds.add(sourceRegionId)
          }
        }
      }
    } else if (ownsUnresolvedFigureText) {
      // The visual rendition is still unresolved, but its diagram-internal
      // text is unambiguously enclosed by the single caption-bounded figure
      // candidate. Keep that text with the unresolved visual transcript; do
      // not splice it into the surrounding scholarly prose.
      for (const sourceRegionId of unresolvedOverlayRegionIds) {
        consumedRegionIds.add(sourceRegionId)
      }
    }
    if (status !== 'matched') {
      diagnostics.push({
        code:
          status === 'ambiguous'
            ? 'AMBIGUOUS_VISUAL_MATCH'
            : 'UNRESOLVED_VISUAL_OBJECT',
        severity: 'error',
        page: caption.page,
        message:
          status === 'ambiguous'
            ? `${label.label} retains ${result.scored.length} similarly scored visual candidates for review.`
            : `${label.label} has no source visual candidate above the deterministic confidence threshold.`,
        sourceBoxes: [
          caption.box,
          ...result.scored.flatMap(
            (candidate) => candidate.candidate.sourceBoxes,
          ),
        ],
        target: {
          regionIds: [
            caption.id,
            ...result.scored.flatMap(
              (candidate) => candidate.candidate.sourceRegionIds,
            ),
          ],
          markerId: null,
        },
      })
    }
    const noCandidateEvidence = tableScopeResolution
      ? [
          'bounded-table-scope-unresolved',
          tableScopeResolution.ambiguity.code,
          ...tableScopeResolution.ambiguity.evidence,
        ]
      : ['no-source-candidate']
    relationships.push({
      id: `visual-relationship-${String(relationships.length + 1).padStart(4, '0')}`,
      kind: label.kind,
      label: label.label,
      captionRegionId: caption.id,
      sourceRegionIds: status === 'matched' ? best!.sourceRegionIds : [],
      sourceLineIds:
        status === 'matched' ? [...(best!.sourceLineIds ?? [])] : [],
      sourceObjectIds: status === 'matched' ? best!.sourceObjectIds : [],
      assetIds: status === 'matched' ? best!.assetIds : [],
      status,
      confidence: result.best?.score ?? 0,
      evidence:
        result.best && !payloadComplete
          ? [...result.best.evidence, 'source-rendition-unavailable']
          : (result.best?.evidence ?? noCandidateEvidence),
      candidates: scoredCandidateRecords,
      sourceBoxes:
        status === 'matched'
          ? [caption.box, ...best!.sourceBoxes]
          : [caption.box],
      sourceText:
        status === 'matched'
          ? best!.sourceText
          : ownsUnresolvedFigureText
            ? matchedCandidate!.sourceText
            : '',
      altText: caption.text,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
  }

  const equationCountByPage = new Map<number, number>()
  const examinedEquationRegionIds = new Set<string>()
  for (const source of regions.filter(
    (region) =>
      !consumedRegionIds.has(region.id) && isProbableDisplayEquation(region),
  )) {
    if (
      consumedRegionIds.has(source.id) ||
      examinedEquationRegionIds.has(source.id)
    ) {
      continue
    }
    const page = pages.find((item) => item.page === source.page)
    if (!page) continue
    const sources = attachedEquationRegions(source, regions, consumedRegionIds)
    for (const attached of sources) {
      if (attached.kind === 'equation') {
        examinedEquationRegionIds.add(attached.id)
      }
    }
    const sourceText = equationSourceText(sources)
    if (!probableDisplayEquationText(sourceText)) continue
    const transcriptResolved = equationTranscriptResolved(sources)
    const pageSequence = (equationCountByPage.get(source.page) ?? 0) + 1
    equationCountByPage.set(source.page, pageSequence)
    const sourceBox = unionBox(sources)
    const label = sourceEquationLabel(source, pageSequence, sources)
    const sourceObjectId = `equation-source-p${String(source.page).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}`
    const visualAsset = transcriptResolved
      ? await createTextSvgAsset({
          kind: 'equation',
          sourceObjectId,
          sourceBox,
          lines: sources.flatMap((region) => region.lines),
          pageWidth: page.width,
          pageHeight: page.height,
        })
      : null
    if (visualAsset) mergeAsset(assetStore, visualAsset)
    const transcriptEvidence = transcriptResolved
      ? ['source-text-alt']
      : ['source-text-transcript-unresolved']
    const approximationEvidence = [
      'source-equation-region',
      'bounded-source-geometry',
      ...transcriptEvidence,
      ...(visualAsset ? ['readable-text-svg-approximation'] : []),
    ]
    const sourceCropBox = paddedUnionBox([sourceBox])
    const sourceCrop = rasterizeFigure
      ? await rasterizeFigure({
          kind: 'equation',
          page: source.page,
          sourceBox: sourceCropBox,
          sourceObjectIds: [sourceObjectId],
          sourceBoxes: [sourceBox],
        }).catch(() => null)
      : null
    const cropMatched = Boolean(
      sourceCrop &&
      completeSourcePageCropAsset(
        sourceCrop,
        'equation',
        [sourceObjectId],
        [sourceBox],
        sourceCropBox,
      ),
    )
    if (sourceCrop && cropMatched) mergeAsset(assetStore, sourceCrop)
    const evidence = cropMatched
      ? [
          'source-equation-region',
          'bounded-source-geometry',
          ...transcriptEvidence,
          'source-page-crop',
        ]
      : approximationEvidence
    if (cropMatched) {
      for (const attached of sources) {
        if (attached.id !== source.id) consumedRegionIds.add(attached.id)
      }
    }
    relationships.push({
      id: '',
      kind: 'equation',
      label,
      // Keep the primary equation region in reading order so layout can turn
      // its source text into the accessible caption for a matched crop.
      captionRegionId: source.id,
      sourceRegionIds: cropMatched ? sources.map((region) => region.id) : [],
      sourceObjectIds: cropMatched ? [sourceObjectId] : [],
      assetIds: cropMatched ? [sourceCrop!.id] : [],
      status: cropMatched ? 'matched' : 'unresolved',
      confidence: source.confidence,
      evidence: cropMatched
        ? evidence
        : [...evidence, 'source-rendition-unavailable'],
      candidates: [
        {
          sourceRegionIds: sources.map((region) => region.id),
          sourceObjectIds: [sourceObjectId],
          assetIds: cropMatched
            ? [sourceCrop!.id]
            : visualAsset
              ? [visualAsset.id]
              : [],
          score: source.confidence,
          evidence,
          sourceBoxes: [sourceBox],
        },
      ],
      sourceBoxes: sources.map((region) => region.box),
      sourceText: transcriptResolved ? sourceText : '',
      altText: transcriptResolved ? sourceText : label,
      altTextSource: transcriptResolved ? 'source-text' : 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
    if (!cropMatched) {
      diagnostics.push({
        code: 'UNRESOLVED_VISUAL_OBJECT',
        severity: 'error',
        page: source.page,
        message: transcriptResolved
          ? `${label} has readable source text but no source glyph, path, or raster rendition.`
          : `${label} has bounded source geometry but its extracted semantic transcript is unresolved and no source glyph raster is available.`,
        sourceBoxes: sources.map((region) => region.box),
        target: {
          regionIds: sources.map((region) => region.id),
          markerId: null,
        },
      })
    }
  }

  const visualColumnSplits = visualOnlyColumnSplits(relationships)
  relationships.sort((left, right) => {
    const leftPosition = relationshipPosition(left)
    const rightPosition = relationshipPosition(right)
    const columnSplit =
      leftPosition.page === rightPosition.page
        ? visualColumnSplits.get(leftPosition.page)
        : undefined
    const leftColumn =
      columnSplit === undefined
        ? 0
        : left.sourceBoxes[0].x + left.sourceBoxes[0].width / 2 < columnSplit
          ? 0
          : 1
    const rightColumn =
      columnSplit === undefined
        ? 0
        : right.sourceBoxes[0].x + right.sourceBoxes[0].width / 2 < columnSplit
          ? 0
          : 1
    return (
      leftPosition.page - rightPosition.page ||
      leftColumn - rightColumn ||
      leftPosition.y - rightPosition.y ||
      leftPosition.x - rightPosition.x ||
      left.label.localeCompare(right.label)
    )
  })
  for (const [index, relationship] of relationships.entries()) {
    relationship.id = `visual-relationship-${String(index + 1).padStart(4, '0')}`
  }

  const referenced = new Set(
    relationships.flatMap((relationship) => relationship.sourceObjectIds),
  )
  for (const object of pages.flatMap((page) => page.objects ?? [])) {
    if (object.role === 'scan-source') continue
    if (referenced.has(object.id)) continue
    if (decorativeObjectIds.has(object.id)) continue
    diagnostics.push({
      code: 'UNREFERENCED_VISUAL_ASSET',
      severity: 'error',
      page: object.page,
      message: `Source visual object ${object.id} has no unique caption relationship.`,
      sourceBoxes: [object.box],
      target: { regionIds: [], markerId: null },
    })
  }

  const partialRegionLineSelections = regions
    .flatMap<PdfPartialRegionLineSelection>((region) => {
      if (consumedRegionIds.has(region.id) || region.lines.length === 0) {
        return []
      }
      const consumed = region.lines
        .filter((line) => consumedLineIds.has(line.id))
        .map((line) => line.id)
        .sort()
      if (consumed.length === 0) return []
      const retained = region.lines
        .filter((line) => !consumedLineIds.has(line.id))
        .map((line) => line.id)
        .sort()
      return [
        {
          regionId: region.id,
          consumedLineIds: consumed,
          retainedLineIds: retained,
        },
      ]
    })
    .sort((left, right) => left.regionId.localeCompare(right.regionId))

  return {
    assets: [...assetStore.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    relationships,
    canonicalTablesByAssetId,
    consumedRegionIds,
    consumedLineIds,
    partialRegionLineSelections,
    diagnostics,
  }
}
