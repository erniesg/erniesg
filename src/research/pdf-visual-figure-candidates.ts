import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import { materiallyOverlapsPdfSourceText as materiallyOverlapsSourceText } from './pdf-visual-source-crops'
import {
  materiallyOverlappingSourceBoxes,
  paddedUnionBox,
} from './pdf-visual-source-geometry'
import {
  fullyContainsBox,
  intersectionArea,
  MIN_CAPTION_BOUNDED_FLOW_OVERLAY_LINE_COUNT,
  MIN_COMPOSITE_FIGURE_FRAGMENTS,
  MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT,
} from './pdf-visual-figure-lineage'
import {
  adjacentPanelLabelOverlays,
  connectedFigureRegionGroups,
  owningCaptionForBox,
  PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE,
  probablePanelLabelOverlayRegion,
  unionObjectBox,
  yieldPdfVisualTask,
  type PdfFigureGroupingEvidence,
} from './pdf-visual-figure-grouping'
import {
  bindsDenseNativeFragmentSet,
  captionBoundedRenderBox,
  captionBoundedSemanticEnvelopeCandidates,
  coextensiveNativeLayers,
  isCompositeScaffold,
  provesCaptionBoundedNativeScaffold,
  renderBoxForGroup,
  textOverlayId,
} from './pdf-visual-caption-envelopes'
import {
  FIGURE_OVERLAY_BOX_TOLERANCE,
  horizontalOverlapRatio,
  type VisualCandidate,
} from './pdf-visual-matching'

// Diagram labels must remain outside canonical reading order and subordinate
// to the established native render scope. The area cap is a secondary bound;
// individually small fragments are not evidence that canonical prose is safe.
const MAX_FIGURE_TEXT_OVERLAY_AREA_RATIO = 0.2
const MAX_CAPTION_BOUNDED_FLOW_OVERLAY_AREA_RATIO = 0.45
const MAX_LAYERED_PANEL_FLOW_OVERLAY_AREA_RATIO = 0.9
const MAX_SINGLE_LINE_CHART_OVERLAY_CHARACTERS = 48
const MAX_SINGLE_LINE_CHART_OVERLAY_AREA_RATIO = 0.03

type PdfFigureEquationEvidence = {
  isProbableDisplayEquation: (region: PdfPageRegion) => boolean
  sourcePrintedEquationNumber: (region: PdfPageRegion) => string | null
}

function strongHierarchicalSectionHeading(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const title =
    /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+){0,3})\.?\s+(.+)$/u.exec(
      normalized,
    )?.[1] ?? ''
  const words = title.match(/\p{L}{2,}/gu) ?? []
  return (
    title.length <= 160 &&
    words.length >= 2 &&
    title === title.toLocaleUpperCase() &&
    title !== title.toLocaleLowerCase() &&
    !/[.!?]\s*$/u.test(title)
  )
}

function normalizedRepeatedPageText(text: string) {
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

function repeatedTopPageFurnitureRegionIds(regions: PdfPageRegion[]) {
  const candidates = regions.filter(
    (region) =>
      region.lines.length > 0 &&
      region.text.trim().length >= 12 &&
      region.box.y <= 0.16 &&
      region.box.y + region.box.height <= 0.2 &&
      ['body', 'spanning', 'header', 'side'].includes(region.kind),
  )
  const byText = new Map<string, PdfPageRegion[]>()
  for (const region of candidates) {
    const key = normalizedRepeatedPageText(region.text)
    const matches = byText.get(key) ?? []
    matches.push(region)
    byText.set(key, matches)
  }
  return new Set(
    [...byText.values()]
      .filter((matches) => {
        const pages = new Set(matches.map((region) => region.page))
        return (
          pages.size >= 2 &&
          (pages.size >= 3 ||
            matches.some((region) => region.kind === 'header'))
        )
      })
      .flatMap((matches) => matches.map((region) => region.id)),
  )
}

function topPageFurnitureTextSources(regions: PdfPageRegion[]) {
  const fragments = regions.flatMap((region) =>
    region.lines.flatMap((line) => {
      const sourceFragments =
        line.runs.length > 0
          ? line.runs.map((run, index) => ({
              id: `${line.id}-run-${index + 1}`,
              text: run.text,
              box: {
                page: region.page,
                x: run.x,
                y: run.y,
                width: run.width,
                height: run.height,
                rotation: region.box.rotation,
                method: 'pdf-text' as const,
              },
            }))
          : [{ id: line.id, text: line.text, box: line.box }]
      return [
        ...sourceFragments,
        ...(sourceFragments.length > 1
          ? [{ id: line.id, text: line.text, box: line.box }]
          : []),
      ].map((fragment) => ({ region, line, ...fragment }))
    }),
  )
  const isolatedTopPageNumber = ({
    region,
    line,
    text,
    box,
  }: (typeof fragments)[number]) => {
    const normalized = normalizedRepeatedPageText(text).replace(
      /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
      '',
    )
    if (!/^\d{1,4}(?::\d{1,4})?$/u.test(normalized)) return false
    if (['header', 'page-number'].includes(region.kind)) return true
    const numericSiblingCount = line.runs.filter((run) =>
      /^\d{1,4}(?::\d{1,4})?$/u.test(
        normalizedRepeatedPageText(run.text).replace(
          /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
          '',
        ),
      ),
    ).length
    return box.y + box.height <= 0.082 && numericSiblingCount <= 1
  }
  const topFragments = fragments.filter((fragment) => {
    const { text, box } = fragment
    const normalized = normalizedRepeatedPageText(text).replace(
      /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
      '',
    )
    const words = normalized.match(/\p{L}{2,}/gu) ?? []
    return (
      box.y <= 0.1 &&
      box.y + box.height <= 0.115 &&
      (isolatedTopPageNumber(fragment) ||
        (normalized.length >= 12 && words.length >= 4))
    )
  })
  const byText = new Map<string, typeof topFragments>()
  for (const fragment of topFragments) {
    const key = normalizedRepeatedPageText(fragment.text).replace(
      /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
      '',
    )
    const matches = byText.get(key) ?? []
    matches.push(fragment)
    byText.set(key, matches)
  }
  const repeatedFragmentIds = new Set(
    [...byText.values()]
      .filter((matches) => {
        const pages = new Set(matches.map(({ region }) => region.page))
        return (
          pages.size >= 3 ||
          (pages.size >= 2 &&
            matches.some(({ region }) => region.kind === 'header'))
        )
      })
      .flatMap((matches) => matches.map(({ id }) => id)),
  )
  return topFragments
    .filter((fragment) => {
      return (
        repeatedFragmentIds.has(fragment.id) || isolatedTopPageNumber(fragment)
      )
    })
    .map(
      ({ region, line, id, text, box }) =>
        ({
          ...region,
          id: `${region.id}-page-furniture-${id}`,
          text,
          box,
          lines: [{ ...line, id, text, box, runs: [] }],
          nativeObjectIds: [],
          includedInReadingOrder: false,
        }) satisfies PdfPageRegion,
    )
}

function boundedTextOverlays(
  group: PdfPageRegion[],
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  strongHeadingRegionIds: ReadonlySet<string>,
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
        !strongHeadingRegionIds.has(region.id) &&
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
      materiallyOverlappingSourceBoxes(scope, region.box),
  )
}

function captionBoundedReadingOrderOverlays(
  group: PdfPageRegion[],
  figureRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  repeatedPageFurnitureIds: ReadonlySet<string>,
  strongHeadingRegionIds: ReadonlySet<string>,
  equationEvidence: PdfFigureEquationEvidence,
) {
  if (!provesCaptionBoundedNativeScaffold(group, figureRegions)) return []
  const nativeBox = unionObjectBox(group)
  const caption = owningCaptionForBox(nativeBox, captions)
  if (!caption) return []
  const scope = renderBoxForGroup(group, captions)
  const provesLayeredPanel = coextensiveNativeLayers(group)
  const provesDensePanel =
    group.length >= MIN_DENSE_NATIVE_SCAFFOLD_FRAGMENT_COUNT ||
    group.some((region) => bindsDenseNativeFragmentSet(region, figureRegions))
  const provesCaptionLanePanel = provesLayeredPanel || provesDensePanel
  const panelScope = provesCaptionLanePanel
    ? {
        ...scope,
        x: Math.min(scope.x, caption.box.x),
        width:
          Math.max(scope.x + scope.width, caption.box.x + caption.box.width) -
          Math.min(scope.x, caption.box.x),
      }
    : scope
  const scopeArea = panelScope.width * panelScope.height
  const horizontallySubordinateToPanel = (region: PdfPageRegion) => {
    const overlap = Math.max(
      0,
      Math.min(
        panelScope.x + panelScope.width,
        region.box.x + region.box.width,
      ) - Math.max(panelScope.x, region.box.x),
    )
    return (
      overlap >= Math.min(panelScope.width, region.box.width) * 0.9 &&
      region.box.y >= scope.y - FIGURE_OVERLAY_BOX_TOLERANCE &&
      region.box.y + region.box.height <=
        scope.y + scope.height + FIGURE_OVERLAY_BOX_TOLERANCE
    )
  }
  const boundedByPanel = (region: PdfPageRegion) =>
    fullyContainsBox(scope, region.box, FIGURE_OVERLAY_BOX_TOLERANCE) ||
    (provesCaptionLanePanel && horizontallySubordinateToPanel(region))
  const maximumAreaRatio = provesLayeredPanel
    ? MAX_LAYERED_PANEL_FLOW_OVERLAY_AREA_RATIO
    : MAX_CAPTION_BOUNDED_FLOW_OVERLAY_AREA_RATIO
  const candidates = regions
    .filter(
      (region) =>
        region.page === scope.page &&
        region.includedInReadingOrder &&
        region.nativeObjectIds.length === 0 &&
        region.lines.length > 0 &&
        region.text.trim().length > 0 &&
        ['body', 'spanning'].includes(region.kind) &&
        !strongHeadingRegionIds.has(region.id) &&
        !repeatedPageFurnitureIds.has(region.id) &&
        region.box.y + region.box.height <=
          caption.box.y + FIGURE_OVERLAY_BOX_TOLERANCE &&
        boundedByPanel(region) &&
        region.box.width * region.box.height <= scopeArea * maximumAreaRatio,
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
    const boundedPanelEquations = regions.filter(
      (region) =>
        region.page === scope.page &&
        region.includedInReadingOrder &&
        region.nativeObjectIds.length === 0 &&
        region.lines.length > 0 &&
        region.kind === 'equation' &&
        equationEvidence.isProbableDisplayEquation(region) &&
        equationEvidence.sourcePrintedEquationNumber(region) === null &&
        region.box.y + region.box.height <=
          caption.box.y + FIGURE_OVERLAY_BOX_TOLERANCE &&
        boundedByPanel(region) &&
        region.box.width * region.box.height <= scopeArea * maximumAreaRatio,
    )
    return [...candidates, ...boundedPanelEquations].sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
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

export async function figureCandidates(
  regions: PdfPageRegion[],
  captions: PdfPageRegion[],
  decorativeObjectIds: Set<string>,
  pageBackdropObjectIds: Set<string>,
  panelClipObjectIds: Set<string>,
  equationEvidence: PdfFigureEquationEvidence,
  evidence: PdfFigureGroupingEvidence,
  onProgress?: (progress: PdfImportProgress) => void,
  signal?: AbortSignal,
) {
  const repeatedPageFurnitureIds = repeatedTopPageFurnitureRegionIds(regions)
  const topPageFurnitureSources = topPageFurnitureTextSources(regions)
  const strongHeadingRegionIds = new Set<string>()
  for (const [regionIndex, region] of regions.entries()) {
    if (strongHierarchicalSectionHeading(region.text)) {
      strongHeadingRegionIds.add(region.id)
    }
    if ((regionIndex + 1) % PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE === 0) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: regionIndex + 1,
        total: regions.length,
        message: `Classifying structural headings for bounded figure ownership ${regionIndex + 1} of ${regions.length}…`,
        checkpoint: 'figure-heading-classification',
      })
      await yieldPdfVisualTask(signal)
    }
  }
  const figureRegions = regions.filter(
    (region) => region.kind === 'figure' && region.nativeObjectIds.length > 0,
  )
  evidence.figureRegionCount = figureRegions.length
  const regionsByPage = new Map<number, PdfPageRegion[]>()
  for (const region of regions) {
    const values = regionsByPage.get(region.page) ?? []
    values.push(region)
    regionsByPage.set(region.page, values)
  }
  const figureRegionsByPage = new Map<number, PdfPageRegion[]>()
  for (const region of figureRegions) {
    const values = figureRegionsByPage.get(region.page) ?? []
    values.push(region)
    figureRegionsByPage.set(region.page, values)
  }
  const captionsByPage = new Map<number, PdfPageRegion[]>()
  for (const caption of captions) {
    const values = captionsByPage.get(caption.page) ?? []
    values.push(caption)
    captionsByPage.set(caption.page, values)
  }
  const panelLabelRegionsByPage = new Map<number, PdfPageRegion[]>()
  for (const region of regions.filter(probablePanelLabelOverlayRegion)) {
    const values = panelLabelRegionsByPage.get(region.page) ?? []
    values.push(region)
    panelLabelRegionsByPage.set(region.page, values)
  }
  const groups = await connectedFigureRegionGroups({
    figureRegions,
    panelLabelRegionsByPage,
    captionsByPage,
    decorativeObjectIds,
    pageBackdropObjectIds,
    evidence,
    onProgress,
    signal,
  })
  const pageFurnitureSourcesByPage = new Map<number, PdfPageRegion[]>()
  for (const region of topPageFurnitureSources) {
    const values = pageFurnitureSourcesByPage.get(region.page) ?? []
    values.push(region)
    pageFurnitureSourcesByPage.set(region.page, values)
  }
  const connectedCandidates = groups
    .map<VisualCandidate>((group) => {
      const pageRegions = regionsByPage.get(group[0].page) ?? []
      const pageFigureRegions = figureRegionsByPage.get(group[0].page) ?? []
      const pageCaptions = captionsByPage.get(group[0].page) ?? []
      const pageFurnitureText = pageRegions.filter(
        (region) =>
          region.page === group[0].page &&
          region.nativeObjectIds.length === 0 &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          (['header', 'footer', 'page-number'].includes(region.kind) ||
            repeatedPageFurnitureIds.has(region.id)),
      )
      pageFurnitureText.push(
        ...(pageFurnitureSourcesByPage.get(group[0].page) ?? []),
      )
      const excludesPageFurniture = (region: PdfPageRegion) =>
        !materiallyOverlapsSourceText(region, pageFurnitureText)
      const panelLabelOverlays = adjacentPanelLabelOverlays(
        group,
        pageRegions,
        pageCaptions,
      ).filter(excludesPageFurniture)
      const flowOverlays = [
        ...new Map(
          [
            ...captionBoundedReadingOrderOverlays(
              group,
              pageFigureRegions,
              pageRegions,
              pageCaptions,
              repeatedPageFurnitureIds,
              strongHeadingRegionIds,
              equationEvidence,
            ),
            ...panelLabelOverlays,
          ].map((region) => [region.id, region]),
        ).values(),
      ].filter(excludesPageFurniture)
      const claimedFlowOverlayIds = new Set(
        flowOverlays.map((region) => region.id),
      )
      const unclaimedReadingOrderText = pageRegions.filter(
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
          !materiallyOverlapsSourceText(region, [
            ...unclaimedReadingOrderText,
            ...pageFurnitureText,
          ]),
      )
      const nativeGroup =
        provesCaptionBoundedNativeScaffold(group, pageFigureRegions) &&
        uncontaminatedGroup.length >= MIN_COMPOSITE_FIGURE_FRAGMENTS
          ? uncontaminatedGroup
          : group
      const nativeRenderBox = renderBoxForGroup(nativeGroup, pageCaptions)
      const overlays = [
        ...boundedTextOverlays(
          nativeGroup,
          pageRegions,
          pageCaptions,
          strongHeadingRegionIds,
        ).filter(excludesPageFurniture),
        ...flowOverlays,
      ].sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
      const provesNativeScaffold = provesCaptionBoundedNativeScaffold(
        group,
        pageFigureRegions,
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
        pageCaptions,
        useCaptionBounds,
      )
      const nativeTextOwnershipBox = useCaptionBounds
        ? captionBoundedRenderBox(group, pageCaptions, true)
        : null
      const textOwnershipBox = nativeTextOwnershipBox
        ? {
            ...nativeTextOwnershipBox,
            x: renderBox.x,
            width: renderBox.width,
          }
        : undefined
      const nativeGroupIds = new Set(nativeGroup.map((region) => region.id))
      const trimmedByReadingOrderText = group.some(
        (region) =>
          !nativeGroupIds.has(region.id) &&
          materiallyOverlapsSourceText(region, unclaimedReadingOrderText),
      )
      const trimmedByPageFurniture = group.some(
        (region) =>
          !nativeGroupIds.has(region.id) &&
          materiallyOverlapsSourceText(region, pageFurnitureText),
      )
      const omittedNativeMaterial = group.filter(
        (region) =>
          !nativeGroupIds.has(region.id) &&
          !isCompositeScaffold(region, pageFigureRegions) &&
          !bindsDenseNativeFragmentSet(region, pageFigureRegions) &&
          intersectionArea(region.box, renderBox) > 0,
      )
      const sourcePageCropBlockedByReadingOrderText =
        scopeContainsReadingOrderText(
          paddedUnionBox([nativeRenderBox]),
          pageRegions,
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
        textOwnershipBox,
        sourcePageCropBlockedByReadingOrderText,
        nativeEnvelopeIncomplete: omittedNativeMaterial.length > 0,
        evidence: [
          ...(overlays.length > 0 ? ['source-text-overlay'] : []),
          ...(panelLabelOverlays.length > 0
            ? ['panel-label-source-owned']
            : []),
          ...(provesNativeScaffold ? ['connected-native-scaffold'] : []),
          ...(useCaptionBounds ? ['caption-bounded-native-scaffold'] : []),
          ...(ownsSingleLineChartOverlay
            ? ['single-line-chart-overlay-source-owned']
            : []),
          ...(trimmedByReadingOrderText
            ? ['source-scaffold-trimmed-reading-order-overlap']
            : []),
          ...(trimmedByPageFurniture
            ? ['source-scaffold-trimmed-page-furniture-overlap']
            : []),
          ...(group.some((region) =>
            region.nativeObjectIds.some((id) => panelClipObjectIds.has(id)),
          )
            ? ['source-reused-page-edge-clipping-layer']
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
  onProgress?.({
    phase: 'semantic-promotion',
    completed: groups.length,
    total: groups.length,
    message: `Materialized ${groups.length} connected native figure groups…`,
    checkpoint: 'figure-grouping-candidates',
  })
  await yieldPdfVisualTask(signal)
  const semanticEnvelopes = await captionBoundedSemanticEnvelopeCandidates(
    figureRegions,
    regions,
    captions,
    pageBackdropObjectIds,
    panelClipObjectIds,
    strongHeadingRegionIds,
    repeatedPageFurnitureIds,
    onProgress,
    signal,
  )
  return [...connectedCandidates, ...semanticEnvelopes].sort(
    (left, right) =>
      left.page - right.page ||
      Math.min(...left.sourceBoxes.map((box) => box.y)) -
        Math.min(...right.sourceBoxes.map((box) => box.y)) ||
      (left.captionRegionId ?? '').localeCompare(right.captionRegionId ?? ''),
  )
}

/**
 * Recover a complete native image when region grouping was conservative.
 *
 * Some PDFs expose a figure as one parent image plus many tiny label/vector
 * fragments.  The parent image can be filtered as page furniture or fail the
 * connected-scaffold proof even though PDF.js has already decoded an exact
 * source asset for it.  In that case the caption is still enough to bind the
 * nearest large, source-backed image: the candidate is never synthesized and
 * its source object/asset lineage remains explicit.
 */
export function sourcePreservedFigureFallbackCandidate({
  caption,
  pages,
  regions,
  assetStore,
  renderEnvelope,
}: {
  caption: PdfPageRegion
  pages: PdfPageAnalysis[]
  regions: PdfPageRegion[]
  assetStore: ReadonlyMap<string, PdfVisualAsset>
  renderEnvelope?: NormalizedSourceBox
}): VisualCandidate | null {
  const page = pages.find((value) => value.page === caption.page)
  if (!page) return null
  const contains = (outer: NormalizedSourceBox, inner: NormalizedSourceBox) =>
    outer.x <= inner.x + 0.0005 &&
    outer.y <= inner.y + 0.0005 &&
    outer.x + outer.width >= inner.x + inner.width - 0.0005 &&
    outer.y + outer.height >= inner.y + inner.height - 0.0005
  const imageObjects = (page.objects ?? [])
    .filter(
      (object) =>
        object.kind === 'image' &&
        typeof object.assetId === 'string' &&
        assetStore.has(object.assetId) &&
        object.box.width * object.box.height >= 0.01 &&
        object.box.width <= 0.9 &&
        object.box.height <= 0.65 &&
        (!renderEnvelope || contains(object.box, renderEnvelope)),
    )
    .filter((object) => {
      const distance = caption.box.y - (object.box.y + object.box.height)
      return (
        distance >= -0.004 &&
        distance <= 0.14 &&
        horizontalOverlapRatio(caption.box, object.box) >= 0.5
      )
    })
  if (imageObjects.length === 0) return null
  const parentObjects = imageObjects.filter(
    (object) =>
      !imageObjects.some(
        (other) =>
          other.id !== object.id &&
          other.box.width * other.box.height >
            object.box.width * object.box.height * 1.25 &&
          contains(other.box, object.box),
      ),
  )
  const sourceObject = [
    ...(parentObjects.length > 0 ? parentObjects : imageObjects),
  ].sort(
    (left, right) =>
      right.box.width * right.box.height - left.box.width * left.box.height ||
      left.id.localeCompare(right.id),
  )[0]
  if (!sourceObject || !sourceObject.assetId) return null
  const sourceRegions = regions.filter((region) =>
    region.nativeObjectIds.includes(sourceObject.id),
  )
  const column = sourceRegions[0]?.column ?? caption.column
  return {
    kind: 'figure',
    sourceRegionIds: sourceRegions.map((region) => region.id),
    sourceObjectIds: [sourceObject.id],
    assetIds: [sourceObject.assetId],
    sourceBoxes: [{ ...sourceObject.box }],
    sourceText: '',
    page: sourceObject.page,
    column,
    renderBox: { ...sourceObject.box },
    evidence: [
      'source-preserved-figure-fallback',
      'native-object-direct-rendition',
    ],
  }
}
